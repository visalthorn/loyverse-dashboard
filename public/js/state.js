export const state = {
  userPermissions:      {},
  currentUserRole:      '',
  currentPeriod:        'last10',
  currentStartDate:     '',
  currentEndDate:       '',
  expenseFilterStartDate: '',
  expenseFilterEndDate:   '',
  branchId:             null,
  expenseFilterBranchId: null,
  charts:               {},
};

// Categorical chart palette — reads the CVD-validated --chart-N theme tokens.
// Order is fixed (never cycled); theme changes trigger a full reload, so
// resolving once at module load is safe. Fallbacks mirror the dark theme.
const CHART_FALLBACKS = ['#d47d05','#5c8fe6','#2a9a7d','#7f6fe0','#e0685f','#2f9cbd','#8a9847','#c9628f'];

export const COLORS = CHART_FALLBACKS.map((fallback, i) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--chart-${i + 1}`).trim();
  return v || fallback;
});
