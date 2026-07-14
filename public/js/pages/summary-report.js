import { state } from '../state.js';
import { fetchJSON } from '../api.js';
import { getEl, getTodayDate, TZ } from '../utils.js';
import { renderDateFilter } from '../dateFilter.js';
import { createReportSections } from './report-sections.js';

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

// The monthly deck has no POS-device slide, so this page omits that section.
const SECTIONS_OPTS = {
  sections: ['kpis', 'trend', 'dining', 'payments', 'peakHours', 'topProducts', 'expenseTrend'],
};

const sections = createReportSections(api, SECTIONS_OPTS);

export const setTopProductsLimit    = sections.setTopProductsLimit;
export const setTopProductsCategory = sections.setTopProductsCategory;
export const loadAll                = sections.loadAll;

// ─── Month view: start date + three 10-day blocks ────────────────────────────

let monthStart = '';

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
  if (block === 'b1') return { start: monthStart,              end: addDays(monthStart, 9) };
  if (block === 'b2') return { start: addDays(monthStart, 10), end: addDays(monthStart, 19) };
  if (block === 'b3') return { start: addDays(monthStart, 20), end: addDays(monthStart, 29) };
  return { start: monthStart, end: addDays(monthStart, 29) };
}

export function setMonthStart(value) {
  if (!value) return;
  monthStart = value;
  const active = document.querySelector('#blockTabs .period-btn.active');
  if (active) selectBlock(active.dataset.block);
}

export function selectBlock(block) {
  const r = blockRange(block);
  applyDateFilter({ period: 'range', start: r.start, end: r.end });
  document.querySelectorAll('#blockTabs .period-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.block === block));
  const label = getEl('blockRangeLabel');
  if (label) label.textContent = `${r.start} → ${r.end}`;
}

// ─── Period Controls ──────────────────────────────────────────────────────────

export function applyDateFilter({ period, start, end }) {
  // Any date-filter pick deactivates the block tabs; selectBlock re-activates
  // its own tab (and sets the label) right after calling this.
  document.querySelectorAll('#blockTabs .period-btn').forEach(b => b.classList.remove('active'));
  const label = getEl('blockRangeLabel');
  if (label) label.textContent = '';
  state.currentPeriod    = period;
  state.currentStartDate = start;
  state.currentEndDate   = end;
  sections.loadAll();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function init() {
  sections.loadTopProductsCategories();
  monthStart = defaultMonthStart();
  const monthInput = getEl('monthStartInput');
  if (monthInput) {
    monthInput.value = monthStart;
    // Bound the picker to the days the summary tables actually cover.
    fetchJSON('/api/reports/coverage').then(cov => {
      if (!cov) return;
      const toKH = d => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
      if (cov.min_day) monthInput.min = toKH(cov.min_day);
      if (cov.max_day) monthInput.max = toKH(cov.max_day);
    });
  }
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [
      { key: 'yesterday', labelKey: 'common.yesterday' },
      { key: 'last10', labelKey: 'common.last10Days' },
    ],
    defaultPreset: 'yesterday',
    onChange: applyDateFilter,
  });
}
