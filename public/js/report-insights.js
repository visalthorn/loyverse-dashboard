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

export function peakHourList(rows, threshold = 0.5) {
  if (!rows?.length) return [];
  const byHour = new Array(24).fill(0);
  rows.forEach(r => { byHour[parseInt(r.hour)] += parseFloat(r.revenue); });
  const max = Math.max(...byHour);
  if (max <= 0) return [];
  return byHour
    .map((revenue, hour) => ({ revenue, hour }))
    .filter(x => x.revenue >= max * threshold)
    .map(x => x.hour);
}

export function formatHours(hours) {
  if (!hours.length) return '';
  const groups = [];
  hours.forEach(h => {
    const suffix = h < 12 ? 'AM' : 'PM';
    const last = groups[groups.length - 1];
    if (last && last.suffix === suffix) last.hours.push(h);
    else groups.push({ suffix, hours: [h] });
  });
  return groups
    .map(g => g.hours.map(h => (h % 12) || 12).join('-') + ' ' + g.suffix)
    .join(' · ');
}

// Formats already-computed {label, pct} splits (from /api/reports/highlights)
// into the reference bullet style: "Dine-in 86% ~ Delivery 14%".
export function joinSplit(parts) {
  return parts.map(p => `${p.label} ${p.pct}%`).join(' ~ ');
}

// Thresholds for the auto-generated analyst notes. One object so every rule's
// sensitivity is tunable from a single place.
export const INSIGHT_RULES = {
  marginDeltaPct:       1,   // min |margin percentage-point change| to call out
  revenueDeltaPct:      5,   // min |revenue % change| to call out
  peakConcentrationPct: 40,  // min % of revenue inside peak hours to call out
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

  const hours = peakHourList(data.hourly);
  if (hours.length && data.totals.revenue > 0) {
    const peakRevenue = hours.reduce((s, h) => s + (data.hourly[h]?.revenue || 0), 0);
    const peakPct = Math.round((peakRevenue / data.totals.revenue) * 1000) / 10;
    if (peakPct >= rules.peakConcentrationPct) {
      insights.push({
        key: 'summary.hl.insight.peakConcentration',
        vars: { pct: peakPct, hours: formatHours(hours) },
      });
    }
  }

  return insights.slice(0, 5);
}
