import { t } from './i18n.js';
import { getTodayDate, TZ } from './utils.js';

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
  if (period === 'last10') return t('common.last10Days');
  if (period === 'yesterday') return t('common.yesterday');
  return t('common.today');
}

export function renderDateFilter(mountEl, { presets, defaultPreset, onChange }) {
  if (!mountEl) return;

  function render(activeKey, showCustom) {
    mountEl.innerHTML = `
      <div class="flex flex-wrap items-center gap-2">
        <div class="period-selector flex gap-1 bg-[color:var(--bg-surface-alt)] rounded-lg p-1">
          ${presets.map(p => `<button type="button" class="period-btn${p.key === activeKey ? ' active' : ''}" data-key="${p.key}">${t(p.labelKey)}</button>`).join('')}
          <button type="button" class="period-btn${activeKey === 'range' ? ' active' : ''}" data-key="range">${t('common.custom')}</button>
        </div>
        <div class="date-filter-custom flex flex-wrap items-center gap-2"${showCustom ? '' : ' style="display:none"'}>
          <label class="text-xs text-[color:var(--text-secondary)]"><span>${t('common.from')}</span> <input type="date" class="date-filter-start rounded bg-[color:var(--bg-surface)] border border-[color:var(--border)] text-[color:var(--text-primary)] text-xs p-1"></label>
          <label class="text-xs text-[color:var(--text-secondary)]"><span>${t('common.to')}</span> <input type="date" class="date-filter-end rounded bg-[color:var(--bg-surface)] border border-[color:var(--border)] text-[color:var(--text-primary)] text-xs p-1"></label>
          <button type="button" class="date-filter-apply btn-accent">${t('common.apply')}</button>
        </div>
      </div>`;

    mountEl.querySelectorAll('.period-selector .period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (key === 'range') { render(activeKey, true); return; }
        render(key, false);
        onChange({ period: key, ...resolveDates(key) });
      });
    });

    mountEl.querySelector('.date-filter-apply')?.addEventListener('click', () => {
      const start = mountEl.querySelector('.date-filter-start')?.value || '';
      const end   = mountEl.querySelector('.date-filter-end')?.value   || '';
      if (!start || !end) { alert(t('common.errorMissingDates')); return; }
      if (start > end)    { alert(t('common.errorDateOrder')); return; }
      render('range', true);
      onChange({ period: 'range', start, end });
    });
  }

  render(defaultPreset, false);
  onChange({ period: defaultPreset, ...resolveDates(defaultPreset) });
}
