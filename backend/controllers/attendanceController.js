'use strict';

const fs = require('fs');
const { parseFile } = require('../services/csvService');
const {
  headlessConnect,
  exchangeCodeForToken,
  isTokenValid,
  clearTokens,
  resolveEmpNumber,
  createAttendanceRecord,
} = require('../services/ohrmService');
const { createSession, getSession, deleteSession } = require('../services/sessions');

require('dotenv').config();

const OHRM_BASE_URL      = process.env.OHRM_BASE_URL      || 'https://osm320-os-kord.orangehrm.com';
const OHRM_CLIENT_ID     = process.env.OHRM_CLIENT_ID     || '';
const OHRM_CLIENT_SECRET = process.env.OHRM_CLIENT_SECRET || '';

// POST /api/attendance/connect  — headless OAuth2 using admin credentials
async function connect(req, res) {
  const baseUrl      = (req.body.baseUrl  || OHRM_BASE_URL).replace(/\/$/, '');
  const username     = req.body.username  || '';
  const password     = req.body.password  || '';
  const clientId     = req.body.clientId  || OHRM_CLIENT_ID;
  const clientSecret = req.body.clientSecret || OHRM_CLIENT_SECRET;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    await headlessConnect(baseUrl, username, password, clientId, clientSecret);
    res.json({ ok: true, message: 'Connected to OrangeHRM successfully' });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
}

// GET /oauth/start  → redirect browser to OrangeHRM authorize (fallback)
function oauthStart(req, res) {
  const baseUrl  = (req.query.baseUrl || OHRM_BASE_URL).replace(/\/$/, '');
  const clientId = req.query.clientId || OHRM_CLIENT_ID;
  const proto    = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host     = req.headers.host || 'localhost:4000';
  const redirectUri = `${proto}://${host}/oauth/callback`;

  const state = Buffer.from(JSON.stringify({ baseUrl, clientId })).toString('base64url');
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, state });
  res.redirect(`${baseUrl}/web/index.php/oauth2/authorize?${params}`);
}

// GET /oauth/callback  → exchange code for token
async function oauthCallback(req, res) {
  const { code, state, error } = req.query;
  if (error) return res.send(`<h3>OAuth error: ${error}</h3><p><a href="/">Back</a></p>`);
  if (!code)  return res.send('<h3>No code received</h3><p><a href="/">Back</a></p>');

  let baseUrl  = OHRM_BASE_URL;
  let clientId = OHRM_CLIENT_ID;
  try {
    const s = JSON.parse(Buffer.from(state, 'base64url').toString());
    baseUrl  = s.baseUrl  || baseUrl;
    clientId = s.clientId || clientId;
  } catch { /* use defaults */ }

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host  = req.headers.host || 'localhost:4000';
  const redirectUri = `${proto}://${host}/oauth/callback`;

  try {
    await exchangeCodeForToken(baseUrl, clientId, OHRM_CLIENT_SECRET, code, redirectUri);
    res.send(`
      <!DOCTYPE html><html><head><title>Connected</title>
      <style>body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f2f5}
      .box{background:#fff;padding:2rem 2.5rem;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center}
      h2{color:#76BC21;margin-bottom:.5rem}p{color:#666;margin-bottom:1.5rem}
      a{display:inline-block;background:linear-gradient(135deg,#FF920B,#F35C17);color:#fff;padding:.7rem 2rem;border-radius:8px;text-decoration:none;font-weight:600}</style>
      </head><body><div class="box">
      <h2>&#10003; Connected to OrangeHRM</h2>
      <p>Authentication successful. You can now close this tab and start importing.</p>
      <a href="/">Go to Import Tool</a>
      </div></body></html>
    `);
  } catch (err) {
    res.send(`<h3>Token exchange failed: ${err.message}</h3><p><a href="/">Back</a></p>`);
  }
}

