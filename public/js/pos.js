import { getTerminalToken, getTerminalInfo, showTerminalLogin, terminalLogout, clearDeviceTerminalId } from './terminalAuth.js';
import { fetchTerminalJSON as fetchJSON } from './terminalAuth.js';
import { getEl } from './utils.js';
import { showConfirm } from './dialog.js';
import { showToast } from './toast.js';
import { printReceipt, printKitchenTicket, getBridgeUrl, setBridgeUrl, receiptHTML } from './print.js';
import { mutate, onQueueChange, onReplaySuccess, nextLocalOrderNumber, startOfflineQueue } from './offlineQueue.js';

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
let lastPaidOrder      = null;
let orderLoading       = false;

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

function editCartNote(idx) {
  const line = cart[idx];
  if (!line) return;
  const note = window.prompt('Note for ' + line.name, line.note || '');
  if (note === null) return;
  line.note = note.trim() || null;
  renderCart();
}

async function changeSentItemQty(itemId, delta) {
  if (!currentOrder) return;
  const item = currentOrder.items.find(i => i.id === itemId);
  if (!item) return;
  const newQty = item.quantity + delta;
  if (newQty < 1) { removeSentItem(itemId); return; }
  const { ok, data } = await mutate(`/api/pos/order-items/${itemId}`, 'PATCH', { quantity: newQty });
  if (ok && data.order) { currentOrder = data.order; renderCart(); }
  else if (!ok) showToast(data.message || 'Failed to update item.', 'error');
}

