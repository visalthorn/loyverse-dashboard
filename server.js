const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const dotenv = require('dotenv');
 
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || process.env.JWT_SECRET_UAT || process.env.JWT_SECRET_PROD || 'pos_dashboard_secret_change_in_prod';
const JWT_EXPIRES = '1h'; // token lasts 1 hour
const express = require('express');
const cors = require('cors');
const path = require('path');
const pool = require('./db');

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ────────────────────────────────────────────────────────────────

// Auth Middleware ───────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token      = authHeader && authHeader.split(' ')[1]; // Bearer <token>
 
  if (!token) {
    return res.status(401).json({ message: 'Access denied. Please log in.' });
  }
 
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, username, email, role }
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }
}

// Cambodia timezone UTC+7
// receipt_date is stored in UTC so we shift by +7 hours when filtering

function toKH(col) {
  return col; // receipt_date is already stored in local time
}

function buildPeriodFilter(period, startDate, endDate, alias = 'r', firstParam = 1, colName = 'receipt_date') {
  const col = alias + '.' + colName;
  const kh  = toKH(col);
  if (startDate && endDate) {
    return { clause: `DATE(${kh}) BETWEEN $${firstParam} AND $${firstParam + 1}`, params: [startDate, endDate] };
  }
  if (startDate) {
    return { clause: `DATE(${kh}) >= $${firstParam}`, params: [startDate] };
  }
  if (endDate) {
    return { clause: `DATE(${kh}) <= $${firstParam}`, params: [endDate] };
  }
  switch (period) {
    case 'today': return { clause: `DATE(${kh}) = CURRENT_DATE`, params: [] };
    case 'week':  return { clause: `DATE(${kh}) BETWEEN CURRENT_DATE - INTERVAL '6 days' AND CURRENT_DATE`, params: [] };
    case 'month': return { clause: `DATE_TRUNC('month', ${kh}) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')`, params: [] };
    case 'year':  return { clause: `DATE_TRUNC('year', ${kh}) = DATE_TRUNC('year', CURRENT_DATE - INTERVAL '1 year')`, params: [] };
    default:      return { clause: `DATE(${kh}) = CURRENT_DATE`, params: [] };
  }
}

function getTrendPeriod(period, startDate, endDate) {
  if (period === 'year') return 'month';
  if (period === 'week' || period === 'month') return 'day';
  if (period === 'range' && startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const days = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1);
    if (days <= 31) return 'day';
    if (days <= 180) return 'week';
    return 'month';
  }
  return 'day';
}

function getPrevPeriodSQL(period, alias = 'r') {
  const col = alias + '.receipt_date';
  const kh  = toKH(col);
  switch (period) {
    case 'week':   return "DATE(" + kh + ") BETWEEN CURRENT_DATE - INTERVAL '13 days' AND CURRENT_DATE - INTERVAL '7 days'";
    case 'month':  return "DATE_TRUNC('month', " + kh + ") = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '2 months')";
    case 'year':   return "DATE_TRUNC('year',  " + kh + ") = DATE_TRUNC('year',  CURRENT_DATE - INTERVAL '2 years')";
    default:       return "DATE(" + kh + ") = CURRENT_DATE - INTERVAL '1 day'";
  }
}

function growth(current, previous) {
  if (!previous || previous == 0) return 0;
  return parseFloat((((current - previous) / previous) * 100).toFixed(1));
}

