import { getTerminalInfo, showTerminalLogin, terminalLogout, clearDeviceTerminalId, bootSession, startIdleWatch, lockNow } from './terminalAuth.js';
import { fetchTerminalJSON as fetchJSON, terminalApiPost } from './terminalAuth.js';
import { getEl } from './utils.js';
import { showConfirm, showPrompt, showAlert } from './dialog.js';
import { showToast } from './toast.js';
import { printReceipt, printKitchenTicket, getBridgeUrl, setBridgeUrl, receiptHTML } from './print.js';
import {
  mutate, onQueueChange, onReplaySuccess, onReplayRejected, onDeadLetter, onSyncSummary,
  onQueueNearLimit, onConnectivityChange, isOffline, getLastSyncAt, getQueueSnapshot,
  retryDeadLetter, discardDeadLetter, cancelQueuedLocalOrder, nextLocalOrderNumber,
  startOfflineQueue, syncNow,
} from './offlineQueue.js';

const CATALOG_VERSION_POLL_MS = 5 * 60 * 1000;
const OPEN_ORDERS_POLL_MS     = 15 * 1000;
const CATALOG_CACHE_KEY       = 'pos_catalog_cache';

let catalog = { categories: [], items: [] };
let config  = { dining_options: [], payment_methods: [] };
let lastCatalogVersion = null;

let activeCategory = 'all';
let searchTerm     = '';

// New, not-yet-persisted lines for the order currently in the panel.
let cart = [];
// The persisted order this panel represents, or null for a brand-new order.
let currentOrder = null;

let diningOption = null;
let tableNumber  = '';

let selectedPayMethod = null;
let cashReceived       = 0;

const PAY_METHOD_LABELS = { cash: 'Cash', khqr: 'QR', both: 'Cash + QR' };
let lastPaidOrder      = null;
let orderLoading       = false;

// server_now vs Date.now() at fetch time -- corrects for the same naive-
// Cambodia-local-timestamp-vs-client-clock mismatch kds.js already guards
// against (see kds-elapsed-timezone.test.js) so "sitting time" in the Orders
// list doesn't drift by hours if the terminal's own clock/timezone differs.
let ordersClockOffsetMs = 0;

function khr(n) {
  const num = Number(n) || 0;
  return '៛' + num.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Order name is assigned at creation time and never staff-editable (matches
// the server, which generates its own name the same way for an online
// create -- see routes/pos.js). Only needed here for an offline-created
// order's local stand-in, since there's no server round trip yet to assign
// one for it.
function defaultOrderName() {
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Phnom_Penh', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date());
  return `Order ${time}`;
}

// Same "YYYY-MM-DD HH:mm:ss" naive-Cambodia-local shape the server writes
// via toCambodiaTime() — needed so client-built (offline) orders print with
// a timestamp that matches the server's convention exactly.
function cambodiaNaiveNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Phnom_Penh', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

// ─── Terminal role (POS audit, 2026-08-02; revised 2026-08-03) ──────────────
// Any terminal may fetch, resume, or cancel entirely any open order in the
// branch. Editing (items, table#, dining option) and completing payment
// require actually holding the order's edit lock -- see the "Order edit
// lock" section below -- with a supervisor terminal always able to override
// a live lock. This client-side role check is UI convenience only (hiding a
// button that would 403/409) and must never be trusted as the control.
function myRole() {
  const info = getTerminalInfo();
  return info ? info.role : null;
}
function isSupervisor() { return myRole() === 'supervisor'; }

async function showSupervisorRequiredDialog() {
  await showAlert('Ask a supervisor to complete this order at a supervisor terminal.', { title: 'Supervisor required' });
}

// ─── Catalog ──────────────────────────────────────────────────────────────

async function loadCatalog() {
  const data = await fetchJSON('/api/pos/catalog');
  if (data) {
    catalog = data;
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(data));
  } else {
    // Offline (or server unreachable) — fall back to the last good catalog
    // so the grid still renders instantly instead of coming up empty.
    try {
      const cached = JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY) || 'null');
      if (cached) catalog = cached;
    } catch { /* corrupt cache — ignore, keep whatever catalog already is */ }
  }
  renderCategories();
  renderItemGrid();
}

async function pollCatalogVersion() {
  const v = await fetchJSON('/api/pos/catalog/version');
  if (!v) return;
  if (lastCatalogVersion !== null && v.version !== lastCatalogVersion) {
    const fresh = await fetchJSON('/api/pos/catalog?refresh=1');
    if (fresh) { catalog = fresh; renderCategories(); renderItemGrid(); }
  }
  lastCatalogVersion = v.version;
}

