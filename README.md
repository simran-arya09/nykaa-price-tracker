# 🛍️ Nykaa Price Tracker

A full-stack multi-user web app to track Nykaa beauty product prices — with automatic price checks every 15 minutes, drop alerts, price history charts, and a one-click bookmarklet.

**Live demo:** [nykaa-price-tracker-production.up.railway.app](https://nykaa-price-tracker-production.up.railway.app)

---

## ✨ Features

- **Multi-user auth** — sign up, log in, reset password (JWT-based sessions)
- **Track any Nykaa product** — paste a URL and it scrapes name, price, image instantly
- **Auto price checks** — cron job runs every 15 minutes across all tracked products
- **Price drop alerts** — logs every drop and sale start with discount percentage
- **Price history chart** — interactive Chart.js line graph per product
- **Bulk import** — paste multiple URLs at once to track your whole wishlist
- **Bookmarklet** — one-click add from any Nykaa product page while browsing
- **Per-user isolation** — each user only sees their own tracked products and alerts

---

## 🖼️ Screenshots

> Auth screen → Dashboard → Price history modal

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 |
| Framework | Express 5 |
| Database | SQLite3 (file-based) |
| Auth | bcryptjs + JSON Web Tokens |
| Scraping | Axios + Cheerio |
| Scheduler | node-cron |
| Frontend | Vanilla JS SPA (no framework) |
| Charts | Chart.js |

---

## 🚀 Running Locally

**Prerequisites:** Node.js 20+, npm

```bash
# 1. Clone the repo
git clone https://github.com/YOUR_USERNAME/nykaa-price-tracker.git
cd nykaa-price-tracker

# 2. Install dependencies (sqlite3 must build from source)
npm install --build-from-source

# 3. Start the server
JWT_SECRET=your_secret_here node server.js

# 4. Open in browser
# http://localhost:5000
```

---

## ☁️ Deploying to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select this repo
4. Go to **Variables** tab → add `JWT_SECRET` = any long random string
5. Go to **Settings** → **Networking** → **Generate Domain**
6. Done — live in ~2 minutes ✅

---

## ⚙️ Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | ✅ Yes | Secret key for signing JWT tokens |
| `PORT` | No | Auto-set by Railway (defaults to 5000 locally) |

---

## 📁 Project Structure

```
nykaa-price-tracker/
├── server.js          # Express API, scraper, cron scheduler
├── package.json
├── railway.json       # Railway deployment config
├── .nixpacks.toml     # Build config (ensures sqlite3 compiles)
├── .gitignore
└── public/
    ├── index.html     # Full SPA frontend
    └── favicon.svg
```

---

## ⚠️ Known Limitations

- Nykaa may return **403** for some scraping requests — this is expected and handled gracefully
- The price CSS selector (`span.css-1jczs19`) may break if Nykaa updates their frontend
- SQLite file (`tracker.db`) resets on Railway redeploy unless you attach a persistent volume
- Set `JWT_SECRET` to a strong random value in production — never use the dev default

---
<img width="1897" height="821" alt="Screenshot 2026-05-07 123105" src="https://github.com/user-attachments/assets/e5d5d52f-68bb-4cdb-9ba1-22650ce02e3d" />
<img width="1885" height="806" alt="Screenshot 2026-05-07 123048" src="https://github.com/user-attachments/assets/b864c7e8-675d-45dd-a574-c4f1ed1725c8" />
<img width="1902" height="834" alt="Screenshot 2026-05-07 123034" src="https://github.com/user-attachments/assets/81b33f38-2787-4808-8b46-19066d3861a7" />
<img width="1891" height="816" alt="Screenshot 2026-05-07 123000" src="https://github.com/user-attachments/assets/d132ea45-7b75-44b0-8126-d893ac6006a9" />

## 📄 License

MIT — free to use, modify, and deploy.
