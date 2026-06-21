const path   = require('path');
const router = require('express').Router();

const authRouter        = require('./auth');
const analyticsRouter   = require('./analytics');
const expensesRouter    = require('./expenses');
const receiptsRouter    = require('./receipts');
const staffRouter       = require('./staff');
const usersRouter       = require('./users');
const permissionsRouter = require('./permissions');

router.use('/api/auth',        authRouter);
router.use('/api',             analyticsRouter);
router.use('/api/expenses',    expensesRouter);
router.use('/api/receipts',    receiptsRouter);
router.use('/api/staff',       staffRouter);
router.use('/api/users',       usersRouter);
router.use('/api/permissions', permissionsRouter);

router.get('/login', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
router.get('/',      (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
router.get('/users', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'users.html')));

module.exports = router;