function renderCategories() {
  const select = getEl('categoryBar');
  const tabs = [{ id: 'all', name: 'All' }, ...catalog.categories];
  select.innerHTML = tabs.map(c => `<option value="${esc(c.id)}" ${activeCategory === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  select.onchange = () => { activeCategory = select.value; renderItemGrid(); };
}

function cartQtyFor(itemId) {
  const line = cart.find(l => l.source_item_id === itemId);
  return line ? line.quantity : 0;
}

function renderItemGrid() {
  const grid = getEl('itemGrid');
  const term = searchTerm.trim().toLowerCase();
  const items = catalog.items.filter(it => {
    if (activeCategory !== 'all' && it.category_id !== activeCategory) return false;
    if (term && !it.name.toLowerCase().includes(term)) return false;
    return true;
  });

  if (!items.length) {
    grid.innerHTML = '<div id="emptyGridMsg">No items match.</div>';
    return;
  }

  grid.innerHTML = items.map(it => {
    const qty = cartQtyFor(it.id);
    return `
      <button class="item-btn" data-item-id="${it.id}">
        <span class="item-inner">
          <span class="item-qty-badge" ${qty > 0 ? '' : 'hidden'}>×${qty}</span>
          ${it.image_url
            ? `<img class="item-img" src="${esc(it.image_url)}" alt="" loading="lazy" onerror="this.remove()"/>`
            : ''}
          <span class="item-name">${it.name}</span>
          <span class="item-price">${khr(it.price)}</span>
        </span>
      </button>`;
  }).join('');

  grid.querySelectorAll('.item-btn').forEach(btn => {
    btn.addEventListener('click', () => addItemToCart(btn.dataset.itemId));
  });
}

// Cart changes only ever alter the qty badges -- they never change which items
// pass the category/search filter. Re-running renderItemGrid() for them rebuilt
// every tile's innerHTML, which re-created every <img> node: on a phone that
// showed up as the whole menu blinking/reloading its images and jumping back to
// the top of the grid on each tap. Patch just the badges instead, so the grid
// (and its scroll position) is left completely alone.
//
// Only safe while catalog.items / activeCategory / searchTerm are unchanged --
// those four call sites still use the full renderItemGrid() above.
function updateQtyBadges() {
  const grid = getEl('itemGrid');
  grid.querySelectorAll('.item-btn').forEach(btn => {
    const badge = btn.querySelector('.item-qty-badge');
    if (!badge) return;
    const qty = cartQtyFor(btn.dataset.itemId);
    badge.textContent = `×${qty}`;
    badge.hidden = qty === 0;
  });
}

// ─── In-progress cart draft ─────────────────────────────────────────────────
// Persisted on every meaningful change so a hard refresh or reboot mid-order
// restores the panel instead of silently dropping unsent items. Keyed per
// terminal so a browser that's logged into different terminals over time
// doesn't bleed one terminal's draft into another's.
//
// Only ever written by explicit user actions (typing, tapping) -- never by
// the offline-queue's own replay -- so restoring a draft on boot can't cause
// a duplicate order. The queue's own QUEUE_KEY (offlineQueue.js) is the sole
// source of truth for what still needs to reach the server; this draft is
// just a mirror of what the panel should *show* while that's pending.

function draftKey() {
  const info = getTerminalInfo();
  return `pos_cart_draft_${info ? info.terminal_id : 'unknown'}`;
}

function saveDraft() {
  try {
    localStorage.setItem(draftKey(), JSON.stringify({ currentOrder, cart, diningOption, tableNumber }));
  } catch { /* storage full/disabled -- worst case the draft doesn't restore */ }
}

function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch { /* ignore */ }
}

function loadDraft() {
  try { return JSON.parse(localStorage.getItem(draftKey()) || 'null'); }
  catch { return null; }
}

// Only restores when there's genuinely unsent content -- a currentOrder that
// was already fully persisted (not _queued) with an empty cart has nothing
// at risk (it's safely in the DB, reachable again from the Orders list), so
// leaving the panel blank there is correct, not a bug.
// Returns true if a draft was applied. Must run BEFORE resetPanel() -- not
// after -- since resetPanel()'s own renderCart() call saves a blank draft via
// saveDraft(), which would clobber the very draft this is meant to restore.
function restoreDraftIfAny() {
  const draft = loadDraft();
  const hasUnsentContent = draft && ((draft.cart && draft.cart.length) || (draft.currentOrder && draft.currentOrder._queued));
  if (!hasUnsentContent) { clearDraft(); return false; }

  currentOrder = draft.currentOrder || null;
  cart = draft.cart || [];
  diningOption = draft.diningOption || diningOption;
  tableNumber  = draft.tableNumber || '';
  // A restored real order is still locked to this device (the lock is keyed
  // on the terminal session, which survives a reload) -- restart its idle
  // countdown. The Open Orders poll right after boot clears the panel if the
  // lock actually expired while this tab was gone.
  armOrderIdleTimer();

  getEl('tableNumber').value = tableNumber;
  getEl('tableNumber').classList.remove('invalid');
  renderDiningOptions();
  renderCart();
  updateQtyBadges();
  showToast('Restored unsent order');
  return true;
}

// ─── Cart ─────────────────────────────────────────────────────────────────

function addItemToCart(itemId) {
  const item = catalog.items.find(it => it.id === itemId);
  if (!item) return;
  const existing = cart.find(l => l.source_item_id === itemId);
  if (existing) existing.quantity += 1;
  else cart.push({ source_item_id: itemId, name: item.name, price: item.price, quantity: 1, note: null });
  markOrderActivity();
  updateQtyBadges();
  renderCart();
}

function changeCartQty(idx, delta) {
  const line = cart[idx];
  if (!line) return;
  line.quantity += delta;
  if (line.quantity <= 0) cart.splice(idx, 1);
  markOrderActivity();
  updateQtyBadges();
  renderCart();
}

function removeCartLine(idx) {
  cart.splice(idx, 1);
  markOrderActivity();
  updateQtyBadges();
  renderCart();
}

async function editCartNote(idx) {
  const line = cart[idx];
  if (!line) return;
  const note = await showPrompt(`Note for ${line.name}`, { defaultValue: line.note || '', placeholder: 'e.g. no ice, extra spicy' });
  if (note === null) return;
  line.note = note || null;
  markOrderActivity();
  renderCart();
}

// ─── Cancel Item (POS revision, 2026-08-02) ─────────────────────────────────
// Replaces the old qty stepper + separate remove-line control with a single
// action, available on both Order and Supervisor terminals, on ANY item
// regardless of kitchen_status (pending/preparing/done -- no difference).
let cancelItemTarget = null; // { id, item_name, quantity }

function openCancelItemModal(itemId) {
  if (!currentOrder) return;
  const item = currentOrder.items.find(i => i.id === itemId);
  if (!item) return;
  cancelItemTarget = item;
  getEl('cancelItemName').textContent = `${item.item_name} (qty ${item.quantity})`;
  const qtyInput = getEl('cancelItemQty');
  qtyInput.value = item.quantity;
  qtyInput.max = item.quantity;
  qtyInput.min = 1;
  getEl('cancelItemReason').value = '';
  getEl('cancelItemModal').classList.add('open');
}

function closeCancelItemModal() {
  cancelItemTarget = null;
  getEl('cancelItemModal').classList.remove('open');
}

let confirmCancelItemInFlight = false;
async function confirmCancelItem() {
  if (!currentOrder || !cancelItemTarget || confirmCancelItemInFlight) return;
  const qty = parseInt(getEl('cancelItemQty').value, 10);
  if (!Number.isInteger(qty) || qty < 1 || qty > cancelItemTarget.quantity) {
    showToast(`Enter a quantity between 1 and ${cancelItemTarget.quantity}.`, 'error');
    return;
  }
  confirmCancelItemInFlight = true;
  const btn = getEl('cancelItemConfirmBtn');
  if (btn) btn.disabled = true;
  try {
    const reason = getEl('cancelItemReason').value.trim() || undefined;
    const itemId = cancelItemTarget.id;
    const fullRemoval = qty >= cancelItemTarget.quantity;

    const { ok, data, queued } = await mutate(
      `/api/pos/orders/${currentOrder.id}/items/${itemId}/cancel`, 'POST',
      { qty, reason, client_time: new Date().toISOString() }, { idempotent: true }
    );
    closeCancelItemModal();

    if (queued) {
      // Optimistic local update -- reflect the cancellation immediately,
      // reconciled once the queued call actually syncs.
      const remaining = cancelItemTarget.quantity - qty;
      const items = fullRemoval
        ? currentOrder.items.filter(i => i.id !== itemId)
        : currentOrder.items.map(i => i.id === itemId ? { ...i, quantity: remaining } : i);
      const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
      currentOrder = { ...currentOrder, items, subtotal, total: Math.max(0, subtotal - Number(currentOrder.discount)) };
      renderCart();
      showToast('Offline — cancellation queued, will sync automatically.', 'error');
      return;
    }
    if (ok && data.order) {
      currentOrder = data.order;
      noteLockConfirmed();
      renderCart();
      showToast(fullRemoval ? 'Item removed.' : `Quantity reduced by ${qty}.`);
    } else if (!ok) {
      if (data.code === 'ORDER_TERMINAL') { handleOrderGoneConflict(data.message); return; }
      if (data.code === 'ORDER_LOCKED') { handleOrderLockedConflict(data.message, currentOrder.id); return; }
      showToast(data.message || 'Failed to cancel item.', 'error');
    }
  } finally {
    confirmCancelItemInFlight = false;
    if (btn) btn.disabled = false;
  }
}

function computeTotals() {
  const persistedSubtotal = currentOrder ? Number(currentOrder.subtotal) : 0;
  // Discount can no longer be applied from the POS UI -- only respected here
  // so totals still render correctly for older orders that already have one.
  const persistedDiscount = currentOrder ? Number(currentOrder.discount) : 0;
  const pendingSubtotal   = cart.reduce((sum, l) => sum + l.price * l.quantity, 0);
  const subtotal = persistedSubtotal + pendingSubtotal;
  const total    = Math.max(0, subtotal - persistedDiscount);
  return { subtotal, total, discount: persistedDiscount };
}

function renderCart() {
  const list = getEl('cartList');
  const persisted = currentOrder ? currentOrder.items : [];

  if (!persisted.length && !cart.length) {
    list.innerHTML = '<div id="emptyCartMsg">Cart is empty — tap items to add.</div>';
  } else {
    // Cancel Item is available on any real (already-synced) line regardless
    // of kitchen_status -- pending/preparing/done make no difference. A line
    // with no id yet (still-local, order._queued) has nothing server-side to
    // cancel until its create call syncs.
    const persistedHTML = persisted.map(it => {
      const canCancel = it.id != null;
      return `
        <div class="cart-line sent">
          <div class="cl-info">
            <div class="cl-name">${esc(it.item_name)}</div>
            <div class="cl-price">${khr(it.price)} × ${it.quantity}${it.note ? ` · ${esc(it.note)}` : ''}</div>
          </div>
          <div class="cl-total">${khr(it.price * it.quantity)}</div>
          ${canCancel ? `<button class="cl-remove" type="button" data-sent-cancel="${it.id}" title="Cancel item">✕</button>` : ''}
        </div>
      `;
    }).join('');

    const cartHTML = cart.map((l, idx) => `
      <div class="cart-line">
        <div class="cl-info" data-note-idx="${idx}">
          <div class="cl-name">${esc(l.name)}</div>
          <div class="cl-price">${khr(l.price)}${l.note ? ` · <span class="cl-note">${esc(l.note)}</span>` : ''}</div>
        </div>
        <div class="qty-stepper">
          <button type="button" data-dec="${idx}">−</button>
          <span class="qty-val">${l.quantity}</span>
          <button type="button" data-inc="${idx}">+</button>
        </div>
        <div class="cl-total">${khr(l.price * l.quantity)}</div>
        <button class="cl-remove" type="button" data-remove="${idx}">✕</button>
      </div>
    `).join('');

    list.innerHTML = persistedHTML + cartHTML;

    list.querySelectorAll('[data-inc]').forEach(b => b.addEventListener('click', () => changeCartQty(parseInt(b.dataset.inc), 1)));
    list.querySelectorAll('[data-dec]').forEach(b => b.addEventListener('click', () => changeCartQty(parseInt(b.dataset.dec), -1)));
    list.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => removeCartLine(parseInt(b.dataset.remove))));
    list.querySelectorAll('[data-note-idx]').forEach(el => el.addEventListener('click', () => editCartNote(parseInt(el.dataset.noteIdx))));
    list.querySelectorAll('[data-sent-cancel]').forEach(b => b.addEventListener('click', () => openCancelItemModal(parseInt(b.dataset.sentCancel, 10))));
  }

  const { subtotal, total } = computeTotals();
  getEl('subtotalValue').textContent = khr(subtotal);
  getEl('totalValue').textContent    = khr(total);

  const badge = getEl('orderBadge');
  // Visible for as long as the panel is open -- unlike a toast, which fires
  // once and is easy to miss on a busy counter, this stays on screen so the
  // cashier can tell at a glance why further edits keep bouncing off
  // ORDER_LOCKED (see handleOrderLockedConflict below). The Open Orders list
  // badge (loadOpenOrders' lockBadge) only helps before you open the order --
  // this is the equivalent once you're actually looking at it.
  const lockedByOther = currentOrder && currentOrder.locked_by_terminal_id && !currentOrder.locked_by_me;
  badge.innerHTML = currentOrder
    ? `${currentOrder.name ? esc(currentOrder.name) + ' · ' : ''}<b>${currentOrder.order_number}</b> · ${currentOrder.status.replace(/_/g, ' ')}${lockedByOther ? ` · 🔒 ${esc(currentOrder.locked_by_terminal_name || 'locked by another terminal')}` : ''}`
    : 'New order (not yet sent)';

  // Cancel Order is available on any role, any open order, regardless of
  // kitchen_status (POS revision, 2026-08-02) -- the accountability
  // mechanism is the audit trail, not an access restriction.
  getEl('cancelOrderBtn').style.display = (currentOrder && !['paid', 'cancelled'].includes(currentOrder.status)) ? 'block' : 'none';

  // Saved but not yet sent (either the auto-send on save failed, or this is
  // a previously-saved order reopened from the strip) -- offer a manual
  // retry right where the cashier is already looking.
  const retryBtn = getEl('sendToKitchenRetryBtn');
  if (retryBtn) retryBtn.style.display = (currentOrder && currentOrder.status === 'open') ? 'flex' : 'none';

  saveDraft();
}

// ─── Dining option / table number ──────────────────────────────────────────

function renderDiningOptions() {
  const box = getEl('diningOptions');
  box.innerHTML = config.dining_options.map(opt => `
    <button class="seg-btn ${diningOption === opt ? 'active' : ''}" data-opt="${opt}">${opt}</button>
  `).join('');
  box.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => onDiningOptionSelect(btn.dataset.opt));
  });
}

// Changeable any time, including after the order's been saved -- persists
// the change server-side when there's a real order to update.
async function onDiningOptionSelect(opt) {
  if (opt === diningOption) return;
  diningOption = opt;
  markOrderActivity();
  renderDiningOptions();
  saveDraft();
  if (!currentOrder || currentOrder._queued) return;
  const orderId = currentOrder.id;
  const { ok, data } = await mutate(`/api/pos/orders/${orderId}/dining-option`, 'PATCH', { dining_option: opt, base_version: currentOrder.version });
  // Guard against the panel having moved on to a different (or no) order
  // while this request was in flight -- otherwise order A's response can
  // silently clobber order B back onto the screen.
  if (ok && data.order && currentOrder && currentOrder.id === orderId) {
    currentOrder = data.order;
    renderCart();
    if (data.notice) showToast('This order changed elsewhere — refreshed.', 'error');
  } else if (!ok) {
    if (data.code === 'ORDER_TERMINAL' && currentOrder && currentOrder.id === orderId) { handleOrderGoneConflict(data.message); return; }
    if (data.code === 'ORDER_LOCKED') { handleOrderLockedConflict(data.message, orderId); return; }
    showToast(data.message || 'Failed to update dining option.', 'error');
  }
}

function onSearch(value) { searchTerm = value; renderItemGrid(); }

// Visually calls out the table-# field after a dine-in save was rejected for
// missing it -- a toast alone is easy to miss on a busy counter.
function flagTableNumberRequired() {
  const input = getEl('tableNumber');
  input.classList.add('invalid');
  input.focus();
}

let tableNumberTimer = null;
function onTableNumber(value) {
  tableNumber = value;
  markOrderActivity();
  getEl('tableNumber').classList.remove('invalid');
  saveDraft();
  if (!currentOrder || currentOrder._queued) return; // nothing to persist server-side yet -- included in the save/create call instead
  clearTimeout(tableNumberTimer);
  tableNumberTimer = setTimeout(async () => {
    if (!currentOrder) return; // panel was reset while this was pending
    const orderId = currentOrder.id;
    const { ok, data, queued } = await mutate(`/api/pos/orders/${orderId}/table-number`, 'PATCH', { table_number: tableNumber, base_version: currentOrder.version });
    if (queued) {
      showToast('Offline — table number queued, will sync automatically.', 'error');
      return;
    }
    if (ok && data.order && currentOrder && currentOrder.id === orderId) {
      currentOrder = data.order;
      renderCart();
      if (data.notice) showToast('This order changed elsewhere — refreshed.', 'error');
    } else if (!ok) {
      if (data.code === 'ORDER_TERMINAL' && currentOrder && currentOrder.id === orderId) { handleOrderGoneConflict(data.message); return; }
      if (data.code === 'ORDER_LOCKED') { handleOrderLockedConflict(data.message, orderId); return; }
      showToast(data.message || 'Failed to update table number.', 'error');
    }
  }, 600);
}

// ─── Order lifecycle ───────────────────────────────────────────────────────

function resetPanel() {
  // Cancel any pending debounced table# save -- otherwise it fires later
  // against whatever order (or no order) is on screen by then.
  clearTimeout(tableNumberTimer);
  cancelOrderIdleTimer();
  releaseOrderLock(currentOrder);
  currentOrder = null;
  cart = [];
  diningOption = config.dining_options[0] || null;
  tableNumber  = '';
  getEl('tableNumber').value  = '';
  getEl('tableNumber').classList.remove('invalid');
  renderDiningOptions();
  renderCart();
  updateQtyBadges();
}

// A 409 tagged ORDER_TERMINAL means the order was already paid or cancelled
// (by another terminal, or by this same order finishing through a path this
// panel doesn't know about yet) by the time this action reached the server.
// Continuing to edit it is pointless -- surface a clear reason instead of
// the generic error text, and clear the stale cart/panel instead of leaving
// it on screen inviting another failed retry.
function handleOrderGoneConflict(message) {
  showToast(message || 'This order was already completed or cancelled — clearing this screen.', 'error');
  clearDraft();
  resetPanel();
  loadOpenOrders();
}

// A 409 tagged ORDER_LOCKED means another terminal (or a supervisor override)
// holds this order's edit lock right now. The order itself is still alive
// (unlike ORDER_TERMINAL), but this terminal definitively does NOT hold it,
// so the panel gets cleared the same way -- an order sitting on screen that
// this terminal cannot edit is exactly the state that made the lock look
// like it wasn't enforced. Anything the cashier had staged locally goes with
// it; it was never theirs to send once someone else took the order.
//
// This used to re-fetch and stay on screen instead. The next Open Orders
// poll (see the lock check in loadOpenOrders) would clear it within ~15s
// anyway -- doing it here just makes it immediate and gives the cashier the
// specific reason rather than the generic one.
function handleOrderLockedConflict(message, orderId) {
  showToast(message || 'This order is locked by another terminal right now.', 'error');
  if (!currentOrder || currentOrder.id !== orderId) return;
  clearDraft();
  resetPanel();
  loadOpenOrders();
}

function pendingLinesPayload() {
  return cart.map(l => ({ source_item_id: l.source_item_id, quantity: l.quantity, note: l.note }));
}

// Builds a client-side stand-in for an order whose create call is still
// sitting in the offline queue — no real id yet, so it can't be paid or
// cancelled server-side until the create replays successfully (cancelling
// it just discards the queued create locally, see cancelOrder()). Appending
// MORE items is still possible while _queued -- persistCart() queues those
// as a dependent entry chained on this order's own localId.
function buildLocalOrder(localId, lines) {
  const items = lines.map(l => ({
    id: null, source_item_id: l.source_item_id, item_name: l.name, price: l.price,
    quantity: l.quantity, note: l.note, kitchen_status: 'pending',
  }));
  const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  return {
    id: null, order_number: localId, provisional_number: localId, status: 'open', name: defaultOrderName(),
    dining_option: diningOption, table_number: tableNumber || null,
    subtotal, discount: 0, total: subtotal,
    created_at: cambodiaNaiveNow(), items, _queued: true,
  };
}

// Optimistic local application of newly-added lines onto currentOrder while
// the real append call is still queued -- shared by both the "order itself
// hasn't synced yet" and "order is real but append is offline" paths below.
function applyOptimisticAppend(lines) {
  const newItems = lines.map(l => ({
    id: null, source_item_id: l.source_item_id, item_name: l.name, price: l.price,
    quantity: l.quantity, note: l.note, kitchen_status: 'pending',
  }));
  const subtotal = Number(currentOrder.subtotal) + newItems.reduce((s, i) => s + i.price * i.quantity, 0);
  currentOrder = {
    ...currentOrder,
    items: [...currentOrder.items, ...newItems],
    subtotal, total: Math.max(0, subtotal - Number(currentOrder.discount)),
  };
}

// Persists whatever's in `cart` onto currentOrder — creating it if this is
// a brand-new order, appending if one already exists. Transparently handles
// the offline-queue path (optimistic local state). `ok:false` means a real
// validation/server rejection; `queued:true` means it's stored offline and
// will sync automatically.
async function persistCart() {
  if (!cart.length) return { ok: false, queued: false, message: 'Add items first.' };

  if (!currentOrder) {
    if (!diningOption) return { ok: false, queued: false, message: 'Select dine-in / takeaway.' };
    if (diningOption === config.dine_in_option && !tableNumber.trim()) {
      flagTableNumberRequired();
      return { ok: false, queued: false, message: 'Table # is required for dine-in orders.' };
    }
    const info = getTerminalInfo();
    const localId = nextLocalOrderNumber(info ? info.terminal_id : null);
    const lines = cart.slice();
    const { ok, data, queued } = await mutate('/api/pos/orders', 'POST', {
      dining_option: diningOption, table_number: tableNumber || null,
      items: pendingLinesPayload(),
      provisional_number: localId, client_time: new Date().toISOString(),
    }, { idempotent: true, localId });

    if (queued) {
      currentOrder = buildLocalOrder(localId, lines);
      cart = [];
      return { ok: true, queued: true };
    }
    if (!ok) return { ok: false, queued: false, message: data.message, code: data.code };
    currentOrder = data.order;
    cart = [];
    // The creating terminal holds the lock from the moment the row exists.
    noteLockConfirmed();
    return { ok: true, queued: false };
  }

  const lines = cart.slice();

  if (currentOrder._queued) {
    // The create itself hasn't synced yet -- queue this append as a
    // dependent action rather than refusing outright. The placeholder in
    // the URL is resolved to the real order id the moment the create entry
    // it depends on succeeds (see offlineQueue.js's drainOnce()).
    const localId = currentOrder.order_number;
    await mutate(`/api/pos/orders/{{LOCAL:${localId}}}/items`, 'POST',
      { items: pendingLinesPayload(), client_time: new Date().toISOString() },
      { idempotent: true, dependsOnLocalId: localId });
    applyOptimisticAppend(lines);
    cart = [];
    return { ok: true, queued: true };
  }

  const { ok, data, queued } = await mutate(`/api/pos/orders/${currentOrder.id}/items`, 'POST',
    { items: pendingLinesPayload(), client_time: new Date().toISOString() }, { idempotent: true });
  if (queued) {
    applyOptimisticAppend(lines);
    cart = [];
    return { ok: true, queued: true };
  }
  if (!ok) return { ok: false, queued: false, message: data.message, code: data.code };
  currentOrder = data.order;
  cart = [];
  noteLockConfirmed();
  return { ok: true, queued: false };
}

// Every new order is saved as 'open' first. Attempts to move it on to
// 'sent_to_kitchen' right away; if that specific step fails (network hiccup,
// KDS-side issue), the order itself is never lost -- it just stays 'open'
// and the manual retry button (shown whenever currentOrder.status==='open')
// lets the cashier force it without re-entering anything.
async function attemptSendToKitchen(order) {
  if (!order || order.status !== 'open') return order;
  const { ok, data, queued } = await mutate(`/api/pos/orders/${order.id}/send-to-kitchen`, 'POST', { client_time: new Date().toISOString() });
  if (queued || !ok) return order;
  return data.order;
}

// Guards against a fast double-tap firing two real requests before the
// first one's response lands -- persistCart() mints a fresh
// client_mutation_id per call, so idempotency doesn't dedupe a genuine
// double-submit the way it dedupes a lost-response retry.
let saveOrderInFlight = false;
async function saveOrder() {
  if (saveOrderInFlight) return;
  saveOrderInFlight = true;
  const btn = getEl('saveOrderBtn');
  if (btn) btn.disabled = true;
  try {
    const wasNew = !currentOrder;
    const existingOrderId = currentOrder ? currentOrder.id : null;
    const result = await persistCart();
    if (!result.ok) {
      if (result.code === 'ORDER_TERMINAL') { handleOrderGoneConflict(result.message); return; }
      if (result.code === 'ORDER_LOCKED' && existingOrderId) { handleOrderLockedConflict(result.message, existingOrderId); return; }
      showToast(result.message || 'Failed to save.', 'error');
      return;
    }

    let savedOrder = currentOrder;

    if (result.queued) {
      // Fully offline -- can't attempt the send-to-kitchen call yet since
      // there's no real order id. reconcileLocalOrder() picks this up once
      // the create itself syncs. Still clear the panel -- the order is safely
      // queued (visible in Open Orders), and leaving it on screen just invites
      // the next customer's items to land on top of it by mistake.
      showToast(`Offline — order queued as ${savedOrder.order_number}. Will sync and send automatically.`, 'error');
      clearDraft();
      resetPanel();
      loadOpenOrders();
      return;
    }

    savedOrder = await attemptSendToKitchen(savedOrder);
    currentOrder = savedOrder;

    if (savedOrder.status !== 'open') {
      // Any successfully saved order clears the panel -- whether it was brand
      // new or an existing order reopened and re-saved -- so the next
      // customer never gets typed on top of the previous one by accident.
      showToast(wasNew ? `Sent to kitchen — ${savedOrder.order_number}` : 'Items sent to kitchen.');
      clearDraft();
      resetPanel();
    } else {
      // Couldn't reach the kitchen -- stays on screen so the retry button
      // (shown for status === 'open') is right where the cashier is looking.
      showToast(`Saved as ${savedOrder.order_number} — couldn't reach the kitchen. Tap "Send to Kitchen" to retry.`, 'error');
      renderCart();
    }
    loadOpenOrders();
  } finally {
    saveOrderInFlight = false;
    if (btn) btn.disabled = false;
  }
}

