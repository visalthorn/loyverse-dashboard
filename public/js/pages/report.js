import { state, COLORS } from '../state.js';
import { fetchJSON } from '../api.js';
import { getEl, fmt, fmtRaw, fmtDate } from '../utils.js';
import { destroyChart, chartOpts, barOpts, pieOpts } from '../charts.js';
import { t } from '../i18n.js';
import { renderDateFilter, periodLabel } from '../dateFilter.js';

// ─── Period helpers ───────────────────────────────────────────────────────────

function rangeQuery() {
  return state.currentPeriod === 'range' && state.currentStartDate && state.currentEndDate
    ? `&start=${state.currentStartDate}&end=${state.currentEndDate}`
    : '';
}

function trendGranularity() {
  const { currentPeriod: p, currentStartDate: s, currentEndDate: e } = state;
  if (p === 'year') return 'monthly';
  if (p === 'today' || p === 'week' || p === 'month') return 'daily';
  if (p === 'range' && s && e) {
    const days = Math.max(1, Math.round((new Date(e) - new Date(s)) / 86400000) + 1);
    if (days <= 31)  return 'daily';
    if (days <= 180) return 'weekly';
    return 'monthly';
  }
  return 'daily';
}

function growthBadge(g) {
  if (g == null) return '<span class="growth-nil">—</span>';
  if (g > 0) return `<span class="growth-up">▲ ${g > 100 ? '>100' : g}%</span>`;
  if (g < 0) return `<span class="growth-down">▼ ${Math.abs(g) > 100 ? '>100' : Math.abs(g)}%</span>`;
  return '<span class="growth-nil">0%</span>';
}


// ─── Section 1: KPI Summary ───────────────────────────────────────────────────

async function loadReportKPIs() {
  const data = await fetchJSON(`/api/kpis?period=${state.currentPeriod}${rangeQuery()}`);
  if (!data) return;

  const grossVal = parseFloat(data.gross_income.value);
  const expVal   = parseFloat(data.expenses.value);
  const netVal   = parseFloat(data.net_revenue);
  const margin   = grossVal > 0 ? (netVal / grossVal * 100).toFixed(1) : '0';
  const aov      = parseFloat(data.aov.value);
  const expPct   = grossVal > 0 ? (expVal / grossVal * 100).toFixed(1) : '0';

  const el = getEl('reportKpis');
  if (!el) return;

  el.innerHTML = [
    {
      accent: 'amber', icon: '💰', label: t('report.kpi.totalRevenue'),
      val: '៛' + fmtRaw(grossVal), valClass: 'text-amber-400',
      sub: `<span class="text-slate-500">${t('report.kpi.vsPrev')} </span><span class="text-slate-300">${growthBadge(data.gross_income.growth)}</span>`,
    },
    {
      accent: 'red', icon: '💸', label: t('dashboard.kpi.expenses'),
      val: '-៛' + fmtRaw(expVal), valClass: 'text-red-400',
      sub: `<span class="text-slate-500">${t('report.kpi.pctOfRevenue', { pct: expPct })} · </span><span class="text-slate-300">${growthBadge(data.expenses.growth)}</span>`,
    },
    {
      accent: 'violet', icon: '🧾', label: t('report.kpi.avgOrderValue'),
      val: '៛' + fmtRaw(aov), valClass: 'text-violet-400',
      sub: `<span class="text-slate-500">${t('report.kpi.vsPrev')} </span><span class="text-slate-300">${growthBadge(data.aov.growth)}</span>`,
    },
    {
      accent: 'emerald', icon: '📊', label: t('report.kpi.netMargin'),
      val: margin + '%', valClass: netVal >= 0 ? 'text-blue-400' : 'text-red-400',
      sub: `<span class="text-blue-500">${t('report.kpi.netAmount', { amount: '៛' + fmtRaw(Math.abs(netVal)) })}</span>`,
    },
  ].map(c => `
    <div class="kpi-primary kpi-primary--${c.accent}"${c.id ? ` id="${c.id}"` : ''}>
      <div class="flex items-start justify-between gap-2">
        <div class="kpi-icon kpi-icon--${c.accent}">${c.icon}</div>
      </div>
      <div class="kpi-primary-val ${c.valClass}">${c.val}</div>
      <div class="kpi-primary-lbl">${c.label}</div>
      <div class="kpi-primary-sub">${c.sub}</div>
    </div>
  `).join('');
}

