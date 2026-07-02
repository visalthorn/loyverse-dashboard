const router = require('express').Router();
const pool   = require('../db');
const { requireAuth } = require('../middleware/auth');
const { buildPeriodFilter, getTrendPeriod, getPrevPeriodSQL, getPeriodDateRange, getPrevPeriodDateRange, growth } = require('../utils/date');

// Per-day average query: for each calendar day in [start,end], compute
// daily_gross and daily_expense, derive daily_net = gross - expense, then AVG all three.
const DAILY_AVG_SQL = `
  SELECT
    COALESCE(AVG(gross),   0) AS avg_gross,
    COALESCE(AVG(expense), 0) AS avg_expense,
    COALESCE(AVG(net),     0) AS avg_net
  FROM (
    SELECT
      COALESCE(r.daily_gross,   0)                              AS gross,
      COALESCE(e.daily_expense, 0)                              AS expense,
      COALESCE(r.daily_gross,   0) - COALESCE(e.daily_expense, 0) AS net
    FROM generate_series($1::date, $2::date, '1 day'::interval) AS gs(day)
    LEFT JOIN (
      SELECT DATE(receipt_date) AS day, SUM(total_money) AS daily_gross
      FROM receipts
      WHERE DATE(receipt_date) BETWEEN $1 AND $2
        AND ((receipt_type = 'SALE' AND cancelled_at IS NULL) OR (receipt_type = 'REFUND' AND cancelled_at IS NOT NULL))
      GROUP BY DATE(receipt_date)
    ) r ON r.day = gs.day::date
    LEFT JOIN (
      SELECT DATE(expense_date) AS day, SUM(amount) AS daily_expense
      FROM expenses
      WHERE DATE(expense_date) BETWEEN $1 AND $2
      GROUP BY DATE(expense_date)
    ) e ON e.day = gs.day::date
  ) daily
`;

