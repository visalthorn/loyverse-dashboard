import { fetchJSON } from '../api.js';
import { getEl, fmtDatetime } from '../utils.js';
import { t } from '../i18n.js';

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const UNCATEGORIZED = '__uncategorized__';

let items = [];
let categories = [];

function fmtPrice(p) {
  if (p === null || p === undefined) return '—';
  return Number(p).toLocaleString('en-US');
}

async function loadCatalog() {
  const [summary, itemList] = await Promise.all([
    fetchJSON('/api/catalog/summary'),
    fetchJSON('/api/items'),
  ]);

  if (!summary || !Array.isArray(itemList)) {
    getEl('catalogCategoriesBody').innerHTML = `<tr><td colspan="3" class="py-10 text-center text-[color:var(--loss)]">${t('catalog.loadFailed')}</td></tr>`;
    getEl('catalogItemsBody').innerHTML = `<tr><td colspan="5" class="py-10 text-center text-[color:var(--loss)]">${t('catalog.loadFailed')}</td></tr>`;
    return;
  }

  categories = summary.categories;
  items = itemList;

  getEl('catalogStatActive').textContent     = summary.active_items;
  getEl('catalogStatTotal').textContent       = summary.total_items;
  getEl('catalogStatCategories').textContent  = summary.total_categories;
  getEl('catalogStatSynced').textContent      = summary.last_synced_at ? fmtDatetime(summary.last_synced_at) : t('catalog.neverSynced');

  renderCategoriesTable();
  populateCategoryFilter();
  renderItemsTable();
}

function renderCategoriesTable() {
  const tbody = getEl('catalogCategoriesBody');
  if (!tbody) return;
  if (!categories.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="py-10 text-center text-[color:var(--text-secondary)]">${t('catalog.noCategoriesFound')}</td></tr>`;
    return;
  }
  tbody.innerHTML = categories.map(c => `
    <tr class="border-b border-[color:var(--border-subtle)]">
      <td class="py-2 pr-3 text-xs">${c.id === null ? t('catalog.uncategorized') : esc(c.name)}</td>
      <td class="py-2 pr-3 text-xs text-right num">${c.active_item_count}</td>
      <td class="py-2 text-xs text-right num text-[color:var(--text-secondary)]">${c.total_item_count}</td>
    </tr>`).join('');
}

function populateCategoryFilter() {
  const sel = getEl('catalogCategoryFilter');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">${t('catalog.allCategories')}</option>` +
    categories.map(c => `<option value="${c.id === null ? UNCATEGORIZED : esc(c.id)}">${c.id === null ? t('catalog.uncategorized') : esc(c.name)}</option>`).join('');
  sel.value = current;
}

function matchesFilters(item, search, categoryFilter) {
  if (search) {
    const haystack = `${item.display_name || ''} ${item.sku || ''}`.toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  if (categoryFilter) {
    const effectiveCategoryId = item.effective_category_id;
    if (categoryFilter === UNCATEGORIZED) {
      if (effectiveCategoryId && categories.some(c => c.id === effectiveCategoryId)) return false;
    } else if (effectiveCategoryId !== categoryFilter) {
      return false;
    }
  }
  return true;
}

function renderItemsTable() {
  const tbody = getEl('catalogItemsBody');
  if (!tbody) return;

  const search = (getEl('catalogSearch')?.value || '').trim().toLowerCase();
  const categoryFilter = getEl('catalogCategoryFilter')?.value || '';
  const filtered = items.filter(i => matchesFilters(i, search, categoryFilter));

  const countEl = getEl('catalogItemsCount');
  if (countEl) countEl.textContent = t('catalog.itemsCount', { shown: filtered.length, total: items.length });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="py-10 text-center text-[color:var(--text-secondary)]">${t('catalog.noItemsFound')}</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(i => {
    const statusBadge = i.deleted_at
      ? `<span class="badge" style="background:color-mix(in srgb, var(--text-muted) 14%, transparent);color:var(--text-muted)">${t('catalog.badgeInactive')}</span>`
      : `<span class="badge" style="background:var(--gain-soft);color:var(--gain)">${t('catalog.badgeActive')}</span>`;
    return `<tr class="border-b border-[color:var(--border-subtle)]${i.deleted_at ? ' opacity-50' : ''}">
      <td class="py-2 pr-3 text-xs">${esc(i.display_name)}</td>
      <td class="py-2 pr-3 text-xs text-[color:var(--text-secondary)]">${esc(i.category_name || '—')}</td>
      <td class="py-2 pr-3 text-xs font-mono text-[color:var(--text-secondary)]">${esc(i.sku || '—')}</td>
      <td class="py-2 pr-3 text-xs text-right num">${fmtPrice(i.price)}</td>
      <td class="py-2 text-center">${statusBadge}</td>
    </tr>`;
  }).join('');
}

export function init() {
  loadCatalog();
  getEl('catalogSearch')?.addEventListener('input', renderItemsTable);
  getEl('catalogCategoryFilter')?.addEventListener('change', renderItemsTable);
}
