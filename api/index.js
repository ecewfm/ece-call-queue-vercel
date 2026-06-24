// api/index.js — main API router for all backend functions
import crypto from 'crypto';
import { readRange, writeRange, appendRow, getSheets, batchUpdateValues, uploadCSVToDrive, verifyDriveFile, rewriteDataRows, archiveDiagnostics, ensureSheetColumns } from './_lib/sheets.js';

const SALT = process.env.SALT || 'ECE_QUEUE_2026';
const SHEET_ID = process.env.SHEET_ID;

// ── Helpers ──────────────────────────────────────────────────────────────────

function hashPassword(plain) {
  return crypto.createHash('sha256').update(SALT + plain).digest('base64');
}

function nowDate() { return new Date(); }
function nowISO() { return new Date().toISOString(); }

function fmtTs(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

async function logEvent(agentId, agentName, event, fromStatus, toStatus, ts, durSec, note) {
  const tsObj = ts instanceof Date ? ts : new Date(ts);
  const tz = 'Asia/Manila';
  const pad = n => String(n).padStart(2,'0');
  const date = tsObj.getFullYear()+'-'+pad(tsObj.getMonth()+1)+'-'+pad(tsObj.getDate());
  const time = pad(tsObj.getHours())+':'+pad(tsObj.getMinutes())+':'+pad(tsObj.getSeconds());
  await appendRow('Logs', [
    tsObj.toISOString(), agentId, agentName, event,
    fromStatus || '', toStatus || '', note || '', durSec || 0, date, time
  ]);
}

// ── Get all agents (returns objects) ──────────────────────────────────────────

async function getAllAgents() {
  const rows = await readRange('Agents!A2:N');
  return rows.filter(r => r[0]).map(r => ({
    id: r[0],
    name: r[1],
    username: r[2],
    role: r[4],
    status: r[5],
    queueJoin: r[6] ? new Date(r[6]).toISOString() : null,
    callStart: r[7] ? new Date(r[7]).toISOString() : null,
    queuePosition: r[8] || '',
    auxStart: r[9] ? new Date(r[9]).toISOString() : null,
    passwordChanged: r[10] === true || r[10] === 'TRUE',
    securityQuestion: r[11] || '',
    aircallPref: r[13] || ''  // column N: '', 'show', or 'hide'
  }));
}

// Get raw rows (for updates)
async function getAgentRowIndex(agentId) {
  const rows = await readRange('Agents!A:A');
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) == String(agentId)) return i + 1; // sheet row (1-indexed)
  }
  return null;
}

// ── AUTH ──────────────────────────────────────────────────────────────────────

async function login(username, password) {
  const rows = await readRange('Agents!A2:N');
  const hashed = hashPassword(password);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r[2] === username && r[3] === hashed) {
      const role = r[4];
      const now = nowDate();
      // Auto-set agent status to Not Available on login
      if (role === 'agent') {
        const oldStatus = r[5];
        const rowNum = i + 2;
        await writeRange(`Agents!F${rowNum}:G${rowNum}`, [['Not Available', '']]);
        await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
        await logEvent(r[0], r[1], 'Agent Login', oldStatus, 'Not Available', now, 0, '');
      }
      return {
        success: true,
        agent: {
          id: r[0], name: r[1], username: r[2], role,
          status: role === 'agent' ? 'Not Available' : r[5],
          passwordChanged: r[10] === true || r[10] === 'TRUE',
          securityQuestion: r[11] || '',
          aircallPref: r[13] || ''
        }
      };
    }
  }
  return { success: false };
}

async function agentLogout(agentId) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return { success: false };
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  const oldStatus = agentRow[5];
  const now = nowDate();
  await writeRange(`Agents!F${rowNum}:H${rowNum}`, [['End of Shift', '', '']]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  await logEvent(agentId, agentRow[1], 'Agent Logout', oldStatus, 'End of Shift', now, 0, '');
  await recalculateQueue();
  return { success: true };
}

async function forceChangePassword(agentId, newPass, secQ, secA) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return { success: false, error: 'Agent not found' };
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  await writeRange(`Agents!D${rowNum}`, [[hashPassword(newPass)]]);
  await writeRange(`Agents!K${rowNum}:M${rowNum}`, [[true, secQ, hashPassword(secA.toLowerCase().trim())]]);
  await logEvent(agentId, agentRow[1], 'Password Setup', '', '', nowDate(), 0, 'First-time password change');
  return { success: true };
}

