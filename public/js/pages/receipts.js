import { fetchJSON, apiPost } from '../api.js';
import { getEl, fmtRaw, fmtKHR, downloadCSV, TZ, getTodayDate } from '../utils.js';
import { t } from '../i18n.js';
import { renderDateFilter } from '../dateFilter.js';
import { renderBranchFilter } from '../branchFilter.js';
import { showToast } from '../toast.js';
import { showConfirm } from '../dialog.js';
import { state } from '../state.js';

const PAGE_SIZE = 25;

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

let allReceipts = [];
let displayed   = [];
let currentPage = 1;
let selectedId  = null;
let isLoading   = false;
let filterStart = '';
let filterEnd   = '';
let receiptSource = 'own'; // 'loyverse' | 'own' | 'cancellations'
let ownBranchId = null;

let cancellationsFiltersMounted = false;
let cancellationsBranchId = null;
let cancellationsStart = '';
let cancellationsEnd = '';
let cancellationsTerminalId = '';

// ─── Formatters (receipts-specific) ─────────────────────────────────────────

function formatCurrency(val) {
  if (val == null) return '—';
  return 'KHR ' + Number(val).toLocaleString();
}

function formatDate(str) {
  if (!str) return '—';
  try {
    return new Date(str).toLocaleString('en-GB', {
      timeZone: TZ,
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch { return str; }
}

// ─── Load ────────────────────────────────────────────────────────────────────

export async function loadReceipts() {
  if (isLoading) return;
  isLoading = true;
  setTableLoading(true);

  const start = filterStart;
  const end   = filterEnd;
  const type  = getEl('filterType')?.value || '';

  const params = new URLSearchParams({ per_page: 500, source: receiptSource });
  if (start) params.set('start', start);
  if (end)   params.set('end',   end);
  if (type)  params.set('type',  type);
  if (receiptSource === 'own' && ownBranchId) params.set('branch', ownBranchId);

  const data = await fetchJSON(`/api/receipts?${params}`);
  allReceipts = data ? (data.receipts ?? []) : (receiptSource === 'loyverse' ? filterDemoData(start, end, type) : []);

  isLoading   = false;
  currentPage = 1;
  renderStats();
  applySearch();
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function renderStats() {
  const salesRows  = allReceipts.filter(r => r.receipt_type === 'SALE' && r.is_canceled === 'No');
  const refundRows = allReceipts.filter(r => r.receipt_type === 'REFUND');

  const salesAmt  = salesRows.reduce((s, r)  => s + parseFloat(r.total_money || 0), 0);
  const refundAmt = refundRows.reduce((s, r) => s + parseFloat(r.total_money || 0), 0);
  // Own-POS refunds (receiptSource 'own') flip the one existing row straight
  // from SALE to REFUND (routes/receipts.js POST /:id/refund) -- salesAmt
  // above already excludes it once its type flips, so it must NOT also be
  // subtracted here or it's double-counted out of the total. Loyverse-synced
  // receipts still keep the original two-row shape (a standalone REFUND
  // receipt alongside its untouched original SALE row), where subtracting
  // is the correct way to net a partial-or-full refund back out.
  const totalAmt = receiptSource === 'own' ? salesAmt : (salesAmt - refundAmt);

  const set = (id, val) => { const el = getEl(id); if (el) el.textContent = val; };
  set('statTotal',         allReceipts.length);
  set('statTotalAmount',   fmtKHR(totalAmt));
  set('statSales',         salesRows.length);
  set('statSalesAmount',   fmtKHR(salesAmt));
  set('statRefunds',       refundRows.length);
  set('statRefundsAmount', fmtKHR(refundAmt));
}

// ─── Search / Filter ─────────────────────────────────────────────────────────

export function switchReceiptSource(source) {
  if (source === receiptSource) return;
  receiptSource = source;
  currentPage = 1;
  selectedId  = null;
  getEl('receiptTabLoyverse')?.classList.toggle('active', source === 'loyverse');
  getEl('receiptTabOwn')?.classList.toggle('active', source === 'own');
  getEl('receiptTabCancellations')?.classList.toggle('active', source === 'cancellations');
  getEl('ownBranchFilterRow')?.classList.toggle('hidden', source !== 'own');
  getEl('liveOrdersCard')?.classList.toggle('hidden', source !== 'own');
  getEl('liveActivityCard')?.classList.toggle('hidden', source !== 'own');

  // Cancellations is a different shape entirely (two small activity tables,
  // not a paginated receipt list + detail panel) -- swap the whole layout
  // rather than reusing the receipts table.
  getEl('statsRow')?.classList.toggle('hidden', source === 'cancellations');
  getEl('receiptsLayoutSection')?.classList.toggle('hidden', source === 'cancellations');
  getEl('cancellationsSection')?.classList.toggle('hidden', source !== 'cancellations');

  const empty = getEl('detailEmpty'), content = getEl('detailContent'), panel = getEl('detailPanel');
  if (empty && content && panel) { empty.classList.remove('hidden'); content.classList.add('hidden'); panel.classList.remove('active'); }

  if (source === 'own') {
    mountOwnBranchFilter();
    loadLiveOrders();
    loadLiveActivity();
    startLiveOrdersPoll();
    loadReceipts();
  } else if (source === 'cancellations') {
    stopLiveOrdersPoll();
    if (!cancellationsFiltersMounted) { mountCancellationsFilters(); cancellationsFiltersMounted = true; }
    else loadCancellations();
  } else {
    stopLiveOrdersPoll();
    loadReceipts();
  }
}

function mountOwnBranchFilter() {
  // renderBranchFilter pre-selects state.branchId (persisted across pages) in
  // the dropdown -- sync the module-local filter value to match, otherwise
  // the dropdown shows a branch selected while the list still shows all of them.
  ownBranchId = state.branchId ?? null;
  renderBranchFilter(getEl('ownBranchFilterMount'), {
    onChange: (branchId) => { ownBranchId = branchId; loadReceipts(); },
  });
}

// ─── Cancellations tab (POS revision, 2026-08-02) ───────────────────────────
// Accountability view replacing the removed ownership/kitchen-status
// restrictions on cancel-order and cancel-item -- reads GET
// /api/dashboard/cancellations (routes/cancellations.js), which itself reads
// the general pos_order_events activity log.

function mountCancellationsFilters() {
  cancellationsBranchId = state.branchId ?? null;
  renderBranchFilter(getEl('cancellationsBranchFilterMount'), {
    onChange: (branchId) => { cancellationsBranchId = branchId; loadCancellations(); },
  });
  // renderDateFilter fires onChange once immediately on mount, which is what
  // triggers the first loadCancellations() call -- no separate initial load needed.
  renderDateFilter(getEl('cancellationsDateFilterMount'), {
    presets: [{ key: 'yesterday', labelKey: 'common.yesterday' }, { key: 'last10', labelKey: 'common.last10Days' }],
    defaultPreset: 'last10',
    onChange: ({ start, end }) => { cancellationsStart = start; cancellationsEnd = end; loadCancellations(); },
  });
}

export function onCancellationsTerminalChange(value) {
  cancellationsTerminalId = value;
  loadCancellations();
}

export async function loadCancellations() {
  const params = new URLSearchParams();
  if (cancellationsBranchId)   params.set('branch_id', cancellationsBranchId);
  if (cancellationsStart)      params.set('start', cancellationsStart);
  if (cancellationsEnd)        params.set('end', cancellationsEnd);
  if (cancellationsTerminalId) params.set('terminal_id', cancellationsTerminalId);

  const data = await fetchJSON(`/api/dashboard/cancellations?${params}`);
  const orders = data ? data.orders : [];
  const items  = data ? data.items  : [];

  // The per-branch terminal list is admin-only (routes/branches.js) and a
  // manager can view this tab -- so the terminal filter is populated from
  // whatever terminals actually appear in the current result set instead.
  const termSel = getEl('cancellationsTerminalFilter');
  if (termSel) {
    const seen = new Map();
    [...orders, ...items].forEach(r => { if (r.terminal_id) seen.set(r.terminal_id, r.terminal_name || r.terminal_id); });
    const current = termSel.value;
    termSel.innerHTML = `<option value="">${t('receipts.typeAll')}</option>` +
      [...seen.entries()].map(([id, name]) => `<option value="${esc(id)}"${id === current ? ' selected' : ''}>${esc(name)}</option>`).join('');
  }

  const ordersBody = getEl('cancelledOrdersTbody');
  ordersBody.innerHTML = orders.length ? orders.map(r => `
    <tr class="border-b border-[color:var(--border-subtle)]">
      <td class="py-2 pr-3">${esc(formatDate(r.created_at))}</td>
      <td class="py-2 pr-3">${esc(r.branch_name || '—')}</td>
      <td class="py-2 pr-3">${esc(r.terminal_name || r.terminal_id || '—')}</td>
      <td class="py-2 pr-3">${esc(r.order_number)}</td>
      <td class="py-2 pr-3 text-right">${r.order_total != null ? formatCurrency(r.order_total) : '—'}</td>
      <td class="py-2">${esc(r.reason || '—')}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty-state">${t('receipts.noCancellations')}</td></tr>`;

  const itemsBody = getEl('cancelledItemsTbody');
  itemsBody.innerHTML = items.length ? items.map(r => `
    <tr class="border-b border-[color:var(--border-subtle)]">
      <td class="py-2 pr-3">${esc(formatDate(r.created_at))}</td>
      <td class="py-2 pr-3">${esc(r.branch_name || '—')}</td>
      <td class="py-2 pr-3">${esc(r.terminal_name || r.terminal_id || '—')}</td>
      <td class="py-2 pr-3">${esc(r.order_number)}</td>
      <td class="py-2 pr-3">${esc(r.item_name || '—')} × ${r.qty_removed ?? '—'}${r.qty_remaining ? ` (kept ${r.qty_remaining})` : ''}</td>
      <td class="py-2">${esc(r.reason || '—')}</td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty-state">${t('receipts.noCancellations')}</td></tr>`;
}

export function onApiFilterChange() { loadReceipts(); }

export function onSearchChange() {
  currentPage = 1;
  applySearch();
}

function applySearch() {
  const q = getEl('searchInput')?.value.trim().toLowerCase() || '';
  displayed = q
    ? allReceipts.filter(r =>
        (r.receipt_number || '').toLowerCase().includes(q) ||
        (r.pos_device     || '').toLowerCase().includes(q) ||
        String(r.order || '').includes(q)
      )
    : allReceipts;

  const resultCount = getEl('resultCount');
  if (resultCount) resultCount.textContent = q
    ? t('receipts.resultCountFiltered', { count: displayed.length, total: allReceipts.length })
    : t('receipts.resultCountAll', { total: allReceipts.length });

  setTableLoading(false);
  renderTable();
  renderPagination();
}

export function applyDateFilter({ start, end }) {
  filterStart = start;
  filterEnd   = end;
  loadReceipts();
}

function mountDateFilter(initial) {
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [{ key: 'yesterday', labelKey: 'common.yesterday' }],
    defaultPreset: 'yesterday',
    onChange: applyDateFilter,
    initial,
  });
}

export function resetFilters() {
  const set = (id, val) => { const el = getEl(id); if (el) el.value = val; };
  set('searchInput', '');
  set('filterType',  '');
  mountDateFilter();
}

function setTableLoading(on) {
  if (on) {
    const tbody = getEl('receiptsTbody');
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="empty-state"><span class="loading-dots">${t('receipts.loading')}</span></td></tr>`;
    const pageInfo = getEl('pageInfo');
    if (pageInfo) pageInfo.textContent = t('receipts.pageInfo', { page: 1, pages: 1 });
  }
}

// ─── Table ───────────────────────────────────────────────────────────────────

function renderTable() {
  const tbody = getEl('receiptsTbody');
  if (!tbody) return;
  const start = (currentPage - 1) * PAGE_SIZE;
  const rows  = displayed.slice(start, start + PAGE_SIZE);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state">${t('receipts.noResults')}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((r, i) => {
    const idx         = start + i + 1;
    const typeClass   = r.receipt_type === 'REFUND' ? 'badge-refund' : 'badge-sale';
    const typeLabel   = r.receipt_type === 'SALE' ? t('receipts.typeSale') : r.receipt_type === 'REFUND' ? t('receipts.typeRefund') : (r.receipt_type || '—');
    const cancelBadge = r.is_canceled === 'Yes'
      ? `<span class="badge badge-canceled">${t('receipts.yes')}</span>`
      : '<span class="text-[color:var(--text-muted)] text-xs">—</span>';
    const sel = r.id === selectedId ? 'selected' : '';

    return `<tr class="receipt-row ${sel}" onclick="selectReceipt(${r.id})">
      <td class="py-2.5 pr-3 text-[color:var(--text-muted)] text-xs pl-1">${idx}</td>
      <td class="py-2.5 pr-3 num text-[color:var(--accent-strong)] font-semibold text-xs">${r.receipt_number}</td>
      <td class="py-2.5 pr-3 text-[color:var(--text-muted)] text-xs">${r.order ?? '—'}</td>
      <td class="py-2.5 pr-3 text-[color:var(--text-secondary)] text-xs whitespace-nowrap">${formatDate(r.receipt_date)}</td>
      <td class="py-2.5 pr-3 text-[color:var(--text-secondary)] text-xs">${r.pos_device ?? '—'}</td>
      <td class="py-2.5 pr-3 text-center"><span class="badge ${typeClass}">${typeLabel}</span></td>
      <td class="py-2.5 pr-3 text-center">${cancelBadge}</td>
      <td class="py-2.5 text-right font-semibold text-[color:var(--text-primary)] text-xs whitespace-nowrap">${formatCurrency(r.total_money)}</td>
    </tr>`;
  }).join('');
}

// ─── Pagination ──────────────────────────────────────────────────────────────

function renderPagination() {
  const total    = Math.ceil(displayed.length / PAGE_SIZE);
  const ctrl     = getEl('paginationControls');
  const pageInfo = getEl('pageInfo');

  if (pageInfo) pageInfo.textContent = t('receipts.pageInfo', { page: currentPage, pages: total || 1 });
  if (!ctrl) return;
  if (total <= 1) { ctrl.innerHTML = ''; return; }

  const show   = new Set([1, total, currentPage, currentPage - 1, currentPage + 1].filter(p => p >= 1 && p <= total));
  const sorted = [...show].sort((a, b) => a - b);

  let html = `<button class="page-btn" onclick="changePage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>‹</button>`;
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) html += `<span class="page-btn" style="cursor:default;color:var(--text-muted)">…</span>`;
    html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" onclick="changePage(${p})">${p}</button>`;
    prev = p;
  }
  html += `<button class="page-btn" onclick="changePage(${currentPage + 1})" ${currentPage === total ? 'disabled' : ''}>›</button>`;
  ctrl.innerHTML = html;
}

export function changePage(p) {
  const total = Math.ceil(displayed.length / PAGE_SIZE);
  if (p < 1 || p > total) return;
  currentPage = p;
  renderTable();
  renderPagination();
}

// ─── Detail Panel ────────────────────────────────────────────────────────────

export function selectReceipt(id) {
  selectedId = id;
  const r = allReceipts.find(x => x.id === id);
  renderTable();
  if (!r) return;

  const panel   = getEl('detailPanel');
  const empty   = getEl('detailEmpty');
  const content = getEl('detailContent');
  if (!panel || !empty || !content) return;

  empty.classList.add('hidden');
  content.classList.remove('hidden');
  panel.classList.add('active');

  const items     = Array.isArray(r.items) ? r.items : [];
  const isRefund  = r.receipt_type === 'REFUND';
  const typeClass = isRefund ? 'val-loss' : 'val-gain';
  const typeLabel = isRefund ? t('receipts.typeRefund') : t('receipts.typeSale');
  const cancelNote = r.is_canceled === 'Yes'
    ? `<span class="badge badge-canceled ml-2">${t('receipts.canceledBadge')}</span>`
    : '';

  const itemsHtml = items.map(it => `
    <div class="detail-item-row">
      <div>
        <div class="detail-item-name">${it.item_name}</div>
        <div class="detail-item-qty">${it.qty} × ${formatCurrency(it.unit_price)}</div>
      </div>
      <div class="detail-item-price">${formatCurrency(it.total_price)}</div>
    </div>`).join('');

  content.innerHTML = `
    <div class="detail-header">
      <div class="flex items-start justify-between gap-2 mb-2">
        <div>
          <div class="text-xs text-[color:var(--text-muted)] mb-0.5">${t('receipts.thReceiptNo')}</div>
          <div class="num font-bold text-[color:var(--accent-strong)] text-base">${r.receipt_number}</div>
        </div>
        <div class="text-right">
          <span class="badge ${isRefund ? 'badge-refund' : 'badge-sale'} text-sm px-3 py-1">${typeLabel}</span>
          ${cancelNote}
        </div>
      </div>
      <div class="text-2xl font-bold text-[color:var(--text-primary)] mb-1">${formatCurrency(r.total_money)}</div>
      <div class="text-xs text-[color:var(--text-muted)]">${t('receipts.thTotal')}</div>
    </div>
    <div class="p-4 space-y-3 text-xs">
      <div class="grid grid-cols-2 gap-2">
        <div><div class="text-[color:var(--text-muted)] mb-0.5">${t('receipts.thOrder')}</div><div class="text-[color:var(--text-primary)]">${r.order ?? '—'}</div></div>
        <div><div class="text-[color:var(--text-muted)] mb-0.5">${t('receipts.detailPosDevice')}</div><div class="text-[color:var(--text-primary)]">${r.pos_device ?? '—'}</div></div>
        <div><div class="text-[color:var(--text-muted)] mb-0.5">${t('receipts.thDate')}</div><div class="text-[color:var(--text-primary)]">${formatDate(r.receipt_date)}</div></div>
      </div>
      ${itemsHtml ? `<div class="border-t border-[color:var(--border)] pt-3"><div class="text-[color:var(--text-muted)] font-semibold mb-2">${t('receipts.detailItems')}</div>${itemsHtml}</div>` : ''}
      <div class="border-t border-[color:var(--border)] pt-3 flex justify-between font-semibold">
        <span class="text-[color:var(--text-secondary)]">${t('receipts.thTotal')}</span>
        <span class="${typeClass}">${formatCurrency(r.total_money)}</span>
      </div>
      <div class="border-t border-[color:var(--border)] pt-3">
        <button onclick="exportReceiptPDF()" class="w-full bg-[color:var(--bg-surface-alt)] hover:bg-[color:var(--border)] text-[color:var(--text-primary)] text-xs font-semibold py-2 rounded flex items-center justify-center gap-1.5">${t('receipts.exportPdf')}</button>
      </div>
      ${receiptSource === 'own' && r.refundable && state.userPermissions.receipts?.can_write ? `
      <div class="border-t border-[color:var(--border)] pt-3">
        <input id="refundReasonInput" type="text" maxlength="200" placeholder="${t('receipts.refundReasonPlaceholder')}" class="field-input w-full mb-2"/>
        <button onclick="refundReceipt(${r.id})" class="w-full text-[color:var(--loss)] border border-[color:var(--loss)] hover:bg-[color:var(--loss)] hover:text-white text-xs font-semibold py-2 rounded flex items-center justify-center gap-1.5">${t('receipts.refundBtn')}</button>
      </div>` : ''}
    </div>`;
}

export async function refundReceipt(id) {
  const ok = await showConfirm(t('receipts.refundConfirm'), { danger: true, confirmText: t('receipts.refundBtn') });
  if (!ok) return;
  const reason = (getEl('refundReasonInput')?.value || '').trim();
  const res = await apiPost(`/api/receipts/${id}/refund`, { reason });
  if (!res.ok) { showToast(res.data.message || t('receipts.refundFailed'), 'error'); return; }
  showToast(t('receipts.refundSuccess'));
  selectedId = null;
  // loadReceipts() only re-renders the table -- without this the detail
  // panel keeps showing the pre-refund view (including the now-stale Refund
  // button) since nothing else clears it once selectedId is nulled.
  const empty = getEl('detailEmpty'), content = getEl('detailContent'), panel = getEl('detailPanel');
  if (empty && content && panel) { empty.classList.remove('hidden'); content.classList.add('hidden'); panel.classList.remove('active'); }

  // The new refund row is always dated "now" (see routes/receipts.js
  // /:id/refund). If the currently applied date range ends before today, that
  // row -- and its contribution to the Refunds stat card -- falls outside the
  // window loadReceipts() is about to (re)fetch, so it silently stays at 0
  // even though the refund succeeded. Extend the visible range forward to
  // include today so what just happened is actually visible, same as the
  // list/detail-panel updates above; loadReceipts() runs as part of this
  // re-mount's onChange, so no separate call is needed here.
  const today = getTodayDate();
  if (today > filterEnd) {
    mountDateFilter({ period: 'range', start: filterStart, end: today });
  } else {
    await loadReceipts();
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export function exportReceiptsCSV() {
  if (!allReceipts.length) return showToast(t('receipts.exportNoData'), 'error');
  downloadCSV(`receipts-${new Date().toISOString().slice(0, 10)}.csv`, [
    [t('receipts.csvReceiptNo'), t('receipts.csvOrder'), t('receipts.csvDate'), t('receipts.csvPosDevice'), t('receipts.csvType'), t('receipts.csvCanceled'), t('receipts.csvTotal')],
    ...allReceipts.map(r => [
      r.receipt_number, r.order ?? '', formatDate(r.receipt_date), r.pos_device ?? '',
      r.receipt_type === 'SALE' ? t('receipts.typeSale') : r.receipt_type === 'REFUND' ? t('receipts.typeRefund') : (r.receipt_type ?? ''),
      r.is_canceled, r.total_money,
    ]),
  ]);
}

export function exportReceiptPDF() {
  const r = allReceipts.find(x => x.id === selectedId);
  if (!r) return;
  const items     = Array.isArray(r.items) ? r.items : [];
  const typeLabel = r.receipt_type === 'REFUND' ? t('receipts.typeRefund') : t('receipts.typeSale');
  const receiptLabel = t('receipts.printReceipt');
  const canceledLabel = t('receipts.canceledBadge');
  const dateLabel = t('receipts.csvDate');
  const posDeviceLabel = t('receipts.csvPosDevice');
  const orderLabel = t('receipts.csvOrder');
  const itemLabel = t('receipts.printItem');
  const qtyLabel = t('receipts.printQty');
  const unitPriceLabel = t('receipts.printUnitPrice');
  const totalLabel = t('receipts.thTotal');
  const thankYouLabel = t('receipts.printThankYou');

  const itemsHtml = items.map(it => `
    <tr>
      <td>${it.item_name}</td>
      <td style="text-align:center">${it.qty}</td>
      <td style="text-align:right">KHR ${Number(it.unit_price).toLocaleString()}</td>
      <td style="text-align:right">KHR ${Number(it.total_price).toLocaleString()}</td>
    </tr>`).join('');

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8"/><title>${receiptLabel} ${r.receipt_number}</title>
    <style>
      body{font-family:Arial,sans-serif;max-width:420px;margin:24px auto;font-size:13px;color:#111}
      h1{text-align:center;font-size:18px;margin:0 0 2px}
      .sub{text-align:center;color:#555;font-size:11px;margin-bottom:14px}
      .meta{display:flex;justify-content:space-between;margin:4px 0;font-size:12px}
      .meta span:first-child{color:#666}
      hr{border:none;border-top:1px dashed #999;margin:10px 0}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th{border-bottom:1px solid #333;padding:4px 6px;text-align:left}
      td{padding:4px 6px}
      .total-row td{border-top:1px solid #333;font-weight:bold;padding-top:6px}
      @media print{@page{margin:10mm}}
    </style></head><body>
    <h1>${receiptLabel}</h1>
    <div class="sub">${r.receipt_number} &bull; ${typeLabel}${r.is_canceled === 'Yes' ? ' &bull; ' + canceledLabel : ''}</div>
    <hr/>
    <div class="meta"><span>${dateLabel}</span><span>${formatDate(r.receipt_date)}</span></div>
    <div class="meta"><span>${posDeviceLabel}</span><span>${r.pos_device ?? '—'}</span></div>
    <div class="meta"><span>${orderLabel}</span><span>${r.order ?? '—'}</span></div>
    ${items.length ? `<hr/><table>
      <thead><tr><th>${itemLabel}</th><th style="text-align:center">${qtyLabel}</th><th style="text-align:right">${unitPriceLabel}</th><th style="text-align:right">${totalLabel}</th></tr></thead>
      <tbody>${itemsHtml}<tr class="total-row"><td colspan="3">${totalLabel}</td><td style="text-align:right">KHR ${Number(r.total_money).toLocaleString()}</td></tr></tbody>
    </table>` : `<hr/><div class="meta"><strong>${totalLabel}</strong><strong>KHR ${Number(r.total_money).toLocaleString()}</strong></div>`}
    <hr/>
    <div style="text-align:center;font-size:11px;color:#888;margin-top:8px">${thankYouLabel}</div>
    <script>window.print();window.onafterprint=()=>window.close();<\/script>
  </body></html>`);
  win.document.close();
}

// ─── Demo data fallback ──────────────────────────────────────────────────────

function filterDemoData(start, end, type) {
  return DEMO_RECEIPTS.filter(r => {
    const d = r.receipt_date?.slice(0, 10) || '';
    if (start && d < start) return false;
    if (end   && d > end)   return false;
    if (type  && r.receipt_type !== type) return false;
    return true;
  });
}

const DEMO_RECEIPTS = [
  { id:'r1292', receipt_number:'6-1292', order:'8', receipt_date:'2026-06-17T16:46:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:23000, items:[
    {item_name:'សុករសជ្រៀងជាន',qty:1,unit_price:17000,total_price:17000},{item_name:'ជាសស',qty:1,unit_price:1000,total_price:1000},
    {item_name:'សាក់យសម្ជ្រ',qty:1,unit_price:2000,total_price:2000},{item_name:'Coca-Cola',qty:1,unit_price:3000,total_price:3000},
  ]},
  { id:'r1291', receipt_number:'6-1291', order:'10', receipt_date:'2026-06-17T16:07:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:67000, items:[]},
  { id:'r1290', receipt_number:'6-1290', order:null,  receipt_date:'2026-06-17T16:01:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:86000, items:[]},
  ...Array.from({length:27}, (_,i) => ({
    id:`rdemo${i}`, receipt_number:`6-${1260+i}`, order:null,
    receipt_date: new Date(Date.now() - (i+1)*3600000).toISOString(),
    pos_device:'Shop Device', receipt_type: i % 9 === 0 ? 'REFUND' : 'SALE',
    is_canceled: i % 11 === 0 ? 'Yes' : 'No',
    total_money: (Math.floor(Math.random()*20)+1)*5000,
    items:[],
  })),
];

// ─── Own-POS: Live Orders ───────────────────────────────────────────────────

let liveOrdersTimer = null;

function elapsedLabel(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  const mins = Math.max(0, Math.floor(ms / 60000));
  return `${mins}m`;
}

let expandedLiveOrderId = null;
// Populated by every loadLiveOrders() poll -- lets loadLiveActivity's rows
// (below) know whether the order an event refers to is still jump-able, i.e.
// still open, without a second network round trip.
let liveOrders = [];

async function loadLiveOrders() {
  const data = await fetchJSON('/api/receipts/own/live');
  const list = getEl('liveOrdersList');
  const count = getEl('liveOrdersCount');
  if (!data) return;
  const orders = data.orders || [];
  liveOrders = orders;
  if (count) count.textContent = `${orders.length} active`;
  if (!list) return;
  if (!orders.length) {
    list.innerHTML = `<div class="empty-state">No live orders right now.</div>`;
    return;
  }
  list.innerHTML = orders.map(o => {
    const items = Array.isArray(o.items) ? o.items : [];
    const expanded = expandedLiveOrderId === o.id;
    const itemsHtml = expanded ? `
      <div class="live-order-items">
        ${items.map(it => `<div class="detail-item-row"><span>${it.qty} × ${esc(it.item_name)}</span><span>${fmtKHR(it.total_price)}</span></div>`).join('') || '<div class="detail-item-row">No items</div>'}
      </div>` : '';
    return `
      <div class="detail-item-row live-order-row" id="live-order-${o.id}" data-live-order-id="${o.id}" style="cursor:pointer;">
        <div>
          <div class="detail-item-name">${esc(o.branch_name) || '—'} · ${esc(o.order_number)}${o.name ? ' · ' + esc(o.name) : ''}</div>
          <div class="detail-item-qty">${esc((o.status || '').replace(/_/g, ' '))} · ${elapsedLabel(o.created_at)} · by ${esc(o.terminal_name) || '—'}</div>
        </div>
        <div class="detail-item-price">${fmtKHR(o.total)}</div>
      </div>
      ${itemsHtml}
    `;
  }).join('');
  list.querySelectorAll('[data-live-order-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = parseInt(el.dataset.liveOrderId, 10);
      expandedLiveOrderId = expandedLiveOrderId === id ? null : id;
      loadLiveOrders();
    });
  });
}

// Jump target for a Recent Activity row (see loadLiveActivity below). Only
// still-open orders are jump-able -- once an order's paid/cancelled it drops
// out of GET /own/live entirely (and this dashboard has no order-number
// search over historical/paid orders to fall back to), so that case is
// surfaced honestly with a toast instead of a link that silently does nothing.
function jumpToLiveOrder(orderId, orderNumber) {
  if (!liveOrders.some(o => o.id === orderId)) {
    showToast(`${orderNumber} is no longer active (already paid or cancelled).`, 'error');
    return;
  }
  expandedLiveOrderId = orderId;
  loadLiveOrders();
  const row = getEl(`live-order-${orderId}`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('jump-highlight');
  setTimeout(() => row.classList.remove('jump-highlight'), 1500);
}

// 5s, not 30s -- this view exists specifically so a manager can watch orders
// change live; at 30s a qty edit or a new item looked "stuck" until the
// viewer happened to click something else (expand/collapse) that triggered
// an incidental extra fetch. No SSE push here (unlike KDS's /kds/stream):
// that stream authenticates via the terminal's session cookie, and the
// dashboard instead carries its JWT as a Bearer header -- EventSource can't
// attach custom headers, and putting the token in the stream URL's query
// string is exactly the log/proxy/history leak the KDS stream comment
// explicitly avoids. A fast poll is the safe tradeoff until/unless the
// dashboard gets its own cookie-based session to hang an SSE endpoint off of.
const LIVE_ORDERS_POLL_MS = 5000;
function pollLiveOwnData() {
  loadLiveOrders();
  loadLiveActivity();
}
function startLiveOrdersPoll() {
  stopLiveOrdersPoll();
  liveOrdersTimer = setInterval(pollLiveOwnData, LIVE_ORDERS_POLL_MS);
}

function stopLiveOrdersPoll() {
  if (liveOrdersTimer) { clearInterval(liveOrdersTimer); liveOrdersTimer = null; }
}

// ─── Own-POS: Recent Activity ───────────────────────────────────────────────
// The Live Orders card above is a snapshot of currently-open orders -- it
// naturally reflects a qty/item change on the next poll, but says nothing
// about WHO made it or WHEN, and says nothing at all once an order leaves
// the open set (paid/cancelled). This is the actual action trail: every
// pos_order_events row (see routes/pos.js logOrderEvent), across every
// terminal, most-recent-first -- "GM added 1 item to Order X",
// "POS-1 removed 1x Coke from Order X", etc. Same 5s poll as Live Orders
// (see pollLiveOwnData above), same reasoning: a manager watching this is
// specifically trying to catch an edit as it happens.
function itemsSummary(items) {
  if (!Array.isArray(items) || !items.length) return 'items';
  return items.map(i => `${i.quantity}× ${i.item_name}`).join(', ');
}

// Returns { text, orderLabel } instead of a flat string -- orderLabel is
// substituted back in as a clickable <span> by loadLiveActivity below, so
// the order reference within the sentence (wherever it falls) is the actual
// link, not the whole row.
function activityLine(e) {
  const who = e.terminal_name || 'Unknown terminal';
  const order = '{{ORDER}}';
  const d = e.detail || {};
  const text = (() => {
    switch (e.event) {
      case 'created':
        return `${who} created ${order} with ${d.item_count ?? '?'} item(s) — ${fmtKHR(d.total)}`;
      case 'items_added':
        return `${who} added ${itemsSummary(d.items)} to ${order}` + (d.reactivated ? ' (was ready — sent back to kitchen)' : '');
      case 'item_cancelled':
        return `${who} removed ${d.qty_removed ?? ''}× ${d.item_name || 'an item'} from ${order}` + (d.reason ? ` — "${d.reason}"` : '');
      case 'sent_to_kitchen':
        return `${who} sent ${order} to the kitchen`;
      case 'ready':
        return `${order} is ready for pickup`;
      case 'served':
        return `${who} marked ${order} served`;
      case 'awaiting_payment':
        return `${who} marked ${order} ready to bill`;
      case 'paid':
        return `${who} completed payment for ${order}`;
      case 'cancelled':
        return `${who} cancelled ${order}` + (d.reason ? ` — "${d.reason}"` : '');
      default:
        return `${who} · ${e.event} · ${order}`;
    }
  })();
  return text;
}

async function loadLiveActivity() {
  const data = await fetchJSON('/api/receipts/own/live/activity');
  const list = getEl('liveActivityList');
  const count = getEl('liveActivityCount');
  if (!data) return;
  const events = data.events || [];
  if (count) count.textContent = `${events.length} recent`;
  if (!list) return;
  if (!events.length) {
    list.innerHTML = `<div class="empty-state">No activity yet.</div>`;
    return;
  }
  list.innerHTML = events.map(e => {
    const orderLabel = esc(e.order_name || e.order_number);
    // esc() the whole sentence first (it may embed item names/reasons typed
    // by staff), THEN substitute the link span -- otherwise esc() would
    // mangle the span's own HTML.
    const line = esc(activityLine(e)).replace('{{ORDER}}',
      `<span class="activity-order-link" data-jump-order-id="${e.order_id}" data-jump-order-number="${orderLabel}">${orderLabel}</span>`);
    return `
      <div class="detail-item-row" style="cursor:default;">
        <div class="detail-item-name">${line}</div>
        <div class="detail-item-qty">${esc(e.branch_name) || '—'} · ${elapsedLabel(e.created_at)} ago</div>
      </div>
    `;
  }).join('');
  list.querySelectorAll('[data-jump-order-id]').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      jumpToLiveOrder(parseInt(el.dataset.jumpOrderId, 10), el.dataset.jumpOrderNumber);
    });
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function init() {
  // Own is the default tab -- mirrors what switchReceiptSource('own') sets up,
  // but done directly since receiptSource already starts as 'own' (that guard
  // would otherwise short-circuit and skip this setup entirely).
  mountOwnBranchFilter();
  loadLiveOrders();
  loadLiveActivity();
  startLiveOrdersPoll();
  mountDateFilter();
}
