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

Hardened 2026-08-01 after an audit found the original queue could silently
duplicate orders on a lost response, had no queue-size ceiling, and left the
kitchen completely dark during an internet-down/LAN-up outage (this app is
cloud-hosted — `/pos` and `/kds` devices on the same branch WiFi still both
need the internet to reach the server and each other). See
`services/pos/idempotency.js`, `services/pos/offlineClock.js`,
`public/js/offlineQueue.js`, and `migrations/022_pos_offline_hardening.sql`.

- The catalog is cached in `localStorage` on every successful load, so the
  item grid still renders instantly if `/api/pos/catalog` is unreachable.
- Every order mutation (create/append/pay/cancel) goes through a 5-second
  timeout. On a network failure it's queued in **IndexedDB**
  (`pos_offline_db`, not `localStorage` — a far higher practical quota for a
  long outage or a busy night) and drained automatically every 2s, respecting
  each entry's own backoff, and immediately on the browser's `online` event.
- **Idempotent replay.** Create-order, append-items, and pay each carry a
  `client_mutation_id` (UUID, generated once before the first attempt —
  live or queued). The server caches the result the first time it actually
  commits (`pos_idempotent_requests`); a retried request with the same id
  replays that ORIGINAL result instead of creating a second real row. This is
  what actually prevents duplicate orders on a lost response, not just a
  "best effort" retry.
- **Retry policy.** A connectivity failure or a `5xx` retries with
  exponential backoff (2s → 60s cap), never silently dropped. A genuine
  `4xx` (a real rejection — e.g. the table got taken by someone else while
  this device was offline) moves to a **dead-letter list** requiring
  explicit staff action (retry or discard) from the sync panel — never
  auto-retried forever, never silently discarded either.
- **Dependency-aware draining.** Appending more items to an order whose own
  create hasn't synced yet is queued as a dependent entry (referencing the
  order's provisional number) rather than being refused — it resolves the
  moment the create entry ahead of it succeeds. Cancelling an order that
  hasn't synced yet needs no server round-trip at all: it just discards the
  still-queued create.
- A new order created while offline gets a **terminal-prefixed provisional
  number** (e.g. `PP-POS-01-OFF-0007`, from `nextLocalOrderNumber()`) instead
  of the old generic `LOCAL-####` — distinct across terminals by
  construction, so two offline tablets never show the same provisional
  number. It's stored on the order (and later the receipt) as
  `provisional_number` for staff traceability even after it syncs to a real
  `POS-YYMMDD-####` number. Printed tickets for an unsynced order carry a
  bold "OFFLINE TICKET — provisional" marking (`print.js`).