async function changePassword(agentId, currentPass, newPass) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return { success: false, error: 'Agent not found.' };
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  if (agentRow[3] !== hashPassword(currentPass)) return { success: false, error: 'Current password is incorrect.' };
  await writeRange(`Agents!D${rowNum}`, [[hashPassword(newPass)]]);
  await writeRange(`Agents!K${rowNum}`, [[true]]);
  await logEvent(agentId, agentRow[1], 'Password Changed', '', '', nowDate(), 0, '');
  return { success: true };
}

async function changeSecurityQA(agentId, currentPass, secQ, secA) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return { success: false, error: 'Agent not found.' };
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  if (agentRow[3] !== hashPassword(currentPass)) return { success: false, error: 'Current password is incorrect.' };
  await writeRange(`Agents!L${rowNum}:M${rowNum}`, [[secQ, hashPassword(secA.toLowerCase().trim())]]);
  await logEvent(agentId, agentRow[1], 'Security Q&A Updated', '', '', nowDate(), 0, '');
  return { success: true };
}

async function getSecurityQuestion(username) {
  const rows = await readRange('Agents!A2:M');
  for (const r of rows) {
    if (r[2] === username) {
      if (!r[11]) return { success: false, error: 'No security question set. Contact your supervisor.' };
      return { success: true, question: r[11] };
    }
  }
  return { success: false, error: 'Username not found.' };
}

async function resetPasswordWithSecurity(username, secA, newPass) {
  const rows = await readRange('Agents!A2:M');
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r[2] === username) {
      if (!r[12]) return { success: false, error: 'No security answer on file.' };
      if (r[12] !== hashPassword(secA.toLowerCase().trim())) return { success: false, error: 'Incorrect security answer.' };
      const rowNum = i + 2;
      await writeRange(`Agents!D${rowNum}`, [[hashPassword(newPass)]]);
      await writeRange(`Agents!K${rowNum}`, [[true]]);
      await logEvent(r[0], r[1], 'Password Reset', '', '', nowDate(), 0, 'Via security question');
      return { success: true };
    }
  }
  return { success: false, error: 'Username not found.' };
}

// ── AGENT ACTIONS ─────────────────────────────────────────────────────────────

async function setMyStatus(agentId, newStatus, callerRole) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents();
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  const oldStatus = agentRow[5];
  const now = nowDate();
  await writeRange(`Agents!F${rowNum}:G${rowNum}`, [[newStatus, newStatus === 'Available' ? now.toISOString() : '']]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  await logEvent(agentId, agentRow[1], 'AUX Change', oldStatus, newStatus, now, 0, callerRole === 'admin' ? 'Admin override' : '');
  await recalculateQueue();
  return await getAllAgents();
}

async function markCallReceived(agentId, callerRole) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents();
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  if (agentRow[5] !== 'Available') return await getAllAgents();
  const now = nowDate();
  await writeRange(`Agents!F${rowNum}:H${rowNum}`, [['On Call', '', now.toISOString()]]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  await logEvent(agentId, agentRow[1], 'Call Received', 'Available', 'On Call', now, 0, callerRole === 'admin' ? 'Marked by admin' : '');
  await recalculateQueue();
  return await getAllAgents();
}

async function markCallEnded(agentId, callerRole, callerDropped) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents();
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  const callStart = agentRow[7];
  const now = nowDate();
  const durSec = callStart ? Math.round((now - new Date(callStart)) / 1000) : 0;
  // Move to ACW (After Call Work) instead of straight to Available.
  // Store call duration in callStart column temporarily? No — clear H, set J to ACW start.
  await writeRange(`Agents!F${rowNum}:H${rowNum}`, [['ACW', '', '']]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  const evt = callerDropped ? 'Caller Dropped' : 'Call Ended';
  const note = callerDropped ? '📵 Caller dropped — entering ACW' : (callerRole === 'admin' ? 'Ended by admin — ACW' : 'Entering ACW');
  await logEvent(agentId, agentRow[1], evt, 'On Call', 'ACW', now, durSec, note);
  await recalculateQueue();
  return await getAllAgents();
}

