# Dark / Light Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-toggleable light theme alongside the existing dark theme, with full coverage across all 7 pages, the sidebar/header/dropdown, and every Chart.js chart.

**Architecture:** CSS custom properties on `:root`/`[data-theme="light"]` in `style.css` drive all hand-rolled styling; Tailwind's own `darkMode: 'class'` variant (a `.dark` class on `<html>`) drives the 147 hardcoded Tailwind utility classes already in page markup; Chart.js reads resolved CSS variable values via `getComputedStyle` at chart-creation time. A single toggle click sets `localStorage.pos_theme` and reloads — no live re-theming code anywhere.

**Tech Stack:** Vanilla ES modules, Tailwind CDN (`https://cdn.tailwindcss.com`), Chart.js. No new npm dependencies, no build step.

## Global Constraints

- No new npm dependencies, no build step.
- Dark theme = today's exact colors. Zero visual regression for anyone who never toggles.
- Default theme for a first-time visitor is dark; `localStorage.pos_theme` (`'dark'` | `'light'`) persists the choice, mirroring the existing `pos_lang` convention.
- Toggle behavior is reload-on-click (`location.reload()`), identical to the existing language switcher — never a live CSS/JS re-theme.
- The toggle UI is a sun/moon inline SVG pair (not emoji), styled and positioned exactly like the existing flag-icon language switcher (`.lang-switch`/`.lang-btn` in `public/css/style.css`), in the always-visible sidebar header, visible in both expanded and collapsed states.
- Amber accent (`#f59e0b`) and all semantic/status colors (PROD/UAT env badge, up/down badges, KPI category colors, chart series colors, role/status badges) stay fixed in both themes — never migrated to a themed variable.
- Text sitting on an amber-background element (buttons, active pills) always stays a fixed dark color in both themes — never a themed variable, since amber needs dark text for contrast regardless of theme.
- `staff.html`'s `.rst-*` roster/spreadsheet classes and its `@media print` block, and `receipts.js`'s printable-receipt HTML template, are deliberately fixed light/white "paper" styling — never migrated, in either theme.
- `login.html` is consolidated onto the shared `style.css` variable system; its private `:root` block is removed.
- Spec: `docs/superpowers/specs/2026-07-06-dark-light-theme-design.md`

---

### Task 1: CSS variable foundation in `style.css`

**Files:**
- Modify: `public/css/style.css`

**Interfaces:**
- Produces: the CSS custom properties every later task consumes — `--bg-canvas`, `--bg-surface`, `--bg-surface-alt`, `--border`, `--border-subtle`, `--border-strong`, `--border-translucent`, `--text-primary`, `--text-secondary`, `--text-dim`, `--text-muted`, `--text-label`, `--accent`, `--accent-strong`, `--heatmap-empty`.

- [ ] **Step 1: Insert the variable blocks at the very top of `style.css`**

Insert this as the new first lines of the file (before the existing `/* Cards */` comment):

```css
:root {
  --bg-canvas: #0f172a;
  --bg-surface: #1e293b;
  --bg-surface-alt: #131f2e;
  --border: #334155;
  --border-subtle: #1f2d45;
  --border-strong: #475569;
  --border-translucent: rgba(51,65,85,.5);
  --text-primary: #e2e8f0;
  --text-secondary: #94a3b8;
  --text-dim: #475569;
  --text-muted: #64748b;
  --text-label: #4b6280;
  --accent: #f59e0b;
  --accent-strong: #fbbf24;
  --heatmap-empty: #1e293b;
}

[data-theme="light"] {
  --bg-canvas: #f1f5f9;
  --bg-surface: #ffffff;
  --bg-surface-alt: #f8fafc;
  --border: #e2e8f0;
  --border-subtle: #f1f5f9;
  --border-strong: #cbd5e1;
  --border-translucent: rgba(226,232,240,.6);
  --text-primary: #0f172a;
  --text-secondary: #475569;
  --text-dim: #94a3b8;
  --text-muted: #64748b;
  --text-label: #94a3b8;
  --accent: #f59e0b;
  --accent-strong: #b45309;
  --heatmap-empty: #e2e8f0;
}
```

- [ ] **Step 2: Apply this exact mapping throughout the rest of the file**

Replace every occurrence of the literal value on the left with the CSS expression on the right, wherever it appears in a `color`, `background`, `background-color`, or `border`/`border-*-color` declaration in `style.css` (the file as it exists today, i.e. everything after the block from Step 1):

