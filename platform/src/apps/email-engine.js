// Platform email engine — master store + always-up-to-date sync orchestrator.
// Apps never talk to a provider (Gmail/IMAP); they talk to this engine via the
// bridge (email.*) or ctx.email. The provider is the upstream origin; this is
// the system of record, kept converged by email-sync-imap / email-sync-gmail.
//
// Follows the established service seams:
//   init(appsDir, secretStore, broadcaster)   — telegram.js signature
//   conn()/idempotent schema, deferred init   — memory-service.js pattern
//   .email-engine.json plain settings         — platform-settings.js pattern
//   event dispatch                            — telegram.js dispatchUpdate pattern
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const appDb = require('./app-db');
const emailTags = require('./email-tags');
const emailAccounts = require('./email-accounts');
const embeddings = require('./embeddings');
const platformCron = require('./platform-cron');
const guard = require('./app-guard');

const DB = 'vc_platform_mail';
const EMBED_DIM = embeddings.DIM;

let appsDir = null;
let secretStore = null;
let broadcaster = null;
let _ready = false;
let _vector = false;

// Sync providers register themselves (email-sync-imap / email-sync-gmail /
// calendar-engine) so the engine can delegate cron ticks, write-through ops and
// account lifecycle without circular requires.
const providers = {};

// appName → Map<event, Set<fn>> — backend (routes.js / ctx.email.on) subscribers.
const handlers = new Map();
// appName → Set<event> — iframe subscriptions (email.subscribe bridge call).
const subscribers = new Map();

// ---------------------------------------------------------------------------
// Settings (.email-engine.json — non-secret engine config)
// ---------------------------------------------------------------------------
const SETTINGS_DEFAULTS = {
  nearEnough: 0.6,            // cosine distance cutoff for similarSearch
  gmailPollSchedule: 'every 2 minutes',
  reconcileSchedule: 'every 60 minutes',
  embedSweepSchedule: 'every 5 minutes',
  deleteSweepSchedule: 'every 1 minute',
  maintenanceSchedule: 'every 6 hours', // retention sweep cadence (runMaintenanceSweep)
  deletedPruneEnabled: false, // opt-in: hard-delete is_deleted rows past deletedPruneDays
  deletedPruneDays: 30,       // age (by deleted_at) before a flagged row is purged
  attachmentPruneEnabled: false, // opt-in: NULL cached attachment blobs past attachmentPruneDays
  attachmentPruneDays: 180,   // age (by fetched_at) before a cached blob is dropped
  sentRetentionDays: 0,       // send-log retention (platform_email_sent); 0 = keep forever
  accounts: {},               // email → { enabled, backfillDepth, folders, sentFolder, signature, signatureHtml }
};
const ACCOUNT_DEFAULTS = {
  enabled: false,             // off until Setup enables (and migration verifies)
  backfillDepth: 'all',       // 30d | 6m | 1y | all
  folders: null,              // null = auto (INBOX + SPECIAL-USE Sent/Archive/Trash/Junk)
  sentFolder: null,           // null = auto-detect via SPECIAL-USE \Sent
  // Reply signature, authored per part. Applied by email-compose at COMPOSE
  // time (not at send), so an approved proposal is byte-identical to what was
  // reviewed and nothing can double-sign. An empty signatureHtml falls back to
  // the rendering generated from the text, so hand-written HTML is optional.
  // Scope is replies Horst composes — NOT every send through ctx.email.send.
  signature: '',
  signatureHtml: '',
};

let settings = {};

function settingsPath() {
  return path.join(appsDir, '.email-engine.json');
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) || {};
  } catch {
    return {};
  }
}

function saveSettings() {
  const tmp = settingsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, settingsPath());
}

function getSetting(key) {
  return settings[key] !== undefined ? settings[key] : SETTINGS_DEFAULTS[key];
}

function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  return getSetting(key);
}

function accountSettings(email) {
  const acc = (settings.accounts || {})[email] || {};
  return { ...ACCOUNT_DEFAULTS, ...acc };
}

function setAccountSettings(email, updates) {
  if (!settings.accounts) settings.accounts = {};
  settings.accounts[email] = { ...accountSettings(email), ...updates };
  saveSettings();
  return settings.accounts[email];
}

// ---------------------------------------------------------------------------
// DB — idempotent schema, deferred until the pool is up (memory-service pattern)
// ---------------------------------------------------------------------------
async function conn() {
  const pool = appDb.getPool();
  if (!pool) throw new Error('Email engine not ready — configure database in Apps > Setup');
  const c = await pool.getConnection();
  await c.query(`USE \`${DB}\``);
  return c;
}

async function probeVector(c) {
  try {
    await c.query(`CREATE TEMPORARY TABLE _vec_probe (v VECTOR(${EMBED_DIM}))`);
    await c.query('DROP TEMPORARY TABLE _vec_probe');
    return true;
  } catch {
    return false;
  }
}

async function initSchema() {
  const pool = appDb.getPool();
  if (!pool) return false;
  const c = await pool.getConnection();
  try {
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``);
    await c.query(`USE \`${DB}\``);

    _vector = await probeVector(c);

    await c.query(`
      CREATE TABLE IF NOT EXISTS platform_email_sync (
        account VARCHAR(255) PRIMARY KEY,
        account_type ENUM('imap','gmail') NOT NULL DEFAULT 'imap',
        status ENUM('idle','backfilling','watching','error','auth_required','disabled') NOT NULL DEFAULT 'disabled',
        history_id VARCHAR(64),
        resume_uid VARCHAR(64),
        page_token TEXT,
        uidvalidity BIGINT NULL,
        condstore TINYINT DEFAULT 0,
        folder_state JSON,
        last_sync_at TIMESTAMP NULL,
        last_reconcile_at TIMESTAMP NULL,
        last_error TEXT,
        backfill_total INT DEFAULT 0,
        backfill_done INT DEFAULT 0,
        enabled TINYINT DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS platform_emails (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account VARCHAR(255) NOT NULL,
        uid VARCHAR(255) NOT NULL,
        thread_id VARCHAR(255),
        message_id VARCHAR(998),
        sender VARCHAR(998),
        recipient TEXT,
        cc TEXT,
        subject TEXT,
        body MEDIUMTEXT,
        html_body MEDIUMTEXT,
        snippet VARCHAR(998),
        date DATETIME,
        internal_date BIGINT,
        is_unread BOOLEAN DEFAULT TRUE,
        is_starred BOOLEAN DEFAULT FALSE,
        folder VARCHAR(255) DEFAULT 'INBOX',
        headers JSON,
        attachment_meta JSON,
        label_ids JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        is_deleted BOOLEAN DEFAULT FALSE,
        deleted_at TIMESTAMP NULL DEFAULT NULL,
        sync_orphan TINYINT DEFAULT 0,
        UNIQUE KEY uq_account_uid (account, uid),
        KEY idx_account_folder (account, folder),
        KEY idx_account_date (account, date DESC),
        KEY idx_account_msgid (account, message_id(191)),
        KEY idx_is_deleted (is_deleted),
        FULLTEXT KEY idx_search (subject, body, sender, recipient, cc)
      ) ENGINE=InnoDB
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS platform_email_attachments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account VARCHAR(255) NOT NULL,
        email_uid VARCHAR(255) NOT NULL,
        filename VARCHAR(500) NOT NULL,
        mime_type VARCHAR(255) DEFAULT 'application/octet-stream',
        size INT DEFAULT 0,
        content LONGBLOB,
        attachment_id VARCHAR(500),
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_account_uid (account, email_uid)
      ) ENGINE=InnoDB
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS platform_email_tombstones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account VARCHAR(255) NOT NULL,
        uid VARCHAR(255) NOT NULL,
        message_id VARCHAR(998) NULL,
        deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_account_uid (account, uid),
        KEY idx_account_msgid (account, message_id(191))
      ) ENGINE=InnoDB
    `);

    // Durable queue for optimistic deletes: the row is pre-flagged is_deleted
    // locally and acked instantly; a pending op here means "the mail server
    // still needs to be told". Drained by runDeleteSweep (restart-safe).
    await c.query(`
      CREATE TABLE IF NOT EXISTS platform_email_pending_ops (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account VARCHAR(255) NOT NULL,
        uid VARCHAR(255) NOT NULL,
        op VARCHAR(32) NOT NULL DEFAULT 'delete',
        permanent BOOLEAN DEFAULT FALSE,
        message_id VARCHAR(998) NULL,
        attempts INT DEFAULT 0,
        last_error TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_pending (account, uid, op)
      ) ENGINE=InnoDB
    `);

    // Outbound send log. The provider's own Sent copy only becomes queryable at
    // the NEXT sync (Gmail history poll, IMAP reconcile) — too late for anything
    // that must answer "did we already send this?" right now, and it carries no
    // provenance either. This row is written the instant a send succeeds, so a
    // send is visible immediately and traceable back to the proposal/app that
    // caused it. listSent() unions it with the synced Sent folder, so sends made
    // by hand from another client are not missed.
    await c.query(`
      CREATE TABLE IF NOT EXISTS platform_email_sent (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account VARCHAR(255) NOT NULL,
        message_id VARCHAR(998),
        thread_id VARCHAR(255),
        in_reply_to VARCHAR(998),
        provider_uid VARCHAR(255),
        recipient TEXT,
        cc TEXT,
        bcc TEXT,
        subject TEXT,
        subject_norm VARCHAR(500),
        body MEDIUMTEXT,
        has_attachments TINYINT DEFAULT 0,
        origin_source VARCHAR(32),
        origin_app VARCHAR(128),
        proposal_id VARCHAR(64),
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_account_sent (account, sent_at DESC),
        KEY idx_thread (account, thread_id),
        KEY idx_subject (account, subject_norm(191)),
        KEY idx_inreplyto (account, in_reply_to(191)),
        KEY idx_msgid (account, message_id(191))
      ) ENGINE=InnoDB
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS platform_email_annotations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account VARCHAR(255) NOT NULL,
        email_uid VARCHAR(255) NOT NULL,
        app_name VARCHAR(128) NOT NULL,
        kind VARCHAR(64) NOT NULL DEFAULT 'default',
        data JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_annotation (account, email_uid, app_name, kind),
        KEY idx_workqueue (account, app_name, kind, email_uid)
      ) ENGINE=InnoDB
    `);




    // Vector columns are additive ALTERs, skipped when unsupported (my-dashboard
    // db.js pattern). Nullable on purpose: VECTOR INDEX would require NOT NULL;
    // at this scale VEC_DISTANCE_COSINE scans are fine.
    if (_vector) {
      for (const table of ['platform_emails']) {
        try {
          await c.query(`ALTER TABLE ${table} ADD COLUMN embedding VECTOR(${EMBED_DIM})`);
        } catch (e) {
          if (!/Duplicate column/i.test(e.message)) { _vector = false; break; }
        }
        try {
          await c.query(`ALTER TABLE ${table} ADD COLUMN embed_hash VARCHAR(64) DEFAULT NULL`);
        } catch (e) {
          if (!/Duplicate column/i.test(e.message)) throw e;
        }
        // Existing installs created embed_hash as VARCHAR(40) (bare sha1 hex).
        // Versioned stamps ("<EMBED_VERSION>:<sha1>", see emailEmbedHash) need
        // more room — widen once, guarded by information_schema.
        const [hashCol] = await c.query(
          `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = 'embed_hash'`,
          [DB, table]
        );
        if (hashCol && Number(hashCol.len) < 64) {
          await c.query(`ALTER TABLE ${table} MODIFY embed_hash VARCHAR(64) DEFAULT NULL`);
        }
      }
    }


    // folderCounts() aggregates COUNT(*) + SUM(is_unread) grouped by folder,
    // filtered on is_deleted — none of which idx_account_folder covers, so it
    // was a row scan of the whole account on every folder-bar refresh. This
    // index carries all four columns, making that aggregate index-only.
    try {
      await c.query(
        'ALTER TABLE platform_emails ADD INDEX idx_acct_del_folder (account, is_deleted, folder, is_unread)'
      );
    } catch (e) {
      if (!/Duplicate key name/i.test(e.message)) throw e;
    }

    // Recipient search (2026-08): idx_search gained recipient + cc, so a
    // FULLTEXT query can match a To/CC-only address. Existing installs still
    // carry the old (subject, body, sender) index — rebuild it once, guarded
    // by the column list in information_schema so it never rebuilds again.
    // NOTE: the rebuild can take a while on a large mail store (it runs once).
    const idxCols = await c.query(
      `SELECT COLUMN_NAME AS col FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'platform_emails' AND INDEX_NAME = 'idx_search'
       ORDER BY SEQ_IN_INDEX`,
      [DB]
    );
    const idxHas = new Set(idxCols.map((r) => r.col));
    if (!idxHas.has('recipient') || !idxHas.has('cc')) {
      console.log('  Email engine: rebuilding idx_search FULLTEXT with recipient/cc (one-time, may take a while on large stores)');
      if (idxHas.size) await c.query('ALTER TABLE platform_emails DROP INDEX idx_search');
      await c.query('ALTER TABLE platform_emails ADD FULLTEXT idx_search (subject, body, sender, recipient, cc)');
    }

    _ready = true;
    console.log(`  Email engine: schema ready (vector ${_vector ? 'enabled' : 'unavailable'})`);
    ensureMaintenanceJob();
    backfillThreadIds();
    return true;
  } catch (err) {
    console.error('  Email engine: schema init failed:', err.message);
    return false;
  } finally {
    c.release();
  }
}

