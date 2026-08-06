import {
  getTerminalInfo, showTerminalLogin, bootSession, startIdleWatch,
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

// Ready-strip tap-to-confirm (see render()) -- first tap on a chip arms a
// 3s confirm window instead of marking served immediately.
let confirmingServeId = null;
let confirmingServeTimer = null;
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

// Row1 headline: just the name (order_number moves under the arrival time in
// row2 instead, see oc-order-no below) -- used by the full ticket cards, which
// have room for two lines. The ready-strip chip stays on cardTitle()'s single
// combined line since it has no separate time row to hang the number under.
function cardName(order) {
  return order.name || order.order_number;
}

function elapsedClass(ms) {
  if (ms >= dangerMs) return 'elapsed-danger';
  if (ms >= warnMs) return 'elapsed-warn';
  return 'elapsed-ok';
}

// Paints a ready-chip for its current armed/unarmed state. Kept separate from
// render() so the arming tap can update the tapped chip in place: the previous
// code called render(), which removed the very node being tapped and appended a
// replacement. On iPad that made the follow-up confirm tap land on a node that
// had only just been inserted, and WebKit routinely dropped it -- the chip sat
// on "Tap again to confirm" and the order could never be cleared from the
// "Ready for pickup" strip. Same in-place-mutation reasoning as
// updateReadyButtonForOrder() below.
function paintChip(chip, order) {
  const confirming = confirmingServeId === order.id;
  chip.classList.toggle('confirm-serve', confirming);
  chip.innerHTML = `<span class="rc-title">${esc(cardTitle(order))}</span><span class="rc-sub">${confirming ? 'Tap again to confirm' : esc(badgeText(order))}</span>`;
}

function repaintChipById(orderId) {
  const chip = document.querySelector(`.ready-chip[data-order-id="${orderId}"]`);
  const order = orders.find(o => o.id === orderId);
  if (chip && order) paintChip(chip, order);
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

  // Chips are reused across renders, keyed by order id, rather than torn down
  // and rebuilt. render() runs on every SSE broadcast and on the 30s safety
  // poll, so a chip the user had just armed used to be replaced mid-confirm by
  // an unrelated order's change -- their second tap then hit a node that was
  // seconds old, which is exactly the case iPad drops. Reused nodes keep both
  // their identity and their armed state.
  const strip = document.getElementById('readyStrip');
  const existingChips = new Map(
    [...strip.querySelectorAll('.ready-chip')].map(el => [el.dataset.orderId, el])
  );
  const emptyMsg = strip.querySelector('#emptyReadyMsg');
  if (emptyMsg) emptyMsg.remove();

  if (!ready.length) {
    existingChips.forEach(el => el.remove());
    strip.insertAdjacentHTML('beforeend', '<span id="emptyReadyMsg">Nothing ready</span>');
  } else {
    for (const order of ready) {
      const key = String(order.id);
      const chip = existingChips.get(key) || document.createElement('div');
      existingChips.delete(key);
      chip.className = 'ready-chip';
      chip.dataset.orderId = order.id;
      paintChip(chip, order);
      // A crowded strip touched by busy hands shouldn't drop an order off
      // the ready list on a single mis-tap -- first tap arms a 3s confirm
      // window (re-tap to actually mark served), matching how easy it is
      // to accidentally brush this strip while grabbing a plate.
      //
      // Reads confirmingServeId live rather than closing over a value captured
      // at render time: the arming tap now repaints this same node in place
      // (see paintChip) instead of calling render(), so a stale captured flag
      // would leave the chip permanently stuck on its first tap.
      chip.onclick = () => {
        if (confirmingServeId === order.id) {
          clearTimeout(confirmingServeTimer);
          confirmingServeId = null;
          paintChip(chip, order);
          markServed(order.id);
        } else {
          // Un-arm whatever else was mid-confirm, so only one chip is ever lit.
          const prev = confirmingServeId;
          confirmingServeId = order.id;
          if (prev) repaintChipById(prev);
          clearTimeout(confirmingServeTimer);
          confirmingServeTimer = setTimeout(() => {
            const armed = confirmingServeId;
            confirmingServeId = null;
            if (armed) repaintChipById(armed);
          }, 3000);
          paintChip(chip, order);
        }
      };
      strip.appendChild(chip); // also re-orders reused chips to match `ready`
    }
    // Whatever is left was served/cancelled elsewhere -- drop those nodes.
    existingChips.forEach(el => el.remove());
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
      <span class="oc-number">${esc(cardName(order))}</span>
      <span class="oc-badge">${esc(badgeText(order))}</span>
    </div>
    <div class="oc-head-row2">
      <span class="oc-time-block">
        <span class="oc-arrived">🚫 ${formatClock(order.cancelled_at)}</span>
        <span class="oc-order-no">${esc(order.order_number)}</span>
      </span>
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
      <span class="name"><span class="name-text">${esc(item.item_name)}</span>${item.note ? `<span class="note">⚠ ${esc(item.note)}</span>` : ''}</span>
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
      <span class="oc-number">${esc(cardName(order))}</span>
      <span class="oc-badge">${esc(badgeText(order))}</span>
    </div>
    <div class="oc-head-row2">
      <span class="oc-time-block">
        <span class="oc-arrived">🕐 ${formatClock(order.sent_to_kitchen_at || order.created_at)}</span>
        <span class="oc-order-no">${esc(order.order_number)}</span>
      </span>
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
      <span class="name"><span class="name-text">${esc(item.item_name)}</span>${item.note ? `<span class="note">⚠ ${esc(item.note)}</span>` : ''}</span>
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
  card.dataset.orderId = order.id;

  const head = document.createElement('div');
  head.className = 'oc-head';
  head.innerHTML = `
    <div class="oc-head-row1">
      <span class="oc-number">${esc(cardName(order))}</span>
      <span class="oc-badge">${esc(badgeText(order))}</span>
    </div>
    <div class="oc-head-row2">
      <span class="oc-time-block">
        <span class="oc-arrived">🕐 ${formatClock(order.sent_to_kitchen_at || order.created_at)}</span>
        <span class="oc-order-no">${esc(order.order_number)}</span>
      </span>
      <span class="oc-elapsed">⏱ 0:00</span>
    </div>
  `;
  card.appendChild(head);

  const itemsEl = document.createElement('div');
  itemsEl.className = 'oc-items';
  for (const item of order.items) {
    const row = document.createElement('div');
    row.className = `oc-item status-${item.kitchen_status}`;
    row.dataset.itemId = item.id;
    row.innerHTML = `
      <span class="qty">${item.quantity}×</span>
      <span class="name"><span class="name-text">${esc(item.item_name)}</span>${item.note ? `<span class="note">⚠ ${esc(item.note)}</span>` : ''}</span>
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
    // Danger gets its own glyph, not just a color shift -- color-only
    // urgency cues are easy to miss at a glance and unreadable for
    // colorblind staff.
    if (label) label.textContent = (cls === 'elapsed-danger' ? '⚠ ' : '⏱ ') + formatElapsed(elapsedMs);
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

// Patches the single tapped row's status class in place (plus its card's
// READY button) instead of calling the full render() -- render() tears down
// and recreates every card's DOM from scratch, so a CSS transition/animation
// on the status-done strike (see .oc-item .name::after in kds.html) never
// had a live node to animate: the new node is just born already in its
// final state. Mutating the existing node is also what makes this feel
// instant rather than causing every other card on the board to flicker on
// an unrelated tap.
function updateReadyButtonForOrder(order) {
  const card = document.querySelector(`.order-card[data-order-id="${order.id}"]`);
  const btn = card && card.querySelector('.oc-ready-btn');
  if (!btn) return;
  const allDone = order.items.length > 0 && order.items.every(i => i.kitchen_status === 'done');
  btn.disabled = !allDone;
}

async function cycleItemStatus(itemId, currentStatus) {
  const next = NEXT_STATUS[currentStatus] || 'pending';
  let owningOrder = null;
  for (const order of orders) {
    const item = order.items.find(i => i.id === itemId);
    if (item) { item.kitchen_status = next; owningOrder = order; break; }
  }

  const row = document.querySelector(`.oc-item[data-item-id="${itemId}"]`);
  if (!row || !owningOrder) { render(); } // fell out of sync with the DOM -- fall back to a full rebuild
  else {
    row.className = `oc-item status-${next}`;
    updateReadyButtonForOrder(owningOrder);
  }

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
  // Cookies ride along automatically on a same-origin EventSource request
  // once withCredentials is set -- no token in the URL, so nothing auth-
  // related leaks into server logs, proxies, or browser history.
  const es = new EventSource('/api/pos/kds/stream', { withCredentials: true });
  es.onopen = () => setConnDot(true);
  es.onerror = async () => {
    setConnDot(false);
    // The browser's default auto-reconnect isn't reliable behind every
    // proxy after a hard connection reset -- explicitly reconnect once the
    // connection is confirmed closed rather than trusting it silently.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      // A closed connection is most often a stale/expired session cookie
      // (SSE has no other way to signal 401) -- try a silent refresh once
      // before reconnecting so a lapsed 12h session doesn't need a manual
      // PIN re-entry mid-shift.
      const refreshed = await bootSession();
      if (!refreshed.ok) { requireLogin(); return; }
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
  pollCancelledDot();
});

function tickClock() {
  const el = document.getElementById('clock');
  const d = new Date(nowMs());
  const time = d.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Phnom_Penh' });
  const date = d.toLocaleDateString('en-GB', { timeZone: 'Asia/Phnom_Penh', day: '2-digit', month: 'short', year: 'numeric' });
  el.textContent = `${date} ${time}`;
}

let appStarted = false;

async function startApp(terminal, idleTimeoutMinutes) {
  const info = terminal || getTerminalInfo();
  const brandEl = document.querySelector('#topBar .brand');
  if (brandEl && info) brandEl.textContent = `🍳 ${info.name || info.terminal_id}`;

  await refresh();
  pollCancelledDot();
  if (stream) stream.close();
  connectStream();

  if (!appStarted) {
    appStarted = true;
    startIdleWatch(idleTimeoutMinutes ?? (info && info.idle_timeout_minutes) ?? 30);
    setInterval(() => { refresh(); pollCancelledDot(); }, SAFETY_POLL_MS);
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

// Boot refresh happens first, before rendering anything -- if the device
// cookie is still good, staff land straight on the board with no login
// prompt, no matter how long since the tablet was last touched or rebooted.
(async () => {
  const result = await bootSession();
  if (result.ok) startApp(result.terminal, result.idle_timeout_minutes);
  else requireLogin();
})();
