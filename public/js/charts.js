import { state, COLORS } from './state.js';
import { fmt } from './utils.js';

export { COLORS };

function themeColor(varName, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

export function heatColor(ratio) {
  const empty = themeColor('--heatmap-empty', '#1e293b');
  if (ratio === 0) return empty;
  const { r: r0, g: g0, b: b0 } = hexToRgb(empty);
  const r = Math.round(r0 + ratio * (245 - r0));
  const g = Math.round(g0 + ratio * (158 - g0));
  const b = Math.round(b0 + ratio * (11  - b0));
  return `rgb(${r},${g},${b})`;
}

export function destroyChart(id) {
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
}

export function chartOpts(prefix = '') {
  const gridX = themeColor('--bg-surface', '#1e293b');
  const gridY = themeColor('--border', '#334155');
  const tick  = themeColor('--text-muted', '#64748b');
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: gridX }, ticks: { color: tick, font: { size: 11 } } },
      y: { grid: { color: gridY }, ticks: { color: tick, font: { size: 11 }, callback: v => prefix + fmt(v) } },
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

export function pieOpts(showLegend = true) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: showLegend, position: 'bottom', labels: { color: themeColor('--text-secondary', '#94a3b8'), boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        callbacks: {
          label: c => ` ${c.label}: ៛${fmt(c.raw)} (${((c.raw / c.chart.getDatasetMeta(0).total) * 100).toFixed(1)}%)`,
        },
      },
    },
  };
}
