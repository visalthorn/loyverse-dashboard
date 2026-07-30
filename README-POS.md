# In-house POS — Cashier, Kitchen Display, Printing

Runs on top of the existing dashboard app (same server, same Postgres pool)
but authenticates independently — `/pos` and `/kds` are shop-floor devices,
not dashboard users. It never touches Loyverse-synced tables — all POS writes
go into `pos_*` tables so a Loyverse sync can never collide with or overwrite
a POS order.

## Auth model — device token + session JWT, not dashboard users

`/pos` and `/kds` no longer reuse the dashboard's user login. Each physical
device (or browser tab acting as one) logs in as a **terminal**: a short code
(e.g. `PP-POS-01`) + a 4–6 digit PIN, entered on a numeric pad — no username,
no dashboard account. Once logged in, the device stays logged in indefinitely
(sliding 90-day expiry) without staff ever re-entering the PIN, until someone
explicitly logs out, revokes the device from the dashboard, or 90 days pass
with the tablet never coming back online.

Two artifacts replace what used to be a single flat terminal JWT:

- **Device token** — opaque 256-bit random value, issued once at PIN login,
  stored in `terminal_devices` as a sha256 hash (never the raw value), sliding
  90-day expiry extended on every silent refresh, revocable per-device from
  the dashboard. Travels as the httpOnly `cm_device` cookie, scoped to `/api`.
- **Session token** — a short-lived (12h) JWT, silently re-minted from the
  device token by `POST /api/terminal/session/refresh` before the app ever
  renders. Staff never see this happen. Travels as the httpOnly `cm_session`
  cookie, scoped to the whole app.

Both cookies are same-origin (Express serves the API and the static pages),
so there is no CORS involved. A third, **non-**httpOnly cookie `cm_csrf`
pairs with an `X-CSRF-Token` header on every state-changing request
(double-submit CSRF check, `middleware/terminalCsrf.js`) — plain header-based
`Authorization: Bearer` auth is gone for terminals, and so is any
`localStorage` token.

- `pos_terminals` / `kds_terminals` (`migrations/011_terminal_auth.sql`, plus
  `failed_attempts`/`locked_until` added in `migrations/020_terminal_devices.sql`)
  hold `terminal_id` (unique code), a bcrypt `passcode_hash`, `branch_id`, and
  `is_active`. `kds_terminal_categories` maps a KDS station to the categories
  it should display (empty = unconfigured, shows a "no categories assigned"
  message rather than everything).
- `terminal_devices` (`migrations/020_terminal_devices.sql`) is the device
  token table described above — one row per logged-in physical device,
  independent of the terminal_id/PIN it logged in with.
- `POST /api/terminal/login` (`routes/terminalAuth.js`) checks the passcode
  (bcrypt), and on success mints both cookies plus `cm_csrf`, using
  **`JWT_SECRET_TERMINAL`** for the session JWT — a secret completely
  separate from the dashboard's `JWT_SECRET*`, so a leaked terminal session
  can never be replayed against dashboard routes (`/api/kpis`, etc.) and a
  dashboard token can never reach `/api/pos/*`. 5 wrong PINs in a row locks
  the terminal for 15 minutes (`locked_until`), clearable from the dashboard.
- `requireTerminalAuth` (`middleware/terminalAuth.js`) reads `cm_session`,
  verifies the JWT, then re-checks **both** the terminal's `is_active` and
  the `terminal_devices` row's `revoked_at`/`expires_at` against the DB on
  every single request — deactivating a terminal, or revoking one device,
  takes effect on the device's very next API call, not at next token expiry.
- Frontend: `public/js/terminalAuth.js` no longer stores any token. It keeps
  only display metadata (`terminal_info` — name/branch, not a credential) and
  the remembered terminal code (`device_terminal_id`) so staff only re-enter
  the PIN once per device, never daily. Every terminal API call goes through
  a shared wrapper that attaches the CSRF header and, on a 401, tries one
  silent `/session/refresh` before falling back to the PIN screen — with a
  shared in-flight promise so several simultaneous 401s only trigger one
  refresh call, not a stampede.
- Every `pos_orders` row now carries `terminal_id`/`branch_id` derived
  **server-side** from the caller's session — never trusted from the
  client. `GET /orders`, `/kds/active`, and every single-order action are
  scoped to the calling terminal's own branch.
