const REQUIRED_TELEGRAM_VARS = {
  telegramBotToken:      'TELEGRAM_BOT_TOKEN',
  telegramWebhookSecret: 'TELEGRAM_WEBHOOK_SECRET',
  telegramGroupChatId:   'TELEGRAM_GROUP_CHAT_ID',
  anthropicApiKey:       'ANTHROPIC_API_KEY',
};

function missingTelegramConfig(config) {
  return Object.entries(REQUIRED_TELEGRAM_VARS)
    .filter(([configKey]) => !config[configKey])
    .map(([, envName]) => envName);
}

function warnIfTelegramConfigMissing(config) {
  const missing = missingTelegramConfig(config);
  if (missing.length > 0) {
    console.warn(`⚠️  Telegram bot is not fully configured — missing env var(s): ${missing.join(', ')}. The /api/telegram/webhook route will silently reject every request until these are set.`);
  }
  return missing;
}

module.exports = { missingTelegramConfig, warnIfTelegramConfigMissing };
