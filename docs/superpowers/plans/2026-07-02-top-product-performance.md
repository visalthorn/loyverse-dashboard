# Top Product Performance (pie chart) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Top Product Performance" pie chart section to the Sales & Marketing report page, showing the top 5/10/15/20 items by net sales, filterable via a dropdown.

**Architecture:** Pure frontend addition. Reuses the existing `GET /api/item-comparison?period=&order=desc&limit=N` backend endpoint unchanged. New Chart.js `pie` render fed by that endpoint's `item_name`/`revenue` fields, wired the same way as the report page's other charts (`destroyChart` + `state.charts.*` + `window.*` action binding).

**Tech Stack:** Vanilla JS ES modules (`public/js/`), Chart.js (loaded via CDN in `report.html`), Express/Postgres backend (unchanged).

## Global Constraints

- No new backend route, no DB migration — `revenue` from `/api/item-comparison` is already net sales for non-cancelled `SALE` receipts in the period (`routes/analytics.js:310-359`).
- `limit` is clamped server-side to max 50 (`routes/analytics.js:313`), so passing 5/10/15/20 is always safe.
- **This project has no automated test framework** (no jest/mocha/pytest in `package.json`). Verification steps in this plan use: (a) Node's native ESM dynamic `import()` to sanity-check pure-function modules, (b) `curl` against the running dev server for API checks, (c) manual/Playwright browser checks against `http://localhost:3000` for rendered UI — per this repo's own `verify`-skill convention observed earlier in this session. Do not invent a jest/pytest suite that doesn't exist here.
- Frontend pages are accessed only through the running server (`npm run dev:uat` or `dev:prod`), never by opening HTML files directly — per `CLAUDE.md`.
- Follow the existing code style in `public/js/pages/report.js`: module-local state for page-only settings (not the shared `state` object in `state.js`), `destroyChart(id)` before every re-render, `getEl()` for DOM lookups, template-literal HTML.

---

### Task 1: Add `pieOpts()` chart-options helper

**Files:**
- Modify: `public/js/charts.js` (add new exported function after `donutOpts()`, currently ending at line 48)

**Interfaces:**
- Consumes: `fmt` (already imported at top of `charts.js` from `./utils.js`)
- Produces: `export function pieOpts()` — returns a Chart.js options object with `plugins.legend` enabled (bottom, matches the styling of `buildStackedDatasets` charts in `report.js`) and a `plugins.tooltip.callbacks.label` formatter that renders `" <name>: ៛<amount> (<pct>%)"`. Task 2 imports and calls this as `pieOpts()`.

- [ ] **Step 1: Add the function**

Open `public/js/charts.js`. After the existing `donutOpts()` function (ends at line 48 with its closing `}`), add:

```js

export function pieOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: true, position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        callbacks: {
          label: c => ` ${c.label}: ៛${fmt(c.raw)} (${((c.raw / c.chart.getDatasetMeta(0).total) * 100).toFixed(1)}%)`,
        },
      },
    },
  };
}
```

- [ ] **Step 2: Sanity-check the module still loads and exports the new function**

Run (from the project root, `C:\inetpub\wwwroot\dashboard`):

```bash
node -e "import('./public/js/charts.js').then(m => console.log(typeof m.pieOpts, JSON.stringify(m.pieOpts().plugins.legend)))"
```

Expected output (a `MODULE_TYPELESS_PACKAGE_JSON` warning is fine and expected — the file has no `.mjs` extension):
```
function {"display":true,"position":"bottom","labels":{"color":"#94a3b8","boxWidth":12,"font":{"size":11}}}
```

- [ ] **Step 3: Commit**

```bash
git add public/js/charts.js
git commit -m "feat(charts): add pieOpts() helper for true pie charts with legend"
```

---

### Task 2: Add report page section, page logic, and wiring

**Files:**
- Modify: `public/report.html` — add `.filter-select` style to the existing `<style>` block (after the `.growth-nil` rule, currently ending at line 76), and add the new `<section>` (insert between the closing `</section>` of Section 3 at line 200 and the `<!-- Section 4 -->` comment at line 202)
- Modify: `public/js/pages/report.js` — add module-local limit state, `loadTopProducts()`, `export function setTopProductsLimit(val)`, and wire `loadTopProducts()` into `loadAll()` (currently lines 419-427)
- Modify: `public/js/app.js` — add one `window.*` binding next to the existing report bindings (currently lines 133-135)

