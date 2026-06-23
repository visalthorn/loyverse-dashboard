import { state } from '../state.js';
import { fetchJSON, apiPut } from '../api.js';
import { getEl } from '../utils.js';

// ── Module state ──────────────────────────────────────────────────────────────

let staffList     = [];
let scheduleMap   = {};      // staffId → { day: shift }  for current month grid
let scheduleByDate = {};     // staffId → { 'YYYY-MM-DD': shift } current + prev month

let currentYear  = new Date().getFullYear();
let currentMonth = new Date().getMonth() + 1;
let loaded       = false;   // true once init() has been called at least once

const _now    = new Date();
const _todayY = _now.getFullYear();
const _todayM = _now.getMonth() + 1;
const _todayD = _now.getDate();

const SHIFTS = {
  M:   { bg: 'rgba(59,130,246,0.22)', color: '#60a5fa', label: 'Morning (11am–10pm)' },
  A:   { bg: 'rgba(168,85,247,0.22)', color: '#c084fc', label: 'Afternoon (2pm–1am)' },
  Off: { bg: 'rgba(239,68,68,0.20)',  color: '#f87171', label: 'Day Off'              },
};

const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const DAY_SHORT   = ['Su','Mo','Tu','We','Th','Fr','Sa'];

// ── Date helpers ──────────────────────────────────────────────────────────────

function daysInMonth(y, m)  { return new Date(y, m, 0).getDate(); }
function dowOf(y, m, d)     { return new Date(y, m - 1, d).getDay(); }

function isPastOrToday(y, m, d) {
  if (y !== _todayY) return y < _todayY;
  if (m !== _todayM) return m < _todayM;
  return d <= _todayD;
}

// True if (y,m,d) is on or after the staff join date
function isOnOrAfterJoin(y, m, d, joinStr) {
  if (!joinStr) return true;
  const [jy, jm, jd] = joinStr.split('-').map(Number);
  if (y !== jy) return y > jy;
  if (m !== jm) return m > jm;
  return d >= jd;
}

