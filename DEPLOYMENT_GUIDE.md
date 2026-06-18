# ECE Call Queue System — Vercel Deployment Guide

This guide migrates your tool from Google Apps Script to Vercel. Your Google Sheet stays where it is — Vercel just talks to it via the Google Sheets API. Aircall microphone will work properly because Vercel pages don't have the iframe restrictions Apps Script has.

---

## Final architecture

```
┌──────────────────────┐         ┌─────────────────────────┐         ┌──────────────────┐
│ Vercel (Frontend)    │         │ Vercel Serverless       │         │ Google Sheet     │
│ - index.html         │  HTTPS  │ Functions (Node.js)     │ Sheets  │ (your existing   │
│ - Aircall iframe ✅  │ ──────► │ - login, queue, AUX     │  API    │  data, unchanged)│
│   microphone WORKS   │         │ - all old Code.gs logic │ ──────► │                  │
└──────────────────────┘         └─────────────────────────┘         └──────────────────┘
```

---

## Step-by-step deployment

### Prerequisites

You'll need:
- A GitHub account (free) ✅ you already have this
- A Vercel account (free) — we'll create this with one click using GitHub
- A Google Cloud account (free) — needs a credit card for verification but won't be charged

Total setup time: **about 45 minutes** for first-time setup.

---

## STEP 1 — Set up Google Cloud service account (15 min)

This creates a "robot" user that Vercel will use to access your Google Sheet.

### 1.1 Create a Google Cloud project

1. Go to **https://console.cloud.google.com/**
2. Sign in with the same Google account that owns your Sheet
3. At the top, click the **project dropdown** → **New project**
4. Project name: `ECE Call Queue` → Click **Create**
5. Wait for it to create, then make sure it's selected in the top dropdown

### 1.2 Enable the Sheets API

1. In the left menu: **APIs & Services** → **Library**
2. Search for: **Google Sheets API**
3. Click on it → click **Enable**

### 1.3 Create the service account