function init(dir, store, bc) {
  appsDir = dir;
  secretStore = store;
  broadcaster = bc;
  settings = loadSettings();
  // Internal cron handler for the retention sweep. index.js registers the other
  // email.* handlers; this one lives here so it ships with the engine and needs
  // no index.js wiring (registerInternal is a plain map entry, safe pre-init).
  platformCron.registerInternal('email.maintenance-sweep', () => runMaintenanceSweep());
}

function isReady() {
  return _ready && !!appDb.getPool();
}

function vectorEnabled() {
  return _ready && _vector;
}

// ---------------------------------------------------------------------------
// Providers (sync modules register themselves at init)
// ---------------------------------------------------------------------------
function registerProvider(name, api) {
  providers[name] = api;
}

function provider(name) {
  return providers[name] || null;
}

// Resolve which provider syncs a given account: gmail for google-auth accounts,
// imap for email-accounts entries.
// Resolve an account to its provider, or refuse. This used to fall through to
// 'gmail' for anything without IMAP credentials, so a typo'd or removed address
// surfaced as an opaque Google token error rather than "unknown account" — and
// the caller could not tell a dead grant from a name that never existed.
//
// `strict` is the send path: an address in neither the IMAP vault nor
// google-auth's account list is refused by name. Sync callers keep the lenient
// form because they resolve accounts that are already known to be configured.
function accountType(email, { strict = false } = {}) {
  if (emailAccounts.getCredentials(email)) return 'imap';
  if (!strict) return 'gmail';
  let google = [];
  try { google = require('./google-auth').listAccounts().map((a) => a.email); } catch { google = []; }
  if (google.includes(email)) return 'gmail';
  throw new Error(`unknown email account "${email}"`);
}

// ---------------------------------------------------------------------------
// Send guardrails — the engine is the choke point, not the governance kind
// ---------------------------------------------------------------------------
// Every send guardrail lives here, on the engine method, because `send()` has
// four entry points and only one of them went through the `email.send` kind:
// ctx.email.send validated nothing at all, the Bridge checked two fields, and
// the kind checked everything. A guardrail that only one caller reaches is not
// a guardrail. Moving them down makes the refusals identical on every path.
//
// What deliberately did NOT move: the recompose-on-edit behaviour itself. That
// is a governance property — the kind's `compose` hook re-renders the payload at
// every freeze point so an edited proposal cannot diverge from its sources. The
// engine only ASSERTS the result (below). The two are easy to conflate: compose
// is "re-derive it", this is "prove nobody handed us something else".
const SEND_HEADER_FIELDS = ['account', 'to', 'cc', 'bcc', 'subject', 'inReplyTo', 'references'];
const MAX_ATTACHMENTS = 25;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 40 * 1024 * 1024;

// Every address the platform can actually send from, both vaults unioned.
function knownAccounts() {
  const out = [];
  try { out.push(...emailAccounts.list().map((a) => a.email)); } catch { /* vault not ready */ }
  try { out.push(...require('./google-auth').listAccounts().map((a) => a.email)); } catch { /* not configured */ }
  return out;
}

function validateSend(params) {
  const p = params || {};
  // `payload requires <field>` is the platform-wide phrasing (horst-facet's
  // `req`), kept verbatim so a refusal reads the same whether it surfaced from
  // a governance freeze, an app's ctx call or the Bridge.
  for (const f of ['account', 'to', 'subject', 'body']) {
    if (p[f] == null || String(p[f]).trim() === '') throw new Error(`payload requires ${f}`);
  }
  // Header-bound fields. A reply subject is DERIVED from the parent message —
  // untrusted mail — so a line break here is header injection, not a formatting
  // slip. Refused before either transport sees it, which is what closes the
  // IMAP/nodemailer path that had no defence of its own.
  for (const f of SEND_HEADER_FIELDS) {
    if (p[f] != null && /[\r\n]/.test(String(p[f]))) {
      throw new Error(`${f} must not contain a line break`);
    }
  }
  // A composed reply carries its own sources; assert the rendered parts still
  // match them. Gated on the version so a later rendering change leaves pending
  // proposals frozen and sendable rather than retroactively invalid.
  if (p.replyText != null) {
    const compose = require('./email-compose');
    if (typeof p.replyText !== 'string' || !p.replyText.trim()) throw new Error('replyText must be a non-empty string');
    if (typeof p.htmlBody !== 'string' || !p.htmlBody) throw new Error('a composed reply requires an htmlBody');
    if (p.includeSignature != null && typeof p.includeSignature !== 'boolean') throw new Error('includeSignature must be a boolean');
    if (p.composeVersion === compose.COMPOSE_VERSION) {
      const again = compose.recompose(p);
      if (again.body !== p.body || again.htmlBody !== p.htmlBody) {
        throw new Error('composed body disagrees with its own sources — refusing to freeze');
      }
    }
  }
  // Known-account refusal. Tolerates a platform with no mail account configured
  // at all (fresh install, tests) rather than blocking every send behind setup —
  // send() itself resolves strictly, so an unknown address still cannot go out.
  const known = knownAccounts();
  if (known.length && !known.includes(p.account)) {
    throw new Error(`unknown email account "${p.account}"`);
  }
  validateAttachments(p.attachments);
}

// An attachment the caller did not upload: a pointer at one already in the
// store, which send() fetches at send time. This is what a forward carries —
// the alternative is a 13 MB base64 string travelling through the proposal
// ledger and back out again just to reach the same bytes.
function isAttachmentRef(a) {
  return !!(a && a.attachmentId && (a.uid != null || a.emailId != null));
}

function validateAttachments(attachments) {
  if (attachments == null) return;
  if (!Array.isArray(attachments)) throw new Error('attachments must be an array');
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`too many attachments (${attachments.length} > ${MAX_ATTACHMENTS})`);
  }
  let total = 0;
  for (const a of attachments) {
    if (isAttachmentRef(a)) {
      // Size and content type are only knowable once fetched; the resolved
      // bytes come back through this same function before they go out.
      if (a.account != null && (typeof a.account !== 'string' || !a.account.trim())) {
        throw new Error('attachment ref has an invalid account');
      }
      if (a.filename != null && (typeof a.filename !== 'string' || /[\r\n]/.test(a.filename))) {
        throw new Error('attachment ref has an invalid filename');
      }
      continue;
    }
    if (!a || typeof a.filename !== 'string' || !a.filename.trim()) throw new Error('each attachment requires a filename');
    if (typeof a.base64Data !== 'string' || !a.base64Data) throw new Error(`attachment "${a.filename}" has no data`);
    if (!/^[A-Za-z0-9+/\r\n=]+$/.test(a.base64Data)) throw new Error(`attachment "${a.filename}" is not valid base64`);
    if (a.contentType != null && (typeof a.contentType !== 'string' || /[\r\n]/.test(a.contentType))) {
      throw new Error(`attachment "${a.filename}" has an invalid contentType`);
    }
    // base64 is 4 chars per 3 bytes; count without materialising the buffer.
    const clean = a.base64Data.replace(/[\r\n]/g, '');
    const bytes = Math.floor(clean.length * 3 / 4);
    if (bytes > MAX_ATTACHMENT_BYTES) throw new Error(`attachment "${a.filename}" is too large`);
    total += bytes;
  }
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error('attachments exceed the total size limit');
}

// ---------------------------------------------------------------------------
// Sync-state helpers (used by sync modules and Setup)
// ---------------------------------------------------------------------------
async function getSyncState(account) {
  const c = await conn();
  try {
    const rows = await c.query('SELECT * FROM platform_email_sync WHERE account = ?', [account]);
    return rows[0] || null;
  } finally {
    c.release();
  }
}

async function listSyncState() {
  if (!isReady()) return [];
  const c = await conn();
  try {
    return await c.query('SELECT * FROM platform_email_sync ORDER BY account');
  } finally {
    c.release();
  }
}

async function setSyncState(account, fields) {
  const c = await conn();
  try {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    await c.query(
      `INSERT INTO platform_email_sync (account, account_type, ${keys.join(', ')})
       VALUES (?, ?, ${keys.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${keys.map((k) => `${k} = VALUES(${k})`).join(', ')}`,
      [account, accountType(account), ...keys.map((k) => fields[k])]
    );
  } finally {
    c.release();
  }
  if (fields.status !== undefined || fields.last_error !== undefined || fields.backfill_done !== undefined) {
    dispatchStatus(account, fields);
  }
}

// ---------------------------------------------------------------------------
// Events — applyChange/dispatch (telegram.js dispatchUpdate pattern).
// Backend handlers always fire for their app; iframe broadcasts go to every
// subscribed app (one app:bridge:event per appName, routed by bridge-client).
// ---------------------------------------------------------------------------
function registerHandler(appName, event, fn) {
  if (!handlers.has(appName)) handlers.set(appName, new Map());
  const evMap = handlers.get(appName);
  if (!evMap.has(event)) evMap.set(event, new Set());
  evMap.get(event).add(fn);
  return () => { evMap.get(event)?.delete(fn); };
}

function clearHandlers(appName) {
  handlers.delete(appName);
  subscribers.delete(appName);
}

function subscribe(appName, events) {
  if (!subscribers.has(appName)) subscribers.set(appName, new Set());
  const set = subscribers.get(appName);
  for (const e of events || []) set.add(e);
  return { ok: true, events: [...set] };
}

function dispatch(event, data) {
  for (const [appName, evMap] of handlers) {
    const fns = evMap.get(event);
    if (!fns) continue;
    for (const fn of fns) {
      // App handlers are attributed through the guard; platform subscribers
      // ('horst', '__*') keep their own logging.
      if (guard.isApp(appName)) guard.run(appName, `email.${event}`, () => fn(data));
      else { try { fn(data); } catch (err) { console.error(`[email-engine:${appName}] ${event} handler error:`, err.message); } }
    }
  }
  if (broadcaster) {
    for (const [appName, events] of subscribers) {
      if (events.has(event)) {
        broadcaster.broadcast({ type: 'app:bridge:event', appName, event, data });
      }
    }
  }
}

// Sync-status events also feed the Setup panel (no app subscription needed).
function dispatchStatus(account, fields) {
  const data = {
    account,
    state: fields.status,
    lastSyncAt: fields.last_sync_at,
    error: fields.last_error || null,
    backfillTotal: fields.backfill_total,
    backfillDone: fields.backfill_done,
  };
  dispatch('email:sync:status', data);
  if (broadcaster) broadcaster.broadcast({ type: 'app:setup:emailEngineStatus', ...data });
}

// Sync-failure episodes for Horst's email:sync:failed / :recovered senses. A
// blip — a server restart, a DNS hiccup, the error text flipping between
// timeout and refused — is not news: an account reports once, after graceMs
// of unbroken failure, and once more when it syncs again. 'error' opens or
// extends an episode; 'watching' / 'backfilling' close it (recovered only if
// it had reported); 'disabled' / 'auth_required' close it quietly; 'idle' (a
// reconnect starting) and status-less progress updates change nothing.
const SYNC_ALERT_GRACE_MS = 10 * 60_000;
const SYNC_HEALTHY = new Set(['watching', 'backfilling']);
const SYNC_QUIET_END = new Set(['disabled', 'auth_required']);

function syncAlertTracker({ onFailed, onRecovered, graceMs = SYNC_ALERT_GRACE_MS, now = Date.now }) {
  const episodes = new Map(); // account -> { since, error, lastSyncAt, timer, reported }
  const end = (account) => {
    const ep = episodes.get(account);
    if (ep) { clearTimeout(ep.timer); episodes.delete(account); }
    return ep;
  };
  return {
    feed(d) {
      if (!d || !d.account) return;
      if (d.state === 'error') {
        let ep = episodes.get(d.account);
        if (!ep) {
          ep = { since: now(), reported: false, lastSyncAt: null };
          ep.timer = setTimeout(() => {
            ep.reported = true;
            onFailed({ account: d.account, error: ep.error, since: ep.since, lastSyncAt: ep.lastSyncAt });
          }, graceMs);
          ep.timer.unref?.();
          episodes.set(d.account, ep);
        }
        ep.error = String(d.error || 'unknown error');
        if (d.lastSyncAt) ep.lastSyncAt = d.lastSyncAt;
      } else if (SYNC_HEALTHY.has(d.state)) {
        const ep = end(d.account);
        if (ep?.reported) onRecovered({ account: d.account, since: ep.since, downMs: now() - ep.since });
      } else if (SYNC_QUIET_END.has(d.state)) {
        end(d.account);
      }
    },
    dispose() { for (const account of [...episodes.keys()]) end(account); },
  };
}

// ---------------------------------------------------------------------------
// Store — upserts and reads over platform_emails. Message objects use the
// parseGmailMessage/parseImapMessage shape ({id, threadId, messageId, from,
// to, cc, subject, body, htmlBody, snippet, date, internalDate, isUnread,
// isStarred, headers, attachments, labelIds}) plus folder/isDeleted set by
// the sync provider.
// ---------------------------------------------------------------------------

// Embed text schema v2: recipient/cc included so semantic search can match a
// To/CC-only address (same gap idx_search had). Accepts both message objects
// (from/to) and platform_emails rows (sender/recipient) so upsert and the
// embed sweep build identical text for the same mail. This deliberately breaks
// the old "byte-identical to my-dashboard's db.js" contract (plan Q7) —
// EMBED_TEXT_VERSION below is what re-embeds the old vectors.
function emailEmbedText(msg) {
  const parts = [msg.subject, msg.from || msg.sender, msg.to || msg.recipient, msg.cc, msg.snippet || msg.body];
  return parts.map((s) => (s || '').toString().trim()).filter(Boolean).join('\n').slice(0, 6000);
}

function embedHash(text) {
  return text ? crypto.createHash('sha1').update(text).digest('hex') : null;
}

