const { test } = require('node:test');
const assert = require('node:assert/strict');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
const { tz } = require('../config');
const { extractMessage, handleTelegramMessage, checkWebhookAuth } = require('../routes/telegram');

test('checkWebhookAuth reports not_configured when no secret is set', () => {
  const result = checkWebhookAuth({}, undefined);
  assert.deepEqual(result, { ok: false, reason: 'not_configured' });
});

test('checkWebhookAuth reports bad_secret when the header does not match', () => {
  const result = checkWebhookAuth({ 'x-telegram-bot-api-secret-token': 'wrong' }, 'correct-secret');
  assert.deepEqual(result, { ok: false, reason: 'bad_secret' });
});

test('checkWebhookAuth passes when the header matches the configured secret', () => {
  const result = checkWebhookAuth({ 'x-telegram-bot-api-secret-token': 'correct-secret' }, 'correct-secret');
  assert.deepEqual(result, { ok: true });
});

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
    photoFileId: null,
  });
});

test('extractMessage returns null for updates with no text and no photo', () => {
  assert.equal(extractMessage({ message: { chat: { id: 1 } } }), null);
  assert.equal(extractMessage({}), null);
});

test('extractMessage extracts the largest photo file_id and uses the caption as text', () => {
  const update = {
    message: {
      message_id: 20,
      chat: { id: -100123456 },
      from: { first_name: 'Srey' },
      photo: [
        { file_id: 'small_file_id', width: 90, height: 90 },
        { file_id: 'large_file_id', width: 800, height: 800 },
      ],
      caption: 'fuel receipt',
    },
  };
  const result = extractMessage(update);
  assert.equal(result.photoFileId, 'large_file_id');
  assert.equal(result.text, 'fuel receipt');
});

test('extractMessage extracts a photo with no caption as null text', () => {
  const update = {
    message: {
      message_id: 21,
      chat: { id: -100123456 },
      from: { first_name: 'Srey' },
      photo: [{ file_id: 'only_file_id', width: 400, height: 400 }],
    },
  };
  const result = extractMessage(update);
  assert.equal(result.photoFileId, 'only_file_id');
  assert.equal(result.text, null);
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

test('handleTelegramMessage converts a USD item to KHR at the fixed rate before inserting', async () => {
  const sent = [];
  const inserted = [];
  const result = await handleTelegramMessage(
    { text: '$20 for parts', messageId: 2, senderName: 'Srey', chatId: -1, forwardDate: null },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({ type: 'expense', date: null, items: [{ amount: 20, remark: 'parts', currency: 'USD' }] }),
      insertExpense: async (e) => { inserted.push(e); return e; },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(result.status, 'logged');
  assert.equal(inserted[0].amount, 80000);
  assert.match(sent[0], /\$20/);
  assert.match(sent[0], /80,000/);
});

test('handleTelegramMessage leaves KHR items unconverted alongside a converted USD item', async () => {
  const inserted = [];
  await handleTelegramMessage(
    { text: '50000 diesel, $10 for parts', messageId: 11, senderName: 'Srey', chatId: -1, forwardDate: null },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({
        type: 'expense',
        date: null,
        items: [
          { amount: 50000, remark: 'diesel', currency: 'KHR' },
          { amount: 10, remark: 'parts', currency: 'USD' },
        ],
      }),
      insertExpense: async (e) => { inserted.push(e); return e; },
      sendTelegramMessage: async () => {},
    }
  );
  assert.equal(inserted[0].amount, 50000);
  assert.equal(inserted[1].amount, 40000);
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
  assert.match(sent[0], /ចំណាយ/);
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
      parseExpenseMessage: async () => ({ type: 'expense', date: '2026-06-23', items: [{ amount: 30000, remark: 'parts', currency: 'KHR' }] }),
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
      parseExpenseMessage: async () => ({ type: 'expense', date: null, items: [{ amount: 30000, remark: 'parts', currency: 'KHR' }] }),
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
      parseExpenseMessage: async () => ({ type: 'expense', date: null, items: [{ amount: 30000, remark: 'parts', currency: 'KHR' }] }),
      insertExpense: async (e) => { inserted.push(e); return e; },
      sendTelegramMessage: async () => {},
    }
  );
  assert.equal(inserted[0].expense_date, today());
});

