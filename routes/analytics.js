const router = require('express').Router();
const pool   = require('../db');
const { requireAuth } = require('../middleware/auth');
const { buildPeriodFilter, getTrendPeriod, getPrevPeriodSQL, growth } = require('../utils/date');

router.get('/kpis', requireAuth, async (req, res) => {
  const { period = 'today', start, end } = req.query;
  const filter     = buildPeriodFilter(period, start, end);
  const prevFilter = getPrevPeriodSQL(period, start, end);
  const expFilter  = buildPeriodFilter(period, start, end, 'e', 1, 'expense_date');
  try {
    const [curr, prev, expRes] = await Promise.all([
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
    ]);

    const c = curr.rows[0];
    const p = prev.rows[0];
    const expensesTotal = parseFloat(expRes.rows[0]?.total_expense || 0);

    res.json({
      gross_income: { value: parseFloat(c.gross_income).toFixed(2), growth: growth(c.gross_income, p.gross_income) },
      orders:       { value: parseInt(c.orders),                    growth: growth(c.orders, p.orders) },
      aov:          { value: parseFloat(c.aov).toFixed(2),          growth: growth(c.aov, p.aov) },
      expenses:     { total: expensesTotal },
      net_revenue:  parseFloat((parseFloat(c.gross_income) - expensesTotal).toFixed(2)),
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
      WHERE ${filter.clause} AND r.cancelled_at IS NULL
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
