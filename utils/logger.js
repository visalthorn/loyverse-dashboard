const path = require('path');
const fs   = require('fs');
const dayjs    = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ         = 'Asia/Phnom_Penh';
const LOG_DIR    = path.join(__dirname, '..', 'logs');
const RETENTION_DAYS   = 7;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day is enough for a 7-day window
const LOG_FILE_RE = /^server-(\d{4}-\d{2}-\d{2})\.log$/;

function formatArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'object' && arg !== null) return JSON.stringify(arg, null, 2);
  return String(arg);
}

function write(...args) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const ts   = dayjs().tz(TZ).format('YYYY-MM-DD HH:mm:ss');
    const date = dayjs().tz(TZ).format('YYYY-MM-DD');
    const line = args.map(formatArg).join(' ');
    fs.appendFileSync(path.join(LOG_DIR, `server-${date}.log`), `[${ts}] ${line}\n`, 'utf8');
  } catch (err) {
    process.stderr.write(`Log write failed: ${err.message}\n`);
  }
}

// Deletes any logs/server-YYYY-MM-DD.log older than RETENTION_DAYS so the
// directory doesn't grow unbounded over a long-running server -- matched by
// filename date, not mtime, so it's correct even if the file's mtime was
// touched by a backup/AV scan after it was written.
function pruneOldLogs() {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const cutoff = dayjs().tz(TZ).subtract(RETENTION_DAYS, 'day').format('YYYY-MM-DD');
    for (const name of fs.readdirSync(LOG_DIR)) {
      const match = LOG_FILE_RE.exec(name);
      if (match && match[1] < cutoff) {
        fs.unlinkSync(path.join(LOG_DIR, name));
      }
    }
  } catch (err) {
    process.stderr.write(`Log prune failed: ${err.message}\n`);
  }
}

function install() {
  const origLog   = console.log.bind(console);
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.log   = (...args) => { origLog(...args);   write(...args); };
  console.warn  = (...args) => { origWarn(...args);  write('WARN', ...args); };
  console.error = (...args) => { origError(...args); write('ERROR', ...args); };

  pruneOldLogs();
  setInterval(pruneOldLogs, PRUNE_INTERVAL_MS).unref();
}

module.exports = { install, pruneOldLogs };