// ─── Section 2: Revenue Trend + Growth % ─────────────────────────────────────

async function loadRevenueTrend() {
  const gran  = trendGranularity();
  const label = getEl('revTrendLabel');
  const { currentPeriod: p, currentStartDate: s, currentEndDate: e } = state;
  if (label) label.textContent = periodLabel(p, s, e);

  const data = await fetchJSON(`/api/gross-income?period=${p}${rangeQuery()}`);
  if (!data?.length) return;

  const labels   = data.map(r => fmtDate(r.period, gran));
  const revenue  = data.map(r => parseFloat(r.gross_income));
  const growth   = revenue.map((v, i) => {
    if (i === 0 || revenue[i - 1] === 0) return null;
    return parseFloat(((v - revenue[i - 1]) / revenue[i - 1] * 100).toFixed(1));
  });

  destroyChart('revTrendChart');
  state.charts.revTrendChart = new Chart(document.getElementById('revTrendChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: t('report.chartRevenue'),
          data: revenue,
          backgroundColor: 'rgba(245,158,11,0.7)',
          borderColor: '#f59e0b',
          borderWidth: 1,
          borderRadius: 6,
          yAxisID: 'y',
        },
        {
          label: t('report.chartGrowthPct'),
          data: growth,
          type: 'line',
          borderColor: '#34d399',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#34d399',
          tension: 0.3,
          yAxisID: 'y2',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#94a3b8', font: { size: 11 } } },
      },
      scales: {
        x:  { grid: { color: '#1e293b' }, ticks: { color: '#64748b', font: { size: 11 } } },
        y:  { position: 'left',  grid: { color: '#334155' }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => '៛' + fmt(v) } },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => v + '%' } },
      },
    },
  });
}

// ─── Section 3a: Dining Channel ──────────────────────────────────────────────

async function loadDiningOptions() {
  const data = await fetchJSON(`/api/dining-options?period=${state.currentPeriod}${rangeQuery()}`);
  const legend = getEl('diningLegend');
  if (!data?.length) {
    destroyChart('diningChart');
    if (legend) legend.innerHTML = `<p class="text-slate-500 text-sm">${t('dashboard.noDataRow')}</p>`;
    return;
  }

  const labels  = data.map(r => r.dining_option);
  const revenue = data.map(r => parseFloat(r.revenue));
  const total   = revenue.reduce((a, b) => a + b, 0);

  destroyChart('diningChart');
  state.charts.diningChart = new Chart(document.getElementById('diningChart'), {
    type: 'pie',
    data: { labels, datasets: [{ data: revenue, backgroundColor: COLORS, borderWidth: 0 }] },
    options: pieOpts(false),
  });

  if (legend) legend.innerHTML = data.map((r, i) => `
    <div class="legend-item">
      <span><span class="legend-dot" style="background:${COLORS[i % COLORS.length]}"></span>${r.dining_option}</span>
      <span class="font-medium">៛${fmt(r.revenue)} <span class="text-slate-500">(${total > 0 ? ((r.revenue / total) * 100).toFixed(1) : 0}%)</span></span>
    </div>
  `).join('');
}

// ─── Section 3b: Payment Method ──────────────────────────────────────────────

