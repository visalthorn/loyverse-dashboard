import { apiPost, fetchJSON } from '../api.js';
import { icon } from '../icons.js';
import { getEl, fmtDatetime, TZ } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from '../toast.js';
import { showConfirm } from '../dialog.js';
import { state } from '../state.js';

let logs = [];

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function statusIcon(status) {
  return icon(status === 'success' ? 'circle-check' : status === 'skipped' ? 'skip-forward' : status === 'partial' ? 'triangle-alert' : 'circle-x', { size: 15 });
}

const TYPE_KEYS = {
  receipts:    'sync.typeReceipts',
  items:       'sync.typeItems',
  pos_devices: 'sync.typePosDevices',
};

function renderLastSync(type, mountId) {
  const el = getEl(mountId);
  if (!el) return;
  const row = logs.find(l => l.sync_type === type);
  if (!row) { el.textContent = t('sync.never'); return; }
  const by = row.triggered_by === 'auto' ? t('sync.auto') : t('sync.manual');
  el.innerHTML = t('sync.lastSync', { icon: statusIcon(row.status), date: esc(fmtDatetime(row.created_at)), by: esc(by) });
}

function renderHistory() {
  const tbody = getEl('syncHistoryBody');
  if (!tbody) return;
  if (!logs.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-10 text-center text-[color:var(--text-secondary)]">${t('sync.noLogs')}</td></tr>`;
    return;
  }
  tbody.innerHTML = logs.map(l => `
    <tr class="border-b border-[color:var(--border-subtle)]">
      <td class="py-2 pr-3">${t(TYPE_KEYS[l.sync_type] || 'sync.typeReceipts')}</td>
      <td class="py-2 pr-3">${fmtDatetime(l.created_at)}</td>
      <td class="py-2 pr-3">${statusIcon(l.status)} ${esc(l.status)}</td>
      <td class="py-2 pr-3 text-right">${l.inserted ?? 0}</td>
      <td class="py-2 pr-3">${l.triggered_by === 'auto' ? t('sync.auto') : l.triggered_by === 'catchup' ? t('sync.catchup') : t('sync.manual')}</td>
      <td class="py-2 text-xs text-[color:var(--loss)]">${esc(l.error_message || '')}</td>
    </tr>`).join('');
}

// ─── Scheduler status card ────────────────────────────────────────────────────

function fmtCountdown(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function loadSchedulerStatus() {
  const el = getEl('schedulerStatus');
  if (!el) return;
  const s = await fetchJSON('/api/sync/status');
  if (!s) {
    el.innerHTML = `<div class="text-xs" style="color:var(--loss)">${t('sync.failed')}</div>`;
    return;
  }

  const dot = color => `<span style="color:${color}">●</span>`;
  const schedLine = s.schedulerActive
    ? `${dot('var(--gain)')} ${t('sync.schedRunning', { countdown: fmtCountdown(s.nextRunAt) })}`
    : `${dot('var(--loss)')} ${t('sync.schedStopped')}`;
  const upSince = `<span class="text-xs text-[color:var(--text-secondary)]">· ${t('sync.schedUpSince', { time: fmtDatetime(s.serverStartedAt) })}</span>`;

  const y = s.yesterday;
  let coverLine;
  if (s.yesterdayCoveredBy === 'auto' || s.yesterdayCoveredBy === 'catchup') {
    coverLine = `${dot('var(--gain)')} ${t('sync.schedYAuto', { date: y })}`;
  } else if (s.yesterdayCoveredBy === 'manual') {
    coverLine = `${dot('var(--accent)')} ${t('sync.schedYManual', { date: y })}`;
  } else if (s.yesterdayCovered) {
    coverLine = `${dot('var(--accent)')} ${t('sync.schedYNoLog', { date: y })}`;
  } else {
    coverLine = `${dot('var(--loss)')} ${t('sync.schedYMissing', { date: y })}`;
  }

  el.innerHTML = `<div>${schedLine} ${upSince}</div><div>${coverLine}</div>`;
}

async function loadLogs() {
  try {
    logs = await fetchJSON('/api/sync/logs?limit=30') || [];
  } catch {
    logs = [];
  }
  renderLastSync('receipts', 'receiptsLastSync');
  renderLastSync('items', 'itemsLastSync');
  renderLastSync('pos_devices', 'posDevicesLastSync');
  renderHistory();
}

async function runSync(url, btnId, successKey) {
  const btn = getEl(btnId);
  if (btn) { btn.disabled = true; btn.textContent = t('sync.syncing'); }
  try {
    const res = await apiPost(url, {});
    const data = res.data || {};
    if (res.ok) {
      const msg = data.status === 'skipped'
        ? t('sync.skipped')
        : t(successKey, { count: data.inserted ?? 0 });
      showToast(msg, 'success');
    } else {
      showToast(data.error || t('sync.failed'), 'error');
    }
  } catch {
    showToast(t('sync.failedConnection'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('sync.syncNow'); }
    loadLogs();
    loadSchedulerStatus();
  }
}

export function syncReceipts()    { return runSync('/api/sync/receipts',    'syncReceiptsBtn',    'sync.receiptsSuccess'); }
export function syncItems()       { return runSync('/api/sync/items',       'syncItemsBtn',       'sync.itemsSuccess'); }
export function syncPosDevices()  { return runSync('/api/sync/pos-devices', 'syncPosDevicesBtn',  'sync.posDevicesSuccess'); }

// ─── Archive (admin only) ─────────────────────────────────────────────────────

// Dates arrive as UTC ISO timestamps; render them on the Cambodia calendar.
const toKHDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });

function fmtRangeLine(labelKey, s) {
  const range = s.min_day ? ` (${toKHDay(s.min_day)} → ${toKHDay(s.max_day)})` : '';
  return `<div>${t(labelKey, { count: s.count })}${range}</div>`;
}

async function loadArchiveStatus() {
  const el = getEl('archiveStatus');
  if (!el) return;
  const data = await fetchJSON('/api/archive/status');
  if (!data) { el.textContent = t('sync.failed'); return; }
  el.innerHTML =
    fmtRangeLine('sync.archiveStatusLive', data.live) +
    fmtRangeLine('sync.archiveStatusArchive', data.archive);
}

export async function archiveReceipts() {
  const cutoff = getEl('archiveCutoff')?.value;
  if (!cutoff) { showToast(t('sync.archiveNoCutoff'), 'error'); return; }

  const preview = await fetchJSON(`/api/archive/status?cutoff=${cutoff}`);
  if (!preview) { showToast(t('sync.failed'), 'error'); return; }
  if (!preview.affected) { showToast(t('sync.archiveNothing'), 'success'); return; }
  if (!(await showConfirm(t('sync.archiveConfirm', { count: preview.affected, cutoff }), { danger: true }))) return;

  const btn = getEl('archiveBtn');
  if (btn) { btn.disabled = true; }
  try {
    const res = await apiPost('/api/archive', { cutoff });
    const data = res.data || {};
    if (res.ok && data.status === 'success') {
      showToast(t('sync.archiveSuccess', { count: data.moved.receipts }), 'success');
    } else {
      showToast(data.error || t('sync.failed'), 'error');
    }
  } catch {
    showToast(t('sync.failedConnection'), 'error');
  } finally {
    if (btn) { btn.disabled = false; }
    loadArchiveStatus();
  }
}

// ─── Receipts coverage / gap report ───────────────────────────────────────────

const COVERAGE_STATUS_KEYS = {
  success: 'sync.covSuccess', partial: 'sync.covPartial',
  missing: 'sync.covMissing', failed: 'sync.covFailed', running: 'sync.covRunning',
};

let coverageDays = 60;

function coverageCellClass(status) {
  if (status === 'success') return 'cov-success';
  if (status === 'partial') return 'cov-partial';
  if (status === 'running') return 'cov-running';
  return 'cov-missing'; // 'missing' and 'failed' read the same — both need a backfill
}

async function loadCoverage() {
  const strip = getEl('coverageStrip');
  if (!strip) return;
  strip.innerHTML = `<div class="text-xs text-[color:var(--text-secondary)]">${t('common.loading')}</div>`;

  const data = await fetchJSON(`/api/sync/receipts/coverage?days=${coverageDays}`);
  if (!data) { strip.innerHTML = `<div class="text-xs" style="color:var(--loss)">${t('sync.failed')}</div>`; return; }

  strip.innerHTML = data.days.map(d => {
    const cls = coverageCellClass(d.status);
    const label = t(COVERAGE_STATUS_KEYS[d.status] || 'sync.covMissing');
    const title = `${d.date} · ${esc(label)} · ${t('sync.covCount', { count: d.count })}`;
    const onclick = d.gap ? ` onclick="backfillDate('${d.date}')"` : '';
    return `<span class="coverage-cell ${cls}${d.gap ? ' coverage-cell--gap' : ''}" title="${title}"${onclick}></span>`;
  }).join('');
}

export function setCoverageDays(value) {
  coverageDays = parseInt(value, 10) || 60;
  loadCoverage();
}

export async function backfillDate(dateStr) {
  if (!(await showConfirm(t('sync.backfillConfirmDay', { date: dateStr }), { confirmText: t('sync.backfillBtn') }))) return;
  await runBackfill(dateStr, dateStr);
}

export async function backfillRange() {
  const start = getEl('backfillStart')?.value;
  const end   = getEl('backfillEnd')?.value;
  if (!start || !end) { showToast(t('sync.backfillNoRange'), 'error'); return; }
  if (!(await showConfirm(t('sync.backfillConfirmRange', { start, end }), { confirmText: t('sync.backfillBtn') }))) return;
  await runBackfill(start, end);
}

async function runBackfill(start, end) {
  const btn = getEl('backfillRangeBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('sync.syncing'); }
  try {
    const res = await apiPost('/api/sync/receipts', { start_date: start, end_date: end });
    const data = res.data || {};
    if (res.ok) {
      const totalInserted = (data.days || []).reduce((sum, d) => sum + (d.inserted || 0), 0);
      const totalUpdated  = (data.days || []).reduce((sum, d) => sum + (d.updated  || 0), 0);
      showToast(t('sync.backfillDone', { inserted: totalInserted, updated: totalUpdated }), data.status === 'failed' ? 'error' : 'success');
    } else {
      showToast(data.message || data.error || t('sync.failed'), 'error');
    }
  } catch {
    showToast(t('sync.failedConnection'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('sync.backfillRange'); }
    loadCoverage();
    loadLogs();
    loadSchedulerStatus();
  }
}

export function init() {
  loadLogs();
  loadSchedulerStatus();
  loadCoverage();
  if (state.currentUserRole === 'admin') {
    const card = getEl('archiveCard');
    if (card) card.style.display = '';
    loadArchiveStatus();

    const pdCard = getEl('posDevicesCard');
    if (pdCard) pdCard.style.display = '';
  }
}