| Literal value | Replace with |
|---|---|
| `#1e293b` (**except** `.heatmap-cell` — see override note below the table) | `var(--bg-surface)` |
| `#334155` | `var(--border)` |
| `#4b6280` | `var(--text-label)` |
| `#475569` (as a **border** color, e.g. `.kpi-primary`'s `border-left`, the scrollbar thumb) | `var(--border-strong)` |
| `#475569` (as a **text** color, e.g. `.kpi-primary-sub`, `.heatmap-hour-label`) | `var(--text-dim)` |
| `rgba(51,65,85,.5)` | `var(--border-translucent)` |
| `#1e3448` (the one-off `.kpi-avg` border) | `var(--border)` |
| `#131f2e` | `var(--bg-surface-alt)` |
| `#374f6b` (`.kpi-avg-sub`) | `var(--text-label)` |
| `#e2e8f0` (as **text**, e.g. `.section-title`, `.filter-select`) | `var(--text-primary)` |
| `#cbd5e1` (`.legend-item`) | `var(--text-primary)` |
| `#94a3b8` (as **text**, e.g. `.period-btn`/`.trend-btn`, `.heatmap-label`) | `var(--text-secondary)` |
| `#64748b` (as **text**, e.g. `.kpi-primary-lbl`) | `var(--text-muted)` |
| `#f59e0b` (as `border-color`/`background` for **active/focus state**, e.g. `.period-btn.active`/`.trend-btn.active` background, `.filter-select:focus` border-color) | `var(--accent)` |
| `#0f172a` (as background in `.lang-switch`) | `var(--bg-canvas)` |
| `#1f2d45` (`.lang-switch` border) | `var(--border-subtle)` |

**Do NOT touch these — they are semantic/fixed and stay literal in both themes:**
- `.kpi-primary--amber/--emerald/--red/--blue` and their `::after` (`#f59e0b`, `#10b981`, `#f87171`, `#60a5fa`) and the matching `.kpi-icon--*` rgba backgrounds.
- `.kpi-avg--amber/--red/--emerald/--violet` border-top-colors and `.kpi-avg--highlight.*` rgba backgrounds/borders.
- `.period-btn.active`/`.trend-btn.active`'s `color: #0f172a` (dark text fixed on the amber active background — do not touch even though `#0f172a` also happens to be `--bg-canvas`'s dark value; this one is a "text on amber" case per Global Constraints, not a canvas background).
- `.badge-up`, `.badge-down`, `.badge-flat` (all colors, including `.badge-flat`'s `#64748b`, which coincidentally matches `--text-muted` but is grouped with its semantic siblings).
- `#envBadge[data-env="PROD"]` / `#envBadge[data-env="UAT"]`.
- `.cancel-row` (`#2d1515` background, `#7f1d1d` border).
- `.lang-btn.active`'s `rgba(245,158,11,.18)` background and `rgba(245,158,11,.5)` box-shadow.
- `.user-menu-signout`'s `color: #f87171` and its `:hover` background `rgba(248,113,113,.1)` (semantic "destructive action" red, same family as `.badge-down`/`.error-msg`).

**One override to the general table above:** `.heatmap-cell`'s `background: #1e293b` does **not** follow the generic `#1e293b → var(--bg-surface)` rule — map it to `var(--heatmap-empty)` instead. These two variables share the same dark value today but diverge in light mode (`--bg-surface` light is pure white; `--heatmap-empty` light is `#e2e8f0`, so an empty heatmap cell still reads as a visible grid cell against a white page instead of disappearing into the background). This also keeps `.heatmap-cell` in sync with `charts.js`'s `heatColor()` zero-ratio case, which Task 8 wires to the same `--heatmap-empty` variable.

- [ ] **Step 3: Verify**

```bash
node -e "require('fs').readFileSync('public/css/style.css','utf8')" && echo "readable"
grep -c "var(--" public/css/style.css
```

Expected: no errors; the `grep -c` count is well over 30 (confirms substitutions landed).

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css
git commit -m "feat(theme): add CSS variable foundation for dark/light theming"
```

---

### Task 2: `themeToggle.js` sun/moon toggle component

**Files:**
- Create: `public/js/themeToggle.js`
- Modify: `public/css/style.css`

**Interfaces:**
- Produces: `getTheme()`, `setTheme(theme)`, `applyTheme(theme)`, `renderThemeToggle(mountEl)` — named exports. `renderThemeToggle` follows the exact same "render into a mount point, two icon buttons, click-to-select, active-state highlight" pattern as `renderLangSwitcher` in `i18n.js`. Consumed by Task 3's `sidebar.js` wiring.

- [ ] **Step 1: Create `public/js/themeToggle.js`**

```js
// public/js/themeToggle.js
const THEME_KEY = 'pos_theme';

const ICONS = {
  light: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
  dark: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.3 2a9 9 0 1 0 9.7 13.3A9.4 9.4 0 0 1 12.3 2Z"/></svg>`,
};

export function getTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'light' ? 'light' : 'dark';
}

export function setTheme(theme) {
  localStorage.setItem(THEME_KEY, theme === 'light' ? 'light' : 'dark');
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function renderThemeToggle(mountEl) {
  if (!mountEl) return;
  const theme = getTheme();
  mountEl.innerHTML = `
    <div class="theme-switch" role="group" aria-label="Theme">
      <button type="button" class="theme-btn${theme === 'light' ? ' active' : ''}" data-theme-choice="light" title="Light" aria-label="Light theme">${ICONS.light}</button>
      <button type="button" class="theme-btn${theme === 'dark' ? ' active' : ''}" data-theme-choice="dark" title="Dark" aria-label="Dark theme">${ICONS.dark}</button>
    </div>`;
  mountEl.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const choice = btn.dataset.themeChoice;
      if (choice === getTheme()) return;
      setTheme(choice);
      location.reload();
    });
  });
}
```

- [ ] **Step 2: Add `.theme-switch`/`.theme-btn` CSS**

Append to the end of `public/css/style.css` (mirrors `.lang-switch`/`.lang-btn` exactly, using `currentColor`-based SVGs so no separate icon coloring is needed):

```css