async function loadPaymentMethods() {
  const data = await fetchJSON(`/api/payment-methods?period=${state.currentPeriod}${rangeQuery()}`);
  const legend = getEl('paymentLegend');
  if (!data?.length) {
    destroyChart('paymentChart');
    if (legend) legend.innerHTML = `<p class="text-slate-500 text-sm">${t('dashboard.noDataRow')}</p>`;
    return;
  }

  const labels = data.map(r => r.payment_name || r.payment_type);
  const totals = data.map(r => parseFloat(r.total));
  const total  = totals.reduce((a, b) => a + b, 0);

  destroyChart('paymentChart');
  state.charts.paymentChart = new Chart(document.getElementById('paymentChart'), {
    type: 'pie',
    data: { labels, datasets: [{ data: totals, backgroundColor: COLORS.slice(2), borderWidth: 0 }] },
    options: pieOpts(false),
  });

  if (legend) legend.innerHTML = data.map((r, i) => `
    <div class="legend-item">
      <span><span class="legend-dot" style="background:${COLORS[(i + 2) % COLORS.length]}"></span>${r.payment_name || r.payment_type}</span>
      <span class="font-medium">៛${fmt(r.total)} <span class="text-slate-500">(${total > 0 ? ((r.total / total) * 100).toFixed(1) : 0}%)</span></span>
    </div>
  `).join('');
}

// ─── Section 3c: Top Product Performance ─────────────────────────────────────

let topProductsLimit    = 5;
let topProductsCategory = '';

async function loadTopProducts() {
  const categoryQuery = topProductsCategory ? `&category=${topProductsCategory}` : '';
  const data = await fetchJSON(`/api/item-comparison?period=${state.currentPeriod}${rangeQuery()}&order=desc&limit=${topProductsLimit}${categoryQuery}`);
  const legend = getEl('topProductsLegend');

  if (!data?.length) {
    destroyChart('topProductsChart');
    const categoryLabel = topProductsCategory === 'food' ? t('dashboard.categoryFood')
      : topProductsCategory === 'beverage' ? t('dashboard.categoryBeverage')
      : '';
    if (legend) legend.innerHTML = `<p class="text-slate-500 text-sm">${categoryLabel ? t('report.noCategoryItemsForPeriod', { category: categoryLabel }) : t('dashboard.noDataRow')}</p>`;
    return;
  }

  const labels  = data.map(r => r.item_name);
  const revenue = data.map(r => parseFloat(r.revenue));
  const total   = revenue.reduce((a, b) => a + b, 0);

  destroyChart('topProductsChart');
  state.charts.topProductsChart = new Chart(document.getElementById('topProductsChart'), {
    type: 'pie',
    data: { labels, datasets: [{ data: revenue, backgroundColor: COLORS, borderWidth: 0 }] },
    options: pieOpts(false),
  });

  if (legend) legend.innerHTML = data.map((r, i) => `
    <div class="flex items-center justify-between py-2 border-b border-slate-800 last:border-0">
      <span class="flex items-center gap-2 text-sm">
        <span class="legend-dot" style="background:${COLORS[i % COLORS.length]}"></span>${r.item_name}
      </span>
      <span class="font-medium text-sm">៛${fmt(r.revenue)} <span class="text-slate-500 text-xs">(${total > 0 ? ((r.revenue / total) * 100).toFixed(1) : 0}%)</span></span>
    </div>
  `).join('');
}

export function setTopProductsLimit(val) {
  topProductsLimit = parseInt(val) || 5;
  loadTopProducts();
}

export function setTopProductsCategory(val) {
  topProductsCategory = val;
  loadTopProducts();
}

// ─── Section 5: Expense Trend ─────────────────────────────────────────────────