// Version stamp carried inside every email embed_hash: "<EMBED_VERSION>:<sha1>".
// Two components — the embedding model version (embeddings.js MODEL_VERSION;
// vectors from different models are not comparable) and the text schema above
// (adding a field changes what the vector encodes). Bumping either makes every
// stored stamp stale, and the embed sweep's catch-up pass (email-embed.js
// stampHashes) restamps + re-embeds those rows in batches — never one-shot.
const EMBED_TEXT_VERSION = 2;
const EMBED_VERSION = `${embeddings.MODEL_VERSION}.${EMBED_TEXT_VERSION}`;

function emailEmbedHash(text) {
  const h = embedHash(text);
  return h ? `${EMBED_VERSION}:${h}` : null;
}

function msgDate(msg) {
  let d = msg.date ? new Date(msg.date) : null;
  if ((!d || isNaN(d)) && msg.internalDate) d = new Date(parseInt(msg.internalDate));
  return d && !isNaN(d) ? d : null;
}

async function getTombstoneUids(account) {
  const c = await conn();
  try {
    const rows = await c.query('SELECT uid FROM platform_email_tombstones WHERE account = ?', [account]);
    return new Set(rows.map((r) => String(r.uid)));
  } finally {
    c.release();
  }
}

async function addTombstone(account, uid, messageId) {
  const c = await conn();
  try {
    await c.query(
      'INSERT IGNORE INTO platform_email_tombstones (account, uid, message_id) VALUES (?, ?, ?)',
      [account, String(uid), messageId || null]
    );
  } finally {
    c.release();
  }
}

// Fill in thread_id for messages whose provider does not supply one (IMAP).
//
// One query for the whole batch, then a second pass over the batch itself:
// a reply and the message it answers often arrive in the same sync, and the
// parent is not in the store yet when the child is resolved.
async function resolveThreadIds(c, account, messages) {
  const threading = require('./email-threading');
  const need = messages.filter((m) => !m.threadId);
  if (!need.length) return;

  const wanted = new Set();
  for (const m of need) for (const id of threading.referencedIds(m.headers)) wanted.add(id);

  const known = new Map();
  if (wanted.size) {
    const ids = [...wanted];
    // Chunked: a full-folder sync can reference thousands of ancestors, and a
    // placeholder list has a practical ceiling.
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      // Clients disagree about storing the angle brackets, and so do our two
      // sync paths, so match a stored id in either spelling.
      const forms = chunk.flatMap((id) => [id, `<${id}>`]);
      const rows = await c.query(
        `SELECT message_id, thread_id FROM platform_emails
         WHERE account = ? AND message_id IN (${forms.map(() => '?').join(',')})`,
        [account, ...forms],
      );
      for (const r of rows) {
        const key = threading.normalizeId(r.message_id);
        if (key && r.thread_id) known.set(key, r.thread_id);
      }
    }
  }

  // Oldest first, so a parent is filed before the reply that points at it.
  for (const m of [...need].sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0))) {
    m.threadId = threading.threadIdFor(m, known);
    const own = threading.normalizeId(m.messageId);
    if (own) known.set(own, m.threadId);
  }
}

// One-shot: give the IMAP rows already in the store a real thread id.
//
// `thread_id = uid` is the exact signature of the old IMAP behaviour, so this
// selects only what it should and cannot touch a Gmail row. It runs once —
// after that the setting says so — in the background, in pages, because a large
// store should not hold up boot for it.
const THREAD_BACKFILL_SETTING = 'threadBackfillV1';
const THREAD_BACKFILL_PAGE = 500;

async function backfillThreadIds() {
  if (getSetting(THREAD_BACKFILL_SETTING)) return;
  const threading = require('./email-threading');
  let repaired = 0;
  // A repaired row leaves the `thread_id = uid` set; a genuine thread of one
  // stays in it, so the offset walks past those rather than re-reading them
  // forever.
  let offset = 0;
  try {
    for (;;) {
      const c = await conn();
      let rows;
      let singletons = 0;
      try {
        rows = await c.query(
          `SELECT account, uid, message_id, headers FROM platform_emails
           WHERE thread_id = uid ORDER BY account, uid LIMIT ? OFFSET ?`,
          [THREAD_BACKFILL_PAGE, offset],
        );
        if (!rows.length) break;
        for (const row of rows) {
          const headers = typeof row.headers === 'string' ? JSON.parse(row.headers || '[]') : (row.headers || []);
          // The parent may itself still be unrepaired, so ask the store what it
          // knows rather than trusting a sibling row's thread_id.
          const refs = threading.referencedIds(headers);
          let known = new Map();
          if (refs.length) {
            const forms = refs.flatMap((id) => [id, `<${id}>`]);
            const parents = await c.query(
              `SELECT message_id, thread_id FROM platform_emails
               WHERE account = ? AND message_id IN (${forms.map(() => '?').join(',')}) AND thread_id <> uid`,
              [row.account, ...forms],
            );
            known = new Map(parents
              .filter((r) => r.thread_id)
              .map((r) => [threading.normalizeId(r.message_id), r.thread_id]));
          }
          const threadId = threading.threadIdFor(
            { headers, messageId: row.message_id, id: row.uid }, known,
          );
          if (threadId === String(row.uid)) { singletons++; continue; } // genuinely a thread of one
          await c.query(
            'UPDATE platform_emails SET thread_id = ? WHERE account = ? AND uid = ?',
            [threadId, row.account, String(row.uid)],
          );
          repaired++;
        }
      } finally {
        c.release();
      }
      offset += singletons;
      if (rows.length < THREAD_BACKFILL_PAGE) break;
    }
    setSetting(THREAD_BACKFILL_SETTING, true);
    if (repaired) console.log(`  Email engine: threaded ${repaired} IMAP message(s) by References/In-Reply-To`);
  } catch (err) {
    // Not fatal: mail still reads, threads just stay as they were. Retried on
    // the next boot because the setting was never written.
    console.error('  Email engine: thread backfill failed:', err.message);
  }
}

// Upserts a batch; returns the subset that was newly inserted (for email:new).
// Tombstoned uids are skipped so permanently-deleted mail never resurrects.
async function upsertEmails(account, messages, { suppressEvents = false, origin = { source: 'sync' } } = {}) {
  if (!messages.length) return { inserted: [], updated: 0 };
  const tombstones = await getTombstoneUids(account);
  const c = await conn();
  const inserted = [];
  let updated = 0;
  try {
    await resolveThreadIds(c, account, messages);
    await c.beginTransaction();
    for (const msg of messages) {
      if (tombstones.has(String(msg.id))) continue;
      // HTML-only mail (no text/plain part): fill body with the deterministic
      // markdown extraction so FULLTEXT and embeddings can see the content —
      // body is "the readable text", html_body stays the rendering original.
      // Before embedHash: the filled snippet must land in the embed text.
      if ((!msg.body || !msg.body.trim()) && msg.htmlBody) {
        msg.body = require('./email-content').htmlToMarkdownish(msg.htmlBody);
        if (!msg.snippet) msg.snippet = msg.body.substring(0, 200).replace(/\s+/g, ' ');
      }
      const eh = _vector ? emailEmbedHash(emailEmbedText(msg)) : null;
      const res = await c.query(
        `INSERT INTO platform_emails (account, uid, thread_id, message_id, sender, recipient, cc, subject, body, html_body, snippet, date, internal_date, is_unread, is_starred, folder, headers, attachment_meta, label_ids, is_deleted, deleted_at${_vector ? ', embed_hash' : ''})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${msg.isDeleted ? 'CURRENT_TIMESTAMP' : 'NULL'}${_vector ? ', ?' : ''})
         ON DUPLICATE KEY UPDATE
           thread_id=VALUES(thread_id), message_id=VALUES(message_id), sender=VALUES(sender),
           recipient=VALUES(recipient), cc=VALUES(cc), subject=VALUES(subject),
           body=VALUES(body), html_body=VALUES(html_body), snippet=VALUES(snippet),
           date=VALUES(date), internal_date=VALUES(internal_date),
           is_unread=VALUES(is_unread), is_starred=VALUES(is_starred), folder=VALUES(folder),
           headers=VALUES(headers), attachment_meta=VALUES(attachment_meta), label_ids=VALUES(label_ids),
           deleted_at=IF(VALUES(is_deleted) = is_deleted, deleted_at, IF(VALUES(is_deleted), CURRENT_TIMESTAMP, NULL)),
           is_deleted=VALUES(is_deleted), sync_orphan=0${_vector ? `,
           embedding=IF(embed_hash <=> VALUES(embed_hash), embedding, NULL), embed_hash=VALUES(embed_hash)` : ''}`,
        [
          account, String(msg.id), msg.threadId || null, msg.messageId || null,
          msg.from || null, msg.to || null, msg.cc || null,
          msg.subject || null, msg.body || null, msg.htmlBody || null,
          msg.snippet || null, msgDate(msg), msg.internalDate || null,
          msg.isUnread ? 1 : 0, msg.isStarred ? 1 : 0,
          msg.folder || 'INBOX',
          JSON.stringify(msg.headers || []),
          JSON.stringify(msg.attachments || []),
          JSON.stringify(msg.labelIds || []),
          msg.isDeleted ? 1 : 0,
          ...(_vector ? [eh] : []),
        ]
      );
      // mariadb: affectedRows 1 = insert, 2 = update (0/1 also possible on no-op update)
      if (Number(res.affectedRows) === 1) inserted.push(msg);
      else updated++;
    }
    await c.commit();
  } catch (err) {
    await c.rollback().catch(() => {});
    throw err;
  } finally {
    c.release();
  }
  // Sender rules apply BEFORE anyone hears about the mail: rule-matched
  // INBOX/Spam arrivals are moved to Trash (server-side, async) and never
  // dispatch email:new — no classifier token, no briefing line, no app render.
  let kept = inserted;
  if (inserted.length && loadSenderRules().length) {
    const junk = [];
    kept = [];
    for (const m of inserted) {
      const folder = m.folder || 'INBOX';
      const rule = (folder === 'INBOX' || folder === 'Spam') ? matchSenderRule(m.from) : null;
      if (rule) junk.push({ m, rule });
      else kept.push(m);
    }
    for (const { m } of junk) {
      modify({ account, uid: String(m.id), move: 'Trash' }, { source: 'rules' })
        .catch((err) => console.warn(`[email-rules] arrival move failed (${m.id}):`, err.message));
    }
    if (junk.length) {
      // Audit even during suppressed-event backfill — rule-trashing must never
      // be fully silent (a large import used to move mail with no trail).
      console.log(`[email-rules] ${account}: trashed ${junk.length} rule-matched arrival(s)${suppressEvents ? ' (backfill)' : ''}`);
      recordRuleHits(junk.map(({ m, rule }) => ({ rule, account, uid: String(m.id) })));
    }
  }
  if (!suppressEvents && kept.length) {
    dispatch('email:new', {
      account,
      messages: kept.map((m) => ({
        uid: String(m.id), subject: m.subject || '', sender: m.from || '',
        snippet: m.snippet || '', date: m.date || '', folder: m.folder || 'INBOX',
      })),
      origin,
    });
  }
  return { inserted, updated };
}

// Applies flag/folder/deletion changes detected by sync (or by modify()'s DB
// leg) and emits email:updated. changes: {isUnread?, isStarred?, folder?,
// isDeleted?, labelIds?, permanent?}.
async function applyEmailChanges(account, uid, changes, origin = { source: 'sync' }) {
  const sets = [];
  const vals = [];
  if (changes.isUnread !== undefined) { sets.push('is_unread = ?'); vals.push(changes.isUnread ? 1 : 0); }
  if (changes.isStarred !== undefined) { sets.push('is_starred = ?'); vals.push(changes.isStarred ? 1 : 0); }
  if (changes.folder !== undefined) { sets.push('folder = ?'); vals.push(changes.folder); }
  if (changes.syncOrphan !== undefined) { sets.push('sync_orphan = ?'); vals.push(changes.syncOrphan ? 1 : 0); }
  if (changes.labelIds !== undefined) { sets.push('label_ids = ?'); vals.push(JSON.stringify(changes.labelIds)); }
  if (changes.isDeleted !== undefined) {
    sets.push('is_deleted = ?');
    vals.push(changes.isDeleted ? 1 : 0);
    sets.push(changes.isDeleted ? 'deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP)' : 'deleted_at = NULL');
  }
  if (!sets.length) return false;
  const c = await conn();
  let hit = false;
  try {
    const res = await c.query(
      `UPDATE platform_emails SET ${sets.join(', ')} WHERE account = ? AND uid = ?`,
      [...vals, account, String(uid)]
    );
    hit = Number(res.affectedRows) > 0;
  } finally {
    c.release();
  }
  if (hit) {
    const { labelIds, syncOrphan, ...evChanges } = changes;
    dispatch('email:updated', { account, uid: String(uid), changes: evChanges, origin });
  }
  return hit;
}

// Rewrites a row's uid (IMAP move / B4.7 import merge), cascading to
// annotations + attachment cache in one transaction so the email keeps its
// identity. Returns false when newUid already exists (caller upserts normally).
async function remapEmailUid(account, oldUid, newUid) {
  if (String(oldUid) === String(newUid)) return true;
  const c = await conn();
  try {
    await c.beginTransaction();
    await c.query('UPDATE platform_emails SET uid = ? WHERE account = ? AND uid = ?',
      [String(newUid), account, String(oldUid)]);
    await c.query('UPDATE platform_email_annotations SET email_uid = ? WHERE account = ? AND email_uid = ?',
      [String(newUid), account, String(oldUid)]);
    await c.query('UPDATE platform_email_attachments SET email_uid = ? WHERE account = ? AND email_uid = ?',
      [String(newUid), account, String(oldUid)]);
    await c.commit();
    return true;
  } catch (err) {
    await c.rollback().catch(() => {});
    if (/Duplicate entry/i.test(err.message)) return false;
    throw err;
  } finally {
    c.release();
  }
}