- Branch/terminal management (create terminal, reset passcode, activate/
  deactivate, assign KDS categories, list/revoke logged-in devices, unlock a
  locked-out terminal) lives on `/branches.html`, gated by the existing
  dashboard admin login (`requireAuth` + `requireRole('admin')`) — that
  page's auth is unchanged.

## Architecture

```
                 ┌──────────────────────────┐
                 │   Browser: /pos           │  cashier order-taking
                 │   (public/pos.html+js)    │  + offline queue + printing
                 └───────────┬───────────────┘
                             │ REST (cm_session cookie)  ┌─────────────────────┐
                 ┌───────────▼───────────────┐   SSE     │  Browser: /kds       │
                 │   Express: routes/pos.js  │◄──────────┤  (public/kds.html+js)│
                 │   /api/pos/*              │  push     │  kitchen tablet/TV   │
                 └───────────┬───────────────┘           └─────────────────────┘
                             │
                 ┌───────────▼───────────────┐
                 │   PostgreSQL (db.js pool) │
                 │   pos_orders              │
                 │   pos_order_items         │
                 │   pos_order_events        │
                 │   pos_terminals           │
                 │   kds_terminals           │
                 │   kds_terminal_categories │
                 └────────────────────────────┘

  Optional, separate process — only if silent thermal printing is wanted:

   public/pos.html  ──POST /print──►  print-bridge/server.js (:9977)
                                          │  raw ESC/POS bytes over TCP
                                          ▼
                                   Thermal printer (PRINTER_IP:9100)
```

`items`, `categories`, `receipts`, `receipt_items`, `receipt_payments`,
`pos_devices` are read-only from the POS's point of view — the nightly
Loyverse sync owns them.

## Routes (`/api/pos/*`)

| Method | Path                                  | Auth | Purpose |
|--------|---------------------------------------|------|---------|
| GET    | `/catalog`                            | `requireTerminalAuth(['pos'])` | Categories + sellable items (60s cache) |
| GET    | `/catalog/version`                    | pos  | Cheap fingerprint for hot-reload polling |
| GET    | `/config`                             | pos  | Dining options (discovered from `receipts`) + payment methods |
| GET    | `/orders?status=`                     | pos  | List orders for the caller's own branch (`active` = not paid/cancelled) |
| GET    | `/orders/:id`                         | pos  | One order + its items (404 if it belongs to another branch) |
| POST   | `/orders`                             | pos  | Create order, status → `sent_to_kitchen`; `branch_id`/`terminal_id` derived from the token |
| POST   | `/orders/:id/items`                   | pos  | Append items to an existing order |
| POST   | `/orders/:id/pay`                     | pos  | Pay (cash or khqr) |
| POST   | `/orders/:id/cancel`                  | pos  | Cancel |
| GET    | `/kds/active`                         | `requireTerminalAuth(['kds'])` | Orders in caller's branch, filtered to this KDS station's assigned categories |
| GET    | `/kds/stream`                         | kds, via `cm_session` cookie (EventSource sends cookies automatically with `withCredentials: true`, no token in the URL) | SSE push |
| PATCH  | `/order-items/:id/kitchen-status`     | kds  | Cycle an item `pending → preparing → done` |
| POST   | `/orders/:id/ready`                   | kds  | Caller's own station's items must be `done`; order transitions to `ready` once every station's items are done (auto-advances on the last item struck, no tap required) |
| POST   | `/orders/:id/served`                  | kds  | Order picked up / delivered |
| GET    | `/health`                             | none | `{ db, uptime }` liveness probe |
| POST   | `/api/terminal/login`                 | none, rate-limited 5/2min per `terminal_id` | Terminal PIN login, sets `cm_device`/`cm_session`/`cm_csrf` cookies (no token in the response body) |
| POST   | `/api/terminal/session/refresh`       | `cm_device` cookie | Silently re-mints `cm_session` (called on every app boot, before rendering) |
| POST   | `/api/terminal/unlock`                | `cm_session` + CSRF | Dismisses the idle-lock overlay by re-checking the PIN; does not touch the device token |
| POST   | `/api/terminal/logout`                | CSRF | Explicit sign-out — revokes the device token and clears all three cookies |

