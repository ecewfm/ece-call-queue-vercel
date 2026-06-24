// api/_lib/sheets.js — shared Google Sheets + Drive helper

import { google } from 'googleapis';

const SHEET_ID = process.env.SHEET_ID;

let _sheets = null;
let _drive = null;

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
}

export function getSheets() {
  if (_sheets) return _sheets;
  const auth = getAuth();
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

export function getDrive() {
  if (_drive) return _drive;
  const auth = getAuth();
  _drive = google.drive({ version: 'v3', auth });
  return _drive;
}

// Upload a CSV string to a Drive folder. Returns the created file's metadata.
export async function uploadCSVToDrive(folderId, filename, csvString) {
  const drive = getDrive();
  try {
    const res = await drive.files.create({
      requestBody: {
        name: filename,
        parents: folderId ? [folderId] : undefined,
        mimeType: 'text/csv',
      },
      media: {
        mimeType: 'text/csv',
        body: csvString,
      },
      fields: 'id, name, size, webViewLink',
      supportsAllDrives: true,
    });
    return res.data;
  } catch (e) {
    // Surface Google's actual reason/message so the cause is unambiguous
    const ge = (e && e.errors && e.errors[0]) || {};
    const reason = ge.reason || '';
    const gmsg = ge.message || (e && e.message) || 'unknown';
    const code = (e && e.code) || '';
    throw new Error('Drive upload failed [code=' + code + ', reason=' + reason + ']: ' + gmsg);
  }
}

// Diagnostic: which project does the key belong to, and can we reach the folder?
export async function archiveDiagnostics(folderId) {
  const out = { projectId: null, clientEmail: null, folderId: folderId, folderReachable: null, driveAbout: null, error: null };
  try {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    out.projectId = creds.project_id || null;
    out.clientEmail = creds.client_email || null;
  } catch (e) { out.error = 'Cannot parse GOOGLE_SERVICE_ACCOUNT_JSON: ' + e.message; return out; }

  const drive = getDrive();
  // Probe 1: can we read Drive at all (does the API work for this project)?
  try {
    const about = await drive.about.get({ fields: 'user(emailAddress)' });
    out.driveAbout = about && about.data && about.data.user ? about.data.user.emailAddress : 'ok';
  } catch (e) {
    const ge = (e && e.errors && e.errors[0]) || {};
    out.error = 'Drive about.get failed [code=' + (e && e.code) + ', reason=' + (ge.reason||'') + ']: ' + (ge.message || e.message);
    return out;
  }
  // Probe 2: can we see the target folder?
  try {
    const f = await drive.files.get({ fileId: folderId, fields: 'id, name', supportsAllDrives: true });
    out.folderReachable = f && f.data ? (f.data.name || true) : false;
  } catch (e) {
    const ge = (e && e.errors && e.errors[0]) || {};
    out.folderReachable = false;
    out.error = 'Folder get failed [code=' + (e && e.code) + ', reason=' + (ge.reason||'') + ']: ' + (ge.message || e.message);
  }
  return out;
}

// Verify a file exists in Drive by ID (used before deleting source rows).
export async function verifyDriveFile(fileId) {
  const drive = getDrive();
  try {
    const res = await drive.files.get({ fileId, fields: 'id, name, size', supportsAllDrives: true });
    return res.data;
  } catch (e) {
    return null;
  }
}

export async function readRange(range) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  });
  return res.data.values || [];
}

export async function writeRange(range, values) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

// Batch update multiple ranges in ONE API call — drastically faster for bulk ops
// updates = [{ range: 'Agents!F2:G2', values: [['Break', '']] }, ...]
export async function batchUpdateValues(updates) {
  if (!updates || !updates.length) return;
  const sheets = getSheets();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updates,
    },
  });
}

export async function appendRow(sheetName, row) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// Replace all data rows (everything below the header) of a sheet with `rows`.
// `lastCol` is the last column letter (e.g. 'J' for Logs, 'I' for Dispositions).
// Header in row 1 is always preserved. This is how archive-delete trims the sheet.
export async function rewriteDataRows(sheetName, rows, lastCol) {
  const sheets = getSheets();
  // 1. Clear everything from row 2 down
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A2:${lastCol}`,
  });
  // 2. Write back the rows we want to keep (if any)
  if (rows && rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A2`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    });
  }
}

// Convert sheet serial number to JS Date
export function serialToDate(serial) {
  if (!serial) return null;
  if (serial instanceof Date) return serial;
  if (typeof serial !== 'number') {
    const d = new Date(serial);
    return isNaN(d.getTime()) ? null : d;
  }
  // Google Sheets epoch: Dec 30 1899
  const epoch = new Date(Date.UTC(1899, 11, 30));
  return new Date(epoch.getTime() + serial * 86400000);
}

export function nowSerial() {
  const epoch = new Date(Date.UTC(1899, 11, 30));
  return (Date.now() - epoch.getTime()) / 86400000;
}
