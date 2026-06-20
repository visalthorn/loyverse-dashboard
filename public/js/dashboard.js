// ============================================================
// DASHBOARD AUTH GUARD
// Add this at the VERY TOP of your dashboard.js (before everything)
// ============================================================
 
// ── Auth Guard ───────────────────────────────────────────────
const TOKEN_KEY = 'pos_token';
const USER_KEY  = 'pos_user';
const TZ = 'Asia/Phnom_Penh';
 
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

function getEl(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = getEl(id);
  if (el) el.textContent = value;
  return el;
}

function setHTML(id, value) {
  const el = getEl(id);
  if (el) el.innerHTML = value;
  return el;
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
  const el = getEl('userInfo');
  if (el) {
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

  const sidebarName = getEl('sidebarUserName');
  if (sidebarName) sidebarName.textContent = user.fullName || user.username || 'User';

  const sidebarRole = getEl('sidebarUserRole');
  if (sidebarRole) sidebarRole.textContent = (user.role || '').toUpperCase();

  const sidebarAvatar = getEl('sidebarAvatar');
  if (sidebarAvatar) sidebarAvatar.textContent = (user.fullName || user.username || 'U').charAt(0).toUpperCase();
}

// ─── State ────────────────────────────────────────────────────────────────────
let currentPeriod = 'week';
let currentStartDate = '';
let currentEndDate = '';
let expenseFilterStartDate = '';
let expenseFilterEndDate = '';
let charts = {};
const COLORS = ['#f59e0b','#3b82f6','#10b981','#f43f5e','#8b5cf6','#06b6d4','#84cc16','#ec4899'];
const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

function updateExpenseSummary(count, totalAmount) {
  const summary = getEl('expensesSummary');
  if (!summary) return;
  const formattedTotal = `៛${fmtRaw(totalAmount, 2)}`;
  summary.innerHTML = `<span class="text-sm text-amber-600 font-bold">${count}</span> item${count === 1 ? '' : 's'} · Total: <span class="text-sm text-amber-600 font-bold">${formattedTotal}</span>`;
}

function applyExpenseFilters() {
  expenseFilterStartDate = getEl('expensesStartDate')?.value || '';
  expenseFilterEndDate = getEl('expensesEndDate')?.value || '';
  window.expensesPage = 1;
  loadExpenses();
}

function clearExpenseFilters() {
  const today = getTodayDate();
  const startInput = getEl('expensesStartDate');
  const endInput = getEl('expensesEndDate');
  if (startInput) startInput.value = today;
  if (endInput) endInput.value = today;
  applyExpenseFilters();
}

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const hasDashboard = Boolean(document.getElementById('grossIncomeChart'));
  const hasExpenses  = Boolean(document.getElementById('expenseForm') || document.getElementById('expensesList'));
  const hasReceipts  = Boolean(document.getElementById('receiptsTbody'));

  if (hasDashboard) {
    detectEnv();
    loadAll();
    setInterval(loadAll, 5 * 60 * 1000); // auto-refresh 5 min
  } else if (hasReceipts) {
    const today = getTodayDate();
    const startInput = getEl('filterStart');
    const endInput   = getEl('filterEnd');
    if (startInput) startInput.value = today;
    if (endInput)   endInput.value   = today;
    loadReceipts();
  } else if (hasExpenses) {
    const today = getTodayDate();

    const startInput = getEl('expensesStartDate');
    const endInput = getEl('expensesEndDate');
    if (startInput) startInput.value = today;
    if (endInput) endInput.value = today;

    const applyBtn = getEl('expensesFilterBtn');
    const clearBtn = getEl('expensesClearBtn');
    if (applyBtn) applyBtn.addEventListener('click', applyExpenseFilters);
    if (clearBtn) clearBtn.addEventListener('click', clearExpenseFilters);
    if (startInput) startInput.addEventListener('change', applyExpenseFilters);
    if (endInput) endInput.addEventListener('change', applyExpenseFilters);

    applyExpenseFilters();
  }
});

async function detectEnv() {
  const badge = getEl('envBadge');
  if (!badge) return;
  await fetchJSON('/api/kpis?period=today');
  const host  = location.hostname;
  const env   = host === 'localhost' || host === '127.0.0.1' ? 'UAT' : 'PROD';
  badge.textContent    = env;
  badge.dataset.env    = env;
}

