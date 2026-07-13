import { apiPost, fetchJSON } from '../api.js';
import { getEl, fmtDatetime, TZ } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from '../toast.js';
import { state } from '../state.js';

let logs = [];

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function statusIcon(status) {
  return status === 'success' ? '✅' : status === 'skipped' ? '⏭' : '❌';
}

function renderLastSync(type, mountId) {
  const el = getEl(mountId);
  if (!el) return;
  const row = logs.find(l => l.sync_type === type);
  if (!row) { el.textContent = t('sync.never'); return; }
  const by = row.triggered_by === 'auto' ? t('sync.auto') : t('sync.manual');
  el.textContent = t('sync.lastSync', { icon: statusIcon(row.status), date: fmtDatetime(row.created_at), by });
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
      <td class="py-2 pr-3">${l.sync_type === 'items' ? t('sync.typeItems') : t('sync.typeReceipts')}</td>
      <td class="py-2 pr-3">${fmtDatetime(l.created_at)}</td>
      <td class="py-2 pr-3">${statusIcon(l.status)} ${esc(l.status)}</td>
      <td class="py-2 pr-3 text-right">${l.inserted ?? 0}</td>
      <td class="py-2 pr-3">${l.triggered_by === 'auto' ? t('sync.auto') : t('sync.manual')}</td>
      <td class="py-2 text-xs text-[color:var(--loss)]">${esc(l.error_message || '')}</td>
    </tr>`).join('');
}

async function loadLogs() {
  try {
    logs = await fetchJSON('/api/sync/logs?limit=30') || [];
  } catch {
    logs = [];
  }
  renderLastSync('receipts', 'receiptsLastSync');
  renderLastSync('items', 'itemsLastSync');
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
  }
}

export function syncReceipts() { return runSync('/api/sync/receipts', 'syncReceiptsBtn', 'sync.receiptsSuccess'); }
export function syncItems()    { return runSync('/api/sync/items',    'syncItemsBtn',    'sync.itemsSuccess'); }

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
  if (!confirm(t('sync.archiveConfirm', { count: preview.affected, cutoff }))) return;

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

export function init() {
  loadLogs();
  if (state.currentUserRole === 'admin') {
    const card = getEl('archiveCard');
    if (card) card.style.display = '';
    loadArchiveStatus();
  }
}
