# Khmer/English Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full Khmer (ខ្មែរ) translation of the dashboard UI alongside the existing English text, default English, switchable per-browser, with zero backend/DB changes.

**Architecture:** A dependency-free `public/js/i18n.js` module backed by two flat dictionaries (`public/js/i18n/en.js`, `public/js/i18n/km.js`). Static HTML text is tagged with `data-i18n*` attributes and translated in place on load; dynamic JS-generated strings call `t(key)` directly at the point they're built. Language choice lives in `localStorage['pos_lang']`; switching writes the key and reloads the page.

**Tech Stack:** Vanilla ES modules (no bundler), matches the existing `public/js/*` pattern. Noto Sans Khmer via Google Fonts CDN (the app already depends on the Tailwind and Chart.js CDNs).

## Global Constraints

- Default language is English; nothing must require Khmer to function.
- No DB schema changes, no new npm dependencies, no build step.
- Numerals stay Arabic (0–9) in both languages — only text is translated.
- Every dictionary key follows `<namespace>.<name>` (e.g. `dashboard.kpi.grossIncome`), namespaced per page; shared elements live under `common.*` and `nav.*`.
- `t()` must never render a blank string — fall back to the English dictionary, then to the raw key, and `console.warn` on the fallback so gaps are visible during QA.
- `public/js/dashboard.js` (1741 lines, dead code, unreferenced by `app.js`) is out of scope — do not touch it.
- Spec: `docs/superpowers/specs/2026-07-05-i18n-khmer-english-design.md`

---

### Task 1: i18n framework — dictionaries, `t()`, font

**Files:**
- Create: `public/js/i18n/en.js`
- Create: `public/js/i18n/km.js`
- Create: `public/js/i18n.js`
- Modify: `public/css/style.css` (append)
- Modify: `public/login.html:24-30` (body font-family rule)

**Interfaces:**
- Produces: `t(key, vars = {})`, `getLang()`, `setLang(lang)`, `applyTranslations(root = document)`, `renderLangSwitcher(container)` — all named exports of `public/js/i18n.js`. Every later task imports from this file only.

- [ ] **Step 1: Create the English dictionary seed**

```js
// public/js/i18n/en.js
export const en = {
  // ── common ──────────────────────────────────────────────
  'common.signOut': 'Sign out',
  'common.collapseSidebar': 'Collapse sidebar',
  'common.openMenu': 'Open menu',
  'common.loading': 'Loading...',
  'common.save': 'Save Changes',
  'common.cancel': 'Cancel Edit',
  'common.edit': 'Edit',
  'common.delete': 'Delete',
  'common.apply': 'Apply',
  'common.reset': 'Reset',
  'common.csv': '⬇ CSV',
  'common.confirmCannotUndo': 'This cannot be undone.',

  // ── nav ─────────────────────────────────────────────────
  'nav.dashboard': 'Dashboard',
  'nav.expenses': 'Expenses',
  'nav.reports': 'Reports',
  'nav.receipts': 'Receipts',
  'nav.staff': 'Staff',
  'nav.users': 'Users',
};
```

- [ ] **Step 2: Create the Khmer dictionary seed with the same keys**

```js
// public/js/i18n/km.js
export const km = {
  // ── common ──────────────────────────────────────────────
  'common.signOut': 'ចាកចេញ',
  'common.collapseSidebar': 'បង្រួមម៉ឺនុយ',
  'common.openMenu': 'បើកម៉ឺនុយ',
  'common.loading': 'កំពុងផ្ទុក...',
  'common.save': 'រក្សាទុកការកែប្រែ',
  'common.cancel': 'បោះបង់ការកែប្រែ',
  'common.edit': 'កែប្រែ',
  'common.delete': 'លុប',
  'common.apply': 'អនុវត្ត',
  'common.reset': 'កំណត់ឡើងវិញ',
  'common.csv': '⬇ ទាញយក CSV',
  'common.confirmCannotUndo': 'សកម្មភាពនេះមិនអាចត្រឡប់វិញបានទេ។',

  // ── nav ─────────────────────────────────────────────────
  'nav.dashboard': 'ផ្ទាំងគ្រប់គ្រង',
  'nav.expenses': 'ចំណាយ',
  'nav.reports': 'របាយការណ៍',
  'nav.receipts': 'បង្កាន់ដៃ',
  'nav.staff': 'បុគ្គលិក',
  'nav.users': 'អ្នកប្រើប្រាស់',
};
```

- [ ] **Step 3: Create the i18n module**

```js
// public/js/i18n.js
import { en } from './i18n/en.js';
import { km } from './i18n/km.js';

const LANG_KEY = 'pos_lang';
const dictionaries = { en, km };

export function getLang() {
  const stored = localStorage.getItem(LANG_KEY);
  return stored === 'km' ? 'km' : 'en';
}

export function setLang(lang) {
  localStorage.setItem(LANG_KEY, lang === 'km' ? 'km' : 'en');
}

export function t(key, vars = {}) {
  const lang = getLang();
  let str = dictionaries[lang]?.[key];
  if (str === undefined) {
    console.warn(`[i18n] missing key "${key}" for lang "${lang}"`);
    str = en[key] ?? key;
  }
  return str.replace(/\{(\w+)\}/g, (_, name) => (vars[name] !== undefined ? String(vars[name]) : `{${name}}`));
}

export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle);
  });
}

export function renderLangSwitcher(container) {
  if (!container) return;
  const lang = getLang();
  container.innerHTML = `
    <div class="lang-switch" role="group" aria-label="Language">
      <button type="button" class="lang-btn${lang === 'en' ? ' active' : ''}" data-lang="en">EN</button>
      <button type="button" class="lang-btn${lang === 'km' ? ' active' : ''}" data-lang="km">ខ្មែរ</button>
    </div>`;
  container.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.lang === getLang()) return;
      setLang(btn.dataset.lang);
      location.reload();
    });
  });
}
```

- [ ] **Step 4: Add Khmer font fallback and switcher styles to `public/css/style.css`**

Append to the end of the file:

```css
/* ── i18n: Khmer font fallback ──────────────────────────── */
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans Khmer', Arial, sans-serif;
}

/* ── i18n: language switcher ─────────────────────────────── */
.lang-switch {
  display: flex;
  gap: 2px;
  background: #0f172a;
  border: 1px solid #1f2d45;
  border-radius: 8px;
  padding: 2px;
}
.lang-btn {
  border: none;
  background: transparent;
  color: #64748b;
  font-size: 11px;
  font-weight: 600;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color .15s, color .15s;
}
.lang-btn:hover { color: #cbd5e1; }
.lang-btn.active { background: #f59e0b; color: #0b1120; }
```

- [ ] **Step 5: Add the same font fallback to `public/login.html`, which doesn't link `style.css`**

In `public/login.html`, the `html, body` rule at line 24-30 currently reads:

```css
  html, body {
    height: 100%;
    background: var(--navy);
    font-family: 'DM Sans', sans-serif;
    color: var(--text);
    overflow: hidden;
  }
```

Change the `font-family` line to:

```css
    font-family: 'DM Sans', 'Noto Sans Khmer', sans-serif;
```

- [ ] **Step 6: Add the Noto Sans Khmer Google Fonts link to every page's `<head>`**

In each of `public/index.html`, `public/expenses.html`, `public/receipts.html`, `public/staff.html`, `public/report.html`, `public/users.html`, `public/login.html`, add this line immediately after the `<meta name="viewport" ...>` tag:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Khmer:wght@400;500;600;700&display=swap" rel="stylesheet">
```

- [ ] **Step 7: Manually verify**

Open `http://localhost:3000/login` directly (server must be running via `npm run dev:uat`). Confirm the page still renders unchanged (no visible Khmer text yet — dictionaries aren't wired into any page). Open devtools console, run `localStorage.setItem('pos_lang','km')` then reload — still no visible change yet (expected; no page consumes `i18n.js` until Task 2+). This step only confirms the new files don't 404 or throw.

- [ ] **Step 8: Commit**

```bash
git add public/js/i18n.js public/js/i18n/en.js public/js/i18n/km.js public/css/style.css public/login.html public/index.html public/expenses.html public/receipts.html public/staff.html public/report.html public/users.html
git commit -m "feat(i18n): add translation framework, dictionaries, and Khmer font"
```

---

### Task 2: Language switcher wiring + shared shell translations

**Files:**
- Modify: `public/js/app.js:1-20, 150-176`
- Modify: `public/login.html:302-378`
- Modify: `public/index.html`, `public/expenses.html`, `public/receipts.html`, `public/staff.html`, `public/report.html`, `public/users.html` (sidebar block, identical across all six)

**Interfaces:**
- Consumes: `applyTranslations`, `renderLangSwitcher`, `t` from `public/js/i18n.js` (Task 1).
- Produces: every authenticated page now has a working switcher and translated sidebar; nothing page-specific yet.

- [ ] **Step 1: Add a switcher mount point to the sidebar header in all six authenticated pages**

In each of `public/index.html`, `public/expenses.html`, `public/receipts.html`, `public/staff.html`, `public/report.html`, `public/users.html`, the sidebar header currently looks like (e.g. `public/index.html:90-110`):

```html
    <div class="flex items-center gap-3">
      <div id="sidebarAvatar" class="w-9 h-9 rounded-full bg-gradient-to-tr from-amber-400 to-orange-600 flex items-center justify-center font-bold text-black">U</div>
      <div class="brand-meta">
        ...
      </div>
    </div>
    <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-slate-700" aria-label="Collapse sidebar">⇔</button>
  </div>
```

Insert a switcher container right before the closing `</div>` of `sidebar-header`, i.e. before the `toggleSidebarCollapse` button:

```html
    <div id="langSwitcher"></div>
    <button onclick="toggleSidebarCollapse()" class="hidden md:inline-flex text-xl px-2 py-1 rounded hover:bg-slate-700" data-i18n-title="common.collapseSidebar" aria-label="Collapse sidebar">⇔</button>
```

