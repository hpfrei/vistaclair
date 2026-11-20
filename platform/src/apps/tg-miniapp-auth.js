// Telegram Mini App authentication — ONE implementation, shared by every Mini
// App this package serves (the CLI session app and the Vista approvals app).
//
// Mini App subtrees are auth-EXEMPT (they are opened by Telegram's webview,
// which carries no owner cookie), so each endpoint self-authenticates:
//
//   1. The client posts Telegram's signed `initData` to `<base>/auth`.
//   2. We verify the signature and freshness (app-identity.validateInitData —
//      HMAC over the sorted data-check string, 1 h max-age, timingSafeEqual)
//      and check the user is the bot's claimed owner.
//   3. We mint a short-lived opaque bearer (12 h at most), returned once and
//      thereafter sent in a per-app header. It is RE-CHECKED on every request:
//      the bot must still be restricted and the token's user still the owner,
//      so an owner change, an unclaim, un-restricting or removing the bot
//      revokes every bearer at once.
//
// Two properties are load-bearing and easy to lose:
//
//   * **Each mount gets its own token map.** A bearer minted for one Mini App
//     must not authenticate the other — they expose different capabilities
//     (driving a CLI session vs. deciding proposals). Sharing one map would
//     silently merge those two authorities.
//   * **Each mount gets its own header AND storage key.** sessionStorage and
//     request headers are global to the origin, and both apps live under
//     /pro/*, so a shared name means the two apps clobber each other's tokens.
const crypto = require('crypto');
const telegram = require('./telegram');
const appIdentity = require('./app-identity');

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
// A Mini App's initData sits in the URL hash and in screenshots, so the control
// bot's Mini Apps accept it for an hour only (app bots keep app-identity's default).
const INITDATA_MAX_AGE_S = 60 * 60;

// Where a Mini App lives, as an absolute URL, or null when no public URL is
// configured. A `web_app` button MUST be omitted rather than pointed at a dead
// link, so every caller treats null as "no button".
function miniAppUrl(appPath) {
  let base = '';
  try { base = (telegram.getPublicUrl() || '').replace(/\/+$/, ''); } catch { return null; }
  return base ? `${base}${appPath}` : null;
}

// Mounts `<base>/auth` on the router and returns the guards for every other
// route under that base. `header` is the request header the client echoes the
// bearer back in — distinct per Mini App (see above).
function mountAuth(router, base, { key, header, ttlMs = DEFAULT_TTL_MS }) {
  if (!key || !header) throw new Error('mountAuth requires { key, header }');
  const headerName = String(header).toLowerCase(); // Node lowercases incoming headers
  const tokens = new Map(); // token → { chatId, userId, expiresAt }

  function stillOwner(userId) {
    const bot = telegram.getBot(key);
    return !!bot?.restricted && telegram.isAllowed(key, userId);
  }

  function issueToken(chatId, userId) {
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, { chatId, userId, expiresAt: Date.now() + ttlMs });
    // Opportunistic sweep — no timer, so this never keeps the process alive.
    for (const [t, rec] of tokens) { if (rec.expiresAt <= Date.now()) tokens.delete(t); }
    return token;
  }

  function resolveToken(req) {
    const token = req.headers[headerName];
    if (!token) return null;
    const rec = tokens.get(token);
    if (!rec || rec.expiresAt <= Date.now()) { tokens.delete(token); return null; }
    // Revocation: still the owner of a restricted bot, or the bearer dies.
    if (!stillOwner(rec.userId)) { tokens.delete(token); return null; }
    return rec;
  }

  router.post(`${base}/auth`, (req, res) => {
    const initData = req.body?.initData;
    const user = appIdentity.validateInitData(key, initData, { maxAgeS: INITDATA_MAX_AGE_S });
    if (!user) return res.status(401).json({ error: 'invalid initData' });
    // The Mini App is only for the claimed chat of the restricted platform bot.
    // An unrestricted bot serves everyone, so it gets no Mini App at all.
    if (!stillOwner(user.id)) {
      return res.status(403).json({ error: 'not authorized for this bot' });
    }
    // For the control bot the chat id IS the user id (it is a private chat).
    res.json({ ok: true, token: issueToken(user.id, user.id) });
  });

  const authed = (handler) => async (req, res) => {
    const rec = resolveToken(req);
    if (!rec) return res.status(401).json({ error: 'unauthorized' });
    try {
      await handler(req, res, rec);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };

  return { authed, issueToken, resolveToken };
}

module.exports = { mountAuth, miniAppUrl, DEFAULT_TTL_MS, INITDATA_MAX_AGE_S };
