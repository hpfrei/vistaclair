const https = require('https');
const http = require('http');
const path = require('path');

let keyDir = null;
let encPath = null;
let legacyPath = null;
let secretStore = null;
let config = null;

function init(appsDir, store) {
  keyDir = appsDir;
  encPath = path.join(appsDir, '.google-oauth.enc');
  legacyPath = path.join(appsDir, '.google-oauth.json');
  secretStore = store;
  config = loadConfig();
}

function loadConfig() {
  const cfg = secretStore.readSecretFile(encPath, keyDir, {
    legacyPath,
    fallback: { clientId: '', clientSecret: '', accounts: {} },
  });
  if (!cfg.accounts) cfg.accounts = {};
  return cfg;
}

function saveConfig(cfg) {
  config = cfg || config;
  if (!config.accounts) config.accounts = {};
  secretStore.writeSecretFile(encPath, config, keyDir, { legacyPath });
}

function setCredentials(clientId, clientSecret) {
  config.clientId = clientId;
  config.clientSecret = clientSecret;
  saveConfig();
}

// `email` names the account being (re-)authorised. Its own granted scopes are
// carried forward so a re-auth never silently DROPS a capability the account
// already had; every OTHER account's scopes are none of this consent screen's
// business. Unioning across all of them — which this did — meant re-authorising
// a calendar-only account presented the owner with a second account's Gmail
// scopes, asking for more than the flow needs and training them to click
// through it. Google's own `include_granted_scopes` already merges what that
// user previously granted, server-side, which is the correct mechanism.
// OAuth `state`: random, single-use, server-side, bound to the flow the owner
// started (getAuthUrl is only reached from owner-gated paths: dashboard WS,
// the bridge, an app's ctx). The exempt callback consumes it; a missing or
// unknown state is refused, so a code minted by anyone else's consent cannot
// be injected as a platform Google account.
const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_MAX = 200;
const pendingStates = new Map(); // state -> { exp, redirectUri }
// The redirect URI the auth link carried is stored with the state: Google
// requires the code exchange to repeat it exactly, and behind a tunnel the
// callback request's own headers can spell it differently.
function issueState(redirectUri = null) {
  const now = Date.now();
  for (const [k, v] of pendingStates) if (v.exp <= now) pendingStates.delete(k);
  while (pendingStates.size >= STATE_MAX) pendingStates.delete(pendingStates.keys().next().value);
  const state = require('crypto').randomBytes(24).toString('hex');
  pendingStates.set(state, { exp: now + STATE_TTL_MS, redirectUri: redirectUri || null });
  return state;
}
// Once for a live state; always deletes it. Returns the entry
// `{ redirectUri }` (truthy) or null for a missing / unknown / reused / expired
// state.
function consumeState(state) {
  if (typeof state !== 'string' || !state) return null;
  const v = pendingStates.get(state);
  pendingStates.delete(state);
  return v && v.exp > Date.now() ? { redirectUri: v.redirectUri } : null;
}

