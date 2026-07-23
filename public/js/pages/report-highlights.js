import { state } from '../state.js';
import { fetchJSON } from '../api.js';
import { getEl, fmt, fmtKHR } from '../utils.js';
import { t, getLang } from '../i18n.js';
import { periodLabel } from '../dateFilter.js';
import { joinSplit, buildInsights, localizedCategoryLabel } from '../report-insights.js';
import { emptyStateHTML, errorStateHTML } from '../ui.js';

// Highlights card for the Summary Report: grouped money columns, ratio/mix
// splits (incl. items sold by category) rendered as hlMoneyCols-style
// colored boxes, rules-based analyst notes, and a data-quality banner — all
// from one GET /api/reports/highlights fetch. Also fills five .section-bullet
// strips elsewhere on the page (bulletTrend/bulletDining/bulletPayment/
// bulletTopProducts/bulletExpense).

// Palette order for the category boxes; "Other" always renders slate.
const CAT_PALETTE = ['teal', 'orange', 'blue', 'yellow', 'slate'];

export function createHighlights() {
  let data; // undefined = loading, null = fetch failed

  function rq() {
    return `start=${state.currentStartDate}&end=${state.currentEndDate}`;
  }

  const signedKHR = v => (v < 0 ? '-' : '') + fmtKHR(Math.abs(v));

  function colHTML(accent, labelKey, val) {
    return `<div class="hl-col hl-col--${accent}">
      <div class="hl-col-lbl">${t(labelKey)}</div>
      <div class="hl-col-val">${val}</div>
    </div>`;
  }

  // Same box style as colHTML, but for pre-translated legend labels.
  function legendColHTML(accent, label, val) {
    return `<div class="hl-col hl-col--${accent}">
      <div class="hl-col-lbl">${label}</div>
      <div class="hl-col-val">${val}</div>
    </div>`;
  }

  function renderMoney() {
    const el = getEl('hlMoneyCols');
    if (!el) return;
    const totNet = data.totals.net >= 0 ? 'net' : 'exp';
    const avgNet = data.dailyAvg.net >= 0 ? 'net' : 'exp';
    el.innerHTML = `
      <div class="hl-cols">
        ${colHTML('rev', 'summary.hl.colRevenue', fmtKHR(data.totals.revenue))}
        ${colHTML('exp', 'summary.hl.colExpenses', '-' + fmtKHR(data.totals.expenses))}
        ${colHTML(totNet, 'summary.hl.colNet', signedKHR(data.totals.net))}
      </div>
      <div class="hl-cols hl-cols--day">
        ${colHTML('rev', 'summary.hl.colRevenueDay', fmtKHR(data.dailyAvg.revenue))}
        ${colHTML('exp', 'summary.hl.colExpensesDay', fmtKHR(data.dailyAvg.expenses))}
        ${colHTML(avgNet, 'summary.hl.colNetDay', signedKHR(data.dailyAvg.net))}
      </div>`;
  }

  function mixBarHTML(parts, palette) {
    const withAccent = parts.map((p, i) => ({ ...p, accent: palette[Math.min(i, palette.length - 1)] }));
    const boxes = withAccent.filter(p => p.pct > 0)
      .map(p => legendColHTML(p.accent, p.label, `${fmtKHR(p.revenue)} (${p.pct}%)`));
    return `<div class="hl-mix-block"><div class="hl-cols">${boxes.join('')}</div></div>`;
  }

  function renderMixBars() {
    const el = getEl('hlMixBars');
    if (!el) return;
    const bars = [];
    if (data.channelSplit.length) bars.push(mixBarHTML(data.channelSplit, ['blue', 'slate', 'yellow']));
    if (data.paymentSplit.length) bars.push(mixBarHTML(data.paymentSplit, ['teal', 'slate', 'yellow']));
    el.innerHTML = bars.length ? `<div class="hl-bar-row">${bars.join('')}</div>` : '';
  }

  // {label, units, pct} → {accent, lbl, units, pct} with localized labels.
  function categoryParts() {
    const lang = getLang();
    return data.categorySplit.map((c, i) => ({
      accent: c.label === 'Other' ? 'slate' : CAT_PALETTE[i % CAT_PALETTE.length],
      lbl:    c.label === 'Other' ? t('common.other') : localizedCategoryLabel(c.label, lang),
      units:  c.units,
      pct:    c.pct,
    }));
  }

  function renderItemsCategory() {
    const el = getEl('hlItemsCategory');
    if (!el) return;
    const title = `<div class="hl-items-title">${t('summary.hl.itemsByCategory', { n: `<b>${fmt(data.totals.itemsSold)}</b>` })}</div>`;
    if (!data.categorySplit.length) {
      el.innerHTML = data.totals.itemsSold > 0 ? title : '';
      return;
    }
    const parts = categoryParts();
    const boxes = parts.filter(p => p.pct > 0)
      .map(p => legendColHTML(p.accent, p.lbl, `${fmt(p.units)} (${p.pct}%)`));
    el.innerHTML = title + `<div class="hl-cols hl-cols--wrap">${boxes.join('')}</div>`;
  }

  function renderNotes() {
    const el = getEl('hlNotes');
    if (!el) return;
    el.innerHTML = buildInsights(data).map(i => `<li>${t(i.key, i.vars)}</li>`).join('');
  }

  function renderDataQuality() {
    const el = getEl('highlightsDataQuality');
    if (!el) return;
    if (data.dataQuality.zeroExpenseDays > 0) {
      el.style.display = '';
      el.innerHTML = `<span>⚠️</span><span>${t('summary.hl.dataQualityNotice', {
        n: data.dataQuality.zeroExpenseDays, m: data.dataQuality.totalDays,
      })}</span>`;
    } else {
      el.style.display = 'none';
    }
  }

  // The five mini-bullet strips embedded under the other Summary Report sections.
  function renderSectionStrips() {
    const strips = {
      bulletTrend: t('summary.hl.perDay', {
        rev: fmtKHR(data.dailyAvg.revenue), exp: fmtKHR(data.dailyAvg.expenses),
        net: signedKHR(data.dailyAvg.net),
      }),
      bulletDining:      data.channelSplit.length ? joinSplit(data.channelSplit) : '',
      bulletPayment:     data.paymentSplit.length ? joinSplit(data.paymentSplit) : '',
      bulletTopProducts: t('summary.hl.itemsSold', { n: fmt(data.totals.itemsSold) }),
      bulletExpense:     t('summary.hl.ratio', { exp: data.expenseRatioPct, net: data.netMarginPct }),
    };
    Object.entries(strips).forEach(([id, text]) => { const e = getEl(id); if (e) e.textContent = text; });
  }

  function showState(html) {
    const stateEl = getEl('hlState');
    const body = getEl('hlBody');
    if (stateEl) { stateEl.innerHTML = html; stateEl.style.display = html ? '' : 'none'; }
    if (body) body.style.display = html ? 'none' : '';
  }

  function render() {
    const label = getEl('highlightsRangeLabel');
    if (label) label.textContent = periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate);

    if (data === undefined) return; // loading — leave previous content
    if (!data) {
      showState(errorStateHTML({ vars: { range: periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate) } }));
      return;
    }
    if (data.totals.revenue === 0 && data.totals.orders === 0) {
      showState(emptyStateHTML({ titleKey: 'common.emptyNoSales', hintKey: 'common.emptyHintSync' }));
      const dq = getEl('highlightsDataQuality');
      if (dq) dq.style.display = 'none';
      renderSectionStrips();
      return;
    }

    showState('');
    renderMoney();
    renderMixBars();
    renderItemsCategory();
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
      t('summary.hl.totals', { rev: fmtKHR(data.totals.revenue), exp: fmtKHR(data.totals.expenses), net: fmtKHR(data.totals.net) }),
      t('summary.hl.perDay', { rev: fmtKHR(data.dailyAvg.revenue), exp: fmtKHR(data.dailyAvg.expenses), net: fmtKHR(data.dailyAvg.net) }),
      t('summary.hl.ratio', { exp: data.expenseRatioPct, net: data.netMarginPct }),
    ];
    if (data.channelSplit.length) lines.push(joinSplit(data.channelSplit));
    if (data.paymentSplit.length) lines.push(joinSplit(data.paymentSplit));
    if (data.categorySplit.length) {
      const parts = categoryParts();
      lines.push(`${t('summary.hl.itemsSold', { n: fmt(data.totals.itemsSold) })} — ${parts.map(p => `${p.lbl} ${p.pct}%`).join(' · ')}`);
    } else {
      lines.push(t('summary.hl.itemsSold', { n: fmt(data.totals.itemsSold) }));
    }
    buildInsights(data).forEach(i => lines.push(t(i.key, i.vars)));

    const text = [range, ...lines.map(l => '• ' + l)].join('\n');
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