**Interfaces:**
- Consumes: `pieOpts` from `public/js/charts.js` (Task 1); `state`, `COLORS` from `public/js/state.js`; `fetchJSON` from `public/js/api.js`; `getEl` from `public/js/utils.js`; `destroyChart` from `public/js/charts.js`; existing module-local `rangeQuery()` in `report.js`.
- Produces: `export function setTopProductsLimit(val)` in `report.js` — later referenced only by `app.js`'s `window.reportSetTopProductsLimit` binding and the `<select onchange>` HTML attribute. No other task depends on this beyond wiring.

- [ ] **Step 1: Add the `.filter-select` style to `report.html`**

In `public/report.html`, inside the existing `<style>` block, right after the `.growth-nil { color: #64748b; }` line (line 75), add:

```css
  .filter-select {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 8px;
    color: #e2e8f0;
    font-size: 0.75rem;
    padding: 6px 10px;
  }
  .filter-select:focus { outline: none; border-color: #f59e0b; }
```

- [ ] **Step 2: Add the new section markup to `report.html`**

Insert this new `<section>` right after the closing `</section>` of "Section 3: Channel Mix" (line 200) and before the `<!-- Section 4: Product Intelligence -->` comment (line 202):

```html
    <!-- Section 3b: Top Product Performance -->
    <section class="card">
      <div class="flex items-center justify-between mb-4">
        <h2 class="section-title">🥧 Top Product Performance</h2>
        <select id="topProductsLimit" class="filter-select" onchange="reportSetTopProductsLimit(this.value)">
          <option value="5" selected>Top 5</option>
          <option value="10">Top 10</option>
          <option value="15">Top 15</option>
          <option value="20">Top 20</option>
        </select>
      </div>
      <div class="chart-container"><canvas id="topProductsChart"></canvas></div>
    </section>

```

- [ ] **Step 3: Add `loadTopProducts()` and `setTopProductsLimit()` to `report.js`**

In `public/js/pages/report.js`, update the top import line to also pull in `pieOpts`:

```js
import { destroyChart, chartOpts, barOpts, pieOpts } from '../charts.js';
```

Then, right after the `// ─── Section 3b: Payment Method Trend ────` block ends (after the closing `}` of `loadPaymentTrend()`, currently line 221, and before the `// ─── Section 4: Product Intelligence ───` comment on line 223), add:

```js

// ─── Section 3c: Top Product Performance ─────────────────────────────────────

let topProductsLimit = 5;

async function loadTopProducts() {
  const data = await fetchJSON(`/api/item-comparison?period=${state.currentPeriod}${rangeQuery()}&order=desc&limit=${topProductsLimit}`);
  if (!data?.length) return;

  const labels  = data.map(r => r.item_name);
  const revenue = data.map(r => parseFloat(r.revenue));

  destroyChart('topProductsChart');
  state.charts.topProductsChart = new Chart(document.getElementById('topProductsChart'), {
    type: 'pie',
    data: { labels, datasets: [{ data: revenue, backgroundColor: COLORS, borderWidth: 0 }] },
    options: pieOpts(),
  });
}

export function setTopProductsLimit(val) {
  topProductsLimit = parseInt(val) || 5;
  loadTopProducts();
}
```

- [ ] **Step 4: Wire `loadTopProducts()` into `loadAll()`**

In `public/js/pages/report.js`, find `loadAll()` (currently lines 419-427):

```js
export function loadAll() {
  loadReportKPIs();
  loadRevenueTrend();
  loadDiningTrend();
  loadPaymentTrend();
  loadProductIntelligence();
  loadExpenseTrend();
  loadDevicePerformance();
}
```

Add `loadTopProducts();` after `loadPaymentTrend();`:

```js
export function loadAll() {
  loadReportKPIs();
  loadRevenueTrend();
  loadDiningTrend();
  loadPaymentTrend();
  loadTopProducts();
  loadProductIntelligence();
  loadExpenseTrend();
  loadDevicePerformance();
}
```

- [ ] **Step 5: Bind the new action on `window` in `app.js`**

In `public/js/app.js`, find the existing report bindings (currently lines 133-135):

```js
window.reportSetPeriod         = Report.setPeriod;
window.reportApplyRange        = Report.applyCustomRange;
window.reportToggleSlowMovers  = Report.reportToggleSlowMovers;
```

Add one line:

```js
window.reportSetPeriod            = Report.setPeriod;
window.reportApplyRange           = Report.applyCustomRange;
window.reportToggleSlowMovers     = Report.reportToggleSlowMovers;
window.reportSetTopProductsLimit  = Report.setTopProductsLimit;
```

