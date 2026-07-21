// api/index.js — main API router for all backend functions
import crypto from 'crypto';
import { readRange, writeRange, appendRow, getSheets, batchUpdateValues, uploadCSVToDrive, verifyDriveFile, rewriteDataRows, archiveDiagnostics, ensureSheetColumns, sendGmail } from './_lib/sheets.js';

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

// ── Agents read cache ─────────────────────────────────────────────────────────
// The agent list is by far the most-polled read (every agent + admin, every ~3s).
// At 15-30 agents that alone can exceed Google's Sheets read quota. This cache
// serves the SAME agent snapshot to everyone within a short TTL, collapsing many
// concurrent reads into ONE Sheets fetch. Any write that changes agent state
// calls invalidateAgentsCache() so data never goes stale after an action.
//
// NOTE: Vercel serverless instances don't share memory, so this helps within a
// warm instance (which, under constant polling, is the common case). It reduces
// reads substantially but is not a hard guarantee across all instances.
let _agentsCache = null;      // parsed agent objects
let _agentsCacheAt = 0;       // epoch ms when cached
const AGENTS_CACHE_TTL_MS = 2500;  // ~2.5s: shorter than the 3s poll interval

function invalidateAgentsCache() {
  _agentsCache = null;
  _agentsCacheAt = 0;
}

