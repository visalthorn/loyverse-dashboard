import { state, COLORS } from '../state.js';
import { t } from '../i18n.js';
import { fetchJSON } from '../api.js';
import { getEl, fmt, fmtRaw, fmtKHR, fmtDate, fmtDatetime, TZ } from '../utils.js';
import { destroyChart, chartOpts, barOpts, donutOpts, themeColor, withAlpha, legendTheme } from '../charts.js';
import { renderDateFilter, periodLabel } from '../dateFilter.js';
import { emptyStateHTML, errorStateHTML, chartStateShow, chartStateClear, legendRowsHTML, growthBadge } from '../ui.js';
import { renderBranchFilter } from '../branchFilter.js';
import { loadBranchBreakdown } from '../branchBreakdown.js';

function currentRangeLabel() {
  return periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate);
}

// ─── Period helpers ───────────────────────────────────────────────────────────

function rangeQuery() {
  return state.currentPeriod === 'range' && state.currentStartDate && state.currentEndDate
    ? `&start=${state.currentStartDate}&end=${state.currentEndDate}`
    : '';
}

function branchQuery() {
  return state.branchId ? `&branch=${state.branchId}` : '';
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

async function loadKPIs() {
  const data = await fetchJSON(`/api/kpis?period=${state.currentPeriod}${rangeQuery()}${branchQuery()}`);
  if (!data) {
    const html = `<div class="col-span-full card">${errorStateHTML({ vars: { range: currentRangeLabel() } })}</div>`;
    const p = getEl('kpiPrimary'); if (p) p.innerHTML = html;
    return;
  }

  const grossVal  = parseFloat(data.gross_income.value);
  const netVal    = parseFloat(data.net_revenue);
  const expVal    = parseFloat(data.expenses.value);

  const netPositive  = netVal >= 0;
  const netAccent    = netPositive ? 'emerald' : 'red';
  const netValClass  = netPositive ? 'val-gain' : 'val-loss';
  const netIcon      = netPositive ? '📈' : '📉';
  const margin       = grossVal > 0 ? Math.round((netVal / grossVal) * 100) : 0;
  const expPct       = grossVal > 0 ? Math.round((expVal / grossVal) * 100) : 0;

  // ── Section 1: Period totals ────────────────────────────────────────────────
  const primary = [
    {
      accent: 'amber', icon: '💰', label: t('dashboard.kpi.grossIncome'),
      val: fmtKHR(grossVal), valClass: 'val-accent',
      growth: data.gross_income.growth,
      sub: `<span class="${netValClass} font-semibold num">Net ${fmtKHR(Math.abs(netVal))}</span>`
         + `<span class="text-[color:var(--text-muted)]"> · ${t('dashboard.kpi.marginSub', { margin })}</span>`,
    },
    {
      accent: netAccent, icon: netIcon, label: t('dashboard.kpi.netProfit'),
      val: (netPositive ? '' : '-') + fmtKHR(Math.abs(netVal)),
      valClass: netValClass,
      growth: null,
      sub: `<span class="text-[color:var(--text-muted)]">${t('dashboard.kpi.netSub')}</span>`,
    },
    {
      accent: 'blue', icon: '🧾', label: t('dashboard.kpi.orders'),
      val: fmtRaw(data.orders.value), valClass: 'val-blue',
      growth: data.orders.growth,
      sub: `<span class="text-[color:var(--text-muted)]">${t('dashboard.kpi.aovSub')} </span>`
         + `<span class="text-[color:var(--text-secondary)] font-semibold num">${fmtKHR(data.aov.value)}</span>`,
    },
    {
      accent: 'red', icon: '💸', label: t('dashboard.kpi.expenses'),
      val: '-' + fmtKHR(expVal), valClass: 'val-loss',
      growth: data.expenses.growth,
      sub: `<span class="text-[color:var(--text-muted)]">${t('dashboard.kpi.pctOfGross', { pct: expPct })}</span>`,
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
}

// ─── Gross Income Trend ──────────────────────────────────────────────────────

async function loadGrossIncomeTrend() {
  const trendPeriod  = getGrossIncomeTrendGranularity();
  const { currentPeriod: p, currentStartDate: s, currentEndDate: e } = state;

  const trendLabel = getEl('grossIncomeLabel');
  if (trendLabel) trendLabel.textContent = periodLabel(p, s, e);

  const [incomeData, expenseTrend] = await Promise.all([
    fetchJSON(`/api/gross-income?period=${p}${rangeQuery()}${branchQuery()}`),
    fetchJSON(`/api/expenses-trend?period=${p}${rangeQuery()}${branchQuery()}`),
  ]);
  destroyChart('grossIncomeChart');
  if (!incomeData) {
    chartStateShow('grossIncomeChart', errorStateHTML({ vars: { range: currentRangeLabel() } }));
    return;
  }
  if (!incomeData.length) {
    chartStateShow('grossIncomeChart', emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }));
    return;
  }
  chartStateClear('grossIncomeChart');

  const ppDateKey = period => new Date(period).toLocaleDateString('en-CA', { timeZone: TZ });

  const labels  = incomeData.map(r => fmtDate(r.period, trendPeriod));
  const revenue = incomeData.map(r => parseFloat(r.gross_income));

  const expenseMap = {};
  if (expenseTrend?.length) expenseTrend.forEach(e => { expenseMap[ppDateKey(e.period)] = parseFloat(e.total_expense); });
  const expenses = incomeData.map(r => expenseMap[ppDateKey(r.period)] || 0);

  const opts = chartOpts('៛');
  opts.plugins.legend = legendTheme();
  state.charts.grossIncomeChart = new Chart(document.getElementById('grossIncomeChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: t('dashboard.kpi.grossIncome'), data: revenue, backgroundColor: withAlpha('--accent', 0.7), borderColor: themeColor('--accent', '#f59e0b'), borderWidth: 1, borderRadius: 6 },
        { label: t('dashboard.kpi.expenses'),     data: expenses, backgroundColor: withAlpha('--loss', 0.7),  borderColor: themeColor('--loss', '#e28377'), borderWidth: 1, borderRadius: 6 },
      ],
    },
    options: opts,
  });
}

