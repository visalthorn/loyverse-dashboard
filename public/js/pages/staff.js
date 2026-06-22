import { state } from '../state.js';
import { fetchJSON, apiPost, apiPut, apiDelete } from '../api.js';
import { getEl, fmtRaw, downloadCSV } from '../utils.js';
import { logout } from '../auth.js';

let staffList     = [];
let editingStaffId = null;

// ─── Load ────────────────────────────────────────────────────────────────────

export async function loadStaff() {
  const data = await fetchJSON('/api/staff');
  staffList  = Array.isArray(data) ? data : [];
  renderStaffStats();
  renderStaffTable();
}

// ─── Stats ───────────────────────────────────────────────────────────────────

function renderStaffStats() {
  const active = staffList.filter(s => s.is_active);

  const totalSalary = active.reduce((sum, s) => {
    const amt = parseFloat(s.salary || 0);
    return sum + (s.salary_ccy === 'KHR' ? amt / 4000 : amt);
  }, 0);

  const totalLoan = active.reduce((sum, s) => {
    const amt = parseFloat(s.loan_amount || 0);
    return sum + (s.loan_ccy === 'USD' ? amt * 4000 : amt);
  }, 0);

  const set = (id, val) => { const el = getEl(id); if (el) el.textContent = val; };
  set('statActiveStaff', active.length);
  set('statTotalSalary', '$' + fmtRaw(totalSalary, 2));
  set('statTotalLoan',   '៛' + fmtRaw(totalLoan));
}

// ─── Table ───────────────────────────────────────────────────────────────────

