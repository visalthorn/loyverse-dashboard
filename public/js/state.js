// Filter fields mirrored into sessionStorage so they survive the full-page
// reload triggered by the theme/currency/language toggles (and a plain F5) —
// without it, every switch silently resets the period/branch back to defaults.
const FILTER_KEYS = [
  'currentPeriod', 'currentStartDate', 'currentEndDate', 'branchId',
  'expenseFilterPeriod', 'expenseFilterStartDate', 'expenseFilterEndDate', 'expenseFilterBranchId',
  'inventoryFilterBranchId',
  'summaryAnchorStart', 'summaryAnchorEnd', 'summaryActiveBlock',
];
const SNAPSHOT_KEY = 'pos_filter_state';

function loadFilterSnapshot() {
  try { return JSON.parse(sessionStorage.getItem(SNAPSHOT_KEY)) || {}; }
  catch { return {}; }
}

export function clearFilterMemory() {
  sessionStorage.removeItem(SNAPSHOT_KEY);
}

const saved = loadFilterSnapshot();

const initialState = {
  userPermissions:      {},
  currentUserRole:      '',
  // null/'' (rather than a hardcoded preset) when nothing was saved, so page
  // init code can tell "restore this" apart from "nothing to restore, use
  // your own default" — see the `initial` param on renderDateFilter.
  currentPeriod:        saved.currentPeriod ?? null,
  currentStartDate:     saved.currentStartDate ?? '',
  currentEndDate:       saved.currentEndDate ?? '',
  branchId:             saved.branchId ?? null,
  expenseFilterPeriod:   saved.expenseFilterPeriod ?? null,
  expenseFilterStartDate: saved.expenseFilterStartDate ?? '',
  expenseFilterEndDate:   saved.expenseFilterEndDate ?? '',
  expenseFilterBranchId: saved.expenseFilterBranchId ?? null,
  inventoryFilterBranchId: saved.inventoryFilterBranchId ?? null,
  // Summary Report's own anchor + block-tab selection (separate from
  // currentPeriod/StartDate/EndDate, which only hold the *resolved* range).
  summaryAnchorStart:   saved.summaryAnchorStart ?? '',
  summaryAnchorEnd:     saved.summaryAnchorEnd ?? '',
  summaryActiveBlock:   saved.summaryActiveBlock ?? null,
  charts:               {},
};

export const state = new Proxy(initialState, {
  set(target, key, value) {
    target[key] = value;
    if (FILTER_KEYS.includes(key)) {
      const snapshot = loadFilterSnapshot();
      snapshot[key] = value;
      sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    }
    return true;
  },
});

// Categorical chart palette — reads the CVD-validated --chart-N theme tokens.
// Order is fixed (never cycled); theme changes trigger a full reload, so
// resolving once at module load is safe. Fallbacks mirror the dark theme.
const CHART_FALLBACKS = ['#d47d05','#5c8fe6','#2a9a7d','#7f6fe0','#e0685f','#2f9cbd','#8a9847','#c9628f'];

export const COLORS = CHART_FALLBACKS.map((fallback, i) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--chart-${i + 1}`).trim();
  return v || fallback;
});
