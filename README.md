# Nykaa Price Tracker

A multi-user web app to track Nykaa beauty product prices — with auto price checks, drop alerts, and history charts.

## Deploy on Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select this repo
4. Add environment variable: `JWT_SECRET` = any long random string
5. Railway auto-deploys — your app will be live in ~2 minutes

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Secret key for JWT tokens — set a long random string |
| `PORT` | No | Auto-set by Railway |

## Stack

- Node.js 20 + Express 5
- SQLite3 (file-based, persists on Railway volume)
- bcryptjs + JWT auth
- Axios + Cheerio scraping
- node-cron (price checks every 15 min)

## Notes

- Nykaa may return 403 for some scraping attempts — expected behaviour
- Price selector `span.css-1jczs19` may break if Nykaa changes their HTML
