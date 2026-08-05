import { showToast } from './toast.js';

const BRIDGE_URL_KEY = 'pos_print_bridge_url';

export function getBridgeUrl() {
  return (localStorage.getItem(BRIDGE_URL_KEY) || '').trim();
}

export function setBridgeUrl(url) {
  const trimmed = (url || '').trim();
  if (trimmed) localStorage.setItem(BRIDGE_URL_KEY, trimmed);
  else localStorage.removeItem(BRIDGE_URL_KEY);
}

function khr(n) {
  const num = Number(n) || 0;
  return '៛' + num.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

// order.created_at/paid_at hold the same Cambodia-local wall-clock value in
// two different shapes depending on where the order object came from: a
// plain "YYYY-MM-DD HH:mm:ss" string when it's the in-memory object right
// after an INSERT/UPDATE response, or an ISO string like
// "YYYY-MM-DDTHH:mm:ss.sssZ" when it round-tripped through pg's TIMESTAMP ->
// JS Date -> JSON.stringify() (e.g. after a GET /receipts fetch for
// reprint) -- pg has no timezone info to apply to a "timestamp without time
// zone" column, so the Date object just carries the original local digits
// relabeled as UTC. Either way the first 16 characters after normalizing
// the separator are the real Cambodia-local date/time -- no actual
// timezone math needed or wanted here.
function cambodiaDatetime(ts) {
  return String(ts || '').replace('T', ' ').slice(0, 16);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function printHTML(html) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();
  iframe.onload = () => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => iframe.remove(), 1500);
  };
}

const RECEIPT_STYLE = `
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; }
  body { width: 72mm; margin: 0 auto; padding: 4mm 3mm; font-family: 'Noto Sans Khmer', 'Courier New', monospace; font-size: 12px; color: #000; }
  .center { text-align: center; }
  .bold { font-weight: 700; }
  .hr { border-top: 1px dashed #000; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .note { padding-left: 10px; font-style: italic; font-size: 11px; }
  .grand { font-size: 16px; font-weight: 800; }
`;

const PAY_METHOD_LABELS = { cash: 'Cash', khqr: 'QR', both: 'Cash + QR' };

// order.provisional_number carries the terminal-prefixed offline number
// (e.g. PP-POS-01-OFF-0007, see offlineQueue.js's nextLocalOrderNumber())
// whether it's still the client-side stand-in or a since-synced order that
// happened to originate offline -- falls back to order_number/order.id if
// somehow absent so a ticket never prints blank.
function offlineBannerHTML() {
  return `<div class="offline-banner">⚠ OFFLINE TICKET — provisional</div>`;
}

