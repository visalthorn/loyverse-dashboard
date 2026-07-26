# POS/KDS Usability Fixes & UI Improvements — Design

**Status:** Approved by user 2026-07-26, ready for implementation planning.

## Context

This is a follow-up round to the POS/KDS revision plan (`2026-07-26-pos-kds-revision.md`, merged the same day). It addresses real-world feedback from live testing: a mix of UI space/discoverability improvements, a genuine multi-station Kitchen Display bug that was explicitly deferred in the prior plan (and is now confirmed happening), and several smaller correctness bugs found by tracing the code with the user during brainstorming.

No new tables are needed for any item in this design. The KDS multi-station fix (the largest item) is deliberately designed to avoid new schema by relying entirely on the existing `pos_order_items.kitchen_status` column as the single source of truth for readiness.

---

## POS

### P1 — Collapsible nav

**Problem:** `#topStrip` in `public/pos.html` permanently shows Switch Terminal, Settings, Receipts, and the terminal name tag as separate always-visible buttons, competing for space with the open-orders strip and New Order button (the two things actually used constantly).

**Design:** Replace the three occasional-use buttons (`#switchTerminalBtn`, `#settingsBtn`, `#receiptsBtn`) and the dynamically-inserted terminal name tag with a single collapsed hamburger-style menu button. Tapping it opens a small dropdown/panel containing: terminal name (display only), Switch Terminal, Settings, Receipts — each triggering the exact same existing `window.pos*` handlers already wired (`posSwitchTerminal`, `posOpenSettings`, `posOpenReceipts`). Collapsed by default; no change to any handler logic, only to how they're reached. Brand, open-orders strip, and New Order stay exactly where they are today.

### P2 — Category selector as dropdown

**Problem:** `#categoryBar` renders one horizontally-scrolling tab button per category, consuming a full row above the item grid.