// True purge: removes the row and its cached attachments + annotations from the
// store entirely (vs. the soft is_deleted flag). The tombstone written by the
// caller is what keeps a re-synced server copy from resurrecting it, so this is
// only ever called once the message is gone from the mail server too.
async function hardDeleteRow(account, uid) {
  const c = await conn();
  try {
    await c.beginTransaction();
    await c.query('DELETE FROM platform_email_attachments WHERE account = ? AND email_uid = ?', [account, String(uid)]);
    await c.query('DELETE FROM platform_email_annotations WHERE account = ? AND email_uid = ?', [account, String(uid)]);
    const res = await c.query('DELETE FROM platform_emails WHERE account = ? AND uid = ?', [account, String(uid)]);
    await c.commit();
    return Number(res.affectedRows) > 0;
  } catch (err) {
    await c.rollback().catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

function toEmail(row) {
  const parse = (v, fb) => {
    if (v == null) return fb;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fb; } }
    return v;
  };
  return {
    id: row.uid,
    threadId: row.thread_id,
    messageId: row.message_id,
    account: row.account,
    from: row.sender,
    to: row.recipient,
    cc: row.cc,
    subject: row.subject,
    body: row.body,
    htmlBody: row.html_body,
    snippet: row.snippet,
    date: row.date ? new Date(row.date).toUTCString() : '',
    internalDate: row.internal_date ? String(row.internal_date) : '',
    isUnread: !!row.is_unread,
    isStarred: !!row.is_starred,
    folder: row.folder,
    headers: parse(row.headers, []),
    attachments: parse(row.attachment_meta, []),
    labelIds: parse(row.label_ids, []),
    isDeleted: !!row.is_deleted,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    syncOrphan: !!row.sync_orphan,
  };
}

// Attaches the caller's annotations ({kind: data}) to a list of email objects.
// `from` (listEmails' `annotationsFrom`) additionally pulls in the named writer
// apps — how a view app reads what the platform classifier decided about the
// very emails it just listed, instead of keeping a private mirror of it.
// Own-app annotations win on a kind collision, so nothing a caller already
// reads can be shadowed by another app writing the same kind.
async function attachAnnotations(c, appName, emails, from = null) {
  if (!appName || !emails.length) return;
  const readers = [appName, ...(Array.isArray(from) ? from : []).filter((a) => a && a !== appName)];
  const pairs = emails.map((e) => [e.account, String(e.id)]);
  const placeholders = pairs.map(() => '(?, ?)').join(', ');
  const rows = await c.query(
    `SELECT account, email_uid, app_name, kind, data FROM platform_email_annotations
     WHERE app_name IN (${readers.map(() => '?').join(', ')}) AND (account, email_uid) IN (${placeholders})`,
    [...readers, ...pairs.flat()]
  );
  const byKey = new Map(emails.map((e) => [`${e.account}\u0001${e.id}`, e]));
  for (const e of emails) e.annotations = {};
  for (const r of rows) {
    const e = byKey.get(`${r.account}\u0001${r.email_uid}`);
    if (!e) continue;
    // Own-app wins: skip a foreign row whose kind the caller already filled.
    if (r.app_name !== appName && e.annotations[r.kind] !== undefined) continue;
    let data = r.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
    e.annotations[r.kind] = data;
  }
}

// Column set for `fields:'meta'` — everything except the two MEDIUMTEXT body
// columns and the headers JSON. List views, count passes and index sweeps read
// none of those, and a 300-row page of full bodies is orders of magnitude
// larger than the same page of metadata. `toEmail` needs no change: the absent
// columns come back undefined (and JSON.stringify drops them), which is exactly
// the "not hydrated yet" signal a caller tests for before fetching the message.
const META_COLS = [
  'id', 'account', 'uid', 'thread_id', 'message_id', 'sender', 'recipient', 'cc',
  'subject', 'snippet', 'date', 'internal_date', 'is_unread', 'is_starred',
  'folder', 'attachment_meta', 'label_ids', 'is_deleted', 'deleted_at', 'sync_orphan',
].map((col) => `e.${col}`).join(', ');