async function retrySendToKitchen() {
  if (!currentOrder || currentOrder.status !== 'open') return;
  const sent = await attemptSendToKitchen(currentOrder);
  currentOrder = sent;
  if (sent.status !== 'open') {
    showToast(`Sent to kitchen — ${sent.order_number}`);
    clearDraft();
    resetPanel();
  } else {
    showToast('Still could not reach the kitchen. Try again.', 'error');
    renderCart();
  }
  loadOpenOrders();
}

// Flushes any pending cart lines into a real order (creating it if needed)
// so the pay endpoint always has an order id to act on. Refuses to proceed
// if the order is still offline-queued (no real id to pay against yet).
async function ensureOrderPersisted() {
  if (currentOrder && currentOrder._queued) {
    showToast("This order hasn't synced yet — it'll retry automatically.", 'error');
    return false;
  }
  if (currentOrder && !cart.length) return true;

  const existingOrderId = currentOrder ? currentOrder.id : null;
  const result = await persistCart();
  if (!result.ok) {
    if (result.code === 'ORDER_TERMINAL') { handleOrderGoneConflict(result.message); return false; }
    if (result.code === 'ORDER_LOCKED' && existingOrderId) { handleOrderLockedConflict(result.message, existingOrderId); return false; }
    showToast(result.message || 'Failed to create order.', 'error');
    return false;
  }
  if (result.queued) {
    showToast(`Offline — order queued as ${currentOrder.order_number}. Pay once it syncs.`, 'error');
    return false;
  }
  loadOpenOrders();
  return true;
}

