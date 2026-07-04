const router = require('express').Router();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const pool = require('../db');
const { tz, telegramWebhookSecret, telegramGroupChatId } = require('../config');
const { parseExpenseMessage } = require('../services/telegramParser');
const { insertExpense } = require('../services/expenses');
const { sendTelegramMessage } = require('../services/telegramBot');

function extractMessage(update) {
  const message = update && update.message;
  if (!message || typeof message.text !== 'string' || !message.chat) return null;
  const from = message.from || {};
  const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';
  const forwardTimestamp = (message.forward_origin && message.forward_origin.date) ?? message.forward_date ?? null;
  const forwardDate = forwardTimestamp ? dayjs.unix(forwardTimestamp).tz(tz).format('YYYY-MM-DD') : null;
  return {
    text: message.text,
    chatId: message.chat.id,
    messageId: message.message_id,
    senderName,
    forwardDate,
  };
}

async function handleTelegramMessage({ text, messageId, senderName, chatId, forwardDate }, deps) {
  const { pool, parseExpenseMessage, insertExpense, sendTelegramMessage } = deps;

  const dup = await pool.query('SELECT 1 FROM expenses WHERE telegram_message_id = $1 LIMIT 1', [messageId]);
  if (dup.rowCount > 0) return { status: 'duplicate' };

  const today = dayjs().tz(tz).format('YYYY-MM-DD');
  // A forwarded message may have reached the group long after the expense happened —
  // its original send date is a better guess than "today" when nothing else is stated.
  const referenceDate = forwardDate || today;

  let parsed;
  try {
    parsed = await parseExpenseMessage(text, referenceDate);
  } catch (err) {
    console.error('[telegram] parseExpenseMessage failed:', err.message);
    await sendTelegramMessage(chatId, 'Having trouble right now — please try again in a bit.');
    return { status: 'error' };
  }

  if (parsed.type === 'not_expense') return { status: 'ignored' };

  if (parsed.type === 'usd_detected') {
    await sendTelegramMessage(chatId, 'That looks like USD — please send the amount in Riel (៛) instead.');
    return { status: 'usd_detected' };
  }

  if (parsed.type === 'unclear') {
    await sendTelegramMessage(chatId, "Sorry, I couldn't understand that. Try something like '50000 diesel for truck'.");
    return { status: 'unclear' };
  }

  const expenseDate = parsed.date || referenceDate;
  const inserted = [];
  for (const item of parsed.items) {
    const expense = await insertExpense({
      expense_date: expenseDate,
      amount: item.amount,
      remark: item.remark,
      expense_by: senderName,
      source: 'telegram',
      telegram_message_id: messageId,
    });
    inserted.push(expense);
  }

  const replyText = inserted
    .map(e => `✅ Logged: ៛${Number(e.amount).toLocaleString()} – ${e.remark || '(no remark)'} (${expenseDate})`)
    .join('\n');
  await sendTelegramMessage(chatId, replyText);
  return { status: 'logged', inserted };
}

router.post('/webhook', async (req, res) => {
  if (req.headers['x-telegram-bot-api-secret-token'] !== telegramWebhookSecret) {
    console.warn('[telegram] Rejected webhook: bad secret token');
    return res.sendStatus(200);
  }

  const message = extractMessage(req.body);
  if (!message || String(message.chatId) !== String(telegramGroupChatId)) {
    console.warn('[telegram] Ignored update from unrecognized chat or non-text message', message ? message.chatId : null);
    return res.sendStatus(200);
  }

  try {
    await handleTelegramMessage(message, { pool, parseExpenseMessage, insertExpense, sendTelegramMessage });
  } catch (err) {
    console.error('[telegram] Error handling message:', err.message);
  }
  res.sendStatus(200);
});

module.exports = router;
module.exports.extractMessage = extractMessage;
module.exports.handleTelegramMessage = handleTelegramMessage;
