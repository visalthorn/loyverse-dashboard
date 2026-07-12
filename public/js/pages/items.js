import { fetchJSON, apiPut } from '../api.js';
import { getEl } from '../utils.js';
import { t, applyTranslations } from '../i18n.js';
import { showToast } from '../toast.js';
import { state } from '../state.js';

let items = [];
let categories = [];
let renameTarget = null;   // { kind: 'item'|'category', id }

const canWrite = () => !!state.userPermissions.items?.can_write;
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function fmtPrice(p) {
  if (p === null || p === undefined) return '—';
  return Number(p).toLocaleString('en-US');
}

// ── rendering ────────────────────────────────────────────────────────────────

function renderCategoryFilter() {
  const sel = getEl('itemCategoryFilter');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">${t('items.categoryAll')}</option>` +
    categories.map(c => `<option value="${c.id}">${esc(c.display_name)}</option>`).join('');
  sel.value = current;
}

function categoryDropdown(item) {
  const opts = `<option value="">${t('items.uncategorized')}</option>` +
    categories.map(c =>
      `<option value="${c.id}"${c.id === item.effective_category_id ? ' selected' : ''}>${esc(c.display_name)}</option>`
    ).join('');
  return `<select class="field-input" style="max-width:190px;padding:0.25rem 0.5rem;font-size:0.75rem"
            onchange="changeItemCategory('${item.id}', this.value)">${opts}</select>`;
}

function visibleItems() {
  const q = (getEl('itemSearch')?.value || '').toLowerCase().trim();
  const cat = getEl('itemCategoryFilter')?.value || '';
  const showDeleted = getEl('showDeletedToggle')?.checked;
  return items.filter(i => {
    if (!showDeleted && i.deleted_at) return false;
    if (cat && i.effective_category_id !== cat) return false;
    if (q && !(`${i.display_name} ${i.name} ${i.sku || ''}`.toLowerCase().includes(q))) return false;
    return true;
  });
}