- **Ownership lock.** While a terminal is offline, it may only modify
  (add/adjust/remove items, cancel, rename, change table #/dining option) an
  order it created itself — other terminals' orders show read-only with a
  "🔒 locked — offline" badge. Paying an order is never locked — any terminal
  may complete any order, online or offline. This is a client-side guard
  only (matches created_by against the logged-in terminal's own code); there
  is no server-side enforcement of it.
- **Status chip + panel.** A persistent chip (`#syncStatusChip`, top of
  `/pos`) always shows Online / Offline (N queued) / Syncing / N need
  attention. Tapping it opens a panel with the queued list, the dead-letter
  list (retry/discard buttons), a **manual "Sync now"** button (don't wait
  for the automatic drain if you want to check right away), and the last
  successful sync time. A toast summarizes each completed sync batch (e.g.
  "3 synced, 1 needs attention").
- Offline order/kitchen/payment timestamps use the **device's own clock**
  at the moment the action happened (bounds-checked server-side, ±5 min
  future / 72h back) instead of the server's clock at whenever the sync
  finally lands — so an order taken just before midnight and synced just
  after still lands in the correct business day's reports.
- **KDS was explicitly left out of this hardening pass** — it still only
  shows a small connection dot (green/red), still has no offline queue of
  its own, and still receives nothing new during an outage. See "Known gaps"
  below.
- KDS reconnects automatically via the browser's native EventSource retry
  and immediately on the `online` event — that part is unchanged.

### Known gaps (not fixed, on purpose)

- **The kitchen display goes dark during an outage.** With the internet
  down, `/kds` receives no new orders at all until connectivity returns —
  there's no LAN-local fallback (e.g. auto-printing a paper ticket) wired
  up. Staff must walk over and tell the kitchen directly for anything sent
  while the status chip is red. This was scoped out deliberately, not
  missed — see the "Internet or power outage" runbook below.
- **Payment method is never restricted offline.** Cash, QR, and split
  payments all stay selectable and payable while offline; there's no
  server-side re-validation tied to connectivity either. This system has no
  live payment-gateway verification even when fully online — QR payment has
  always been staff-attested, not automatically confirmed — so this was
  judged not worth restricting.
- **No stale-write/version conflict detection.** The ownership lock above
  covers the realistic case (two terminals both offline, one modifying the
  other's order); a full `updated_at`-based conflict check with a
  diff-for-staff-review was scoped out as unnecessary on top of that.

## Internet or power outage — what to do

1. Look at the top of the `/pos` screen. If it turns **red** and says
   "⚠ Offline — N queued", the till has lost its connection — but it still
   works.
2. **Keep taking orders as normal.** Creating orders, adding items, and
   taking payment all keep working exactly like usual while offline.
3. Offline orders show a temporary number like `PP-POS-01-OFF-0007` instead
   of the usual `POS-260801-0007` — that's normal. It becomes the real
   number automatically once the connection is back; nothing needs to be
   redone.
4. **Important: the kitchen screen will NOT show these orders until the
   connection comes back.** Walk over and tell the kitchen directly (or
   write it down) for anything sent while the banner is red.
5. Don't force-close the tablet while offline — leave the app open so it
   can sync on its own. If it does get restarted, don't worry: nothing
   queued is lost, it picks up right where it left off.
6. Tap the red banner any time to see what's still waiting, and to tap
   "Sync now" if you don't want to wait for it to retry on its own.
7. **Keep every tablet on the shop WiFi even when the internet itself is
   down** — printing (receipts and any manually reprinted kitchen ticket)
   goes over that same WiFi to the print bridge, not over the internet, so
   staying connected to it is what keeps printing working.
8. Once the banner turns **green** ("● Online"), everything queued sends
   itself within a few seconds, with a confirmation toast for each order.
   If the panel ever shows something "needs attention," tell a manager
   rather than redoing that order yourself.

**Hardware note:** a UPS covering the WiFi router, the print-bridge PC, and
the thermal printer keeps printing working through a power cut — receipts,
and any kitchen ticket a cashier manually reprints. Tablets run on their own
battery and don't need to be on the UPS, but printing depends on the shop's
own LAN staying powered, not on the tablets alone.

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
      offline, create an order — it should get a terminal-prefixed
      provisional number (e.g. `PP-POS-01-OFF-0007`), turn the status chip
      red ("⚠ Offline — N queued"), and still let you print a kitchen
      ticket (marked "OFFLINE TICKET"). Go back online and confirm it
      reconciles to a real `POS-YYMMDD-####` number automatically (within
      2s, or immediately on the `online` event) and the chip turns green.
      Also see `test/pos-offline-proof.test.js` and
      `test/pos-idempotency.test.js` for the automated proof that a retried
      create/append/pay never duplicates.
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

Separately, the offline-queue hardening (see "Offline behavior" above) needs
`migrations/022_pos_offline_hardening.sql` run against PROD **before** this
code is deployed there — idempotent, no ordering dependency on 011/020, but
`routes/pos.js` now unconditionally queries `pos_idempotent_requests` on
every create/append/pay, so deploying the code first would 500 every one of
those calls (relation does not exist), not just silently lose the new
protection.
