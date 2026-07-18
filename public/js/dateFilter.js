import { t } from './i18n.js';
import { getTodayDate, TZ } from './utils.js';
import { showToast } from './toast.js';

// Date N days ago as YYYY-MM-DD in Cambodia time — never the browser's zone.
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toLocaleDateString('en-CA', { timeZone: TZ });
}

function resolveDates(key) {
  const end = getTodayDate();
  if (key === 'last10') return { start: daysAgo(10), end };
  if (key === 'yesterday') {
    const yesterday = daysAgo(1);
    return { start: yesterday, end: yesterday };
  }
  return { start: end, end };
}

export function periodLabel(period, start, end) {
  if (period === 'range') return `${start} → ${end}`;
  if (period === 'last10') return `${t('common.last10Days')} (${start} → ${end})`;
  if (period === 'yesterday') return t('common.yesterday');
  return t('common.today');
}

export function renderDateFilter(mountEl, { presets, defaultPreset, onChange }) {
  if (!mountEl) return;

  // The custom range currently applied to the page (null when a preset is active).
  // Keeps the from/to inputs filled across re-renders and drives the "Showing" chip.
  let applied = null;

  function render(activeKey, showCustom) {
    const chip = applied ? `
        <span class="date-filter-chip inline-flex items-center gap-1.5 rounded-full bg-[color:var(--accent-soft)] text-[color:var(--accent)] text-xs font-medium pl-2.5 pr-1 py-1">
          <span aria-hidden="true">●</span>
          <span>${t('common.showing')}: ${applied.start} → ${applied.end}</span>
          <button type="button" class="date-filter-clear rounded-full w-5 h-5 leading-none hover:bg-[color:var(--hover-tint)]" aria-label="${t('common.clearDateFilter')}">✕</button>
        </span>` : '';

    mountEl.innerHTML = `
      <div class="flex flex-wrap items-center gap-2">
        <div class="period-selector flex gap-1 bg-[color:var(--bg-surface-alt)] rounded-lg p-1">
          ${presets.map(p => `<button type="button" class="period-btn${p.key === activeKey ? ' active' : ''}" data-key="${p.key}">${t(p.labelKey)}</button>`).join('')}
          <button type="button" class="period-btn${activeKey === 'range' ? ' active' : ''}" data-key="range">${t('common.custom')}</button>
        </div>
        <div class="date-filter-custom flex flex-wrap items-center gap-2"${showCustom ? '' : ' style="display:none"'}>
          <label class="text-xs text-[color:var(--text-secondary)]"><span>${t('common.from')}</span> <input type="date" class="date-filter-start rounded bg-[color:var(--bg-surface)] border border-[color:var(--border)] text-[color:var(--text-primary)] text-xs p-1" value="${applied ? applied.start : ''}"></label>
          <label class="text-xs text-[color:var(--text-secondary)]"><span>${t('common.to')}</span> <input type="date" class="date-filter-end rounded bg-[color:var(--bg-surface)] border border-[color:var(--border)] text-[color:var(--text-primary)] text-xs p-1" value="${applied ? applied.end : ''}"></label>
          <button type="button" class="date-filter-apply btn-accent">${t('common.apply')}</button>
        </div>${chip}
      </div>`;

    mountEl.querySelectorAll('.period-selector .period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (key === 'range') { render(activeKey, true); return; }
        applied = null;
        render(key, false);
        onChange({ period: key, ...resolveDates(key) });
      });
    });

    mountEl.querySelector('.date-filter-apply')?.addEventListener('click', () => {
      const start = mountEl.querySelector('.date-filter-start')?.value || '';
      const end   = mountEl.querySelector('.date-filter-end')?.value   || '';
      if (!start || !end) { showToast(t('common.errorMissingDates'), 'error'); return; }
      if (start > end)    { showToast(t('common.errorDateOrder'), 'error'); return; }
      applied = { start, end };
      render('range', true);
      onChange({ period: 'range', start, end });
    });

    mountEl.querySelector('.date-filter-clear')?.addEventListener('click', () => {
      applied = null;
      render(defaultPreset, false);
      onChange({ period: defaultPreset, ...resolveDates(defaultPreset) });
    });
  }

  render(defaultPreset, false);
  onChange({ period: defaultPreset, ...resolveDates(defaultPreset) });
}
