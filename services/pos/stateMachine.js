// Single shared guard for every pos_orders status transition.
// open -> sent_to_kitchen -> preparing -> ready -> served -> paid | cancelled
const TERMINAL = new Set(['paid', 'cancelled']);
const FORWARD  = ['open', 'sent_to_kitchen', 'preparing', 'ready', 'served'];

// PAY and CANCEL are allowed from any non-terminal state — kitchen progress
// never gates payment (mirrors Loyverse: KDS completion is independent of
// checkout). Forward kitchen-status steps must happen strictly in sequence.
function canTransition(current, next) {
  if (TERMINAL.has(current)) return false;
  if (next === 'cancelled') return true;
  if (next === 'paid') return true;
  const curIdx  = FORWARD.indexOf(current);
  const nextIdx = FORWARD.indexOf(next);
  return curIdx !== -1 && nextIdx === curIdx + 1;
}

module.exports = { canTransition, TERMINAL, FORWARD };
