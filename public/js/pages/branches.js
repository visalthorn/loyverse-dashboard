import { fetchJSON, apiPost, apiPut, apiPatch, apiDelete } from '../api.js';
import { getEl } from '../utils.js';
import { t } from '../i18n.js';
import { showToast } from '../toast.js';
import { showConfirm } from '../dialog.js';

let branches  = [];
let devices   = [];
let editingId = null;

let terminalBranchId = null;
let terminalTab      = 'pos'; // 'pos' | 'kds'
let terminals        = [];

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
  renderTerminalBranchSelect();
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

// ─── POS/KDS Terminals ──────────────────────────────────────────────────────

function renderTerminalBranchSelect() {
  const sel = getEl('terminalBranchSelect');
  if (!sel) return;
  if (!branches.length) {
    sel.innerHTML = `<option value="">${t('branches.selectBranchFirst')}</option>`;
    terminalBranchId = null;
    renderTerminals();
    return;
  }
  if (terminalBranchId == null || !branches.some(b => b.id === terminalBranchId)) {
    terminalBranchId = branches[0].id;
  }
  sel.innerHTML = branches.map(b =>
    `<option value="${b.id}"${b.id === terminalBranchId ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
  loadTerminals();
}

export function onTerminalBranchChange(id) {
  terminalBranchId = Number(id);
  loadTerminals();
}

export function switchTerminalTab(tab) {
  terminalTab = tab;
  getEl('terminalTabPos').classList.toggle('tab-active', tab === 'pos');
  getEl('terminalTabKds').classList.toggle('tab-active', tab === 'kds');
  loadTerminals();
}

function terminalEndpoint() {
  return terminalTab === 'pos' ? 'pos-terminals' : 'kds-terminals';
}

async function loadTerminals() {
  if (!terminalBranchId) { terminals = []; renderTerminals(); return; }
  const data = await fetchJSON(`/api/branches/${terminalBranchId}/${terminalEndpoint()}`);
  terminals = data || [];
  renderTerminals();
}

function fmtLastLogin(ts) {
  return ts ? new Date(ts).toLocaleString() : t('branches.never');
}

function renderTerminals() {
  const tbody = getEl('terminalsTableBody');
  if (!tbody) return;
  if (!terminalBranchId) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-10 text-center text-[color:var(--text-secondary)]">${t('branches.selectBranchFirst')}</td></tr>`;
    return;
  }
  if (!terminals.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-10 text-center text-[color:var(--text-secondary)]">${t('branches.noTerminals')}</td></tr>`;
    return;
  }
  const isPos = terminalTab === 'pos';
  tbody.innerHTML = terminals.map(term => `
    <tr class="border-b border-[color:var(--border-subtle)]">
      <td class="py-2.5 pr-3 font-mono font-medium">${esc(term.terminal_id)}</td>
      <td class="py-2.5 pr-3">${esc(term.name || '')}</td>
      <td class="py-2.5 pr-3 text-center">
        <button onclick="toggleTerminalActive(${term.id})" class="badge" style="cursor:pointer;background:${term.is_active ? 'var(--gain-soft, var(--accent-soft))' : 'var(--bg-surface-alt)'};color:${term.is_active ? 'var(--gain)' : 'var(--text-muted)'}">
          ${term.is_active ? t('branches.active') : t('branches.inactive')}
        </button>
      </td>
      <td class="py-2.5 pr-3 text-xs text-[color:var(--text-secondary)]">${fmtLastLogin(term.last_login_at)}</td>
      <td class="py-2.5 text-center whitespace-nowrap">
        <button onclick="resetTerminalPasscode(${term.id})" class="text-xs text-[color:var(--accent-strong)] hover:underline mr-3">${t('branches.resetPasscode')}</button>
        ${isPos ? '' : `<button onclick="openCategoriesModal(${term.id})" class="text-xs text-[color:var(--accent-strong)] hover:underline">${t('branches.categories')}</button>`}
      </td>
    </tr>`).join('');
}

export async function toggleTerminalActive(id) {
  const term = terminals.find(x => x.id === id);
  if (!term) return;
  if (term.is_active) {
    const ok = await showConfirm(t('branches.deactivateConfirm', { name: term.name || term.terminal_id }), { danger: true });
    if (!ok) return;
  }
  const res = await apiPatch(`/api/${terminalEndpoint()}/${id}/toggle`);
  if (res.ok) loadTerminals();
  else showToast(res.data.error || t('branches.saveFailed'), 'error');
}

export async function resetTerminalPasscode(id) {
  const term = terminals.find(x => x.id === id);
  if (!term) return;
  const ok = await showConfirm(t('branches.resetConfirm', { name: term.name || term.terminal_id }), { danger: true });
  if (!ok) return;
  const res = await apiPost(`/api/${terminalEndpoint()}/${id}/reset-passcode`, {});
  if (res.ok) {
    showToast(t('branches.passcodeReset'), 'success');
    showPasscodeModal(res.data.passcode);
  } else {
    showToast(res.data.error || t('branches.saveFailed'), 'error');
  }
}

// ─── Create-terminal modal (lightweight, no shared dialog infra needed) ─────

