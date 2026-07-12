import { getEl } from './utils.js';

export function showToast(message, type = 'success') {
  let toast = getEl('appToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.setAttribute('role', 'status');
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:var(--shadow-lift);transition:opacity .3s;background:var(--bg-surface);color:var(--text-primary);border:1px solid var(--border)';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.borderLeft = `3px solid ${type === 'error' ? 'var(--loss)' : 'var(--gain)'}`;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, type === 'error' ? 8000 : 3500);
}
