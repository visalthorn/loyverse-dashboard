# Telegram Expense Bot — Design

## Goal

The business is co-run by two sisters: one in Phnom Penh (dashboard owner), one as GM at the Poipet branch where the business actually operates. Today the Poipet GM reports expenses to her sister by message, who then manually types them into the dashboard. The GM has not adopted the dashboard directly — a Telegram bot is a lower-friction way to get expenses into the system, since Telegram is already how the family communicates day to day. This also lays groundwork for adding more branches later, each with their own expense-reporting flow.

Scope: **expense capture via Telegram only.** No bot-side editing/deleting, no other operational features (reports, staff, receipts) via Telegram in this iteration.

## Architecture

Integrated into the existing Express app — no new process or deployment. The dashboard is already public over HTTPS, so Telegram's webhook can call it directly.

- `routes/telegram.js` — `POST /api/telegram/webhook`. Validates the `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` and that the update's chat ID matches `TELEGRAM_GROUP_CHAT_ID`. Anything else is silently ignored (no reply, logged server-side).
- `services/telegramParser.js` — sends the message text to the Claude API (model: `claude-haiku-4-5` — a classification/extraction task like this doesn't need a larger model, and Haiku's pricing keeps this bot's running cost negligible at low message volume) and gets back structured JSON: either "not an expense" (casual chat), one or more `{ amount, remark }` items (KHR assumed), "usd_detected" (message appears to be in USD), or "unclear" (needs clarification).
- `services/expenses.js` — the expense-insert logic currently inline in `routes/expenses.js`'s `POST /` handler is extracted into a shared `insertExpense()` function, used by both the dashboard form and the Telegram path, so there's one source of truth for the insert.
- `services/telegramBot.js` — thin wrapper around the Telegram Bot API (`axios`, matching the existing `services/loyverse.js` pattern) for sending reply messages.

New env vars (wired through `config/index.js`, following the existing `loyverseToken` pattern):

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_GROUP_CHAT_ID=
ANTHROPIC_API_KEY=
```

## Data flow

1. GM posts a message in the family Telegram group, e.g. "50000 diesel for truck".
2. Telegram POSTs the update to the webhook.
3. Route validates the secret token and chat whitelist; extracts message text, sender display name, and Telegram message ID.
4. `telegramParser` calls the Claude API and returns one of:
   - **not an expense** → ignored, no reply (keeps the bot quiet during normal family chat).
   - **one or more expense items** (amount assumed to be KHR) → each inserted via `insertExpense()` with `expense_by` = sender's Telegram display name, `source = 'telegram'`.
   - **USD detected** → bot does not insert anything; replies asking her to resend the amount in Riel instead (e.g. "Please send the amount in Riel (៛), not USD.").
   - **unclear** → bot replies asking her to rephrase (e.g. "Could you say the amount and what it was for, like '50000 diesel'?").
5. On successful insert, bot replies with a confirmation including the resolved expense date, one line per item if multiple: `✅ Logged: ៛50,000 – diesel for truck (2026-07-04)`.
6. A message with several expenses ("50000 diesel, 20000 lunch") is parsed into multiple items in one Claude call and logged in one batch, with one combined confirmation reply.

## Expense date resolution

The GM sometimes reports an expense somewhere else first (e.g. voice note to her sister) and the message only reaches the Telegram group later, forwarded by whoever received it first. In that case the date the message *arrives* in the group is not the date the expense happened. Resolution order, most authoritative first:

1. **Explicit date in the message text** — if the message states when the expense happened ("yesterday", "last Monday", "July 1"), `telegramParser` resolves it to an absolute `YYYY-MM-DD` date. To resolve relative phrasing and bare day/month mentions, the parser is given a reference date (see step 2) as context for "what day is this relative to / what year is implied."
2. **Forwarded message → the forward's original date.** If Telegram marks the message as forwarded, its original send date (from Telegram's forward metadata, not the time it landed in the group) is used as the reference date, and as the expense date if step 1 finds nothing.
3. **A fresh, non-forwarded message with no date mentioned → today.** The message's own arrival date (Cambodia time) is used, matching the original design.

`telegramParser.parseExpenseMessage()` returns an additional `date` field (`YYYY-MM-DD` or `null`) alongside `type`/`items`. The route computes the reference date (forward date if forwarded, else today) before calling the parser, and the final `expense_date` used for the insert is `parsed.date ?? referenceDate`.

## Currency handling

- The system stores a single currency: KHR. No currency column, no conversion, no exchange rate config.
- The parser detects when a message appears to be denominated in USD (`$`, "USD", "dollar", "ដុល្លារ", etc.) and, in that case, does **not** insert anything — it replies asking the sender to resend the amount in Riel. She does the conversion herself before resubmitting.
- This keeps `expenses.amount` exactly as it is today (KHR, no ambiguity) and requires no changes to existing totals/analytics queries.

## Schema changes

Additive, non-breaking `ALTER TABLE expenses`:

| column | type | default | purpose |
|---|---|---|---|
| `source` | `varchar(20)` | `'dashboard'` | `'dashboard'` or `'telegram'`, for traceability |
| `telegram_message_id` | `bigint`, nullable, unique | `NULL` | dedupe key if Telegram retries a webhook delivery |

## Error handling

- **Duplicate webhook delivery** (Telegram retries on timeout): unique constraint on `telegram_message_id` + `ON CONFLICT DO NOTHING`, same pattern as the existing Loyverse receipt sync.
- **Claude API failure/timeout**: reply "Having trouble right now, please try again in a bit"; error logged server-side; message is not silently dropped from the user's perspective, but is not retried automatically.
- **Message from an unrecognized chat**: ignored and logged; no reply sent (avoids the bot being usable from outside the whitelisted group).
- **Edits/deletes**: dashboard-only for this iteration — no bot-side edit commands. If a logged expense is wrong, it's fixed the same way manual entries are fixed today.

## Testing

- Unit tests for `telegramParser` against a fixed set of sample messages: a clean single expense, a multi-item message, casual chat, an ambiguous message, USD-denominated wording (should trigger the "resend in Riel" reply, not an insert), and a message with an explicit date mention.
- Unit tests for the date-resolution priority: explicit parsed date wins over everything; a forwarded message with no explicit date falls back to the forward's original date; a fresh non-forwarded message with no explicit date falls back to today.
- Manual webhook test plan using a private Telegram test group before pointing the bot at the real family group: verify insert correctness, verify casual chat is ignored, verify a duplicate delivery no-ops instead of double-inserting, verify USD wording is rejected with the correct prompt, verify a forwarded message logs under the original date rather than today.

## Out of scope (for this iteration)

- Bot-side editing or deleting of logged expenses.
- Multi-branch chat routing (one group ↔ one branch mapping). Today there is only one branch (Poipet); this can be added later by introducing a `branch` column and mapping `TELEGRAM_GROUP_CHAT_ID` to a branch, without disrupting this design.
- Receipt/photo OCR capture.
- Any Telegram-based reporting, staff, or receipts functionality.