function getAuthUrl(scopes, redirectUri, email = null) {
  if (!config.clientId) throw new Error('Google OAuth not configured. Set client ID in Apps > Setup.');
  const carried = email ? (config.accounts?.[email]?.grantedScopes || []) : [];
  const allScopes = new Set([...carried, ...scopes]);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: [...allScopes].join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: issueState(redirectUri),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

const HTTP_TIMEOUT_MS = 10000;

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const data = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const req = mod.request(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) },
      timeout: HTTP_TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error(buf)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Request to ${parsed.host} timed out`)));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Like httpPost, but hands back the status and the raw body instead of parsed
// JSON: the revoke endpoint answers 200 with an EMPTY body, which JSON.parse
// rejects, so a JSON-only helper reports every successful revoke as a failure.
function httpPostRaw(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const data = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const req = mod.request(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) },
      timeout: HTTP_TIMEOUT_MS,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => req.destroy(new Error(`Request to ${parsed.host} timed out`)));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(parsed, { method: 'GET', headers: headers || {}, timeout: HTTP_TIMEOUT_MS }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { reject(new Error(buf)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Request to ${parsed.host} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

async function exchangeCode(code, redirectUri) {
  if (!config.clientId || !config.clientSecret) {
    throw new Error('Google OAuth not configured');
  }
  const tokens = await httpPost('https://oauth2.googleapis.com/token', {
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (tokens.error) throw new Error(tokens.error_description || tokens.error);

  const userInfo = await httpGet('https://www.googleapis.com/oauth2/v2/userinfo', {
    Authorization: `Bearer ${tokens.access_token}`,
  });
  const email = userInfo.email;
  if (!email) throw new Error('Could not retrieve email from Google');

  const scopeStr = tokens.scope || '';
  const grantedScopes = scopeStr.split(' ').filter(Boolean);

  config.accounts[email] = {
    tokens: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || config.accounts[email]?.tokens?.refresh_token,
      expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000,
      scope: scopeStr,
    },
    grantedScopes,
    addedAt: config.accounts[email]?.addedAt || Date.now(),
  };
  saveConfig();
  return { email, grantedScopes };
}

async function refreshAccessToken(email) {
  const account = config.accounts[email];
  if (!account?.tokens?.refresh_token) {
    throw new Error(`No refresh token for ${email}. Re-authorize.`);
  }
  const tokens = await httpPost('https://oauth2.googleapis.com/token', {
    refresh_token: account.tokens.refresh_token,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
  });
  if (tokens.error) throw new Error(tokens.error_description || tokens.error);

  account.tokens.access_token = tokens.access_token;
  account.tokens.expiry_date = Date.now() + (tokens.expires_in || 3600) * 1000;
  if (tokens.refresh_token) account.tokens.refresh_token = tokens.refresh_token;
  saveConfig();
  return account.tokens.access_token;
}

async function getAccessToken(scopes, redirectUri, targetEmail) {
  if (!config.clientId) {
    return { authRequired: true, error: 'Google OAuth not configured. Set client ID in Apps > Setup.' };
  }

  const accounts = config.accounts || {};
  const entries = targetEmail
    ? (accounts[targetEmail] ? [[targetEmail, accounts[targetEmail]]] : [])
    : Object.entries(accounts);

  const matches = entries.filter(([, account]) => {
    const granted = new Set(account.grantedScopes || []);
    return scopes.every((s) => granted.has(s));
  });

  // Without an explicit email this used to return the FIRST account whose
  // scopes covered the request — insertion order, silently. With two Google
  // accounts connected, "read the calendar" therefore read whichever one
  // happened to be added first, and the caller could not tell it had been
  // answered about the wrong mailbox. Ambiguity is a question, not a default.
  if (!targetEmail && matches.length > 1) {
    return {
      authRequired: false,
      error: `${matches.length} Google accounts can serve this request (${matches.map(([e]) => e).join(', ')}) — name the account explicitly.`,
      ambiguous: matches.map(([e]) => e),
    };
  }

  for (const [email, account] of matches) {
    if (account.tokens.expiry_date && account.tokens.expiry_date < Date.now() + 60000) {
      try {
        const newToken = await refreshAccessToken(email);
        return { accessToken: newToken, email };
      } catch (err) {
        notifyAuthExpired(email, err.message);
        return { authRequired: true, email, authUrl: getAuthUrl(scopes, redirectUri, email) };
      }
    }
    return { accessToken: account.tokens.access_token, email };
  }

  return { authRequired: true, authUrl: getAuthUrl(scopes, redirectUri) };
}

// onAuthExpired(fn(email, error)) — a stored Google account's token refresh
// failed (revoked grant, changed password, …) and the caller was bounced to
// re-auth. Feeds Horst's google:auth-expired sense. Returns an unsubscribe fn.
const authExpiredObservers = [];
function onAuthExpired(fn) {
  authExpiredObservers.push(fn);
  return () => { const i = authExpiredObservers.indexOf(fn); if (i >= 0) authExpiredObservers.splice(i, 1); };
}
function notifyAuthExpired(email, error) {
  for (const fn of authExpiredObservers) { try { fn(email, error); } catch (err) { console.warn('[google-auth] observer failed:', err.message); } }
}

function listAccounts() {
  return Object.entries(config.accounts || {}).map(([email, acc]) => ({
    email,
    grantedScopes: acc.grantedScopes || [],
    addedAt: acc.addedAt,
  }));
}

// "Revoke" used to mean "forget locally": the row was deleted and the grant
// stayed live at Google, refresh token and all, indefinitely. The owner had
// every reason to believe they had withdrawn access and they had not — the one
// place a security promise must not be aspirational.
//
// Revoking the refresh token revokes the whole grant (Google drops every token
// derived from it). The local record is dropped either way: an owner who asked
// to remove an account must not be left with it still listed because Google was
// unreachable. A failure is returned, not thrown, so the caller can say so.
async function revokeAccount(email) {
  const account = config.accounts?.[email];
  const token = account?.tokens?.refresh_token || account?.tokens?.access_token || null;

  // Google FIRST, local record second. The token is the only thing that can
  // revoke the grant, so dropping it before the call means a crash — or a
  // process restart — in between leaves the grant live at Google with nothing
  // left here to kill it with, and no sign to the owner that it happened.
  let outcome = { ok: true, revokedAtGoogle: false, reason: 'no token stored' };
  if (token) {
    try {
      const res = await httpPostRaw('https://oauth2.googleapis.com/revoke', { token });
      // 200 = revoked. 400 with invalid_token = already dead at Google, which is
      // the desired end state, so both are success.
      outcome = (res.status === 200 || /invalid_token/.test(res.body || ''))
        ? { ok: true, revokedAtGoogle: true }
        : { ok: true, revokedAtGoogle: false, reason: `Google returned ${res.status}` };
    } catch (err) {
      outcome = { ok: true, revokedAtGoogle: false, reason: err.message };
    }
  }

  // Dropped either way: an owner who asked to remove an account must not be
  // left with it still listed because Google was unreachable.
  delete config.accounts[email];
  saveConfig();
  return outcome;
}

function status() {
  return {
    configured: !!(config.clientId && config.clientSecret),
    accountCount: Object.keys(config.accounts || {}).length,
    accounts: listAccounts(),
  };
}

function getCredentials() {
  return {
    clientId: config.clientId || '',
    clientSecret: config.clientSecret || '',
  };
}

function testSetup(redirectUri) {
  const checks = { clientIdFormat: false, clientSecretPresent: false, authUrlGenerated: false, redirectUri, error: null };
  if (!config.clientId) {
    checks.error = 'Client ID is not set';
    return { ok: false, checks };
  }
  if (!config.clientSecret) {
    checks.error = 'Client Secret is not set';
    return { ok: false, checks };
  }
  checks.clientSecretPresent = true;
  if (!/^\d+.*\.apps\.googleusercontent\.com$/.test(config.clientId)) {
    checks.error = 'Client ID format is invalid. Expected: xxxx.apps.googleusercontent.com';
    return { ok: false, checks };
  }
  checks.clientIdFormat = true;
  try {
    const url = getAuthUrl(['openid', 'email'], redirectUri);
    checks.authUrlGenerated = true;
    return { ok: true, checks };
  } catch (err) {
    checks.error = err.message;
    return { ok: false, checks };
  }
}

async function testAccount(email) {
  const account = (config.accounts || {})[email];
  if (!account) return { ok: false, email, error: 'Account not found', services: {} };

  const services = { token: { ok: false }, gmail: { ok: false }, calendar: { ok: false } };
  const scopes = new Set(account.grantedScopes || []);

  try {
    await refreshAccessToken(email);
    services.token = { ok: true };
  } catch (err) {
    services.token = { ok: false, error: err.message };
    return { ok: false, email, services };
  }

  const token = account.tokens.access_token;
  const headers = { Authorization: `Bearer ${token}` };

  const hasGmail = scopes.has('https://www.googleapis.com/auth/gmail.readonly')
    || scopes.has('https://www.googleapis.com/auth/gmail.modify')
    || scopes.has('https://mail.google.com/');
  const hasCalendar = scopes.has('https://www.googleapis.com/auth/calendar')
    || scopes.has('https://www.googleapis.com/auth/calendar.readonly')
    || scopes.has('https://www.googleapis.com/auth/calendar.events')
    || scopes.has('https://www.googleapis.com/auth/calendar.events.readonly');

  const probe = async (url, defaultError) => {
    try {
      const res = await httpGet(url, headers);
      if (res.error) throw new Error(res.error.message || res.error.status || defaultError);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };

  [services.gmail, services.calendar] = await Promise.all([
    hasGmail
      ? probe('https://www.googleapis.com/gmail/v1/users/me/profile', 'Gmail API error')
      : { ok: false, missing: true },
    hasCalendar
      ? probe('https://www.googleapis.com/calendar/v3/calendars/primary', 'Calendar API error')
      : { ok: false, missing: true },
  ]);

  const allOk = services.token.ok
    && (services.gmail.ok || services.gmail.missing)
    && (services.calendar.ok || services.calendar.missing);
  return { ok: allOk, email, services };
}

module.exports = { init, setCredentials, getAuthUrl, consumeState, exchangeCode, getAccessToken, refreshAccessToken, listAccounts, revokeAccount, status, getCredentials, testSetup, testAccount, onAuthExpired };
