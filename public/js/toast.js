import { getEl } from './utils.js';

export function showToast(message, type = 'success') {
  let toast = getEl('appToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.setAttribute('role', 'status');
    // Anchored to the top of the screen, not center -- a centered toast used
    // to sit directly over the numpad/pay button a cashier was mid-tap on,
    // which read as "blocking" the UI even though pointer-events:none meant
    // clicks always passed through underneath it. pointer-events:none is
    // kept anyway as a defensive belt-and-suspenders (z-index this high
    // would otherwise eat clicks meant for whatever's underneath, e.g. a
    // payment modal's "Confirm" button, for as long as it stays visible).
    toast.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9999;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:var(--shadow-lift);transition:opacity .3s;background:var(--bg-surface);color:var(--text-primary);border:1px solid var(--border);max-width:min(420px,calc(100vw - 32px));text-align:center;pointer-events:none';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.borderLeft = `3px solid ${type === 'error' ? 'var(--loss)' : 'var(--gain)'}`;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, type === 'error' ? 8000 : 3500);
}
