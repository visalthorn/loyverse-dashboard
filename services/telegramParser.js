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
- "unclear": the message or photo might be an expense but the AMOUNT or WHAT IT WAS FOR is too ambiguous to extract confidently (e.g. a blurry or unreadable photo). Judge this on the amounts and descriptions only — never answer "unclear" because of anything to do with the date. If you can read the amounts, answer "expense", however odd, old, missing or self-contradictory the dates look.

Also check whether the message explicitly states when the expense happened (a specific day, "yesterday", "last Monday", a date like "July 1" or "01/07", or a date printed on a receipt). Dates are often written in Khmer, sometimes with Khmer numerals (០១២៣៤៥៦៧៨៩): "ម្សិលមិញ" = yesterday, "ថ្ងៃទី5" or "ទី៥" = the 5th day of the month. A bare day of the month like "ទី៨" or "ចំណាយទី៨" ("expense of the 8th") IS a stated date: resolve it to the most recent 8th on or before the reference date (usually the current month, or the previous month if the day number is after the reference day). If a date is stated, resolve it to an absolute date in YYYY-MM-DD format and set "date" to that value — use the reference date given with the message to resolve relative terms and to fill in an unstated year and month. If nothing states when the expense happened, set "date" to null.

When several dates appear in one message, pick ONE for the whole message using this order of precedence:
1. A date that heads the message or stands on its own line applies to every item below it and always wins. In "ចំណាយថ្ងៃទី 5/8/2025" followed by a list of items, the expense date is 5 August 2025 for all of them.
2. A day number written inside an item's own description — "អយស្ទ័ថ្ងៃទី4", "ខ្ទឹមទី៨" — is part of that item's label, not a competing date. Keep it in that item's "remark" and do not let it override a message-level date.
3. Only when no message-level date exists does a day number inside a single-item message set the date.
Never report the message as unclear because two dates disagree — apply this order and move on.

Rules about the reference date — follow these exactly, they matter more than anything you believe about what today's date is:
- The reference date given with the message is authoritative. Never substitute your own idea of the current year, month, or day. Your training data is older than the reference date; trust the reference date, not your instincts.
- When the message spells a year out in full (e.g. "5/8/2025"), use that year exactly as written, even if it is long before the reference date. Someone downstream confirms old dates, so report what the message says rather than second-guessing it.
- When no year is written, the year of "date" MUST be the year of the reference date, or the year before it when the day and month fall after the reference date within that year.
- "date" must never be later than the reference date. An expense that has already been paid cannot happen in the future.
- Where no year is stated, these messages report recent spending, so "date" is almost always the reference date itself or within the few days before it. If a date with no stated year lands more than a month before the reference date, you have probably used the wrong year — correct the year, but still answer "expense".

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
    max_tokens: 1024,
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
    // Sonnet 5 (not Haiku): receipts are often handwritten/messy, and Haiku's
    // vision isn't high-resolution — it was misreading handwritten amounts.
    model: 'claude-sonnet-5',
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
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