// ─── Dining Options ──────────────────────────────────────────────────────────

async function loadDiningOptions() {
  const data = await fetchJSON(`/api/dining-options?period=${state.currentPeriod}${rangeQuery()}${branchQuery()}`);
  const legend = getEl('diningLegend');
  destroyChart('diningChart');
  if (!data?.length) {
    chartStateShow('diningChart', data ? emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }) : errorStateHTML({ vars: { range: currentRangeLabel() } }));
    if (legend) legend.innerHTML = '';
    return;
  }
  chartStateClear('diningChart');

  const labels  = data.map(r => r.dining_option);
  const revenue = data.map(r => parseFloat(r.revenue));
  const total   = revenue.reduce((a, b) => a + b, 0);

  state.charts.diningChart = new Chart(document.getElementById('diningChart'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: revenue, backgroundColor: COLORS, borderWidth: 0 }] },
    options: donutOpts(),
  });

  if (legend) legend.innerHTML = legendRowsHTML(data.map((r, i) => ({
    label: r.dining_option,
    color: COLORS[i % COLORS.length],
    amount: fmtKHR(r.revenue),
    pct: total > 0 ? ((r.revenue / total) * 100).toFixed(1) : 0,
  })));
}

// ─── Payment Methods ─────────────────────────────────────────────────────────

