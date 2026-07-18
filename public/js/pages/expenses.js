import { state } from '../state.js';
import { fetchJSON, apiPost, apiPut, apiDelete } from '../api.js';
import { getEl, fmt, fmtRaw, fmtKHR, fmtDate, downloadCSV } from '../utils.js';
import { logout } from '../auth.js';
import { t, getLang } from '../i18n.js';
import { renderDateFilter } from '../dateFilter.js';
import { showToast } from '../toast.js';
import { showConfirm } from '../dialog.js';

// ─── Summary ─────────────────────────────────────────────────────────────────

function updateExpenseSummary(count, totalAmount) {
  const summary = getEl('expensesSummary');
  if (!summary) return;
  const countHtml = `<span class="text-sm text-[color:var(--accent-strong)] font-bold num">${count}</span>`;
  const total = `<span class="text-sm text-[color:var(--accent-strong)] font-bold num">${fmtKHR(totalAmount, 2)}</span>`;
  const plural = getLang() === 'en' && count !== 1 ? 's' : '';
  summary.innerHTML = t('expenses.summary', { count: countHtml, plural, total });
}

// ─── Load ────────────────────────────────────────────────────────────────────

export async function loadExpenses() {
  const container = getEl('expensesList');
  if (!container) return;
  container.innerHTML = `<div class="text-[color:var(--text-muted)]">${t('expenses.loading')}</div>`;

  const page     = window.expensesPage    || 1;
  const per_page = window.expensesPerPage || 10;
  const queryParts = [`page=${page}`, `per_page=${per_page}`];
  if (state.expenseFilterStartDate) queryParts.push(`start=${encodeURIComponent(state.expenseFilterStartDate)}`);
  if (state.expenseFilterEndDate)   queryParts.push(`end=${encodeURIComponent(state.expenseFilterEndDate)}`);

  const data = await fetchJSON(`/api/expenses?${queryParts.join('&')}`);
  if (!data) {
    updateExpenseSummary(0, 0);
    container.innerHTML = `<div class="text-[color:var(--text-muted)]">${t('expenses.loadFailed')}</div>`;
    return;
  }

  updateExpenseSummary(data.total || 0, parseFloat(data.total_amount || 0));

  if (!data.items?.length) {
    container.innerHTML = `<div class="text-[color:var(--text-muted)]">${t('expenses.noneForRange')}</div>`;
    renderPagination(data.total || 0, data.page, data.per_page);
    return;
  }

  let lastDate = null;
  container.innerHTML = data.items.map(e => {
    const dayLabel  = fmtDate(e.expense_date, 'weekly');
    const showHeader = dayLabel !== lastDate;
    lastDate = dayLabel;
    return `${showHeader ? `<div class="mt-3 mb-1 text-xs uppercase tracking-wide text-[color:var(--accent-strong)] font-bold border-b border-[color:var(--border)] pb-1">${dayLabel}</div>` : ''}
    <div class="flex items-center justify-between p-2 bg-[color:var(--bg-surface-alt)] rounded ${showHeader ? '' : 'mt-2'}">
      <div>
        <div class="font-medium">${e.expense_by}</div>
        <div class="text-xs text-[color:var(--text-muted)]">${e.remark || ''}</div>
      </div>
      <div class="flex items-center gap-3">
        <div class="val-accent font-bold num">${fmtKHR(e.amount)}</div>
        ${state.userPermissions.expenses?.can_write ? `
          <button onclick="startEditExpense(${e.id})" class="text-sm text-[color:var(--text-secondary)] hover:text-[color:var(--accent-strong)]">${t('common.edit')}</button>
          <button onclick="confirmDeleteExpense(${e.id})" class="text-sm text-[color:var(--loss)] hover:opacity-80">${t('common.delete')}</button>` : ''}
      </div>
    </div>`;
  }).join('');

  renderPagination(data.total, data.page, data.per_page);
}

// ─── Pagination ──────────────────────────────────────────────────────────────