function parseAgentRows(rows) {
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

async function getAllAgents(opts) {
  const forceFresh = opts && opts.fresh;
  const now = Date.now();
  if (!forceFresh && _agentsCache && (now - _agentsCacheAt) < AGENTS_CACHE_TTL_MS) {
    return _agentsCache;  // cache hit — no Sheets read
  }
  const rows = await readRange('Agents!A2:N');
  const parsed = parseAgentRows(rows);
  _agentsCache = parsed;
  _agentsCacheAt = Date.now();
  return parsed;
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
  if (!rowNum) return await getAllAgents({ fresh: true });
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  const oldStatus = agentRow[5];
  const now = nowDate();
  await writeRange(`Agents!F${rowNum}:G${rowNum}`, [[newStatus, newStatus === 'Available' ? now.toISOString() : '']]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  await logEvent(agentId, agentRow[1], 'AUX Change', oldStatus, newStatus, now, 0, callerRole === 'admin' ? 'Admin override' : '');
  await recalculateQueue();
  return await getAllAgents({ fresh: true });
}

async function markCallReceived(agentId, callerRole) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents({ fresh: true });
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  if (agentRow[5] !== 'Available') return await getAllAgents({ fresh: true });
  const now = nowDate();
  await writeRange(`Agents!F${rowNum}:H${rowNum}`, [['On Call', '', now.toISOString()]]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  await logEvent(agentId, agentRow[1], 'Call Received', 'Available', 'On Call', now, 0, callerRole === 'admin' ? 'Marked by admin' : '');
  await recalculateQueue();
  return await getAllAgents({ fresh: true });
}

async function markCallEnded(agentId, callerRole, callerDropped) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents({ fresh: true });
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
  return await getAllAgents({ fresh: true });
}

// Called when agent finishes ACW (manually or auto via timer)
// Ghost call / quick caller-drop: return the agent to Available but KEEP their
// place at the top of the queue. Unlike finishACW (which sets queueJoinTime=now,
// sending them to the back), this PRESERVES the existing queueJoinTime so the
// round-robin keeps them at #1. Skips ACW entirely — one click back to Available.
// If the agent has no prior queueJoinTime, we fall back to a timestamp far enough
// in the past to keep them at the front.
async function finishCallerDroppedRetainSpot(agentId) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents({ fresh: true });
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  const now = nowDate();

  // Preserve the earliest join time we can. Column G (index 6) may already hold
  // the agent's original queue-join time from before the call; keep it. If empty,
  // seed with a very early time so they sort to the front.
  let keepJoin = agentRow[6];
  if (!keepJoin) {
    keepJoin = new Date(now.getTime() - 3600 * 1000).toISOString(); // 1h ago
  } else {
    keepJoin = new Date(keepJoin).toISOString();
  }

  // Set Available, restore/preserve the join time (NOT now), clear call/ACW cols.
  await writeRange(`Agents!F${rowNum}:H${rowNum}`, [['Available', keepJoin, '']]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  await logEvent(agentId, agentRow[1], 'Caller Dropped', 'On Call', 'Available', now, 0,
    '📵 Ghost/quick caller drop — retained top spot (skipped ACW)');
  await recalculateQueue();
  return await getAllAgents({ fresh: true });
}

async function finishACW(agentId, expired) {  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents({ fresh: true });
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  if (agentRow[5] !== 'ACW') return await getAllAgents({ fresh: true }); // not in ACW, ignore
  const now = nowDate();
  const acwStart = agentRow[9];
  const acwSec = acwStart ? Math.round((now - new Date(acwStart)) / 1000) : 0;
  await writeRange(`Agents!F${rowNum}:G${rowNum}`, [['Available', now.toISOString()]]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  const note = expired ? `⚑ ACW expired after ${acwSec}s — auto-returned (no disposition)` : `ACW complete (${acwSec}s)`;
  await logEvent(agentId, agentRow[1], 'ACW Complete', 'ACW', 'Available', now, acwSec, note);
  await recalculateQueue();
  return await getAllAgents({ fresh: true });
}

// Save a disposition record (to Dispositions sheet + log reference)
async function saveDisposition(d) {
  await ensureDispositionsSheet();
  const now = nowDate();
  // Phone-number fields can start with "+" (e.g. +1 222...). Google Sheets would
  // treat a leading "+" or "=" as a FORMULA and show "#ERROR! (Formula parse
  // error.)". Prefix such values with a leading apostrophe so Sheets stores them
  // as literal text (the apostrophe is not displayed). Values that don't start
  // with a formula character are left unchanged.
  const asText = (v) => {
    const s = String(v == null ? '' : v);
    if (s && /^[=+\-@]/.test(s)) return "'" + s;
    return s;
  };
  await appendRow('Dispositions', [
    now.toISOString(),
    d.agentId || '',
    d.agentName || '',
    asText(d.customerNumber),
    d.customerName || '',
    d.category || '',
    d.subcategory || '',
    d.notes || '',
    d.callDurationSec || 0,
    asText(d.aircallNumber)
  ]);
  // Reference note in the logs
  await logEvent(d.agentId, d.agentName, 'Disposition', '', '', now, d.callDurationSec || 0,
    `${d.category || '—'} › ${d.subcategory || '—'}${d.customerNumber ? ' | #'+d.customerNumber : ''}`);
  // Fire a trigger email if this category+subcategory is configured (best-effort; never blocks the save)
  try { await maybeSendDispositionEmail({ ...d, timestamp: now.toISOString() }); }
  catch (e) { /* swallow — email failure must not break disposition saving */ }
  return { success: true };
}

// ── Disposition email triggers + EOD report ───────────────────────────────────
// Settings keys (JSON in the Settings sheet via saveGlobalSettings):
//   emailTriggers: [{ category, subcategory, recipients }]  recipients = comma-separated
//   eodRecipients: comma-separated string of addresses for the EOD summary

function parseTriggers() {
  const s = _globalSettingsCache || {};
  let raw = s.emailTriggers;
  if (!raw) return [];
  try { const a = (typeof raw === 'string') ? JSON.parse(raw) : raw; return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}

let _globalSettingsCache = null; // refreshed by getGlobalSettings

function fmtDispEmailRow(label, value) {
  return '<tr><td style="padding:4px 10px;font-weight:bold;background:#f1f5f9">' + label +
         '</td><td style="padding:4px 10px">' + (value || '—') + '</td></tr>';
}

async function maybeSendDispositionEmail(d) {
  // Load fresh settings so triggers are current
  const settings = await getGlobalSettings();
  let triggers = [];
  try { triggers = JSON.parse(settings.emailTriggers || '[]'); } catch (e) { triggers = []; }
  if (!Array.isArray(triggers) || !triggers.length) return;

  const cat = String(d.category || '').trim().toLowerCase();
  const sub = String(d.subcategory || '').trim().toLowerCase();

  // Find matching trigger(s): match category, and subcategory if the trigger specifies one
  const matched = triggers.filter(t => {
    const tc = String(t.category || '').trim().toLowerCase();
    const ts = String(t.subcategory || '').trim().toLowerCase();
    if (tc !== cat) return false;
    if (ts && ts !== sub) return false; // blank trigger subcategory = any subcategory
    return true;
  });
  if (!matched.length) return;

  // Collect unique recipients across matched triggers
  const recips = {};
  matched.forEach(t => String(t.recipients || '').split(/[,;]/).forEach(r => { const e = r.trim(); if (e) recips[e] = true; }));
  const to = Object.keys(recips);
  if (!to.length) return;

  const when = fmtTs(new Date(d.timestamp || Date.now()));
  const html =
    '<div style="font-family:Arial,sans-serif;color:#1a1a1a">' +
    '<h2 style="color:#1d2b23;margin:0 0 4px">New Call Disposition</h2>' +
    '<p style="color:#6b7280;margin:0 0 12px">A disposition matching an email trigger was submitted.</p>' +
    '<table style="border-collapse:collapse;border:1px solid #e2e6ea;font-size:14px">' +
    fmtDispEmailRow('Time', when) +
    fmtDispEmailRow('Agent', d.agentName) +
    fmtDispEmailRow('Category', d.category) +
    fmtDispEmailRow('Subcategory', d.subcategory) +
    fmtDispEmailRow('Customer Number', d.customerNumber) +
    fmtDispEmailRow('Customer Name', d.customerName) +
    fmtDispEmailRow('Aircall Number', d.aircallNumber) +
    fmtDispEmailRow('Notes', d.notes) +
    '</table>' +
    '<p style="color:#94a3b8;font-size:12px;margin-top:14px">Sent automatically by the ECE Call Queue System.</p>' +
    '</div>';

  await sendGmail(to, 'Call Disposition: ' + (d.category || '') + ' › ' + (d.subcategory || ''), html);
}

// Send/test an EOD summary of all dispositions for a given date (YYYY-MM-DD, local).
async function sendEODReport(dateStr, recipientsOverride) {
  const settings = await getGlobalSettings();
  const recips = (recipientsOverride || settings.eodRecipients || '')
    .split(/[,;]/).map(s => s.trim()).filter(Boolean);
  if (!recips.length) throw new Error('No EOD recipients configured (Settings → Email triggers → EOD recipients).');

  const all = await getDispositions(0);
  // Filter to the requested local calendar date
  const target = dateStr || (function () { const d = new Date(); const p = n => String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); })();
  const localDate = (iso) => { const d = new Date(iso); if (isNaN(d)) return ''; const p = n => String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); };
  let rows = all.filter(r => localDate(r.timestamp) === target);

  // Optional EOD category/subcategory filters (same idea as email triggers).
  // Stored in Settings key `eodFilters` as JSON: [{category, subcategory}].
  // A blank subcategory matches ANY subcategory in that category. If NO filters
  // are configured, the EOD includes everything (the original behavior).
  let eodFilters = [];
  try {
    const raw = settings.eodFilters;
    const arr = (typeof raw === 'string') ? JSON.parse(raw || '[]') : (raw || []);
    if (Array.isArray(arr)) eodFilters = arr.filter(f => f && f.category);
  } catch (e) { eodFilters = []; }

  let filterNote = '';
  if (eodFilters.length) {
    const norm = s => String(s == null ? '' : s).trim().toLowerCase();
    rows = rows.filter(r =>
      eodFilters.some(f =>
        norm(f.category) === norm(r.category) &&
        (!f.subcategory || norm(f.subcategory) === norm(r.subcategory))
      )
    );
    filterNote = ' &nbsp;|&nbsp; <span style="color:#4c6a63">Filtered by: ' +
      eodFilters.map(f => (f.category + (f.subcategory ? ' › ' + f.subcategory : ' (any)'))).join('; ') +
      '</span>';
  }

  // Aggregate counts by category › subcategory
  const counts = {};
  rows.forEach(r => { const k = (r.category||'—')+' › '+(r.subcategory||'—'); counts[k] = (counts[k]||0)+1; });

  let summaryRows = Object.keys(counts).sort().map(k =>
    '<tr><td style="padding:4px 10px;border:1px solid #e2e6ea">'+k+'</td><td style="padding:4px 10px;border:1px solid #e2e6ea;text-align:right">'+counts[k]+'</td></tr>'
  ).join('');
  if (!summaryRows) summaryRows = '<tr><td colspan="2" style="padding:8px 10px;color:#94a3b8">No dispositions for this date.</td></tr>';

  let detailRows = rows.map(r =>
    '<tr>' +
    '<td style="padding:3px 8px;border:1px solid #e2e6ea">'+fmtTs(new Date(r.timestamp))+'</td>' +
    '<td style="padding:3px 8px;border:1px solid #e2e6ea">'+(r.agentName||'')+'</td>' +
    '<td style="padding:3px 8px;border:1px solid #e2e6ea">'+(r.category||'')+'</td>' +
    '<td style="padding:3px 8px;border:1px solid #e2e6ea">'+(r.subcategory||'')+'</td>' +
    '<td style="padding:3px 8px;border:1px solid #e2e6ea">'+(r.customerNumber||'')+'</td>' +
    '<td style="padding:3px 8px;border:1px solid #e2e6ea">'+(r.customerName||'')+'</td>' +
    '<td style="padding:3px 8px;border:1px solid #e2e6ea">'+(r.aircallNumber||'')+'</td>' +
    '<td style="padding:3px 8px;border:1px solid #e2e6ea">'+(r.notes||'')+'</td>' +
    '</tr>'
  ).join('');
  if (!detailRows) detailRows = '<tr><td colspan="8" style="padding:8px 10px;color:#94a3b8">No dispositions for this date.</td></tr>';

  const html =
    '<div style="font-family:Arial,sans-serif;color:#1a1a1a">' +
    '<h2 style="color:#1d2b23;margin:0 0 4px">End-of-Day Disposition Report</h2>' +
    '<p style="color:#6b7280;margin:0 0 12px">Date: '+target+' &nbsp;|&nbsp; Total dispositions: '+rows.length+filterNote+'</p>' +
    '<h3 style="color:#4c6a63;margin:14px 0 6px">Summary by category</h3>' +
    '<table style="border-collapse:collapse;font-size:14px"><tr><th style="padding:4px 10px;border:1px solid #e2e6ea;background:#1d2b23;color:#fff;text-align:left">Category › Subcategory</th><th style="padding:4px 10px;border:1px solid #e2e6ea;background:#1d2b23;color:#fff">Count</th></tr>'+summaryRows+'</table>' +
    '<h3 style="color:#4c6a63;margin:18px 0 6px">All dispositions</h3>' +
    '<table style="border-collapse:collapse;font-size:12px"><tr>'+
      ['Time','Agent','Category','Subcategory','Cust. #','Cust. name','Aircall #','Notes'].map(h=>'<th style="padding:4px 8px;border:1px solid #e2e6ea;background:#1d2b23;color:#fff;text-align:left">'+h+'</th>').join('')+
    '</tr>'+detailRows+'</table>' +
    '<p style="color:#94a3b8;font-size:12px;margin-top:14px">Sent by the ECE Call Queue System.</p>' +
    '</div>';

  const res = await sendGmail(recips, 'EOD Disposition Report — ' + target, html);
  return { success: true, date: target, count: rows.length, sentTo: recips, id: res.id };
}

// ── Scheduled EOD (driven by Vercel Cron, hourly) ─────────────────────────────
// The schedule is stored in Settings under key `eodSchedule` as JSON:
//   { frequency: 'off'|'daily'|'weekly'|'monthly',
//     hour: 0-23,            // hour in America/New_York (EST/EDT, DST-aware)
//     dayOfWeek: 0-6,        // 0=Sun … 6=Sat (weekly only)
//     dayOfMonth: 1-31 }     // (monthly only)
// A guard key `eodLastSentDate` (a New-York YYYY-MM-DD) prevents double-sends.
//
// This is called by the cron endpoint (api/cron-eod.js) once per hour. It decides
// whether a send is due *right now* in New York time, and if so sends the EOD for
// "today" (New York date) and records the guard.

// Return New York (America/New_York) date parts for a given Date — DST-aware.
function nyParts(d) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  });
  const p = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  const wkmap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return {
    date: p.year + '-' + p.month + '-' + p.day,   // YYYY-MM-DD (NY)
    hour: parseInt(p.hour, 10),                    // 0-23 (NY)
    dayOfWeek: wkmap[p.weekday],                   // 0-6
    dayOfMonth: parseInt(p.day, 10),               // 1-31
  };
}