async function loadPaymentMethods() {
  const data = await fetchJSON(`/api/payment-methods?period=${state.currentPeriod}${rangeQuery()}${branchQuery()}`);
  const legend = getEl('paymentLegend');
  destroyChart('paymentChart');
  if (!data?.length) {
    chartStateShow('paymentChart', data ? emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }) : errorStateHTML({ vars: { range: currentRangeLabel() } }));
    if (legend) legend.innerHTML = '';
    return;
  }
  chartStateClear('paymentChart');

  const labels = data.map(r => r.payment_name || r.payment_type);
  const totals = data.map(r => parseFloat(r.total));
  const total  = totals.reduce((a, b) => a + b, 0);

  // Offset into the fixed palette so payment hues differ from the dining
  // donut beside it; modulo keeps >6 slices from running off the palette.
  const sliceColor = i => COLORS[(i + 2) % COLORS.length];

  state.charts.paymentChart = new Chart(document.getElementById('paymentChart'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: totals, backgroundColor: labels.map((_, i) => sliceColor(i)), borderWidth: 0 }] },
    options: donutOpts(),
  });

  if (legend) legend.innerHTML = legendRowsHTML(data.map((r, i) => ({
    label: r.payment_name || r.payment_type,
    color: sliceColor(i),
    amount: fmtKHR(r.total),
    pct: total > 0 ? ((r.total / total) * 100).toFixed(1) : 0,
  })));
}

// ─── Top Products (with growth vs last period + slow movers) ────────────────