function renderPagination(total, page, per_page) {
  window.expensesPage    = page;
  window.expensesPerPage = per_page;
  const pages = Math.max(1, Math.ceil(total / per_page));

  const container = getEl('expensesList');
  const existing  = document.getElementById('expensesPager');
  if (existing) existing.remove();

  const pager = document.createElement('div');
  pager.id        = 'expensesPager';
  pager.className = 'mt-2 flex items-center gap-2';

  const prev = document.createElement('button');
  prev.textContent = t('expenses.prev');
  prev.disabled    = page <= 1;
  prev.onclick     = () => { if (page > 1) { window.expensesPage = page - 1; loadExpenses(); } };

  const next = document.createElement('button');
  next.textContent = t('expenses.next');
  next.disabled    = page >= pages;
  next.onclick     = () => { if (page < pages) { window.expensesPage = page + 1; loadExpenses(); } };

  const info       = document.createElement('span');
  info.className   = 'text-[color:var(--text-muted)] text-sm';
  info.textContent = t('expenses.pageInfo', { page, pages, total });

  pager.append(prev, info, next);
  container.parentNode.appendChild(pager);
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export function applyDateFilter({ start, end }) {
  state.expenseFilterStartDate = start;
  state.expenseFilterEndDate   = end;
  window.expensesPage = 1;
  loadExpenses();
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function submitExpense(e) {
  e.preventDefault();
  const msg = getEl('expenseMsg');
  if (msg) msg.textContent = '';

  const expense_date = getEl('expenseDate').value;
  const amount       = getEl('expenseAmount').value;
  const expense_by   = getEl('expenseBy').value.trim();
  const remark       = getEl('expenseRemark').value.trim();
  const editingId    = window.editingExpenseId || null;

  if (!expense_date || !amount || !expense_by) {
    if (msg) msg.textContent = t('expenses.errorRequiredFields');
    return;
  }

  if (state.currentUserRole !== 'admin' && !(await showConfirm(editingId ? t('expenses.confirmUpdate') : t('expenses.confirmAdd')))) return;

  const body = { expense_date, amount, remark, expense_by };
  const res  = editingId
    ? await apiPut(`/api/expenses/${editingId}`, body)
    : await apiPost('/api/expenses', body);

  if (!res.ok) {
    if (msg) msg.textContent = res.data?.message || t('expenses.saveFailed');
    return;
  }

  if (msg) msg.textContent = editingId ? t('expenses.updated') : t('expenses.saved');
  getEl('expenseForm').reset();
  window.editingExpenseId = null;
  getEl('expenseForm').querySelector('button[type=submit]').textContent = t('expenses.addButton');
  loadExpenses();
}

export function startEditExpense(id) {
  (async () => {
    const data = await fetchJSON('/api/expenses?page=1&per_page=100');
    const item = (data?.items || []).find(x => x.id === id);
    if (!item) return showToast(t('expenses.notFound'), 'error');

    getEl('expenseDate').value   = item.expense_date.split('T')[0];
    getEl('expenseAmount').value = item.amount;
    getEl('expenseBy').value     = item.expense_by;
    getEl('expenseRemark').value = item.remark || '';
    window.editingExpenseId      = id;
    getEl('expenseForm').querySelector('button[type=submit]').textContent = t('expenses.saveButton');
    window.scrollTo({ top: (getEl('expenseForm')?.offsetTop ?? 0) - 50, behavior: 'smooth' });
  })();
}

export async function confirmDeleteExpense(id) {
  if (!(await showConfirm(t('expenses.confirmDelete'), { danger: true, confirmText: t('common.delete') }))) return;
  deleteExpense(id);
}

async function deleteExpense(id) {
  const res = await apiDelete(`/api/expenses/${id}`);
  if (!res.ok) { showToast(res.data?.message || t('expenses.deleteFailed'), 'error'); return; }
  loadExpenses();
}

// ─── Export ──────────────────────────────────────────────────────────────────

export async function exportExpensesCSV() {
  const params = new URLSearchParams({ per_page: 1000 });
  if (state.expenseFilterStartDate) params.set('start', state.expenseFilterStartDate);
  if (state.expenseFilterEndDate)   params.set('end',   state.expenseFilterEndDate);
  const data = await fetchJSON(`/api/expenses?${params}`);
  if (!data?.items) return showToast(t('expenses.exportLoadFailed'), 'error');
  downloadCSV(`expenses-${new Date().toISOString().slice(0, 10)}.csv`, [
    [t('expenses.csvDate'), t('expenses.csvAmount'), t('expenses.csvExpenseBy'), t('expenses.csvRemark')],
    ...data.items.map(e => [e.expense_date?.slice(0, 10) || '', e.amount, e.expense_by, e.remark ?? '']),
  ]);
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function init() {
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [{ key: 'yesterday', labelKey: 'common.yesterday' }],
    defaultPreset: 'yesterday',
    onChange: applyDateFilter,
  });
}
