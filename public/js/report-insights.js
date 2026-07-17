// Pure computations behind the Summary Report highlight bullets.
// Kept dependency-free so node --test can exercise them directly.

export function splitPct(rows, getLabel, getValue, minPct = 1) {
  if (!rows?.length) return [];
  const val = r => Number(getValue(r)) || 0;
  const total = rows.reduce((sum, r) => sum + val(r), 0);
  if (total <= 0) return [];
  return rows
    .map(r => ({ label: getLabel(r), pct: Math.round(val(r) / total * 100) }))
    .filter(p => p.pct >= minPct);
}

// Formats already-computed {label, pct} splits (from /api/reports/highlights)
// into the reference bullet style: "Dine-in 86% ~ Delivery 14%".
export function joinSplit(parts) {
  return parts.map(p => `${p.label} ${p.pct}%`).join(' ~ ');
}

// Category labels are stored bilingually as "ខ្មែរ | English". Pick the side
// matching the active language; labels without a separator pass through.
export function localizedCategoryLabel(label, lang) {
  const parts = String(label).split('|').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return String(label).trim();
  return lang === 'km' ? parts[0] : parts[parts.length - 1];
}

// Thresholds for the auto-generated analyst notes. One object so every rule's
// sensitivity is tunable from a single place.
export const INSIGHT_RULES = {
  marginDeltaPct:       1,   // min |margin percentage-point change| to call out
  revenueDeltaPct:      5,   // min |revenue % change| to call out
  channelLeadPct:       60,  // min % share for a channel to be called "dominant"
};

// Pure: takes the /api/reports/highlights payload shape and returns up to 5
// {key, vars} entries. Callers render with t(key, vars); no i18n dependency
// here so this stays testable with plain node --test.
export function buildInsights(data, rules = INSIGHT_RULES) {
  const insights = [];
  const hasComparison = data.comparison?.totals?.revenue > 0;

  if (hasComparison) {
    const marginDelta = data.netMarginPct - data.comparison.netMarginPct;
    if (Math.abs(marginDelta) >= rules.marginDeltaPct) {
      insights.push({
        key: marginDelta < 0 ? 'summary.hl.insight.marginDrop' : 'summary.hl.insight.marginRise',
        vars: { prev: data.comparison.netMarginPct, curr: data.netMarginPct },
      });
    }
    const revenueDelta = data.comparison.deltas.revenuePct;
    if (Math.abs(revenueDelta) >= rules.revenueDeltaPct) {
      insights.push({
        key: revenueDelta > 0 ? 'summary.hl.insight.revenueGrowth' : 'summary.hl.insight.revenueDecline',
        vars: { pct: Math.abs(revenueDelta) },
      });
    }
  } else {
    insights.push({ key: 'summary.hl.insight.noPeriodOverPeriod', vars: {} });
  }

  if (data.dataQuality.zeroExpenseDays > 0) {
    insights.push({
      key: 'summary.hl.insight.expenseGap',
      vars: { n: data.dataQuality.zeroExpenseDays, m: data.dataQuality.totalDays },
    });
  }

  if (data.channelSplit.length && data.channelSplit[0].pct >= rules.channelLeadPct) {
    insights.push({
      key: 'summary.hl.insight.channelLead',
      vars: { label: data.channelSplit[0].label, pct: data.channelSplit[0].pct },
    });
  }

  return insights.slice(0, 5);
}