**Design:** Replace the tab row with a single `<select id="categorySelect">` (option list: "All" + each category, matching today's `renderCategories()` data). `renderItemGrid()`'s filtering logic (`activeCategory`) is unchanged — only the input mechanism changes from tab-click to select-change.

### P3 — Edit quantity / remove items already sent to the kitchen, locked once kitchen-struck

**Problem:** Today, once an order is sent to the kitchen, its items (`currentOrder.items`, rendered as `.cart-line.sent`) are permanently read-only in the POS cart — no quantity change, no removal. The only way to change a sent order is to append more lines via the existing `/orders/:id/items` endpoint.

**Design:**

- **New backend endpoints** in `routes/pos.js`, both `requireTerminalAuth(['pos'])`, branch-scoped the same way every other order-mutating route in this file already is (`order.branch_id !== req.terminal.branch_id` → 404):
  - `PATCH /order-items/:id` — body `{ quantity }`. Locks (`SELECT ... FOR UPDATE`) the item and its parent order. Rejects with 409 if `item.kitchen_status === 'done'` ("This item has already been prepared and can't be changed.") or if `TERMINAL.has(order.status)` (paid/cancelled). Otherwise updates `quantity`, recomputes `order.subtotal`/`order.total` the same way `/orders/:id/items` already does, returns the refreshed order.
  - `DELETE /order-items/:id` — same locks and same two rejection cases, plus refuses to delete the last remaining item on an order (an order needs at least one item; if it's the only line, the cashier should cancel the whole order instead). Deletes the row, recomputes totals, returns the refreshed order.
- **Frontend** (`public/js/pos.js` `renderCart()`): persisted (`.cart-line.sent`) items with `kitchen_status !== 'done'` get the same qty-stepper + remove-button treatment already used for pending cart lines; items with `kitchen_status === 'done'` keep today's flat, uncontrolled rendering. New handlers call the two endpoints above via the existing `mutate()` offline-queue wrapper — matching how every other order mutation in this file already goes through it — and refresh `currentOrder`/`renderCart()` on success. Editing controls stay hidden for a still-offline-queued (`_queued`) order, since there's no real item id to target yet, consistent with how `onDiningOptionSelect`/`onOrderName` already handle that case.

### P4 — Cancel-order silent-failure bug

**Root cause, confirmed by code trace:** `public/js/dialog.js`'s `openDialog()` reuses a single module-level `<dialog>` element (`dlg`) for every `showConfirm`/`showAlert` call app-wide. Calling `d.showModal()` while that same element is already open throws `InvalidStateError` synchronously inside the `Promise` executor, which makes `openDialog()` return a **rejected** promise. `cancelOrder()` (`await showConfirm(...)`) has no try/catch around that await, so the rejection becomes an unhandled promise rejection in the browser — a tap that visibly does nothing, no toast, no dialog, no console-visible-to-the-cashier error. This matches the reported symptom exactly, including why it "worked" immediately after switching to a different terminal (fresh page load → fresh `dlg` singleton, nothing stale to collide with).

**Fix:**
- `dialog.js`'s `openDialog()`: before calling `showModal()`, check `d.open` — if the dialog is already open, force-close it first (`d.close('')`) so the stale instance can't collide with the new call.
- `public/js/pos.js`: add a simple loading guard (e.g. a module-level `let orderLoading = false` set around `loadOrderIntoPanel`'s fetch) and make `cancelOrder()` (and any other action tied to `currentOrder`) bail with a toast if a load is still in flight, rather than silently no-op on a stale/null `currentOrder`.

---

## KDS

### K1 — Time labels

Add a small icon prefix to each value in the card header so it's unambiguous at a glance: 🕐 before the arrival clock (`oc-arrived`), ⏱ before the elapsed counter (`oc-elapsed`). No layout change — same two spans, same position.

### K2 — Optimistic strike (perceived ~1s lag)

**Root cause:** `cycleItemStatus()` PATCHes the server, then waits for `scheduleRefresh()` (120ms debounce) → `refresh()` (full `GET /kds/active` round-trip) → full board re-render before the tapped item visually changes. No local state update happens before that.

**Fix:** On tap, immediately mutate the matching item's `kitchen_status` in the local `orders` array and call `render()` synchronously (before awaiting the PATCH). Let the network response — or the subsequent scheduled refresh — reconcile with server truth; on a failed PATCH, revert the local mutation and show an error toast (see K6).

### K3 — SSE reconnect after connection reset

**Problem:** `es.onerror` only dims the connection indicator; it relies entirely on the browser's default `EventSource` auto-reconnect. Confirmed live: a hard connection reset (`ERR_CONNECTION_RESET`) left the board frozen on a stable (non-restarting) server, meaning the default reconnect didn't recover it.

**Fix:** In `es.onerror`, check `es.readyState === EventSource.CLOSED` — if so, explicitly schedule a manual `connectStream()` retry after a short delay (e.g. 3s) instead of trusting the browser's default behavior alone. Keep the existing `online` event listener's immediate-reconnect-on-network-restore behavior as-is.

### K4 — Multi-station Ready (the 409, and the "finished item just disappeared" report — same root cause)

**Confirmed root cause:** `POST /orders/:id/ready` requires every item on the *entire order* to be `kitchen_status='done'`, regardless of which KDS station owns them. The client's Ready button is only enabled once *this station's own* filtered items are done (since `/kds/active` already returns per-station-filtered items). When an order spans two stations, the first station to finish gets a 409 from a button that looked ready to tap — and today there's no error feedback (K6), so it looks like nothing happened. The order never reaches `ready`/`served`, so it correctly never appears in the Finished view either — it's stuck at `preparing` indefinitely.

**Design — no new table, `kitchen_status` stays the single source of truth:**

- `POST /orders/:id/ready` (`routes/pos.js`): change the completeness check from "every item on the order" to "every item belonging to *this calling station's* assigned categories" (reuse the same category-join query `attachFilteredItems`/`loadKdsCategoryIds` already use). This is the check that should now always pass when tapped, since it's exactly what the client already uses to enable the button.
  - After confirming this station's own items are done, additionally check whether **every item on the whole order** (any station) is now done.
    - If yes: transition `status` to `'ready'` as today (broadcast, response unchanged in shape).
    - If no (other station(s) still have pending items): respond `200` (not 409) with `{ order, fully_ready: false }` — no status transition, order stays exactly where it is (still visible on every station's active board, including this one).
- `PATCH /order-items/:id/kitchen-status` (`routes/pos.js`): after applying the status change, additionally check "are all items on this order now done" — if so (and the order isn't already past `preparing` in the state machine), auto-transition to `'ready'` right there. This covers the case where the *last* pending item anywhere on the order gets struck without that station ever explicitly tapping the Ready button — readiness becomes correct regardless of tap order across stations.
- Client (`public/js/kds.js` `markReady()`): read the new `fully_ready` flag. `true` → beep + today's success toast, order leaves the active board via the next refresh (unchanged). `false` → a plain informational toast ("Your items are ready — waiting on other station(s)."), no beep, order stays visible with its own items already shown struck-through.

### K5 — Un-strike after Ready

Falls out of K4 with no extra code: since nothing is ever locked or removed from a station's board as a side effect of *that station's own* items being done (the order only leaves any board once **every** station is actually done, via K4's real completeness check), tapping a done item to cycle it back to `pending` continues to work exactly as it already does today (`NEXT_STATUS.done === 'pending'`), at any point before the order is genuinely served.

### K6 — Silent failure feedback

`markReady`, `markServed`, and `cycleItemStatus` currently do nothing visible when the underlying request fails (`if (res.ok) {...}`, no `else`). Add an error toast (reusing the existing `toast.js`, already used elsewhere in this app) on the failure path of all three.

### K7 — No-cache headers on KDS polling endpoints

**Investigated, not fully confirmed:** the reported "counts down instead of up" symptom couldn't be reproduced from the elapsed-time math itself (the UTC⇄Cambodia-local offset trick in `parseNaive`/`nowMs` cancels correctly on paper). One concrete, cheap, and correct-regardless-of-root-cause fix: `GET /api/pos/kds/active` and `GET /api/pos/kds/finished` set no `Cache-Control` header today (unlike `/kds/stream`, which already sends `no-cache`). Add `Cache-Control: no-store` to both, so a proxy or browser can never serve a stale cached response for a "live" polling endpoint. **This item needs live verification after implementation** — watch a real KDS board across several minutes and confirm the counter only ever increases. If it still misbehaves after this fix, that's a signal the root cause is elsewhere and needs a fresh investigation with live reproduction.

---

## Dashboard

### D1 — Live Orders: item detail + creating POS

`GET /api/receipts/own/live` (`routes/receipts.js`) already selects `terminal_name` (which POS/terminal created the order) but it isn't prominently shown, and item lines aren't fetched at all.

**Design:** Add an items array to the endpoint's response (join `pos_order_items` the same way the terminal-facing routes already do). In `public/js/pages/receipts.js`'s `loadLiveOrders()`, make each row expandable — click to reveal its item list (name/qty) inline — and keep the terminal name visible as it already is in the subtitle line.

---

## Testing

- **Backend, automated (`node --test`):** new `PATCH`/`DELETE /order-items/:id` endpoints (branch scoping, kitchen_status='done' lock, terminal-state lock, total recomputation, last-item-can't-be-deleted rule); K4's two-station scenario (station A taps ready early → 200 `fully_ready:false`, order still visible/actionable on both boards; station B's last item struck → order auto-transitions to `ready`); K7's `Cache-Control` header presence.
- **Frontend:** no automated test harness in this repo (established convention from the prior plan) — `node --check` for syntax, plus a live walkthrough on the actual POS/KDS pages before calling this done, specifically re-testing the original acceptance scenario (order split across two KDS stations) and the cancel-order repro steps the user described.
