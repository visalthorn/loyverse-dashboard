require('dotenv').config();

const net     = require('net');
const express = require('express');
const { buildReceipt, buildKitchenTicket } = require('./escpos');

const app = express();
app.use(express.json({ limit: '256kb' }));

// The POS browser page and this bridge run on different ports on the same
// LAN — no cookies/credentials involved, so a permissive CORS header is
// enough (this process only ever talks to the printer, never the internet).
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const PORT        = process.env.PORT || 9977;
const PRINTER_IP   = process.env.PRINTER_IP;
const PRINTER_PORT = Number(process.env.PRINTER_PORT) || 9100;

app.post('/print', (req, res) => {
  const { type, order } = req.body || {};
  if (!order) return res.status(400).json({ message: 'order is required.' });
  if (!PRINTER_IP) return res.status(500).json({ message: 'PRINTER_IP not configured — copy .env.example to .env.' });

  let bytes;
  try {
    bytes = type === 'kitchen' ? buildKitchenTicket(order) : buildReceipt(order);
  } catch (err) {
    return res.status(400).json({ message: 'Failed to build print job: ' + err.message });
  }

  let responded = false;
  const respond = (status, body) => {
    if (responded) return;
    responded = true;
    res.status(status).json(body);
  };

  const socket = net.createConnection({ host: PRINTER_IP, port: PRINTER_PORT }, () => {
    socket.write(bytes, () => socket.end());
  });
  socket.setTimeout(5000);
  socket.on('timeout', () => { socket.destroy(); respond(504, { message: 'Printer connection timed out.' }); });
  socket.on('error', (err) => respond(502, { message: 'Printer error: ' + err.message }));
  socket.on('close', () => respond(200, { ok: true }));
});

app.listen(PORT, () => {
  console.log(`\nPOS print bridge listening on :${PORT}`);
  console.log(`Forwarding print jobs to ${PRINTER_IP || '(PRINTER_IP not set — see .env.example)'}:${PRINTER_PORT}\n`);
});