async function openPayModal() {
  const ready = await ensureOrderPersisted();
  if (!ready) return;
  renderCart();

  getEl('payModalBody').style.display = '';
  getEl('paySuccessView').style.display = 'none';

  selectedPayMethod = null;
  cashReceived = 0;
  getEl('cashReceivedInput').value = '';
  getEl('cashReceivedInput').placeholder = 'Cash received';
  getEl('cashSection').classList.remove('show');
  getEl('cashExactBtn').style.display = '';
  getEl('changeLabel').textContent = 'Change';
  getEl('payConfirmBtn').disabled = true;
  getEl('payModalTotal').textContent = khr(computeTotals().total);

  // Offline: cash only -- there's no way to verify a QR scan without
  // connectivity, so khqr/both aren't offered while the queue is holding
  // this device's requests.
  const availableMethods = isOffline() ? config.payment_methods.filter(m => m.code === 'cash') : config.payment_methods;
  const box = getEl('payMethodButtons');
  box.innerHTML = availableMethods.map(m => `
    <button type="button" class="pay-method-btn" data-code="${m.code}">${m.label}</button>
  `).join('');
  box.querySelectorAll('.pay-method-btn').forEach(btn => {
    btn.addEventListener('click', () => selectPayMethod(btn.dataset.code));
  });

  updateChange();
  getEl('payModal').classList.add('open');
}

function closePayModal() { getEl('payModal').classList.remove('open'); }

function selectPayMethod(code) {
  selectedPayMethod = code;
  document.querySelectorAll('.pay-method-btn').forEach(b => b.classList.toggle('active', b.dataset.code === code));
  getEl('cashSection').classList.toggle('show', code === 'cash' || code === 'both');
  getEl('cashExactBtn').style.display = code === 'both' ? 'none' : '';
  getEl('cashReceivedInput').placeholder = code === 'both' ? 'Cash portion' : 'Cash received';
  updateChange();
}

function onCashReceived(value) { cashReceived = Math.max(0, Number(value) || 0); updateChange(); }
function cashQuick(amount)     { cashReceived += amount; getEl('cashReceivedInput').value = cashReceived; updateChange(); }
function cashExact()           { cashReceived = computeTotals().total; getEl('cashReceivedInput').value = cashReceived; updateChange(); }

function updateChange() {
  const total = computeTotals().total;
  const changeLabel = getEl('changeLabel');
  let valid = false;

  if (selectedPayMethod === 'cash') {
    changeLabel.textContent = 'Change';
    getEl('changeValue').textContent = khr(Math.max(0, cashReceived - total));
    valid = cashReceived >= total;
  } else if (selectedPayMethod === 'both') {
    changeLabel.textContent = 'QR amount';
    getEl('changeValue').textContent = khr(Math.max(0, total - cashReceived));
    valid = cashReceived > 0 && cashReceived < total;
  } else if (selectedPayMethod === 'khqr') {
    valid = true;
  }
  getEl('payConfirmBtn').disabled = !valid;

  const hint = getEl('payHint');
  if (!selectedPayMethod) hint.textContent = 'Select a payment method to continue.';
  else if (selectedPayMethod === 'cash' && cashReceived < total) hint.textContent = 'Enter cash received — must be at least the total.';
  else if (selectedPayMethod === 'both' && !valid) hint.textContent = 'Enter the cash portion — must be more than 0 and less than the total; the rest is paid by QR.';
  else hint.textContent = '';
}

