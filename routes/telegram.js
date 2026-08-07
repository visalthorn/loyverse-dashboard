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
const {
  sendTelegramMessage,
  sendTelegramButtons,
  editTelegramMessage,
  answerCallbackQuery,
  downloadTelegramFile,
} = require('../services/telegramBot');
const { putPending, takePending } = require('../services/telegramPending');

const USD_TO_KHR_RATE = 4000;

// Nobody reports a month-old expense through the group chat -- anything that
// old is entered on the dashboard by hand. So a Telegram date outside this
// window is treated as a mistake (usually the parser resolving the wrong year)
// and is held for the sender to confirm rather than written straight in.
const MAX_BACKDATE_MONTHS = 1;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CALLBACK_RE = /^exp:([0-9a-f]{8}):(.+)$/;
const CANCEL_CHOICE = 'x';

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const parsed = dayjs(value);
  // Round-trip rejects real-looking but impossible dates like 2026-02-30,
  // which dayjs would otherwise roll forward into March.
  return parsed.isValid() && parsed.format('YYYY-MM-DD') === value;
}

function isPlausibleExpenseDate(date, referenceDate) {
  if (!isValidDate(date)) return false;
  const d = dayjs(date);
  const ref = dayjs(referenceDate);
  if (d.isAfter(ref, 'day')) return false;
  return !d.isBefore(ref.subtract(MAX_BACKDATE_MONTHS, 'month'), 'day');
}

// The observed failure is a right day/month with the wrong year, so the most
// useful correction to offer is the same day/month, most recently past.
function sameDayMostRecentYear(date, referenceDate) {
  const ref = dayjs(referenceDate);
  const monthDay = date.slice(5);
  for (const year of [ref.year(), ref.year() - 1]) {
    const candidate = `${year}-${monthDay}`;
    if (isValidDate(candidate) && !dayjs(candidate).isAfter(ref, 'day')) return candidate;
  }
  return null;
}

function buildDateChoices(parsedDate, referenceDate) {
  const choices = [];
  const suggested = sameDayMostRecentYear(parsedDate, referenceDate);
  if (suggested && suggested !== parsedDate && isPlausibleExpenseDate(suggested, referenceDate)) {
    choices.push(suggested);
  }
  choices.push(parsedDate);
  if (!choices.includes(referenceDate)) choices.push(referenceDate);
  return choices;
}

