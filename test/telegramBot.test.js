const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sendTelegramMessage, downloadTelegramFile } = require('../services/telegramBot');

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

test('downloadTelegramFile resolves the file path then downloads the bytes', async () => {
  const calls = [];
  const fakeHttp = {
    get: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/getFile')) {
        return { data: { result: { file_path: 'photos/file_1.jpg' } } };
      }
      return { data: Buffer.from('fake-image-bytes') };
    },
  };

  const result = await downloadTelegramFile('abc123', fakeHttp);

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/getFile$/);
  assert.deepEqual(calls[0].options.params, { file_id: 'abc123' });
  assert.match(calls[1].url, /\/file\/bot.*\/photos\/file_1\.jpg$/);
  assert.deepEqual(calls[1].options, { responseType: 'arraybuffer' });
  assert.ok(Buffer.isBuffer(result));
  assert.equal(result.toString(), 'fake-image-bytes');
});
