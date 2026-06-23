import { state, COLORS, DAYS } from '../state.js';
import { fetchJSON } from '../api.js';
import { apiPost } from '../api.js';
import { getEl, fmt, fmtRaw, fmtDate, fmtDatetime, TZ } from '../utils.js';
import { destroyChart, chartOpts, barOpts, donutOpts, heatColor } from '../charts.js';

// ─── Period helpers ───────────────────────────────────────────────────────────

function rangeQuery() {
  return state.currentPeriod === 'range' && state.currentStartDate && state.currentEndDate
    ? `&start=${state.currentStartDate}&end=${state.currentEndDate}`
    : '';
}

function getGrossIncomeTrendGranularity() {
  const { currentPeriod: p, currentStartDate: s, currentEndDate: e } = state;
  if (p === 'year') return 'monthly';
  if (p === 'today' || p === 'week' || p === 'month') return 'daily';
  if (p === 'range' && s && e) {
    const days = Math.max(1, Math.round((new Date(e) - new Date(s)) / (1000 * 60 * 60 * 24)) + 1);
    if (days <= 31)  return 'daily';
    if (days <= 180) return 'weekly';
    return 'monthly';
  }
  return 'daily';
}

// ─── KPIs ────────────────────────────────────────────────────────────────────

function growthBadge(g) {
  if (g == null) return '';
  if (g > 0) return `<span class="badge-up">▲ ${g > 100 ? '>100' : g}%</span>`;
  if (g < 0) return `<span class="badge-down">▼ ${Math.abs(g) > 100 ? '>100' : Math.abs(g)}%</span>`;
  return `<span class="badge-flat">— 0%</span>`;
}

async function loadKPIs() {
  state.currentPeriod = document.querySelector('.period-btn.active')?.dataset.period || state.currentPeriod;
  const data = await fetchJSON(`/api/kpis?period=${state.currentPeriod}${rangeQuery()}`);
  if (!data) return;

  const grossVal  = parseFloat(data.gross_income.value);
  const netVal    = parseFloat(data.net_revenue);
  const expVal    = parseFloat(data.expenses.value);
  const avgNetVal = parseFloat(data.net_per_order?.value ?? 0);

  const netPositive  = netVal >= 0;
  const netAccent    = netPositive ? 'emerald' : 'red';
  const netValClass  = netPositive ? 'text-emerald-400' : 'text-red-400';
  const netIcon      = netPositive ? '📈' : '📉';
  const margin       = grossVal > 0 ? Math.round((netVal / grossVal) * 100) : 0;
  const expPct       = grossVal > 0 ? Math.round((expVal / grossVal) * 100) : 0;

  const avgNetPositive = avgNetVal >= 0;
  const avgNetAccent   = avgNetPositive ? 'emerald' : 'red';
  const avgNetClass    = avgNetPositive ? 'text-emerald-400' : 'text-red-400';

  // ── Section 1: Period totals ────────────────────────────────────────────────
  const primary = [
    {
      accent: 'amber', icon: '💰', label: 'Gross Income',
      val: '៛' + fmtRaw(grossVal), valClass: 'text-amber-400',
      growth: data.gross_income.growth,
      sub: `<span class="${netValClass} font-semibold">Net ៛${fmtRaw(Math.abs(netVal))}</span>`
         + `<span class="text-slate-600"> · ${margin}% margin</span>`,
    },
    {
      accent: netAccent, icon: netIcon, label: 'Net Profit',
      val: (netPositive ? '' : '-') + '៛' + fmtRaw(Math.abs(netVal)),
      valClass: netValClass,
      growth: null,
      sub: `<span class="text-slate-500">Gross minus expenses</span>`,
    },
    {
      accent: 'blue', icon: '🧾', label: 'Orders',
      val: fmtRaw(data.orders.value), valClass: 'text-sky-400',
      growth: data.orders.growth,
      sub: `<span class="text-slate-500">AOV </span>`
         + `<span class="text-slate-300 font-semibold">៛${fmtRaw(data.aov.value)}</span>`,
    },
    {
      accent: 'red', icon: '💸', label: 'Expenses',
      val: '-៛' + fmtRaw(expVal), valClass: 'text-red-400',
      growth: data.expenses.growth,
      sub: `<span class="text-slate-600">${expPct}% of gross income</span>`,
    },
  ];

  const primaryEl = getEl('kpiPrimary');
  if (primaryEl) primaryEl.innerHTML = primary.map(c => `
    <div class="kpi-primary kpi-primary--${c.accent}">
      <div class="flex items-start justify-between gap-2">
        <div class="kpi-icon kpi-icon--${c.accent}">${c.icon}</div>
        ${growthBadge(c.growth)}
      </div>
      <div class="kpi-primary-val ${c.valClass}">${c.val}</div>
      <div class="kpi-primary-lbl">${c.label}</div>
      ${c.sub ? `<div class="kpi-primary-sub">${c.sub}</div>` : ''}
    </div>
  `).join('');

  // ── Section 2: Daily benchmarks (same order & terms as Section 1) ───────────
  const averages = [
    {
      accent: 'amber', label: 'Gross Income',
      val: '៛' + fmtRaw(data.avg_gross_income?.value ?? 0),
      valClass: 'text-amber-400',
      growth: data.avg_gross_income?.growth,
      sub: 'per day · avg',
    },
    {
      accent: avgNetAccent, label: 'Net Profit',
      val: (avgNetPositive ? '' : '-') + '៛' + fmtRaw(Math.abs(avgNetVal)),
      valClass: avgNetClass,
      growth: data.net_per_order?.growth,
      sub: 'per day · avg',
      highlight: true,
    },
    {
      accent: 'violet', label: 'Orders',
      val: '៛' + fmtRaw(data.aov?.value ?? 0),
      valClass: 'text-violet-400',
      growth: data.aov?.growth,
      sub: 'avg value per order',
    },
    {
      accent: 'red', label: 'Expenses',
      val: '-៛' + fmtRaw(data.avg_expense?.value ?? 0),
      valClass: 'text-red-400',
      growth: data.avg_expense?.growth,
      sub: 'per day · avg',
    },
  ];

  const avgEl = getEl('kpiAverage');
  if (avgEl) avgEl.innerHTML = averages.map(c => `
    <div class="kpi-avg kpi-avg--${c.accent}${c.highlight ? ' kpi-avg--highlight' : ''}">
      <div class="flex items-start justify-between gap-1 mb-1">
        <div class="kpi-avg-lbl">${c.label}</div>
        ${growthBadge(c.growth)}
      </div>
      <div class="kpi-avg-val ${c.valClass}">${c.val}</div>
      <div class="kpi-avg-sub">${c.sub}</div>
    </div>
  `).join('');
}