// A base an app may point a rewritten `cid:` src at: an absolute path on this
// host, or an http(s) URL. Refused here and not in the sanitiser's caller,
// because every entry point (ctx, Bridge, kind, semantic search) ends up on this
// one function — and a base like `javascript:` would otherwise be the single src
// in the document that skipped the scheme check.
const INLINE_BASE_RE = /^(https?:\/\/[^\s"'<>\\]+|\/(?!\/)[^\s"'<>\\]*)$/;

// Core read API (bridge email.list). similarSearch is layered on by the embed
// provider (A8.6); until then (or without VECTOR) search uses FULLTEXT only.
// `fields:'meta'` and `withTotal:false` are opt-in: omitted, the query is
// byte-identical to what every existing caller already gets.
// Apply the read path's render mode. Sanitising belongs HERE and not in each
// renderer: `html_body` is attacker-controlled by definition, so the default has
// to be safe and `raw` has to be asked for by name. A user-facing caller may not
// ask for it at all — nothing reachable from a phone or a public session has a
// reason to hold unsanitised markup.
function render(emails, { html = 'sanitized', allowImages = false, inlineImageBase = null } = {}) {
  if (html === 'raw' && require('./spend-context').isUserFacing()) throw new Error('raw html is not available to user-facing callers');
  const { renderEmail, HTML_MODES } = require('./html-sanitize');
  if (!HTML_MODES.includes(html)) throw new Error(`unknown html mode "${html}"`);
  if (inlineImageBase != null && !INLINE_BASE_RE.test(String(inlineImageBase))) {
    throw new Error('inlineImageBase must be an absolute path ("/apps/…/") or an http(s) URL');
  }
  if (html === 'raw') return emails;
  return emails.map((e) => renderEmail(e, html, { allowImages, inlineImageBase }));
}

async function listEmails(params = {}, appName = null) {
  const {
    account, folder, unread, starred, threadId, search, since,
    hasAnnotation, includeDeleted = false, deleted = false, limit = 50, offset = 0,
    fields = null, withTotal = true, annotationsFrom = null,
    html = 'sanitized', allowImages = false, inlineImageBase = null,
  } = params;

  // Semantic search fetches its own rows; it renders them through `render`
  // itself (its keyword half comes back through here already rendered, and
  // rendering a second time would clear the blocked-images flag).
  if (params.similarSearch && providers.embed?.similarSearch) {
    return providers.embed.similarSearch(params, appName);
  }

  const where = [];
  const vals = [];
  if (account) { where.push('e.account = ?'); vals.push(account); }
  if (folder) { where.push('e.folder = ?'); vals.push(folder); }
  if (threadId) { where.push('e.thread_id = ?'); vals.push(threadId); }
  if (unread !== undefined) { where.push('e.is_unread = ?'); vals.push(unread ? 1 : 0); }
  if (starred !== undefined) { where.push('e.is_starred = ?'); vals.push(starred ? 1 : 0); }
  if (since) { where.push('e.date >= ?'); vals.push(new Date(since)); }
  if (deleted) where.push('e.is_deleted = TRUE');
  else if (!includeDeleted) where.push('e.is_deleted = FALSE');
  // Search operators (`from:`, `in:`, `is:unread`, …) compile to predicates
  // here rather than being post-filtered by whichever surface asked. What is
  // left over after the operators is the free text FULLTEXT sees.
  const q = search ? require('./email-query').parseSearchQuery(search) : null;
  if (q?.hasOps) {
    const ops = require('./email-query').operatorSql(q, 'e.', { labels: listLabels() });
    where.push(...ops.where);
    vals.push(...ops.vals);
  }
  // Sanitised: the raw string used to reach boolean mode, where a stray `+`
  // changed the caller's meaning and an unbalanced quote threw a 500.
  const searchTerm = q?.freeText ? require('./fulltext-query').sanitize(q.freeText) : '';
  if (searchTerm) { where.push('MATCH(e.subject, e.body, e.sender, e.recipient, e.cc) AGAINST(? IN BOOLEAN MODE)'); vals.push(searchTerm); }

  let join = '';
  if (hasAnnotation !== undefined && appName) {
    const kind = typeof hasAnnotation === 'object' ? hasAnnotation.kind : null;
    const exists = typeof hasAnnotation === 'object' ? hasAnnotation.exists !== false : !!hasAnnotation;
    if (!exists) {
      join = `LEFT JOIN platform_email_annotations a
              ON a.account = e.account AND a.email_uid = e.uid AND a.app_name = ?${kind ? ' AND a.kind = ?' : ''}`;
      vals.unshift(...(kind ? [appName, kind] : [appName]));
      where.push('a.id IS NULL');
    } else {
      where.push(`EXISTS (SELECT 1 FROM platform_email_annotations a
                  WHERE a.account = e.account AND a.email_uid = e.uid AND a.app_name = ?${kind ? ' AND a.kind = ?' : ''})`);
      vals.push(...(kind ? [appName, kind] : [appName]));
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const c = await conn();
  try {
    const orderBy = deleted ? 'e.deleted_at DESC' : 'e.date DESC';
    const cols = fields === 'meta' ? META_COLS : 'e.*';
    const rows = await c.query(
      `SELECT ${cols} FROM platform_emails e ${join} ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...vals, Number(limit), Number(offset)]
    );
    // The total is a second full-predicate scan; callers that ignore it opt out.
    let total = rows.length;
    if (withTotal) {
      const [cnt] = await c.query(
        `SELECT COUNT(*) AS total FROM platform_emails e ${join} ${whereSql}`,
        vals
      );
      total = Number(cnt.total);
    }
    const emails = render(rows.map(toEmail), { html, allowImages, inlineImageBase });
    await attachAnnotations(c, appName, emails, annotationsFrom);
    return {
      emails, total,
      ...(search && !params.similarSearch ? { mode: 'keyword' } : {}),
      // How the search string was read. A surface that wants the leftover free
      // text (to search a second corpus with it, or to draw operator chips)
      // reads it here instead of parsing the query a second time.
      ...(q ? { query: { freeText: q.freeText, hasOps: q.hasOps } } : {}),
    };
  } finally {
    c.release();
  }
}

async function getEmail({ account, uid, includeDeleted = false, html = 'sanitized', allowImages = false, inlineImageBase = null, annotationsFrom = null }, appName = null) {
  const c = await conn();
  try {
    const rows = await c.query(
      `SELECT * FROM platform_emails WHERE account = ? AND uid = ?${includeDeleted ? '' : ' AND is_deleted = FALSE'}`,
      [account, String(uid)]
    );
    if (!rows.length) return null;
    const [email] = render([toEmail(rows[0])], { html, allowImages, inlineImageBase });
    await attachAnnotations(c, appName, [email], annotationsFrom);
    return email;
  } finally {
    c.release();
  }
}

// Per-folder totals: {folder: {total, unread}} for one account, or
// {account: {folder: {total, unread}}} for all accounts when none given.
async function folderCounts({ account } = {}) {
  const c = await conn();
  try {
    const rows = await c.query(
      `SELECT account, folder, COUNT(*) AS total, SUM(is_unread) AS unread
       FROM platform_emails WHERE is_deleted = FALSE${account ? ' AND account = ?' : ''}
       GROUP BY account, folder`,
      account ? [account] : []
    );
    const out = {};
    for (const r of rows) {
      const acct = out[r.account] || (out[r.account] = {});
      acct[r.folder] = { total: Number(r.total), unread: Number(r.unread || 0) };
    }
    return account ? (out[account] || {}) : out;
  } finally {
    c.release();
  }
}

// Provider-dispatched manual sync (Setup "Sync Now" / bridge email.syncNow).
async function syncNow(account) {
  if (!isReady()) throw new Error('Email engine not ready — configure database in Apps > Setup');
  const type = accountType(account);
  const p = providers[type];
  if (!p?.syncNow) throw new Error(`No ${type} sync provider loaded`);
  return p.syncNow(account);
}

// ---------------------------------------------------------------------------
// Write-through mutations — all converge here (plan A5 applyChange): provider
// first, then DB, then event. origin distinguishes bridge/app writes from sync.
// ---------------------------------------------------------------------------
function requireProvider(account) {
  const type = accountType(account);
  const p = providers[type];
  if (!p?.applyModify) throw new Error(`No ${type} provider loaded for ${account}`);
  return p;
}

// Canonical mutation (plan A4). params: {account, uid, addFlags?, removeFlags?,
// move?, delete?: bool|{permanent:true}, restore?: bool}. Sugar verbs
// (markRead/star/move/delete) are thin wrappers at the bridge layer.
async function modify(params, origin = { source: 'bridge' }) {
  const { account, uid } = params;
  if (!account || !uid) throw new Error('modify requires account and uid');
  return modifyOne(account, String(uid), {
    addFlags: params.addFlags || [],
    removeFlags: params.removeFlags || [],
    move: params.move,
    del: params.delete,
    restore: params.restore,
  }, origin);
}

// Single-UID write-through: provider op first, then DB + email:updated event.
async function modifyOne(account, uid, changeSpec, origin = { source: 'bridge' }) {
  // Judged BEFORE the provider is told, so a refused purge leaves the message
  // untouched on the mail server rather than expunged-then-rejected.
  const wantsPermanent = changeSpec && changeSpec.del && changeSpec.del.permanent;
  if (wantsPermanent) await assertPurgeable(account, uid, origin);
  const p = requireProvider(account);
  const changes = await p.applyModify(account, String(uid), changeSpec);

  const permanent = !!changes.permanent;
  // provider may have remapped the row uid (IMAP move); event reports the new one
  const effectiveUid = changes.uid || String(uid);
  const { uid: _u, permanent: _p, ...dbChanges } = changes;

  if (permanent) {
    // Gone from the mail server (provider expunged it) — now purge it from the
    // store too. The tombstone outlives the row so sync can't bring it back.
    const email = await getEmail({ account, uid: effectiveUid, includeDeleted: true, html: 'raw' });
    await addTombstone(account, effectiveUid, email?.messageId || null);
    await hardDeleteRow(account, effectiveUid);
    dispatch('email:updated', { account, uid: effectiveUid, changes: { isDeleted: true, purged: true }, origin });
  } else if (Object.keys(dbChanges).length) {
    await applyEmailChanges(account, effectiveUid, dbChanges, origin);
  }
  return { ok: true, uid: effectiveUid, changes: dbChanges, ...(permanent ? { permanent: true } : {}) };
}

// A provider error meaning "the message is already gone on the server" — for an
// idempotent delete that is success, not failure. Gmail returns HTTP 404; IMAP
// reports a missing/expunged UID. We match loosely on the error text/status.
function isAlreadyGoneError(err) {
  if (!err) return false;
  const status = err.status || err.statusCode || err.code;
  if (status === 404 || status === '404') return true;
  const m = String(err.message || err).toLowerCase();
  return m.includes('not found') || m.includes('no such') ||
    m.includes('does not exist') || m.includes("doesn't exist") ||
    m.includes('unknown uid') || m.includes('already deleted') ||
    m.includes('expunged') || m.includes('no matching messages');
}

const MAX_DELETE_ATTEMPTS = 5;
let _sweeping = false;

// ---------------------------------------------------------------------------
// Permanent-delete policy (server-side, because the browser was deciding it)
// ---------------------------------------------------------------------------
// `permanent: true` bypasses Trash entirely: the provider expunges, the row is
// hard-deleted and a tombstone keeps sync from ever bringing it back. That is
// the only genuinely irreversible thing the mail engine does, and until now the
// only thing deciding it was a boolean in a request body. An app — or anyone
// reaching an app's user surface — could purge an INBOX message outright.
//
// Two rules, both enforced here so every entry point gets them:
//
//   1. Permanent delete is a TRASH operation. Refused for a message that is not
//      already in Trash or Spam, which is what makes it the second half of a
//      two-step the owner performed deliberately rather than a one-shot purge.
//   2. A user-facing caller may never perform it at all. An app's own users are
//      not the mailbox owner; the worst they may do is move mail to Trash.
const PURGEABLE_FOLDERS = new Set(['trash', 'spam', 'junk', '[gmail]/trash', '[gmail]/spam']);

async function assertPurgeable(account, uids, origin) {
  // The sweep is the engine finishing work the owner already authorised; it
  // re-enters through modifyOne and must not be re-judged.
  if (origin && (origin.source === 'sweep' || origin.source === 'sync')) return;

  if (require('./spend-context').isUserFacing()) {
    throw new Error('permanent delete is not available to app users');
  }

  const list = (Array.isArray(uids) ? uids : [uids]).map(String).filter(Boolean);
  if (!list.length) return;
  const c = await conn();
  let rows;
  try {
    rows = await c.query(
      `SELECT uid, folder FROM platform_emails
       WHERE account = ? AND uid IN (${list.map(() => '?').join(',')})`,
      [account, ...list],
    );
  } finally {
    c.release();
  }
  for (const row of rows || []) {
    const folder = String(row.folder || '').toLowerCase();
    if (!PURGEABLE_FOLDERS.has(folder)) {
      throw new Error(`permanent delete is only allowed from Trash or Spam (uid ${row.uid} is in "${row.folder}")`);
    }
  }
}

// Optimistic batch delete: pre-flag every uid is_deleted locally (so apps stop
// seeing them at once), enqueue a durable pending op per uid, kick the sweep,
// and return immediately — the real mail-server deletion happens in the
// background (runDeleteSweep), restart-safe via platform_email_pending_ops.
async function batchDelete({ account, uids, permanent = false }, origin = { source: 'bridge' }) {
  if (!account) throw new Error('batchDelete requires account');
  const list = (Array.isArray(uids) ? uids : []).map((u) => String(u)).filter(Boolean);
  if (!list.length) throw new Error('batchDelete requires a non-empty uids array');
  if (permanent) await assertPurgeable(account, list, origin);

  const c = await conn();
  try {
    for (const uid of list) {
      // Local pre-flag: hidden from every read path immediately, emits email:updated.
      await applyEmailChanges(account, uid, { isDeleted: true }, origin);
      // Durable "server still needs to be told" record.
      await c.query(
        `INSERT INTO platform_email_pending_ops (account, uid, op, permanent)
         VALUES (?, ?, 'delete', ?)
         ON DUPLICATE KEY UPDATE permanent = VALUES(permanent), attempts = 0, last_error = NULL`,
        [account, uid, permanent ? 1 : 0]
      );
    }
  } finally {
    c.release();
  }

  // Fire-and-forget: start write-through now without blocking the ack.
  runDeleteSweep().catch((err) => console.error('  Email engine: delete sweep error:', err.message));

  return { ok: true, count: list.length, queued: list.length };
}

// Drains platform_email_pending_ops: writes each queued delete through to the
// real mail server. Idempotent (already-gone == success), bounded retry with a
// surfaced terminal error. Safe to call from the inline kick and the cron tick.
async function runDeleteSweep({ limit = 100 } = {}) {
  if (_sweeping) return { ok: true, skipped: true };
  _sweeping = true;
  let processed = 0, succeeded = 0, failed = 0;
  try {
    const c = await conn();
    let rows;
    try {
      rows = await c.query(
        `SELECT id, account, uid, permanent, attempts FROM platform_email_pending_ops
         WHERE op = 'delete' AND attempts < ? ORDER BY created_at ASC LIMIT ?`,
        [MAX_DELETE_ATTEMPTS, limit]
      );
    } finally {
      c.release();
    }

    for (const row of rows) {
      processed++;
      const account = row.account;
      const uid = String(row.uid);
      const permanent = !!row.permanent;
      try {
        await modifyOne(account, uid, { del: permanent ? { permanent: true } : true }, { source: 'sweep' });
        await deletePendingOp(row.id);
        succeeded++;
      } catch (err) {
        if (isAlreadyGoneError(err)) {
          // Already deleted/nonexistent on the server — treat as done, no retry.
          // For a permanent op the row must still be purged from the store (this
          // is the common case for the Deleted view, where rows are mail that
          // already vanished server-side), with a tombstone so it can't resync.
          if (permanent) {
            const email = await getEmail({ account, uid, includeDeleted: true, html: 'raw' }).catch(() => null);
            await addTombstone(account, uid, email?.messageId || null).catch(() => {});
            await hardDeleteRow(account, uid).catch(() => {});
            dispatch('email:updated', { account, uid, changes: { isDeleted: true, purged: true }, origin: { source: 'sweep' } });
          }
          await deletePendingOp(row.id);
          succeeded++;
          continue;
        }
        failed++;
        const attempts = (row.attempts || 0) + 1;
        await bumpPendingOp(row.id, attempts, err.message);
        if (attempts >= MAX_DELETE_ATTEMPTS) {
          // Stays hidden (is_deleted remains TRUE); stop auto-retrying and
          // surface so it isn't silently dropped.
          console.error(`  Email engine: delete write-through gave up after ${attempts} attempts for ${account}/${uid}: ${err.message}`);
          dispatch('email:delete-failed', { account, uid, attempts, error: err.message });
        }
      }
    }
  } finally {
    _sweeping = false;
  }
  return { ok: true, processed, succeeded, failed };
}

async function deletePendingOp(id) {
  const c = await conn();
  try {
    await c.query('DELETE FROM platform_email_pending_ops WHERE id = ?', [id]);
  } finally {
    c.release();
  }
}

async function bumpPendingOp(id, attempts, lastError) {
  const c = await conn();
  try {
    await c.query(
      'UPDATE platform_email_pending_ops SET attempts = ?, last_error = ? WHERE id = ?',
      [attempts, lastError ? String(lastError).slice(0, 2000) : null, id]
    );
  } finally {
    c.release();
  }
}

// Normalized subject — the join key for subject-based thread matching.
//
// The multilingual prefix stripping itself now lives in email-compose, which
// needs the case-PRESERVING half to build "Re:" subjects for outgoing replies.
// This adds the lowercase, whitespace collapse and length cap that turn it into
// a key rather than a display string. One implementation, so a language added
// for matching is automatically handled when composing (and vice versa).
// Required lazily: email-compose is a leaf (it never requires this module), and
// deferring keeps module load order irrelevant.
function normalizeSubject(subject) {
  const { stripSubjectPrefixes } = require('./email-compose');
  return stripSubjectPrefixes(subject).toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500);
}

// Record a successful send. Non-fatal by design: the mail is already gone, and
// failing the caller because a bookkeeping row didn't land would be worse than
// the missing row.
async function logSend(params, result, origin) {
  let c;
  try {
    c = await conn();
    await c.query(
      `INSERT INTO platform_email_sent
        (account, message_id, thread_id, in_reply_to, provider_uid, recipient, cc, bcc,
         subject, subject_norm, body, has_attachments, origin_source, origin_app, proposal_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.account,
        result.messageId || null,
        result.threadId || params.threadId || null,
        params.inReplyTo || null,
        result.uid != null ? String(result.uid) : null,
        params.to || null, params.cc || null, params.bcc || null,
        params.subject || null, normalizeSubject(params.subject),
        String(params.body || '').slice(0, 60000),
        Array.isArray(params.attachments) && params.attachments.length ? 1 : 0,
        origin?.source || null, origin?.appName || null, origin?.proposalId || null,
      ]
    );
  } catch (err) {
    console.warn(`  Email engine: send-log write failed (${params.account}):`, err.message);
  } finally {
    c?.release();
  }
}

// Turn reference attachments into bytes, immediately before the provider send.
// A ref that cannot be fetched REFUSES the whole send: a forward that silently
// drops its attachment is a wrong mail, and mail cannot be recalled.
// `fetch` is a parameter so the resolution can be exercised without a mail
// store; every caller uses the default.
async function resolveSendAttachments(account, attachments, fetch = attachment) {
  if (!Array.isArray(attachments) || !attachments.some(isAttachmentRef)) return attachments;
  const out = [];
  for (const a of attachments) {
    if (!isAttachmentRef(a)) { out.push(a); continue; }
    const from = a.account || account;
    const uid = String(a.uid != null ? a.uid : a.emailId);
    let att;
    try {
      att = await fetch({ account: from, uid, attachmentId: String(a.attachmentId) });
    } catch (err) {
      throw new Error(`attachment "${a.filename || a.attachmentId}" could not be fetched: ${err.message}`);
    }
    out.push({
      filename: a.filename || att.filename || 'attachment',
      contentType: a.contentType || a.mimeType || att.mimeType || 'application/octet-stream',
      base64Data: att.data,
    });
  }
  validateAttachments(out); // the size ceilings apply to what actually goes out
  return out;
}

// Send via Gmail API or SMTP (+APPEND-to-Sent) by account type. The sent copy
// flows back through sync as a normal row; Gmail returns its id immediately.
// The send log is written first so the send is queryable before the next sync.
async function send(params, origin = { source: 'bridge' }) {
  validateSend(params);
  const { account } = params;
  // strict: an unknown address is refused by name here, so this is also the
  // known-account check — one implementation, not one per caller.
  const type = accountType(account, { strict: true });
  const p = providers[type];
  if (!p?.send) throw new Error(`No ${type} send provider loaded for ${account}`);
  const attachments = await resolveSendAttachments(account, params.attachments);
  const outbound = attachments === params.attachments ? params : { ...params, attachments };
  const result = await p.send(account, outbound);
  await logSend(outbound, result, origin);
  dispatch('email:sent', {
    account,
    uid: result.uid || null,
    to: params.to,
    subject: params.subject,
    inReplyTo: params.inReplyTo || null,
    origin,
  });
  return { ok: true, ...result };
}

// Outbound mail as one queryable stream: the send log (ours, instant, carries
// provenance) unioned with the synced Sent folder (catches sends made by hand
// from Gmail/phone/another client). Deduped by Message-ID, falling back to
// provider uid — the same physical message reaches us through both paths.
//
// Filters are OR-matched within the "which conversation" group (threadId,
// inReplyTo, subject) and AND-matched against account/to/since, because a
// caller asking "has this thread been answered?" holds only some of those keys.
//
// `includeBody` adds the full sent text as `body` on each item. It is off by
// default and `snippet` is unaffected either way: the common read ("has this
// been answered?") stays a list of headers, and a surface that wants to show
// what was sent opts in rather than pulling up to 60k chars per item it will
// not render. Only `via:'log'` items can carry it — the send log stores the
// outgoing text; a `via:'folder'` item is a headers-only Sent-folder row, so
// its `body` is null and the caller fetches it with `email.get({ uid })`.
async function listSent({
  account, threadId, inReplyTo, to, subject, since, limit = 50, includeBody = false,
} = {}) {
  const wantBody = includeBody === true || includeBody === 'true';
  const subjectNorm = subject ? normalizeSubject(subject) : null;
  const convo = [];
  const convoVals = [];
  if (threadId) { convo.push('thread_id = ?'); convoVals.push(threadId); }
  if (inReplyTo) { convo.push('in_reply_to = ?'); convoVals.push(inReplyTo); }
  if (subjectNorm) { convo.push('subject_norm = ?'); convoVals.push(subjectNorm); }

  const where = [];
  const vals = [];
  if (account) { where.push('account = ?'); vals.push(account); }
  if (since) { where.push('sent_at >= ?'); vals.push(new Date(since)); }
  if (to) { where.push('recipient LIKE ?'); vals.push(`%${to}%`); }
  if (convo.length) { where.push(`(${convo.join(' OR ')})`); vals.push(...convoVals); }

  const cap = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const c = await conn();
  let logged = [];
  try {
    logged = await c.query(
      `SELECT * FROM platform_email_sent
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY sent_at DESC LIMIT ?`,
      [...vals, cap]
    );
  } finally {
    c.release();
  }

  const items = logged.map((r) => ({
    account: r.account,
    messageId: r.message_id,
    threadId: r.thread_id,
    inReplyTo: r.in_reply_to,
    uid: r.provider_uid,
    to: r.recipient, cc: r.cc, bcc: r.bcc,
    subject: r.subject,
    snippet: String(r.body || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    ...(wantBody ? { body: r.body == null ? null : String(r.body) } : {}),
    sentAt: r.sent_at,
    hasAttachments: !!r.has_attachments,
    origin: { source: r.origin_source, app: r.origin_app, proposalId: r.proposal_id },
    via: 'log',
  }));

  // Synced Sent folder — the same query shape, minus in_reply_to (not a column
  // on platform_emails; a manual reply is matched by thread or subject).
  const folderParams = { account, folder: 'Sent', limit: cap, fields: 'meta', withTotal: false };
  if (threadId) folderParams.threadId = threadId;
  if (since) folderParams.since = since;
  let synced = [];
  try {
    const r = await listEmails(folderParams, null);
    synced = r.emails || [];
  } catch { /* Sent folder may not be synced for this account */ }

  const seen = new Set(items.flatMap((i) => [i.messageId, i.uid].filter(Boolean).map(String)));
  for (const e of synced) {
    if (subjectNorm && !threadId && normalizeSubject(e.subject) !== subjectNorm) continue;
    if (to && !String(e.to || '').includes(to)) continue;
    const keys = [e.messageId, e.id].filter(Boolean).map(String);
    if (keys.some((k) => seen.has(k))) continue;
    keys.forEach((k) => seen.add(k));
    items.push({
      account: e.account,
      messageId: e.messageId,
      threadId: e.threadId,
      inReplyTo: null,
      uid: e.id,
      to: e.to, cc: e.cc, bcc: null,
      subject: e.subject,
      snippet: e.snippet,
      ...(wantBody ? { body: null } : {}),
      sentAt: e.date,
      hasAttachments: (e.attachments || []).length > 0,
      origin: null,
      via: 'folder',
    });
  }

  items.sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0));
  return { sent: items.slice(0, cap), total: items.length };
}

// "Which of these have I answered?" — the read behind the &#8617; badge.
//
// The sent log records the Message-ID each send replied to, so the store
// already knows; it just had no read shaped like a page of an inbox. An app
// rendering the badge otherwise has to keep its own table of what it sent,
// which is a copy that starts drifting the first time a reply goes out from
// Horst, Telegram or another surface.
//
// Anchored on in_reply_to and nothing else: answering the newest mail of a
// thread does not mean the owner answered the one from three months ago.
async function repliedTo({ account, messageIds } = {}) {
  const ids = [...new Set((messageIds || []).filter(Boolean).map(String))].slice(0, 500);
  if (!account || !ids.length) return {};
  const c = await conn();
  try {
    const rows = await c.query(
      `SELECT in_reply_to, MAX(sent_at) AS last_sent FROM platform_email_sent
        WHERE account = ? AND in_reply_to IN (${ids.map(() => "?").join(",")})
        GROUP BY in_reply_to`,
      [account, ...ids],
    );
    const out = {};
    for (const r of rows) {
      if (r.in_reply_to) out[r.in_reply_to] = r.last_sent ? new Date(r.last_sent).toISOString() : null;
    }
    return out;
  } finally {
    c.release();
  }
}

// --- Sender history ----------------------------------------------------------
// Deterministic relationship data from the user's own mail store: how often an
// address has written to the user, and whether the user has ever written back.
// Unlike the From header this cannot be forged by the mail's author, and unlike
// a mined memory fact it cannot be poisoned by a misclassified mail — it is the
// classifier's "do I actually know this sender?" signal (horst-triage).

const ADDR_EXTRACT_RE = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+\.[a-z0-9-]{2,}/gi;

function extractAddresses(...fields) {
  const out = [];
  for (const f of fields) {
    for (const m of String(f || '').matchAll(ADDR_EXTRACT_RE)) out.push(m[0].toLowerCase());
  }
  return out;
}

// addresses: string[] → Map<address, {inboundCount, sentCount, firstSeen}>.
// inboundCount includes the mail currently under triage (it is already synced
// when the sweep reads it), so inboundCount === 1 means "first contact".
async function senderHistory(addresses) {
  const out = new Map();
  const addrs = [...new Set((addresses || [])
    .map((a) => String(a || '').trim().toLowerCase())
    .filter((a) => a.includes('@')))];
  if (!addrs.length) return out;
  if (!isReady()) return out; // empty map: unknown history must not read as "first contact"
  for (const a of addrs) out.set(a, { inboundCount: 0, sentCount: 0, firstSeen: null });

  const c = await conn();
  try {
    // Inbound mail from these addresses (grouped by raw header; attributed to
    // whichever queried address the header contains).
    const inbound = await c.query(
      `SELECT sender, COUNT(*) AS n, MIN(date) AS first_seen
         FROM platform_emails
        WHERE is_deleted = 0 AND folder != 'Sent' AND (${addrs.map(() => 'sender LIKE ?').join(' OR ')})
        GROUP BY sender`,
      addrs.map((a) => `%${a}%`),
    );
    for (const r of inbound) {
      const senderLc = String(r.sender || '').toLowerCase();
      for (const a of addrs) {
        if (!senderLc.includes(a)) continue;
        const h = out.get(a);
        h.inboundCount += Number(r.n) || 0;
        if (r.first_seen && (!h.firstSeen || r.first_seen < h.firstSeen)) h.firstSeen = r.first_seen;
      }
    }

    // Outbound: synced Sent folder + the app send log.
    const sentFolder = await c.query(
      `SELECT recipient, cc FROM platform_emails
        WHERE is_deleted = 0 AND folder = 'Sent' AND (${addrs.map(() => '(recipient LIKE ? OR cc LIKE ?)').join(' OR ')})`,
      addrs.flatMap((a) => [`%${a}%`, `%${a}%`]),
    );
    const sentLog = await c.query(
      `SELECT recipient, cc, bcc FROM platform_email_sent
        WHERE ${addrs.map(() => '(recipient LIKE ? OR cc LIKE ? OR bcc LIKE ?)').join(' OR ')}`,
      addrs.flatMap((a) => [`%${a}%`, `%${a}%`, `%${a}%`]),
    );
    for (const r of [...sentFolder, ...sentLog]) {
      const rcpts = new Set(extractAddresses(r.recipient, r.cc, r.bcc));
      for (const a of addrs) if (rcpts.has(a)) out.get(a).sentCount++;
    }
  } finally {
    c.release();
  }
  return out;
}

// --- Participants ("who is X?") --------------------------------------------
//
// The mail store already knows every address the owner has ever corresponded
// with — it is sitting in `sender`/`recipient`/`cc` on every row. my-dashboard
// built a second copy of that knowledge (an `email_participants` table) because
// the engine exposed no way to ask; this is the engine answering instead.
//
// No new index: the headers are scanned over a recent window plus the FULLTEXT
// hits for the query, which is what makes a name like "Anna" findable even
// though no column holds it on its own.

// `"Anna Meier" <anna@x.test>`, `Anna Meier <anna@x.test>`, `anna@x.test`.
const PARTICIPANT_RE = /(?:"([^"]*)"|([^<,;"]*?))\s*<\s*([^\s<>,;]+@[^\s<>,;]+)\s*>|([^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+\.[a-z0-9-]{2,})/gi;

function parseParticipants(field) {
  const out = [];
  for (const m of String(field || '').matchAll(PARTICIPANT_RE)) {
    const address = String(m[3] || m[4] || '').toLowerCase().replace(/^[<'"]+|[>'"]+$/g, '');
    if (!address.includes('@')) continue;
    const name = String(m[1] || m[2] || '').trim().replace(/^['"]+|['"]+$/g, '');
    out.push({ address, name });
  }
  return out;
}

const PARTICIPANT_SCAN = 4000; // recent-window cap; the FULLTEXT hits are added on top
const PARTICIPANT_JUNK = ['trash', 'spam', 'junk'];

// Find the people behind a query — a name, a domain, a partial address.
// Returns `[{ address, names, count, seenAs, lastSeen, isOwnAccount, examples }]`
// ordered by how often they appear, which is the closest thing the store has to
// "how well does the owner know this person".
async function lookupParticipants(query, { limit = 10, account } = {}) {
  const terms = String(query || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!terms.length) throw new Error('lookupParticipants requires a query');
  if (!isReady()) return [];
  const cap = Math.min(Math.max(Number(limit) || 10, 1), 25);

  const cols = 'account, uid, sender, recipient, cc, subject, date, internal_date, folder';
  const junk = PARTICIPANT_JUNK.map(() => 'LOWER(folder) != ?').join(' AND ');
  const acctWhere = account ? ' AND account = ?' : '';
  const c = await conn();
  let rows;
  try {
    // Two pools, deliberately: the recent window answers "who do I deal with",
    // the FULLTEXT hits answer "who is this person I spoke to in 2021".
    const [recent, matched] = await Promise.all([
      c.query(
        `SELECT ${cols} FROM platform_emails
          WHERE is_deleted = 0 AND ${junk}${acctWhere}
          ORDER BY internal_date DESC LIMIT ?`,
        [...PARTICIPANT_JUNK, ...(account ? [account] : []), PARTICIPANT_SCAN],
      ),
      c.query(
        `SELECT ${cols} FROM platform_emails
          WHERE is_deleted = 0 AND ${junk}${acctWhere}
            AND MATCH(subject, body, sender, recipient, cc) AGAINST(? IN BOOLEAN MODE)
          ORDER BY internal_date DESC LIMIT ?`,
        [...PARTICIPANT_JUNK, ...(account ? [account] : []), require('./fulltext-query').sanitize(terms.join(' ')), 500],
      ).catch(() => []),
    ]);
    const seen = new Set();
    rows = [...recent, ...matched].filter((r) => {
      const k = `${r.account}\u0000${r.uid}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } finally { c.release(); }

  const own = new Set(knownAccounts().map((a) => String(a || '').toLowerCase()));
  const hits = new Map();
  for (const r of rows) {
    const date = r.date || null;
    for (const [field, seenAs] of [[r.sender, 'from'], [r.recipient, 'to'], [r.cc, 'cc']]) {
      for (const { address, name } of parseParticipants(field)) {
        const hay = `${address} ${name}`.toLowerCase();
        // Every term must appear somewhere in the address or the name, so
        // "anna meier" does not match every Anna in the store.
        if (!terms.every((t) => hay.includes(t))) continue;
        let hit = hits.get(address);
        if (!hit) {
          hit = { address, names: new Set(), count: 0, seenAs: { from: 0, to: 0, cc: 0 }, lastSeen: null, examples: [] };
          hits.set(address, hit);
        }
        if (name) hit.names.add(name);
        hit.count++;
        hit.seenAs[seenAs]++;
        if (date && (!hit.lastSeen || date > hit.lastSeen)) hit.lastSeen = date;
        if (hit.examples.length < 3) {
          hit.examples.push({ account: r.account, emailId: String(r.uid), subject: r.subject || '', date, folder: r.folder });
        }
      }
    }
  }

  return [...hits.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, cap)
    .map((h) => ({ ...h, names: [...h.names], isOwnAccount: own.has(h.address) || undefined }));
}

// Every address the user has ever written to (Sent folder + send log) — the
// evidence set for "corresponds with X". Consumed by the one-time contact-fact
// cleanup in memory-maintenance.
async function sentRecipientAddresses() {
  const out = new Set();
  if (!isReady()) return out;
  const c = await conn();
  try {
    const folderRows = await c.query(
      `SELECT recipient, cc FROM platform_emails WHERE folder = 'Sent'`,
    );
    const logRows = await c.query(
      `SELECT recipient, cc, bcc FROM platform_email_sent`,
    );
    for (const r of [...folderRows, ...logRows]) {
      for (const a of extractAddresses(r.recipient, r.cc, r.bcc)) out.add(a);
    }
  } finally {
    c.release();
  }
  return out;
}

// Cache-or-fetch attachment, returns base64 (plan A4 email.attachment).
async function attachment({ account, uid, attachmentId }) {
  const c = await conn();
  try {
    const rows = await c.query(
      `SELECT filename, mime_type, content FROM platform_email_attachments
       WHERE account = ? AND email_uid = ? AND attachment_id = ? AND content IS NOT NULL LIMIT 1`,
      [account, String(uid), String(attachmentId)]
    );
    if (rows.length) {
      return {
        filename: rows[0].filename,
        mimeType: rows[0].mime_type,
        size: rows[0].content.length,
        data: rows[0].content.toString('base64'),
        cached: true,
      };
    }
  } finally {
    c.release();
  }

  const type = accountType(account);
  const p = providers[type];
  if (!p?.fetchAttachment) throw new Error(`No ${type} attachment provider loaded for ${account}`);
  const fetched = await p.fetchAttachment(account, String(uid), String(attachmentId));
  const content = Buffer.isBuffer(fetched) ? fetched : fetched.content;
  const filename = fetched.filename || 'attachment';
  const mimeType = fetched.mimeType || 'application/octet-stream';

  const c2 = await conn();
  try {
    // A row whose blob was pruned (content NULLed by runMaintenanceSweep) is
    // refilled in place — fetched_at restarts its LRU clock — instead of
    // accumulating a duplicate row per re-fetch.
    const upd = await c2.query(
      `UPDATE platform_email_attachments
       SET filename = ?, mime_type = ?, size = ?, content = ?, fetched_at = CURRENT_TIMESTAMP
       WHERE account = ? AND email_uid = ? AND attachment_id = ? AND content IS NULL`,
      [filename, mimeType, content.length, content, account, String(uid), String(attachmentId)]
    );
    if (!Number(upd.affectedRows)) {
      await c2.query(
        `INSERT INTO platform_email_attachments (account, email_uid, filename, mime_type, size, content, attachment_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [account, String(uid), filename, mimeType, content.length, content, String(attachmentId)]
      );
    }
  } catch (err) {
    console.error('  Email engine: attachment cache write failed:', err.message);
  } finally {
    c2.release();
  }
  return { filename, mimeType, size: content.length, data: content.toString('base64'), cached: false };
}

// Write-through IMAP mailboxCreate; no-op metadata for Gmail (plan Q2).
async function createFolder({ account, name }) {
  if (!account || !name) throw new Error('createFolder requires account and name');
  if (accountType(account) === 'gmail') return { ok: true, name, gmail: true };
  const p = providers.imap;
  if (!p?.createFolder) throw new Error(`No IMAP provider loaded for ${account}`);
  return p.createFolder(account, name);
}

// ---------------------------------------------------------------------------
// Sender rules — the engine-level junk filter (Architecture D, 2026-08).
// "Mail from these senders is junk" is user-life configuration, so it lives in
// the ENGINE and is enforced at sync time: rule-matched arrivals are moved to
// Trash (server-side too) BEFORE email:new is dispatched, so no consumer —
// classifier, briefing, apps — ever sees them. This dissolves the old race
// where an app's arrival handler had to out-run the platform classifier.
// Store: <appsDir>/.email-rules.json — { rules: [{id, type:'sender'|'domain',
// value, createdAt}] }. Apps edit it via the email.rules.* surface.
// ---------------------------------------------------------------------------

let _senderRules = null; // cached; reloaded on set, loaded lazily on first use

function rulesPath() { return path.join(appsDir, '.email-rules.json'); }

function loadSenderRules() {
  // Never cache before init(): appsDir is still null, so the read would throw and
  // an empty rule list would stick for the life of the process — silently
  // disabling the junk filter. (Same guard as loadLabels below.)
  if (!appsDir) return [];
  if (_senderRules) return _senderRules;
  try { _senderRules = JSON.parse(fs.readFileSync(rulesPath(), 'utf8')).rules || []; }
  catch { _senderRules = []; }
  return _senderRules;
}

function saveSenderRules(rules) {
  if (!appsDir) throw new Error('Email engine not ready — cannot write sender rules');
  _senderRules = rules;
  const tmp = rulesPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ rules }, null, 2));
  fs.renameSync(tmp, rulesPath());
}

function ruleSenderAddress(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

// The owner's own addresses, lowercased — both vaults (knownAccounts).
function ownAddressSet() {
  return new Set(knownAccounts().map((a) => String(a || '').trim().toLowerCase()).filter(Boolean));
}

// A sender rule on one of the owner's own addresses would trash every copy of
// their own outgoing mail that syncs back (and any self-addressed note). Refused
// here, on the method every entry point reaches — ctx, Bridge and the
// email.rule.add kind's validate. Exact address only: a domain rule on the
// owner's domain is a real (if drastic) choice and stays the owner's.
function assertRuleAllowed({ type, value } = {}) {
  if (type !== 'sender') return;
  const v = String(value || '').trim().toLowerCase();
  if (v && ownAddressSet().has(v)) throw new Error(`"${v}" is one of your own accounts — a sender rule on it would trash your own mail`);
}

// Returns the first matching rule (or null) so callers can attribute the hit.
// A sender rule naming an own address never matches: one written before the
// guard existed stays in the store, inert, until the owner removes it.
function matchSenderRule(from, rules = loadSenderRules()) {
  if (!rules.length) return null;
  const sender = ruleSenderAddress(from);
  if (!sender) return null;
  const domain = sender.split('@')[1] || '';
  let own = null;
  for (const rule of rules) {
    if (rule.type === 'sender' && sender === rule.value) {
      if (!own) own = ownAddressSet();
      if (!own.has(sender)) return rule;
      continue;
    }
    if (rule.type === 'domain' && (domain === rule.value || domain.endsWith('.' + rule.value))) return rule;
  }
  return null;
}

function matchesSenderRules(from, rules = loadSenderRules()) {
  return matchSenderRule(from, rules) != null;
}

// Provenance for every rule-trashing: bump the rule's hitCount/lastMatchedAt
// (rendered by the Spam panel so dead rules are prunable) and write a
// 'rule-match' annotation (writer 'platform') so Trash views can show WHY the
// mail vanished. Annotations are best-effort — the move itself never waits.
function recordRuleHits(hits) {
  if (!hits.length) return;
  const rules = loadSenderRules();
  const byId = new Map(rules.map((r) => [r.id, r]));
  const now = Date.now();
  for (const { rule } of hits) {
    const stored = byId.get(rule.id);
    if (!stored) continue; // rule removed mid-flight
    stored.hitCount = (Number(stored.hitCount) || 0) + 1;
    stored.lastMatchedAt = now;
  }
  try { saveSenderRules(rules); } catch (err) { console.warn('[email-rules] hit-count save failed:', err.message); }
  for (const { rule, account, uid } of hits) {
    annotate({
      account, uid, kind: 'rule-match',
      data: { ruleId: rule.id, type: rule.type, value: rule.value, at: now },
    }, 'platform').catch(() => {});
  }
}

function listRules() { return loadSenderRules().slice(); }

function addRule({ type, value }) {
  if (!['sender', 'domain'].includes(type)) throw new Error('rule type must be sender or domain');
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) throw new Error('rule value required');
  assertRuleAllowed({ type, value: normalized });
  const rules = loadSenderRules();
  const existing = rules.find((r) => r.type === type && r.value === normalized);
  if (existing) return { rule: existing, existed: true };
  const rule = { id: 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), type, value: normalized, createdAt: Date.now() };
  saveSenderRules([...rules, rule]);
  return { rule, existed: false };
}

function removeRule(id) {
  const rules = loadSenderRules();
  const next = rules.filter((r) => r.id !== id);
  saveSenderRules(next);
  return { ok: true, removed: rules.length - next.length };
}

// Backlog sweep: move every existing INBOX/Spam match to Trash (server-side).
// Used on rule add/apply; new arrivals are handled at sync time (upsertEmails).
async function applyRules({ rules, accounts } = {}) {
  const active = rules || loadSenderRules();
  if (!active.length) return { moved: 0 };
  const accts = accounts || (() => {
    try { return require('./email-accounts').list().map((a) => a.email); } catch { return []; }
  })();
  let moved = 0;
  const hits = [];
  for (const account of accts) {
    for (const folder of ['INBOX', 'Spam']) {
      try {
        const { emails } = await listEmails({ account, folder, limit: 1000 }, null);
        for (const m of emails || []) {
          const rule = matchSenderRule(m.from, active);
          if (!rule) continue;
          try {
            await modify({ account, uid: String(m.id), move: 'Trash' }, { source: 'rules' });
            moved++;
            hits.push({ rule, account, uid: String(m.id) });
          } catch (err) { console.warn(`[email-rules] sweep move failed (${m.id}):`, err.message); }
        }
      } catch { /* folder may not exist for this account */ }
    }
  }
  if (hits.length) {
    console.log(`[email-rules] backlog sweep trashed ${hits.length} email(s)`);
    recordRuleHits(hits);
  }
  return { moved };
}

// ---------------------------------------------------------------------------
// Labels — the shared tag vocabulary (2026-08).
// Same reasoning as sender rules above: "these are my labels" is user-life
// configuration, not one app's private setting. It lives in the ENGINE so the
// classifier and every app work from ONE vocabulary instead of a copy that
// drifts. Horst's triage prompt reads it (horst-triage labelVocabulary());
// apps read AND edit it through email.labels.* — platform-owned never means
// app-locked.
// Store: <appsDir>/.email-labels.json — { labels: [{id, name, color, endDate?,
// createdAt}] }. The shape matches my-dashboard's pre-existing tag object
// exactly, ids included, so its email_tags assignments survive the move with no
// data migration.
// ---------------------------------------------------------------------------

let _labels = null; // cached; reloaded on save, loaded lazily on first use

function labelsPath() { return path.join(appsDir, '.email-labels.json'); }

function loadLabels() {
  // Never cache before init(): appsDir is still null, so the read would fail and
  // an empty list would stick for the life of the process.
  if (!appsDir) return [];
  if (_labels) return _labels;
  try { _labels = JSON.parse(fs.readFileSync(labelsPath(), 'utf8')).labels || []; }
  catch { _labels = []; }
  return _labels;
}

function saveLabels(labels) {
  if (!appsDir) throw new Error('Email engine not ready — cannot write labels');
  _labels = labels;
  const tmp = labelsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ labels }, null, 2));
  fs.renameSync(tmp, labelsPath());
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function labelId(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return (base || 'label') + '-' + crypto.randomBytes(3).toString('hex');
}

