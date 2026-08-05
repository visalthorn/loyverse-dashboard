// Generic idempotency ledger for offline-queue-sensitive mutations
// (pos_idempotent_requests, migrations/022). A client_mutation_id (UUID v4,
// generated once on the device before the FIRST attempt -- live or queued --
// of a given logical action) is checked before running the business logic;
// on a repeat id the ORIGINAL cached response is replayed verbatim instead
// of re-running the handler.
//
// Why this actually prevents duplicates: the record+commit happens in the
// SAME transaction as the row it's protecting. If the business logic throws
// (a genuine validation/conflict rejection), the whole transaction --
// including any idempotency bookkeeping -- rolls back with it, so nothing is
// ever cached for a failed attempt; a retry just tries fresh. Only a
// COMMITTED success is ever replayable, which is exactly the "server
// committed but the client never saw the response" case this exists for.
//
// Both functions take the in-transaction `client` (not the pool) so the
// check and the eventual insert are part of the same atomic unit as the
// row(s) they're guarding.

async function findIdempotentResponse(client, clientMutationId) {
  if (!clientMutationId) return null;
  const { rows } = await client.query(
    `SELECT status_code, response_body FROM pos_idempotent_requests WHERE client_mutation_id = $1`,
    [clientMutationId]
  );
  return rows.length ? { statusCode: rows[0].status_code, body: rows[0].response_body } : null;
}

async function recordIdempotentResponse(client, clientMutationId, endpoint, orderId, statusCode, body) {
  if (!clientMutationId) return;
  // ON CONFLICT DO NOTHING: defensive only -- this architecture's queue is
  // strictly sequential per device, so two requests bearing the same id
  // in flight at once shouldn't happen, but a no-op here is harmless if it
  // somehow does (the caller already has its own result to return).
  await client.query(
    `INSERT INTO pos_idempotent_requests (client_mutation_id, endpoint, order_id, status_code, response_body)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (client_mutation_id) DO NOTHING`,
    [clientMutationId, endpoint, orderId, statusCode, JSON.stringify(body)]
  );
}

module.exports = { findIdempotentResponse, recordIdempotentResponse };
