import { state, COLORS } from '../state.js';
import { fetchJSON } from '../api.js';
import { getEl, fmt, fmtRaw, fmtKHR, fmtDate } from '../utils.js';
import { emptyStateHTML, errorStateHTML, chartStateShow, chartStateClear, legendRowsHTML } from '../ui.js';
import { destroyChart, chartOpts, barOpts, pieOpts, themeColor, tooltipTheme, legendTheme, numTicks, withAlpha } from '../charts.js';
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
  const el = getEl('reportKpis');
  if (!el) return;
  if (!data) {
    el.innerHTML = `<div class="col-span-full card">${errorStateHTML({ vars: { range: periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate) } })}</div>`;
    return;
  }

  const grossVal = parseFloat(data.gross_income.value);
  const expVal   = parseFloat(data.expenses.value);
  const netVal   = parseFloat(data.net_revenue);
  const margin   = grossVal > 0 ? (netVal / grossVal * 100).toFixed(1) : '0';
  const aov      = parseFloat(data.aov.value);
  const expPct   = grossVal > 0 ? (expVal / grossVal * 100).toFixed(1) : '0';

  el.innerHTML = [
    {
      accent: 'amber', icon: '💰', label: t('report.kpi.totalRevenue'),
      val: fmtKHR(grossVal), valClass: 'val-accent',
      sub: `<span class="text-[color:var(--text-muted)]">${t('report.kpi.vsPrev')} </span><span class="text-[color:var(--text-secondary)]">${growthBadge(data.gross_income.growth)}</span>`,
    },
    {
      accent: 'red', icon: '💸', label: t('dashboard.kpi.expenses'),
      val: '-' + fmtKHR(expVal), valClass: 'val-loss',
      sub: `<span class="text-[color:var(--text-muted)]">${t('report.kpi.pctOfRevenue', { pct: expPct })} · </span><span class="text-[color:var(--text-secondary)]">${growthBadge(data.expenses.growth)}</span>`,
    },
    {
      accent: 'violet', icon: '🧾', label: t('report.kpi.avgOrderValue'),
      val: fmtKHR(aov), valClass: 'val-violet',
      sub: `<span class="text-[color:var(--text-muted)]">${t('report.kpi.vsPrev')} </span><span class="text-[color:var(--text-secondary)]">${growthBadge(data.aov.growth)}</span>`,
    },
    {
      accent: 'emerald', icon: '📊', label: t('report.kpi.netMargin'),
      val: margin + '%', valClass: netVal >= 0 ? 'val-blue' : 'val-loss',
      sub: `<span class="text-[color:var(--chart-2)] num">${t('report.kpi.netAmount', { amount: fmtKHR(Math.abs(netVal)) })}</span>`,
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
  destroyChart('revTrendChart');
  if (!data) {
    chartStateShow('revTrendChart', errorStateHTML({ vars: { range: periodLabel(p, s, e) } }));
    return;
  }
  if (!data.length) {
    chartStateShow('revTrendChart', emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }));
    return;
  }
  chartStateClear('revTrendChart');

  const labels   = data.map(r => fmtDate(r.period, gran));
  const revenue  = data.map(r => parseFloat(r.gross_income));
  const growth   = revenue.map((v, i) => {
    if (i === 0 || revenue[i - 1] === 0) return null;
    return parseFloat(((v - revenue[i - 1]) / revenue[i - 1] * 100).toFixed(1));
  });

  const gain = themeColor('--gain', '#7fc98f');
  state.charts.revTrendChart = new Chart(document.getElementById('revTrendChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: t('report.chartRevenue'),
          data: revenue,
          backgroundColor: withAlpha('--accent', 0.7),
          borderColor: themeColor('--accent', '#f59e0b'),
          borderWidth: 1,
          borderRadius: 6,
          yAxisID: 'y',
        },
        {
          label: t('report.chartGrowthPct'),
          data: growth,
          type: 'line',
          borderColor: gain,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: gain,
          tension: 0.3,
          yAxisID: 'y2',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: legendTheme(), tooltip: tooltipTheme() },
      scales: {
        x:  { grid: { color: themeColor('--bg-surface', '#151f33') }, ticks: numTicks() },
        y:  { position: 'left',  grid: { color: themeColor('--border', '#2b3952') }, ticks: numTicks({ callback: v => fmtKHR(v) }) },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: numTicks({ callback: v => v + '%' }) },
      },
    },
  });
}

