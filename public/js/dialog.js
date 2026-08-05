import { t } from './i18n.js';

let dlg = null;

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'app-dialog';
  dlg.innerHTML = `
    <div class="app-dialog-card">
      <div class="app-dialog-body">
        <div class="app-dialog-icon" aria-hidden="true"></div>
        <div class="app-dialog-text">
          <h3 class="app-dialog-title"></h3>
          <p class="app-dialog-message"></p>
          <input type="text" class="app-dialog-input" style="display:none" />
        </div>
      </div>
      <div class="app-dialog-actions">
        <button type="button" class="btn-ghost app-dialog-cancel"></button>
        <button type="button" class="btn-accent app-dialog-confirm"></button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  return dlg;
}

function openDialog({ message, title, confirmText, cancelText, danger, showCancel, input }) {
  const d = ensureDialog();
  // A prior invocation's dialog can still be open if this is called again
  // before it resolved (e.g. a second action fired while the first dialog
  // was still up) -- showModal() on an already-open <dialog> throws
  // InvalidStateError, which silently rejects the returned promise with no
  // visible error to the user. Force-close any stale instance first so its
  // pending promise resolves (as cancelled) instead of hanging or throwing.
  if (d.open) d.close('');

  const titleEl   = d.querySelector('.app-dialog-title');
  const msgEl     = d.querySelector('.app-dialog-message');
  const iconEl    = d.querySelector('.app-dialog-icon');
  const inputEl   = d.querySelector('.app-dialog-input');
  const cancelBtn = d.querySelector('.app-dialog-cancel');
  const confirmBtn = d.querySelector('.app-dialog-confirm');

  titleEl.textContent = title || '';
  titleEl.style.display = title ? '' : 'none';
  msgEl.textContent = message;
  iconEl.textContent = danger ? '!' : showCancel ? '?' : 'i';
  iconEl.classList.toggle('app-dialog-icon--danger', !!danger);
  confirmBtn.textContent = confirmText;
  confirmBtn.classList.toggle('app-dialog-btn--danger', !!danger);
  cancelBtn.textContent = cancelText || '';
  cancelBtn.style.display = showCancel ? '' : 'none';

  inputEl.style.display = input ? '' : 'none';
  inputEl.value = input ? (input.value || '') : '';
  inputEl.placeholder = input ? (input.placeholder || '') : '';
  inputEl.maxLength = (input && input.maxLength) || 500;

  return new Promise(resolve => {
    const onClose = () => {
      d.removeEventListener('close', onClose);
      d.removeEventListener('click', onBackdrop);
      inputEl.removeEventListener('keydown', onInputKeydown);
      resolve({ confirmed: d.returnValue === 'confirm', value: inputEl.value });
    };
    const onBackdrop = e => { if (e.target === d) d.close(''); };
    // Enter submits like a form would -- without this, hitting Enter in the
    // input does nothing (a <dialog> has no implicit submit button).
    const onInputKeydown = e => { if (e.key === 'Enter') { e.preventDefault(); d.close('confirm'); } };
    confirmBtn.onclick = () => d.close('confirm');
    cancelBtn.onclick  = () => d.close('');
    d.addEventListener('close', onClose);
    d.addEventListener('click', onBackdrop);
    if (input) inputEl.addEventListener('keydown', onInputKeydown);
    d.returnValue = '';
    d.showModal();
    if (input) inputEl.focus(); else confirmBtn.focus();
  });
}

/** Themed replacement for confirm(). Resolves true if confirmed. */
export function showConfirm(message, { title = '', confirmText, cancelText, danger = false } = {}) {
  return openDialog({
    message,
    title,
    confirmText: confirmText ?? t('dialog.confirm'),
    cancelText:  cancelText  ?? t('dialog.cancel'),
    danger,
    showCancel: true,
  }).then(r => r.confirmed);
}

/** Themed replacement for alert(). Resolves when dismissed. */
export function showAlert(message, { title = '', okText } = {}) {
  return openDialog({
    message,
    title,
    confirmText: okText ?? t('dialog.ok'),
    showCancel: false,
  }).then(() => undefined);
}

// Themed replacement for prompt() -- a single dialog rather than confirm()
// immediately followed by a native prompt(), which reads as two separate
// jarring popups back to back (and the native one breaks the app's theme
// entirely, which is especially bad on a touchscreen POS/KDS terminal).
// Resolves the trimmed input text if confirmed, or null if dismissed --
// mirrors prompt()'s null-on-cancel so callers can treat "" as a
// deliberately blank answer, exactly like the reason it wraps.
export function showPrompt(message, { title = '', confirmText, cancelText, danger = false, placeholder = '', defaultValue = '', maxLength } = {}) {
  return openDialog({
    message,
    title,
    confirmText: confirmText ?? t('dialog.confirm'),
    cancelText:  cancelText  ?? t('dialog.cancel'),
    danger,
    showCancel: true,
    input: { placeholder, value: defaultValue, maxLength },
  }).then(r => (r.confirmed ? r.value.trim() : null));
}
