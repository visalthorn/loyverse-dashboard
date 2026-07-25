import { getTerminalToken, getTerminalInfo, showTerminalLogin } from './terminalAuth.js';
import { fetchTerminalJSON as fetchJSON } from './terminalAuth.js';
import { getEl } from './utils.js';
import { showConfirm } from './dialog.js';
import { showToast } from './toast.js';
import { printReceipt, printKitchenTicket, getBridgeUrl, setBridgeUrl } from './print.js';
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
let discount     = 0;

let selectedPayMethod = null;
let cashReceived       = 0;
let lastPaidOrder      = null;

function khr(n) {
  const num = Number(n) || 0;
  return '៛' + num.toLocaleString('en-US', { maximumFractionDigits: 0 });
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
  const bar = getEl('categoryBar');
  const tabs = [{ id: 'all', name: 'All' }, ...catalog.categories];
  bar.innerHTML = tabs.map(c => `
    <button class="cat-tab ${activeCategory === c.id ? 'active' : ''}" data-cat="${c.id}">${c.name}</button>
  `).join('');
  bar.querySelectorAll('.cat-tab').forEach(btn => {
    btn.addEventListener('click', () => { activeCategory = btn.dataset.cat; renderCategories(); renderItemGrid(); });
  });
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

function computeTotals() {
  const persistedSubtotal = currentOrder ? Number(currentOrder.subtotal) : 0;
  const persistedDiscount = currentOrder ? Number(currentOrder.discount) : Math.max(0, Number(discount) || 0);
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
    const persistedHTML = persisted.map(it => `
      <div class="cart-line sent">
        <div class="cl-info">
          <div class="cl-name">${it.item_name}</div>
          <div class="cl-price">${khr(it.price)} × ${it.quantity}${it.note ? ` · ${it.note}` : ''}</div>
        </div>
        <div class="cl-total">${khr(it.price * it.quantity)}</div>
      </div>
    `).join('');

    const cartHTML = cart.map((l, idx) => `
      <div class="cart-line">
        <div class="cl-info" data-note-idx="${idx}">
          <div class="cl-name">${l.name}</div>
          <div class="cl-price">${khr(l.price)}${l.note ? ` · <span class="cl-note">${l.note}</span>` : ''}</div>
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
  }

  const { subtotal, total } = computeTotals();
  getEl('subtotalValue').textContent = khr(subtotal);
  getEl('totalValue').textContent    = khr(total);

  const badge = getEl('orderBadge');
  badge.innerHTML = currentOrder
    ? `Order <b>${currentOrder.order_number}</b> · ${currentOrder.status.replace(/_/g, ' ')}`
    : 'New order (not yet sent)';

  getEl('cancelOrderBtn').style.display = (currentOrder && !['paid', 'cancelled'].includes(currentOrder.status)) ? 'block' : 'none';

  getEl('discountInput').disabled = !!currentOrder;
}

// ─── Dining option / table number / discount ───────────────────────────────

function renderDiningOptions() {
  const box = getEl('diningOptions');
  box.innerHTML = config.dining_options.map(opt => `
    <button class="seg-btn ${diningOption === opt ? 'active' : ''}" data-opt="${opt}">${opt}</button>
  `).join('');
  box.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (currentOrder) return; // dining option locked once the order is persisted
      diningOption = btn.dataset.opt;
      renderDiningOptions();
    });
  });
}

function onSearch(value)      { searchTerm = value; renderItemGrid(); }
function onTableNumber(value) { tableNumber = value; }
function onDiscount(value)    { discount = Math.max(0, Number(value) || 0); renderCart(); }

// ─── Order lifecycle ───────────────────────────────────────────────────────

function resetPanel() {
  currentOrder = null;
  cart = [];
  diningOption = config.dining_options[0] || null;
  tableNumber  = '';
  discount     = 0;
  getEl('tableNumber').value  = '';
  getEl('discountInput').value = '0';
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
  const subtotal   = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const discountAmt = Math.max(0, Number(discount) || 0);
  const total      = Math.max(0, subtotal - discountAmt);
  return {
    id: null, order_number: localId, status: 'sent_to_kitchen',
    dining_option: diningOption, table_number: tableNumber || null,
    subtotal, discount: discountAmt, total,
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
      discount, items: pendingLinesPayload(),
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

async function sendToKitchen() {
  const wasNew = !currentOrder;
  const result = await persistCart();
  if (!result.ok) { showToast(result.message || 'Failed to send.', 'error'); return; }

  const sentOrder = currentOrder;

  if (result.queued) {
    showToast(`Offline — order queued as ${sentOrder.order_number}. Will sync automatically.`, 'error');
  } else if (wasNew) {
    showToast(`Sent to kitchen — ${sentOrder.order_number}`);
  } else {
    showToast('Items sent to kitchen.');
  }

  printKitchenTicket(sentOrder);

  if (wasNew && !result.queued) {
    // Otherwise currentOrder stays pinned to the order that was just sent,
    // and the next items rung up silently append onto it instead of
    // starting a new order -- looks like "sending a new order" does nothing.
    resetPanel();
  } else {
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
  printReceipt(data.order);
  showPaySuccess(data.order, data.change);
  loadOpenOrders();
}

function showPaySuccess(order, change) {
  lastPaidOrder = order;
  getEl('payModalBody').style.display = 'none';
  getEl('paySuccessView').style.display = 'block';
  getEl('paySuccessOrderNo').textContent = `${order.order_number} · ${order.payment_method}`;
  getEl('paySuccessChange').textContent = change ? `Change ${khr(change)}` : '';
}

function reprintReceipt() {
  if (lastPaidOrder) printReceipt(lastPaidOrder);
}

function donePay() {
  closePayModal();
  resetPanel();
}

async function cancelOrder() {
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
  discount     = Number(order.discount);
  getEl('tableNumber').value   = tableNumber;
  getEl('discountInput').value = discount;
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
    chip.innerHTML = `
      <span class="chip-title">${o.table_number ? 'Table ' + o.table_number : o.order_number}</span>
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
  const data = await fetchJSON(`/api/pos/orders/${id}`);
  if (!data) return;
  applyOrderToPanel(data.order);
}

// ─── Offline queue wiring ───────────────────────────────────────────────────

function reconcileLocalOrder(localId, realOrder) {
  if (currentOrder && currentOrder.order_number === localId) {
    currentOrder = realOrder;
    renderCart();
  }
  showToast(`Order synced — ${realOrder.order_number}`);
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

// ─── Bootstrap ──────────────────────────────────────────────────────────────

window.posOnSearch        = onSearch;
window.posOnTableNumber   = onTableNumber;
window.posOnDiscount      = onDiscount;
window.posSendToKitchen   = sendToKitchen;
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

let appStarted = false;

async function startApp(terminal) {
  const info = terminal || getTerminalInfo();
  const brandEl = document.querySelector('#topStrip .brand');
  if (brandEl && info) {
    const tag = document.createElement('span');
    tag.style.cssText = 'font-size:11px;color:var(--text-secondary);white-space:nowrap;';
    tag.textContent = info.name || info.terminal_id;
    brandEl.insertAdjacentElement('afterend', tag);
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
