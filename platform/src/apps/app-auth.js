// Turnkey multi-user auth for apps. A manifest `auth` flag is all an app needs:
//
//   "auth": { "email": true, "telegram": true,
//             "sender": "me@example.com",      // required when email:true
//             "license": "buddy" }             // optional licence gating (app-license.js)
//
// Gate exemptions are declared in the manifest's `surfaces.public.api`
// (legacy `auth.publicRoutes` still normalizes — see surfaces.js).
//
// At mount time the platform (app-manager.mountRoutes) calls mount() which:
//   1. provisions the app's own `accounts` + `email_verifications` tables,
//   2. mounts /api/auth/* (signup, verify, login, link, attach-email, me, logout),
//   3. installs a DEFAULT-DENY guard on every /api/* route except /api/auth/* and
//      the declared surfaces.public.api prefixes — an un-gated data route is
//      opt-OUT, not opt-in.
//
// One `accounts` row = one human. `email`, `tg_user_id` and `wa_id` are linkable
// credentials on the same row, so a user can sign in by any and land on the same
// data. The platform session token (ctx.identity.issueSession) carries the opaque
// account id.
//
// Security: this is the highest-risk code in the app surface, so it lives here once,
// audited, rather than being copy-pasted per app. Passwords are scrypt-hashed
// (ctx.identity.hashPassword); verification tokens are random; redeem is rate-limited
// by the platform identity layer. The module needs the FULL ctx (email.send for
// verification), so app-manager mounts it before downgrading a public app's ctx.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MIN_PASSWORD = 8;

// Per-(app,email/ip) login/signup throttle — blunts credential stuffing. The
// identity layer already throttles link-code redeem; this guards password tries.
const attempts = new Map(); // key -> { count, resetAt }
const ATTEMPT_WINDOW_MS = 60 * 1000;
const ATTEMPT_MAX = 12;
function throttled(key) {
  const now = Date.now();
  let t = attempts.get(key);
  if (!t || t.resetAt <= now) { t = { count: 0, resetAt: now + ATTEMPT_WINDOW_MS }; attempts.set(key, t); }
  t.count++;
  return t.count > ATTEMPT_MAX;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     email VARCHAR(255) UNIQUE NULL,
     password_hash VARCHAR(255) NULL,
     email_verified TINYINT NOT NULL DEFAULT 0,
     tg_user_id BIGINT UNIQUE NULL,
     wa_id VARCHAR(32) UNIQUE NULL,
     display_name VARCHAR(255) NULL,
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   )`,
  // Back-fill wa_id on installs whose accounts table predates WhatsApp support.
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS wa_id VARCHAR(32) UNIQUE NULL`,
  // Licence key this account claimed (manifest auth.license apps; harmless
  // elsewhere). The ONLY licensing state persisted app-side — status/tier/
  // expiry are mastered on the licence server and cached in memory.
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS license_key VARCHAR(64) NULL`,
  // Platform-owner auto-login: the dashboard admin's owner credentials resolve
  // (via:'owner') to the single is_owner=1 row, provisioned on first touch —
  // no signup. See findOrCreateOwnerAccount / accountFromIdentity.
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_owner TINYINT NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS email_verifications (
     token VARCHAR(64) PRIMARY KEY,
     account_id BIGINT NOT NULL,
     expires_at DATETIME NOT NULL,
     INDEX (account_id)
   )`,
];

async function findAccountById(ctx, id) {
  const rows = await ctx.dbQuery('SELECT * FROM accounts WHERE id=?', [id]);
  return rows[0] || null;
}
async function findAccountByEmail(ctx, email) {
  const rows = await ctx.dbQuery('SELECT * FROM accounts WHERE email=?', [String(email).toLowerCase()]);
  return rows[0] || null;
}
async function findAccountByTg(ctx, tgId) {
  const rows = await ctx.dbQuery('SELECT * FROM accounts WHERE tg_user_id=?', [String(tgId)]);
  return rows[0] || null;
}