function formatKhr(amount) {
  return `៛${Number(amount).toLocaleString()}`;
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

function extractCallbackQuery(update) {
  const query = update && update.callback_query;
  if (!query || typeof query.data !== 'string' || !query.message || !query.message.chat) return null;

  const match = CALLBACK_RE.exec(query.data);
  if (!match) return null;

  return {
    callbackId: query.id,
    pendingId: match[1],
    choice: match[2],
    chatId: query.message.chat.id,
    messageId: query.message.message_id,
  };
}

async function insertItems({ items, expenseDate, senderName, messageId }, insertExpense) {
  const inserted = [];
  for (const item of items) {
    const amount = item.currency === 'USD' ? item.amount * USD_TO_KHR_RATE : item.amount;
    const expense = await insertExpense({
      expense_date: expenseDate,
      amount,
      remark: item.remark,
      expense_by: senderName,
      source: 'telegram',
      telegram_message_id: messageId,
    });
    inserted.push({ expense, item });
  }
  return inserted;
}

function loggedReply(inserted, expenseDate) {
  return inserted
    .map(({ expense, item }) => {
      const convertedNote = item.currency === 'USD' ? ` (converted from $${item.amount})` : '';
      return `✅ Logged: ${formatKhr(expense.amount)}${convertedNote} – ${expense.remark || '(no remark)'} (${expenseDate})`;
    })
    .join('\n');
}

function confirmationPrompt(parsedDate, items) {
  const lines = items
    .map(item => `• ${item.currency === 'USD' ? `$${item.amount}` : formatKhr(item.amount)} – ${item.remark || '(no remark)'}`)
    .join('\n');
  return `⚠️ កាលបរិច្ឆេទ ${parsedDate} ចាស់ជាង ១ ខែ។ ខ្ញុំមិនទាន់កត់ត្រាទេ។\n\n${lines}\n\nសូមជ្រើសរើសកាលបរិច្ឆេទត្រឹមត្រូវ៖`;
}

function choiceButtons(choices, referenceDate) {
  const buttons = choices.map((date, index) => ({
    text: date === referenceDate ? `📌 ថ្ងៃនេះ ${date}` : `${index === 0 ? '✅' : '📅'} ${date}`,
    callback_data: `exp:__ID__:${date}`,
  }));
  buttons.push({ text: '✖️ បោះបង់', callback_data: `exp:__ID__:${CANCEL_CHOICE}` });
  return buttons;
}

async function handleTelegramMessage({ text, messageId, senderName, chatId, forwardDate, photoFileId }, deps) {
  const {
    pool, parseExpenseMessage, parseExpenseImage, downloadTelegramFile,
    insertExpense, sendTelegramMessage, sendTelegramButtons, putPending,
  } = deps;

  const dup = await pool.query('SELECT 1 FROM expenses WHERE telegram_message_id = $1 LIMIT 1', [messageId]);
  if (dup.rowCount > 0) {
    console.log(`[telegram] msg ${messageId} from ${senderName}: already recorded, skipping`);
    return { status: 'duplicate' };
  }

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
    console.error(`[telegram] msg ${messageId} parsing failed:`, err.message);
    await sendTelegramMessage(chatId, 'Having trouble right now — please try again in a bit.');
    return { status: 'error' };
  }

  if (parsed.type === 'not_expense') {
    console.log(`[telegram] msg ${messageId} from ${senderName}: not an expense, ignored`);
    return { status: 'ignored' };
  }

  if (parsed.type === 'unclear') {
    console.log(`[telegram] msg ${messageId} from ${senderName}: unclear, asked for clarification`);
    await sendTelegramMessage(
      chatId,
      "សុំទោស ខ្ញុំមិនច្បាស់ថាតើអ្នកចង់ឲ្យខ្ញុំកត់ត្រាចំណាយនេះទេ? បើចង់ សូមសាកល្បងសរសេរបែបនេះ៖ 'ចំណាយ 2/7/26 14000៛'"
    );
    return { status: 'unclear' };
  }

  const expenseDate = isValidDate(parsed.date) ? parsed.date : referenceDate;

  // Hold anything outside the window instead of inserting it. Without this an
  // expense silently lands a year in the past, where no dashboard filter finds it.
  if (!isPlausibleExpenseDate(expenseDate, referenceDate)) {
    const choices = buildDateChoices(expenseDate, referenceDate);
    const pendingId = putPending({ chatId, messageId, senderName, items: parsed.items, choices });
    const buttons = choiceButtons(choices, referenceDate).map(b => ({
      ...b,
      callback_data: b.callback_data.replace('__ID__', pendingId),
    }));
    console.warn(
      `[telegram] msg ${messageId} from ${senderName}: date ${expenseDate} is outside ${MAX_BACKDATE_MONTHS} month of ${referenceDate} — holding ${parsed.items.length} item(s) for confirmation (pending ${pendingId})`
    );
    await sendTelegramButtons(chatId, confirmationPrompt(expenseDate, parsed.items), buttons);
    return { status: 'awaiting_date_confirmation', pendingId, choices };
  }

  const inserted = await insertItems({ items: parsed.items, expenseDate, senderName, messageId }, insertExpense);
  console.log(`[telegram] msg ${messageId} from ${senderName}: logged ${inserted.length} item(s) on ${expenseDate} (ids ${inserted.map(x => x.expense.id).join(',')})`);
  await sendTelegramMessage(chatId, loggedReply(inserted, expenseDate));
  return { status: 'logged', inserted: inserted.map(x => x.expense) };
}

