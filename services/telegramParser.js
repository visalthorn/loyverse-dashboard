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