1. Left menu: **APIs & Services** → **Credentials**
2. Click **Create Credentials** (top) → **Service account**
3. Service account name: `vercel-sheets-access`
4. Click **Create and Continue**
5. Role: **Editor** (or skip role assignment — we'll grant access via the sheet directly)
6. Click **Continue** → **Done**

### 1.4 Generate a key for the service account

1. On the Credentials page, find your new service account in the list
2. Click on its email (looks like: `vercel-sheets-access@ece-call-queue.iam.gserviceaccount.com`)
3. Click the **Keys** tab
4. Click **Add Key** → **Create new key**
5. Select **JSON** → Click **Create**
6. A JSON file downloads to your computer — **keep this file safe**, you'll paste its contents into Vercel later

### 1.5 Share your Google Sheet with the service account

1. Open your existing Google Sheet (the one with Agents and Logs)
2. Click **Share** (top right)
3. Paste the service account email (e.g. `vercel-sheets-access@ece-call-queue.iam.gserviceaccount.com`)
4. Set permission: **Editor**
5. **Uncheck** "Notify people"
6. Click **Share**

---

## STEP 2 — Push the project to GitHub (10 min)

### 2.1 Create a new GitHub repo

1. Go to https://github.com → click **+** → **New repository**
2. Repository name: `ece-call-queue-vercel` (must be different from your existing repo)
3. Choose **Public** or **Private** (either works for Vercel)
4. Click **Create repository**

### 2.2 Upload the project files

You have a folder with this structure:
```
ece-call-queue-vercel/
├── api/
│   ├── _lib/
│   │   └── sheets.js
│   └── index.js
├── public/
│   └── index.html
├── package.json
└── vercel.json
```

To upload them to GitHub:

1. On your new repo page, click **uploading an existing file** (or **Add file** → **Upload files**)
2. Drag the entire `ece-call-queue-vercel` folder contents into the upload area
   - Make sure the folder structure is preserved (api folder + public folder + the two JSON files at root)
3. Commit message: `Initial Vercel project`
4. Click **Commit changes**

---

## STEP 3 — Deploy to Vercel (10 min)

### 3.1 Create Vercel account

1. Go to https://vercel.com
2. Click **Sign Up**
3. Choose **Continue with GitHub** — uses your existing account
4. Authorize Vercel

### 3.2 Import your project

1. On the Vercel dashboard, click **Add New** → **Project**
2. You'll see a list of your GitHub repos
3. Find `ece-call-queue-vercel` → click **Import**

### 3.3 Configure environment variables (CRITICAL STEP)

Before deploying, click **Environment Variables** section to expand it. Add THREE variables:

| Name | Value |
|---|---|
| `SHEET_ID` | `14P4tgnj_FJpXhCwjOLDYe9RlFnNDotCeDcJucMJG-PQ` (your Google Sheet ID — same as in Code.gs) |
| `SALT` | `ECE_QUEUE_2026` (the same salt from Code.gs — must match for existing password hashes to work) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The ENTIRE contents of the JSON file you downloaded in Step 1.4 |

**For `GOOGLE_SERVICE_ACCOUNT_JSON`:**
1. Open the downloaded JSON file in Notepad or any text editor
2. Select ALL the content (Ctrl + A) → Copy (Ctrl + C)
3. Paste it as the value for this variable
4. It should look like: `{"type":"service_account","project_id":"...",...}` — one long line

### 3.4 Deploy

1. Click **Deploy** at the bottom
2. Wait 1-2 minutes for the build
3. When done, you'll see "Congratulations!" with confetti and a URL like:
   ```
   https://ece-call-queue-vercel.vercel.app
   ```

---

## STEP 4 — Test it (5 min)

1. Open the Vercel URL
2. Try logging in with your existing credentials
3. **Test Aircall:** when the iframe loads, you should get a microphone permission prompt → Click **Allow**
4. Make a test call to verify

---

## STEP 5 — Verify everything works

Quick checklist:
- ☐ Login works
- ☐ Queue refreshes every 3 seconds
- ☐ AUX status changes save to the sheet
- ☐ Admin can override AUX for any agent
- ☐ Bulk upload of agents works
- ☐ Call alert modal fires when reaching #1
- ☐ Aircall microphone prompt appears and works
- ☐ Logs tab shows entries

---

## Important notes

### Future updates

Whenever I send you new code:
- **For backend changes** (api/index.js or api/_lib/sheets.js): edit on GitHub → commit → Vercel auto-redeploys in 1 min
- **For frontend changes** (public/index.html): same — edit on GitHub → commit → auto-deploy

You don't have to do anything in Vercel for redeployments — it watches GitHub automatically.

### Your existing Apps Script tool still works

Both versions can run in parallel. They share the same Google Sheet. Use the Vercel URL for agents who need Aircall calls, keep the Apps Script URL as backup.

### Cost monitoring

Vercel free tier limits:
- 100 GB bandwidth/month
- 100K function invocations/month

A 30-agent team using the tool 8 hours/day will use maybe 5% of this. You're nowhere near limits.

Google Sheets API limits:
- 300 reads per minute per project
- The 3-second polling = 20 reads/min per agent
- Stay under ~15 active agents for safety, OR increase the poll interval

If your team grows beyond 15 agents on the tool simultaneously, we'd need to either:
- Increase the poll interval from 3s to 5-10s
- Add a server-side cache (5 minutes of code)

### Troubleshooting

**"Internal error" on login:**
- Check Vercel logs (Vercel dashboard → your project → Deployments → click latest → Functions tab)
- Most common cause: GOOGLE_SERVICE_ACCOUNT_JSON not pasted correctly. Re-paste from the downloaded file.

**"Failed to fetch":**
- Sheet not shared with service account email. Re-do Step 1.5.

**Aircall iframe shows microphone error:**
- Hard refresh (Ctrl + Shift + R)
- Check Chrome's site permissions for the Vercel URL — should allow microphone

---

## Files in this project

| File | Purpose |
|---|---|
| `api/index.js` | All backend API functions (replaces Code.gs) |
| `api/_lib/sheets.js` | Google Sheets connection helper |
| `public/index.html` | Frontend (same as before, with `/api` as backend URL) |
| `package.json` | Node.js dependencies (just `googleapis`) |
| `vercel.json` | Vercel configuration |

---

## Quick mental model

- **Vercel** = hosts your website + runs the backend functions
- **GitHub** = source code storage that Vercel watches for updates
- **Google Cloud** = creates the "robot user" (service account) that has permission to read/write your Sheet
- **Google Sheet** = unchanged, still your database

Once set up, you only interact with **GitHub** (to push code changes) and the **Vercel URL** (to use the tool). The rest just runs.
