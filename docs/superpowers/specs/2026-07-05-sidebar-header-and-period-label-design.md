# Sidebar Header Redesign & Chart Period-Label Fix — Design Spec

**Goal:** (1) Redesign the sidebar header so Sign out and language switching live in a dropdown menu triggered by clicking the avatar/username, decluttering the always-visible header down to just identity + collapse toggle; (2) fix three chart/heatmap period-range labels that currently show broken or misleading text after the date-filter refactor, and make the fixed labels visually prominent instead of muted gray.

**Context:** During the recent sidebar-overflow bug investigation, the header was found to be structurally overcrowded (avatar, username, env badge, role, Sign out, language switcher, and collapse toggle all fighting for space in a 272px-wide column). The user has now asked for a proper redesign rather than another patch. Separately, while investigating "the period display on chart is look slate," a second, unrelated regression was found: `loadGrossIncomeTrend()`/`loadRevenueTrend()`/`loadPeakHours()` still branch on the retired `week`/`month`/`year` period values from before the date-filter refactor, so for the current `today`/`last10` presets they render nonsense (`"Period: today"`, literal `"(last10)"`, or — on Report — always `"Last year"` regardless of the actual selection).

---

## A) Sidebar header redesign

**New component:** `public/js/userMenu.js`, exporting `renderUserMenu(mountEl, user)` — follows the same "render markup into a mount point" pattern as this session's `sidebar.js`/`dateFilter.js`.

**Always-visible header** (inside `sidebar.js`'s existing `.sidebar-header`, replacing everything currently there except the collapse button): avatar + username + a small `▾` caret hinting the row is clickable. Clicking anywhere on this row toggles the dropdown. No env badge, no role, no Sign out, no language switcher in the always-visible row anymore.

**Dropdown panel** (rendered by `userMenu.js`, absolutely positioned below the avatar row, right-aligned within the sidebar, `z-index` above nav content): three stacked sections —
1. An info row showing role (e.g. "ADMIN") and the env badge (UAT/PROD) side by side, read-only.
2. The language switcher, reusing the existing `renderLangSwitcher(container)` from `i18n.js` unchanged (same EN/ខ្មែរ pill buttons, same reload-on-switch behavior).
3. A "Sign out" row/button, calling the existing `logout()`.

**Interaction:** clicking the avatar/username row toggles the dropdown open/closed. Clicking anywhere outside the dropdown, or pressing Escape, closes it. Opening the dropdown while collapsed works the same way — collapsed mode only hides the username/caret (avatar remains clickable), matching the existing collapse pattern.

**Collapsed state:** since the header now only ever contains avatar + username + caret + collapse button (no more env badge/langSwitcher/Sign out competing for space), the `flex-wrap` overflow-prevention CSS added during the recent bug fix becomes unnecessary dead weight — it's removed as part of this change, along with the now-unused `.sidebar-header-controls` class and its collapsed-mode override. The collapsed layout simplifies back to: avatar centered, collapse button below it (same vertical stack as before), no wrapping logic needed since there's nothing left to overflow.

**Wiring:** `sidebar.js`'s `renderSidebar()` calls `renderUserMenu()` once, passing a mount point inside the header; `app.js`'s bootstrap sequence is unaffected (still calls `renderSidebar()` first, then `renderUserHeader()`/`renderEnvBadge()` which continue to populate `#sidebarUserName`/`#sidebarAvatar`/`#envBadge`/`#sidebarUserRole` — these element IDs don't change, only where they're positioned in the DOM, so no other file needs updating).

## B) Chart period-label fix

**New shared helper**, added to `public/js/dateFilter.js` (it already owns period semantics via `resolveDates()`):

```js
export function periodLabel(period, start, end) {
  if (period === 'range') return `${start} → ${end}`;
  if (period === 'last10') return t('common.last10Days');
  return t('common.today');
}
```

**Three call sites corrected** to use this helper instead of their stale week/month/year ternaries:
- `public/js/pages/dashboard.js` → `loadGrossIncomeTrend()`'s `#grossIncomeLabel` text.
- `public/js/pages/dashboard.js` → `loadPeakHours()`'s `#heatmapRangeLabel` text (drops the old parenthesized wrapping, e.g. `(today)` — the pill styling in Section B below already visually sets it apart, so parentheses are redundant).
- `public/js/pages/report.js` → `loadRevenueTrend()`'s `#revTrendLabel` text.

**Retired dictionary keys removed** once nothing references them: `dashboard.grossIncomeRangeCustom`, `dashboard.grossIncomeRangeWeek`, `dashboard.grossIncomeRangeMonth`, `dashboard.grossIncomeRangeYear`, `dashboard.grossIncomeRangePeriod`, `report.trendRangeCustom` (all superseded by `periodLabel()` + the existing `common.today`/`common.last10Days` keys).

**Visual restyle:** all three labels change from `class="text-xs text-slate-400"` to a small amber pill, matching the visual language already used for badges elsewhere in the app (e.g. `staff.html`'s status badges): `background: rgba(245,158,11,.12); color: #fbbf24; padding: 2px 8px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600;` — added as a new `.period-badge` class in `style.css` rather than inline styles, applied to all three elements.

## Verification

No test suite exists in this repo (confirmed earlier in this project). Verification is:
1. A headless-browser check (same puppeteer-core approach used for the two prior sidebar fixes this session) driving the real `renderSidebar()`/`renderUserMenu()`/`periodLabel()` source with realistic data — confirming the dropdown opens/closes correctly, outside-click and Escape close it, the language switcher and Sign out inside it still work, and the three period labels show correct text for `today`, `last10`, and a custom `range`.
2. Manual grep sweep for any remaining references to the retired dictionary keys and the old always-visible Sign out/langSwitcher/role/env-badge header markup, confirming full migration.
