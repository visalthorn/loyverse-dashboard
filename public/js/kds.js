import {
  getTerminalToken, getTerminalInfo, showTerminalLogin,
  fetchTerminalJSON as fetchJSON, terminalApiPatch as apiPatch, terminalApiPost as apiPost,
} from './terminalAuth.js';
import { showToast } from './toast.js';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Tapping an item just strikes it (done) or un-strikes it (back to pending)
// -- 'preparing' is no longer a manually-reachable click state, though the
// order-level sent_to_kitchen -> preparing bump (server side) is unaffected
// since it only checks for "not pending".
const NEXT_STATUS = { pending: 'done', preparing: 'done', done: 'pending' };
let warnMs   = 10 * 60 * 1000;
let dangerMs = 20 * 60 * 1000;
const SAFETY_POLL_MS = 30 * 1000;

let orders = [];        // raw orders from /kds/active (sent_to_kitchen | preparing | ready)
let clockOffsetMs = 0;  // (server "now" ms) - (Date.now() at fetch time)
let finishedModalOpen = false; // finished-orders lookback shows in a dialog, never replaces the active board
let finishedVisibleIds = []; // order ids currently rendered in the finished modal -- what a "Clear" tap dismisses

const DISMISSED_KEY = 'kds_dismissed_finished_orders';

function getDismissedIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function setDismissedIds(idSet) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...idSet]));
  } catch {
    // Nothing actionable client-side (quota exceeded, storage disabled) --
    // worst case dismissed orders reappear next refresh.
  }
}

// server_now and every order timestamp are genuine UTC values (see
// routes/pos.js) -- parse them the normal way. Display conversion to
// Cambodia time happens explicitly in formatClock()/tickClock() below.
function toEpochMs(ts) {
  return new Date(ts).getTime();
}

function nowMs() {
  return Date.now() + clockOffsetMs;
}

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatClock(ts) {
  const d = new Date(toEpochMs(ts));
  return d.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Phnom_Penh', hour: '2-digit', minute: '2-digit' });
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch { /* audio not available */ }
}

function setConnDot(online) {
  document.getElementById('connDot').classList.toggle('online', online);
}

let noCategoriesAssigned = false;

async function refresh() {
  const data = await fetchJSON('/api/pos/kds/active');
  if (!data) return;
  clockOffsetMs = toEpochMs(data.server_now) - Date.now();
  if (Number.isInteger(data.warn_minutes))   warnMs   = data.warn_minutes * 60 * 1000;
  if (Number.isInteger(data.danger_minutes)) dangerMs = data.danger_minutes * 60 * 1000;
  orders = data.orders;
  noCategoriesAssigned = !!data.no_categories_assigned;
  render();
}

function badgeText(order) {
  return order.table_number ? `Table ${order.table_number}` : order.dining_option;
}

// Returns unescaped text -- callers must esc() the result before inserting into HTML.
function cardTitle(order) {
  return order.name ? `${order.name} · ${order.order_number}` : order.order_number;
}

function elapsedClass(ms) {
  if (ms >= dangerMs) return 'elapsed-danger';
  if (ms >= warnMs) return 'elapsed-warn';
  return 'elapsed-ok';
}

function render() {
  const board = document.getElementById('board');
  const active = orders.filter(o => o.status === 'sent_to_kitchen' || o.status === 'preparing');
  const ready  = orders.filter(o => o.status === 'ready');

  board.innerHTML = '';
  if (noCategoriesAssigned) {
    board.innerHTML = '<div id="emptyBoardMsg">No categories assigned — ask a manager to configure this station.</div>';
  } else if (!active.length) {
    board.innerHTML = '<div id="emptyBoardMsg">No orders in the kitchen 🎉</div>';
  } else {
    for (const order of active) {
      board.appendChild(renderCard(order));
    }
  }

  const strip = document.getElementById('readyStrip');
  strip.querySelectorAll('.ready-chip, #emptyReadyMsg').forEach(el => el.remove());
  if (!ready.length) {
    strip.insertAdjacentHTML('beforeend', '<span id="emptyReadyMsg">Nothing ready</span>');
  } else {
    for (const order of ready) {
      const chip = document.createElement('div');
      chip.className = 'ready-chip';
      chip.innerHTML = `<span class="rc-title">${esc(cardTitle(order))}</span><span class="rc-sub">${esc(badgeText(order))}</span>`;
      chip.onclick = () => markServed(order.id);
      strip.appendChild(chip);
    }
  }

  tickElapsed();
}

