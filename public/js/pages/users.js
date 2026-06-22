import { fetchJSON, apiPost, apiPut, apiDelete } from '../api.js';
import { getEl } from '../utils.js';
import { logout } from '../auth.js';
import { state } from '../state.js';

let usersList       = [];
let permissionsList = [];
let editingUserId   = null;

// ─── Load ────────────────────────────────────────────────────────────────────

export async function loadUsersPage() {
  await Promise.all([loadUsersList(), loadPermissionsList()]);
}

async function loadUsersList() {
  const data = await fetchJSON('/api/users');
  if (data?.error || !Array.isArray(data)) { window.location.href = '/'; return; }
  usersList = data;
  renderUsersTable();
}

async function loadPermissionsList() {
  const data      = await fetchJSON('/api/permissions');
  permissionsList = Array.isArray(data) ? data : [];
  renderPermissionsMatrix();
}

// ─── Tables ──────────────────────────────────────────────────────────────────

function renderUsersTable() {
  const tbody = getEl('usersTableBody');
  if (!tbody) return;

  if (!usersList.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-10 text-center text-slate-500">No users found</td></tr>';
    return;
  }

  tbody.innerHTML = usersList.map((u, i) => {
    const roleBadge   = u.role === 'admin'
      ? '<span class="badge" style="background:rgba(245,158,11,.15);color:#fbbf24">admin</span>'
      : '<span class="badge" style="background:rgba(59,130,246,.12);color:#60a5fa">manager</span>';
    const statusBadge = u.is_active
      ? '<span class="badge" style="background:rgba(34,197,94,.12);color:#4ade80">Active</span>'
      : '<span class="badge" style="background:rgba(100,116,139,.14);color:#94a3b8">Inactive</span>';
    const toggleColor = u.is_active ? 'text-slate-400 hover:text-red-400' : 'text-slate-400 hover:text-emerald-400';

    return `<tr class="border-b border-slate-800 hover:bg-slate-800/30">
      <td class="py-2.5 pr-3 text-slate-500 text-xs">${i + 1}</td>
      <td class="py-2.5 pr-3 font-mono text-amber-400 text-xs font-semibold">${u.username}</td>
      <td class="py-2.5 pr-3 text-slate-200 text-xs">${u.full_name || '—'}</td>
      <td class="py-2.5 pr-3 text-slate-400 text-xs">${u.email}</td>
      <td class="py-2.5 pr-3 text-xs">${roleBadge}</td>
      <td class="py-2.5 pr-3 text-xs text-center">${statusBadge}</td>
      <td class="py-2.5 text-center whitespace-nowrap">
        <button onclick="startEditUser(${u.id})" class="text-xs text-slate-400 hover:text-amber-400 mr-3">Edit</button>
        <button onclick="toggleUserStatus(${u.id}, ${!u.is_active})" class="text-xs ${toggleColor} mr-3">${u.is_active ? 'Deactivate' : 'Activate'}</button>
        <button onclick="confirmDeleteUser(${u.id})" class="text-xs text-red-500 hover:text-red-400">Delete</button>
      </td>
    </tr>`;
  }).join('');
}

