# Telegram Expense Bot — Image Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Poipet GM drop a photo of a receipt/invoice into the Telegram group and have the bot extract the expense(s) from the image, reusing the existing text-parsing pipeline and schema.

**Architecture:** Extend `extractMessage()` to recognize `message.photo`, add a `downloadTelegramFile()` helper to fetch the raw bytes from Telegram, add a `parseExpenseImage()` sibling to the existing `parseExpenseMessage()` that sends the image (base64) to Claude vision instead of text, and add one new branch in `handleTelegramMessage()` that routes photo messages through the new download+parse path before falling into the exact same insert/reply/error-handling code already used for text.

**Tech Stack:** Node.js (CommonJS), `@anthropic-ai/sdk` (`claude-haiku-4-5`, structured outputs via `output_config.format`), `axios`, `node:test` + `node:assert/strict`.

## Global Constraints

- Vision model is `claude-haiku-4-5` — same model as text parsing, per explicit decision (not upgraded to a higher-res model).
- The downloaded image is **never persisted** — used once in memory to build the base64 payload, then discarded. No new column, no storage bucket, no upload directory.
- Only `message.photo` (Telegram's compressed photo array) is handled. `message.document` (image sent as an uncompressed file) is out of scope.
- Media type for all Telegram `photo` entries is hardcoded to `image/jpeg` (Telegram guarantees this) — no MIME sniffing.
- Multi-photo albums (`media_group_id`) are not merged — each photo arrives as its own webhook update and is processed independently. This is a known, accepted limitation.
- No new DB schema changes — `source = 'telegram'` and `telegram_message_id` are reused exactly as they are today.

---

### Task 1: Detect photo messages in `extractMessage()`

**Files:**
- Modify: `routes/telegram.js:22-36` (the `extractMessage` function)
- Test: `test/telegram.route.test.js`

**Interfaces:**
- Produces: `extractMessage(update)` now returns `{ text, chatId, messageId, senderName, forwardDate, photoFileId }` — `photoFileId` is `null` for text-only messages, and the `file_id` of the **largest** entry in `message.photo` for photo messages. `text` is `message.caption ?? null` for photo messages (unchanged — still `message.text` — for text messages).

- [ ] **Step 1: Write the failing tests**

In `test/telegram.route.test.js`, replace the existing `'extractMessage pulls text, chat id, message id, and sender name'` test (it currently expects an object without `photoFileId`, which will now always be present) and the existing `'extractMessage returns null for non-text updates'` test (its photo case is about to become valid input), and add new photo-detection tests. Replace this block:

```js
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
```

with:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `photoFileId` is `undefined` in the deepEqual test, and the two new photo tests fail because `extractMessage` currently returns `null` for any update without `message.text`.

- [ ] **Step 3: Implement the minimal change**

Replace `extractMessage` in `routes/telegram.js:22-36` with:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all `extractMessage` tests green, including the two pre-existing forward-date tests (unaffected, since they use `assert.equal` on individual fields, not `deepEqual`).

- [ ] **Step 5: Commit**

```bash
git add routes/telegram.js test/telegram.route.test.js
git commit -m "feat(telegram): detect photo messages in extractMessage"
```

---

### Task 2: Add `downloadTelegramFile()` to fetch image bytes from Telegram

**Files:**
- Modify: `services/telegramBot.js`
- Test: `test/telegramBot.test.js`

**Interfaces:**
- Consumes: `telegramBotToken` from `config/index.js` (already imported in this file).
- Produces: `downloadTelegramFile(fileId, httpClient = axios)` → `Promise<Buffer>` — resolves the file path via Telegram's `getFile` endpoint, then downloads and returns the raw bytes as a `Buffer`.

- [ ] **Step 1: Write the failing test**

Add to `test/telegramBot.test.js`:

```js
const { sendTelegramMessage, downloadTelegramFile } = require('../services/telegramBot');

test('downloadTelegramFile resolves the file path then downloads the bytes', async () => {
  const calls = [];
  const fakeHttp = {
    get: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/getFile')) {
        return { data: { result: { file_path: 'photos/file_1.jpg' } } };
      }
      return { data: Buffer.from('fake-image-bytes') };
    },
  };

  const result = await downloadTelegramFile('abc123', fakeHttp);

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/getFile$/);
  assert.deepEqual(calls[0].options.params, { file_id: 'abc123' });
  assert.match(calls[1].url, /\/file\/bot.*\/photos\/file_1\.jpg$/);
  assert.deepEqual(calls[1].options, { responseType: 'arraybuffer' });
  assert.ok(Buffer.isBuffer(result));
  assert.equal(result.toString(), 'fake-image-bytes');
});
```

(The existing `require` line at the top of the file changes from `const { sendTelegramMessage } = require('../services/telegramBot');` to the two-name import shown above.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with `downloadTelegramFile is not a function` (or `undefined`).

- [ ] **Step 3: Implement the minimal code**

Replace the full contents of `services/telegramBot.js` with:

```js
const axios = require('axios');
const { telegramBotToken } = require('../config');

async function sendTelegramMessage(chatId, text, httpClient = axios) {
  await httpClient.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    chat_id: chatId,
    text,
  });
}

async function downloadTelegramFile(fileId, httpClient = axios) {
  const getFileResponse = await httpClient.get(`https://api.telegram.org/bot${telegramBotToken}/getFile`, {
    params: { file_id: fileId },
  });
  const filePath = getFileResponse.data.result.file_path;
  const fileResponse = await httpClient.get(`https://api.telegram.org/file/bot${telegramBotToken}/${filePath}`, {
    responseType: 'arraybuffer',
  });
  return Buffer.from(fileResponse.data);
}

