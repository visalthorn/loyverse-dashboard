const { test } = require('node:test');
const assert = require('node:assert/strict');

test('config exposes telegram and anthropic env vars', () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret';
  process.env.TELEGRAM_GROUP_CHAT_ID = '-100123456';
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  delete require.cache[require.resolve('../config')];
  const config = require('../config');

  assert.equal(config.telegramBotToken, 'test-bot-token');
  assert.equal(config.telegramWebhookSecret, 'test-webhook-secret');
  assert.equal(config.telegramGroupChatId, '-100123456');
  assert.equal(config.anthropicApiKey, 'test-anthropic-key');
});
