'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const agent = new https.Agent({ rejectUnauthorized: false });

// ── In-memory token + connection store ───────────────────────────────────────
let _accessToken  = null;
let _refreshToken = null;
let _tokenExpiry  = 0;
let _baseUrl      = '';

function setTokens({ access_token, refresh_token, expires_in }, baseUrl) {
  _accessToken  = access_token;
  _refreshToken = refresh_token || null;
  _tokenExpiry  = Date.now() + (expires_in ? (expires_in - 60) * 1000 : 3600 * 1000);
  if (baseUrl) _baseUrl = baseUrl;
}

function isTokenValid() { return !!_accessToken && Date.now() < _tokenExpiry; }

function clearTokens() {
  _accessToken  = null;
  _refreshToken = null;
  _tokenExpiry  = 0;
  _baseUrl      = '';
}

function getConnectionInfo() {
  return { baseUrl: _baseUrl, connected: isTokenValid() };
}

// ── Low-level HTTP/HTTPS wrapper ─────────────────────────────────────────────

async function rawRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url     = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const bodyStr = options.body || '';

    const reqOptions = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method:   options.method || 'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':          'text/html,application/xhtml+xml,application/json,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {}),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr).toString() } : {}),
      },
      agent: isHttps ? agent : undefined,
    };

    const req = lib.request(reqOptions, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end',  () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function parseCookies(h) {
  const jar = {};
  if (!h) return jar;
  for (const s of (Array.isArray(h) ? h : [h])) {
    const p = s.split(';')[0].trim();
    const i = p.indexOf('=');
    if (i > 0) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── Auto-create OAuth2 client using admin session cookies ────────────────────
// OrangeHRM's Vue SPA calls /api/v2/admin/oauth-clients with the session cookie
// and XSRF-TOKEN, so we replicate that here after a successful admin login.

async function autoCreateOAuthClient(baseUrl, jar) {
  const PORT = process.env.PORT || 4000;
  const redirectUri = `http://localhost:${PORT}/oauth/callback`;

  const xsrfToken = decodeURIComponent(jar['XSRF-TOKEN'] || jar['xsrf-token'] || '');
  const headers = {
    'Content-Type':     'application/json',
    'Accept':           'application/json',
    'Cookie':           cookieHeader(jar),
    'X-Requested-With': 'XMLHttpRequest',
    'Referer':          `${baseUrl}/web/index.php/admin/oauth-clients`,
    'Origin':           baseUrl,
  };
  if (xsrfToken) headers['X-XSRF-TOKEN'] = xsrfToken;

  // Try a fixed name first; fall back to a timestamped name to avoid duplicate conflicts
  const names = ['AttendanceImporter', `AttendanceImporter_${Date.now()}`];

  for (const name of names) {
    let resp;
    try {
      resp = await rawRequest(`${baseUrl}/web/index.php/api/v2/admin/oauth-clients`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name, redirectUri, enabled: true, confidential: true }),
      });
    } catch (err) {
      throw new Error(`Network error reaching OAuth client API: ${err.message}`);
    }

    if (resp.status === 200 || resp.status === 201) {
      let parsed;
      try { parsed = JSON.parse(resp.body); } catch { break; }
      const client       = parsed?.data;
      const clientSecret = parsed?.meta?.clientSecret;  // OrangeHRM returns secret in meta, not data
      if (client?.clientId && clientSecret) {
        return { clientId: client.clientId, clientSecret, redirectUri };
      }
    } else if (resp.status === 404) {
      throw new Error(
        'OAuth client API not found on this OrangeHRM instance. ' +
        'Please provide the Client ID and Client Secret manually in Advanced Options.'
      );
    } else if (resp.status === 401 || resp.status === 403) {
      throw new Error(
        'Session-based OAuth client creation is not supported by this instance. ' +
        'Please provide the Client ID and Client Secret manually in Advanced Options.'
      );
    }
    // 400/409/422 likely means name conflict — try next name in loop
  }

  throw new Error(
    'Could not auto-create OAuth2 client. ' +
    'Please create one in OrangeHRM (Admin → API → OAuth Clients → Add) ' +
    'and enter the Client ID and Client Secret in Advanced Options.'
  );
}

// ── Headless OAuth2: login + (auto-create client) + authorize + token ─────────