test('handleTelegramMessage downloads and parses a photo message via parseExpenseImage', async () => {
  const inserted = [];
  const sent = [];
  const result = await handleTelegramMessage(
    { text: 'fuel receipt', messageId: 30, senderName: 'Srey', chatId: -1, forwardDate: null, photoFileId: 'file_abc' },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => { throw new Error('should not be called for a photo message'); },
      downloadTelegramFile: async (fileId) => {
        assert.equal(fileId, 'file_abc');
        return Buffer.from('fake-bytes');
      },
      parseExpenseImage: async (caption, imageBase64) => {
        assert.equal(caption, 'fuel receipt');
        assert.equal(imageBase64, Buffer.from('fake-bytes').toString('base64'));
        return { type: 'expense', date: null, items: [{ amount: 45000, remark: 'fuel', currency: 'KHR' }] };
      },
      insertExpense: async (e) => { inserted.push(e); return e; },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(result.status, 'logged');
  assert.equal(inserted[0].amount, 45000);
  assert.equal(inserted[0].source, 'telegram');
  assert.equal(inserted[0].telegram_message_id, 30);
});

test('handleTelegramMessage ignores a non-receipt photo classified as not_expense', async () => {
  const sent = [];
  const result = await handleTelegramMessage(
    { text: null, messageId: 31, senderName: 'Srey', chatId: -1, forwardDate: null, photoFileId: 'file_def' },
    {
      pool: fakePool(false),
      downloadTelegramFile: async () => Buffer.from('fake-bytes'),
      parseExpenseImage: async () => ({ type: 'not_expense', date: null, items: [] }),
      insertExpense: async () => { throw new Error('should not insert'); },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(result.status, 'ignored');
  assert.equal(sent.length, 0);
});

test('handleTelegramMessage asks for clarification when a photo is unclear', async () => {
  const sent = [];
  const result = await handleTelegramMessage(
    { text: null, messageId: 32, senderName: 'Srey', chatId: -1, forwardDate: null, photoFileId: 'file_ghi' },
    {
      pool: fakePool(false),
      downloadTelegramFile: async () => Buffer.from('fake-bytes'),
      parseExpenseImage: async () => ({ type: 'unclear', date: null, items: [] }),
      insertExpense: async () => { throw new Error('should not insert'); },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(result.status, 'unclear');
  assert.match(sent[0], /ចំណាយ/);
});

test('handleTelegramMessage replies with a retry message when the image download fails', async () => {
  const sent = [];
  const result = await handleTelegramMessage(
    { text: null, messageId: 33, senderName: 'Srey', chatId: -1, forwardDate: null, photoFileId: 'file_jkl' },
    {
      pool: fakePool(false),
      downloadTelegramFile: async () => { throw new Error('Telegram file expired'); },
      parseExpenseImage: async () => { throw new Error('should not be called'); },
      insertExpense: async () => { throw new Error('should not insert'); },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(result.status, 'error');
  assert.match(sent[0], /trouble/i);
});

test('handleTelegramMessage replies with a retry message when parseExpenseImage fails', async () => {
  const sent = [];
  const result = await handleTelegramMessage(
    { text: null, messageId: 34, senderName: 'Srey', chatId: -1, forwardDate: null, photoFileId: 'file_mno' },
    {
      pool: fakePool(false),
      downloadTelegramFile: async () => Buffer.from('fake-bytes'),
      parseExpenseImage: async () => { throw new Error('Claude API timeout'); },
      insertExpense: async () => { throw new Error('should not insert'); },
      sendTelegramMessage: async (chatId, text) => { sent.push(text); },
    }
  );
  assert.equal(result.status, 'error');
  assert.match(sent[0], /trouble/i);
});
