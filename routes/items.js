const router = require('express').Router();
const pool   = require('../db');
const { requireAuth, requireWrite } = require('../middleware/auth');
const { rebuildItemCategories } = require('../services/sync');

const ITEM_SELECT = `
  SELECT i.id, i.sku, i.name, i.custom_name,
         COALESCE(i.custom_name, i.name)                AS display_name,
         i.category_id, i.custom_category_id,
         COALESCE(i.custom_category_id, i.category_id)  AS effective_category_id,
         COALESCE(c.custom_name, c.name)                AS category_name,
         i.report_category_id, rc.name                  AS report_category_name,
         i.price, i.cost, i.image_url, i.deleted_at, i.synced_at
  FROM items i
  LEFT JOIN categories c ON c.id = COALESCE(i.custom_category_id, i.category_id)
  LEFT JOIN report_categories rc ON rc.id = i.report_category_id`;

router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`${ITEM_SELECT} ORDER BY COALESCE(i.custom_name, i.name)`);
    res.json(result.rows);
  } catch (err) {
    console.error('Items GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/categories', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, custom_name, COALESCE(custom_name, name) AS display_name, color, deleted_at
      FROM categories
      WHERE deleted_at IS NULL
      ORDER BY COALESCE(custom_name, name)
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Categories GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/categories/:id', requireAuth, requireWrite('items'), async (req, res) => {
  if (!('custom_name' in req.body))
    return res.status(400).json({ message: 'custom_name is required (null to reset).' });
  const customName = req.body.custom_name === '' ? null : req.body.custom_name;
  try {
    const result = await pool.query(`
      UPDATE categories SET custom_name = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, name, custom_name, COALESCE(custom_name, name) AS display_name, color, deleted_at
    `, [customName, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Category not found.' });
    await rebuildItemCategories();
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Category PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

function parseReportCategoryId(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && String(n) === String(v) ? n : null;
}

router.get('/report-categories', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name FROM report_categories ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error('Report categories GET error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/report-categories', requireAuth, requireWrite('items'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name || name.length > 100) return res.status(400).json({ message: 'Name is required (max 100 chars).' });
  try {
    const result = await pool.query(
      'INSERT INTO report_categories (name) VALUES ($1) RETURNING id, name', [name]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'A report category with this name already exists.' });
    console.error('Report categories POST error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/report-categories/:id', requireAuth, requireWrite('items'), async (req, res) => {
  const id = parseReportCategoryId(req.params.id);
  if (id === null) return res.status(404).json({ message: 'Report category not found.' });
  const name = (req.body.name || '').trim();
  if (!name || name.length > 100) return res.status(400).json({ message: 'Name is required (max 100 chars).' });
  try {
    const result = await pool.query(
      'UPDATE report_categories SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name',
      [name, id]);
    if (!result.rows.length) return res.status(404).json({ message: 'Report category not found.' });
    await rebuildItemCategories();
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'A report category with this name already exists.' });
    console.error('Report categories PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/report-categories/:id', requireAuth, requireWrite('items'), async (req, res) => {
  const id = parseReportCategoryId(req.params.id);
  if (id === null) return res.status(404).json({ message: 'Report category not found.' });
  try {
    const result = await pool.query('DELETE FROM report_categories WHERE id = $1 RETURNING id', [id]);
    if (!result.rowCount) return res.status(404).json({ message: 'Report category not found.' });
    await rebuildItemCategories();
    res.json({ success: true });
  } catch (err) {
    console.error('Report categories DELETE error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAuth, requireWrite('items'), async (req, res) => {
  const sets   = [];
  const params = [];
  let i = 1;
  if ('custom_name' in req.body) {
    sets.push(`custom_name = $${i++}`);
    params.push(req.body.custom_name === '' ? null : req.body.custom_name);
  }
  if ('custom_category_id' in req.body) {
    sets.push(`custom_category_id = $${i++}`);
    params.push(req.body.custom_category_id || null);
  }
  if ('report_category_id' in req.body) {
    sets.push(`report_category_id = $${i++}`);
    params.push(req.body.report_category_id || null);
  }
  if (!sets.length)
    return res.status(400).json({ message: 'Nothing to update. Send custom_name and/or custom_category_id.' });
  params.push(req.params.id);

  try {
    const upd = await pool.query(
      `UPDATE items SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING id`,
      params
    );
    if (!upd.rows.length) return res.status(404).json({ message: 'Item not found.' });
    await rebuildItemCategories();
    const result = await pool.query(`${ITEM_SELECT} WHERE i.id = $1`, [req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Item PUT error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