// ─── Gross Income Trend ──────────────────────────────────────────────────────

async function loadGrossIncomeTrend() {
  const trendPeriod  = getGrossIncomeTrendGranularity();
  const { currentPeriod: p, currentStartDate: s, currentEndDate: e } = state;

  const trendLabel = getEl('grossIncomeLabel');
  if (trendLabel) trendLabel.textContent = p === 'range'
    ? `Custom range ${s} → ${e}`
    : p === 'week'  ? 'Last 7 days'
    : p === 'month' ? 'Last month'
    : p === 'year'  ? 'Last year'
    : `Period: ${p}`;

  const [incomeData, expenseTrend] = await Promise.all([
    fetchJSON(`/api/gross-income?period=${p}${rangeQuery()}`),
    fetchJSON(`/api/expenses-trend?period=${p}${rangeQuery()}`),
  ]);
  if (!incomeData) return;

  const ppDateKey = period => new Date(period).toLocaleDateString('en-CA', { timeZone: TZ });

  const labels  = incomeData.map(r => fmtDate(r.period, trendPeriod));
  const revenue = incomeData.map(r => parseFloat(r.gross_income));

  const expenseMap = {};
  if (expenseTrend?.length) expenseTrend.forEach(e => { expenseMap[ppDateKey(e.period)] = parseFloat(e.total_expense); });
  const expenses = incomeData.map(r => expenseMap[ppDateKey(r.period)] || 0);

  destroyChart('grossIncomeChart');
  state.charts.grossIncomeChart = new Chart(document.getElementById('grossIncomeChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Gross Income', data: revenue, backgroundColor: 'rgba(245,158,11,0.7)', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 6 },
        { label: 'Expenses',     data: expenses, backgroundColor: 'rgba(239,68,68,0.7)',  borderColor: '#ef4444', borderWidth: 1, borderRadius: 6 },
      ],
    },
    options: chartOpts('៛'),
  });
}