- [ ] **Step 6: Quick static check — confirm the endpoint this relies on actually returns usable data**

With the dev server running (`npm run dev:uat` or whatever is already running per `CLAUDE.md`), and using any valid auth token for a logged-in session (grab it from the browser's `localStorage.pos_token` after logging in at `http://localhost:3000/login`):

```bash
curl -s "http://localhost:3000/api/item-comparison?period=month&order=desc&limit=5" \
  -H "Authorization: Bearer <token>" | node -e "const d=JSON.parse(require('fs').readFileSync(0)); console.log(d.length, d[0])"
```

Expected: prints a count `<= 5` and the first row shaped like `{ item_name: '...', sku: '...', revenue: <number>, qty: <number>, prev_revenue: <number>, growth: <number|null> }`.

- [ ] **Step 7: Commit**

```bash
git add public/report.html public/js/pages/report.js public/js/app.js
git commit -m "feat(report): add top product performance pie chart with 5/10/15/20 filter"
```

---

### Task 3: End-to-end browser verification

**Files:** none (verification only)

**Interfaces:**
- Consumes: the fully wired feature from Tasks 1-2.
- Produces: nothing further downstream — this is the plan's final task.

- [ ] **Step 1: Load the report page and confirm the chart renders**

With the dev server running, open `http://localhost:3000/report.html` in a browser (log in first if needed), or drive it headlessly the same way this session's earlier CSS-fix verification did (Playwright + a locally-signed JWT for `http://localhost:3000/login`'s `pos_token`/`pos_user` localStorage keys — see this repo's dev `.env` for `JWT_SECRET_UAT`, read at runtime, never hardcoded into a persisted script).

Confirm:
- A "🥧 Top Product Performance" card appears between the Channel Mix section and the "Product Performance vs Last Period" table.
- The pie chart renders with up to 5 slices (default), colors matching `COLORS` from `state.js`.
- Hovering a slice shows a tooltip like `Item Name: ៛123,000 (42.3%)`.
- The bottom legend lists the item names.

- [ ] **Step 2: Confirm the 5/10/15/20 filter works**

Change the `<select>` to each of 10, 15, and 20. For each:
- Confirm the network call fires: `GET /api/item-comparison?period=<current>&order=desc&limit=<N>`.
- Confirm the pie chart re-renders with up to `N` slices (fewer if there aren't `N` distinct items in the period) and no leftover/duplicate chart instance (i.e. `destroyChart` correctly cleared the prior one — no visual overlap or console errors about "Canvas is already in use").

- [ ] **Step 3: Confirm it respects the existing period/date-range controls**

Switch the top period selector between "Last 7 days", "Last Month", "Year", and a custom range via "Custom" + Apply. Confirm the pie chart updates each time (via `loadAll()` → `loadTopProducts()`) and keeps whatever limit was last selected.

- [ ] **Step 4: Confirm the empty-state doesn't crash**

Pick a period/custom-range with no sales (e.g. a future custom date range). Confirm the card stays but the chart area doesn't throw a console error (matches the existing `if (!data?.length) return;` guard pattern used by every other chart loader in `report.js`).

- [ ] **Step 5: Report results**

Summarize what was observed for each step above (pass/fail + any screenshot), following this repo's `verify` skill conventions used earlier in this session.

---

## Self-Review

**Spec coverage:**
- Data source reuse (no new endpoint) → Task 1 Global Constraints + Task 2 Step 6. ✓
- Placement between Section 3 and Section 4 → Task 2 Step 2. ✓
- Pie chart + built-in Chart.js legend (no custom ranked list) → Task 1 (`pieOpts`) + Task 2 Step 3 (`type: 'pie'`). ✓
- 5/10/15/20 filter, default 5 → Task 2 Steps 2-3 (`<select>` + `topProductsLimit = 5`). ✓
- Wiring through `app.js` → Task 2 Step 5. ✓
- Respects existing period/range filters → Task 2 Step 4 (`loadAll()`) + Task 3 Step 3. ✓

**Placeholder scan:** No TBD/TODO; every step has literal code or literal commands with expected output.

**Type consistency:** `setTopProductsLimit` name matches between `report.js` (Task 2 Step 3), `app.js` binding (Task 2 Step 5), and the `<select onchange>` HTML (Task 2 Step 2 — calls `reportSetTopProductsLimit`, the `window.*`-bound name, not the raw export name — consistent with how `reportSetPeriod`/`reportApplyRange` are already used in `report.html`).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-02-top-product-performance.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