// Payment requires a supervisor terminal, enforced server-side by
// requireTerminalRole -- the Pay button itself only exists on a supervisor
// terminal (see applyRoleUI), but a queued pay replaying after a dashboard
// role change still needs a friendly surface instead of a raw 403.
let confirmPayInFlight = false;
async function confirmPay() {
  if (!currentOrder || !selectedPayMethod || confirmPayInFlight) return;
  confirmPayInFlight = true;
  const btn = getEl('payConfirmBtn');
  if (btn) btn.disabled = true;
  try {
  const total = computeTotals().total;
  const body = { payment_method: selectedPayMethod, client_time: new Date().toISOString() };
  if (selectedPayMethod === 'cash') body.cash_received = cashReceived;
  if (selectedPayMethod === 'both') {
    body.cash_received = cashReceived;
    body.khqr_received = total - cashReceived;
  }

  const { ok, status, data, queued } = await mutate(`/api/pos/orders/${currentOrder.id}/pay`, 'POST', body, { idempotent: true });

  if (queued) {
    // Optimistic: the network is down, not the till — let the cashier keep
    // moving and reconcile once the pay call replays successfully.
    const change = selectedPayMethod === 'cash' ? Math.max(0, cashReceived - total) : 0;
    const optimisticOrder = {
      ...currentOrder, status: 'paid', payment_method: selectedPayMethod,
      cash_received: (selectedPayMethod === 'cash' || selectedPayMethod === 'both') ? cashReceived : null,
    };
    showToast(`Offline — payment queued for ${currentOrder.order_number}.`, 'error');
    showPaySuccess(optimisticOrder, change);
    loadOpenOrders();
    return;
  }

  if (!ok) {
    if (status === 403) { closePayModal(); showSupervisorRequiredDialog(); return; }
    if (data.code === 'ORDER_TERMINAL') { closePayModal(); handleOrderGoneConflict(data.message); return; }
    showToast(data.message || 'Payment failed.', 'error');
    return;
  }

  showToast(`Paid — ${data.order.order_number}`);
  showPaySuccess(data.order, data.change);
  loadOpenOrders();
  } finally {
    confirmPayInFlight = false;
    if (btn) btn.disabled = false;
  }
}

function showPaySuccess(order, change) {
  lastPaidOrder = order;
  getEl('payModalBody').style.display = 'none';
  getEl('paySuccessView').style.display = 'block';
  getEl('paySuccessOrderNo').textContent = `${order.order_number} · ${PAY_METHOD_LABELS[order.payment_method] || order.payment_method}`;
  getEl('paySuccessChange').textContent = change ? `Change ${khr(change)}` : '';
  // No printing happens automatically -- this is a viewable receipt only;
  // "Print Receipt" below sends it to the printer/bridge on demand.
  getEl('paySuccessReceiptFrame').srcdoc = receiptHTML(order);
}

function reprintReceipt() {
  if (lastPaidOrder) printReceipt(lastPaidOrder);
}

function donePay() {
  closePayModal();
  clearDraft();
  resetPanel();
}

let cancelOrderInFlight = false;
async function cancelOrder() {
  if (orderLoading) { showToast('Still loading the order — try again in a moment.', 'error'); return; }
  if (!currentOrder || cancelOrderInFlight) return;
  cancelOrderInFlight = true;
  try {
    if (currentOrder._queued) {
      // Nothing has ever reached the server for this order -- just drop its
      // still-pending create (and anything chained to it) instead of queuing
      // yet another call that would otherwise create-then-immediately-cancel
      // a real order once connectivity returns.
      const ok = await showConfirm("This order hasn't synced yet — discard it?", { danger: true, confirmText: 'Discard' });
      if (!ok) return;
      await cancelQueuedLocalOrder(currentOrder.order_number);
      showToast('Discarded — never sent.');
      clearDraft();
      resetPanel();
      loadOpenOrders();
      return;
    }

    const reason = await showPrompt('Cancel this order? This cannot be undone.', {
      title: 'Cancel Order', danger: true, confirmText: 'Cancel Order',
      placeholder: 'Reason for cancellation (optional)',
    });
    if (reason === null) return; // dismissed the dialog itself

    const res = await mutate(`/api/pos/orders/${currentOrder.id}/cancel`, 'POST', { reason, client_time: new Date().toISOString() });
    if (res.queued) {
      showToast('Offline — cancellation queued, will sync automatically.', 'error');
      clearDraft();
      resetPanel();
      loadOpenOrders();
      return;
    }
    if (!res.ok) {
      if (res.data.code === 'ORDER_TERMINAL') { handleOrderGoneConflict(res.data.message); return; }
      showToast(res.data.message || 'Failed to cancel order.', 'error');
      return;
    }
    showToast('Order cancelled.');
    clearDraft();
    resetPanel();
    loadOpenOrders();
  } finally {
    cancelOrderInFlight = false;
  }
}

// Order-terminal counterpart to Pay -- pushes the order to awaiting_payment
// instead of completing it, so a supervisor terminal picks up payment from
// its To Settle list. No role gate: any order terminal may bill an order it
// or another order terminal took.
async function readyToBill() {
  const ready = await ensureOrderPersisted();
  if (!ready) return;
  const total = computeTotals().total;
  const ok = await showConfirm(`Ready to bill ${currentOrder.order_number} — total ${khr(total)}?`, { confirmText: 'Ready to Bill' });
  if (!ok) return;

  const { ok: success, status, data, queued } = await mutate(
    `/api/pos/orders/${currentOrder.id}/ready-to-bill`, 'POST',
    { client_time: new Date().toISOString() }, { idempotent: true }
  );

  if (queued) {
    showToast(`Offline — will be billed once a supervisor is reached, ${currentOrder.order_number} queued.`, 'error');
    clearDraft();
    resetPanel();
    loadOpenOrders();
    return;
  }
  if (!success) {
    if (status === 403) { showSupervisorRequiredDialog(); return; }
    if (data.code === 'ORDER_TERMINAL') { handleOrderGoneConflict(data.message); return; }
    showToast(data.message || 'Failed to mark ready to bill.', 'error');
    return;
  }
  showToast(`${data.order.order_number} sent for billing.`);
  clearDraft();
  resetPanel();
  loadOpenOrders();
}

// ─── Open orders strip ──────────────────────────────────────────────────────

function applyOrderToPanel(order) {
  currentOrder = order;
  // Opening an order counts as touching it -- start its idle countdown from
  // here, so an order loaded and then left alone releases itself on time.
  armOrderIdleTimer();
  cart = [];
  diningOption = order.dining_option;
  tableNumber  = order.table_number || '';
  getEl('tableNumber').value   = tableNumber;
  getEl('tableNumber').classList.remove('invalid');
  renderDiningOptions();
  renderCart();
  updateQtyBadges();
}

// table_number always shown when present -- it must never be hidden behind
// a custom order name, since "which table is this" is the one thing a
// cashier or runner needs at a glance. Falls back to the dining option
// (e.g. "Takeaway") when there's no table to show.
function orderTableLabel(o) {
  return o.table_number ? `Table ${o.table_number}` : (o.dining_option || '');
}

// Maps the order's kitchen-facing state to the four labels requested:
// Pending -> Cooking -> Ready -> Finished. 'sent_to_kitchen' covers two
// distinct situations that both read as "kitchen hasn't started yet" but
// differ in history -- a genuinely fresh order, vs. one that was already
// ready/served and just had new items appended to it (see the reactivation
// branch, logged as 'items_added' with detail.reactivated:true, in POST
// /orders/:id/items) -- the latter carries a mix of already-'done' and
// freshly-'pending' items, which
// is exactly what distinguishes it from a first-time send.
function orderStatusLabel(o) {
  if (o.status === 'awaiting_payment') return { text: 'Awaiting Payment', cls: 'awaiting-payment' };
  if (o.status === 'served')    return { text: 'Finished', cls: 'finished' };
  if (o.status === 'ready')     return { text: 'Ready',    cls: 'ready' };
  if (o.status === 'preparing') return { text: 'Cooking',  cls: 'cooking' };
  if (o.status === 'sent_to_kitchen') {
    const items = o.items || [];
    const hasDone    = items.some(i => i.kitchen_status === 'done');
    const hasPending = items.some(i => i.kitchen_status === 'pending');
    if (hasDone && hasPending) return { text: 'Pending · new items', cls: 'pending-new' };
    return { text: 'Pending', cls: 'pending' };
  }
  return { text: 'Pending', cls: 'pending' }; // 'open' -- not yet sent to kitchen at all
}

function orderElapsedBaseMs(o) {
  const ts = o.sent_to_kitchen_at || o.created_at;
  return ts ? new Date(ts).getTime() : null;
}

