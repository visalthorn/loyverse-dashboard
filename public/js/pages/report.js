import { state } from '../state.js';
import { fetchJSON } from '../api.js';
import { getEl } from '../utils.js';
import { renderDateFilter } from '../dateFilter.js';
import { createReportSections } from './report-sections.js';

// Live Sales & Marketing Report: reads the live /api/* analytics endpoints
// with period-preset queries. Chart rendering lives in report-sections.js.

function q() {
  const range = state.currentPeriod === 'range' && state.currentStartDate && state.currentEndDate
    ? `&start=${state.currentStartDate}&end=${state.currentEndDate}`
    : '';
  return `period=${state.currentPeriod}${range}`;
}

const api = {
  summary:   () => fetchJSON(`/api/kpis?${q()}`),
  trend:     () => fetchJSON(`/api/gross-income?${q()}`),
  dining:    () => fetchJSON(`/api/dining-options?${q()}`),
  payments:  () => fetchJSON(`/api/payment-methods?${q()}`),
  peakHours: () => fetchJSON(`/api/peak-hours?${q()}`),
  topItems:  (limit, category) =>
    fetchJSON(`/api/item-comparison?${q()}&order=desc&limit=${limit}${category ? `&category=${encodeURIComponent(category)}` : ''}`),
  device:    () => fetchJSON(`/api/device-performance?${q()}`),
  // The live API has no merged endpoint; join expenses and income client-side.
  revenueExpenses: async () => {
    const [expData, incData] = await Promise.all([
      fetchJSON(`/api/expenses-trend?${q()}`),
      fetchJSON(`/api/gross-income?${q()}`),
    ]);
    if (!expData) return null;
    const toKey = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Phnom_Penh' });
    const incomeMap = {};
    if (incData?.length) incData.forEach(r => { incomeMap[toKey(r.period)] = parseFloat(r.gross_income); });
    return expData.map(r => ({ ...r, gross_income: incomeMap[toKey(r.period)] || 0 }));
  },
};

const sections = createReportSections(api);

export const setTopProductsLimit    = sections.setTopProductsLimit;
export const setTopProductsCategory = sections.setTopProductsCategory;
export const loadAll                = sections.loadAll;

export function applyDateFilter({ period, start, end }) {
  state.currentPeriod    = period;
  state.currentStartDate = period === 'range' ? start : '';
  state.currentEndDate   = period === 'range' ? end   : '';
  sections.loadAll();
}

export function init() {
  sections.loadTopProductsCategories();
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [
      { key: 'yesterday', labelKey: 'common.yesterday' },
      { key: 'last10', labelKey: 'common.last10Days' },
    ],
    defaultPreset: 'yesterday',
    onChange: applyDateFilter,
  });
}
