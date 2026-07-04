const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseExpenseMessage, parseExpenseImage } = require('../services/telegramParser');

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

test('parses a single KHR expense', async () => {
  const client = fakeClient(JSON.stringify({
    type: 'expense',
    date: null,
    items: [{ amount: 50000, remark: 'diesel for truck', currency: 'KHR' }],
  }));
  const result = await parseExpenseMessage('50000 diesel for truck', '2026-07-04', client);
  assert.deepEqual(result, { type: 'expense', date: null, items: [{ amount: 50000, remark: 'diesel for truck', currency: 'KHR' }] });
});

test('parses multiple expenses from one message', async () => {
  const client = fakeClient(JSON.stringify({
    type: 'expense',
    date: null,
    items: [
      { amount: 50000, remark: 'diesel', currency: 'KHR' },
      { amount: 20000, remark: 'lunch', currency: 'KHR' },
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

test('tags a USD-denominated item with currency USD instead of rejecting it', async () => {
  const client = fakeClient(JSON.stringify({
    type: 'expense',
    date: null,
    items: [{ amount: 20, remark: 'parts', currency: 'USD' }],
  }));
  const result = await parseExpenseMessage('$20 for parts', '2026-07-04', client);
  assert.equal(result.type, 'expense');
  assert.equal(result.items[0].currency, 'USD');
  assert.equal(result.items[0].amount, 20);
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
    items: [{ amount: 30000, remark: 'parts, bought last Tuesday', currency: 'KHR' }],
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