module.exports = { sendTelegramMessage, downloadTelegramFile };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — both the pre-existing `sendTelegramMessage` test and the new `downloadTelegramFile` test are green.

- [ ] **Step 5: Commit**

```bash
git add services/telegramBot.js test/telegramBot.test.js
git commit -m "feat(telegram): add downloadTelegramFile for fetching photo bytes"
```

---

### Task 3: Add `parseExpenseImage()` to `telegramParser.js`

**Files:**
- Modify: `services/telegramParser.js`
- Test: `test/telegramParser.test.js`

**Interfaces:**
- Consumes: shared `SYSTEM_PROMPT` and `OUTPUT_SCHEMA` constants (reworded/reused from the existing text path — see Step 3).
- Produces: `parseExpenseImage(caption, imageBase64, referenceDate, anthropicClient = getDefaultClient())` → same return shape as `parseExpenseMessage`: `{ type: 'expense'|'not_expense'|'unclear', date: string|null, items: [{amount, remark, currency}] }`.
- Also produces (internal refactor, not exported): `interpretResponse(response)` — shared response-parsing logic used by both `parseExpenseMessage` and `parseExpenseImage`.

- [ ] **Step 1: Write the failing tests**

Add to `test/telegramParser.test.js` (alongside the existing `parseExpenseMessage` import — change the top import line to `const { parseExpenseMessage, parseExpenseImage } = require('../services/telegramParser');`):

```js
function fakeImageClient(responseText, stopReason = 'end_turn') {
  return {
    messages: {
      create: async () => ({
        stop_reason: stopReason,
        content: [{ type: 'text', text: responseText }],
      }),
    },
  };
}

test('parseExpenseImage parses a single-item receipt photo', async () => {
  const client = fakeImageClient(JSON.stringify({
    type: 'expense',
    date: null,
    items: [{ amount: 45000, remark: 'fuel receipt', currency: 'KHR' }],
  }));
  const result = await parseExpenseImage(null, 'ZmFrZS1pbWFnZS1ieXRlcw==', '2026-07-04', client);
  assert.deepEqual(result, { type: 'expense', date: null, items: [{ amount: 45000, remark: 'fuel receipt', currency: 'KHR' }] });
});

test('parseExpenseImage parses a multi-item receipt photo', async () => {
  const client = fakeImageClient(JSON.stringify({
    type: 'expense',
    date: null,
    items: [
      { amount: 30000, remark: 'parts', currency: 'KHR' },
      { amount: 15000, remark: 'labor', currency: 'KHR' },
    ],
  }));
  const result = await parseExpenseImage('repair shop', 'ZmFrZS1pbWFnZS1ieXRlcw==', '2026-07-04', client);
  assert.equal(result.items.length, 2);
});

test('parseExpenseImage classifies a non-receipt photo as not_expense', async () => {
  const client = fakeImageClient(JSON.stringify({ type: 'not_expense', date: null, items: [] }));
  const result = await parseExpenseImage(null, 'ZmFrZS1pbWFnZS1ieXRlcw==', '2026-07-04', client);
  assert.equal(result.type, 'not_expense');
});

test('parseExpenseImage treats a refusal stop_reason as unclear', async () => {
  const client = { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } };
  const result = await parseExpenseImage(null, 'ZmFrZS1pbWFnZS1ieXRlcw==', '2026-07-04', client);
  assert.equal(result.type, 'unclear');
});

test('parseExpenseImage extracts a date printed on the receipt', async () => {
  const client = fakeImageClient(JSON.stringify({
    type: 'expense',
    date: '2026-07-01',
    items: [{ amount: 45000, remark: 'fuel', currency: 'KHR' }],
  }));
  const result = await parseExpenseImage(null, 'ZmFrZS1pbWFnZS1ieXRlcw==', '2026-07-04', client);
  assert.equal(result.date, '2026-07-01');
});

test('parseExpenseImage sends the image as a base64 content block and includes the caption in the text block', async () => {
  let receivedParams = null;
  const client = {
    messages: {
      create: async (params) => {
        receivedParams = params;
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({ type: 'not_expense', date: null, items: [] }) }],
        };
      },
    },
  };
  await parseExpenseImage('fuel receipt', 'ZmFrZS1pbWFnZS1ieXRlcw==', '2026-07-04', client);
  const content = receivedParams.messages[0].content;
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.data, 'ZmFrZS1pbWFnZS1ieXRlcw==');
  assert.equal(content[0].source.media_type, 'image/jpeg');
  assert.match(content[1].text, /2026-07-04/);
  assert.match(content[1].text, /fuel receipt/);
});

test('parseExpenseImage omits the caption line when there is no caption', async () => {
  let receivedParams = null;
  const client = {
    messages: {
      create: async (params) => {
        receivedParams = params;
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({ type: 'not_expense', date: null, items: [] }) }],
        };
      },
    },
  };
  await parseExpenseImage(null, 'ZmFrZS1pbWFnZS1ieXRlcw==', '2026-07-04', client);
  const content = receivedParams.messages[0].content;
  assert.doesNotMatch(content[1].text, /Caption:/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `parseExpenseImage is not a function`.

- [ ] **Step 3: Implement the minimal code**

Replace the full contents of `services/telegramParser.js` with:

```js
const Anthropic = require('@anthropic-ai/sdk');
const { anthropicApiKey } = require('../config');

