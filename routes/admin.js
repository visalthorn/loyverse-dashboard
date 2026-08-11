const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { sendAlert, alertsConfigured } = require('../services/sync/alerts');

// Lets an admin confirm TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID actually work
// end-to-end (right token, right chat, bot not blocked/kicked) without
// waiting for a real sync failure to find out.
router.post('/test-telegram', requireAuth, requireRole('admin'), async (req, res) => {
  if (!alertsConfigured()) {
    return res.status(400).json({ message: 'TELEGRAM_BOT_TOKEN and/or TELEGRAM_CHAT_ID are not set.' });
  }
  const sent = await sendAlert(`✅ Test alert from ${req.user.username} — sync alerts are wired up correctly.`);
  if (!sent) return res.status(502).json({ message: 'Telegram API call failed — check the token/chat id and server logs.' });
  res.json({ status: 'sent' });
});

module.exports = router;