export function renderStaffTable() {
  const tbody = getEl('staffTableBody');
  if (!tbody) return;

  const showInactive = getEl('showInactive')?.checked;
  const rows = showInactive ? staffList : staffList.filter(s => s.is_active);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="py-10 text-center text-slate-500">No staff found</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((s, i) => {
    const joinDate     = s.join_date ? new Date(s.join_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
    const statusBadge  = s.is_active ? '<span class="badge badge-active">Active</span>' : '<span class="badge badge-inactive">Inactive</span>';
    const salaryCcy    = s.salary_ccy || 'USD';
    const salaryDisplay = salaryCcy === 'KHR' ? '៛' + fmtRaw(s.salary) : '$' + fmtRaw(s.salary, 2);
    const loanCcy      = s.loan_ccy || 'KHR';
    const loanBadge    = parseFloat(s.loan_amount) > 0
      ? `<span class="badge badge-loan">${loanCcy === 'KHR' ? '៛' : '$'}${fmtRaw(s.loan_amount, loanCcy === 'KHR' ? 0 : 2)}</span>`
      : '<span class="text-slate-600 text-xs">—</span>';
    const toggleLabel = s.is_active ? 'Deactivate' : 'Activate';
    const toggleColor = s.is_active ? 'text-slate-400 hover:text-red-400' : 'text-slate-400 hover:text-emerald-400';

    return `<tr class="staff-row border-b border-slate-800">
      <td class="py-2.5 pr-3 text-slate-500 text-xs">${i + 1}</td>
      <td class="py-2.5 pr-3 font-mono text-amber-400 text-xs font-semibold">${s.staff_id}</td>
      <td class="py-2.5 pr-3 font-medium text-slate-100 text-xs">${s.full_name}</td>
      <td class="py-2.5 pr-3 text-slate-300 text-xs">${s.position || '—'}</td>
      <td class="py-2.5 pr-3 text-slate-400 text-xs whitespace-nowrap">${joinDate}</td>
      <td class="py-2.5 pr-3 text-right text-emerald-400 font-semibold text-xs">${salaryDisplay}</td>
      <td class="py-2.5 pr-3 text-slate-300 text-xs">${s.phone || '—'}</td>
      <td class="py-2.5 pr-3 text-right text-xs">${loanBadge}</td>
      <td class="py-2.5 pr-3 text-center">${statusBadge}</td>
      <td class="py-2.5 text-center whitespace-nowrap">
        ${state.userPermissions.staff?.can_write ? `
          <button onclick="startEditStaff(${s.id})" class="text-xs text-slate-400 hover:text-amber-400 mr-3">Edit</button>
          <button onclick="toggleStaffStatus(${s.id}, ${!s.is_active})" class="text-xs ${toggleColor} mr-3">${toggleLabel}</button>
          <button onclick="confirmDeleteStaff(${s.id})" class="text-xs text-red-500 hover:text-red-400">Delete</button>
        ` : '<span class="text-xs text-slate-600">Read only</span>'}
      </td>
    </tr>`;
  }).join('');
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function submitStaff(e) {
  e.preventDefault();
  const msg = getEl('staffMsg');
  if (msg) msg.textContent = '';

  const payload = {
    staff_id:    getEl('staffId').value.trim(),
    full_name:   getEl('staffFullName').value.trim(),
    position:    getEl('staffPosition').value.trim(),
    join_date:   getEl('staffJoinDate').value || null,
    salary:      parseFloat(getEl('staffSalary').value) || 0,
    salary_ccy:  getEl('staffSalaryCcy').value || 'USD',
    phone:       getEl('staffPhone').value.trim() || null,
    loan_amount: parseFloat(getEl('staffLoan').value) || 0,
    loan_ccy:    getEl('staffLoanCcy').value || 'KHR',
    notes:       getEl('staffNotes').value.trim() || null,
  };

  if (state.currentUserRole !== 'admin' && !confirm(`Are you sure you want to ${editingStaffId ? `update "${payload.full_name}"` : `add "${payload.full_name}"`}?`)) return;

  const body = editingStaffId ? { ...payload, is_active: true } : payload;
  const res  = editingStaffId
    ? await apiPut(`/api/staff/${editingStaffId}`, body)
    : await apiPost('/api/staff', body);

  if (!res.ok) {
    if (msg) msg.textContent = res.data?.message || 'Failed to save.';
    return;
  }

  if (msg) msg.textContent = editingStaffId ? 'Updated.' : 'Added.';
  cancelEditStaff();
  loadStaff();
}

export function startEditStaff(id) {
  const s = staffList.find(x => x.id === id);
  if (!s) return;
  editingStaffId = id;

  getEl('staffId').value        = s.staff_id;
  getEl('staffFullName').value  = s.full_name;
  getEl('staffPosition').value  = s.position || '';
  getEl('staffJoinDate').value  = s.join_date ? s.join_date.slice(0, 10) : '';
  getEl('staffSalary').value    = s.salary;
  getEl('staffSalaryCcy').value = s.salary_ccy || 'USD';
  getEl('staffPhone').value     = s.phone || '';
  getEl('staffLoan').value      = s.loan_amount;
  getEl('staffLoanCcy').value   = s.loan_ccy || 'KHR';
  getEl('staffNotes').value     = s.notes || '';

  const titleEl  = getEl('staffFormTitle');
  const labelEl  = getEl('staffSubmitLabel');
  const cancelBtn = getEl('staffFormCancelBtn');
  if (titleEl)   titleEl.textContent  = 'Edit Staff';
  if (labelEl)   labelEl.textContent  = 'Save Changes';
  if (cancelBtn) cancelBtn.classList.remove('hidden');
  window.scrollTo({ top: (getEl('staffForm')?.offsetTop ?? 0) - 80, behavior: 'smooth' });
}

export function cancelEditStaff() {
  editingStaffId = null;
  getEl('staffForm')?.reset();
  const titleEl  = getEl('staffFormTitle');
  const labelEl  = getEl('staffSubmitLabel');
  const cancelBtn = getEl('staffFormCancelBtn');
  const msg       = getEl('staffMsg');
  if (titleEl)   titleEl.textContent  = 'Add Staff';
  if (labelEl)   labelEl.textContent  = 'Add Staff';
  if (cancelBtn) cancelBtn.classList.add('hidden');
  if (msg)       msg.textContent      = '';
}

export async function toggleStaffStatus(id, isActive) {
  const s = staffList.find(x => x.id === id);
  if (!s) return;
  const res = await apiPut(`/api/staff/${id}`, {
    ...s,
    join_date: s.join_date ? s.join_date.slice(0, 10) : null,
    is_active: isActive,
  });
  if (!res.ok) { alert('Failed to update status.'); return; }
  loadStaff();
}

export function confirmDeleteStaff(id) {
  const s = staffList.find(x => x.id === id);
  if (!confirm(`Delete ${s?.full_name ?? 'this staff member'}? This cannot be undone.`)) return;
  deleteStaff(id);
}

async function deleteStaff(id) {
  const res = await apiDelete(`/api/staff/${id}`);
  if (!res.ok) { alert(res.data?.message || 'Failed to delete.'); return; }
  loadStaff();
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function exportStaffCSV() {
  if (!staffList.length) return alert('No staff loaded.');
  const showInactive = getEl('showInactive')?.checked;
  const rows = showInactive ? staffList : staffList.filter(s => s.is_active);
  downloadCSV(`staff-${new Date().toISOString().slice(0, 10)}.csv`, [
    ['Staff ID','Full Name','Position','Join Date','Salary','Salary CCY','Phone','Loan','Loan CCY','Status','Notes'],
    ...rows.map(s => [
      s.staff_id, s.full_name, s.position ?? '', s.join_date ? s.join_date.slice(0,10) : '',
      s.salary, s.salary_ccy || 'USD', s.phone ?? '', s.loan_amount, s.loan_ccy || 'KHR',
      s.is_active ? 'Active' : 'Inactive', s.notes ?? '',
    ]),
  ]);
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function init() { loadStaff(); }
