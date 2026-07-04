const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
const { tz } = require('../config');
const { install } = require('../utils/logger');

const LOG_FILE = path.join(__dirname, '..', 'logs', `server-${dayjs().tz(tz).format('YYYY-MM-DD')}.log`);

test('install() captures console.log, console.warn, and console.error to the log file', () => {
  const originalContent = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : null;

  install();
  const marker = `test-marker-${Date.now()}`;
  console.log(`LOG ${marker}`);
  console.warn(`WARN-CASE ${marker}`);
  console.error(`ERROR-CASE ${marker}`);

  const content = fs.readFileSync(LOG_FILE, 'utf8');
  assert.match(content, new RegExp(`LOG ${marker}`));
  assert.match(content, new RegExp(`WARN.*WARN-CASE ${marker}`));
  assert.match(content, new RegExp(`ERROR.*ERROR-CASE ${marker}`));

  // restore the file to its pre-test state so this test doesn't pollute real logs
  if (originalContent === null) {
    fs.unlinkSync(LOG_FILE);
  } else {
    fs.writeFileSync(LOG_FILE, originalContent);
  }
});
