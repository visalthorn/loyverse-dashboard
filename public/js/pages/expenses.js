import { state } from '../state.js';
import { fetchJSON, apiPost, apiPut, apiDelete } from '../api.js';
import { getEl, fmt, fmtRaw, fmtKHR, fmtDate, downloadCSV } from '../utils.js';
import { logout } from '../auth.js';
import { t, getLang } from '../i18n.js';
import { renderDateFilter } from '../dateFilter.js';
import { showToast } from '../toast.js';
import { showConfirm } from '../dialog.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

let branchOptions = [];
let recurringTemplates = [];
const DOW_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function defaultBranchId() {
  return branchOptions.find(b => b.is_default)?.id ?? null;
}

function setFormBranch(id) {
  const sel = getEl('expenseBranch');
  if (sel) sel.value = id ?? defaultBranchId() ?? '';
}

async function loadBranchOptions() {
  branchOptions = await fetchJSON('/api/branches/options') || [];
  const formSel = getEl('expenseBranch');
  if (formSel) {
    formSel.innerHTML = branchOptions.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    setFormBranch(null); // pre-select the default branch
  }
  const filterSel = getEl('expenseBranchFilter');
  if (filterSel) {
    filterSel.innerHTML = `<option value="">${t('common.allBranches')}</option>` +
      branchOptions.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    filterSel.onchange = () => {
      state.expenseFilterBranchId = filterSel.value ? Number(filterSel.value) : null;
      window.expensesPage = 1;
      loadExpenses();
    };
  }
  const recurringSel = getEl('recurringBranch');
  if (recurringSel) {
    recurringSel.innerHTML = branchOptions.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  }
}

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
  if (state.expenseFilterBranchId) queryParts.push(`branch_id=${state.expenseFilterBranchId}`);

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
        <div class="font-medium">${esc(e.expense_by)}${e.source === 'recurring' ? `<span class="recurring-badge">${t('expenses.badgeRecurring')}</span>` : ''}</div>
        <div class="text-xs text-[color:var(--text-muted)]">${esc(e.remark || '')}${e.branch_name ? `<span class="text-[color:var(--accent-strong)]"> · ${esc(e.branch_name)}</span>` : ''}</div>
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

export function applyDateFilter({ period, start, end }) {
  state.expenseFilterPeriod    = period;
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
  const branchSel    = getEl('expenseBranch');
  const branch_id    = branchSel?.value ? Number(branchSel.value) : null;
  const editingId    = window.editingExpenseId || null;

  if (!expense_date || !amount || !expense_by) {
    if (msg) msg.textContent = t('expenses.errorRequiredFields');
    return;
  }

  if (state.currentUserRole !== 'admin' && !(await showConfirm(editingId ? t('expenses.confirmUpdate') : t('expenses.confirmAdd')))) return;

  const body = { expense_date, amount, remark, expense_by, branch_id };
  const res  = editingId
    ? await apiPut(`/api/expenses/${editingId}`, body)
    : await apiPost('/api/expenses', body);

  if (!res.ok) {
    if (msg) msg.textContent = res.data?.message || t('expenses.saveFailed');
    return;
  }

  if (msg) msg.textContent = editingId ? t('expenses.updated') : t('expenses.saved');
  getEl('expenseForm').reset();
  setFormBranch(null);
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
    setFormBranch(item.branch_id);
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
  if (state.expenseFilterBranchId) params.set('branch_id', state.expenseFilterBranchId);
  const data = await fetchJSON(`/api/expenses?${params}`);
  if (!data?.items) return showToast(t('expenses.exportLoadFailed'), 'error');
  downloadCSV(`expenses-${new Date().toISOString().slice(0, 10)}.csv`, [
    [t('expenses.csvDate'), t('expenses.csvAmount'), t('expenses.csvExpenseBy'), t('expenses.csvBranch'), t('expenses.csvRemark')],
    ...data.items.map(e => [e.expense_date?.slice(0, 10) || '', e.amount, e.expense_by, e.branch_name ?? '', e.remark ?? '']),
  ]);
}

