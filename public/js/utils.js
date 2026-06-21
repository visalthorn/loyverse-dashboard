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

export function getTodayDate() {
  return new Date().toISOString().split('T')[0];
}

export function fmt(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '0';
  if (num >= 1_000_000) return (num / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M';
  if (num >= 1_000)     return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function fmtRaw(value, decimals = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtDate(iso, period) {
  const d = new Date(iso);
  if (period === 'monthly') return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
  if (period === 'weekly')  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtDatetime(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
