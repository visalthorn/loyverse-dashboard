import { getCsrfToken, refreshSession, terminalLogout } from './terminalAuth.js';

// Offline-queue hardening (POS audit, 2026-08-01). Queue storage moved from
// localStorage to IndexedDB -- localStorage's ~5-10MB practical quota can be
// exceeded by a long outage/busy night with no warning (setItem throws
// synchronously and the old code had no try/catch around it, silently
// losing the mutation). IndexedDB has a far higher practical ceiling and
// every write here is explicitly awaited, so a failure surfaces instead of
// vanishing.
//
// Queue entry shape:
//   { id (autoincrement), url, method, body, clientMutationId,
//     localId, dependsOnLocalId, status: 'pending'|'dead',
//     attempt, nextAttemptAt, lastError, createdAt }
//
// - clientMutationId: attached to body.client_mutation_id for
//   idempotency-sensitive endpoints (create order, append items, pay) --
//   see services/pos/idempotency.js. Lets a lost-response retry replay the
//   ORIGINAL server result instead of creating a second real row.
// - localId: set only on a create-order entry -- the provisional order
//   number (e.g. PP-POS-01-OFF-0007) this entry resolves once it succeeds.
// - dependsOnLocalId: set on a follow-up action (append/pay/etc) built
//   against an order that hasn't synced yet. Its `url` contains a
//   `{{LOCAL:<id>}}` placeholder instead of a real numeric order id --
//   resolved in place the moment the matching create entry succeeds. An
//   entry with an unresolved dependency is skipped every pass, never
//   failed, never counted against its own retry backoff.
// - status 'dead': a genuine 4xx rejection on replay (a real business
//   rule violation once the world changed, e.g. the table got taken by
//   someone else while this device was offline) -- requires explicit staff
//   action (retry or discard) from the queue panel, never auto-retried and
//   never silently dropped. Order-field version conflicts no longer land
//   here (POS revision, 2026-08-02) -- see isStaleVersion in routes/pos.js.

const DB_NAME       = 'pos_offline_db';
const DB_VERSION    = 1;
const STORE         = 'queue';
const LEGACY_LS_KEY  = 'pos_offline_queue';

const REQUEST_TIMEOUT_MS = 5000;
const TICK_MS             = 2000;   // how often we check for due entries
const BACKOFF_BASE_MS     = 2000;   // 2s
const BACKOFF_CAP_MS      = 60000;  // 60s cap
const MAX_QUEUE_SIZE      = 500;
const WARN_QUEUE_SIZE     = Math.floor(MAX_QUEUE_SIZE * 0.8);

let queueChangeListener   = null; // (pendingCount, deadCount)
let replaySuccessListener = null; // (entry, responseData)
let replayRejectedListener = null; // (entry, responseData) -- dead-lettered (4xx)
let deadLetterListener    = null; // (entry) -- fired whenever something NEW lands in dead-letter
let syncSummaryListener   = null; // ({synced, deadLettered, stillPending})
let queueNearLimitListener = null; // (count)

let lastSyncAt = null; // epoch ms of the last drain pass that synced >=1 entry

// Reactive connectivity signal -- no dedicated polling probe (navigator.onLine
// is known to lie on WiFi-connected-but-no-internet, exactly this app's
// failure mode, but a separate GET /health poll was scoped out). Instead this
// flips based on the real outcome of every mutate()/drain request: false the
// instant any request actually reaches the server, true the instant one
// times out or errors at the network layer. Accurate as of the last real
// attempt, which for the POS is frequent (every user action, plus the 2s
// drain tick whenever the queue is non-empty).
let offline = false;
let connectivityListener = null;
export function onConnectivityChange(fn) { connectivityListener = fn; fn(offline); }
export function isOffline() { return offline; }
function setOffline(v) {
  if (v === offline) return;
  offline = v;
  if (connectivityListener) connectivityListener(offline);
}

// ── IndexedDB plumbing ──────────────────────────────────────────────────────

