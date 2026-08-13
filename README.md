# POS Analytics Dashboard

## ⚠️ IMPORTANT — How to Open the Dashboard

**DO NOT open index.html directly in your browser.**
You must start the Node.js server first, then open the URL.

---

## 🚀 Setup Steps

### Step 1 — Install dependencies
Open CMD and run:
```
cd c:\inetpub\wwwroot\project\dashboard
npm install
```

### Step 2 — Start the server

**UAT (Local Database):**
```
npm run dev:uat
```

**PROD (Supabase):**
```
npm run start:prod
```

### Step 3 — Open dashboard in browser
```
http://localhost:3000
```

---

## 📁 File Structure
```
c:\inetpub\wwwroot\project\
  ├── .env                  ← DO NOT TOUCH
  ├── sync-db.js            ← DO NOT TOUCH
  ├── db.js                 ← shared DB connection
  └── dashboard\
        ├── server.js       ← run this with npm start
        ├── package.json
        ├── README.md
        └── public\
              ├── index.html     ← DO NOT open directly
              ├── css\style.css
              └── js\dashboard.js
```

## 🔧 Troubleshooting

| Problem | Solution |
|---|---|
| Page not loading | Make sure `npm run dev:uat` is running in CMD |
| Database error | Check your .env file has correct credentials |
| Wrong data | Switch ENV=UAT or ENV=PROD in .env |
| Port in use | Add `DASHBOARD_PORT=3001` in .env |

## 📊 API Endpoints
All accept `?period=today|week|month|year`

| Endpoint | Description |
|---|---|
| GET /api/kpis | Revenue, Orders, AOV, Cancellations |
| GET /api/revenue-trend | Line chart |
| GET /api/dining-options | Doughnut chart |
| GET /api/payment-methods | Payment breakdown |
| GET /api/top-items | Top 10 products |
| GET /api/employee-performance | Staff bar chart |
| GET /api/device-performance | Device bar chart |
| GET /api/cancelled-orders | Alert panel |

## 📝 Audit Log

**Off by default.** Set `AUDIT_LOG_ENABLED=true` in `.env` to start
recording; unset (or anything other than `true`) and `writeAudit()` is a
no-op — no query, no write, no cost. The `/audit` viewer and `/api/audit`
still work either way (over whatever history already exists); the flag only
controls whether *new* writes get recorded going forward.

`audit_log` (migration `036_audit_log.sql`) records every write to
`expenses`, `staff`, `users` and `role_permissions`, plus login attempts —
see `services/audit.js` (the writer, `writeAudit()`) and `routes/audit.js`
(the admin-only `/api/audit` reader). Viewable at `/audit` (admin only):
filter by date range, actor, entity or action; expand a row for a
field-by-field before/after diff; export the filtered set as CSV.

Sensitive fields (`users.password`, and anything else not explicitly
listed) are never captured — each entity has an explicit **allowlist** of
fields `writeAudit()` is permitted to log, defined in `services/audit.js`.
Adding a new sensitive column to an audited table is safe by default: it's
simply not recorded until someone deliberately adds it to that entity's
allowlist.

**Retention: 12 months.** A monthly cron job (`services/auditPrune.js`,
1st of the month at 03:00 Asia/Phnom_Penh) deletes `audit_log` rows older
than 12 months. Read operations are never logged — only writes.