router.get('/kpis', requireAuth, async (req, res) => {
  const { period = 'today', start, end } = req.query;
  const filter        = buildPeriodFilter(period, start, end);
  const prevFilter    = getPrevPeriodSQL(period, start, end);
  const expFilter     = buildPeriodFilter(period, start, end, 'e', 1, 'expense_date');
  const prevExpFilter = getPrevPeriodSQL(period, start, end, 'e', 'expense_date');
  const currRange     = getPeriodDateRange(period, start, end);
  const prevRange     = getPrevPeriodDateRange(period, start, end);
  try {
    const [curr, prev, expRes, prevExpRes, currAvg, prevAvg] = await Promise.all([
      pool.query(`
        SELECT COALESCE(SUM(total_money),0) AS gross_income, COUNT(*) AS orders, COALESCE(AVG(total_money),0) AS aov
        FROM receipts r WHERE ${filter.clause}
          AND ((receipt_type='SALE' AND cancelled_at IS NULL) OR (receipt_type='REFUND' AND cancelled_at IS NOT NULL))
      `, filter.params),
      pool.query(`
        SELECT COALESCE(SUM(total_money),0) AS gross_income, COUNT(*) AS orders, COALESCE(AVG(total_money),0) AS aov
        FROM receipts r WHERE ${prevFilter.clause}
          AND ((receipt_type='SALE' AND cancelled_at IS NULL) OR (receipt_type='REFUND' AND cancelled_at IS NOT NULL))
      `, prevFilter.params),
      pool.query(`
        SELECT COALESCE(SUM(amount),0) AS total_expense FROM expenses e WHERE ${expFilter.clause}
      `, expFilter.params),
      pool.query(`
        SELECT COALESCE(SUM(amount),0) AS total_expense FROM expenses e WHERE ${prevExpFilter.clause}
      `, prevExpFilter.params),
      pool.query(DAILY_AVG_SQL, [currRange.start, currRange.end]),
      pool.query(DAILY_AVG_SQL, [prevRange.start, prevRange.end]),
    ]);

    const c = curr.rows[0];
    const p = prev.rows[0];
    const expensesTotal     = parseFloat(expRes.rows[0]?.total_expense     || 0);
    const prevExpensesTotal = parseFloat(prevExpRes.rows[0]?.total_expense || 0);

    const avgGross       = parseFloat(currAvg.rows[0].avg_gross   || 0);
    const avgExpense     = parseFloat(currAvg.rows[0].avg_expense || 0);
    const avgNet         = parseFloat(currAvg.rows[0].avg_net     || 0);
    const prevAvgGross   = parseFloat(prevAvg.rows[0].avg_gross   || 0);
    const prevAvgExpense = parseFloat(prevAvg.rows[0].avg_expense || 0);
    const prevAvgNet     = parseFloat(prevAvg.rows[0].avg_net     || 0);

    // Only suppress expense-related growth when the CURRENT period has no expenses —
    // showing growth from 0 is meaningless. When PREVIOUS has no expenses, prevAvgNet
    // and prevAvgExpense are still valid SQL-computed values (gross − 0 = gross), so
    // let growth() handle the zero-previous case naturally (it already returns 0 when
    // previous == 0, which covers the avg_expense case automatically).
    const hasNoExpense = expensesTotal === 0;

    res.json({
      gross_income:     { value: parseFloat(c.gross_income).toFixed(2), growth: growth(c.gross_income, p.gross_income) },
      orders:           { value: parseInt(c.orders) || 0,               growth: growth(c.orders, p.orders) },
      aov:              { value: parseFloat(c.aov).toFixed(2),          growth: growth(c.aov, p.aov) },
      expenses:         { value: expensesTotal,                         growth: hasNoExpense ? 0 : growth(expensesTotal, prevExpensesTotal) },
      net_revenue:      parseFloat((parseFloat(c.gross_income) - expensesTotal).toFixed(2)),
      avg_gross_income: { value: avgGross.toFixed(2),   growth: growth(avgGross,   prevAvgGross) },
      avg_expense:      { value: avgExpense.toFixed(2), growth: hasNoExpense ? 0 : growth(avgExpense, prevAvgExpense) },
      net_per_order:    { value: avgNet.toFixed(2),     growth: growth(avgNet,     prevAvgNet) },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/gross-income', requireAuth, async (req, res) => {
  const { period = 'daily', start, end } = req.query;
  const filter = buildPeriodFilter(period, start, end, 'r', 2);
  const trunc  = getTrendPeriod(period, start, end);
  try {
    const result = await pool.query(`
      SELECT DATE_TRUNC($1, receipt_date) AS period,
             COALESCE(SUM(total_money),0) AS gross_income,
             COUNT(*) FILTER (WHERE cancelled_at IS NULL) AS orders
      FROM receipts r WHERE ${filter.clause} AND cancelled_at IS NULL
      GROUP BY 1 ORDER BY 1
    `, [trunc, ...filter.params]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/expenses-trend', requireAuth, async (req, res) => {
  const { period = 'daily', start, end } = req.query;
  const filter = buildPeriodFilter(period, start, end, 'e', 2, 'expense_date');
  const trunc  = getTrendPeriod(period, start, end);
  try {
    const result = await pool.query(`
      SELECT DATE_TRUNC($1, expense_date) AS period, COALESCE(SUM(amount),0) AS total_expense
      FROM expenses e WHERE ${filter.clause} GROUP BY 1 ORDER BY 1
    `, [trunc, ...filter.params]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/dining-options', requireAuth, async (req, res) => {
  const { period = 'month', start, end } = req.query;
  const filter = buildPeriodFilter(period, start, end);
  try {
    const result = await pool.query(`
      SELECT COALESCE(dining_option,'Unknown') AS dining_option, COUNT(*) AS orders, COALESCE(SUM(total_money),0) AS revenue
      FROM receipts r WHERE ${filter.clause} AND cancelled_at IS NULL GROUP BY 1 ORDER BY revenue DESC
    `, filter.params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/top-items', requireAuth, async (req, res) => {
  const { period = 'month', start, end, limit = 10 } = req.query;
  const filter = buildPeriodFilter(period, start, end);
  try {
    const params = [...filter.params, limit];
    const result = await pool.query(`
      SELECT ri.item_name, ri.sku, SUM(ri.quantity) AS qty_sold, SUM(ri.gross_total) AS revenue
      FROM receipt_items ri JOIN receipts r ON r.receipt_number = ri.receipt_number
      WHERE ${filter.clause} AND r.cancelled_at IS NULL
      GROUP BY ri.item_name, ri.sku ORDER BY revenue DESC LIMIT $${params.length}
    `, params);
    const total = result.rows.reduce((s, r) => s + parseFloat(r.revenue), 0);
    res.json(result.rows.map(r => ({
      ...r,
      pct: total > 0 ? ((parseFloat(r.revenue) / total) * 100).toFixed(1) : '0',
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/payment-methods', requireAuth, async (req, res) => {
  const { period = 'month', start, end } = req.query;
  const filter = buildPeriodFilter(period, start, end);
  try {
    const result = await pool.query(`
      SELECT rp.payment_name, rp.payment_type, COUNT(*) AS transactions, SUM(rp.money_amount) AS total
      FROM receipt_payments rp JOIN receipts r ON r.receipt_number = rp.receipt_number
      WHERE ${filter.clause} AND r.cancelled_at IS NULL AND r.receipt_type = 'SALE'
      GROUP BY rp.payment_name, rp.payment_type ORDER BY total DESC
    `, filter.params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/peak-hours', requireAuth, async (req, res) => {
  const { period = 'month', start, end } = req.query;
  const filter = buildPeriodFilter(period, start, end);
  try {
    const result = await pool.query(`
      SELECT EXTRACT(DOW FROM receipt_date) AS day_of_week, EXTRACT(HOUR FROM receipt_date) AS hour,
             COUNT(*) AS orders, COALESCE(SUM(total_money),0) AS revenue
      FROM receipts r WHERE ${filter.clause} AND cancelled_at IS NULL GROUP BY 1,2 ORDER BY 1,2
    `, filter.params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/employee-performance', requireAuth, async (req, res) => {
  const { period = 'month', start, end } = req.query;
  const filter = buildPeriodFilter(period, start, end);
  try {
    const result = await pool.query(`
      SELECT employee_id,
             COUNT(*) FILTER (WHERE cancelled_at IS NULL) AS orders,
             COALESCE(SUM(total_money) FILTER (WHERE cancelled_at IS NULL),0) AS revenue,
             COALESCE(AVG(total_money) FILTER (WHERE cancelled_at IS NULL),0) AS aov
      FROM receipts r WHERE ${filter.clause} GROUP BY employee_id ORDER BY revenue DESC LIMIT 10
    `, filter.params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/device-performance', requireAuth, async (req, res) => {
  const { period = 'month', start, end } = req.query;
  const filter = buildPeriodFilter(period, start, end);
  try {
    const result = await pool.query(`
      SELECT COALESCE(pd.name, r.pos_device_id) AS device_name,
             COUNT(*) FILTER (WHERE r.cancelled_at IS NULL) AS orders,
             COALESCE(SUM(r.total_money) FILTER (WHERE r.cancelled_at IS NULL),0) AS revenue
      FROM receipts r LEFT JOIN pos_devices pd ON pd.id::varchar = r.pos_device_id
      WHERE ${filter.clause} GROUP BY pd.name, r.pos_device_id ORDER BY revenue DESC
    `, filter.params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/cancelled-orders', async (req, res) => {
  const { period = 'today', start, end } = req.query;
  const filter = buildPeriodFilter(period, start, end);
  try {
    const [items, summary] = await Promise.all([
      pool.query(`
        SELECT receipt_number, total_money, receipt_date, cancelled_at, employee_id, dining_option
        FROM receipts r WHERE ${filter.clause} AND cancelled_at IS NOT NULL
        ORDER BY cancelled_at DESC LIMIT 20
      `, filter.params),
      pool.query(`
        SELECT COUNT(*) AS count, COALESCE(SUM(total_money),0) AS lost_revenue
        FROM receipts r WHERE ${filter.clause} AND cancelled_at IS NOT NULL
      `, filter.params),
    ]);
    res.json({ summary: summary.rows[0], items: items.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/dining-trend', requireAuth, async (req, res) => {
  const { period = 'month', start, end } = req.query;
  const filter = buildPeriodFilter(period, start, end, 'r', 2);
  const trunc  = getTrendPeriod(period, start, end);
  try {
    const result = await pool.query(`
      SELECT DATE_TRUNC($1, r.receipt_date) AS period,
             COALESCE(r.dining_option, 'Unknown') AS dining_option,
             COUNT(*) AS orders,
             COALESCE(SUM(r.total_money), 0) AS revenue
      FROM receipts r
      WHERE ${filter.clause}
        AND r.receipt_type = 'SALE' AND r.cancelled_at IS NULL
      GROUP BY 1, 2
      ORDER BY 1, 4 DESC
    `, [trunc, ...filter.params]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/payment-trend', requireAuth, async (req, res) => {
  const { period = 'month', start, end } = req.query;
  const filter = buildPeriodFilter(period, start, end, 'r', 2);
  const trunc  = getTrendPeriod(period, start, end);
  try {
    const result = await pool.query(`
      SELECT DATE_TRUNC($1, r.receipt_date) AS period,
             rp.payment_name,
             COUNT(*) AS transactions,
             COALESCE(SUM(rp.money_amount), 0) AS total
      FROM receipt_payments rp
      JOIN receipts r ON r.receipt_number = rp.receipt_number
      WHERE ${filter.clause}
        AND r.receipt_type = 'SALE' AND r.cancelled_at IS NULL
      GROUP BY 1, 2
      ORDER BY 1, 4 DESC
    `, [trunc, ...filter.params]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/item-comparison', requireAuth, async (req, res) => {
  const { period = 'month', start, end, order = 'desc', limit = 20, category } = req.query;
  const sortDir    = order === 'asc' ? 'ASC' : 'DESC';
  const rowLimit   = Math.min(parseInt(limit) || 20, 50);
  const filter     = buildPeriodFilter(period, start, end);
  const prevFilter = getPrevPeriodSQL(period, start, end);

  // Only join item_categories when a category filter is actually requested,
  // so this endpoint keeps working even before that table exists/is populated.
  const categoryJoin = category ? 'JOIN item_categories ic ON ic.sku = ri.sku' : '';
  const currCategoryClause = category ? ` AND ic.category = $${filter.params.length + 1}` : '';
  const prevCategoryClause = category ? ` AND ic.category = $${prevFilter.params.length + 1}` : '';
  const currParams = category ? [...filter.params, category] : filter.params;
  const prevParams = category ? [...prevFilter.params, category] : prevFilter.params;

  try {
    const [curr, prev] = await Promise.all([
      pool.query(`
        SELECT ri.item_name, ri.sku,
               SUM(ri.gross_total) AS revenue,
               SUM(ri.quantity)    AS qty
        FROM receipt_items ri
        JOIN receipts r ON r.receipt_number = ri.receipt_number
        ${categoryJoin}
        WHERE ${filter.clause}
          AND r.receipt_type = 'SALE' AND r.cancelled_at IS NULL
          ${currCategoryClause}
        GROUP BY ri.item_name, ri.sku
        ORDER BY revenue ${sortDir}
        LIMIT ${rowLimit}
      `, currParams),
      pool.query(`
        SELECT ri.sku, SUM(ri.gross_total) AS revenue
        FROM receipt_items ri
        JOIN receipts r ON r.receipt_number = ri.receipt_number
        ${categoryJoin}
        WHERE ${prevFilter.clause}
          AND r.receipt_type = 'SALE' AND r.cancelled_at IS NULL
          ${prevCategoryClause}
        GROUP BY ri.sku
      `, prevParams),
    ]);

    const prevMap = {};
    prev.rows.forEach(r => { prevMap[r.sku] = parseFloat(r.revenue); });

    res.json(curr.rows.map(r => {
      const currRev = parseFloat(r.revenue);
      const prevRev = prevMap[r.sku] || 0;
      return {
        item_name:    r.item_name,
        sku:          r.sku,
        revenue:      currRev,
        qty:          parseInt(r.qty),
        prev_revenue: prevRev,
        growth:       prevRev > 0 ? parseFloat(((currRev - prevRev) / prevRev * 100).toFixed(1)) : null,
      };
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/refund-analysis', requireAuth, async (req, res) => {
  const { period = 'month', start, end } = req.query;
  const filter = buildPeriodFilter(period, start, end, 'r', 2);
  const trunc  = getTrendPeriod(period, start, end);
  try {
    const result = await pool.query(`
      SELECT DATE_TRUNC($1, r.receipt_date) AS period,
             COUNT(*) FILTER (WHERE r.receipt_type = 'SALE'   AND r.cancelled_at IS NULL)     AS sales,
             COUNT(*) FILTER (WHERE r.receipt_type = 'REFUND' AND r.cancelled_at IS NOT NULL) AS refunds,
             COUNT(*) FILTER (WHERE r.receipt_type = 'SALE'   AND r.cancelled_at IS NOT NULL) AS cancellations,
             COALESCE(SUM(r.total_money) FILTER (WHERE r.receipt_type = 'REFUND' AND r.cancelled_at IS NOT NULL), 0) AS refund_amount
      FROM receipts r
      WHERE ${filter.clause}
      GROUP BY 1
      ORDER BY 1
    `, [trunc, ...filter.params]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/debug', async (req, res) => {
  try {
    const [dateRange, sample, payments, items] = await Promise.all([
      pool.query(`
        SELECT MIN(receipt_date) AS oldest, MAX(receipt_date) AS newest,
               COUNT(*) AS total_receipts,
               COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL) AS cancelled,
               CURRENT_DATE AS db_today, NOW() AS db_now
        FROM receipts
      `),
      pool.query(`SELECT receipt_number, receipt_date, total_money, dining_option, cancelled_at FROM receipts ORDER BY receipt_date DESC LIMIT 5`),
      pool.query(`SELECT COUNT(*) AS count FROM receipt_payments`),
      pool.query(`SELECT COUNT(*) AS count FROM receipt_items`),
    ]);
    res.json({
      dateRange:      dateRange.rows[0],
      recentReceipts: sample.rows,
      paymentCount:   payments.rows[0],
      itemCount:      items.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;