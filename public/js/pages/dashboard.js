import { state, COLORS } from '../state.js';
import { t, days } from '../i18n.js';
import { fetchJSON } from '../api.js';
import { apiPost } from '../api.js';
import { getEl, fmt, fmtRaw, fmtKHR, fmtDate, fmtDatetime, TZ } from '../utils.js';
import { destroyChart, chartOpts, barOpts, donutOpts, heatColor, themeColor, withAlpha, legendTheme } from '../charts.js';
import { renderDateFilter, periodLabel } from '../dateFilter.js';
import { emptyStateHTML, errorStateHTML, chartStateShow, chartStateClear, legendRowsHTML } from '../ui.js';

function currentRangeLabel() {
  return periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate);
}

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
  const data = await fetchJSON(`/api/kpis?period=${state.currentPeriod}${rangeQuery()}`);
  if (!data) {
    const html = `<div class="col-span-full card">${errorStateHTML({ vars: { range: currentRangeLabel() } })}</div>`;
    const p = getEl('kpiPrimary'); if (p) p.innerHTML = html;
    const a = getEl('kpiAverage'); if (a) a.innerHTML = html;
    return;
  }

  const grossVal  = parseFloat(data.gross_income.value);
  const netVal    = parseFloat(data.net_revenue);
  const expVal    = parseFloat(data.expenses.value);
  const avgNetVal = parseFloat(data.net_per_order?.value ?? 0);

  const netPositive  = netVal >= 0;
  const netAccent    = netPositive ? 'emerald' : 'red';
  const netValClass  = netPositive ? 'val-gain' : 'val-loss';
  const netIcon      = netPositive ? '📈' : '📉';
  const margin       = grossVal > 0 ? Math.round((netVal / grossVal) * 100) : 0;
  const expPct       = grossVal > 0 ? Math.round((expVal / grossVal) * 100) : 0;

  const avgNetPositive = avgNetVal >= 0;
  const avgNetAccent   = avgNetPositive ? 'emerald' : 'red';
  const avgNetClass    = avgNetPositive ? 'val-gain' : 'val-loss';

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

  // ── Section 2: Daily benchmarks (same order & terms as Section 1) ───────────
  const averages = [
    {
      accent: 'amber', label: t('dashboard.kpi.grossIncome'),
      val: fmtKHR(data.avg_gross_income?.value ?? 0),
      valClass: 'val-accent',
      growth: data.avg_gross_income?.growth,
      sub: t('dashboard.perDayAvg'),
    },
    {
      accent: avgNetAccent, label: t('dashboard.kpi.netProfit'),
      val: (avgNetPositive ? '' : '-') + fmtKHR(Math.abs(avgNetVal)),
      valClass: avgNetClass,
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
  if (trendLabel) trendLabel.textContent = periodLabel(p, s, e);

  const [incomeData, expenseTrend] = await Promise.all([
    fetchJSON(`/api/gross-income?period=${p}${rangeQuery()}`),
    fetchJSON(`/api/expenses-trend?period=${p}${rangeQuery()}`),
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
  const data = await fetchJSON(`/api/dining-options?period=${state.currentPeriod}${rangeQuery()}`);
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
  const data = await fetchJSON(`/api/payment-methods?period=${state.currentPeriod}${rangeQuery()}`);
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

// ─── Peak Hours Heatmap ──────────────────────────────────────────────────────

async function loadPeakHours() {
  const { currentPeriod: p, currentStartDate: s, currentEndDate: e } = state;

  const heatmapLabel = getEl('heatmapRangeLabel');
  if (heatmapLabel) heatmapLabel.textContent = periodLabel(p, s, e);

  const data = await fetchJSON(`/api/peak-hours?period=${p}${rangeQuery()}`);
  const box = getEl('heatmap');
  if (!box) return;
  if (!data) {
    box.innerHTML = errorStateHTML({ vars: { range: currentRangeLabel() } });
    return;
  }
  if (!data.length) {
    box.innerHTML = emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' });
    return;
  }

  const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let maxVal = 0;
  data.forEach(r => {
    const d = parseInt(r.day_of_week), h = parseInt(r.hour);
    matrix[d][h] = parseFloat(r.revenue);
    if (matrix[d][h] > maxVal) maxVal = matrix[d][h];
  });

  let html = '<div class="heatmap-header-row"><div></div>';
  for (let h = 0; h < 24; h++) html += `<div class="heatmap-hour-label">${h}h</div>`;
  html += '</div>';

  days().forEach((day, d) => {
    html += `<div class="heatmap-row"><div class="heatmap-label">${day}</div>`;
    for (let h = 0; h < 24; h++) {
      const val   = matrix[d][h];
      const ratio = maxVal > 0 ? val / maxVal : 0;
      html += `<div class="heatmap-cell" style="background:${heatColor(ratio)}" title="${day} ${h}:00 — ${fmtKHR(val)}"></div>`;
    }
    html += '</div>';
  });

  box.innerHTML = html;
}

// ─── Top Products (with growth vs last period + slow movers) ────────────────

function renderProductRows(rows, tbodyId, startRank = 1) {
  const tbody = getEl(tbodyId);
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-4 text-center text-[color:var(--text-muted)]">${t('dashboard.noDataRow')}</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map((r, i) => `
    <tr class="border-b border-[color:var(--border)] hover:bg-[color:var(--hover-tint)] transition-colors">
      <td class="py-2 pr-3 text-[color:var(--text-muted)] font-mono">${startRank + i}</td>
      <td class="py-2 pr-3">
        <div class="font-medium">${r.item_name}</div>
        <div class="text-xs text-[color:var(--text-muted)]">${r.sku || ''}</div>
      </td>
      <td class="py-2 pr-3 text-right text-[color:var(--text-secondary)]">${fmt(r.qty)}</td>
      <td class="py-2 pr-3 text-right text-amber-400 font-medium">៛${fmt(r.revenue)}</td>
      <td class="py-2 pr-3 text-right text-[color:var(--text-muted)]">${r.prev_revenue > 0 ? '៛' + fmt(r.prev_revenue) : '—'}</td>
      <td class="py-2 text-right">${growthBadge(r.growth) || '<span class="text-[color:var(--text-muted)]">—</span>'}</td>
    </tr>
  `).join('');
}

let topProductsCategory = '';

async function loadTopItems() {
  const categoryQuery = topProductsCategory ? `&category=${topProductsCategory}` : '';
  const data = await fetchJSON(`/api/item-comparison?period=${state.currentPeriod}${rangeQuery()}&order=desc&limit=20${categoryQuery}`);
  if (!data) return;
  renderProductRows(data, 'productTableBody');
}

async function loadSlowMovers() {
  const categoryQuery = topProductsCategory ? `&category=${topProductsCategory}` : '';
  const data = await fetchJSON(`/api/item-comparison?period=${state.currentPeriod}${rangeQuery()}&order=asc&limit=10${categoryQuery}`);
  if (!data) return;
  renderProductRows(data, 'slowMoversBody', 1);
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
  const data = await fetchJSON(`/api/employee-performance?period=${state.currentPeriod}${rangeQuery()}`);
  if (!data?.length) return;

  destroyChart('employeeChart');
  state.charts.employeeChart = new Chart(document.getElementById('employeeChart'), {
    type: 'bar',
    data: {
      labels: data.map(r => r.employee_id || t('dashboard.unknown')),
      datasets: [{ label: t('dashboard.table.revenue'), data: data.map(r => parseFloat(r.revenue)), backgroundColor: 'rgba(245,158,11,0.7)', borderRadius: 6 }],
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
      labels: data.map(r => r.device_name || t('dashboard.unknown')),
      datasets: [{ label: t('dashboard.table.revenue'), data: data.map(r => parseFloat(r.revenue)), backgroundColor: 'rgba(59,130,246,0.7)', borderRadius: 6 }],
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
    <span class="text-red-400 font-bold">${t('dashboard.cancelledCount', { count: data.summary.count })}</span>
    <span class="text-[color:var(--text-muted)]">${t('dashboard.cancelledLost', { amount: '<span class="text-red-300 font-bold">$' + fmt(data.summary.lost_revenue) + '</span>' })}</span>
  `;

  const cancelList = getEl('cancelList');
  if (cancelList) cancelList.innerHTML = data.items.length
    ? data.items.map(r => `
        <div class="cancel-row">
          <div>
            <div class="font-medium text-red-200">#${r.receipt_number}</div>
            <div class="text-xs text-[color:var(--text-muted)]">${fmtDatetime(r.cancelled_at)} · ${r.dining_option || '-'} · ${r.employee_id || '-'}</div>
          </div>
          <div class="text-red-400 font-bold">-$${fmt(r.total_money)}</div>
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
  loadPeakHours();
  loadTopItems();
  loadEmployeePerformance();
  loadDevicePerformance();
  loadCancelledOrders();
}

// ─── Period Controls (exposed to window) ─────────────────────────────────────

export function applyDateFilter({ period, start, end }) {
  state.currentPeriod    = period;
  state.currentStartDate = period === 'range' ? start : '';
  state.currentEndDate   = period === 'range' ? end   : '';
  loadAll();
}

export async function syncGrossIncome() {
  const btn = getEl('syncBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('dashboard.syncing'); }
  try {
    const res = await apiPost('/api/receipts/sync', {});
    const data = res.data || {};
    if (res.ok) {
      const msg = data.status === 'skipped'
        ? t('dashboard.syncSkipped')
        : t('dashboard.syncSuccess', { count: data.inserted ?? 0 });
      showSyncToast(msg, 'success');
      loadGrossIncomeTrend();
      loadLastSync();
    } else {
      showSyncToast(data.error || t('dashboard.syncFailed'), 'error');
    }
  } catch (err) {
    showSyncToast(t('dashboard.syncFailedConnection'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('dashboard.syncButton'); }
  }
}

function showSyncToast(message, type) {
  let toast = getEl('syncToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'syncToast';
    toast.setAttribute('role', 'status');
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:var(--shadow-lift);transition:opacity .3s;background:var(--bg-surface);color:var(--text-primary);border:1px solid var(--border)';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.borderLeft = `3px solid ${type === 'error' ? 'var(--loss)' : 'var(--gain)'}`;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, type === 'error' ? 8000 : 3500);
}

export async function loadLastSync() {
  const chip = getEl('lastSyncChip');
  if (!chip) return;
  try {
    const rows = await fetchJSON('/api/sync-logs/latest?limit=1');
    if (!rows || !rows.length) return;
    const row = rows[0];
    const icon = row.status === 'success' ? '✅' : row.status === 'skipped' ? '⏭' : '❌';
    const date = new Date(row.created_at).toLocaleString('en-US', {
      timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    const by = row.triggered_by === 'auto' ? t('dashboard.syncAuto') : t('dashboard.syncManual');
    chip.textContent = t('dashboard.lastSync', { icon, date, by });
    chip.classList.remove('hidden');
  } catch {
    // non-critical
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

export async function init() {
  const slowMoversBtn = getEl('slowMoversBtn');
  if (slowMoversBtn) slowMoversBtn.innerHTML = `<span id="slowMoversArrow">▶</span> ${t('dashboard.showSlowMovers')}`;
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [
      { key: 'yesterday', labelKey: 'common.yesterday' },
      { key: 'last10', labelKey: 'common.last10Days' },
    ],
    defaultPreset: 'yesterday',
    onChange: applyDateFilter,
  });
  loadLastSync();
  setInterval(loadAll, 5 * 60 * 1000);
}