Order status lifecycle: `open → sent_to_kitchen → preparing → ready → served →
paid | cancelled`. PAY and CANCEL are allowed from any non-terminal status —
kitchen progress never blocks checkout (mirrors Loyverse). See
`services/pos/stateMachine.js`.

## Printing

Two independent modes, chosen per-terminal by whether a print-bridge URL is
saved (⚙ button on `/pos` → Printer Settings → `localStorage['pos_print_bridge_url']`):

- **Mode A — browser printing** (default, zero setup): `public/js/print.js`
  opens a hidden iframe sized for an 80mm roll and calls `window.print()`.
  Works immediately, requires a print dialog per receipt/ticket.
- **Mode B — LAN bridge (silent)**: point the setting at a small always-on
  Node process running near the printer:
  ```bash
  cd print-bridge
  npm install
  cp .env.example .env    # set PRINTER_IP to the thermal printer's LAN IP
  npm start                # listens on :9977
  ```
  The POS page then `POST`s `{type, order}` to `<bridge-url>/print`, which
  turns it into raw ESC/POS bytes and streams them over TCP to
  `PRINTER_IP:9100`. Khmer text is transliterated to Latin first (see the
  comment block in `print-bridge/escpos.js`) — thermal codepages have no
  Khmer glyphs, so this is a best-effort romanization, not exact.

**Printing never blocks an order.** If a print call fails (bridge
unreachable, printer off), the app toasts an error and the order still
proceeds — reprint from the 🖨 button on an order chip (kitchen ticket) or the
pay-success screen (receipt).

## Offline behavior

- The catalog is cached in `localStorage` on every successful load, so the
  item grid still renders instantly if `/api/pos/catalog` is unreachable.