async function checkAndSendScheduledEOD() {
  const settings = await getGlobalSettings();

  let sched;
  try { sched = JSON.parse(settings.eodSchedule || '{}'); }
  catch (e) { sched = {}; }

  const freq = (sched.frequency || 'off').toLowerCase();
  if (freq === 'off' || !freq) {
    return { ran: false, reason: 'schedule off' };
  }

  const now = nyParts(new Date());
  const wantHour = Number.isInteger(sched.hour) ? sched.hour : 18; // default 6 PM NY

  // Is this the right hour?
  if (now.hour !== wantHour) {
    return { ran: false, reason: `not the hour (now ${now.hour}, want ${wantHour} NY)` };
  }

  // Is this the right day for the frequency?
  if (freq === 'weekly') {
    const wantDow = Number.isInteger(sched.dayOfWeek) ? sched.dayOfWeek : 5; // default Fri
    if (now.dayOfWeek !== wantDow) return { ran: false, reason: 'not the weekday' };
  } else if (freq === 'monthly') {
    const wantDom = Number.isInteger(sched.dayOfMonth) ? sched.dayOfMonth : 1;
    if (now.dayOfMonth !== wantDom) return { ran: false, reason: 'not the day of month' };
  } // daily: any day at the hour

  // Duplicate guard — already sent for this NY date?
  if (settings.eodLastSentDate === now.date) {
    return { ran: false, reason: 'already sent today', date: now.date };
  }

  // Send the EOD for today's NY date, then record the guard.
  // Wrapped so a config problem (e.g. no recipients) doesn't make the hourly
  // cron throw every run — it just reports the reason.
  let result;
  try {
    result = await sendEODReport(now.date);
  } catch (e) {
    return { ran: false, reason: 'send failed: ' + (e && e.message), date: now.date };
  }
  await saveGlobalSettings({ eodLastSentDate: now.date });

  return { ran: true, date: now.date, count: result.count, sentTo: result.sentTo, frequency: freq };
}

