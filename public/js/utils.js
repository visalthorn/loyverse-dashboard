export const TZ = 'Asia/Phnom_Penh';

export function getEl(id) { return document.getElementById(id); }

export function setText(id, value) {
  const el = getEl(id);
  if (el) el.textContent = value;
  return el;
}

export function setHTML(id, value) {
  const el = getEl(id);
  if (el) el.innerHTML = value;
  return el;
}

// Today's date (YYYY-MM-DD) in Cambodia time — never the browser's zone.
export function getTodayDate() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });
}

export function fmt(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '0';
  return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function fmtRaw(value, decimals = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Currency — the only place ៛/$ prefixes are produced.
// Static display rate; mirrors USD_TO_KHR_RATE on the backend (routes/telegram.js).
export const USD_RATE = 4000;

export function getCurrency() {
  return localStorage.getItem('pos_currency') === 'USD' ? 'USD' : 'KHR';
}

// Formats a KHR-stored amount in the user's display currency: ៛ as-is,
// or converted to $ at the static rate. Display-only — stored data stays KHR.
export function fmtKHR(n, decimals = 0) {
  if (getCurrency() === 'USD') return fmtUSD(Number(n) / USD_RATE);
  return '៛' + fmtRaw(n, decimals);
}

// Literal dollars (e.g. staff salaries stored in USD) — never re-converted.
export function fmtUSD(n, decimals = 2) {
  return '$' + fmtRaw(n, decimals);
}

// All dates/times render in Cambodia time (UTC+7), regardless of client zone.
export function fmtDate(iso, period) {
  const d = new Date(iso);
  if (period === 'monthly') return d.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', year: '2-digit' });
  return d.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
}

export function fmtDatetime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function downloadCSV(filename, rows) {
  const csv = rows.map(r => r.map(cell => {
    const s = String(cell ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
