# Khmer/English Localization — Design

## Goal
Add full Khmer (ខ្មែរ) localization alongside the existing English UI, default English, user-switchable, no backend/DB changes.

## Scope
All pages: `login.html`, `index.html` (dashboard), `expenses.html`, `receipts.html`, `staff.html` (incl. Schedule tab), `report.html`, `users.html`. Every hardcoded user-facing string: static HTML labels, buttons, table headers, dynamically-generated content (table rows, alerts, `confirm()` dialogs), chart legends/tooltips, day/month names.

`public/js/dashboard.js` (1741 lines) is dead code — not imported by `app.js` (only `public/js/pages/dashboard.js` is) — excluded from scope.

## Architecture

New module `public/js/i18n.js`:
- `t(key, vars?)` — returns the translated string for the current language, interpolating `vars` (e.g. `{count}`), falling back to the English string (with `console.warn`) if the key is missing in the active dictionary.
- `getLang()` / `setLang(lang)` — reads/writes `localStorage['pos_lang']` (`'en'` default if unset).
- `applyTranslations(root = document)` — walks `root` querying `[data-i18n]`, `[data-i18n-placeholder]`, `[data-i18n-title]` and sets `textContent` / `placeholder` / `title` respectively.

Dictionaries: `public/js/i18n/en.js` and `public/js/i18n/km.js`, each a flat exported object `{ "namespace.key": "string" }`, namespaced per page (e.g. `dashboard.kpi.grossIncome`, `common.signOut`, `staff.schedule.applyShift`).

### Static markup
Existing HTML gets `data-i18n="key"` attributes added (keeping the current English text as the literal fallback content in markup, since `applyTranslations()` overwrites it after load — avoids a flash of untranslated content being jarring since English is the default anyway).

### Dynamic JS content
Every page module (`pages/dashboard.js`, `pages/expenses.js`, `pages/receipts.js`, `pages/staff.js`, `pages/schedule.js`, `pages/report.js`, `pages/users.js`) and shared modules (`auth.js`, `api.js`, `charts.js`, `app.js`) have their hardcoded string literals (template rows, `alert()`/`confirm()` messages, chart legend/tooltip labels, day names currently in `state.js`'s `DAYS` constant) replaced with `t('key')` calls.

## Language switching
- Toggle UI: pill switch (`EN` / `ខ្មែរ`) in the sidebar header next to the user avatar, present on every authenticated page (`index.html`, `expenses.html`, `receipts.html`, `staff.html`, `report.html`, `users.html`). A matching small toggle in the top corner of `login.html` (pre-auth, so it can't live in the sidebar).
- On click: `setLang(newLang)` writes to localStorage, then `location.reload()`. Full reload is intentional — every page already fully re-renders (tables, charts) on `init()`, so re-running that after the language is set is simpler and more reliable than making every render function reactive to a language-change event.
- `app.js` calls `applyTranslations()` and initializes the switcher before any page-specific `init()` runs, so first paint is already in the correct language.

## Font handling
Add Noto Sans Khmer via Google Fonts `<link>` in every page's `<head>` (consistent with the existing Tailwind CDN / Chart.js CDN pattern — this app already depends on external CDNs). Extend the body font-family stack in `public/css/style.css` to include `'Noto Sans Khmer'` as a fallback so Khmer glyphs render correctly regardless of which language is active (mixed content, e.g. an English product name inside a Khmer-language table, still renders correctly since fonts fall back per-glyph).

Numerals stay Arabic (0–9) in both languages — only labels, buttons, headers, messages, and day/month names are translated. This matches common practice in Cambodian business software and avoids numeral-confusion in financial figures.

## Translation content
I draft Khmer translations for every string using standard Cambodian business/restaurant terminology, delivered in the editable `km.js` dictionary. The user will review and request corrections after the initial pass — this is expected, not a blocker to shipping v1.

## Rollout phases (for the implementation plan)
0. Framework: `i18n.js`, `en.js`/`km.js` scaffolding, switcher component, font, wiring into `app.js`.
1. Login page
2. Dashboard
3. Expenses
4. Receipts
5. Staff + Schedule tab
6. Report
7. Users (admin-only)

Each phase adds its page's strings to both dictionaries and swaps in `data-i18n`/`t()` calls; phases 1–7 are independent of each other once phase 0 lands, so they can be parallelized.

## Testing
Manual QA per page, in both languages:
- No layout overflow/wrapping breakage from longer Khmer strings (buttons, badges, nav labels).
- Language persists across reload and page navigation; first-time visitors default to English.
- Dynamic content actually switches: alerts, `confirm()` dialogs, chart legends/tooltips, day-of-week labels, table-generated rows.
- Mixed-content rendering (Khmer labels next to English product/staff names) looks correct with the font fallback.

No automated test suite exists for the frontend today; this remains manual-verification only, consistent with the rest of the codebase.
