// POS cancellation audit -- the accountability mechanism replacing the
// removed ownership/kitchen-status restrictions on cancel-order and
// cancel-item (POS revision, 2026-08-02). Reads the general pos_order_events
// activity log (see routes/pos.js logOrderEvent), filtered to the two
// cancellation event types.
const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

router.get('/cancellations', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { branch_id, start, end, terminal_id } = req.query;

    const filters = [];
    const params  = [];
    let i = 1;
    if (branch_id)   { filters.push(`e.branch_id = $${i++}`); params.push(branch_id); }
    if (start)       { filters.push(`e.created_at >= $${i++}`); params.push(start); }
    if (end)         { filters.push(`e.created_at <= $${i++}`); params.push(`${end} 23:59:59`); }
    if (terminal_id) { filters.push(`e.actor = $${i++}`); params.push(terminal_id); }
    const extraWhere = filters.length ? `AND ${filters.join(' AND ')}` : '';

    const baseSelect = `
      SELECT e.id, e.created_at, e.branch_id, b.name AS branch_name,
             e.actor AS terminal_id, e.detail->>'terminal_name' AS terminal_name,
             o.order_number, e.detail
      FROM pos_order_events e
      JOIN pos_orders o ON o.id = e.order_id
      LEFT JOIN branches b ON b.id = e.branch_id
    `;

    const [ordersRes, itemsRes] = await Promise.all([
      pool.query(`${baseSelect} WHERE e.event = 'cancelled' ${extraWhere} ORDER BY e.created_at DESC LIMIT 500`, params),
      pool.query(`${baseSelect} WHERE e.event = 'item_cancelled' ${extraWhere} ORDER BY e.created_at DESC LIMIT 500`, params),
    ]);

    res.json({
      orders: ordersRes.rows.map(r => ({
        id: r.id, created_at: r.created_at, branch_id: r.branch_id, branch_name: r.branch_name,
        terminal_id: r.terminal_id, terminal_name: r.terminal_name, order_number: r.order_number,
        order_total: r.detail?.order_total ?? null, reason: r.detail?.reason ?? null,
      })),
      items: itemsRes.rows.map(r => ({
        id: r.id, created_at: r.created_at, branch_id: r.branch_id, branch_name: r.branch_name,
        terminal_id: r.terminal_id, terminal_name: r.terminal_name, order_number: r.order_number,
        item_name: r.detail?.item_name ?? null, qty_removed: r.detail?.qty_removed ?? null,
        qty_remaining: r.detail?.qty_remaining ?? null, reason: r.detail?.reason ?? null,
      })),
    });
  } catch (err) {
    console.error('cancellations GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
