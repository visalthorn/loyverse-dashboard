# POS/KDS Usability Fixes Round 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix real-world usability and correctness issues found in live testing of the POS/KDS revision: a genuine multi-station Kitchen Display bug (explicitly deferred earlier, now confirmed happening), a silent-failure dialog bug, missing item-editing on sent orders, and several UI space/feedback improvements across POS, KDS, and the dashboard's Live Orders view.

**Architecture:** No new database tables. The multi-station KDS fix (the largest item) relies entirely on the existing `pos_order_items.kitchen_status` column as the single source of truth for order readiness — a station's Ready tap only ever checks its own items, and the order auto-advances to `ready` the moment every item on it (any station) is done, regardless of tap order. Everything else is additive: two new order-item endpoints, response-shape additions to two existing endpoints, and frontend-only UI/UX changes.

**Tech Stack:** Same as the prior plan — Express (CommonJS) + `pg`, vanilla-JS ES module frontend, `node:test` for backend tests (no frontend test harness in this repo).

## Global Constraints

- All new/changed timestamps go through `toCambodiaTime()`, never raw `NOW()` in application code — matches every prior task in this codebase.
- Branch scoping for every new/changed POS/KDS terminal endpoint derives strictly from `req.terminal.branch_id` (JWT-derived, never client input) — same pattern as every existing route in `routes/pos.js`.
- Any new HTML interpolated into `innerHTML` via user-controlled or catalog-sourced text (item names, notes, order names, terminal names) MUST go through the existing `esc()` helper already defined in the touched file. Two real stored-XSS bugs were found and fixed this way in the prior plan — do not reintroduce the pattern.
- Frontend files have no automated test harness. Verify with `node --check <file>` for syntax, and note explicitly in each frontend task's report that live browser verification is deferred to the user (matching the established convention from the prior plan).
- Test fixture string literals inserted into `VARCHAR(20)` columns (`pos_orders.order_number`, `pos_receipts.receipt_number`, `pos_terminals.terminal_id`, `kds_terminals.terminal_id`) MUST keep `prefix.length + 13 <= 20` when built as `` `PREFIX-${Date.now()}` `` (13-digit epoch ms) — this exact overflow bug was hit and fixed repeatedly in the prior plan. Keep prefixes to 7 characters or fewer.
- `categories.id` and `items.id` are `uuid` columns with **no database-side default** in this schema — any test fixture inserting into `categories`/`items` must supply an explicit `crypto.randomUUID()` as the id.
- Environment convention: every test/migration command MUST be run with `npx cross-env ENV=UAT` prefixed — bare `node`/`node --test` silently hits the PROD Supabase database.

---

### Task 1: Fix the cancel-order silent-failure bug

**Files:**
- Modify: `public/js/dialog.js`
- Modify: `public/js/pos.js`

**Interfaces:**
- No new exports. `openDialog()`'s existing signature/return (a Promise resolving to boolean) is unchanged — only its internal robustness against re-entrancy changes.

**Root cause (confirmed by code trace during design):** `openDialog()` reuses one module-level `<dialog>` element for every `showConfirm`/`showAlert` call app-wide. Calling `d.showModal()` while that element is already open throws `InvalidStateError` synchronously inside the `Promise` executor, making `openDialog()` return a **rejected** promise. `cancelOrder()` does `const ok = await showConfirm(...)` with no try/catch — the rejection becomes an unhandled promise rejection, which is why tapping Cancel appeared to silently do nothing.

- [ ] **Step 1: Fix the dialog re-entrancy bug**

In `public/js/dialog.js`, inside `openDialog()`, right after `const d = ensureDialog();`:

```js
function openDialog({ message, title, confirmText, cancelText, danger, showCancel }) {
  const d = ensureDialog();
  // A prior invocation's dialog can still be open if this is called again
  // before it resolved (e.g. a second action fired while the first dialog
  // was still up) -- showModal() on an already-open <dialog> throws
  // InvalidStateError, which silently rejects the returned promise with no
  // visible error to the user. Force-close any stale instance first so its
  // pending promise resolves (as cancelled) instead of hanging or throwing.
  if (d.open) d.close('');

  const titleEl   = d.querySelector('.app-dialog-title');
  // ...rest of the function unchanged
```

- [ ] **Step 2: Verify with `node --check`**

Run: `node --check public/js/dialog.js`
Expected: no output (syntax OK).

- [ ] **Step 3: Add a loading guard in `pos.js` so an in-flight order load can't be acted on with stale/no data**

In `public/js/pos.js`, add a module-level flag near the other module-level `let` declarations (around line 30, next to `let lastPaidOrder`):

```js
let orderLoading = false;
```

Update `loadOrderIntoPanel` (currently around line 625):

```js
async function loadOrderIntoPanel(id) {
  orderLoading = true;
  const data = await fetchJSON(`/api/pos/orders/${id}`);
  orderLoading = false;
  if (!data) return;
  applyOrderToPanel(data.order);
}
```

Update the top of `cancelOrder()` (currently around line 553):

```js
async function cancelOrder() {
  if (orderLoading) { showToast('Still loading the order — try again in a moment.', 'error'); return; }
  if (!currentOrder) return;
  if (currentOrder._queued) {
    showToast("This order hasn't synced yet — it'll retry automatically.", 'error');
    return;
  }
  // ...rest unchanged
```

- [ ] **Step 4: Verify with `node --check`**

Run: `node --check public/js/pos.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add public/js/dialog.js public/js/pos.js
git commit -m "fix(pos): stop the confirm dialog from silently failing on re-entrant calls"
```

---

### Task 2: Backend — edit quantity / remove items already sent to the kitchen

**Files:**
- Modify: `routes/pos.js` (add two routes after the existing `POST /orders/:id/items`, around line 449)
- Test: `test/pos-order-items-edit.test.js`

**Interfaces:**
- Produces: `PATCH /api/pos/order-items/:id` (`requireTerminalAuth(['pos'])`), body `{ quantity }` → `{ order }`.
- Produces: `DELETE /api/pos/order-items/:id` (`requireTerminalAuth(['pos'])`) → `{ order }`.
- Both reject with `409` if `item.kitchen_status === 'done'`, if the order is in a terminal state (`TERMINAL.has(order.status)`), or (DELETE only) if it's the order's last remaining item.
- Consumes: existing `httpError`, `parseId`, `TERMINAL`, `toCambodiaTime`, `broadcastOrdersChanged`, `fetchOrder` — all already defined/imported in `routes/pos.js`.

- [ ] **Step 1: Write the failing tests**