let defaultClient = null;
function getDefaultClient() {
  if (!defaultClient) defaultClient = new Anthropic({ apiKey: anthropicApiKey });
  return defaultClient;
}

const SYSTEM_PROMPT = `You read messages from a Telegram group used by a small business in Cambodia to report expenses. A message may be plain text describing an expense, or a photo of a receipt/invoice (optionally with a caption).

For each message, decide one of:
- "expense": the message (or photo) describes one or more real expenses. List each distinct expense as an item with a plain numeric "amount" (no currency symbols, no thousands separators), a short "remark" describing what it was for, and a "currency" of "KHR" or "USD" based on how the amount was stated (mentions of "$", "USD", "dollar", or similar mean USD; otherwise assume KHR). For a receipt or invoice photo with several line items, list each as a separate item.
- "not_expense": the message is casual conversation, a greeting, a question, or a photo unrelated to an expense — not an expense report.
- "unclear": the message or photo might be an expense but the amount or what it was for is too ambiguous to extract confidently (e.g. a blurry or unreadable photo).

Also check whether the message explicitly states when the expense happened (a specific day, "yesterday", "last Monday", a date like "July 1" or "01/07", or a date printed on a receipt). If so, resolve it to an absolute date in YYYY-MM-DD format and set "date" to that value — use the reference date given with the message to resolve relative terms and to fill in an unstated year. If nothing states when the expense happened, set "date" to null.

Respond only with the structured JSON — no other text.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['expense', 'not_expense', 'unclear'] },
    date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          remark: { type: 'string' },
          currency: { type: 'string', enum: ['KHR', 'USD'] },
        },
        required: ['amount', 'remark', 'currency'],
        additionalProperties: false,
      },
    },
  },
  required: ['type', 'date', 'items'],
  additionalProperties: false,
};

function interpretResponse(response) {
  if (response.stop_reason === 'refusal') return { type: 'unclear', date: null };

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) return { type: 'unclear', date: null };

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    return { type: 'unclear', date: null };
  }

  if (parsed.type === 'expense' && (!Array.isArray(parsed.items) || parsed.items.length === 0)) {
    return { type: 'unclear', date: null };
  }

  return parsed;
}

async function parseExpenseMessage(text, referenceDate, anthropicClient = getDefaultClient()) {
  const response = await anthropicClient.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{
      role: 'user',
      content: `Reference date (today, or the date this message was originally sent if it was forwarded): ${referenceDate}\n\nMessage: ${text}`,
    }],
  });

  return interpretResponse(response);
}

async function parseExpenseImage(caption, imageBase64, referenceDate, anthropicClient = getDefaultClient()) {
  const captionLine = caption ? `\n\nCaption: ${caption}` : '';
  const response = await anthropicClient.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: `Reference date (today, or the date this message was originally sent if it was forwarded): ${referenceDate}${captionLine}` },
      ],
    }],
  });

  return interpretResponse(response);
}

module.exports = { parseExpenseMessage, parseExpenseImage };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all pre-existing `parseExpenseMessage` tests still pass unchanged (the refactor into `interpretResponse` preserves identical behavior), plus all new `parseExpenseImage` tests pass.

- [ ] **Step 5: Commit**

```bash
git add services/telegramParser.js test/telegramParser.test.js
git commit -m "feat(telegram): add parseExpenseImage for receipt photo extraction"
```

---

### Task 4: Route photo messages through download + image parsing in `handleTelegramMessage`

**Files:**
- Modify: `routes/telegram.js` (the `handleTelegramMessage` function and the `POST /webhook` handler)
- Test: `test/telegram.route.test.js`

**Interfaces:**
- Consumes: `photoFileId` from `extractMessage()` (Task 1), `downloadTelegramFile()` from `services/telegramBot.js` (Task 2), `parseExpenseImage()` from `services/telegramParser.js` (Task 3).
- Produces: `handleTelegramMessage({ text, messageId, senderName, chatId, forwardDate, photoFileId }, deps)` where `deps` now also accepts `parseExpenseImage` and `downloadTelegramFile` alongside the existing `pool`, `parseExpenseMessage`, `insertExpense`, `sendTelegramMessage`.

- [ ] **Step 1: Write the failing tests**

Add to `test/telegram.route.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `handleTelegramMessage` currently always calls `parseExpenseMessage` regardless of `photoFileId`, so the mocked `parseExpenseMessage` throw (`'should not be called for a photo message'`) fires, and the download-mock assertions never run.

