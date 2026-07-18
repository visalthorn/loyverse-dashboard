const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { insertExpense } = require('../services/expenses');
const { analyzeIngredient, analyzeAllActive } = require('../services/inventoryAnalysis');

// The unit field accepts the frontend's predefined list (kg, g, l, ml, pc,
// bag) or any custom value the user types — validated shape only, no whitelist.
const UNIT_RE  = /^[\p{L}\p{N} .]{1,15}$/u;
const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;

function badRequest(res, message) { return res.status(400).json({ message }); }

// ── Ingredients ────────────────────────────────────────────────────────────

router.get('/ingredients', requireAuth, async (req, res) => {
  const includeInactive = req.query.include_inactive === 'true';
  try {
    const result = await pool.query(`
      SELECT i.id, i.name, i.name_kh, i.unit, i.alert_threshold, i.is_active,
             lr.restock_date AS last_restock_date, lr.total_after AS last_total_after,
             COALESCE(lc.link_count, 0) AS link_count
      FROM inv_ingredients i
      LEFT JOIN LATERAL (
        SELECT restock_date, total_after FROM inv_restocks
        WHERE ingredient_id = i.id
        ORDER BY restock_date DESC, created_at DESC
        LIMIT 1
      ) lr ON true
      LEFT JOIN (
        SELECT ingredient_id, COUNT(*) AS link_count FROM inv_item_links GROUP BY ingredient_id
      ) lc ON lc.ingredient_id = i.id
      ${includeInactive ? '' : 'WHERE i.is_active = true'}
      ORDER BY i.name
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Inventory ingredients GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingredients', requireAuth, async (req, res) => {
  const { name, name_kh } = req.body;
  const unit = (req.body.unit || '').trim();
  const alertThreshold = parseFloat(req.body.alert_threshold);
  if (!name?.trim() || !unit) return badRequest(res, 'name and unit are required.');
  if (!UNIT_RE.test(unit))    return badRequest(res, 'unit must be 1-15 letters/numbers (e.g. kg, or a custom unit).');
  try {
    const result = await pool.query(`
      INSERT INTO inv_ingredients (name, name_kh, unit, alert_threshold)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [name.trim(), name_kh?.trim() || null, unit, isNaN(alertThreshold) ? 0 : alertThreshold]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Inventory ingredients POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/ingredients/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, name_kh } = req.body;
  const unit = (req.body.unit || '').trim();
  const alertThreshold = parseFloat(req.body.alert_threshold);
  if (!id || !name?.trim() || !unit) return badRequest(res, 'id, name and unit are required.');
  if (!UNIT_RE.test(unit))           return badRequest(res, 'unit must be 1-15 letters/numbers (e.g. kg, or a custom unit).');
  try {
    const result = await pool.query(`
      UPDATE inv_ingredients
      SET name=$1, name_kh=$2, unit=$3, alert_threshold=$4, updated_at=NOW()
      WHERE id=$5 RETURNING *
    `, [name.trim(), name_kh?.trim() || null, unit, isNaN(alertThreshold) ? 0 : alertThreshold, id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Ingredient not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Inventory ingredients PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/ingredients/:id/toggle', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return badRequest(res, 'Invalid id.');
  try {
    const result = await pool.query(`
      UPDATE inv_ingredients SET is_active = NOT is_active, updated_at = NOW()
      WHERE id=$1 RETURNING *
    `, [id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Ingredient not found.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Inventory ingredients TOGGLE error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Restocks — the only stock input ────────────────────────────────────────

router.post('/restocks', requireAuth, async (req, res) => {
  const ingredientId = parseInt(req.body.ingredient_id);
  const { restock_date, note } = req.body;
  const added     = parseFloat(req.body.qty_added);
  const remaining = parseFloat(req.body.qty_remaining);
  const record_expense = req.body.record_expense !== false; // default ON

  if (!ingredientId || !restock_date || !DATE_RE.test(restock_date))
    return badRequest(res, 'ingredient_id and a valid restock_date (YYYY-MM-DD) are required.');
  if (isNaN(added) || added < 0 || isNaN(remaining) || remaining < 0)
    return badRequest(res, 'qty_added and qty_remaining must be numbers >= 0.');

  const totalAfter = remaining + added;
  const cost = req.body.cost !== undefined && req.body.cost !== null && req.body.cost !== ''
    ? Math.round(parseFloat(req.body.cost)) : null;
  if (cost !== null && (isNaN(cost) || cost < 0)) return badRequest(res, 'cost must be a number >= 0.');

  try {
    const ing = await pool.query('SELECT name, unit FROM inv_ingredients WHERE id=$1', [ingredientId]);
    if (!ing.rows.length) return res.status(404).json({ message: 'Ingredient not found.' });

    const result = await pool.query(`
      INSERT INTO inv_restocks (ingredient_id, restock_date, qty_added, qty_remaining, total_after, cost, note, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [ingredientId, restock_date, added, remaining, totalAfter, cost, note?.trim() || null, req.user.username]);

    let expense = null;
    if (cost > 0 && record_expense) {
      const { name, unit } = ing.rows[0];
      expense = await insertExpense({
        expense_date: restock_date,
        amount: cost,
        remark: `Stock: ${name} +${added}${unit}`,
        expense_by: req.user.username,
        source: 'inventory',
      });
    }

    res.status(201).json({ restock: result.rows[0], expense });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'A restock for this ingredient already exists on that date.' });
    if (err.code === '23514') return badRequest(res, 'qty_added and qty_remaining must be >= 0.');
    console.error('Inventory restocks POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/restocks', requireAuth, async (req, res) => {
  const ingredientId = parseInt(req.query.ingredient_id);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  if (!ingredientId) return badRequest(res, 'ingredient_id is required.');
  try {
    // LAG runs over the ingredient's full history so "consumed since previous"
    // stays correct even for the oldest row still inside the LIMIT window.
    const result = await pool.query(`
      SELECT * FROM (
        SELECT r.*,
               LAG(r.total_after) OVER (PARTITION BY r.ingredient_id ORDER BY r.restock_date, r.created_at) AS prev_total_after
        FROM inv_restocks r
        WHERE r.ingredient_id = $1
      ) sub
      ORDER BY restock_date DESC, created_at DESC
      LIMIT $2
    `, [ingredientId, limit]);

    const rows = result.rows.map(r => ({
      ...r,
      consumed_since_previous: r.prev_total_after != null
        ? parseFloat((parseFloat(r.prev_total_after) - parseFloat(r.qty_remaining)).toFixed(2))
        : null,
    }));
    res.json(rows);
  } catch (err) {
    console.error('Inventory restocks GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/restocks/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return badRequest(res, 'Invalid id.');
  try {
    const result = await pool.query('DELETE FROM inv_restocks WHERE id=$1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Restock not found.' });
    res.json({ deleted: true, id });
  } catch (err) {
    console.error('Inventory restocks DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Item links — link only, no quantities ──────────────────────────────────

router.get('/links', requireAuth, async (req, res) => {
  const ingredientId = parseInt(req.query.ingredient_id);
  if (!ingredientId) return badRequest(res, 'ingredient_id is required.');
  try {
    const result = await pool.query(`
      SELECT id, ingredient_id, sku, item_name
      FROM inv_item_links WHERE ingredient_id=$1 ORDER BY item_name
    `, [ingredientId]);
    res.json(result.rows);
  } catch (err) {
    console.error('Inventory links GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/links', requireAuth, async (req, res) => {
  const ingredientId = parseInt(req.body.ingredient_id);
  const sku = (req.body.sku || '').trim();
  if (!ingredientId || !sku) return badRequest(res, 'ingredient_id and sku are required.');
  try {
    const ing = await pool.query('SELECT id FROM inv_ingredients WHERE id=$1', [ingredientId]);
    if (!ing.rows.length) return res.status(404).json({ message: 'Ingredient not found.' });

    // Cache the item's most recent name off receipt_items so the chip/list
    // doesn't need a live join every time it renders.
    const nameRes = await pool.query(`
      SELECT ri.item_name
      FROM receipt_items ri JOIN receipts r ON r.receipt_number = ri.receipt_number
      WHERE ri.sku = $1
      ORDER BY r.receipt_date DESC LIMIT 1
    `, [sku]);

    const result = await pool.query(`
      INSERT INTO inv_item_links (ingredient_id, sku, item_name)
      VALUES ($1,$2,$3) RETURNING *
    `, [ingredientId, sku, nameRes.rows[0]?.item_name || null]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'This item is already linked to the ingredient.' });
    console.error('Inventory links POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/links/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return badRequest(res, 'Invalid id.');
  try {
    const result = await pool.query('DELETE FROM inv_item_links WHERE id=$1 RETURNING id', [id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Link not found.' });
    res.json({ deleted: true, id });
  } catch (err) {
    console.error('Inventory links DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Consumption analysis ───────────────────────────────────────────────────

router.get('/analysis', requireAuth, async (req, res) => {
  try {
    res.json(await analyzeAllActive());
  } catch (err) {
    console.error('Inventory analysis GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/analysis/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return badRequest(res, 'Invalid id.');
  try {
    const ing = await pool.query(
      'SELECT id, name, name_kh, unit, alert_threshold FROM inv_ingredients WHERE id = $1', [id]);
    if (!ing.rows.length) return res.status(404).json({ message: 'Ingredient not found.' });
    res.json(await analyzeIngredient(ing.rows[0]));
  } catch (err) {
    console.error('Inventory analysis:id GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Catalog of recently-sold SKUs for the "link an item" picker.
router.get('/sold-items', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (ri.sku) ri.sku, ri.item_name
      FROM receipt_items ri JOIN receipts r ON r.receipt_number = ri.receipt_number
      WHERE r.receipt_date >= NOW() - INTERVAL '90 days'
        AND r.cancelled_at IS NULL
        AND ri.sku IS NOT NULL AND ri.sku <> ''
      ORDER BY ri.sku, r.receipt_date DESC
    `);
    result.rows.sort((a, b) => (a.item_name || '').localeCompare(b.item_name || ''));
    res.json(result.rows);
  } catch (err) {
    console.error('Inventory sold-items GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
