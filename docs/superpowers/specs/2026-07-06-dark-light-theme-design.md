# Dark / Light Theme — Design Spec

**Goal:** Add a user-toggleable light theme alongside the existing dark theme, with full coverage across all 7 pages (`index`, `login`, `expenses`, `receipts`, `report`, `staff`, `users`), the sidebar/header/dropdown, and every Chart.js chart — not just the shell chrome touched in recent sessions.

**Context:** The app currently has no theming system at all: colors are hardcoded as literal hex values in ~150+ places, spread across `public/css/style.css`, five pages' own embedded `<style>` blocks (`receipts.html`, `report.html`, `staff.html`, `users.html`, and `login.html` — the last of which doesn't even link `style.css`, running an entirely separate, duplicated color-variable system), and several JS files that configure Chart.js with literal hex colors (`charts.js`, and the chart-consuming page modules `dashboard.js`, `report.js`, `staff.js`, `receipts.js`, `users.js`, `schedule.js`). This fragmentation was directly responsible for a bug earlier this session (a flag-icon fix applied to the shared `style.css` component silently missed `login.html`'s private duplicate copy). Introducing theming is the forcing function to consolidate this.

**Scope revision:** an initial hex-color survey (~150 hits) missed a second, larger source of hardcoded chrome: 134 instances of Tailwind's own utility classes (`bg-slate-800`, `border-slate-700`, `text-slate-400`, etc.) hardcoded directly in each page's static markup (body/header/sidebar/tables) across `index.html`, `expenses.html`, `receipts.html`, `report.html`, `staff.html`, `users.html`. These bypass our CSS variables entirely, since Tailwind's CDN build has no awareness of our custom `data-theme` attribute. This roughly doubles the migration surface and is addressed via Tailwind's own dark-mode variant mechanism (below) rather than replacing them with custom classes, to stay consistent with the project's existing Tailwind-first convention.

---

## Architecture

**CSS custom properties + a `data-theme` attribute.** All themable colors move to named CSS variables defined on `:root` in `style.css` (dark values = today's exact colors, so the dark theme has zero visual regression), with a `[data-theme="light"]` block overriding them. Toggling `document.documentElement.dataset.theme` between `'dark'` and `'light'` is the entire runtime mechanism — no JavaScript re-styling needed for anything CSS-driven.

**Persistence + flash prevention.** `localStorage.pos_theme` stores `'dark'` or `'light'` (mirroring the existing `pos_lang` convention). Each page's `<head>` gets a small inline script, before any stylesheet/content, that reads this value and sets `data-theme` immediately — preventing a flash of the wrong theme on load. This is new infrastructure the codebase doesn't have for anything else (language switching currently has no such guard and briefly shows untranslated text), but a full-color flash is a much more jarring defect than a text flash, so it's justified specifically for this feature.

**Chart.js.** Charts render to `<canvas>`, so they cannot pick up CSS variables via the cascade. `charts.js`'s option-builder functions (`chartOpts()`, `barOpts()`, etc.) read the resolved values at chart-creation time via `getComputedStyle(document.documentElement).getPropertyValue('--chart-grid')` (and similar), rather than hardcoding hex. This keeps one source of truth (the CSS variables) instead of a parallel JS palette that could drift out of sync.

**Toggle behavior: reload, not live-swap.** Clicking the toggle sets `localStorage.pos_theme` and calls `location.reload()` — identical to how the existing language switcher (`renderLangSwitcher()`) already behaves. This means every chart simply re-initializes with the correct theme's colors on the next load; no page needs to listen for a "theme changed" event and live-update its Chart.js instances. This trades a full reload for a large reduction in moving parts and risk.

**Tailwind's own dark-mode variant, for the 134 hardcoded Tailwind utility classes.** Each Tailwind-CDN page (all except `login.html`, which doesn't load Tailwind) gets a small inline `<script>tailwind.config = { darkMode: 'class' }</script>` placed before the CDN `<script src="https://cdn.tailwindcss.com">` tag. The same init/toggle logic that sets `data-theme` also toggles a `.dark` class on `<html>` — two attributes driven by one action, since our hand-rolled CSS variables and Tailwind's utilities are two different engines that both need to hear about a theme change. Existing bare utility classes (e.g. `bg-slate-800`) are rewritten with an explicit light default plus a `dark:`-prefixed version of the current value (e.g. `bg-white dark:bg-slate-800`), so light mode is the new default appearance and dark mode (today's look) requires `.dark` to be present — matching the "dark theme has zero visual regression" requirement above.

## Palette

Dark theme values are today's exact colors, formalized as variables (illustrative, not exhaustive — see Migration Scope):

