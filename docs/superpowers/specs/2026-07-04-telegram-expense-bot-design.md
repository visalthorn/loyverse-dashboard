# Telegram Expense Bot — Design

## Goal

The business is co-run by two sisters: one in Phnom Penh (dashboard owner), one as GM at the Poipet branch where the business actually operates. Today the Poipet GM reports expenses to her sister by message, who then manually types them into the dashboard. The GM has not adopted the dashboard directly — a Telegram bot is a lower-friction way to get expenses into the system, since Telegram is already how the family communicates day to day. This also lays groundwork for adding more branches later, each with their own expense-reporting flow.

Scope: **expense capture via Telegram only.** No bot-side editing/deleting, no other operational features (reports, staff, receipts) via Telegram in this iteration.

## Architecture

Integrated into the existing Express app — no new process or deployment. The dashboard is already public over HTTPS, so Telegram's webhook can call it directly.

- `routes/telegram.js` — `POST /api/telegram/webhook`. Validates the `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` and that the update's chat ID matches `TELEGRAM_GROUP_CHAT_ID`. Anything else is silently ignored (no reply, logged server-side).
- `services/telegramParser.js` — sends the message text to the Claude API and gets back structured JSON: either "not an expense" (casual chat), one or more `{ amount, currency, remark }` items, or "unclear" (needs clarification).
- `services/expenses.js` — the expense-insert logic currently inline in `routes/expenses.js`'s `POST /` handler is extracted into a shared `insertExpense()` function, used by both the dashboard form and the Telegram path, so there's one source of truth for the insert.
- `services/telegramBot.js` — thin wrapper around the Telegram Bot API (`axios`, matching the existing `services/loyverse.js` pattern) for sending reply messages.

New env vars (wired through `config/index.js`, following the existing `loyverseToken` pattern):

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_GROUP_CHAT_ID=
ANTHROPIC_API_KEY=
USD_TO_KHR_RATE=4000
```

## Data flow

1. GM posts a message in the family Telegram group, e.g. "50000 diesel for truck".
2. Telegram POSTs the update to the webhook.
3. Route validates the secret token and chat whitelist; extracts message text, sender display name, and Telegram message ID.
4. `telegramParser` calls the Claude API and returns one of:
   - **not an expense** → ignored, no reply (keeps the bot quiet during normal family chat).
   - **one or more expense items** → each inserted via `insertExpense()` with `expense_by` = sender's Telegram display name, `source = 'telegram'`.
   - **unclear** → bot replies asking her to rephrase (e.g. "Could you say the amount and what it was for, like '50000 diesel'?").
5. On successful insert, bot replies with a confirmation, one line per item if multiple: `✅ Logged: ៛50,000 – diesel for truck`.
6. A message with several expenses ("50000 diesel, 20000 lunch") is parsed into multiple items in one Claude call and logged in one batch, with one combined confirmation reply.

## Currency handling

- Claude's parser output includes a `currency` field (`KHR` or `USD`) detected from the message wording ($, USD, ដុល្លារ, riel, etc).
- `expenses.currency` stores what was actually said.
- `expenses.amount_khr` stores the amount normalized to Riel: `amount` as-is if `currency = 'KHR'`, or `amount * USD_TO_KHR_RATE` if `currency = 'USD'`, using the fixed rate **1 USD = 4,000 KHR** from `config`.
- All existing totals (expenses list summary, analytics/report aggregates) switch from `SUM(amount)` to `SUM(amount_khr)` so mixed-currency entries still roll up into one correct blended total. Existing rows are backfilled with `currency = 'KHR'`, `amount_khr = amount`.
- The rate is a config value, not hardcoded, so it can be updated later without a schema or code change — but there is no historical rate tracking; changing it only affects future inserts, not past ones.

## Schema changes

Additive, non-breaking `ALTER TABLE expenses`:

| column | type | default | purpose |
|---|---|---|---|
| `currency` | `varchar(3)` | `'KHR'` | currency as stated in the message |
| `amount_khr` | `numeric` | backfilled = `amount` | normalized amount used for all SUM aggregates |
| `source` | `varchar(20)` | `'dashboard'` | `'dashboard'` or `'telegram'`, for traceability |
| `telegram_message_id` | `bigint`, nullable, unique | `NULL` | dedupe key if Telegram retries a webhook delivery |

## Error handling

- **Duplicate webhook delivery** (Telegram retries on timeout): unique constraint on `telegram_message_id` + `ON CONFLICT DO NOTHING`, same pattern as the existing Loyverse receipt sync.
- **Claude API failure/timeout**: reply "Having trouble right now, please try again in a bit"; error logged server-side; message is not silently dropped from the user's perspective, but is not retried automatically.
- **Message from an unrecognized chat**: ignored and logged; no reply sent (avoids the bot being usable from outside the whitelisted group).
- **Edits/deletes**: dashboard-only for this iteration — no bot-side edit commands. If a logged expense is wrong, it's fixed the same way manual entries are fixed today.

## Testing

- Unit tests for `telegramParser` against a fixed set of sample messages: a clean single expense, a multi-item message, casual chat, an ambiguous message, USD-denominated and KHR-denominated wording.
- Manual webhook test plan using a private Telegram test group before pointing the bot at the real family group: verify insert correctness, verify casual chat is ignored, verify a duplicate delivery no-ops instead of double-inserting.
- Verify dashboard/report totals remain correct once mixed-currency rows exist (spot-check `SUM(amount_khr)` against manually computed expected totals).

## Out of scope (for this iteration)

- Bot-side editing or deleting of logged expenses.
- Multi-branch chat routing (one group ↔ one branch mapping). Today there is only one branch (Poipet); this can be added later by introducing a `branch` column and mapping `TELEGRAM_GROUP_CHAT_ID` to a branch, without disrupting this design.
- Receipt/photo OCR capture.
- Any Telegram-based reporting, staff, or receipts functionality.