function renderPermissionsMatrix() {
  const tbody = getEl('permissionsMatrixBody');
  if (!tbody) return;

  const pages  = ['expenses', 'staff', 'receipts'];
  const labels = { expenses: '💸 Expenses', staff: '👥 Staff', receipts: '🧾 Receipts' };

  tbody.innerHTML = pages.map(page => {
    const perm    = permissionsList.find(p => p.role === 'manager' && p.page === page);
    const checked = perm?.can_write ? 'checked' : '';
    return `<tr class="border-b border-slate-800">
      <td class="py-3 pr-4 text-sm text-slate-200">${labels[page]}</td>
      <td class="py-3 pr-4 text-center text-xs text-emerald-400 font-semibold">✓ Always</td>
      <td class="py-3 text-center">
        <label class="relative inline-flex items-center cursor-pointer">
          <input type="checkbox" class="sr-only peer" ${checked}
            onchange="togglePermission('manager','${page}',this.checked)"/>
          <div class="w-10 h-5 bg-slate-700 rounded-full peer peer-checked:bg-amber-500 relative
            after:content-[''] after:absolute after:top-[2px] after:left-[2px]
            after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all
            peer-checked:after:translate-x-5"></div>
        </label>
      </td>
    </tr>`;
  }).join('');
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function submitUser(e) {
  e.preventDefault();
  const msg = getEl('userMsg');
  if (msg) msg.textContent = '';

  const password = getEl('userPassword').value;
  if (!editingUserId && !password) {
    if (msg) msg.textContent = 'Password is required for new users.';
    return;
  }

  const payload = {
    email:     getEl('userEmail').value.trim(),
    full_name: getEl('userFullName').value.trim() || null,
    role:      getEl('userRole').value,
  };
  if (!editingUserId) payload.username = getEl('userUsername').value.trim();
  if (password)       payload.password = password;

  const label = editingUserId ? `update user "${payload.email}"` : `create user "${payload.username}"`;
  if (state.currentUserRole !== 'admin' && !confirm(`Are you sure you want to ${label}?`)) return;

  const res = editingUserId
    ? await apiPut(`/api/users/${editingUserId}`, payload)
    : await apiPost('/api/users', payload);

  if (!res.ok) {
    if (msg) msg.textContent = res.data?.message || 'Failed to save.';
    return;
  }

  if (msg) msg.textContent = editingUserId ? 'Updated.' : 'User created.';
  cancelEditUser();
  loadUsersList();
}

export function startEditUser(id) {
  const u = usersList.find(x => x.id === id);
  if (!u) return;
  editingUserId = id;

  const usernameEl = getEl('userUsername');
  if (usernameEl) { usernameEl.value = u.username; usernameEl.disabled = true; }
  getEl('userEmail').value    = u.email;
  getEl('userFullName').value = u.full_name || '';
  getEl('userRole').value     = u.role;
  getEl('userPassword').value = '';

  const pwdLabel = getEl('userPasswordLabel');
  if (pwdLabel) pwdLabel.textContent = 'New Password (leave blank to keep)';
  if (getEl('userFormTitle'))   getEl('userFormTitle').textContent   = 'Edit User';
  if (getEl('userSubmitLabel')) getEl('userSubmitLabel').textContent = 'Save Changes';
  getEl('userFormCancelBtn')?.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function cancelEditUser() {
  editingUserId = null;
  getEl('userForm')?.reset();

  const usernameEl = getEl('userUsername');
  if (usernameEl) usernameEl.disabled = false;
  const pwdLabel = getEl('userPasswordLabel');
  if (pwdLabel) pwdLabel.textContent = 'Password';
  if (getEl('userFormTitle'))   getEl('userFormTitle').textContent   = 'Add User';
  if (getEl('userSubmitLabel')) getEl('userSubmitLabel').textContent = 'Create User';
  getEl('userFormCancelBtn')?.classList.add('hidden');
  const msg = getEl('userMsg');
  if (msg) msg.textContent = '';
}

export async function toggleUserStatus(id, isActive) {
  const u = usersList.find(x => x.id === id);
  if (!u) return;
  const res = await apiPut(`/api/users/${id}`, { email: u.email, full_name: u.full_name, role: u.role, is_active: isActive });
  if (!res.ok) { alert('Failed to update status.'); return; }
  loadUsersList();
}

export function confirmDeleteUser(id) {
  const u = usersList.find(x => x.id === id);
  if (!confirm(`Delete user "${u?.username}"? This cannot be undone.`)) return;
  deleteUser(id);
}

async function deleteUser(id) {
  const res = await apiDelete(`/api/users/${id}`);
  if (!res.ok) { alert(res.data?.message || 'Failed to delete.'); return; }
  loadUsersList();
}

export async function togglePermission(role, page, canWrite) {
  const action = canWrite ? 'enable' : 'disable';
  if (state.currentUserRole !== 'admin' && !confirm(`Are you sure you want to ${action} write permission for "${role}" on "${page}"?`)) {
    loadPermissionsList();
    return;
  }
  const res = await apiPut('/api/permissions', { role, page, can_write: canWrite });
  if (!res.ok) { alert('Failed to update permission.'); loadPermissionsList(); }
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function init() { loadUsersPage(); }
