// Dashboard write-action audit trail. See migrations/036_audit_log.sql and
// routes/audit.js (the admin-only viewer). Mirrors what pos_order_events
// already does for POS cancellations (routes/pos.js logOrderEvent) -- same
// idea, dashboard side.
const pool = require('../db');
const { auditLogEnabled } = require('../config');

// Explicit ALLOWLIST per entity -- deliberately never a denylist. A denylist
// only redacts fields someone remembered to name; a column added later
// (e.g. a future users.mfa_secret) would leak into before/after until
// someone thought to blocklist it. An allowlist fails closed instead: an
// unlisted field is simply never captured, whether or not it's sensitive.
const ALLOWLISTS = {
  expenses: ['id', 'expense_date', 'amount', 'remark', 'expense_by', 'branch_id', 'source', 'telegram_message_id', 'recurring_expense_id', 'recurring_period'],
  recurring_expenses: ['id', 'name', 'amount', 'category', 'frequency', 'day_of_month', 'day_of_week', 'branch_id', 'start_date', 'end_date', 'is_active', 'backfill_inserted', 'backfill_checked'],
  staff: [
    'id', 'staff_id', 'full_name', 'position', 'join_date', 'salary', 'salary_ccy',
    'phone', 'loan_amount', 'loan_ccy', 'is_active', 'notes', 'default_shift', 'last_salary_date',
  ],
  // users.password (bcrypt hash) is deliberately NOT in this list.
  users: ['id', 'username', 'email', 'full_name', 'role', 'is_active'],
  role_permissions: ['id', 'role', 'page', 'can_write'],
};

// Returns null for an entity with no allowlist entry -- redact everything
// rather than risk logging an unreviewed field for an entity nobody added
// audit support for yet.
function redact(entity, data) {
  if (!data) return null;
  const allowed = ALLOWLISTS[entity];
  if (!allowed) return null;
  const out = {};
  for (const key of allowed) {
    if (key in data) out[key] = data[key];
  }
  return out;
}

// Prefers the first hop in X-Forwarded-For (set by Railway's edge proxy in
// PROD) over the socket address, which on a proxied deploy would otherwise
// just be the proxy's own address for every request.
function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim().slice(0, 45);
  return (req.socket?.remoteAddress || '').slice(0, 45);
}

// Never throws -- a failed audit write must not fail the underlying
// request/response. `req` is optional (e.g. a cron-triggered sync has no
// request); when present, actor/IP/user-agent default from it.
async function writeAudit({ req, actorUserId, actorUsername, action, entity, entityId, before, after }) {
  if (!auditLogEnabled) return; // AUDIT_LOG_ENABLED is not 'true' -- skip the query entirely, not just the display
  try {
    const actor_user_id  = actorUserId  ?? req?.user?.id       ?? null;
    const actor_username = actorUsername ?? req?.user?.username ?? null;
    await pool.query(
      `INSERT INTO audit_log (actor_user_id, actor_username, action, entity, entity_id, before_data, after_data, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        actor_user_id,
        actor_username,
        action,
        entity,
        entityId != null ? String(entityId) : null,
        redact(entity, before),
        redact(entity, after),
        req ? getClientIp(req) : null,
        req ? (req.headers['user-agent'] || null) : null,
      ]
    );
  } catch (err) {
    console.error('❌ [audit] Failed to write audit log:', err.message);
  }
}

module.exports = { writeAudit, getClientIp, redact, ALLOWLISTS };
