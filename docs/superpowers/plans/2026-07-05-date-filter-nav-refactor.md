# Date Filter Presets & Shared Sidebar Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inconsistent date-range controls on Dashboard/Report/Receipts/Expenses with one shared, per-page-configurable date-filter component and new preset lists, and eliminate the sidebar `<nav>` markup (and CSS) duplicated across all 6 authenticated HTML pages by replacing it with a single JS-rendered component.

**Architecture:** Two new dependency-free vanilla-ES-module components — `public/js/sidebar.js` (`renderSidebar(el, activePage)`) and `public/js/dateFilter.js` (`renderDateFilter(el, config)`) — follow the exact pattern already established by `renderLangSwitcher()` in `public/js/i18n.js`: render markup into a mount element, no build step, no new dependency. Each of the 4 filtered pages keeps its own reload logic; only how the UI feeds that logic changes.

**Tech Stack:** Vanilla ES modules, matches existing `public/js/*` pattern. No new npm dependencies, no build step.

## Global Constraints

- Default language is English; Khmer strings must be added to both `public/js/i18n/en.js` and `public/js/i18n/km.js` for every new key, verified symmetric.
- No new npm dependencies, no build step.
- Drop Week/Month/Year presets entirely from the UI (per approved spec) — new preset lists: Dashboard = Today/Last 10 days/Custom (default Today); Report = Last 10 days/Custom (default Last 10 days); Receipts = Today/Custom (default Today); Expenses = Today/Custom (default Today).
- `public/js/dashboard.js` (dead code, unreferenced by `app.js`) is out of scope — do not touch it.
- Spec: `docs/superpowers/specs/2026-07-05-date-filter-nav-refactor-design.md`

---

### Task 1: Backend — `last10` period support + `today` comparison fix

**Files:**
- Modify: `utils/date.js`

**Interfaces:**
- Produces: `last10` as a valid `period` value accepted by `buildPeriodFilter`, `getTrendPeriod`, `getPrevPeriodSQL`, `getPeriodDateRange`, `getPrevPeriodDateRange` — all five already exported from this module, signatures unchanged, only their internal `switch`/`if` chains gain a new branch.

- [ ] **Step 1: Add `last10` to `buildPeriodFilter`**

In `utils/date.js`, the `switch (period)` block (currently lines 26-32) reads:

```js
  switch (period) {
    case 'today': return { clause: `DATE(${col}) = CURRENT_DATE`, params: [] };
    case 'week':  return { clause: `DATE(${col}) BETWEEN CURRENT_DATE - INTERVAL '7 days' AND CURRENT_DATE`, params: [] };
    case 'month': return { clause: `DATE_TRUNC('month', ${col}) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')`, params: [] };
    case 'year':  return { clause: `DATE_TRUNC('year', ${col}) = DATE_TRUNC('year', CURRENT_DATE - INTERVAL '1 year')`, params: [] };
    default:      return { clause: `DATE(${col}) = CURRENT_DATE`, params: [] };
  }
```

Add a `last10` case right after `'week'`:

```js
  switch (period) {
    case 'today':  return { clause: `DATE(${col}) = CURRENT_DATE`, params: [] };
    case 'week':   return { clause: `DATE(${col}) BETWEEN CURRENT_DATE - INTERVAL '7 days' AND CURRENT_DATE`, params: [] };
    case 'last10': return { clause: `DATE(${col}) BETWEEN CURRENT_DATE - INTERVAL '10 days' AND CURRENT_DATE`, params: [] };
    case 'month':  return { clause: `DATE_TRUNC('month', ${col}) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')`, params: [] };
    case 'year':   return { clause: `DATE_TRUNC('year', ${col}) = DATE_TRUNC('year', CURRENT_DATE - INTERVAL '1 year')`, params: [] };
    default:       return { clause: `DATE(${col}) = CURRENT_DATE`, params: [] };
  }
```

- [ ] **Step 2: Add `last10` to `getTrendPeriod`**

Currently (lines 35-45):

```js
function getTrendPeriod(period, startDate, endDate) {
  if (period === 'year') return 'month';
  if (period === 'week' || period === 'month') return 'day';
  if (period === 'range' && startDate && endDate) {
    const days = Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)) + 1);
    if (days <= 31)  return 'day';
    if (days <= 180) return 'week';
    return 'month';
  }
  return 'day';
}
```

Change the second line to include `last10`:

```js
function getTrendPeriod(period, startDate, endDate) {
  if (period === 'year') return 'month';
  if (period === 'week' || period === 'last10' || period === 'month') return 'day';
  if (period === 'range' && startDate && endDate) {
    const days = Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)) + 1);
    if (days <= 31)  return 'day';
    if (days <= 180) return 'week';
    return 'month';
  }
  return 'day';
}
```

- [ ] **Step 3: Add `last10` to `getPrevPeriodSQL`**

Currently (lines 47-72):

```js
function getPrevPeriodSQL(period, startDate, endDate, alias = 'r', colName = 'receipt_date') {
  const col = `${alias}.${colName}`;
  switch (period) {
    case 'week':
      return { clause: `DATE(${col}) BETWEEN CURRENT_DATE - INTERVAL '13 days' AND CURRENT_DATE - INTERVAL '7 days'`, params: [] };
    case 'month':
      return { clause: `DATE_TRUNC('month', ${col}) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '2 months')`, params: [] };
    case 'year':
      return { clause: `DATE_TRUNC('year', ${col}) = DATE_TRUNC('year', CURRENT_DATE - INTERVAL '2 years')`, params: [] };
    case 'range':
      if (startDate && endDate) {
        const start     = dayjs(startDate).startOf('day');
        const end       = dayjs(endDate).startOf('day');
        const days      = Math.max(1, end.diff(start, 'day') + 1);
        const prevEnd   = start.subtract(1, 'day');
        const prevStart = prevEnd.subtract(days - 1, 'day');
        return {
          clause: `DATE(${col}) BETWEEN $1 AND $2`,
          params: [prevStart.format('YYYY-MM-DD'), prevEnd.format('YYYY-MM-DD')],
        };
      }
      return { clause: `DATE(${col}) = CURRENT_DATE - INTERVAL '2 day'`, params: [] };
    default:
      return { clause: `DATE(${col}) = CURRENT_DATE - INTERVAL '2 day'`, params: [] };
  }
}
```

Add a `last10` case after `'week'`, mirroring its non-overlapping-preceding-block pattern (10-day block immediately before the current 10-day block):

```js
function getPrevPeriodSQL(period, startDate, endDate, alias = 'r', colName = 'receipt_date') {
  const col = `${alias}.${colName}`;
  switch (period) {
    case 'week':
      return { clause: `DATE(${col}) BETWEEN CURRENT_DATE - INTERVAL '13 days' AND CURRENT_DATE - INTERVAL '7 days'`, params: [] };
    case 'last10':
      return { clause: `DATE(${col}) BETWEEN CURRENT_DATE - INTERVAL '20 days' AND CURRENT_DATE - INTERVAL '10 days'`, params: [] };
    case 'month':
      return { clause: `DATE_TRUNC('month', ${col}) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '2 months')`, params: [] };
    case 'year':
      return { clause: `DATE_TRUNC('year', ${col}) = DATE_TRUNC('year', CURRENT_DATE - INTERVAL '2 years')`, params: [] };
    case 'range':
      if (startDate && endDate) {
        const start     = dayjs(startDate).startOf('day');
        const end       = dayjs(endDate).startOf('day');
        const days      = Math.max(1, end.diff(start, 'day') + 1);
        const prevEnd   = start.subtract(1, 'day');
        const prevStart = prevEnd.subtract(days - 1, 'day');
        return {
          clause: `DATE(${col}) BETWEEN $1 AND $2`,
          params: [prevStart.format('YYYY-MM-DD'), prevEnd.format('YYYY-MM-DD')],
        };
      }
      return { clause: `DATE(${col}) = CURRENT_DATE - INTERVAL '2 day'`, params: [] };
    default:
      return { clause: `DATE(${col}) = CURRENT_DATE - INTERVAL '2 day'`, params: [] };
  }
}
```

- [ ] **Step 4: Add `last10` to `getPeriodDateRange`**

Currently (lines 80-103):

```js
function getPeriodDateRange(period, startDate, endDate) {
  if (startDate && endDate) return { start: startDate, end: endDate };
  const now = dayjs().tz(TZ);
  switch (period) {
    case 'today': {
      const d = now.format('YYYY-MM-DD');
      return { start: d, end: d };
    }
    case 'week':
      return { start: now.subtract(7, 'day').format('YYYY-MM-DD'), end: now.format('YYYY-MM-DD') };
    case 'month': {
      const m = now.subtract(1, 'month');
      return { start: m.startOf('month').format('YYYY-MM-DD'), end: m.endOf('month').format('YYYY-MM-DD') };
    }
    case 'year': {
      const y = now.subtract(1, 'year');
      return { start: y.startOf('year').format('YYYY-MM-DD'), end: y.endOf('year').format('YYYY-MM-DD') };
    }
    default: {
      const d = now.format('YYYY-MM-DD');
      return { start: d, end: d };
    }
  }
}
```

Add a `last10` case after `'week'`:

```js
function getPeriodDateRange(period, startDate, endDate) {
  if (startDate && endDate) return { start: startDate, end: endDate };
  const now = dayjs().tz(TZ);
  switch (period) {
    case 'today': {
      const d = now.format('YYYY-MM-DD');
      return { start: d, end: d };
    }
    case 'week':
      return { start: now.subtract(7, 'day').format('YYYY-MM-DD'), end: now.format('YYYY-MM-DD') };
    case 'last10':
      return { start: now.subtract(10, 'day').format('YYYY-MM-DD'), end: now.format('YYYY-MM-DD') };
    case 'month': {
      const m = now.subtract(1, 'month');
      return { start: m.startOf('month').format('YYYY-MM-DD'), end: m.endOf('month').format('YYYY-MM-DD') };
    }
    case 'year': {
      const y = now.subtract(1, 'year');
      return { start: y.startOf('year').format('YYYY-MM-DD'), end: y.endOf('year').format('YYYY-MM-DD') };
    }
    default: {
      const d = now.format('YYYY-MM-DD');
      return { start: d, end: d };
    }
  }
}
```

- [ ] **Step 5: Add `last10` to `getPrevPeriodDateRange` and fix the `today` comparison quirk**

Currently (lines 106-143):

```js
function getPrevPeriodDateRange(period, startDate, endDate) {
  const now = dayjs().tz(TZ);
  switch (period) {
    case 'today': {
      const d = now.subtract(2, 'day').format('YYYY-MM-DD');
      return { start: d, end: d };
    }
    case 'week':
      return {
        start: now.subtract(13, 'day').format('YYYY-MM-DD'),
        end:   now.subtract(7,  'day').format('YYYY-MM-DD'),
      };
    case 'month': {
      const m = now.subtract(2, 'month');
      return { start: m.startOf('month').format('YYYY-MM-DD'), end: m.endOf('month').format('YYYY-MM-DD') };
    }
    case 'year': {
      const y = now.subtract(2, 'year');
      return { start: y.startOf('year').format('YYYY-MM-DD'), end: y.endOf('year').format('YYYY-MM-DD') };
    }
    case 'range': {
      if (startDate && endDate) {
        const s    = dayjs(startDate);
        const e    = dayjs(endDate);
        const days = e.diff(s, 'day') + 1;
        const prevEnd   = s.subtract(1, 'day');
        const prevStart = prevEnd.subtract(days - 1, 'day');
        return { start: prevStart.format('YYYY-MM-DD'), end: prevEnd.format('YYYY-MM-DD') };
      }
      const d = now.subtract(2, 'day').format('YYYY-MM-DD');
      return { start: d, end: d };
    }
    default: {
      const d = now.subtract(2, 'day').format('YYYY-MM-DD');
      return { start: d, end: d };
    }
  }
}
```

Change the `today` case to compare against 1 day ago (yesterday) instead of 2, and add a `last10` case after `week`:

```js
function getPrevPeriodDateRange(period, startDate, endDate) {
  const now = dayjs().tz(TZ);
  switch (period) {
    case 'today': {
      const d = now.subtract(1, 'day').format('YYYY-MM-DD');
      return { start: d, end: d };
    }
    case 'week':
      return {
        start: now.subtract(13, 'day').format('YYYY-MM-DD'),
        end:   now.subtract(7,  'day').format('YYYY-MM-DD'),
      };
    case 'last10':
      return {
        start: now.subtract(20, 'day').format('YYYY-MM-DD'),
        end:   now.subtract(10, 'day').format('YYYY-MM-DD'),
      };
    case 'month': {
      const m = now.subtract(2, 'month');
      return { start: m.startOf('month').format('YYYY-MM-DD'), end: m.endOf('month').format('YYYY-MM-DD') };
    }
    case 'year': {
      const y = now.subtract(2, 'year');
      return { start: y.startOf('year').format('YYYY-MM-DD'), end: y.endOf('year').format('YYYY-MM-DD') };
    }
    case 'range': {
      if (startDate && endDate) {
        const s    = dayjs(startDate);
        const e    = dayjs(endDate);
        const days = e.diff(s, 'day') + 1;
        const prevEnd   = s.subtract(1, 'day');
        const prevStart = prevEnd.subtract(days - 1, 'day');
        return { start: prevStart.format('YYYY-MM-DD'), end: prevEnd.format('YYYY-MM-DD') };
      }
      const d = now.subtract(1, 'day').format('YYYY-MM-DD');
      return { start: d, end: d };
    }
    default: {
      const d = now.subtract(1, 'day').format('YYYY-MM-DD');
      return { start: d, end: d };
    }
  }
}
```

Note the `range` and `default` fallback branches (used only when `startDate`/`endDate` are absent) also change from `subtract(2, 'day')` to `subtract(1, 'day')` for consistency with the `today` fix.

- [ ] **Step 6: Manually verify**

Start the server (`npm run dev:uat`) and hit the KPI endpoint directly for both new periods:

```bash
curl -s "http://localhost:3000/api/kpis?period=today" -H "Authorization: Bearer <token from browser localStorage pos_token>"
curl -s "http://localhost:3000/api/kpis?period=last10"
```

Confirm both return `200` with a JSON body containing `gross_income`, `orders`, etc. (no 500s, no SQL errors in the server log).

- [ ] **Step 7: Commit**

```bash
git add utils/date.js
git commit -m "feat(filters): add last10 period support and fix today comparison window"
```

---

### Task 2: Shared i18n keys for the date-filter component

**Files:**
- Modify: `public/js/i18n/en.js`
- Modify: `public/js/i18n/km.js`

**Interfaces:**
- Produces: `common.today`, `common.last10Days`, `common.custom`, `common.from`, `common.to`, `common.errorMissingDates`, `common.errorDateOrder` — consumed by `dateFilter.js` (Task 4) and each page's preset config (Tasks 5-8).

- [ ] **Step 1: Add the keys to `public/js/i18n/en.js`**

Find the `common.*` block (starts `'common.signOut': 'Sign out',`) and add these lines right after `'common.thisStaffMember': 'this staff member',`:

```js
  'common.thisStaffMember': 'this staff member',
  'common.today': 'Today',
  'common.last10Days': 'Last 10 days',
  'common.custom': 'Custom',
  'common.from': 'From',
  'common.to': 'To',
  'common.errorMissingDates': 'Please choose both a start and end date.',
  'common.errorDateOrder': 'Start date must be before or equal to end date.',