function listLabels() { return loadLabels().slice(); }

function addLabel({ id, name, color, endDate } = {}) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('label name required');
  if (clean.length > 60) throw new Error('label name too long (60 max)');
  const labels = loadLabels();
  const existing = labels.find((l) => l.name.toLowerCase() === clean.toLowerCase());
  if (existing) return { label: existing, existed: true };
  // An explicit id is honoured so a migrating app can preserve the ids its own
  // assignment rows already reference.
  const label = {
    id: id || labelId(clean),
    name: clean,
    color: HEX_COLOR.test(color || '') ? color : '#64748b',
    createdAt: Date.now(),
  };
  if (ISO_DATE.test(endDate || '')) label.endDate = endDate;
  saveLabels([...labels, label]);
  return { label, existed: false };
}

function updateLabel(id, { name, color, endDate } = {}) {
  const labels = loadLabels();
  const label = labels.find((l) => l.id === id);
  if (!label) throw new Error('label not found');
  if (name != null) {
    const clean = String(name).trim();
    if (!clean) throw new Error('label name required');
    if (clean.length > 60) throw new Error('label name too long (60 max)');
    if (labels.some((l) => l.id !== id && l.name.toLowerCase() === clean.toLowerCase())) {
      throw new Error(`label "${clean}" already exists`);
    }
    label.name = clean;
  }
  if (HEX_COLOR.test(color || '')) label.color = color;
  if (endDate !== undefined) {
    if (ISO_DATE.test(endDate || '')) label.endDate = endDate;
    else delete label.endDate;
  }
  saveLabels(labels);
  return { label };
}