// ─── Section 3a: Dining Channel ──────────────────────────────────────────────

async function loadDiningOptions() {
  const data = await fetchJSON(`/api/dining-options?period=${state.currentPeriod}${rangeQuery()}`);
  const legend = getEl('diningLegend');
  destroyChart('diningChart');
  if (!data?.length) {
    chartStateShow('diningChart', data ? emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }) : errorStateHTML({ vars: { range: periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate) } }));
    if (legend) legend.innerHTML = '';
    return;
  }
  chartStateClear('diningChart');

  const labels  = data.map(r => r.dining_option);
  const revenue = data.map(r => parseFloat(r.revenue));
  const total   = revenue.reduce((a, b) => a + b, 0);

  state.charts.diningChart = new Chart(document.getElementById('diningChart'), {
    type: 'pie',
    data: { labels, datasets: [{ data: revenue, backgroundColor: COLORS, borderWidth: 0 }] },
    options: pieOpts(false),
  });

  if (legend) legend.innerHTML = legendRowsHTML(data.map((r, i) => ({
    label: r.dining_option,
    color: COLORS[i % COLORS.length],
    amount: fmtKHR(r.revenue),
    pct: total > 0 ? ((r.revenue / total) * 100).toFixed(1) : 0,
  })));
}

// ─── Section 3b: Payment Method ──────────────────────────────────────────────

async function loadPaymentMethods() {
  const data = await fetchJSON(`/api/payment-methods?period=${state.currentPeriod}${rangeQuery()}`);
  const legend = getEl('paymentLegend');
  destroyChart('paymentChart');
  if (!data?.length) {
    chartStateShow('paymentChart', data ? emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }) : errorStateHTML({ vars: { range: periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate) } }));
    if (legend) legend.innerHTML = '';
    return;
  }
  chartStateClear('paymentChart');

  const labels = data.map(r => r.payment_name || r.payment_type);
  const totals = data.map(r => parseFloat(r.total));
  const total  = totals.reduce((a, b) => a + b, 0);

  const sliceColor = i => COLORS[(i + 2) % COLORS.length];

  state.charts.paymentChart = new Chart(document.getElementById('paymentChart'), {
    type: 'pie',
    data: { labels, datasets: [{ data: totals, backgroundColor: labels.map((_, i) => sliceColor(i)), borderWidth: 0 }] },
    options: pieOpts(false),
  });

  if (legend) legend.innerHTML = legendRowsHTML(data.map((r, i) => ({
    label: r.payment_name || r.payment_type,
    color: sliceColor(i),
    amount: fmtKHR(r.total),
    pct: total > 0 ? ((r.total / total) * 100).toFixed(1) : 0,
  })));
}

// ─── Section 3c: Top Product Performance ─────────────────────────────────────

let topProductsLimit    = 5;
let topProductsCategory = '';

