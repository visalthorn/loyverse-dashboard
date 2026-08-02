import { getTerminalInfo, showTerminalLogin, terminalLogout, clearDeviceTerminalId, bootSession, startIdleWatch, lockNow } from './terminalAuth.js';
import { fetchTerminalJSON as fetchJSON } from './terminalAuth.js';
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

// Saved-order name: auto-filled with the time the order was started, freely
// editable (e.g. to "Table 5") before or after saving.
let orderName = '';

function khr(n) {
  const num = Number(n) || 0;
  return '៛' + num.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

// ─── Terminal role (POS audit, 2026-08-02; revised 2026-08-02) ──────────────
// Devices are fully shared -- any terminal may fetch, resume, edit, cancel an
// item on, or cancel entirely any open order in the branch, online or
// offline. Only completing PAYMENT is role-gated (requireTerminalRole on the
// server) -- this client-side check is UI convenience only (hiding a button
// that would 403) and must never be trusted as the control.
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
        ${qty > 0 ? `<span class="item-qty-badge">×${qty}</span>` : ''}
        ${it.image_url
          ? `<img class="item-img" src="${esc(it.image_url)}" alt="" loading="lazy" onerror="this.remove()"/>`
          : ''}
        <span class="item-name">${it.name}</span>
        <span class="item-price">${khr(it.price)}</span>
      </button>`;
  }).join('');

  grid.querySelectorAll('.item-btn').forEach(btn => {
    btn.addEventListener('click', () => addItemToCart(btn.dataset.itemId));
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
    localStorage.setItem(draftKey(), JSON.stringify({ currentOrder, cart, diningOption, tableNumber, orderName }));
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
  orderName    = draft.orderName || orderName;

  getEl('tableNumber').value = tableNumber;
  getEl('tableNumber').classList.remove('invalid');
  getEl('orderNameInput').value = orderName;
  renderDiningOptions();
  renderCart();
  renderItemGrid();
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
  renderItemGrid();
  renderCart();
}

function changeCartQty(idx, delta) {
  const line = cart[idx];
  if (!line) return;
  line.quantity += delta;
  if (line.quantity <= 0) cart.splice(idx, 1);
  renderItemGrid();
  renderCart();
}

function removeCartLine(idx) {
  cart.splice(idx, 1);
  renderItemGrid();
  renderCart();
}

async function editCartNote(idx) {
  const line = cart[idx];
  if (!line) return;
  const note = await showPrompt(`Note for ${line.name}`, { defaultValue: line.note || '', placeholder: 'e.g. no ice, extra spicy' });
  if (note === null) return;
  line.note = note || null;
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
      renderCart();
      showToast(fullRemoval ? 'Item removed.' : `Quantity reduced by ${qty}.`);
    } else if (!ok) {
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
  badge.innerHTML = currentOrder
    ? `${currentOrder.name ? esc(currentOrder.name) + ' · ' : ''}<b>${currentOrder.order_number}</b> · ${currentOrder.status.replace(/_/g, ' ')}`
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
      showToast(data.message || 'Failed to update table number.', 'error');
    }
  }, 600);
}

let renameTimer = null;
function onOrderName(value) {
  orderName = value;
  saveDraft();
  if (!currentOrder || currentOrder._queued) return; // nothing to persist server-side yet -- included in the save/create call instead
  clearTimeout(renameTimer);
  renameTimer = setTimeout(async () => {
    if (!currentOrder) return; // panel was reset while this was pending
    const orderId = currentOrder.id;
    const { ok, data } = await mutate(`/api/pos/orders/${orderId}/name`, 'PATCH', { name: orderName, base_version: currentOrder.version });
    if (ok && data.order && currentOrder && currentOrder.id === orderId) {
      currentOrder = data.order;
      renderCart();
      if (data.notice) showToast('This order changed elsewhere — refreshed.', 'error');
    }
  }, 600);
}

// ─── Order lifecycle ───────────────────────────────────────────────────────

function resetPanel() {
  // Cancel any pending debounced table#/name save -- otherwise it fires
  // later against whatever order (or no order) is on screen by then.
  clearTimeout(tableNumberTimer);
  clearTimeout(renameTimer);
  currentOrder = null;
  cart = [];
  diningOption = config.dining_options[0] || null;
  tableNumber  = '';
  orderName    = defaultOrderName();
  getEl('tableNumber').value  = '';
  getEl('tableNumber').classList.remove('invalid');
  getEl('orderNameInput').value = orderName;
  renderDiningOptions();
  renderCart();
  renderItemGrid();
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
    id: null, order_number: localId, provisional_number: localId, status: 'open', name: orderName || null,
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
      items: pendingLinesPayload(), name: orderName || null,
      provisional_number: localId, client_time: new Date().toISOString(),
    }, { idempotent: true, localId });

    if (queued) {
      currentOrder = buildLocalOrder(localId, lines);
      cart = [];
      return { ok: true, queued: true };
    }
    if (!ok) return { ok: false, queued: false, message: data.message };
    currentOrder = data.order;
    cart = [];
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
  if (!ok) return { ok: false, queued: false, message: data.message };
  currentOrder = data.order;
  cart = [];
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
    const result = await persistCart();
    if (!result.ok) { showToast(result.message || 'Failed to save.', 'error'); return; }

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

  const result = await persistCart();
  if (!result.ok) { showToast(result.message || 'Failed to create order.', 'error'); return false; }
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
  cart = [];
  diningOption = order.dining_option;
  tableNumber  = order.table_number || '';
  orderName    = order.name || '';
  getEl('tableNumber').value   = tableNumber;
  getEl('tableNumber').classList.remove('invalid');
  getEl('orderNameInput').value = orderName;
  renderDiningOptions();
  renderCart();
  renderItemGrid();
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
// ready/served and just had new items appended to it (see the
// 'items_added_after_ready' reactivation in POST /orders/:id/items) -- the
// latter carries a mix of already-'done' and freshly-'pending' items, which
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
  const data = await fetchJSON('/api/pos/orders?status=active');
  if (!data) {
    if (!openOrdersLoadFailed && !isOffline()) showToast('Could not refresh open orders — check connection.', 'error');
    openOrdersLoadFailed = true;
    return;
  }
  openOrdersLoadFailed = false;
  const orders = data.orders.slice();
  if (data.server_now) ordersClockOffsetMs = new Date(data.server_now).getTime() - Date.now();
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
    row.innerHTML = `
      <div>
        <div class="or-title">${title}</div>
        <div class="or-sub">
          ${tableLabel ? `${tableLabel} · ` : ''}<span class="or-status-badge status-${status.cls}">${esc(status.text)}</span>${elapsedText ? ` · ${elapsedText}` : ''}${o._queued ? ' · offline' : ''}
        </div>
      </div>
      <span class="or-total">${khr(o.total)}</span>
      <button class="chip-reprint" type="button" title="Reprint kitchen ticket">🖨</button>
    `;
    row.addEventListener('click', () => {
      if (o._queued) applyOrderToPanel(o);
      else loadOrderIntoPanel(o.id);
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

async function loadOrderIntoPanel(id) {
  orderLoading = true;
  const data = await fetchJSON(`/api/pos/orders/${id}`);
  orderLoading = false;
  if (!data) { showToast('Could not open that order — try again.', 'error'); return; }
  applyOrderToPanel(data.order);
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
  clearDeviceTerminalId();
  clearDraft();
  terminalLogout(); // clears the session and fires 'terminal-logged-out', which shows the login screen
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

window.posOnSearch        = onSearch;
window.posOnTableNumber   = onTableNumber;
window.posOnOrderName     = onOrderName;
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
