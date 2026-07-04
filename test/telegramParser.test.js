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
    date: null,
    items: [{ amount: 50000, remark: 'diesel for truck' }],
  }));
  const result = await parseExpenseMessage('50000 diesel for truck', '2026-07-04', client);
  assert.deepEqual(result, { type: 'expense', date: null, items: [{ amount: 50000, remark: 'diesel for truck' }] });
});

test('parses multiple expenses from one message', async () => {
  const client = fakeClient(JSON.stringify({
    type: 'expense',
    date: null,
    items: [
      { amount: 50000, remark: 'diesel' },
      { amount: 20000, remark: 'lunch' },
    ],
  }));
  const result = await parseExpenseMessage('50000 diesel, 20000 lunch', '2026-07-04', client);
  assert.equal(result.type, 'expense');
  assert.equal(result.items.length, 2);
});

test('classifies casual chat as not_expense', async () => {
  const client = fakeClient(JSON.stringify({ type: 'not_expense', date: null, items: [] }));
  const result = await parseExpenseMessage('good morning everyone', '2026-07-04', client);
  assert.equal(result.type, 'not_expense');
});

test('classifies USD-denominated messages as usd_detected', async () => {
  const client = fakeClient(JSON.stringify({ type: 'usd_detected', date: null, items: [] }));
  const result = await parseExpenseMessage('$20 for parts', '2026-07-04', client);
  assert.equal(result.type, 'usd_detected');
});

test('treats a refusal stop_reason as unclear', async () => {
  const client = { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } };
  const result = await parseExpenseMessage('some message', '2026-07-04', client);
  assert.equal(result.type, 'unclear');
  assert.equal(result.date, null);
});

test('treats malformed JSON as unclear', async () => {
  const client = fakeClient('not valid json{{{');
  const result = await parseExpenseMessage('garbled', '2026-07-04', client);
  assert.equal(result.type, 'unclear');
});

test('treats an expense type with no items as unclear', async () => {
  const client = fakeClient(JSON.stringify({ type: 'expense', date: null, items: [] }));
  const result = await parseExpenseMessage('ambiguous message', '2026-07-04', client);
  assert.equal(result.type, 'unclear');
});

test('extracts an explicit date mentioned in the message', async () => {
  const client = fakeClient(JSON.stringify({
    type: 'expense',
    date: '2026-06-30',
    items: [{ amount: 30000, remark: 'parts, bought last Tuesday' }],
  }));
  const result = await parseExpenseMessage('30000 for parts, bought last Tuesday', '2026-07-04', client);
  assert.equal(result.date, '2026-06-30');
});

test('passes the reference date and message text to the API request', async () => {
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
  await parseExpenseMessage('good morning', '2026-07-04', client);
  const userMessage = receivedParams.messages[0].content;
  assert.match(userMessage, /2026-07-04/);
  assert.match(userMessage, /good morning/);
});
