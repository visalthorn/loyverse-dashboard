const router = require('express').Router();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const pool = require('../db');
const { tz, telegramWebhookSecret, telegramGroupChatId } = require('../config');
const { parseExpenseMessage, parseExpenseImage } = require('../services/telegramParser');
const { insertExpense } = require('../services/expenses');
const { sendTelegramMessage, downloadTelegramFile } = require('../services/telegramBot');

const USD_TO_KHR_RATE = 4000;

function checkWebhookAuth(headers, secret) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  if (headers['x-telegram-bot-api-secret-token'] !== secret) return { ok: false, reason: 'bad_secret' };
  return { ok: true };
}

function extractMessage(update) {
  const message = update && update.message;
  if (!message || !message.chat) return null;

  const hasText = typeof message.text === 'string';
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
  if (!hasText && !hasPhoto) return null;

  const from = message.from || {};
  const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';
  const forwardTimestamp = (message.forward_origin && message.forward_origin.date) ?? message.forward_date ?? null;
  const forwardDate = forwardTimestamp ? dayjs.unix(forwardTimestamp).tz(tz).format('YYYY-MM-DD') : null;

  return {
    text: hasText ? message.text : (message.caption ?? null),
    chatId: message.chat.id,
    messageId: message.message_id,
    senderName,
    forwardDate,
    photoFileId: hasPhoto ? message.photo[message.photo.length - 1].file_id : null,
  };
}

async function handleTelegramMessage({ text, messageId, senderName, chatId, forwardDate, photoFileId }, deps) {
  const { pool, parseExpenseMessage, parseExpenseImage, downloadTelegramFile, insertExpense, sendTelegramMessage } = deps;

  const dup = await pool.query('SELECT 1 FROM expenses WHERE telegram_message_id = $1 LIMIT 1', [messageId]);
  if (dup.rowCount > 0) return { status: 'duplicate' };

  const today = dayjs().tz(tz).format('YYYY-MM-DD');
  // A forwarded message may have reached the group long after the expense happened —
  // its original send date is a better guess than "today" when nothing else is stated.
  const referenceDate = forwardDate || today;

  let parsed;
  try {
    if (photoFileId) {
      const imageBuffer = await downloadTelegramFile(photoFileId);
      parsed = await parseExpenseImage(text, imageBuffer.toString('base64'), referenceDate);
    } else {
      parsed = await parseExpenseMessage(text, referenceDate);
    }
  } catch (err) {
    console.error('[telegram] parsing failed:', err.message);
    await sendTelegramMessage(chatId, 'Having trouble right now — please try again in a bit.');
    return { status: 'error' };
  }

  if (parsed.type === 'not_expense') return { status: 'ignored' };

  if (parsed.type === 'unclear') {
    await sendTelegramMessage(
      chatId,
      "សុំទោស ខ្ញុំមិនច្បាស់ថាតើអ្នកចង់ឲ្យខ្ញុំកត់ត្រាចំណាយនេះទេ? បើចង់ សូមសាកល្បងសរសេរបែបនេះ៖ 'ចំណាយ 2/7/26 14000៛'"
    );
    return { status: 'unclear' };
  }

  const expenseDate = parsed.date || referenceDate;
  const insertedWithSource = [];
  for (const item of parsed.items) {
    const amount = item.currency === 'USD' ? item.amount * USD_TO_KHR_RATE : item.amount;
    const expense = await insertExpense({
      expense_date: expenseDate,
      amount,
      remark: item.remark,
      expense_by: senderName,
      source: 'telegram',
      telegram_message_id: messageId,
    });
    insertedWithSource.push({ expense, item });
  }

  const replyText = insertedWithSource
    .map(({ expense, item }) => {
      const convertedNote = item.currency === 'USD' ? ` (converted from $${item.amount})` : '';
      return `✅ Logged: ៛${Number(expense.amount).toLocaleString()}${convertedNote} – ${expense.remark || '(no remark)'} (${expenseDate})`;
    })
    .join('\n');
  await sendTelegramMessage(chatId, replyText);
  return { status: 'logged', inserted: insertedWithSource.map(x => x.expense) };
}

router.post('/webhook', async (req, res) => {
  const auth = checkWebhookAuth(req.headers, telegramWebhookSecret);
  if (!auth.ok) {
    if (auth.reason === 'not_configured') {
      console.error('[telegram] TELEGRAM_WEBHOOK_SECRET is not configured — rejecting all webhook requests until this is set.');
    } else {
      console.warn('[telegram] Rejected webhook: bad secret token');
    }
    return res.sendStatus(200);
  }

  const message = extractMessage(req.body);
  if (!message || String(message.chatId) !== String(telegramGroupChatId)) {
    console.warn('[telegram] Ignored update from unrecognized chat or unsupported message type', message ? message.chatId : null);
    return res.sendStatus(200);
  }

  try {
    await handleTelegramMessage(message, { pool, parseExpenseMessage, parseExpenseImage, downloadTelegramFile, insertExpense, sendTelegramMessage });
  } catch (err) {
    console.error('[telegram] Error handling message:', err.message);
  }
  res.sendStatus(200);
});

module.exports = router;
module.exports.extractMessage = extractMessage;
module.exports.handleTelegramMessage = handleTelegramMessage;
module.exports.checkWebhookAuth = checkWebhookAuth;
