const path   = require('path');
const router = require('express').Router();

const authRouter        = require('./auth');
const analyticsRouter   = require('./analytics');
const expensesRouter    = require('./expenses');
const receiptsRouter    = require('./receipts');
const staffRouter       = require('./staff');
const scheduleRouter    = require('./schedule');
const usersRouter       = require('./users');
const permissionsRouter = require('./permissions');
const syncRouter        = require('./sync');
const reportsRouter     = require('./reports');
const archiveRouter     = require('./archive');
const telegramRouter    = require('./telegram');
const itemsRouter       = require('./items');
const inventoryRouter   = require('./inventory');
const branchesRouter    = require('./branches');

router.use('/api/auth',        authRouter);
router.use('/api',             analyticsRouter);
router.use('/api/expenses',    expensesRouter);
router.use('/api/receipts',    receiptsRouter);
router.use('/api/staff',       staffRouter);
router.use('/api/schedule',    scheduleRouter);
router.use('/api/users',       usersRouter);
router.use('/api/permissions', permissionsRouter);
router.use('/api/sync',        syncRouter);
router.use('/api/reports',     reportsRouter);
router.use('/api/archive',     archiveRouter);
router.use('/api/telegram',    telegramRouter);
router.use('/api/items',       itemsRouter);
router.use('/api/inventory',   inventoryRouter);
router.use('/api/branches',    branchesRouter);

router.get('/login',       (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
router.get('/',            (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
router.get('/users',       (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'users.html')));
router.get('/inventory',   (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'inventory.html')));
router.get('/report.html',         (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'report.html')));
router.get('/summary-report.html', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'summary-report.html')));

module.exports = router;