// ─── Recurring templates ───────────────────────────────────────────────────

export function switchExpensesTab(tab) {
  const isList = tab === 'list';
  getEl('expensesTabList')?.classList.toggle('active', isList);
  getEl('expensesTabRecurring')?.classList.toggle('active', !isList);
  getEl('expensesListSection').style.display = isList ? '' : 'none';
  getEl('recurringSection').style.display    = isList ? 'none' : '';
  if (!isList) loadRecurringTemplates();
}

export function onRecurringFrequencyChange() {
  const freq = getEl('recurringFrequency').value;
  getEl('recurringDayOfMonthField').style.display = freq === 'monthly' ? '' : 'none';
  getEl('recurringDayOfWeekField').style.display  = freq === 'weekly'  ? '' : 'none';
}

async function loadRecurringTemplates() {
  const container = getEl('recurringList');
  if (!container) return;
  container.innerHTML = `<div class="text-[color:var(--text-muted)]">${t('expenses.recurringLoading')}</div>`;

  const data = await fetchJSON('/api/recurring-expenses');
  if (!data) { container.innerHTML = `<div class="text-[color:var(--text-muted)]">${t('expenses.recurringLoadFailed')}</div>`; return; }
  recurringTemplates = data.templates || [];
  if (!recurringTemplates.length) { container.innerHTML = `<div class="text-[color:var(--text-muted)]">${t('expenses.recurringNone')}</div>`; return; }

  container.innerHTML = recurringTemplates.map(rt => {
    const freqLabel = rt.frequency === 'monthly'
      ? `${t('expenses.recurringMonthly')} (${rt.day_of_month})`
      : `${t('expenses.recurringWeekly')} (${t('common.' + DOW_KEYS[rt.day_of_week])})`;
    return `
    <div class="flex items-center justify-between p-2 bg-[color:var(--bg-surface-alt)] rounded">
      <div>
        <div class="font-medium">${esc(rt.name)}${rt.is_active ? '' : `<span class="recurring-badge" style="background:var(--text-muted)">${t('expenses.recurringInactive')}</span>`}</div>
        <div class="text-xs text-[color:var(--text-muted)]">${esc(freqLabel)}${rt.category ? ` · ${esc(rt.category)}` : ''}${rt.branch_name ? ` · ${esc(rt.branch_name)}` : ''} · ${t('expenses.recurringGeneratedCount', { count: rt.generated_count })}</div>
      </div>
      <div class="flex items-center gap-3">
        <div class="val-accent font-bold num">${fmtKHR(rt.amount)}</div>
        ${state.userPermissions.expenses?.can_write ? `
          <button onclick="requestRecurringBackfill(${rt.id})" class="text-sm text-[color:var(--text-secondary)] hover:text-[color:var(--accent-strong)]">${t('expenses.recurringBackfillButton')}</button>
          <button onclick="startEditRecurringTemplate(${rt.id})" class="text-sm text-[color:var(--text-secondary)] hover:text-[color:var(--accent-strong)]">${t('common.edit')}</button>
          <button onclick="confirmDeleteRecurringTemplate(${rt.id})" class="text-sm text-[color:var(--loss)] hover:opacity-80">${t('common.delete')}</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

export async function submitRecurringTemplate(e) {
  e.preventDefault();
  const msg = getEl('recurringMsg');
  if (msg) msg.textContent = '';

  const name          = getEl('recurringName').value.trim();
  const amount         = getEl('recurringAmount').value;
  const category        = getEl('recurringCategory').value.trim();
  const frequency      = getEl('recurringFrequency').value;
  const day_of_month   = frequency === 'monthly' ? Number(getEl('recurringDayOfMonth').value) : null;
  const day_of_week    = frequency === 'weekly'  ? Number(getEl('recurringDayOfWeek').value)  : null;
  const branchSel      = getEl('recurringBranch');
  const branch_id      = branchSel?.value ? Number(branchSel.value) : null;
  const start_date     = getEl('recurringStartDate').value;
  const end_date       = getEl('recurringEndDate').value || null;
  const editingId      = window.editingRecurringId || null;

  if (!name || !amount || !frequency || !start_date) {
    if (msg) msg.textContent = t('expenses.recurringErrorRequiredFields');
    return;
  }

  const body = { name, amount, category, frequency, day_of_month, day_of_week, branch_id, start_date, end_date };
  const res  = editingId
    ? await apiPut(`/api/recurring-expenses/${editingId}`, body)
    : await apiPost('/api/recurring-expenses', body);

  if (!res.ok) {
    if (msg) msg.textContent = res.data?.message || t('expenses.recurringSaveFailed');
    return;
  }

  if (msg) msg.textContent = editingId ? t('expenses.recurringUpdated') : t('expenses.recurringSaved');
  getEl('recurringForm').reset();
  onRecurringFrequencyChange();
  window.editingRecurringId = null;
  getEl('recurringForm').querySelector('button[type=submit]').textContent = t('expenses.recurringAddButton');
  loadRecurringTemplates();
}

export function startEditRecurringTemplate(id) {
  const rt = recurringTemplates.find(x => x.id === id);
  if (!rt) return;
  getEl('recurringName').value      = rt.name;
  getEl('recurringAmount').value    = rt.amount;
  getEl('recurringCategory').value  = rt.category || '';
  getEl('recurringFrequency').value = rt.frequency;
  onRecurringFrequencyChange();
  if (rt.frequency === 'monthly') getEl('recurringDayOfMonth').value = rt.day_of_month;
  else getEl('recurringDayOfWeek').value = rt.day_of_week;
  getEl('recurringBranch').value    = rt.branch_id ?? '';
  getEl('recurringStartDate').value = rt.start_date.split('T')[0];
  getEl('recurringEndDate').value   = rt.end_date ? rt.end_date.split('T')[0] : '';
  window.editingRecurringId = id;
  getEl('recurringForm').querySelector('button[type=submit]').textContent = t('expenses.recurringSaveButton');
  window.scrollTo({ top: (getEl('recurringForm')?.offsetTop ?? 0) - 50, behavior: 'smooth' });
}

export async function confirmDeleteRecurringTemplate(id) {
  if (!(await showConfirm(t('expenses.recurringConfirmDelete'), { danger: true, confirmText: t('common.delete') }))) return;
  const res = await apiDelete(`/api/recurring-expenses/${id}`);
  if (!res.ok) { showToast(res.data?.message || t('expenses.recurringDeleteFailed'), 'error'); return; }
  loadRecurringTemplates();
}

// Preview-then-confirm-then-run: the backend never generates past
// occurrences on its own, so this is the only path that can.
export async function requestRecurringBackfill(id) {
  const preview = await fetchJSON(`/api/recurring-expenses/${id}/backfill-preview`);
  if (!preview) { showToast(t('expenses.recurringBackfillPreviewFailed'), 'error'); return; }
  if (!preview.count) { showToast(t('expenses.recurringBackfillNone')); return; }

  const rt     = recurringTemplates.find(x => x.id === id);
  const plural = getLang() === 'en' && preview.count !== 1 ? 's' : '';
  const ok = await showConfirm(t('expenses.recurringBackfillConfirm', {
    count: preview.count, plural, start: rt?.start_date?.split('T')[0] || preview.dates[0],
  }));
  if (!ok) return;

  const res = await apiPost(`/api/recurring-expenses/${id}/backfill`, {});
  if (!res.ok) { showToast(res.data?.message || t('expenses.recurringBackfillFailed'), 'error'); return; }
  const plural2 = getLang() === 'en' && res.data.inserted !== 1 ? 's' : '';
  showToast(t('expenses.recurringBackfillDone', { count: res.data.inserted, plural: plural2 }));
  loadRecurringTemplates();
  loadExpenses();
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function init() {
  loadBranchOptions();
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [{ key: 'yesterday', labelKey: 'common.yesterday' }],
    defaultPreset: 'yesterday',
    initial: { period: state.expenseFilterPeriod, start: state.expenseFilterStartDate, end: state.expenseFilterEndDate },
    onChange: applyDateFilter,
  });
}