// Finished (served) orders open in a dialog on top of the active board so
// checking one doesn't interrupt the live board underneath -- it's just a
// quick reconcile-with-the-order lookup, not a separate mode to switch into.
async function openFinishedModal() {
  finishedModalOpen = true;
  document.getElementById('finishedModal').classList.add('open');
  await refreshFinishedModal();
}

function closeFinishedModal() {
  finishedModalOpen = false;
  document.getElementById('finishedModal').classList.remove('open');
}

async function refreshFinishedModal() {
  const data = await fetchJSON('/api/pos/kds/finished');
  const body = document.getElementById('finishedModalBody');
  if (!data) return;

  if (data.no_categories_assigned) {
    finishedVisibleIds = [];
    body.innerHTML = '<div id="emptyBoardMsg">No categories assigned — ask a manager to configure this station.</div>';
    return;
  }

  // Drop any dismissed id the server no longer returns (aged out of its own
  // 24h window) so this set can't grow unbounded across days of use.
  const liveIds = new Set(data.orders.map(o => o.id));
  const prunedDismissed = new Set([...getDismissedIds()].filter(id => liveIds.has(id)));
  setDismissedIds(prunedDismissed);

  const visible = data.orders.filter(o => !prunedDismissed.has(o.id));
  finishedVisibleIds = visible.map(o => o.id);

  body.innerHTML = '';
  if (!visible.length) {
    body.innerHTML = '<div id="emptyBoardMsg">No finished orders yet.</div>';
  } else {
    for (const order of visible) body.appendChild(renderFinishedCard(order));
  }
}

async function clearFinishedOrders() {
  const dismissed = getDismissedIds();
  for (const id of finishedVisibleIds) dismissed.add(id);
  setDismissedIds(dismissed);
  await refreshFinishedModal();
}

const DISMISSED_CANCELLED_KEY = 'kds_dismissed_cancelled_orders';

function getDismissedCancelledIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_CANCELLED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function setDismissedCancelledIds(idSet) {
  try {
    localStorage.setItem(DISMISSED_CANCELLED_KEY, JSON.stringify([...idSet]));
  } catch {
    // Nothing actionable client-side (quota exceeded, storage disabled) --
    // worst case dismissed orders reappear next refresh.
  }
}

let cancelledModalOpen = false;
let cancelledVisibleIds = [];

function setCancelledDot(lit) {
  document.getElementById('cancelledDot').classList.toggle('show', lit);
}

async function openCancelledModal() {
  cancelledModalOpen = true;
  document.getElementById('cancelledModal').classList.add('open');
  await refreshCancelledModal();
}

function closeCancelledModal() {
  cancelledModalOpen = false;
  document.getElementById('cancelledModal').classList.remove('open');
}

async function refreshCancelledModal() {
  const data = await fetchJSON('/api/pos/kds/cancelled');
  const body = document.getElementById('cancelledModalBody');
  if (!data) return;

  if (data.no_categories_assigned) {
    cancelledVisibleIds = [];
    setCancelledDot(false);
    body.innerHTML = '<div id="emptyBoardMsg">No categories assigned — ask a manager to configure this station.</div>';
    return;
  }

  const liveIds = new Set(data.orders.map(o => o.id));
  const prunedDismissed = new Set([...getDismissedCancelledIds()].filter(id => liveIds.has(id)));
  setDismissedCancelledIds(prunedDismissed);

  const visible = data.orders.filter(o => !prunedDismissed.has(o.id));
  cancelledVisibleIds = visible.map(o => o.id);
  setCancelledDot(visible.length > 0);

  body.innerHTML = '';
  if (!visible.length) {
    body.innerHTML = '<div id="emptyBoardMsg">No cancelled orders in the last 24h.</div>';
  } else {
    for (const order of visible) body.appendChild(renderCancelledCard(order));
  }
}

async function clearCancelledOrders() {
  const dismissed = getDismissedCancelledIds();
  for (const id of cancelledVisibleIds) dismissed.add(id);
  setDismissedCancelledIds(dismissed);
  await refreshCancelledModal();
}

// Lightweight poll used only while the modal is closed, purely to light the
// dot -- refreshCancelledModal() (above) covers the dot too whenever the
// modal is open, so the two never race on the same UI element.
async function pollCancelledDot() {
  if (cancelledModalOpen) return;
  const data = await fetchJSON('/api/pos/kds/cancelled');
  if (!data || data.no_categories_assigned) { setCancelledDot(false); return; }
  const dismissed = getDismissedCancelledIds();
  const visible = data.orders.filter(o => !dismissed.has(o.id));
  setCancelledDot(visible.length > 0);
}