// Called when agent finishes ACW (manually or auto via timer)
async function finishACW(agentId, expired) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents();
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  if (agentRow[5] !== 'ACW') return await getAllAgents(); // not in ACW, ignore
  const now = nowDate();
  const acwStart = agentRow[9];
  const acwSec = acwStart ? Math.round((now - new Date(acwStart)) / 1000) : 0;
  await writeRange(`Agents!F${rowNum}:G${rowNum}`, [['Available', now.toISOString()]]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  const note = expired ? `⚑ ACW expired after ${acwSec}s — auto-returned (no disposition)` : `ACW complete (${acwSec}s)`;
  await logEvent(agentId, agentRow[1], 'ACW Complete', 'ACW', 'Available', now, acwSec, note);
  await recalculateQueue();
  return await getAllAgents();
}

// Save a disposition record (to Dispositions sheet + log reference)
async function saveDisposition(d) {
  await ensureDispositionsSheet();
  const now = nowDate();
  await appendRow('Dispositions', [
    now.toISOString(),
    d.agentId || '',
    d.agentName || '',
    d.customerNumber || '',
    d.customerName || '',
    d.category || '',
    d.subcategory || '',
    d.notes || '',
    d.callDurationSec || 0
  ]);
  // Reference note in the logs
  await logEvent(d.agentId, d.agentName, 'Disposition', '', '', now, d.callDurationSec || 0,
    `${d.category || '—'} › ${d.subcategory || '—'}${d.customerNumber ? ' | #'+d.customerNumber : ''}`);
  return { success: true };
}

async function ensureDispositionsSheet() {
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === 'Dispositions');
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Dispositions' } } }] }
    });
    await writeRange('Dispositions!A1:I1', [[
      'Timestamp','AgentID','AgentName','CustomerNumber','CustomerName','Category','Subcategory','Notes','CallDurationSec'
    ]]);
  }
}

async function getDispositions(limit) {
  await ensureDispositionsSheet();
  const rows = await readRange('Dispositions!A2:I');
  const list = rows.filter(r => r[0]).map(r => ({
    timestamp: r[0], agentId: r[1], agentName: r[2],
    customerNumber: r[3], customerName: r[4],
    category: r[5], subcategory: r[6], notes: r[7], callDurationSec: r[8]
  }));
  list.reverse();
  const n = parseInt(limit, 10);
  return (n && n > 0) ? list.slice(0, n) : list;
}

// ── ARCHIVE (Logs + Dispositions → CSV in Drive) ──────────────────────────────