function formatSittingTime(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  if (totalMin < 60) return `${totalMin}m`;
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

// Toggled by the "To Settle" entry point (supervisor terminals only) --
// reuses this same fetch/modal instead of a separate polling pipeline,
// just pre-filtered to what a supervisor is settling. See openToSettle().
let settleModeActive = false;

// fetchJSON resolves to null on ANY non-2xx (403/500/network blip alike) with
// no toast of its own -- flagged once per failure streak (not every 15s poll
// tick) so a genuine outage/permission problem is visible instead of just
// quietly rendering "No open orders." forever.
let openOrdersLoadFailed = false;
async function loadOpenOrders() {
  // Stamped before the request goes out so a response that was already in
  // flight when we (re)claimed an order can't be read as "we lost the lock"
  // -- it simply predates the claim. See lockConfirmedAt.
  const requestedAt = Date.now();
  const data = await fetchJSON('/api/pos/orders?status=active');
  if (!data) {
    if (!openOrdersLoadFailed && !isOffline()) showToast('Could not refresh open orders — check connection.', 'error');
    openOrdersLoadFailed = true;
    return;
  }
  openOrdersLoadFailed = false;
  const orders = data.orders.slice();
  if (data.server_now) ordersClockOffsetMs = new Date(data.server_now).getTime() - Date.now();

  // Server is the authority on who holds the lock: if the order in the panel
  // comes back not-ours, this terminal lost it (taken over, or expired) and
  // must clear it. Only acts on an order actually present in the response --
  // an absent one has left the active list entirely (paid/cancelled), which
  // the ORDER_TERMINAL paths already handle with a more specific message.
  if (currentOrder && currentOrder.id && !currentOrder._queued && requestedAt > lockConfirmedAt) {
    const mine = orders.find(o => o.id === currentOrder.id);
    if (mine && !mine.locked_by_me) handleOrderLockLost(mine);
  }
  // The server has no idea a still-offline order exists yet — keep it
  // visible in the list locally until its create call reconciles.
  if (currentOrder && currentOrder._queued && !orders.some(o => o.order_number === currentOrder.order_number)) {
    orders.unshift(currentOrder);
  }

  const countEl = getEl('openOrdersCount');
  countEl.textContent = orders.length || '';
  countEl.dataset.count = String(orders.length);

  const toSettle = orders.filter(o => o.status === 'awaiting_payment');
  const settleCountEl = getEl('toSettleCount');
  if (settleCountEl) {
    settleCountEl.textContent = toSettle.length || '';
    settleCountEl.dataset.count = String(toSettle.length);
  }

  // Rebuilt every poll cycle regardless of whether the modal is open --
  // matches the previous strip's behavior and keeps the list correct the
  // instant it's opened, without a separate "is this visible" check.
  const shownOrders = settleModeActive
    ? [...toSettle, ...orders.filter(o => o.status === 'served')]
        .sort((a, b) => (orderElapsedBaseMs(a) || 0) - (orderElapsedBaseMs(b) || 0)) // oldest first
    : orders;

  const list = getEl('openOrdersList');
  if (!shownOrders.length) {
    list.innerHTML = `<div style="text-align:center;color:var(--text-secondary);padding:20px 0;">${settleModeActive ? 'Nothing to settle.' : 'No open orders.'}</div>`;
    return;
  }
  list.innerHTML = '';
  shownOrders.forEach(o => {
    const row = document.createElement('div');
    row.className = 'order-row-item';
    const title = o.name ? esc(o.name) : o.order_number;
    const tableLabel = esc(orderTableLabel(o));
    const status = orderStatusLabel(o);
    const baseMs = orderElapsedBaseMs(o);
    const elapsedText = baseMs ? formatSittingTime(Date.now() + ordersClockOffsetMs - baseMs) : '';
    // locked_by_me is computed server-side (maskStaleLock in routes/pos.js):
    // the lock is identified by terminal_devices.id, a session id this
    // browser never sees, so the client cannot decide ownership itself.
    // Comparing terminal ids here instead -- as this did before -- made two
    // windows signed in under the SAME terminal code each think the lock was
    // their own, hiding the badge from both (see migration 027).
    //
    // GET /orders also already masks an expired lock back to null, so a
    // genuinely stale lock never reaches this badge. What can still show for
    // up to one poll cycle (~15s) is a lock released moments ago; the real
    // enforcement is always the server-side check on claim/edit.
    const lockedByOther = o.locked_by_terminal_id && !o.locked_by_me;
    const lockBadge = lockedByOther ? ` · 🔒 ${esc(o.locked_by_terminal_name || 'another terminal')}` : '';
    row.innerHTML = `
      <div>
        <div class="or-title">${title}</div>
        <div class="or-sub">
          ${tableLabel ? `${tableLabel} · ` : ''}<span class="or-status-badge status-${status.cls}">${esc(status.text)}</span>${elapsedText ? ` · ${elapsedText}` : ''}${o._queued ? ' · offline' : ''}${lockBadge}
        </div>
      </div>
      <span class="or-total">${khr(o.total)}</span>
      <button class="chip-reprint" type="button" title="Reprint kitchen ticket">🖨</button>
    `;
    row.addEventListener('click', () => {
      if (o._queued) applyOrderToPanel(o);
      else loadOrderIntoPanel(o.id, o);
      closeOrdersModal();
    });
    row.querySelector('.chip-reprint').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (o._queued) { printKitchenTicket(o, { offline: true }); return; }
      const fresh = await fetchJSON(`/api/pos/orders/${o.id}`);
      if (fresh) printKitchenTicket(fresh.order);
    });
    list.appendChild(row);
  });
}

function openOrdersModal() {
  settleModeActive = false;
  getEl('ordersModalTitle').textContent = 'Open Orders';
  loadOpenOrders();
  getEl('ordersModal').classList.add('open');
}
function openToSettle() {
  settleModeActive = true;
  getEl('ordersModalTitle').textContent = 'To Settle';
  loadOpenOrders();
  getEl('ordersModal').classList.add('open');
}
function closeOrdersModal() {
  settleModeActive = false;
  getEl('ordersModal').classList.remove('open');
}

// Claims the order-edit lock and opens it into the panel in one round trip
// (the claim response carries the full fresh order, same shape as the old
// plain GET this replaced). `fallbackOrder` is the summary row already on
// screen from the last Open Orders poll -- used only if the claim can't
// reach the server at all, so a genuinely offline terminal can still fall
// back to best-effort local editing instead of being blocked outright (there
// is no one to coordinate a lock with if this terminal can't reach the
// server anyway).
async function loadOrderIntoPanel(id, fallbackOrder, { force = false } = {}) {
  if (orderLoading) return;
  // Whatever this panel was holding before, released only once the new claim
  // has actually succeeded (see below). Releasing it up front -- as this did
  // until 2026-08-05 -- meant tapping an order that turned out to be locked
  // by someone else cost the cashier the order they already had, and left
  // them with nothing.
  const previous = (currentOrder && currentOrder.id && currentOrder.id !== id) ? currentOrder : null;
  orderLoading = true;
  const { ok, status, data, networkError } = await terminalApiPost(
    `/api/pos/orders/${id}/claim`, force ? { force: true } : undefined);
  orderLoading = false;

  if (networkError) {
    if (fallbackOrder) applyOrderToPanel(fallbackOrder);
    else showToast('Offline — could not open that order.', 'error');
    return;
  }
  if (!ok) {
    if (status === 409 && data.code === 'ORDER_TERMINAL') {
      showToast(data.message || 'This order was already completed or cancelled.', 'error');
      loadOpenOrders();
    } else if (status === 409 && data.code === 'ORDER_LOCKED') {
      // Deliberately a modal, not a toast: the cashier just tapped this order
      // expecting it to open, and nothing visible happens otherwise. Refresh
      // the list behind it so the 🔒 badge is up to date when they look back.
      await showAlert(data.message || 'Another terminal has this order open right now.',
        { title: 'Order locked' });
      loadOpenOrders();
    } else if (status === 409 && data.code === 'ORDER_LOCKED_OVERRIDABLE') {
      // Supervisor-only path: the order is genuinely open on someone else's
      // terminal. Taking it over is allowed but is a real decision (the other
      // cashier loses it mid-edit), so it's an explicit confirm + an audited
      // lock_overridden event -- never the silent seizure it used to be.
      const ok2 = await showConfirm(data.message || 'Another terminal has this order open. Take it over?', {
        danger: true, confirmText: 'Take over',
      });
      if (ok2) await loadOrderIntoPanel(id, fallbackOrder, { force: true });
      return;
    } else {
      // Covers ORDER_LOCKED (another terminal has it open) and any other
      // rejection alike -- the message from the server is already specific.
      showToast(data.message || 'Could not open that order — try again.', 'error');
    }
    return;
  }
  if (data.took_over) showToast('Taken over from another terminal — they have been locked out of it.', 'error');
  releaseOrderLock(previous);
  applyOrderToPanel(data.order);
  noteLockConfirmed();
}

// ─── Order idle release (2026-08-05) ────────────────────────────────────────
// This used to be a blind 15s heartbeat fired from loadOpenOrders(), which
// meant an order stayed locked to this terminal for as long as the tab was
// merely open -- a cashier who loaded an order and walked away held it
// forever and no other POS could ever take it. The lock is now renewed only
// by real work on the order, and after order_lock_ttl_seconds of no such
// work this terminal releases it AND clears it off its own screen, so the
// two sides never disagree about who has it.
//
// What counts as work: opening the order, staging/removing/reordering a cart
// line, editing a line note, changing table # or dining option, appending or
// cancelling items, sending to kitchen. Server-side mutations refresh
// locked_at themselves (touchLock in routes/pos.js) -- the claim call here
// exists for purely LOCAL activity (staging cart lines that aren't persisted
// until Save), which the server would otherwise never hear about.
const ORDER_LOCK_TTL_FALLBACK_MS   = 5 * 60 * 1000; // until /config lands
const LOCK_RENEW_MIN_INTERVAL_MS   = 30 * 1000;

let orderIdleTimer        = null;
let lastLockRenewAt       = 0;
let lockRenewTrailingTimer = null;
// When the server last CONFIRMED this terminal holds the panel's order. Any
// Open Orders response that was requested before this moment is older than
// that confirmation and must not be trusted to say the lock is gone.
let lockConfirmedAt       = 0;

function orderLockTtlMs() {
  const secs = Number(config.order_lock_ttl_seconds);
  return secs > 0 ? secs * 1000 : ORDER_LOCK_TTL_FALLBACK_MS;
}

// Not awaited and its failure is non-fatal: if the lock was taken by a
// supervisor override or genuinely expired, the next real edit surfaces a
// clear 409 ORDER_LOCKED and the Open Orders poll clears the panel -- better
// than this ripping an in-progress cart away over one dropped request.
function renewOrderLockNow() {
  if (!currentOrder || !currentOrder.id || currentOrder._queued) return;
  lastLockRenewAt = Date.now();
  const id = currentOrder.id;
  terminalApiPost(`/api/pos/orders/${id}/claim`).then(r => {
    if (r && r.ok && currentOrder && currentOrder.id === id) lockConfirmedAt = Date.now();
  }).catch(() => { /* fire-and-forget: the poll and the next edit both re-check */ });
}

