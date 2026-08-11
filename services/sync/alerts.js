const { sendTelegramMessage } = require('../telegramBot');
const { telegramBotToken, telegramChatId } = require('../../config');
const { getReceiptsCoverage } = require('./coverage');

// Alerts are entirely optional -- the scheduler and sync work fine without
// Telegram configured, they just log instead of sending. See
// config/index.js (telegramChatId) and utils/startupChecks.js.
function alertsConfigured() {
  return !!(telegramBotToken && telegramChatId);
}

async function sendAlert(text) {
  if (!alertsConfigured()) {
    console.warn(`⚠️  [alerts] Telegram not configured (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) — alert not sent:\n${text}`);
    return false;
  }
  try {
    await sendTelegramMessage(telegramChatId, text);
    return true;
  } catch (err) {
    console.error('❌ [alerts] Failed to send Telegram alert:', err.message);
    return false;
  }
}

// Immediate alert when a sync run fails outright (Loyverse fetch error or
// DB error). Includes how many days are now missing in the trailing 14-day
// window so the message alone conveys the blast radius, not just this date.
async function alertSyncFailure({ date, error, triggeredBy }) {
  let gapsLine = '';
  try {
    const coverage = await getReceiptsCoverage(14);
    const gaps = coverage.days.filter(d => d.gap).length;
    gapsLine = `\n${gaps} day(s) missing/incomplete in the last 14 days.`;
  } catch {
    // Coverage lookup failing shouldn't swallow the original failure alert.
  }
  return sendAlert(
    `🔴 Receipts sync FAILED for ${date} (${triggeredBy})\nError: ${error}${gapsLine}`
  );
}

// A sync ran and wrote data but didn't fully converge with Loyverse's count
// -- e.g. a row failed an individual insert. Reports the mismatch plainly
// so it's obvious this date still needs a look (or a re-run).
async function alertSyncPartial({ date, expected, stored, triggeredBy }) {
  return sendAlert(
    `🟡 Receipts sync PARTIAL for ${date} (${triggeredBy})\nExpected ${expected} receipts (Loyverse), stored ${stored}.`
  );
}

// Daily 09:15 check -- silent when everything's healthy, so a message
// arriving at all means it's worth reading. "Needs attention" = any gap
// (missing/partial/failed) in the last 14 days.
async function sendHealthSummaryIfNeeded() {
  const coverage = await getReceiptsCoverage(14);
  const gapDays = coverage.days.filter(d => d.gap);

  if (gapDays.length === 0) {
    console.log('✅ [alerts] Daily health check — all clear, staying quiet');
    return { sent: false, gaps: 0 };
  }

  const lines = gapDays.map(d => `  • ${d.date} — ${d.status} (${d.count} stored)`).join('\n');
  const sent = await sendAlert(
    `🟠 Daily sync health check — ${gapDays.length} day(s) need attention in the last 14 days:\n${lines}`
  );
  return { sent, gaps: gapDays.length };
}

module.exports = { alertsConfigured, sendAlert, alertSyncFailure, alertSyncPartial, sendHealthSummaryIfNeeded };