const ARCHIVE_FOLDER_ID = process.env.ARCHIVE_FOLDER_ID || '19uC54HePEp9ij2DukfwX3YSJCPeZcBCW';

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return '"' + s.replace(/"/g, '""') + '"';
}
function rowsToCSV(header, rows) {
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  return lines.join('\r\n');
}
function mmddyyyy(d) {
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + d.getFullYear();
}
// Is a timestamp (column A) within [fromStr, toStr] inclusive, by calendar date?
function inRange(tsRaw, fromStr, toStr) {
  if (!tsRaw) return false;
  const d = new Date(tsRaw);
  if (isNaN(d.getTime())) return false;
  const from = fromStr ? new Date(fromStr + 'T00:00:00') : null;
  const to   = toStr   ? new Date(toStr   + 'T23:59:59') : null;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

// Archive Logs + Dispositions in a date range to two CSVs in Drive.
// deleteAfter = true also removes the archived rows from the sheets (after verify).
async function archiveData(fromStr, toStr, deleteAfter) {
  await ensureDispositionsSheet();
  const runDate = mmddyyyy(nowDate());
  const result = { logs: {}, dispositions: {}, deleted: !!deleteAfter };

  // ---- LOGS (A:J, 10 cols) ----
  const LOG_HEADER = ['Timestamp','AgentID','AgentName','Event','FromStatus','ToStatus','Note','DurationSec','Date','Time'];
  const logRows = await readRange('Logs!A2:J');
  const logIn = [], logKeep = [];
  for (const r of logRows) {
    if (!r[0]) continue;
    if (inRange(r[0], fromStr, toStr)) logIn.push(r);
    else logKeep.push(r);
  }
  if (logIn.length) {
    const csv = rowsToCSV(LOG_HEADER, logIn);
    const file = await uploadCSVToDrive(ARCHIVE_FOLDER_ID, `7Cs Logs ${runDate}.csv`, csv);
    const ok = file && file.id ? await verifyDriveFile(file.id) : null;
    if (!ok) throw new Error('Logs CSV upload could not be verified — aborting (no rows deleted).');
    result.logs = { archived: logIn.length, file: file.name, fileId: file.id, link: file.webViewLink };
    if (deleteAfter) {
      await rewriteDataRows('Logs', logKeep, 'J');
      result.logs.remaining = logKeep.length;
    }
  } else {
    result.logs = { archived: 0 };
  }

  // ---- DISPOSITIONS (A:I, 9 cols) ----
  const DISP_HEADER = ['Timestamp','AgentID','AgentName','CustomerNumber','CustomerName','Category','Subcategory','Notes','CallDurationSec'];
  const dispRows = await readRange('Dispositions!A2:I');
  const dispIn = [], dispKeep = [];
  for (const r of dispRows) {
    if (!r[0]) continue;
    if (inRange(r[0], fromStr, toStr)) dispIn.push(r);
    else dispKeep.push(r);
  }
  if (dispIn.length) {
    const csv = rowsToCSV(DISP_HEADER, dispIn);
    const file = await uploadCSVToDrive(ARCHIVE_FOLDER_ID, `7Cs Disposition ${runDate}.csv`, csv);
    const ok = file && file.id ? await verifyDriveFile(file.id) : null;
    if (!ok) throw new Error('Dispositions CSV upload could not be verified — aborting (no rows deleted).');
    result.dispositions = { archived: dispIn.length, file: file.name, fileId: file.id, link: file.webViewLink };
    if (deleteAfter) {
      await rewriteDataRows('Dispositions', dispKeep, 'I');
      result.dispositions.remaining = dispKeep.length;
    }
  } else {
    result.dispositions = { archived: 0 };
  }

  result.success = true;
  return result;
}

async function logCallAvoidance(agentId, note) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents();
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  const now = nowDate();
  // Dismissing a call now sets the agent to Not Available (pulled from the queue).
  // F = status, G = queueJoinTime (cleared), J = AUX start time.
  await writeRange(`Agents!F${rowNum}:G${rowNum}`, [['Not Available', '']]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  await logEvent(agentId, agentRow[1], 'Call Avoidance', 'Available', 'Not Available', now, 0, '⚑ ' + (note || 'No reason provided'));
  await recalculateQueue();
  return await getAllAgents();
}

async function logMissedCall(agentId, secondsElapsed) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents();
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  const now = nowDate();
  // Set agent to Not Available, clear queue join
  await writeRange(`Agents!F${rowNum}:G${rowNum}`, [['Not Available', '']]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  await logEvent(agentId, agentRow[1], 'Missed Call', 'Available', 'Not Available', now, 0,
    `⚑ Auto-skipped after ${secondsElapsed || '?'}s — no response`);
  await recalculateQueue();
  return await getAllAgents();
}

// ── QUEUE ─────────────────────────────────────────────────────────────────────

async function recalculateQueue() {
  const rows = await readRange('Agents!A2:M');
  const avail = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][5] === 'Available' && rows[i][6]) {
      avail.push({ row: i + 2, joinTime: new Date(rows[i][6]) });
    }
  }
  avail.sort((a, b) => a.joinTime - b.joinTime);

  // Build the new queue position values for all rows in ONE batch update
  const updates = [];
  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    // Find this row's new position (if Available) or empty
    const availEntry = avail.find(a => a.row === rowNum);
    const newPos = availEntry ? String(avail.indexOf(availEntry) + 1) : '';
    updates.push({ range: `Agents!I${rowNum}`, values: [[newPos]] });
  }
  if (updates.length) await batchUpdateValues(updates);
}

// ── ACCOUNT MANAGEMENT ────────────────────────────────────────────────────────

async function createAgent(name, username, password, role) {
  const isDefault = password === 'admin123';
  const now = nowDate();
  await appendRow('Agents', [
    Date.now(), name, username, hashPassword(password),
    role, 'Not Available', '', '', '', now.toISOString(),
    !isDefault, '', ''
  ]);
  await logEvent(Date.now(), name, 'Account Created', '', role, now, 0, '');
  return await getAllAgents();
}

