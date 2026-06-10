// ============================================================
// DASHBOARD AUTH GUARD
// Add this at the VERY TOP of your dashboard.js (before everything)
// ============================================================
 
// ── Auth Guard ───────────────────────────────────────────────
const TOKEN_KEY = 'pos_token';
const USER_KEY  = 'pos_user';
 
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
 
function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY));
  } catch {
    return null;
  }
}
 
function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  window.location.href = '/login';
}
 
// Check auth on page load — redirect to login if no token
(async function checkAuth() {
  const token = getToken();
  if (!token) {
    window.location.href = '/login';
    return;
  }
 
  // Verify token is still valid with server
  try {
    const res = await fetch('/api/auth/verify', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) {
      logout();
      return;
    }
    // Show user info in header
    const data = await res.json();
    renderUserHeader(data.user);
  } catch {
    logout();
  }
})();
 
// Show logged-in user in dashboard header
function renderUserHeader(user) {
  const el = document.getElementById('userInfo');
  if (!el) return;
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="text-align:right;">
        <div style="font-size:13px;font-weight:600;color:#e2e8f0;">${user.fullName || user.username}</div>
        <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">${user.role}</div>
      </div>
      <div style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#d97706);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#0b1120;">
        ${(user.fullName || user.username).charAt(0).toUpperCase()}
      </div>
      <button onclick="logout()" title="Sign out"
        style="background:none;border:1px solid #1f2d45;border-radius:8px;padding:6px 10px;color:#64748b;cursor:pointer;font-size:12px;transition:all 0.2s;"
        onmouseover="this.style.color='#f87171';this.style.borderColor='#f87171'"
        onmouseout="this.style.color='#64748b';this.style.borderColor='#1f2d45'">
        Sign out
      </button>
    </div>
  `;
}

// ─── State ────────────────────────────────────────────────────────────────────
let currentPeriod = 'week';
let currentStartDate = '';
let currentEndDate = '';
let charts = {};
const COLORS = ['#f59e0b','#3b82f6','#10b981','#f43f5e','#8b5cf6','#06b6d4','#84cc16','#ec4899'];
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  detectEnv();
  loadAll();
  setInterval(loadAll, 5 * 60 * 1000); // auto-refresh 5 min
});

async function detectEnv() {
  await fetchJSON('/api/kpis?period=today');
  const badge = document.getElementById('envBadge');
  const host  = location.hostname;
  const env   = host === 'localhost' || host === '127.0.0.1' ? 'UAT' : 'PROD';
  badge.textContent    = env;
  badge.dataset.env    = env;
}

function loadAll() {
  document.getElementById('lastUpdated').textContent =
    'Updated: ' + new Date().toLocaleTimeString();
  loadKPIs();
  loadGrossIncomeTrend();
  loadDiningOptions();
  loadPaymentMethods();
  loadPeakHours();
  loadTopItems();
  loadEmployeePerformance();
  loadDevicePerformance();
  loadCancelledOrders();
  loadExpenses();
}

// ─── Period / Trend Controls ──────────────────────────────────────────────────
function setPeriod(p) {
  currentPeriod = p;
  document.querySelectorAll('.period-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.period === p));

  if (p !== 'range') {
    currentStartDate = '';
    currentEndDate = '';
    document.getElementById('startDate').value = '';
    document.getElementById('endDate').value = '';
    loadAll();
    return;
  }

  if (currentStartDate && currentEndDate) {
    loadAll();
  }
}

function applyCustomRange() {
  const start = document.getElementById('startDate').value;
  const end   = document.getElementById('endDate').value;
  
  if (!start || !end) {
    alert('Please choose both a start and end date.');
    return;
  }
  if (start > end) {
    alert('Start date must be before or equal to end date.');
    return;
  }

  currentPeriod = 'range';
  currentStartDate = start;
  currentEndDate = end;
  document.querySelectorAll('.period-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.period === 'range'));
  loadAll();
}

function getGrossIncomeTrendGranularity() {
  if (currentPeriod === 'year') return 'monthly';
  if (currentPeriod === 'today' || currentPeriod === 'week' || currentPeriod === 'month') return 'daily';
  if (currentPeriod === 'range' && currentStartDate && currentEndDate) {
    const start = new Date(currentStartDate);
    const end = new Date(currentEndDate);
    const days = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
    if (days <= 31) return 'daily';
    if (days <= 180) return 'weekly';
    return 'monthly';
  }
  return 'daily';
}

// ─── KPIs ─────────────────────────────────────────────────────────────────────
async function loadKPIs() {
  currentPeriod = document.querySelector('.period-btn.active')?.dataset.period || currentPeriod;
  const data = await fetchJSON(`/api/kpis?period=${currentPeriod}${rangeQuery()}`);
  if (!data) return;

  const cards = [
    { icon:'💰', label:'Gross Income',     value: '៛' + fmtRaw(data.gross_income.value),  growth: data.gross_income.growth, sub: 'Net Profit: ៛' + fmtRaw(data.net_revenue) },
    { icon:'🧾', label:'Orders',           value: data.orders.value,                      growth: data.orders.growth },
    { icon:'📊', label:'Avg Order Value',  value: '៛' + fmtRaw(data.aov.value),           growth: data.aov.growth },
    { icon:'💸', label:'Total Expenses',   value: '-៛' + fmtRaw(data.expenses.total),     growth: 0, valueClass: 'text-red-400' },
  ];

  document.getElementById('kpiCards').innerHTML = cards.map(c => `
    <div class="kpi-card">
      <div class="flex items-start justify-between">
        <span class="text-2xl">${c.icon}</span>
        ${growthBadge(c.growth)}
      </div>
      <div class="mt-2">
        <div class="text-2xl font-bold ${c.valueClass || 'text-white'}">${c.value}</div>
        <div class="text-xs text-slate-400 mt-1">${c.label}</div>
        ${c.sub ? `<div class="text-xs text-green-400 mt-1">${c.sub}</div>` : ''}
      </div>
    </div>
  `).join('');
}

function growthBadge(g) {
  if (g > 0)  return `<span class="badge-up">▲ ${g}%</span>`;
  if (g < 0)  return `<span class="badge-down">▼ ${Math.abs(g)}%</span>`;
  return `<span class="badge-flat">— 0%</span>`;
}

// ─── Gross Income Trend ─────────────────────────────────────────────────────
async function loadGrossIncomeTrend() {
  const trendPeriod = getGrossIncomeTrendGranularity();
  const trendLabel = document.getElementById('grossIncomeLabel');
  const displayLabel = currentPeriod === 'range'
    ? `Custom range ${currentStartDate} → ${currentEndDate}`
    : currentPeriod === 'week' ? 'Last 7 days'
    : currentPeriod === 'month' ? 'Last month'
    : currentPeriod === 'year' ? 'Last year'
    : `Global period: ${currentPeriod}`;
  trendLabel.textContent = displayLabel;

  const [incomeData, expenseTrend] = await Promise.all([
    fetchJSON(`/api/gross-income?period=${currentPeriod}${rangeQuery()}`),
    fetchJSON(`/api/expenses-trend?period=${currentPeriod}${rangeQuery()}`)
  ]);
  if (!incomeData) return;

  const labels  = incomeData.map(r => fmtDate(r.period, trendPeriod));
  const revenue = incomeData.map(r => parseFloat(r.gross_income));
  const expenses = (expenseTrend && expenseTrend.length)
    ? expenseTrend.map(r => parseFloat(r.total_expense))
    : labels.map(() => 0);

  destroyChart('grossIncomeChart');
  charts.grossIncomeChart = new Chart(document.getElementById('grossIncomeChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Gross Income',
          data: revenue,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.08)',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#f59e0b',
          fill: true,
          tension: 0.4,
        },
        {
          label: 'Expenses',
          data: expenses,
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,0.06)',
          borderWidth: 2,
          pointRadius: 2,
          pointBackgroundColor: '#ef4444',
          fill: true,
          tension: 0.3,
        }
      ]
    },
    options: chartOpts('៛')
  });
}

// ─── Dining Options ───────────────────────────────────────────────────────────
async function loadDiningOptions() {
  const data = await fetchJSON(`/api/dining-options?period=${currentPeriod}${rangeQuery()}`);
  if (!data || !data.length) return;

  const labels  = data.map(r => r.dining_option);
  const revenue = data.map(r => parseFloat(r.revenue));

  destroyChart('diningChart');
  charts.diningChart = new Chart(document.getElementById('diningChart'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: revenue, backgroundColor: COLORS, borderWidth: 0 }] },
    options: donutOpts()
  });

  const total = revenue.reduce((a, b) => a + b, 0);
  document.getElementById('diningLegend').innerHTML = data.map((r, i) => `
    <div class="legend-item">
      <span><span class="legend-dot" style="background:${COLORS[i]}"></span>${r.dining_option}</span>
      <span class="font-medium">៛${fmt(r.revenue)} <span class="text-slate-500">(${total > 0 ? ((r.revenue/total)*100).toFixed(1) : 0}%)</span></span>
    </div>
  `).join('');
}

// ─── Payment Methods ──────────────────────────────────────────────────────────
async function loadPaymentMethods() {
  const data = await fetchJSON(`/api/payment-methods?period=${currentPeriod}${rangeQuery()}`);
  if (!data || !data.length) return;

  const labels = data.map(r => r.payment_name || r.payment_type);
  const totals = data.map(r => parseFloat(r.total));

  destroyChart('paymentChart');
  charts.paymentChart = new Chart(document.getElementById('paymentChart'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: totals, backgroundColor: COLORS.slice(2), borderWidth: 0 }] },
    options: donutOpts()
  });

  const total = totals.reduce((a, b) => a + b, 0);
  document.getElementById('paymentLegend').innerHTML = data.map((r, i) => `
    <div class="legend-item">
      <span><span class="legend-dot" style="background:${COLORS[i+2]}"></span>${r.payment_name || r.payment_type}</span>
      <span class="font-medium">$${fmt(r.total)} <span class="text-slate-500">(${total > 0 ? ((r.total/total)*100).toFixed(1) : 0}%)</span></span>
    </div>
  `).join('');
}

// ─── Peak Hours Heatmap ───────────────────────────────────────────────────────
async function loadPeakHours() {
  const heatmapLabel = document.getElementById('heatmapRangeLabel');
  const displayHeatmap = currentPeriod === 'range'
    ? `(${currentStartDate} → ${currentEndDate})`
    : currentPeriod === 'week' ? '(Last 7 days)'
    : currentPeriod === 'month' ? '(Last month)'
    : currentPeriod === 'year' ? '(Last year)'
    : `(${currentPeriod})`;
  heatmapLabel.textContent = displayHeatmap;

  const data = await fetchJSON(`/api/peak-hours?period=${currentPeriod}${rangeQuery()}`);
  if (!data) return;

  // Build matrix [day][hour] = revenue
  const matrix = Array.from({length:7}, () => new Array(24).fill(0));
  let maxVal = 0;
  data.forEach(r => {
    const d = parseInt(r.day_of_week), h = parseInt(r.hour);
    matrix[d][h] = parseFloat(r.revenue);
    if (matrix[d][h] > maxVal) maxVal = matrix[d][h];
  });

  const container = document.getElementById('heatmap');

  // Hour headers
  let html = '<div class="heatmap-header-row"><div></div>';
  for (let h = 0; h < 24; h++) {
    html += `<div class="heatmap-hour-label">${h}h</div>`;
  }
  html += '</div>';

  // Day rows
  DAYS.forEach((day, d) => {
    html += `<div class="heatmap-row"><div class="heatmap-label">${day}</div>`;
    for (let h = 0; h < 24; h++) {
      const val   = matrix[d][h];
      const ratio = maxVal > 0 ? val / maxVal : 0;
      const bg    = heatColor(ratio);
      const tip   = `${day} ${h}:00 — ៛${fmt(val)}`;
      html += `<div class="heatmap-cell" style="background:${bg}" title="${tip}"></div>`;
    }
    html += '</div>';
  });

  container.innerHTML = html;
}

function heatColor(ratio) {
  if (ratio === 0) return '#1e293b';
  // amber gradient low→high
  const r = Math.round(30  + ratio * (245 - 30));
  const g = Math.round(41  + ratio * (158 - 41));
  const b = Math.round(59  + ratio * (11  - 59));
  return `rgb(${r},${g},${b})`;
}

// ─── Top Items ────────────────────────────────────────────────────────────────
async function loadTopItems() {
  const data = await fetchJSON(`/api/top-items?period=${currentPeriod}&limit=10${rangeQuery()}`);
  if (!data) return;

  document.getElementById('topItemsBody').innerHTML = data.map((r, i) => `
    <tr class="border-b border-slate-800 hover:bg-slate-800 transition-colors">
      <td class="py-2 pr-4 text-slate-400 font-mono">${i+1}</td>
      <td class="py-2 pr-4">
        <div class="font-medium">${r.item_name}</div>
        <div class="text-xs text-slate-500">${r.sku || ''}</div>
      </td>
      <td class="py-2 pr-4 text-right">${fmt(r.qty_sold)}</td>
      <td class="py-2 pr-4 text-right text-amber-400 font-medium">៛${fmt(r.revenue)}</td>
      <td class="py-2 text-right">
        <span class="inline-block bg-slate-700 rounded px-2 py-0.5 text-xs">${r.pct}%</span>
      </td>
    </tr>
  `).join('');
}

// ─── Employee Performance ─────────────────────────────────────────────────────
async function loadEmployeePerformance() {
  const data = await fetchJSON(`/api/employee-performance?period=${currentPeriod}${rangeQuery()}`);
  if (!data || !data.length) return;

  const labels  = data.map(r => r.employee_id || 'Unknown');
  const revenue = data.map(r => parseFloat(r.revenue));

  destroyChart('employeeChart');
  charts.employeeChart = new Chart(document.getElementById('employeeChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Revenue',
        data: revenue,
        backgroundColor: 'rgba(245,158,11,0.7)',
        borderRadius: 6,
      }]
    },
    options: barOpts('៛')
  });
}

// ─── Device Performance ───────────────────────────────────────────────────────
async function loadDevicePerformance() {
  const data = await fetchJSON(`/api/device-performance?period=${currentPeriod}${rangeQuery()}`);
  if (!data || !data.length) return;

  const labels  = data.map(r => r.device_name || 'Unknown');
  const revenue = data.map(r => parseFloat(r.revenue));

  destroyChart('deviceChart');
  charts.deviceChart = new Chart(document.getElementById('deviceChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Revenue',
        data: revenue,
        backgroundColor: 'rgba(59,130,246,0.7)',
        borderRadius: 6,
      }]
    },
    options: barOpts('៛')
  });
}

// ─── Cancelled Orders ─────────────────────────────────────────────────────────
async function loadCancelledOrders() {
  const data = await fetchJSON(`/api/cancelled-orders?period=${currentPeriod}${rangeQuery()}`);
  if (!data) return;

  document.getElementById('cancelSummary').innerHTML = `
    <span class="text-red-400 font-bold">${data.summary.count} cancelled</span>
    <span class="text-slate-400">Lost: <span class="text-red-300 font-bold">$${fmt(data.summary.lost_revenue)}</span></span>
  `;

  document.getElementById('cancelList').innerHTML = data.items.length
    ? data.items.map(r => `
        <div class="cancel-row">
          <div>
            <div class="font-medium text-red-200">#${r.receipt_number}</div>
            <div class="text-xs text-slate-500">${fmtDatetime(r.cancelled_at)} · ${r.dining_option || '-'} · ${r.employee_id || '-'}</div>
          </div>
          <div class="text-red-400 font-bold">-$${fmt(r.total_money)}</div>
        </div>
      `).join('')
    : '<p class="text-slate-500 text-sm">No cancellations in this period ✅</p>';
}

// ─── Chart Helpers ────────────────────────────────────────────────────────────
function chartOpts(prefix = '') {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: '#1e293b' }, ticks: { color: '#64748b', font: { size: 11 } } },
      y: { grid: { color: '#334155' }, ticks: { color: '#64748b', font: { size: 11 },
           callback: v => prefix + fmt(v) } }
    }
  };
}

function barOpts(prefix = '') {
  return {
    ...chartOpts(prefix),
    plugins: { legend: { display: false } },
    indexAxis: 'y',
  };
}

function donutOpts() {
  return {
    responsive: true, maintainAspectRatio: false, cutout: '65%',
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: c => ` ៛${fmt(c.raw)} (${((c.raw / c.chart.getDatasetMeta(0).total)*100).toFixed(1)}%)` } }
    }
  };
}

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

function rangeQuery() {
//  console.log('Current period:', currentPeriod, 'Start:', currentStartDate, 'End:', currentEndDate);
  return currentPeriod === 'range' && currentStartDate && currentEndDate
    ? `&start=${currentStartDate}&end=${currentEndDate}`
    : '';
}

// ─── Utils ───────────────────────────────────────────────────────────────────
async function fetchJSON(url) {
  const token = getToken();

  try {
    const r = await fetch(url, {
      headers: {
        'Authorization': token ? 'Bearer ' + token : ''
      }
    });

    // If 401 — session expired, redirect to login
    if (r.status === 401) {
      logout();
      return null;
    }

    if (!r.ok) throw new Error(r.statusText);
    return await r.json();
  } catch (e) {
    console.error('API error:', url, e);
    return null;
  }
}

function fmt(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '0';
  // KHR: show in millions for large numbers
  if (num >= 1000000) return (num / 1000000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M';
  if (num >= 1000)    return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtRaw(value, decimals = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';

  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function fmtDate(iso, period) {
  const d = new Date(iso);
  if (period === 'monthly') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  if (period === 'weekly')  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtDatetime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Expenses ───────────────────────────────────────────────────────────────
async function loadExpenses() {
  const container = document.getElementById('expensesList');
  if (!container) return;
  container.innerHTML = '<div class="text-slate-500">Loading...</div>';
  // pagination state
  const page = window.expensesPage || 1;
  const per_page = window.expensesPerPage || 10;

  const data = await fetchJSON(`/api/expenses?page=${page}&per_page=${per_page}`);
  if (!data) return container.innerHTML = '<div class="text-slate-500">Failed to load expenses.</div>';

  if (!data.items || data.items.length === 0) return container.innerHTML = '<div class="text-slate-500">No expenses recorded.</div>';

  // render list with edit/delete buttons
  container.innerHTML = data.items.map(e => `
    <div class="flex items-center justify-between p-2 bg-slate-800 rounded">
      <div>
        <div class="font-medium">${e.expense_by} · ${fmtDate(e.expense_date, 'weekly')}</div>
        <div class="text-xs text-slate-400">${e.remark || ''}</div>
      </div>
      <div class="flex items-center gap-3">
        <div class="text-amber-400 font-bold">៛${fmt(e.amount)}</div>
        <button onclick="startEditExpense(${e.id})" class="text-sm text-slate-300 hover:text-amber-400">Edit</button>
        <button onclick="confirmDeleteExpense(${e.id})" class="text-sm text-red-400 hover:text-red-300">Delete</button>
      </div>
    </div>
  `).join('');

  renderExpensesPagination(data.total, data.page, data.per_page);
}

async function submitExpense(e) {
  e.preventDefault();
  const msg = document.getElementById('expenseMsg');
  msg.textContent = '';

  const expense_date = document.getElementById('expenseDate').value;
  const amount = document.getElementById('expenseAmount').value;
  const expense_by = document.getElementById('expenseBy').value.trim();
  const remark = document.getElementById('expenseRemark').value.trim();

  const editingId = window.editingExpenseId || null;

  if (!expense_date || !amount || !expense_by) {
    msg.textContent = 'Please fill required fields.';
    return;
  }

  // use fetch directly with POST since we need to send a body and attach auth
  try {
    const token = getToken();
    let r;
    if (editingId) {
      r = await fetch(`/api/expenses/${editingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' },
        body: JSON.stringify({ expense_date, amount, remark, expense_by })
      });
    } else {
      r = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' },
        body: JSON.stringify({ expense_date, amount, remark, expense_by })
      });
    }

    if (r.status === 401) { logout(); return; }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      msg.textContent = j.message || 'Failed to save expense.';
      return;
    }

    const jr = await r.json();
    msg.textContent = editingId ? 'Updated.' : 'Saved.';
    document.getElementById('expenseForm').reset();
    window.editingExpenseId = null;
    document.getElementById('expenseForm').querySelector('button[type=submit]').textContent = 'Add Expense';
    loadExpenses();
  } catch (err) {
    console.error('Submit expense error:', err);
    msg.textContent = 'Error saving expense.';
  }
}