async function removeSentItem(itemId) {
  if (!currentOrder) return;
  const ok = await showConfirm('Remove this item from the order?', { danger: true, confirmText: 'Remove' });
  if (!ok) return;
  const { ok: success, data } = await mutate(`/api/pos/order-items/${itemId}`, 'DELETE', null);
  if (success && data.order) { currentOrder = data.order; renderCart(); }
  else if (!success) showToast(data.message || 'Failed to remove item.', 'error');
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
    const persistedHTML = persisted.map(it => {
      const editable = it.id != null && it.kitchen_status !== 'done' && !(currentOrder && currentOrder._queued);
      if (!editable) {
        return `
          <div class="cart-line sent">
            <div class="cl-info">
              <div class="cl-name">${esc(it.item_name)}</div>
              <div class="cl-price">${khr(it.price)} × ${it.quantity}${it.note ? ` · ${esc(it.note)}` : ''}</div>
            </div>
            <div class="cl-total">${khr(it.price * it.quantity)}</div>
          </div>
        `;
      }
      return `
        <div class="cart-line sent">
          <div class="cl-info">
            <div class="cl-name">${esc(it.item_name)}</div>
            <div class="cl-price">${khr(it.price)}${it.note ? ` · <span class="cl-note">${esc(it.note)}</span>` : ''}</div>
          </div>
          <div class="qty-stepper">
            <button type="button" data-sent-dec="${it.id}">−</button>
            <span class="qty-val">${it.quantity}</span>
            <button type="button" data-sent-inc="${it.id}">+</button>
          </div>
          <div class="cl-total">${khr(it.price * it.quantity)}</div>
          <button class="cl-remove" type="button" data-sent-remove="${it.id}">✕</button>
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
    list.querySelectorAll('[data-sent-inc]').forEach(b => b.addEventListener('click', () => changeSentItemQty(parseInt(b.dataset.sentInc, 10), 1)));
    list.querySelectorAll('[data-sent-dec]').forEach(b => b.addEventListener('click', () => changeSentItemQty(parseInt(b.dataset.sentDec, 10), -1)));
    list.querySelectorAll('[data-sent-remove]').forEach(b => b.addEventListener('click', () => removeSentItem(parseInt(b.dataset.sentRemove, 10))));
  }

  const { subtotal, total } = computeTotals();
  getEl('subtotalValue').textContent = khr(subtotal);
  getEl('totalValue').textContent    = khr(total);

  const badge = getEl('orderBadge');
  badge.innerHTML = currentOrder
    ? `${currentOrder.name ? esc(currentOrder.name) + ' · ' : ''}<b>${currentOrder.order_number}</b> · ${currentOrder.status.replace(/_/g, ' ')}`
    : 'New order (not yet sent)';

  const hasDoneItem = !!(currentOrder && currentOrder.items && currentOrder.items.some(it => it.kitchen_status === 'done'));
  getEl('cancelOrderBtn').style.display = (currentOrder && !['paid', 'cancelled'].includes(currentOrder.status) && !hasDoneItem) ? 'block' : 'none';

  // Saved but not yet sent (either the auto-send on save failed, or this is
  // a previously-saved order reopened from the strip) -- offer a manual
  // retry right where the cashier is already looking.
  const retryBtn = getEl('sendToKitchenRetryBtn');
  if (retryBtn) retryBtn.style.display = (currentOrder && currentOrder.status === 'open') ? 'flex' : 'none';
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
  if (!currentOrder || currentOrder._queued) return;
  const { ok, data } = await mutate(`/api/pos/orders/${currentOrder.id}/dining-option`, 'PATCH', { dining_option: opt });
  if (ok && data.order) { currentOrder = data.order; renderCart(); }
}

function onSearch(value) { searchTerm = value; renderItemGrid(); }

let tableNumberTimer = null;
function onTableNumber(value) {
  tableNumber = value;
  if (!currentOrder || currentOrder._queued) return; // nothing to persist yet -- included in the save/create call instead
  clearTimeout(tableNumberTimer);
  tableNumberTimer = setTimeout(async () => {
    const orderId = currentOrder.id;
    const { ok, data } = await mutate(`/api/pos/orders/${orderId}/table-number`, 'PATCH', { table_number: tableNumber });
    if (ok && data.order && currentOrder && currentOrder.id === orderId) {
      currentOrder = data.order;
      renderCart();
    } else if (!ok) {
      showToast(data.message || 'Failed to update table number.', 'error');
    }
  }, 600);
}

let renameTimer = null;
function onOrderName(value) {
  orderName = value;
  if (!currentOrder || currentOrder._queued) return; // nothing to persist yet -- included in the save/create call instead
  clearTimeout(renameTimer);
  renameTimer = setTimeout(async () => {
    const orderId = currentOrder.id;
    const { ok, data } = await mutate(`/api/pos/orders/${orderId}/name`, 'PATCH', { name: orderName });
    if (ok && data.order && currentOrder && currentOrder.id === orderId) {
      currentOrder = data.order;
      renderCart();
    }
  }, 600);
}

// ─── Order lifecycle ───────────────────────────────────────────────────────

function resetPanel() {
  currentOrder = null;
  cart = [];
  diningOption = config.dining_options[0] || null;
  tableNumber  = '';
  orderName    = defaultOrderName();
  getEl('tableNumber').value  = '';
  getEl('orderNameInput').value = orderName;
  renderDiningOptions();
  renderCart();
  renderItemGrid();
}

function pendingLinesPayload() {
  return cart.map(l => ({ source_item_id: l.source_item_id, quantity: l.quantity, note: l.note }));
}

// Builds a client-side stand-in for an order whose create call is still
// sitting in the offline queue — no real id yet, so it can't be paid,
// cancelled, or appended to until the create replays successfully.
function buildLocalOrder(localId, lines) {
  const items = lines.map(l => ({
    id: null, source_item_id: l.source_item_id, item_name: l.name, price: l.price,
    quantity: l.quantity, note: l.note, kitchen_status: 'pending',
  }));
  const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  return {
    id: null, order_number: localId, status: 'open', name: orderName || null,
    dining_option: diningOption, table_number: tableNumber || null,
    subtotal, discount: 0, total: subtotal,
    created_at: cambodiaNaiveNow(), items, _queued: true,
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
    const localId = nextLocalOrderNumber();
    const lines = cart.slice();
    const { ok, data, queued } = await mutate('/api/pos/orders', 'POST', {
      dining_option: diningOption, table_number: tableNumber || null,
      items: pendingLinesPayload(), name: orderName || null,
    }, localId);

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

  if (currentOrder._queued) {
    return { ok: false, queued: false, message: "This order hasn't synced yet — it'll retry automatically." };
  }

  const lines = cart.slice();
  const { ok, data, queued } = await mutate(`/api/pos/orders/${currentOrder.id}/items`, 'POST', { items: pendingLinesPayload() });
  if (queued) {
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
  const { ok, data, queued } = await mutate(`/api/pos/orders/${order.id}/send-to-kitchen`, 'POST', {});
  if (queued || !ok) return order;
  return data.order;
}

async function saveOrder() {
  const wasNew = !currentOrder;
  const result = await persistCart();
  if (!result.ok) { showToast(result.message || 'Failed to save.', 'error'); return; }

  let savedOrder = currentOrder;

  if (result.queued) {
    // Fully offline -- can't attempt the send-to-kitchen call yet since
    // there's no real order id. reconcileLocalOrder() picks this up once
    // the create itself syncs.
    showToast(`Offline — order queued as ${savedOrder.order_number}. Will sync and send automatically.`, 'error');
    renderCart();
    loadOpenOrders();
    return;
  }

  savedOrder = await attemptSendToKitchen(savedOrder);
  currentOrder = savedOrder;

  if (savedOrder.status !== 'open') {
    showToast(wasNew ? `Sent to kitchen — ${savedOrder.order_number}` : 'Items sent to kitchen.');
    if (wasNew) resetPanel(); else renderCart();
  } else {
    showToast(`Saved as ${savedOrder.order_number} — couldn't reach the kitchen. Tap "Send to Kitchen" to retry.`, 'error');
    renderCart();
  }
  loadOpenOrders();
}

async function retrySendToKitchen() {
  if (!currentOrder || currentOrder.status !== 'open') return;
  const sent = await attemptSendToKitchen(currentOrder);
  currentOrder = sent;
  if (sent.status !== 'open') {
    showToast(`Sent to kitchen — ${sent.order_number}`);
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
  getEl('cashSection').classList.remove('show');
  getEl('payConfirmBtn').disabled = true;
  getEl('payModalTotal').textContent = khr(computeTotals().total);

  const box = getEl('payMethodButtons');
  box.innerHTML = config.payment_methods.map(m => `
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
  getEl('cashSection').classList.toggle('show', code === 'cash');
  updateChange();
}

function onCashReceived(value) { cashReceived = Math.max(0, Number(value) || 0); updateChange(); }
function cashQuick(amount)     { cashReceived += amount; getEl('cashReceivedInput').value = cashReceived; updateChange(); }
function cashExact()           { cashReceived = computeTotals().total; getEl('cashReceivedInput').value = cashReceived; updateChange(); }

function updateChange() {
  const total = computeTotals().total;
  const change = selectedPayMethod === 'cash' ? cashReceived - total : 0;
  getEl('changeValue').textContent = khr(Math.max(0, change));
  const valid = selectedPayMethod && (selectedPayMethod !== 'cash' || cashReceived >= total);
  getEl('payConfirmBtn').disabled = !valid;

  const hint = getEl('payHint');
  if (!selectedPayMethod) hint.textContent = 'Select a payment method to continue.';
  else if (selectedPayMethod === 'cash' && cashReceived < total) hint.textContent = 'Enter cash received — must be at least the total.';
  else hint.textContent = '';
}

async function confirmPay() {
  if (!currentOrder || !selectedPayMethod) return;
  const body = { payment_method: selectedPayMethod };
  if (selectedPayMethod === 'cash') body.cash_received = cashReceived;

  const { ok, data, queued } = await mutate(`/api/pos/orders/${currentOrder.id}/pay`, 'POST', body);

  if (queued) {
    // Optimistic: the network is down, not the till — let the cashier keep
    // moving and reconcile once the pay call replays successfully.
    const change = selectedPayMethod === 'cash' ? Math.max(0, cashReceived - computeTotals().total) : 0;
    const optimisticOrder = {
      ...currentOrder, status: 'paid', payment_method: selectedPayMethod,
      cash_received: selectedPayMethod === 'cash' ? cashReceived : null,
    };
    showToast(`Offline — payment queued for ${currentOrder.order_number}.`, 'error');
    printReceipt(optimisticOrder);
    showPaySuccess(optimisticOrder, change);
    loadOpenOrders();
    return;
  }

  if (!ok) { showToast(data.message || 'Payment failed.', 'error'); return; }

  showToast(`Paid — ${data.order.order_number}`);
  printReceipt(data.order); // the one auto-print left: a completed sale should always hand over a receipt
  showPaySuccess(data.order, data.change);
  loadOpenOrders();
}

function showPaySuccess(order, change) {
  lastPaidOrder = order;
  getEl('payModalBody').style.display = 'none';
  getEl('paySuccessView').style.display = 'block';
  getEl('paySuccessOrderNo').textContent = `${order.order_number} · ${order.payment_method}`;
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
  resetPanel();
}

async function cancelOrder() {
  if (orderLoading) { showToast('Still loading the order — try again in a moment.', 'error'); return; }
  if (!currentOrder) return;
  if (currentOrder._queued) {
    showToast("This order hasn't synced yet — it'll retry automatically.", 'error');
    return;
  }
  const ok = await showConfirm('Cancel this order? This cannot be undone.', { danger: true, confirmText: 'Cancel Order' });
  if (!ok) return;
  const reason = window.prompt('Reason for cancellation (optional):') || '';

  const res = await mutate(`/api/pos/orders/${currentOrder.id}/cancel`, 'POST', { reason });
  if (res.queued) {
    showToast('Offline — cancellation queued, will sync automatically.', 'error');
    resetPanel();
    loadOpenOrders();
    return;
  }
  if (!res.ok) { showToast(res.data.message || 'Failed to cancel order.', 'error'); return; }
  showToast('Order cancelled.');
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
  getEl('orderNameInput').value = orderName;
  renderDiningOptions();
  renderCart();
  renderItemGrid();
}

async function loadOpenOrders() {
  const data = await fetchJSON('/api/pos/orders?status=active');
  const orders = data ? data.orders.slice() : [];
  // The server has no idea a still-offline order exists yet — keep it
  // visible in the strip locally until its create call reconciles.
  if (currentOrder && currentOrder._queued && !orders.some(o => o.order_number === currentOrder.order_number)) {
    orders.unshift(currentOrder);
  }

  const strip = getEl('openOrdersStrip');
  strip.innerHTML = '';
  orders.forEach(o => {
    const chip = document.createElement('div');
    chip.className = 'order-chip';
    const title = o.name ? esc(o.name) : (o.table_number ? 'Table ' + o.table_number : o.order_number);
    chip.innerHTML = `
      <span class="chip-title">${title}</span>
      <span class="chip-sub">${khr(o.total)} · ${(o.status || '').replace(/_/g, ' ')}${o._queued ? ' · offline' : ''}</span>
      <button class="chip-reprint" type="button" title="Reprint kitchen ticket">🖨</button>
    `;
    chip.addEventListener('click', () => {
      if (o._queued) applyOrderToPanel(o);
      else loadOrderIntoPanel(o.id);
    });
    chip.querySelector('.chip-reprint').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (o._queued) { printKitchenTicket(o); return; }
      const fresh = await fetchJSON(`/api/pos/orders/${o.id}`);
      if (fresh) printKitchenTicket(fresh.order);
    });
    strip.appendChild(chip);
  });
}

async function loadOrderIntoPanel(id) {
  orderLoading = true;
  const data = await fetchJSON(`/api/pos/orders/${id}`);
  orderLoading = false;
  if (!data) return;
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
});

onQueueChange(count => {
  const el = getEl('offlineBanner');
  if (!el) return;
  if (count > 0) {
    el.style.display = 'flex';
    el.textContent = `⚠ Offline — ${count} queued`;
  } else {
    el.style.display = 'none';
  }
});

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
    payment_method: receipt.payment ? receipt.payment.payment_name : '',
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
  terminalLogout(); // clears the token and fires 'terminal-logged-out', which shows the login screen
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
window.posReprintReceipt  = reprintReceipt;
window.posDonePay         = donePay;
window.posCancelOrder     = cancelOrder;
window.posNewOrder        = () => resetPanel();
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

let appStarted = false;

async function startApp(terminal) {
  const info = terminal || getTerminalInfo();
  const nameEl = getEl('navMenuTerminalName');
  if (nameEl && info) nameEl.textContent = info.name || info.terminal_id;
  const brandEl = getEl('posBrand');
  if (info) {
    if (brandEl) brandEl.textContent = `🧾 ${info.name || info.terminal_id}`;
    document.title = info.name || info.terminal_id;
  }

  const configData = await fetchJSON('/api/pos/config');
  if (configData) config = configData;

  await loadCatalog();
  const v = await fetchJSON('/api/pos/catalog/version');
  if (v) lastCatalogVersion = v.version;

  resetPanel();
  await loadOpenOrders();

  if (!appStarted) {
    appStarted = true;
    startOfflineQueue();
    setInterval(pollCatalogVersion, CATALOG_VERSION_POLL_MS);
    setInterval(loadOpenOrders, OPEN_ORDERS_POLL_MS);
  }
}

function requireLogin() {
  showTerminalLogin({ label: 'POS Terminal Login', onSuccess: startApp });
}

window.addEventListener('terminal-logged-out', requireLogin);

window.addEventListener('DOMContentLoaded', () => {
  if (!getTerminalToken()) requireLogin();
  else startApp();
});

document.addEventListener('DOMContentLoaded', () => {
  getEl('receiptReprintBtn')?.addEventListener('click', reprintReceiptFromList);
});