async function headlessConnect(baseUrl, username, password, clientId, clientSecret) {
  const PORT = process.env.PORT || 4000;
  const loginUrl     = `${baseUrl}/web/index.php/auth/login`;
  const validateUrl  = `${baseUrl}/web/index.php/auth/validate`;
  const authorizeUrl = `${baseUrl}/web/index.php/oauth2/authorize`;
  const tokenUrl     = `${baseUrl}/web/index.php/oauth2/token`;

  // Step 1: GET login page → session cookie + CSRF token
  const lp = await rawRequest(loginUrl, {
    headers: { 'Accept': 'text/html,application/xhtml+xml' },
  });
  if (lp.status !== 200) throw new Error(`Login page returned HTTP ${lp.status}`);

  const jar = parseCookies(lp.headers['set-cookie']);
  const tm  = lp.body.match(/:token="&quot;([^&]+)&quot;"/);
  if (!tm) throw new Error('Could not find CSRF token on login page');
  const csrfToken = tm[1];

  // Step 2: POST credentials
  const credBody = new URLSearchParams({ username, password, _token: csrfToken }).toString();
  const valResp = await rawRequest(validateUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer':      loginUrl,
      'Origin':       baseUrl,
      'Cookie':       cookieHeader(jar),
    },
    body: credBody,
  });

  Object.assign(jar, parseCookies(valResp.headers['set-cookie']));
  const valLoc = valResp.headers['location'] || '';

  if (valResp.status === 302 && valLoc.includes('auth/login')) {
    throw new Error('OrangeHRM rejected the credentials — check username and password');
  }

  // Step 3: Follow post-login redirect to establish full session (sets XSRF-TOKEN cookie)
  if (valResp.status === 302 && valLoc) {
    const rUrl = valLoc.startsWith('http') ? valLoc : `${baseUrl}${valLoc}`;
    const rResp = await rawRequest(rUrl, {
      headers: { 'Cookie': cookieHeader(jar), 'Accept': 'text/html' },
    });
    Object.assign(jar, parseCookies(rResp.headers['set-cookie']));
  }

  // Step 4: Obtain OAuth2 client credentials
  // If user provided them manually, use those; otherwise auto-create via admin session
  let effectiveClientId     = clientId;
  let effectiveClientSecret = clientSecret;
  let redirectUri           = `http://localhost:${PORT}/oauth/callback`;

  if (!effectiveClientId || !effectiveClientSecret) {
    const created = await autoCreateOAuthClient(baseUrl, jar);
    effectiveClientId     = created.clientId;
    effectiveClientSecret = created.clientSecret;
    redirectUri           = created.redirectUri;
  }

  // Step 5: GET /oauth2/authorize with session cookie → code (or consent page)
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id:     effectiveClientId,
    redirect_uri:  redirectUri,
  });

  const authResp = await rawRequest(`${authorizeUrl}?${authParams}`, {
    headers: { 'Cookie': cookieHeader(jar), 'Accept': 'text/html' },
  });

  Object.assign(jar, parseCookies(authResp.headers['set-cookie']));
  const authLoc = authResp.headers['location'] || '';

  let code;

  if (authResp.status === 302 && authLoc.includes('code=')) {
    const u = new URL(authLoc.startsWith('http') ? authLoc : `http://dummy${authLoc}`);
    code = u.searchParams.get('code');
  } else if (authResp.status === 200 && authResp.body.includes('oauth-authorize')) {
    // Check for an inline error (e.g. invalid_client) before attempting consent
    const errorTypeMatch = authResp.body.match(/error-type="&quot;([^&]+)&quot;"/);
    if (errorTypeMatch) {
      throw new Error(`OAuth2 authorization error: ${errorTypeMatch[1]} — the OAuth2 client may be invalid or not registered on this instance`);
    }

    // Consent page (Vue SPA) — extract params from component props and approve
    const paramsMatch = authResp.body.match(/:params="({[^"]+})"/);
    const consentParams = new URLSearchParams({ authorized: 'true' });

    if (paramsMatch) {
      try {
        const jsonStr = paramsMatch[1]
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&#x2F;/g, '/')
          .replace(/\\\//g, '/');
        const params = JSON.parse(jsonStr);
        for (const [k, v] of Object.entries(params)) consentParams.set(k, v);
      } catch { /* fall through with just authorized=true */ }
    } else {
      for (const [k, v] of authParams.entries()) consentParams.set(k, v);
    }

    const consentUrl = `${baseUrl}/web/index.php/oauth2/authorize/consent?${consentParams}`;
    const consentResp = await rawRequest(consentUrl, {
      headers: { 'Cookie': cookieHeader(jar), 'Referer': `${authorizeUrl}?${authParams}` },
    });

    const consentLoc = consentResp.headers['location'] || '';
    if (consentResp.status === 302 && consentLoc.includes('code=')) {
      const u = new URL(consentLoc.startsWith('http') ? consentLoc : `http://dummy${consentLoc}`);
      code = u.searchParams.get('code');
    } else {
      throw new Error(`OAuth2 consent failed (HTTP ${consentResp.status}). Location: ${consentLoc.substring(0, 100)}`);
    }
  } else {
    throw new Error(`Unexpected OAuth2 authorize response (HTTP ${authResp.status})`);
  }

  if (!code) throw new Error('No authorization code received from OrangeHRM');

  // Step 6: Exchange code for access token
  const tokenBody = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     effectiveClientId,
    client_secret: effectiveClientSecret,
    code,
    redirect_uri:  redirectUri,
  }).toString();

  const tokResp = await rawRequest(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody,
  });

  let tokenData;
  try { tokenData = JSON.parse(tokResp.body); } catch { throw new Error('Invalid token response from OrangeHRM'); }

  if (tokResp.status !== 200 || tokenData.error) {
    throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed');
  }

  setTokens(tokenData, baseUrl);
  return tokenData;
}

