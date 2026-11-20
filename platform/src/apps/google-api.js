// Shared raw-https Google API helper (no googleapis dependency) used by
// email-sync-gmail.js and calendar-engine.js. Auth comes from google-auth.js;
// this module only does bearer-token JSON requests with status-aware errors
// (sync code needs err.status to detect 404/410 history/syncToken expiry).
const https = require('https');
const googleAuth = require('./google-auth');
const { core } = require('./core-services');

const SCOPES = {
  gmail: ['https://www.googleapis.com/auth/gmail.modify'],
  gmailSend: ['https://www.googleapis.com/auth/gmail.send'],
  calendar: ['https://www.googleapis.com/auth/calendar'],
};

// The platform's ONE public-URL setting (Setup → Telegram "Public URL"), no
// trailing slash; '' when unset. Google sign-in links use it so a link opened
// on another device (the owner reaches Vistaclair through a tunnel) lands on
// the platform, not on that device's localhost.
function publicBase() {
  try { return String(require('./telegram').getPublicUrl() || '').trim().replace(/\/+$/, ''); } catch { return ''; }
}

function redirectUri() {
  // ONE redirect URI for the whole flow: the public URL when one is set, else
  // the DASHBOARD's port, because that is where the Pro router mounts the
  // callback and what Setup shows the owner to paste into the Google console —
  // a second spelling elsewhere just produces a consent link Google refuses
  // with redirect_uri_mismatch.
  const base = publicBase();
  if (base) return `${base}/pro/auth/google/callback`;
  const port = core.dashboardPort || process.env.DASHBOARD_PORT || 3457;
  return `http://localhost:${port}/pro/auth/google/callback`;
}

// Returns an access token or throws an Error with .authRequired (+ .authUrl).
async function getToken(scopes, email) {
  const result = await googleAuth.getAccessToken(scopes, redirectUri(), email);
  if (result.accessToken) return result.accessToken;
  const err = new Error(result.error || `Google authorization required for ${email}`);
  // "Two accounts could answer this — name one" is a caller mistake, not an
  // expired grant. Flagging it authRequired sends the caller off to re-consent
  // an account that works (email-sync-gmail reads exactly this flag to decide)
  // and buries the one sentence that says what to fix.
  if (result.ambiguous) err.ambiguous = result.ambiguous;
  else err.authRequired = true;
  if (result.authUrl) err.authUrl = result.authUrl;
  throw err;
}

function request(method, url, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = body !== undefined ? JSON.stringify(body) : null;
    const headers = { Authorization: `Bearer ${token}` };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request(parsed, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        const message = json?.error?.message || json?.error_description
          || (text ? text.slice(0, 300) : `HTTP ${res.statusCode}`);
        const err = new Error(`${method} ${parsed.pathname}: ${message}`);
        err.status = res.statusCode;
        err.reason = json?.error?.errors?.[0]?.reason || json?.error?.status || null;
        reject(err);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const get = (url, token) => request('GET', url, { token });
const post = (url, token, body) => request('POST', url, { token, body });
const put = (url, token, body) => request('PUT', url, { token, body });
const del = (url, token) => request('DELETE', url, { token });

// Consent link for a NEW account (Setup → Google → Connect). openid + email so
// the callback's userinfo lookup can name the account, plus every scope the
// email and calendar engines ask for, taken from SCOPES above.
function connectScopes() {
  return ['openid', 'email', ...Object.values(SCOPES).flat()];
}
function connectAuthUrl(redirect) {
  return googleAuth.getAuthUrl(connectScopes(), redirect || redirectUri());
}

module.exports = { SCOPES, publicBase, redirectUri, connectScopes, connectAuthUrl, getToken, request, get, post, put, del };
