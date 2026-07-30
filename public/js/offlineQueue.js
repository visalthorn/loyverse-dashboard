import { getCsrfToken, refreshSession, terminalLogout } from './terminalAuth.js';

const QUEUE_KEY     = 'pos_offline_queue';
const LOCAL_SEQ_KEY  = 'pos_local_order_seq';
const REQUEST_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS  = 15000;

let queueChangeListener  = null;
let replaySuccessListener = null;
let replayRejectedListener = null;

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch { return []; }
}

function saveQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  if (queueChangeListener) queueChangeListener(queue.length);
}

export function queueLength() {
  return loadQueue().length;
}

export function onQueueChange(fn) {
  queueChangeListener = fn;
  fn(queueLength()); // fire once immediately so the UI starts in sync
}

// Called once with (entry, responseData) whenever a queued request is
// successfully replayed against the server.
export function onReplaySuccess(fn) {
  replaySuccessListener = fn;
}

// Called with (entry, responseData) whenever a queued request replays and
// comes back rejected (a real 4xx/5xx, not a connectivity failure) -- lets
// the caller un-stick any local state that was optimistically built around
// the assumption the request would eventually succeed.
export function onReplayRejected(fn) {
  replayRejectedListener = fn;
}

export function nextLocalOrderNumber() {
  const n = (parseInt(localStorage.getItem(LOCAL_SEQ_KEY) || '0', 10) || 0) + 1;
  localStorage.setItem(LOCAL_SEQ_KEY, String(n));
  return `LOCAL-${String(n).padStart(4, '0')}`;
}

async function rawFetch(url, method, body, csrfToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  try {
    return await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function timedFetch(url, method, body) {
  let r;
  try {
    r = await rawFetch(url, method, body, getCsrfToken());
  } catch {
    return { ok: false, status: 0, data: {}, networkError: true };
  }

  if (r.status === 401) {
    // A queued mutation can easily replay well after the 12h session JWT
    // expired -- that's not a real rejection, so try the same silent
    // refresh-then-retry the live request wrapper uses before giving up.
    const refreshed = await refreshSession();
    if (refreshed.ok) {
      try {
        r = await rawFetch(url, method, body, getCsrfToken());
      } catch {
        return { ok: false, status: 0, data: {}, networkError: true };
      }
    }
    if (r.status === 401) {
      terminalLogout();
      return { ok: false, status: 401, data: {}, networkError: false };
    }
  }

  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data, networkError: false };
}

// Main entry point for POS mutations. Behaves like apiPost/apiPatch on a
// reachable server (returns {ok,status,data}); on a connectivity failure
// (timeout or network error) it queues {url,method,body,localId,ts} for
// later replay instead of surfacing an error, and returns {queued:true}.
export async function mutate(url, method, body, localId = null) {
  const result = await timedFetch(url, method, body);
  if (result.networkError) {
    const queue = loadQueue();
    queue.push({ url, method, body, localId, ts: Date.now() });
    saveQueue(queue);
    return { ok: false, status: 0, data: {}, queued: true };
  }
  return { ok: result.ok, status: result.status, data: result.data, queued: false };
}

async function retryQueue() {
  let queue = loadQueue();
  if (!queue.length) return;

  const remaining = [];
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    // Stop at the first still-unreachable entry to preserve ordering and
    // avoid hammering a server that's still down.
    if (remaining.length) { remaining.push(entry); continue; }

    const result = await timedFetch(entry.url, entry.method, entry.body);
    if (result.networkError) {
      remaining.push(entry);
      continue;
    }
    if (result.ok && replaySuccessListener) {
      replaySuccessListener(entry, result.data);
    } else if (!result.ok && replayRejectedListener) {
      replayRejectedListener(entry, result.data);
    }
    // A non-network response (success OR a real 4xx/5xx) resolves this
    // queue entry either way — a rejected request replayed verbatim will
    // keep failing the same way forever, so there's nothing to gain by
    // holding onto it.
  }
  queue = remaining;
  saveQueue(queue);
}

export function startOfflineQueue() {
  setInterval(retryQueue, RETRY_INTERVAL_MS);
  window.addEventListener('online', retryQueue);
}