function renderProductRows(rows, tbodyId, startRank = 1) {
  const tbody = getEl(tbodyId);
  if (!tbody) return;
  if (!rows) {
    tbody.innerHTML = `<tr><td colspan="6">${errorStateHTML({ vars: { range: currentRangeLabel() } })}</td></tr>`;
    return;
  }
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6">${emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' })}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, i) => `
    <tr class="border-b border-dashed border-[color:var(--border)] hover:bg-[color:var(--hover-tint)] transition-colors">
      <td class="py-2 pr-3 text-[color:var(--text-muted)] num">${startRank + i}</td>
      <td class="py-2 pr-3">
        <div class="font-medium">${r.item_name}</div>
        <div class="text-xs text-[color:var(--text-muted)]">${r.sku || ''}</div>
      </td>
      <td class="py-2 pr-3 text-right text-[color:var(--text-secondary)] num">${fmt(r.qty)}</td>
      <td class="py-2 pr-3 text-right val-accent font-medium num">${fmtKHR(r.revenue)}</td>
      <td class="py-2 pr-3 text-right text-[color:var(--text-muted)] num">${r.prev_revenue > 0 ? fmtKHR(r.prev_revenue) : '—'}</td>
      <td class="py-2 text-right">${growthBadge(r.growth) || '<span class="text-[color:var(--text-muted)]">—</span>'}</td>
    </tr>
  `).join('');
}

let topProductsCategory = '';

async function loadTopItems() {
  const categoryQuery = topProductsCategory ? `&category=${encodeURIComponent(topProductsCategory)}` : '';
  const data = await fetchJSON(`/api/item-comparison?period=${state.currentPeriod}${rangeQuery()}&order=desc&limit=20${categoryQuery}${branchQuery()}`);
  renderProductRows(data, 'productTableBody');
}

async function loadSlowMovers() {
  const categoryQuery = topProductsCategory ? `&category=${encodeURIComponent(topProductsCategory)}` : '';
  const data = await fetchJSON(`/api/item-comparison?period=${state.currentPeriod}${rangeQuery()}&order=asc&limit=10${categoryQuery}${branchQuery()}`);
  renderProductRows(data, 'slowMoversBody', 1);
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

export function setTopProductsCategory(val) {
  topProductsCategory = val;
  loadTopItems();
  if (!getEl('slowMoversSection')?.classList.contains('hidden')) loadSlowMovers();
}

export function toggleSlowMovers() {
  const section = getEl('slowMoversSection');
  const btn     = getEl('slowMoversBtn');
  if (!section) return;

  const isHidden = section.classList.contains('hidden');
  section.classList.toggle('hidden', !isHidden);
  if (btn) {
    btn.innerHTML = `<span id="slowMoversArrow">${isHidden ? '▼' : '▶'}</span> ${isHidden ? t('dashboard.hideSlowMovers') : t('dashboard.showSlowMovers')}`;
  }

  if (isHidden) loadSlowMovers();
}

// ─── Employee Performance ────────────────────────────────────────────────────

async function loadEmployeePerformance() {
  const data = await fetchJSON(`/api/employee-performance?period=${state.currentPeriod}${rangeQuery()}${branchQuery()}`);
  destroyChart('employeeChart');
  if (!data?.length) {
    chartStateShow('employeeChart', data ? emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }) : errorStateHTML({ vars: { range: currentRangeLabel() } }));
    return;
  }
  chartStateClear('employeeChart');

  state.charts.employeeChart = new Chart(document.getElementById('employeeChart'), {
    type: 'bar',
    data: {
      labels: data.map(r => r.employee_id || t('dashboard.unknown')),
      datasets: [{ label: t('dashboard.table.revenue'), data: data.map(r => parseFloat(r.revenue)), backgroundColor: withAlpha('--accent', 0.7), borderRadius: 6 }],
    },
    options: barOpts('៛'),
  });
}

// ─── Device Performance ──────────────────────────────────────────────────────

async function loadDevicePerformance() {
  const data = await fetchJSON(`/api/device-performance?period=${state.currentPeriod}${rangeQuery()}${branchQuery()}`);
  destroyChart('deviceChart');
  if (!data?.length) {
    chartStateShow('deviceChart', data ? emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }) : errorStateHTML({ vars: { range: currentRangeLabel() } }));
    return;
  }
  chartStateClear('deviceChart');

  state.charts.deviceChart = new Chart(document.getElementById('deviceChart'), {
    type: 'bar',
    data: {
      labels: data.map(r => r.device_name || t('dashboard.unknown')),
      datasets: [{ label: t('dashboard.table.revenue'), data: data.map(r => parseFloat(r.revenue)), backgroundColor: withAlpha('--chart-2', 0.7), borderRadius: 6 }],
    },
    options: barOpts('៛'),
  });
}

// ─── Stock Watch ─────────────────────────────────────────────────────────────

// "Now"-based: driven by restock history + linked-item sales since the last
// restock, so the global period filter deliberately does not reload it.
async function loadStockWatch() {
  const box = getEl('stockWatchList');
  if (!box) return;

  const data = await fetchJSON('/api/inventory/analysis');
  if (!data) {
    box.innerHTML = `<p class="text-sm text-[color:var(--text-muted)]">${t('dashboard.stockWatchLoadFailed')}</p>`;
    return;
  }

  const alerts = data.filter(r => r.status === 'inspect' || r.status === 'soon');
  if (!alerts.length) {
    box.innerHTML = `<p class="text-sm" style="color:var(--gain)">${t('dashboard.stockWatchAllOk')}</p>`;
    return;
  }

  box.innerHTML = alerts.map(r => {
    const color = r.status === 'inspect' ? 'var(--loss)' : 'var(--accent-strong)';
    const days  = r.days_until_empty != null
      ? `<span class="num text-xl font-bold" style="color:${color}">${r.days_until_empty}</span> <span class="text-xs text-[color:var(--text-muted)]">${t('dashboard.stockWatchDays')}</span>`
      : `<span class="text-xs text-[color:var(--text-muted)]">—</span>`;
    return `
    <div class="flex items-center justify-between gap-3 p-2 rounded bg-[color:var(--bg-surface-alt)]">
      <div class="min-w-0">
        <div class="font-medium truncate">${r.name}${r.name_kh ? ` <span class="text-sm text-[color:var(--text-secondary)]">${r.name_kh}</span>` : ''}</div>
        <div class="text-xs text-[color:var(--text-muted)]">
          <span class="num font-semibold" style="color:${color}">~${r.estimated_remaining} ${r.unit}</span>
          · ${t('dashboard.stockWatchLastRestock', { date: r.last_restock_date ? fmtDate(r.last_restock_date) : '—' })}
        </div>
      </div>
      <div class="flex items-center gap-4 flex-shrink-0">
        <div class="text-right">${days}</div>
        <a href="/inventory" class="text-xs text-[color:var(--accent-strong)] hover:underline whitespace-nowrap">${t('dashboard.stockWatchRestockNow')}</a>
      </div>
    </div>`;
  }).join('');
}

// ─── Cancelled Orders ────────────────────────────────────────────────────────

async function loadCancelledOrders() {
  const data = await fetchJSON(`/api/cancelled-orders?period=${state.currentPeriod}${rangeQuery()}${branchQuery()}`);
  const cancelSummary = getEl('cancelSummary');
  const cancelList = getEl('cancelList');
  if (!data) {
    if (cancelSummary) cancelSummary.innerHTML = '';
    if (cancelList) cancelList.innerHTML = errorStateHTML({ vars: { range: currentRangeLabel() } });
    return;
  }

  if (cancelSummary) cancelSummary.innerHTML = `
    <span class="val-loss font-bold">${t('dashboard.cancelledCount', { count: data.summary.count })}</span>
    <span class="text-[color:var(--text-muted)]">${t('dashboard.cancelledLost', { amount: '<span class="val-loss font-bold num">' + fmtKHR(data.summary.lost_revenue) + '</span>' })}</span>
  `;

  if (cancelList) cancelList.innerHTML = data.items.length
    ? data.items.map(r => `
        <div class="cancel-row">
          <div>
            <div class="font-medium num">#${r.receipt_number}</div>
            <div class="text-xs text-[color:var(--text-muted)]">${fmtDatetime(r.cancelled_at)} · ${r.dining_option || '-'} · ${r.employee_id || '-'}</div>
          </div>
          <div class="val-loss font-bold num">-${fmtKHR(r.total_money)}</div>
        </div>
      `).join('')
    : `<p class="text-[color:var(--text-muted)] text-sm">${t('dashboard.noCancellations')}</p>`;
}

// ─── Load All ────────────────────────────────────────────────────────────────

export function loadAll() {
  const lastUpdated = getEl('lastUpdated');
  if (lastUpdated) lastUpdated.textContent = t('dashboard.lastUpdated', { time: new Date().toLocaleTimeString() });
  loadKPIs();
  loadGrossIncomeTrend();
  loadDiningOptions();
  loadPaymentMethods();
  loadTopItems();
  loadEmployeePerformance();
  loadDevicePerformance();
  loadCancelledOrders();
  loadBranchBreakdown('branchBreakdown');
}

// ─── Period Controls (exposed to window) ─────────────────────────────────────

export function applyDateFilter({ period, start, end }) {
  state.currentPeriod    = period;
  // Always keep the resolved dates for display (periodLabel); query builders
  // below only use them when period === 'range'.
  state.currentStartDate = start;
  state.currentEndDate   = end;
  loadAll();
}

// ─── Init ────────────────────────────────────────────────────────────────────

export async function init() {
  const slowMoversBtn = getEl('slowMoversBtn');
  if (slowMoversBtn) slowMoversBtn.innerHTML = `<span id="slowMoversArrow">▶</span> ${t('dashboard.showSlowMovers')}`;
  loadTopProductsCategories();
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [
      { key: 'yesterday', labelKey: 'common.yesterday' },
      { key: 'last10', labelKey: 'common.last10Days' },
    ],
    defaultPreset: 'yesterday',
    initial: { period: state.currentPeriod, start: state.currentStartDate, end: state.currentEndDate },
    onChange: applyDateFilter,
  });
  renderBranchFilter(getEl('branchFilterMount'), { onChange: () => loadAll() });
  loadStockWatch();
  setInterval(loadAll, 5 * 60 * 1000);
  setInterval(loadStockWatch, 5 * 60 * 1000);
}