function loadAll() {
  const lastUpdated = getEl('lastUpdated');
  if (lastUpdated) lastUpdated.textContent = 'Updated: ' + new Date().toLocaleTimeString();
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
    const startInput = getEl('startDate');
    const endInput = getEl('endDate');
    if (startInput) startInput.value = '';
    if (endInput) endInput.value = '';
    loadAll();
    return;
  }

  if (currentStartDate && currentEndDate) {
    loadAll();
  }
}

function applyCustomRange() {
  const startInput = getEl('startDate');
  const endInput = getEl('endDate');
  const start = startInput ? startInput.value : '';
  const end = endInput ? endInput.value : '';
  
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

  const kpiCards = getEl('kpiCards');
  if (kpiCards) kpiCards.innerHTML = cards.map(c => `
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
  const trendLabel = getEl('grossIncomeLabel');
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

  // Normalize any period value to its Phnom Penh calendar date (YYYY-MM-DD).
  // DATE_TRUNC groups by PP day, but the returned timestamp is the UTC instant
  // for PP midnight (e.g. 2026-06-07T17:00:00.000Z === 2026-06-08 00:00 +07:00),
  // so we must convert via the PP timezone rather than reading the UTC date part.
  const ppDateKey = (period) =>
    new Date(period).toLocaleDateString('en-CA', { timeZone: TZ });

  const labels  = incomeData.map(r => fmtDate(r.period, trendPeriod));
  const revenue = incomeData.map(r => parseFloat(r.gross_income));

  // Align expenses to income periods by PP calendar date, not raw timestamp string.
  const expenseMap = {};
  if (expenseTrend && expenseTrend.length) {
    expenseTrend.forEach(e => {
      expenseMap[ppDateKey(e.period)] = parseFloat(e.total_expense);
    });
  }
  const expenses = incomeData.map(r => expenseMap[ppDateKey(r.period)] || 0);

  destroyChart('grossIncomeChart');
  charts.grossIncomeChart = new Chart(document.getElementById('grossIncomeChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Gross Income',
          data: revenue,
          backgroundColor: 'rgba(245,158,11,0.7)',
          borderColor: '#f59e0b',
          borderWidth: 1,
          borderRadius: 6,
        },
        {
          label: 'Expenses',
          data: expenses,
          backgroundColor: 'rgba(239,68,68,0.7)',
          borderColor: '#ef4444',
          borderWidth: 1,
          borderRadius: 6,
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
  const diningLegend = getEl('diningLegend');
  if (diningLegend) diningLegend.innerHTML = data.map((r, i) => `
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
  const paymentLegend = getEl('paymentLegend');
  if (paymentLegend) paymentLegend.innerHTML = data.map((r, i) => `
    <div class="legend-item">
      <span><span class="legend-dot" style="background:${COLORS[i+2]}"></span>${r.payment_name || r.payment_type}</span>
      <span class="font-medium">៛${fmt(r.total)} <span class="text-slate-500">(${total > 0 ? ((r.total/total)*100).toFixed(1) : 0}%)</span></span>
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

  const container = getEl('heatmap');
  if (!container) return;

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

  const topItemsBody = getEl('topItemsBody');
  if (topItemsBody) topItemsBody.innerHTML = data.map((r, i) => `
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

  const cancelSummary = getEl('cancelSummary');
  if (cancelSummary) cancelSummary.innerHTML = `
    <span class="text-red-400 font-bold">${data.summary.count} cancelled</span>
    <span class="text-slate-400">Lost: <span class="text-red-300 font-bold">$${fmt(data.summary.lost_revenue)}</span></span>
  `;

  const cancelList = getEl('cancelList');
  if (cancelList) cancelList.innerHTML = data.items.length
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

  const queryParts = [`page=${page}`, `per_page=${per_page}`];
  if (expenseFilterStartDate) queryParts.push(`start=${encodeURIComponent(expenseFilterStartDate)}`);
  if (expenseFilterEndDate) queryParts.push(`end=${encodeURIComponent(expenseFilterEndDate)}`);
  const data = await fetchJSON(`/api/expenses?${queryParts.join('&')}`);
  if (!data) {
    updateExpenseSummary(0, 0);
    return container.innerHTML = '<div class="text-slate-500">Failed to load expenses.</div>';
  }

  const totalAmount = parseFloat(data.total_amount || 0);
  updateExpenseSummary(data.total || 0, totalAmount);

  if (!data.items || data.items.length === 0) {
    container.innerHTML = '<div class="text-slate-500">No expenses recorded for the selected range.</div>';
    renderExpensesPagination(data.total || 0, data.page, data.per_page);
    return;
  }

  let lastDate = null;
  const groupedHtml = data.items.map(e => {
    const dayLabel = fmtDate(e.expense_date, 'weekly');
    const showHeader = dayLabel !== lastDate;
    lastDate = dayLabel;
    return `${showHeader ? `
      <div class="mt-3 mb-1 text-xs uppercase tracking-wide text-amber-500 font-bold border-b border-slate-700 pb-1">${dayLabel}</div>
    ` : ''}
    <div class="flex items-center justify-between p-2 bg-slate-800 rounded ${showHeader ? '' : 'mt-2'}">
      <div>
        <div class="font-medium">${e.expense_by}</div>
        <div class="text-xs text-slate-400">${e.remark || ''}</div>
      </div>
      <div class="flex items-center gap-3">
        <div class="text-amber-400 font-bold">៛${fmt(e.amount)}</div>
        <button onclick="startEditExpense(${e.id})" class="text-sm text-slate-300 hover:text-amber-400">Edit</button>
        <button onclick="confirmDeleteExpense(${e.id})" class="text-sm text-red-400 hover:text-red-300">Delete</button>
      </div>
    </div>`;
  }).join('');

  container.innerHTML = groupedHtml;
  renderExpensesPagination(data.total, data.page, data.per_page);
}

async function submitExpense(e) {
  e.preventDefault();
  const msg = getEl('expenseMsg');
  if (msg) msg.textContent = '';

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
      if (msg) msg.textContent = j.message || 'Failed to save expense.';
      return;
    }

    const jr = await r.json();
    if (msg) msg.textContent = editingId ? 'Updated.' : 'Saved.';
    document.getElementById('expenseForm').reset();
    window.editingExpenseId = null;
    document.getElementById('expenseForm').querySelector('button[type=submit]').textContent = 'Add Expense';
    loadExpenses();
  } catch (err) {
    console.error('Submit expense error:', err);
    if (msg) msg.textContent = 'Error saving expense.';
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

// // ───  Sync Gross Income for Yesterday ───────────────────────────────────────────────────────────────
async function syncGrossIncome() {

  // use fetch directly with POST since we need to send a body and attach auth
  try {
    const token = getToken();
    let r = await fetch('/api/gross-income', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' },
        body: JSON.stringify({})
      });

    console.log(r.status);

    if (r.status === 401) { logout(); return; }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      console.error('Failed to sync gross income:', j.message || 'Unknown error');
      return;
    }

    console.log("🔚 Finished");
    loadGrossIncomeTrend();
  } catch (err) {
    console.error('Sync gross income error:', err);
  }
}

