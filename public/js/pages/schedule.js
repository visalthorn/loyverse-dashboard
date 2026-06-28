import { state } from '../state.js';
import { fetchJSON, apiPut } from '../api.js';
import { getEl } from '../utils.js';

// ── Module state ──────────────────────────────────────────────────────────────

let staffList     = [];
let scheduleMap   = {};      // staffId → { day: shift }  for current month grid
let scheduleByDate = {};     // staffId → { 'YYYY-MM-DD': shift } current + prev month

let currentYear  = new Date().getFullYear();
let currentMonth = new Date().getMonth() + 1;
let loaded       = false;

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

// DB entry wins (including explicit Off); otherwise auto-fill with default shift for all days on/after join date
function effectiveShift(staffId, day, defaultShift, joinStr) {
  const dbVal = scheduleMap[staffId]?.[day];
  if (dbVal !== undefined) return { shift: dbVal, auto: false };
  if (isOnOrAfterJoin(currentYear, currentMonth, day, joinStr) && defaultShift)
    return { shift: defaultShift, auto: true };
  return { shift: null, auto: false };
}

// ── Payment cycle helpers ─────────────────────────────────────────────────────

function payDayInMonth(joinDay, y, m) {
  return Math.min(joinDay, daysInMonth(y, m));
}

function getLastPayDate(joinStr) {
  if (!joinStr) return null;
  const joinDay = parseInt(joinStr.slice(8, 10), 10);

  const thisPayDay = payDayInMonth(joinDay, _todayY, _todayM);
  if (thisPayDay <= _todayD) return toDateStr(_todayY, _todayM, thisPayDay);

  const prevM = _todayM === 1 ? 12 : _todayM - 1;
  const prevY = _todayM === 1 ? _todayY - 1 : _todayY;
  return toDateStr(prevY, prevM, payDayInMonth(joinDay, prevY, prevM));
}

function getNextPayDate(joinStr) {
  const last = getLastPayDate(joinStr);
  if (!last) return null;
  const [y, m]  = last.split('-').map(Number);
  const joinDay = parseInt(joinStr.slice(8, 10), 10);
  const nxtM = m === 12 ? 1  : m + 1;
  const nxtY = m === 12 ? y + 1 : y;
  return toDateStr(nxtY, nxtM, payDayInMonth(joinDay, nxtY, nxtM));
}