- [ ] **Step 3: Implement the minimal change**

Replace `handleTelegramMessage` in `routes/telegram.js` with:

```js
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
```

Then update the `require` line and the webhook handler's dependency object. Change:

```js
const { sendTelegramMessage } = require('../services/telegramBot');
```

to:

```js
const { sendTelegramMessage, downloadTelegramFile } = require('../services/telegramBot');
```

and change:

```js
const { parseExpenseMessage } = require('../services/telegramParser');
```

to:

```js
const { parseExpenseMessage, parseExpenseImage } = require('../services/telegramParser');
```

and inside `router.post('/webhook', ...)`, change:

```js
await handleTelegramMessage(message, { pool, parseExpenseMessage, insertExpense, sendTelegramMessage });
```

to:

```js
await handleTelegramMessage(message, { pool, parseExpenseMessage, parseExpenseImage, downloadTelegramFile, insertExpense, sendTelegramMessage });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all pre-existing `handleTelegramMessage` text-path tests remain green (they never set `photoFileId`, so they take the unchanged `parseExpenseMessage` branch), plus all five new photo-path tests pass.

- [ ] **Step 5: Commit**

```bash
git add routes/telegram.js test/telegram.route.test.js
git commit -m "feat(telegram): route photo messages through parseExpenseImage"
```

---

## Self-Review

**Spec coverage:**
- Photo detection / caption-as-text / largest-resolution selection → Task 1.
- Downloading image bytes from Telegram → Task 2.
- Vision extraction via Claude (Haiku 4.5, shared schema, receipt with multiple line items) → Task 3.
- Wiring into `handleTelegramMessage` (no storage, error handling identical to text path, `not_expense`/`unclear`/error branches) → Task 4.
- "No image storage" constraint → satisfied structurally: the buffer from `downloadTelegramFile` is only ever converted to a base64 string and handed to `parseExpenseImage`; it is never written to disk or a DB column anywhere in this plan.
- `message.document` and media-group merging are explicitly out of scope per the spec — no task attempts them.

**Placeholder scan:** No TBD/TODO — every step has literal file contents and exact test code.

**Type consistency:** `photoFileId` (Task 1) → consumed by `downloadTelegramFile(fileId, ...)` (Task 2) and by the `if (photoFileId)` branch in `handleTelegramMessage` (Task 4). `parseExpenseImage(caption, imageBase64, referenceDate, anthropicClient)` (Task 3) signature matches exactly how it's called in Task 4 (`parseExpenseImage(text, imageBuffer.toString('base64'), referenceDate)`). Return shape `{ type, date, items }` is identical between `parseExpenseMessage` and `parseExpenseImage`, so Task 4's existing post-parse logic (`not_expense`/`unclear`/insert loop) needs no branching beyond the parse call itself.