// ─── Expenses ───────────────────────────────────────────────────────────────
/* ===========================
     Config
  =========================== */
  const PAGE_SIZE = 25;

  /* ===========================
     State
  =========================== */
  let allReceipts = [];   // loaded from API (already filtered by date/type)
  let displayed   = [];   // after client-side search
  let currentPage = 1;
  let selectedId  = null;
  let isLoading   = false;

  /* ===========================
     Fetch from API — date/type filters sent as query params
  =========================== */
  async function loadReceipts() {
    if (isLoading) return;
    isLoading = true;
    setTableLoading(true);

    const start = document.getElementById('filterStart').value;
    const end   = document.getElementById('filterEnd').value;
    const type  = document.getElementById('filterType').value;

    const params = new URLSearchParams({ per_page: 500 });
    if (start) params.set('start', start);
    if (end)   params.set('end',   end);
    if (type)  params.set('type',  type);

    const data = await fetchJSON(`/api/receipts?${params}`);
    allReceipts = data ? (data.receipts ?? []) : filterDemoData(start, end, type);

    isLoading = false;
    currentPage = 1;
    renderStats();
    applySearch();
  }

  /* ===========================
     Stats (from API-returned dataset)
  =========================== */
  function renderStats() {
    const salesRows   = allReceipts.filter(r => r.receipt_type === 'SALE' && r.is_canceled === 'No');
    const refundRows  = allReceipts.filter(r => r.receipt_type === 'REFUND');

    const salesAmt   = salesRows.reduce((s, r)   => s + parseFloat(r.total_money || 0), 0);
    const refundAmt  = refundRows.reduce((s, r)  => s + parseFloat(r.total_money || 0), 0);
    const totalAmt   = salesAmt - refundAmt;

    document.getElementById('statTotal').textContent         = allReceipts.length;
    document.getElementById('statTotalAmount').textContent   = '៛' + fmtRaw(totalAmt);
    document.getElementById('statSales').textContent         = salesRows.length;
    document.getElementById('statSalesAmount').textContent   = '៛' + fmtRaw(salesAmt);
    document.getElementById('statRefunds').textContent       = refundRows.length;
    document.getElementById('statRefundsAmount').textContent = '៛' + fmtRaw(refundAmt);
  }

  /* ===========================
     API filter change — re-fetch
  =========================== */
  function onApiFilterChange() {
    loadReceipts();
  }

  /* ===========================
     Client-side search (no API call)
  =========================== */
  function onSearchChange() {
    currentPage = 1;
    applySearch();
  }

  function applySearch() {
    const q = document.getElementById('searchInput').value.trim().toLowerCase();

    displayed = q
      ? allReceipts.filter(r =>
          (r.receipt_number || '').toLowerCase().includes(q) ||
          (r.pos_device || '').toLowerCase().includes(q) ||
          String(r.order || '').includes(q)
        )
      : allReceipts;

    const n  = displayed.length;
    const of = allReceipts.length;
    document.getElementById('resultCount').textContent =
      q ? `${n} of ${of} receipts` : `${of} receipts`;

    setTableLoading(false);
    renderTable();
    renderPagination();
  }

  function resetFilters() {
    document.getElementById('searchInput').value = '';
    document.getElementById('filterStart').value = '';
    document.getElementById('filterEnd').value   = '';
    document.getElementById('filterType').value  = '';
    loadReceipts();
  }

  function setTableLoading(on) {
    if (on) {
      document.getElementById('receiptsTbody').innerHTML =
        `<tr><td colspan="8" class="empty-state"><span class="loading-dots">Loading</span></td></tr>`;
    }
  }

  /* ===========================
     Table rendering
  =========================== */
  function renderTable() {
    const tbody  = document.getElementById('receiptsTbody');
    const start  = (currentPage - 1) * PAGE_SIZE;
    const rows   = displayed.slice(start, start + PAGE_SIZE);

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-state">No receipts match your filters</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((r, i) => {
      const idx         = start + i + 1;
      const dateStr     = formatDate(r.receipt_date);
      const typeClass   = r.receipt_type === 'REFUND' ? 'badge-refund' : 'badge-sale';
      const typeLabel   = r.receipt_type === 'SALE' ? 'Sale' : r.receipt_type === 'REFUND' ? 'Refund' : (r.receipt_type || '—');
      const cancelBadge = r.is_canceled === 'Yes'
        ? '<span class="badge badge-canceled">Yes</span>'
        : '<span class="text-slate-600 text-xs">—</span>';
      const sel = r.id === selectedId ? 'selected' : '';

      return `<tr class="receipt-row ${sel}" onclick="selectReceipt(${r.id})">
        <td class="py-2.5 pr-3 text-slate-500 text-xs pl-1">${idx}</td>
        <td class="py-2.5 pr-3 font-mono text-amber-400 font-semibold text-xs">${r.receipt_number}</td>
        <td class="py-2.5 pr-3 text-slate-400 text-xs">${r.order ?? '—'}</td>
        <td class="py-2.5 pr-3 text-slate-300 text-xs whitespace-nowrap">${dateStr}</td>
        <td class="py-2.5 pr-3 text-slate-300 text-xs">${r.pos_device ?? '—'}</td>
        <td class="py-2.5 pr-3 text-center"><span class="badge ${typeClass}">${typeLabel}</span></td>
        <td class="py-2.5 pr-3 text-center">${cancelBadge}</td>
        <td class="py-2.5 text-right font-semibold text-white text-xs whitespace-nowrap">${formatCurrency(r.total_money)}</td>
      </tr>`;
    }).join('');
  }

  /* ===========================
     Pagination
  =========================== */
  function renderPagination() {
    const total     = Math.ceil(displayed.length / PAGE_SIZE);
    const ctrl      = document.getElementById('paginationControls');
    const pageInfo  = document.getElementById('pageInfo');

    pageInfo.textContent = `Page ${currentPage} of ${total || 1}`;

    if (total <= 1) { ctrl.innerHTML = ''; return; }

    let pages = [];
    // always show first, last, current ±1
    const show = new Set([1, total, currentPage, currentPage - 1, currentPage + 1]
      .filter(p => p >= 1 && p <= total));
    const sorted = [...show].sort((a, b) => a - b);

    let html = `<button class="page-btn" onclick="changePage(${currentPage - 1})" ${currentPage===1?'disabled':''}>‹</button>`;

    let prev = 0;
    for (const p of sorted) {
      if (p - prev > 1) html += `<span class="page-btn" style="cursor:default;color:#475569">…</span>`;
      html += `<button class="page-btn ${p===currentPage?'active':''}" onclick="changePage(${p})">${p}</button>`;
      prev = p;
    }

    html += `<button class="page-btn" onclick="changePage(${currentPage + 1})" ${currentPage===total?'disabled':''}>›</button>`;
    ctrl.innerHTML = html;
  }

  function changePage(p) {
    const total = Math.ceil(displayed.length / PAGE_SIZE);
    if (p < 1 || p > total) return;
    currentPage = p;
    renderTable();
    renderPagination();
  }

  /* ===========================
     Receipt detail
  =========================== */
  function selectReceipt(id) {
    selectedId = id;
    const r = allReceipts.find(x => x.id === id);
    renderTable();

    if (!r) return;

    const panel   = document.getElementById('detailPanel');
    const empty   = document.getElementById('detailEmpty');
    const content = document.getElementById('detailContent');

    empty.classList.add('hidden');
    content.classList.remove('hidden');
    panel.classList.add('active');

    const items = Array.isArray(r.items) ? r.items : [];
    const itemsHtml = items.map(it => `
      <div class="detail-item-row">
        <div>
          <div class="detail-item-name">${it.item_name}</div>
          <div class="detail-item-qty">${it.qty} × ${formatCurrency(it.unit_price)}</div>
        </div>
        <div class="detail-item-price">${formatCurrency(it.total_price)}</div>
      </div>`).join('');

    const isRefund   = r.receipt_type === 'REFUND';
    const typeClass  = isRefund ? 'text-red-400' : 'text-emerald-400';
    const typeLabel  = isRefund ? 'Refund' : 'Sale';
    const cancelNote = r.is_canceled === 'Yes' ? `<span class="badge badge-canceled ml-2">Canceled</span>` : '';

    content.innerHTML = `
      <div class="detail-header">
        <div class="flex items-start justify-between gap-2 mb-2">
          <div>
            <div class="text-xs text-slate-400 mb-0.5">Receipt No.</div>
            <div class="font-mono font-bold text-amber-400 text-base">${r.receipt_number}</div>
          </div>
          <div class="text-right">
            <span class="badge ${isRefund ? 'badge-refund' : 'badge-sale'} text-sm px-3 py-1">${typeLabel}</span>
            ${cancelNote}
          </div>
        </div>
        <div class="text-2xl font-bold text-white mb-1">${formatCurrency(r.total_money)}</div>
        <div class="text-xs text-slate-400">Total</div>
      </div>

      <div class="p-4 space-y-3 text-xs">
        <div class="grid grid-cols-2 gap-2">
          <div>
            <div class="text-slate-500 mb-0.5">Order</div>
            <div class="text-slate-200">${r.order ?? '—'}</div>
          </div>
          <div>
            <div class="text-slate-500 mb-0.5">POS Device</div>
            <div class="text-slate-200">${r.pos_device ?? '—'}</div>
          </div>
          <div>
            <div class="text-slate-500 mb-0.5">Date</div>
            <div class="text-slate-200">${formatDate(r.receipt_date)}</div>
          </div>
        </div>

        ${itemsHtml ? `
        <div class="border-t border-slate-700 pt-3">
          <div class="text-slate-400 font-semibold mb-2">Items</div>
          ${itemsHtml}
        </div>` : ''}

        <div class="border-t border-slate-700 pt-3 flex justify-between font-semibold">
          <span class="text-slate-300">Total</span>
          <span class="${typeClass}">${formatCurrency(r.total_money)}</span>
        </div>

        <div class="border-t border-slate-700 pt-3">
          <button onclick="exportReceiptPDF()" class="w-full bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold py-2 rounded flex items-center justify-center gap-1.5">
            🖨 Export PDF
          </button>
        </div>
      </div>`;
  }

  /* ===========================
     Formatters
  =========================== */
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
        hour: '2-digit', minute: '2-digit', hour12: false
      });
    } catch { return str; }
  }

  /* ===========================
     CSV / PDF Export
  =========================== */
  function downloadCSV(filename, rows) {
    const csv = rows.map(r => r.map(cell => {
      const s = String(cell ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function exportReceiptsCSV() {
    if (!allReceipts.length) return alert('No receipts loaded.');
    const rows = [
      ['Receipt No.', 'Order', 'Date', 'POS Device', 'Type', 'Is Canceled', 'Total (KHR)'],
      ...allReceipts.map(r => [
        r.receipt_number,
        r.order ?? '',
        formatDate(r.receipt_date),
        r.pos_device ?? '',
        r.receipt_type === 'SALE' ? 'Sale' : r.receipt_type === 'REFUND' ? 'Refund' : (r.receipt_type ?? ''),
        r.is_canceled,
        r.total_money
      ])
    ];
    downloadCSV(`receipts-${new Date().toISOString().slice(0,10)}.csv`, rows);
  }

  async function exportExpensesCSV() {
    const params = new URLSearchParams({ per_page: 1000 });
    if (expenseFilterStartDate) params.set('start', expenseFilterStartDate);
    if (expenseFilterEndDate)   params.set('end',   expenseFilterEndDate);
    const data = await fetchJSON(`/api/expenses?${params}`);
    if (!data || !data.items) return alert('Failed to load expenses.');
    const rows = [
      ['Date', 'Amount (KHR)', 'Expense By', 'Remark'],
      ...data.items.map(e => [
        e.expense_date ? e.expense_date.slice(0, 10) : '',
        e.amount,
        e.expense_by,
        e.remark ?? ''
      ])
    ];
    downloadCSV(`expenses-${new Date().toISOString().slice(0,10)}.csv`, rows);
  }

  function exportReceiptPDF() {
    const r = allReceipts.find(x => x.id === selectedId);
    if (!r) return;
    const items = Array.isArray(r.items) ? r.items : [];
    const itemsHtml = items.map(it => `
      <tr>
        <td>${it.item_name}</td>
        <td style="text-align:center">${it.qty}</td>
        <td style="text-align:right">KHR ${Number(it.unit_price).toLocaleString()}</td>
        <td style="text-align:right">KHR ${Number(it.total_price).toLocaleString()}</td>
      </tr>`).join('');
    const typeLabel = r.receipt_type === 'REFUND' ? 'Refund' : 'Sale';
    const win = window.open('', '_blank');
    win.document.write(`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"/>
<title>Receipt ${r.receipt_number}</title>
<style>
  body { font-family: Arial, sans-serif; max-width: 420px; margin: 24px auto; font-size: 13px; color: #111; }
  h1 { text-align: center; font-size: 18px; margin: 0 0 2px; }
  .sub { text-align: center; color: #555; font-size: 11px; margin-bottom: 14px; }
  .meta { display: flex; justify-content: space-between; margin: 4px 0; font-size: 12px; }
  .meta span:first-child { color: #666; }
  hr { border: none; border-top: 1px dashed #999; margin: 10px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { border-bottom: 1px solid #333; padding: 4px 6px; text-align: left; }
  td { padding: 4px 6px; }
  .total-row td { border-top: 1px solid #333; font-weight: bold; padding-top: 6px; }
  @media print { @page { margin: 10mm; } }
</style>
</head><body>
  <h1>Receipt</h1>
  <div class="sub">${r.receipt_number} &bull; ${typeLabel}${r.is_canceled === 'Yes' ? ' &bull; Canceled' : ''}</div>
  <hr/>
  <div class="meta"><span>Date</span><span>${formatDate(r.receipt_date)}</span></div>
  <div class="meta"><span>POS Device</span><span>${r.pos_device ?? '—'}</span></div>
  <div class="meta"><span>Order</span><span>${r.order ?? '—'}</span></div>
  ${items.length ? `<hr/>
  <table>
    <thead><tr>
      <th>Item</th>
      <th style="text-align:center">Qty</th>
      <th style="text-align:right">Unit Price</th>
      <th style="text-align:right">Total</th>
    </tr></thead>
    <tbody>
      ${itemsHtml}
      <tr class="total-row">
        <td colspan="3">Total</td>
        <td style="text-align:right">KHR ${Number(r.total_money).toLocaleString()}</td>
      </tr>
    </tbody>
  </table>` : `<hr/><div class="meta"><strong>Total</strong><strong>KHR ${Number(r.total_money).toLocaleString()}</strong></div>`}
  <hr/>
  <div style="text-align:center;font-size:11px;color:#888;margin-top:8px">Thank you!</div>
<script>window.print(); window.onafterprint = () => window.close();<\/script>
</body></html>`);
    win.document.close();
  }

  /* ===========================
     Demo data helpers (fallback when API is unavailable)
  =========================== */
  function filterDemoData(start, end, type) {
    return DEMO_RECEIPTS.filter(r => {
      const rDate = r.receipt_date ? r.receipt_date.slice(0, 10) : '';
      if (start && rDate < start) return false;
      if (end   && rDate > end)   return false;
      if (type  && r.receipt_type !== type) return false;
      return true;
    });
  }

  /* ===========================
     Demo data
  =========================== */
  const DEMO_RECEIPTS = [
    { id:'r1292', receipt_number:'6-1292', order:'8', receipt_date:'2026-06-17T16:46:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:23000, items:[
      {item_name:'សុករសជ្រៀងជាន', qty:1, unit_price:17000, total_price:17000},
      {item_name:'ជាសស', qty:1, unit_price:1000, total_price:1000},
      {item_name:'សាក់យសម្ជ្រ', qty:1, unit_price:2000, total_price:2000},
      {item_name:'Coca-Cola', qty:1, unit_price:3000, total_price:3000},
    ]},
    { id:'r1291', receipt_number:'6-1291', order:'10', receipt_date:'2026-06-17T16:07:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:67000, items:[]},
    { id:'r1290', receipt_number:'6-1290', order:null, receipt_date:'2026-06-17T16:01:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:86000, items:[]},
    { id:'r1289', receipt_number:'6-1289', order:null, receipt_date:'2026-06-17T15:45:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:60000, items:[]},
    { id:'r1288', receipt_number:'6-1288', order:null, receipt_date:'2026-06-17T15:43:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:105000, items:[]},
    { id:'r1287', receipt_number:'6-1287', order:null, receipt_date:'2026-06-17T15:32:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:101000, items:[]},
    { id:'r0131', receipt_number:'9-0131', order:null, receipt_date:'2026-06-17T15:12:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:61000, items:[]},
    { id:'r0130', receipt_number:'9-0130', order:null, receipt_date:'2026-06-17T14:59:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:56000, items:[]},
    { id:'r1286', receipt_number:'6-1286', order:null, receipt_date:'2026-06-17T14:45:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:22000, items:[]},
    { id:'r0129', receipt_number:'9-0129', order:null, receipt_date:'2026-06-17T14:35:00Z', pos_device:'Shop Device', receipt_type:'SALE', is_canceled:'No', total_money:27000, items:[]},
    ...Array.from({length:27}, (_,i) => ({
      id:`rdemo${i}`, receipt_number:`6-${1260+i}`, order:null,
      receipt_date: new Date(Date.now() - (i+1)*3600000).toISOString(),
      pos_device:'Shop Device', receipt_type: i % 9 === 0 ? 'REFUND' : 'SALE',
      is_canceled: i % 11 === 0 ? 'Yes' : 'No',
      total_money: (Math.floor(Math.random()*20)+1)*5000,
      items:[]
    }))
  ];