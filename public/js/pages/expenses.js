import { state } from '../state.js';
import { fetchJSON, apiPost, apiPut, apiDelete } from '../api.js';
import { getEl, fmt, fmtRaw, fmtDate, getTodayDate, downloadCSV } from '../utils.js';
import { logout } from '../auth.js';
import { t } from '../i18n.js';

// ─── Summary ─────────────────────────────────────────────────────────────────

function updateExpenseSummary(count, totalAmount) {
  const summary = getEl('expensesSummary');
  if (!summary) return;
  const countHtml = `<span class="text-sm text-amber-600 font-bold">${count}</span>`;
  const total = `<span class="text-sm text-amber-600 font-bold">៛${fmtRaw(totalAmount, 2)}</span>`;
  summary.innerHTML = t('expenses.summary', { count: countHtml, plural: count === 1 ? '' : 's', total });
}

// ─── Load ────────────────────────────────────────────────────────────────────

export async function loadExpenses() {
  const container = getEl('expensesList');
  if (!container) return;
  container.innerHTML = `<div class="text-slate-500">${t('expenses.loading')}</div>`;

  const page     = window.expensesPage    || 1;
  const per_page = window.expensesPerPage || 10;
  const queryParts = [`page=${page}`, `per_page=${per_page}`];
  if (state.expenseFilterStartDate) queryParts.push(`start=${encodeURIComponent(state.expenseFilterStartDate)}`);
  if (state.expenseFilterEndDate)   queryParts.push(`end=${encodeURIComponent(state.expenseFilterEndDate)}`);

  const data = await fetchJSON(`/api/expenses?${queryParts.join('&')}`);
  if (!data) {
    updateExpenseSummary(0, 0);
    container.innerHTML = `<div class="text-slate-500">${t('expenses.loadFailed')}</div>`;
    return;
  }

  updateExpenseSummary(data.total || 0, parseFloat(data.total_amount || 0));

  if (!data.items?.length) {
    container.innerHTML = `<div class="text-slate-500">${t('expenses.noneForRange')}</div>`;
    renderPagination(data.total || 0, data.page, data.per_page);
    return;
  }

  let lastDate = null;
  container.innerHTML = data.items.map(e => {
    const dayLabel  = fmtDate(e.expense_date, 'weekly');
    const showHeader = dayLabel !== lastDate;
    lastDate = dayLabel;
    return `${showHeader ? `<div class="mt-3 mb-1 text-xs uppercase tracking-wide text-amber-500 font-bold border-b border-slate-700 pb-1">${dayLabel}</div>` : ''}
    <div class="flex items-center justify-between p-2 bg-slate-800 rounded ${showHeader ? '' : 'mt-2'}">
      <div>
        <div class="font-medium">${e.expense_by}</div>
        <div class="text-xs text-slate-400">${e.remark || ''}</div>
      </div>
      <div class="flex items-center gap-3">
        <div class="text-amber-400 font-bold">៛${fmt(e.amount)}</div>
        ${state.userPermissions.expenses?.can_write ? `
          <button onclick="startEditExpense(${e.id})" class="text-sm text-slate-300 hover:text-amber-400">${t('common.edit')}</button>
          <button onclick="confirmDeleteExpense(${e.id})" class="text-sm text-red-400 hover:text-red-300">${t('common.delete')}</button>` : ''}
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
  info.className   = 'text-slate-400 text-sm';
  info.textContent = t('expenses.pageInfo', { page, pages, total });

  pager.append(prev, info, next);
  container.parentNode.appendChild(pager);
}

// ─── Filters ─────────────────────────────────────────────────────────────────

export function applyExpenseFilters() {
  state.expenseFilterStartDate = getEl('expensesStartDate')?.value || '';
  state.expenseFilterEndDate   = getEl('expensesEndDate')?.value   || '';
  window.expensesPage = 1;
  loadExpenses();
}

export function clearExpenseFilters() {
  const today = getTodayDate();
  const start = getEl('expensesStartDate');
  const end   = getEl('expensesEndDate');
  if (start) start.value = today;
  if (end)   end.value   = today;
  applyExpenseFilters();
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

  if (state.currentUserRole !== 'admin' && !confirm(editingId ? t('expenses.confirmUpdate') : t('expenses.confirmAdd'))) return;

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
    if (!item) return alert(t('expenses.notFound'));

    getEl('expenseDate').value   = item.expense_date.split('T')[0];
    getEl('expenseAmount').value = item.amount;
    getEl('expenseBy').value     = item.expense_by;
    getEl('expenseRemark').value = item.remark || '';
    window.editingExpenseId      = id;
    getEl('expenseForm').querySelector('button[type=submit]').textContent = t('expenses.saveButton');
    window.scrollTo({ top: (getEl('expenseForm')?.offsetTop ?? 0) - 50, behavior: 'smooth' });
  })();
}

export function confirmDeleteExpense(id) {
  if (!confirm(t('expenses.confirmDelete'))) return;
  deleteExpense(id);
}

async function deleteExpense(id) {
  const res = await apiDelete(`/api/expenses/${id}`);
  if (!res.ok) { alert(res.data?.message || t('expenses.deleteFailed')); return; }
  loadExpenses();
}

// ─── Export ──────────────────────────────────────────────────────────────────

export async function exportExpensesCSV() {
  const params = new URLSearchParams({ per_page: 1000 });
  if (state.expenseFilterStartDate) params.set('start', state.expenseFilterStartDate);
  if (state.expenseFilterEndDate)   params.set('end',   state.expenseFilterEndDate);
  const data = await fetchJSON(`/api/expenses?${params}`);
  if (!data?.items) return alert(t('expenses.exportLoadFailed'));
  downloadCSV(`expenses-${new Date().toISOString().slice(0, 10)}.csv`, [
    [t('expenses.csvDate'), t('expenses.csvAmount'), t('expenses.csvExpenseBy'), t('expenses.csvRemark')],
    ...data.items.map(e => [e.expense_date?.slice(0, 10) || '', e.amount, e.expense_by, e.remark ?? '']),
  ]);
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function init() {
  const today = getTodayDate();
  const start = getEl('expensesStartDate');
  const end   = getEl('expensesEndDate');
  if (start) start.value = today;
  if (end)   end.value   = today;

  start?.addEventListener('change', applyExpenseFilters);
  end?.addEventListener('change',   applyExpenseFilters);

  applyExpenseFilters();
}
