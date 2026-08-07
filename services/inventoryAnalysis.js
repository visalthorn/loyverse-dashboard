const dayjs  = require('dayjs');
const utc    = require('dayjs/plugin/utc');
const tzPlug = require('dayjs/plugin/timezone');
const pool   = require('../db');
const { tz } = require('../config');

dayjs.extend(utc);
dayjs.extend(tzPlug);

// Consumption-rate learning for inv_* ingredients. The only stock input is
// restock events (date, qty_added, and OPTIONALLY qty_remaining); everything
// here is derived:
//   consumption per period  = measured from the count, or assumed (see below)
//   rate_per_item / rate_per_day = recency-weighted averages across periods
//   estimated remaining     = last baseline − learned rate × activity since
// Approximate by design — an early-warning nudge, not precision stock control.

const round = (v, dp = 2) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

const num = v => (v == null ? null : parseFloat(v));

// ── Pure computations (unit-tested directly) ────────────────────────────────

// What an ingredient is known to hold immediately after a restock. With a
// count that is exact; without one, all we can attest to is what was bought,
// which understates the true figure by whatever remnant was on the shelf.
// Understating is the safe direction for a stock alert — it warns early.
function baselineAfter(restock) {
  const total = num(restock.total_after);
  return total != null ? total : num(restock.qty_added);
}

// restocks: chronological [{restock_date 'YYYY-MM-DD', qty_added, qty_remaining, total_after}].
// A period runs from one restock to the next; sales on the end date belong to
// the NEXT period ([start, end) semantics).
//
// Two ways to size a period's consumption:
//   'counted'  someone recorded what was physically left at the closing
//              restock, so consumption is measured: baseline − that count.
//   'assumed'  no count, so we assume the ingredient was restocked at roughly
//              the same (near-empty) level as last time, which makes the
//              opening purchase the amount consumed. Holds whenever restocking
//              happens when stock runs low; overstates consumption if someone
//              tops up while still well stocked.
// Negative consumption can only arise from counts that contradict each other —
// surfaced separately, never learned from.
function computePeriods(restocks) {
  const periods = [], badPeriods = [];
  for (let i = 0; i < restocks.length - 1; i++) {
    const a = restocks[i], b = restocks[i + 1];
    const closingCount = num(b.qty_remaining);

    const basis = closingCount != null ? 'counted' : 'assumed';
    const consumed = basis === 'counted'
      ? round(baselineAfter(a) - closingCount)
      : round(num(a.qty_added));

    const period = {
      start: a.restock_date,
      end:   b.restock_date,
      days:  dayjs(b.restock_date).diff(dayjs(a.restock_date), 'day'),
      consumed,
      basis,
    };
    (consumed < 0 ? badPeriods : periods).push(period);
  }
  return { periods, badPeriods };
}

// periods: chronological, each with .sold filled in. Weight = 1-based position,
// so recent behaviour dominates old behaviour without ever discarding it.
function learnRates(periods) {
  let daySum = 0, dayWeight = 0, itemSum = 0, itemWeight = 0;
  periods.forEach((p, idx) => {
    const w = idx + 1;
    if (p.days > 0) { daySum += w * (p.consumed / p.days); dayWeight += w; }
    if (p.sold > 0) { itemSum += w * (p.consumed / p.sold); itemWeight += w; }
  });
  return {
    rate_per_day:  dayWeight  > 0 ? daySum  / dayWeight  : null,
    rate_per_item: itemWeight > 0 ? itemSum / itemWeight : null,
  };
}

// More periods means more evidence. But an all-assumed history rests on the
// restock-when-near-empty assumption with nothing to check it against, so it
// never reaches 'good' — that ceiling is the standing reason to record an
// actual count now and then, without ever requiring one.
function confidenceFor(periodCount, countedPeriods = null) {
  let level;
  if (periodCount < 2) level = 'low';
  else if (periodCount <= 3) level = 'medium';
  else level = 'good';
  if (countedPeriods === 0 && level === 'good') level = 'medium';
  return level;
}

// Blend favours the sales-driven estimate (it tracks busy vs quiet days);
// the per-day estimate keeps it honest when sales data is thin.
function estimateRemaining({ lastTotal, ratePerItem, ratePerDay, salesSince, daysElapsed }) {
  if (lastTotal == null) return null;
  const byDays  = ratePerDay  != null ? lastTotal - ratePerDay  * daysElapsed : null;
  const bySales = ratePerItem != null ? lastTotal - ratePerItem * salesSince  : null;
  let est;
  if (bySales != null && byDays != null) est = 0.7 * bySales + 0.3 * byDays;
  else if (bySales != null)              est = bySales;
  else if (byDays != null)               est = byDays;
  else return null;
  return Math.max(0, est);
}

function statusFor({ restockCount, periodCount, estimatedRemaining, alertThreshold, daysUntilEmpty }) {
  if (restockCount < 2 || periodCount === 0) return 'no_data';
  if ((estimatedRemaining != null && estimatedRemaining <= alertThreshold) ||
      (daysUntilEmpty != null && daysUntilEmpty <= 2)) return 'inspect';
  if (daysUntilEmpty != null && daysUntilEmpty <= 5) return 'soon';
  return 'ok';
}