```

- [ ] **Step 2: Add the mirrored keys to `public/js/i18n/km.js`**

Find the matching `common.*` block and add these lines right after `'common.thisStaffMember': 'បុគ្គលិកនេះ',`:

```js
  'common.thisStaffMember': 'បុគ្គលិកនេះ',
  'common.today': 'ថ្ងៃនេះ',
  'common.last10Days': '10ថ្ងៃចុងក្រោយ',
  'common.custom': 'កំណត់ដោយខ្លួនឯង',
  'common.from': 'ពី',
  'common.to': 'ដល់',
  'common.errorMissingDates': 'សូមជ្រើសរើសទាំងកាលបរិច្ឆេទចាប់ផ្តើម និងបញ្ចប់។',
  'common.errorDateOrder': 'កាលបរិច្ឆេទចាប់ផ្តើមត្រូវតែមុន ឬស្មើកាលបរិច្ឆេទបញ្ចប់។',
```

- [ ] **Step 3: Verify dictionary symmetry**

```bash
node --input-type=module -e "
import { en } from './public/js/i18n/en.js';
import { km } from './public/js/i18n/km.js';
const enKeys = Object.keys(en);
const kmKeys = Object.keys(km);
console.log('Missing in km:', enKeys.filter(k => !kmKeys.includes(k)));
console.log('Missing in en:', kmKeys.filter(k => !enKeys.includes(k)));
"
```

Expected: both `Missing in ...` lines print `[]`.

- [ ] **Step 4: Commit**

```bash
git add public/js/i18n/en.js public/js/i18n/km.js
git commit -m "feat(i18n): add shared date-filter keys (today/last10Days/custom/from/to)"
```

---

### Task 3: Shared sidebar component

**Files:**
- Create: `public/js/sidebar.js`
- Modify: `public/js/app.js`
- Modify: `public/css/style.css` (append)
- Modify: `public/index.html`, `public/expenses.html`, `public/receipts.html`, `public/staff.html`, `public/report.html`, `public/users.html`

**Interfaces:**
- Produces: `renderSidebar(sidebarEl, activePage)` — named export of `public/js/sidebar.js`. `activePage` uses the exact same string values `detectPage()` in `app.js` already returns: `'dashboard'`, `'expenses'`, `'report'`, `'receipts'`, `'staff'`, `'users'`.
- Consumes: `t` from `public/js/i18n.js`.

- [ ] **Step 1: Create `public/js/sidebar.js`**

```js
// public/js/sidebar.js
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
    <a href="${item.href}"${item.id ? ` id="${item.id}"` : ''} class="nav-item${item.page === activePage ? ' active' : ''}"${item.adminOnly ? ' style="display:none"' : ''}>
      <span class="text-lg">${item.icon}</span>
      <span class="nav-label" data-i18n="${item.labelKey}">${t(item.labelKey)}</span>
    </a>`).join('');

  sidebarEl.innerHTML = `
    <div class="sidebar-header px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <div id="sidebarAvatar" class="w-9 h-9 rounded-full bg-gradient-to-tr from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black">U</div>
        <div class="brand-meta">
          <div class="flex items-center gap-2">
            <div id="sidebarUserName" class="text-base font-bold text-amber-400">User</div>
            <span id="envBadge" class="px-2 py-0.5 rounded text-xs font-bold"></span>
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
      <div id="langSwitcher"></div>
      <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-slate-700" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
    </div>

    <nav class="flex-1 px-3 py-4 space-y-1">${navHtml}</nav>

    <div class="px-5 py-4 border-t border-slate-700 sidebar-footer">
      <div id="userInfo" class="text-xs text-slate-400"></div>
    </div>`;
}
```

- [ ] **Step 2: Move the shared sidebar/app-shell CSS into `public/css/style.css`**

Append to the end of `public/css/style.css`:

```css

/* ── shared app shell / sidebar layout (was duplicated per-page) ──────── */
body.app-shell { display: flex; min-height: 100vh; }

.sidebar {
  width: 17rem;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  transition: width .2s ease;
}
.sidebar-collapsed .sidebar { width: 4.5rem; }
.sidebar-collapsed .sidebar-header .brand-meta,
.sidebar-collapsed .sidebar-footer { display: none; }
.sidebar-collapsed .nav-item { justify-content: center; }
.sidebar-collapsed .nav-label { display: none; }

.main-wrapper {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 1rem;
  border-radius: 0.5rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: #cbd5e1;
  border-left: 3px solid transparent;
  transition: background-color .15s, color .15s, border-color .15s;
}
.nav-item:hover { background: rgba(255,255,255,.06); color: #fff; }
.nav-item.active {
  background: rgba(245,158,11,.12);
  color: #fbbf24;
  border-left-color: #fbbf24;
}

.sidebar-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,.5);
  z-index: 50;
}
.sidebar-overlay.show { display: block; }

@media (max-width: 767px) {
  .sidebar {
    position: fixed;
    top: 0; left: 0; bottom: 0;
    transform: translateX(-100%);
    z-index: 60;
    transition: transform .25s ease;
  }
  .sidebar.sidebar-open { transform: translateX(0); }
}
```

- [ ] **Step 3: Remove the duplicated shared block from `public/index.html`**

`public/index.html` currently has a `<style>` block (immediately after `<link rel="stylesheet" href="/css/style.css"/>`) whose *entire* content is the shared block now in `style.css`. Delete the whole block, including the `<style>`/`</style>` tags:

