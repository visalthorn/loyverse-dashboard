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