// Test the email path (sends a simple test email to provided or EOD recipients).
async function sendTestEmail(recipients) {
  const to = (recipients || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  if (!to.length) throw new Error('Enter at least one recipient to test.');
  const res = await sendGmail(to, 'ECE Call Queue — test email',
    '<div style="font-family:Arial,sans-serif"><h2 style="color:#1d2b23">Test email</h2>' +
    '<p>If you received this, disposition email sending is working.</p>' +
    '<p style="color:#94a3b8;font-size:12px">Sent by the ECE Call Queue System.</p></div>');
  return { success: true, sentTo: to, id: res.id };
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
    await writeRange('Dispositions!A1:J1', [[
      'Timestamp','AgentID','AgentName','CustomerNumber','CustomerName','Category','Subcategory','Notes','CallDurationSec','AircallNumber'
    ]]);
  } else {
    // Sheet exists — make sure the AircallNumber header (col J) is present for older sheets
    const hdr = await readRange('Dispositions!A1:J1');
    if (!hdr[0] || !hdr[0][9]) {
      await ensureSheetColumns('Dispositions', 10);
      await writeRange('Dispositions!J1', [['AircallNumber']]);
    }
  }
}

async function getDispositions(limit) {
  await ensureDispositionsSheet();
  const rows = await readRange('Dispositions!A2:J');
  // A cell that was stored as a bad formula (e.g. a "+1..." phone number) reads
  // back as a Sheets error like "#ERROR!". Blank those out so the report shows an
  // empty cell instead of an error. New dispositions no longer hit this (see
  // saveDisposition), but this protects any rows already broken in the sheet.
  const clean = (v) => {
    const s = String(v == null ? '' : v);
    if (/^#(ERROR!|REF!|NAME\?|VALUE!|DIV\/0!|N\/A|NULL!|NUM!)/.test(s)) return '';
    return v;
  };
  const list = rows.filter(r => r[0]).map(r => ({
    timestamp: r[0], agentId: r[1], agentName: r[2],
    customerNumber: clean(r[3]), customerName: r[4],
    category: r[5], subcategory: r[6], notes: r[7], callDurationSec: r[8],
    aircallNumber: clean(r[9] || '')
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
  const DISP_HEADER = ['Timestamp','AgentID','AgentName','CustomerNumber','CustomerName','Category','Subcategory','Notes','CallDurationSec','AircallNumber'];
  const dispRows = await readRange('Dispositions!A2:J');
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
      await rewriteDataRows('Dispositions', dispKeep, 'J');
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
  if (!rowNum) return await getAllAgents({ fresh: true });
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  const now = nowDate();
  // Dismissing a call now sets the agent to Not Available (pulled from the queue).
  // F = status, G = queueJoinTime (cleared), J = AUX start time.
  await writeRange(`Agents!F${rowNum}:G${rowNum}`, [['Not Available', '']]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  await logEvent(agentId, agentRow[1], 'Call Avoidance', 'Available', 'Not Available', now, 0, '⚑ ' + (note || 'No reason provided'));
  await recalculateQueue();
  return await getAllAgents({ fresh: true });
}

async function logMissedCall(agentId, secondsElapsed) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents({ fresh: true });
  const agentRow = (await readRange(`Agents!A${rowNum}:M${rowNum}`))[0];
  const now = nowDate();
  // Set agent to Not Available, clear queue join
  await writeRange(`Agents!F${rowNum}:G${rowNum}`, [['Not Available', '']]);
  await writeRange(`Agents!J${rowNum}`, [[now.toISOString()]]);
  await logEvent(agentId, agentRow[1], 'Missed Call', 'Available', 'Not Available', now, 0,
    `⚑ Auto-skipped after ${secondsElapsed || '?'}s — no response`);
  await recalculateQueue();
  return await getAllAgents({ fresh: true });
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
  return await getAllAgents({ fresh: true });
}

async function updateAgent(agentId, name, username, password, role) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents({ fresh: true });
  await writeRange(`Agents!B${rowNum}:C${rowNum}`, [[name, username]]);
  await writeRange(`Agents!E${rowNum}`, [[role]]);
  if (password) {
    await writeRange(`Agents!D${rowNum}`, [[hashPassword(password)]]);
    if (password === 'admin123') await writeRange(`Agents!K${rowNum}`, [[false]]);
  }
  await logEvent(agentId, name, 'Account Updated', '', '', nowDate(), 0, '');
  return await getAllAgents({ fresh: true });
}

async function deleteAgent(agentId) {
  const rowNum = await getAgentRowIndex(agentId);
  if (!rowNum) return await getAllAgents({ fresh: true });
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
  return await getAllAgents({ fresh: true });
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
  return await getAllAgents({ fresh: true });
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
  return { created: toAdd.length, errors, agents: await getAllAgents({ fresh: true }) };
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
    customStatuses: JSON.stringify([]),  // [{name, color}] — admin-defined agent-selectable "away" statuses
    emailTriggers: JSON.stringify([]),   // [{category, subcategory, recipients}]
    eodRecipients: '',                   // comma-separated addresses for the EOD summary
    eodSchedule: JSON.stringify({ frequency: 'off', hour: 18, dayOfWeek: 5, dayOfMonth: 1 }), // auto-EOD schedule (New York time)
    eodLastSentDate: '',                 // guard: last NY date an auto-EOD was sent
    eodFilters: JSON.stringify([]),      // [{category, subcategory}] — empty = EOD includes all
    aircallLines: JSON.stringify([])     // ['ECE Main', 'GW/TED 10XLA', …] admin-configured line names for the disposition dropdown
  };
  rows.forEach(r => {
    if (!r[0]) return;
    let v = r[1];
    if (v === 'true' || v === true) v = true;
    else if (v === 'false' || v === false) v = false;
    settings[r[0]] = v;
  });
  _globalSettingsCache = settings;
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

// ── Incoming calls (Aircall webhook feed) ─────────────────────────────────────
// IncomingCalls tab columns (must match api/webhook.js HEADER):
//  A ReceivedAt | B CallId | C Direction | D CallerNumber | E AircallLineId
//  F AircallLineName | G AircallLineDigits | H Status | I EventTimestamp | J Handled
const INCOMING_TAB = 'IncomingCalls';

// Lines whose NAME contains any of these (case-insensitive) are NOT ECE calls
// and must never trigger the agent popup. "Berman Abogado(s)" is a different
// team sharing the same Aircall account. Add more markers here if needed.
const NON_ECE_LINE_MARKERS = ['berman abogado'];

function isEceLine(lineName) {
  const n = String(lineName || '').toLowerCase();
  return !NON_ECE_LINE_MARKERS.some(marker => n.includes(marker));
}

// Returns the most recent UNHANDLED, RECENT, ECE incoming call (or null).
async function getIncomingCalls(windowSec) {
  const win = parseInt(windowSec) > 0 ? parseInt(windowSec) : 90;
  // Read only the LAST ~50 rows, not the whole (large, fast-growing) tab.
  // The live call is always near the bottom, so we find the current row count
  // first (cheap, single column) and read only the tail.
  let rows;
  try {
    const colB = await readRange(`${INCOMING_TAB}!B2:B`);   // CallId column = row count
    const total = (colB && colB.length) || 0;
    if (total === 0) return { call: null, count: 0 };
    const TAIL = 50;
    const startRow = Math.max(2, total - TAIL + 2);          // +2: header is row 1
    rows = await readRange(`${INCOMING_TAB}!A${startRow}:J`);
  } catch (e) {
    return { call: null, count: 0 };
  }
  if (!rows || !rows.length) return { call: null, count: 0 };

  const cutoffMs = Date.now() - win * 1000;
  const fresh = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const receivedAt = r[0];
    const callId     = r[1];
    const direction  = r[2];
    const caller     = r[3];
    const lineName   = r[5];
    const status     = r[7];
    const handled    = r[9];

    if (handled) continue;
    if (!callId) continue;
    if (direction && String(direction) !== 'inbound') continue;
    if (!isEceLine(lineName)) continue;

    const t = Date.parse(receivedAt);
    if (isNaN(t) || t < cutoffMs) continue;

    fresh.push({
      callId: String(callId),
      caller: String(caller || ''),
      lineName: String(lineName || ''),
      status: String(status || ''),
      receivedAt: receivedAt,
      _t: t,
    });
  }
  if (!fresh.length) return { call: null, count: 0 };

  fresh.sort((a, b) => b._t - a._t);
  const top = fresh[0];
  delete top._t;
  return { call: top, count: fresh.length };
}

// Marks a specific IncomingCalls row (by CallId) as handled. Idempotent.
async function markIncomingCallHandled(callId) {
  if (!callId) return { ok: false, reason: 'no callId' };
  const ids = await readRange(`${INCOMING_TAB}!B2:B`);
  let rowNum = -1;
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] && String(ids[i][0]) === String(callId)) {
      rowNum = i + 2;
      break;
    }
  }
  if (rowNum === -1) return { ok: false, reason: 'callId not found' };
  await writeRange(`${INCOMING_TAB}!J${rowNum}`, [['yes']]);
  return { ok: true, callId: String(callId), row: rowNum };
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

    // Any state-changing call invalidates the agents cache so the next read is
    // fresh. Read-only calls (getAllAgents, getInitialData, getIncomingCalls, etc.)
    // are NOT listed here, so they benefit from the cache.
    const MUTATING_FNS = new Set([
      'login','agentLogout','forceChangePassword','changePassword','changeSecurityQA',
      'resetPasswordWithSecurity','setMyStatus','markCallReceived','markCallEnded',
      'finishACW','logCallAvoidance','logMissedCall','createAgent','updateAgent',
      'deleteAgent','bulkSetStatus','bulkCreateAgents','setAircallPref'
    ]);
    if (MUTATING_FNS.has(fn)) invalidateAgentsCache();

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
      case 'finishCallerDroppedRetainSpot': data = await finishCallerDroppedRetainSpot(params.agentId); break;
      case 'saveDisposition':           data = await saveDisposition(params.disposition || params); break;
      case 'getDispositions':           data = await getDispositions(params.limit); break;
      case 'archiveData':               data = await archiveData(params.from, params.to, params.deleteAfter); break;
      case 'archiveDiagnostics':        data = await archiveDiagnostics(process.env.ARCHIVE_FOLDER_ID || '19uC54HePEp9ij2DukfwX3YSJCPeZcBCW'); break;
      case 'sendEODReport':             data = await sendEODReport(params.date, params.recipients); break;
      case 'checkAndSendScheduledEOD':  data = await checkAndSendScheduledEOD(); break;
      case 'sendTestEmail':             data = await sendTestEmail(params.recipients); break;
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
      case 'getIncomingCalls':          data = await getIncomingCalls(params.windowSec); break;
      case 'markIncomingCallHandled':   data = await markIncomingCallHandled(params.callId); break;
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

// Named export so the Vercel Cron endpoint (api/cron-eod.js) can run the
// scheduled-EOD check directly, without a self-HTTP call.
export { checkAndSendScheduledEOD };
