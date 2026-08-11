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

// Sync alerts (services/sync/alerts.js) are optional -- the scheduler runs
// fine without them, they just silently skip sending. This is a softer
// warning than the expense-bot check above, not folded into it, since
// telegramBotToken is shared but telegramChatId is a separate, optional
// destination (see config/index.js).
function warnIfAlertConfigMissing(config) {
  const missing = [];
  if (!config.telegramBotToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.telegramChatId)   missing.push('TELEGRAM_CHAT_ID');
  if (missing.length > 0) {
    console.warn(`⚠️  Sync failure/gap alerts are not configured — missing env var(s): ${missing.join(', ')}. Syncing still works; Telegram alerts will just be skipped (logged to console instead).`);
  }
  return missing;
}

module.exports = { missingTelegramConfig, warnIfTelegramConfigMissing, warnIfAlertConfigMissing };
