# Sidebar Header Redesign & Chart Period-Label Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Sign out and language switching into an avatar-triggered dropdown menu so the sidebar header always shows just avatar + username + collapse toggle, and fix three chart/heatmap period-range labels left showing broken text (`"Period: today"`, literal `"(last10)"`, or an always-wrong `"Last year"`) by the recent date-filter refactor.

**Architecture:** A new `public/js/userMenu.js` component (`renderUserMenu(mountEl)`) follows the same "render into a mount point" pattern as this session's `sidebar.js`/`dateFilter.js`, reusing the existing `renderLangSwitcher()` from `i18n.js` inside its dropdown panel. A new `periodLabel(period, start, end)` helper is added to `dateFilter.js` (which already owns period semantics) and becomes the single source of truth for period-range display text, replacing three separate stale ternary chains.

**Tech Stack:** Vanilla ES modules, matches existing `public/js/*` pattern. No new npm dependencies, no build step.

## Global Constraints

- No new npm dependencies, no build step.
- The always-visible sidebar header shows only avatar + username + collapse toggle — no env badge, role, Sign out, or language switcher outside the dropdown.
- Clicking the avatar/username toggles the dropdown; clicking outside it or pressing Escape closes it.
- `periodLabel()` returns: `today` → "Today", `last10` → "Last 10 days", `range` → `"{start} → {end}"`.
- The three period labels restyle from `text-xs text-slate-400` to a small amber pill (`.period-badge`).
- Retired dictionary keys (`dashboard.grossIncomeRangeCustom/Week/Month/Year/Period`, `report.trendRangeCustom`) are removed from both `public/js/i18n/en.js` and `public/js/i18n/km.js` once nothing references them.
- Spec: `docs/superpowers/specs/2026-07-05-sidebar-header-and-period-label-design.md`

---

### Task 1: `periodLabel()` helper in `dateFilter.js`

**Files:**
- Modify: `public/js/dateFilter.js`

**Interfaces:**
- Produces: `periodLabel(period, start, end)` — new named export, consumed by Task 2's `dashboard.js`/`report.js` changes.

- [ ] **Step 1: Add the `periodLabel` export**

In `public/js/dateFilter.js`, add this function after `resolveDates` (before `export function renderDateFilter`):

```js
export function periodLabel(period, start, end) {
  if (period === 'range') return `${start} → ${end}`;
  if (period === 'last10') return t('common.last10Days');
  return t('common.today');
}
```

- [ ] **Step 2: Manually verify**

```bash
node --check public/js/dateFilter.js
node --input-type=module -e "
import { periodLabel } from './public/js/dateFilter.js';
console.log(periodLabel('today', '', ''));
console.log(periodLabel('last10', '', ''));
console.log(periodLabel('range', '2026-06-25', '2026-07-05'));
"
```

Expected: `node --check` prints nothing; the three `console.log` lines print `Today`, `Last 10 days`, `2026-06-25 → 2026-07-05`.

- [ ] **Step 3: Commit**

```bash
git add public/js/dateFilter.js
git commit -m "feat(filters): add periodLabel() helper for chart range display"
```

---

### Task 2: Fix the three broken period labels and restyle as a pill

**Files:**
- Modify: `public/js/pages/dashboard.js`
- Modify: `public/js/pages/report.js`
- Modify: `public/index.html`
- Modify: `public/report.html`
- Modify: `public/css/style.css`
- Modify: `public/js/i18n/en.js`
- Modify: `public/js/i18n/km.js`

**Interfaces:**
- Consumes: `periodLabel` from `public/js/dateFilter.js` (Task 1).

- [ ] **Step 1: Add the `.period-badge` CSS class**

Append to the end of `public/css/style.css`:

```css

/* ── period-range badge (chart/heatmap labels) ──────────── */
.period-badge {
  display: inline-block;
  background: rgba(245,158,11,.12);
  color: #fbbf24;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
}
```

- [ ] **Step 2: Fix `loadGrossIncomeTrend()` in `public/js/pages/dashboard.js`**

Update the import line at the top of the file (currently `import { renderDateFilter } from '../dateFilter.js';`):

```js
import { renderDateFilter, periodLabel } from '../dateFilter.js';
```

Currently:

```js
  const trendLabel = getEl('grossIncomeLabel');
  if (trendLabel) trendLabel.textContent = p === 'range'
    ? t('dashboard.grossIncomeRangeCustom', { start: s, end: e })
    : p === 'week'  ? t('dashboard.grossIncomeRangeWeek')
    : p === 'month' ? t('dashboard.grossIncomeRangeMonth')
    : p === 'year'  ? t('dashboard.grossIncomeRangeYear')
    : t('dashboard.grossIncomeRangePeriod', { period: p });
```

Replace with:

```js
  const trendLabel = getEl('grossIncomeLabel');
  if (trendLabel) trendLabel.textContent = periodLabel(p, s, e);
```

- [ ] **Step 3: Fix `loadPeakHours()` in `public/js/pages/dashboard.js`**

Currently:

```js
  const heatmapLabel = getEl('heatmapRangeLabel');
  if (heatmapLabel) heatmapLabel.textContent = p === 'range'
    ? `(${s} → ${e})`
    : p === 'week'  ? `(${t('dashboard.grossIncomeRangeWeek')})`
    : p === 'month' ? `(${t('dashboard.grossIncomeRangeMonth')})`
    : p === 'year'  ? `(${t('dashboard.grossIncomeRangeYear')})`
    : `(${p})`;
```

Replace with:

```js
  const heatmapLabel = getEl('heatmapRangeLabel');
  if (heatmapLabel) heatmapLabel.textContent = periodLabel(p, s, e);
```

- [ ] **Step 4: Fix `loadRevenueTrend()` in `public/js/pages/report.js`**

Update the import line at the top of the file (currently `import { renderDateFilter } from '../dateFilter.js';`):

```js
import { renderDateFilter, periodLabel } from '../dateFilter.js';
```

Currently:

```js
  const label = getEl('revTrendLabel');
  const { currentPeriod: p, currentStartDate: s, currentEndDate: e } = state;
  if (label) label.textContent = p === 'range' ? t('report.trendRangeCustom', { start: s, end: e })
    : p === 'week'  ? t('dashboard.grossIncomeRangeWeek')
    : p === 'month' ? t('dashboard.grossIncomeRangeMonth')
    : t('dashboard.grossIncomeRangeYear');
```

Replace with:

```js
  const label = getEl('revTrendLabel');
  const { currentPeriod: p, currentStartDate: s, currentEndDate: e } = state;
  if (label) label.textContent = periodLabel(p, s, e);
```

- [ ] **Step 5: Restyle the three label elements in the HTML**

In `public/index.html`, currently:

```html
        <span id="grossIncomeLabel" class="text-xs text-slate-400" data-i18n="dashboard.grossIncomeChartSub">Period matched to global filter</span>
```

Change the class to:

```html
        <span id="grossIncomeLabel" class="period-badge" data-i18n="dashboard.grossIncomeChartSub">Period matched to global filter</span>
```

Also in `public/index.html`, currently:

```html
      <h2 class="section-title mb-4"><span data-i18n="dashboard.heatmapTitle">🔥 Peak Hours Heatmap</span> <span id="heatmapRangeLabel" class="text-xs text-slate-400 font-normal"></span></h2>
```

Change to:

```html
      <h2 class="section-title mb-4"><span data-i18n="dashboard.heatmapTitle">🔥 Peak Hours Heatmap</span> <span id="heatmapRangeLabel" class="period-badge"></span></h2>
```

In `public/report.html`, currently:

```html
        <span id="revTrendLabel" class="text-xs text-slate-400"></span>
```

Change to:

```html
        <span id="revTrendLabel" class="period-badge"></span>
```

- [ ] **Step 6: Remove the now-unreferenced dictionary keys**

Remove from `public/js/i18n/en.js`:

```js
  'dashboard.grossIncomeRangeCustom': 'Custom range {start} → {end}',
  'dashboard.grossIncomeRangeWeek': 'Last 7 days',
  'dashboard.grossIncomeRangeMonth': 'Last month',
  'dashboard.grossIncomeRangeYear': 'Last year',
  'dashboard.grossIncomeRangePeriod': 'Period: {period}',
```

and:

```js
  'report.trendRangeCustom': '{start} → {end}',
```

Remove the mirrored lines from `public/js/i18n/km.js`:

