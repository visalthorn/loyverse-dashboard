# Top Product Performance (pie chart) — Design

## Goal

Add a "Top Product Performance" section to the Sales & Marketing report page (`/report.html`) showing a pie chart of the top-selling items by net sales, with a filter to show the top 5, 10, 15, or 20 items. Modeled on Loyverse's "Sales by item" pie chart report.

## Data source

No new backend endpoint is needed. The existing `GET /api/item-comparison` route (`routes/analytics.js`) already returns items sorted by revenue for a period:

```
GET /api/item-comparison?period=<period>&start=&end=&order=desc&limit=<N>
→ [{ item_name, sku, revenue, qty, prev_revenue, growth }, ...]
```

`revenue` here is net sales (`SUM(ri.gross_total)` for non-cancelled `SALE` receipts in the period) — exactly what's needed for the pie. `limit` is already clamped server-side to a max of 50, so 5/10/15/20 all pass through safely.

## Placement

New `<section class="card">` in `public/report.html`, inserted between:
- Section 3: Channel Mix (Dining/Payment trend)
- Section 4: Product Performance vs Last Period (table)

## Frontend markup (`report.html`)

```html
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

A small `.filter-select` style is added to report.html's existing `<style>` block (same visual language as `.period-btn`: dark bg, slate border, small text) since report.html doesn't currently define a select style.

## Chart config (`charts.js`)

Add `pieOpts()` alongside the existing `donutOpts()`:

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

Unlike `donutOpts()`, this has no `cutout` (renders as a true pie) and enables the built-in legend (per user's choice: pie chart + Chart.js legend, no separate custom ranked list).

## Frontend logic (`report.js`)

- Module-local `let topProductsLimit = 5;` (page-specific UI setting, not global app `state` — mirrors how other page-local settings are handled).
- `loadTopProducts()`:
  - Fetch `/api/item-comparison?period=${state.currentPeriod}${rangeQuery()}&order=desc&limit=${topProductsLimit}`.
  - `destroyChart('topProductsChart')`, then render `type: 'pie'` with `labels = data.map(r => r.item_name)`, `data = data.map(r => parseFloat(r.revenue))`, `backgroundColor: COLORS`, using `pieOpts()`.
  - Empty state: if no rows, skip chart render (existing pattern used elsewhere: `if (!data?.length) return;`).
- `export function setTopProductsLimit(val)`: parses `val` to int, sets `topProductsLimit`, calls `loadTopProducts()` only (not the full `loadAll()`, since only this chart depends on the limit).
- Add `loadTopProducts()` call inside `loadAll()`.
- Respects the existing period/date-range filters (`state.currentPeriod`, `rangeQuery()`) — changing period or custom range via `loadAll()` also refreshes this chart at the currently selected limit.

## Wiring (`app.js`)

Add one line next to the existing report bindings:
```js
window.reportSetTopProductsLimit = Report.setTopProductsLimit;
```

## Out of scope

- No new backend route, no DB migration.
- No custom ranked list next to the chart (built-in Chart.js legend + tooltip only, per approved design).
- No color-legend-to-table linking beyond what Chart.js provides natively.