async function loadTopProducts() {
  const categoryQuery = topProductsCategory ? `&category=${topProductsCategory}` : '';
  const data = await fetchJSON(`/api/item-comparison?period=${state.currentPeriod}${rangeQuery()}&order=desc&limit=${topProductsLimit}${categoryQuery}`);
  const legend = getEl('topProductsLegend');

  destroyChart('topProductsChart');
  if (!data?.length) {
    const categoryLabel = topProductsCategory === 'food' ? t('dashboard.categoryFood')
      : topProductsCategory === 'beverage' ? t('dashboard.categoryBeverage')
      : '';
    const message = !data
      ? errorStateHTML({ vars: { range: periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate) } })
      : categoryLabel
        ? `<div class="panel-state"><div class="panel-state-icon">🧾</div><div class="panel-state-title">${t('report.noCategoryItemsForPeriod', { category: categoryLabel })}</div><div class="panel-state-hint">${t('common.emptyHintWiden')}</div></div>`
        : emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' });
    chartStateShow('topProductsChart', message);
    if (legend) legend.innerHTML = '';
    return;
  }
  chartStateClear('topProductsChart');

  const labels  = data.map(r => r.item_name);
  const revenue = data.map(r => parseFloat(r.revenue));
  const total   = revenue.reduce((a, b) => a + b, 0);

  state.charts.topProductsChart = new Chart(document.getElementById('topProductsChart'), {
    type: 'pie',
    data: { labels, datasets: [{ data: revenue, backgroundColor: COLORS, borderWidth: 0 }] },
    options: pieOpts(false),
  });

  if (legend) legend.innerHTML = legendRowsHTML(data.map((r, i) => ({
    label: r.item_name,
    color: COLORS[i % COLORS.length],
    meta: `${t('dashboard.table.qty')}: ${fmt(r.qty)}`,
    amount: fmtKHR(r.revenue),
    pct: total > 0 ? ((r.revenue / total) * 100).toFixed(1) : 0,
  })));
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
  destroyChart('expenseTrendChart');
  if (!expData) {
    chartStateShow('expenseTrendChart', errorStateHTML({ vars: { range: periodLabel(p, state.currentStartDate, state.currentEndDate) } }));
    return;
  }
  if (!expData.length) {
    chartStateShow('expenseTrendChart', emptyStateHTML({}));
    return;
  }
  chartStateClear('expenseTrendChart');

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
  if (chip) chip.textContent = t('report.expenseSummaryChip', { total: fmtKHR(totalExp), pct: overallPct });

  const ratioColor = themeColor('--chart-6', '#2f9cbd');
  state.charts.expenseTrendChart = new Chart(document.getElementById('expenseTrendChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: t('report.chartRevenueKhr'),
          data: revenue,
          backgroundColor: withAlpha('--accent', 0.5),
          borderColor: themeColor('--accent', '#f59e0b'),
          borderWidth: 1,
          borderRadius: 6,
          yAxisID: 'y',
        },
        {
          label: t('report.chartExpensesKhr'),
          data: expenses,
          backgroundColor: withAlpha('--loss', 0.7),
          borderColor: themeColor('--loss', '#e28377'),
          borderWidth: 1,
          borderRadius: 6,
          yAxisID: 'y',
        },
        {
          label: t('report.chartExpensePct'),
          data: expPct,
          type: 'line',
          borderColor: ratioColor,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: ratioColor,
          tension: 0.3,
          yAxisID: 'y2',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: legendTheme(),
        tooltip: {
          ...tooltipTheme(),
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
        x:  { grid: { color: themeColor('--bg-surface', '#151f33') }, ticks: numTicks() },
        y:  { position: 'left',  grid: { color: themeColor('--border', '#2b3952') }, ticks: numTicks({ callback: v => fmtKHR(v) }) },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: numTicks({ color: ratioColor, callback: v => v + '%' }), suggestedMax: 100 },
      },
    },
  });
}

// ─── Section 6: POS Device Performance ───────────────────────────────────────

async function loadDevicePerformance() {
  const data = await fetchJSON(`/api/device-performance?period=${state.currentPeriod}${rangeQuery()}`);
  destroyChart('devicePerfChart');
  if (!data?.length) {
    chartStateShow('devicePerfChart', data ? emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }) : errorStateHTML({ vars: { range: periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate) } }));
    return;
  }
  chartStateClear('devicePerfChart');

  const labels  = data.map(r => r.device_name || t('dashboard.unknown'));
  const revenue = data.map(r => parseFloat(r.revenue));
  const orders  = data.map(r => parseInt(r.orders));

  const maxRev    = Math.max(...revenue);
  const revColors = revenue.map(v => v === maxRev ? withAlpha('--accent', 0.9) : withAlpha('--accent', 0.45));
  const ordersColor = themeColor('--chart-2', '#5c8fe6');

  state.charts.devicePerfChart = new Chart(document.getElementById('devicePerfChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: t('report.chartRevenueKhr'), data: revenue, backgroundColor: revColors,                     borderRadius: 4, yAxisID: 'y' },
        { label: t('dashboard.kpi.orders'),   data: orders,  backgroundColor: withAlpha('--chart-2', 0.6), borderRadius: 4, yAxisID: 'y2' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: legendTheme('bottom'), tooltip: tooltipTheme() },
      scales: {
        x:  { grid: { color: themeColor('--bg-surface', '#151f33') }, ticks: numTicks({ color: themeColor('--text-secondary', '#a5a396') }) },
        y:  { position: 'left',  grid: { color: themeColor('--border', '#2b3952') }, ticks: numTicks({ callback: v => fmtKHR(v) }) },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: numTicks({ color: ordersColor }) },
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
      { key: 'yesterday', labelKey: 'common.yesterday' },
      { key: 'last10', labelKey: 'common.last10Days' },
    ],
    defaultPreset: 'yesterday',
    onChange: applyDateFilter,
  });
}
