require('./utils/logger').install();

const app  = require('./app');
const config = require('./config');
const { port, env } = config;
const { startScheduler } = require('./services/sync');
const { startStockAlertScheduler } = require('./services/stockAlert');
const { warnIfTelegramConfigMissing, warnIfAlertConfigMissing } = require('./utils/startupChecks');

warnIfTelegramConfigMissing(config);
warnIfAlertConfigMissing(config);

app.listen(port, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║  ✅  POS Dashboard is RUNNING           ║`);
  console.log(`╠════════════════════════════════════════╣`);
  console.log(`║  🌐  Open: http://localhost:${port}         ║`);
  console.log(`║  🗄   ENV: ${(env || 'UAT').padEnd(29)}║`);
  console.log(`╚════════════════════════════════════════╝\n`);

  startScheduler();
  startStockAlertScheduler();
});
