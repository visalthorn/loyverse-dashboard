# Telegram Expense Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Poipet GM log expenses by posting a plain-text message in a shared Telegram group; a webhook parses it with Claude and inserts it into the same `expenses` table the dashboard already uses.

**Architecture:** A new Express route (`POST /api/telegram/webhook`) receives Telegram updates, validates the sender, calls a Claude Haiku parsing service to classify/extract expense data, and inserts via a shared `insertExpense()` service also used by the existing dashboard form. A Telegram-send service replies with a confirmation or a clarification request.

**Tech Stack:** Node.js/Express (CommonJS), PostgreSQL (`pg`), `axios` (already a dependency, used for the Telegram Bot API), `@anthropic-ai/sdk` (new dependency, for Claude Haiku), Node's built-in `node:test` + `node:assert/strict` (new test tooling — this project has no existing test framework).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-04-telegram-expense-bot-design.md` — read it before starting if anything here is ambiguous.
- Integrated into the existing Express app — no new process, no new deployment target.
- Single currency: KHR only. No `currency` column, no conversion. A USD-sounding message is rejected with a prompt to resend in Riel — never inserted as-is.
- No bot-side editing/deleting of expenses. Mistakes are fixed via the existing dashboard edit UI.
- Parsing model: `claude-haiku-4-5` (classification/extraction task; no need for a larger model).
- New env vars (add to `.env`, wired through `config/index.js`): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_GROUP_CHAT_ID`, `ANTHROPIC_API_KEY`.
- Schema additions to `expenses`: `source VARCHAR(20) NOT NULL DEFAULT 'dashboard'`, `telegram_message_id BIGINT` (nullable).
  - **Deviation from the spec's literal wording, noted here for the reviewer:** the spec describes `telegram_message_id` as "unique" for dedupe. This plan implements the *same* idempotency guarantee (a retried Telegram webhook delivery does not double-insert) via an existence check before inserting, rather than a DB `UNIQUE` constraint — because one Telegram message can legitimately produce multiple expense rows (e.g. "50000 diesel, 20000 lunch"), and those rows share one `telegram_message_id`. A `UNIQUE` constraint would silently drop the second row of a multi-item message. No column-level uniqueness is added.
- The webhook route (`/api/telegram/webhook`) is intentionally **not** behind `requireAuth`/`requireWrite` — Telegram is the caller, not a dashboard user. It authenticates the request itself by comparing Telegram's `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET`, and by checking the update's chat ID against `TELEGRAM_GROUP_CHAT_ID`. This is deliberate, not an oversight.
- All dates are handled in Asia/Phnom_Penh (`config.tz`), matching the rest of the codebase (`utils/date.js`).
- **This project has no existing test suite.** Tests introduced here use Node's built-in `node:test` (no new dependency) and, where they touch the database, run against the local UAT Postgres instance — **never** production. `.env` currently sets `ENV=PROD` by default, so **every test command in this plan is explicitly prefixed with `cross-env ENV=UAT`**. Do not run a bare `node --test` — it will connect to the live Supabase production database.
- `cross-env` is already a project dependency (used by the existing `npm run dev:uat` script) — reuse it, don't add a new env-var tool.

---

### Task 1: Database migration (`source`, `telegram_message_id`) + test tooling setup

**Files:**
- Create: `scripts/add-telegram-columns.js`
- Create: `test/db-migration.test.js`
- Modify: `package.json` (add `"test"` script)

**Interfaces:**
- Produces: two new nullable/defaulted columns on the existing `expenses` table (`source`, `telegram_message_id`) that Task 3 (`insertExpense`) and Task 6 (webhook dedupe check) depend on.

- [ ] **Step 1: Add the test script to `package.json`**

In `package.json`, inside `"scripts"`, add:

```json
"test": "cross-env ENV=UAT node --test"
```

So the `"scripts"` block reads:

```json
"scripts": {
  "start": "node server.js",
  "dev": "nodemon server.js",
  "start:uat": "cross-env ENV=UAT node server.js",
  "start:prod": "cross-env ENV=PROD node server.js",
  "dev:uat": "cross-env ENV=UAT nodemon server.js",
  "dev:prod": "cross-env ENV=PROD nodemon server.js",
  "test": "cross-env ENV=UAT node --test"
},
```

- [ ] **Step 2: Write the failing test**

Create `test/db-migration.test.js`:

```js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');

