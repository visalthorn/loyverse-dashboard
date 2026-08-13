import { fetchJSON } from '../api.js';
import { getEl, fmtDatetime, downloadCSV } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from '../toast.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const PAGE_SIZE = 50;
let page = 1;
let total = 0;
let items = [];
let expandedId = null;

function currentFilters() {
  return {
    start:  getEl('auditStart')?.value  || '',
    end:    getEl('auditEnd')?.value    || '',
    actor:  getEl('auditActor')?.value.trim() || '',
    entity: getEl('auditEntity')?.value || '',
    action: getEl('auditAction')?.value || '',
  };
}

function buildParams(filters, overrides = {}) {
  const params = new URLSearchParams();
  if (filters.start)  params.set('start', filters.start);
  if (filters.end)    params.set('end', filters.end);
  if (filters.actor)  params.set('actor', filters.actor);
  if (filters.entity) params.set('entity', filters.entity);
  if (filters.action) params.set('action', filters.action);
  Object.entries(overrides).forEach(([k, v]) => params.set(k, v));
  return params;
}

async function loadAuditLog() {
  const tbody = getEl('auditTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="py-10 text-center text-[color:var(--text-secondary)]">${t('audit.loadingRow')}</td></tr>`;

  const params = buildParams(currentFilters(), { page, per_page: PAGE_SIZE });
  const data = await fetchJSON(`/api/audit?${params}`);
  if (!data?.items) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="py-10 text-center text-[color:var(--loss)]">${t('audit.loadFailed')}</td></tr>`;
    return;
  }

  items = data.items;
  total = data.total;
  expandedId = null;
  renderTable();
  renderPager();
}

// ─── Diff rendering ──────────────────────────────────────────────────────────

// Union of before/after keys, one row per key, highlighting where the value
// actually changed -- so a diff with mostly-unchanged fields (e.g. an
// expense edit that only touched `amount`) doesn't force the reader to
// eyeball two full JSON blobs to spot the one line that matters.
function renderDiffTable(before, after) {
  if (!before && !after) return `<div class="text-xs text-[color:var(--text-secondary)] py-2 px-3">${t('audit.noDiffData')}</div>`;
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
  const rows = keys.map(k => {
    const b = before ? before[k] : undefined;
    const a = after  ? after[k]  : undefined;
    const changed = JSON.stringify(b) !== JSON.stringify(a);
    return `<tr class="${changed ? 'audit-diff-changed' : ''}">
      <td class="font-mono text-[color:var(--text-secondary)]">${esc(k)}</td>
      <td class="font-mono">${esc(b === undefined ? '—' : JSON.stringify(b))}</td>
      <td class="font-mono">${esc(a === undefined ? '—' : JSON.stringify(a))}</td>
    </tr>`;
  }).join('');
  return `<table class="audit-diff-table w-full">
    <thead><tr class="text-[color:var(--text-secondary)]">
      <th class="text-left">${t('audit.diffField')}</th>
      <th class="text-left">${t('audit.diffBefore')}</th>
      <th class="text-left">${t('audit.diffAfter')}</th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="3" class="text-[color:var(--text-secondary)]">${t('audit.noDiffData')}</td></tr>`}</tbody>
  </table>`;
}

export function toggleAuditDiff(id) {
  // audit_log.id is a Postgres BIGSERIAL -- pg returns bigint columns as
  // strings to avoid precision loss, but the onclick attribute embeds this
  // as a bare numeric literal, so `id` here arrives as a JS number while
  // row.id (from the fetched JSON) is a string. Compare as strings so
  // "10" === 10 doesn't silently fail and leave every row uncollapsible.
  expandedId = String(expandedId) === String(id) ? null : String(id);
  renderTable();
}

// ─── Table ───────────────────────────────────────────────────────────────────

const ACTION_COLORS = {
  create: 'var(--gain)', update: 'var(--chart-2)', delete: 'var(--loss)',
  login: 'var(--gain)', login_failed: 'var(--loss)', permission_change: 'var(--chart-3)', sync: 'var(--text-muted)',
};

function renderTable() {
  const tbody = getEl('auditTableBody');
  if (!tbody) return;

  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-10 text-center text-[color:var(--text-secondary)]">${t('audit.noRowsFound')}</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(row => {
    const color = ACTION_COLORS[row.action] || 'var(--text-muted)';
    const isOpen = expandedId !== null && String(expandedId) === String(row.id);
    const mainRow = `<tr class="border-b border-[color:var(--border)] hover:bg-[color:var(--hover-tint)]">
      <td class="py-2 pr-3 text-[color:var(--text-secondary)] text-xs whitespace-nowrap">${fmtDatetime(row.created_at)}</td>
      <td class="py-2 pr-3 text-xs">${esc(row.actor_username || '—')}</td>
      <td class="py-2 pr-3 text-xs"><span class="badge" style="background:color-mix(in srgb, ${color} 14%, transparent);color:${color}">${esc(row.action)}</span></td>
      <td class="py-2 pr-3 text-xs">${esc(row.entity)}</td>
      <td class="py-2 pr-3 text-xs font-mono">${esc(row.entity_id ?? '—')}</td>
      <td class="py-2 pr-3 text-xs font-mono text-[color:var(--text-secondary)]">${esc(row.ip || '—')}</td>
      <td class="py-2 text-center">
        <button onclick="toggleAuditDiff(${row.id})" class="text-xs text-[color:var(--accent-strong)] hover:opacity-80">
          ${isOpen ? t('audit.hideDiff') : t('audit.viewDiff')}
        </button>
      </td>
    </tr>`;
    const diffRow = isOpen
      ? `<tr class="audit-diff-row"><td colspan="7">${renderDiffTable(row.before_data, row.after_data)}</td></tr>`
      : '';
    return mainRow + diffRow;
  }).join('');
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const info = getEl('auditPageInfo');
  if (info) info.textContent = t('audit.pageInfo', { page, pages, total });
  const totalEl = getEl('auditTotal');
  if (totalEl) totalEl.textContent = t('audit.totalRows', { total });
  const prev = getEl('auditPrevBtn');
  const next = getEl('auditNextBtn');
  if (prev) prev.disabled = page <= 1;
  if (next) next.disabled = page >= pages;
}

