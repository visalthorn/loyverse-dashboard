// Admin-only viewer for the dashboard write-action audit trail. See
// migrations/036_audit_log.sql and services/audit.js (the writer).
const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const ACTIONS = ['create', 'update', 'delete', 'login', 'login_failed', 'permission_change', 'sync'];
const ENTITIES = ['expenses', 'staff', 'users', 'role_permissions', 'receipts'];

router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const page     = Math.max(1, parseInt(req.query.page) || 1);
    const per_page = Math.min(1000, Math.max(1, parseInt(req.query.per_page) || 50));
    const offset   = (page - 1) * per_page;

    const filters = [];
    const params  = [];
    let i = 1;
    if (req.query.start) { filters.push(`created_at >= $${i++}`); params.push(req.query.start); }
    if (req.query.end)   { filters.push(`created_at <= $${i++}`); params.push(`${req.query.end} 23:59:59`); }
    // actor: matches either the stored username (partial, case-insensitive --
    // usernames are free text at time of the event, an old row can predate a
    // rename) or an exact numeric user id.
    if (req.query.actor) {
      const actorId = Number(req.query.actor);
      if (Number.isInteger(actorId) && String(actorId) === req.query.actor.trim()) {
        filters.push(`actor_user_id = $${i++}`); params.push(actorId);
      } else {
        filters.push(`actor_username ILIKE $${i++}`); params.push(`%${req.query.actor.trim()}%`);
      }
    }
    if (req.query.entity && ENTITIES.includes(req.query.entity)) {
      filters.push(`entity = $${i++}`); params.push(req.query.entity);
    }
    if (req.query.action && ACTIONS.includes(req.query.action)) {
      filters.push(`action = $${i++}`); params.push(req.query.action);
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const [totalRes, result] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS count FROM audit_log ${where}`, params),
      pool.query(`
        SELECT id, actor_user_id, actor_username, action, entity, entity_id,
               before_data, after_data, ip, user_agent, created_at
        FROM audit_log ${where}
        ORDER BY created_at DESC
        LIMIT $${i} OFFSET $${i + 1}
      `, [...params, per_page, offset]),
    ]);

    res.json({
      items:    result.rows,
      total:    parseInt(totalRes.rows[0].count || 0),
      page,
      per_page,
      actions:  ACTIONS,
      entities: ENTITIES,
    });
  } catch (err) {
    console.error('Audit GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
