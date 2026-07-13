const router = require('express').Router();
const dayjs  = require('dayjs');
const pool   = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { growth } = require('../utils/date');
const { rebuildSummaries } = require('../services/sync');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validates ?start&end. Sends the 400 itself and returns null when invalid.
function parseRange(req, res) {
  const { start, end } = req.query;
  if (!DATE_RE.test(start || '') || !DATE_RE.test(end || '') || start > end) {
    res.status(400).json({ error: 'start and end must be YYYY-MM-DD with start <= end' });
    return null;
  }
  return { start, end };
}

function prevRange(start, end) {
  const days    = dayjs(end).diff(dayjs(start), 'day') + 1;
  const prevEnd = dayjs(start).subtract(1, 'day');
  return {
    start: prevEnd.subtract(days - 1, 'day').format('YYYY-MM-DD'),
    end:   prevEnd.format('YYYY-MM-DD'),
  };
}

// /api/kpis formula: gross = SALE-not-cancelled + REFUND-cancelled.
const TOTALS_SQL = `
  SELECT COALESCE(SUM(sales_gross + refund_amount), 0) AS gross_income,
         COALESCE(SUM(sales_orders + refund_count), 0) AS orders
  FROM daily_summary WHERE day BETWEEN $1 AND $2`;

const EXPENSES_SQL = `
  SELECT COALESCE(SUM(amount), 0) AS total_expense
  FROM expenses WHERE DATE(expense_date) BETWEEN $1 AND $2`;

const DAILY_AVG_SQL = `
  SELECT COALESCE(AVG(gross), 0)           AS avg_gross,
         COALESCE(AVG(expense), 0)         AS avg_expense,
         COALESCE(AVG(gross - expense), 0) AS avg_net
  FROM (
    SELECT COALESCE(ds.sales_gross + ds.refund_amount, 0) AS gross,
           COALESCE(e.daily_expense, 0)                   AS expense
    FROM generate_series($1::date, $2::date, '1 day'::interval) AS gs(day)
    LEFT JOIN daily_summary ds ON ds.day = gs.day::date
    LEFT JOIN (
      SELECT DATE(expense_date) AS day, SUM(amount) AS daily_expense
      FROM expenses WHERE DATE(expense_date) BETWEEN $1 AND $2 GROUP BY 1
    ) e ON e.day = gs.day::date
  ) d`;

async function periodTotals(start, end) {
  const [tot, exp, avg] = await Promise.all([
    pool.query(TOTALS_SQL, [start, end]),
    pool.query(EXPENSES_SQL, [start, end]),
    pool.query(DAILY_AVG_SQL, [start, end]),
  ]);
  const gross  = parseFloat(tot.rows[0].gross_income);
  const orders = parseInt(tot.rows[0].orders);
  return {
    gross,
    orders,
    aov:        orders > 0 ? gross / orders : 0,
    expenses:   parseFloat(exp.rows[0].total_expense),
    avgGross:   parseFloat(avg.rows[0].avg_gross),
    avgExpense: parseFloat(avg.rows[0].avg_expense),
    avgNet:     parseFloat(avg.rows[0].avg_net),
  };
}