async function updateAgent(agentId, name, username, password, role) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents();
  await writeRange(`Agents!B${rowNum}:C${rowNum}`, [[name, username]]);
  await writeRange(`Agents!E${rowNum}`, [[role]]);
  if (password) {
    await writeRange(`Agents!D${rowNum}`, [[hashPassword(password)]]);
    if (password === 'admin123') await writeRange(`Agents!K${rowNum}`, [[false]]);
  }
  await logEvent(agentId, name, 'Account Updated', '', '', nowDate(), 0, '');
  return await getAllAgents();
}

async function deleteAgent(agentId) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents();
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  await logEvent(agentId, agentRow[1], 'Account Deleted', '', '', nowDate(), 0, '');
  // Delete the row using batchUpdate
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetMeta = meta.data.sheets.find(s => s.properties.title === 'Agents');
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: sheetMeta.properties.sheetId, dimension: 'ROWS', startIndex: rowNum - 1, endIndex: rowNum }
        }
      }]
    }
  });
  return await getAllAgents();
}

async function bulkSetStatus(agentIds, newStatus) {
  const rows = await readRange('Agents!A2:M');
  const now = nowDate();
  const nowISO = now.toISOString();
  const idSet = new Set(agentIds.map(String));
  const updates = [];
  let updated = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!idSet.has(String(rows[i][0]))) continue;
    const rowNum = i + 2;
    // F:G = status + queueJoinTime, J = AUX start time
    updates.push({
      range: `Agents!F${rowNum}:G${rowNum}`,
      values: [[newStatus, newStatus === 'Available' ? nowISO : '']]
    });
    updates.push({
      range: `Agents!J${rowNum}`,
      values: [[nowISO]]
    });
    updated++;
  }
  // ONE batch call writes all updates at once
  if (updates.length) await batchUpdateValues(updates);
  if (updated > 0) {
    await logEvent(0, 'SYSTEM', 'Bulk AUX Change', '', newStatus, now, 0, `${updated} agents → ${newStatus} (admin override)`);
  }
  await recalculateQueue();
  return await getAllAgents();
}

async function bulkCreateAgents(newRows) {
  const existing = await readRange('Agents!A2:C');
  const existingUsernames = new Set(existing.map(r => String(r[2] || '').toLowerCase()));
  const now = nowDate();
  const defaultHash = hashPassword('admin123');
  const errors = [];
  const toAdd = [];

  newRows.forEach((row, idx) => {
    const name = String(row.name || '').trim();
    const username = String(row.username || '').trim();
    let role = String(row.role || 'agent').trim().toLowerCase();
    if (!name || !username) { errors.push(`Row ${idx+1}: missing name or username`); return; }
    if (existingUsernames.has(username.toLowerCase())) { errors.push(`Row ${idx+1}: username "${username}" already exists`); return; }
    if (role !== 'agent' && role !== 'admin') role = 'agent';
    toAdd.push([Date.now() + idx, name, username, defaultHash, role, 'Not Available', '', '', '', now.toISOString(), false, '', '']);
    existingUsernames.add(username.toLowerCase());
  });

  for (const row of toAdd) await appendRow('Agents', row);
  if (toAdd.length > 0) {
    await logEvent(0, 'SYSTEM', 'Bulk Upload', '', '', now, 0, `${toAdd.length} agents created`);
  }
  return { created: toAdd.length, errors, agents: await getAllAgents() };
}

// ── GLOBAL SETTINGS ───────────────────────────────────────────────────────────

async function ensureSettingsSheet() {
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === 'Settings');
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: 'Settings' } } }] }
    });
    // Seed with header row
    await writeRange('Settings!A1:B1', [['Key', 'Value']]);
  }
}

async function getGlobalSettings() {
  await ensureSettingsSheet();
  const rows = await readRange('Settings!A2:B');
  const settings = {
    showAircall: true,
    acwThresholdSec: 180,  // 3 minutes default
    dispositionCategories: JSON.stringify([
      { category: 'Sales',          subcategories: ['New order','Upsell','Quote request'] },
      { category: 'Support',        subcategories: ['Technical issue','Billing question','Account update'] },
      { category: 'Complaint',      subcategories: ['Service delay','Product defect','Staff conduct'] },
      { category: 'General Inquiry', subcategories: ['Hours/location','Product info','Other'] }
    ]),
    customStatuses: JSON.stringify([])  // [{name, color}] — admin-defined agent-selectable "away" statuses
  };
  rows.forEach(r => {
    if (!r[0]) return;
    let v = r[1];
    if (v === 'true' || v === true) v = true;
    else if (v === 'false' || v === false) v = false;
    settings[r[0]] = v;
  });
  return settings;
}

