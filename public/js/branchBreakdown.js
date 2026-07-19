import { fetchJSON } from './api.js';
import { t } from './i18n.js';
import { state } from './state.js';
import { fmtKHR } from './utils.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Revenue-by-branch card body. Deliberately ignores state.branchId — this IS
// the per-branch breakdown, always showing every branch for the period.
export async function loadBranchBreakdown(mountId) {
  const el = document.getElementById(mountId);
  if (!el) return;

  const range = state.currentPeriod === 'range' && state.currentStartDate && state.currentEndDate
    ? `&start=${state.currentStartDate}&end=${state.currentEndDate}` : '';
  const data = await fetchJSON(`/api/branch-breakdown?period=${state.currentPeriod}${range}`);

  if (!data) { el.innerHTML = `<p class="text-sm text-[color:var(--text-muted)]">${t('branches.cardLoadFailed')}</p>`; return; }
  if (!data.length) { el.innerHTML = `<p class="text-sm text-[color:var(--text-muted)]">${t('branches.cardEmpty')}</p>`; return; }

  const total = data.reduce((s, r) => s + parseFloat(r.revenue), 0);
  el.innerHTML = data.map(r => {
    const pct  = total > 0 ? (parseFloat(r.revenue) / total) * 100 : 0;
    const name = r.branch_name ?? t('branches.unassigned');
    return `
      <div class="space-y-1">
        <div class="flex items-center justify-between gap-3 text-sm">
          <span class="font-medium truncate">${esc(name)}</span>
          <span class="num font-bold whitespace-nowrap">${fmtKHR(r.revenue)}
            <span class="text-xs text-[color:var(--text-muted)] font-normal">· ${t('branches.cardOrders', { count: r.orders })}</span>
          </span>
        </div>
        <div class="h-1.5 rounded-full bg-[color:var(--bg-surface-alt)] overflow-hidden">
          <div class="h-full rounded-full" style="width:${pct.toFixed(1)}%;background:var(--accent)"></div>
        </div>
      </div>`;
  }).join('');
}