// ── DB-bound analysis ───────────────────────────────────────────────────────

// One query pulls daily linked-item sales from the first restock onward; JS
// sums them per period and since the last restock. receipt_date is stored in
// Cambodia time already (toCambodiaTime at INSERT), so DATE() needs no shift.
async function analyzeIngredient(ing, branchId = null) {
  const restockParams = branchId ? [ing.id, branchId] : [ing.id];
  const [restocksRes, linksRes, branchRes] = await Promise.all([
    pool.query(`
      SELECT to_char(restock_date, 'YYYY-MM-DD') AS restock_date,
             qty_added::float, qty_remaining::float, total_after::float
      FROM inv_restocks WHERE ingredient_id = $1${branchId ? ' AND branch_id = $2' : ''}
      ORDER BY restock_date, created_at
    `, restockParams),
    pool.query('SELECT sku FROM inv_item_links WHERE ingredient_id = $1', [ing.id]),
    branchId ? pool.query('SELECT name FROM branches WHERE id = $1', [branchId]) : Promise.resolve(null),
  ]);
  const restocks   = restocksRes.rows;
  const skus       = linksRes.rows.map(r => r.sku);
  const last       = restocks[restocks.length - 1] || null;
  const branchName = branchId ? (branchRes.rows[0]?.name ?? null) : null;

  const { periods, badPeriods } = computePeriods(restocks);

  const salesByDay = {};
  if (skus.length && restocks.length) {
    // Sales/consumption data isn't branch-tagged yet — receipts would need the
    // pos_devices.branch_id join idiom used in routes/analytics.js (lines 6-18)
    // applied here, a separate, larger change. So branch-scoped estimates mix
    // an exact per-branch restock number with a whole-business consumption
    // number — approximate by design.
    const salesRes = await pool.query(`
      SELECT to_char(DATE(r.receipt_date), 'YYYY-MM-DD') AS day, SUM(ri.quantity)::float AS qty
      FROM receipt_items ri
      JOIN receipts r ON r.receipt_number = ri.receipt_number
      WHERE ri.sku = ANY($1)
        AND r.receipt_type = 'SALE' AND r.cancelled_at IS NULL
        AND DATE(r.receipt_date) >= $2
      GROUP BY 1
    `, [skus, restocks[0].restock_date]);
    salesRes.rows.forEach(r => { salesByDay[r.day] = r.qty; });
  }

  const soldBetween = (from, toExclusive) => {
    let sum = 0;
    for (const [day, qty] of Object.entries(salesByDay)) {
      if (day >= from && (toExclusive == null || day < toExclusive)) sum += qty;
    }
    return round(sum);
  };

  periods.forEach(p => { p.sold = soldBetween(p.start, p.end); });
  badPeriods.forEach(p => { p.sold = soldBetween(p.start, p.end); });

  const rates = learnRates(periods);

  const today       = dayjs().tz(tz).format('YYYY-MM-DD');
  const daysElapsed = last ? Math.max(0, dayjs(today).diff(dayjs(last.restock_date), 'day')) : 0;
  const salesSince  = last ? soldBetween(last.restock_date, null) : 0;

  const estimated = estimateRemaining({
    lastTotal:   last ? baselineAfter(last) : null,
    ratePerItem: rates.rate_per_item,
    ratePerDay:  rates.rate_per_day,
    salesSince, daysElapsed,
  });
  const daysUntilEmpty = (estimated != null && rates.rate_per_day > 0)
    ? round(estimated / rates.rate_per_day, 1) : null;

  const countedPeriods = periods.filter(p => p.basis === 'counted').length;

  return {
    id: ing.id, name: ing.name, name_kh: ing.name_kh, unit: ing.unit,
    alert_threshold: parseFloat(ing.alert_threshold),
    last_restock_date: last ? last.restock_date : null,
    last_total:        last ? baselineAfter(last) : null,
    // Whether that baseline is a measured total or just the last purchase —
    // the UI says "of the last delivery" rather than "on hand" when assumed.
    last_total_basis:  last ? (last.total_after != null ? 'counted' : 'assumed') : null,
    counted_periods:   countedPeriods,
    estimated_remaining: round(estimated),
    rate_per_item: round(rates.rate_per_item, 3),
    rate_per_day:  round(rates.rate_per_day, 3),
    days_until_empty: daysUntilEmpty,
    confidence: confidenceFor(periods.length, countedPeriods),
    status: statusFor({
      restockCount: restocks.length,
      periodCount:  periods.length,
      estimatedRemaining: estimated,
      alertThreshold: parseFloat(ing.alert_threshold),
      daysUntilEmpty,
    }),
    periods,
    bad_periods: badPeriods,
    ...(branchId ? { branch_id: branchId, branch_name: branchName } : {}),
  };
}

async function analyzeAllActive(branchId = null) {
  const result = await pool.query(`
    SELECT id, name, name_kh, unit, alert_threshold
    FROM inv_ingredients WHERE is_active = true ORDER BY name
  `);
  return Promise.all(result.rows.map(ing => analyzeIngredient(ing, branchId)));
}

module.exports = {
  computePeriods, learnRates, confidenceFor, estimateRemaining, statusFor,
  baselineAfter, analyzeIngredient, analyzeAllActive,
};
