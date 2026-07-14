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
