const { test } = require('node:test');
const assert = require('node:assert/strict');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
const { tz } = require('../config');
const { extractMessage, handleTelegramMessage } = require('../routes/telegram');

function fakePool(dupExists = false) {
  return { query: async () => ({ rowCount: dupExists ? 1 : 0 }) };
}

function today() {
  return dayjs().tz(tz).format('YYYY-MM-DD');
}

test('extractMessage pulls text, chat id, message id, and sender name', () => {
  const update = {
    message: {
      message_id: 42,
      chat: { id: -100123456 },
      from: { first_name: 'Srey', last_name: 'Nich', username: 'sreynich' },
      text: '50000 diesel',
    },
  };
  const result = extractMessage(update);
  assert.deepEqual(result, {
    text: '50000 diesel',
    chatId: -100123456,
    messageId: 42,
    senderName: 'Srey Nich',
    forwardDate: null,
  });
});

test('extractMessage returns null for non-text updates', () => {
  assert.equal(extractMessage({ message: { chat: { id: 1 }, photo: [{}] } }), null);
  assert.equal(extractMessage({}), null);
});

test('extractMessage reads the forward date from forward_origin', () => {
  const update = {
    message: {
      message_id: 7,
      chat: { id: -100123456 },
      from: { first_name: 'Sister' },
      text: '30000 for parts',
      forward_origin: { type: 'user', date: 1782806400 }, // 2026-06-30T00:00:00Z
    },
  };
  const result = extractMessage(update);
  assert.equal(result.forwardDate, '2026-06-30');
});

test('extractMessage falls back to the legacy forward_date field', () => {
  const update = {
    message: {
      message_id: 8,
      chat: { id: -100123456 },
      from: { first_name: 'Sister' },
      text: '30000 for parts',
      forward_date: 1782806400, // 2026-06-30T00:00:00Z
    },
  };
  const result = extractMessage(update);
  assert.equal(result.forwardDate, '2026-06-30');
});

test('handleTelegramMessage skips a duplicate telegram_message_id without calling the parser', async () => {
  const sent = [];
  const inserted = [];
  const result = await handleTelegramMessage(
    { text: '50000 diesel', messageId: 42, senderName: 'Srey', chatId: -1, forwardDate: null },
    {
      pool: fakePool(true),
      parseExpenseMessage: async () => { throw new Error('should not be called'); },
      insertExpense: async (e) => { inserted.push(e); return e; },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(result.status, 'duplicate');
  assert.equal(inserted.length, 0);
  assert.equal(sent.length, 0);
});

test('handleTelegramMessage ignores casual chat', async () => {
  const sent = [];
  const result = await handleTelegramMessage(
    { text: 'good morning', messageId: 1, senderName: 'Srey', chatId: -1, forwardDate: null },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({ type: 'not_expense', date: null, items: [] }),
      insertExpense: async () => { throw new Error('should not insert'); },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(result.status, 'ignored');
  assert.equal(sent.length, 0);
});

test('handleTelegramMessage asks for Riel when USD is detected', async () => {
  const sent = [];
  const result = await handleTelegramMessage(
    { text: '$20 for parts', messageId: 2, senderName: 'Srey', chatId: -1, forwardDate: null },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({ type: 'usd_detected', date: null, items: [] }),
      insertExpense: async () => { throw new Error('should not insert'); },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(result.status, 'usd_detected');
  assert.match(sent[0], /Riel/);
});

test('handleTelegramMessage asks for clarification when unclear', async () => {
  const sent = [];
  const result = await handleTelegramMessage(
    { text: 'huh', messageId: 3, senderName: 'Srey', chatId: -1, forwardDate: null },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({ type: 'unclear', date: null, items: [] }),
      insertExpense: async () => { throw new Error('should not insert'); },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(result.status, 'unclear');
  assert.equal(sent.length, 1);
});

test('handleTelegramMessage inserts each item and sends one combined confirmation', async () => {
  const sent = [];
  const inserted = [];
  const result = await handleTelegramMessage(
    { text: '50000 diesel, 20000 lunch', messageId: 4, senderName: 'Srey', chatId: -1, forwardDate: null },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({
        type: 'expense',
        date: null,
        items: [
          { amount: 50000, remark: 'diesel' },
          { amount: 20000, remark: 'lunch' },
        ],
      }),
      insertExpense: async (e) => { inserted.push(e); return e; },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(result.status, 'logged');
  assert.equal(inserted.length, 2);
  assert.equal(inserted[0].telegram_message_id, 4);
  assert.equal(inserted[0].source, 'telegram');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /diesel/);
  assert.match(sent[0], /lunch/);
});

test('handleTelegramMessage replies with a retry message when the parser fails', async () => {
  const sent = [];
  const result = await handleTelegramMessage(
    { text: '50000 diesel', messageId: 5, senderName: 'Srey', chatId: -1, forwardDate: null },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => { throw new Error('Claude API timeout'); },
      insertExpense: async () => { throw new Error('should not insert'); },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(result.status, 'error');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /trouble/i);
});

test('handleTelegramMessage uses an explicit parsed date over any fallback', async () => {
  const inserted = [];
  const sent = [];
  await handleTelegramMessage(
    { text: '30000 parts, bought last Tuesday', messageId: 6, senderName: 'Srey', chatId: -1, forwardDate: '2026-06-25' },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({ type: 'expense', date: '2026-06-23', items: [{ amount: 30000, remark: 'parts' }] }),
      insertExpense: async (e) => { inserted.push(e); return e; },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(inserted[0].expense_date, '2026-06-23');
  assert.match(sent[0], /2026-06-23/);
});

test('handleTelegramMessage falls back to the forward date when the parser finds no explicit date', async () => {
  const inserted = [];
  await handleTelegramMessage(
    { text: '30000 for parts', messageId: 9, senderName: 'Srey', chatId: -1, forwardDate: '2026-06-30' },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({ type: 'expense', date: null, items: [{ amount: 30000, remark: 'parts' }] }),
      insertExpense: async (e) => { inserted.push(e); return e; },
      sendTelegramMessage: async () => {},
    }
  );
  assert.equal(inserted[0].expense_date, '2026-06-30');
});

test('handleTelegramMessage falls back to today for a fresh message with no explicit date', async () => {
  const inserted = [];
  await handleTelegramMessage(
    { text: '30000 for parts', messageId: 10, senderName: 'Srey', chatId: -1, forwardDate: null },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({ type: 'expense', date: null, items: [{ amount: 30000, remark: 'parts' }] }),
      insertExpense: async (e) => { inserted.push(e); return e; },
      sendTelegramMessage: async () => {},
    }
  );
  assert.equal(inserted[0].expense_date, today());
});
