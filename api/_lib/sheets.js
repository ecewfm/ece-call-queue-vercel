// api/_lib/sheets.js — shared Google Sheets helper

import { google } from 'googleapis';

const SHEET_ID = process.env.SHEET_ID;

let _sheets = null;

export function getSheets() {
  if (_sheets) return _sheets;
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
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

export async function appendRow(sheetName, row) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
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
