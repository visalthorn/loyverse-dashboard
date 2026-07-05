// public/js/userMenu.js
import { t, renderLangSwitcher } from './i18n.js';

export function renderUserMenu(mountEl) {
  if (!mountEl) return;

  mountEl.innerHTML = `
    <div id="userMenuPanel" class="user-menu-panel" style="display:none;">
      <div class="user-menu-info">
        <span id="sidebarUserRole">Role</span>
        <span id="envBadge" class="px-2 py-0.5 rounded text-xs font-bold"></span>
      </div>
      <div id="userMenuLangSwitcher" class="user-menu-lang"></div>
      <button onclick="logout()" class="user-menu-signout">
        <span data-i18n="common.signOut">${t('common.signOut')}</span>
      </button>
    </div>`;

  renderLangSwitcher(mountEl.querySelector('#userMenuLangSwitcher'));

  const trigger = document.getElementById('userMenuTrigger');
  const panel   = mountEl.querySelector('#userMenuPanel');
  if (!trigger || !panel) return;

  function closeMenu() { panel.style.display = 'none'; }
  function openMenu()  { panel.style.display = 'block'; }

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
