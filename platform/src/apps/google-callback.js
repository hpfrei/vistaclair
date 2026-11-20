// /pro/auth/google/callback — the auth-EXEMPT page Google redirects the popup
// to (cross-site, so no owner cookie). Everything on it is attacker-reachable:
//
//  - the query (`error`, `code`, `state`) is data, never markup: it is embedded
//    as JSON with `<`, U+2028 and U+2029 escaped, inside a nonce'd script;
//  - the response carries its own CSP (core drops its CSP for add-on routes),
//    `script-src 'nonce-…'` only, nothing else allowed;
//  - postMessage targets this page's own origin, not '*';
//  - a code is exchanged only for a live one-time `state` that getAuthUrl
//    issued when the owner started the flow (google-auth.js issueState); the
//    exchange repeats the redirect URI stored with that state, not the headers.

const crypto = require('crypto');

function embed(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function page(res, status, payload) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.status(status);
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(`<!doctype html><html><head><meta charset="utf-8"></head><body><script nonce="${nonce}">var m=${embed(payload)};try{window.opener&&window.opener.postMessage(m,location.origin)}catch(e){}window.close();</script></body></html>`);
}

const clip = (v) => String(v == null ? '' : v).slice(0, 500);

function createHandler(googleAuth) {
  return async function googleCallback(req, res) {
    const { code, error, state } = req.query;
    if (error) {
      // No side effect: render the error only. A live state is spent so it
      // cannot be replayed.
      googleAuth.consumeState(state);
      return page(res, 200, { type: 'google-auth-error', error: clip(error) });
    }
    const live = googleAuth.consumeState(state);
    if (!live) {
      return page(res, 400, { type: 'google-auth-error', error: 'Invalid or expired authorization state. Start the sign-in again from the dashboard.' });
    }
    if (!code || typeof code !== 'string') {
      return page(res, 400, { type: 'google-auth-error', error: 'Missing code parameter' });
    }
    try {
      // The URI the auth link carried (stored with the state); the request's
      // headers are only a fallback for a state issued without one.
      let redirectUri = live.redirectUri;
      if (!redirectUri) {
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        redirectUri = `${proto}://${host}/pro/auth/google/callback`;
      }
      const { email, grantedScopes } = await googleAuth.exchangeCode(code, redirectUri);
      return page(res, 200, { type: 'google-auth-success', email, scopes: grantedScopes });
    } catch (err) {
      return page(res, 200, { type: 'google-auth-error', error: clip(err.message) });
    }
  };
}

module.exports = { createHandler, embed };
