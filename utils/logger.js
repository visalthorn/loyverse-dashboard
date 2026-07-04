const path = require('path');
const fs   = require('fs');
const dayjs    = require('dayjs');
const utc      = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ      = 'Asia/Phnom_Penh';
const LOG_DIR = path.join(__dirname, '..', 'logs');

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

function install() {
  const origLog   = console.log.bind(console);
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.log   = (...args) => { origLog(...args);   write(...args); };
  console.warn  = (...args) => { origWarn(...args);  write('WARN', ...args); };
  console.error = (...args) => { origError(...args); write('ERROR', ...args); };
}

module.exports = { install };