function removeLabel(id) {
  const labels = loadLabels();
  const next = labels.filter((l) => l.id !== id);
  saveLabels(next);
  return { ok: true, removed: labels.length - next.length };
}

// ---------------------------------------------------------------------------
// Tag membership — the `tags` annotation (writer 'platform', email-tags.js).
// The classifier and every app write the SAME document, so a view, Horst's
// chat and the `tag:` search operator all see one answer per message.
// ---------------------------------------------------------------------------

async function readTagDoc(account, uid) {
  const [row] = await annotations({ account, uid, kinds: [emailTags.KIND] }, emailTags.WRITER);
  return row ? row.data : null;
}

// The sender is learned once, from the message itself, so a sender-rule miner
// never needs a second read.
async function tagSender(account, uid, data) {
  if (data && data.sender) return data.sender;
  const c = await conn();
  try {
    const rows = await c.query('SELECT sender FROM platform_emails WHERE account = ? AND uid = ?', [account, String(uid)]);
    return rows.length ? (ruleSenderAddress(rows[0].sender) || null) : null;
  } finally {
    c.release();
  }
}

async function writeTagDoc(account, uid, before, after) {
  // Nothing changed → nothing written: a document that only restates itself
  // would still fire an `email:annotated` event and a row update.
  if (before && JSON.stringify(before) === JSON.stringify(after)) return { ok: true, changed: false };
  // No document and nothing to put in one: most mail carries no tag, and an
  // empty document per message would be a row for every mail ever synced.
  if (!before && !Object.keys(after.tags || {}).length) return { ok: true, changed: false };
  await annotate({ account, uid, kind: emailTags.KIND, data: after }, emailTags.WRITER);
  return { ok: true, changed: true };
}

// Automatic assignment: replaces the entries of `source` ('ai' by default;
// 'rule' for an app's deterministic sender tagging) and touches nothing else.
async function assignTags(account, uid, tagIds, { source = 'ai' } = {}) {
  if (!account || uid == null) throw new Error('assignTags requires account and uid');
  const ids = [...new Set((tagIds || []).map(String).filter(Boolean))];
  const before = await readTagDoc(account, uid);
  const after = emailTags.applyAutoAssign(before, ids, await tagSender(account, uid, before), source);
  return writeTagDoc(account, uid, before, after);
}

// The owner's decision: an add is theirs from now on, a removal is a tombstone.
async function setTags(account, uid, { add = [], remove = [] } = {}) {
  if (!account || uid == null) throw new Error('setTags requires account and uid');
  const before = await readTagDoc(account, uid);
  const after = emailTags.applyUserEdit(before, { add: add.map(String), remove: remove.map(String) }, await tagSender(account, uid, before));
  return writeTagDoc(account, uid, before, after);
}