// ─── Dining Options ──────────────────────────────────────────────────────────

async function loadDiningOptions() {
  const data = await fetchJSON(`/api/dining-options?period=${state.currentPeriod}${rangeQuery()}`);
  if (!data?.length) return;

  const labels  = data.map(r => r.dining_option);
  const revenue = data.map(r => parseFloat(r.revenue));
  const total   = revenue.reduce((a, b) => a + b, 0);

  destroyChart('diningChart');
  state.charts.diningChart = new Chart(document.getElementById('diningChart'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: revenue, backgroundColor: COLORS, borderWidth: 0 }] },
    options: donutOpts(),
  });

  const diningLegend = getEl('diningLegend');
  if (diningLegend) diningLegend.innerHTML = data.map((r, i) => `
    <div class="legend-item">
      <span><span class="legend-dot" style="background:${COLORS[i]}"></span>${r.dining_option}</span>
      <span class="font-medium">៛${fmt(r.revenue)} <span class="text-slate-500">(${total > 0 ? ((r.revenue / total) * 100).toFixed(1) : 0}%)</span></span>
    </div>
  `).join('');
}

// ─── Payment Methods ─────────────────────────────────────────────────────────

async function loadPaymentMethods() {
  const data = await fetchJSON(`/api/payment-methods?period=${state.currentPeriod}${rangeQuery()}`);
  if (!data?.length) return;

  const labels = data.map(r => r.payment_name || r.payment_type);
  const totals = data.map(r => parseFloat(r.total));
  const total  = totals.reduce((a, b) => a + b, 0);

  destroyChart('paymentChart');
  state.charts.paymentChart = new Chart(document.getElementById('paymentChart'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: totals, backgroundColor: COLORS.slice(2), borderWidth: 0 }] },
    options: donutOpts(),
  });

  const paymentLegend = getEl('paymentLegend');
  if (paymentLegend) paymentLegend.innerHTML = data.map((r, i) => `
    <div class="legend-item">
      <span><span class="legend-dot" style="background:${COLORS[i + 2]}"></span>${r.payment_name || r.payment_type}</span>
      <span class="font-medium">៛${fmt(r.total)} <span class="text-slate-500">(${total > 0 ? ((r.total / total) * 100).toFixed(1) : 0}%)</span></span>
    </div>
  `).join('');
}

// ─── Peak Hours Heatmap ──────────────────────────────────────────────────────

async function loadPeakHours() {
  const { currentPeriod: p, currentStartDate: s, currentEndDate: e } = state;

  const heatmapLabel = getEl('heatmapRangeLabel');
  if (heatmapLabel) heatmapLabel.textContent = p === 'range'
    ? `(${s} → ${e})`
    : p === 'week'  ? '(Last 7 days)'
    : p === 'month' ? '(Last month)'
    : p === 'year'  ? '(Last year)'
    : `(${p})`;

  const data = await fetchJSON(`/api/peak-hours?period=${p}${rangeQuery()}`);
  if (!data) return;

  const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let maxVal = 0;
  data.forEach(r => {
    const d = parseInt(r.day_of_week), h = parseInt(r.hour);
    matrix[d][h] = parseFloat(r.revenue);
    if (matrix[d][h] > maxVal) maxVal = matrix[d][h];
  });

  const container = getEl('heatmap');
  if (!container) return;

  let html = '<div class="heatmap-header-row"><div></div>';
  for (let h = 0; h < 24; h++) html += `<div class="heatmap-hour-label">${h}h</div>`;
  html += '</div>';

  DAYS.forEach((day, d) => {
    html += `<div class="heatmap-row"><div class="heatmap-label">${day}</div>`;
    for (let h = 0; h < 24; h++) {
      const val   = matrix[d][h];
      const ratio = maxVal > 0 ? val / maxVal : 0;
      html += `<div class="heatmap-cell" style="background:${heatColor(ratio)}" title="${day} ${h}:00 — ៛${fmt(val)}"></div>`;
    }
    html += '</div>';
  });

  container.innerHTML = html;
}

// ─── Top Items ───────────────────────────────────────────────────────────────