async function handleTelegramCallback({ callbackId, pendingId, choice, chatId, messageId }, deps) {
  const { takePending, insertExpense, answerCallbackQuery, editTelegramMessage } = deps;

  const entry = takePending(pendingId);
  await answerCallbackQuery(callbackId);

  if (!entry) {
    console.warn(`[telegram] callback ${pendingId}: no pending entry (expired or already answered)`);
    await editTelegramMessage(chatId, messageId, '⌛️ សំណើនេះផុតកំណត់ហើយ — សូមផ្ញើចំណាយម្ដងទៀត។');
    return { status: 'expired' };
  }

  if (choice === CANCEL_CHOICE) {
    console.log(`[telegram] callback ${pendingId}: cancelled by user, nothing recorded`);
    await editTelegramMessage(chatId, messageId, '✖️ បានបោះបង់ — មិនបានកត់ត្រាទេ។ សូមផ្ញើឡើងវិញជាមួយកាលបរិច្ឆេទត្រឹមត្រូវ។');
    return { status: 'cancelled' };
  }

  // callback_data comes from the client, so only dates we actually offered are honoured.
  if (!entry.choices.includes(choice)) {
    console.warn(`[telegram] callback ${pendingId}: rejected unoffered date ${choice}`);
    await editTelegramMessage(chatId, messageId, '⚠️ ជម្រើសមិនត្រឹមត្រូវ — សូមផ្ញើចំណាយម្ដងទៀត។');
    return { status: 'invalid_choice' };
  }

  const inserted = await insertItems(
    { items: entry.items, expenseDate: choice, senderName: entry.senderName, messageId: entry.messageId },
    insertExpense
  );
  console.log(`[telegram] callback ${pendingId}: confirmed ${choice}, logged ${inserted.length} item(s) (ids ${inserted.map(x => x.expense.id).join(',')})`);
  await editTelegramMessage(chatId, messageId, loggedReply(inserted, choice));
  return { status: 'logged', expenseDate: choice, inserted: inserted.map(x => x.expense) };
}

function checkWebhookAuth(headers, secret) {
  if (!secret) return { ok: false, reason: 'not_configured' };
  if (headers['x-telegram-bot-api-secret-token'] !== secret) return { ok: false, reason: 'bad_secret' };
  return { ok: true };
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

  const callback = extractCallbackQuery(req.body);
  if (callback) {
    if (String(callback.chatId) !== String(telegramGroupChatId)) {
      console.warn('[telegram] Ignored callback from unrecognized chat', callback.chatId);
      return res.sendStatus(200);
    }
    try {
      await handleTelegramCallback(callback, { takePending, insertExpense, answerCallbackQuery, editTelegramMessage });
    } catch (err) {
      console.error('[telegram] Error handling callback:', err.message);
    }
    return res.sendStatus(200);
  }

  const message = extractMessage(req.body);
  if (!message || String(message.chatId) !== String(telegramGroupChatId)) {
    console.warn('[telegram] Ignored update from unrecognized chat or unsupported message type', message ? message.chatId : null);
    return res.sendStatus(200);
  }

  try {
    await handleTelegramMessage(message, {
      pool, parseExpenseMessage, parseExpenseImage, downloadTelegramFile,
      insertExpense, sendTelegramMessage, sendTelegramButtons, putPending,
    });
  } catch (err) {
    console.error('[telegram] Error handling message:', err.message);
  }
  res.sendStatus(200);
});

module.exports = router;
module.exports.extractMessage = extractMessage;
module.exports.extractCallbackQuery = extractCallbackQuery;
module.exports.handleTelegramMessage = handleTelegramMessage;
module.exports.handleTelegramCallback = handleTelegramCallback;
module.exports.checkWebhookAuth = checkWebhookAuth;
module.exports.isPlausibleExpenseDate = isPlausibleExpenseDate;
module.exports.buildDateChoices = buildDateChoices;
