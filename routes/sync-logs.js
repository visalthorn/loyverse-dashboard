const router = require('express').Router();
const pool   = require('../db');
const { requireAuth } = require('../middleware/auth');

router.get('/latest', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 10);
    const result = await pool.query(
      `SELECT id, sync_date, status, triggered_by, inserted, error_message, created_at
       FROM sync_logs
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('sync-logs GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
