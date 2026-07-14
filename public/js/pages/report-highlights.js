import { state } from '../state.js';
import { getEl, fmt, fmtKHR } from '../utils.js';
import { t } from '../i18n.js';
import { periodLabel } from '../dateFilter.js';
import { splitPct, peakHourList, formatHours } from '../report-insights.js';

// Highlights card for the Summary Report: every number the owner used to
// compute by hand for the monthly deck, derived from the same datasets the
// charts render. undefined = still loading, null = fetch failed.

const LOADING = '…';
const FAILED  = '—';

export function createHighlights() {
  const data = { summary: undefined, dining: undefined, payments: undefined, peakHours: undefined };

  const joinSplit = rows => rows.map(p => `${p.label} ${p.pct}%`).join(' ~ ');

  // Each builder returns the bullet string, or LOADING/FAILED placeholders.
  function totalsBullet() {
    const s = data.summary;
    if (s === undefined) return LOADING;
    if (!s) return FAILED;
    const gross = parseFloat(s.gross_income.value);
    const exp   = parseFloat(s.expenses.value);
    return t('summary.hl.totals', { rev: fmtKHR(gross), exp: fmtKHR(exp), net: fmtKHR(parseFloat(s.net_revenue)) });
  }

  function perDayBullet() {
    const s = data.summary;
    if (s === undefined) return LOADING;
    if (!s) return FAILED;
    const net = parseFloat(s.net_per_order?.value ?? 0);
    return t('summary.hl.perDay', {
      rev: fmtKHR(s.avg_gross_income?.value ?? 0),
      exp: fmtKHR(s.avg_expense?.value ?? 0),
      net: (net < 0 ? '-' : '') + fmtKHR(Math.abs(net)),
    });
  }

  function diningBullet() {
    if (data.dining === undefined) return LOADING;
    const parts = splitPct(data.dining, r => r.dining_option, r => parseFloat(r.revenue));
    return parts.length ? joinSplit(parts) : FAILED;
  }

  function paymentBullet() {
    if (data.payments === undefined) return LOADING;
    const parts = splitPct(data.payments, r => r.payment_name || r.payment_type, r => parseFloat(r.total));
    return parts.length ? joinSplit(parts) : FAILED;
  }

  function itemsSoldBullet() {
    const s = data.summary;
    if (s === undefined) return LOADING;
    if (!s?.items_sold) return FAILED;
    return t('summary.hl.itemsSold', { n: fmt(s.items_sold.value) });
  }

  function ratioBullet() {
    const s = data.summary;
    if (s === undefined) return LOADING;
    if (!s) return FAILED;
    const gross = parseFloat(s.gross_income.value);
    if (gross <= 0) return FAILED;
    const expPct = (parseFloat(s.expenses.value) / gross * 100).toFixed(1);
    const netPct = (parseFloat(s.net_revenue) / gross * 100).toFixed(1);
    return t('summary.hl.ratio', { exp: expPct, net: netPct });
  }

  function peakHoursBullet() {
    if (data.peakHours === undefined) return LOADING;
    const hours = peakHourList(data.peakHours);
    return hours.length ? t('summary.hl.peakHours', { hours: formatHours(hours) }) : FAILED;
  }

  function bullets() {
    return [
      totalsBullet(), perDayBullet(), diningBullet(), paymentBullet(),
      itemsSoldBullet(), ratioBullet(), peakHoursBullet(),
    ];
  }

  function render() {
    const list = getEl('highlightsList');
    if (list) list.innerHTML = bullets().map(b => `<li>${b}</li>`).join('');
    const label = getEl('highlightsRangeLabel');
    if (label) label.textContent = periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate);

    const strips = {
      bulletDining:      diningBullet(),
      bulletPayment:     paymentBullet(),
      bulletTopProducts: itemsSoldBullet(),
      bulletHeatmap:     peakHoursBullet(),
      bulletExpense:     ratioBullet(),
    };
    Object.entries(strips).forEach(([id, text]) => {
      const el = getEl(id);
      if (el) el.textContent = text === LOADING ? '' : text;
    });
  }

  function onData(key, value) {
    if (!(key in data)) return;
    data[key] = value;
    render();
  }

  function reset() {
    Object.keys(data).forEach(k => { data[k] = undefined; });
    render();
  }

  async function copy() {
    const range = periodLabel(state.currentPeriod, state.currentStartDate, state.currentEndDate);
    const text  = [range, ...bullets().map(b => '• ' + b)].join('\n');
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

  return { onData, reset, copy };
}
