import { fetchJSON } from './api.js';
import { t } from './i18n.js';
import { state } from './state.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// Compact branch <select>: "All branches" + one option per branch.
// Renders nothing if the options fetch fails (page behaves as before).
export async function renderBranchFilter(mountEl, { onChange }) {
  if (!mountEl) return;
  const options = await fetchJSON('/api/branches/options');
  if (!options?.length) { mountEl.innerHTML = ''; return; }

  const sel = document.createElement('select');
  sel.className = 'field-select';
  sel.style.fontSize = '.75rem';
  sel.style.padding = '6px 26px 6px 9px';
  sel.setAttribute('aria-label', t('common.allBranches'));
  sel.innerHTML = `<option value="">${t('common.allBranches')}</option>` +
    options.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  sel.value = state.branchId ?? '';
  sel.addEventListener('change', () => {
    state.branchId = sel.value ? Number(sel.value) : null;
    onChange(state.branchId);
  });

  mountEl.innerHTML = '';
  mountEl.appendChild(sel);
}
