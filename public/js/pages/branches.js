import { fetchJSON, apiPost, apiPut, apiPatch, apiDelete } from '../api.js';
import { icon } from '../icons.js';
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
        <div class="font-medium">${esc(b.name)}${b.is_default ? ` <span class="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded" style="background:var(--accent-soft);color:var(--accent-strong)">${t('branches.defaultBadge')}</span>` : ''}${b.google_maps_url ? ` <a href="${esc(b.google_maps_url)}" target="_blank" rel="noopener" title="Google Maps">${icon('map-pin', { size: 14 })}</a>` : ''}</div>
        ${b.address ? `<div class="text-xs text-[color:var(--text-muted)] truncate" style="max-width:240px">${esc(b.address)}</div>` : ''}
      </td>
      <td class="py-2.5 pr-3 text-center">${b.device_count}</td>
      <td class="py-2.5 text-center whitespace-nowrap">
        <button onclick="startEditBranch(${b.id})" class="text-xs text-[color:var(--accent-strong)] hover:underline mr-3">${t('branches.edit')}</button>
        <button onclick="confirmRevokeAllBranchDevices(${b.id})" class="text-xs text-[color:var(--loss)] hover:underline mr-3">${t('branches.revokeAllDevices')}</button>
        <button onclick="confirmDeleteBranch(${b.id})" class="text-xs text-[color:var(--loss)] hover:underline">${t('branches.delete')}</button>
      </td>
    </tr>`).join('');
}

export async function confirmRevokeAllBranchDevices(id) {
  const b = branches.find(x => x.id === id);
  if (!b) return;
  const ok = await showConfirm(t('branches.revokeAllBranchConfirm', { name: b.name }), { danger: true });
  if (!ok) return;
  const res = await apiPost(`/api/branches/${id}/revoke-all-devices`, {});
  if (res.ok) showToast(t('branches.devicesRevoked', { count: res.data.revoked_count }), 'success');
  else showToast(res.data.error || t('branches.saveFailed'), 'error');
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
  const warning = getEl('noSupervisorWarning');
  if (!tbody) return;
  if (!terminalBranchId) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-10 text-center text-[color:var(--text-secondary)]">${t('branches.selectBranchFirst')}</td></tr>`;
    if (warning) warning.classList.add('hidden');
    return;
  }
  if (!terminals.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-10 text-center text-[color:var(--text-secondary)]">${t('branches.noTerminals')}</td></tr>`;
    if (warning) warning.classList.add('hidden');
    return;
  }
  const isPos = terminalTab === 'pos';
  const isLocked = term => term.locked_until && new Date(term.locked_until) > new Date();
  tbody.innerHTML = terminals.map(term => `
    <tr class="border-b border-[color:var(--border-subtle)]">
      <td class="py-2.5 pr-3 font-mono font-medium">${esc(term.terminal_id)}</td>
      <td class="py-2.5 pr-3">${esc(term.name || '')}</td>
      <td class="py-2.5 pr-3 text-center">
        <button onclick="toggleTerminalActive(${term.id})" class="badge" style="cursor:pointer;background:${term.is_active ? 'var(--gain-soft, var(--accent-soft))' : 'var(--bg-surface-alt)'};color:${term.is_active ? 'var(--gain)' : 'var(--text-muted)'}">
          ${term.is_active ? t('branches.active') : t('branches.inactive')}
        </button>
        ${isLocked(term) ? `<button onclick="unlockTerminal(${term.id})" class="badge" style="cursor:pointer;background:var(--loss-soft, var(--bg-surface-alt));color:var(--loss);margin-left:4px;" title="${esc(new Date(term.locked_until).toLocaleString())}">${t('branches.lockedBadge')}</button>` : ''}
      </td>
      <td class="py-2.5 pr-3 text-center">
        ${isPos
          ? `<button onclick="changeTerminalRole(${term.id})" class="badge" style="cursor:pointer;background:${term.role === 'supervisor' ? 'var(--accent-soft)' : 'var(--bg-surface-alt)'};color:${term.role === 'supervisor' ? 'var(--accent-strong)' : 'var(--text-muted)'}">
              ${term.role === 'supervisor' ? t('branches.roleSupervisor') : t('branches.roleOrder')}
            </button>`
          : '<span class="text-[color:var(--text-muted)]">—</span>'}
      </td>
      <td class="py-2.5 pr-3 text-xs text-[color:var(--text-secondary)]">${fmtLastLogin(term.last_login_at)}</td>
      <td class="py-2.5 text-center whitespace-nowrap">
        <button onclick="resetTerminalPasscode(${term.id})" class="text-xs text-[color:var(--accent-strong)] hover:underline mr-3">${t('branches.resetPasscode')}</button>
        <button onclick="openDevicesModal(${term.id})" class="text-xs text-[color:var(--accent-strong)] hover:underline mr-3">${t('branches.devices')}</button>
        ${isPos ? '' : `<button onclick="openCategoriesModal(${term.id})" class="text-xs text-[color:var(--accent-strong)] hover:underline">${t('branches.categories')}</button>`}
      </td>
    </tr>`).join('');

  if (warning) {
    const noSupervisors = isPos && terminals.some(term => term.is_active) && !terminals.some(term => term.is_active && term.role === 'supervisor');
    warning.classList.toggle('hidden', !noSupervisors);
  }
}

