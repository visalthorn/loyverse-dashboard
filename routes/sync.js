const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireWrite } = require('../middleware/auth');
const { syncYesterdayReceipts, syncItems } = require('../services/sync');

router.post('/receipts', requireAuth, requireWrite('receipts'), async (req, res) => {
  try {
    const result = await syncYesterdayReceipts('manual');
    res.status(result.status === 'failed' ? 500 : 200).json(result);
  } catch (err) {
    console.error('❌ Receipts sync route error:', err.message);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

router.post('/items', requireAuth, requireWrite('items'), async (req, res) => {
  try {
    const result = await syncItems('manual');
    res.status(result.status === 'failed' ? 500 : 200).json(result);
  } catch (err) {
    console.error('❌ Items sync route error:', err.message);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

router.get('/logs', requireAuth, async (req, res) => {
  try {
    const limit  = Math.min(50, parseInt(req.query.limit) || 10);
    const params = [limit];
    let where = '';
    if (req.query.type) { where = 'WHERE sync_type = $2'; params.push(req.query.type); }
    const result = await pool.query(
      `SELECT id, sync_type, sync_date, status, triggered_by, inserted, error_message, created_at
       FROM sync_logs ${where}
       ORDER BY created_at DESC
       LIMIT $1`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error('sync logs GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
