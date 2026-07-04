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
