// api/webhook.js
//
// Aircall webhook receiver for the ECE Call Queue System.
//
// What it does:
//   - Accepts POST from Aircall (call.created and other call events).
//   - Verifies the event is genuinely from Aircall by comparing the payload's
//     `token` against AIRCALL_WEBHOOK_TOKEN (Aircall's documented method).
//   - Ignores everything except inbound `call.created`.
//   - De-dupes by call id (handles the IVR parent/child duplicate case).
//   - Writes one row to the `IncomingCalls` tab (auto-created if missing,
//     same pattern as the Dispositions tab).
//   - ALWAYS returns 200 quickly so Aircall never disables the webhook,
//     even if the sheet write fails (the error is logged, not surfaced).
//
// Security note: the token lives ONLY in the Vercel env var, never in code.
//
// Required Vercel env vars:
//   SHEET_ID                     - the Google Sheet ID
//   GOOGLE_SERVICE_ACCOUNT_JSON  - the service account key JSON (string)
//   AIRCALL_WEBHOOK_TOKEN        - the webhook token from the Aircall dashboard

const { google } = require('googleapis');

const SHEET_TAB = 'IncomingCalls';
const HEADER = [
  'ReceivedAt',      // ISO timestamp when we received the event
  'CallId',          // Aircall call id (used for de-dup)
  'Direction',       // inbound / outbound
  'CallerNumber',    // raw_digits (the caller's number)
  'AircallLineId',   // number.id
  'AircallLineName', // number.name
  'AircallLineDigits', // number.digits
  'Status',          // call status from the payload, if present
  'EventTimestamp',  // Aircall's own event timestamp (unix seconds)
  'Handled',         // '' | 'yes' - flag the UI/poll can set/read
];

// --- Google Sheets client -------------------------------------------------

function getServiceAccountCreds() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  // Some setups store the JSON with escaped newlines in the private key.
  const creds = JSON.parse(raw);
  if (creds.private_key && creds.private_key.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }
  return creds;
}

async function getSheets() {
  const creds = getServiceAccountCreds();
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// Ensure the IncomingCalls tab exists with a header row.
// Mirrors the "auto-create the Dispositions tab" pattern.
async function ensureTab(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const exists = (meta.data.sheets || []).some(
    (s) => s.properties && s.properties.title === SHEET_TAB
  );

  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_TAB } } }],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    });
    return;
  }

  // Tab exists — make sure row 1 is the header (in case it was created empty).
  const head = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TAB}!A1:J1`,
  });
  const firstRow = (head.data.values && head.data.values[0]) || [];
  if (firstRow.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [HEADER] },
    });
  }
}

// De-dup: has this call id already been written?
// Reads existing call ids (column B) and checks membership.
async function callIdAlreadyLogged(sheets, spreadsheetId, callId) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${SHEET_TAB}!B2:B`,
    });
    const ids = (res.data.values || []).map((r) => String(r[0]));
    return ids.includes(String(callId));
  } catch (e) {
    // If the read fails, don't block the write — a rare duplicate row is
    // far less bad than dropping a real incoming-call event.
    return false;
  }
}

async function appendRow(sheets, spreadsheetId, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

// --- Body parsing ---------------------------------------------------------
// Vercel usually parses JSON automatically (req.body is an object). But if the
// content-type is off, req.body may be a string or undefined — handle both.

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') {
      try { return resolve(JSON.parse(req.body)); } catch { return resolve({}); }
    }
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

// --- Handler --------------------------------------------------------------

module.exports = async (req, res) => {
  // Aircall only ever POSTs. Answer other methods plainly (helps with the
  // occasional health check / browser hit on the URL).
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true, note: 'Aircall webhook endpoint. POST only.' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    // Malformed body — still 200 so Aircall doesn't count it as a failure.
    res.status(200).json({ ok: true, ignored: 'unparseable body' });
    return;
  }

  // 1) Verify the event really came from Aircall (token in payload body).
  const expected = process.env.AIRCALL_WEBHOOK_TOKEN;
  if (!expected) {
    // Misconfiguration on our side. Log it; still 200 so the webhook stays alive.
    console.error('[webhook] AIRCALL_WEBHOOK_TOKEN is not set');
    res.status(200).json({ ok: true, ignored: 'server not configured' });
    return;
  }
  if (!body || body.token !== expected) {
    // Bad or missing token: this is either noise or a spoof attempt.
    // Reject clearly. (Aircall's real events will always carry the token.)
    console.warn('[webhook] rejected event: token mismatch');
    res.status(401).json({ ok: false, error: 'invalid token' });
    return;
  }

  // 2) Only act on inbound call.created. Acknowledge everything else with 200.
  const event = body.event;
  const data = body.data || {};
  if (event !== 'call.created') {
    res.status(200).json({ ok: true, ignored: `event ${event}` });
    return;
  }
  if (data.direction && data.direction !== 'inbound') {
    res.status(200).json({ ok: true, ignored: 'outbound call.created' });
    return;
  }

  // 3) Extract the fields we care about.
  const number = data.number || {};
  const row = [
    new Date().toISOString(),          // ReceivedAt
    data.id != null ? String(data.id) : '', // CallId
    data.direction || 'inbound',       // Direction
    data.raw_digits || data.from || '', // CallerNumber
    number.id != null ? String(number.id) : '', // AircallLineId
    number.name || '',                 // AircallLineName
    number.digits || '',               // AircallLineDigits
    data.status || '',                 // Status
    body.timestamp != null ? String(body.timestamp) : '', // EventTimestamp
    '',                                // Handled (empty = not yet handled)
  ];

  // 4) Write to the sheet. Wrapped so a failure NEVER fails the webhook.
  try {
    const spreadsheetId = process.env.SHEET_ID;
    if (!spreadsheetId) throw new Error('SHEET_ID is not set');

    const sheets = await getSheets();
    await ensureTab(sheets, spreadsheetId);

    if (data.id != null) {
      const dup = await callIdAlreadyLogged(sheets, spreadsheetId, data.id);
      if (dup) {
        res.status(200).json({ ok: true, deduped: String(data.id) });
        return;
      }
    }

    await appendRow(sheets, spreadsheetId, row);
    res.status(200).json({ ok: true, logged: row[1] });
  } catch (err) {
    // Log for debugging but return 200 — losing one sheet write is acceptable;
    // getting the webhook disabled again is not.
    console.error('[webhook] sheet write failed:', err && err.message);
    res.status(200).json({ ok: true, warning: 'logged-but-not-written' });
  }
};
