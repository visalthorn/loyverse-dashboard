// Minimal ESC/POS command builder for 80mm thermal receipt/kitchen printers.

const ESC = 0x1B;
const GS  = 0x1D;

const CMD = {
  init:        Buffer.from([ESC, 0x40]),
  alignLeft:   Buffer.from([ESC, 0x61, 0x00]),
  alignCenter: Buffer.from([ESC, 0x61, 0x01]),
  boldOn:      Buffer.from([ESC, 0x45, 0x01]),
  boldOff:     Buffer.from([ESC, 0x45, 0x00]),
  doubleOn:    Buffer.from([GS, 0x21, 0x11]), // double width + height
  doubleOff:   Buffer.from([GS, 0x21, 0x00]),
  cut:         Buffer.from([GS, 0x56, 0x42, 0x00]), // feed + partial cut
};

function feed(n = 1) {
  return Buffer.from([ESC, 0x64, n]);
}

function line(text = '') {
  return Buffer.from(text + '\n', 'ascii');
}

// ── Khmer → Latin transliteration ───────────────────────────────────────
//
// Standard ESC/POS codepages (CP437/CP1252/etc.) used by cheap thermal
// printers have no Khmer glyphs at all, so Khmer text must be turned into
// Latin letters before it reaches the printer. This is a naive,
// character-by-character best-effort romanization — it ignores subscript
// consonant stacking (coeng) and register-dependent vowel pronunciation,
// so multi-syllable words come out only loosely phonetic. That's fine for
// short shop/menu names on a receipt; if exact fidelity is ever needed,
// either extend this map or switch to bitmap/image printing of the
// original Khmer text instead of raw ESC/POS text.
const KHMER_MAP = {
  // consonants
  'ក': 'k', 'ខ': 'kh', 'គ': 'k', 'ឃ': 'kh', 'ង': 'ng',
  'ច': 'ch', 'ឆ': 'chh', 'ជ': 'j', 'ឈ': 'chh', 'ញ': 'nh',
  'ដ': 'd', 'ឋ': 'th', 'ឌ': 'd', 'ឍ': 'th', 'ណ': 'n',
  'ត': 't', 'ថ': 'th', 'ទ': 't', 'ធ': 'th', 'ន': 'n',
  'ប': 'b', 'ផ': 'ph', 'ព': 'p', 'ភ': 'ph', 'ម': 'm',
  'យ': 'y', 'រ': 'r', 'ល': 'l', 'វ': 'v', 'ស': 's',
  'ហ': 'h', 'ឡ': 'l', 'អ': 'a',
  // independent vowels
  'ឥ': 'i', 'ឦ': 'ei', 'ឧ': 'u', 'ឩ': 'u', 'ឪ': 'ou',
  'ឫ': 'rue', 'ឬ': 'rue', 'ឭ': 'lue', 'ឮ': 'lue',
  'ឯ': 'ae', 'ឰ': 'ai', 'ឱ': 'o', 'ឲ': 'o', 'ឳ': 'au',
  // dependent vowel signs
  'ា': 'a', 'ិ': 'i', 'ី': 'ei', 'ឹ': 'oe', 'ឺ': 'eu',
  'ុ': 'u', 'ូ': 'ou', 'ួ': 'ua', 'ើ': 'aeu', 'ឿ': 'ie',
  'ៀ': 'ie', 'េ': 'e', 'ែ': 'ae', 'ៃ': 'ai', 'ោ': 'ao', 'ៅ': 'au',
  // signs / diacritics
  'ំ': 'm', 'ះ': 'h',
  '៉': '', '៊': '', '់': '', '៌': '', '៍': '', '៎': '', '៏': '', '័': '', '្': '',
  // digits
  '០': '0', '១': '1', '២': '2', '៣': '3', '៤': '4',
  '៥': '5', '៦': '6', '៧': '7', '៨': '8', '៩': '9',
};

