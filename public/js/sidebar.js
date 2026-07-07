import { t, renderLangSwitcher } from './i18n.js';
import { renderUserMenu } from './userMenu.js';
import { renderThemeToggle } from './themeToggle.js';

const NAV_ITEMS = [
  { page: 'dashboard', href: '/',              icon: '📊', labelKey: 'nav.dashboard' },
  { page: 'expenses',  href: '/expenses.html',  icon: '💸', labelKey: 'nav.expenses'  },
  { page: 'report',    href: '/report.html',    icon: '📋', labelKey: 'nav.reports'   },
  { page: 'receipts',  href: '/receipts.html',  icon: '🧾', labelKey: 'nav.receipts'  },
  { page: 'staff',     href: '/staff.html',     icon: '👥', labelKey: 'nav.staff'     },
  { page: 'users',     href: '/users.html',     icon: '⚙️', labelKey: 'nav.users', id: 'navUsers', adminOnly: true },
];

export function renderSidebar(sidebarEl, activePage) {
  if (!sidebarEl) return;

  const navHtml = NAV_ITEMS.map(item => `
    <a href="${item.href}"${item.id ? ` id="${item.id}"` : ''} class="nav-item${item.page === activePage ? ' active' : ''}" title="${t(item.labelKey)}"${item.adminOnly ? ' style="display:none"' : ''}>
      <span class="text-lg">${item.icon}</span>
      <span class="nav-label" data-i18n="${item.labelKey}">${t(item.labelKey)}</span>
    </a>`).join('');

  sidebarEl.innerHTML = `
    <div class="sidebar-header px-5 py-4 border-b border-[color:var(--border)] flex items-center flex-wrap justify-between gap-y-2.5 gap-x-3" style="position:relative;">
      <button id="userMenuTrigger" type="button" class="flex items-center gap-2" style="background:none;border:none;cursor:pointer;padding:0;text-align:left;">
        <div id="sidebarAvatar" class="w-9 h-9 rounded-full bg-gradient-to-tr from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black flex-shrink-0">U</div>
        <span id="sidebarUserName" class="text-base font-bold text-amber-400 truncate">User</span>
        <span class="user-menu-caret text-[color:var(--text-muted)] flex-shrink-0">▾</span>
      </button>
      <div id="sidebarLangSwitcher" class="flex-shrink-0"></div>
      <div id="sidebarThemeToggle" class="flex-shrink-0"></div>
      <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-[color:var(--hover-tint)] flex-shrink-0" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
      <div id="userMenuMount"></div>
    </div>

    <nav class="flex-1 px-3 py-4 space-y-1">${navHtml}</nav>

    <div class="px-5 py-4 border-t border-[color:var(--border)] sidebar-footer">
      <div id="userInfo" class="text-xs text-[color:var(--text-muted)]"></div>
    </div>`;

  renderUserMenu(sidebarEl.querySelector('#userMenuMount'));
  renderLangSwitcher(sidebarEl.querySelector('#sidebarLangSwitcher'));
  renderThemeToggle(sidebarEl.querySelector('#sidebarThemeToggle'));
}