after(async () => {
  await pool.end();
});

test('expenses table has source and telegram_message_id columns', async () => {
  const result = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'expenses' AND column_name IN ('source', 'telegram_message_id')
  `);
  const columns = result.rows.map(r => r.column_name).sort();
  assert.deepEqual(columns, ['source', 'telegram_message_id']);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx cross-env ENV=UAT node --test test/db-migration.test.js`
Expected: FAIL — `columns` is `[]`, not `['source', 'telegram_message_id']`.

- [ ] **Step 4: Write the migration script**

Create `scripts/add-telegram-columns.js`:

```js
const pool = require('../db');

async function migrate() {
  await pool.query(`
    ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'dashboard',
      ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT
  `);
  console.log('✅ expenses table migrated: source, telegram_message_id columns present');
}

migrate()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  });
```

- [ ] **Step 5: Run the migration against UAT**

Run: `npx cross-env ENV=UAT node scripts/add-telegram-columns.js`
Expected: `✅ expenses table migrated: source, telegram_message_id columns present`

- [ ] **Step 6: Run the test again to verify it passes**

Run: `npx cross-env ENV=UAT node --test test/db-migration.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/add-telegram-columns.js test/db-migration.test.js
git commit -m "$(cat <<'EOF'
Add source/telegram_message_id columns to expenses table

Foundation for Telegram-sourced expense entries: source distinguishes
dashboard vs telegram inserts, telegram_message_id supports dedupe on
webhook retries. Also adds node:test as the project's test runner
(there was none previously).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Config — Telegram and Anthropic env vars

**Files:**
- Modify: `config/index.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `config.telegramBotToken`, `config.telegramWebhookSecret`, `config.telegramGroupChatId`, `config.anthropicApiKey` — consumed by Tasks 4, 5, and 6.

- [ ] **Step 1: Write the failing test**

Create `test/config.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('config exposes telegram and anthropic env vars', () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret';
  process.env.TELEGRAM_GROUP_CHAT_ID = '-100123456';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  delete require.cache[require.resolve('../config')];
  const config = require('../config');

  assert.equal(config.telegramBotToken, 'test-bot-token');
  assert.equal(config.telegramWebhookSecret, 'test-webhook-secret');
  assert.equal(config.telegramGroupChatId, '-100123456');
  assert.equal(config.anthropicApiKey, 'test-anthropic-key');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env ENV=UAT node --test test/config.test.js`
Expected: FAIL — `config.telegramBotToken` etc. are `undefined`.

- [ ] **Step 3: Update config/index.js**

Change `config/index.js` from:

```js
require('dotenv').config();

module.exports = {
  port:          process.env.PORT || process.env.DASHBOARD_PORT || 3000,
  jwtSecret:     process.env.JWT_SECRET || process.env.JWT_SECRET_UAT || process.env.JWT_SECRET_PROD || 'pos_dashboard_secret_change_in_prod',
  jwtExpires:    '24h',
  tz:            'Asia/Phnom_Penh',
  env:           process.env.ENV || 'UAT',
  loyverseToken: process.env.LOYVERSE_TOKEN,
};
```

to:

```js
require('dotenv').config();

module.exports = {
  port:                  process.env.PORT || process.env.DASHBOARD_PORT || 3000,
  jwtSecret:             process.env.JWT_SECRET || process.env.JWT_SECRET_UAT || process.env.JWT_SECRET_PROD || 'pos_dashboard_secret_change_in_prod',
  jwtExpires:            '24h',
  tz:                    'Asia/Phnom_Penh',
  env:                   process.env.ENV || 'UAT',
  loyverseToken:         process.env.LOYVERSE_TOKEN,
  telegramBotToken:      process.env.TELEGRAM_BOT_TOKEN,
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  telegramGroupChatId:   process.env.TELEGRAM_GROUP_CHAT_ID,
  anthropicApiKey:       process.env.ANTHROPIC_API_KEY,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx cross-env ENV=UAT node --test test/config.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add config/index.js test/config.test.js
git commit -m "$(cat <<'EOF'
Add Telegram and Anthropic config values

Centralizes the new env vars in config/index.js following the
existing loyverseToken pattern, so later modules import from config
instead of reading process.env directly.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extract `insertExpense()` into a shared service

**Files:**
- Create: `services/expenses.js`
- Modify: `routes/expenses.js:1-3` (add require), `routes/expenses.js:46-60` (POST handler body)
- Test: `test/expenses.service.test.js`

**Interfaces:**
- Consumes: nothing beyond the existing `pool` from `../db`.
- Produces: `insertExpense({ expense_date, amount, remark, expense_by, source = 'dashboard', telegram_message_id = null }) => Promise<{ id, expense_date, amount, remark, expense_by, source, telegram_message_id, created_at }>` — consumed by `routes/expenses.js` (this task) and `routes/telegram.js` (Task 6).

- [ ] **Step 1: Write the failing test**

Create `test/expenses.service.test.js`:

```js
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const { insertExpense } = require('../services/expenses');

after(async () => {
  await pool.end();
});

test('insertExpense defaults source to dashboard and telegram_message_id to null', async () => {
  const expense = await insertExpense({
    expense_date: '2026-07-04',
    amount: 15000,
    remark: 'test remark',
    expense_by: 'Test User',
  });

  assert.equal(expense.source, 'dashboard');
  assert.equal(expense.telegram_message_id, null);
  assert.equal(Number(expense.amount), 15000);
  assert.equal(expense.expense_by, 'Test User');

  await pool.query('DELETE FROM expenses WHERE id = $1', [expense.id]);
});

test('insertExpense stores telegram source and message id when provided', async () => {
  const expense = await insertExpense({
    expense_date: '2026-07-04',
    amount: 20000,
    remark: 'diesel',
    expense_by: 'Srey Sister',
    source: 'telegram',
    telegram_message_id: 999001,
  });

  assert.equal(expense.source, 'telegram');
  assert.equal(expense.telegram_message_id, 999001);

  await pool.query('DELETE FROM expenses WHERE id = $1', [expense.id]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env ENV=UAT node --test test/expenses.service.test.js`
Expected: FAIL with `Cannot find module '../services/expenses'`.

- [ ] **Step 3: Write `services/expenses.js`**

```js
const pool = require('../db');

async function insertExpense({ expense_date, amount, remark, expense_by, source = 'dashboard', telegram_message_id = null }) {
  const result = await pool.query(`
    INSERT INTO expenses (expense_date, amount, remark, expense_by, source, telegram_message_id)
    VALUES ($1,$2,$3,$4,$5,$6)
    RETURNING id, expense_date, amount, remark, expense_by, source, telegram_message_id, created_at
  `, [expense_date, amount, remark || null, expense_by, source, telegram_message_id]);
  return result.rows[0];
}

module.exports = { insertExpense };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx cross-env ENV=UAT node --test test/expenses.service.test.js`
Expected: PASS

- [ ] **Step 5: Refactor `routes/expenses.js` to use the new service**

In `routes/expenses.js`, change the top of the file from:

```js
const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireWrite } = require('../middleware/auth');
```

to:

```js
const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireWrite } = require('../middleware/auth');
const { insertExpense } = require('../services/expenses');
```

Then change the POST handler from:

```js
router.post('/', requireAuth, requireWrite('expenses'), async (req, res) => {
  const { expense_date, amount, remark, expense_by } = req.body;
  if (!expense_date || !amount || !expense_by)
    return res.status(400).json({ message: 'expense_date, amount and expense_by are required.' });
  try {
    const result = await pool.query(`
      INSERT INTO expenses (expense_date, amount, remark, expense_by)
      VALUES ($1,$2,$3,$4) RETURNING id, expense_date, amount, remark, expense_by, created_at
    `, [expense_date, amount, remark || null, expense_by]);
    res.status(201).json({ expense: result.rows[0] });
  } catch (err) {
    console.error('Expenses POST error:', err);
    res.status(500).json({ error: err.message });
  }
});
```

to:

```js
router.post('/', requireAuth, requireWrite('expenses'), async (req, res) => {
  const { expense_date, amount, remark, expense_by } = req.body;
  if (!expense_date || !amount || !expense_by)
    return res.status(400).json({ message: 'expense_date, amount and expense_by are required.' });
  try {
    const expense = await insertExpense({ expense_date, amount, remark, expense_by });
    res.status(201).json({ expense });
  } catch (err) {
    console.error('Expenses POST error:', err);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 6: Manually verify the dashboard expense form still works**

Run: `npm run dev:uat`, open `http://localhost:3000`, go to the Expenses page, and add an expense through the form. Confirm it appears in the list (this exercises the refactored route end-to-end against the real UAT DB).

- [ ] **Step 7: Commit**

```bash
git add services/expenses.js routes/expenses.js test/expenses.service.test.js
git commit -m "$(cat <<'EOF'
Extract insertExpense() into a shared service

The dashboard's manual expense form and the upcoming Telegram bot
both need to insert into the expenses table the same way. Pulling
the INSERT out of routes/expenses.js into services/expenses.js gives
both callers one source of truth.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Claude-based message parser

**Files:**
- Create: `services/telegramParser.js`
- Test: `test/telegramParser.test.js`
- Modify: `package.json` (new dependency)

**Interfaces:**
- Consumes: `config.anthropicApiKey` (Task 2); an injectable Anthropic-shaped client `{ messages: { create(params) => Promise<{ stop_reason, content: [{ type, text }] }> } }` for testability.
- Produces: `parseExpenseMessage(text, anthropicClient?) => Promise<{ type: 'expense', items: [{amount, remark}] } | { type: 'not_expense' | 'usd_detected' | 'unclear', items?: [] }>` — consumed by `routes/telegram.js` (Task 6).

- [ ] **Step 1: Install the Anthropic SDK**

Run: `npm install @anthropic-ai/sdk`
Expected: `package.json` gains a `"@anthropic-ai/sdk"` entry under `"dependencies"`.

- [ ] **Step 2: Write the failing tests**

Create `test/telegramParser.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseExpenseMessage } = require('../services/telegramParser');

function fakeClient(responseText, stopReason = 'end_turn') {
  return {
    messages: {
      create: async () => ({
        stop_reason: stopReason,
        content: [{ type: 'text', text: responseText }],
      }),
    },
  };
}

test('parses a single expense', async () => {
  const client = fakeClient(JSON.stringify({
    type: 'expense',
    items: [{ amount: 50000, remark: 'diesel for truck' }],
  }));
  const result = await parseExpenseMessage('50000 diesel for truck', client);
  assert.deepEqual(result, { type: 'expense', items: [{ amount: 50000, remark: 'diesel for truck' }] });
});

test('parses multiple expenses from one message', async () => {
  const client = fakeClient(JSON.stringify({
    type: 'expense',
    items: [
      { amount: 50000, remark: 'diesel' },
      { amount: 20000, remark: 'lunch' },
    ],
  }));
  const result = await parseExpenseMessage('50000 diesel, 20000 lunch', client);
  assert.equal(result.type, 'expense');
  assert.equal(result.items.length, 2);
});

test('classifies casual chat as not_expense', async () => {
  const client = fakeClient(JSON.stringify({ type: 'not_expense', items: [] }));
  const result = await parseExpenseMessage('good morning everyone', client);
  assert.equal(result.type, 'not_expense');
});

test('classifies USD-denominated messages as usd_detected', async () => {
  const client = fakeClient(JSON.stringify({ type: 'usd_detected', items: [] }));
  const result = await parseExpenseMessage('$20 for parts', client);
  assert.equal(result.type, 'usd_detected');
});

test('treats a refusal stop_reason as unclear', async () => {
  const client = { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } };
  const result = await parseExpenseMessage('some message', client);
  assert.equal(result.type, 'unclear');
});

test('treats malformed JSON as unclear', async () => {
  const client = fakeClient('not valid json{{{');
  const result = await parseExpenseMessage('garbled', client);
  assert.equal(result.type, 'unclear');
});

test('treats an expense type with no items as unclear', async () => {
  const client = fakeClient(JSON.stringify({ type: 'expense', items: [] }));
  const result = await parseExpenseMessage('ambiguous message', client);
  assert.equal(result.type, 'unclear');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx cross-env ENV=UAT node --test test/telegramParser.test.js`
Expected: FAIL with `Cannot find module '../services/telegramParser'`.

- [ ] **Step 4: Write `services/telegramParser.js`**

```js
const Anthropic = require('@anthropic-ai/sdk');
const { anthropicApiKey } = require('../config');

let defaultClient = null;
function getDefaultClient() {
  if (!defaultClient) defaultClient = new Anthropic({ apiKey: anthropicApiKey });
  return defaultClient;
}

const SYSTEM_PROMPT = `You read messages from a Telegram group used by a small business in Cambodia to report expenses.

For each message, decide one of:
- "expense": the message describes one or more real expenses paid in Cambodian Riel (KHR). List each distinct expense as an item with a plain numeric "amount" (no currency symbols, no thousands separators) and a short "remark" describing what it was for.
- "not_expense": the message is casual conversation, a greeting, or a question — not an expense report.
- "usd_detected": the message describes an expense but the amount is stated in US dollars (mentions "$", "USD", "dollar", or similar). Do not extract an amount in this case.
- "unclear": the message might be an expense but the amount or what it was for is too ambiguous to extract confidently.

Respond only with the structured JSON — no other text.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['expense', 'not_expense', 'usd_detected', 'unclear'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          remark: { type: 'string' },
        },
        required: ['amount', 'remark'],
        additionalProperties: false,
      },
    },
  },
  required: ['type', 'items'],
  additionalProperties: false,
};

async function parseExpenseMessage(text, anthropicClient = getDefaultClient()) {
  const response = await anthropicClient.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    messages: [{ role: 'user', content: text }],
  });

  if (response.stop_reason === 'refusal') return { type: 'unclear' };

  const textBlock = response.content.find(b => b.type === 'text');
  if (!textBlock) return { type: 'unclear' };

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    return { type: 'unclear' };
  }

  if (parsed.type === 'expense' && (!Array.isArray(parsed.items) || parsed.items.length === 0)) {
    return { type: 'unclear' };
  }

  return parsed;
}

module.exports = { parseExpenseMessage };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx cross-env ENV=UAT node --test test/telegramParser.test.js`
Expected: PASS (all 7 tests) — these tests never call the real Anthropic API since every call injects `fakeClient`.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json services/telegramParser.js test/telegramParser.test.js
git commit -m "$(cat <<'EOF'
Add Claude-based Telegram message parser

parseExpenseMessage() classifies a Telegram message as an expense
(one or more amount+remark items), casual chat, USD-denominated (KHR
only is supported, so this is rejected rather than converted), or
unclear. Uses claude-haiku-4-5 with a JSON schema output format so
responses are always structurally valid.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Telegram send wrapper

**Files:**
- Create: `services/telegramBot.js`
- Test: `test/telegramBot.test.js`

**Interfaces:**
- Consumes: `config.telegramBotToken` (Task 2); an injectable HTTP client `{ post(url, body) => Promise }` for testability (default: the project's existing `axios`).
- Produces: `sendTelegramMessage(chatId, text, httpClient?) => Promise<void>` — consumed by `routes/telegram.js` (Task 6).

- [ ] **Step 1: Write the failing test**

Create `test/telegramBot.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendTelegramMessage } = require('../services/telegramBot');

test('sendTelegramMessage posts chat_id and text to the Telegram API', async () => {
  const calls = [];
  const fakeHttp = {
    post: async (url, body) => {
      calls.push({ url, body });
      return { data: { ok: true } };
    },
  };

  await sendTelegramMessage(-100123456, 'hello', fakeHttp);

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/sendMessage$/);
  assert.deepEqual(calls[0].body, { chat_id: -100123456, text: 'hello' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env ENV=UAT node --test test/telegramBot.test.js`
Expected: FAIL with `Cannot find module '../services/telegramBot'`.

- [ ] **Step 3: Write `services/telegramBot.js`**

```js
const axios = require('axios');
const { telegramBotToken } = require('../config');

async function sendTelegramMessage(chatId, text, httpClient = axios) {
  await httpClient.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    chat_id: chatId,
    text,
  });
}

module.exports = { sendTelegramMessage };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx cross-env ENV=UAT node --test test/telegramBot.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/telegramBot.js test/telegramBot.test.js
git commit -m "$(cat <<'EOF'
Add Telegram send wrapper

sendTelegramMessage() posts a reply to a chat via the Telegram Bot
API, mirroring the existing axios-client pattern in
services/loyverse.js.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Webhook route

**Files:**
- Create: `routes/telegram.js`
- Modify: `routes/index.js`
- Test: `test/telegram.route.test.js`

**Interfaces:**
- Consumes: `pool` (`../db`), `config.telegramWebhookSecret` / `config.telegramGroupChatId` (Task 2), `parseExpenseMessage` (Task 4), `insertExpense` (Task 3), `sendTelegramMessage` (Task 5).
- Produces: `POST /api/telegram/webhook` route; exports `extractMessage(update)` and `handleTelegramMessage(message, deps)` for testing.

- [ ] **Step 1: Write the failing tests**

Create `test/telegram.route.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractMessage, handleTelegramMessage } = require('../routes/telegram');

function fakePool(dupExists = false) {
  return { query: async () => ({ rowCount: dupExists ? 1 : 0 }) };
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
  });
});

test('extractMessage returns null for non-text updates', () => {
  assert.equal(extractMessage({ message: { chat: { id: 1 }, photo: [{}] } }), null);
  assert.equal(extractMessage({}), null);
});

test('handleTelegramMessage skips a duplicate telegram_message_id without calling the parser', async () => {
  const sent = [];
  const inserted = [];
  const result = await handleTelegramMessage(
    { text: '50000 diesel', messageId: 42, senderName: 'Srey', chatId: -1 },
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
    { text: 'good morning', messageId: 1, senderName: 'Srey', chatId: -1 },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({ type: 'not_expense', items: [] }),
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
    { text: '$20 for parts', messageId: 2, senderName: 'Srey', chatId: -1 },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({ type: 'usd_detected', items: [] }),
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
    { text: 'huh', messageId: 3, senderName: 'Srey', chatId: -1 },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({ type: 'unclear', items: [] }),
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
    { text: '50000 diesel, 20000 lunch', messageId: 4, senderName: 'Srey', chatId: -1 },
    {
      pool: fakePool(false),
      parseExpenseMessage: async () => ({
        type: 'expense',
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
    { text: '50000 diesel', messageId: 5, senderName: 'Srey', chatId: -1 },
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx cross-env ENV=UAT node --test test/telegram.route.test.js`
Expected: FAIL with `Cannot find module '../routes/telegram'`.

- [ ] **Step 3: Write `routes/telegram.js`**

```js
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
  return {
    text: message.text,
    chatId: message.chat.id,
    messageId: message.message_id,
    senderName,
  };
}

async function handleTelegramMessage({ text, messageId, senderName, chatId }, deps) {
  const { pool, parseExpenseMessage, insertExpense, sendTelegramMessage } = deps;

  const dup = await pool.query('SELECT 1 FROM expenses WHERE telegram_message_id = $1 LIMIT 1', [messageId]);
  if (dup.rowCount > 0) return { status: 'duplicate' };

  let parsed;
  try {
    parsed = await parseExpenseMessage(text);
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

  const today = dayjs().tz(tz).format('YYYY-MM-DD');
  const inserted = [];
  for (const item of parsed.items) {
    const expense = await insertExpense({
      expense_date: today,
      amount: item.amount,
      remark: item.remark,
      expense_by: senderName,
      source: 'telegram',
      telegram_message_id: messageId,
    });
    inserted.push(expense);
  }

  const replyText = inserted
    .map(e => `✅ Logged: ៛${Number(e.amount).toLocaleString()} – ${e.remark || '(no remark)'}`)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx cross-env ENV=UAT node --test test/telegram.route.test.js`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Mount the route**

In `routes/index.js`, change:

```js
const authRouter        = require('./auth');
const analyticsRouter   = require('./analytics');
const expensesRouter    = require('./expenses');
const receiptsRouter    = require('./receipts');
const staffRouter       = require('./staff');
const scheduleRouter    = require('./schedule');
const usersRouter       = require('./users');
const permissionsRouter = require('./permissions');
const syncLogsRouter    = require('./sync-logs');

router.use('/api/auth',        authRouter);
router.use('/api',             analyticsRouter);
router.use('/api/expenses',    expensesRouter);
router.use('/api/receipts',    receiptsRouter);
router.use('/api/staff',       staffRouter);
router.use('/api/schedule',    scheduleRouter);
router.use('/api/users',       usersRouter);
router.use('/api/permissions', permissionsRouter);
router.use('/api/sync-logs',   syncLogsRouter);
```

to:

```js
const authRouter        = require('./auth');
const analyticsRouter   = require('./analytics');
const expensesRouter    = require('./expenses');
const receiptsRouter    = require('./receipts');
const staffRouter       = require('./staff');
const scheduleRouter    = require('./schedule');
const usersRouter       = require('./users');
const permissionsRouter = require('./permissions');
const syncLogsRouter    = require('./sync-logs');
const telegramRouter    = require('./telegram');

router.use('/api/auth',        authRouter);
router.use('/api',             analyticsRouter);
router.use('/api/expenses',    expensesRouter);
router.use('/api/receipts',    receiptsRouter);
router.use('/api/staff',       staffRouter);
router.use('/api/schedule',    scheduleRouter);
router.use('/api/users',       usersRouter);
router.use('/api/permissions', permissionsRouter);
router.use('/api/sync-logs',   syncLogsRouter);
router.use('/api/telegram',    telegramRouter);
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: all test files pass (`db-migration`, `config`, `expenses.service`, `telegramParser`, `telegramBot`, `telegram.route`).

- [ ] **Step 7: Manually verify the app still starts**

Run: `npm run dev:uat`, confirm the server starts without errors and `http://localhost:3000` still loads (the new route doesn't break existing ones).

- [ ] **Step 8: Commit**

```bash
git add routes/telegram.js routes/index.js test/telegram.route.test.js
git commit -m "$(cat <<'EOF'
Add Telegram webhook route

POST /api/telegram/webhook validates the request against
TELEGRAM_WEBHOOK_SECRET and TELEGRAM_GROUP_CHAT_ID, parses the
message via Claude, and inserts matched expenses using the shared
insertExpense() service. Casual chat is ignored; USD-denominated and
unparseable messages get a reply asking the sender to rephrase.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Manual deployment steps (not part of the automated task list)

These happen once, deliberately, when ready to go live — they are not something a subagent should run unattended, since they touch production data and external services.

1. **Run the migration against PROD:** `npx cross-env ENV=PROD node scripts/add-telegram-columns.js` — additive `ADD COLUMN IF NOT EXISTS`, safe to run once.
2. **Add the real secrets to `.env`** (already gitignored): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (any random string you generate), `TELEGRAM_GROUP_CHAT_ID`, `ANTHROPIC_API_KEY`.
3. **Create the bot** via `@BotFather`, run `/setprivacy` → Disable (so the bot receives every group message, not just ones that mention it), add it to the family Telegram group.
4. **Find the group's chat ID** (e.g. via `@getidsbot`) and set it as `TELEGRAM_GROUP_CHAT_ID`.
5. **Deploy/restart** the dashboard with the new env vars.
6. **Register the webhook** with Telegram (one-time call):
   ```bash
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -d "url=https://<your-dashboard-domain>/api/telegram/webhook" \
     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
   ```
7. **Send a test message** in the group (e.g. "50000 diesel for truck") and confirm the bot replies and the expense shows up on the dashboard's Expenses page.