function startEditExpense(id) {
  // fetch single expense from current list via API (reuse /api/expenses with a simple filter not available), call backend: we will fetch page by page and find id
  // Simpler: fetch first page that contains id by requesting a large per_page then find
  (async () => {
    const token = getToken();
    const r = await fetch(`/api/expenses?page=1&per_page=100`, { headers: { 'Authorization': token ? 'Bearer ' + token : '' } });
    if (!r.ok) return alert('Failed to load expense for edit.');
    const j = await r.json();
    const item = (j.items || []).find(x => x.id === id);
    if (!item) return alert('Expense not found.');

    document.getElementById('expenseDate').value = item.expense_date.split('T')[0];
    document.getElementById('expenseAmount').value = item.amount;
    document.getElementById('expenseBy').value = item.expense_by;
    document.getElementById('expenseRemark').value = item.remark || '';
    window.editingExpenseId = id;
    document.getElementById('expenseForm').querySelector('button[type=submit]').textContent = 'Save Changes';
    window.scrollTo({ top: document.getElementById('expenseForm').offsetTop - 50, behavior: 'smooth' });
  })();
}

function confirmDeleteExpense(id) {
  if (!confirm('Are you sure you want to delete this expense? This cannot be undone.')) return;
  deleteExpense(id);
}