- [ ] **Step 2: Tag the sidebar nav labels and Sign out button with `data-i18n` in all six pages**

Each page's nav block (e.g. `public/index.html:112-136`) currently reads:

```html
    <a href="/" class="nav-item active">
      <span class="text-lg">📊</span>
      <span class="nav-label">Dashboard</span>
    </a>
    <a href="/expenses.html" class="nav-item">
      <span class="text-lg">💸</span>
      <span class="nav-label">Expenses</span>
    </a>
    <a href="/report.html" class="nav-item">
      <span class="text-lg">📋</span>
      <span class="nav-label">Reports</span>
    </a>
    <a href="/receipts.html" class="nav-item">
      <span class="text-lg">🧾</span>
      <span class="nav-label">Receipts</span>
    </a>
    <a href="/staff.html" class="nav-item">
      <span class="text-lg">👥</span>
      <span class="nav-label">Staff</span>
    </a>
    <a href="/users.html" id="navUsers" class="nav-item" style="display:none">
      <span class="text-lg">⚙️</span>
      <span class="nav-label">Users</span>
    </a>
```

Add a `data-i18n` attribute to each `.nav-label` span (only the attribute — leave the English text as literal fallback content):

```html
      <span class="nav-label" data-i18n="nav.dashboard">Dashboard</span>
      ...
      <span class="nav-label" data-i18n="nav.expenses">Expenses</span>
      ...
      <span class="nav-label" data-i18n="nav.reports">Reports</span>
      ...
      <span class="nav-label" data-i18n="nav.receipts">Receipts</span>
      ...
      <span class="nav-label" data-i18n="nav.staff">Staff</span>
      ...
      <span class="nav-label" data-i18n="nav.users">Users</span>
```

Apply this same edit identically to all six files (the sidebar markup is byte-for-byte duplicated across `index.html`, `expenses.html`, `receipts.html`, `staff.html`, `report.html`, `users.html` except for which `.nav-item` has the `active` class).

- [ ] **Step 3: Tag the two "Sign out" buttons with `data-i18n`**

Each page has a "Sign out" button in the sidebar footer markup (e.g. `public/index.html:100-105`) and `public/js/app.js` renders a second one dynamically in `renderUserHeader()` (`public/js/app.js:28-33`). Add `data-i18n="common.signOut"` to the static one in each of the six HTML files:

```html
        Sign out
      </button>
```
becomes
```html
        <span data-i18n="common.signOut">Sign out</span>
      </button>
```

(Wrap the text in a `span` rather than tagging the `button` itself, since `data-i18n` overwrites `textContent` and the button has no other children.)

- [ ] **Step 4: Wire `applyTranslations` + `renderLangSwitcher` into `public/js/app.js`**

At the top of `public/js/app.js`, add the import (after the existing `getEl` import on line 3):

```js
import { applyTranslations, renderLangSwitcher } from './i18n.js';
```

In the `DOMContentLoaded` handler (`public/js/app.js:150-176`), add the calls right after `renderUserHeader(authData.user);` (line 157):

```js
  renderUserHeader(authData.user);
  applyPermissions();
  applyTranslations();
  renderLangSwitcher(getEl('langSwitcher'));
```

Also update `renderUserHeader()` (`public/js/app.js:16-43`) so its dynamically-created "Sign out" button uses `t()` instead of the literal string. Change line 32:

```js
        <button onclick="logout()" title="Sign out"
```
to:
```js
        <button onclick="logout()" title="${t('common.signOut')}"
```

and line 32 (button text) from:
```js
          Sign out
```
to:
```js
          ${t('common.signOut')}
```

Add `t` to the import from Step 4 above: `import { applyTranslations, renderLangSwitcher, t } from './i18n.js';`.

- [ ] **Step 5: Add the switcher to `login.html`, which has no sidebar**

In `public/login.html`, add a mount point inside the `.logo` block (`public/login.html:269-275`), after the closing `</div>` of `.logo-text`:

```html
    <div class="logo">
      <div class="logo-icon">📊</div>
      <div class="logo-text">
        <h1>POS Analytics</h1>
        <p>Dashboard Portal</p>
      </div>
      <div id="langSwitcher" style="margin-left:auto;"></div>
    </div>
```

At the bottom of `public/login.html`, before the closing `</script>` tag of the inline script (`public/login.html:313-378`), the script is a plain (non-module) `<script>` tag. Since `i18n.js` is an ES module, add a second `<script type="module">` block right after it (before `</body>`):

```html
<script type="module">
  import { applyTranslations, renderLangSwitcher } from '/js/i18n.js';
  applyTranslations();
  renderLangSwitcher(document.getElementById('langSwitcher'));
</script>
</body>
</html>
```

- [ ] **Step 6: Manually verify**

Start the server (`npm run dev:uat`), open `http://localhost:3000/login`. Confirm the EN/ខ្មែរ toggle appears next to the logo. Click ខ្មែរ — page reloads, sidebar/login stays functionally identical (no translated strings yet besides nav labels once logged in). Log in, confirm the switcher appears in the sidebar header on the dashboard, and that all six nav labels plus "Sign out" now read in Khmer. Toggle back to EN and confirm it reverts. Reload without toggling — confirm the language persists.

- [ ] **Step 7: Commit**

```bash
git add public/js/app.js public/login.html public/index.html public/expenses.html public/receipts.html public/staff.html public/report.html public/users.html
git commit -m "feat(i18n): wire language switcher and translate shared nav shell"
```

---

### Task 3: Login page — full translation (worked example: forms + validation messages)

**Files:**
- Modify: `public/login.html`

**Interfaces:**
- Consumes: `t`, `applyTranslations` from Task 2's module-script block in `login.html`.
- Produces: `login.*` namespace in both dictionaries; this task is the reference pattern for form-heavy pages (Task 6 Expenses, Task 8 Staff, Task 10 Users all repeat this exact shape).

- [ ] **Step 1: Add the `login.*` keys to both dictionaries**

Append to `public/js/i18n/en.js`:

```js
  // ── login ───────────────────────────────────────────────
  'login.title': 'POS Analytics',
  'login.subtitle': 'Dashboard Portal',
  'login.welcome': 'Welcome back',
  'login.instructions': 'Sign in to access your analytics dashboard',
  'login.username': 'Username',
  'login.usernamePlaceholder': 'Enter your username',
  'login.password': 'Password',
  'login.passwordPlaceholder': 'Enter your password',
  'login.signIn': 'Sign In',
  'login.signingIn': 'Signing in...',
  'login.errorDefault': 'Invalid username or password.',
  'login.errorMissingFields': 'Please enter both username and password.',
  'login.errorConnection': 'Cannot connect to server. Please try again.',
  'login.footer': 'POS Analytics © 2025',
```

Append to `public/js/i18n/km.js`:

```js
  // ── login ───────────────────────────────────────────────
  'login.title': 'POS Analytics',
  'login.subtitle': 'ច្រកចូលផ្ទាំងគ្រប់គ្រង',
  'login.welcome': 'សូមស្វាគមន៍ការត្រឡប់មកវិញ',
  'login.instructions': 'ចូលគណនីដើម្បីចូលប្រើផ្ទាំងវិភាគរបស់អ្នក',
  'login.username': 'ឈ្មោះអ្នកប្រើប្រាស់',
  'login.usernamePlaceholder': 'បញ្ចូលឈ្មោះអ្នកប្រើប្រាស់',
  'login.password': 'ពាក្យសម្ងាត់',
  'login.passwordPlaceholder': 'បញ្ចូលពាក្យសម្ងាត់',
  'login.signIn': 'ចូលប្រើប្រាស់',
  'login.signingIn': 'កំពុងចូល...',
  'login.errorDefault': 'ឈ្មោះអ្នកប្រើប្រាស់ ឬពាក្យសម្ងាត់មិនត្រឹមត្រូវ។',
  'login.errorMissingFields': 'សូមបញ្ចូលទាំងឈ្មោះអ្នកប្រើប្រាស់ និងពាក្យសម្ងាត់។',
  'login.errorConnection': 'មិនអាចភ្ជាប់ទៅម៉ាស៊ីនមេបានទេ។ សូមព្យាយាមម្តងទៀត។',
  'login.footer': 'POS Analytics © ២០២៥',
```

- [ ] **Step 2: Tag static markup with `data-i18n`/`data-i18n-placeholder`**

In `public/login.html:269-308`, apply these changes (English fallback text unchanged, only attributes added):

```html
      <div class="logo-text">
        <h1 data-i18n="login.title">POS Analytics</h1>
        <p data-i18n="login.subtitle">Dashboard Portal</p>
      </div>
```

```html
    <h2 class="page-title" data-i18n="login.welcome">Welcome back</h2>
    <p class="page-sub" data-i18n="login.instructions">Sign in to access your analytics dashboard</p>
```

```html
      <span id="errorText" data-i18n="login.errorDefault">Invalid username or password.</span>
```

```html
      <label data-i18n="login.username">Username</label>
      <div class="input-wrap">
        <span class="icon">👤</span>
        <input type="text" id="username" data-i18n-placeholder="login.usernamePlaceholder" placeholder="Enter your username" autocomplete="username"/>
```

```html
      <label data-i18n="login.password">Password</label>
      <div class="input-wrap">
        <span class="icon">🔒</span>
        <input type="password" id="password" data-i18n-placeholder="login.passwordPlaceholder" placeholder="Enter your password" autocomplete="current-password"/>
```

```html
      <span class="spinner" id="spinner"></span>
      <span id="btnText" data-i18n="login.signIn">Sign In</span>
```

```html
    <p class="footer-note"><span data-i18n="login.footer">POS Analytics © 2025</span> &nbsp;·&nbsp; <span>Chab Mouth</span></p>
```

- [ ] **Step 3: Replace hardcoded strings in the inline `<script>` with `t()` calls**

`public/login.html:313-378` is a plain `<script>` (not a module), so it can't `import` directly — reference the already-imported `t` via the module script from Task 2 by exposing it on `window`. In the Task 2 module script block, change:

```html
<script type="module">
  import { applyTranslations, renderLangSwitcher } from '/js/i18n.js';
  applyTranslations();
  renderLangSwitcher(document.getElementById('langSwitcher'));
</script>
```

to:

```html
<script type="module">
  import { applyTranslations, renderLangSwitcher, t } from '/js/i18n.js';
  window.t = t;
  applyTranslations();
  renderLangSwitcher(document.getElementById('langSwitcher'));
</script>
```

Then in the plain script (`public/login.html:326-377`), replace the four hardcoded strings:

```js
  if (!username || !password) {
    showError(window.t('login.errorMissingFields'));
    return;
  }

  // Loading state
  btn.disabled      = true;
  spinner.style.display = 'block';
  btnText.textContent   = window.t('login.signingIn');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (res.ok && data.token) {
      localStorage.setItem('pos_token', data.token);
      localStorage.setItem('pos_user',  JSON.stringify(data.user));
      window.location.href = '/';
    } else {
      showError(data.message || window.t('login.errorDefault'));
    }
  } catch (err) {
    showError(window.t('login.errorConnection'));
  } finally {
    btn.disabled          = false;
    spinner.style.display = 'none';
    btnText.textContent   = window.t('login.signIn');
  }
```

Note: the plain `<script>` block runs before the module script guarantees `window.t` exists only if the module has executed; since ES modules execute in document order relative to other modules but `<script type="module">` is deferred by default, place the module script block **before** the plain script block in the file (move the `<script type="module">` from Task 2 Step 5 to just above the existing `<script>` tag at line 313) so `window.t` is available by the time a user can click "Sign In".

- [ ] **Step 4: Manually verify**