async function saveGlobalSettings(settings) {
  await ensureSettingsSheet();
  // Read existing keys to know which to update vs append
  const existing = await readRange('Settings!A2:B');
  const keyToRow = {};
  existing.forEach((r, i) => { if (r[0]) keyToRow[r[0]] = i + 2; });

  const updates = [];
  const appends = [];
  for (const k in settings) {
    if (!settings.hasOwnProperty(k)) continue;
    const v = String(settings[k]);
    if (keyToRow[k]) {
      updates.push({ range: `Settings!B${keyToRow[k]}`, values: [[v]] });
    } else {
      appends.push([k, v]);
    }
  }
  if (updates.length) await batchUpdateValues(updates);
  for (const row of appends) await appendRow('Settings', row);

  await logEvent(0, 'SYSTEM', 'Settings Updated', '', '', nowDate(), 0,
    Object.keys(settings).map(k => `${k}=${settings[k]}`).join(', '));
  return await getGlobalSettings();
}

async function setAircallPref(agentId, pref) {
  // pref must be '', 'show', or 'hide'
  const validPref = ['', 'show', 'hide'].includes(pref) ? pref : '';
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return { success: false, error: 'Agent not found' };
  await ensureSheetColumns('Agents', 14); // column N is the 14th — make sure the grid is wide enough
  await writeRange(`Agents!N${rowNum}`, [[validPref]]);
  return { success: true, aircallPref: validPref };
}



function rowToLog(row) {
  if (!row[0]) return null;
  let ts;
  try { ts = new Date(row[0]); if (isNaN(ts.getTime())) return null; } catch(e) { return null; }
  return {
    timestamp: fmtTs(ts),
    rawTs: ts.toISOString(),
    agentId: String(row[1] || ''),
    agentName: String(row[2] || ''),
    event: String(row[3] || ''),
    fromStatus: String(row[4] || ''),
    toStatus: String(row[5] || ''),
    note: String(row[6] || ''),
    durationSec: typeof row[7] === 'number' ? Math.round(row[7]) : (parseInt(row[7]) || 0)
  };
}

async function getLogs(limit) {
  const rows = await readRange('Logs!A2:J');
  const max = limit || 500;
  const logs = [];
  for (let i = rows.length - 1; i >= 0 && logs.length < max; i--) {
    const entry = rowToLog(rows[i]);
    if (entry) logs.push(entry);
  }
  return logs;
}

async function getLogsByDateRange(fromStr, toStr) {
  const rows = await readRange('Logs!A2:J');
  const from = new Date(fromStr + 'T00:00:00');
  const to = new Date(toStr + 'T23:59:59');
  const logs = [];
  for (const r of rows) {
    const entry = rowToLog(r);
    if (!entry) continue;
    const ts = new Date(entry.rawTs);
    if (ts >= from && ts <= to) logs.push(entry);
  }
  logs.sort((a, b) => new Date(a.rawTs) - new Date(b.rawTs));
  return logs;
}

async function getAgentAuxSummary(fromStr, toStr) {
  const logs = await getLogsByDateRange(fromStr, toStr);
  const byAgent = {};
  for (const l of logs) {
    if (!l.agentName) continue;
    if (!byAgent[l.agentName]) byAgent[l.agentName] = [];
    byAgent[l.agentName].push(l);
  }
  const summary = {};
  for (const name in byAgent) {
    const events = byAgent[name];
    summary[name] = { availSec:0, breakSec:0, awaySec:0, callSec:0, calls:0, totalDurSec:0 };
    for (let i = 0; i < events.length; i++) {
      const e = events[i], next = events[i + 1];
      if (e.event === 'Call Received') summary[name].calls++;
      if (e.event === 'Call Ended' && e.durationSec) summary[name].totalDurSec += e.durationSec;
      if (!next) continue;
      const durSec = (new Date(next.rawTs) - new Date(e.rawTs)) / 1000;
      if (durSec <= 0) continue;
      if (e.toStatus === 'Available') summary[name].availSec += durSec;
      else if (e.toStatus === 'Break' || e.toStatus === 'Lunch') summary[name].breakSec += durSec;
      else if (['Coaching','Meeting','Outbound Call','Not Available','End of Shift'].includes(e.toStatus)) summary[name].awaySec += durSec;
      else if (e.toStatus === 'On Call') summary[name].callSec += durSec;
    }
  }
  return summary;
}

