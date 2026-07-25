import {
  getTerminalToken, getTerminalInfo, showTerminalLogin,
  fetchTerminalJSON as fetchJSON, terminalApiPatch as apiPatch, terminalApiPost as apiPost,
} from './terminalAuth.js';

const NEXT_STATUS = { pending: 'preparing', preparing: 'done', done: 'pending' };
const WARN_MS   = 10 * 60 * 1000;
const DANGER_MS = 20 * 60 * 1000;
const SAFETY_POLL_MS = 30 * 1000;

let orders = [];        // raw orders from /kds/active (sent_to_kitchen | preparing | ready)
let clockOffsetMs = 0;  // (server "now" ms) - (Date.now() at fetch time)

// server_now arrives as a naive "YYYY-MM-DD HH:mm:ss" string (no zone), but
// order.created_at goes through Express's JSON serialization of a Date
// object first, which already produces a full ISO string ending in "Z" --
// blindly appending another "Z" there made an invalid double-"Z" string
// (Invalid Date -> NaN elapsed). Only append when it isn't already present.
function parseNaive(ts) {
  const s = String(ts).replace(' ', 'T');
  return new Date(s.endsWith('Z') ? s : s + 'Z').getTime();
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
  clockOffsetMs = parseNaive(data.server_now) - Date.now();
  orders = data.orders;
  noCategoriesAssigned = !!data.no_categories_assigned;
  render();
}

function badgeText(order) {
  return order.table_number ? `Table ${order.table_number}` : order.dining_option;
}

function elapsedClass(ms) {
  if (ms >= DANGER_MS) return 'elapsed-danger';
  if (ms >= WARN_MS) return 'elapsed-warn';
  return '';
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
      chip.innerHTML = `<span class="rc-title">${order.order_number}</span><span class="rc-sub">${badgeText(order)}</span>`;
      chip.onclick = () => markServed(order.id);
      strip.appendChild(chip);
    }
  }

  tickElapsed();
}

function renderCard(order) {
  const card = document.createElement('div');
  card.className = 'order-card';
  card.dataset.createdAt = order.created_at;

  const head = document.createElement('div');
  head.className = 'oc-head';
  head.innerHTML = `
    <span class="oc-number">${order.order_number}</span>
    <span class="oc-badge">${badgeText(order)}</span>
    <span class="oc-elapsed">0:00</span>
  `;
  card.appendChild(head);

  const itemsEl = document.createElement('div');
  itemsEl.className = 'oc-items';
  for (const item of order.items) {
    const row = document.createElement('div');
    row.className = `oc-item status-${item.kitchen_status}`;
    row.innerHTML = `
      <span class="qty">${item.quantity}×</span>
      <span class="name">${item.item_name}${item.note ? `<span class="note">${item.note}</span>` : ''}</span>
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
  document.querySelectorAll('.order-card').forEach(card => {
    const elapsedMs = nowMs() - parseNaive(card.dataset.createdAt);
    const cls = elapsedClass(elapsedMs);
    card.classList.toggle('elapsed-warn', cls === 'elapsed-warn');
    card.classList.toggle('elapsed-danger', cls === 'elapsed-danger');
    const label = card.querySelector('.oc-elapsed');
    if (label) label.textContent = formatElapsed(elapsedMs);
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
  refreshTimer = setTimeout(refresh, 120);
}

async function cycleItemStatus(itemId, currentStatus) {
  const next = NEXT_STATUS[currentStatus] || 'pending';
  const res = await apiPatch(`/api/pos/order-items/${itemId}/kitchen-status`, { status: next });
  if (res.ok) scheduleRefresh();
}

async function markReady(orderId) {
  const res = await apiPost(`/api/pos/orders/${orderId}/ready`, {});
  if (res.ok) {
    beep();
    scheduleRefresh();
  }
}

async function markServed(orderId) {
  const res = await apiPost(`/api/pos/orders/${orderId}/served`, {});
  if (res.ok) scheduleRefresh();
}

let stream = null;

function connectStream() {
  const token = getTerminalToken();
  const es = new EventSource(`/api/pos/kds/stream?token=${encodeURIComponent(token)}`);
  es.onopen = () => setConnDot(true);
  es.onerror = () => setConnDot(false);
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
  el.textContent = d.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'UTC' });
}

let appStarted = false;

async function startApp(terminal) {
  const info = terminal || getTerminalInfo();
  const brandEl = document.querySelector('#topBar .brand');
  if (brandEl && info) brandEl.textContent = `🍳 ${info.name || info.terminal_id}`;

  await refresh();
  if (stream) stream.close();
  connectStream();

  if (!appStarted) {
    appStarted = true;
    setInterval(refresh, SAFETY_POLL_MS);
    setInterval(() => { tickElapsed(); tickClock(); }, 1000);
  }
}

function requireLogin() {
  showTerminalLogin({ label: 'KDS Terminal Login', onSuccess: startApp });
}

window.addEventListener('terminal-logged-out', requireLogin);

if (!getTerminalToken()) requireLogin();
else startApp();
