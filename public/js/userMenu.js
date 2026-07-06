// public/js/userMenu.js
import { t } from './i18n.js';

export function renderUserMenu(mountEl) {
  if (!mountEl) return;

  mountEl.innerHTML = `
    <div id="userMenuPanel" class="user-menu-panel" style="display:none;">
      <div class="user-menu-meta-label" data-i18n="common.signedInAs">${t('common.signedInAs')}</div>
      <div class="user-menu-info">
        <span id="sidebarUserRole">Role</span>
        <span id="envBadge" class="px-2 py-0.5 rounded text-xs font-bold"></span>
      </div>
      <button onclick="logout()" class="user-menu-signout">
        <span class="user-menu-icon" aria-hidden="true">⏻</span>
        <span data-i18n="common.signOut">${t('common.signOut')}</span>
      </button>
    </div>`;

  const trigger = document.getElementById('userMenuTrigger');
  const panel   = mountEl.querySelector('#userMenuPanel');
  if (!trigger || !panel) return;

  const caret = trigger.querySelector('.user-menu-caret');

  function closeMenu() { panel.style.display = 'none'; caret?.classList.remove('open'); }
  function openMenu()  { panel.style.display = 'block'; caret?.classList.add('open'); }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.style.display === 'none') openMenu(); else closeMenu();
  });

  document.addEventListener('click', (e) => {
    if (panel.style.display === 'none') return;
    if (!panel.contains(e.target) && !trigger.contains(e.target)) closeMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
}