export function auditPrevPage() {
  if (page <= 1) return;
  page -= 1;
  loadAuditLog();
}

export function auditNextPage() {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page >= pages) return;
  page += 1;
  loadAuditLog();
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export function applyAuditFilters(e) {
  e.preventDefault();
  page = 1;
  loadAuditLog();
}

export function resetAuditFilters() {
  getEl('auditFilterForm')?.reset();
  page = 1;
  loadAuditLog();
}

// ─── CSV export ──────────────────────────────────────────────────────────────

export async function exportAuditCSV() {
  const params = buildParams(currentFilters(), { page: 1, per_page: 1000 });
  const data = await fetchJSON(`/api/audit?${params}`);
  if (!data?.items) return showToast(t('audit.exportLoadFailed'), 'error');
  downloadCSV(`audit-log-${new Date().toISOString().slice(0, 10)}.csv`, [
    [t('audit.thWhen'), t('audit.thActor'), t('audit.thAction'), t('audit.thEntity'), t('audit.thEntityId'), t('audit.thIp'), 'user_agent', 'before_data', 'after_data'],
    ...data.items.map(r => [
      r.created_at, r.actor_username || '', r.action, r.entity, r.entity_id ?? '',
      r.ip || '', r.user_agent || '',
      r.before_data ? JSON.stringify(r.before_data) : '',
      r.after_data  ? JSON.stringify(r.after_data)  : '',
    ]),
  ]);
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function init() {
  page = 1;
  loadAuditLog();
}
