import { state } from '../state.js';
import { fetchJSON } from '../api.js';
import { getEl, getTodayDate, TZ } from '../utils.js';
import { t } from '../i18n.js';
import { createReportSections } from './report-sections.js';
import { createHighlights } from './report-highlights.js';

// Summary Report: reads the permanent /api/reports/* summary tables with
// explicit start/end ranges. Chart rendering lives in report-sections.js.

const rq = () => `start=${state.currentStartDate}&end=${state.currentEndDate}`;

const api = {
  summary:   () => fetchJSON(`/api/reports/summary?${rq()}`),
  trend:     () => fetchJSON(`/api/reports/trend?${rq()}`),
  dining:    () => fetchJSON(`/api/reports/dining?${rq()}`),
  payments:  () => fetchJSON(`/api/reports/payments?${rq()}`),
  peakHours: () => fetchJSON(`/api/reports/peak-hours?${rq()}`),
  topItems:  (limit, category) =>
    fetchJSON(`/api/reports/top-items?${rq()}&limit=${limit}${category ? `&category=${encodeURIComponent(category)}` : ''}`),
  revenueExpenses: () => fetchJSON(`/api/reports/revenue-expenses?${rq()}`),
};

const highlights = createHighlights();

// The monthly deck has no POS-device slide, so this page omits that section.
const SECTIONS_OPTS = {
  sections: ['kpis', 'trend', 'dining', 'payments', 'peakHours', 'topProducts', 'expenseTrend'],
  onData: (key, value) => highlights.onData(key, value),
};

const sections = createReportSections(api, SECTIONS_OPTS);

export const setTopProductsLimit    = sections.setTopProductsLimit;
export const setTopProductsCategory = sections.setTopProductsCategory;
export const loadAll                = sections.loadAll;
export const copyHighlights = () => highlights.copy();

// ─── Anchor range + block tabs ───────────────────────────────────────────────
// One anchor range {start, end} drives the page. Block tabs are 10-day slices
// of the anchor clamped to its end; Custom replaces the anchor outright.

let anchor = { start: '', end: '' };

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Most recent 9th of a month whose 30-day window ends on or before yesterday
// (the owner's reports anchor on the 9th — PROD data starts 2026-06-09).
function defaultMonthStart() {
  const today = getTodayDate();
  let candidate = today.slice(0, 8) + '09';
  while (addDays(candidate, 29) >= today) {
    const d = new Date(candidate + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() - 1);
    candidate = d.toISOString().slice(0, 10);
  }
  return candidate;
}

function blockRange(block) {
  const { start, end } = anchor;
  const clamp = d => (d > end ? end : d);
  if (block === 'b1') return { start,                     end: clamp(addDays(start, 9))  };
  if (block === 'b2') return { start: addDays(start, 10), end: clamp(addDays(start, 19)) };
  if (block === 'b3') return { start: addDays(start, 20), end: clamp(addDays(start, 29)) };
  return { start, end };
}

// Disable tabs whose slice starts past the anchor end (short custom ranges).
function updateBlockTabs() {
  document.querySelectorAll('#blockTabs .period-btn[data-block]').forEach(b => {
    b.disabled = b.dataset.block !== 'full' && blockRange(b.dataset.block).start > anchor.end;
  });
}

export function selectBlock(block) {
  const r = blockRange(block);
  if (r.start > r.end) return;
  applyDateFilter({ period: 'range', start: r.start, end: r.end });
  document.querySelectorAll('#blockTabs .period-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.block === block));
  const label = getEl('blockRangeLabel');
  if (label) label.textContent = `${r.start} → ${r.end}`;
}

export function toggleCustom() {
  const box = getEl('customRangeInputs');
  const btn = getEl('customRangeBtn');
  if (!box) return;
  const show = box.style.display === 'none';
  box.style.display = show ? '' : 'none';
  if (btn) btn.classList.toggle('active', show);
}

export function applyCustom() {
  const start = getEl('customStart')?.value || '';
  const end   = getEl('customEnd')?.value   || '';
  if (!start || !end) { alert(t('common.errorMissingDates')); return; }
  if (start > end)    { alert(t('common.errorDateOrder')); return; }
  anchor = { start, end };
  updateBlockTabs();
  selectBlock('full');
}

// ─── Period Controls ──────────────────────────────────────────────────────────

export function applyDateFilter({ period, start, end }) {
  state.currentPeriod    = period;
  state.currentStartDate = start;
  state.currentEndDate   = end;
  highlights.reset();
  sections.loadAll();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function init() {
  sections.loadTopProductsCategories();
  const start = defaultMonthStart();
  anchor = { start, end: addDays(start, 29) };
  // Bound the custom pickers to the days the summary tables actually cover.
  fetchJSON('/api/reports/coverage').then(cov => {
    if (!cov) return;
    const toKH = d => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
    ['customStart', 'customEnd'].forEach(id => {
      const inp = getEl(id);
      if (!inp) return;
      if (cov.min_day) inp.min = toKH(cov.min_day);
      if (cov.max_day) inp.max = toKH(cov.max_day);
    });
  });
  updateBlockTabs();
  selectBlock('full');
}
