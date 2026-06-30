require('./utils/logger').install();

const cron = require('node-cron');
const app  = require('./app');
const { port, env, tz } = require('./config');
const { syncYesterdayReceipts } = require('./services/sync');

app.listen(port, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║  ✅  POS Dashboard is RUNNING           ║`);
  console.log(`╠════════════════════════════════════════╣`);
  console.log(`║  🌐  Open: http://localhost:${port}         ║`);
  console.log(`║  🗄   ENV: ${(env || 'UAT').padEnd(29)}║`);
  console.log(`╚════════════════════════════════════════╝\n`);

  // Daily auto-sync at 01:00 AM Cambodia time
  cron.schedule('5 0 * * *', () => syncYesterdayReceipts('auto'), {
    scheduled: true,
    timezone: tz,
  });
  console.log(`⏰  Auto-sync scheduled daily at 00:05 AM (${tz})\n`);
});