// ── OAuth2 callback handler (browser flow fallback) ──────────────────────────

async function exchangeCodeForToken(baseUrl, clientId, clientSecret, code, redirectUri) {
  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    client_id:     clientId,
    client_secret: clientSecret,
    code,
    redirect_uri:  redirectUri,
  }).toString();

  const resp = await rawRequest(`${baseUrl}/web/index.php/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  let data;
  try { data = JSON.parse(resp.body); } catch { throw new Error('Invalid token response'); }

  if (resp.status !== 200 || data.error) {
    throw new Error(data.error_description || data.error || 'Token exchange failed');
  }

  setTokens(data, baseUrl);
  return data;
}

// ── API helper (Bearer token) ─────────────────────────────────────────────────

async function apiRequest(baseUrl, method, path, bodyObj) {
  if (!isTokenValid()) throw new Error('Not connected to OrangeHRM — please connect first');

  const url = `${baseUrl}/web/index.php/api/v2${path}`;
  const options = {
    method,
    headers: {
      'Accept':        'application/json',
      'Authorization': `Bearer ${_accessToken}`,
    },
  };
  if (bodyObj) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(bodyObj);
  }

  const resp = await rawRequest(url, options);

  if (resp.status === 401) { clearTokens(); throw new Error('Session expired — please reconnect OrangeHRM'); }

  let data;
  try { data = JSON.parse(resp.body); } catch { data = { raw: resp.body }; }

  return { status: resp.status, data };
}

// ── Employee lookup ───────────────────────────────────────────────────────────

async function resolveEmpNumber(baseUrl, employeeId) {
  const { status, data } = await apiRequest(
    baseUrl, 'GET',
    `/pim/employees?employeeId=${encodeURIComponent(employeeId)}&limit=1`,
    null
  );

  if (status !== 200) throw new Error(`Employee lookup failed (HTTP ${status})`);

  const list = data?.data;
  if (!Array.isArray(list) || list.length === 0) throw new Error(`Employee not found: "${employeeId}"`);
  return list[0].empNumber;
}

// ── Create attendance record (punch-in then punch-out) ───────────────────────

async function createAttendanceRecord(baseUrl, params) {
  const {
    empNumber, punchInDate, punchInTime, punchInNote,
    punchOutDate, punchOutTime, punchOutNote,
    timezoneOffset = 0,
    timezoneName   = 'UTC',
  } = params;

  const { status: s1, data: d1 } = await apiRequest(
    baseUrl, 'POST',
    `/attendance/employees/${empNumber}/records`,
    { date: punchInDate, time: punchInTime, note: punchInNote || '', timezoneOffset, timezoneName }
  );

  if (s1 !== 200 && s1 !== 201) {
    const msg = d1?.error?.message || d1?.message || JSON.stringify(d1);
    throw new Error(`Punch-in failed: ${msg}`);
  }

  const { status: s2, data: d2 } = await apiRequest(
    baseUrl, 'PUT',
    `/attendance/employees/${empNumber}/records`,
    { date: punchOutDate, time: punchOutTime, note: punchOutNote || '', timezoneOffset, timezoneName }
  );

  if (s2 !== 200 && s2 !== 201) {
    const msg = d2?.error?.message || d2?.message || JSON.stringify(d2);
    throw new Error(`Punch-out failed: ${msg}`);
  }

  return { success: true, data: d2.data || d2 };
}

module.exports = {
  headlessConnect,
  exchangeCodeForToken,
  isTokenValid,
  clearTokens,
  getConnectionInfo,
  resolveEmpNumber,
  createAttendanceRecord,
};