function renderCancelledCard(order) {
  const card = document.createElement('div');
  card.className = 'order-card dimmed';

  const head = document.createElement('div');
  head.className = 'oc-head';
  head.innerHTML = `
    <div class="oc-head-row1">
      <span class="oc-number">${esc(cardTitle(order))}</span>
      <span class="oc-badge">${esc(badgeText(order))}</span>
    </div>
    <div class="oc-head-row2">
      <span class="oc-arrived">🚫 ${formatClock(order.cancelled_at)}</span>
    </div>
    ${order.cancel_reason ? `<div class="oc-cancel-reason">${esc(order.cancel_reason)}</div>` : ''}
  `;
  card.appendChild(head);

  const itemsEl = document.createElement('div');
  itemsEl.className = 'oc-items';
  for (const item of order.items) {
    const row = document.createElement('div');
    row.className = 'oc-item status-cancelled';
    row.innerHTML = `
      <span class="qty">${item.quantity}×</span>
      <span class="name">${esc(item.item_name)}${item.note ? `<span class="note">${esc(item.note)}</span>` : ''}</span>
    `;
    itemsEl.appendChild(row);
  }
  card.appendChild(itemsEl);

  return card;
}

function renderFinishedCard(order) {
  const card = document.createElement('div');
  card.className = 'order-card dimmed';

  const head = document.createElement('div');
  head.className = 'oc-head';
  head.innerHTML = `
    <div class="oc-head-row1">
      <span class="oc-number">${esc(cardTitle(order))}</span>
      <span class="oc-badge">${esc(badgeText(order))}</span>
    </div>
    <div class="oc-head-row2">
      <span class="oc-arrived">🕐 ${formatClock(order.sent_to_kitchen_at || order.created_at)}</span>
      <span class="oc-served">✅ ${order.served_at ? formatClock(order.served_at) : '—'}</span>
    </div>
  `;
  card.appendChild(head);

  const itemsEl = document.createElement('div');
  itemsEl.className = 'oc-items';
  for (const item of order.items) {
    const row = document.createElement('div');
    row.className = 'oc-item status-done';
    row.innerHTML = `
      <span class="qty">${item.quantity}×</span>
      <span class="name">${esc(item.item_name)}${item.note ? `<span class="note">${esc(item.note)}</span>` : ''}</span>
    `;
    itemsEl.appendChild(row);
  }
  card.appendChild(itemsEl);

  return card;
}

function renderCard(order) {
  const card = document.createElement('div');
  card.className = 'order-card';
  card.dataset.createdAt = order.sent_to_kitchen_at || order.created_at;

  const head = document.createElement('div');
  head.className = 'oc-head';
  head.innerHTML = `
    <div class="oc-head-row1">
      <span class="oc-number">${esc(cardTitle(order))}</span>
      <span class="oc-badge">${esc(badgeText(order))}</span>
    </div>
    <div class="oc-head-row2">
      <span class="oc-arrived">🕐 ${formatClock(order.sent_to_kitchen_at || order.created_at)}</span>
      <span class="oc-elapsed">⏱ 0:00</span>
    </div>
  `;
  card.appendChild(head);

  const itemsEl = document.createElement('div');
  itemsEl.className = 'oc-items';
  for (const item of order.items) {
    const row = document.createElement('div');
    row.className = `oc-item status-${item.kitchen_status}`;
    row.innerHTML = `
      <span class="qty">${item.quantity}×</span>
      <span class="name">${esc(item.item_name)}${item.note ? `<span class="note">${esc(item.note)}</span>` : ''}</span>
    `;
    row.onclick = () => cycleItemStatus(item.id, item.kitchen_status);
    itemsEl.appendChild(row);
  }
  card.appendChild(itemsEl);

  const allDone = order.items.length > 0 && order.items.every(i => i.kitchen_status === 'done');
  const readyBtn = document.createElement('button');
  readyBtn.className = 'oc-ready-btn';
  readyBtn.textContent = '✅ READY';
  readyBtn.disabled = !allDone;
  readyBtn.onclick = () => markReady(order.id);
  card.appendChild(readyBtn);

  return card;
}

function tickElapsed() {
  // :not(.dimmed) -- renderFinishedCard() and renderCancelledCard() never set
  // dataset.createdAt, so without this scope toEpochMs(undefined) -> NaN ->
  // both threshold comparisons false -> elapsedClass's fallback ('elapsed-ok')
  // paints a misleading green "on time" border on cards outside the live timer.
  document.querySelectorAll('.order-card:not(.dimmed)').forEach(card => {
    const elapsedMs = nowMs() - toEpochMs(card.dataset.createdAt);
    const cls = elapsedClass(elapsedMs);
    card.classList.toggle('elapsed-ok',     cls === 'elapsed-ok');
    card.classList.toggle('elapsed-warn',   cls === 'elapsed-warn');
    card.classList.toggle('elapsed-danger', cls === 'elapsed-danger');
    const label = card.querySelector('.oc-elapsed');
    if (label) label.textContent = '⏱ ' + formatElapsed(elapsedMs);
  });
}