```html
<style>
  /* ---- App shell / sidebar layout ---- */
  body.app-shell { display: flex; min-height: 100vh; }

  .sidebar-collapsed .sidebar {
    width: 4.5rem;
  }

  .sidebar-collapsed .sidebar-header .brand-meta,
  .sidebar-collapsed .sidebar-footer {
    display: none;
  }

  .sidebar-collapsed .nav-item {
    justify-content: center;
  }

  .sidebar-collapsed .nav-label {
    display: none;
  }

  .main-wrapper {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 1rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: #cbd5e1; /* slate-300 */
    border-left: 3px solid transparent;
    transition: background-color .15s, color .15s, border-color .15s;
  }
  .nav-item:hover { background: rgba(255,255,255,.06); color: #fff; }
  .nav-item.active {
    background: rgba(245, 158, 11, .12); /* amber-500/12 */
    color: #fbbf24; /* amber-400 */
    border-left-color: #fbbf24;
  }

  .sidebar-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.5);
    z-index: 50;
  }
  .sidebar-overlay.show { display: block; }

  @media (max-width: 767px) {
    .sidebar {
      position: fixed;
      top: 0; left: 0; bottom: 0;
      transform: translateX(-100%);
      z-index: 60;
      transition: transform .25s ease;
    }
    .sidebar.sidebar-open { transform: translateX(0); }
  }
</style>
```

(Delete this whole block — nothing replaces it, `<link rel="stylesheet" href="/css/style.css"/>` on the line above is untouched.)

Then replace the entire `<aside id="sidebar" ...>...</aside>` block:

```html
<!-- Sidebar -->
<aside id="sidebar" class="sidebar bg-slate-800 border-r border-slate-700">
  <div class="sidebar-header px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3">
    <div class="flex items-center gap-3">
      <div id="sidebarAvatar" class="w-9 h-9 rounded-full bg-gradient-to-tr from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black">U</div>
      <div class="brand-meta">
        <div class="flex items-center gap-2">
          <div id="sidebarUserName" class="text-base font-bold text-amber-400">User</div>
          <span id="envBadge" class="px-2 py-0.5 rounded text-xs font-bold"></span>
        </div>
        <div class="text-xs text-slate-400 flex items-center gap-2">
          <span id="sidebarUserRole">Role</span>
          <button onclick="logout()" title="Sign out"
        style="background:none;border:1px solid #1f2d45;border-radius:8px;padding:6px 10px;color:#64748b;cursor:pointer;font-size:12px;transition:all 0.2s;"
        onmouseover="this.style.color='#f87171';this.style.borderColor='#f87171'"
        onmouseout="this.style.color='#64748b';this.style.borderColor='#1f2d45'">
        <span data-i18n="common.signOut">Sign out</span>
      </button>
        </div>
      </div>
    </div>
    <div id="langSwitcher"></div>
    <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-slate-700" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
  </div>

  <nav class="flex-1 px-3 py-4 space-y-1">
    <a href="/" class="nav-item active">
      <span class="text-lg">📊</span>
      <span class="nav-label" data-i18n="nav.dashboard">Dashboard</span>
    </a>
    <a href="/expenses.html" class="nav-item">
      <span class="text-lg">💸</span>
      <span class="nav-label" data-i18n="nav.expenses">Expenses</span>
    </a>
    <a href="/report.html" class="nav-item">
      <span class="text-lg">📋</span>
      <span class="nav-label" data-i18n="nav.reports">Reports</span>
    </a>
    <a href="/receipts.html" class="nav-item">
      <span class="text-lg">🧾</span>
      <span class="nav-label" data-i18n="nav.receipts">Receipts</span>
    </a>
    <a href="/staff.html" class="nav-item">
      <span class="text-lg">👥</span>
      <span class="nav-label" data-i18n="nav.staff">Staff</span>
    </a>
    <a href="/users.html" id="navUsers" class="nav-item" style="display:none">
      <span class="text-lg">⚙️</span>
      <span class="nav-label" data-i18n="nav.users">Users</span>
    </a>
  </nav>

  <div class="px-5 py-4 border-t border-slate-700 sidebar-footer">
    <div id="userInfo" class="text-xs text-slate-400"></div>
  </div>
</aside>
```

with:

```html
<!-- Sidebar -->
<aside id="sidebar" class="sidebar bg-slate-800 border-r border-slate-700"></aside>
```

- [ ] **Step 4a: `public/expenses.html`**

Delete the entire `<style>...</style>` block (its content is 100% the shared block, nothing page-specific):

```html
<style>
  /* ---- App shell / sidebar layout ---- */
  body.app-shell { display: flex; min-height: 100vh; }

  .sidebar {
    width: 17rem;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    transition: width .2s ease;
  }

  .sidebar-collapsed .sidebar {
    width: 4.5rem;
  }

  .sidebar-collapsed .sidebar-header .brand-meta,
  .sidebar-collapsed .sidebar-footer {
    display: none;
  }

  .sidebar-collapsed .nav-item {
    justify-content: center;
  }

  .sidebar-collapsed .nav-label {
    display: none;
  }

  .main-wrapper {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 1rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: #cbd5e1; /* slate-300 */
    border-left: 3px solid transparent;
    transition: background-color .15s, color .15s, border-color .15s;
  }
  .nav-item:hover { background: rgba(255,255,255,.06); color: #fff; }
  .nav-item.active {
    background: rgba(245, 158, 11, .12); /* amber-500/12 */
    color: #fbbf24; /* amber-400 */
    border-left-color: #fbbf24;
  }

  .sidebar-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.5);
    z-index: 50;
  }
  .sidebar-overlay.show { display: block; }

  @media (max-width: 767px) {
    .sidebar {
      position: fixed;
      top: 0; left: 0; bottom: 0;
      transform: translateX(-100%);
      z-index: 60;
      transition: transform .25s ease;
    }
    .sidebar.sidebar-open { transform: translateX(0); }
  }
</style>
```

Replace the `<aside id="sidebar" ...>...</aside>` block:

```html
<!-- Sidebar -->
<aside id="sidebar" class="sidebar bg-slate-800 border-r border-slate-700">
  <div class="sidebar-header px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3">
    <div class="flex items-center gap-3">
      <div id="sidebarAvatar" class="w-9 h-9 rounded-full bg-gradient-to-tr from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black">U</div>
      <div class="brand-meta">
        <div class="flex items-center gap-2">
          <div id="sidebarUserName" class="text-base font-bold text-amber-400">User</div>
        </div>
        <div class="text-xs text-slate-400 flex items-center gap-2">
          <span id="sidebarUserRole">Role</span>
          <button onclick="logout()" title="Sign out"
        style="background:none;border:1px solid #1f2d45;border-radius:8px;padding:6px 10px;color:#64748b;cursor:pointer;font-size:12px;transition:all 0.2s;"
        onmouseover="this.style.color='#f87171';this.style.borderColor='#f87171'"
        onmouseout="this.style.color='#64748b';this.style.borderColor='#1f2d45'"><span data-i18n="common.signOut">Sign out</span></button>
        </div>
      </div>
    </div>
    <div id="langSwitcher"></div>
    <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-slate-700" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
  </div>

  <nav class="flex-1 px-3 py-4 space-y-1">
    <a href="/" class="nav-item">
      <span class="text-lg">📊</span>
      <span class="nav-label" data-i18n="nav.dashboard">Dashboard</span>
    </a>
    <a href="/expenses.html" class="nav-item active">
      <span class="text-lg">💸</span>
      <span class="nav-label" data-i18n="nav.expenses">Expenses</span>
    </a>
    <a href="/report.html" class="nav-item">
      <span class="text-lg">📋</span>
      <span class="nav-label" data-i18n="nav.reports">Reports</span>
    </a>
    <a href="/receipts.html" class="nav-item">
      <span class="text-lg">🧾</span>
      <span class="nav-label" data-i18n="nav.receipts">Receipts</span>
    </a>
    <a href="/staff.html" class="nav-item">
      <span class="text-lg">👥</span>
      <span class="nav-label" data-i18n="nav.staff">Staff</span>
    </a>
    <a href="/users.html" id="navUsers" class="nav-item" style="display:none">
      <span class="text-lg">⚙️</span>
      <span class="nav-label" data-i18n="nav.users">Users</span>
    </a>
  </nav>

  <div class="px-5 py-4 border-t border-slate-700 sidebar-footer">
    <div id="userInfo" class="text-xs text-slate-400"></div>
  </div>
</aside>
```

with:

```html
<!-- Sidebar -->
<aside id="sidebar" class="sidebar bg-slate-800 border-r border-slate-700"></aside>
```

- [ ] **Step 4b: `public/receipts.html`**

In the `<style>` block, remove only the shared portion (keep everything from `/* ---- Receipt layout ---- */` onward):

```html
  /* ---- App shell / sidebar layout ---- */
  body.app-shell { display: flex; min-height: 100vh; }

  .sidebar {
    width: 17rem;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    transition: width .2s ease;
  }

  .sidebar-collapsed .sidebar { width: 4.5rem; }
  .sidebar-collapsed .sidebar-header .brand-meta,
  .sidebar-collapsed .sidebar-footer { display: none; }
  .sidebar-collapsed .nav-item { justify-content: center; }
  .sidebar-collapsed .nav-label { display: none; }

  .main-wrapper {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 1rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: #cbd5e1;
    border-left: 3px solid transparent;
    transition: background-color .15s, color .15s, border-color .15s;
  }
  .nav-item:hover { background: rgba(255,255,255,.06); color: #fff; }
  .nav-item.active {
    background: rgba(245,158,11,.12);
    color: #fbbf24;
    border-left-color: #fbbf24;
  }

  .sidebar-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.5);
    z-index: 50;
  }
  .sidebar-overlay.show { display: block; }

  @media (max-width: 767px) {
    .sidebar {
      position: fixed;
      top: 0; left: 0; bottom: 0;
      transform: translateX(-100%);
      z-index: 60;
      transition: transform .25s ease;
    }
    .sidebar.sidebar-open { transform: translateX(0); }
  }

  /* ---- Receipt layout ---- */
```

becomes:

```html
  /* ---- Receipt layout ---- */
```