/* ── theme switch (sun/moon) ──────────────────────────────── */
.theme-switch {
  display: flex;
  gap: 4px;
  background: var(--bg-canvas);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 2px;
}
.theme-btn {
  border: none;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-muted);
  opacity: .55;
  transition: opacity .15s, color .15s, background-color .15s;
}
.theme-btn svg { width: 18px; height: 18px; display: block; }
.theme-btn:hover { opacity: .85; }
.theme-btn.active {
  opacity: 1;
  color: var(--accent-strong);
  background: rgba(245,158,11,.18);
  box-shadow: 0 0 0 1px rgba(245,158,11,.5) inset;
}
.sidebar-collapsed .theme-switch { gap: 3px; padding: 2px; }
.sidebar-collapsed .theme-btn { padding: 3px; }
.sidebar-collapsed .theme-btn svg { width: 14px; height: 14px; }
```

- [ ] **Step 3: Manually verify**

```bash
node --check public/js/themeToggle.js
```

Expected: no output. (No page mounts this yet — Task 3 wires it into `sidebar.js`.)

- [ ] **Step 4: Commit**

```bash
git add public/js/themeToggle.js public/css/style.css
git commit -m "feat(theme): add sun/moon theme toggle component"
```

---

### Task 3: Wire the toggle into `sidebar.js`; theme-enable `index.html` and `expenses.html`

**Files:**
- Modify: `public/js/sidebar.js`
- Modify: `public/index.html`
- Modify: `public/expenses.html`

**Interfaces:**
- Consumes: `renderThemeToggle` from `public/js/themeToggle.js` (Task 2).

- [ ] **Step 1: Wire `renderThemeToggle` into `sidebar.js`**

Add to the top of `public/js/sidebar.js` (alongside the existing `renderLangSwitcher` import):

```js
import { renderThemeToggle } from './themeToggle.js';
```

In the header markup (the `sidebarEl.innerHTML` template), add a new mount div immediately after the existing `<div id="sidebarLangSwitcher" class="flex-shrink-0"></div>`:

```html
      <div id="sidebarThemeToggle" class="flex-shrink-0"></div>
```

At the end of `renderSidebar()`, add a call alongside the existing `renderLangSwitcher(...)` line:

```js
  renderThemeToggle(sidebarEl.querySelector('#sidebarThemeToggle'));
```

- [ ] **Step 2: Add the flash-prevention + Tailwind config scripts to `index.html`'s `<head>`**

**Important ordering note (found during implementation):** the Tailwind Play CDN only defines the global `tailwind` object once its own `<script src="https://cdn.tailwindcss.com">` tag has executed. Setting `tailwind.config` in a `<script>` block placed *before* that tag throws `ReferenceError: tailwind is not defined` and aborts the rest of that script's execution. The config script must go *after* the CDN script tag, not before.

In `public/index.html`, immediately *before* the existing `<script src="https://cdn.tailwindcss.com"></script>` line, insert the flash-prevention script:

```html
<script>
  (function() {
    var t = localStorage.getItem('pos_theme') === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    document.documentElement.classList.toggle('dark', t === 'dark');
  })();
</script>
```

Then, immediately *after* the `<script src="https://cdn.tailwindcss.com"></script>` line, insert the config script:

```html
<script>tailwind.config = { darkMode: 'class' };</script>
```

(The flash-prevention logic is duplicated inline, not imported from `themeToggle.js`'s `applyTheme()`, because it must run synchronously before first paint — an ES module import cannot be relied on to complete before the browser paints. This same block pair — flash-prevention script before the CDN tag, config script after it — is repeated in every Tailwind-using page touched by this plan.)

- [ ] **Step 3: Rewrite `index.html`'s Tailwind utility classes**

Apply this exact mapping to every occurrence in `public/index.html`:

| Existing class | Replace with |
|---|---|
| `bg-slate-900` | `bg-slate-100 dark:bg-slate-900` |
| `bg-slate-800` | `bg-white dark:bg-slate-800` |
| `border-slate-700` | `border-slate-200 dark:border-slate-700` |
| `hover:bg-slate-700` | `hover:bg-slate-200 dark:hover:bg-slate-700` |
| `text-slate-400` | `text-slate-600 dark:text-slate-400` |
| `text-slate-500` | *(leave unchanged — reads fine on both themes)* |
| `text-white` | `text-slate-900 dark:text-white` |
| `hover:text-slate-200` | `hover:text-slate-700 dark:hover:text-slate-200` |

**Exception — do NOT change:** the `text-slate-900` on the "Sync Gross Income" button (`id="syncBtn"`, paired with `bg-amber-500 hover:bg-amber-400`) — this is fixed dark text on the amber accent, per Global Constraints.

- [ ] **Step 4: Repeat Steps 2–3 for `expenses.html`**

Insert the flash-prevention script before its `<script src="https://cdn.tailwindcss.com"></script>` line and the config script after it (same ordering as Task 3 Step 2), and apply this mapping to every occurrence in `public/expenses.html`:

| Existing class | Replace with |
|---|---|
| `bg-slate-900` | `bg-slate-100 dark:bg-slate-900` |
| `bg-slate-800` | `bg-white dark:bg-slate-800` |
| `border-slate-700` | `border-slate-200 dark:border-slate-700` |
| `hover:bg-slate-700` | `hover:bg-slate-200 dark:hover:bg-slate-700` |
| `hover:bg-slate-600` | `hover:bg-slate-300 dark:hover:bg-slate-600` |
| `text-slate-300` (form labels, summary/list text) | `text-slate-700 dark:text-slate-300` |
| `text-slate-200` (on the CSV export button, paired with `bg-slate-700 hover:bg-slate-600`) | `text-slate-700 dark:text-slate-200` |
| `text-white` | `text-slate-900 dark:text-white` |

**Exception — do NOT change:** the `text-slate-900` on the "Add Expense" submit button (paired with `bg-amber-500 hover:bg-amber-400`).

- [ ] **Step 5: Manually verify with a headless-browser harness**

Reuse this session's established pattern: a trivial Node `http` static server serving `public/`, driven by Puppeteer with real Chrome. Load `index.html`, confirm:
1. Default (no `localStorage.pos_theme` set): `document.documentElement.dataset.theme === 'dark'` and `document.documentElement.classList.contains('dark')` is `true`.
2. Click the moon icon in `#sidebarThemeToggle` → confirm it's already active (dark is default) → click the sun icon → page reloads → `localStorage.getItem('pos_theme') === 'light'`, `dataset.theme === 'light'`, `.dark` class absent, and the sidebar/header now render with their light Tailwind classes (e.g. sidebar `getComputedStyle` background is white, not `#1e293b`).
3. Repeat for `expenses.html`.
4. No console errors on either page in either theme.

