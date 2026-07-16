import { t } from './i18n.js';
import { getEl } from './utils.js';

// Shared panel-state components. Every panel renders one of these instead of
// a blank card: a skeleton while loading, an empty state that says what
// happened and what to do, or an error state that says what failed.

export function emptyStateHTML({ titleKey = 'common.emptyNoData', hintKey = 'common.emptyHintWiden', icon = '🧾', vars = {} } = {}) {
  return `
    <div class="panel-state">
      <div class="panel-state-icon">${icon}</div>
      <div class="panel-state-title">${t(titleKey, vars)}</div>
      <div class="panel-state-hint">${t(hintKey, vars)}</div>
    </div>`;
}

export function errorStateHTML({ titleKey = 'common.errorPanelTitle', hintKey = 'common.errorPanelHint', vars = {} } = {}) {
  return `
    <div class="panel-state panel-state--error">
      <div class="panel-state-icon">⚠️</div>
      <div class="panel-state-title">${t(titleKey, vars)}</div>
      <div class="panel-state-hint">${t(hintKey, vars)}</div>
    </div>`;
}

// One legend renderer for every donut/pie panel: ledger rows with a color
// dot, name, mono amount, and share. rows: [{ label, amount, pct, color, meta }]
export function legendRowsHTML(rows) {
  return rows.map(r => `
    <div class="legend-row">
      <span class="legend-name"><span class="legend-dot" style="background:${r.color}"></span><span class="truncate">${r.label}</span>${r.meta ? `<span class="legend-pct">${r.meta}</span>` : ''}</span>
      <span class="legend-amount num">${r.amount} <span class="legend-pct">(${r.pct}%)</span></span>
    </div>`).join('');
}

// Chart canvases live inside a positioned .chart-container; the skeleton is
// an overlay so the canvas doesn't reflow when data lands.
export function showChartSkeleton(canvasId) {
  const canvas = getEl(canvasId);
  const box = canvas?.parentElement;
  if (!box || box.querySelector('.chart-skeleton')) return;
  const el = document.createElement('div');
  el.className = 'chart-skeleton';
  box.appendChild(el);
}

export function hideChartSkeleton(canvasId) {
  getEl(canvasId)?.parentElement?.querySelector('.chart-skeleton')?.remove();
}

// Replace a chart with a message (empty/error) — hides the canvas and mounts
// the state block beside it; restore with chartStateClear before re-drawing.
export function chartStateShow(canvasId, html) {
  const canvas = getEl(canvasId);
  const box = canvas?.parentElement;
  if (!box) return;
  hideChartSkeleton(canvasId);
  canvas.style.display = 'none';
  let mount = box.querySelector('.panel-state-mount');
  if (!mount) {
    mount = document.createElement('div');
    mount.className = 'panel-state-mount';
    mount.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;';
    box.appendChild(mount);
  }
  mount.innerHTML = html;
}

export function chartStateClear(canvasId) {
  const canvas = getEl(canvasId);
  const box = canvas?.parentElement;
  if (!box) return;
  hideChartSkeleton(canvasId);
  box.querySelector('.panel-state-mount')?.remove();
  canvas.style.display = '';
}

// ▲/▼/— delta chip for a period-over-period growth percentage. null = no
// comparison available (renders nothing).
export function growthBadge(g) {
  if (g == null) return '';
  if (g > 0) return `<span class="badge-up">▲ ${g > 100 ? '>100' : g}%</span>`;
  if (g < 0) return `<span class="badge-down">▼ ${Math.abs(g) > 100 ? '>100' : Math.abs(g)}%</span>`;
  return `<span class="badge-flat">— 0%</span>`;
}
