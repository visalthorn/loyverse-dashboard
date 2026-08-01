// Bounds-checked client-supplied action timestamp. An offline order/payment/
// etc. should be recorded at the time the action actually happened on the
// device, not at server replay time once connectivity returns -- otherwise
// an outage spanning midnight silently misattributes the sale to the wrong
// Cambodia business day (receipt_date drives every day-bucketed report).
// Falls back to the server's own clock whenever the client value is
// missing, unparseable, or outside a sane window -- a broken device clock
// must never be trusted to corrupt a financial record.

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;       // 5min -- ordinary clock-drift allowance
const MAX_BACKDATE_MS    = 72 * 60 * 60 * 1000; // 72h -- covers a long outage/weekend, not indefinite

function resolveActionTime(clientTimeIso) {
  if (!clientTimeIso) return new Date();
  const parsed = new Date(clientTimeIso);
  if (isNaN(parsed.getTime())) return new Date();
  const diffMs = Date.now() - parsed.getTime();
  if (diffMs < -MAX_FUTURE_SKEW_MS || diffMs > MAX_BACKDATE_MS) return new Date();
  return parsed;
}

module.exports = { resolveActionTime };
