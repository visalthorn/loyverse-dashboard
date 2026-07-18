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

function openDialog({ message, title, confirmText, cancelText, danger, showCancel }) {
  const d = ensureDialog();
  const titleEl   = d.querySelector('.app-dialog-title');
  const msgEl     = d.querySelector('.app-dialog-message');
  const iconEl    = d.querySelector('.app-dialog-icon');
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

  return new Promise(resolve => {
    const onClose = () => {
      d.removeEventListener('close', onClose);
      d.removeEventListener('click', onBackdrop);
      resolve(d.returnValue === 'confirm');
    };
    const onBackdrop = e => { if (e.target === d) d.close(''); };
    confirmBtn.onclick = () => d.close('confirm');
    cancelBtn.onclick  = () => d.close('');
    d.addEventListener('close', onClose);
    d.addEventListener('click', onBackdrop);
    d.returnValue = '';
    d.showModal();
    confirmBtn.focus();
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
  });
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