```js
// test/pos-order-items-edit.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { jwtSecretTerminal } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, termId, catalogItemId, orderId, itemId1, itemId2;
const SUFFIX = Date.now();

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-EdIt-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const t = await pool.query(`INSERT INTO pos_terminals (name, branch_id, terminal_id, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [`T-EdPos-${SUFFIX}`, branchId, `T-EdPo-${SUFFIX}`, hash]);
  termId = t.rows[0].id;
  const cat = await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2) RETURNING id`, [require('crypto').randomUUID(), `T-EdCat-${SUFFIX}`]);
  const item = await pool.query(`INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [require('crypto').randomUUID(), `T-EdItem-${SUFFIX}`, 4000, cat.rows[0].id]);
  catalogItemId = item.rows[0].id;
});

after(async () => {
  await pool.query(`DELETE FROM pos_order_events WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_order_items WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM items WHERE id = $1`, [catalogItemId]);
  await pool.query(`DELETE FROM categories WHERE name = $1`, [`T-EdCat-${SUFFIX}`]);
  await pool.query(`DELETE FROM pos_terminals WHERE id = $1`, [termId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

function posToken() {
  return jwt.sign({ type: 'pos', id: termId, terminal_id: `T-EdPo-${SUFFIX}`, branch_id: branchId, name: 'x' }, jwtSecretTerminal);
}
const authed = (opts = {}) => ({ ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${posToken()}`, ...(opts.headers || {}) } });

test('setup: create an order with two lines and send to kitchen', async () => {
  const diningRow = await pool.query(`SELECT DISTINCT dining_option FROM receipts WHERE dining_option IS NOT NULL LIMIT 1`);
  const diningOption = diningRow.rows[0]?.dining_option || 'ក្នុងហាង';
  const created = await fetch(`${base}/api/pos/orders`, authed({
    method: 'POST',
    body: JSON.stringify({ dining_option: diningOption, items: [
      { source_item_id: catalogItemId, quantity: 2 },
      { source_item_id: catalogItemId, quantity: 1 },
    ] }),
  }));
  const body = await created.json();
  orderId = body.order.id;
  itemId1 = body.order.items[0].id;
  itemId2 = body.order.items[1].id;
  assert.equal(body.order.items.length, 2);
});

test('PATCH quantity recomputes order totals', async () => {
  const res = await fetch(`${base}/api/pos/order-items/${itemId1}`, authed({ method: 'PATCH', body: JSON.stringify({ quantity: 5 }) }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const line1 = body.order.items.find(i => i.id === itemId1);
  assert.equal(line1.quantity, 5);
  assert.equal(Number(body.order.subtotal), 4000 * 5 + 4000 * 1);
});

test('a done item cannot be changed', async () => {
  await pool.query(`UPDATE pos_order_items SET kitchen_status = 'done' WHERE id = $1`, [itemId1]);
  const res = await fetch(`${base}/api/pos/order-items/${itemId1}`, authed({ method: 'PATCH', body: JSON.stringify({ quantity: 1 }) }));
  assert.equal(res.status, 409);
  await pool.query(`UPDATE pos_order_items SET kitchen_status = 'pending' WHERE id = $1`, [itemId1]);
});

test('DELETE removes a line and recomputes totals', async () => {
  const res = await fetch(`${base}/api/pos/order-items/${itemId2}`, authed({ method: 'DELETE' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.order.items.length, 1);
  assert.equal(Number(body.order.subtotal), 4000 * 5);
});

test('cannot delete the last remaining item', async () => {
  const res = await fetch(`${base}/api/pos/order-items/${itemId1}`, authed({ method: 'DELETE' }));
  assert.equal(res.status, 409);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env ENV=UAT node --test test/pos-order-items-edit.test.js`
Expected: FAIL — both routes 404 (don't exist yet).

- [ ] **Step 3: Add the routes to `routes/pos.js`**, right after the existing `POST /orders/:id/items` handler (before `async function completeOrder`):

```js
router.patch('/order-items/:id', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  const qty = parseInt(req.body.quantity, 10);
  if (!id) return res.status(400).json({ message: 'Invalid item id.' });
  if (!Number.isInteger(qty) || qty < 1 || qty > 100) {
    return res.status(400).json({ message: 'quantity must be a number between 1 and 100.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itemRes = await client.query('SELECT * FROM pos_order_items WHERE id = $1 FOR UPDATE', [id]);
    if (!itemRes.rows.length) throw httpError(404, 'Order item not found.');
    const item = itemRes.rows[0];

    const orderRes = await client.query('SELECT * FROM pos_orders WHERE id = $1 FOR UPDATE', [item.order_id]);
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order item not found.');
    if (TERMINAL.has(order.status)) throw httpError(409, `Cannot edit items on a ${order.status} order.`);
    if (item.kitchen_status === 'done') throw httpError(409, "This item has already been prepared and can't be changed.");

    await client.query('UPDATE pos_order_items SET quantity = $1 WHERE id = $2', [qty, id]);

    const itemsRes  = await client.query('SELECT price, quantity FROM pos_order_items WHERE order_id = $1', [order.id]);
    const newSubtotal = itemsRes.rows.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
    const newTotal     = Math.max(0, newSubtotal - Number(order.discount));
    const now = toCambodiaTime(new Date());
    await client.query(
      `UPDATE pos_orders SET subtotal = $1, total = $2, updated_at = $3 WHERE id = $4`,
      [newSubtotal, newTotal, now, order.id]
    );

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(order.id) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS order-item quantity error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
});

router.delete('/order-items/:id', requireTerminalAuth(['pos']), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: 'Invalid item id.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itemRes = await client.query('SELECT * FROM pos_order_items WHERE id = $1 FOR UPDATE', [id]);
    if (!itemRes.rows.length) throw httpError(404, 'Order item not found.');
    const item = itemRes.rows[0];

    const orderRes = await client.query('SELECT * FROM pos_orders WHERE id = $1 FOR UPDATE', [item.order_id]);
    const order = orderRes.rows[0];
    if (order.branch_id !== req.terminal.branch_id) throw httpError(404, 'Order item not found.');
    if (TERMINAL.has(order.status)) throw httpError(409, `Cannot edit items on a ${order.status} order.`);
    if (item.kitchen_status === 'done') throw httpError(409, "This item has already been prepared and can't be removed.");

    const countRes = await client.query('SELECT COUNT(*) AS n FROM pos_order_items WHERE order_id = $1', [order.id]);
    if (parseInt(countRes.rows[0].n, 10) <= 1) {
      throw httpError(409, 'Cannot remove the last item — cancel the order instead.');
    }

    await client.query('DELETE FROM pos_order_items WHERE id = $1', [id]);

    const itemsRes  = await client.query('SELECT price, quantity FROM pos_order_items WHERE order_id = $1', [order.id]);
    const newSubtotal = itemsRes.rows.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
    const newTotal     = Math.max(0, newSubtotal - Number(order.discount));
    const now = toCambodiaTime(new Date());
    await client.query(
      `UPDATE pos_orders SET subtotal = $1, total = $2, updated_at = $3 WHERE id = $4`,
      [newSubtotal, newTotal, now, order.id]
    );

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(order.id) });
  } catch (err) {
    await client.query('ROLLBACK');
    const status = err.statusCode || 500;
    if (status >= 500) console.error('POS order-item delete error:', err);
    res.status(status).json({ message: err.message });
  } finally {
    client.release();
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx cross-env ENV=UAT node --test test/pos-order-items-edit.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add routes/pos.js test/pos-order-items-edit.test.js
git commit -m "feat(pos): allow editing/removing sent order items until the kitchen strikes them"
```

---

### Task 3: Frontend — cart editing UI for sent-but-unstruck items

**Files:**
- Modify: `public/js/pos.js` (`renderCart`, plus two new handler functions)

**Interfaces:**
- Consumes: `PATCH /api/pos/order-items/:id` and `DELETE /api/pos/order-items/:id` from Task 2.
- Produces: `changeSentItemQty(itemId, delta)`, `removeSentItem(itemId)` — internal to `pos.js`, wired via event listeners in `renderCart()`, not exposed on `window`.

- [ ] **Step 1: Replace the `persistedHTML` block inside `renderCart()`** (currently the `persisted.map(...)` block, around line 196)

```js
const persistedHTML = persisted.map(it => {
  const editable = it.kitchen_status !== 'done' && !(currentOrder && currentOrder._queued);
  if (!editable) {
    return `
      <div class="cart-line sent">
        <div class="cl-info">
          <div class="cl-name">${esc(it.item_name)}</div>
          <div class="cl-price">${khr(it.price)} × ${it.quantity}${it.note ? ` · ${esc(it.note)}` : ''}</div>
        </div>
        <div class="cl-total">${khr(it.price * it.quantity)}</div>
      </div>
    `;
  }
  return `
    <div class="cart-line sent">
      <div class="cl-info">
        <div class="cl-name">${esc(it.item_name)}</div>
        <div class="cl-price">${khr(it.price)}${it.note ? ` · <span class="cl-note">${esc(it.note)}</span>` : ''}</div>
      </div>
      <div class="qty-stepper">
        <button type="button" data-sent-dec="${it.id}">−</button>
        <span class="qty-val">${it.quantity}</span>
        <button type="button" data-sent-inc="${it.id}">+</button>
      </div>
      <div class="cl-total">${khr(it.price * it.quantity)}</div>
      <button class="cl-remove" type="button" data-sent-remove="${it.id}">✕</button>
    </div>
  `;
}).join('');
```

- [ ] **Step 2: Wire the new handlers**, right after the existing `list.querySelectorAll('[data-note-idx]')...` line inside `renderCart()`:

```js
list.querySelectorAll('[data-sent-inc]').forEach(b => b.addEventListener('click', () => changeSentItemQty(parseInt(b.dataset.sentInc, 10), 1)));
list.querySelectorAll('[data-sent-dec]').forEach(b => b.addEventListener('click', () => changeSentItemQty(parseInt(b.dataset.sentDec, 10), -1)));
list.querySelectorAll('[data-sent-remove]').forEach(b => b.addEventListener('click', () => removeSentItem(parseInt(b.dataset.sentRemove, 10))));
```

- [ ] **Step 3: Add the two handler functions**, near `editCartNote` (in the Cart section):

```js
async function changeSentItemQty(itemId, delta) {
  if (!currentOrder) return;
  const item = currentOrder.items.find(i => i.id === itemId);
  if (!item) return;
  const newQty = item.quantity + delta;
  if (newQty < 1) { removeSentItem(itemId); return; }
  const { ok, data } = await mutate(`/api/pos/order-items/${itemId}`, 'PATCH', { quantity: newQty });
  if (ok && data.order) { currentOrder = data.order; renderCart(); }
  else if (!ok) showToast(data.message || 'Failed to update item.', 'error');
}

async function removeSentItem(itemId) {
  if (!currentOrder) return;
  const ok = await showConfirm('Remove this item from the order?', { danger: true, confirmText: 'Remove' });
  if (!ok) return;
  const { ok: success, data } = await mutate(`/api/pos/order-items/${itemId}`, 'DELETE', null);
  if (success && data.order) { currentOrder = data.order; renderCart(); }
  else if (!success) showToast(data.message || 'Failed to remove item.', 'error');
}
```

- [ ] **Step 4: Verify with `node --check`**

Run: `node --check public/js/pos.js`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add public/js/pos.js
git commit -m "feat(pos): edit quantity or remove sent order items until kitchen-struck"
```

---

### Task 4: POS — collapsible nav menu

**Files:**
- Modify: `public/pos.html`
- Modify: `public/js/pos.js`

**Interfaces:**
- Produces: `window.posToggleNavMenu()` (new). Existing `window.posSwitchTerminal`, `window.posOpenSettings`, `window.posOpenReceipts` unchanged — just reached through the new menu instead of standalone buttons.

- [ ] **Step 1: Replace the `#topStrip` markup in `public/pos.html`** (currently lines 297–304)

```html
  <div id="topStrip">
    <span class="brand">🧾 POS Till</span>
    <div id="openOrdersStrip" style="display:flex;gap:10px;"></div>
    <button id="navMenuBtn" onclick="window.posToggleNavMenu()" title="Menu">☰</button>
    <button id="newOrderBtn" onclick="window.posNewOrder()">+ New Order</button>
  </div>

  <div id="navMenu">
    <div id="navMenuTerminalName"></div>
    <button type="button" onclick="window.posSwitchTerminal(); window.posToggleNavMenu();">🔀 Switch Terminal</button>
    <button type="button" onclick="window.posOpenSettings(); window.posToggleNavMenu();">⚙ Settings</button>
    <button type="button" onclick="window.posOpenReceipts(); window.posToggleNavMenu();">🧾 Receipts</button>
  </div>
```

- [ ] **Step 2: Replace the button-group CSS rule** (currently `#newOrderBtn, #settingsBtn, #switchTerminalBtn, #receiptsBtn { ... }` and the three width overrides right after it, around lines 52–60) with:

```css
  #newOrderBtn, #navMenuBtn {
    flex: 0 0 auto; height: 48px; padding: 0 18px;
    border-radius: 10px; border: 1px solid var(--border-strong);
    background: var(--bg-surface-alt); color: var(--text-primary);
    font-weight: 600; font-size: 13px; cursor: pointer;
  }
  #navMenuBtn { margin-left: auto; width: 48px; padding: 0; font-size: 18px; }

  #navMenu {
    display: none; flex-direction: column; gap: 4px;
    position: fixed; top: 68px; right: 16px; z-index: 600;
    min-width: 220px; padding: 10px; border-radius: 12px;
    background: var(--bg-surface); border: 1px solid var(--border); box-shadow: var(--shadow-lift);
  }
  #navMenu.open { display: flex; }
  #navMenuTerminalName {
    padding: 8px 10px; font-size: 12px; font-weight: 700; color: var(--text-secondary);
    border-bottom: 1px solid var(--border-subtle); margin-bottom: 4px;
  }
  #navMenu button {
    height: 44px; padding: 0 12px; text-align: left; border-radius: 8px; border: none;
    background: none; color: var(--text-primary); font-size: 14px; font-weight: 600; cursor: pointer;
  }
  #navMenu button:active { background: var(--bg-surface-alt); }
```

- [ ] **Step 3: Add menu toggle logic to `public/js/pos.js`**, near `switchTerminal()`:

```js
function toggleNavMenu() {
  getEl('navMenu').classList.toggle('open');
}

document.addEventListener('click', (e) => {
  const menu = getEl('navMenu');
  const btn  = getEl('navMenuBtn');
  if (menu && menu.classList.contains('open') && !menu.contains(e.target) && e.target !== btn) {
    menu.classList.remove('open');
  }
});

window.posToggleNavMenu = toggleNavMenu;
```

- [ ] **Step 4: Replace the dynamic terminal-name-tag insertion in `startApp()`** (currently the `if (brandEl && info) { ... let tag = ... }` block, around lines 800–813) with:

```js
  const info = terminal || getTerminalInfo();
  const nameEl = getEl('navMenuTerminalName');
  if (nameEl && info) nameEl.textContent = info.name || info.terminal_id;
```

(This replaces the old block that queried `#topBar .brand` — note `#topBar` doesn't exist in `pos.html` at all, that selector was a pre-existing dead reference; `#topStrip .brand` is the correct one and is unused by this replacement since the name now lives in the menu instead.)

- [ ] **Step 5: Verify with `node --check`**

Run: `node --check public/js/pos.js`
Expected: no output.

- [ ] **Step 6: Manual verification**

Run: `npm run dev:uat`, log into a POS terminal.
1. Confirm Switch Terminal/Settings/Receipts buttons are gone from the top strip; a single ☰ button remains, right-aligned before "+ New Order".
2. Tap ☰ → menu opens showing terminal name + the three actions. Tap outside the menu → it closes.
3. Tap each of the three actions → correct modal/flow opens, and the menu closes itself.

Expected: matches the above; no console errors.

- [ ] **Step 7: Commit**

```bash
git add public/pos.html public/js/pos.js
git commit -m "feat(pos): collapse terminal name/switch/settings/receipts into a nav menu"
```

---

### Task 5: POS — category selector as a dropdown

**Files:**
- Modify: `public/pos.html`
- Modify: `public/js/pos.js`

**Interfaces:**
- No new exports. `renderCategories()`'s external contract (reads `catalog.categories`, writes `activeCategory`, triggers `renderItemGrid()`) is unchanged.

- [ ] **Step 1: Replace `#categoryBar`'s CSS rule** in `public/pos.html` (currently `#categoryBar { display: flex; gap: 8px; ... }` plus the two `.cat-tab` rules right after it, around lines 68–74):

```css
  #categoryBar {
    display: block; margin: 10px 12px; flex: 0 0 auto;
    height: 52px; padding: 0 14px; border-radius: 10px;
    border: 1px solid var(--border); background: var(--bg-surface);
    color: var(--text-primary); font-size: 14px; font-weight: 600;
  }
```

(The `.cat-tab`/`.cat-tab.active` rules are removed — no longer used once the tabs become a `<select>`.)

- [ ] **Step 2: Change `#categoryBar` from a `<div>` to a `<select>` in the markup** (currently `<div id="categoryBar"></div>`, around line 308):

```html
      <select id="categoryBar"></select>
```

- [ ] **Step 3: Replace `renderCategories()` in `public/js/pos.js`** (currently around line 94):

```js
function renderCategories() {
  const select = getEl('categoryBar');
  const tabs = [{ id: 'all', name: 'All' }, ...catalog.categories];
  select.innerHTML = tabs.map(c => `<option value="${c.id}" ${activeCategory === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  select.onchange = () => { activeCategory = select.value; renderItemGrid(); };
}
```

- [ ] **Step 4: Verify with `node --check`**

Run: `node --check public/js/pos.js`
Expected: no output.

- [ ] **Step 5: Manual verification**

Run: `npm run dev:uat`, log into a POS terminal.
1. Confirm the category tab row is replaced by a single dropdown showing "All" + every category.
2. Selecting a category filters the item grid exactly as the tabs did before.

Expected: matches the above; no console errors.

- [ ] **Step 6: Commit**

```bash
git add public/pos.html public/js/pos.js
git commit -m "feat(pos): replace category tabs with a dropdown to save vertical space"
```

---

### Task 6: KDS — no-cache headers on polling endpoints

**Files:**
- Modify: `routes/pos.js` (`GET /kds/active`, `GET /kds/finished`)
- Test: `test/kds-cache-control.test.js`

**Interfaces:**
- No response-shape change — only an added response header.

- [ ] **Step 1: Write the failing test**

```js
// test/kds-cache-control.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { jwtSecretTerminal } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, kdsId;
const SUFFIX = Date.now();

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-Cache-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const k = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `T-CacheK-${SUFFIX}`, 'KDS-Cache', hash]);
  kdsId = k.rows[0].id;
});

after(async () => {
  await pool.query(`DELETE FROM kds_terminals WHERE id = $1`, [kdsId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

function kdsToken() {
  return jwt.sign({ type: 'kds', id: kdsId, terminal_id: `T-CacheK-${SUFFIX}`, branch_id: branchId, name: 'x' }, jwtSecretTerminal);
}

test('GET /kds/active sends Cache-Control: no-store', async () => {
  const res = await fetch(`${base}/api/pos/kds/active`, { headers: { Authorization: `Bearer ${kdsToken()}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('GET /kds/finished sends Cache-Control: no-store', async () => {
  const res = await fetch(`${base}/api/pos/kds/finished`, { headers: { Authorization: `Bearer ${kdsToken()}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env ENV=UAT node --test test/kds-cache-control.test.js`
Expected: FAIL — `cache-control` header is `null` on both.

- [ ] **Step 3: Add the header to both routes in `routes/pos.js`**

In `router.get('/kds/active', ...)`, right after the `try {`:

```js
  try {
    res.set('Cache-Control', 'no-store');
```

In `router.get('/kds/finished', ...)`, same change, right after its `try {`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx cross-env ENV=UAT node --test test/kds-cache-control.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add routes/pos.js test/kds-cache-control.test.js
git commit -m "fix(kds): prevent caching of the live-board polling endpoints"
```

---

### Task 7: Backend — multi-station Ready redesign

**Files:**
- Modify: `routes/pos.js` (`PATCH /order-items/:id/kitchen-status`, `POST /orders/:id/ready`)
- Test: `test/kds-multi-station-ready.test.js`

**Interfaces:**
- `POST /orders/:id/ready` response shape changes: adds `fully_ready: boolean` alongside the existing `order`. `200` is now the response for "this station's part is done" regardless of whether other stations are still pending — the old "all items on the order" 409 case is gone (a genuine 409 on this route now only means this *station's own* items aren't actually done, which the client's button-disabled state should already prevent).
- `PATCH /order-items/:id/kitchen-status` response shape is unchanged (`{ order }`), but the order it returns may now show `status: 'ready'` immediately after the *last* pending item anywhere on the order is struck, even if nobody tapped Ready.
- Consumes: `loadKdsCategoryIds` (already defined above these routes in `routes/pos.js`).

- [ ] **Step 1: Write the failing tests**

```js
// test/kds-multi-station-ready.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { jwtSecretTerminal } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, kds1Id, kds2Id, catBbqId, catSeafoodId, itemBbqId, itemSeafoodId, orderId, orderItemBbqId, orderItemSeafoodId;
const SUFFIX = Date.now();

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-MSR-${SUFFIX}`]);
  branchId = b.rows[0].id;
  const hash = await bcrypt.hash('000000', 10);
  const k1 = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `T-MSR1-${SUFFIX}`, 'KDS-BBQ', hash]);
  const k2 = await pool.query(`INSERT INTO kds_terminals (branch_id, terminal_id, name, passcode_hash) VALUES ($1,$2,$3,$4) RETURNING id`,
    [branchId, `T-MSR2-${SUFFIX}`, 'KDS-Seafood', hash]);
  kds1Id = k1.rows[0].id;
  kds2Id = k2.rows[0].id;

  catBbqId = crypto.randomUUID();
  catSeafoodId = crypto.randomUUID();
  await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2), ($3,$4)`,
    [catBbqId, `T-BBQ-${SUFFIX}`, catSeafoodId, `T-Seafood-${SUFFIX}`]);
  await pool.query(`INSERT INTO kds_terminal_categories (kds_terminal_id, category_id, branch_id) VALUES ($1,$2,$3)`, [kds1Id, catBbqId, branchId]);
  await pool.query(`INSERT INTO kds_terminal_categories (kds_terminal_id, category_id, branch_id) VALUES ($1,$2,$3)`, [kds2Id, catSeafoodId, branchId]);

  itemBbqId = crypto.randomUUID();
  itemSeafoodId = crypto.randomUUID();
  await pool.query(`INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4), ($5,$6,$7,$8)`,
    [itemBbqId, `T-BBQItem-${SUFFIX}`, 5000, catBbqId, itemSeafoodId, `T-SFItem-${SUFFIX}`, 8000, catSeafoodId]);

  const order = await pool.query(`
    INSERT INTO pos_orders (order_number, status, dining_option, subtotal, discount, total, branch_id, created_at, updated_at, sent_to_kitchen_at)
    VALUES ($1,'sent_to_kitchen','ក្នុងហាង',13000,0,13000,$2,NOW(),NOW(),NOW()) RETURNING id
  `, [`T-MSROrd-${SUFFIX}`, branchId]);
  orderId = order.rows[0].id;

  const oi = await pool.query(`
    INSERT INTO pos_order_items (order_id, source_item_id, item_name, price, quantity, kitchen_status)
    VALUES ($1,$2,'BBQ line',5000,1,'pending'), ($1,$3,'Seafood line',8000,1,'pending')
    RETURNING id
  `, [orderId, itemBbqId, itemSeafoodId]);
  orderItemBbqId = oi.rows[0].id;
  orderItemSeafoodId = oi.rows[1].id;
});

after(async () => {
  await pool.query(`DELETE FROM pos_order_events WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_order_items WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM items WHERE id IN ($1,$2)`, [itemBbqId, itemSeafoodId]);
  await pool.query(`DELETE FROM kds_terminal_categories WHERE kds_terminal_id IN ($1,$2)`, [kds1Id, kds2Id]);
  await pool.query(`DELETE FROM categories WHERE id IN ($1,$2)`, [catBbqId, catSeafoodId]);
  await pool.query(`DELETE FROM kds_terminals WHERE id IN ($1,$2)`, [kds1Id, kds2Id]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

const kdsToken = (id, terminalId) => jwt.sign({ type: 'kds', id, terminal_id: terminalId, branch_id: branchId, name: 'x' }, jwtSecretTerminal);
const authed = (token, opts = {}) => ({ ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });

test('KDS-1 taps ready before KDS-2 finishes -- 200, fully_ready:false, order untouched', async () => {
  await fetch(`${base}/api/pos/order-items/${orderItemBbqId}/kitchen-status`, authed(kdsToken(kds1Id, `T-MSR1-${SUFFIX}`), {
    method: 'PATCH', body: JSON.stringify({ status: 'done' }),
  }));

  const res = await fetch(`${base}/api/pos/orders/${orderId}/ready`, authed(kdsToken(kds1Id, `T-MSR1-${SUFFIX}`), { method: 'POST' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.fully_ready, false);
  assert.equal(body.order.status, 'preparing');
});

test('KDS-1 cannot be blocked by KDS-2 still-pending items -- no 409', async () => {
  const orderRow = await pool.query('SELECT status FROM pos_orders WHERE id = $1', [orderId]);
  assert.notEqual(orderRow.rows[0].status, 'ready');
});

test('KDS-2 tapping ready before its own item is done still 409s (real error, not the multi-station bug)', async () => {
  const res = await fetch(`${base}/api/pos/orders/${orderId}/ready`, authed(kdsToken(kds2Id, `T-MSR2-${SUFFIX}`), { method: 'POST' }));
  assert.equal(res.status, 409);
});

test('the last item struck anywhere auto-advances the order to ready, no explicit ready tap needed', async () => {
  const res = await fetch(`${base}/api/pos/order-items/${orderItemSeafoodId}/kitchen-status`, authed(kdsToken(kds2Id, `T-MSR2-${SUFFIX}`), {
    method: 'PATCH', body: JSON.stringify({ status: 'done' }),
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.order.status, 'ready');
});

test('un-striking an item back to pending still works freely (no lock introduced)', async () => {
  const res = await fetch(`${base}/api/pos/order-items/${orderItemBbqId}/kitchen-status`, authed(kdsToken(kds1Id, `T-MSR1-${SUFFIX}`), {
    method: 'PATCH', body: JSON.stringify({ status: 'pending' }),
  }));
  assert.equal(res.status, 200);
  const item = await pool.query('SELECT kitchen_status FROM pos_order_items WHERE id = $1', [orderItemBbqId]);
  assert.equal(item.rows[0].kitchen_status, 'pending');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env ENV=UAT node --test test/kds-multi-station-ready.test.js`
Expected: FAIL — the first test's ready-tap gets a 409 (today's "all items on the order" check), not 200.

- [ ] **Step 3: Replace `PATCH /order-items/:id/kitchen-status` in `routes/pos.js`** — the block from `await client.query('UPDATE pos_order_items SET kitchen_status...')` through the `if (order.status === 'sent_to_kitchen' ...)`/`else` block:

```js
    await client.query('UPDATE pos_order_items SET kitchen_status = $1 WHERE id = $2', [status, id]);

    const now = toCambodiaTime(new Date());
    // Every item across the WHOLE order (any KDS station) done -- auto-advance
    // to ready regardless of which station struck the last one, so readiness
    // never depends on someone remembering to tap the Ready button.
    const allItemsRes = await client.query('SELECT kitchen_status FROM pos_order_items WHERE order_id = $1', [order.id]);
    const allDone = allItemsRes.rows.every(i => i.kitchen_status === 'done');

    if (allDone && order.status !== 'ready' && order.status !== 'served' && !TERMINAL.has(order.status)) {
      await client.query('UPDATE pos_orders SET status = $1, updated_at = $2 WHERE id = $3', ['ready', now, order.id]);
      await client.query(
        `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'ready',$2,$3)`,
        [order.id, req.terminal.terminal_id, now]
      );
    } else if (order.status === 'sent_to_kitchen' && status !== 'pending') {
      await client.query('UPDATE pos_orders SET status = $1, updated_at = $2 WHERE id = $3', ['preparing', now, order.id]);
    } else {
      await client.query('UPDATE pos_orders SET updated_at = $1 WHERE id = $2', [now, order.id]);
    }
```

- [ ] **Step 4: Replace `POST /orders/:id/ready` in `routes/pos.js`** — the block from the `if (!canTransition(order.status, 'ready'))` line through the final `COMMIT`/`res.json`:

```js
    if (TERMINAL.has(order.status)) throw httpError(409, `Cannot mark a ${order.status} order ready.`);
    if (order.status === 'ready' || order.status === 'served') {
      // Already fully ready -- another station's tap (or the last item
      // struck anywhere) already got there first. Idempotent no-op.
      await client.query('COMMIT');
      return res.json({ order: await fetchOrder(id), fully_ready: true });
    }

    // Only THIS station's own items must be done -- exactly what the
    // client's Ready button already checks before it's enabled. A station
    // must never be blocked by another station's still-pending items.
    const categoryIds = await loadKdsCategoryIds(req.terminal.id);
    const stationItemsRes = await client.query(`
      SELECT poi.kitchen_status
      FROM pos_order_items poi
      JOIN items i ON i.id = poi.source_item_id::uuid
      WHERE poi.order_id = $1
        AND COALESCE(i.custom_category_id, i.category_id) = ANY($2::uuid[])
    `, [id, categoryIds]);
    if (stationItemsRes.rows.some(i => i.kitchen_status !== 'done')) {
      throw httpError(409, 'Your items must be done before marking your part ready.');
    }

    const now = toCambodiaTime(new Date());
    const allItemsRes = await client.query('SELECT kitchen_status FROM pos_order_items WHERE order_id = $1', [id]);
    const fullyReady = allItemsRes.rows.every(i => i.kitchen_status === 'done');

    if (fullyReady) {
      await client.query('UPDATE pos_orders SET status = $1, updated_at = $2 WHERE id = $3', ['ready', now, id]);
      await client.query(
        `INSERT INTO pos_order_events (order_id, event, actor, created_at) VALUES ($1,'ready',$2,$3)`,
        [id, req.terminal.terminal_id, now]
      );
    }
    // else: this station's part is done, but other station(s) still have
    // pending items -- no status change, order stays visible everywhere.

    await client.query('COMMIT');
    broadcastOrdersChanged();
    res.json({ order: await fetchOrder(id), fully_ready: fullyReady });
```

(The `canTransition` import stays used elsewhere in the file — `completeOrder`, `cancel`, `served` — so don't remove the import.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx cross-env ENV=UAT node --test test/kds-multi-station-ready.test.js`
Expected: PASS (5 tests)

- [ ] **Step 6: Run the regression suite for touched files**

Run: `npx cross-env ENV=UAT node --test test/pos-orders-complete.test.js test/pos-kds-arrival.test.js`
Expected: PASS (both unaffected by this change).

- [ ] **Step 7: Commit**

```bash
git add routes/pos.js test/kds-multi-station-ready.test.js
git commit -m "fix(kds): a KDS station's Ready can no longer be blocked by another station's items"
```

---

### Task 8: Frontend — multi-station Ready response handling

**Files:**
- Modify: `public/js/kds.js` (`markReady`, plus the new `showToast` import)

**Interfaces:**
- Consumes: the `fully_ready` field added to `POST /orders/:id/ready`'s response in Task 7.

- [ ] **Step 1: Add the `showToast` import** to the top of `public/js/kds.js`, alongside the existing import block:

```js
import { showToast } from './toast.js';
```

- [ ] **Step 2: Replace `markReady`** (currently around line 251):

```js
async function markReady(orderId) {
  const res = await apiPost(`/api/pos/orders/${orderId}/ready`, {});
  if (res.ok) {
    if (res.data.fully_ready) {
      beep();
      showToast('Order ready!');
    } else {
      showToast('Your items are ready — waiting on other station(s).');
    }
    scheduleRefresh();
  } else {
    showToast(res.data.message || 'Failed to mark ready.', 'error');
  }
}
```

- [ ] **Step 3: Verify with `node --check`**

Run: `node --check public/js/kds.js`
Expected: no output.

- [ ] **Step 4: Manual verification**

Using the same two-KDS-station setup from Task 7's test (or via the admin UI): strike all of KDS-1's items, tap Ready → toast "Your items are ready — waiting on other station(s)", card stays on KDS-1's board. Strike KDS-2's last item → order auto-leaves both boards and appears in the ready strip, no explicit tap needed on KDS-2.

- [ ] **Step 5: Commit**

```bash
git add public/js/kds.js
git commit -m "feat(kds): show per-station ready feedback instead of a silent 409"
```

---

### Task 9: KDS — time label icons

**Files:**
- Modify: `public/js/kds.js` (`renderCard`, `tickElapsed`)

**Interfaces:**
- No new exports.

- [ ] **Step 1: Update the arrival/elapsed spans in `renderCard`** (currently around line 182–187):

```js
  head.innerHTML = `
    <span class="oc-number">${order.order_number}</span>
    <span class="oc-badge">${badgeText(order)}</span>
    <span class="oc-arrived">🕐 ${formatClock(order.sent_to_kitchen_at || order.created_at)}</span>
    <span class="oc-elapsed">⏱ 0:00</span>
  `;
```

- [ ] **Step 2: Update `tickElapsed`'s label text** (currently `label.textContent = formatElapsed(elapsedMs);`, around line 227):

```js
    if (label) label.textContent = '⏱ ' + formatElapsed(elapsedMs);
```

- [ ] **Step 3: Verify with `node --check`**

Run: `node --check public/js/kds.js`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add public/js/kds.js
git commit -m "feat(kds): add icon labels to the arrival and elapsed time displays"
```

---

### Task 10: KDS — optimistic strike + error toasts

**Files:**
- Modify: `public/js/kds.js` (`cycleItemStatus`, `markServed`)

**Interfaces:**
- No new exports. `showToast` already imported by Task 8 (this task must run after Task 8, or add the import itself if run standalone — check the top of the file first).

- [ ] **Step 1: Replace `cycleItemStatus`** (currently around line 245):

```js
async function cycleItemStatus(itemId, currentStatus) {
  const next = NEXT_STATUS[currentStatus] || 'pending';
  // Optimistic: update locally and re-render immediately so the tap feels
  // instant, rather than waiting on a full network round trip.
  for (const order of orders) {
    const item = order.items.find(i => i.id === itemId);
    if (item) { item.kitchen_status = next; break; }
  }
  render();

  const res = await apiPatch(`/api/pos/order-items/${itemId}/kitchen-status`, { status: next });
  if (!res.ok) {
    showToast(res.data.message || 'Failed to update item.', 'error');
    refresh(); // reconcile with server truth -- the optimistic update above was wrong
    return;
  }
  scheduleRefresh();
}
```

- [ ] **Step 2: Replace `markServed`** (currently around line 259):

```js
async function markServed(orderId) {
  const res = await apiPost(`/api/pos/orders/${orderId}/served`, {});
  if (res.ok) scheduleRefresh();
  else showToast(res.data.message || 'Failed to mark served.', 'error');
}
```

- [ ] **Step 3: Verify with `node --check`**

Run: `node --check public/js/kds.js`
Expected: no output.

- [ ] **Step 4: Manual verification**

Tap an item on a live KDS board — it should strike through immediately, before any network delay is perceptible. Simulate a failure (e.g. disconnect network briefly) and confirm a red error toast appears and the item reverts.

- [ ] **Step 5: Commit**

```bash
git add public/js/kds.js
git commit -m "feat(kds): optimistic item-status updates + error feedback on failed actions"
```

---

### Task 11: KDS — SSE reconnect after connection reset

**Files:**
- Modify: `public/js/kds.js` (`connectStream`)

**Interfaces:**
- No new exports.

- [ ] **Step 1: Replace `connectStream`** (currently around line 266):

```js
function connectStream() {
  const token = getTerminalToken();
  const es = new EventSource(`/api/pos/kds/stream?token=${encodeURIComponent(token)}`);
  es.onopen = () => setConnDot(true);
  es.onerror = () => {
    setConnDot(false);
    // The browser's default auto-reconnect isn't reliable behind every
    // proxy after a hard connection reset -- explicitly reconnect once the
    // connection is confirmed closed rather than trusting it silently.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      setTimeout(() => { if (stream === es) connectStream(); }, 3000);
    }
  };
  es.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.type === 'orders_changed') scheduleRefresh();
    } catch { /* ignore keep-alive comments */ }
  };
  stream = es;
  return es;
}
```

- [ ] **Step 2: Verify with `node --check`**

Run: `node --check public/js/kds.js`
Expected: no output.

- [ ] **Step 3: Manual verification**

With a KDS board open, stop and restart the dev server (or briefly block the `/kds/stream` request in devtools) — confirm the connection dot goes red, then green again within a few seconds without a manual page refresh.

- [ ] **Step 4: Commit**

```bash
git add public/js/kds.js
git commit -m "fix(kds): actively reconnect the live stream after a connection reset"
```

---

### Task 12: Dashboard — Live Orders item detail + creating POS

**Files:**
- Modify: `routes/receipts.js` (`GET /own/live`)
- Modify: `public/js/pages/receipts.js` (`loadLiveOrders`)
- Test: `test/receipts-own-live-items.test.js`

**Interfaces:**
- `GET /api/receipts/own/live` response gains an `items` array per order: `[{item_name, qty, unit_price, total_price}]`. `terminal_name` (already present) is unchanged.

- [ ] **Step 1: Write the failing test**

```js
// test/receipts-own-live-items.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { jwtSecret } = require('../config');
const app = require('../app');
const pool = require('../db');

let server, base, branchId, catId, itemId, orderId;
const SUFFIX = Date.now();
const adminToken = jwt.sign({ id: 1, username: 't-admin', role: 'admin' }, jwtSecret);

before(async () => {
  server = app.listen(0);
  await new Promise(r => server.on('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const b = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [`T-LiveIt-${SUFFIX}`]);
  branchId = b.rows[0].id;
  catId = crypto.randomUUID();
  itemId = crypto.randomUUID();
  await pool.query(`INSERT INTO categories (id, name) VALUES ($1,$2)`, [catId, `T-LiveCat-${SUFFIX}`]);
  await pool.query(`INSERT INTO items (id, name, price, category_id) VALUES ($1,$2,$3,$4)`, [itemId, `T-LiveItem-${SUFFIX}`, 6000, catId]);

  const order = await pool.query(`
    INSERT INTO pos_orders (order_number, status, dining_option, subtotal, discount, total, branch_id, created_at, updated_at)
    VALUES ($1,'preparing','ក្នុងហាង',6000,0,6000,$2,NOW(),NOW()) RETURNING id
  `, [`T-LiveOrd-${SUFFIX}`, branchId]);
  orderId = order.rows[0].id;
  await pool.query(`
    INSERT INTO pos_order_items (order_id, source_item_id, item_name, price, quantity)
    VALUES ($1,$2,'T-LiveLine',6000,1)
  `, [orderId, itemId]);
});

after(async () => {
  await pool.query(`DELETE FROM pos_order_items WHERE order_id = $1`, [orderId]);
  await pool.query(`DELETE FROM pos_orders WHERE id = $1`, [orderId]);
  await pool.query(`DELETE FROM items WHERE id = $1`, [itemId]);
  await pool.query(`DELETE FROM categories WHERE id = $1`, [catId]);
  await pool.query(`DELETE FROM branches WHERE id = $1`, [branchId]);
  server.close();
  await pool.end();
});

test('own/live now includes each order\'s item lines', async () => {
  const res = await fetch(`${base}/api/receipts/own/live`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  const found = body.orders.find(o => o.id === orderId);
  assert.ok(found);
  assert.ok(Array.isArray(found.items));
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].item_name, 'T-LiveLine');
  assert.equal(found.items[0].qty, 1);
  assert.equal(Number(found.items[0].total_price), 6000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx cross-env ENV=UAT node --test test/receipts-own-live-items.test.js`
Expected: FAIL — `found.items` is `undefined`.

- [ ] **Step 3: Update the SELECT in `GET /own/live`** (`routes/receipts.js`, currently around line 179):

```js
router.get('/own/live', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT po.id, po.order_number, po.name, po.status, po.dining_option, po.table_number,
             po.total, po.created_at, po.updated_at,
             b.name AS branch_name, COALESCE(pt.name, pt.terminal_id) AS terminal_name,
             (SELECT jsonb_agg(jsonb_build_object('item_name',poi.item_name,'qty',poi.quantity,'unit_price',poi.price,'total_price',poi.price * poi.quantity))
              FROM pos_order_items poi WHERE poi.order_id = po.id) AS items
      FROM pos_orders po
      LEFT JOIN branches b ON b.id = po.branch_id
      LEFT JOIN pos_terminals pt ON pt.id = po.terminal_id
      WHERE po.status NOT IN ('paid','cancelled')
      ORDER BY po.created_at ASC
    `);
    res.json({ orders: rows });
  } catch (err) {
    console.error('Own live orders GET error:', err);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx cross-env ENV=UAT node --test test/receipts-own-live-items.test.js`
Expected: PASS (1 test)

- [ ] **Step 5: Make each live-order row expandable in `public/js/pages/receipts.js`**

Replace `loadLiveOrders()` (currently around line 418):

```js
let expandedLiveOrderId = null;

async function loadLiveOrders() {
  const data = await fetchJSON('/api/receipts/own/live');
  const list = getEl('liveOrdersList');
  const count = getEl('liveOrdersCount');
  if (!data) return;
  const orders = data.orders || [];
  if (count) count.textContent = `${orders.length} active`;
  if (!list) return;
  if (!orders.length) {
    list.innerHTML = `<div class="empty-state">No live orders right now.</div>`;
    return;
  }
  list.innerHTML = orders.map(o => {
    const items = Array.isArray(o.items) ? o.items : [];
    const expanded = expandedLiveOrderId === o.id;
    const itemsHtml = expanded ? `
      <div class="live-order-items">
        ${items.map(it => `<div class="detail-item-row"><span>${it.qty} × ${esc(it.item_name)}</span><span>${fmtKHR(it.total_price)}</span></div>`).join('') || '<div class="detail-item-row">No items</div>'}
      </div>` : '';
    return `
      <div class="detail-item-row live-order-row" data-live-order-id="${o.id}" style="cursor:pointer;">
        <div>
          <div class="detail-item-name">${esc(o.branch_name) || '—'} · ${esc(o.order_number)}${o.name ? ' · ' + esc(o.name) : ''}</div>
          <div class="detail-item-qty">${esc((o.status || '').replace(/_/g, ' '))} · ${elapsedLabel(o.created_at)} · by ${esc(o.terminal_name) || '—'}</div>
        </div>
        <div class="detail-item-price">${fmtKHR(o.total)}</div>
      </div>
      ${itemsHtml}
    `;
  }).join('');
  list.querySelectorAll('[data-live-order-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = parseInt(el.dataset.liveOrderId, 10);
      expandedLiveOrderId = expandedLiveOrderId === id ? null : id;
      loadLiveOrders();
    });
  });
}
```

- [ ] **Step 6: Verify with `node --check`**

Run: `node --check public/js/pages/receipts.js`
Expected: no output.

- [ ] **Step 7: Manual verification**

On the dashboard's Receipts page, Own tab: confirm the Live Orders section shows branch/order/creator as before, and clicking a row expands to show its item list (name × qty, price), clicking again collapses it.

- [ ] **Step 8: Commit**

```bash
git add routes/receipts.js public/js/pages/receipts.js test/receipts-own-live-items.test.js
git commit -m "feat(receipts): show item detail on expand for Live Orders"
```

---

## Closing notes

Once all 12 tasks are merged, re-run the exact repro steps from the original feedback as a final live walkthrough:
1. Split an order's items across two KDS stations (matching the acceptance scenario from the prior plan) — confirm neither station ever hits a 409 from its own Ready tap, and the order only fully leaves both boards once both stations are done.
2. On POS, load an order that's already at the kitchen, tap Cancel — confirm the dialog appears reliably, including immediately after switching orders.
3. Edit the quantity of a not-yet-struck item on a sent order from POS; confirm a kitchen-struck item shows no editing controls.
4. Watch a KDS card's elapsed timer for at least 2 minutes continuous wall-clock time and confirm it only ever counts up, never down (Task 6's `Cache-Control` fix is the concrete change here — if it still misbehaves, this needs a fresh live-reproduction investigation, not another guess from static code).