- Every order mutation (create/append/pay/cancel) goes through a 5-second
  timeout. On a network failure (not a real server rejection — those still
  show a normal error) it's queued in `localStorage['pos_offline_queue']` as
  `{url, method, body, localId, ts}` and retried automatically every 15s (and
  immediately on the browser's `online` event).
- A new order created while offline gets a temporary `LOCAL-####` number and
  is fully usable (cart, kitchen ticket print) — it just can't be paid or
  cancelled until its create call reconciles with the server and gets a real
  order number. An amber "⚠ Offline — N queued" banner shows the queue depth
  the whole time.
- KDS shows a connection dot (green = SSE connected, red = not) and
  reconnects automatically, both via the browser's native EventSource retry
  and immediately on the `online` event.

## Loyverse is down — staff runbook

If Loyverse itself is unreachable (their outage, not ours), the shop keeps
running entirely on this in-house POS:

1. **Keep using `/pos` and `/kds` as normal** — they never call Loyverse.
   Orders, kitchen tickets, and payments all keep working.
2. **Ignore any Loyverse-branded errors** on other dashboard pages (Sync,
   Items) — those only affect historical reporting, not today's service.
3. **Do not run "Sync Now"** on the Sync page until Loyverse is back —
   syncing while their API is flaky can produce a partial pull.
4. **If item prices or the menu need to change** and Loyverse is down, ask an
   admin to edit them directly on the Items page (`custom_name`/price
   override) — the POS catalog reads from there, not from Loyverse live.
5. **Once Loyverse is back**, run a normal receipts + items sync from the
   Sync page. Nothing about the POS's own orders needs to be redone — Phase 7
   folds them into reporting separately.

## Final manual test checklist

Run through this after any change that touches `routes/pos.js`,
`public/js/pos.js`, or `public/js/kds.js`:

- [ ] **Full order lifecycle**: create → append items → pay (cash, verify
      change) → confirm a back-office item price change does **not** alter
      an already-created order's line price.
- [ ] **Illegal transitions rejected**: pay a cancelled order (409), add
      items to a paid order (409), unknown payment method (400),
      insufficient cash (400).
- [ ] **KDS realtime**: open `/pos` and `/kds` side by side; sending an order
      shows it on KDS in well under a second; cycling items to `done`
      enables the READY button; tapping it drops the card into the Ready
      strip and plays a beep; tapping a ready chip marks it served.
- [ ] **Both print modes**: with no bridge URL set, Send/Pay opens the
      browser print dialog for a correctly-formatted 80mm layout; with a
      bridge URL set (`print-bridge` running locally), the same actions POST
      to the bridge instead and the printer (or a fake TCP listener) receives
      valid ESC/POS bytes.
- [ ] **Offline create + reconnect recovery**: with dev tools network set to
      offline, create an order — it should get a `LOCAL-####` number, show
      the amber offline banner, and still let you print a kitchen ticket. Go
      back online and confirm it reconciles to a real `POS-YYMMDD-####`
      number automatically (within 15s, or immediately on the `online`
      event) and the banner clears.
- [ ] **Catalog hot-reload**: edit an item's price/name on the Items page
      while `/pos` is open elsewhere; within 5 minutes (or immediately after
      an `?refresh=1`) the grid picks up the change without a manual reload.
- [ ] **Rate limiting**: 6 rapid bad logins from the same IP → the 6th
      returns 429.
- [ ] **Health check**: `GET /api/pos/health` returns `{db:"ok", uptime}`

Run through this after any change that touches terminal auth
(`middleware/terminalAuth.js`, `middleware/terminalCsrf.js`,
`routes/terminalAuth.js`, `routes/terminals.js`, `public/js/terminalAuth.js`):

- [ ] **Cross-auth guardrails**: a dashboard user JWT gets 401 on any
      `/api/pos/*` route; a terminal session cookie gets 401 on any
      dashboard-only route (e.g. `/api/kpis`); a POS-type session gets 401 on
      a KDS-only route and vice versa.
- [ ] **Wrong PIN**: generic "Invalid terminal ID or passcode" — never
      reveals whether the terminal ID or the PIN was the wrong part. 5 wrong
      attempts (at login or at the idle-lock unlock screen) locks the
      terminal 15 minutes.
- [ ] **Immediate revocation**: revoke a device (or deactivate a terminal) on
      `/branches.html` while it's logged in elsewhere — its very next API
      call 401s, it does not wait for the 12h session expiry.
- [ ] **Silent boot refresh**: close the browser entirely and reopen `/pos` or
      `/kds` — lands straight in the app with no login prompt, as long as the
      device hasn't been revoked/expired/deactivated.
- [ ] **CSRF**: a state-changing request with a missing or mismatched
      `X-CSRF-Token` header gets 403, even with a valid session cookie.
- [ ] **Branch isolation**: two terminals on different branches — a cashier
      never sees the other branch's open orders, and can't pay/cancel an
      order id belonging to another branch even if guessed directly.
- [ ] **KDS category filtering**: a KDS terminal with zero categories
      assigned shows the "ask a manager to configure this station" message;
      assigning categories makes only matching items appear, and an order
      spanning categories from two different stations shows a different item
      subset on each.
- [ ] **One-time passcode**: creating or resetting a terminal shows the PIN
      exactly once in a modal; reloading `/branches.html` or re-opening the
      terminal list never displays it again.

## Deploying this to PROD

Three things beyond code need to land on the production (Supabase) database
and environment before terminal auth works there — all are **your call to
run**, not something run automatically for you:

1. Run `migrations/011_terminal_auth.sql` against PROD if it hasn't already
   landed there, then `migrations/020_terminal_devices.sql` (adds the
   `terminal_devices` table and `failed_attempts`/`locked_until` columns).
   Both are idempotent — safe to run more than once, and 020 must run after
   011. `migrations/` is gitignored in this repo despite files 015–019
   already being tracked from before that rule existed — `git add -f
   migrations/020_terminal_devices.sql` (or fix `.gitignore`) so it actually
   makes it into your next commit.
2. Add `JWT_SECRET_TERMINAL` to PROD's `.env` (a long random string, distinct
   from `JWT_SECRET_PROD`). Without it the app falls back to a hardcoded dev
   default, which is fine for local testing but must not be used in
   production.
3. **Secure cookies require HTTPS.** `config.isProd` (true when `ENV=PROD`)
   sets `Secure` on all three terminal cookies — confirm PROD is actually
   served over HTTPS (Railway provisions this automatically for its default
   domain and any custom domain with DNS pointed at it) before flipping
   `ENV=PROD`, or the browser will silently refuse to set the cookies at all
   and login will loop. Local dev (`ENV=UAT`, plain HTTP) omits `Secure`
   automatically — no local config needed.

Until all three are done, `/pos` and `/kds` on PROD will fail (the old
dashboard-JWT login path no longer exists in the code at all — there's no
backwards-compatible fallback).