// GET /api/attendance/status
function authStatus(req, res) { res.json({ connected: isTokenValid() }); }

// POST /api/attendance/disconnect
function disconnect(req, res) { clearTokens(); res.json({ ok: true }); }

// ── Main import handler ──────────────────────────────────────────────────────

async function importAttendance(req, res) {
  const csvFile = req.file;
  if (!csvFile) return res.status(400).json({ error: 'No CSV file uploaded' });

  const baseUrl = (req.body.baseUrl || OHRM_BASE_URL).replace(/\/$/, '');

  if (!isTokenValid()) {
    fs.unlink(csvFile.path, () => {});
    return res.status(401).json({ error: 'not_connected', message: 'Please connect to OrangeHRM first' });
  }

  const { sessionId, emitter } = createSession();
  function emit(type, text, extra = {}) { emitter.emit('line', { type, text, ...extra }); }

  (async () => {
    try {
      emit('info', `Parsing CSV file: ${csvFile.originalname}`);
      let records, csvErrors;
      try {
        ({ records, errors: csvErrors } = parseFile(csvFile.path));
      } catch (err) {
        emit('error', `CSV parse failed: ${err.message}`);
        emitter.emit('done');
        return;
      }

      emit('info', `Found ${records.length} valid record(s), ${csvErrors.length} skipped row(s)`);
      for (const e of csvErrors) {
        emit('warn', `  Line ${e.line}${e.employeeId ? ` [${e.employeeId}]` : ''}: ${e.error}`);
      }

      if (records.length === 0) { emit('error', 'No valid records to import'); emitter.emit('done'); return; }

      emit('info', `Importing ${records.length} record(s) into ${baseUrl} ...`);

      let succeeded = 0, failed = 0;
      const empCache = new Map();

      for (const record of records) {
        const tag = `Line ${record.line} [${record.employeeId}]`;

        let empNumber;
        try {
          if (empCache.has(record.employeeId)) {
            empNumber = empCache.get(record.employeeId);
          } else {
            empNumber = await resolveEmpNumber(baseUrl, record.employeeId);
            empCache.set(record.employeeId, empNumber);
          }
        } catch (err) {
          emit('error', `${tag} — employee lookup: ${err.message}`);
          failed++; continue;
        }

        try {
          await createAttendanceRecord(baseUrl, {
            empNumber,
            punchInDate:  record.punchInDate,
            punchInTime:  record.punchInTime,
            punchInNote:  record.punchInNote,
            punchOutDate: record.punchOutDate,
            punchOutTime: record.punchOutTime,
            punchOutNote: record.punchOutNote,
          });
          emit('success', `${tag} — ${record.punchInDate} ${record.punchInTime} → ${record.punchOutDate} ${record.punchOutTime}`);
          succeeded++;
        } catch (err) {
          emit('error', `${tag} — ${err.message}`);
          failed++;
        }
      }

      emit('divider', '──────────────────────────────────');
      emit('summary', `Import complete — ${succeeded} succeeded, ${failed} failed`, { succeeded, failed });

    } catch (err) {
      emit('error', `Unexpected error: ${err.message}`);
    } finally {
      fs.unlink(csvFile.path, () => {});
      emitter.emit('done');
      setTimeout(() => deleteSession(sessionId), 120_000);
    }
  })();

  res.json({ sessionId });
}

// ── SSE stream ───────────────────────────────────────────────────────────────

function attendanceStream(req, res) {
  const emitter = getSession(req.params.sessionId);
  if (!emitter) return res.status(404).json({ error: 'Session not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const onLine = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  const onDone = () => { res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`); cleanup(); res.end(); };
  function cleanup() { emitter.off('line', onLine); emitter.off('done', onDone); }

  emitter.on('line', onLine);
  emitter.on('done', onDone);
  req.on('close', cleanup);
}

module.exports = { connect, importAttendance, attendanceStream, oauthStart, oauthCallback, authStatus, disconnect };