export async function changeTerminalRole(id) {
  const term = terminals.find(x => x.id === id);
  if (!term) return;
  const nextRole = term.role === 'supervisor' ? 'order' : 'supervisor';
  const confirmMsg = nextRole === 'supervisor'
    ? t('branches.makeSupervisorConfirm', { name: term.name || term.terminal_id })
    : t('branches.makeOrderConfirm', { name: term.name || term.terminal_id });
  const ok = await showConfirm(confirmMsg);
  if (!ok) return;
  const res = await apiPatch(`/api/pos-terminals/${id}/role`, { role: nextRole });
  if (res.ok) loadTerminals();
  else showToast(res.data.error || t('branches.saveFailed'), 'error');
}

export async function unlockTerminal(id) {
  const res = await apiPost(`/api/terminals/${terminalEndpoint() === 'pos-terminals' ? 'pos' : 'kds'}/${id}/unlock`, {});
  if (res.ok) { showToast(t('branches.terminalUnlocked'), 'success'); loadTerminals(); }
  else showToast(res.data.error || t('branches.saveFailed'), 'error');
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

// ─── Device management modal ────────────────────────────────────────────────
// Long-lived device tokens minted at PIN login (see routes/terminalAuth.js) --
// this is the dashboard's only visibility into which physical devices are
// still logged into a given terminal, and the only way to revoke one short
// of waiting out its 90-day sliding expiry.

function relativeTime(ts) {
  if (!ts) return t('branches.never');
  const diffMs = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t('branches.justNow');
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export async function openDevicesModal(termId) {
  const type = terminalEndpoint() === 'pos-terminals' ? 'pos' : 'kds';
  const term = terminals.find(x => x.id === termId);

  const overlay = buildModalShell(`
    <h2 style="margin:0 0 4px;font-size:16px;font-weight:700;">${t('branches.devicesModalTitle')}</h2>
    <p style="font-size:11px;color:var(--text-secondary);margin:0 0 12px;">${esc(term ? (term.name || term.terminal_id) : '')}</p>
    <div id="devicesModalBody" style="max-height:340px;overflow-y:auto;margin-bottom:12px;font-size:12px;">
      <div style="text-align:center;color:var(--text-secondary);padding:20px 0;">…</div>
    </div>
    <div style="display:flex;gap:10px;">
      <button id="devicesRevokeAllBtn" type="button" class="btn-ghost" style="flex:1;color:var(--loss);">${t('branches.revokeAllDevices')}</button>
      <button id="devicesCloseBtn" type="button" class="btn-accent" style="flex:1;">${t('dialog.ok')}</button>
    </div>
  `);
  overlay.querySelector('#devicesCloseBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#devicesRevokeAllBtn').addEventListener('click', async () => {
    const ok = await showConfirm(t('branches.revokeAllConfirm'), { danger: true });
    if (!ok) return;
    const res = await apiPost(`/api/terminals/${type}/${termId}/revoke-all-devices`, {});
    if (res.ok) { showToast(t('branches.devicesRevoked', { count: res.data.revoked_count }), 'success'); renderDeviceList(); }
    else showToast(res.data.error || t('branches.saveFailed'), 'error');
  });

  async function renderDeviceList() {
    const body = overlay.querySelector('#devicesModalBody');
    const list = await fetchJSON(`/api/terminals/${type}/${termId}/devices`);
    const rows = (list || []).filter(d => !d.revoked_at);
    if (!body) return; // overlay closed while awaiting
    if (!rows.length) {
      body.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:20px 0;">${t('branches.noTerminalDevices')}</div>`;
      return;
    }
    body.innerHTML = rows.map(d => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 4px;border-bottom:1px solid var(--border-subtle);">
        <div style="min-width:0;">
          <div style="font-weight:600;">${esc(d.device_label || t('branches.unlabeledDevice'))}</div>
          <div style="color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px;">${esc((d.user_agent || '').slice(0, 60))}</div>
          <div style="color:var(--text-muted);">${t('branches.lastActive')}: ${relativeTime(d.last_active_at)} · ${t('branches.expires')}: ${new Date(d.expires_at).toLocaleDateString()}</div>
        </div>
        <button data-revoke-id="${d.id}" class="text-xs text-[color:var(--loss)] hover:underline" style="flex-shrink:0;">${t('branches.revoke')}</button>
      </div>`).join('');
    body.querySelectorAll('[data-revoke-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const res = await apiPost(`/api/terminal-devices/${btn.dataset.revokeId}/revoke`, {});
        if (res.ok) renderDeviceList();
        else showToast(res.data.error || t('branches.saveFailed'), 'error');
      });
    });
  }

  renderDeviceList();
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
  const isPos = terminalTab === 'pos';
  const overlay = buildModalShell(`
    <h2 style="margin:0 0 14px;font-size:16px;font-weight:700;">${t('branches.createTerminalTitle')}</h2>
    <input id="newTerminalId" type="text" maxlength="20" placeholder="${t('branches.terminalIdPlaceholder')}"
      class="field-input" style="margin-bottom:8px;text-transform:uppercase;"/>
    <input id="newTerminalName" type="text" maxlength="100" placeholder="${t('branches.terminalNamePlaceholder')}"
      class="field-input" style="margin-bottom:${isPos ? '8px' : '16px'};"/>
    ${isPos ? `
    <select id="newTerminalRole" class="field-input" style="margin-bottom:4px;">
      <option value="order">${t('branches.roleOrder')}</option>
      <option value="supervisor">${t('branches.roleSupervisor')}</option>
    </select>
    <p style="font-size:11px;color:var(--text-secondary);margin:0 0 16px;">${t('branches.roleHelperText')}</p>
    ` : ''}
    <div style="display:flex;gap:10px;">
      <button id="createTerminalCancelBtn" type="button" class="btn-ghost" style="flex:1;">${t('dialog.cancel')}</button>
      <button id="createTerminalSubmitBtn" type="button" class="btn-accent" style="flex:1;">${t('branches.createBtn')}</button>
    </div>
  `);
  overlay.querySelector('#createTerminalCancelBtn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#createTerminalSubmitBtn').addEventListener('click', async () => {
    const terminalId = overlay.querySelector('#newTerminalId').value.trim().toUpperCase();
    const name       = overlay.querySelector('#newTerminalName').value.trim();
    const role       = isPos ? overlay.querySelector('#newTerminalRole').value : undefined;
    if (!terminalId) { showToast(t('branches.terminalIdRequired'), 'error'); return; }
    const res = await apiPost(`/api/branches/${terminalBranchId}/${terminalEndpoint()}`, { terminal_id: terminalId, name, role });
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
  const [allCats, assigned, branchWide] = await Promise.all([
    fetchJSON('/api/items/categories'),
    fetchJSON(`/api/kds-terminals/${kdsTerminalId}/categories`),
    fetchJSON(`/api/branches/${terminalBranchId}/kds-terminal-categories`),
  ]);
  const cats = allCats || [];
  const assignedIds = new Set((assigned || []).map(c => c.id));
  const takenBy = new Map();
  (branchWide || []).forEach(row => {
    if (row.kds_terminal_id !== kdsTerminalId) takenBy.set(row.category_id, row);
  });

  const overlay = buildModalShell(`
    <h2 style="margin:0 0 6px;font-size:16px;font-weight:700;">${t('branches.categoriesModalTitle')}</h2>
    <p style="font-size:11px;color:var(--text-secondary);margin:0 0 12px;">${t('branches.categoriesModalHint')}</p>
    <div style="max-height:280px;overflow-y:auto;margin-bottom:16px;">
      ${cats.map(c => {
        const taken = takenBy.get(c.id);
        const disabled = !!taken && !assignedIds.has(c.id);
        return `
        <label style="display:flex;align-items:center;gap:10px;padding:8px 4px;${disabled ? 'opacity:.45;cursor:not-allowed;' : 'cursor:pointer;'}">
          <input type="checkbox" class="cat-checkbox" value="${c.id}" ${assignedIds.has(c.id) ? 'checked' : ''} ${disabled ? 'disabled' : ''}/>
          <span>${esc(c.custom_name || c.name)}</span>
          ${disabled ? `<span style="font-size:10px;color:var(--text-muted);margin-left:auto;">${t('branches.assignedToTerminal', { terminal: esc(taken.name || taken.terminal_id) })}</span>` : ''}
        </label>`;
      }).join('') || `<div style="text-align:center;color:var(--text-secondary);font-size:12px;padding:20px 0;">—</div>`}
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
    } else if (res.status === 409) {
      showToast(res.data.error || t('branches.categoryConflict'), 'error');
    } else {
      showToast(res.data.error || t('branches.saveFailed'), 'error');
    }
  });
}

let kdsSettings = { warn_minutes: 10, danger_minutes: 20 };

async function loadKdsSettings() {
  const data = await fetchJSON('/api/branches/kds-settings');
  if (data) kdsSettings = data;
  const warnEl   = getEl('kdsWarnMinutesInput');
  const dangerEl = getEl('kdsDangerMinutesInput');
  if (warnEl)   warnEl.value   = kdsSettings.warn_minutes;
  if (dangerEl) dangerEl.value = kdsSettings.danger_minutes;
}

export async function saveKdsDisplaySettings(e) {
  e.preventDefault();
  const warn   = parseInt(getEl('kdsWarnMinutesInput').value, 10);
  const danger = parseInt(getEl('kdsDangerMinutesInput').value, 10);
  if (!Number.isInteger(warn) || warn < 1 || !Number.isInteger(danger) || danger < 1 || warn >= danger) {
    showToast(t('branches.kdsSettingsInvalid'), 'error');
    return;
  }
  const res = await apiPut('/api/branches/kds-settings', { warn_minutes: warn, danger_minutes: danger });
  if (!res.ok) { showToast(res.data.error || t('branches.kdsSettingsSaveFailed'), 'error'); return; }
  kdsSettings = res.data;
  showToast(t('branches.kdsSettingsSaved'));
}

export async function init() {
  await loadAll();
  await loadKdsSettings();
}