| Variable | Dark (today) | Light |
|---|---|---|
| `--bg-canvas` (page background) | `#0f172a` | `#f1f5f9` |
| `--bg-surface` (sidebar/cards/panels) | `#1e293b` | `#ffffff` |
| `--border` | `#334155` | `#e2e8f0` |
| `--border-subtle` | `#1f2d45` | `#f1f5f9` |
| `--text-primary` | `#e2e8f0` | `#0f172a` |
| `--text-secondary` | `#94a3b8` | `#475569` |
| `--text-muted` | `#64748b` | `#64748b` |
| `--accent` (brand amber) | `#f59e0b` | `#f59e0b` (unchanged) |
| `--accent-strong` (active-nav text) | `#fbbf24` | `#b45309` |

Surfaces in light mode use a subtle `box-shadow` instead of a hard `border` for the "cards float on a soft gray canvas" depth cue chosen during design (Option B). Semantic colors — PROD red `#dc2626`, UAT green `#16a34a`, up/down badge greens/reds — are reused unchanged in both themes; they already have sufficient contrast on white.

`staff.html`'s embedded styles alone carry 30+ distinct one-off hex colors (status/role badges, several already light-oriented like `#f8fafc`/`#fef08a`). Not all of these necessarily map to the core role variables above — some may be intentionally-fixed status colors that shouldn't change with theme (to be judged file-by-file during implementation, using the table above as the default mapping and adding new narrowly-scoped variables only where an existing role doesn't fit).

## Toggle UI

A sun/moon inline SVG icon (same technique as the recently-added flag icons — not emoji, for guaranteed consistent cross-platform rendering), placed in the always-visible sidebar header next to the language flags. Visible in both expanded and collapsed sidebar states, following the same layout precedent set by the flag icons (stacks below the avatar in the collapsed 72px rail).

## Migration Scope

- **`public/css/style.css`**: introduce the `:root`/`[data-theme="light"]` variable blocks; migrate every hardcoded color in this file to `var()`.
- **`public/js/charts.js`**: `chartOpts()`, `barOpts()`, `heatColor()`, and friends read colors via `getComputedStyle` instead of literal hex.
- **Page modules configuring charts**: `dashboard.js`, `report.js`, `staff.js`, `receipts.js`, `users.js`, `schedule.js` — audit for any additional hardcoded chart colors beyond what `charts.js` centralizes.
- **`receipts.html`, `report.html`, `staff.html`, `users.html`**: these already link `style.css`, so their embedded `<style>` blocks' hardcoded colors convert to reference the same `var()`s (CSS variables cascade regardless of which stylesheet declares vs. consumes them).
- **`login.html`**: consolidated onto the shared `style.css` variable system. Its private `:root` block (`--navy`, `--amber`, `--border`, `--text`, `--muted`, etc.) is removed; it adds a `<link rel="stylesheet" href="/css/style.css">` and an inline theme-init script matching the other pages.
- **`public/js/sidebar.js`, `public/js/userMenu.js`**: inline colors in their JS-generated markup (template literals) move to CSS classes backed by variables, following the pattern already used for `.user-menu-panel`, `.lang-btn`, etc.
- **`index.html`, `expenses.html`, `receipts.html`, `report.html`, `staff.html`, `users.html`**: the 134 hardcoded Tailwind slate utility classes in each page's markup get the `tailwind.config` snippet added and are rewritten to light-default + `dark:`-prefixed pairs.
- **New**: `public/js/themeToggle.js`, a sun/moon toggle component mirroring `userMenu.js`'s "render into a mount point" pattern + the `:root` variable tables in `style.css` + per-page inline flash-prevention scripts (which now also toggle the `.dark` class for Tailwind).

## Testing

No automated test suite exists in this repo (confirmed in `CLAUDE.md` and prior sessions). Verification is a headless-browser (Puppeteer) pass, extending the pattern already used for the sidebar/flag work this session:
1. Toggle renders and functions in both expanded and collapsed sidebar states, alongside the language flags and collapse button, with no overflow.
2. Every one of the 7 pages, in both themes: visually legible (no white-text-on-white or dark-text-on-dark regressions), charts render with theme-appropriate grid/tick/legend colors, and no `[data-theme]` mismatch flash on load.
3. Grep sweep confirming no remaining hardcoded hex colors in the migrated files' themable properties (status/semantic colors intentionally excluded per the Palette section).
4. `login.html` specifically: confirm it now renders identically to before in dark mode after consolidating onto the shared variable system (no regression from removing its private `:root` block), and correctly in light mode.