// [{ id, source }] — tombstones dropped, ids of deleted labels included (the
// caller renders against listLabels(); an orphan simply has no name).
async function tagsOf(account, uid) {
  if (!account || uid == null) throw new Error('tagsOf requires account and uid');
  return emailTags.mergeTags(await readTagDoc(account, uid));
}

// ---------------------------------------------------------------------------
// Annotations — kind-keyed, app-scoped (write own-only, shared read).
// appName is stamped server-side by the bridge (cannot be impersonated).
// ---------------------------------------------------------------------------
async function annotate({ account, uid, kind = 'default', data }, appName) {
  if (!appName) throw new Error('annotate requires an app identity');
  if (!account || !uid) throw new Error('annotate requires account and uid');
  const c = await conn();
  try {
    await c.query(
      `INSERT INTO platform_email_annotations (account, email_uid, app_name, kind, data)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [account, String(uid), appName, kind, JSON.stringify(data ?? null)]
    );
  } finally {
    c.release();
  }
  dispatch('email:annotated', { account, uid: String(uid), appName, kind });
  return { ok: true };
}

async function annotations({ account, uid, kinds, scope = 'mine' }, appName) {
  const c = await conn();
  try {
    const where = ['account = ?', 'email_uid = ?'];
    const vals = [account, String(uid)];
    if (scope !== 'all') { where.push('app_name = ?'); vals.push(appName); }
    if (kinds?.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); vals.push(...kinds); }
    const rows = await c.query(
      `SELECT app_name, kind, data, updated_at FROM platform_email_annotations WHERE ${where.join(' AND ')}`,
      vals
    );
    return rows.map((r) => {
      let data = r.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
      return { appName: r.app_name, kind: r.kind, data, updatedAt: r.updated_at };
    });
  } finally {
    c.release();
  }
}

// Batch/watermark read across emails — for apps consuming another app's
// annotations (e.g. the platform classifier's 'email-intel'). Unlike
// annotations(), this does not require a uid: filter by writer app + kind,
// optionally `since` (updated_at watermark) and/or a `uids` list. Read-only
// and cross-app by design (annotation reads were always shared; this is the
// bulk form so consumers don't N+1 on startup catch-up).
async function listAnnotations({ appName: writerApp, kind, account, since, uids, limit = 500 } = {}) {
  if (!writerApp || !kind) throw new Error('listAnnotations requires appName and kind');
  const c = await conn();
  try {
    const where = ['app_name = ?', 'kind = ?'];
    const vals = [writerApp, kind];
    if (account) { where.push('account = ?'); vals.push(account); }
    if (since) { where.push('updated_at > ?'); vals.push(new Date(since)); }
    if (uids?.length) { where.push(`email_uid IN (${uids.map(() => '?').join(',')})`); vals.push(...uids.map(String)); }
    const rows = await c.query(
      `SELECT account, email_uid, kind, data, updated_at FROM platform_email_annotations
       WHERE ${where.join(' AND ')} ORDER BY updated_at ASC LIMIT ?`,
      [...vals, Math.min(Math.max(Number(limit) || 500, 1), 2000)]
    );
    return rows.map((r) => {
      let data = r.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
      return { account: r.account, uid: r.email_uid, kind: r.kind, data, updatedAt: r.updated_at };
    });
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// Retention maintenance — one cron job (email:maintenance-sweep, self-
// registered below) covering three opt-in sweeps, all default OFF:
//   deletedPruneEnabled   — hard-delete is_deleted rows (UIDVALIDITY sweeps,
//                           old trash) older than deletedPruneDays
//   attachmentPruneEnabled — NULL cached attachment blobs older than
//                           attachmentPruneDays (row kept; re-fetch on demand)
//   sentRetentionDays > 0 — trim the platform_email_sent send log
// Each sweep is batched (MAINT_BATCH per statement) so a large backlog never
// holds a connection or the event loop for long; the next tick continues.
// ---------------------------------------------------------------------------
const MAINT_BATCH = 200;
const MAINT_MAX_BATCHES = 50; // per tick — backlog drains across ticks
let _maintaining = false;

// Hard-delete is_deleted rows past the age cutoff. Follows the permanent-delete
// path (tombstone first, then hardDeleteRow's row+attachments+annotations
// purge) so a copy still on the server — Trash not yet expunged upstream —
// cannot resurrect on resync. Rows with a queued pending op are skipped: the
// op is the record that the mail server hasn't been told yet.
async function pruneDeletedRows() {
  const days = Math.max(1, Number(getSetting('deletedPruneDays')) || 30);
  let purged = 0;
  for (let guard = 0; guard < MAINT_MAX_BATCHES; guard++) {
    const c = await conn();
    let rows;
    try {
      rows = await c.query(
        `SELECT e.account, e.uid, e.message_id FROM platform_emails e
         WHERE e.is_deleted = TRUE
           AND COALESCE(e.deleted_at, e.updated_at) < (NOW() - INTERVAL ? DAY)
           AND NOT EXISTS (SELECT 1 FROM platform_email_pending_ops p
                           WHERE p.account = e.account AND p.uid = e.uid)
         LIMIT ?`,
        [days, MAINT_BATCH]
      );
    } finally {
      c.release();
    }
    if (!rows.length) break;
    for (const r of rows) {
      await addTombstone(r.account, String(r.uid), r.message_id || null);
      await hardDeleteRow(r.account, String(r.uid));
      purged++;
    }
    if (rows.length < MAINT_BATCH) break;
  }
  if (purged) console.log(`  Email engine: maintenance purged ${purged} is_deleted row(s) older than ${days}d`);
  return { purged, days };
}

// NULL cached attachment blobs past the age cutoff, oldest fetched first (LRU).
// The row survives so attachment() re-fetches from the provider on demand and
// refills it in place (see the cache write there).
async function pruneAttachmentBlobs() {
  const days = Math.max(1, Number(getSetting('attachmentPruneDays')) || 180);
  let pruned = 0;
  for (let guard = 0; guard < MAINT_MAX_BATCHES; guard++) {
    const c = await conn();
    let res;
    try {
      res = await c.query(
        `UPDATE platform_email_attachments SET content = NULL
         WHERE content IS NOT NULL AND fetched_at < (NOW() - INTERVAL ? DAY)
         ORDER BY fetched_at ASC LIMIT ?`,
        [days, MAINT_BATCH]
      );
    } finally {
      c.release();
    }
    const n = Number(res.affectedRows) || 0;
    pruned += n;
    if (n < MAINT_BATCH) break;
  }
  if (pruned) console.log(`  Email engine: maintenance dropped ${pruned} cached attachment blob(s) older than ${days}d`);
  return { pruned, days };
}

// Trim the send log. sentRetentionDays doubles as the enable switch: 0 (the
// default) keeps every row forever.
async function pruneSentLog() {
  const days = Math.max(1, Number(getSetting('sentRetentionDays')));
  let trimmed = 0;
  for (let guard = 0; guard < MAINT_MAX_BATCHES; guard++) {
    const c = await conn();
    let res;
    try {
      res = await c.query(
        `DELETE FROM platform_email_sent
         WHERE sent_at < (NOW() - INTERVAL ? DAY)
         ORDER BY sent_at ASC LIMIT ?`,
        [days, MAINT_BATCH]
      );
    } finally {
      c.release();
    }
    const n = Number(res.affectedRows) || 0;
    trimmed += n;
    if (n < MAINT_BATCH) break;
  }
  if (trimmed) console.log(`  Email engine: maintenance trimmed ${trimmed} send-log row(s) older than ${days}d`);
  return { trimmed, days };
}

// Cron entry (email.maintenance-sweep). Single-flight like runDeleteSweep;
// every sweep is gated on its own opt-in setting.
async function runMaintenanceSweep() {
  if (!isReady()) return { ok: true, skipped: true };
  if (_maintaining) return { ok: true, skipped: true };
  _maintaining = true;
  try {
    const out = { ok: true };
    if (getSetting('deletedPruneEnabled')) out.deleted = await pruneDeletedRows();
    if (getSetting('attachmentPruneEnabled')) out.attachments = await pruneAttachmentBlobs();
    if (Number(getSetting('sentRetentionDays')) > 0) out.sent = await pruneSentLog();
    return out;
  } finally {
    _maintaining = false;
  }
}

// Register the persistent job if absent (dedup-by-name, ensureMailJobs
// pattern). Lives here rather than in index.js ensureMailJobs so the sweep
// ships entirely with the engine; called once the schema is ready.
function ensureMaintenanceJob() {
  try {
    const existing = new Set(platformCron.list().map((j) => j.name));
    if (existing.has('email:maintenance-sweep')) return;
    const res = platformCron.addJob({
      name: 'email:maintenance-sweep',
      schedule: getSetting('maintenanceSchedule'),
      target: { type: 'internal', handler: 'email.maintenance-sweep' },
    });
    if (!res.ok) console.error(`  Email engine: failed to register email:maintenance-sweep: ${res.error}`);
  } catch (err) {
    console.error('  Email engine: maintenance job registration failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Status (Setup panel + bridge email.syncStatus)
// ---------------------------------------------------------------------------

// Attachment-cache footprint: total bytes of cached blobs, with a warning once
// past the soft limit. Warning only — pruning stays opt-in (attachmentPrune*).
const ATTACHMENT_CACHE_WARN_BYTES = 500 * 1024 * 1024;

async function attachmentCacheStats() {
  if (!isReady()) return null;
  const c = await conn();
  try {
    const [row] = await c.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(content IS NOT NULL), 0) AS cached,
              COALESCE(SUM(IF(content IS NULL, 0, size)), 0) AS bytes
       FROM platform_email_attachments`
    );
    const bytes = Number(row.bytes) || 0;
    return {
      rows: Number(row.total) || 0,
      cachedBlobs: Number(row.cached) || 0,
      totalBytes: bytes,
      warnBytes: ATTACHMENT_CACHE_WARN_BYTES,
      warning: bytes > ATTACHMENT_CACHE_WARN_BYTES
        ? `Attachment cache holds ${Math.round(bytes / (1024 * 1024))} MB of blobs (soft limit ${Math.round(ATTACHMENT_CACHE_WARN_BYTES / (1024 * 1024))} MB) — consider enabling attachmentPruneEnabled`
        : null,
    };
  } finally {
    c.release();
  }
}

async function status() {
  const accounts = await listSyncState().catch(() => []);
  const attachmentCache = await attachmentCacheStats().catch(() => null);
  return {
    ready: isReady(),
    vector: _vector,
    embedding: embeddings.info(),
    attachmentCache,
    accounts: accounts.map((a) => ({
      account: a.account,
      type: a.account_type,
      status: a.status,
      enabled: !!a.enabled,
      lastSyncAt: a.last_sync_at,
      lastReconcileAt: a.last_reconcile_at,
      lastError: a.last_error,
      backfillTotal: a.backfill_total,
      backfillDone: a.backfill_done,
      settings: accountSettings(a.account),
    })),
  };
}

// ---------------------------------------------------------------------------
// Cron delegation — handlers are registered unconditionally at boot (memory
// pattern); each no-ops until the schema is ready and the provider is loaded.
// ---------------------------------------------------------------------------
async function runGmailPoll() {
  if (!isReady()) return;
  return providers.gmail?.poll?.();
}

async function runImapReconcile() {
  if (!isReady()) return;
  return providers.imap?.reconcile?.();
}

async function runEmbedSweep() {
  if (!isReady() || !_vector) return;
  return providers.embed?.sweep?.();
}

// App rename: annotations are scoped by app_name (reads filter on it, and the
// unique key spans it) — stale rows would make the renamed app's own annotations
// invisible and let duplicates accumulate. UPDATE IGNORE skips the rare row that
// would collide with one left by a previously-deleted app of the new name.
async function renameApp(oldName, newName) {
  const c = await conn();
  try {
    const r = await c.query(
      'UPDATE IGNORE `platform_email_annotations` SET app_name = ? WHERE app_name = ?',
      [newName, oldName]
    );
    return Number(r.affectedRows || 0);
  } finally {
    c.release();
  }
}

module.exports = {
  DB,
  init,
  validateSend,
  validateAttachments,
  knownAccounts,
  assertRuleAllowed,
  assertPurgeable,
  PURGEABLE_FOLDERS,
  initSchema,
  isReady,
  vectorEnabled,
  conn,
  renameApp,
  registerProvider,
  provider,
  accountType,
  getSyncState,
  listSyncState,
  setSyncState,
  registerHandler,
  clearHandlers,
  subscribe,
  dispatch,
  dispatchStatus,
  syncAlertTracker,
  status,
  attachmentCacheStats,
  getSetting,
  setSetting,
  accountSettings,
  setAccountSettings,
  runGmailPoll,
  runImapReconcile,
  runEmbedSweep,
  runMaintenanceSweep,
  emailEmbedText,
  embedHash,
  emailEmbedHash,
  EMBED_VERSION,
  getTombstoneUids,
  addTombstone,
  upsertEmails,
  applyEmailChanges,
  remapEmailUid,
  hardDeleteRow,
  toEmail,
  attachAnnotations,
  renderRows: render,
  listEmails,
  getEmail,
  folderCounts,
  syncNow,
  modify,
  batchDelete,
  runDeleteSweep,
  send,
  resolveSendAttachments, // reference → bytes (shared with its tests)
  listSent,
  repliedTo,
  senderHistory,
  lookupParticipants,
  parseParticipants, // the address/display-name parser (shared with its tests)
  sentRecipientAddresses,
  normalizeSubject,
  attachment,
  createFolder,
  annotate,
  annotations,
  listAnnotations,
  listRules, addRule, removeRule, applyRules, matchesSenderRules, matchSenderRule,
  listLabels, addLabel, updateLabel, removeLabel,
  assignTags, setTags, tagsOf,
};
