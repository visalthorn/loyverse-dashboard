import { state } from '../state.js';
import { fetchJSON, apiPost, apiPut, apiPatch, apiDelete } from '../api.js';
import { getEl, fmtKHR, fmtDate, getTodayDate, toISODate } from '../utils.js';
import { t } from '../i18n.js';
import { emptyStateHTML } from '../ui.js';
import { showToast } from '../toast.js';
import { showConfirm } from '../dialog.js';
import { destroyChart, themeColor, withAlpha, tooltipTheme, legendTheme, numTicks } from '../charts.js';

// Ingredient stock control: restock-only tracking (date + qty added + qty
// remaining), item links with no usage quantities, a history view with a
// server-computed "consumed since previous restock" column, and the learned
// consumption analysis (estimated remaining on each card; click a card for
// the per-period chart). No per-order deduction anywhere.

let ingredients = [];
let analysisById = {};         // id → /api/inventory/analysis row
let soldItems = null;          // lazily fetched, cached for the link picker
let currentIngredientId = null;
let currentLinks = [];
let currentRestockUnit = '';
let currentHistoryRows = [];

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Ingredient quantities keep up to 2 decimals (fmt()/fmtKHR() round to whole numbers).
function fmtQty(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function showModal(id) {
  const m = getEl(id);
  if (!m) return;
  m.classList.remove('hidden');
  m.style.display = 'flex';
}

function hideModal(id) {
  const m = getEl(id);
  if (!m) return;
  m.classList.add('hidden');
  m.style.display = 'none';
}

// ── Ingredient grid ──────────────────────────────────────────────────────────

async function loadIngredients() {
  const includeInactive = getEl('showInactiveToggle')?.checked;
  const [data, analysis] = await Promise.all([
    fetchJSON(`/api/inventory/ingredients${includeInactive ? '?include_inactive=true' : ''}`),
    fetchJSON('/api/inventory/analysis'),
  ]);
  ingredients = data || [];
  analysisById = {};
  (analysis || []).forEach(a => { analysisById[a.id] = a; });
  renderIngredients();
}

// Rates can be tiny (0.05 bag/item) or large (4.2 kg/day) — adapt precision.
function fmtRate(v) {
  if (v == null) return '?';
  const dp = v >= 1 ? 1 : (v >= 0.1 ? 2 : 3);
  return Number(v.toFixed(dp)).toString();
}

function estimateHTML(ing) {
  const a = analysisById[ing.id];
  const status = a?.status || 'no_data';
  if (!a || status === 'no_data' || a.estimated_remaining == null) {
    return `<div class="inv-card-stat-val inv-est--no_data">${t('inventory.noDataYet')}</div>`;
  }
  const days = a.days_until_empty != null
    ? `<span class="inv-est-days">${t('inventory.daysLeft', { n: fmtQty(a.days_until_empty) })}</span>` : '';
  const dot = `<span class="inv-conf-dot inv-conf-dot--${a.confidence}" title="${t('inventory.confidenceLabel', {
    level: t(`inventory.confidence.${a.confidence}`), n: a.periods.length,
  })}"></span>`;
  return `<div class="inv-card-stat-val inv-est--${status}">~${fmtQty(a.estimated_remaining)} ${esc(ing.unit)}${dot}${days}</div>`;
}

function renderIngredients() {
  const grid = getEl('ingredientsGrid');
  if (!grid) return;

  if (!ingredients.length) {
    grid.innerHTML = emptyStateHTML({ titleKey: 'inventory.emptyTitle', hintKey: 'inventory.emptyHint', icon: '🧂' });
    return;
  }

  grid.innerHTML = ingredients.map(ing => {
    const lastLine = ing.last_restock_date
      ? `${fmtDate(ing.last_restock_date)} · ${fmtQty(ing.last_total_after)} ${esc(ing.unit)}`
      : t('inventory.noRestockYet');
    return `
    <div class="card inv-card${ing.is_active ? '' : ' inv-card--inactive'}" onclick="invOpenAnalysis(event, ${ing.id})">
      <div class="inv-card-head">
        <div class="min-w-0">
          <div class="inv-card-name">${esc(ing.name)}${ing.name_kh ? `<span class="inv-card-name-kh">${esc(ing.name_kh)}</span>` : ''}</div>
          <div class="inv-card-unit">${esc(ing.unit)}</div>
        </div>
        ${ing.is_active ? '' : `<span class="badge inv-badge--inactive">${t('inventory.inactive')}</span>`}
      </div>

      <div>
        <div class="inv-card-stat-lbl">${t('inventory.lastRestock')}</div>
        <div class="inv-card-stat-val">${lastLine}</div>
      </div>

      <div>
        <div class="inv-card-stat-lbl">${t('inventory.estRemaining')}</div>
        ${estimateHTML(ing)}
      </div>

      <div class="inv-card-actions">
        <button onclick="invOpenRestock(${ing.id})" class="inv-btn inv-btn--accent">📦 ${t('inventory.restock')}</button>
        <button onclick="invOpenLinks(${ing.id})" class="inv-btn">🔗 ${t('inventory.items')} (${ing.link_count})</button>
        <button onclick="invOpenHistory(${ing.id})" class="inv-btn">📜 ${t('inventory.history')}</button>
        <button onclick="invOpenEditIngredient(${ing.id})" class="inv-icon-btn" title="${t('common.edit')}">✏️</button>
        <button onclick="invToggleActive(${ing.id})" class="inv-icon-btn" title="${t(ing.is_active ? 'inventory.deactivate' : 'inventory.activate')}">${ing.is_active ? '⏸' : '▶'}</button>
      </div>
    </div>`;
  }).join('');
}

export function invOnShowInactiveChange() { loadIngredients(); }

// ── Add / edit ingredient ────────────────────────────────────────────────────

const PREDEFINED_UNITS = ['kg', 'g', 'l', 'ml', 'pc', 'bag'];

export function invOnUnitSelectChange() {
  const isCustom = getEl('ingredientUnit').value === '__custom__';
  const customInput = getEl('ingredientUnitCustom');
  customInput.classList.toggle('hidden', !isCustom);
  if (isCustom) customInput.focus();
}

export function invOpenAddIngredient() {
  getEl('ingredientEditId').value = '';
  getEl('ingredientModalTitle').textContent = t('inventory.addIngredient');
  getEl('ingredientName').value = '';
  getEl('ingredientNameKh').value = '';
  getEl('ingredientUnit').value = 'kg';
  getEl('ingredientUnitCustom').value = '';
  getEl('ingredientUnitCustom').classList.add('hidden');
  getEl('ingredientAlertThreshold').value = '';
  getEl('ingredientMsg').textContent = '';
  showModal('ingredientModal');
  getEl('ingredientName').focus();
}

export function invOpenEditIngredient(id) {
  const ing = ingredients.find(i => i.id === id);
  if (!ing) return;
  getEl('ingredientEditId').value = id;
  getEl('ingredientModalTitle').textContent = t('inventory.editIngredient');
  getEl('ingredientName').value = ing.name;
  getEl('ingredientNameKh').value = ing.name_kh || '';
  const isPredefined = PREDEFINED_UNITS.includes(ing.unit);
  getEl('ingredientUnit').value = isPredefined ? ing.unit : '__custom__';
  getEl('ingredientUnitCustom').value = isPredefined ? '' : ing.unit;
  getEl('ingredientUnitCustom').classList.toggle('hidden', isPredefined);
  getEl('ingredientAlertThreshold').value = ing.alert_threshold;
  getEl('ingredientMsg').textContent = '';
  showModal('ingredientModal');
}

export function invCloseIngredientModal() { hideModal('ingredientModal'); }

export async function invSubmitIngredient(e) {
  e.preventDefault();
  const msg = getEl('ingredientMsg');
  msg.textContent = '';

  const id = getEl('ingredientEditId').value;
  const selectedUnit = getEl('ingredientUnit').value;
  const unit = selectedUnit === '__custom__' ? getEl('ingredientUnitCustom').value.trim() : selectedUnit;
  const body = {
    name:            getEl('ingredientName').value.trim(),
    name_kh:         getEl('ingredientNameKh').value.trim(),
    unit,
    alert_threshold: getEl('ingredientAlertThreshold').value || 0,
  };
  if (!body.name || !body.unit) { msg.textContent = t('inventory.errorRequiredFields'); return; }

  const res = id
    ? await apiPut(`/api/inventory/ingredients/${id}`, body)
    : await apiPost('/api/inventory/ingredients', body);

  if (!res.ok) { msg.textContent = res.data?.message || t('inventory.saveFailed'); return; }

  showToast(t('inventory.saved'), 'success');
  invCloseIngredientModal();
  await loadIngredients();
}

export async function invToggleActive(id) {
  const ing = ingredients.find(i => i.id === id);
  if (!ing) return;
  if (!(await showConfirm(t(ing.is_active ? 'inventory.confirmDeactivate' : 'inventory.confirmActivate')))) return;
  const res = await apiPatch(`/api/inventory/ingredients/${id}/toggle`);
  if (!res.ok) { showToast(res.data?.message || t('inventory.saveFailed'), 'error'); return; }
  await loadIngredients();
}

// ── Restock ───────────────────────────────────────────────────────────────

export function invOpenRestock(id) {
  const ing = ingredients.find(i => i.id === id);
  if (!ing) return;
  currentRestockUnit = ing.unit;

  getEl('restockEditId').value = '';
  getEl('restockModalAction').textContent = t('inventory.restock');
  getEl('restockExpenseRow').classList.remove('hidden');
  getEl('restockEditHint').classList.add('hidden');
  getEl('restockIngredientId').value = id;
  getEl('restockIngName').textContent = ing.name;
  getEl('restockDate').value = getTodayDate();
  getEl('restockRemaining').value = '';
  getEl('restockAdded').value = '';
  getEl('restockCost').value = '';
  getEl('restockRecordExpense').checked = true;
  getEl('restockNote').value = '';
  getEl('restockUnit1').textContent = ing.unit;
  getEl('restockUnit2').textContent = ing.unit;
  getEl('restockMsg').textContent = '';
  invUpdateRestockPreview();
  showModal('restockModal');
  getEl('restockRemaining').focus();
}

export function invOpenEditRestock(id, ingredientId) {
  const ing = ingredients.find(i => i.id === ingredientId);
  const row = currentHistoryRows.find(r => r.id === id);
  if (!ing || !row) return;
  currentRestockUnit = ing.unit;

  getEl('restockEditId').value = id;
  getEl('restockModalAction').textContent = t('inventory.editRestock');
  getEl('restockExpenseRow').classList.add('hidden');
  getEl('restockEditHint').classList.remove('hidden');
  getEl('restockIngredientId').value = ingredientId;
  getEl('restockIngName').textContent = ing.name;
  getEl('restockDate').value = toISODate(row.restock_date);
  getEl('restockRemaining').value = row.qty_remaining;
  getEl('restockAdded').value = row.qty_added;
  getEl('restockCost').value = row.cost ?? '';
  getEl('restockNote').value = row.note || '';
  getEl('restockUnit1').textContent = ing.unit;
  getEl('restockUnit2').textContent = ing.unit;
  getEl('restockMsg').textContent = '';
  invUpdateRestockPreview();
  showModal('restockModal');
  getEl('restockRemaining').focus();
}

export function invCloseRestock() { hideModal('restockModal'); }

export function invUpdateRestockPreview() {
  const remaining = parseFloat(getEl('restockRemaining').value) || 0;
  const added     = parseFloat(getEl('restockAdded').value) || 0;
  getEl('restockPreview').textContent = t('inventory.totalAfterPreview', {
    total: fmtQty(remaining + added), unit: currentRestockUnit,
  });
}

export async function invSubmitRestock(e) {
  e.preventDefault();
  const msg = getEl('restockMsg');
  msg.textContent = '';

  const editId        = getEl('restockEditId').value;
  const ingredientId   = parseInt(getEl('restockIngredientId').value);
  const restock_date   = getEl('restockDate').value;
  const remainingVal   = getEl('restockRemaining').value;
  const addedVal       = getEl('restockAdded').value;
  const costVal        = getEl('restockCost').value;
  const record_expense = getEl('restockRecordExpense').checked;
  const note = getEl('restockNote').value.trim();

  if (!restock_date || remainingVal === '' || addedVal === '') {
    msg.textContent = t('inventory.errorRequiredFields');
    return;
  }

  const body = {
    restock_date,
    qty_remaining: parseFloat(remainingVal),
    qty_added:     parseFloat(addedVal),
    cost: costVal === '' ? null : parseFloat(costVal),
    note,
  };

  const res = editId
    ? await apiPut(`/api/inventory/restocks/${editId}`, body)
    : await apiPost('/api/inventory/restocks', { ...body, ingredient_id: ingredientId, record_expense });

  if (!res.ok) { msg.textContent = res.data?.message || t('inventory.saveFailed'); return; }

  showToast(t('inventory.restockSaved'), 'success');
  invCloseRestock();
  if (editId && !getEl('historyModal').classList.contains('hidden')) {
    const ing = ingredients.find(i => i.id === ingredientId);
    const rows = await fetchJSON(`/api/inventory/restocks?ingredient_id=${ingredientId}&limit=20`) || [];
    renderHistory(rows, ing?.unit || '');
  }
  await loadIngredients();
}

// ── Item links ────────────────────────────────────────────────────────────

function renderLinksList() {
  const el = getEl('linksCurrentList');
  if (!el) return;
  if (!currentLinks.length) {
    el.innerHTML = `<div class="text-xs text-[color:var(--text-muted)]">${t('inventory.noLinksYet')}</div>`;
    return;
  }
  el.innerHTML = currentLinks.map(l => `
    <span class="chip">${esc(l.item_name || l.sku)}<button type="button" onclick="invRemoveLink(${l.id})" class="chip-remove" title="${t('common.delete')}">✕</button></span>
  `).join('');
}

export async function invOpenLinks(id) {
  const ing = ingredients.find(i => i.id === id);
  if (!ing) return;
  currentIngredientId = id;
  getEl('linksIngName').textContent = ing.name;
  getEl('linkSearch').value = '';
  getEl('linkResults').innerHTML = '';

  currentLinks = await fetchJSON(`/api/inventory/links?ingredient_id=${id}`) || [];
  renderLinksList();
  if (!soldItems) soldItems = await fetchJSON('/api/inventory/sold-items') || [];
  showModal('linksModal');
}

export function invCloseLinks() { hideModal('linksModal'); }

export function invOnLinkSearch() {
  const q = (getEl('linkSearch').value || '').toLowerCase().trim();
  const results = getEl('linkResults');
  if (!q) { results.innerHTML = ''; return; }

  const linkedSkus = new Set(currentLinks.map(l => l.sku));
  const matches = (soldItems || [])
    .filter(i => !linkedSkus.has(i.sku) && `${i.item_name} ${i.sku}`.toLowerCase().includes(q))
    .slice(0, 8);

  results.innerHTML = matches.length
    ? matches.map(i => `<button type="button" class="inv-link-result-item" onclick="invAddLink('${esc(i.sku)}')">${esc(i.item_name)} <span class="text-[color:var(--text-muted)]">${esc(i.sku)}</span></button>`).join('')
    : `<div class="text-xs text-[color:var(--text-muted)] px-1 py-1">${t('common.emptyNoData')}</div>`;
}

export async function invAddLink(sku) {
  const res = await apiPost('/api/inventory/links', { ingredient_id: currentIngredientId, sku });
  if (!res.ok) { showToast(res.data?.message || t('inventory.linkFailed'), 'error'); return; }

  currentLinks.push(res.data);
  renderLinksList();
  getEl('linkSearch').value = '';
  getEl('linkResults').innerHTML = '';
  await loadIngredients();   // refresh the (n) link count badge on the card
}

export async function invRemoveLink(id) {
  const res = await apiDelete(`/api/inventory/links/${id}`);
  if (!res.ok) { showToast(res.data?.message || t('inventory.linkFailed'), 'error'); return; }

  currentLinks = currentLinks.filter(l => l.id !== id);
  renderLinksList();
  await loadIngredients();
}

// ── History ───────────────────────────────────────────────────────────────

function renderHistory(rows, unit) {
  currentHistoryRows = rows;
  const tbody = getEl('historyTableBody');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="py-6 text-center text-[color:var(--text-secondary)]">${t('inventory.noRestockYet')}</td></tr>`;
    return;
  }

  const isAdmin = state.currentUserRole === 'admin';
  tbody.innerHTML = rows.map(r => `
    <tr class="border-b border-[color:var(--border-subtle)]">
      <td class="py-2 pr-3">${fmtDate(r.restock_date)}</td>
      <td class="py-2 pr-3 text-right num">${fmtQty(r.qty_remaining)}</td>
      <td class="py-2 pr-3 text-right num">${fmtQty(r.qty_added)}</td>
      <td class="py-2 pr-3 text-right num font-semibold">${fmtQty(r.total_after)}</td>
      <td class="py-2 pr-3 text-right num">${r.consumed_since_previous != null ? `${fmtQty(r.consumed_since_previous)} ${esc(unit)}` : '—'}</td>
      <td class="py-2 pr-3 text-right num">${r.cost ? fmtKHR(r.cost) : '—'}</td>
      <td class="py-2 pr-3 text-xs text-[color:var(--text-muted)]">${esc(r.note || '')}</td>
      <td class="py-2 text-center whitespace-nowrap">${isAdmin ? `
        <button onclick="invOpenEditRestock(${r.id},${currentIngredientId})" class="inv-icon-btn" title="${t('common.edit')}">✏️</button>
        <button onclick="invDeleteRestock(${r.id},${currentIngredientId})" class="inv-icon-btn" title="${t('common.delete')}">🗑️</button>` : ''}</td>
    </tr>`).join('');
}

export async function invOpenHistory(id) {
  const ing = ingredients.find(i => i.id === id);
  if (!ing) return;
  currentIngredientId = id;
  getEl('historyIngName').textContent = ing.name;
  getEl('historyTableBody').innerHTML = `<tr><td colspan="8" class="py-6 text-center text-[color:var(--text-secondary)]">${t('common.loading')}</td></tr>`;
  showModal('historyModal');

  const rows = await fetchJSON(`/api/inventory/restocks?ingredient_id=${id}&limit=20`) || [];
  renderHistory(rows, ing.unit);
}

export function invCloseHistory() { hideModal('historyModal'); }

export async function invDeleteRestock(id, ingredientId) {
  if (!(await showConfirm(t('inventory.confirmDeleteRestock'), { danger: true, confirmText: t('common.delete') }))) return;
  const res = await apiDelete(`/api/inventory/restocks/${id}`);
  if (!res.ok) { showToast(res.data?.message || t('inventory.deleteFailed'), 'error'); return; }

  const ing  = ingredients.find(i => i.id === ingredientId);
  const rows = await fetchJSON(`/api/inventory/restocks?ingredient_id=${ingredientId}&limit=20`) || [];
  renderHistory(rows, ing?.unit || '');
  await loadIngredients();   // last-restock line on the card may have changed
}

// ── Analysis detail ───────────────────────────────────────────────────────

function analysisSummaryText(a, unit) {
  if (!a.periods.length) return t('inventory.analysisNoData');
  const parts = [];
  if (a.rate_per_item != null) parts.push(t('inventory.ratePerItem', { rate: fmtRate(a.rate_per_item), unit }));
  if (a.rate_per_day != null)  parts.push(t('inventory.ratePerDay',  { rate: fmtRate(a.rate_per_day),  unit }));
  parts.push(t('inventory.confidenceLabel', {
    level: t(`inventory.confidence.${a.confidence}`), n: a.periods.length,
  }));
  return parts.join(' · ');
}

function renderAnalysisChart(a) {
  destroyChart('analysisChart');
  const wrap = getEl('analysisChartWrap');
  if (!a.periods.length) { if (wrap) wrap.style.display = 'none'; return; }
  if (wrap) wrap.style.display = '';

  const soldColor = themeColor('--chart-2', '#5c8fe6');
  state.charts.analysisChart = new Chart(document.getElementById('analysisChart'), {
    type: 'bar',
    data: {
      labels: a.periods.map(p => `${fmtDate(p.start)} → ${fmtDate(p.end)}`),
      datasets: [
        {
          label: t('inventory.chartConsumed', { unit: a.unit }),
          data: a.periods.map(p => p.consumed),
          backgroundColor: withAlpha('--accent', 0.7),
          borderColor: themeColor('--accent', '#f59e0b'),
          borderWidth: 1,
          borderRadius: 6,
          yAxisID: 'y',
        },
        {
          label: t('inventory.chartSold'),
          data: a.periods.map(p => p.sold),
          type: 'line',
          borderColor: soldColor,
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: soldColor,
          tension: 0.3,
          yAxisID: 'y2',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: legendTheme(), tooltip: tooltipTheme() },
      scales: {
        x:  { grid: { color: themeColor('--bg-surface', '#151f33') }, ticks: numTicks() },
        y:  { position: 'left',  grid: { color: themeColor('--border', '#2b3952') }, ticks: numTicks() },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: numTicks({ color: soldColor }) },
      },
    },
  });
}

export async function invOpenAnalysis(event, id) {
  if (event?.target?.closest('button')) return;   // card buttons keep their own actions
  const ing = ingredients.find(i => i.id === id);
  if (!ing) return;

  getEl('analysisIngName').textContent = ing.name;
  getEl('analysisSummary').textContent = t('common.loading');
  getEl('analysisBadPeriods').style.display = 'none';
  showModal('analysisModal');

  const a = await fetchJSON(`/api/inventory/analysis/${id}`);
  if (!a) { getEl('analysisSummary').textContent = t('inventory.saveFailed'); return; }

  getEl('analysisSummary').textContent = `${ing.name}: ${analysisSummaryText(a, ing.unit)}`;
  renderAnalysisChart(a);

  const bad = getEl('analysisBadPeriods');
  if (a.bad_periods.length) {
    bad.style.display = '';
    bad.innerHTML = `<div class="font-semibold mb-1">${t('inventory.badPeriodsTitle')}</div>`
      + a.bad_periods.map(p =>
          `<div>${fmtDate(p.start)} → ${fmtDate(p.end)}: ${fmtQty(p.consumed)} ${esc(ing.unit)}</div>`).join('');
  }
}

export function invCloseAnalysis() {
  destroyChart('analysisChart');
  hideModal('analysisModal');
}

// ── AI analysis ───────────────────────────────────────────────────────────
// Cards render from cached results on page load; the button POSTs a run that
// only sends CHANGED ingredients to the API (see services/inventoryAI.js).

let aiRunning = false;

function fmtAiTime(v) {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function updateAiStatusBar(latest) {
  const btn = getEl('aiAnalyzeBtn'), txt = getEl('aiStatusText');
  if (!btn || !latest) return;
  txt.textContent = latest.last_analyzed_at
    ? t('inventory.aiLastAnalyzed', { time: fmtAiTime(latest.last_analyzed_at), n: latest.changed_count })
    : t('inventory.aiNeverAnalyzed');
  if (latest.changed_count === 0) {
    btn.disabled = true;
    btn.textContent = t('inventory.aiUpToDate');
    btn.title = t('inventory.aiUpToDateTooltip');
  } else {
    btn.disabled = false;
    btn.textContent = t('inventory.aiAnalyze');
    btn.title = '';
  }
}

function aiCardHTML(r) {
  const cachedChip = r.cached
    ? `<span class="badge ai-chip-cached">${t('inventory.aiCached')}</span>` : '';
  const anomalies = (r.anomalies || []).map(a => `<div class="ai-anomaly">⚠ ${esc(a)}</div>`).join('');
  const note = r.data_quality_note
    ? `<div class="text-xs text-[color:var(--text-muted)]">${esc(r.data_quality_note)}</div>` : '';
  return `
    <div class="card inv-card">
      <div class="inv-card-head">
        <div class="inv-card-name">${esc(r.name)}${r.name_kh ? `<span class="inv-card-name-kh">${esc(r.name_kh)}</span>` : ''}</div>
        <div class="flex items-center gap-1 flex-shrink-0">
          ${cachedChip}
          <span class="badge ai-health--${esc(r.health)}">${t(`inventory.aiHealth.${r.health}`)}</span>
        </div>
      </div>
      <div class="ai-summary" data-en="${esc(r.summary_en)}" data-kh="${esc(r.summary_kh)}" data-lang="en">${esc(r.summary_en)}
        ${r.summary_kh ? `<button type="button" class="ai-lang-toggle" onclick="invToggleAiLang(this)" title="ភាសាខ្មែរ / English">🇰🇭</button>` : ''}
      </div>
      ${anomalies}
      ${r.refill_advice ? `<div class="ai-advice">📦 ${esc(r.refill_advice)}</div>` : ''}
      ${note}
      <div class="text-xs text-[color:var(--text-dim)]">${fmtAiTime(r.analyzed_at)}</div>
    </div>`;
}

function renderAiCards(list) {
  const sec = getEl('aiInsightsSection'), grid = getEl('aiInsightsGrid');
  if (!sec || !grid) return;
  if (!list.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  grid.innerHTML = list.map(aiCardHTML).join('');
}

export function invToggleAiLang(btn) {
  const box = btn.closest('.ai-summary');
  if (!box) return;
  const toKh = box.dataset.lang !== 'kh';
  box.dataset.lang = toKh ? 'kh' : 'en';
  // Replace only the text node; the toggle button stays.
  box.childNodes[0].textContent = (toKh ? box.dataset.kh : box.dataset.en) + '\n        ';
  btn.textContent = toKh ? '🇬🇧' : '🇰🇭';
}

async function loadAiStatus({ renderCards = true } = {}) {
  const latest = await fetchJSON('/api/inventory/ai-analyze/latest');
  if (!latest) return;
  updateAiStatusBar(latest);
  if (renderCards) {
    renderAiCards((latest.ingredients || [])
      .filter(r => r.analysis)
      .map(r => ({ ...r.analysis, name: r.name, name_kh: r.name_kh, unit: r.unit,
                   cached: false, analyzed_at: r.analyzed_at })));
  }
}

export async function invRunAiAnalysis() {
  if (aiRunning) return;
  const btn = getEl('aiAnalyzeBtn');
  aiRunning = true;
  btn.disabled = true;
  btn.innerHTML = `<span class="ai-spinner"></span> ${t('inventory.aiAnalyzing')}`;
  try {
    const res = await apiPost('/api/inventory/ai-analyze', {});
    if (!res.ok) {
      // Errors never break the page — toast and keep the last cached cards.
      showToast(res.data?.message || t('inventory.aiRunFailed'), 'error');
      return;
    }
    const d = res.data;
    renderAiCards([...(d.results || []), ...(d.cached || [])]);
    getEl('aiUsageFooter').textContent = d.usage
      ? t('inventory.aiUsage', { in: d.usage.input_tokens, out: d.usage.output_tokens })
      : '';
    if (d.skipped?.length) showToast(t('inventory.aiSkipped', { n: d.skipped.length }));
    if (d.failed?.length)  showToast(t('inventory.aiFailed'), 'error');
  } catch {
    showToast(t('inventory.aiRunFailed'), 'error');
  } finally {
    aiRunning = false;
    btn.disabled = false;
    btn.textContent = t('inventory.aiAnalyze');
    loadAiStatus({ renderCards: false });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────

export function init() {
  ['ingredientModal', 'restockModal', 'linksModal', 'historyModal', 'analysisModal'].forEach(id => {
    const m = getEl(id);
    if (m) m.style.display = 'none';   // ensure hidden despite inline flex
  });
  loadIngredients();
  loadAiStatus();
}