```js
  'dashboard.grossIncomeRangeCustom': 'កំឡុងពេលកំណត់ {start} → {end}',
  'dashboard.grossIncomeRangeWeek': '7ថ្ងៃចុងក្រោយ',
  'dashboard.grossIncomeRangeMonth': 'ខែមុន',
  'dashboard.grossIncomeRangeYear': 'ឆ្នាំមុន',
  'dashboard.grossIncomeRangePeriod': 'កំឡុងពេល៖ {period}',
```

and:

```js
  'report.trendRangeCustom': '{start} → {end}',
```

(Leave `dashboard.grossIncomeChartSub` untouched — it's a different key, used only as a static fallback shown before `loadGrossIncomeTrend()` overwrites the label on page load.)

- [ ] **Step 7: Verify no remaining references, dictionary symmetry, and syntax**

```bash
grep -rn "grossIncomeRangeCustom\|grossIncomeRangeWeek\|grossIncomeRangeMonth\|grossIncomeRangeYear\|grossIncomeRangePeriod\|report\.trendRangeCustom" public/ --include=*.js --include=*.html
```

Expected: no matches.

```bash
node --check public/js/pages/dashboard.js
node --check public/js/pages/report.js
node --input-type=module -e "
import { en } from './public/js/i18n/en.js';
import { km } from './public/js/i18n/km.js';
const enKeys = Object.keys(en);
const kmKeys = Object.keys(km);
console.log('Missing in km:', enKeys.filter(k => !kmKeys.includes(k)));
console.log('Missing in en:', kmKeys.filter(k => !enKeys.includes(k)));
"
```

Expected: both `node --check` calls print nothing; both `Missing in ...` lines print `[]`.

- [ ] **Step 8: Commit**

```bash
git add public/js/pages/dashboard.js public/js/pages/report.js public/index.html public/report.html public/css/style.css public/js/i18n/en.js public/js/i18n/km.js
git commit -m "fix(charts): correct broken period-range labels and restyle as a badge"
```

---

### Task 3: `userMenu.js` dropdown component

**Files:**
- Create: `public/js/userMenu.js`
- Modify: `public/css/style.css`

**Interfaces:**
- Consumes: `t`, `renderLangSwitcher` from `public/js/i18n.js`.
- Produces: `renderUserMenu(mountEl)` — named export. Expects a `#userMenuTrigger` element to already exist in the document (rendered by `sidebar.js` in Task 4) and toggles a dropdown panel it renders into `mountEl`. Renders `#sidebarUserRole` and `#envBadge` elements inside the panel — these IDs are unchanged from before, so `app.js`'s existing `renderUserHeader()`/`renderEnvBadge()` (which call `getEl('sidebarUserRole')`/`getEl('envBadge')`) keep working without any change to `app.js`.

- [ ] **Step 1: Create `public/js/userMenu.js`**

```js
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
```

- [ ] **Step 2: Add dropdown panel CSS**

Append to the end of `public/css/style.css`:

```css

/* ── user menu dropdown (avatar-triggered) ───────────────── */
.user-menu-panel {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  min-width: 220px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 10px;
  padding: 12px;
  box-shadow: 0 12px 32px rgba(0,0,0,.5);
  z-index: 70;
}
.user-menu-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 10px;
  margin-bottom: 10px;
  border-bottom: 1px solid #334155;
  font-size: 0.75rem;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.user-menu-lang { margin-bottom: 10px; }
.user-menu-signout {
  width: 100%;
  text-align: left;
  background: none;
  border: 1px solid #1f2d45;
  border-radius: 8px;
  padding: 8px 10px;
  color: #f87171;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: background-color .15s;
}
.user-menu-signout:hover { background: rgba(248,113,113,.1); }
```

- [ ] **Step 3: Manually verify**

```bash
node --check public/js/userMenu.js
```

Expected: no output. (This component has no page wired to it yet — Task 4 does that.)

- [ ] **Step 4: Commit**

```bash
git add public/js/userMenu.js public/css/style.css
git commit -m "feat(sidebar): add userMenu dropdown component"
```

---

### Task 4: Redesign the sidebar header to use `userMenu`

**Files:**
- Modify: `public/js/sidebar.js`
- Modify: `public/css/style.css`

**Interfaces:**
- Consumes: `renderUserMenu` from `public/js/userMenu.js` (Task 3).
- Produces: the always-visible header now contains only `#sidebarAvatar` + `#sidebarUserName` (inside a `#userMenuTrigger` button) + the collapse-toggle button. `#sidebarUserRole` and `#envBadge` move into the dropdown panel (rendered by `userMenu.js`), so nothing in `app.js` needs to change.

- [ ] **Step 1: Replace the header markup in `public/js/sidebar.js`**

Add the import at the top of the file:

```js
import { t } from './i18n.js';
import { renderUserMenu } from './userMenu.js';
```

Currently, the `sidebarEl.innerHTML` template's header section reads:

```js
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
```

Replace this entire block with:

```js
    <div class="sidebar-header px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3" style="position:relative;">
      <button id="userMenuTrigger" type="button" class="flex items-center gap-2 min-w-0 flex-1" style="background:none;border:none;cursor:pointer;padding:0;text-align:left;">
        <div id="sidebarAvatar" class="w-9 h-9 rounded-full bg-gradient-to-tr from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black flex-shrink-0">U</div>
        <span id="sidebarUserName" class="text-base font-bold text-amber-400 truncate">User</span>
        <span class="user-menu-caret text-slate-500 flex-shrink-0" style="font-size:10px;">▾</span>
      </button>
      <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-slate-700 flex-shrink-0" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
      <div id="userMenuMount"></div>
    </div>
```

Then, at the end of `renderSidebar()` (after the `sidebarEl.innerHTML = ...` assignment, before the function's closing brace), add:

```js
  renderUserMenu(sidebarEl.querySelector('#userMenuMount'));
```

The full function now reads:

```js
export function renderSidebar(sidebarEl, activePage) {
  if (!sidebarEl) return;

  const navHtml = NAV_ITEMS.map(item => `
    <a href="${item.href}"${item.id ? ` id="${item.id}"` : ''} class="nav-item${item.page === activePage ? ' active' : ''}" title="${t(item.labelKey)}"${item.adminOnly ? ' style="display:none"' : ''}>
      <span class="text-lg">${item.icon}</span>
      <span class="nav-label" data-i18n="${item.labelKey}">${t(item.labelKey)}</span>
    </a>`).join('');

  sidebarEl.innerHTML = `
    <div class="sidebar-header px-5 py-4 border-b border-slate-700 flex items-center justify-between gap-3" style="position:relative;">
      <button id="userMenuTrigger" type="button" class="flex items-center gap-2 min-w-0 flex-1" style="background:none;border:none;cursor:pointer;padding:0;text-align:left;">
        <div id="sidebarAvatar" class="w-9 h-9 rounded-full bg-gradient-to-tr from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black flex-shrink-0">U</div>
        <span id="sidebarUserName" class="text-base font-bold text-amber-400 truncate">User</span>
        <span class="user-menu-caret text-slate-500 flex-shrink-0" style="font-size:10px;">▾</span>
      </button>
      <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-slate-700 flex-shrink-0" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
      <div id="userMenuMount"></div>
    </div>

    <nav class="flex-1 px-3 py-4 space-y-1">${navHtml}</nav>

    <div class="px-5 py-4 border-t border-slate-700 sidebar-footer">
      <div id="userInfo" class="text-xs text-slate-400"></div>
    </div>`;

  renderUserMenu(sidebarEl.querySelector('#userMenuMount'));
}
```

- [ ] **Step 2: Simplify the collapsed-state CSS in `public/css/style.css`**

Currently:

```css
.sidebar-collapsed .sidebar { width: 4.5rem; }
.sidebar-collapsed .sidebar-header {
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding-left: 0.5rem;
  padding-right: 0.5rem;
}
.sidebar-collapsed .sidebar-header .brand-meta,
.sidebar-collapsed #langSwitcher,
.sidebar-collapsed .sidebar-footer { display: none; }
.sidebar-collapsed .sidebar-header-controls { margin-left: 0; }
.sidebar-collapsed .nav-item {
  justify-content: center;
  padding-left: 0.5rem;
  padding-right: 0.5rem;
}
.sidebar-collapsed .nav-label { display: none; }
```

Replace with (the header now only ever has two direct children — the trigger button and the collapse button — so the `flex-wrap`/`.sidebar-header-controls` overflow-prevention plumbing from the previous fix is no longer needed; `#sidebarUserName`/the caret are hidden directly instead of via the retired `.brand-meta` wrapper):

```css
.sidebar-collapsed .sidebar { width: 4.5rem; }
.sidebar-collapsed .sidebar-header {
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding-left: 0.5rem;
  padding-right: 0.5rem;
}
.sidebar-collapsed #sidebarUserName,
.sidebar-collapsed .user-menu-caret,
.sidebar-collapsed .sidebar-footer { display: none; }
.sidebar-collapsed .nav-item {
  justify-content: center;
  padding-left: 0.5rem;
  padding-right: 0.5rem;
}
.sidebar-collapsed .nav-label { display: none; }
```

- [ ] **Step 3: Manually verify with a headless-browser harness**

This has no login dependency — build a standalone test file at a scratch location (e.g. the session scratchpad directory) that imports the real `renderSidebar` from `public/js/sidebar.js` (matching the approach used for the two prior sidebar fixes this session: since ES module imports across `file://` URLs get blocked by Chrome's CORS policy, serve `public/js/` and `public/css/` via a trivial local static file server rather than opening the file directly). Render with realistic data (username "deemo", role "ADMIN", env badge "PROD"), then using Puppeteer:

1. Screenshot the default state — confirm the header shows only avatar + "deemo" + a small ▾ caret + the collapse button, nothing else.
2. Click `#userMenuTrigger` — confirm the dropdown appears below it showing "ADMIN" + "PROD" badge, the EN/ខ្មែរ language switcher, and a "Sign out" row — and confirm via `getBoundingClientRect()` that the dropdown panel's right edge stays within the sidebar's own width (no bleed into main content).
3. Click somewhere outside the panel — confirm it closes (`#userMenuPanel` computed `display` is `none`).
4. Re-open it and press Escape — confirm it closes.
5. Toggle `sidebar-collapsed` on `document.body` — confirm `#sidebarUserName` and the caret are hidden, the avatar remains visible and centered, and clicking `#userMenuTrigger` still opens the dropdown correctly.

Expected: all five checks pass with no console errors and no element overlapping or extending outside the sidebar's width in either expanded or collapsed state.

- [ ] **Step 4: Commit**

```bash
git add public/js/sidebar.js public/css/style.css
git commit -m "refactor(sidebar): move Sign out/language switch into avatar dropdown"
```

---

### Task 5: Final sweep

**Files:**
- Modify: none expected (fix-up only, touching whatever the sweep finds)

**Interfaces:**
- Consumes: nothing new — this is a verification pass over everything Tasks 1-4 produced.

- [ ] **Step 1: Grep for any stray references to the removed always-visible header elements**

```bash
grep -rn "brand-meta\|sidebar-header-controls" public/ --include=*.js --include=*.css --include=*.html
```

Expected: no matches (both were fully retired in Task 4).

- [ ] **Step 2: Syntax-check every touched file**

```bash
node --check public/js/dateFilter.js
node --check public/js/sidebar.js
node --check public/js/userMenu.js
node --check public/js/pages/dashboard.js
node --check public/js/pages/report.js
```

Expected: no output from any command.

- [ ] **Step 3: Full click-through in both languages**

With the dev server running (`npm run dev:uat`, on a port that doesn't collide with any already-running instance), click through Dashboard, Report, Expenses, Receipts, Staff, and Users in English, then toggle to Khmer (`localStorage.setItem('pos_lang','km')` + reload) and repeat, watching the browser console for `[i18n] missing key` warnings. Specifically re-check:
- The avatar dropdown opens/closes correctly on every page, in both languages (the Sign out label and role/badge should read correctly in Khmer too).
- Dashboard's Gross Income chart label and Peak Hours heatmap label, and Report's Revenue Trend label, all show "Today"/"ថ្ងៃនេះ" or "Last 10 days"/"10ថ្ងៃចុងក្រោយ" or the correct custom date range — never raw text like "Period: today" or "(last10)".

Fix any warning or incorrect label found by adding the missing key to both dictionaries or correcting the call site.

- [ ] **Step 4: Commit any fixes found**

```bash
git add -A
git commit -m "fix: close gaps found in sidebar/period-label final sweep"
```

(Skip this commit if the sweep found nothing to fix.)
