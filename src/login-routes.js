// Dashboard login HTTP routes, mountable so tests drive the same code
// server.js serves.
//
//   mountLoginRoutes(app, deps)  — public (before the auth middleware):
//     GET  /login, /login.js          the login page
//     POST /login                     static-token form            (via 'token')
//     GET  /login/auto?token=         host-local auto-login         (via 'token')
//     GET  /login/once?k=             one-time login link           (via 'login-link')
//     GET  /login/challenge/info      → { providers: [{ id, label }], tokenLogin: true }
//     POST /login/challenge/start     { replaces? } → { nonce, code, expiresInMs,
//                                       providers: [{ id, label, link, qrSvg }] }
//     POST /login/challenge/poll      { nonce } → { status: 'pending'|'expired'|'denied'|'ok' }
//                                     long-polls ≤ 25 s; 'ok' sets the sid cookie
//   mountLoginApi(app, deps)     — owner-only (after the auth middleware):
//     GET/DELETE /api/sessions, DELETE /api/sessions/:id, POST /api/logout,
//     POST /api/login/login-link (host-local internal header only)
//
// deps: { login (src/login.js), authToken, authCookie(name, value, extra),
//         authLimiter, isLoopback(req), isInternal(req), getSidFromCookies,
//         safeEqual, publicDir, pollHoldMs?, maxHeldPolls? }

const path = require('path');
const express = require('express');
const QRCode = require('qrcode');

const POLL_HOLD_MS = 25 * 1000;
const MAX_HELD_POLLS = 50;
const NONCE_RE = /^[0-9a-f]{32}$/;