// Every mutation also triggers the server's own SSE broadcast back to the
// client that made it (broadcastOrdersChanged() has no way to know who
// caused the change), so the direct refresh() below and the SSE-triggered
// one arrive within milliseconds of each other -- without coalescing, every
// single click did a full extra /kds/active fetch + board re-render.
let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refresh();
    if (finishedModalOpen) refreshFinishedModal();
    if (cancelledModalOpen) refreshCancelledModal(); else pollCancelledDot();
  }, 120);
}

async function cycleItemStatus(itemId, currentStatus) {
  const next = NEXT_STATUS[currentStatus] || 'pending';
  // Optimistic: update locally and re-render immediately so the tap feels
  // instant, rather than waiting on a full network round trip.
  for (const order of orders) {
    const item = order.items.find(i => i.id === itemId);
    if (item) { item.kitchen_status = next; break; }
  }
  render();

  const res = await apiPatch(`/api/pos/order-items/${itemId}/kitchen-status`, { status: next });
  if (!res.ok) {
    showToast(res.data.message || 'Failed to update item.', 'error');
    refresh(); // reconcile with server truth -- the optimistic update above was wrong
    return;
  }
  scheduleRefresh();
}

async function markReady(orderId) {
  const res = await apiPost(`/api/pos/orders/${orderId}/ready`, {});
  if (res.ok) {
    if (res.data.fully_ready) {
      beep();
      showToast('Order ready!');
    } else {
      showToast('Your items are ready — waiting on other station(s).');
    }
    scheduleRefresh();
  } else {
    showToast(res.data.message || 'Failed to mark ready.', 'error');
  }
}

async function markServed(orderId) {
  const res = await apiPost(`/api/pos/orders/${orderId}/served`, {});
  if (res.ok) scheduleRefresh();
  else showToast(res.data.message || 'Failed to mark served.', 'error');
}

let stream = null;

function connectStream() {
  const token = getTerminalToken();
  const es = new EventSource(`/api/pos/kds/stream?token=${encodeURIComponent(token)}`);
  es.onopen = () => setConnDot(true);
  es.onerror = () => {
    setConnDot(false);
    // The browser's default auto-reconnect isn't reliable behind every
    // proxy after a hard connection reset -- explicitly reconnect once the
    // connection is confirmed closed rather than trusting it silently.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      setTimeout(() => { if (stream === es) connectStream(); }, 3000);
    }
  };
  es.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.type === 'orders_changed') scheduleRefresh();
    } catch { /* ignore keep-alive comments */ }
  };
  stream = es;
  return es;
}

// The browser's own reconnect backoff can take a few seconds; when the OS
// reports connectivity back, jump the queue instead of waiting for it.
window.addEventListener('online', () => {
  if (stream) stream.close();
  connectStream();
  refresh();
});

function tickClock() {
  const el = document.getElementById('clock');
  const d = new Date(nowMs());
  const time = d.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Phnom_Penh' });
  const date = d.toLocaleDateString('en-GB', { timeZone: 'Asia/Phnom_Penh', day: '2-digit', month: 'short', year: 'numeric' });
  el.textContent = `${date} ${time}`;
}

let appStarted = false;

async function startApp(terminal) {
  const info = terminal || getTerminalInfo();
  const brandEl = document.querySelector('#topBar .brand');
  if (brandEl && info) brandEl.textContent = `🍳 ${info.name || info.terminal_id}`;

  await refresh();
  pollCancelledDot();
  if (stream) stream.close();
  connectStream();

  if (!appStarted) {
    appStarted = true;
    setInterval(refresh, SAFETY_POLL_MS);
    setInterval(() => { tickElapsed(); tickClock(); }, 1000);
  }
}

window.kdsOpenFinished   = openFinishedModal;
window.kdsCloseFinished  = closeFinishedModal;
window.kdsClearFinished  = clearFinishedOrders;
window.kdsOpenCancelled  = openCancelledModal;
window.kdsCloseCancelled = closeCancelledModal;
window.kdsClearCancelled = clearCancelledOrders;

function requireLogin() {
  showTerminalLogin({ label: 'KDS Terminal Login', onSuccess: startApp });
}

window.addEventListener('terminal-logged-out', requireLogin);

if (!getTerminalToken()) requireLogin();
else startApp();
