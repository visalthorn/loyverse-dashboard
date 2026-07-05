import { t } from './i18n.js';

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
    <div class="sidebar-header px-5 py-4 border-b border-slate-700 flex flex-wrap items-center justify-between gap-3">
      <div class="flex items-center gap-3 min-w-0">
        <div id="sidebarAvatar" class="w-9 h-9 rounded-full bg-gradient-to-tr from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black flex-shrink-0">U</div>
        <div class="brand-meta min-w-0">
          <div class="flex items-center gap-2 min-w-0">
            <div id="sidebarUserName" class="text-base font-bold text-amber-400 truncate">User</div>
            <span id="envBadge" class="px-2 py-0.5 rounded text-xs font-bold flex-shrink-0"></span>
          </div>
          <div class="text-xs text-slate-400 flex items-center gap-2">
            <span id="sidebarUserRole">Role</span>
            <button onclick="logout()" title="Sign out"
              style="background:none;border:1px solid #1f2d45;border-radius:8px;padding:6px 10px;color:#64748b;cursor:pointer;font-size:12px;transition:all 0.2s;"
              onmouseover="this.style.color='#f87171';this.style.borderColor='#f87171'"
              onmouseout="this.style.color='#64748b';this.style.borderColor='#1f2d45'">
              <span data-i18n="common.signOut">${t('common.signOut')}</span>
            </button>
          </div>
        </div>
      </div>
      <div class="sidebar-header-controls flex items-center gap-3 flex-shrink-0 ml-auto">
        <div id="langSwitcher"></div>
        <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-slate-700" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
      </div>
    </div>

    <nav class="flex-1 px-3 py-4 space-y-1">${navHtml}</nav>

    <div class="px-5 py-4 border-t border-slate-700 sidebar-footer">
      <div id="userInfo" class="text-xs text-slate-400"></div>
    </div>`;
}
