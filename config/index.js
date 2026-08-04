require('dotenv').config();

module.exports = {
  port:                  process.env.PORT || process.env.DASHBOARD_PORT || 3000,
  jwtSecret:             process.env.JWT_SECRET || process.env.JWT_SECRET_UAT || process.env.JWT_SECRET_PROD || 'pos_dashboard_secret_change_in_prod',
  jwtExpires:            '24h',
  // Separate secret for POS/KDS terminal tokens -- must never be the same as
  // jwtSecret, so a leaked terminal token can't be replayed against dashboard
  // routes (and vice versa).
  jwtSecretTerminal:     process.env.JWT_SECRET_TERMINAL || 'pos_terminal_secret_change_in_prod',
  // Short-lived session JWT, silently re-minted from the long-lived device
  // token (see terminal_devices / routes/terminalAuth.js) -- staff never see
  // this expire because /api/terminal/session/refresh re-mints it first.
  jwtExpiresSession:     '12h',
  deviceTokenDays:       90,
  // How long a terminal can sit idle before the lock overlay covers it --
  // a person check, not a device check (Section 6 of the terminal-auth
  // redesign). Same for both terminal types.
  idleTimeoutMinutes:    { pos: 30, kds: 30 },
  // How long a POS order-edit lock (pos_orders.locked_by_terminal_id) survives
  // without a heartbeat before another terminal may claim it. Tunable in case
  // 60s proves too short/long once this is used in real service -- too short
  // and a terminal with a slow connection loses its own lock mid-edit; too
  // long and a terminal that genuinely dropped offline strands the order.
  posOrderLockTtlSeconds: Number(process.env.POS_ORDER_LOCK_TTL_SECONDS) || 60,
  isProd:                (process.env.ENV || 'UAT') === 'PROD',
  tz:                    'Asia/Phnom_Penh',
  env:                   process.env.ENV || 'UAT',
  loyverseToken:         process.env.LOYVERSE_TOKEN,
  telegramBotToken:      process.env.TELEGRAM_BOT_TOKEN,
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  telegramGroupChatId:   process.env.TELEGRAM_GROUP_CHAT_ID,
  anthropicApiKey:       process.env.ANTHROPIC_API_KEY,
};