function mountLoginRoutes(app, deps) {
  const {
    login, authToken, authCookie, authLimiter, isLoopback, safeEqual, publicDir,
    pollHoldMs = POLL_HOLD_MS, maxHeldPolls = MAX_HELD_POLLS,
  } = deps;
  // The login page posts JSON before any auth; parse it here too so the routes
  // never depend on a global parser's position.
  const json = express.json({ limit: '4kb' });
  const ua = (req) => req.headers['user-agent'];
  const emit = (req, fields) => login.emitLogin({
    via: fields.via, ip: fields.ip ?? req.ip ?? null, ua: fields.ua ?? ua(req) ?? null,
    sessionId: fields.sessionId ?? null, code: fields.code ?? null,
    external: !isLoopback(req),
  });

  app.get('/login', (req, res) => {
    res.sendFile(path.join(publicDir, 'login.html'));
  });
  // The login page's script (no inline script under the CSP).
  app.get('/login.js', (req, res) => {
    res.sendFile(path.join(publicDir, 'login.js'));
  });

  // The static token is a credential for every caller, local or external.
  app.post('/login', authLimiter, express.urlencoded({ extended: false }), json, (req, res) => {
    if (safeEqual(req.body?.token, authToken)) {
      res.setHeader('Set-Cookie', authCookie('token', authToken));
      emit(req, { via: 'token' });
      return res.redirect('/');
    }
    res.redirect('/login?error=1');
  });

  app.get('/login/auto', authLimiter, (req, res) => {
    if (!isLoopback(req)) return res.redirect('/login');
    if (safeEqual(req.query.token, authToken)) {
      res.setHeader('Set-Cookie', authCookie('token', authToken));
      emit(req, { via: 'token' });
      return res.redirect('/');
    }
    res.redirect('/login');
  });

  // One-time login link redemption (minted host-locally via `vistaclair login-link`)
  app.get('/login/once', authLimiter, (req, res) => {
    const s = login.redeemOneTimeLink(req.query.k, { ip: req.ip, ua: ua(req) });
    if (!s) return res.redirect('/login');
    res.setHeader('Set-Cookie', authCookie('sid', s.sid));
    emit(req, { via: 'login-link', sessionId: s.sessionId });
    res.redirect('/');
  });

  // --- Challenges (providers registered by add-ons approve them) ---

  app.get('/login/challenge/info', (req, res) => {
    res.json({ providers: login.listProviders(), tokenLogin: true });
  });

  app.post('/login/challenge/start', authLimiter, json, async (req, res) => {
    const replaces = typeof req.body?.replaces === 'string' ? req.body.replaces : undefined;
    const ch = login.startChallenge({ ip: req.ip, ua: ua(req), replaces });
    if (!ch) return res.status(429).json({ error: 'Too many pending logins' });
    const providers = [];
    for (const p of login.providerLinks(ch.code)) {
      try {
        const qrSvg = await QRCode.toString(p.link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        providers.push({ id: p.id, label: p.label, link: p.link, qrSvg });
      } catch (e) {
        console.error(`  login: QR for provider "${p.id}" failed:`, e.message);
      }
    }
    res.json({ nonce: ch.nonce, code: ch.code, expiresInMs: ch.expiresInMs, providers });
  });

  let heldPolls = 0;
  app.post('/login/challenge/poll', json, (req, res) => {
    const nonce = typeof req.body?.nonce === 'string' && NONCE_RE.test(req.body.nonce) ? req.body.nonce : null;
    const answer = (result) => {
      if (result === 'pending' || result === 'expired' || result === 'denied') return res.json({ status: result });
      res.setHeader('Set-Cookie', authCookie('sid', result.sid));
      emit(req, { via: result.via, ip: result.ip, ua: result.ua, sessionId: result.sessionId, code: result.code });
      res.json({ status: 'ok' });
    };
    if (!nonce) return res.json({ status: 'expired' });
    const first = login.pollChallenge(nonce);
    if (first !== 'pending' || heldPolls >= maxHeldPolls) return answer(first);

    // Hold until the challenge changes, it expires, or the hold ends.
    heldPolls++;
    let done = false;
    const release = () => {
      if (done) return false;
      done = true;
      heldPolls--;
      clearTimeout(timer);
      unwatch();
      return true;
    };
    const settle = () => { if (release()) answer(login.pollChallenge(nonce)); };
    const unwatch = login.watchChallenge(nonce, () => setImmediate(settle));
    const timer = setTimeout(settle, Math.min(pollHoldMs, login.challengeTimeLeft(nonce) + 20));
    // Client gone: free the slot. Listen on the response — the request's
    // 'close' fires as soon as its body has been read.
    res.on('close', () => { if (!res.writableEnded) release(); });
  });
}

function mountLoginApi(app, deps) {
  const { login, authCookie, isInternal, getSidFromCookies } = deps;

  app.get('/api/sessions', (req, res) => {
    res.json({ sessions: login.listSessions(getSidFromCookies(req.headers.cookie)) });
  });

  app.delete('/api/sessions/:id', (req, res) => {
    res.json({ ok: login.revokeSession(req.params.id) });
  });

  app.delete('/api/sessions', (req, res) => {
    // "Log out everywhere" keeps the caller's own session unless ?all=1
    login.revokeAll(req.query.all === '1' ? {} : { exceptSid: getSidFromCookies(req.headers.cookie) });
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    const sid = getSidFromCookies(req.headers.cookie);
    const s = sid && login.getSession(sid);
    if (s) login.revokeSession(s.id);
    res.setHeader('Set-Cookie', [
      authCookie('sid', '', '; Max-Age=0'),
      authCookie('token', '', '; Max-Age=0'),
    ]);
    res.json({ ok: true });
  });

  // Break-glass: mint a one-time login URL. Loopback + internal header only, so
  // it is reachable exclusively from the host itself (`vistaclair login-link`).
  app.post('/api/login/login-link', (req, res) => {
    if (!isInternal(req)) return res.status(403).json({ error: 'Host-local only' });
    const key = login.createOneTimeLink();
    res.json({ path: `/login/once?k=${key}`, expiresInMs: login.LINK_TTL_MS });
  });
}

module.exports = { mountLoginRoutes, mountLoginApi, POLL_HOLD_MS, MAX_HELD_POLLS };
