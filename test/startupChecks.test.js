const { test } = require('node:test');
const assert = require('node:assert/strict');
const { missingTelegramConfig, warnIfTelegramConfigMissing } = require('../utils/startupChecks');

test('missingTelegramConfig returns nothing when all values are set', () => {
  const config = {
    telegramBotToken: 'x',
    telegramWebhookSecret: 'y',
    telegramGroupChatId: '-100123',
    anthropicApiKey: 'z',
  };
  assert.deepEqual(missingTelegramConfig(config), []);
});

test('missingTelegramConfig lists the env var names that are unset', () => {
  const config = {
    telegramBotToken: 'x',
    telegramWebhookSecret: undefined,
    telegramGroupChatId: '-100123',
    anthropicApiKey: undefined,
  };
  assert.deepEqual(missingTelegramConfig(config), ['TELEGRAM_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY']);
});

test('warnIfTelegramConfigMissing warns loudly and returns the missing list', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  const config = { telegramBotToken: undefined, telegramWebhookSecret: 'y', telegramGroupChatId: '-100123', anthropicApiKey: 'z' };
  const missing = warnIfTelegramConfigMissing(config);

  console.warn = originalWarn;

  assert.deepEqual(missing, ['TELEGRAM_BOT_TOKEN']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /TELEGRAM_BOT_TOKEN/);
});

test('warnIfTelegramConfigMissing does not warn when everything is set', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  const config = { telegramBotToken: 'x', telegramWebhookSecret: 'y', telegramGroupChatId: '-100123', anthropicApiKey: 'z' };
  warnIfTelegramConfigMissing(config);

  console.warn = originalWarn;

  assert.equal(warnings.length, 0);
});
