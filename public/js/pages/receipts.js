import { fetchJSON } from '../api.js';
import { getEl, fmtRaw, fmtKHR, downloadCSV, TZ } from '../utils.js';
import { t } from '../i18n.js';
import { renderDateFilter } from '../dateFilter.js';
import { showToast } from '../toast.js';

const PAGE_SIZE = 25;

let allReceipts = [];
let displayed   = [];
let currentPage = 1;
let selectedId  = null;
let isLoading   = false;
let filterStart = '';
let filterEnd   = '';

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

  const params = new URLSearchParams({ per_page: 500 });
  if (start) params.set('start', start);
  if (end)   params.set('end',   end);
  if (type)  params.set('type',  type);

  const data = await fetchJSON(`/api/receipts?${params}`);
  allReceipts = data ? (data.receipts ?? []) : filterDemoData(start, end, type);

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
  const totalAmt  = salesAmt - refundAmt;

  const set = (id, val) => { const el = getEl(id); if (el) el.textContent = val; };
  set('statTotal',         allReceipts.length);
  set('statTotalAmount',   fmtKHR(totalAmt));
  set('statSales',         salesRows.length);
  set('statSalesAmount',   fmtKHR(salesAmt));
  set('statRefunds',       refundRows.length);
  set('statRefundsAmount', fmtKHR(refundAmt));
}

// ─── Search / Filter ─────────────────────────────────────────────────────────

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

function mountDateFilter() {
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [{ key: 'yesterday', labelKey: 'common.yesterday' }],
    defaultPreset: 'yesterday',
    onChange: applyDateFilter,
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
  const cancelNote = r.is_canceled === 'Yes' ? `<span class="badge badge-canceled ml-2">${t('receipts.canceledBadge')}</span>` : '';

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
    </div>`;
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

// ─── Init ────────────────────────────────────────────────────────────────────

export function init() {
  mountDateFilter();
}
