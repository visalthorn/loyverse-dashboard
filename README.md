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
| GET /api/peak-hours | Heatmap 7×24 |
| GET /api/top-items | Top 10 products |
| GET /api/employee-performance | Staff bar chart |
| GET /api/device-performance | Device bar chart |
| GET /api/cancelled-orders | Alert panel |
