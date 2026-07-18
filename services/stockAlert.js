const cron = require('node-cron');
const { tz, telegramBotToken, telegramGroupChatId } = require('../config');
const { sendTelegramMessage } = require('./telegramBot');
const { analyzeAllActive } = require('./inventoryAnalysis');

// Daily 10:00 Cambodia-time nudge: one Telegram message listing every
// ingredient whose estimated stock says "inspect". Silent when all is well.

const fmtQty = v => Number(Number(v).toFixed(1)).toString();

// Pure — unit-tested. Returns null when nothing needs inspection.
function buildStockAlertMessage(rows) {
  const flagged = rows.filter(r => r.status === 'inspect');
  if (!flagged.length) return null;
  const parts = flagged.map(r => {
    const days = r.days_until_empty != null
      ? ` (≈${Math.round(r.days_until_empty)} day${Math.round(r.days_until_empty) === 1 ? '' : 's'})`
      : '';
    const qty = r.estimated_remaining != null ? `~${fmtQty(r.estimated_remaining)}${r.unit} left` : 'level unknown';
    return `${r.name} ${qty}${days}`;
  });
  return `🥬 Stock check needed: ${parts.join('. ')}.`;
}

async function checkAndSendStockAlert() {
  const rows = await analyzeAllActive();
  const message = buildStockAlertMessage(rows);
  if (!message) {
    console.log('🥬 [cron] Stock check: all levels ok — no alert sent');
    return { sent: false, message: null };
  }
  if (!telegramBotToken || !telegramGroupChatId) {
    console.warn('🥬 [cron] Stock needs inspection but Telegram is not configured:', message);
    return { sent: false, message };
  }
  await sendTelegramMessage(telegramGroupChatId, message);
  console.log('🥬 [cron] Stock alert sent:', message);
  return { sent: true, message };
}

function startStockAlertScheduler() {
  cron.schedule('0 10 * * *', () => {
    checkAndSendStockAlert().catch(err =>
      console.error('❌ [cron] Stock alert failed:', err.message));
  }, { scheduled: true, timezone: tz });
  console.log(`🥬  Stock alert scheduled daily at 10:00 (${tz})`);
}

module.exports = { buildStockAlertMessage, checkAndSendStockAlert, startStockAlertScheduler };
