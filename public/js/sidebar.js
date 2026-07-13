import { t, renderLangSwitcher } from './i18n.js';
import { renderUserMenu } from './userMenu.js';
import { renderThemeToggle } from './themeToggle.js';
import { renderCurrencyToggle } from './currencyToggle.js';

const NAV_ITEMS = [
  { page: 'dashboard', href: '/',              icon: '📊', labelKey: 'nav.dashboard' },
  { page: 'expenses',  href: '/expenses.html',  icon: '💸', labelKey: 'nav.expenses'  },
  { page: 'report',    href: '/summary-report.html', icon: '📋', labelKey: 'nav.reports' },
  { page: 'receipts',  href: '/receipts.html',  icon: '🧾', labelKey: 'nav.receipts'  },
  { page: 'staff',     href: '/staff.html',     icon: '👥', labelKey: 'nav.staff'     },
  { page: 'items',     href: '/items.html',     icon: '🏷️', labelKey: 'nav.items'     },
  { page: 'users',     href: '/users.html',     icon: '⚙️', labelKey: 'nav.users', id: 'navUsers', adminOnly: true },
  { page: 'sync',      href: '/sync.html',      icon: '🔄', labelKey: 'nav.sync'      },
];

export function renderSidebar(sidebarEl, activePage) {
  if (!sidebarEl) return;

  const navHtml = NAV_ITEMS.map(item => `
    <a href="${item.href}"${item.id ? ` id="${item.id}"` : ''} class="nav-item${item.page === activePage ? ' active' : ''}" title="${t(item.labelKey)}"${item.adminOnly ? ' style="display:none"' : ''}>
      <span class="text-lg">${item.icon}</span>
      <span class="nav-label" data-i18n="${item.labelKey}">${t(item.labelKey)}</span>
    </a>`).join('');

  sidebarEl.innerHTML = `
    <div class="sidebar-header px-5 py-4 border-b border-[color:var(--border)] space-y-2.5" style="position:relative;">
      <div class="sidebar-userrow flex items-center justify-between gap-2">
        <button id="userMenuTrigger" type="button" class="flex items-center gap-2 min-w-0" style="background:none;border:none;cursor:pointer;padding:0;text-align:left;">
          <div id="sidebarAvatar" class="w-9 h-9 rounded-full flex items-center justify-center font-bold flex-shrink-0" style="background:linear-gradient(135deg,var(--accent),var(--accent-strong));color:var(--accent-contrast);">U</div>
          <span id="sidebarUserName" class="text-base font-bold text-[color:var(--accent-strong)] truncate">User</span>
          <span class="user-menu-caret text-[color:var(--text-muted)] flex-shrink-0">▾</span>
        </button>
        <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-[color:var(--hover-tint)] flex-shrink-0" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
      </div>
      <div class="sidebar-prefs flex items-center justify-between gap-2">
        <div id="sidebarLangSwitcher" class="flex-shrink-0"></div>
        <div id="sidebarCurrencyToggle" class="flex-shrink-0"></div>
        <div id="sidebarThemeToggle" class="flex-shrink-0"></div>
      </div>
      <div id="userMenuMount"></div>
    </div>

    <nav class="flex-1 px-3 py-4 space-y-1">${navHtml}</nav>

    <div class="px-5 py-4 border-t border-[color:var(--border)] sidebar-footer">
      <div id="userInfo" class="text-xs text-[color:var(--text-muted)]"></div>
    </div>`;

  renderUserMenu(sidebarEl.querySelector('#userMenuMount'));
  renderLangSwitcher(sidebarEl.querySelector('#sidebarLangSwitcher'));
  renderCurrencyToggle(sidebarEl.querySelector('#sidebarCurrencyToggle'));
  renderThemeToggle(sidebarEl.querySelector('#sidebarThemeToggle'));
}
