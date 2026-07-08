import { state, COLORS } from './state.js';
import { fmt, fmtKHR } from './utils.js';

export { COLORS };

function themeVar(varName, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

// Back-compat alias — page modules import this name.
export const themeColor = themeVar;

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}

export function heatColor(ratio) {
  const empty = themeVar('--heatmap-empty', '#1d2940');
  if (ratio === 0) return empty;
  const { r: r0, g: g0, b: b0 } = hexToRgb(empty);
  const { r: r1, g: g1, b: b1 } = hexToRgb(themeVar('--accent', '#f59e0b'));
  const r = Math.round(r0 + ratio * (r1 - r0));
  const g = Math.round(g0 + ratio * (g1 - g0));
  const b = Math.round(b0 + ratio * (b1 - b0));
  return `rgb(${r},${g},${b})`;
}

export function destroyChart(id) {
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
}

// ─── Shared Chart.js theme — every chart derives from these tokens ──────────

// Global defaults: sans for chrome, theme ink. Runs once at module load
// (stylesheets are applied before module scripts execute).
if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = themeVar('--font-sans', 'sans-serif');
  Chart.defaults.color = themeVar('--text-muted', '#8a887c');
}

// Tick figures are numbers — set them in the tabular mono face.
function numTicks(extra = {}) {
  return {
    color: themeVar('--text-muted', '#8a887c'),
    font: { family: themeVar('--font-num', 'monospace'), size: 11 },
    ...extra,
  };
}

export function tooltipTheme() {
  return {
    backgroundColor: themeVar('--bg-surface-alt', '#101827'),
    borderColor: themeVar('--border', '#2b3952'),
    borderWidth: 1,
    titleColor: themeVar('--text-primary', '#eae6da'),
    bodyColor: themeVar('--text-secondary', '#a5a396'),
    bodyFont: { family: themeVar('--font-num', 'monospace'), size: 11 },
    padding: 10,
    cornerRadius: 6,
  };
}

export function chartOpts(prefix = '') {
  const gridX = themeVar('--bg-surface', '#151f33');
  const gridY = themeVar('--border', '#2b3952');
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: tooltipTheme() },
    scales: {
      x: { grid: { color: gridX }, ticks: numTicks() },
      y: { grid: { color: gridY }, ticks: numTicks({ callback: v => prefix + fmt(v) }) },
    },
  };
}

export function barOpts(prefix = '') {
  return { ...chartOpts(prefix), plugins: { legend: { display: false }, tooltip: tooltipTheme() }, indexAxis: 'y' };
}

export function donutOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '65%',
    plugins: {
      legend: { display: false },
      tooltip: {
        ...tooltipTheme(),
        callbacks: {
          label: c => ` ${fmtKHR(c.raw)} (${((c.raw / c.chart.getDatasetMeta(0).total) * 100).toFixed(1)}%)`,
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
      legend: { display: showLegend, position: 'bottom', labels: { color: themeVar('--text-secondary', '#a5a396'), boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        ...tooltipTheme(),
        callbacks: {
          label: c => ` ${c.label}: ${fmtKHR(c.raw)} (${((c.raw / c.chart.getDatasetMeta(0).total) * 100).toFixed(1)}%)`,
        },
      },
    },
  };
}