let dbPromise = null;
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGetAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbPut(entry) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put(entry);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// One-time migration: any entries left in the old localStorage queue (from
// before this rewrite shipped) are carried over as plain pending entries --
// they predate client_mutation_id/localId/dependsOnLocalId, so they replay
// exactly like before (no idempotency protection, no dependency chaining),
// same as a mutate() call made with no options today.
async function migrateFromLocalStorage() {
  let legacy;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_LS_KEY) || 'null'); }
  catch { legacy = null; }
  if (!Array.isArray(legacy) || !legacy.length) {
    if (legacy) localStorage.removeItem(LEGACY_LS_KEY);
    return;
  }
  for (const old of legacy) {
    await idbPut({
      url: old.url, method: old.method, body: old.body || {},
      clientMutationId: null, localId: old.localId || null, dependsOnLocalId: null,
      status: 'pending', attempt: 0, nextAttemptAt: 0, lastError: null,
      createdAt: old.ts || Date.now(),
    });
  }
  localStorage.removeItem(LEGACY_LS_KEY);
  console.log(`[offlineQueue] migrated ${legacy.length} entr${legacy.length === 1 ? 'y' : 'ies'} from localStorage to IndexedDB`);
}

// ── Listeners / status ───────────────────────────────────────────────────────

async function notifyQueueChange() {
  if (!queueChangeListener) return;
  const all = await idbGetAll();
  const pending = all.filter(e => e.status === 'pending').length;
  const dead    = all.filter(e => e.status === 'dead').length;
  queueChangeListener(pending, dead);
  if (pending >= WARN_QUEUE_SIZE && queueNearLimitListener) queueNearLimitListener(pending);
}

export function onQueueChange(fn)    { queueChangeListener = fn; notifyQueueChange(); }
export function onReplaySuccess(fn)  { replaySuccessListener = fn; }
export function onReplayRejected(fn) { replayRejectedListener = fn; }
export function onDeadLetter(fn)     { deadLetterListener = fn; }
export function onSyncSummary(fn)    { syncSummaryListener = fn; }
export function onQueueNearLimit(fn) { queueNearLimitListener = fn; }

export function getLastSyncAt() { return lastSyncAt; }

export async function getQueueSnapshot() {
  const all = await idbGetAll();
  return {
    pending: all.filter(e => e.status === 'pending').sort((a, b) => a.id - b.id),
    dead:    all.filter(e => e.status === 'dead').sort((a, b) => a.id - b.id),
  };
}

export async function retryDeadLetter(id) {
  const all = await idbGetAll();
  const entry = all.find(e => e.id === id);
  if (!entry) return;
  entry.status = 'pending';
  entry.attempt = 0;
  entry.nextAttemptAt = 0;
  entry.lastError = null;
  await idbPut(entry);
  notifyQueueChange();
}

export async function discardDeadLetter(id) {
  await idbDelete(id);
  notifyQueueChange();
}

// Cancelling an order that hasn't synced yet doesn't need a server
// round-trip at all -- there's no real order to cancel yet. Just remove its
// still-pending create entry (and anything queued that depends on it, e.g.
// an append-items chained to it) so it's never sent in the first place.
export async function cancelQueuedLocalOrder(localId) {
  const all = await idbGetAll();
  for (const entry of all) {
    if (entry.localId === localId || entry.dependsOnLocalId === localId) {
      await idbDelete(entry.id);
    }
  }
  await notifyQueueChange();
}

// Terminal-prefixed provisional order number -- shown on screen/print while
// an order hasn't synced yet. Per-device counter (own localStorage key),
// distinct across terminals by construction since each terminal's own code
// is the prefix (no cross-terminal collision the way a bare "LOCAL-0007"
// counter could produce -- two different devices now show two different
// strings even if their own internal counters happen to match).
export function nextLocalOrderNumber(terminalCode) {
  const key = `pos_local_order_seq_${terminalCode || 'unknown'}`;
  const n = (parseInt(localStorage.getItem(key) || '0', 10) || 0) + 1;
  localStorage.setItem(key, String(n));
  const prefix = terminalCode || 'POS';
  return `${prefix}-OFF-${String(n).padStart(4, '0')}`;
}

// ── Network ──────────────────────────────────────────────────────────────

