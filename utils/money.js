// ── Revenue rule for Loyverse-sourced receipts ─────────────────────────────
//
// Loyverse models a refund as a SEPARATE receipt (receipt_type='REFUND'),
// linked back to the original sale via refund_for (the original receipt's
// receipt_number) -- the original SALE receipt is left untouched, still
// counted at its full amount. total_money is stored POSITIVE on both SALE
// and REFUND rows; Loyverse never stores a refund as a negative number.
// Confirmed both from Loyverse's own API field docs and empirically: every
// REFUND row in this DB has a receipt_number distinct from any SALE row.
//
// This means excluding REFUND rows is NOT enough to net a refund out of
// revenue -- the original sale is still sitting there at full value. The
// refund amount must be SUBTRACTED, not just hidden.
//
// Separately, Loyverse Back Office "Cancel" is a different action from a
// POS "Refund": cancelling completely excludes a receipt from sales reports
// (Loyverse's own description). cancelled_at marks this and is NOT
// restricted to SALE receipts -- a REFUND can itself be cancelled (voiding
// a mistaken refund), so cancelled_at IS NULL must be checked on BOTH sides.
//
// The rule, everywhere money is summed against the Loyverse-sourced
// receipts table (directly or through v_receipts_all):
//
//   revenue = SUM(total_money) WHERE receipt_type='SALE'   AND cancelled_at IS NULL
//           - SUM(total_money) WHERE receipt_type='REFUND' AND cancelled_at IS NULL
//
// Per-dimension breakdowns (by item, employee, device, dining option,
// payment method) use the SAME rule, grouped by each row's own dimension
// fields -- a REFUND receipt carries its own employee_id/dining_option/
// pos_device_id/line items (whoever processed the refund), so subtracting
// its amount from whatever bucket those fields indicate is correct; no
// join back to the original sale is needed for aggregate reporting.
//
// This does NOT apply to the in-house POS/KDS system's own `pos_receipts`
// table -- that flips a single row's type from SALE to REFUND in place
// (see routes/receipts.js POST /:id/refund), so excluding REFUND there
// already nets it out without a subtraction.

// SQL fragment: a signed total_money contribution (+SALE, -REFUND, 0
// otherwise) for the given receipts-table alias. Wrap in SUM(...) and
// combine with notCancelledClause(alias) in the WHERE (or a FILTER) to
// exclude voided receipts of either type.
function netMoneyExpr(alias = '') {
  return netExpr(alias ? `${alias}.total_money` : 'total_money', alias);
}

// General form for joined queries where the money column lives on a child
// table (receipt_items.gross_total, receipt_payments.money_amount) but
// receipt_type lives on the joined receipts row -- e.g.
//   netExpr('ri.gross_total', 'r')   -- item revenue, sign from r.receipt_type
//   netExpr('rp.money_amount', 'r')  -- payment total, sign from r.receipt_type
function netExpr(valueExpr, typeAlias = '') {
  const typeCol = typeAlias ? `${typeAlias}.receipt_type` : 'receipt_type';
  return `CASE WHEN ${typeCol} = 'SALE' THEN ${valueExpr} WHEN ${typeCol} = 'REFUND' THEN -(${valueExpr}) ELSE 0 END`;
}

// SQL fragment: true for a receipt that hasn't been cancelled/voided.
function notCancelledClause(alias = '') {
  const col = alias ? `${alias}.` : '';
  return `${col}cancelled_at IS NULL`;
}

module.exports = { netMoneyExpr, netExpr, notCancelledClause };