// Throttled so a burst of taps on the item grid doesn't fire a claim per tap.
// The trailing call matters: without it, activity that lands inside a
// throttle window never reaches the server at all, and locked_at could sit
// up to LOCK_RENEW_MIN_INTERVAL_MS behind what this terminal believes.
function renewOrderLockThrottled() {
  if (!currentOrder || !currentOrder.id || currentOrder._queued) return;
  const since = Date.now() - lastLockRenewAt;
  if (since >= LOCK_RENEW_MIN_INTERVAL_MS) { renewOrderLockNow(); return; }
  if (lockRenewTrailingTimer) return;
  lockRenewTrailingTimer = setTimeout(() => {
    lockRenewTrailingTimer = null;
    renewOrderLockNow();
  }, LOCK_RENEW_MIN_INTERVAL_MS - since);
}

function cancelOrderIdleTimer() {
  clearTimeout(orderIdleTimer);
  clearTimeout(lockRenewTrailingTimer);
  orderIdleTimer = lockRenewTrailingTimer = null;
}

// Restarts the countdown without talking to the server. For activity the
// server already knows about -- a successful claim, or any mutation, all of
// which refresh locked_at themselves via touchLock().
function armOrderIdleTimer() {
  cancelOrderIdleTimer();
  if (!currentOrder || !currentOrder.id || currentOrder._queued) return;
  orderIdleTimer = setTimeout(releaseIdleOrder, orderLockTtlMs());
}

// The server just told us, in a response, that we hold this order. Arms the
// countdown and closes the race window on in-flight Open Orders polls.
function noteLockConfirmed() {
  lockConfirmedAt = lastLockRenewAt = Date.now();
  armOrderIdleTimer();
}

// Call from every path where the cashier did something to the order in the
// panel that the server has NOT been told about (local cart staging, a
// debounced field edit not yet sent). Safe to call with no order / an
// offline-queued one -- it just stands the timer down.
function markOrderActivity() {
  armOrderIdleTimer();
  renewOrderLockThrottled();
}

function releaseIdleOrder() {
  if (!currentOrder || !currentOrder.id || currentOrder._queued) return;
  const label   = currentOrder.name || currentOrder.order_number;
  const minutes = Math.round(orderLockTtlMs() / 60000);
  clearDraft();
  resetPanel(); // releases the lock server-side
  loadOpenOrders();
  showToast(`${label} released after ${minutes} min with no changes — it's open to other terminals again.`, 'error');
}

// Another terminal now holds (or nobody holds) an order this panel still has
// on screen: a supervisor took it over, or the server expired our lock while
// this tab was backgrounded and its idle timer throttled. Either way this
// terminal must not keep showing an order it can no longer edit.
function handleOrderLockLost(order) {
  const label = order.name || order.order_number;
  const takenBy = order.locked_by_terminal_id ? (order.locked_by_terminal_name || 'another terminal') : null;
  clearDraft();
  resetPanel();
  showToast(takenBy
    ? `${label} was taken over by ${takenBy} — cleared from this terminal.`
    : `${label} was released after a period with no changes — cleared from this terminal.`, 'error');
}

// A backgrounded tab's timers are throttled to roughly once a minute, so the
// idle release above can fire late. Re-check against the server the moment
// the cashier comes back rather than trusting the local clock alone.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadOpenOrders();
});

// Best-effort courtesy release so the next terminal doesn't have to wait out
// the TTL -- not required for correctness (isLockStale() server-side is the
// real backstop), so this is fire-and-forget and never queued offline.
function releaseOrderLock(order) {
  if (!order || !order.id || order._queued) return;
  terminalApiPost(`/api/pos/orders/${order.id}/release`);
}

// ─── Offline queue wiring ───────────────────────────────────────────────────

async function reconcileLocalOrder(localId, realOrder) {
  // The create call itself just came back online -- now that there's a real
  // id, follow through on the same auto-send-to-kitchen attempt the online
  // path makes right after saving.
  const order = await attemptSendToKitchen(realOrder);

  if (currentOrder && currentOrder.order_number === localId) {
    currentOrder = order;
    renderCart();
  }
  showToast(order.status === 'open'
    ? `Order synced as ${order.order_number} — couldn't reach the kitchen, tap "Send to Kitchen" to retry.`
    : `Order synced — ${order.order_number}`);
  loadOpenOrders();
}

onReplaySuccess((entry, data) => {
  if (entry.localId && data && data.order) reconcileLocalOrder(entry.localId, data.order);
  else loadOpenOrders();
  // A queued edit that landed on a since-changed order still applied
  // (last-write-wins) -- surface the same non-blocking notice a live edit
  // would have gotten, instead of silently vanishing into the sync log.
  if (data && data.notice) showToast('A queued change was applied on top of a newer version of the order.', 'error');
});

// A queued request that replays and comes back genuinely rejected (not just
// unreachable) never becomes a real order -- without this, a local order
// stuck as `_queued` would block persistCart() forever with no way out
// short of a page refresh, silently losing the cart in the process.
onReplayRejected((entry, data) => {
  if (entry.localId) {
    if (currentOrder && currentOrder.order_number === entry.localId) {
      cart = currentOrder.items.map(i => ({
        source_item_id: i.source_item_id, name: i.item_name, price: i.price,
        quantity: i.quantity, note: i.note,
      }));
      currentOrder = null;
      renderCart();
    }
    showToast(`Order ${entry.localId} couldn't be saved: ${data.message || 'rejected by the server'}. Please check and save again.`, 'error');
  } else {
    showToast(data.message ? `A queued change was rejected: ${data.message}` : 'A queued change was rejected by the server.', 'error');
  }
  loadOpenOrders();
});

onConnectivityChange(() => updateStatusChip());

onQueueChange((pendingCount, deadCount) => updateStatusChip(pendingCount, deadCount));

onDeadLetter(entry => {
  showToast(`Needs attention: ${entry.lastError || 'a queued change was rejected'} — check the sync panel.`, 'error');
});

onSyncSummary(({ synced, deadLettered }) => {
  if (!synced && !deadLettered) return;
  const parts = [];
  if (synced) parts.push(`${synced} synced`);
  if (deadLettered) parts.push(`${deadLettered} need${deadLettered === 1 ? 's' : ''} attention`);
  showToast(parts.join(', '), deadLettered ? 'error' : 'success');
});

onQueueNearLimit(count => {
  showToast(`Offline queue is getting large (${count} items) — reconnect soon to avoid losing headroom.`, 'error');
});

// ─── Sync status chip + panel ───────────────────────────────────────────────

async function updateStatusChip(pendingCount, deadCount) {
  const chip = getEl('syncStatusChip');
  if (!chip) return;
  if (pendingCount === undefined || deadCount === undefined) {
    const snap = await getQueueSnapshot();
    pendingCount = snap.pending.length;
    deadCount = snap.dead.length;
  }
  let label, cls;
  if (isOffline()) {
    label = `⚠ Offline${pendingCount ? ` — ${pendingCount} queued` : ''}`;
    cls = 'chip-offline';
  } else if (deadCount) {
    label = `⚠ ${deadCount} need${deadCount === 1 ? 's' : ''} attention`;
    cls = 'chip-attention';
  } else if (pendingCount) {
    label = `↻ Syncing — ${pendingCount} queued`;
    cls = 'chip-syncing';
  } else {
    label = '● Online';
    cls = 'chip-online';
  }
  chip.textContent = label;
  chip.className = `sync-status-chip ${cls}`;
}

function fmtLastSync() {
  const t = getLastSyncAt();
  if (!t) return 'Not synced yet this session';
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return 'Last synced just now';
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `Last synced ${min}m ago`;
  const hr = Math.floor(min / 60);
  return `Last synced ${hr}h ${min % 60}m ago`;
}