// Find-or-create the account for a resolved Telegram user. Used by the link flow
// and by the app's own entry-surface routes (via ctx.auth.accountForTelegram).
async function findOrCreateTgAccount(ctx, tgUser) {
  const tgId = String(tgUser.id);
  let acct = await findAccountByTg(ctx, tgId);
  if (acct) return acct;
  const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ')
    || tgUser.username || ('User ' + tgId);
  await ctx.dbQuery('INSERT INTO accounts (tg_user_id, display_name) VALUES (?,?)', [tgId, name]);
  return await findAccountByTg(ctx, tgId);
}

async function findAccountByWa(ctx, waId) {
  const rows = await ctx.dbQuery('SELECT * FROM accounts WHERE wa_id=?', [String(waId)]);
  return rows[0] || null;
}

// Find-or-create the account for a WhatsApp user (keyed by wa_id / phone). The
// WhatsApp analog of findOrCreateTgAccount. `name` is the optional profile name.
async function findOrCreateWaAccount(ctx, waId, name) {
  const id = String(waId);
  let acct = await findAccountByWa(ctx, id);
  if (acct) return acct;
  await ctx.dbQuery('INSERT INTO accounts (wa_id, display_name) VALUES (?,?)', [id, name || ('User ' + id)]);
  return await findAccountByWa(ctx, id);
}

// Find-or-create the app's single platform-owner account — the row the
// dashboard admin's owner credentials resolve to (identity.resolve via:'owner').
// Serialized per app so concurrent first requests can't double-insert; both
// racers converge on the lowest-id owner row either way (ORDER BY id).
const ownerInflight = new Map(); // appName -> Promise<account>
function findOrCreateOwnerAccount(ctx) {
  const key = ctx.appName;
  if (ownerInflight.has(key)) return ownerInflight.get(key);
  const p = (async () => {
    const rows = await ctx.dbQuery('SELECT * FROM accounts WHERE is_owner=1 ORDER BY id LIMIT 1');
    if (rows[0]) return rows[0];
    await ctx.dbQuery('INSERT INTO accounts (display_name, is_owner) VALUES (?,1)', ['Admin']);
    const fresh = await ctx.dbQuery('SELECT * FROM accounts WHERE is_owner=1 ORDER BY id LIMIT 1');
    return fresh[0] || null;
  })().finally(() => ownerInflight.delete(key));
  ownerInflight.set(key, p);
  return p;
}

function publicAccount(a) {
  if (!a) return null;
  return {
    id: a.id,
    email: a.email || null,
    emailVerified: !!a.email_verified,
    telegramLinked: a.tg_user_id != null,
    whatsappLinked: a.wa_id != null,
    displayName: a.display_name || null,
    isOwner: !!a.is_owner,
  };
}

// Map a resolved identity ({userId, via, user, channel}) to an account row.
//   owner              → the auto-provisioned admin account
//   telegram initData  → find-or-create by tg id
//   session + channel  → find-or-create by THAT channel's id (a token issued by
//                        the app with `issueSession(id, { via })` — the classic
//                        "users.id = Telegram id" apps and WhatsApp web sign-in)
//   session, untagged  → the token carries the account id directly
// The two session cases never fall back into each other: an untagged Telegram
// id must not resolve to whichever account row shares the number.
// Returns null if a session points at a deleted account.
async function accountFromIdentity(ctx, resolved) {
  if (!resolved) return null;
  if (resolved.via === 'owner') {
    // Platform owner (dashboard cookie / internal header) — auto-provisioned admin account.
    return await findOrCreateOwnerAccount(ctx);
  }
  if (resolved.via === 'telegram' && resolved.user) {
    return await findOrCreateTgAccount(ctx, resolved.user);
  }
  if (resolved.via === 'session' && resolved.channel === 'telegram') {
    return await findOrCreateTgAccount(ctx, { id: resolved.userId });
  }
  if (resolved.via === 'session' && resolved.channel === 'whatsapp') {
    return await findOrCreateWaAccount(ctx, resolved.userId);
  }
  return await findAccountById(ctx, resolved.userId);
}