// Login Route ───────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
 
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }
 
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND is_active = true LIMIT 1',
      [username.toLowerCase().trim()]
    );
 
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }
 
    const user = result.rows[0];
    const storedHash = user.password;

    if (!storedHash) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const passwordMatch = await bcrypt.compare(password, storedHash);
 
    if (!passwordMatch) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }
 
    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );
 
    res.json({
      token,
      user: {
        id:       user.id,
        username: user.username,
        email:    user.email,
        fullName: user.full_name
      }
    });
 
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// Verify token route (used by dashboard on load) ────────
app.get('/api/auth/verify', requireAuth, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// Serve login page ──────────────────────────────────────
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ─── API: KPIs ───────────────────────────────────────────────────────────────

app.get('/api/kpis', requireAuth, async (req, res) => {
  const period = req.query.period || 'today';
  const filter = buildPeriodFilter(period, req.query.start, req.query.end);
  try {
    const curr = await pool.query(`
      SELECT
        COALESCE(SUM(total_money), 0) AS gross_income,
        COUNT(*) FILTER (WHERE cancelled_at IS NULL) AS orders,
        COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL) AS cancelled,
        COALESCE(AVG(total_money) FILTER (WHERE cancelled_at IS NULL), 0) AS aov
      FROM receipts r
      WHERE ${filter.clause}
    `, filter.params);
    // total expenses for the same filter (use expense_date column)
    const expFilter = buildPeriodFilter(period, req.query.start, req.query.end, 'e', 1, 'expense_date');
    const expRes = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS total_expense FROM expenses e WHERE ${expFilter.clause}
    `, expFilter.params);
    const prev = await pool.query(`
      SELECT
        COALESCE(SUM(total_money), 0) AS gross_income,
        COUNT(*) FILTER (WHERE cancelled_at IS NULL) AS orders
      FROM receipts r
      WHERE ${getPrevPeriodSQL(period)}
    `);
    const c = curr.rows[0];
    const p = prev.rows[0];
    const expensesTotal = expRes.rows[0] ? parseFloat(expRes.rows[0].total_expense) : 0;
    const totalOrders = parseInt(c.orders) + parseInt(c.cancelled);
    res.json({
      gross_income:     { value: parseFloat(c.gross_income).toFixed(2), growth: growth(c.gross_income, p.gross_income) },
      orders:           { value: parseInt(c.orders), growth: growth(c.orders, p.orders) },
      aov:              { value: parseFloat(c.aov).toFixed(2), growth: 0 },
      cancellationRate: { value: totalOrders > 0 ? ((c.cancelled / totalOrders) * 100).toFixed(1) : '0.0', growth: 0 },
      cancelledCount:   parseInt(c.cancelled),
      cancelledRevenue: 0,
      expenses: { total: expensesTotal },
      net_revenue: parseFloat((parseFloat(c.gross_income) - expensesTotal).toFixed(2))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Gross Income ──────────────────────────────────────────────────────

app.get('/api/gross-income', requireAuth, async (req, res) => {
  const period = req.query.period || 'daily';
  const filter = buildPeriodFilter(period, req.query.start, req.query.end, 'r', 2);
  const trunc = getTrendPeriod(period, req.query.start, req.query.end);

  try {
    const result = await pool.query(`
      SELECT
        DATE_TRUNC($1, receipt_date) AS period,
        COALESCE(SUM(total_money), 0) AS gross_income,
        COUNT(*) FILTER (WHERE cancelled_at IS NULL) AS orders
      FROM receipts r
      WHERE ${filter.clause} AND cancelled_at IS NULL
      GROUP BY 1
      ORDER BY 1
    `, [trunc, ...filter.params]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Expenses Trend (for chart overlays) ─────────────────────────────────
app.get('/api/expenses-trend', requireAuth, async (req, res) => {
  const period = req.query.period || 'daily';
  const filter = buildPeriodFilter(period, req.query.start, req.query.end, 'e', 2, 'expense_date');
  const trunc = getTrendPeriod(period, req.query.start, req.query.end);

  try {
    const result = await pool.query(`
      SELECT
        DATE_TRUNC($1, expense_date) AS period,
        COALESCE(SUM(amount), 0) AS total_expense
      FROM expenses e
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

// ─── API: Dining Options ─────────────────────────────────────────────────────

app.get('/api/dining-options', requireAuth, async (req, res) => {
  const period = req.query.period || 'month';
  const filter = buildPeriodFilter(period, req.query.start, req.query.end);
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(dining_option, 'Unknown') AS dining_option,
        COUNT(*) AS orders,
        COALESCE(SUM(total_money), 0) AS revenue
      FROM receipts r
      WHERE ${filter.clause} AND cancelled_at IS NULL
      GROUP BY 1
      ORDER BY revenue DESC
    `, filter.params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Top Items ──────────────────────────────────────────────────────────

app.get('/api/top-items', requireAuth, async (req, res) => {
  const period = req.query.period || 'month';
  const limit  = req.query.limit  || 10;
  const filter = buildPeriodFilter(period, req.query.start, req.query.end);
  try {
    const params = [...filter.params, limit];
    const result = await pool.query(`
      SELECT
        ri.item_name,
        ri.sku,
        SUM(ri.quantity) AS qty_sold,
        SUM(ri.gross_total) AS revenue
      FROM receipt_items ri
      JOIN receipts r ON r.receipt_number = ri.receipt_number
      WHERE ${filter.clause} AND r.cancelled_at IS NULL
      GROUP BY ri.item_name, ri.sku
      ORDER BY revenue DESC
      LIMIT $${params.length}
    `, params);

    const total = result.rows.reduce((s, r) => s + parseFloat(r.revenue), 0);
    const rows  = result.rows.map(r => ({
      ...r,
      pct: total > 0 ? ((parseFloat(r.revenue) / total) * 100).toFixed(1) : '0'
    }));
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Payment Methods ────────────────────────────────────────────────────

app.get('/api/payment-methods', requireAuth, async (req, res) => {
  const period = req.query.period || 'month';
  const filter = buildPeriodFilter(period, req.query.start, req.query.end);
  try {
    const result = await pool.query(`
      SELECT
        rp.payment_name,
        rp.payment_type,
        COUNT(*) AS transactions,
        SUM(rp.money_amount) AS total
      FROM receipt_payments rp
      JOIN receipts r ON r.receipt_number = rp.receipt_number
      WHERE ${filter.clause} AND r.cancelled_at IS NULL
      GROUP BY rp.payment_name, rp.payment_type
      ORDER BY total DESC
    `, filter.params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Peak Hours ─────────────────────────────────────────────────────────

app.get('/api/peak-hours', requireAuth, async (req, res) => {
  const period = req.query.period || 'month';
  const filter = buildPeriodFilter(period, req.query.start, req.query.end);
  try {
    const result = await pool.query(`
      SELECT
        EXTRACT(DOW  FROM receipt_date) AS day_of_week,
        EXTRACT(HOUR FROM receipt_date) AS hour,
        COUNT(*) AS orders,
        COALESCE(SUM(total_money), 0) AS revenue
      FROM receipts r
      WHERE ${filter.clause} AND cancelled_at IS NULL
      GROUP BY 1, 2
      ORDER BY 1, 2
    `, filter.params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Employee Performance ───────────────────────────────────────────────
app.get('/api/employee-performance', requireAuth, async (req, res) => {
  const period = req.query.period || 'month';
  const filter = buildPeriodFilter(period, req.query.start, req.query.end);
  try {
    const result = await pool.query(`
      SELECT
        employee_id,
        COUNT(*) FILTER (WHERE cancelled_at IS NULL) AS orders,
        COALESCE(SUM(total_money) FILTER (WHERE cancelled_at IS NULL), 0) AS revenue,
        COALESCE(AVG(total_money) FILTER (WHERE cancelled_at IS NULL), 0) AS aov
      FROM receipts r
      WHERE ${filter.clause}
      GROUP BY employee_id
      ORDER BY revenue DESC
      LIMIT 10
    `, filter.params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Device Performance ─────────────────────────────────────────────────
app.get('/api/device-performance', requireAuth, async (req, res) => {
  const period = req.query.period || 'month';
  const filter = buildPeriodFilter(period, req.query.start, req.query.end);
  try {
    const result = await pool.query(`
      SELECT
        COALESCE(pd.name, r.pos_device_id) AS device_name,
        COUNT(*) FILTER (WHERE r.cancelled_at IS NULL) AS orders,
        COALESCE(SUM(r.total_money) FILTER (WHERE r.cancelled_at IS NULL), 0) AS revenue
      FROM receipts r
      LEFT JOIN pos_devices pd ON pd.id::varchar = r.pos_device_id
      WHERE ${filter.clause}
      GROUP BY pd.name, r.pos_device_id
      ORDER BY revenue DESC
    `, filter.params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Cancelled Orders ───────────────────────────────────────────────────
app.get('/api/cancelled-orders', async (req, res) => {
  const period = req.query.period || 'today';
  const filter = buildPeriodFilter(period, req.query.start, req.query.end);
  try {
    const result = await pool.query(`
      SELECT
        receipt_number,
        total_money,
        receipt_date,
        cancelled_at,
        employee_id,
        dining_option
      FROM receipts r
      WHERE ${filter.clause} AND cancelled_at IS NOT NULL
      ORDER BY cancelled_at DESC
      LIMIT 20
    `, filter.params);
    const summary = await pool.query(`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(total_money), 0) AS lost_revenue
      FROM receipts r
      WHERE ${filter.clause} AND cancelled_at IS NOT NULL
    `, filter.params);
    res.json({ summary: summary.rows[0], items: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Expenses ───────────────────────────────────────────────────────────
app.get('/api/expenses', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, expense_date, amount, remark, expense_by, created_at
      FROM expenses
      ORDER BY created_at DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Expenses GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/expenses', requireAuth, async (req, res) => {
  const { expense_date, amount, remark, expense_by } = req.body;
  if (!expense_date || !amount || !expense_by) {
    return res.status(400).json({ message: 'expense_date, amount and expense_by are required.' });
  }

  try {
    const result = await pool.query(`
      INSERT INTO expenses (expense_date, amount, remark, expense_by)
      VALUES ($1, $2, $3, $4)
      RETURNING id, expense_date, amount, remark, expense_by, created_at
    `, [expense_date, amount, remark || null, expense_by]);

    res.status(201).json({ expense: result.rows[0] });
  } catch (err) {
    console.error('Expenses POST error:', err);
    res.status(500).json({ error: err.message });
  }
});



// ─── DEBUG endpoint ──────────────────────────────────────────────────────────
app.get('/api/debug', async (req, res) => {
  try {
    const dateRange = await pool.query(`
      SELECT
        MIN(receipt_date) AS oldest,
        MAX(receipt_date) AS newest,
        COUNT(*) AS total_receipts,
        COUNT(*) FILTER (WHERE cancelled_at IS NOT NULL) AS cancelled,
        CURRENT_DATE AS db_today,
        NOW() AS db_now
      FROM receipts
    `);
    const sample = await pool.query(`SELECT receipt_number, receipt_date, total_money, dining_option, cancelled_at FROM receipts ORDER BY receipt_date DESC LIMIT 5`);
    const payments = await pool.query(`SELECT COUNT(*) as count FROM receipt_payments`);
    const items = await pool.query(`SELECT COUNT(*) as count FROM receipt_items`);
    res.json({
      dateRange: dateRange.rows[0],
      recentReceipts: sample.rows,
      paymentCount: payments.rows[0],
      itemCount: items.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 8. Users table SQL ───────────────────────────────────────
/*
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(50)  UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  email         VARCHAR(100) UNIQUE NOT NULL,
  full_name     VARCHAR(100),
  role          VARCHAR(20)  NOT NULL DEFAULT 'viewer',  -- 'admin' | 'manager' | 'viewer'
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMP    NOT NULL DEFAULT NOW()
);
 
-- Create your first admin user (password: changeme123)
INSERT INTO users (username, password, email, full_name, role)
VALUES (
  'admin',
  '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- bcrypt of 'password'
  'admin@chabmouth.com',
  'Admin User',
  'admin'
);
*/
 
 
// ── 9. Create admin user script ──────────────────────────────
// Run once: node create-admin.js
// File: create-admin.js
/*
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();
 
const pool = new Pool({ ... }); // your db config
 
async function createAdmin() {
  const hash = await bcrypt.hash('your_password_here', 10);
  await pool.query(
    'INSERT INTO users (username, password, email, full_name, role) VALUES ($1,$2,$3,$4,$5)',
    ['admin', hash, 'admin@chabmouth.com', 'Admin User', 'admin']
  );
  console.log('✅ Admin user created!');
  process.exit(0);
}
createAdmin();
*/

// ─── Serve Dashboard ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║  ✅  POS Dashboard is RUNNING           ║`);
  console.log(`╠════════════════════════════════════════╣`);
  console.log(`║  🌐  Open: http://localhost:${PORT}         ║`);
  console.log(`║  🗄   ENV: ${(process.env.ENV || 'UAT').padEnd(29)}║`);
  console.log(`╚════════════════════════════════════════╝\n`);
});
