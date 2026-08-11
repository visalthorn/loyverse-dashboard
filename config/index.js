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
  // WITHOUT CASHIER ACTIVITY before another terminal may claim it.
  //
  // This is an IDLE timeout, not a liveness heartbeat (changed 2026-08-05).
  // It used to be renewed by a blind 15s setInterval in the POS tab, which
  // meant a terminal that merely had an order open -- nobody touching it,
  // cashier walked away, tab left on a back counter -- held that order
  // hostage indefinitely and no other terminal could ever take it. Now only
  // real work on the order renews it: opening it, staging/removing a cart
  // line, editing a note, changing table #/dining option, appending items,
  // cancelling an item, sending to kitchen (see touchLock in routes/pos.js
  // and markOrderActivity in public/js/pos.js). Five minutes of no such
  // activity and the order releases itself -- and the holding terminal
  // clears it off its own screen to match.
  //
  // 300s is the number the floor asked for; keep it comfortably above the
  // 15s Open Orders poll so a lock is never lost between two beats of an
  // actively-used order.
  posOrderLockTtlSeconds: Number(process.env.POS_ORDER_LOCK_TTL_SECONDS) || 300,
  isProd:                (process.env.ENV || 'UAT') === 'PROD',
  tz:                    'Asia/Phnom_Penh',
  env:                   process.env.ENV || 'UAT',
  loyverseToken:         process.env.LOYVERSE_TOKEN,
  telegramBotToken:      process.env.TELEGRAM_BOT_TOKEN,
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  telegramGroupChatId:   process.env.TELEGRAM_GROUP_CHAT_ID,
  // Separate from telegramGroupChatId (the staff-facing expense-bot channel)
  // deliberately -- ops alerts (sync failures, gap reports) shouldn't land
  // in a channel staff use for day-to-day expense recording. Points the
  // scheduler's Telegram alerts (services/sync/alerts.js) at whichever
  // chat/channel an admin wants them in.
  telegramChatId:        process.env.TELEGRAM_CHAT_ID,
  anthropicApiKey:       process.env.ANTHROPIC_API_KEY,
};