async function mount(appRouter, ctx, manifest) {
  const auth = (manifest && manifest.auth) || {};
  const base = ctx.basePath || `/apps/${ctx.appName}`;
  const sender = auth.sender || null;
  // Guard exemptions come from the manifest's surfaces declaration
  // (surfaces.public.api; legacy auth.publicRoutes is normalized in there).
  const publicRoutes = require('./surfaces').publicApiPrefixes(manifest);
  // Licence gating (pure parse — never touches the licence server at mount time).
  const appLicense = require('./app-license');
  const licenseCfg = appLicense.parseManifest(auth.license);
  if (licenseCfg && !(auth.email || auth.telegram || auth.whatsapp)) {
    console.warn(`[app:${ctx.appName}] auth.license is set but no login method (email/telegram/whatsapp) is enabled — no user can sign in to claim a licence`);
  }
  const licenseGate = licenseCfg ? appLicense.gate(ctx, licenseCfg) : null;

  await ctx.ensureSchema(SCHEMA);

  // Expose account helpers so the app's own routes (and the migrated my-gym) can
  // resolve req → account without re-implementing the credential mapping.
  ctx.auth = {
    findOrCreateTgAccount: (tgUser) => findOrCreateTgAccount(ctx, tgUser),
    accountForTelegram: (tgUser) => findOrCreateTgAccount(ctx, tgUser),
    findOrCreateWaAccount: (waId, name) => findOrCreateWaAccount(ctx, waId, name),
    accountForWhatsapp: (waId, name) => findOrCreateWaAccount(ctx, waId, name),
    accountById: (id) => findAccountById(ctx, id),
    accountForOwner: () => findOrCreateOwnerAccount(ctx),
    publicAccount,
    // Express middleware: 401 unless authenticated; sets req.account + req.appUser.
    require: async (req, res, next) => {
      try {
        const resolved = ctx.identity.resolve(req);
        const acct = await accountFromIdentity(ctx, resolved);
        if (!acct) { res.status(401).json({ error: 'not_authenticated' }); return; }
        req.account = acct;
        req.appUser = { id: acct.id, accountId: acct.id, via: resolved.via, telegram: resolved.user || null };
        next();
      } catch (err) { res.status(500).json({ error: err.message }); }
    },
  };

  const ip = (req) => (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'ip').toString().split(',')[0].trim();

  // --- /api/auth endpoints -------------------------------------------------
  const r = require('express').Router();
  r.use(require('express').json({ limit: '256kb' }));

  // POST /api/auth/signup {email,password}
  r.post('/signup', async (req, res) => {
    if (!auth.email) return res.status(404).json({ error: 'email_signup_disabled' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: 'weak_password', minLength: MIN_PASSWORD });
    if (throttled(`signup:${ip(req)}`)) return res.status(429).json({ error: 'rate_limited' });
    const existing = await findAccountByEmail(ctx, email);
    if (existing) return res.status(409).json({ error: 'email_taken' });
    const hash = ctx.identity.hashPassword(password);
    await ctx.dbQuery('INSERT INTO accounts (email, password_hash, display_name) VALUES (?,?,?)',
      [email, hash, email.split('@')[0]]);
    const acct = await findAccountByEmail(ctx, email);
    await sendVerification(ctx, acct, sender, base, req);
    const out = { ok: true, message: 'check_email' };
    if (licenseCfg && req.body?.licenseKey) {
      // Optional key at signup. Best-effort: a bad key must never fail signup —
      // the account exists and can claim later via /api/auth/license/claim.
      out.license = await appLicense.claim(ctx, licenseCfg, acct.id, req.body.licenseKey)
        .catch((err) => ({ ok: false, error: err.message }));
    }
    res.json(out);
  });

  // GET /api/auth/verify?token=
  r.get('/verify', async (req, res) => {
    const token = String(req.query?.token || '');
    const rows = await ctx.dbQuery('SELECT * FROM email_verifications WHERE token=?', [token]);
    const rec = rows[0];
    if (!rec || new Date(rec.expires_at).getTime() <= Date.now()) {
      return res.status(400).send('Verification link invalid or expired.');
    }
    await ctx.dbQuery('UPDATE accounts SET email_verified=1 WHERE id=?', [rec.account_id]);
    await ctx.dbQuery('DELETE FROM email_verifications WHERE account_id=?', [rec.account_id]);
    res.redirect(`${base}/?verified=1`);
  });

  // POST /api/auth/login {email,password}
  r.post('/login', async (req, res) => {
    if (!auth.email) return res.status(404).json({ error: 'email_login_disabled' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (throttled(`login:${ip(req)}:${email}`)) return res.status(429).json({ error: 'rate_limited' });
    const acct = await findAccountByEmail(ctx, email);
    // Constant-ish: always run a verify to avoid trivially leaking which emails exist.
    const ok = acct && acct.password_hash && ctx.identity.verifyPassword(password, acct.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    if (!acct.email_verified) return res.status(403).json({ error: 'email_unverified' });
    const token = ctx.identity.issueSession(acct.id);
    res.json({ ok: true, token, account: publicAccount(acct) });
  });

  // POST /api/auth/link {code} — redeem a Telegram OR WhatsApp /link code. The
  // code carries which channel it belongs to (redeemed.via), so one endpoint
  // serves both.
  //  • With a current session  → attach the channel to the CURRENT account.
  //  • Without a session        → find-or-create the channel account + session.
  r.post('/link', async (req, res) => {
    const code = String(req.body?.code || '').trim();
    const redeemed = ctx.identity.redeemLinkCode(code);
    if (!redeemed) return res.status(400).json({ error: 'invalid_code' });
    const via = redeemed.via || 'telegram';
    if (via === 'whatsapp' && !auth.whatsapp) return res.status(404).json({ error: 'whatsapp_disabled' });
    if (via === 'telegram' && !auth.telegram) return res.status(404).json({ error: 'telegram_disabled' });

    // Channel-specific column + lookups; everything else is identical.
    const col = via === 'whatsapp' ? 'wa_id' : 'tg_user_id';
    const channelId = String(redeemed.userId);
    const findByChannel = via === 'whatsapp'
      ? (id) => findAccountByWa(ctx, id)
      : (id) => findAccountByTg(ctx, id);

    const resolved = ctx.identity.resolve(req);
    const current = await accountFromIdentity(ctx, resolved);
    if (current) {
      const owner = await findByChannel(channelId);
      if (owner && owner.id !== current.id) return res.status(409).json({ error: 'already_linked' });
      if (current[col] == null) {
        await ctx.dbQuery(`UPDATE accounts SET ${col}=? WHERE id=?`, [channelId, current.id]);
      }
      const acct = await findAccountById(ctx, current.id);
      return res.json({ ok: true, account: publicAccount(acct) });
    }
    // Channel-only login (no email session yet).
    let acct = await findByChannel(channelId);
    if (!acct) {
      await ctx.dbQuery(`INSERT INTO accounts (${col}) VALUES (?)`, [channelId]);
      acct = await findByChannel(channelId);
    }
    const token = ctx.identity.issueSession(acct.id);
    res.json({ ok: true, token, account: publicAccount(acct) });
  });

  // POST /api/auth/attach-email {email,password} — TG-authenticated user adds an
  // email/password credential to their existing account.
  r.post('/attach-email', async (req, res) => {
    if (!auth.email) return res.status(404).json({ error: 'email_signup_disabled' });
    const resolved = ctx.identity.resolve(req);
    const acct = await accountFromIdentity(ctx, resolved);
    if (!acct) return res.status(401).json({ error: 'not_authenticated' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
    if (password.length < MIN_PASSWORD) return res.status(400).json({ error: 'weak_password', minLength: MIN_PASSWORD });
    const owner = await findAccountByEmail(ctx, email);
    if (owner && owner.id !== acct.id) return res.status(409).json({ error: 'already_linked' });
    const hash = ctx.identity.hashPassword(password);
    await ctx.dbQuery('UPDATE accounts SET email=?, password_hash=?, email_verified=0 WHERE id=?',
      [email, hash, acct.id]);
    const fresh = await findAccountById(ctx, acct.id);
    await sendVerification(ctx, fresh, sender, base, req);
    res.json({ ok: true, message: 'check_email', account: publicAccount(fresh) });
  });

  // GET /api/auth/me — current account + linked methods (+ licence state).
  r.get('/me', async (req, res) => {
    const resolved = ctx.identity.resolve(req);
    const acct = await accountFromIdentity(ctx, resolved);
    if (!acct) return res.status(401).json({ error: 'not_authenticated' });
    const out = { account: publicAccount(acct), via: resolved.via };
    if (licenseCfg) {
      out.license = await appLicense.getEntitlement(ctx, licenseCfg, acct);
      if (!out.license.licensed) {
        out.license = { ...out.license, checkoutUrl: await appLicense.checkoutUrl(licenseCfg).catch(() => null) };
      }
    }
    res.json(out);
  });

  // --- Licensing (manifest auth.license; see app-license.js) ---------------
  if (licenseCfg) {
    // POST /api/auth/license/claim {key} — bind a licence key to the current
    // account and take a seat on the licence server.
    r.post('/license/claim', async (req, res) => {
      const resolved = ctx.identity.resolve(req);
      const acct = await accountFromIdentity(ctx, resolved);
      if (!acct) return res.status(401).json({ error: 'not_authenticated' });
      if (throttled(`claim:${ip(req)}`)) return res.status(429).json({ error: 'rate_limited' });
      const result = await appLicense.claim(ctx, licenseCfg, acct.id, req.body?.key);
      if (result.ok) return res.json(result);
      res.status(result.error === 'license_server_unreachable' ? 503 : 400).json(result);
    });

    // POST /api/auth/license/release — drop the key and free the seat.
    r.post('/license/release', async (req, res) => {
      const resolved = ctx.identity.resolve(req);
      const acct = await accountFromIdentity(ctx, resolved);
      if (!acct) return res.status(401).json({ error: 'not_authenticated' });
      res.json(await appLicense.release(ctx, licenseCfg, acct.id));
    });

    // GET /api/auth/license/products — tier variants + checkout links. Public
    // (auth-exempt like all /api/auth/*): pricing pages need it pre-login.
    r.get('/license/products', async (req, res) => {
      res.json(await appLicense.products(licenseCfg));
    });
  }

  // POST /api/auth/logout — tokens are stateless; client drops it. No-op for symmetry.
  r.post('/logout', (req, res) => res.json({ ok: true }));

  appRouter.use('/api/auth', r);

  // --- Default-deny guard --------------------------------------------------
  // Every /api/* route except /api/auth/* and the declared surfaces.public.api
  // prefixes requires an authenticated account. This runs BEFORE the app's own /api handlers (mounted
  // after this in setup()), so a forgotten ctx.identity.require on a data route
  // still fails closed. Static assets (no /api prefix) are untouched.
  appRouter.use((req, res, next) => {
    const p = req.path || req.url || '';
    if (!p.startsWith('/api/')) return next();
    if (p.startsWith('/api/auth/')) return next();
    if (publicRoutes.some((pre) => p === pre || p.startsWith(pre.endsWith('/') ? pre : pre + '/'))) return next();
    if (!licenseGate) return ctx.auth.require(req, res, next);
    // Licensed app: authenticated AND entitled (freemium `free` tier passes).
    return ctx.auth.require(req, res, () => licenseGate(req, res, next));
  });
}

async function sendVerification(ctx, acct, sender, base, req) {
  if (!acct || !acct.email) return;
  if (!sender) { console.warn(`[app:${ctx.appName}] no sender configured — verification email skipped`); return; }
  const token = ctx.identity.randomToken(24);
  const expiresAt = new Date(Date.now() + VERIFY_TTL_MS).toISOString().slice(0, 19).replace('T', ' ');
  await ctx.dbQuery('DELETE FROM email_verifications WHERE account_id=?', [acct.id]);
  await ctx.dbQuery('INSERT INTO email_verifications (token, account_id, expires_at) VALUES (?,?,?)',
    [token, acct.id, expiresAt]);
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const link = `${proto}://${host}${base}/api/auth/verify?token=${token}`;
  try {
    await ctx.email.send({
      account: sender,
      to: acct.email,
      subject: `Verify your email for ${ctx.appName}`,
      // body/htmlBody are what send() and both transports read — `text`/`html`
      // silently produced an empty verification mail.
      body: `Confirm your email address to finish signing up:\n\n${link}\n\nThis link expires in 24 hours.`,
      htmlBody: `<p>Confirm your email address to finish signing up:</p><p><a href="${link}">Verify my email</a></p><p>This link expires in 24 hours.</p>`,
    });
  } catch (err) {
    console.warn(`[app:${ctx.appName}] verification email send failed: ${err.message}`);
  }
}

module.exports = { mount, findOrCreateTgAccount, findOrCreateWaAccount, findOrCreateOwnerAccount, accountFromIdentity, publicAccount };