async function deleteExpense(id) {
  try {
    const token = getToken();
    const r = await fetch(`/api/expenses/${id}`, { method: 'DELETE', headers: { 'Authorization': token ? 'Bearer ' + token : '' } });
    if (r.status === 401) { logout(); return; }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      return alert(j.message || 'Failed to delete expense.');
    }
    loadExpenses();
  } catch (err) {
    console.error('Delete expense error:', err);
    alert('Error deleting expense.');
  }
}

// Pagination helpers
function renderExpensesPagination(total, page, per_page) {
  window.expensesPage = page;
  window.expensesPerPage = per_page;
  const pages = Math.max(1, Math.ceil(total / per_page));
  const container = document.getElementById('expensesList');
  const pagerId = 'expensesPager';
  // remove existing pager if any
  const existing = document.getElementById(pagerId);
  if (existing) existing.remove();

  const pager = document.createElement('div');
  pager.id = pagerId;
  pager.className = 'mt-2 flex items-center gap-2';

  const prev = document.createElement('button');
  prev.textContent = 'Prev';
  prev.disabled = page <= 1;
  prev.onclick = () => { if (page > 1) { window.expensesPage = page - 1; loadExpenses(); } };

  const next = document.createElement('button');
  next.textContent = 'Next';
  next.disabled = page >= pages;
  next.onclick = () => { if (page < pages) { window.expensesPage = page + 1; loadExpenses(); } };

  const info = document.createElement('span');
  info.className = 'text-slate-400 text-sm';
  info.textContent = `Page ${page} / ${pages} · ${total} items`;

  pager.appendChild(prev);
  pager.appendChild(info);
  pager.appendChild(next);

  container.parentNode.appendChild(pager);
}
