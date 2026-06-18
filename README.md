# ECE Call Queue System (Vercel Edition)

Production call queue management system for ECE Contact Centers — runs on Vercel, uses Google Sheets as data store.

## Features

- Real-time agent queue with round robin
- Embedded Aircall workspace (with working microphone)
- 9 AUX statuses with duration thresholds and breach alerts
- Auto-set "Not Available" on login, "End of Shift" on logout
- Call alert modal with chime + call avoidance flow
- Admin dashboard with bulk AUX override, bulk agent upload (CSV)
- First-time password setup + forgot password (security questions)
- Reports tab with per-agent breakdown + calls heatmap
- Logs with date range filter + CSV export

## Tech stack

- Frontend: Vanilla HTML/CSS/JS (no framework)
- Backend: Vercel Serverless Functions (Node.js)
- Data store: Google Sheets via Sheets API v4
- Hosting: Vercel

## Setup

See `DEPLOYMENT_GUIDE.md` for complete step-by-step deployment instructions.

## Environment variables

| Variable | Description |
|---|---|
| `SHEET_ID` | Google Sheet ID |
| `SALT` | Password hash salt |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full service account JSON credentials |