function computeWorkedSince(staffId, defaultShift, fromStr, joinStr) {
  if (!fromStr) return 0;
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  let count = 0;
  let cur   = new Date(fy, fm - 1, fd + 1);
  const end = new Date(_todayY, _todayM - 1, _todayD);

  while (cur <= end) {
    const ds  = toDateStr(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
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

export function printSchedule() {
  window.print();
}

export function exportScheduleCSV() {
  const days    = daysInMonth(currentYear, currentMonth);
  const monthLabel = `${MONTH_NAMES[currentMonth - 1]}_${currentYear}`;

  const dayHeaders = [];
  for (let d = 1; d <= days; d++) {
    dayHeaders.push(`${d} ${DAY_SHORT[dowOf(currentYear, currentMonth, d)]}`);
  }

  const headers = ['Staff Name', 'Staff ID', 'Position', ...dayHeaders];

  const dataRows = staffList.map(s => {
    const defaultShift = s.default_shift || 'A';
    const cells = [];
    for (let d = 1; d <= days; d++) {
      const { shift } = effectiveShift(s.id, d, defaultShift, s.join_date);
      cells.push(shift || '');
    }
    return [s.full_name, s.staff_id, s.position, ...cells];
  });

  const csv = [headers, ...dataRows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `roster_${monthLabel}.csv`;
  a.click();
  URL.revokeObjectURL(url);
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

  const isFutureMonth = currentYear > _todayY || (currentYear === _todayY && currentMonth > _todayM);
  const futureNote = getEl('scheduleFutureNote');
  if (futureNote) futureNote.classList.toggle('hidden', !isFutureMonth);

  // Two-row header: day numbers (row 1) + day abbreviations (row 2)
  // #, ID, Name cells span both rows via rowspan="2"
  let head1 = `
    <th rowspan="2" class="rst-th-meta rst-th-num">#</th>
    <th rowspan="2" class="rst-th-meta rst-th-id">ID</th>
    <th rowspan="2" class="rst-th-meta rst-th-name-h">Name</th>`;
  let head2 = '';

  for (let d = 1; d <= days; d++) {
    const dw     = dowOf(currentYear, currentMonth, d);
    const we     = dw === 0 || dw === 6;
    const isToday = currentYear === _todayY && currentMonth === _todayM && d === _todayD;
    const weCls  = we ? ' rst-th-we' : '';
    const todCls = isToday ? ' rst-th-today' : '';
    head1 += `<th class="rst-th-day${weCls}${todCls}">${d}</th>`;
    head2 += `<th class="rst-th-dow${weCls}${todCls}">${DAY_SHORT[dw]}</th>`;
  }

  // Summary column spans both header rows
  head1 += `<th rowspan="2" class="rst-th-meta rst-th-sum">Since Last Pay</th>`;

  const rows = staffList.length
    ? staffList.map((s, i) => buildRosterRow(s, days, canEdit, i)).join('')
    : `<tr><td colspan="${days + 4}" style="background:#fff;padding:2rem;text-align:center;color:#6b7280;font-size:0.875rem">No active staff with join date and position set.</td></tr>`;

  container.innerHTML = `
    <div class="rst-outer">
      <div class="rst-title">${MONTH_NAMES[currentMonth - 1]} ${currentYear} — Staff Roster</div>
      <div class="rst-scroll">
        <table class="rst-table">
          <thead>
            <tr>${head1}</tr>
            <tr>${head2}</tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="rst-legend">
        <span class="rst-leg rst-leg-m">M · 11am – 10pm</span>
        <span class="rst-leg rst-leg-a">A · 2pm – 1am</span>
        <span class="rst-leg rst-leg-off">Off · Day Off</span>
      </div>
    </div>`;
}

function buildRosterRow(s, days, canEdit, index) {
  const defaultShift = s.default_shift || 'A';
  const joinStr      = s.join_date;
  const joinDay      = parseInt(joinStr.slice(8, 10), 10);
  const lastPayDate  = getLastPayDate(joinStr);
  const nextPayDate  = getNextPayDate(joinStr);
  const workedDays   = computeWorkedSince(s.id, defaultShift, lastPayDate, joinStr);
  const payColDay    = payDayInMonth(joinDay, currentYear, currentMonth);

  const fillBtn = canEdit
    ? `<button class="rst-fill-btn" onclick="openRosterFill(event,${s.id})">⊞ Fill</button>`
    : '';

  const alt = index % 2 === 1;

  let cells = `
    <td class="rst-td-num">${index + 1}</td>
    <td class="rst-td-id">${s.staff_id}</td>
    <td class="rst-td-name">${s.full_name}${fillBtn}</td>`;

  for (let d = 1; d <= days; d++) {
    const { shift, auto } = effectiveShift(s.id, d, defaultShift, joinStr);
    const dw      = dowOf(currentYear, currentMonth, d);
    const we      = dw === 0 || dw === 6;
    const isToday = currentYear === _todayY && currentMonth === _todayM && d === _todayD;
    const isPayDay = d === payColDay;
    const dateStr  = toDateStr(currentYear, currentMonth, d);
    const eligible = isOnOrAfterJoin(currentYear, currentMonth, d, joinStr);

    const clickAttr = canEdit && eligible
      ? ` onclick="openShiftPicker(event,${s.id},'${dateStr}')"`
      : '';

    const shiftCls = shift === 'M' ? ' rst-m' : shift === 'A' ? ' rst-a' : shift === 'Off' ? ' rst-off' : '';
    const cls = `rst-td${we ? ' rst-we' : ''}${shiftCls}${auto ? ' rst-auto' : ''}${isToday ? ' rst-today-cell' : ''}${isPayDay ? ' rst-pay-col' : ''}`;

    cells += `<td class="${cls}"${clickAttr}>${shift || ''}</td>`;
  }

  cells += `<td class="rst-sum-cell${alt ? ' rst-sum-alt' : ''}">
    <div><span class="rst-sum-days">${workedDays}</span><span class="rst-sum-unit">d</span></div>
    <div class="rst-sum-label">since ${shortDate(lastPayDate)}</div>
    <div class="rst-sum-next">Next: ${shortDate(nextPayDate)}</div>
  </td>`;

  return `<tr class="rst-row${alt ? ' rst-row-alt' : ''}" data-staff-id="${s.id}">${cells}</tr>`;
}

// ── Shift picker ──────────────────────────────────────────────────────────────

let activePicker = null;

export function openShiftPicker(event, staffId, dateStr) {
  event.stopPropagation();
  closeShiftPicker();
  closeRosterFill();

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

// ── Roster fill ───────────────────────────────────────────────────────────────

let activeRosterPicker = null;

export function openRosterFill(event, staffId) {
  event.stopPropagation();
  closeShiftPicker();
  closeRosterFill();

  const staff = staffList.find(s => s.id === staffId);
  const name  = staff ? staff.full_name : 'Staff';

  const patterns = [
    { key: 'all-M',   badge: 'M',   badgeStyle: `background:${SHIFTS.M.bg};color:${SHIFTS.M.color}`,     label: 'All days Morning (11am–10pm)'        },
    { key: 'all-A',   badge: 'A',   badgeStyle: `background:${SHIFTS.A.bg};color:${SHIFTS.A.color}`,     label: 'All days Afternoon (2pm–1am)'        },
    { key: 'all-Off', badge: 'Off', badgeStyle: `background:${SHIFTS.Off.bg};color:${SHIFTS.Off.color}`, label: 'All days Off'                        },
    { key: 'wd-M',    badge: 'M',   badgeStyle: `background:${SHIFTS.M.bg};color:${SHIFTS.M.color}`,     label: 'Weekdays Morning · Weekend Off'      },
    { key: 'wd-A',    badge: 'A',   badgeStyle: `background:${SHIFTS.A.bg};color:${SHIFTS.A.color}`,     label: 'Weekdays Afternoon · Weekend Off'    },
  ];

  const picker = document.createElement('div');
  picker.className = 'sch-roster-picker';
  picker.innerHTML = `
    <div class="sch-roster-title">Fill Roster · ${name}</div>
    ${patterns.map(p => `
      <button class="sch-roster-opt" onclick="applyRosterFill(${staffId},'${p.key}')">
        <span class="sch-picker-badge" style="${p.badgeStyle}">${p.badge}</span>
        <span>${p.label}</span>
      </button>`).join('')}
    <hr class="sch-roster-divider"/>
    <button class="sch-roster-opt" style="color:#f87171" onclick="applyRosterFill(${staffId},'clear')">
      <span class="sch-picker-clear" style="background:rgba(239,68,68,0.15);color:#f87171">✕</span>
      <span>Clear all entries this month</span>
    </button>`;

  document.body.appendChild(picker);
  activeRosterPicker = picker;
  _positionNear(picker, event, 270, 250);
  setTimeout(() => document.addEventListener('click', closeRosterFill, { once: true }), 0);
}

export function closeRosterFill() {
  activeRosterPicker?.remove();
  activeRosterPicker = null;
}

export async function applyRosterFill(staffId, pattern) {
  closeRosterFill();

  const entries = _buildRosterEntries(staffId, pattern);
  const res = await apiPut('/api/schedule/bulk', { entries });
  if (!res.ok) { alert('Failed to apply roster.'); return; }

  if (!scheduleMap[staffId])    scheduleMap[staffId]    = {};
  if (!scheduleByDate[staffId]) scheduleByDate[staffId] = {};

  for (const e of entries) {
    const day = parseInt(e.schedule_date.split('-')[2], 10);
    if (e.shift) {
      scheduleMap[staffId][day]            = e.shift;
      scheduleByDate[staffId][e.schedule_date] = e.shift;
    } else {
      delete scheduleMap[staffId][day];
      delete scheduleByDate[staffId][e.schedule_date];
    }
  }

  render();
}

function _buildRosterEntries(staffId, pattern) {
  const days    = daysInMonth(currentYear, currentMonth);
  const entries = [];

  for (let d = 1; d <= days; d++) {
    const dateStr  = toDateStr(currentYear, currentMonth, d);
    const dw       = dowOf(currentYear, currentMonth, d);
    const isWeekend = dw === 0 || dw === 6;

    let shift;
    switch (pattern) {
      case 'all-M':   shift = 'M';   break;
      case 'all-A':   shift = 'A';   break;
      case 'all-Off': shift = 'Off'; break;
      case 'wd-M':    shift = isWeekend ? 'Off' : 'M'; break;
      case 'wd-A':    shift = isWeekend ? 'Off' : 'A'; break;
      default:        shift = null;  // 'clear'
    }

    entries.push({ staff_id: staffId, schedule_date: dateStr, shift });
  }

  return entries;
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