// Trims a queue entry's URL down to something readable in the panel without
// exposing the full /api/pos prefix or numeric ids nobody on the floor cares about.
function summarizeUrl(url) {
  return url.replace('/api/pos', '').replace(/^\/orders\//, 'order ').replace(/^\/order-items\//, 'item ');
}

async function renderSyncPanel() {
  const { pending, dead } = await getQueueSnapshot();
  getEl('syncPanelLastSync').textContent = fmtLastSync();

  const pendingList = getEl('syncPanelPending');
  pendingList.innerHTML = pending.length
    ? pending.map(e => `
        <div class="sync-item">
          <div class="sync-item-main">${esc(e.method)} ${esc(summarizeUrl(e.url))}</div>
          <div class="sync-item-sub">${e.dependsOnLocalId ? `waiting on ${esc(e.dependsOnLocalId)}` : (e.attempt ? `retry attempt ${e.attempt}` : 'queued')}</div>
        </div>`).join('')
    : '<div class="sync-empty">Nothing queued.</div>';

  const deadList = getEl('syncPanelDead');
  deadList.innerHTML = dead.length
    ? dead.map(e => `
        <div class="sync-item sync-item--dead">
          <div class="sync-item-main">${esc(e.method)} ${esc(summarizeUrl(e.url))}</div>
          <div class="sync-item-sub">${esc(e.lastError || 'Rejected')}</div>
          <div class="sync-item-actions">
            <button type="button" class="inv-btn" data-retry="${e.id}">Retry</button>
            <button type="button" class="inv-btn" data-discard="${e.id}">Discard</button>
          </div>
        </div>`).join('')
    : '<div class="sync-empty">Nothing needs attention.</div>';

  deadList.querySelectorAll('[data-retry]').forEach(b => b.addEventListener('click', async () => {
    await retryDeadLetter(parseInt(b.dataset.retry, 10));
    await syncNow();
    await renderSyncPanel();
  }));
  deadList.querySelectorAll('[data-discard]').forEach(b => b.addEventListener('click', async () => {
    const ok = await showConfirm('Discard this item? This cannot be undone.', { danger: true, confirmText: 'Discard' });
    if (!ok) return;
    await discardDeadLetter(parseInt(b.dataset.discard, 10));
    await renderSyncPanel();
  }));
}

async function openSyncPanel() {
  await renderSyncPanel();
  getEl('syncPanelModal').classList.add('open');
}
function closeSyncPanel() { getEl('syncPanelModal').classList.remove('open'); }

async function manualSyncNow() {
  const btn = getEl('syncNowBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
  await syncNow();
  await renderSyncPanel();
  loadOpenOrders();
  if (btn) { btn.disabled = false; btn.textContent = 'Sync now'; }
}

window.posOpenSyncPanel  = openSyncPanel;
window.posCloseSyncPanel = closeSyncPanel;
window.posManualSyncNow  = manualSyncNow;

// ─── Printer settings popover ───────────────────────────────────────────────

function openSettings() {
  getEl('bridgeUrlInput').value = getBridgeUrl();
  getEl('settingsModal').classList.add('open');
}

function closeSettings() {
  getEl('settingsModal').classList.remove('open');
}

function saveSettings() {
  const url = getEl('bridgeUrlInput').value.trim();
  setBridgeUrl(url);
  showToast(url ? 'Print bridge saved — printing via LAN.' : 'Print bridge cleared — using browser printing.');
  closeSettings();
}

// ─── Receipts view ──────────────────────────────────────────────────────────

let receiptsCache = [];

function receiptToPrintableOrder(receipt) {
  // Adapts a pos_receipts row (Task 5's GET /receipts/:id shape) into the
  // order-shaped object receiptHTML() from print.js already knows how to render.
  return {
    order_number:   receipt.order_number || receipt.receipt_number,
    paid_at:        receipt.receipt_date,
    created_at:     receipt.receipt_date,
    table_number:   receipt.table_number,
    dining_option:  receipt.dining_option,
    items:          (receipt.items || []).map(it => ({ item_name: it.item_name, price: it.price, quantity: it.quantity, note: null })),
    subtotal:       receipt.subtotal,
    discount:        receipt.discount,
    total:          receipt.total,
    payment_method: (receipt.payments || []).map(p => p.payment_name).join(' + '),
    cash_received:  null,
  };
}

async function openReceipts() {
  getEl('receiptDetailView').style.display = 'none';
  getEl('receiptsList').style.display = '';
  const data = await fetchJSON('/api/pos/receipts');
  receiptsCache = data ? data.receipts : [];
  const list = getEl('receiptsList');
  if (!receiptsCache.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--text-secondary);padding:20px 0;">No receipts yet today.</div>';
  } else {
    list.innerHTML = receiptsCache.map(r => `
      <div class="receipt-row-item" data-receipt-id="${r.id}">
        <div>
          <div class="rr-num">${esc(r.receipt_number)}</div>
          <div class="rr-meta">${esc(r.order_name || (r.table_number ? 'Table ' + r.table_number : r.dining_option))}${r.cancelled_at ? ' · refunded' : ''}</div>
        </div>
        <div class="rr-total">${khr(r.total)}</div>
      </div>
    `).join('');
    list.querySelectorAll('[data-receipt-id]').forEach(el => {
      el.addEventListener('click', () => openReceiptDetail(parseInt(el.dataset.receiptId, 10)));
    });
  }
  getEl('receiptsModal').classList.add('open');
}

let currentReceiptDetail = null;

async function openReceiptDetail(id) {
  const data = await fetchJSON(`/api/pos/receipts/${id}`);
  if (!data) return;
  currentReceiptDetail = data.receipt;
  getEl('receiptsList').style.display = 'none';
  getEl('receiptDetailView').style.display = 'block';
  getEl('receiptDetailFrame').srcdoc = receiptHTML(receiptToPrintableOrder(data.receipt));
}

function backToReceiptsList() {
  getEl('receiptDetailView').style.display = 'none';
  getEl('receiptsList').style.display = '';
}

function reprintReceiptFromList() {
  if (currentReceiptDetail) printReceipt(receiptToPrintableOrder(currentReceiptDetail));
}

function closeReceipts() {
  getEl('receiptsModal').classList.remove('open');
}

window.posOpenOrdersModal     = openOrdersModal;
window.posOpenToSettle        = openToSettle;
window.posCloseOrdersModal    = closeOrdersModal;
window.posOpenReceipts        = openReceipts;
window.posCloseReceipts       = closeReceipts;
window.posBackToReceiptsList  = backToReceiptsList;

// ─── Switch terminal ────────────────────────────────────────────────────────

async function switchTerminal() {
  const message = cart.length
    ? "You have unsaved items in the cart — they'll be lost. Switch terminal anyway?"
    : 'Log out of this terminal and switch to a different one?';
  const ok = await showConfirm(message, { danger: cart.length > 0, confirmText: 'Switch Terminal' });
  if (!ok) return;

  // Forget the remembered terminal_id too -- switching implies logging into
  // a DIFFERENT terminal, so the next login screen should ask for it fresh
  // rather than pre-filling the one we're leaving.
  releaseOrderLock(currentOrder);
  clearDeviceTerminalId();
  clearDraft();
  terminalLogout(); // clears the session and fires 'terminal-logged-out', which shows the login screen
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

window.posOnSearch        = onSearch;
window.posOnTableNumber   = onTableNumber;
window.posSaveOrder       = saveOrder;
window.posRetrySendToKitchen = retrySendToKitchen;
window.posOpenPayModal    = openPayModal;
window.posClosePayModal   = closePayModal;
window.posOnCashReceived  = onCashReceived;
window.posCashQuick       = cashQuick;
window.posCashExact       = cashExact;
window.posConfirmPay      = confirmPay;
window.posReadyToBill     = readyToBill;
window.posReprintReceipt  = reprintReceipt;
window.posDonePay         = donePay;
window.posCancelOrder     = cancelOrder;
window.posCloseCancelItemModal = closeCancelItemModal;
window.posConfirmCancelItem    = confirmCancelItem;
window.posNewOrder        = () => { clearDraft(); resetPanel(); };
window.posLockNow         = lockNow;
window.posOpenSettings    = openSettings;
window.posCloseSettings   = closeSettings;
window.posSaveSettings    = saveSettings;
window.posSwitchTerminal  = switchTerminal;

function toggleNavMenu() {
  getEl('navMenu').classList.toggle('open');
}

document.addEventListener('click', (e) => {
  const menu = getEl('navMenu');
  const btn  = getEl('navMenuBtn');
  if (menu && menu.classList.contains('open') && !menu.contains(e.target) && e.target !== btn) {
    menu.classList.remove('open');
  }
});

window.posToggleNavMenu = toggleNavMenu;

// Role is fixed for the life of a terminal session (a dashboard role change
// only takes effect for THAT terminal's next request/login, not this
// already-open tab) -- set once at boot rather than re-derived on every
// renderCart(). Order terminals get "Ready to Bill" instead of Pay, and only
// see the To Settle entry point if they're a supervisor.
function applyRoleUI(info) {
  const supervisor = info && info.role === 'supervisor';
  const payBtn = getEl('payBtn');
  if (payBtn) {
    payBtn.textContent = supervisor ? '💳 Pay' : '🧾 Ready to Bill';
    payBtn.onclick = supervisor ? openPayModal : readyToBill;
  }
  const settleBtn = getEl('toSettleBtn');
  if (settleBtn) settleBtn.style.display = supervisor ? '' : 'none';
}

let appStarted = false;

async function startApp(terminal, idleTimeoutMinutes) {
  const info = terminal || getTerminalInfo();
  const nameEl = getEl('navMenuTerminalName');
  if (nameEl && info) nameEl.textContent = info.name || info.terminal_id;
  if (info) document.title = info.name || info.terminal_id;
  applyRoleUI(info);

  const configData = await fetchJSON('/api/pos/config');
  if (configData) config = configData;

  await loadCatalog();
  const v = await fetchJSON('/api/pos/catalog/version');
  if (v) lastCatalogVersion = v.version;

  if (!restoreDraftIfAny()) resetPanel();
  await loadOpenOrders();

  if (!appStarted) {
    appStarted = true;
    startIdleWatch(idleTimeoutMinutes ?? (info && info.idle_timeout_minutes) ?? 30);
    startOfflineQueue();
    setInterval(pollCatalogVersion, CATALOG_VERSION_POLL_MS);
    setInterval(loadOpenOrders, OPEN_ORDERS_POLL_MS);
  }
}

function requireLogin() {
  showTerminalLogin({ label: 'POS Terminal Login', onSuccess: startApp });
}

window.addEventListener('terminal-logged-out', requireLogin);

// Boot refresh happens first, before rendering anything -- if the device
// cookie is still good, staff land straight in the POS with no login
// prompt, no matter how long since the tablet was last touched or rebooted.
window.addEventListener('DOMContentLoaded', async () => {
  const result = await bootSession();
  if (result.ok) startApp(result.terminal, result.idle_timeout_minutes);
  else requireLogin();
});

document.addEventListener('DOMContentLoaded', () => {
  getEl('receiptReprintBtn')?.addEventListener('click', reprintReceiptFromList);
});
