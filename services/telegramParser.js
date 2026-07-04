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
