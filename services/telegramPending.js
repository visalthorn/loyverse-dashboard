const crypto = require('crypto');

// A parsed expense waiting for the sender to confirm which date it belongs to
// (see the date guard in routes/telegram.js). Held in memory on purpose: a
// confirmation is answered within seconds or minutes, and nothing is written
// to expenses until the sender taps a button, so a lost entry costs at most a
// re-send. A server restart drops them and the callback replies "expired".
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

const pending = new Map();

function prune(now = Date.now()) {
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
}

function putPending(payload, now = Date.now()) {
  prune(now);
  // Map preserves insertion order, so this drops the oldest entry first.
  while (pending.size >= MAX_ENTRIES) pending.delete(pending.keys().next().value);

  const id = crypto.randomBytes(4).toString('hex');
  pending.set(id, { ...payload, expiresAt: now + TTL_MS });
  return id;
}

// One-shot by design: taking an entry removes it, so a double-tapped button
// can't insert the same expense twice.
function takePending(id, now = Date.now()) {
  const entry = pending.get(id);
  pending.delete(id);
  if (!entry || entry.expiresAt <= now) return null;
  return entry;
}

function pendingSize() {
  return pending.size;
}

function clearPending() {
  pending.clear();
}

module.exports = { putPending, takePending, pendingSize, clearPending, TTL_MS, MAX_ENTRIES };