router.get('/summary', requireAuth, async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  const prev = prevRange(range.start, range.end);
  try {
    const [c, p] = await Promise.all([
      periodTotals(range.start, range.end),
      periodTotals(prev.start, prev.end),
    ]);
    const hasNoExpense = c.expenses === 0;
    res.json({
      gross_income:     { value: c.gross.toFixed(2), growth: growth(c.gross, p.gross) },
      orders:           { value: c.orders,           growth: growth(c.orders, p.orders) },
      aov:              { value: c.aov.toFixed(2),   growth: growth(c.aov, p.aov) },
      expenses:         { value: c.expenses,         growth: hasNoExpense ? 0 : growth(c.expenses, p.expenses) },
      net_revenue:      parseFloat((c.gross - c.expenses).toFixed(2)),
      avg_gross_income: { value: c.avgGross.toFixed(2),   growth: growth(c.avgGross, p.avgGross) },
      avg_expense:      { value: c.avgExpense.toFixed(2), growth: hasNoExpense ? 0 : growth(c.avgExpense, p.avgExpense) },
      net_per_order:    { value: c.avgNet.toFixed(2),     growth: growth(c.avgNet, p.avgNet) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/trend', requireAuth, async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  try {
    // /api/gross-income formula: any receipt_type with cancelled_at IS NULL.
    const result = await pool.query(`
      SELECT day AS period,
             sales_gross + refund_open_amount AS gross_income,
             sales_orders + refund_open_count AS orders
      FROM daily_summary
      WHERE day BETWEEN $1 AND $2 AND (sales_orders + refund_open_count) > 0
      ORDER BY day
    `, [range.start, range.end]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/revenue-expenses', requireAuth, async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  try {
    const result = await pool.query(`
      SELECT gs.day::date AS period,
             COALESCE(ds.sales_gross + ds.refund_open_amount, 0) AS gross_income,
             COALESCE(e.daily_expense, 0) AS total_expense
      FROM generate_series($1::date, $2::date, '1 day'::interval) AS gs(day)
      LEFT JOIN daily_summary ds ON ds.day = gs.day::date
      LEFT JOIN (
        SELECT DATE(expense_date) AS day, SUM(amount) AS daily_expense
        FROM expenses WHERE DATE(expense_date) BETWEEN $1 AND $2 GROUP BY 1
      ) e ON e.day = gs.day::date
      ORDER BY 1
    `, [range.start, range.end]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/dining', requireAuth, async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  try {
    const result = await pool.query(`
      SELECT dining_option, SUM(orders) AS orders, COALESCE(SUM(revenue), 0) AS revenue
      FROM daily_dining_summary WHERE day BETWEEN $1 AND $2
      GROUP BY 1 ORDER BY revenue DESC
    `, [range.start, range.end]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/payments', requireAuth, async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  try {
    const result = await pool.query(`
      SELECT payment_name, payment_type,
             SUM(transactions) AS transactions, COALESCE(SUM(total), 0) AS total
      FROM daily_payment_summary WHERE day BETWEEN $1 AND $2
      GROUP BY 1, 2 ORDER BY total DESC
    `, [range.start, range.end]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/top-items', requireAuth, async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  const limit    = Math.min(parseInt(req.query.limit) || 5, 50);
  const category = req.query.category || '';
  const categoryJoin   = category ? 'JOIN item_categories ic ON ic.sku = dis.sku' : '';
  const categoryClause = category ? 'AND ic.category = $3' : '';
  const params = category ? [range.start, range.end, category] : [range.start, range.end];
  try {
    const result = await pool.query(`
      SELECT dis.sku, MAX(dis.item_name) AS item_name,
             SUM(dis.qty) AS qty, COALESCE(SUM(dis.revenue), 0) AS revenue
      FROM daily_item_summary dis
      ${categoryJoin}
      WHERE dis.day BETWEEN $1 AND $2 ${categoryClause}
      GROUP BY dis.sku ORDER BY revenue DESC LIMIT ${limit}
    `, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/peak-hours', requireAuth, async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  try {
    const result = await pool.query(`
      SELECT EXTRACT(DOW FROM day) AS day_of_week, hour,
             SUM(orders) AS orders, COALESCE(SUM(revenue), 0) AS revenue
      FROM daily_hour_summary WHERE day BETWEEN $1 AND $2
      GROUP BY 1, 2 ORDER BY 1, 2
    `, [range.start, range.end]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/device', requireAuth, async (req, res) => {
  const range = parseRange(req, res);
  if (!range) return;
  try {
    const result = await pool.query(`
      SELECT device_name, SUM(orders) AS orders, COALESCE(SUM(revenue), 0) AS revenue
      FROM daily_device_summary WHERE day BETWEEN $1 AND $2
      GROUP BY 1 ORDER BY revenue DESC
    `, [range.start, range.end]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/coverage', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT MIN(day) AS min_day, MAX(day) AS max_day FROM daily_summary`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/rebuild', requireAuth, requireRole('admin'), async (req, res) => {
  const { start, end } = req.body || {};
  if (!DATE_RE.test(start || '') || !DATE_RE.test(end || '') || start > end) {
    return res.status(400).json({ error: 'start and end must be YYYY-MM-DD with start <= end' });
  }
  if (dayjs(end).diff(dayjs(start), 'day') > 400) {
    return res.status(400).json({ error: 'range too large (max 400 days per rebuild)' });
  }
  try {
    const result = await rebuildSummaries(start, end, 'manual');
    res.json(result);
  } catch (err) {
    console.error('❌ Summary rebuild route error:', err.message);
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

module.exports = router;
