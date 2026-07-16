import { state } from '../state.js';
import { fetchJSON } from '../api.js';
import { getEl, fmt, fmtKHR } from '../utils.js';
import { t } from '../i18n.js';
import { periodLabel } from '../dateFilter.js';
import { joinSplit, peakHourList, formatHours, buildInsights } from '../report-insights.js';
import { growthBadge, emptyStateHTML, errorStateHTML } from '../ui.js';
import { destroyChart, chartOpts, themeColor, withAlpha } from '../charts.js';

// Highlights card for the Summary Report: KPI tiles, margin bar, detail
// chips, peak-hour chart, and rules-based analyst notes, all from one
// GET /api/reports/highlights fetch. Also fills six .section-bullet strips
// elsewhere on the page (bulletTrend/bulletDining/bulletPayment/
// bulletTopProducts/bulletHeatmap/bulletExpense) that used to be populated
// by this module's old per-endpoint onData wiring.

export function createHighlights() {
  let data; // undefined = loading, null = fetch failed

  function rq() {
    return `start=${state.currentStartDate}&end=${state.currentEndDate}`;
  }

  function kpiTileHTML({ accent, icon, label, val, valClass, growth, sub }) {
    return `
      <div class="kpi-primary kpi-primary--${accent}">
        <div class="flex items-start justify-between gap-2">
          <div class="kpi-icon kpi-icon--${accent}">${icon}</div>
          ${growthBadge(growth)}
        </div>
        <div class="kpi-primary-val ${valClass}">${val}</div>
        <div class="kpi-primary-lbl">${label}</div>
        <div class="kpi-primary-sub">${sub}</div>
      </div>`;
  }

  function renderKpis() {
    const el = getEl('highlightsKpis');
    if (!el) return;
    const netPositive = data.totals.net >= 0;
    el.innerHTML = [
      kpiTileHTML({
        accent: 'amber', icon: '💰', label: t('report.kpi.totalRevenue'),
        val: fmtKHR(data.totals.revenue), valClass: 'val-accent',
        growth: data.comparison.deltas.revenuePct,
        sub: t('summary.hl.dailyAvgLabel', { amount: fmtKHR(data.dailyAvg.revenue) }),
      }),
      kpiTileHTML({
        accent: 'red', icon: '💸', label: t('dashboard.kpi.expenses'),
        val: '-' + fmtKHR(data.totals.expenses), valClass: 'val-loss',
        growth: data.comparison.deltas.expensesPct,
        sub: t('summary.hl.dailyAvgLabel', { amount: fmtKHR(data.dailyAvg.expenses) }),
      }),
      kpiTileHTML({
        accent: netPositive ? 'emerald' : 'red', icon: netPositive ? '📈' : '📉',
        label: t('dashboard.kpi.netProfit'),
        val: (netPositive ? '' : '-') + fmtKHR(Math.abs(data.totals.net)),
        valClass: netPositive ? 'val-gain' : 'val-loss',
        growth: data.comparison.deltas.netPct,
        sub: t('summary.hl.dailyAvgLabel', { amount: fmtKHR(data.dailyAvg.net) }),
      }),
    ].join('');
  }

  function renderMarginBar() {
    const el = getEl('highlightsMarginBar');
    if (!el) return;
    if (data.totals.revenue <= 0) {
      el.innerHTML = `<div class="hl-margin-bar"><div class="hl-margin-bar-empty">${t('summary.hl.marginBarEmpty')}</div></div>`;
      return;
    }
    el.innerHTML = `
      <div class="hl-margin-bar">
        <div class="hl-margin-bar-seg hl-margin-bar-seg--expense" style="width:${data.expenseRatioPct}%">${data.expenseRatioPct >= 12 ? t('summary.hl.marginBarExpense', { pct: data.expenseRatioPct }) : ''}</div>
        <div class="hl-margin-bar-seg hl-margin-bar-seg--net" style="width:${data.netMarginPct}%">${data.netMarginPct >= 12 ? t('summary.hl.marginBarNet', { pct: data.netMarginPct }) : ''}</div>
      </div>`;
  }

  function renderChips() {
    const el = getEl('highlightsChips');
    if (!el) return;
    const chips = [];
    if (data.channelSplit.length) chips.push(joinSplit(data.channelSplit));
    if (data.paymentSplit.length) chips.push(joinSplit(data.paymentSplit));
    chips.push(t('summary.hl.itemsSold', { n: fmt(data.totals.itemsSold) }));
    const hours = peakHourList(data.hourly);
    if (hours.length) chips.push(t('summary.hl.peakHours', { hours: formatHours(hours) }));
    el.innerHTML = chips.map(c => `<span class="hl-chip">${c}</span>`).join('');
  }

  function renderChart() {
    destroyChart('highlightsHourChart');
    const canvas = getEl('highlightsHourChart');
    if (!canvas) return;
    const evening = h => h >= 18 && h <= 22;
    state.charts.highlightsHourChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: data.hourly.map(h => `${h.hour}h`),
        datasets: [{
          data: data.hourly.map(h => h.revenue),
          backgroundColor: data.hourly.map(h => evening(h.hour) ? themeColor('--accent', '#f59e0b') : withAlpha('--chart-2', 0.5)),
          borderRadius: 3,
        }],
      },
      options: chartOpts(),
    });
  }

  function renderInsights() {
    const el = getEl('highlightsInsights');
    if (!el) return;
    const insights = buildInsights(data);
    el.innerHTML = insights.map(i => `<li>${t(i.key, i.vars)}</li>`).join('');
  }

  function renderDataQuality() {
    const el = getEl('highlightsDataQuality');
    if (!el) return;
    if (data.dataQuality.zeroExpenseDays > 0) {
      el.style.display = '';
      el.textContent = t('summary.hl.dataQualityNotice', {
        n: data.dataQuality.zeroExpenseDays, m: data.dataQuality.totalDays,
      });
    } else {
      el.style.display = 'none';
    }
  }

  // The six mini-bullet strips embedded under the other Summary Report
  // sections — previously fed by this module's onData(key, value) callback.
  function renderSectionStrips() {
    const hours = peakHourList(data.hourly);
    const strips = {
      bulletTrend: t('summary.hl.perDay', {
        rev: fmtKHR(data.dailyAvg.revenue), exp: fmtKHR(data.dailyAvg.expenses),
        net: (data.dailyAvg.net < 0 ? '-' : '') + fmtKHR(Math.abs(data.dailyAvg.net)),
      }),
      bulletDining:      data.channelSplit.length ? joinSplit(data.channelSplit) : '',
      bulletPayment:     data.paymentSplit.length ? joinSplit(data.paymentSplit) : '',
      bulletTopProducts: t('summary.hl.itemsSold', { n: fmt(data.totals.itemsSold) }),
      bulletHeatmap:     hours.length ? t('summary.hl.peakHours', { hours: formatHours(hours) }) : '',
      bulletExpense:     t('summary.hl.ratio', { exp: data.expenseRatioPct, net: data.netMarginPct }),
    };
    Object.entries(strips).forEach(([id, text]) => { const e = getEl(id); if (e) e.textContent = text; });
  }

  function render() {
    const label = getEl('highlightsRangeLabel');
    if (label) label.textContent = periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate);

    if (data === undefined) return; // loading — leave skeleton/previous content
    if (!data) {
      const html = errorStateHTML({ vars: { range: periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate) } });
      const kpis = getEl('highlightsKpis'); if (kpis) kpis.innerHTML = `<div class="col-span-full">${html}</div>`;
      return;
    }
    if (data.totals.revenue === 0 && data.totals.orders === 0) {
      const html = emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' });
      const kpis = getEl('highlightsKpis'); if (kpis) kpis.innerHTML = `<div class="col-span-full">${html}</div>`;
      getEl('highlightsMarginBar')?.replaceChildren();
      getEl('highlightsChips')?.replaceChildren();
      getEl('highlightsInsights')?.replaceChildren();
      getEl('highlightsDataQuality') && (getEl('highlightsDataQuality').style.display = 'none');
      destroyChart('highlightsHourChart');
      renderSectionStrips();
      return;
    }

    renderKpis();
    renderMarginBar();
    renderChips();
    renderChart();
    renderInsights();
    renderDataQuality();
    renderSectionStrips();
  }

  async function load() {
    data = undefined;
    render();
    data = await fetchJSON(`/api/reports/highlights?${rq()}`);
    render();
  }

  async function copy() {
    if (!data) return;
    const range = periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate);
    const lines = [
      range,
      t('summary.hl.totals', { rev: fmtKHR(data.totals.revenue), exp: fmtKHR(data.totals.expenses), net: fmtKHR(data.totals.net) }),
      t('summary.hl.perDay', { rev: fmtKHR(data.dailyAvg.revenue), exp: fmtKHR(data.dailyAvg.expenses), net: fmtKHR(data.dailyAvg.net) }),
    ];
    if (data.channelSplit.length) lines.push(joinSplit(data.channelSplit));
    if (data.paymentSplit.length) lines.push(joinSplit(data.paymentSplit));
    lines.push(t('summary.hl.itemsSold', { n: fmt(data.totals.itemsSold) }));
    lines.push(t('summary.hl.ratio', { exp: data.expenseRatioPct, net: data.netMarginPct }));
    const hours = peakHourList(data.hourly);
    if (hours.length) lines.push(t('summary.hl.peakHours', { hours: formatHours(hours) }));

    const text = [lines[0], ...lines.slice(1).map(l => '• ' + l)].join('\n');
    const btn = getEl('copyHighlightsBtn');
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        btn.textContent = t('summary.copied');
        setTimeout(() => { btn.textContent = t('summary.copy'); }, 1500);
      }
    } catch (err) {
      console.error('clipboard write failed', err);
    }
  }

  return { load, copy };
}