Reload `/login` in Khmer (switcher set to ខ្មែរ from Task 2's verification). Confirm: page title, subtitle, "Welcome back", instructions, both field labels, both placeholders, and the button text are all in Khmer. Trigger each error path (empty fields, wrong credentials, stop the server to trigger the connection-error path) and confirm each message is in Khmer. Switch back to EN and confirm everything reverts.

- [ ] **Step 5: Commit**

```bash
git add public/login.html public/js/i18n/en.js public/js/i18n/km.js
git commit -m "feat(i18n): translate login page"
```

---

### Task 4: Dashboard page — full translation (worked example: dynamic tables, charts, heatmap, toasts)

**Files:**
- Modify: `public/index.html`
- Modify: `public/js/pages/dashboard.js`
- Modify: `public/js/state.js:13` (`DAYS` constant)

**Interfaces:**
- Consumes: `t` from `public/js/i18n.js`.
- Produces: `dashboard.*` namespace; `t('common.dayShort.0'..'6')` for weekday abbreviations (shared namespace since Report/Schedule may reuse day names later — see Task 7/8 notes). This task is the reference pattern for chart legends/tooltips, table row templates, and toast messages, reused by Task 7 (Receipts tables), Task 8 (Staff tables), Task 9 (Report — near-identical KPI/chart code).

- [ ] **Step 1: Replace the `DAYS` constant with translation keys**

`public/js/state.js:13` currently reads:

```js
export const DAYS   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
```

Add day-name keys to both dictionaries instead of hardcoding English. Append to `public/js/i18n/en.js`:

```js
  // ── common: day names ───────────────────────────────────
  'common.day.0': 'Sun', 'common.day.1': 'Mon', 'common.day.2': 'Tue',
  'common.day.3': 'Wed', 'common.day.4': 'Thu', 'common.day.5': 'Fri', 'common.day.6': 'Sat',
```

Append to `public/js/i18n/km.js`:

```js
  // ── common: day names ───────────────────────────────────
  'common.day.0': 'អា', 'common.day.1': 'ច័ន្ទ', 'common.day.2': 'អង្គារ',
  'common.day.3': 'ពុធ', 'common.day.4': 'ព្រហ.', 'common.day.5': 'សុក្រ', 'common.day.6': 'សៅរ៍',
```

In `public/js/state.js`, remove the `DAYS` export (it's replaced by a function since it must read the current language at call time, not at module-load time):

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

export const COLORS = ['#f59e0b','#3b82f6','#10b981','#f43f5e','#8b5cf6','#06b6d4','#84cc16','#ec4899'];
```

In `public/js/charts.js:1,4`, remove `DAYS` from the re-export:

```js
import { state, COLORS } from './state.js';
import { fmt } from './utils.js';

export { COLORS };
```

- [ ] **Step 2: Add a `days()` helper to `public/js/i18n.js`**

Add this export to `public/js/i18n.js` (alongside the existing exports from Task 1):

```js
export function days() {
  return [0, 1, 2, 3, 4, 5, 6].map(i => t(`common.day.${i}`));
}
```

- [ ] **Step 3: Update `public/js/pages/dashboard.js` to use `days()` and `t`**

Change the import on line 1 and add the i18n import:

```js
import { state, COLORS } from '../state.js';
import { t, days } from '../i18n.js';
```

In `loadPeakHours()` (`public/js/pages/dashboard.js:274-282`), replace `DAYS.forEach(...)`:

```js
  days().forEach((day, d) => {
    html += `<div class="heatmap-row"><div class="heatmap-label">${day}</div>`;
    for (let h = 0; h < 24; h++) {
      const val   = matrix[d][h];
      const ratio = maxVal > 0 ? val / maxVal : 0;
      html += `<div class="heatmap-cell" style="background:${heatColor(ratio)}" title="${day} ${h}:00 — ៛${fmt(val)}"></div>`;
    }
    html += '</div>';
  });
```

- [ ] **Step 4: Add the `dashboard.*` keys to both dictionaries**

Append to `public/js/i18n/en.js`:

```js
  // ── dashboard ───────────────────────────────────────────
  'dashboard.title': 'Dashboard',
  'dashboard.syncButton': 'Sync Gross Income',
  'dashboard.syncing': 'Syncing…',
  'dashboard.periodWeek': 'Last 7 days',
  'dashboard.periodMonth': 'Last Month',
  'dashboard.periodYear': 'Year',
  'dashboard.periodCustom': 'Custom',
  'dashboard.from': 'From',
  'dashboard.to': 'To',
  'dashboard.periodPerformance': 'Period Performance',
  'dashboard.dailyBenchmarks': 'Daily Benchmarks',
  'dashboard.dailyBenchmarksSub': 'per-day averages for the period',
  'dashboard.perDayAvg': 'per day · avg',
  'dashboard.avgValuePerOrder': 'avg value per order',
  'dashboard.kpi.grossIncome': 'Gross Income',
  'dashboard.kpi.netProfit': 'Net Profit',
  'dashboard.kpi.orders': 'Orders',
  'dashboard.kpi.expenses': 'Expenses',
  'dashboard.kpi.netSub': 'Gross minus expenses',
  'dashboard.kpi.aovSub': 'AOV',
  'dashboard.kpi.marginSub': '{margin}% margin',
  'dashboard.kpi.pctOfGross': '{pct}% of gross income',
  'dashboard.grossIncomeChartTitle': '📈 Gross Income and Expenses',
  'dashboard.grossIncomeChartSub': 'Period matched to global filter',
  'dashboard.grossIncomeRangeCustom': 'Custom range {start} → {end}',
  'dashboard.grossIncomeRangeWeek': 'Last 7 days',
  'dashboard.grossIncomeRangeMonth': 'Last month',
  'dashboard.grossIncomeRangeYear': 'Last year',
  'dashboard.grossIncomeRangePeriod': 'Period: {period}',
  'dashboard.diningTitle': '🍽️ Dining Options',
  'dashboard.paymentTitle': '💳 Payment Methods',
  'dashboard.heatmapTitle': '🔥 Peak Hours Heatmap',
  'dashboard.topProductsTitle': '🛒 Top Products',
  'dashboard.topProductsSub': 'Top 20 by revenue · green = growing · red = declining',
  'dashboard.categoryAll': 'All',
  'dashboard.categoryFood': 'Food',
  'dashboard.categoryBeverage': 'Beverage',
  'dashboard.table.rank': '#',
  'dashboard.table.item': 'Item',
  'dashboard.table.qty': 'Qty',
  'dashboard.table.revenue': 'Revenue',
  'dashboard.table.lastPeriod': 'Last Period',
  'dashboard.table.growth': 'Growth',
  'dashboard.loadingRow': 'Loading...',
  'dashboard.noDataRow': 'No data for this period',
  'dashboard.showSlowMovers': 'Show Bottom 10 Slow Movers',
  'dashboard.hideSlowMovers': 'Hide Bottom 10 Slow Movers',
  'dashboard.employeeTitle': '👤 Employee Performance',
  'dashboard.deviceTitle': '🖥️ Device Performance',
  'dashboard.cancelledTitle': '🚨 Cancelled Orders',
  'dashboard.cancelledCount': '{count} cancelled',
  'dashboard.cancelledLost': 'Lost: {amount}',
  'dashboard.noCancellations': 'No cancellations in this period ✅',
  'dashboard.unknown': 'Unknown',
  'dashboard.syncSkipped': 'Already synced for yesterday',
  'dashboard.syncSuccess': 'Synced {count} receipt(s)',
  'dashboard.syncFailed': 'Sync failed',
  'dashboard.syncFailedConnection': 'Sync failed — check connection',
  'dashboard.lastSync': '{icon} Last sync: {date} ({by})',
  'dashboard.syncAuto': 'auto',
  'dashboard.syncManual': 'manual',
  'dashboard.errorMissingDates': 'Please choose both a start and end date.',
  'dashboard.errorDateOrder': 'Start date must be before or equal to end date.',
```

Append the mirrored Khmer keys to `public/js/i18n/km.js` (same key set):

```js
  // ── dashboard ───────────────────────────────────────────
  'dashboard.title': 'ផ្ទាំងគ្រប់គ្រង',
  'dashboard.syncButton': 'ធ្វើសមកាលកម្មចំណូលដុល',
  'dashboard.syncing': 'កំពុងធ្វើសមកាលកម្ម…',
  'dashboard.periodWeek': '៧ថ្ងៃចុងក្រោយ',
  'dashboard.periodMonth': 'ខែមុន',
  'dashboard.periodYear': 'ឆ្នាំ',
  'dashboard.periodCustom': 'កំណត់ដោយខ្លួនឯង',
  'dashboard.from': 'ពី',
  'dashboard.to': 'ដល់',
  'dashboard.periodPerformance': 'សមិទ្ធផលក្នុងកំឡុងពេល',
  'dashboard.dailyBenchmarks': 'ស្តង់ដារប្រចាំថ្ងៃ',
  'dashboard.dailyBenchmarksSub': 'មធ្យមភាគប្រចាំថ្ងៃសម្រាប់កំឡុងពេលនេះ',
  'dashboard.perDayAvg': 'មធ្យមភាគ · ក្នុងមួយថ្ងៃ',
  'dashboard.avgValuePerOrder': 'តម្លៃមធ្យមក្នុងមួយការបញ្ជាទិញ',
  'dashboard.kpi.grossIncome': 'ចំណូលដុល',
  'dashboard.kpi.netProfit': 'ប្រាក់ចំណេញសុទ្ធ',
  'dashboard.kpi.orders': 'ការបញ្ជាទិញ',
  'dashboard.kpi.expenses': 'ចំណាយ',
  'dashboard.kpi.netSub': 'ចំណូលដុលដកចំណាយ',
  'dashboard.kpi.aovSub': 'តម្លៃមធ្យម',
  'dashboard.kpi.marginSub': 'កម្រៃ {margin}%',
  'dashboard.kpi.pctOfGross': '{pct}% នៃចំណូលដុល',
  'dashboard.grossIncomeChartTitle': '📈 ចំណូលដុល និងចំណាយ',
  'dashboard.grossIncomeChartSub': 'កំឡុងពេលត្រូវគ្នានឹងតម្រងសកល',
  'dashboard.grossIncomeRangeCustom': 'កំឡុងពេលកំណត់ {start} → {end}',
  'dashboard.grossIncomeRangeWeek': '៧ថ្ងៃចុងក្រោយ',
  'dashboard.grossIncomeRangeMonth': 'ខែមុន',
  'dashboard.grossIncomeRangeYear': 'ឆ្នាំមុន',
  'dashboard.grossIncomeRangePeriod': 'កំឡុងពេល៖ {period}',
  'dashboard.diningTitle': '🍽️ ជម្រើសកន្លែងទទួលទាន',
  'dashboard.paymentTitle': '💳 វិធីទូទាត់',
  'dashboard.heatmapTitle': '🔥 ម៉ោងមមាញឹកបំផុត',
  'dashboard.topProductsTitle': '🛒 ទំនិញលក់ដាច់បំផុត',
  'dashboard.topProductsSub': 'កំពូល ២០ តាមចំណូល · បៃតង = កំពុងកើនឡើង · ក្រហម = កំពុងធ្លាក់ចុះ',
  'dashboard.categoryAll': 'ទាំងអស់',
  'dashboard.categoryFood': 'អាហារ',
  'dashboard.categoryBeverage': 'ភេសជ្ជៈ',
  'dashboard.table.rank': '#',
  'dashboard.table.item': 'ទំនិញ',
  'dashboard.table.qty': 'ចំនួន',
  'dashboard.table.revenue': 'ចំណូល',
  'dashboard.table.lastPeriod': 'កំឡុងពេលមុន',
  'dashboard.table.growth': 'កំណើន',
  'dashboard.loadingRow': 'កំពុងផ្ទុក...',
  'dashboard.noDataRow': 'មិនមានទិន្នន័យសម្រាប់កំឡុងពេលនេះ',
  'dashboard.showSlowMovers': 'បង្ហាញ ១០ ទំនិញលក់យឺតបំផុត',
  'dashboard.hideSlowMovers': 'លាក់ ១០ ទំនិញលក់យឺតបំផុត',
  'dashboard.employeeTitle': '👤 សមិទ្ធផលបុគ្គលិក',
  'dashboard.deviceTitle': '🖥️ សមិទ្ធផលឧបករណ៍',
  'dashboard.cancelledTitle': '🚨 ការបញ្ជាទិញដែលបានលុបចោល',
  'dashboard.cancelledCount': 'បានលុបចោល {count}',
  'dashboard.cancelledLost': 'បាត់បង់៖ {amount}',
  'dashboard.noCancellations': 'មិនមានការលុបចោលក្នុងកំឡុងពេលនេះទេ ✅',
  'dashboard.unknown': 'មិនស្គាល់',
  'dashboard.syncSkipped': 'បានធ្វើសមកាលកម្មរួចហើយសម្រាប់ម្សិលមិញ',
  'dashboard.syncSuccess': 'បានធ្វើសមកាលកម្មបង្កាន់ដៃ {count}',
  'dashboard.syncFailed': 'ការធ្វើសមកាលកម្មបរាជ័យ',
  'dashboard.syncFailedConnection': 'ការធ្វើសមកាលកម្មបរាជ័យ — សូមពិនិត្យការតភ្ជាប់',
  'dashboard.lastSync': '{icon} សមកាលកម្មចុងក្រោយ៖ {date} ({by})',
  'dashboard.syncAuto': 'ស្វ័យប្រវត្តិ',
  'dashboard.syncManual': 'ដោយដៃ',
  'dashboard.errorMissingDates': 'សូមជ្រើសរើសទាំងកាលបរិច្ឆេទចាប់ផ្តើម និងបញ្ចប់។',
  'dashboard.errorDateOrder': 'កាលបរិច្ឆេទចាប់ផ្តើមត្រូវតែមុន ឬស្មើកាលបរិច្ឆេទបញ្ចប់។',
```

- [ ] **Step 5: Tag static markup in `public/index.html` with `data-i18n`**

Apply `data-i18n` to (English text unchanged, keys per Step 4 above): the `<h2>` at line 155 (`dashboard.title`), the sync button at line 161 (`dashboard.syncButton`), the four period buttons at lines 165-168 (`dashboard.periodWeek/Month/Year/Custom`), the "From"/"To" labels at lines 171-172 (`dashboard.from`/`dashboard.to`), the "Apply" button at line 173 (`common.apply`), the two section labels at lines 184 and 198 (`dashboard.periodPerformance`, `dashboard.dailyBenchmarks`), the sub-label at line 199 (`dashboard.dailyBenchmarksSub`), the chart section titles at lines 213, 222, 227, 235, 244, 301, 305, 313 (`dashboard.grossIncomeChartTitle`, `dashboard.diningTitle`, `dashboard.paymentTitle`, `dashboard.heatmapTitle`, `dashboard.topProductsTitle`, `dashboard.employeeTitle`, `dashboard.deviceTitle`, `dashboard.cancelledTitle`), the sub-label at line 214 (`dashboard.grossIncomeChartSub`), the sub-label at line 246 (`dashboard.topProductsSub`), the three `<option>` values at lines 248-250 (`dashboard.categoryAll/Food/Beverage`), the six table headers at lines 258-263 (`dashboard.table.rank/item/qty/revenue/lastPeriod/growth`), the loading-row cells at lines 267 and 291 (`dashboard.loadingRow`), and the slow-movers toggle text at line 276 (this one is rebuilt dynamically in JS — see Step 6, remove the static English there and let JS own it).

Example for one representative block (line 155):
```html
        <h2 class="text-lg font-semibold" data-i18n="dashboard.title">Dashboard</h2>
```

Example for the period buttons (lines 165-168):
```html
          <button onclick="setPeriod('week')"   class="period-btn active" data-period="week" data-i18n="dashboard.periodWeek">Last 7 days</button>
          <button onclick="setPeriod('month')"  class="period-btn" data-period="month" data-i18n="dashboard.periodMonth">Last Month</button>
          <button onclick="setPeriod('year')"   class="period-btn" data-period="year" data-i18n="dashboard.periodYear">Year</button>
          <button onclick="setPeriod('range')"  class="period-btn" data-period="range" data-i18n="dashboard.periodCustom">Custom</button>
```

Follow the same `data-i18n="<key>"` attribute-only pattern (no textContent removed) for every element listed above, matching each element to its key one-for-one.

- [ ] **Step 6: Replace hardcoded strings in `public/js/pages/dashboard.js` with `t()`**

Replace the KPI card builders in `loadKPIs()` (lines 59-133) — change every `label:` literal and the two `sub:` template literals using the new keys:

```js
  const primary = [
    {
      accent: 'amber', icon: '💰', label: t('dashboard.kpi.grossIncome'),
      val: '៛' + fmtRaw(grossVal), valClass: 'text-amber-400',
      growth: data.gross_income.growth,
      sub: `<span class="${netValClass} font-semibold">Net ៛${fmtRaw(Math.abs(netVal))}</span>`
         + `<span class="text-slate-600"> · ${t('dashboard.kpi.marginSub', { margin })}</span>`,
    },
    {
      accent: netAccent, icon: netIcon, label: t('dashboard.kpi.netProfit'),
      val: (netPositive ? '' : '-') + '៛' + fmtRaw(Math.abs(netVal)),
      valClass: netValClass,
      growth: null,
      sub: `<span class="text-slate-500">${t('dashboard.kpi.netSub')}</span>`,
    },
    {
      accent: 'blue', icon: '🧾', label: t('dashboard.kpi.orders'),
      val: fmtRaw(data.orders.value), valClass: 'text-sky-400',
      growth: data.orders.growth,
      sub: `<span class="text-slate-500">${t('dashboard.kpi.aovSub')} </span>`
         + `<span class="text-slate-300 font-semibold">៛${fmtRaw(data.aov.value)}</span>`,
    },
    {
      accent: 'red', icon: '💸', label: t('dashboard.kpi.expenses'),
      val: '-៛' + fmtRaw(expVal), valClass: 'text-red-400',
      growth: data.expenses.growth,
      sub: `<span class="text-slate-600">${t('dashboard.kpi.pctOfGross', { pct: expPct })}</span>`,
    },
  ];
```

```js
  const averages = [
    {
      accent: 'amber', label: t('dashboard.kpi.grossIncome'),
      val: '៛' + fmtRaw(data.avg_gross_income?.value ?? 0),
      valClass: 'text-amber-400',
      growth: data.avg_gross_income?.growth,
      sub: t('dashboard.perDayAvg'),
    },
    {
      accent: avgNetAccent, label: t('dashboard.kpi.netProfit'),
      val: (avgNetPositive ? '' : '-') + '៛' + fmtRaw(Math.abs(avgNetVal)),
      valClass: avgNetClass,
      growth: data.net_per_order?.growth,
      sub: t('dashboard.perDayAvg'),
      highlight: true,
    },
    {
      accent: 'violet', label: t('dashboard.kpi.orders'),
      val: '៛' + fmtRaw(data.aov?.value ?? 0),
      valClass: 'text-violet-400',
      growth: data.aov?.growth,
      sub: t('dashboard.avgValuePerOrder'),
    },
    {
      accent: 'red', label: t('dashboard.kpi.expenses'),
      val: '-៛' + fmtRaw(data.avg_expense?.value ?? 0),
      valClass: 'text-red-400',
      growth: data.avg_expense?.growth,
      sub: t('dashboard.perDayAvg'),
    },
  ];
```

Replace the trend label in `loadGrossIncomeTrend()` (lines 154-160):

```js
  const trendLabel = getEl('grossIncomeLabel');
  if (trendLabel) trendLabel.textContent = p === 'range'
    ? t('dashboard.grossIncomeRangeCustom', { start: s, end: e })
    : p === 'week'  ? t('dashboard.grossIncomeRangeWeek')
    : p === 'month' ? t('dashboard.grossIncomeRangeMonth')
    : p === 'year'  ? t('dashboard.grossIncomeRangeYear')
    : t('dashboard.grossIncomeRangePeriod', { period: p });
```

Replace the two chart dataset labels in `loadGrossIncomeTrend()` (lines 183-184):

```js
        { label: t('dashboard.kpi.grossIncome'), data: revenue, backgroundColor: 'rgba(245,158,11,0.7)', borderColor: '#f59e0b', borderWidth: 1, borderRadius: 6 },
        { label: t('dashboard.kpi.expenses'),     data: expenses, backgroundColor: 'rgba(239,68,68,0.7)',  borderColor: '#ef4444', borderWidth: 1, borderRadius: 6 },
```

Replace the "No data" row in `renderProductRows()` (line 293):

```js
    tbody.innerHTML = `<tr><td colspan="6" class="py-4 text-center text-slate-500">${t('dashboard.noDataRow')}</td></tr>`;
```

Replace the slow-movers toggle text in `toggleSlowMovers()` (line 341):

```js
    btn.innerHTML = `<span id="slowMoversArrow">${isHidden ? '▼' : '▶'}</span> ${isHidden ? t('dashboard.hideSlowMovers') : t('dashboard.showSlowMovers')}`;
```

Since this text is now fully JS-owned, remove the static English after `<span id="slowMoversArrow">▶</span>` in `public/index.html:276` (leave the `<span>` and `id`, drop the trailing " Show Bottom 10 Slow Movers" text — JS sets it on load via `init()` calling `renderProductRows`/toggle logic already in place; no init-time call needed since the button always starts in the "Show" state matching the HTML default of `▶`). Concretely, `public/index.html:274-277` becomes:

```html
        <button onclick="dashboardToggleSlowMovers()" id="slowMoversBtn"
          class="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1">
          <span id="slowMoversArrow">▶</span>
        </button>
```

and add one line to `init()` (`public/js/pages/dashboard.js:515-526`) to set the initial label since it's no longer in the HTML:

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

Replace the employee/device "Unknown" fallbacks (lines 357, 374):

```js
      labels: data.map(r => r.employee_id || t('dashboard.unknown')),
```
```js
      labels: data.map(r => r.device_name || t('dashboard.unknown')),
```

Replace the two chart dataset labels `'Revenue'` (lines 358, 375) with `t('dashboard.table.revenue')`.

Replace the cancelled-orders summary in `loadCancelledOrders()` (lines 388-404):

```js
  const cancelSummary = getEl('cancelSummary');
  if (cancelSummary) cancelSummary.innerHTML = `
    <span class="text-red-400 font-bold">${t('dashboard.cancelledCount', { count: data.summary.count })}</span>
    <span class="text-slate-400">${t('dashboard.cancelledLost', { amount: '<span class="text-red-300 font-bold">$' + fmt(data.summary.lost_revenue) + '</span>' })}</span>
  `;

  const cancelList = getEl('cancelList');
  if (cancelList) cancelList.innerHTML = data.items.length
    ? data.items.map(r => `
        <div class="cancel-row">
          <div>
            <div class="font-medium text-red-200">#${r.receipt_number}</div>
            <div class="text-xs text-slate-500">${fmtDatetime(r.cancelled_at)} · ${r.dining_option || '-'} · ${r.employee_id || '-'}</div>
          </div>
          <div class="text-red-400 font-bold">-$${fmt(r.total_money)}</div>
        </div>
      `).join('')
    : `<p class="text-slate-500 text-sm">${t('dashboard.noCancellations')}</p>`;
```

Replace the sync-related strings in `syncGrossIncome()` (lines 455-476):

```js
export async function syncGrossIncome() {
  const btn = getEl('syncBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('dashboard.syncing'); }
  try {
    const res = await apiPost('/api/receipts/sync', {});
    const data = res.data || {};
    if (res.ok) {
      const msg = data.status === 'skipped'
        ? t('dashboard.syncSkipped')
        : t('dashboard.syncSuccess', { count: data.inserted ?? 0 });
      showSyncToast(msg, 'success');
      loadGrossIncomeTrend();
      loadLastSync();
    } else {
      showSyncToast(data.error || t('dashboard.syncFailed'), 'error');
    }
  } catch (err) {
    showSyncToast(t('dashboard.syncFailedConnection'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('dashboard.syncButton'); }
  }
}
```

Replace the last-sync chip text in `loadLastSync()` (lines 505-506):

```js
    const by = row.triggered_by === 'auto' ? t('dashboard.syncAuto') : t('dashboard.syncManual');
    chip.textContent = t('dashboard.lastSync', { icon, date, by });
```

Replace the two `alert()` calls in `applyCustomRange()` (lines 445-446):

```js
  if (!start || !end) { alert(t('dashboard.errorMissingDates')); return; }
  if (start > end)    { alert(t('dashboard.errorDateOrder')); return; }
```

- [ ] **Step 7: Manually verify**

Log in, toggle to ខ្មែរ, reload the dashboard. Confirm: all four period buttons, all section titles, both KPI rows (labels + sub-text + margin/percent interpolation), the gross-income chart legend and date-range label, dining/payment legends, the heatmap's day-of-week row (now in Khmer) and hover tooltips, the top-products table headers and "No data"/"Loading" states, the slow-movers toggle text (both states — click it), employee/device chart labels, and the cancelled-orders panel are all in Khmer. Click "Sync Gross Income" and confirm the toast message and button states show Khmer text. Trigger the custom-range validation alerts (leave a date blank, then pick start > end) and confirm both are in Khmer. Switch back to EN and spot-check the same list.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/js/pages/dashboard.js public/js/state.js public/js/charts.js public/js/i18n.js public/js/i18n/en.js public/js/i18n/km.js
git commit -m "feat(i18n): translate dashboard page"
```

---

### Task 5: Expenses page — full translation (worked example: forms + list + pagination + confirm dialogs)

**Files:**
- Modify: `public/expenses.html`
- Modify: `public/js/pages/expenses.js`

**Interfaces:**
- Consumes: `t` from `public/js/i18n.js`.
- Produces: `expenses.*` namespace. Reference pattern (alongside Task 3) for Task 7 (Staff) and Task 8 (Users), which share the same form/list/confirm-dialog shape.

- [ ] **Step 1: Add `expenses.*` keys to both dictionaries**

Append to `public/js/i18n/en.js`:

```js
  // ── expenses ────────────────────────────────────────────
  'expenses.title': 'Expenses',
  'expenses.subtitle': 'Manage expense entries',
  'expenses.listSubtitle': 'Add, edit, and review expense records',
  'expenses.date': 'Date',
  'expenses.amount': 'Amount',
  'expenses.expenseBy': 'Expense by',
  'expenses.expenseByPlaceholder': 'Name',
  'expenses.remark': 'Remark',
  'expenses.remarkPlaceholder': 'Optional note',
  'expenses.addButton': 'Add Expense',
  'expenses.saveButton': 'Save Changes',
  'expenses.listTitle': '💸 Expenses List',
  'expenses.start': 'Start',
  'expenses.end': 'End',
  'expenses.loading': 'Loading...',
  'expenses.loadFailed': 'Failed to load expenses.',
  'expenses.noneForRange': 'No expenses recorded for the selected range.',
  'expenses.summary': '{count} item{plural} · Total: {total}',
  'expenses.prev': 'Prev',
  'expenses.next': 'Next',
  'expenses.pageInfo': 'Page {page} / {pages} · {total} items',
  'expenses.errorRequiredFields': 'Please fill required fields.',
  'expenses.confirmUpdate': 'Are you sure you want to update this expense?',
  'expenses.confirmAdd': 'Are you sure you want to add this expense?',
  'expenses.saveFailed': 'Failed to save expense.',
  'expenses.updated': 'Updated.',
  'expenses.saved': 'Saved.',
  'expenses.notFound': 'Expense not found.',
  'expenses.confirmDelete': 'Are you sure you want to delete this expense? This cannot be undone.',
  'expenses.deleteFailed': 'Failed to delete expense.',
  'expenses.exportLoadFailed': 'Failed to load expenses.',
  'expenses.csvDate': 'Date',
  'expenses.csvAmount': 'Amount (KHR)',
  'expenses.csvExpenseBy': 'Expense By',
  'expenses.csvRemark': 'Remark',
```

Append to `public/js/i18n/km.js`:

```js
  // ── expenses ────────────────────────────────────────────
  'expenses.title': 'ចំណាយ',
  'expenses.subtitle': 'គ្រប់គ្រងកំណត់ត្រាចំណាយ',
  'expenses.listSubtitle': 'បន្ថែម កែប្រែ និងពិនិត្យកំណត់ត្រាចំណាយ',
  'expenses.date': 'កាលបរិច្ឆេទ',
  'expenses.amount': 'ចំនួនទឹកប្រាក់',
  'expenses.expenseBy': 'ចំណាយដោយ',
  'expenses.expenseByPlaceholder': 'ឈ្មោះ',
  'expenses.remark': 'ចំណាំ',
  'expenses.remarkPlaceholder': 'ចំណាំបន្ថែម (មិនចាំបាច់)',
  'expenses.addButton': 'បន្ថែមចំណាយ',
  'expenses.saveButton': 'រក្សាទុកការកែប្រែ',
  'expenses.listTitle': '💸 បញ្ជីចំណាយ',
  'expenses.start': 'ចាប់ផ្តើម',
  'expenses.end': 'បញ្ចប់',
  'expenses.loading': 'កំពុងផ្ទុក...',
  'expenses.loadFailed': 'បរាជ័យក្នុងការផ្ទុកទិន្នន័យចំណាយ។',
  'expenses.noneForRange': 'មិនមានកំណត់ត្រាចំណាយសម្រាប់កំឡុងពេលដែលបានជ្រើសរើសទេ។',
  'expenses.summary': '{count} ធាតុ{plural} · សរុប៖ {total}',
  'expenses.prev': 'មុន',
  'expenses.next': 'បន្ទាប់',
  'expenses.pageInfo': 'ទំព័រ {page} / {pages} · {total} ធាតុ',
  'expenses.errorRequiredFields': 'សូមបំពេញព័ត៌មានដែលត្រូវការ។',
  'expenses.confirmUpdate': 'តើអ្នកប្រាកដថាចង់កែប្រែចំណាយនេះមែនទេ?',
  'expenses.confirmAdd': 'តើអ្នកប្រាកដថាចង់បន្ថែមចំណាយនេះមែនទេ?',
  'expenses.saveFailed': 'បរាជ័យក្នុងការរក្សាទុកចំណាយ។',
  'expenses.updated': 'បានធ្វើបច្ចុប្បន្នភាព។',
  'expenses.saved': 'បានរក្សាទុក។',
  'expenses.notFound': 'រកមិនឃើញចំណាយនេះទេ។',
  'expenses.confirmDelete': 'តើអ្នកប្រាកដថាចង់លុបចំណាយនេះមែនទេ? សកម្មភាពនេះមិនអាចត្រឡប់វិញបានទេ។',
  'expenses.deleteFailed': 'បរាជ័យក្នុងការលុបចំណាយ។',
  'expenses.exportLoadFailed': 'បរាជ័យក្នុងការផ្ទុកទិន្នន័យចំណាយ។',
  'expenses.csvDate': 'កាលបរិច្ឆេទ',
  'expenses.csvAmount': 'ចំនួនទឹកប្រាក់ (KHR)',
  'expenses.csvExpenseBy': 'ចំណាយដោយ',
  'expenses.csvRemark': 'ចំណាំ',
```

- [ ] **Step 2: Tag static markup in `public/expenses.html` with `data-i18n`**

Apply `data-i18n` (English text unchanged) to: the `<h2>` at line 150 (`expenses.title`), the `<p>` at line 151 (`expenses.subtitle`), the `<p>` at line 160 (`expenses.listSubtitle`), the four field labels at lines 166, 170, 174, 178 (`expenses.date`, `expenses.amount`, `expenses.expenseBy`, `expenses.remark`), the two placeholders at lines 175, 179 (`data-i18n-placeholder="expenses.expenseByPlaceholder"` / `expenses.remarkPlaceholder`), the submit button at line 182 (`expenses.addButton`), the list title at line 189 (`expenses.listTitle`), the "Start"/"End" labels at lines 194, 196 (`expenses.start`, `expenses.end`), and the CSV button's visible text at line 198 (wrap `⬇ CSV` in a span with `data-i18n="common.csv"`).

Example (line 182):
```html
          <button type="submit" class="bg-amber-500 hover:bg-amber-400 text-slate-900 text-sm font-semibold px-4 py-2 rounded" data-i18n="expenses.addButton">Add Expense</button>
```

- [ ] **Step 3: Replace hardcoded strings in `public/js/pages/expenses.js` with `t()`**

Add the import at the top:

```js
import { t } from '../i18n.js';
```

Replace `updateExpenseSummary()` (lines 8-12):

```js
function updateExpenseSummary(count, totalAmount) {
  const summary = getEl('expensesSummary');
  if (!summary) return;
  const total = `<span class="text-sm text-amber-600 font-bold">៛${fmtRaw(totalAmount, 2)}</span>`;
  const countHtml = `<span class="text-sm text-amber-600 font-bold">${count}</span>`;
  summary.innerHTML = t('expenses.summary', { count: countHtml, plural: count === 1 ? '' : 's', total }).replace('{count}', countHtml);
}
```

Wait — `t()`'s `{count}` interpolation already substitutes `countHtml` via the `vars.count` value since the call passes `count: countHtml`; simplify to:

```js
function updateExpenseSummary(count, totalAmount) {
  const summary = getEl('expensesSummary');
  if (!summary) return;
  const countHtml = `<span class="text-sm text-amber-600 font-bold">${count}</span>`;
  const total = `<span class="text-sm text-amber-600 font-bold">៛${fmtRaw(totalAmount, 2)}</span>`;
  summary.innerHTML = t('expenses.summary', { count: countHtml, plural: count === 1 ? '' : 's', total });
}
```

Replace the loading/error/empty states in `loadExpenses()` (lines 19, 30, 37):

```js
  container.innerHTML = `<div class="text-slate-500">${t('expenses.loading')}</div>`;
```
```js
    container.innerHTML = `<div class="text-slate-500">${t('expenses.loadFailed')}</div>`;
```
```js
    container.innerHTML = `<div class="text-slate-500">${t('expenses.noneForRange')}</div>`;
```

Replace the Edit/Delete button labels in the row template (lines 56-57):

```js
          <button onclick="startEditExpense(${e.id})" class="text-sm text-slate-300 hover:text-amber-400">${t('common.edit')}</button>
          <button onclick="confirmDeleteExpense(${e.id})" class="text-sm text-red-400 hover:text-red-300">${t('common.delete')}</button>` : ''}
```

Replace the pagination text in `renderPagination()` (lines 81, 86, 92):

```js
  prev.textContent = t('expenses.prev');
```
```js
  next.textContent = t('expenses.next');
```
```js
  info.textContent = t('expenses.pageInfo', { page, pages, total });
```

Replace the validation/confirm/status messages in `submitExpense()` (lines 130, 134, 142, 146, 149):

```js
  if (!expense_date || !amount || !expense_by) {
    if (msg) msg.textContent = t('expenses.errorRequiredFields');
    return;
  }

  if (state.currentUserRole !== 'admin' && !confirm(editingId ? t('expenses.confirmUpdate') : t('expenses.confirmAdd'))) return;

  const body = { expense_date, amount, remark, expense_by };
  const res  = editingId
    ? await apiPut(`/api/expenses/${editingId}`, body)
    : await apiPost('/api/expenses', body);

  if (!res.ok) {
    if (msg) msg.textContent = res.data?.message || t('expenses.saveFailed');
    return;
  }

  if (msg) msg.textContent = editingId ? t('expenses.updated') : t('expenses.saved');
  getEl('expenseForm').reset();
  window.editingExpenseId = null;
  getEl('expenseForm').querySelector('button[type=submit]').textContent = t('expenses.addButton');
  loadExpenses();
```

Replace `startEditExpense()` (lines 157, 164):

```js
    if (!item) return alert(t('expenses.notFound'));

    getEl('expenseDate').value   = item.expense_date.split('T')[0];
    getEl('expenseAmount').value = item.amount;
    getEl('expenseBy').value     = item.expense_by;
    getEl('expenseRemark').value = item.remark || '';
    window.editingExpenseId      = id;
    getEl('expenseForm').querySelector('button[type=submit]').textContent = t('expenses.saveButton');
```

Replace `confirmDeleteExpense()` and `deleteExpense()` (lines 170, 176):

```js
export function confirmDeleteExpense(id) {
  if (!confirm(t('expenses.confirmDelete'))) return;
  deleteExpense(id);
}

async function deleteExpense(id) {
  const res = await apiDelete(`/api/expenses/${id}`);
  if (!res.ok) { alert(res.data?.message || t('expenses.deleteFailed')); return; }
  loadExpenses();
}
```

Replace `exportExpensesCSV()` (lines 187, 189):

```js
  if (!data?.items) return alert(t('expenses.exportLoadFailed'));
  downloadCSV(`expenses-${new Date().toISOString().slice(0, 10)}.csv`, [
    [t('expenses.csvDate'), t('expenses.csvAmount'), t('expenses.csvExpenseBy'), t('expenses.csvRemark')],
    ...data.items.map(e => [e.expense_date?.slice(0, 10) || '', e.amount, e.expense_by, e.remark ?? '']),
  ]);
```

- [ ] **Step 4: Manually verify**

Toggle to ខ្មែរ, reload `/expenses.html`. Confirm the page title/subtitle, form labels, placeholders, "Add Expense" button, list title, Start/End labels, CSV button, and summary line are all in Khmer. Submit the form with missing fields (see the required-fields message), then with all fields filled as a non-admin user (see the confirm dialog text — requires a manager-role login; if only an admin account is available, note in the PR that the confirm-dialog path was verified by code inspection rather than live click). Edit an existing expense (see "Save Changes" + confirm dialog + "Updated." message) and delete one (see the delete confirm + result). Page through results if there are more than one page and confirm "Prev"/"Next"/page-info text. Export CSV and open it to confirm Khmer column headers. Switch back to EN and spot-check.

- [ ] **Step 5: Commit**

```bash
git add public/expenses.html public/js/pages/expenses.js public/js/i18n/en.js public/js/i18n/km.js
git commit -m "feat(i18n): translate expenses page"
```

---

### Task 6: Receipts page — full translation (pattern-following)

**Files:**
- Modify: `public/receipts.html`
- Modify: `public/js/pages/receipts.js`

**Interfaces:**
- Consumes: `t` from `public/js/i18n.js`. Follows the exact conventions demonstrated in Task 4 (dynamic tables/tooltips) and Task 5 (forms, CSV export, empty/loading states).
- Produces: `receipts.*` namespace.

- [ ] **Step 1: Read `public/receipts.html` and `public/js/pages/receipts.js` in full**

Confirmed structure from earlier exploration: page header "Receipts" (`receipts.html:273`); filter panel with Search/From/To/Type labels and a Reset button (`receipts.html:319-345`); Type `<select>` with options All/Sale/Refund (`receipts.html:339-341`); a results table with headers `#`, `Receipt No.`, `Order`, `Date`, `Pos Device`, `Type`, `Is Canceled`, `Total` (`receipts.html:362-369`). `public/js/pages/receipts.js` builds table rows in `renderTable()` (line 119), pagination in `renderPagination()` (line 154), stats in `renderStats()` (line 57), and has a `No receipts loaded.` alert in `exportReceiptsCSV()` (line 252) plus a PDF export in `exportReceiptPDF()` (line 263).

- [ ] **Step 2: Add an `receipts.*` namespace to both dictionaries**

Following the exact key-naming convention from Tasks 4/5 (one key per static label, one per table header, one per dynamic message), add keys for: page title/subtitle, the Search/From/To/Type filter labels and the Search placeholder, the Reset button, the Type select's All/Sale/Refund options, all 8 table column headers, any "Loading"/"No results" row text found in `renderTable()`, the CSV/PDF export button labels, and the `No receipts loaded.` alert (`receipts.exportNoData`). Mirror every key into `km.js` with a Khmer translation.

- [ ] **Step 3: Tag static markup in `public/receipts.html` with `data-i18n`/`data-i18n-placeholder`, one per element identified in Step 1**, following the exact attribute-only pattern shown in Task 5 Step 2 (add the attribute, leave the English fallback text in place).

- [ ] **Step 4: Replace hardcoded strings in `public/js/pages/receipts.js` with `t()` calls**, importing `t` from `../i18n.js` as in Task 5 Step 3. Apply to: `renderStats()`, `renderTable()` (including any empty-state/loading-state text), `renderPagination()` (reuse `t('expenses.prev')`/`t('expenses.next')` if the pagination copy is identical, or add `receipts.prev`/`receipts.next` if the wording differs), and the `alert('No receipts loaded.')` call.

- [ ] **Step 5: Manually verify**

Toggle to ខ្មែរ, reload `/receipts.html`. Confirm the page title, all filter labels and the search placeholder, the Type dropdown options, all 8 table headers, pagination text, and both export buttons are in Khmer. Trigger the CSV export with zero receipts loaded to see the Khmer alert. Switch back to EN and spot-check.

- [ ] **Step 6: Commit**

```bash
git add public/receipts.html public/js/pages/receipts.js public/js/i18n/en.js public/js/i18n/km.js
git commit -m "feat(i18n): translate receipts page"
```

---

### Task 7: Staff + Schedule tab — full translation (pattern-following)

**Files:**
- Modify: `public/staff.html`
- Modify: `public/js/pages/staff.js`
- Modify: `public/js/pages/schedule.js`

**Interfaces:**
- Consumes: `t` from `public/js/i18n.js`. Follows Task 5 (form + CRUD + confirm dialogs) for the Staff tab and Task 4 (dynamic table rendering) for the Schedule tab's roster grid.
- Produces: `staff.*` and `schedule.*` namespaces.

- [ ] **Step 1: Read `public/staff.html`, `public/js/pages/staff.js`, and `public/js/pages/schedule.js` in full**

Confirmed structure from earlier exploration: page header "Staff" (`staff.html:338`); an Add/Edit form with a dynamic title (`#staffFormTitle`, defaults to "Add Staff") and a "Cancel Edit" button (`staff.html:386-387`); fields Staff ID, Full Name, Position (with a `positionList` datalist of Owner/Biz, Manager, Waiter, Waitress, Assistance Chief, Cleaner, Cashier), Join Date, Salary (currency select USD/KHR), Phone, Loan (currency select KHR/USD), Default Shift (select with "— None —", "M · Morning (11am–10pm)", "A · Afternoon (2pm–1am)"), Notes (`staff.html:391-449`); a Staff List table with 11 headers (`staff.html:474-486`). `public/js/pages/staff.js` has `confirm()` dialogs for add/update (line 115), status toggle failure (186), delete confirm (193) and failure (199), and `No staff loaded.` alert (206). `public/js/pages/schedule.js` renders a monthly roster grid (`render()` line 228, `buildRosterRow()` line 288) with shift-picker and roster-fill popovers (`openShiftPicker`/`openRosterFill`), and has `alert()` calls for failed shift/roster updates (lines 372, 440).

- [ ] **Step 2: Add `staff.*` and `schedule.*` namespaces to both dictionaries**

For `staff.*`: page title/subtitle, "Add Staff"/edit-mode title text, "Cancel Edit", all field labels (Staff ID, Full Name, Position, Join Date, Salary, Phone, Loan, Default Shift, Notes), the Position datalist options (Owner/Biz, Manager, Waiter, Waitress, Assistance Chief, Cleaner, Cashier — these are job-title proper nouns; translate to natural Khmer job-title equivalents), the Default Shift options ("— None —", the Morning/Afternoon labels — keep the `11am–10pm`/`2pm–1am` time ranges as-is since times aren't localized per the spec, only translate "Morning"/"Afternoon"), all 11 table headers, the "Staff List" title, the confirm-dialog templates (`staff.confirmAddUpdate` taking a `{action}` var, `staff.confirmDelete` taking a `{name}` var), and the status/delete failure messages.

For `schedule.*`: any static labels found in the roster grid header/nav (month nav buttons, print/export buttons — confirmed by function names `printSchedule`, `exportScheduleCSV`), the shift-picker and roster-fill popover labels, and `schedule.shiftUpdateFailed` / `schedule.rosterUpdateFailed` for the two `alert()` calls.

Mirror every key into `km.js`.

- [ ] **Step 3: Tag static markup in `public/staff.html` with `data-i18n`/`data-i18n-placeholder`**, one per element identified in Step 1, following the Task 5 Step 2 pattern. Pay special attention to `#staffFormTitle`'s two states ("Add Staff" vs. an edit-mode title) — since `staff.js` sets `textContent` dynamically when entering edit mode, add the `data-i18n="staff.addTitle"` attribute for the default state but make sure the JS edit-mode code path (in `startEditStaff()`) uses `t('staff.editTitle')` rather than a literal string, matching the Task 4 pattern of JS owning text it mutates at runtime.

- [ ] **Step 4: Replace hardcoded strings in `public/js/pages/staff.js` and `public/js/pages/schedule.js` with `t()` calls**, importing `t` from `../i18n.js` in both files. Apply the exact `confirm(t('staff.confirmAddUpdate', { action: ... }))` / `confirm(t('staff.confirmDelete', { name: s?.full_name ?? t('common.thisStaffMember') }))` pattern shown in Task 5 Step 3 for the two confirm dialogs, and replace the two `schedule.js` `alert()` calls the same way as Task 4 Step 6's `applyCustomRange()` example.

- [ ] **Step 5: Manually verify**

Toggle to ខ្មែរ, reload `/staff.html`. Confirm the page title, form title (both Add and Edit states — start editing an existing staff member to check), all field labels, the Position datalist suggestions, the Default Shift options, the Staff List table headers, and the confirm/delete dialogs are all in Khmer. Switch to the Schedule tab and confirm month navigation, the roster grid, and the shift/roster-fill popovers are translated; trigger a failed shift update if possible to see the Khmer alert (or verify by code inspection if the failure path isn't easily reproducible). Switch back to EN and spot-check both tabs.

- [ ] **Step 6: Commit**

```bash
git add public/staff.html public/js/pages/staff.js public/js/pages/schedule.js public/js/i18n/en.js public/js/i18n/km.js
git commit -m "feat(i18n): translate staff and schedule pages"
```

---

### Task 8: Report page — full translation (pattern-following)

**Files:**
- Modify: `public/report.html`
- Modify: `public/js/pages/report.js`

**Interfaces:**
- Consumes: `t`, `days` from `public/js/i18n.js`. `report.js`'s KPI/chart/trend functions closely mirror `dashboard.js` (same function names: `loadReportKPIs`, `loadRevenueTrend`, `loadDiningOptions`, `loadPaymentMethods`, `loadTopProducts`, `loadExpenseTrend`, `loadDevicePerformance`) — reuse the `dashboard.*` keys wherever the copy is identical (e.g. `dashboard.kpi.grossIncome`, `dashboard.categoryAll/Food/Beverage`, `dashboard.periodWeek/Month/Year/Custom`) instead of duplicating them under `report.*`.
- Produces: `report.*` namespace for report-specific copy only (page title, section titles, the Top-N select options, the two date-validation alerts).

- [ ] **Step 1: Read `public/report.html` and `public/js/pages/report.js` in full**

Confirmed structure from earlier exploration: page header "Sales & Marketing Report" (`report.html:146`); the same four period buttons and From/To/Apply controls as the dashboard (`report.html:151-159`); section titles "📈 Revenue Trend & Growth", "🍽️ Dining Channel", "💳 Payment Method", "🥧 Top Product Performance", "💸 Revenue vs Expenses", "🖥️ POS Device Performance" (`report.html:184-240`); a category `<select>` (All/Food/Beverage, `report.html:210-212`) and a Top-N `<select>` (Top 5/10/15/20, `report.html:215-218`). `public/js/pages/report.js` has two `alert()` date-validation calls (lines 416-417) identical in wording to `dashboard.js`.

- [ ] **Step 2: Add `report.*` keys to both dictionaries**

Add: `report.title` ("Sales & Marketing Report"), `report.trendTitle` ("📈 Revenue Trend & Growth"), `report.diningTitle` ("🍽️ Dining Channel"), `report.paymentTitle` ("💳 Payment Method"), `report.topProductsTitle` ("🥧 Top Product Performance"), `report.expensesVsRevenueTitle` ("💸 Revenue vs Expenses"), `report.deviceTitle` ("🖥️ POS Device Performance"), and `report.top5`/`report.top10`/`report.top15`/`report.top20` for the Top-N select options. Do **not** re-add period-button, category-option, or date-validation-alert keys — reuse `dashboard.periodWeek/Month/Year/Custom`, `dashboard.categoryAll/Food/Beverage`, `dashboard.from`, `dashboard.to`, `common.apply`, `dashboard.errorMissingDates`, `dashboard.errorDateOrder` from Task 4. Mirror the new `report.*` keys into `km.js`.

- [ ] **Step 3: Tag static markup in `public/report.html` with `data-i18n`**, using `dashboard.*`/`common.*` keys for the shared controls (period buttons, From/To/Apply, category select) exactly as tagged in Task 4 Step 5, and the new `report.*` keys for the report-specific title and section headings and Top-N select.

- [ ] **Step 4: Replace the two `alert()` calls in `public/js/pages/report.js` (lines 416-417) with `t('dashboard.errorMissingDates')` / `t('dashboard.errorDateOrder')`**, importing `t` from `../i18n.js`. Check `loadRevenueTrend()`/`loadDiningOptions()`/`loadPaymentMethods()`/`loadDevicePerformance()` for any chart-label strings (e.g. dataset `label:` fields) that duplicate `dashboard.js` wording and reuse the `dashboard.*` key rather than adding a new one — otherwise add a `report.*` key following the Step 2 convention.

- [ ] **Step 5: Manually verify**

Toggle to ខ្មែរ, reload `/report.html`. Confirm the page title, all six section titles, the shared period/date controls (should already read in Khmer since they reuse dashboard keys — this is also a regression check that Task 4 didn't accidentally scope those keys to only work on `index.html`), the category select, and the Top-N select are all in Khmer. Trigger the date-validation alerts and confirm Khmer text. Switch back to EN and spot-check.

- [ ] **Step 6: Commit**

```bash
git add public/report.html public/js/pages/report.js public/js/i18n/en.js public/js/i18n/km.js
git commit -m "feat(i18n): translate report page"
```

---

### Task 9: Users page — full translation (pattern-following, admin-only)

**Files:**
- Modify: `public/users.html`
- Modify: `public/js/pages/users.js`

**Interfaces:**
- Consumes: `t` from `public/js/i18n.js`. Follows Task 5's form/CRUD/confirm-dialog pattern.
- Produces: `users.*` namespace.

- [ ] **Step 1: Read `public/users.html` and `public/js/pages/users.js` in full**

Confirmed structure from earlier exploration: page header "User Management" (`users.html:112`); a form with a dynamic title (`#userFormTitle`, defaults "Add User") and "Cancel Edit" button (`users.html:122-123`); fields Username, Full Name, Email, Role (select Manager/Admin), Password (`users.html:127-147`); a Users table with 7 headers (`users.html:165-171`); a Role Permissions matrix with 3 headers "Page", "Admin (Write)", "Manager (Write)" (`users.html:191-193`). `public/js/pages/users.js` has confirm dialogs for status toggle (line 114, `{label}` interpolated), delete (line 175, `{username}` interpolated), and permission toggle (line 187, `{action}`/`{role}`/`{page}` interpolated), plus failure alerts (lines 169, 181, 192).

- [ ] **Step 2: Add `users.*` keys to both dictionaries**

Add: page title, form title (Add/Edit states, same two-state pattern as Task 7 Step 3's `staffFormTitle`), Cancel Edit (reuse `common.cancel` if wording matches — it does, both say "Cancel Edit"), all 5 field labels + 2 placeholders (username example, email example) + the Role select's Manager/Admin options, both table titles ("Users" / "Role Permissions"), all 7 Users-table headers, all 3 Role-Permissions-table headers, and the three confirm-dialog templates with their interpolated vars, plus the three failure-alert messages. Mirror into `km.js`. For the Role select options and the Permissions-matrix "Admin"/"Manager" column headers, keep these consistent with however Task 7 translated "Manager" (staff position) if reused, or define fresh `users.roleManager`/`users.roleAdmin` keys if the role-name translation should differ contextually from a job-title translation — use fresh `users.*` keys here since "Manager (Write permission)" is a distinct concept from a staff position title.

- [ ] **Step 3: Tag static markup in `public/users.html` with `data-i18n`/`data-i18n-placeholder`**, following the Task 5 Step 2 pattern for every element identified in Step 1.

- [ ] **Step 4: Replace hardcoded strings in `public/js/pages/users.js` with `t()` calls**, importing `t` from `../i18n.js`, using the exact `confirm(t('users.confirmX', { vars }))` pattern from Task 5 Step 3 and Task 7 Step 4 for all three confirm dialogs, and `t('users.xFailed')` for the three alert-on-failure paths.

- [ ] **Step 5: Manually verify**

Log in as an admin (Users page is admin-only per `app.js:163-166`), toggle to ខ្មែរ, reload `/users.html`. Confirm the page title, form title (both Add and Edit states), all field labels/placeholders, the Role select options, both table titles, all 7+3 table headers, and all three confirm dialogs (toggle a non-your-own user's status, attempt a delete, toggle a permission checkbox) are in Khmer. Switch back to EN and spot-check.

- [ ] **Step 6: Commit**

```bash
git add public/users.html public/js/pages/users.js public/js/i18n/en.js public/js/i18n/km.js
git commit -m "feat(i18n): translate users page"
```

---

### Task 10: Final sweep — cross-page consistency and residual-English check

**Files:**
- Modify: none expected (fix-up only, touching whatever the sweep finds)

**Interfaces:**
- Consumes: nothing new — this is a verification pass over everything Tasks 1-9 produced.

- [ ] **Step 1: Grep for likely-missed hardcoded English UI strings across all modified files**

```bash
grep -rn "textContent = '[A-Z]" public/js/pages/ public/js/*.js
grep -rn "innerHTML = \`" public/js/pages/ public/js/*.js | grep -v "t('"
```

Manually review each hit: confirm it's either (a) already routed through `t()`, (b) intentionally untranslated (e.g. currency symbols, a proper noun like a person's name, raw numbers), or (c) a miss — if (c), add the key to both dictionaries and wrap it in `t()` following the pattern from whichever earlier task owns that file's namespace.

- [ ] **Step 2: Grep dictionaries for key collisions or typos**

```bash
node -e "
const { en } = require('./public/js/i18n/en.js');
const { km } = require('./public/js/i18n/km.js');
const enKeys = Object.keys(en).sort();
const kmKeys = Object.keys(km).sort();
const missingInKm = enKeys.filter(k => !kmKeys.includes(k));
const missingInEn = kmKeys.filter(k => !enKeys.includes(k));
console.log('Missing in km:', missingInKm);
console.log('Missing in en:', missingInEn);
"
```

Note: `public/js/i18n/en.js` and `km.js` use `export const`, so this inline check needs `--experimental-vm-modules` or a quick rename to `.mjs` copy for the one-off check — simplest is to temporarily run it via `node --input-type=module -e "import {en} from './public/js/i18n/en.js'; import {km} from './public/js/i18n/km.js'; ..."` with the same comparison logic. Fix any asymmetry by adding the missing key (with a translation) to whichever dictionary is short one.

- [ ] **Step 3: Full click-through in Khmer**

With the server running (`npm run dev:uat`), toggle to ខ្មែរ and click through every page (Dashboard, Expenses, Receipts, Staff, Schedule tab, Report, Users) end to end, watching the browser devtools console for any `[i18n] missing key` warnings from Task 1 Step 3's fallback logging. Fix every warning that appears by adding the missing key to both dictionaries.

- [ ] **Step 4: Commit any fixes found**

```bash
git add -A
git commit -m "fix(i18n): close translation coverage gaps found in final sweep"
```

(Skip this commit if the sweep found nothing to fix.)

---

## Self-Review Notes

- **Spec coverage:** Architecture (i18n.js/dictionaries/data-i18n) → Task 1. Switcher UX + persistence → Task 2. Font → Task 1 Steps 4-6. Every page in scope → Tasks 3-9. Dead-code exclusion (`public/js/dashboard.js`) → stated in Global Constraints, never referenced by any task. Testing approach (manual, per-page, both languages) → each task's verification step. Rollout phasing from the spec → maps 1:1 to Tasks 1-9.
- **Placeholder scan:** No task says "handle appropriately" or defers content to implementation time without showing the pattern; Tasks 6-9 explicitly point back to the fully-worked Task 4/5 code patterns rather than re-describing them, and specify exact key sets to add even where the literal Khmer text is left to be drafted following the demonstrated dictionary style.
- **Type/name consistency:** `t(key, vars)`, `getLang()`, `setLang(lang)`, `applyTranslations(root)`, `renderLangSwitcher(container)`, `days()` are defined once in Task 1/4 and referenced identically by name in every later task. Key namespaces (`common.*`, `nav.*`, `login.*`, `dashboard.*`, `expenses.*`, `receipts.*`, `staff.*`, `schedule.*`, `report.*`, `users.*`) are declared once each and cross-referenced (Task 8 explicitly reuses `dashboard.*` rather than duplicating).
