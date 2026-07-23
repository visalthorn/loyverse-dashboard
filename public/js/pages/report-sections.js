import { state, COLORS } from '../state.js';
import { fetchJSON } from '../api.js';
import { getEl, fmt, fmtKHR, fmtDate } from '../utils.js';
import { emptyStateHTML, errorStateHTML, chartStateShow, chartStateClear, legendRowsHTML } from '../ui.js';
import { destroyChart, pieOpts, themeColor, tooltipTheme, legendTheme, numTicks, withAlpha } from '../charts.js';
import { t } from '../i18n.js';
import { periodLabel } from '../dateFilter.js';

// Shared section renderers for the live Reports page and the Summary Report
// page. Each page supplies `api`: async functions that return the dataset for
// a section (or null on error) — the pages own their endpoints/query styles.

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

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

const ALL_SECTIONS = ['kpis', 'trend', 'dining', 'payments', 'topProducts', 'expenseTrend', 'device'];

export function createReportSections(api, opts = {}) {
  const sections = opts.sections || ALL_SECTIONS;
  const onData   = opts.onData || (() => {});

  let topProductsLimit    = 5;
  let topProductsCategory = '';
  let reportCategoryLimit  = 5;
  let reportCategoryFilter = '';
  let reportCategoryChartIds = [];

  const rangeLabel = () => periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate);

  // ── Section 1: KPI Summary + daily benchmarks ─────────────────────────────
  async function loadReportKPIs() {
    const data = await api.summary();
    onData('summary', data);
    const el = getEl('reportKpis');
    if (!el) return;
    if (!data) {
      const html = `<div class="col-span-full card">${errorStateHTML({ vars: { range: rangeLabel() } })}</div>`;
      el.innerHTML = html;
      const a = getEl('kpiAverage'); if (a) a.innerHTML = html;
      return;
    }

    const grossVal = parseFloat(data.gross_income.value);
    const expVal   = parseFloat(data.expenses.value);
    const netVal   = parseFloat(data.net_revenue);
    const margin   = grossVal > 0 ? (netVal / grossVal * 100).toFixed(1) : '0';
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
        accent: netVal >= 0 ? 'emerald' : 'red', icon: netVal >= 0 ? '📈' : '📉',
        label: t('dashboard.kpi.netProfit'),
        val: (netVal < 0 ? '-' : '') + fmtKHR(Math.abs(netVal)),
        valClass: netVal >= 0 ? 'val-gain' : 'val-loss',
        sub: `<span class="text-[color:var(--text-muted)]">${t('report.kpi.vsPrev')} </span><span class="text-[color:var(--text-secondary)]">${growthBadge(data.net_growth)}</span>`,
      },
      {
        accent: 'emerald', icon: '📊', label: t('report.kpi.netMargin'),
        val: margin + '%', valClass: netVal >= 0 ? 'val-blue' : 'val-loss',
        sub: `<span class="text-[color:var(--chart-2)] num">${t('report.kpi.netAmount', { amount: fmtKHR(Math.abs(netVal)) })}</span>`,
      },
    ].map(c => `
      <div class="kpi-primary kpi-primary--${c.accent}">
        <div class="flex items-start justify-between gap-2">
          <div class="kpi-icon kpi-icon--${c.accent}">${c.icon}</div>
        </div>
        <div class="kpi-primary-val ${c.valClass}">${c.val}</div>
        <div class="kpi-primary-lbl">${c.label}</div>
        <div class="kpi-primary-sub">${c.sub}</div>
      </div>
    `).join('');

    const avgNetVal      = parseFloat(data.net_per_order?.value ?? 0);
    const avgNetPositive = avgNetVal >= 0;

    const averages = [
      {
        accent: 'amber', label: t('dashboard.kpi.grossIncome'),
        val: fmtKHR(data.avg_gross_income?.value ?? 0),
        valClass: 'val-accent',
        growth: data.avg_gross_income?.growth,
        sub: t('dashboard.perDayAvg'),
      },
      {
        accent: avgNetPositive ? 'emerald' : 'red', label: t('dashboard.kpi.netProfit'),
        val: (avgNetPositive ? '' : '-') + fmtKHR(Math.abs(avgNetVal)),
        valClass: avgNetPositive ? 'val-gain' : 'val-loss',
        growth: data.net_per_order?.growth,
        sub: t('dashboard.perDayAvg'),
        highlight: true,
      },
      {
        accent: 'violet', label: t('dashboard.kpi.orders'),
        val: fmtKHR(data.aov?.value ?? 0),
        valClass: 'val-violet',
        growth: data.aov?.growth,
        sub: t('dashboard.avgValuePerOrder'),
      },
      {
        accent: 'red', label: t('dashboard.kpi.expenses'),
        val: '-' + fmtKHR(data.avg_expense?.value ?? 0),
        valClass: 'val-loss',
        growth: data.avg_expense?.growth,
        sub: t('dashboard.perDayAvg'),
      },
    ];

    const avgEl = getEl('kpiAverage');
    if (avgEl) avgEl.innerHTML = averages.map(c => `
      <div class="kpi-avg kpi-avg--${c.accent}${c.highlight ? ' kpi-avg--highlight' : ''}">
        <div class="flex items-start justify-between gap-1 mb-1">
          <div class="kpi-avg-lbl">${c.label}</div>
          ${c.growth == null ? '' : growthBadge(c.growth)}
        </div>
        <div class="kpi-avg-val ${c.valClass}">${c.val}</div>
        <div class="kpi-avg-sub">${c.sub}</div>
      </div>
    `).join('');
  }

  // ── Section 2: Revenue Trend + Growth % ───────────────────────────────────
  async function loadRevenueTrend() {
    const gran  = trendGranularity();
    const label = getEl('revTrendLabel');
    if (label) label.textContent = rangeLabel();

    const data = await api.trend();
    destroyChart('revTrendChart');
    if (!data) {
      chartStateShow('revTrendChart', errorStateHTML({ vars: { range: rangeLabel() } }));
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

  // ── Section 3a: Dining Channel ────────────────────────────────────────────
  async function loadDiningOptions() {
    const data = await api.dining();
    onData('dining', data);
    const legend = getEl('diningLegend');
    destroyChart('diningChart');
    if (!data?.length) {
      chartStateShow('diningChart', data ? emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }) : errorStateHTML({ vars: { range: rangeLabel() } }));
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

  // ── Section 3b: Payment Method ────────────────────────────────────────────
  async function loadPaymentMethods() {
    const data = await api.payments();
    onData('payments', data);
    const legend = getEl('paymentLegend');
    destroyChart('paymentChart');
    if (!data?.length) {
      chartStateShow('paymentChart', data ? emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }) : errorStateHTML({ vars: { range: rangeLabel() } }));
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

  // ── Section 3c: Top Product Performance ───────────────────────────────────
  async function loadTopProducts() {
    const data = await api.topItems(topProductsLimit, topProductsCategory);
    const legend = getEl('topProductsLegend');

    destroyChart('topProductsChart');
    if (!data?.length) {
      const categoryLabel = topProductsCategory || '';
      const message = !data
        ? errorStateHTML({ vars: { range: rangeLabel() } })
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

  async function loadTopProductsCategories() {
    const sel = getEl('topProductsCategory');
    if (!sel) return;
    const data = await fetchJSON('/api/categories') || [];
    data.forEach(row => {
      const opt = document.createElement('option');
      opt.value = row.category;
      opt.textContent = row.category;
      sel.appendChild(opt);
    });
  }

  async function loadReportCategoriesList() {
    const sel = getEl('reportCategoryFilterCategory');
    if (!sel) return;
    const data = await fetchJSON('/api/items/report-categories') || [];
    data.forEach(row => {
      const opt = document.createElement('option');
      opt.value = row.name;
      opt.textContent = row.name;
      sel.appendChild(opt);
    });
  }

  // ── Section 3d: Top Products by Report Category (Summary Report only) ────
  async function loadTopItemsByReportCategory() {
    const container = getEl('reportCategoryCharts');
    if (!container) return;
    const data = await api.topItemsByReportCategory(reportCategoryLimit, reportCategoryFilter);

    reportCategoryChartIds.forEach(id => destroyChart(id));
    reportCategoryChartIds = [];

    if (!data) {
      container.innerHTML = errorStateHTML({ vars: { range: rangeLabel() } });
      return;
    }
    if (!data.length) {
      container.innerHTML = emptyStateHTML({
        titleKey: 'report.emptyNoReportCategories', hintKey: 'report.emptyHintReportCategories',
      });
      return;
    }

    container.innerHTML = data.map((group, i) => `
      <div class="report-cat-card">
        <div class="report-cat-title" title="${esc(group.report_category)}">${esc(group.report_category)}</div>
        <div class="chart-container-sm"><canvas id="reportCatChart${i}"></canvas></div>
        <div id="reportCatLegend${i}" class="space-y-2 mt-3"></div>
        <div class="section-bullet">${t('summary.hl.itemsSold', { n: fmt(group.items_sold) })}</div>
      </div>`).join('');

    data.forEach((group, i) => {
      const canvasId = `reportCatChart${i}`;
      const labels  = group.items.map(it => it.item_name);
      const revenue = group.items.map(it => parseFloat(it.revenue));
      const total   = revenue.reduce((a, b) => a + b, 0);

      reportCategoryChartIds.push(canvasId);
      state.charts[canvasId] = new Chart(document.getElementById(canvasId), {
        type: 'pie',
        data: { labels, datasets: [{ data: revenue, backgroundColor: COLORS, borderWidth: 0 }] },
        options: pieOpts(false),
      });

      const legend = getEl(`reportCatLegend${i}`);
      if (legend) legend.innerHTML = legendRowsHTML(group.items.map((it, j) => ({
        label: it.item_name,
        color: COLORS[j % COLORS.length],
        meta: `${t('dashboard.table.qty')}: ${fmt(it.qty)}`,
        amount: fmtKHR(it.revenue),
        pct: total > 0 ? ((it.revenue / total) * 100).toFixed(1) : 0,
      })));
    });
  }

  // ── Section 5: Revenue vs Expenses ────────────────────────────────────────
  async function loadExpenseTrend() {
    const gran = trendGranularity();

    const data = await api.revenueExpenses();
    destroyChart('expenseTrendChart');
    if (!data) {
      chartStateShow('expenseTrendChart', errorStateHTML({ vars: { range: rangeLabel() } }));
      return;
    }
    if (!data.length) {
      chartStateShow('expenseTrendChart', emptyStateHTML({}));
      return;
    }
    chartStateClear('expenseTrendChart');

    const labels   = data.map(r => fmtDate(r.period, gran));
    const expenses = data.map(r => parseFloat(r.total_expense));
    const revenue  = data.map(r => parseFloat(r.gross_income));
    const expPct   = data.map((r, i) => {
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

  // ── Section 6: POS Device Performance ─────────────────────────────────────
  async function loadDevicePerformance() {
    const data = await api.device();
    destroyChart('devicePerfChart');
    if (!data?.length) {
      chartStateShow('devicePerfChart', data ? emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }) : errorStateHTML({ vars: { range: rangeLabel() } }));
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
          { label: t('report.chartRevenueKhr'), data: revenue, backgroundColor: revColors,                   borderRadius: 4, yAxisID: 'y' },
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

  const LOADERS = {
    kpis:         loadReportKPIs,
    trend:        loadRevenueTrend,
    dining:       loadDiningOptions,
    payments:     loadPaymentMethods,
    topProducts:  loadTopProducts,
    expenseTrend: loadExpenseTrend,
    device:       loadDevicePerformance,
    reportCategoryCharts: loadTopItemsByReportCategory,
  };

  function loadAll() {
    sections.forEach(key => LOADERS[key]());
  }

  function setTopProductsLimit(val) {
    topProductsLimit = parseInt(val) || 5;
    loadTopProducts();
  }

  function setTopProductsCategory(val) {
    topProductsCategory = val;
    loadTopProducts();
  }

  function setReportCategoryLimit(val) {
    reportCategoryLimit = parseInt(val) || 5;
    loadTopItemsByReportCategory();
  }

  function setReportCategoryFilter(val) {
    reportCategoryFilter = val;
    loadTopItemsByReportCategory();
  }

  return {
    loadAll, setTopProductsLimit, setTopProductsCategory, loadTopProductsCategories,
    loadReportCategoriesList, setReportCategoryLimit, setReportCategoryFilter,
  };
}
