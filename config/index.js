require('dotenv').config();

module.exports = {
  port:                  process.env.PORT || process.env.DASHBOARD_PORT || 3000,
  jwtSecret:             process.env.JWT_SECRET || process.env.JWT_SECRET_UAT || process.env.JWT_SECRET_PROD || 'pos_dashboard_secret_change_in_prod',
  jwtExpires:            '24h',
  tz:                    'Asia/Phnom_Penh',
  env:                   process.env.ENV || 'UAT',
  loyverseToken:         process.env.LOYVERSE_TOKEN,
  telegramBotToken:      process.env.TELEGRAM_BOT_TOKEN,
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  telegramGroupChatId:   process.env.TELEGRAM_GROUP_CHAT_ID,
  anthropicApiKey:       process.env.ANTHROPIC_API_KEY,
};