async function loadExpenseTrend() {
  const gran = trendGranularity();
  const { currentPeriod: p } = state;

  const [expData, incData] = await Promise.all([
    fetchJSON(`/api/expenses-trend?period=${p}${rangeQuery()}`),
    fetchJSON(`/api/gross-income?period=${p}${rangeQuery()}`),
  ]);
  if (!expData?.length) return;

  // Normalise both to Cambodia local date string so they align as map keys
  const toKey = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });

  const incomeMap = {};
  if (incData?.length) incData.forEach(r => { incomeMap[toKey(r.period)] = parseFloat(r.gross_income); });

  const labels   = expData.map(r => fmtDate(r.period, gran));
  const expenses = expData.map(r => parseFloat(r.total_expense));
  const revenue  = expData.map(r => incomeMap[toKey(r.period)] || 0);
  const expPct   = expData.map((r, i) => {
    const rev = revenue[i];
    return rev > 0 ? parseFloat((expenses[i] / rev * 100).toFixed(1)) : 0;
  });

  const totalExp = expenses.reduce((a, b) => a + b, 0);
  const totalRev = revenue.reduce((a, b) => a + b, 0);
  const overallPct = totalRev > 0 ? (totalExp / totalRev * 100).toFixed(1) : '0';
  const chip = getEl('expenseSummaryChip');
  if (chip) chip.textContent = t('report.expenseSummaryChip', { total: '៛' + fmt(totalExp), pct: overallPct });

  destroyChart('expenseTrendChart');
  state.charts.expenseTrendChart = new Chart(document.getElementById('expenseTrendChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: t('report.chartRevenueKhr'),
          data: revenue,
          backgroundColor: 'rgba(245,158,11,0.5)',
          borderColor: '#f59e0b',
          borderWidth: 1,
          borderRadius: 6,
          yAxisID: 'y',
        },
        {
          label: t('report.chartExpensesKhr'),
          data: expenses,
          backgroundColor: 'rgba(239,68,68,0.7)',
          borderColor: '#ef4444',
          borderWidth: 1,
          borderRadius: 6,
          yAxisID: 'y',
        },
        {
          label: t('report.chartExpensePct'),
          data: expPct,
          type: 'line',
          borderColor: '#fb923c',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#fb923c',
          tension: 0.3,
          yAxisID: 'y2',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { color: '#94a3b8', boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            afterBody: items => {
              const i = items[0]?.dataIndex;
              if (i == null) return;
              return t('report.tooltipExpenseRatio', { pct: expPct[i] });
            },
          },
        },
      },
      scales: {
        x:  { grid: { color: '#1e293b' }, ticks: { color: '#64748b', font: { size: 11 } } },
        y:  { position: 'left',  grid: { color: '#334155' }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => '៛' + fmt(v) } },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#fb923c', font: { size: 11 }, callback: v => v + '%' }, suggestedMax: 100 },
      },
    },
  });
}

// ─── Section 6: POS Device Performance ───────────────────────────────────────

async function loadDevicePerformance() {
  const data = await fetchJSON(`/api/device-performance?period=${state.currentPeriod}${rangeQuery()}`);
  if (!data?.length) return;

  const labels  = data.map(r => r.device_name || t('dashboard.unknown'));
  const revenue = data.map(r => parseFloat(r.revenue));
  const orders  = data.map(r => parseInt(r.orders));

  const maxRev    = Math.max(...revenue);
  const revColors = revenue.map(v => v === maxRev ? 'rgba(245,158,11,0.9)' : 'rgba(245,158,11,0.45)');

  destroyChart('devicePerfChart');
  state.charts.devicePerfChart = new Chart(document.getElementById('devicePerfChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: t('report.chartRevenueKhr'), data: revenue, backgroundColor: revColors,               borderRadius: 4, yAxisID: 'y' },
        { label: t('dashboard.kpi.orders'),   data: orders,  backgroundColor: 'rgba(59,130,246,0.6)', borderRadius: 4, yAxisID: 'y2' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, font: { size: 11 } } },
      },
      scales: {
        x:  { grid: { color: '#1e293b' }, ticks: { color: '#94a3b8', font: { size: 11 } } },
        y:  { position: 'left',  grid: { color: '#334155' }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => '៛' + fmt(v) } },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#3b82f6', font: { size: 11 } } },
      },
    },
  });
}

// ─── Load All ────────────────────────────────────────────────────────────────

export function loadAll() {
  loadReportKPIs();
  loadRevenueTrend();
  loadDiningOptions();
  loadPaymentMethods();
  loadTopProducts();
  loadExpenseTrend();
  loadDevicePerformance();
}

// ─── Period Controls ──────────────────────────────────────────────────────────

export function applyDateFilter({ period, start, end }) {
  state.currentPeriod    = period;
  state.currentStartDate = period === 'range' ? start : '';
  state.currentEndDate   = period === 'range' ? end   : '';
  loadAll();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function init() {
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [
      { key: 'last10', labelKey: 'common.last10Days' },
    ],
    defaultPreset: 'last10',
    onChange: applyDateFilter,
  });
}