async function getInitialData(logLimit) {
  return {
    agents: await getAllAgents(),
    logs: await getLogs(logLimit || 200),
    settings: await getGlobalSettings()
  };
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS headers for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  try {
    // Parse params — accept both GET query string and POST body
    let params = {};
    if (req.method === 'GET') {
      params = req.query;
    } else if (req.method === 'POST') {
      params = req.body || {};
    }

    // Auto-parse JSON-encoded strings (for arrays/objects)
    for (const k in params) {
      if (typeof params[k] === 'string') {
        const v = params[k];
        if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}'))) {
          try { params[k] = JSON.parse(v); } catch(e) {}
        }
      }
    }

    const fn = params.fn;
    let data;

    switch (fn) {
      case 'login':                     data = await login(params.username, params.password); break;
      case 'agentLogout':               data = await agentLogout(params.agentId); break;
      case 'forceChangePassword':       data = await forceChangePassword(params.agentId, params.newPassword, params.securityQuestion, params.securityAnswer); break;
      case 'changePassword':            data = await changePassword(params.agentId, params.currentPassword, params.newPassword); break;
      case 'changeSecurityQA':          data = await changeSecurityQA(params.agentId, params.currentPassword, params.securityQuestion, params.securityAnswer); break;
      case 'getSecurityQuestion':       data = await getSecurityQuestion(params.username); break;
      case 'resetPasswordWithSecurity': data = await resetPasswordWithSecurity(params.username, params.securityAnswer, params.newPassword); break;
      case 'setMyStatus':               data = await setMyStatus(params.agentId, params.newStatus, params.callerRole); break;
      case 'markCallReceived':          data = await markCallReceived(params.agentId, params.callerRole); break;
      case 'markCallEnded':             data = await markCallEnded(params.agentId, params.callerRole, params.callerDropped); break;
      case 'finishACW':                 data = await finishACW(params.agentId, params.expired); break;
      case 'saveDisposition':           data = await saveDisposition(params.disposition || params); break;
      case 'getDispositions':           data = await getDispositions(params.limit); break;
      case 'archiveData':               data = await archiveData(params.from, params.to, params.deleteAfter); break;
      case 'archiveDiagnostics':        data = await archiveDiagnostics(process.env.ARCHIVE_FOLDER_ID || '19uC54HePEp9ij2DukfwX3YSJCPeZcBCW'); break;
      case 'logCallAvoidance':          data = await logCallAvoidance(params.agentId, params.note); break;
      case 'logMissedCall':             data = await logMissedCall(params.agentId, params.secondsElapsed); break;
      case 'createAgent':               data = await createAgent(params.name, params.username, params.password, params.role); break;
      case 'updateAgent':               data = await updateAgent(params.agentId, params.name, params.username, params.password, params.role); break;
      case 'deleteAgent':               data = await deleteAgent(params.agentId); break;
      case 'bulkSetStatus':             data = await bulkSetStatus(params.agentIds, params.newStatus); break;
      case 'bulkCreateAgents':          data = await bulkCreateAgents(params.rows); break;
      case 'getGlobalSettings':         data = await getGlobalSettings(); break;
      case 'saveGlobalSettings':        data = await saveGlobalSettings(params.settings); break;
      case 'setAircallPref':            data = await setAircallPref(params.agentId, params.pref); break;
      case 'getAllAgents':              data = await getAllAgents(); break;
      case 'getInitialData':            data = await getInitialData(params.logLimit); break;
      case 'getLogs':                   data = await getLogs(params.limit); break;
      case 'getLogsByDateRange':        data = await getLogsByDateRange(params.from, params.to); break;
      case 'getAgentAuxSummary':        data = await getAgentAuxSummary(params.from, params.to); break;
      default:
        res.status(400).json({ error: 'Unknown function: ' + fn });
        return;
    }

    res.status(200).json({ ok: true, data });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
}
