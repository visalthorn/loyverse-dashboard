import { fetchJSON, apiPost, apiPut, apiDelete } from '../api.js';
import { getEl } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from '../toast.js';
import { showConfirm } from '../dialog.js';

let branches  = [];
let devices   = [];
let editingId = null;

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

async function loadAll() {
  const [b, d] = await Promise.all([
    fetchJSON('/api/branches'),
    fetchJSON('/api/branches/devices'),
  ]);
  branches = b || [];
  devices  = d || [];
  renderBranches();
  renderDevices();
}

function renderBranches() {
  const tbody = getEl('branchesTableBody');
  if (!tbody) return;
  if (!branches.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="py-10 text-center text-[color:var(--text-secondary)]">${t('branches.noBranches')}</td></tr>`;
    return;
  }
  tbody.innerHTML = branches.map((b, i) => `
    <tr class="border-b border-[color:var(--border-subtle)]">
      <td class="py-2.5 pr-3 text-[color:var(--text-secondary)]">${i + 1}</td>
      <td class="py-2.5 pr-3">
        <div class="font-medium">${esc(b.name)}${b.is_default ? ` <span class="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded" style="background:var(--accent-soft);color:var(--accent-strong)">${t('branches.defaultBadge')}</span>` : ''}${b.google_maps_url ? ` <a href="${esc(b.google_maps_url)}" target="_blank" rel="noopener" title="Google Maps">📍</a>` : ''}</div>
        ${b.address ? `<div class="text-xs text-[color:var(--text-muted)] truncate" style="max-width:240px">${esc(b.address)}</div>` : ''}
      </td>
      <td class="py-2.5 pr-3 text-center">${b.device_count}</td>
      <td class="py-2.5 text-center whitespace-nowrap">
        <button onclick="startEditBranch(${b.id})" class="text-xs text-[color:var(--accent-strong)] hover:underline mr-3">${t('branches.edit')}</button>
        <button onclick="confirmDeleteBranch(${b.id})" class="text-xs text-[color:var(--loss)] hover:underline">${t('branches.delete')}</button>
      </td>
    </tr>`).join('');
}

function branchOptions(selectedId) {
  const opts = branches.map(b =>
    `<option value="${b.id}"${b.id === selectedId ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  return `<option value=""${selectedId == null ? ' selected' : ''}>${t('branches.unassigned')}</option>${opts}`;
}

function renderDevices() {
  const tbody = getEl('branchDevicesBody');
  if (!tbody) return;
  if (!devices.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="py-10 text-center text-[color:var(--text-secondary)]">${t('branches.noDevices')}</td></tr>`;
    return;
  }
  tbody.innerHTML = devices.map(d => `
    <tr class="border-b border-[color:var(--border-subtle)]">
      <td class="py-2.5 pr-3 font-medium">${esc(d.name)}</td>
      <td class="py-2.5 pr-3 text-xs whitespace-nowrap">
        <span style="color:${d.activated ? 'var(--gain)' : 'var(--text-muted)'}">●</span>
        ${d.activated ? t('branches.active') : t('branches.inactive')}
      </td>
      <td class="py-2.5">
        <select class="field-input" style="max-width:220px" data-prev="${d.branch_id ?? ''}"
                onchange="changeDeviceBranch('${d.id}', this)">${branchOptions(d.branch_id)}</select>
      </td>
    </tr>`).join('');
}

export async function submitBranch(e) {
  e.preventDefault();
  const name = (getEl('branchName')?.value || '').trim();
  if (!name) { showToast(t('branches.nameRequired'), 'error'); return; }
  const address         = (getEl('branchAddress')?.value || '').trim();
  const google_maps_url = (getEl('branchMapUrl')?.value || '').trim();
  const res = editingId
    ? await apiPut(`/api/branches/${editingId}`, { name, address, google_maps_url })
    : await apiPost('/api/branches', { name, address, google_maps_url });
  if (res.ok) {
    showToast(t(editingId ? 'branches.updated' : 'branches.created'), 'success');
    cancelEditBranch();
    loadAll();
  } else if (res.status === 409) {
    showToast(t('branches.duplicate'), 'error');
  } else {
    showToast(res.data.error || t('branches.saveFailed'), 'error');
  }
}

export function startEditBranch(id) {
  const b = branches.find(x => x.id === id);
  if (!b) return;
  editingId = id;
  getEl('branchName').value = b.name;
  getEl('branchAddress').value = b.address || '';
  getEl('branchMapUrl').value  = b.google_maps_url || '';
  getEl('branchFormTitle').textContent = t('branches.editTitle');
  getEl('branchSubmitLabel').textContent = t('branches.updateBtn');
  getEl('branchFormCancelBtn').classList.remove('hidden');
  getEl('branchName').focus();
}

export function cancelEditBranch() {
  editingId = null;
  getEl('branchForm')?.reset();
  getEl('branchFormTitle').textContent = t('branches.addTitle');
  getEl('branchSubmitLabel').textContent = t('branches.createBtn');
  getEl('branchFormCancelBtn').classList.add('hidden');
}

export async function confirmDeleteBranch(id) {
  const b = branches.find(x => x.id === id);
  if (!b) return;
  if (!(await showConfirm(t('branches.deleteConfirm', { name: b.name }), { danger: true }))) return;
  const res = await apiDelete(`/api/branches/${id}`);
  if (res.ok) {
    showToast(t('branches.deleted'), 'success');
    if (editingId === id) cancelEditBranch();
    loadAll();
  } else {
    showToast(res.data.error || t('branches.saveFailed'), 'error');
  }
}

export async function changeDeviceBranch(deviceId, selectEl) {
  const branchId = selectEl.value ? Number(selectEl.value) : null;
  const res = await apiPut(`/api/branches/devices/${deviceId}`, { branch_id: branchId });
  if (res.ok) {
    showToast(t('branches.saved'), 'success');
    loadAll(); // refresh device counts on the branch list
  } else {
    selectEl.value = selectEl.dataset.prev;
    showToast(res.data.error || t('branches.saveFailed'), 'error');
  }
}

export async function init() {
  await loadAll();
}