export function receiptHTML(order, opts = {}) {
  const itemRows = (order.items || []).map(it => `
    <div class="row"><span>${it.quantity} × ${esc(it.item_name)}</span><span>${khr(it.price * it.quantity)}</span></div>
    ${it.note ? `<div class="note">${esc(it.note)}</div>` : ''}
  `).join('');

  let changeRows = '';
  if (order.payment_method === 'cash' && order.cash_received != null) {
    changeRows = `<div class="row"><span>Cash received</span><span>${khr(order.cash_received)}</span></div>
       <div class="row"><span>Change</span><span>${khr(Number(order.cash_received) - Number(order.total))}</span></div>`;
  } else if (order.payment_method === 'both' && order.cash_received != null) {
    changeRows = `<div class="row"><span>Cash</span><span>${khr(order.cash_received)}</span></div>
       <div class="row"><span>QR</span><span>${khr(Number(order.total) - Number(order.cash_received))}</span></div>`;
  }

  const offline = !!(opts.offline || order._queued);
  const displayNumber = offline ? (order.provisional_number || order.order_number) : order.order_number;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${RECEIPT_STYLE}
    .offline-banner { text-align:center; font-weight:800; font-size:13px; border:2px dashed #000; padding:3px 0; margin-bottom:6px; }
  </style></head><body>
    ${offline ? offlineBannerHTML() : ''}
    <div class="center bold" style="font-size:16px;">CHAB MOUTH</div>
    <div class="center" style="font-size:13px;">ចាប់មាត់</div>
    <div class="hr"></div>
    <div class="row"><span>${esc(displayNumber)}</span><span>${cambodiaDatetime(order.paid_at || order.created_at)}</span></div>
    <div>${order.table_number ? 'Table ' + esc(order.table_number) : esc(order.dining_option)}</div>
    <div class="hr"></div>
    ${itemRows}
    <div class="hr"></div>
    <div class="row"><span>Subtotal</span><span>${khr(order.subtotal)}</span></div>
    ${Number(order.discount) > 0 ? `<div class="row"><span>Discount</span><span>-${khr(order.discount)}</span></div>` : ''}
    <div class="row grand"><span>TOTAL</span><span>${khr(order.total)}</span></div>
    <div class="hr"></div>
    <div class="row"><span>Payment</span><span>${esc(PAY_METHOD_LABELS[order.payment_method] || order.payment_method || '')}</span></div>
    ${changeRows}
    <div class="hr"></div>
    <div class="center" style="margin-top:8px;">សូមអរគុណ / Thank you</div>
  </body></html>`;
}

function kitchenTicketHTML(order, opts = {}) {
  const itemRows = (order.items || []).map(it => `
    <div class="kitem">
      <div class="kqty">${it.quantity}×</div>
      <div class="kname">${esc(it.item_name)}${it.note ? `<div class="knote">${esc(it.note)}</div>` : ''}</div>
    </div>
  `).join('');

  const offline = !!(opts.offline || order._queued);
  const displayNumber = offline ? (order.provisional_number || order.order_number) : order.order_number;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: 80mm auto; margin: 0; }
    body { width: 72mm; margin: 0 auto; padding: 4mm 3mm; font-family: 'Noto Sans Khmer','Courier New',monospace; color: #000; }
    .center { text-align: center; }
    .hr { border-top: 2px dashed #000; margin: 6px 0; }
    .offline-banner { text-align:center; font-weight:800; font-size:15px; border:2px dashed #000; padding:4px 0; margin-bottom:6px; }
    .korder { font-size: 26px; font-weight: 800; text-align: center; }
    .kmeta { font-size: 14px; text-align: center; margin-top: 2px; }
    .kitem { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px dashed #000; }
    .kqty { font-size: 22px; font-weight: 800; min-width: 36px; }
    .kname { font-size: 20px; font-weight: 700; }
    .knote { font-size: 14px; font-style: italic; font-weight: 400; }
  </style></head><body>
    ${offline ? offlineBannerHTML() : ''}
    <div class="korder">${esc(displayNumber)}</div>
    <div class="kmeta">${order.table_number ? 'Table ' + esc(order.table_number) : esc(order.dining_option)} · ${cambodiaDatetime(order.created_at)}</div>
    <div class="hr"></div>
    ${itemRows}
  </body></html>`;
}

async function sendToBridge(type, order, opts = {}) {
  const url = getBridgeUrl();
  try {
    const r = await fetch(url.replace(/\/$/, '') + '/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, order, offline: !!(opts.offline || order._queued) }),
    });
    if (!r.ok) throw new Error('Bridge responded ' + r.status);
  } catch (err) {
    console.error('Print bridge error:', err);
    // Printing must never block the order flow — surface a toast and let
    // the cashier hit Reprint once the printer/bridge issue is resolved.
    showToast('Print failed — check printer/bridge, then Reprint.', 'error');
  }
}

export function printReceipt(order, opts = {}) {
  if (getBridgeUrl()) { sendToBridge('receipt', order, opts); return; }
  printHTML(receiptHTML(order, opts));
}

export function printKitchenTicket(order, opts = {}) {
  if (getBridgeUrl()) { sendToBridge('kitchen', order, opts); return; }
  printHTML(kitchenTicketHTML(order, opts));
}
