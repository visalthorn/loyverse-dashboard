import { state, COLORS, DAYS } from './state.js';
import { fmt } from './utils.js';

export { COLORS, DAYS };

export function heatColor(ratio) {
  if (ratio === 0) return '#1e293b';
  const r = Math.round(30  + ratio * (245 - 30));
  const g = Math.round(41  + ratio * (158 - 41));
  const b = Math.round(59  + ratio * (11  - 59));
  return `rgb(${r},${g},${b})`;
}

export function destroyChart(id) {
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
}

export function chartOpts(prefix = '') {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: '#1e293b' }, ticks: { color: '#64748b', font: { size: 11 } } },
      y: { grid: { color: '#334155' }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => prefix + fmt(v) } },
    },
  };
}

export function barOpts(prefix = '') {
  return { ...chartOpts(prefix), plugins: { legend: { display: false } }, indexAxis: 'y' };
}

export function donutOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '65%',
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: c => ` ៛${fmt(c.raw)} (${((c.raw / c.chart.getDatasetMeta(0).total) * 100).toFixed(1)}%)`,
        },
      },
    },
  };
}
