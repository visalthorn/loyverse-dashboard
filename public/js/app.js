import { checkAuth, logout } from './auth.js';
import { state } from './state.js';
import { getEl } from './utils.js';
import { applyTranslations, t } from './i18n.js';
import { renderSidebar } from './sidebar.js';

// Page modules — loaded on demand
import * as Dashboard from './pages/dashboard.js';
import * as Expenses  from './pages/expenses.js';
import * as Receipts  from './pages/receipts.js';
import * as Staff     from './pages/staff.js';
import * as Schedule  from './pages/schedule.js';
import * as Users     from './pages/users.js';
import * as Report        from './pages/report.js';
import * as SummaryReport from './pages/summary-report.js';
import * as Sync      from './pages/sync.js';
import * as Items     from './pages/items.js';

// ─── Shared UI ───────────────────────────────────────────────────────────────

function renderUserHeader(user) {
  const el = getEl('userInfo');
  if (el) {
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="text-align:right;">
          <div style="font-size:13px;font-weight:600;color:var(--text-primary);">${user.fullName || user.username}</div>
          <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;">${user.role}</div>
        </div>
        <div style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent-strong));display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--accent-contrast);">
          ${(user.fullName || user.username).charAt(0).toUpperCase()}
        </div>
        <button onclick="logout()" title="${t('common.signOut')}"
          style="background:none;border:1px solid var(--border-subtle);border-radius:8px;padding:6px 10px;color:var(--text-muted);cursor:pointer;font-size:12px;transition:all 0.2s;"
          onmouseover="this.style.color='var(--loss)';this.style.borderColor='var(--loss)'"
          onmouseout="this.style.color='var(--text-muted)';this.style.borderColor='var(--border-subtle)'">
          ${t('common.signOut')}
        </button>
      </div>`;
  }

  const sidebarName   = getEl('sidebarUserName');
  const sidebarRole   = getEl('sidebarUserRole');
  const sidebarAvatar = getEl('sidebarAvatar');
  if (sidebarName)   sidebarName.textContent   = user.fullName || user.username || 'User';
  if (sidebarRole)   sidebarRole.textContent   = (user.role || '').toUpperCase();
  if (sidebarAvatar) sidebarAvatar.textContent = (user.fullName || user.username || 'U').charAt(0).toUpperCase();
}

function renderEnvBadge() {
  const badge = getEl('envBadge');
  if (!badge) return;
  const host = location.hostname;
  const env  = (host === 'localhost' || host === '127.0.0.1') ? 'UAT' : 'PROD';
  badge.textContent = env;
  badge.dataset.env = env;
}

function applyPermissions() {
  document.querySelectorAll('[data-write-page]').forEach(el => {
    const page = el.dataset.writePage;
    if (!state.userPermissions[page]?.can_write) el.style.display = 'none';
  });
}

// ─── Page detection ───────────────────────────────────────────────────────────

function detectPage() {
  if (document.getElementById('grossIncomeChart'))  return 'dashboard';
  if (document.getElementById('expensesList'))      return 'expenses';
  if (document.getElementById('receiptsTbody'))     return 'receipts';
  if (document.getElementById('staffTableBody'))    return 'staff';
  if (document.getElementById('usersTableBody'))    return 'users';
  if (document.getElementById('summary-report-page')) return 'summary-report';
  if (document.getElementById('report-page'))       return 'report';
  if (document.getElementById('syncCards'))         return 'sync';
  if (document.getElementById('itemsTableBody'))    return 'items';
  return null;
}

// ─── Expose globals needed by HTML onclick handlers ───────────────────────────

window.logout = logout;

// Dashboard
window.dashboardToggleSlowMovers     = Dashboard.toggleSlowMovers;
window.dashboardSetTopProductsCategory = Dashboard.setTopProductsCategory;

// Sync
window.syncReceipts    = Sync.syncReceipts;
window.syncItemsNow    = Sync.syncItems;
window.archiveReceipts = Sync.archiveReceipts;

// Expenses
window.submitExpense        = Expenses.submitExpense;
window.startEditExpense     = Expenses.startEditExpense;
window.confirmDeleteExpense = Expenses.confirmDeleteExpense;
window.exportExpensesCSV    = Expenses.exportExpensesCSV;

// Receipts
window.loadReceipts       = Receipts.loadReceipts;
window.onApiFilterChange  = Receipts.onApiFilterChange;
window.onSearchChange     = Receipts.onSearchChange;
window.resetFilters       = Receipts.resetFilters;
window.changePage         = Receipts.changePage;
window.selectReceipt      = Receipts.selectReceipt;
window.exportReceiptsCSV  = Receipts.exportReceiptsCSV;
window.exportReceiptPDF   = Receipts.exportReceiptPDF;

// Staff
window.submitStaff        = Staff.submitStaff;
window.startEditStaff     = Staff.startEditStaff;
window.cancelEditStaff    = Staff.cancelEditStaff;
window.toggleStaffStatus  = Staff.toggleStaffStatus;
window.confirmDeleteStaff = Staff.confirmDeleteStaff;
window.exportStaffCSV     = Staff.exportStaffCSV;
window.renderStaffTable   = Staff.renderStaffTable;

// Schedule
window.openShiftPicker  = Schedule.openShiftPicker;
window.applyShift       = Schedule.applyShift;
window.prevMonth        = Schedule.prevMonth;
window.nextMonth        = Schedule.nextMonth;
window.exportScheduleCSV = Schedule.exportScheduleCSV;
window.printSchedule     = Schedule.printSchedule;
window.openRosterFill   = Schedule.openRosterFill;
window.applyRosterFill  = Schedule.applyRosterFill;

// Schedule helpers
window.reloadScheduleIfLoaded = Schedule.reloadIfLoaded;

// Tab switcher — async so callers can await the schedule load
window.switchTab = async function(tabName) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  const content = getEl(`tab-${tabName}`);
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  if (content) content.classList.remove('hidden');
  if (btn) btn.classList.add('active');
  if (tabName === 'schedule') await Schedule.init();
};

// Jump from staff list to schedule, highlight the staff row
window.viewInSchedule = async function(staffId) {
  await window.switchTab('schedule');
  const row = document.querySelector(`tr[data-staff-id="${staffId}"]`);
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('rst-row--highlight');
  setTimeout(() => row.classList.remove('rst-row--highlight'), 2500);
};

// Report (Sales & Marketing, live data)
window.reportSetTopProductsLimit    = Report.setTopProductsLimit;
window.reportSetTopProductsCategory = Report.setTopProductsCategory;

// Summary Report (permanent summary data)
window.summaryReportSetTopProductsLimit    = SummaryReport.setTopProductsLimit;
window.summaryReportSetTopProductsCategory = SummaryReport.setTopProductsCategory;
window.summaryReportToggleCustom           = SummaryReport.toggleCustom;
window.summaryReportApplyCustom            = SummaryReport.applyCustom;
window.summaryReportSelectBlock            = SummaryReport.selectBlock;
window.summaryReportCopyHighlights         = SummaryReport.copyHighlights;

// Users
window.submitUser         = Users.submitUser;
window.startEditUser      = Users.startEditUser;
window.cancelEditUser     = Users.cancelEditUser;
window.toggleUserStatus   = Users.toggleUserStatus;
window.confirmDeleteUser  = Users.confirmDeleteUser;
window.togglePermission   = Users.togglePermission;

// Items
window.onItemSearch          = Items.onItemSearch;
window.onItemFilterChange    = Items.onItemFilterChange;
window.changeItemCategory    = Items.changeItemCategory;
window.openRename            = Items.openRename;
window.submitRename          = Items.submitRename;
window.closeRename           = Items.closeRename;
window.resetItemName         = Items.resetItemName;
window.toggleCategoriesPanel = Items.toggleCategoriesPanel;

// ─── Bootstrap ───────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  const authData = await checkAuth();
  if (!authData) return;

  state.userPermissions = authData.permissions || {};
  state.currentUserRole = authData.user?.role  || '';

  const page = detectPage();
  renderSidebar(getEl('sidebar'), page);
  renderEnvBadge();
  renderUserHeader(authData.user);
  applyPermissions();
  applyTranslations();

  const navUsers = getEl('navUsers');
  if (navUsers) navUsers.style.display = state.currentUserRole === 'admin' ? '' : 'none';

  if (document.getElementById('usersTableBody') && state.currentUserRole !== 'admin') {
    window.location.href = '/';
    return;
  }

  if (page === 'dashboard') Dashboard.init();
  if (page === 'expenses')  Expenses.init();
  if (page === 'receipts')  Receipts.init();
  if (page === 'staff')     Staff.init();
  if (page === 'users')     Users.init();
  if (page === 'report')    Report.init();
  if (page === 'summary-report') SummaryReport.init();
  if (page === 'sync')      Sync.init();
  if (page === 'items')     Items.init();
});