Replace the `<aside>` block (identical structure to Step 4a, `receipts.html`'s own nav item marked active):

```html
<!-- Sidebar -->
<aside id="sidebar" class="sidebar bg-slate-800 border-r border-slate-700">
  <div class="sidebar-header px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3">
    <div class="flex items-center gap-3">
      <div id="sidebarAvatar" class="w-9 h-9 rounded-full bg-gradient-to-tr from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black">U</div>
      <div class="brand-meta">
        <div class="flex items-center gap-2">
          <div id="sidebarUserName" class="text-base font-bold text-amber-400">User</div>
        </div>
        <div class="text-xs text-slate-400 flex items-center gap-2">
          <span id="sidebarUserRole">Role</span>
          <button onclick="logout()" title="Sign out"
            style="background:none;border:1px solid #1f2d45;border-radius:8px;padding:6px 10px;color:#64748b;cursor:pointer;font-size:12px;transition:all 0.2s;"
            onmouseover="this.style.color='#f87171';this.style.borderColor='#f87171'"
            onmouseout="this.style.color='#64748b';this.style.borderColor='#1f2d45'"><span data-i18n="common.signOut">Sign out</span></button>
        </div>
      </div>
    </div>
    <div id="langSwitcher"></div>
    <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-slate-700" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
  </div>

  <nav class="flex-1 px-3 py-4 space-y-1">
    <a href="/" class="nav-item">
      <span class="text-lg">📊</span>
      <span class="nav-label" data-i18n="nav.dashboard">Dashboard</span>
    </a>
    <a href="/expenses.html" class="nav-item">
      <span class="text-lg">💸</span>
      <span class="nav-label" data-i18n="nav.expenses">Expenses</span>
    </a>
    <a href="/report.html" class="nav-item">
      <span class="text-lg">📋</span>
      <span class="nav-label" data-i18n="nav.reports">Reports</span>
    </a>
    <a href="/receipts.html" class="nav-item active">
      <span class="text-lg">🧾</span>
      <span class="nav-label" data-i18n="nav.receipts">Receipts</span>
    </a>
    <a href="/staff.html" class="nav-item">
      <span class="text-lg">👥</span>
      <span class="nav-label" data-i18n="nav.staff">Staff</span>
    </a>
    <a href="/users.html" id="navUsers" class="nav-item" style="display:none">
      <span class="text-lg">⚙️</span>
      <span class="nav-label" data-i18n="nav.users">Users</span>
    </a>
  </nav>

  <div class="px-5 py-4 border-t border-slate-700 sidebar-footer">
    <div id="userInfo" class="text-xs text-slate-400"></div>
  </div>
</aside>
```

with:

```html
<!-- Sidebar -->
<aside id="sidebar" class="sidebar bg-slate-800 border-r border-slate-700"></aside>
```

- [ ] **Step 4c: `public/staff.html`**

In the `<style>` block, remove only the shared portion (this page uses the fully-compact formatting variant; keep everything from `.card { ... }` onward):

```html
  body.app-shell { display: flex; min-height: 100vh; }
  .sidebar { width: 17rem; flex-shrink: 0; display: flex; flex-direction: column; transition: width .2s ease; }
  .sidebar-collapsed .sidebar { width: 4.5rem; }
  .sidebar-collapsed .sidebar-header .brand-meta,
  .sidebar-collapsed .sidebar-footer { display: none; }
  .sidebar-collapsed .nav-item { justify-content: center; }
  .sidebar-collapsed .nav-label { display: none; }
  .main-wrapper { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .nav-item {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.625rem 1rem; border-radius: 0.5rem;
    font-size: 0.875rem; font-weight: 500; color: #cbd5e1;
    border-left: 3px solid transparent;
    transition: background-color .15s, color .15s, border-color .15s;
  }
  .nav-item:hover { background: rgba(255,255,255,.06); color: #fff; }
  .nav-item.active { background: rgba(245,158,11,.12); color: #fbbf24; border-left-color: #fbbf24; }
  .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 50; }
  .sidebar-overlay.show { display: block; }
  @media (max-width: 767px) {
    .sidebar { position: fixed; top: 0; left: 0; bottom: 0; transform: translateX(-100%); z-index: 60; transition: transform .25s ease; }
    .sidebar.sidebar-open { transform: translateX(0); }
  }

  .card { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1.25rem; }
```

becomes:

```html
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1.25rem; }
```

Replace the `<aside>` block (`staff.html`'s own nav item marked active):

```html
<aside id="sidebar" class="sidebar bg-slate-800 border-r border-slate-700">
  <div class="sidebar-header px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3">
    <div class="flex items-center gap-3">
      <div id="sidebarAvatar" class="w-9 h-9 rounded-full bg-gradient-to-tr from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black">U</div>
      <div class="brand-meta">
        <div class="flex items-center gap-2">
          <div id="sidebarUserName" class="text-base font-bold text-amber-400">User</div>
        </div>
        <div class="text-xs text-slate-400 flex items-center gap-2">
          <span id="sidebarUserRole">Role</span>
          <button onclick="logout()" title="Sign out"
            style="background:none;border:1px solid #1f2d45;border-radius:8px;padding:6px 10px;color:#64748b;cursor:pointer;font-size:12px;transition:all 0.2s;"
            onmouseover="this.style.color='#f87171';this.style.borderColor='#f87171'"
            onmouseout="this.style.color='#64748b';this.style.borderColor='#1f2d45'"><span data-i18n="common.signOut">Sign out</span></button>
        </div>
      </div>
    </div>
    <div id="langSwitcher"></div>
    <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-slate-700" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
  </div>

  <nav class="flex-1 px-3 py-4 space-y-1">
    <a href="/" class="nav-item">
      <span class="text-lg">📊</span>
      <span class="nav-label" data-i18n="nav.dashboard">Dashboard</span>
    </a>
    <a href="/expenses.html" class="nav-item">
      <span class="text-lg">💸</span>
      <span class="nav-label" data-i18n="nav.expenses">Expenses</span>
    </a>
    <a href="/report.html" class="nav-item">
      <span class="text-lg">📋</span>
      <span class="nav-label" data-i18n="nav.reports">Reports</span>
    </a>
    <a href="/receipts.html" class="nav-item">
      <span class="text-lg">🧾</span>
      <span class="nav-label" data-i18n="nav.receipts">Receipts</span>
    </a>
    <a href="/staff.html" class="nav-item active">
      <span class="text-lg">👥</span>
      <span class="nav-label" data-i18n="nav.staff">Staff</span>
    </a>
    <a href="/users.html" id="navUsers" class="nav-item" style="display:none">
      <span class="text-lg">⚙️</span>
      <span class="nav-label" data-i18n="nav.users">Users</span>
    </a>
  </nav>

  <div class="px-5 py-4 border-t border-slate-700 sidebar-footer">
    <div id="userInfo" class="text-xs text-slate-400"></div>
  </div>
</aside>
```

with:

```html
<aside id="sidebar" class="sidebar bg-slate-800 border-r border-slate-700"></aside>
```

- [ ] **Step 4d: `public/report.html`**

In the `<style>` block, remove only the shared portion (this page's variant keeps `.sidebar`/`.nav-item`/`.sidebar-overlay`/the media query multi-line but condenses the collapse/hover/active one-liners; keep the trailing `.growth-*` rules):

```html
  body.app-shell { display: flex; min-height: 100vh; }

  .sidebar {
    width: 17rem;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    transition: width .2s ease;
  }

  .sidebar-collapsed .sidebar { width: 4.5rem; }
  .sidebar-collapsed .sidebar-header .brand-meta,
  .sidebar-collapsed .sidebar-footer { display: none; }
  .sidebar-collapsed .nav-item { justify-content: center; }
  .sidebar-collapsed .nav-label { display: none; }

  .main-wrapper {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 1rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: #cbd5e1;
    border-left: 3px solid transparent;
    transition: background-color .15s, color .15s, border-color .15s;
  }
  .nav-item:hover { background: rgba(255,255,255,.06); color: #fff; }
  .nav-item.active {
    background: rgba(245,158,11,.12);
    color: #fbbf24;
    border-left-color: #fbbf24;
  }

  .sidebar-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.5);
    z-index: 50;
  }
  .sidebar-overlay.show { display: block; }

  @media (max-width: 767px) {
    .sidebar {
      position: fixed;
      top: 0; left: 0; bottom: 0;
      transform: translateX(-100%);
      z-index: 60;
      transition: transform .25s ease;
    }
    .sidebar.sidebar-open { transform: translateX(0); }
  }

  .growth-up   { color: #34d399; font-weight: 600; }
```

becomes:

```html
  .growth-up   { color: #34d399; font-weight: 600; }
```

Replace the `<aside>` block (`report.html`'s own nav item marked active):

```html
<!-- Sidebar -->
<aside id="sidebar" class="sidebar bg-slate-800 border-r border-slate-700">
  <div class="sidebar-header px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3">
    <div class="flex items-center gap-3">
      <div id="sidebarAvatar" class="w-9 h-9 rounded-full bg-gradient-to-tr from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black">U</div>
      <div class="brand-meta">
        <div class="flex items-center gap-2">
          <div id="sidebarUserName" class="text-base font-bold text-amber-400">User</div>
        </div>
        <div class="text-xs text-slate-400 flex items-center gap-2">
          <span id="sidebarUserRole">Role</span>
          <button onclick="logout()" title="Sign out"
            style="background:none;border:1px solid #1f2d45;border-radius:8px;padding:6px 10px;color:#64748b;cursor:pointer;font-size:12px;transition:all 0.2s;"
            onmouseover="this.style.color='#f87171';this.style.borderColor='#f87171'"
            onmouseout="this.style.color='#64748b';this.style.borderColor='#1f2d45'">
            <span data-i18n="common.signOut">Sign out</span>
          </button>
        </div>
      </div>
    </div>
    <div id="langSwitcher"></div>
    <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-slate-700" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
  </div>

  <nav class="flex-1 px-3 py-4 space-y-1">
    <a href="/" class="nav-item">
      <span class="text-lg">📊</span>
      <span class="nav-label" data-i18n="nav.dashboard">Dashboard</span>
    </a>
    <a href="/expenses.html" class="nav-item">
      <span class="text-lg">💸</span>
      <span class="nav-label" data-i18n="nav.expenses">Expenses</span>
    </a>
    <a href="/report.html" class="nav-item active">
      <span class="text-lg">📋</span>
      <span class="nav-label" data-i18n="nav.reports">Reports</span>
    </a>
    <a href="/receipts.html" class="nav-item">
      <span class="text-lg">🧾</span>
      <span class="nav-label" data-i18n="nav.receipts">Receipts</span>
    </a>
    <a href="/staff.html" class="nav-item">
      <span class="text-lg">👥</span>
      <span class="nav-label" data-i18n="nav.staff">Staff</span>
    </a>
    <a href="/users.html" id="navUsers" class="nav-item" style="display:none">
      <span class="text-lg">⚙️</span>
      <span class="nav-label" data-i18n="nav.users">Users</span>
    </a>
  </nav>

  <div class="px-5 py-4 border-t border-slate-700 sidebar-footer">
    <div id="userInfo" class="text-xs text-slate-400"></div>
  </div>
</aside>
```

with:

```html
<!-- Sidebar -->
<aside id="sidebar" class="sidebar bg-slate-800 border-r border-slate-700"></aside>
```

- [ ] **Step 4e: `public/users.html`**

In the `<style>` block, remove only the shared portion (same fully-compact variant as `staff.html`; keep everything from `.card { ... }` onward):

```html
  body.app-shell { display: flex; min-height: 100vh; }
  .sidebar { width: 17rem; flex-shrink: 0; display: flex; flex-direction: column; transition: width .2s ease; }
  .sidebar-collapsed .sidebar { width: 4.5rem; }
  .sidebar-collapsed .sidebar-header .brand-meta,
  .sidebar-collapsed .sidebar-footer { display: none; }
  .sidebar-collapsed .nav-item { justify-content: center; }
  .sidebar-collapsed .nav-label { display: none; }
  .main-wrapper { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .nav-item {
    display: flex; align-items: center; gap: 0.75rem;
    padding: 0.625rem 1rem; border-radius: 0.5rem;
    font-size: 0.875rem; font-weight: 500; color: #cbd5e1;
    border-left: 3px solid transparent;
    transition: background-color .15s, color .15s, border-color .15s;
  }
  .nav-item:hover { background: rgba(255,255,255,.06); color: #fff; }
  .nav-item.active { background: rgba(245,158,11,.12); color: #fbbf24; border-left-color: #fbbf24; }
  .sidebar-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 50; }
  .sidebar-overlay.show { display: block; }
  @media (max-width: 767px) {
    .sidebar { position: fixed; top: 0; left: 0; bottom: 0; transform: translateX(-100%); z-index: 60; transition: transform .25s ease; }
    .sidebar.sidebar-open { transform: translateX(0); }
  }

  .card { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1.25rem; }
```

becomes:

```html
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1.25rem; }
```

Replace the `<aside>` block (`users.html`'s own nav item marked active):

```html
<aside id="sidebar" class="sidebar bg-slate-800 border-r border-slate-700">
  <div class="sidebar-header px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3">
    <div class="flex items-center gap-3">
      <div id="sidebarAvatar" class="w-9 h-9 rounded-full bg-gradient-to-tr from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black">U</div>
      <div class="brand-meta">
        <div class="flex items-center gap-2">
          <div id="sidebarUserName" class="text-base font-bold text-amber-400">User</div>
        </div>
        <div class="text-xs text-slate-400 flex items-center gap-2">
          <span id="sidebarUserRole">Role</span>
          <button onclick="logout()" title="Sign out"
            style="background:none;border:1px solid #1f2d45;border-radius:8px;padding:6px 10px;color:#64748b;cursor:pointer;font-size:12px;transition:all 0.2s;"
            onmouseover="this.style.color='#f87171';this.style.borderColor='#f87171'"
            onmouseout="this.style.color='#64748b';this.style.borderColor='#1f2d45'"><span data-i18n="common.signOut">Sign out</span></button>
        </div>
      </div>
    </div>
    <div id="langSwitcher"></div>
    <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-slate-700" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
  </div>

  <nav class="flex-1 px-3 py-4 space-y-1">
    <a href="/" class="nav-item">
      <span class="text-lg">📊</span>
      <span class="nav-label" data-i18n="nav.dashboard">Dashboard</span>
    </a>
    <a href="/expenses.html" class="nav-item">
      <span class="text-lg">💸</span>
      <span class="nav-label" data-i18n="nav.expenses">Expenses</span>
    </a>
    <a href="/report.html" class="nav-item">
      <span class="text-lg">📋</span>
      <span class="nav-label" data-i18n="nav.reports">Reports</span>
    </a>
    <a href="/receipts.html" class="nav-item">
      <span class="text-lg">🧾</span>
      <span class="nav-label" data-i18n="nav.receipts">Receipts</span>
    </a>
    <a href="/staff.html" class="nav-item">
      <span class="text-lg">👥</span>
      <span class="nav-label" data-i18n="nav.staff">Staff</span>
    </a>
    <a href="/users.html" id="navUsers" class="nav-item active">
      <span class="text-lg">⚙️</span>
      <span class="nav-label" data-i18n="nav.users">Users</span>
    </a>
  </nav>

  <div class="px-5 py-4 border-t border-slate-700 sidebar-footer">
    <div id="userInfo" class="text-xs text-slate-400"></div>
  </div>
</aside>
```

with:

```html
<aside id="sidebar" class="sidebar bg-slate-800 border-r border-slate-700"></aside>
```

- [ ] **Step 5: Wire `renderSidebar` into `public/js/app.js`**

At the top of `public/js/app.js`, add the import after the existing `i18n.js` import (line 4):

```js
import { checkAuth, logout } from './auth.js';
import { state } from './state.js';
import { getEl } from './utils.js';
import { applyTranslations, renderLangSwitcher, t } from './i18n.js';
import { renderSidebar } from './sidebar.js';
```

Add an `renderEnvBadge()` helper next to the existing `renderUserHeader()` function (after its closing brace, before the `// ─── Page detection ───` comment):

```js
function renderEnvBadge() {
  const badge = getEl('envBadge');
  if (!badge) return;
  const host = location.hostname;
  const env  = (host === 'localhost' || host === '127.0.0.1') ? 'UAT' : 'PROD';
  badge.textContent = env;
  badge.dataset.env = env;
}
```

Replace the `DOMContentLoaded` handler (currently):

```js
window.addEventListener('DOMContentLoaded', async () => {
  const authData = await checkAuth();
  if (!authData) return;

  state.userPermissions = authData.permissions || {};
  state.currentUserRole = authData.user?.role  || '';

  renderUserHeader(authData.user);
  applyPermissions();
  applyTranslations();
  renderLangSwitcher(getEl('langSwitcher'));

  const navUsers = getEl('navUsers');
  if (navUsers) navUsers.style.display = state.currentUserRole === 'admin' ? '' : 'none';

  if (document.getElementById('usersTableBody') && state.currentUserRole !== 'admin') {
    window.location.href = '/';
    return;
  }

  const page = detectPage();
  if (page === 'dashboard') Dashboard.init();
  if (page === 'expenses')  Expenses.init();
  if (page === 'receipts')  Receipts.init();
  if (page === 'staff')     Staff.init();
  if (page === 'users')     Users.init();
  if (page === 'report')    Report.init();
});
```

with:

```js
window.addEventListener('DOMContentLoaded', async () => {
  const authData = await checkAuth();
  if (!authData) return;

  state.userPermissions = authData.permissions || {};
  state.currentUserRole = authData.user?.role  || '';

  const page = detectPage();
  renderSidebar(getEl('sidebar'), page);
  renderEnvBadge();
  renderUserHeader(authData.user);
  applyPermissions();
  applyTranslations();
  renderLangSwitcher(getEl('langSwitcher'));

  const navUsers = getEl('navUsers');
  if (navUsers) navUsers.style.display = state.currentUserRole === 'admin' ? '' : 'none';

  if (document.getElementById('usersTableBody') && state.currentUserRole !== 'admin') {
    window.location.href = '/';
    return;
  }

  if (page === 'dashboard') Dashboard.init();
  if (page === 'expenses')  Expenses.init();
  if (page === 'receipts')  Receipts.init();
  if (page === 'staff')     Staff.init();
  if (page === 'users')     Users.init();
  if (page === 'report')    Report.init();
});
```

(`renderSidebar()` must run before `renderUserHeader()`/`applyPermissions()`/`applyTranslations()`/`renderLangSwitcher()` since it creates the DOM nodes — `#sidebarUserName`, `#sidebarUserRole`, `#sidebarAvatar`, `#userInfo`, `#navUsers`, the `[data-i18n]` nav labels, `#langSwitcher` — that those four calls populate.)

- [ ] **Step 6: Remove the now-redundant `envBadge` logic from `public/js/pages/dashboard.js`**

In `dashboard.js`'s `init()` (currently):

```js
export async function init() {
  const badge = getEl('envBadge');
  if (badge) {
    const host = location.hostname;
    const env  = (host === 'localhost' || host === '127.0.0.1') ? 'UAT' : 'PROD';
    badge.textContent = env;
    badge.dataset.env = env;
  }
  const slowMoversBtn = getEl('slowMoversBtn');
  if (slowMoversBtn) slowMoversBtn.innerHTML = `<span id="slowMoversArrow">▶</span> ${t('dashboard.showSlowMovers')}`;
  loadAll();
  loadLastSync();
  setInterval(loadAll, 5 * 60 * 1000);
}
```

Remove the `envBadge` block (now handled once for every page by `app.js`'s `renderEnvBadge()`):

```js
export async function init() {
  const slowMoversBtn = getEl('slowMoversBtn');
  if (slowMoversBtn) slowMoversBtn.innerHTML = `<span id="slowMoversArrow">▶</span> ${t('dashboard.showSlowMovers')}`;
  loadAll();
  loadLastSync();
  setInterval(loadAll, 5 * 60 * 1000);
}
```

- [ ] **Step 7: Manually verify**

Start the server (`npm run dev:uat`), log in, and check each of the 6 pages (`/`, `/expenses.html`, `/report.html`, `/receipts.html`, `/staff.html`, `/users.html`):
- Sidebar renders with all 6 nav items, correct icons/labels, and the current page's item highlighted amber.
- The env badge (UAT/PROD) now shows next to the username on **every** page, not just Dashboard.
- Collapse button still shrinks the sidebar to icons-only; language switcher and Sign out both still work.
- Resize to mobile width (< 768px): hamburger button opens the sidebar as an overlay, tapping the overlay closes it.
- Toggle to Khmer (`localStorage.setItem('pos_lang','km')` + reload, or the switcher): nav labels, Sign out, and the collapse-button tooltip are all in Khmer on every page.

- [ ] **Step 8: Commit**

```bash
git add public/js/sidebar.js public/js/app.js public/js/pages/dashboard.js public/css/style.css public/index.html public/expenses.html public/receipts.html public/staff.html public/report.html public/users.html
git commit -m "refactor(nav): extract shared sidebar into one JS-rendered component"
```

---

### Task 4: Shared date-filter component

**Files:**
- Create: `public/js/dateFilter.js`

**Interfaces:**
- Produces: `renderDateFilter(mountEl, { presets, defaultPreset, onChange })` — named export. `presets` is `Array<{ key: string, labelKey: string }>` (the `range`/Custom pill is always added automatically, callers never include it). `onChange` is called with `{ period, start, end }` — `start`/`end` are always resolved to concrete `YYYY-MM-DD` dates (even for non-custom presets), `period` is the preset `key` or `'range'` for a custom range.
- Consumes: `t` from `public/js/i18n.js`, `getTodayDate` from `public/js/utils.js`.

- [ ] **Step 1: Create `public/js/dateFilter.js`**

```js
// public/js/dateFilter.js
import { t } from './i18n.js';
import { getTodayDate } from './utils.js';

function resolveDates(key) {
  const end = getTodayDate();
  if (key === 'last10') {
    const d = new Date();
    d.setDate(d.getDate() - 10);
    return { start: d.toISOString().slice(0, 10), end };
  }
  return { start: end, end };
}

export function renderDateFilter(mountEl, { presets, defaultPreset, onChange }) {
  if (!mountEl) return;

  function render(activeKey, showCustom) {
    mountEl.innerHTML = `
      <div class="flex flex-wrap items-center gap-2">
        <div class="period-selector flex gap-1 bg-slate-700 rounded-lg p-1">
          ${presets.map(p => `<button type="button" class="period-btn${p.key === activeKey ? ' active' : ''}" data-key="${p.key}">${t(p.labelKey)}</button>`).join('')}
          <button type="button" class="period-btn${activeKey === 'range' ? ' active' : ''}" data-key="range">${t('common.custom')}</button>
        </div>
        <div class="date-filter-custom flex flex-wrap items-center gap-2"${showCustom ? '' : ' style="display:none"'}>
          <label class="text-xs text-slate-300"><span>${t('common.from')}</span> <input type="date" class="date-filter-start rounded bg-slate-800 border border-slate-700 text-white text-xs p-1"></label>
          <label class="text-xs text-slate-300"><span>${t('common.to')}</span> <input type="date" class="date-filter-end rounded bg-slate-800 border border-slate-700 text-white text-xs p-1"></label>
          <button type="button" class="date-filter-apply bg-amber-500 hover:bg-amber-400 text-slate-900 text-xs font-semibold uppercase tracking-wide px-3 py-2 rounded">${t('common.apply')}</button>
        </div>
      </div>`;

    mountEl.querySelectorAll('.period-selector .period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (key === 'range') { render(activeKey, true); return; }
        render(key, false);
        onChange({ period: key, ...resolveDates(key) });
      });
    });

    mountEl.querySelector('.date-filter-apply')?.addEventListener('click', () => {
      const start = mountEl.querySelector('.date-filter-start')?.value || '';
      const end   = mountEl.querySelector('.date-filter-end')?.value   || '';
      if (!start || !end) { alert(t('common.errorMissingDates')); return; }
      if (start > end)    { alert(t('common.errorDateOrder')); return; }
      render('range', true);
      onChange({ period: 'range', start, end });
    });
  }

  render(defaultPreset, false);
  onChange({ period: defaultPreset, ...resolveDates(defaultPreset) });
}
```

- [ ] **Step 2: Manually verify in isolation**

This component has no page wired to it yet (Tasks 5-8 do that), so verify it loads without a syntax error:

```bash
node --check public/js/dateFilter.js
```

Expected: no output (exit code 0).

- [ ] **Step 3: Commit**

```bash
git add public/js/dateFilter.js
git commit -m "feat(filters): add shared date-filter component"
```

---

### Task 5: Wire the date filter into Dashboard

**Files:**
- Modify: `public/index.html`
- Modify: `public/js/pages/dashboard.js`
- Modify: `public/js/state.js`
- Modify: `public/js/app.js`

**Interfaces:**
- Consumes: `renderDateFilter` from `public/js/dateFilter.js` (Task 4).
- Produces: `applyDateFilter({ period, start, end })` replacing the old `setPeriod(p)`/`applyCustomRange()` pair — same effect, single entry point, no longer reads `.period-btn.active`/`#startDate`/`#endDate` from the DOM.

- [ ] **Step 1: Replace the period-filter markup in `public/index.html`**

Currently (inside the `<header>`, the "Period Filters" block):

```html
      <!-- Period Filters -->
      <div class="flex flex-col md:flex-row items-start md:items-center gap-5">
        <div class="custom-range flex flex-wrap items-center gap-2">
          <button id="syncBtn" onclick="syncGrossIncome()" class="bg-amber-500 hover:bg-amber-400 text-slate-900 text-xs font-semibold uppercase tracking-wide px-3 py-2 rounded" data-i18n="dashboard.syncButton">Sync Gross Income</button>
          <span id="lastSyncChip" class="text-xs text-slate-400 hidden"></span>
        </div>
        <div class="period-selector flex gap-1 bg-slate-700 rounded-lg p-1">
          <button onclick="setPeriod('week')"   class="period-btn active" data-period="week" data-i18n="dashboard.periodWeek">Last 7 days</button>
          <button onclick="setPeriod('month')"  class="period-btn" data-period="month" data-i18n="dashboard.periodMonth">Last Month</button>
          <button onclick="setPeriod('year')"   class="period-btn" data-period="year" data-i18n="dashboard.periodYear">Year</button>
          <button onclick="setPeriod('range')"  class="period-btn" data-period="range" data-i18n="dashboard.periodCustom">Custom</button>
        </div>
        <div class="custom-range flex flex-wrap items-center gap-2">
          <label class="text-xs text-slate-300"><span data-i18n="dashboard.from">From</span> <input id="startDate" type="date" class="rounded bg-slate-800 border border-slate-700 text-white text-xs p-1"></label>
          <label class="text-xs text-slate-300"><span data-i18n="dashboard.to">To</span> <input id="endDate" type="date" class="rounded bg-slate-800 border border-slate-700 text-white text-xs p-1"></label>
          <button onclick="applyCustomRange()" class="bg-amber-500 hover:bg-amber-400 text-slate-900 text-xs font-semibold uppercase tracking-wide px-3 py-2 rounded" data-i18n="common.apply">Apply</button>
        </div>
      </div>
```

Replace with:

```html
      <!-- Period Filters -->
      <div class="flex flex-col md:flex-row items-start md:items-center gap-5">
        <div class="custom-range flex flex-wrap items-center gap-2">
          <button id="syncBtn" onclick="syncGrossIncome()" class="bg-amber-500 hover:bg-amber-400 text-slate-900 text-xs font-semibold uppercase tracking-wide px-3 py-2 rounded" data-i18n="dashboard.syncButton">Sync Gross Income</button>
          <span id="lastSyncChip" class="text-xs text-slate-400 hidden"></span>
        </div>
        <div id="dateFilterMount"></div>
      </div>
```

Note: `public/js/i18n/en.js`/`km.js` still contain `dashboard.periodWeek/Month/Year/Custom`, `dashboard.from/to`, and `dashboard.errorMissingDates/errorDateOrder` at this point — **do not remove them yet**. `public/report.js`/`report.html` (Task 6) still reference these same keys until that task lands; removing them now would leave `t()` falling back to a raw key string on the Report page in the meantime. Task 9's final sweep removes them once every consumer has migrated.

- [ ] **Step 2: Update `public/js/state.js`'s default period**

Currently:

```js
export const state = {
  userPermissions:      {},
  currentUserRole:      '',
  currentPeriod:        'week',
  currentStartDate:     '',
  currentEndDate:       '',
  expenseFilterStartDate: '',
  expenseFilterEndDate:   '',
  charts:               {},
};
```

Change `currentPeriod`'s default from `'week'` to `'today'` (matches the new Dashboard default; the shared `dateFilter.js` mount overrides this immediately on page load regardless, but the static default should reflect the new UI, not the retired one):

```js
export const state = {
  userPermissions:      {},
  currentUserRole:      '',
  currentPeriod:        'today',
  currentStartDate:     '',
  currentEndDate:       '',
  expenseFilterStartDate: '',
  expenseFilterEndDate:   '',
  charts:               {},
};
```

- [ ] **Step 3: Simplify `setPeriod`/`applyCustomRange` into one `applyDateFilter` in `public/js/pages/dashboard.js`**

Currently (`public/js/pages/dashboard.js`, the "Period Controls" section):

```js
export function setPeriod(p) {
  state.currentPeriod = p;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === p));

  if (p !== 'range') {
    state.currentStartDate = '';
    state.currentEndDate   = '';
    const startInput = getEl('startDate');
    const endInput   = getEl('endDate');
    if (startInput) startInput.value = '';
    if (endInput)   endInput.value   = '';
    loadAll();
    return;
  }
  if (state.currentStartDate && state.currentEndDate) loadAll();
}

export function applyCustomRange() {
  const start = getEl('startDate')?.value || '';
  const end   = getEl('endDate')?.value   || '';
  if (!start || !end) { alert(t('dashboard.errorMissingDates')); return; }
  if (start > end)    { alert(t('dashboard.errorDateOrder')); return; }

  state.currentPeriod    = 'range';
  state.currentStartDate = start;
  state.currentEndDate   = end;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === 'range'));
  loadAll();
}
```

Replace both with:

```js
export function applyDateFilter({ period, start, end }) {
  state.currentPeriod    = period;
  state.currentStartDate = period === 'range' ? start : '';
  state.currentEndDate   = period === 'range' ? end   : '';
  loadAll();
}
```

Import `renderDateFilter` at the top of the file (add to the existing import block):

```js
import { state, COLORS } from '../state.js';
import { t, days } from '../i18n.js';
import { fetchJSON } from '../api.js';
import { apiPost } from '../api.js';
import { getEl, fmt, fmtRaw, fmtDate, fmtDatetime, TZ } from '../utils.js';
import { destroyChart, chartOpts, barOpts, donutOpts, heatColor } from '../charts.js';
import { renderDateFilter } from '../dateFilter.js';
```

In `loadKPIs()`, remove the now-dead DOM-sync line (the `.period-btn.active` selector no longer matches anything meaningful since `applyDateFilter` already sets `state.currentPeriod` directly):

Currently:

```js
async function loadKPIs() {
  state.currentPeriod = document.querySelector('.period-btn.active')?.dataset.period || state.currentPeriod;
  const data = await fetchJSON(`/api/kpis?period=${state.currentPeriod}${rangeQuery()}`);
```

Change to:

```js
async function loadKPIs() {
  const data = await fetchJSON(`/api/kpis?period=${state.currentPeriod}${rangeQuery()}`);
```

Update `init()` to mount the date filter instead of unconditionally calling `loadAll()` (the mount's initial render triggers the first load via `applyDateFilter`):

Currently (after Task 3 Step 6's edit):

```js
export async function init() {
  const slowMoversBtn = getEl('slowMoversBtn');
  if (slowMoversBtn) slowMoversBtn.innerHTML = `<span id="slowMoversArrow">▶</span> ${t('dashboard.showSlowMovers')}`;
  loadAll();
  loadLastSync();
  setInterval(loadAll, 5 * 60 * 1000);
}
```

Change to:

```js
export async function init() {
  const slowMoversBtn = getEl('slowMoversBtn');
  if (slowMoversBtn) slowMoversBtn.innerHTML = `<span id="slowMoversArrow">▶</span> ${t('dashboard.showSlowMovers')}`;
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [
      { key: 'today',  labelKey: 'common.today' },
      { key: 'last10', labelKey: 'common.last10Days' },
    ],
    defaultPreset: 'today',
    onChange: applyDateFilter,
  });
  loadLastSync();
  setInterval(loadAll, 5 * 60 * 1000);
}
```

- [ ] **Step 4: Remove `setPeriod`/`applyCustomRange` from `public/js/app.js`'s window exports**

Currently:

```js
// Dashboard
window.setPeriod                     = Dashboard.setPeriod;
window.applyCustomRange              = Dashboard.applyCustomRange;
window.syncGrossIncome               = Dashboard.syncGrossIncome;
window.dashboardToggleSlowMovers     = Dashboard.toggleSlowMovers;
window.dashboardSetTopProductsCategory = Dashboard.setTopProductsCategory;
```

Change to (no HTML `onclick` references either function anymore — the date filter's pills/Apply button are wired via `addEventListener` inside `dateFilter.js`, not inline `onclick`):

```js
// Dashboard
window.syncGrossIncome               = Dashboard.syncGrossIncome;
window.dashboardToggleSlowMovers     = Dashboard.toggleSlowMovers;
window.dashboardSetTopProductsCategory = Dashboard.setTopProductsCategory;
```

- [ ] **Step 5: Manually verify**

Start the server, open `/`. Confirm:
- Page loads with **Today** selected by default and today's data shown.
- Clicking **Last 10 days** reloads with the last-10-day totals (KPI values change).
- Clicking **Custom** reveals From/To fields; leaving one empty and clicking Apply shows the "choose both dates" alert in the current language; picking a valid range and clicking Apply reloads with that range's data and highlights the Custom pill.
- The Sync Gross Income button and last-sync chip still work unaffected.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/js/pages/dashboard.js public/js/state.js public/js/app.js
git commit -m "feat(dashboard): wire Today/Last 10 days/Custom date filter"
```

---

### Task 6: Wire the date filter into Report

**Files:**
- Modify: `public/report.html`
- Modify: `public/js/pages/report.js`

**Interfaces:**
- Consumes: `renderDateFilter` from `public/js/dateFilter.js`.
- Produces: `applyDateFilter({ period, start, end })` in `report.js`, same shape as Task 5's `dashboard.js` version.

- [ ] **Step 1: Replace the period-filter markup in `public/report.html`**

Currently:

```html
      <div class="flex flex-col md:flex-row items-start md:items-center gap-5">
        <div class="period-selector flex gap-1 bg-slate-700 rounded-lg p-1">
          <button onclick="reportSetPeriod('week')"  class="period-btn active" data-period="week" data-i18n="dashboard.periodWeek">Last 7 days</button>
          <button onclick="reportSetPeriod('month')" class="period-btn" data-period="month" data-i18n="dashboard.periodMonth">Last Month</button>
          <button onclick="reportSetPeriod('year')"  class="period-btn" data-period="year" data-i18n="dashboard.periodYear">Year</button>
          <button onclick="reportSetPeriod('range')" class="period-btn" data-period="range" data-i18n="dashboard.periodCustom">Custom</button>
        </div>
        <div class="custom-range flex flex-wrap items-center gap-2">
          <label class="text-xs text-slate-300"><span data-i18n="dashboard.from">From</span> <input id="startDate" type="date" class="rounded bg-slate-800 border border-slate-700 text-white text-xs p-1"></label>
          <label class="text-xs text-slate-300"><span data-i18n="dashboard.to">To</span> <input id="endDate" type="date" class="rounded bg-slate-800 border border-slate-700 text-white text-xs p-1"></label>
          <button onclick="reportApplyRange()" class="bg-amber-500 hover:bg-amber-400 text-slate-900 text-xs font-semibold uppercase tracking-wide px-3 py-2 rounded" data-i18n="common.apply">Apply</button>
        </div>
      </div>
```

Replace with:

```html
      <div class="flex flex-col md:flex-row items-start md:items-center gap-5">
        <div id="dateFilterMount"></div>
      </div>
```

- [ ] **Step 2: Simplify `report.js`'s period controls**

Currently (the "Period Controls" section):

```js
export function setPeriod(p) {
  state.currentPeriod = p;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === p));
  if (p !== 'range') {
    state.currentStartDate = '';
    state.currentEndDate   = '';
    const s = getEl('startDate'); if (s) s.value = '';
    const e = getEl('endDate');   if (e) e.value = '';
    loadAll();
  } else if (state.currentStartDate && state.currentEndDate) {
    loadAll();
  }
}

export function applyCustomRange() {
  const start = getEl('startDate')?.value || '';
  const end   = getEl('endDate')?.value   || '';
  if (!start || !end) { alert(t('dashboard.errorMissingDates')); return; }
  if (start > end)    { alert(t('dashboard.errorDateOrder')); return; }
  state.currentPeriod    = 'range';
  state.currentStartDate = start;
  state.currentEndDate   = end;
  document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === 'range'));
  loadAll();
}
```

Replace with:

```js
export function applyDateFilter({ period, start, end }) {
  state.currentPeriod    = period;
  state.currentStartDate = period === 'range' ? start : '';
  state.currentEndDate   = period === 'range' ? end   : '';
  loadAll();
}
```

Add the import at the top of `report.js` (alongside the existing `t` import):

```js
import { state, COLORS } from '../state.js';
import { fetchJSON } from '../api.js';
import { getEl, fmt, fmtRaw, fmtDate } from '../utils.js';
import { destroyChart, chartOpts, barOpts, pieOpts } from '../charts.js';
import { t } from '../i18n.js';
import { renderDateFilter } from '../dateFilter.js';
```

Replace `init()` (currently `export function init() { loadAll(); }`) with:

```js
export function init() {
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [
      { key: 'last10', labelKey: 'common.last10Days' },
    ],
    defaultPreset: 'last10',
    onChange: applyDateFilter,
  });
}
```

- [ ] **Step 3: Remove `reportSetPeriod`/`reportApplyRange` from `public/js/app.js`'s window exports**

Currently:

```js
// Report
window.reportSetPeriod              = Report.setPeriod;
window.reportApplyRange             = Report.applyCustomRange;
window.reportSetTopProductsLimit    = Report.setTopProductsLimit;
window.reportSetTopProductsCategory = Report.setTopProductsCategory;
```

Change to:

```js
// Report
window.reportSetTopProductsLimit    = Report.setTopProductsLimit;
window.reportSetTopProductsCategory = Report.setTopProductsCategory;
```

- [ ] **Step 4: Manually verify**

Open `/report.html`. Confirm **Last 10 days** is selected by default with data loaded, Custom reveals date fields and validates/applies correctly (same checks as Task 5 Step 6), and the shared category/Top-N selects on this page are unaffected.

- [ ] **Step 5: Commit**

```bash
git add public/report.html public/js/pages/report.js public/js/app.js
git commit -m "feat(report): wire Last 10 days/Custom date filter"
```

---

### Task 7: Wire the date filter into Receipts

**Files:**
- Modify: `public/receipts.html`
- Modify: `public/js/pages/receipts.js`

**Interfaces:**
- Consumes: `renderDateFilter` from `public/js/dateFilter.js`.
- Produces: `applyDateFilter({ start, end })` in `receipts.js`, replacing DOM reads of `#filterStart`/`#filterEnd` with module-level state.

- [ ] **Step 1: Replace the Start/End date inputs in `public/receipts.html`**

Currently (inside the filter bar, between Search and Type):

```html
            <!-- Start date -->
            <div>
              <label class="block text-xs text-slate-400 mb-1" data-i18n="receipts.from">From</label>
              <input id="filterStart" type="date" class="filter-input" onchange="onApiFilterChange()"/>
            </div>
            <!-- End date -->
            <div>
              <label class="block text-xs text-slate-400 mb-1" data-i18n="receipts.to">To</label>
              <input id="filterEnd" type="date" class="filter-input" onchange="onApiFilterChange()"/>
            </div>
```

Replace with:

```html
            <!-- Date filter -->
            <div id="dateFilterMount"></div>
```

- [ ] **Step 2: Replace DOM-read start/end with module state in `public/js/pages/receipts.js`**

Add module-level state right after the existing `let` declarations near the top of the file:

```js
let allReceipts = [];
let displayed   = [];
let currentPage = 1;
let selectedId  = null;
let isLoading   = false;
let filterStart = '';
let filterEnd   = '';
```

In `loadReceipts()`, currently:

```js
  const start = getEl('filterStart')?.value || '';
  const end   = getEl('filterEnd')?.value   || '';
  const type  = getEl('filterType')?.value  || '';
```

Change to:

```js
  const start = filterStart;
  const end   = filterEnd;
  const type  = getEl('filterType')?.value || '';
```

Add the import at the top of the file:

```js
import { fetchJSON } from '../api.js';
import { getEl, fmtRaw, downloadCSV, TZ } from '../utils.js';
import { t } from '../i18n.js';
import { renderDateFilter } from '../dateFilter.js';
```

(note `getTodayDate` is dropped from the `utils.js` import — it was only used by the DOM-defaulting logic in `init()`, which Step 3 below removes.)

Add the new `applyDateFilter` export and a `mountDateFilter()` helper right before `export function resetFilters()`:

```js
export function applyDateFilter({ start, end }) {
  filterStart = start;
  filterEnd   = end;
  loadReceipts();
}

function mountDateFilter() {
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [{ key: 'today', labelKey: 'common.today' }],
    defaultPreset: 'today',
    onChange: applyDateFilter,
  });
}
```

Update `resetFilters()`, currently:

```js
export function resetFilters() {
  const set = (id, val) => { const el = getEl(id); if (el) el.value = val; };
  set('searchInput', '');
  set('filterStart', '');
  set('filterEnd',   '');
  set('filterType',  '');
  loadReceipts();
}
```

Change to (re-mounting the date filter resets it to the **Today** default and triggers its own reload via `applyDateFilter`, so the trailing `loadReceipts()` call is no longer needed):

```js
export function resetFilters() {
  const set = (id, val) => { const el = getEl(id); if (el) el.value = val; };
  set('searchInput', '');
  set('filterType',  '');
  mountDateFilter();
}
```

- [ ] **Step 3: Replace `init()`**

Currently:

```js
export function init() {
  const today = getTodayDate();
  const start = getEl('filterStart');
  const end   = getEl('filterEnd');
  if (start) start.value = today;
  if (end)   end.value   = today;
  loadReceipts();
}
```

Change to:

```js
export function init() {
  mountDateFilter();
}
```

- [ ] **Step 4: Remove `onApiFilterChange`'s now-defunct usage from `public/js/app.js`? — no change needed**

`window.onApiFilterChange = Receipts.onApiFilterChange;` in `app.js` stays as-is: `onApiFilterChange()` is still wired to the `filterType` select's `onchange` in `receipts.html` and just calls `loadReceipts()` — unaffected by this task.

- [ ] **Step 5: Manually verify**

Open `/receipts.html`. Confirm **Today** is selected by default and today's receipts load, **Custom** reveals date fields and validates/applies correctly, the **Type** select and **Search** box still filter independently, and clicking **Reset** clears search/type and puts the date filter back to Today.

- [ ] **Step 6: Commit**

```bash
git add public/receipts.html public/js/pages/receipts.js
git commit -m "feat(receipts): wire Today/Custom date filter"
```

---

### Task 8: Wire the date filter into Expenses

**Files:**
- Modify: `public/expenses.html`
- Modify: `public/js/pages/expenses.js`

**Interfaces:**
- Consumes: `renderDateFilter` from `public/js/dateFilter.js`.
- Produces: `applyDateFilter({ start, end })` in `expenses.js`; `applyExpenseFilters`/`clearExpenseFilters` are removed (dead once their only callers — the two date inputs and the already-commented-out Apply/Clear buttons — are gone).

- [ ] **Step 1: Replace the Start/End date inputs in `public/expenses.html`**

Currently:

```html
        <div class="flex flex-wrap items-center gap-2 text-xs text-slate-300">
          <label for="expensesStartDate" class="text-slate-400" data-i18n="expenses.start">Start</label>
          <input id="expensesStartDate" type="date" class="rounded bg-slate-800 border border-slate-700 text-white text-sm p-2" />
          <label for="expensesEndDate" class="text-slate-400" data-i18n="expenses.end">End</label>
          <input id="expensesEndDate" type="date" class="rounded bg-slate-800 border border-slate-700 text-white text-sm p-2" />
          <button onclick="exportExpensesCSV()" class="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold px-3 py-2 rounded flex items-center gap-1"><span data-i18n="common.csv">⬇ CSV</span></button>
          <!--<button id="expensesFilterBtn" type="button" class="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold px-3 py-2 rounded">Apply</button>
          <button id="expensesClearBtn" type="button" class="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold px-3 py-2 rounded">Clear</button>-->
        </div>
```

Replace with (dropping the dead commented-out Apply/Clear buttons too):

```html
        <div class="flex flex-wrap items-center gap-2 text-xs text-slate-300">
          <div id="dateFilterMount"></div>
          <button onclick="exportExpensesCSV()" class="bg-slate-700 hover:bg-slate-600 text-slate-200 text-xs font-semibold px-3 py-2 rounded flex items-center gap-1"><span data-i18n="common.csv">⬇ CSV</span></button>
        </div>
```

- [ ] **Step 2: Remove the obsolete `expenses.start`/`expenses.end` keys**

Remove from `public/js/i18n/en.js`:

```js
  'expenses.start': 'Start',
  'expenses.end': 'End',
```

Remove the mirrored lines from `public/js/i18n/km.js`:

```js
  'expenses.start': 'ចាប់ផ្តើម',
  'expenses.end': 'បញ្ចប់',
```

- [ ] **Step 3: Replace the filter functions in `public/js/pages/expenses.js`**

Update the import line at the top of the file:

```js
import { state } from '../state.js';
import { fetchJSON, apiPost, apiPut, apiDelete } from '../api.js';
import { getEl, fmt, fmtRaw, fmtDate, downloadCSV } from '../utils.js';
import { logout } from '../auth.js';
import { t, getLang } from '../i18n.js';
import { renderDateFilter } from '../dateFilter.js';
```

(`getTodayDate` is dropped — it was only used by the DOM-defaulting logic in `init()`/`clearExpenseFilters()`, both removed below.)

Replace the "Filters" section, currently:

```js
// ─── Filters ─────────────────────────────────────────────────────────────────

export function applyExpenseFilters() {
  state.expenseFilterStartDate = getEl('expensesStartDate')?.value || '';
  state.expenseFilterEndDate   = getEl('expensesEndDate')?.value   || '';
  window.expensesPage = 1;
  loadExpenses();
}

export function clearExpenseFilters() {
  const today = getTodayDate();
  const start = getEl('expensesStartDate');
  const end   = getEl('expensesEndDate');
  if (start) start.value = today;
  if (end)   end.value   = today;
  applyExpenseFilters();
}
```

with:

```js
// ─── Filters ─────────────────────────────────────────────────────────────────

export function applyDateFilter({ start, end }) {
  state.expenseFilterStartDate = start;
  state.expenseFilterEndDate   = end;
  window.expensesPage = 1;
  loadExpenses();
}
```

Replace `init()`, currently:

```js
export function init() {
  const today = getTodayDate();
  const start = getEl('expensesStartDate');
  const end   = getEl('expensesEndDate');
  if (start) start.value = today;
  if (end)   end.value   = today;

  start?.addEventListener('change', applyExpenseFilters);
  end?.addEventListener('change',   applyExpenseFilters);

  applyExpenseFilters();
}
```

with:

```js
export function init() {
  renderDateFilter(getEl('dateFilterMount'), {
    presets: [{ key: 'today', labelKey: 'common.today' }],
    defaultPreset: 'today',
    onChange: applyDateFilter,
  });
}
```

- [ ] **Step 4: Manually verify**

Open `/expenses.html`. Confirm **Today** is selected by default and today's expenses load, **Custom** reveals date fields and validates/applies correctly, and CSV export (`⬇ CSV`) still exports using the currently-selected range.

- [ ] **Step 5: Commit**

```bash
git add public/expenses.html public/js/pages/expenses.js public/js/i18n/en.js public/js/i18n/km.js
git commit -m "feat(expenses): wire Today/Custom date filter"
```

---

### Task 9: Final sweep — remove dead keys, verify symmetry, full click-through

**Files:**
- Modify: `public/js/i18n/en.js`, `public/js/i18n/km.js`

**Interfaces:**
- Consumes: nothing new — this is a verification and cleanup pass over everything Tasks 1-8 produced.

- [ ] **Step 1: Grep for any residual references to keys/elements that should now be fully unused**

```bash
grep -rn "dashboard\.periodWeek\|dashboard\.periodMonth\|dashboard\.periodYear\|dashboard\.periodCustom\|dashboard\.errorMissingDates\|dashboard\.errorDateOrder\|dashboard\.from\|dashboard\.to\|receipts\.from\|receipts\.to\|expenses\.start\|expenses\.end" public/ --include=*.js --include=*.html
grep -rn "period-btn.active\|filterStart\|filterEnd\|expensesStartDate\|expensesEndDate\|getEl('startDate')\|getEl('endDate')" public/js/pages/ public/*.html
```

Expected: no matches (aside from the dead, out-of-scope `public/js/dashboard.js`, which the grep's file list above deliberately excludes by only targeting `pages/` and `*.html`). If anything else turns up, stop and fix it by applying the same pattern used in the task that owns that file — do **not** proceed to Step 2 until this grep is clean, since Step 2 deletes the dictionary entries these reference.

- [ ] **Step 2: Delete the now fully-unreferenced dictionary keys**

Remove these lines from `public/js/i18n/en.js` (superseded by the `common.*` keys from Task 2; Step 1 just confirmed nothing references them anymore):

```js
  'dashboard.periodWeek': 'Last 7 days',
  'dashboard.periodMonth': 'Last Month',
  'dashboard.periodYear': 'Year',
  'dashboard.periodCustom': 'Custom',
```
```js
  'dashboard.from': 'From',
  'dashboard.to': 'To',
```
```js
  'dashboard.errorMissingDates': 'Please choose both a start and end date.',
  'dashboard.errorDateOrder': 'Start date must be before or equal to end date.',
```
```js
  'receipts.from': 'From',
  'receipts.to': 'To',
```

Remove the mirrored lines from `public/js/i18n/km.js`:

```js
  'dashboard.periodWeek': '7ថ្ងៃចុងក្រោយ',
  'dashboard.periodMonth': 'ខែមុន',
  'dashboard.periodYear': 'ឆ្នាំ',
  'dashboard.periodCustom': 'កំណត់ដោយខ្លួនឯង',
```
```js
  'dashboard.from': 'ពី',
  'dashboard.to': 'ដល់',
```
```js
  'dashboard.errorMissingDates': 'សូមជ្រើសរើសទាំងកាលបរិច្ឆេទចាប់ផ្តើម និងបញ្ចប់។',
  'dashboard.errorDateOrder': 'កាលបរិច្ឆេទចាប់ផ្តើមត្រូវតែមុន ឬស្មើកាលបរិច្ឆេទបញ្ចប់។',
```
```js
  'receipts.from': 'ពី',
  'receipts.to': 'ដល់',
```

(Leave every other `dashboard.*`/`receipts.*` key untouched — `dashboard.periodPerformance`, `dashboard.kpi.*`, `receipts.thDate`, etc. are unrelated to the filter controls. `expenses.start`/`expenses.end` were already removed in Task 8, and are not repeated here.)

- [ ] **Step 3: Verify dictionary symmetry and no syntax errors**

```bash
node --check public/js/pages/dashboard.js
node --check public/js/pages/report.js
node --check public/js/pages/receipts.js
node --check public/js/pages/expenses.js
node --check public/js/app.js
node --check public/js/sidebar.js
node --check public/js/dateFilter.js
node --input-type=module -e "
import { en } from './public/js/i18n/en.js';
import { km } from './public/js/i18n/km.js';
const enKeys = Object.keys(en);
const kmKeys = Object.keys(km);
console.log('Missing in km:', enKeys.filter(k => !kmKeys.includes(k)));
console.log('Missing in en:', kmKeys.filter(k => !enKeys.includes(k)));
"
```

Expected: every `node --check` prints nothing (exit 0); both `Missing in ...` lines print `[]`.

- [ ] **Step 4: Full click-through in both languages**

With the server running (`npm run dev:uat`), click through all 6 pages (Dashboard, Expenses, Report, Receipts, Staff, Users) in English, then toggle to Khmer and repeat, watching the browser devtools console for `[i18n] missing key` warnings. Specifically re-check:
- Every page's sidebar (nav highlight, collapse, language switcher, sign-out, env badge).
- Dashboard/Report/Receipts/Expenses default preset + preset switching + Custom validation/apply, in both languages.
- Mobile width (< 768px) sidebar overlay behavior on at least one page.

Fix any warning found by adding the missing key to both dictionaries.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(i18n): remove dead date-filter keys found in final sweep"
```