function buildModalShell(bodyHtml) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);';
  overlay.innerHTML = `<div style="width:100%;max-width:380px;padding:24px;border-radius:16px;background:var(--bg-surface);border:1px solid var(--border);box-shadow:var(--shadow-lift);">${bodyHtml}</div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  return overlay;
}

export function openCreateTerminalModal() {
  if (!terminalBranchId) { showToast(t('branches.selectBranchFirst'), 'error'); return; }
  const overlay = buildModalShell(`
    <h2 style="margin:0 0 14px;font-size:16px;font-weight:700;">${t('branches.createTerminalTitle')}</h2>
    <input id="newTerminalId" type="text" maxlength="20" placeholder="${t('branches.terminalIdPlaceholder')}"
      class="field-input" style="margin-bottom:8px;text-transform:uppercase;"/>
    <input id="newTerminalName" type="text" maxlength="100" placeholder="${t('branches.terminalNamePlaceholder')}"
      class="field-input" style="margin-bottom:16px;"/>
    <div style="display:flex;gap:10px;">
      <button id="createTerminalCancelBtn" type="button" class="btn-ghost" style="flex:1;">${t('dialog.cancel')}</button>
      <button id="createTerminalSubmitBtn" type="button" class="btn-accent" style="flex:1;">${t('branches.createBtn')}</button>
    </div>
  `);
  overlay.querySelector('#createTerminalCancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#createTerminalSubmitBtn').addEventListener('click', async () => {
    const terminalId = overlay.querySelector('#newTerminalId').value.trim().toUpperCase();
    const name       = overlay.querySelector('#newTerminalName').value.trim();
    if (!terminalId) { showToast(t('branches.terminalIdRequired'), 'error'); return; }
    const res = await apiPost(`/api/branches/${terminalBranchId}/${terminalEndpoint()}`, { terminal_id: terminalId, name });
    if (res.ok) {
      overlay.remove();
      showToast(t('branches.terminalCreated'), 'success');
      loadTerminals();
      showPasscodeModal(res.data.passcode);
    } else if (res.status === 409) {
      showToast(t('branches.terminalIdDuplicate'), 'error');
    } else {
      showToast(res.data.error || t('branches.saveFailed'), 'error');
    }
  });
  overlay.querySelector('#newTerminalId').focus();
}

function showPasscodeModal(passcode) {
  const overlay = buildModalShell(`
    <h2 style="margin:0 0 10px;font-size:16px;font-weight:700;color:var(--accent-strong);">${t('branches.oneTimePasscodeTitle')}</h2>
    <div style="text-align:center;font-size:36px;font-weight:800;font-family:var(--font-num);letter-spacing:.1em;
      padding:16px;border-radius:10px;background:var(--bg-surface-alt);margin-bottom:10px;">${esc(passcode)}</div>
    <p style="font-size:12px;color:var(--loss);margin:0 0 16px;">${t('branches.oneTimePasscodeWarning')}</p>
    <div style="display:flex;gap:10px;">
      <button id="passcodeCopyBtn" type="button" class="btn-ghost" style="flex:1;">${t('branches.copyPasscode')}</button>
      <button id="passcodeDoneBtn" type="button" class="btn-accent" style="flex:1;">${t('dialog.ok')}</button>
    </div>
  `);
  overlay.querySelector('#passcodeDoneBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#passcodeCopyBtn').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(passcode); e.target.textContent = t('branches.copied'); }
    catch { /* clipboard unavailable -- passcode is already shown on screen */ }
  });
}

// ─── KDS category assignment modal ──────────────────────────────────────────

export async function openCategoriesModal(kdsTerminalId) {
  const [allCats, assigned] = await Promise.all([
    fetchJSON('/api/items/categories'),
    fetchJSON(`/api/kds-terminals/${kdsTerminalId}/categories`),
  ]);
  const cats = allCats || [];
  const assignedIds = new Set((assigned || []).map(c => c.id));

  const overlay = buildModalShell(`
    <h2 style="margin:0 0 6px;font-size:16px;font-weight:700;">${t('branches.categoriesModalTitle')}</h2>
    <p style="font-size:11px;color:var(--text-secondary);margin:0 0 12px;">${t('branches.categoriesModalHint')}</p>
    <div style="max-height:280px;overflow-y:auto;margin-bottom:16px;">
      ${cats.map(c => `
        <label style="display:flex;align-items:center;gap:10px;padding:8px 4px;cursor:pointer;">
          <input type="checkbox" class="cat-checkbox" value="${c.id}" ${assignedIds.has(c.id) ? 'checked' : ''}/>
          <span>${esc(c.custom_name || c.name)}</span>
        </label>
      `).join('') || `<div style="text-align:center;color:var(--text-secondary);font-size:12px;padding:20px 0;">—</div>`}
    </div>
    <div style="display:flex;gap:10px;">
      <button id="catsCancelBtn" type="button" class="btn-ghost" style="flex:1;">${t('dialog.cancel')}</button>
      <button id="catsSaveBtn" type="button" class="btn-accent" style="flex:1;">${t('dialog.confirm')}</button>
    </div>
  `);
  overlay.querySelector('#catsCancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#catsSaveBtn').addEventListener('click', async () => {
    const categoryIds = Array.from(overlay.querySelectorAll('.cat-checkbox:checked')).map(el => el.value);
    const res = await apiPut(`/api/kds-terminals/${kdsTerminalId}/categories`, { category_ids: categoryIds });
    if (res.ok) {
      overlay.remove();
      showToast(t('branches.saved'), 'success');
    } else {
      showToast(res.data.error || t('branches.saveFailed'), 'error');
    }
  });
}

export async function init() {
  await loadAll();
}