async function rawFetch(url, method, body, csrfToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json' };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  try {
    return await fetch(url, {
      method, credentials: 'same-origin', headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function timedFetch(url, method, body) {
  let r;
  try { r = await rawFetch(url, method, body, getCsrfToken()); }
  catch { setOffline(true); return { ok: false, status: 0, data: {}, networkError: true }; }

  if (r.status === 401) {
    // A queued mutation can easily replay well after the 12h session JWT
    // expired -- that's not a real rejection, so try the same silent
    // refresh-then-retry the live request wrapper uses before giving up.
    const refreshed = await refreshSession();
    if (refreshed.ok) {
      try { r = await rawFetch(url, method, body, getCsrfToken()); }
      catch { setOffline(true); return { ok: false, status: 0, data: {}, networkError: true }; }
    }
    if (r.status === 401) {
      terminalLogout();
      setOffline(false);
      return { ok: false, status: 401, data: {}, networkError: false };
    }
  }

  setOffline(false); // reached the server at all -- whatever the outcome, we're online
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data, networkError: false };
}

function backoffMs(attempt) {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

// ── Enqueue ──────────────────────────────────────────────────────────────

async function enqueue({ url, method, body, localId, dependsOnLocalId, clientMutationId }) {
  await idbPut({
    url, method, body: body || {}, clientMutationId: clientMutationId || null,
    localId: localId || null, dependsOnLocalId: dependsOnLocalId || null,
    status: 'pending', attempt: 0, nextAttemptAt: 0, lastError: null,
    createdAt: Date.now(),
  });
  await notifyQueueChange();
}

// Main entry point for POS mutations. Behaves like a normal fetch wrapper on
// a reachable server (returns {ok,status,data}); on a connectivity failure
// it queues the request for later replay and returns {queued:true} instead
// of surfacing an error.
//
// opts:
//   idempotent        -- attach a fresh client_mutation_id so a lost-response
//                         retry replays the original result (create/append/pay).
//   localId            -- set only on a create-order call: the provisional
//                         number this entry resolves once it succeeds.
//   dependsOnLocalId    -- set when this action targets an order that hasn't
//                         synced yet (currentOrder._queued). `url` must
//                         already contain `{{LOCAL:<id>}}` in place of the
//                         real order id. Never attempted live -- goes
//                         straight to the queue, resolved once its parent
//                         create entry succeeds.
export async function mutate(url, method, body, opts = {}) {
  const { localId = null, dependsOnLocalId = null, idempotent = false } = opts;

  const finalBody = { ...(body || {}) };
  let clientMutationId = null;
  if (idempotent) {
    clientMutationId = crypto.randomUUID();
    finalBody.client_mutation_id = clientMutationId;
  }

  if (dependsOnLocalId) {
    await enqueue({ url, method, body: finalBody, localId, dependsOnLocalId, clientMutationId });
    return { ok: false, status: 0, data: {}, queued: true };
  }

  const result = await timedFetch(url, method, finalBody);
  if (result.networkError) {
    await enqueue({ url, method, body: finalBody, localId, dependsOnLocalId: null, clientMutationId });
    return { ok: false, status: 0, data: {}, queued: true };
  }
  return { ok: result.ok, status: result.status, data: result.data, queued: false };
}

// ── Drain ────────────────────────────────────────────────────────────────

function resolvePlaceholder(url, localId, realId) {
  return url.replace(`{{LOCAL:${localId}}}`, String(realId));
}

let draining = false;

async function drainOnce() {
  const started = Date.now();
  const all = await idbGetAll();
  const pending = all.filter(e => e.status === 'pending').sort((a, b) => a.id - b.id);
  if (!pending.length) return { synced: 0, deadLettered: 0, progress: false };

  let networkDown = false;
  let synced = 0, deadLettered = 0, skippedDependency = 0, skippedBackoff = 0;
  let progress = false;
  const now = Date.now();

  for (const entry of pending) {
    if (entry.dependsOnLocalId) { skippedDependency++; continue; }
    if (networkDown) continue; // preserve ordering, stop hammering a still-down server this pass
    if (entry.nextAttemptAt && entry.nextAttemptAt > now) { skippedBackoff++; continue; }

    const result = await timedFetch(entry.url, entry.method, entry.body);

    if (result.networkError) {
      networkDown = true;
      entry.attempt += 1;
      entry.nextAttemptAt = Date.now() + backoffMs(entry.attempt);
      await idbPut(entry);
      continue;
    }

    if (result.ok) {
      await idbDelete(entry.id);
      synced++; progress = true;
      lastSyncAt = Date.now();
      if (replaySuccessListener) replaySuccessListener(entry, result.data);

      // Resolve any dependents waiting on this create entry.
      if (entry.localId) {
        const realOrderId = result.data && result.data.order && result.data.order.id;
        if (realOrderId != null) {
          const rest = await idbGetAll();
          for (const other of rest) {
            if (other.dependsOnLocalId === entry.localId) {
              other.url = resolvePlaceholder(other.url, entry.localId, realOrderId);
              other.dependsOnLocalId = null;
              await idbPut(other);
              progress = true;
            }
          }
        }
      }
      continue;
    }

    // Genuine rejection -- not a connectivity failure.
    if (result.status >= 500) {
      // Transient server-side failure -- keep retrying with backoff, never
      // silently dropped (unlike the old flat-15s-then-discard behaviour).
      entry.attempt += 1;
      entry.nextAttemptAt = Date.now() + backoffMs(entry.attempt);
      entry.lastError = result.data.message || `Server error (${result.status})`;
      await idbPut(entry);
      continue;
    }

    // 4xx -- a real business-rule rejection once the world changed (or a
    // stale request). Requires a human to look at it -- never auto-retried,
    // never silently dropped. Version conflicts on order-field edits no
    // longer land here (POS revision, 2026-08-02) -- those apply
    // last-write-wins server-side and come back as a 200 + notice instead.
    entry.status = 'dead';
    entry.lastError = result.data.message || `Rejected (${result.status})`;
    await idbPut(entry);
    deadLettered++; progress = true;
    if (replayRejectedListener) replayRejectedListener(entry, result.data);
    if (deadLetterListener) deadLetterListener(entry);

    // Cascade: anything still waiting on this (now-dead) create entry can
    // never resolve -- dead-letter it too instead of leaving it stuck
    // forever with an unresolved dependency.
    if (entry.localId) {
      const rest = await idbGetAll();
      for (const other of rest) {
        if (other.dependsOnLocalId === entry.localId && other.status === 'pending') {
          other.status = 'dead';
          other.dependsOnLocalId = null;
          other.lastError = `Parent order (${entry.localId}) failed to sync: ${entry.lastError}`;
          await idbPut(other);
          deadLettered++;
          if (replayRejectedListener) replayRejectedListener(other, { message: other.lastError });
          if (deadLetterListener) deadLetterListener(other);
        }
      }
    }
  }

  console.log(
    `[offlineQueue] drain: synced=${synced} dead-lettered=${deadLettered} ` +
    `skipped(dependency)=${skippedDependency} skipped(backoff)=${skippedBackoff} ` +
    `duration=${Date.now() - started}ms`
  );

  await notifyQueueChange();
  return { synced, deadLettered, progress };
}

// Runs drainOnce() repeatedly while it keeps making progress (a dependency
// just got resolved, or a create entry just succeeded and patched its
// dependents) so a "Sync now" tap or a single tick resolves a whole chain
// in one go instead of waiting for several separate ticks. Bounded so a
// pathological loop can't spin forever.
export async function syncNow() {
  if (draining) return;
  draining = true;
  try {
    let totalSynced = 0, totalDead = 0;
    for (let i = 0; i < 10; i++) {
      const { synced, deadLettered, progress } = await drainOnce();
      totalSynced += synced;
      totalDead += deadLettered;
      if (!progress) break;
    }
    if (totalSynced || totalDead) {
      const { pending } = await getQueueSnapshot();
      if (syncSummaryListener) {
        syncSummaryListener({ synced: totalSynced, deadLettered: totalDead, stillPending: pending.length });
      }
    }
  } finally {
    draining = false;
  }
}

export async function startOfflineQueue() {
  await migrateFromLocalStorage();
  await notifyQueueChange();
  setInterval(syncNow, TICK_MS);
  window.addEventListener('online', syncNow);
}