function toLatin(str) {
  if (!str) return '';
  let out = '';
  for (const ch of String(str)) {
    if (ch.charCodeAt(0) < 128) { out += ch; continue; }         // ASCII passthrough
    if (KHMER_MAP[ch] !== undefined) { out += KHMER_MAP[ch]; continue; }
    // Unmapped non-ASCII (rare Khmer symbols, other scripts) — drop silently
    // rather than emitting mojibake the printer can't render anyway.
  }
  return out;
}

function khr(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' KHR';
}

function cambodiaDatetime(ts) {
  return String(ts || '').slice(0, 16).replace('T', ' ');
}

function padCols(left, right, width = 32) {
  const gap = Math.max(1, width - left.length - right.length);
  return left + ' '.repeat(gap) + right;
}

const PAY_METHOD_LABELS = { cash: 'Cash', khqr: 'QR', both: 'Cash + QR' };

function buildReceipt(order) {
  const parts = [
    CMD.init, CMD.alignCenter,
    CMD.boldOn, CMD.doubleOn, line('CHAB MOUTH'), CMD.doubleOff,
    line(toLatin('ចាប់មាត់')), CMD.boldOff,
    line('--------------------------------'),
    CMD.alignLeft,
    line(padCols(order.order_number, cambodiaDatetime(order.paid_at || order.created_at))),
    line(order.table_number ? `Table ${order.table_number}` : toLatin(order.dining_option || '')),
    line('--------------------------------'),
  ];

  for (const it of order.items || []) {
    parts.push(line(padCols(`${it.quantity} x ${toLatin(it.item_name)}`, khr(it.price * it.quantity))));
    if (it.note) parts.push(line('  ' + toLatin(it.note)));
  }

  parts.push(line('--------------------------------'));
  parts.push(line(padCols('Subtotal', khr(order.subtotal))));
  if (Number(order.discount) > 0) {
    parts.push(line(padCols('Discount', '-' + khr(order.discount))));
  }
  parts.push(CMD.boldOn, CMD.doubleOn, line('TOTAL ' + khr(order.total)), CMD.doubleOff, CMD.boldOff);
  parts.push(line('--------------------------------'));
  parts.push(line('Payment: ' + (PAY_METHOD_LABELS[order.payment_method] || order.payment_method || '')));
  if (order.payment_method === 'cash' && order.cash_received != null) {
    parts.push(line(padCols('Cash received', khr(order.cash_received))));
    parts.push(line(padCols('Change', khr(Number(order.cash_received) - Number(order.total)))));
  } else if (order.payment_method === 'both' && order.cash_received != null) {
    parts.push(line(padCols('Cash', khr(order.cash_received))));
    parts.push(line(padCols('QR', khr(Number(order.total) - Number(order.cash_received)))));
  }
  parts.push(CMD.alignCenter, line(''), line(toLatin('សូមអរគុណ') + ' / Thank you'));
  parts.push(feed(3), CMD.cut);

  return Buffer.concat(parts);
}

function buildKitchenTicket(order) {
  const parts = [
    CMD.init, CMD.alignCenter,
    CMD.boldOn, CMD.doubleOn, line(order.order_number), CMD.doubleOff,
    line((order.table_number ? `TABLE ${order.table_number}` : toLatin(order.dining_option || '')) +
         ' - ' + cambodiaDatetime(order.created_at)),
    CMD.boldOff, CMD.alignLeft,
    line('================================'),
  ];

  for (const it of order.items || []) {
    parts.push(CMD.doubleOn, CMD.boldOn, line(`${it.quantity}x ${toLatin(it.item_name)}`), CMD.boldOff, CMD.doubleOff);
    if (it.note) parts.push(line('   >> ' + toLatin(it.note)));
    parts.push(line('--------------------------------'));
  }

  parts.push(feed(4), CMD.cut);
  return Buffer.concat(parts);
}

module.exports = { buildReceipt, buildKitchenTicket, toLatin };