async function loadTopItems() {
  const data = await fetchJSON(`/api/top-items?period=${state.currentPeriod}&limit=10${rangeQuery()}`);
  if (!data) return;

  const topItemsBody = getEl('topItemsBody');
  if (topItemsBody) topItemsBody.innerHTML = data.map((r, i) => `
    <tr class="border-b border-slate-800 hover:bg-slate-800 transition-colors">
      <td class="py-2 pr-4 text-slate-400 font-mono">${i + 1}</td>
      <td class="py-2 pr-4">
        <div class="font-medium">${r.item_name}</div>
        <div class="text-xs text-slate-500">${r.sku || ''}</div>
      </td>
      <td class="py-2 pr-4 text-right">${fmt(r.qty_sold)}</td>
      <td class="py-2 pr-4 text-right text-amber-400 font-medium">៛${fmt(r.revenue)}</td>
      <td class="py-2 text-right"><span class="inline-block bg-slate-700 rounded px-2 py-0.5 text-xs">${r.pct}%</span></td>
    </tr>
  `).join('');
}

// ─── Employee Performance ────────────────────────────────────────────────────

async function loadEmployeePerformance() {
  const data = await fetchJSON(`/api/employee-performance?period=${state.currentPeriod}${rangeQuery()}`);
  if (!data?.length) return;

  destroyChart('employeeChart');
  state.charts.employeeChart = new Chart(document.getElementById('employeeChart'), {
    type: 'bar',
    data: {
      labels: data.map(r => r.employee_id || 'Unknown'),
      datasets: [{ label: 'Revenue', data: data.map(r => parseFloat(r.revenue)), backgroundColor: 'rgba(245,158,11,0.7)', borderRadius: 6 }],
    },
    options: barOpts('៛'),
  });
}

// ─── Device Performance ──────────────────────────────────────────────────────

async function loadDevicePerformance() {
  const data = await fetchJSON(`/api/device-performance?period=${state.currentPeriod}${rangeQuery()}`);
  if (!data?.length) return;

  destroyChart('deviceChart');
  state.charts.deviceChart = new Chart(document.getElementById('deviceChart'), {
    type: 'bar',
    data: {
      labels: data.map(r => r.device_name || 'Unknown'),
      datasets: [{ label: 'Revenue', data: data.map(r => parseFloat(r.revenue)), backgroundColor: 'rgba(59,130,246,0.7)', borderRadius: 6 }],
    },
    options: barOpts('៛'),
  });
}

// ─── Cancelled Orders ────────────────────────────────────────────────────────

async function loadCancelledOrders() {
  const data = await fetchJSON(`/api/cancelled-orders?period=${state.currentPeriod}${rangeQuery()}`);
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

// ─── Load All ────────────────────────────────────────────────────────────────

export function loadAll() {
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
}

// ─── Period Controls (exposed to window) ─────────────────────────────────────

export function setPeriod(p) {
  state.currentPeriod = p;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === p));

  if (p !== 'range') {
    state.currentStartDate = '';
    state.currentEndDate   = '';
    const startInput = getEl('startDate');
    const endInput   = getEl('endDate');
    if (startInput) startInput.value = '';
    if (endInput)   endInput.value   = '';
    loadAll();
    return;
  }
  if (state.currentStartDate && state.currentEndDate) loadAll();
}

export function applyCustomRange() {
  const start = getEl('startDate')?.value || '';
  const end   = getEl('endDate')?.value   || '';
  if (!start || !end) { alert('Please choose both a start and end date.'); return; }
  if (start > end)    { alert('Start date must be before or equal to end date.'); return; }

  state.currentPeriod    = 'range';
  state.currentStartDate = start;
  state.currentEndDate   = end;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === 'range'));
  loadAll();
}

export async function syncGrossIncome() {
  try {
    const res = await apiPost('/api/receipts/sync', {});
    if (!res.ok) { console.error('Sync failed:', res.data); return; }
    console.log('Sync complete');
    loadGrossIncomeTrend();
  } catch (err) {
    console.error('Sync error:', err);
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

export async function init() {
  const badge = getEl('envBadge');
  if (badge) {
    const host = location.hostname;
    const env  = (host === 'localhost' || host === '127.0.0.1') ? 'UAT' : 'PROD';
    badge.textContent = env;
    badge.dataset.env = env;
  }
  loadAll();
  setInterval(loadAll, 5 * 60 * 1000);
}
