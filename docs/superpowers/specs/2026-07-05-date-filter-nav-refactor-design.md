# Date Filter & Shared Sidebar Refactor — Design Spec

**Goal:** (1) Replace the inconsistent, page-specific date-range controls on Dashboard/Report/Receipts/Expenses with one shared, per-page-configurable filter component and new preset lists; (2) eliminate the sidebar `<nav>` markup (and its `<style>` block) that is currently duplicated byte-for-byte across all 6 authenticated HTML pages, replacing it with a single JS-rendered component.

**New preset lists (dropping Week/Month/Year entirely from the UI):**

| Page | Presets | Default |
|---|---|---|
| Dashboard | Today, Last 10 days, Custom | Today |
| Report | Last 10 days, Custom | Last 10 days |
| Receipts | Today, Custom | Today |
| Expenses | Today, Custom | Today |

**Non-goals:** No new npm dependencies, no build step (matches the project's existing zero-build-step, vanilla-ES-module architecture per `CLAUDE.md`). Not touching `public/js/dashboard.js` (pre-existing dead code, out of scope, same exclusion as the i18n project). Not changing the Staff/Schedule/Users pages' filters (they don't have date-range filters today). Not adding filter-choice persistence (localStorage) — matches existing behavior where the period resets to the page default on every reload.

---

## A) Backend — new `last10` period

`utils/date.js` currently switches on `period` in five functions (`buildPeriodFilter`, `getTrendPeriod`, `getPrevPeriodSQL`, `getPeriodDateRange`, `getPrevPeriodDateRange`), each with cases for `today`/`week`/`month`/`year`/`range`. Add a `last10` case to all five, mirroring the existing `week` pattern:

- **Current period:** `CURRENT_DATE - INTERVAL '10 days'` through `CURRENT_DATE` (mirrors `week`'s `-7 days` pattern exactly).
- **Comparison period** (`getPrevPeriodSQL`/`getPrevPeriodDateRange`): the preceding 10-day block, `CURRENT_DATE - INTERVAL '20 days'` through `CURRENT_DATE - INTERVAL '10 days'` (mirrors `week`'s `-13`/`-7` pattern).
- **Trend granularity** (`getTrendPeriod`): `day` (same as `week`).

The existing `week`/`month`/`year` cases stay in the file untouched — after this change the frontend will only ever send `today`, `last10`, or `range` as the `period` param, so those branches become dormant but harmless (no code deletion, avoids breaking anything else that might construct a URL with those values, e.g. saved bookmarks).

Receipts and Expenses do **not** need a `period` query param — their APIs already accept explicit `start`/`end` dates, and "Today" there just resolves to `start=end=<today>` client-side, exactly as today's default already works.

**Pre-existing quirk, fixed as part of this change:** `getPrevPeriodDateRange('today')` currently compares "today" against 2 days ago rather than yesterday (`now.subtract(2, 'day')`). Since "Today" is about to become the default view on 3 of the 4 affected pages, this is corrected to `now.subtract(1, 'day')` as part of this same change, so the growth % shown on the new default view is correct from day one.

## B) Shared sidebar component

**New file:** `public/js/sidebar.js`

```js
export function renderSidebar(mountEl, activePage) { ... }
```

A single array inside this module drives the nav:

```js
const NAV_ITEMS = [
  { page: 'dashboard', href: '/',              icon: '📊', labelKey: 'nav.dashboard' },
  { page: 'expenses',  href: '/expenses.html',  icon: '💸', labelKey: 'nav.expenses'  },
  { page: 'report',    href: '/report.html',    icon: '📋', labelKey: 'nav.reports'   },
  { page: 'receipts',  href: '/receipts.html',  icon: '🧾', labelKey: 'nav.receipts'  },
  { page: 'staff',     href: '/staff.html',     icon: '👥', labelKey: 'nav.staff'     },
  { page: 'users',     href: '/users.html',     icon: '⚙️', labelKey: 'nav.users', id: 'navUsers', adminOnly: true },
];
```

`renderSidebar` builds the full `<aside class="sidebar">` innerHTML: the header (avatar, `sidebarUserName`, `envBadge`, `sidebarUserRole`, the static sign-out button, the `#langSwitcher` mount, the collapse button), the `<nav>` list (marking the item matching `activePage` with `.active`, and rendering `navUsers` with `style="display:none"` exactly as today so `applyPermissions()`'s existing admin-visibility logic keeps working unchanged), and the footer (`sidebar-footer > #userInfo`, left empty for `renderUserHeader()` to fill).

Each of the 6 HTML pages (`index.html`, `expenses.html`, `receipts.html`, `staff.html`, `report.html`, `users.html`) shrinks its `<aside id="sidebar">...</aside>` block down to:

```html
<aside id="sidebarMount"></aside>
```

The shared CSS currently copy-pasted into every page's `<style>` block (`.sidebar`, `.sidebar-collapsed *`, `.nav-item`, `.sidebar-overlay`, the `@media (max-width:767px)` rules) moves once into `public/css/style.css`; each page's local `<style>` block keeps only page-specific rules.

**Wiring in `app.js`:** `detectPage()` already exists and returns the exact page-key strings (`'dashboard'`, `'expenses'`, `'receipts'`, `'staff'`, `'users'`, `'report'`) that `NAV_ITEMS[].page` uses, so `sidebar.js` is wired with zero new page-detection logic. Because `renderSidebar()` creates the DOM nodes that `renderUserHeader()`, `applyPermissions()`, `applyTranslations()`, and `renderLangSwitcher()` all populate, it must run **first**, before those four calls, in the `DOMContentLoaded` handler.

## C) Shared date-filter component

**New file:** `public/js/dateFilter.js`

```js
export function renderDateFilter(mountEl, { presets, defaultPreset, onChange }) { ... }
```

- `presets`: ordered array of `{ key, labelKey }`, e.g. `[{key:'today', labelKey:'common.today'}, {key:'last10', labelKey:'common.last10Days'}]`.
- Renders one pill button per preset plus a trailing "Custom" pill (`common.custom`).
- Clicking a preset pill sets it active and immediately calls `onChange({ period: key, start: '', end: '' })`.
- Clicking "Custom" reveals From/To date inputs + an Apply button inline (hidden otherwise — this replaces the current design where both preset buttons and date inputs are always visible simultaneously). Clicking Apply validates non-empty and `start <= end` (reusing the existing `dashboard.errorMissingDates`/`dashboard.errorDateOrder` messages) and calls `onChange({ period: 'range', start, end })`.
- `mountEl.dataset` is not used for config — presets/callback are passed directly as JS, matching how `renderLangSwitcher(container)` already works (config-by-argument, not config-by-markup).

**Per-page wiring** (each page's `init()` calls `renderDateFilter` once, with a callback that reuses that page's existing state-update + reload function — no reload logic is rewritten, only how the UI feeds it):

| Page | Presets | Default | onChange calls |
|---|---|---|---|
| `dashboard.js` | today, last10 | today | sets `state.currentPeriod`/`currentStartDate`/`currentEndDate` then `loadAll()` (same body `setPeriod`/`applyCustomRange` already have — those two functions get simplified to take `{period,start,end}` directly instead of reading `.period-btn.active`/`#startDate`/`#endDate` from the DOM) |
| `report.js` | last10 | last10 | same pattern as dashboard, applied to `report.js`'s `setPeriod`/`applyCustomRange` |
| `receipts.js` | today | today | sets `#filterStart`/`#filterEnd` values (or equivalent internal state) then `loadReceipts()` |
| `expenses.js` | today | today | sets `state.expenseFilterStartDate`/`expenseFilterEndDate` then `applyExpenseFilters()` |

The existing `#startDate`/`#endDate`/`#filterStart`/`#filterEnd`/`#expensesStartDate`/`#expensesEndDate` raw `<input type=date>` elements and the old always-visible period-button markup are removed from each page's HTML, replaced by one `<div id="dateFilterMount"></div>` each.

## D) i18n additions

New shared keys (both `en.js`/`km.js`), replacing the now-unused `dashboard.periodWeek/Month/Year/Custom`, `dashboard.from/to`, `receipts.from/to`, `expenses.start/end`:

- `common.today` — "Today"
- `common.last10Days` — "Last 10 days"
- `common.custom` — "Custom"
- `common.from` — "From"
- `common.to` — "To"

(`dashboard.periodPerformance`/`dailyBenchmarks` and other non-filter dashboard keys are untouched.) Dictionary symmetry re-verified with the same `node --check` + key-diff approach used throughout the i18n project.

## Verification plan

No test suite exists in this repo (matches prior finding). Verification is manual, via the running dev server (`npm run dev:uat`):

1. Confirm each of the 4 pages loads with the correct default preset active and correct data.
2. Confirm switching presets reloads data correctly (spot-check `last10` numbers against a manual date-range query).
3. Confirm "Custom" reveals the date inputs, validates empty/out-of-order dates, and applies correctly.
4. Confirm the sidebar renders identically (nav items, active-page highlight, collapse behavior, admin-only Users item, language switcher, sign-out) on all 6 pages, in both English and Khmer.
5. Resize to mobile width and confirm the hamburger/overlay sidebar behavior is unchanged.
