import { t } from './i18n.js';
import { getTodayDate } from './utils.js';

function resolveDates(key) {
  const end = getTodayDate();
  if (key === 'last10') {
    const d = new Date();
    d.setDate(d.getDate() - 10);
    return { start: d.toISOString().slice(0, 10), end };
  }
  return { start: end, end };
}

export function periodLabel(period, start, end) {
  if (period === 'range') return `${start} → ${end}`;
  if (period === 'last10') return t('common.last10Days');
  return t('common.today');
}

export function renderDateFilter(mountEl, { presets, defaultPreset, onChange }) {
  if (!mountEl) return;

  function render(activeKey, showCustom) {
    mountEl.innerHTML = `
      <div class="flex flex-wrap items-center gap-2">
        <div class="period-selector flex gap-1 bg-slate-700 rounded-lg p-1">
          ${presets.map(p => `<button type="button" class="period-btn${p.key === activeKey ? ' active' : ''}" data-key="${p.key}">${t(p.labelKey)}</button>`).join('')}
          <button type="button" class="period-btn${activeKey === 'range' ? ' active' : ''}" data-key="range">${t('common.custom')}</button>
        </div>
        <div class="date-filter-custom flex flex-wrap items-center gap-2"${showCustom ? '' : ' style="display:none"'}>
          <label class="text-xs text-slate-300"><span>${t('common.from')}</span> <input type="date" class="date-filter-start rounded bg-slate-800 border border-slate-700 text-white text-xs p-1"></label>
          <label class="text-xs text-slate-300"><span>${t('common.to')}</span> <input type="date" class="date-filter-end rounded bg-slate-800 border border-slate-700 text-white text-xs p-1"></label>
          <button type="button" class="date-filter-apply bg-amber-500 hover:bg-amber-400 text-slate-900 text-xs font-semibold uppercase tracking-wide px-3 py-2 rounded">${t('common.apply')}</button>
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