- [ ] **Step 6: Commit**

```bash
git add public/js/sidebar.js public/index.html public/expenses.html
git commit -m "feat(theme): wire theme toggle into sidebar; theme-enable index and expenses pages"
```

---

### Task 4: Consolidate `login.html` onto the shared variable system

**Files:**
- Modify: `public/login.html`

**Interfaces:**
- Consumes: the `:root`/`[data-theme="light"]` variables from `public/css/style.css` (Task 1).

- [ ] **Step 1: Remove the private `:root` block and link `style.css`**

In `public/login.html`, remove this block entirely from the `<style>` section:

```css
  :root {
    --navy:   #0B1120;
    --card:   #111827;
    --border: #1F2D45;
    --amber:  #F59E0B;
    --amber2: #FCD34D;
    --text:   #E2E8F0;
    --muted:  #64748B;
    --error:  #F87171;
    --success:#4ADE80;
  }
```

Add a stylesheet link right after the existing Google Fonts `<link>` tags (before the `<title>` or the `<style>` block — either is fine since `style.css`'s `:root`/`[data-theme]` variables and this page's own `<style>` block don't define overlapping selectors):

```html
<link rel="stylesheet" href="/css/style.css"/>
```

- [ ] **Step 2: Replace every `var(--navy|--card|--border|--amber|--amber2|--text|--muted|--error|--success)` reference in this file's `<style>` block**

| Old variable reference | Replace with |
|---|---|
| `var(--navy)` | `var(--bg-canvas)` |
| `var(--card)` | `var(--bg-surface)` |
| `var(--border)` | `var(--border)` *(name unchanged — already matches `style.css`'s variable)* |
| `var(--amber)` | `var(--accent)` |
| `var(--amber2)` | `var(--accent-strong)` |
| `var(--text)` | `var(--text-primary)` |
| `var(--muted)` | `var(--text-secondary)` |
| `var(--error)` | *(leave as literal `#F87171` — semantic/fixed, matches Global Constraints)* |
| `var(--success)` | *(leave as literal `#4ADE80` — semantic/fixed)* |

Concretely: remove the now-dead `--error`/`--success` variable declarations were already deleted in Step 1; replace their two usages (`.error-msg`'s `color: var(--error)`) with the literal `color: #F87171` directly (there is no success-color usage elsewhere in this file to change).

- [ ] **Step 3: Handle the two literal-hex spots that aren't a CSS-variable reference**

These currently hardcode `#0B1120` directly instead of `var(--navy)` — update them too, for consistency:
- `.btn-login`'s `color: #0B1120` → `color: var(--bg-canvas)` (dark text fixed on the amber login button — but since `--bg-canvas` is themed and would turn *light* in light mode, defeating the "dark text on amber" requirement, use the **literal** `color: #0B1120` here instead, unchanged. This is a "text on amber background" case per Global Constraints.)
- `.spinner`'s `border-top-color: #0B1120` → same reasoning, leave as literal `#0B1120` unchanged (spinner sits inside the amber button).

(In other words: Step 3 is a no-op — on inspection, both of these are correctly left as fixed literals. Do not introduce `var(--bg-canvas)` here.)

- [ ] **Step 4: Add the flash-prevention script**

`login.html` doesn't load Tailwind, so it only needs the `data-theme` half (no `.dark` class needed). Insert this immediately after the opening `<head>` tag, before the `<link rel="preconnect">` tags:

```html
<script>
  (function() {
    var t = localStorage.getItem('pos_theme') === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
  })();
</script>
```

- [ ] **Step 5: Manually verify**

`login.html` has no separate JS file for `node --check`; verify it directly in a browser instead. Use the Puppeteer harness: load `login.html` with no `localStorage.pos_theme` set — confirm it renders pixel-identical to before this task (same navy background, same card styling, no console errors from the removed `:root` block or the new `<link>`). Then set `localStorage.pos_theme = 'light'` and reload — confirm the background/card/text/border colors switch to their light values and the page remains legible (labels, inputs, and the "Sign In" button all readable).

- [ ] **Step 6: Commit**

```bash
git add public/login.html
git commit -m "feat(theme): consolidate login.html onto shared style.css variable system"
```

---

### Task 5: Theme-enable `receipts.html`

**Files:**
- Modify: `public/receipts.html`

**Interfaces:**
- Consumes: variables from Task 1; Tailwind config pattern from Task 3.

- [ ] **Step 1: Add the flash-prevention + Tailwind config script**

Immediately *before* `receipts.html`'s existing `<script src="https://cdn.tailwindcss.com"></script>` line, insert the flash-prevention script; immediately *after* that same line, insert the config script (same ordering as Task 3 Step 2 — the config script must come after the CDN tag, or `tailwind` is undefined):

```html
<script>
  (function() {
    var t = localStorage.getItem('pos_theme') === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    document.documentElement.classList.toggle('dark', t === 'dark');
  })();
</script>
```
```html
<!-- ... existing <script src="https://cdn.tailwindcss.com"></script> stays here ... -->
<script>tailwind.config = { darkMode: 'class' };</script>
```

- [ ] **Step 2: Migrate the embedded `<style>` block's hardcoded colors**

Apply this exact mapping throughout `receipts.html`'s `<style>` block:

| Literal value | Replace with |
|---|---|
| `#fbbf24` (`.receipt-row.selected td:first-child` border, `.page-btn.active` color/border) | `var(--accent-strong)` |
| `#1e293b` (`.stat-card`, `.detail-panel`, `.detail-item-row` border-bottom, `.page-btn:hover` background) | `var(--bg-surface)` |
| `#334155` (borders throughout) | `var(--border)` |
| `#1e3a5f` (`.detail-header` gradient start) | `var(--border-strong)` |
| `#cbd5e1` (`.detail-item-name`) | `var(--text-primary)` |
| `#f8fafc` (`.detail-item-price`, `.page-btn:hover` color, `.filter-input` color, `.card`/`.section-title` — the "bright white-ish" text) | `var(--text-primary)` |
| `#64748b` (`.detail-item-qty`) | `var(--text-muted)` |
| `#94a3b8` (`.page-btn` color) | `var(--text-secondary)` |
| `#0f172a` (`.filter-input` background) | `var(--bg-canvas)` |
| `#475569` (`.filter-input::placeholder`, `.empty-state`) | `var(--text-dim)` |

**Do NOT touch — semantic, stays fixed:** `.badge-sale`/`.badge-refund`/`.badge-canceled` (all colors, including `.badge-canceled`'s `#94a3b8`, grouped with its semantic siblings).

- [ ] **Step 3: Rewrite `receipts.html`'s Tailwind utility classes**

| Existing class | Replace with |
|---|---|
| `bg-slate-900` | `bg-slate-100 dark:bg-slate-900` |
| `text-white` | `text-slate-900 dark:text-white` |
| `bg-slate-700` (CSV export button) | `bg-slate-200 dark:bg-slate-700` |
| `hover:bg-slate-600` | `hover:bg-slate-300 dark:hover:bg-slate-600` |
| `text-slate-200` (CSV export button text) | `text-slate-700 dark:text-slate-200` |

- [ ] **Step 4: Manually verify**

Puppeteer harness: load `receipts.html` in both themes, confirm the receipts table, detail panel, stat cards, and filter bar are all legible with no white-on-white or dark-on-dark regions, and the badge colors (sale/refund/canceled) are unchanged from today's appearance in both themes.

- [ ] **Step 5: Commit**

```bash
git add public/receipts.html
git commit -m "feat(theme): theme-enable receipts.html"
```

---

### Task 6: Theme-enable `report.html` and `users.html`

**Files:**
- Modify: `public/report.html`
- Modify: `public/users.html`

**Interfaces:**
- Consumes: variables from Task 1; Tailwind config pattern from Task 3.

- [ ] **Step 1: `report.html` — flash-prevention + Tailwind config script**

Insert the same script pair as Task 5 Step 1 — flash-prevention script before `report.html`'s `<script src="https://cdn.tailwindcss.com"></script>` line, config script after it.

- [ ] **Step 2: `report.html` — migrate its embedded `<style>` block**

Its entire embedded block is:

```css
  .growth-up   { color: #34d399; font-weight: 600; }
  .growth-down { color: #f87171; font-weight: 600; }
  .growth-nil  { color: #64748b; }
```

`#34d399` and `#f87171` are semantic (growth up/down, matching the badge-up/down convention) — **leave unchanged**. Only migrate `.growth-nil`:

```css
  .growth-nil  { color: var(--text-muted); }
```

- [ ] **Step 3: `report.html` — rewrite Tailwind utility classes**

| Existing class | Replace with |
|---|---|
| `bg-slate-900` | `bg-slate-100 dark:bg-slate-900` |
| `text-white` | `text-slate-900 dark:text-white` |

- [ ] **Step 4: `users.html` — flash-prevention + Tailwind config script**

Insert the same script pair — flash-prevention script before `users.html`'s `<script src="https://cdn.tailwindcss.com"></script>` line, config script after it.

- [ ] **Step 5: `users.html` — migrate its embedded `<style>` block**

| Literal value | Replace with |
|---|---|
| `#1e293b` (`.card` background) | `var(--bg-surface)` |
| `#334155` (`.card` border, `.field-input` border, scrollbar thumb) | `var(--border)` |
| `#f8fafc` (`.section-title`, `.field-input` color) | `var(--text-primary)` |
| `#0f172a` (`.field-input` background) | `var(--bg-canvas)` |
| `#475569` (`.field-input::placeholder`) | `var(--text-dim)` |
| `#fbbf24` (`.field-input:focus` border-color) | `var(--accent-strong)` |

- [ ] **Step 6: `users.html` — rewrite Tailwind utility classes**

| Existing class | Replace with |
|---|---|
| `bg-slate-900` | `bg-slate-100 dark:bg-slate-900` |
| `text-white` | `text-slate-900 dark:text-white` |

**Exception — do NOT change:** the `text-slate-900` on the "Add User" submit button (paired with `bg-amber-500 hover:bg-amber-400`).

- [ ] **Step 7: Manually verify**

Puppeteer harness: load both pages in both themes. For `report.html`, confirm the three revenue/staff-cost/whatever charts still render (chart color migration itself is Task 9 — for this task just confirm the page shell and growth indicators are legible and undamaged). For `users.html`, confirm the users table, add-user form, and badges are legible in both themes.

- [ ] **Step 8: Commit**

```bash
git add public/report.html public/users.html
git commit -m "feat(theme): theme-enable report.html and users.html"
```

---

### Task 7: Theme-enable `staff.html`

**Files:**
- Modify: `public/staff.html`

**Interfaces:**
- Consumes: variables from Task 1; Tailwind config pattern from Task 3.

- [ ] **Step 1: Flash-prevention + Tailwind config script**

Insert the same script pair as prior tasks — flash-prevention script before `staff.html`'s `<script src="https://cdn.tailwindcss.com"></script>` line, config script after it.

- [ ] **Step 2: Migrate the app-chrome portion of the embedded `<style>` block**

Apply this mapping to the block's **first half only** — from `.card` through `.sch-future-badge` (i.e. everything *before* the `/* ── Roster spreadsheet table ── */` comment):

| Literal value | Replace with |
|---|---|
| `#1e293b` (`.card`, `.stat-card`, `.sch-nav-btn`, `.sch-picker`, `.sch-roster-picker` backgrounds) | `var(--bg-surface)` |
| `#334155` (borders throughout this section) | `var(--border)` |
| `#f8fafc` (`.section-title`, `.staff-input` color) | `var(--text-primary)` |
| `#0f172a` (`.staff-input` background) | `var(--bg-canvas)` |
| `#475569` (`.staff-input::placeholder`) | `var(--text-dim)` |
| `#fbbf24` (`.staff-input:focus` border, `.tab-btn.active` color/border-bottom) | `var(--accent-strong)` |
| `#94a3b8` (`.tab-btn`, `.sch-nav-btn`, `.sch-picker-badge`'s sibling `.sch-picker-clear` color) | `var(--text-secondary)` |
| `#e2e8f0` (`.tab-btn:hover`) | `var(--text-primary)` |
| `#64748b` (`.sch-roster-title`) | `var(--text-muted)` |
| `#cbd5e1` (`.sch-picker-opt`, `.sch-roster-opt` color) | `var(--text-primary)` |
| `#818cf8` (`.sch-future-badge` color) | *(leave unchanged — semantic indigo status accent)* |

**Do NOT touch:** `.badge-active`/`.badge-inactive`/`.badge-loan` (all colors — semantic status badges).

- [ ] **Step 3: Leave the roster spreadsheet section and print styles completely untouched**

Everything from `/* ── Roster spreadsheet table ── */` through the end of the `<style>` block — every `.rst-*` class and the entire `@media print` block — is deliberately fixed light/white "paper" styling for a printable roster grid, per Global Constraints. Do not add, remove, or reference any `var(--...)` in this section. Confirm by eye that this section is unchanged after Step 2.

**One exception found during implementation:** the generic `::-webkit-scrollbar`/`::-webkit-scrollbar-track`/`::-webkit-scrollbar-thumb` rules sit *positionally* after the roster comment (just before `@media print`) but are ordinary page-wide chrome, not roster-specific. Migrate `::-webkit-scrollbar-thumb`'s `#334155` to `var(--border)` same as every other page's scrollbar thumb, even though it falls inside the "leave untouched" byte range.

- [ ] **Step 4: Rewrite `staff.html`'s Tailwind utility classes**

| Existing class | Replace with |
|---|---|
| `bg-slate-900` | `bg-slate-100 dark:bg-slate-900` |
| `text-white` | `text-slate-900 dark:text-white` |
| `bg-slate-700` (CSV export button) | `bg-slate-200 dark:bg-slate-700` |
| `hover:bg-slate-600` | `hover:bg-slate-300 dark:hover:bg-slate-600` |
| `text-slate-200` (CSV export button text) | `text-slate-700 dark:text-slate-200` |

**Exception — do NOT change:** the `text-slate-900` on the "Add Staff" submit button (paired with `bg-amber-500 hover:bg-amber-400`), and do not touch any class inside the roster/schedule table markup that corresponds to the `.rst-*`/print-fixed styles from Step 3 (e.g. any inline `bg-white`/`text-slate-*` used for the roster grid's meta cells, if present in the HTML rather than the `<style>` block — grep for `rst-outer`, `rst-td`, `rst-th` in the body markup first to identify this boundary before editing).

- [ ] **Step 5: Manually verify**

Puppeteer harness: load `staff.html` in both themes. Confirm the staff list, add-staff form, tabs, and schedule-tab's month-nav/badges are legible in both themes. Confirm the roster spreadsheet grid (Schedule tab) looks **identical in both themes** (fixed light/white paper look) — this is the one part of the page that should NOT change when toggling.

- [ ] **Step 6: Commit**

```bash
git add public/staff.html
git commit -m "feat(theme): theme-enable staff.html (roster/print sections intentionally excluded)"
```

---

### Task 8: `charts.js` reads colors via `getComputedStyle`

**Files:**
- Modify: `public/js/charts.js`

**Interfaces:**
- Produces: chart option builders (`chartOpts`, `barOpts`, `pieOpts`, `heatColor`) now theme-aware. No signature changes — consumed identically by every page module that already calls them.

- [ ] **Step 1: Add a small `themeColor` helper and `hexToRgb` utility**

Replace the top of `public/js/charts.js` (before `heatColor`):

```js
import { state, COLORS } from './state.js';
import { fmt } from './utils.js';

export { COLORS };

function themeColor(varName, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
```

- [ ] **Step 2: Update `heatColor` to use the themed empty-cell color**

Replace:

```js
export function heatColor(ratio) {
  if (ratio === 0) return '#1e293b';
  const r = Math.round(30  + ratio * (245 - 30));
  const g = Math.round(41  + ratio * (158 - 41));
  const b = Math.round(59  + ratio * (11  - 59));
  return `rgb(${r},${g},${b})`;
}
```

With:

```js
export function heatColor(ratio) {
  const empty = themeColor('--heatmap-empty', '#1e293b');
  if (ratio === 0) return empty;
  const { r: r0, g: g0, b: b0 } = hexToRgb(empty);
  const r = Math.round(r0 + ratio * (245 - r0));
  const g = Math.round(g0 + ratio * (158 - g0));
  const b = Math.round(b0 + ratio * (11  - b0));
  return `rgb(${r},${g},${b})`;
}
```

- [ ] **Step 3: Update `chartOpts` to read grid/tick colors from variables**

Replace:

```js
export function chartOpts(prefix = '') {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: '#1e293b' }, ticks: { color: '#64748b', font: { size: 11 } } },
      y: { grid: { color: '#334155' }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => prefix + fmt(v) } },
    },
  };
}
```

With:

```js
export function chartOpts(prefix = '') {
  const gridX = themeColor('--bg-surface', '#1e293b');
  const gridY = themeColor('--border', '#334155');
  const tick  = themeColor('--text-muted', '#64748b');
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: gridX }, ticks: { color: tick, font: { size: 11 } } },
      y: { grid: { color: gridY }, ticks: { color: tick, font: { size: 11 }, callback: v => prefix + fmt(v) } },
    },
  };
}
```

`barOpts` needs no direct edit (it already spreads `chartOpts(prefix)`, so it inherits the fix automatically). Confirm this by re-reading its definition — it should still read exactly:

```js
export function barOpts(prefix = '') {
  return { ...chartOpts(prefix), plugins: { legend: { display: false } }, indexAxis: 'y' };
}
```

- [ ] **Step 4: Update `pieOpts`'s legend color**

Replace:

```js
export function pieOpts(showLegend = true) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: showLegend, position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        callbacks: {
          label: c => ` ${c.label}: ៛${fmt(c.raw)} (${((c.raw / c.chart.getDatasetMeta(0).total) * 100).toFixed(1)}%)`,
        },
      },
    },
  };
}
```

With:

```js
export function pieOpts(showLegend = true) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: showLegend, position: 'bottom', labels: { color: themeColor('--text-secondary', '#94a3b8'), boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        callbacks: {
          label: c => ` ${c.label}: ៛${fmt(c.raw)} (${((c.raw / c.chart.getDatasetMeta(0).total) * 100).toFixed(1)}%)`,
        },
      },
    },
  };
}
```

`donutOpts` needs no color changes (it has none today).

- [ ] **Step 5: Manually verify**

```bash
node --check public/js/charts.js
node --input-type=module -e "
import { heatColor } from './public/js/charts.js';
// getComputedStyle isn't available outside a browser; this only confirms the module parses and exports correctly.
console.log(typeof heatColor);
"
```

Expected: `node --check` prints nothing; the module-load check prints `function`. Full behavioral verification (that colors actually change per theme) happens in Task 10's cross-page sweep, since it requires a real DOM/browser to resolve `getComputedStyle`.

- [ ] **Step 6: Commit**

```bash
git add public/js/charts.js
git commit -m "feat(theme): make charts.js read grid/tick/legend colors from CSS variables"
```

---

### Task 9: `report.js`'s inline chart configs read colors via `getComputedStyle`

**Files:**
- Modify: `public/js/pages/report.js`

**Interfaces:**
- Consumes: none new (uses the same `getComputedStyle(document.documentElement).getPropertyValue(...)` technique introduced in Task 8, duplicated here since `report.js` doesn't import `charts.js`'s private `themeColor` helper).

**Context:** unlike `dashboard.js`/`staff.js`/`receipts.js`/`users.js`/`schedule.js` (whose hardcoded hex colors are all semantic dataset/series colors that stay fixed per Global Constraints), `report.js` hand-rolls three separate chart configs with their own duplicated grid/tick/legend axis-chrome colors instead of reusing `charts.js`'s `chartOpts()`/`barOpts()`. These three are real theme-chrome and need the same fix as Task 8, applied locally.

- [ ] **Step 1: Add a local `themeColor` helper**

Add near the top of `public/js/pages/report.js`, after the existing imports:

```js
function themeColor(varName, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback;
}
```

- [ ] **Step 2: Replace the first chart config's axis/legend colors (around line 137-142)**

Replace:

```js
        legend: { display: true, position: 'top', labels: { color: '#94a3b8', font: { size: 11 } } },
```
```js
        x:  { grid: { color: '#1e293b' }, ticks: { color: '#64748b', font: { size: 11 } } },
        y:  { position: 'left',  grid: { color: '#334155' }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => '៛' + fmt(v) } },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => v + '%' } },
```

With:

```js
        legend: { display: true, position: 'top', labels: { color: themeColor('--text-secondary', '#94a3b8'), font: { size: 11 } } },
```
```js
        x:  { grid: { color: themeColor('--bg-surface', '#1e293b') }, ticks: { color: themeColor('--text-muted', '#64748b'), font: { size: 11 } } },
        y:  { position: 'left',  grid: { color: themeColor('--border', '#334155') }, ticks: { color: themeColor('--text-muted', '#64748b'), font: { size: 11 }, callback: v => '៛' + fmt(v) } },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: themeColor('--text-muted', '#64748b'), font: { size: 11 }, callback: v => v + '%' } },
```

(Leave `borderColor: '#f59e0b'`/`'#34d399'`/`pointBackgroundColor: '#34d399'` in this same region untouched — these are the chart's data-series line colors, semantic per Global Constraints.)

- [ ] **Step 3: Replace the second chart config's axis/legend colors (around line 332-346)**

Replace:

```js
        legend: { display: true, position: 'top', labels: { color: '#94a3b8', boxWidth: 12, font: { size: 11 } } },
```
```js
        x:  { grid: { color: '#1e293b' }, ticks: { color: '#64748b', font: { size: 11 } } },
        y:  { position: 'left',  grid: { color: '#334155' }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => '៛' + fmt(v) } },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#fb923c', font: { size: 11 }, callback: v => v + '%' }, suggestedMax: 100 },
```

With:

```js
        legend: { display: true, position: 'top', labels: { color: themeColor('--text-secondary', '#94a3b8'), boxWidth: 12, font: { size: 11 } } },
```
```js
        x:  { grid: { color: themeColor('--bg-surface', '#1e293b') }, ticks: { color: themeColor('--text-muted', '#64748b'), font: { size: 11 } } },
        y:  { position: 'left',  grid: { color: themeColor('--border', '#334155') }, ticks: { color: themeColor('--text-muted', '#64748b'), font: { size: 11 }, callback: v => '៛' + fmt(v) } },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#fb923c', font: { size: 11 }, callback: v => v + '%' }, suggestedMax: 100 },
```

(`'#fb923c'` on the `y2` ticks is a semantic series-matching color — leave it untouched, along with `borderColor: '#f59e0b'`/`'#ef4444'`/`'#fb923c'`/`pointBackgroundColor: '#fb923c'` in this region.)

- [ ] **Step 4: Replace the third chart config's axis/legend colors (around line 379-384)**

Replace:

```js
        legend: { display: true, position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, font: { size: 11 } } },
```
```js
        x:  { grid: { color: '#1e293b' }, ticks: { color: '#94a3b8', font: { size: 11 } } },
        y:  { position: 'left',  grid: { color: '#334155' }, ticks: { color: '#64748b', font: { size: 11 }, callback: v => '៛' + fmt(v) } },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#3b82f6', font: { size: 11 } } },
```

With:

```js
        legend: { display: true, position: 'bottom', labels: { color: themeColor('--text-secondary', '#94a3b8'), boxWidth: 12, font: { size: 11 } } },
```
```js
        x:  { grid: { color: themeColor('--bg-surface', '#1e293b') }, ticks: { color: themeColor('--text-secondary', '#94a3b8'), font: { size: 11 } } },
        y:  { position: 'left',  grid: { color: themeColor('--border', '#334155') }, ticks: { color: themeColor('--text-muted', '#64748b'), font: { size: 11 }, callback: v => '៛' + fmt(v) } },
        y2: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#3b82f6', font: { size: 11 } } },
```

(`'#3b82f6'` on the `y2` ticks is semantic — leave untouched.)

- [ ] **Step 5: Verify**

```bash
node --check public/js/pages/report.js
grep -n "'#1e293b'\|'#334155'\|color: '#64748b'\|color: '#94a3b8'" public/js/pages/report.js
```

Expected: `node --check` prints nothing; the `grep` finds no remaining matches (everything matching those exact patterns was chrome, now migrated — the semantic series colors like `#f59e0b`/`#34d399`/`#ef4444`/`#fb923c`/`#3b82f6` used as `borderColor`/`pointBackgroundColor` don't match this grep pattern and correctly remain).

- [ ] **Step 6: Commit**

```bash
git add public/js/pages/report.js
git commit -m "feat(theme): make report.js's inline chart configs read colors from CSS variables"
```

---

### Task 10: Final verification sweep

**Files:**
- Modify: none expected (fix-up only, touching whatever the sweep finds)

**Interfaces:**
- Consumes: nothing new — this is a verification pass over everything Tasks 1-9 produced.

- [ ] **Step 1: Grep sweep for missed hardcoded chrome colors**

```bash
grep -rn "background: #1e293b\|background: #334155\|color: #64748b\|color: #94a3b8" public/css/style.css public/*.html
```

Expected: no matches outside the explicitly-excluded semantic/fixed sections named in Tasks 1, 5, 6, 7 (re-check any hit against those tasks' "do not touch" lists before treating it as a miss).

```bash
grep -rln "bg-slate-900\|bg-slate-800\b" public/*.html
```

For each file listed, confirm every remaining bare (non-`dark:`-prefixed) occurrence is one of the documented exceptions (there should be none — every `bg-slate-900`/`bg-slate-800` should now appear only as part of a `dark:bg-slate-900`/`dark:bg-slate-800` pair).

- [ ] **Step 2: Syntax-check every touched JS file**

```bash
node --check public/css/style.css 2>&1 || node -e "require('fs').readFileSync('public/css/style.css','utf8')" && echo "css readable"
node --check public/js/themeToggle.js
node --check public/js/sidebar.js
node --check public/js/charts.js
node --check public/js/pages/report.js
```

Expected: no output from any `node --check` call; "css readable" prints.

- [ ] **Step 3: Full click-through in both themes across all 7 pages**

With a headless-browser (Puppeteer) harness serving `public/` (same pattern used throughout this project's sidebar/flag work), for each of `index.html`, `login.html`, `expenses.html`, `receipts.html`, `report.html`, `staff.html`, `users.html`:
1. Load with no `localStorage.pos_theme` set — confirm it renders identically to how it looked before this entire plan (dark, today's exact colors).
2. Toggle to light (via the sidebar toggle where present, or by setting `localStorage.pos_theme = 'light'` and reloading for `login.html`) — confirm every visible region is legible: no white-on-white, no dark-on-dark, sidebar/header/cards/tables/forms/badges all readable.
3. For `index.html` and `report.html` specifically: confirm charts render with theme-appropriate grid/tick/legend colors in both themes (light grid lines on light mode, not the dark-mode grid bleeding through).
4. For `staff.html` specifically: confirm the roster/schedule spreadsheet grid looks identical in both themes (the one deliberately-unthemed area).
5. Confirm the theme toggle itself works correctly in both the expanded and collapsed sidebar states, alongside the language flags and collapse button, with no layout overflow — following the same check pattern already used for the flag icons.

- [ ] **Step 4: Commit any fixes found**

```bash
git add -A
git commit -m "fix: close gaps found in dark/light theme final sweep"
```

(Skip this commit if the sweep found nothing to fix.)
