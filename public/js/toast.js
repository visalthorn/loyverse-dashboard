import { getEl } from './utils.js';

export function showToast(message, type = 'success') {
  let toast = getEl('appToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.setAttribute('role', 'status');
    // pointer-events:none is load-bearing, not cosmetic -- the toast is
    // centered at the same spot modal dialogs put their buttons, and with a
    // z-index this high it would otherwise sit on top of them and silently
    // eat clicks meant for whatever's underneath (e.g. a payment modal's
    // "Confirm" button) for as long as the toast stays visible.
    toast.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:var(--shadow-lift);transition:opacity .3s;background:var(--bg-surface);color:var(--text-primary);border:1px solid var(--border);max-width:min(420px,calc(100vw - 32px));text-align:center;pointer-events:none';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.borderLeft = `3px solid ${type === 'error' ? 'var(--loss)' : 'var(--gain)'}`;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, type === 'error' ? 8000 : 3500);
}