function renderItems() {
  const tbody = getEl('itemsTableBody');
  if (!tbody) return;
  const rows = visibleItems();
  getEl('itemCount').textContent = `(${rows.length})`;

  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-10 text-center text-[color:var(--text-secondary)]">
      <div class="font-semibold mb-1">${t('items.emptyTitle')}</div>
      <div class="text-xs mb-3">${t('items.emptyHint')}</div>
      <a href="/sync.html" class="text-[color:var(--accent-strong)] text-xs">${t('items.goToSync')}</a>
    </td></tr>`;
    return;
  }
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-10 text-center text-[color:var(--text-secondary)]">${t('common.emptyNoData')}</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(i => `
    <tr class="border-b border-[color:var(--border-subtle)]${i.deleted_at ? ' opacity-50' : ''}">
      <td class="py-2 pr-3">${i.image_url ? `<img src="${esc(i.image_url)}" alt="" loading="lazy" style="width:34px;height:34px;border-radius:6px;object-fit:cover"/>` : ''}</td>
      <td class="py-2 pr-3">
        <div class="font-medium">${esc(i.display_name)}
          ${i.custom_name ? `<span class="badge" style="background:var(--hover-tint);color:var(--accent-strong);margin-left:6px">${t('items.editedBadge')}</span>` : ''}
          ${i.deleted_at ? `<span class="badge" style="background:var(--hover-tint);color:var(--loss);margin-left:6px">${t('items.deletedBadge')}</span>` : ''}
        </div>
        ${i.custom_name ? `<div class="text-xs text-[color:var(--text-muted)]">${esc(i.name)}</div>` : ''}
      </td>
      <td class="py-2 pr-3 text-xs">${esc(i.sku) || '—'}</td>
      <td class="py-2 pr-3">${canWrite() ? categoryDropdown(i) : esc(i.category_name || t('items.uncategorized'))}</td>
      <td class="py-2 pr-3 text-right">${fmtPrice(i.price)}</td>
      <td class="py-2 text-center" data-write-page="items">
        <button onclick="openRename('item','${i.id}')" class="text-xs px-2 py-1 rounded hover:bg-[color:var(--hover-tint)]" title="${t('items.renameTitle')}">✏️</button>
        ${i.custom_name ? `<button onclick="resetItemName('${i.id}')" class="text-xs px-2 py-1 rounded hover:bg-[color:var(--hover-tint)]" title="${t('items.reset')}">↩</button>` : ''}
      </td>
    </tr>`).join('');

  if (!canWrite()) document.querySelectorAll('#itemsTableBody [data-write-page]').forEach(el => el.style.display = 'none');
}

function renderCategoriesPanel() {
  const tbody = getEl('categoriesTableBody');
  if (!tbody) return;
  tbody.innerHTML = categories.map(c => `
    <tr class="border-b border-[color:var(--border-subtle)]">
      <td class="py-2 pr-3 font-medium">${esc(c.display_name)}
        ${c.custom_name ? `<span class="badge" style="background:var(--hover-tint);color:var(--accent-strong);margin-left:6px">${t('items.editedBadge')}</span>` : ''}
      </td>
      <td class="py-2 pr-3 text-xs text-[color:var(--text-muted)]">${esc(c.name)}</td>
      <td class="py-2 text-center" data-write-page="items">
        <button onclick="openRename('category','${c.id}')" class="text-xs px-2 py-1 rounded hover:bg-[color:var(--hover-tint)]">✏️</button>
      </td>
    </tr>`).join('');
  if (!canWrite()) document.querySelectorAll('#categoriesTableBody [data-write-page]').forEach(el => el.style.display = 'none');
}

// ── data ─────────────────────────────────────────────────────────────────────

async function loadAll() {
  const [itemsRes, categoriesRes] = await Promise.all([
    fetchJSON('/api/items'),
    fetchJSON('/api/items/categories'),
  ]);
  items      = itemsRes      || [];
  categories = categoriesRes || [];
  renderCategoryFilter();
  renderItems();
  renderCategoriesPanel();
}

// ── actions (exposed via window in app.js) ───────────────────────────────────

export function onItemSearch()       { renderItems(); }
export function onItemFilterChange() { renderItems(); }

export async function changeItemCategory(id, categoryId) {
  const item = items.find(i => i.id === id);
  // Selecting the item's Loyverse-native category clears the override instead of storing a redundant one
  const value = (item && categoryId === item.category_id) ? null : (categoryId || null);
  const res = await apiPut(`/api/items/${id}`, { custom_category_id: value });
  if (res.ok) {
    Object.assign(item, res.data);
    showToast(t('items.saved'), 'success');
  } else {
    showToast(res.data?.message || t('items.saveFailed'), 'error');
  }
  renderItems();
}

export function openRename(kind, id) {
  const list = kind === 'item' ? items : categories;
  const row = list.find(r => r.id === id);
  if (!row) return;
  renameTarget = { kind, id };
  getEl('renameTitle').textContent = kind === 'item' ? t('items.renameTitle') : t('items.renameCategoryTitle');
  getEl('renameInput').value = row.custom_name || '';
  getEl('renameLoyverseName').textContent = `${t('items.loyverseNameLabel')}: ${row.name}`;
  const modal = getEl('renameModal');
  modal.classList.remove('hidden');
  modal.style.display = 'flex';
  getEl('renameInput').focus();
}

export function closeRename() {
  renameTarget = null;
  const modal = getEl('renameModal');
  modal.classList.add('hidden');
  modal.style.display = 'none';
}

export async function submitRename(event) {
  event.preventDefault();
  if (!renameTarget) return;
  const value = getEl('renameInput').value.trim() || null;
  const url = renameTarget.kind === 'item'
    ? `/api/items/${renameTarget.id}`
    : `/api/items/categories/${renameTarget.id}`;
  const res = await apiPut(url, { custom_name: value });
  if (res.ok) {
    showToast(t('items.saved'), 'success');
    closeRename();
    await loadAll();   // category rename changes item rows too — reload both lists
  } else {
    showToast(res.data?.message || t('items.saveFailed'), 'error');
  }
}

export async function resetItemName(id) {
  const res = await apiPut(`/api/items/${id}`, { custom_name: null });
  if (res.ok) {
    const item = items.find(i => i.id === id);
    Object.assign(item, res.data);
    showToast(t('items.saved'), 'success');
  } else {
    showToast(res.data?.message || t('items.saveFailed'), 'error');
  }
  renderItems();
}

export function toggleCategoriesPanel() {
  getEl('categoriesPanel').classList.toggle('hidden');
}

export function init() {
  const modal = getEl('renameModal');
  if (modal) modal.style.display = 'none';   // ensure hidden despite inline flex
  loadAll();
}