function toDateStr(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

function shortDate(dateStr) {
  if (!dateStr) return '—';
  const [, sm, sd] = dateStr.split('-').map(Number);
  return `${MONTH_NAMES[sm - 1].slice(0, 3)} ${sd}`;
}

// Effective shift: DB entry wins, then auto-fill for days within [join_date, today]
function effectiveShift(staffId, day, defaultShift, joinStr) {
  const dbVal = scheduleMap[staffId]?.[day];
  if (dbVal !== undefined) return { shift: dbVal, auto: false };
  if (isPastOrToday(currentYear, currentMonth, day) &&
      isOnOrAfterJoin(currentYear, currentMonth, day, joinStr) &&
      defaultShift)
    return { shift: defaultShift, auto: true };
  return { shift: null, auto: false };
}

// ── Payment cycle helpers ─────────────────────────────────────────────────────
// For join days 29/30/31: use the last valid day of each target month.
// HR convention: e.g. joined Mar 31 → pay on Jan 31, Feb 28/29, Mar 31, Apr 30 …

function payDayInMonth(joinDay, y, m) {
  return Math.min(joinDay, daysInMonth(y, m));
}

// Most recent payment date on or before today
function getLastPayDate(joinStr) {
  if (!joinStr) return null;
  const joinDay = parseInt(joinStr.slice(8, 10), 10);

  const thisPayDay = payDayInMonth(joinDay, _todayY, _todayM);
  if (thisPayDay <= _todayD) return toDateStr(_todayY, _todayM, thisPayDay);

  const prevM = _todayM === 1 ? 12 : _todayM - 1;
  const prevY = _todayM === 1 ? _todayY - 1 : _todayY;
  return toDateStr(prevY, prevM, payDayInMonth(joinDay, prevY, prevM));
}

// Next payment date = one month after last
function getNextPayDate(joinStr) {
  const last = getLastPayDate(joinStr);
  if (!last) return null;
  const [y, m]  = last.split('-').map(Number);
  const joinDay = parseInt(joinStr.slice(8, 10), 10);
  const nxtM = m === 12 ? 1  : m + 1;
  const nxtY = m === 12 ? y + 1 : y;
  return toDateStr(nxtY, nxtM, payDayInMonth(joinDay, nxtY, nxtM));
}

// Days worked since fromDateStr (exclusive) to today.
// Off entries in DB don't count; everything else (auto-fill or explicit M/A) does.
function computeWorkedSince(staffId, defaultShift, fromStr, joinStr) {
  if (!fromStr) return 0;
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  let count = 0;
  let cur   = new Date(fy, fm - 1, fd + 1);
  const end = new Date(_todayY, _todayM - 1, _todayD);

  while (cur <= end) {
    const ds  = toDateStr(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
    // Skip days before join date
    if (!isOnOrAfterJoin(cur.getFullYear(), cur.getMonth() + 1, cur.getDate(), joinStr)) {
      cur.setDate(cur.getDate() + 1);
      continue;
    }
    const dbShift = scheduleByDate[staffId]?.[ds];
    if (dbShift !== 'Off') {
      const eff = dbShift || defaultShift;
      if (eff === 'M' || eff === 'A') count++;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ── Public entry points ───────────────────────────────────────────────────────

export async function init() {
  loaded = true;
  await load();
}

// Called after staff save/edit to refresh the grid without re-showing the tab
export async function reloadIfLoaded() {
  if (loaded) await load();
}

export function prevMonth() {
  currentMonth--;
  if (currentMonth < 1) { currentMonth = 12; currentYear--; }
  load();
}

export function nextMonth() {
  currentMonth++;
  if (currentMonth > 12) { currentMonth = 1; currentYear++; }
  load();
}

// ── Data ──────────────────────────────────────────────────────────────────────

async function load() {
  setNavTitle();
  const container = getEl('scheduleGridContainer');
  if (container) container.innerHTML = `<div class="py-10 text-center text-slate-500 text-sm">Loading…</div>`;

  const prevY = currentMonth === 1 ? currentYear - 1 : currentYear;
  const prevM = currentMonth === 1 ? 12 : currentMonth - 1;

  const [staff, curSched, prevSched] = await Promise.all([
    fetchJSON('/api/staff'),
    fetchJSON(`/api/schedule?year=${currentYear}&month=${currentMonth}`),
    fetchJSON(`/api/schedule?year=${prevY}&month=${prevM}`),
  ]);

  // Only staff with both join_date and position appear in the schedule
  staffList = (Array.isArray(staff) ? staff : [])
    .filter(s => s.is_active && s.join_date && s.position);

  scheduleMap    = {};
  scheduleByDate = {};

  for (const data of [curSched, prevSched]) {
    if (!Array.isArray(data)) continue;
    for (const row of data) {
      const ds        = row.schedule_date.slice(0, 10);
      const [ry, rm, rd] = ds.split('-').map(Number);

      if (!scheduleByDate[row.staff_id]) scheduleByDate[row.staff_id] = {};
      scheduleByDate[row.staff_id][ds] = row.shift;

      if (ry === currentYear && rm === currentMonth) {
        if (!scheduleMap[row.staff_id]) scheduleMap[row.staff_id] = {};
        scheduleMap[row.staff_id][rd] = row.shift;
      }
    }
  }

  render();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function setNavTitle() {
  const el = getEl('scheduleMonthTitle');
  if (el) el.textContent = `${MONTH_NAMES[currentMonth - 1]} ${currentYear}`;
}

function render() {
  const container = getEl('scheduleGridContainer');
  if (!container) return;
  setNavTitle();

  const days    = daysInMonth(currentYear, currentMonth);
  const canEdit = !!state.userPermissions.staff?.can_write;

  const note = getEl('scheduleReadOnlyNote');
  if (note) note.classList.toggle('hidden', canEdit);

  // Header row
  let head = `<th class="sch-th-name">Staff</th>`;
  for (let d = 1; d <= days; d++) {
    const dw       = dowOf(currentYear, currentMonth, d);
    const we       = dw === 0 || dw === 6;
    const isFuture = !isPastOrToday(currentYear, currentMonth, d);
    const isToday  = currentYear === _todayY && currentMonth === _todayM && d === _todayD;
    head += `<th class="sch-th-day${we ? ' sch-weekend' : ''}${isFuture ? ' sch-th-future' : ''}${isToday ? ' sch-th-today' : ''}">${d}<br><small>${DAY_SHORT[dw]}</small></th>`;
  }
  head += `<th class="sch-th-sum">Since Last Pay</th>`;

  const rows = staffList.length
    ? staffList.map(s => buildRow(s, days, canEdit)).join('')
    : `<tr><td colspan="${days + 2}" class="py-8 text-center text-slate-500 text-sm">No active staff with join date and position set.</td></tr>`;

  container.innerHTML = `
    <div class="sch-scroll-wrap">
      <table class="sch-table">
        <thead><tr>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function buildRow(s, days, canEdit) {
  const defaultShift = s.default_shift || 'A';
  const joinStr      = s.join_date;   // guaranteed "YYYY-MM-DD" from backend
  const joinDay      = parseInt(joinStr.slice(8, 10), 10);
  const lastPayDate  = getLastPayDate(joinStr);
  const nextPayDate  = getNextPayDate(joinStr);
  const workedDays   = computeWorkedSince(s.id, defaultShift, lastPayDate, joinStr);

  // Payment-cycle marker column for this month (clamped for short months)
  const payColDay = payDayInMonth(joinDay, currentYear, currentMonth);

  let cells = `<td class="sch-name-cell">
    <div class="sch-name">${s.full_name}</div>
    <div class="sch-staff-meta">${s.staff_id} · <span style="color:${SHIFTS[defaultShift].color};font-weight:700">${defaultShift}</span> · <span style="color:#94a3b8">${s.position}</span></div>
  </td>`;

  for (let d = 1; d <= days; d++) {
    const { shift, auto } = effectiveShift(s.id, d, defaultShift, joinStr);
    const dw       = dowOf(currentYear, currentMonth, d);
    const we       = dw === 0 || dw === 6;
    const isFuture = !isPastOrToday(currentYear, currentMonth, d);
    const isToday  = currentYear === _todayY && currentMonth === _todayM && d === _todayD;
    const isPayDay = d === payColDay;
    const dateStr  = toDateStr(currentYear, currentMonth, d);

    const badge = shift
      ? `<span class="sch-badge${auto ? ' sch-badge--auto' : ''}" style="background:${SHIFTS[shift].bg};color:${SHIFTS[shift].color}">${shift}</span>`
      : '';

    const clickAttr = canEdit && !isFuture && isOnOrAfterJoin(currentYear, currentMonth, d, joinStr)
      ? ` onclick="openShiftPicker(event,${s.id},'${dateStr}')"`
      : '';

    cells += `<td class="sch-day-cell${we ? ' sch-weekend' : ''}${isFuture ? ' sch-future-cell' : ''}${isToday ? ' sch-today-cell' : ''}${isPayDay ? ' sch-pay-mark-col' : ''}"${clickAttr}>${badge}</td>`;
  }

  cells += `<td class="sch-sum-cell">
    <div class="sch-sum-main">${workedDays}<span class="sch-sum-unit">d</span></div>
    <div class="sch-sum-label">since ${shortDate(lastPayDate)}</div>
    <div class="sch-sum-next">Next: ${shortDate(nextPayDate)}</div>
  </td>`;

  return `<tr class="sch-row" data-staff-id="${s.id}">${cells}</tr>`;
}

// ── Shift picker ──────────────────────────────────────────────────────────────

let activePicker = null;

export function openShiftPicker(event, staffId, dateStr) {
  event.stopPropagation();
  closeShiftPicker();

  const opts = [
    { shift: 'M',   label: 'Morning (11am–10pm)' },
    { shift: 'A',   label: 'Afternoon (2pm–1am)' },
    { shift: 'Off', label: 'Day Off'              },
    { shift: null,  label: 'Clear'                },
  ];

  const picker = document.createElement('div');
  picker.className = 'sch-picker';
  picker.innerHTML = opts.map(o => {
    const icon = o.shift
      ? `<span class="sch-picker-badge" style="background:${SHIFTS[o.shift].bg};color:${SHIFTS[o.shift].color}">${o.shift}</span>`
      : `<span class="sch-picker-clear">✕</span>`;
    const arg = o.shift ? `'${o.shift}'` : 'null';
    return `<button class="sch-picker-opt" onclick="applyShift(${staffId},'${dateStr}',${arg})">${icon}<span>${o.label}</span></button>`;
  }).join('');

  document.body.appendChild(picker);
  activePicker = picker;
  _positionNear(picker, event, 200, 170);
  setTimeout(() => document.addEventListener('click', closeShiftPicker, { once: true }), 0);
}

export function closeShiftPicker() {
  activePicker?.remove();
  activePicker = null;
}

export async function applyShift(staffId, dateStr, shift) {
  closeShiftPicker();
  const res = await apiPut('/api/schedule', { staff_id: staffId, schedule_date: dateStr, shift });
  if (!res.ok) { alert('Failed to update shift.'); return; }

  const day = parseInt(dateStr.split('-')[2], 10);
  if (!scheduleMap[staffId])    scheduleMap[staffId]    = {};
  if (!scheduleByDate[staffId]) scheduleByDate[staffId] = {};

  if (shift) {
    scheduleMap[staffId][day]        = shift;
    scheduleByDate[staffId][dateStr] = shift;
  } else {
    delete scheduleMap[staffId][day];
    delete scheduleByDate[staffId][dateStr];
  }

  render();
}

// ── Positioning utility ───────────────────────────────────────────────────────

function _positionNear(el, event, pw, ph) {
  let top  = event.clientY + 10;
  let left = event.clientX - 10;
  if (top  + ph > window.innerHeight - 8) top  = event.clientY - ph - 10;
  if (left + pw > window.innerWidth  - 8) left = window.innerWidth - pw - 8;
  el.style.top  = `${Math.max(8, top)}px`;
  el.style.left = `${Math.max(8, left)}px`;
}
