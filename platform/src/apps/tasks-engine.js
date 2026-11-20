// Platform tasks engine — user-visible todos/reminders as life data (the
// reserved `tasks-engine` slot). NOT Horst's
// work stack (his execution queue) and NOT app jobs — this is the user's
// prospective memory: things with a due time, a done state, a snooze, an
// optional recurrence, and optional reply-watches ("Wiedervorlage": auto-close
// when a reply to a tracked email arrives).
//
// Naming: the app-facing surface is `todos.*` / ctx.todos — the `tasks.`
// bridge prefix is already owned by Background Tasks (process inspection).
//
// Same seams as memory-service: own database, deferred initSchema() (DB may
// connect after boot), isReady() guards, callers identified by app name.
// Scoping: shared-by-default (single-owner life data — a todo created in chat
// is completable from any surface). Deliberate deviation from memory's
// owner-only forget: SHARED rows are mutable by any caller; PRIVATE rows only
// by their app_origin.
//
// Reply-watch handlers are engine-owned (registered on email-engine's bus in
// init(); engines never require platform-horst). Auto-close is bookkeeping and
// deliberately ignores Horst's `paused` kill switch — the *notification* about
// it goes through Horst and is pause-gated there.
const appDb = require('./app-db');
const emailEngine = require('./email-engine');
const embeddings = require('./embeddings');
const platformSettings = require('./platform-settings');
const rrule = require('./rrule');

const DB = 'vc_platform_tasks';
const EMBED_DIM = embeddings.DIM;
const NOT_READY_MSG = 'Todos need the database — connect it in Apps > Setup.';
const RECUR_UNITS = rrule.RECUR_UNITS;
const SNOOZE_UNIT_MS = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };
const DEFAULT_SNOOZE_PRESETS = ['1h', '1d', '1w'];
// Cosine distance under which two short titles count as "similar".
// e5-calibrated (measured): title paraphrase ≈ 0.05, unrelated ≈ 0.20.
const SIMILAR_MAX_DIST = 0.10;

let _appsDir = null;
let _broadcaster = null;
let _ready = false;
let _openWatches = 0; // cheap-path guard: skip per-mail lookups when no watches exist

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
async function conn() {
  const pool = appDb.getPool();
  if (!pool) throw new Error(NOT_READY_MSG);
  const c = await pool.getConnection();
  await c.query(`USE \`${DB}\``);
  return c;
}

function init(appsDir, broadcaster) {
  _appsDir = appsDir;
  _broadcaster = broadcaster;
  // Engine-owned reply-watch handlers; registered once per process.
  emailEngine.registerHandler('tasks-engine', 'email:new', (d) => { onEmailNew(d).catch((e) => console.warn('[tasks-engine] email:new watch pass failed:', e.message)); });
  emailEngine.registerHandler('tasks-engine', 'email:sent', (d) => { onEmailSent(d).catch((e) => console.warn('[tasks-engine] email:sent watch pass failed:', e.message)); });
}

async function initSchema() {
  const pool = appDb.getPool();
  if (!pool) return false;
  const c = await pool.getConnection();
  try {
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``);
    await c.query(`USE \`${DB}\``);
    await c.query(`
      CREATE TABLE IF NOT EXISTS platform_tasks (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        title VARCHAR(500) NOT NULL,
        notes TEXT NULL,
        status ENUM('open','done','dropped') NOT NULL DEFAULT 'open',
        due_at DATETIME NULL,
        snoozed_until DATETIME NULL,
        recurrence JSON NULL,
        recur_of BIGINT NULL,
        watch JSON NULL,
        watch_key VARCHAR(500) NULL,
        app_origin VARCHAR(128) NOT NULL DEFAULT 'horst',
        scope ENUM('private','shared') NOT NULL DEFAULT 'shared',
        source_ref JSON NULL,
        resolution VARCHAR(64) NULL,
        notified_at DATETIME NULL,
        completed_at DATETIME NULL,
        embedding VECTOR(${EMBED_DIM}) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_status_due (status, due_at),
        KEY idx_watch (status, watch_key),
        KEY idx_origin (app_origin, status)
      ) ENGINE=InnoDB
    `);
    _ready = true;
    await refreshWatchCount(c);
    console.log('  Tasks engine: schema ready');
    return true;
  } finally {
    c.release();
  }
}

function isReady() {
  return _ready && !!appDb.getPool();
}

function assertReady() {
  if (!isReady()) throw new Error(NOT_READY_MSG);
}

function broadcast(extra) {
  try { _broadcaster?.broadcast({ type: 'horst:todos', ...extra }); } catch {}
}

function dispatch(action, todo, extra) {
  try { emailEngine.dispatch('todo:changed', { id: todo?.id, action, todo, ...extra }); } catch {}
  broadcast({ action });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function scopeClause(caller) {
  return { sql: `(scope = 'shared' OR (scope = 'private' AND app_origin = ?))`, param: caller };
}

function normalizeMsgId(s) {
  return String(s || '').trim().replace(/^<|>$/g, '').toLowerCase();
}

// Engine settings ride the pro-wide plaintext store (platform-settings.js) —
// same seam as memory-service. Local fallbacks keep the engine working before
// the keys land in that file's DEFAULTS.
// '30m' | '2h' | '1d' | '1w' → ms; null when it isn't a duration.
function parseSnoozePreset(s) {
  const m = String(s || '').trim().toLowerCase().match(/^(\d{1,3})([mhdw])$/);
  if (!m) return null;
  const ms = Number(m[1]) * SNOOZE_UNIT_MS[m[2]];
  return ms > 0 ? ms : null;
}

// todoSnoozePresets: list (or comma string) of durations for snooze UIs/cards.
// Malformed entries are dropped; an empty result falls back to the defaults.
function snoozePresets() {
  const raw = platformSettings.get('todoSnoozePresets');
  const list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  const valid = list.map((s) => String(s).trim().toLowerCase()).filter((s) => parseSnoozePreset(s) != null);
  return valid.length ? valid : DEFAULT_SNOOZE_PRESETS;
}

// todoWatchStrict: References/In-Reply-To-header-only reply matching — the
// thread-id fallback (which can misfire on provider-grouped threads) is off.
function watchStrict() {
  return !!platformSettings.get('todoWatchStrict');
}

function parseDate(v, label) {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (isNaN(d)) throw new Error(`Invalid ${label}: ${v}`);
  return d;
}

// BYDAY input: array or comma string of weekdays — RRULE codes (MO,TU,…) or
// English day names (the first two letters ARE the code: monday→MO). Only
// meaningful for weekly rules; normalized to deduped Monday-first codes.
// Recurrence lives in ./rrule — one model shared with the calendar engine.
// Todos keep their own spelling of it ({every, n, byday}); the arithmetic,
// including the month-clamping and DST behaviour test/tasks-recurrence.test.js
// pins, is the helper's.
function validateRecurrence(r) {
  return rrule.toTaskRule(r);
}

function nextDue(rule, from, now = new Date()) {
  return rrule.nextOccurrence(rule, from, now);
}

function parseMaybeJson(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return null; }
}

function toApi(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    title: row.title,
    notes: row.notes || null,
    status: row.status,
    dueAt: row.due_at || null,
    snoozedUntil: row.snoozed_until || null,
    recurrence: parseMaybeJson(row.recurrence),
    recurOf: row.recur_of != null ? Number(row.recur_of) : null,
    watch: parseMaybeJson(row.watch),
    appOrigin: row.app_origin,
    scope: row.scope,
    source: parseMaybeJson(row.source_ref),
    resolution: row.resolution || null,
    notifiedAt: row.notified_at || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Best-effort title embedding — NULL on failure, never blocks the write.
async function embedTitle(title) {
  try {
    // Titles compare against titles — symmetric, so passage:passage (e5).
    const [v] = await embeddings.embed([String(title)], { kind: 'passage' });
    return embeddings.toVectorLiteral(v);
  } catch {
    return null;
  }
}

async function refreshWatchCount(c) {
  try {
    const r = await c.query(`SELECT COUNT(*) AS n FROM platform_tasks WHERE status = 'open' AND watch_key IS NOT NULL`);
    _openWatches = Number(r[0]?.n || 0);
  } catch {}
}

// Fetch a row the caller is allowed to touch (shared, or private-and-owned).
async function loadMutable(c, id, caller) {
  const sc = scopeClause(caller);
  const rows = await c.query(`SELECT * FROM platform_tasks WHERE id = ? AND ${sc.sql}`, [Number(id), sc.param]);
  if (!rows.length) throw new Error(`Todo ${id} not found`);
  return rows[0];
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
// create({title, notes?, dueAt?, recurrence?, watch?, scope?, source?}, caller)
// watch: {type:'reply', account, uid} — messageId/threadId are resolved
// server-side from the mail store so callers can never fabricate a target.
async function create(params, caller = 'horst') {
  assertReady();
  const title = String(params?.title || '').trim().slice(0, 500);
  if (!title) throw new Error('title is required');
  const notes = params.notes != null ? String(params.notes) : null;
  const dueAt = parseDate(params.dueAt, 'dueAt');
  const recurrence = validateRecurrence(params.recurrence);
  const scope = params.scope === 'private' ? 'private' : 'shared';
  const source = params.source || { type: 'app', app: caller };

  let watch = null;
  let watchKey = null;
  if (params.watch) {
    const w = params.watch;
    if (w.type !== 'reply') throw new Error(`Unknown watch type: ${w.type}`);
    if (!w.account || !w.uid) throw new Error('watch requires account and uid');
    const c0 = await conn();
    let mail;
    try {
      mail = await c0.query(
        `SELECT message_id, thread_id, subject FROM \`vc_platform_mail\`.platform_emails
         WHERE account = ? AND uid = ? AND is_deleted = 0 LIMIT 1`,
        [w.account, String(w.uid)],
      );
    } finally { c0.release(); }
    if (!mail.length || !mail[0].message_id) throw new Error(`watch target not found: ${w.account}/${w.uid}`);
    watch = {
      type: 'reply',
      account: w.account,
      uid: String(w.uid),
      messageId: normalizeMsgId(mail[0].message_id),
      threadId: mail[0].thread_id || null,
      subject: mail[0].subject || null,
    };
    watchKey = `reply:${w.account}:${watch.messageId}`.slice(0, 500);
  }

  const vec = await embedTitle(title);
  const c = await conn();
  try {
    const res = await c.query(
      `INSERT INTO platform_tasks
         (title, notes, due_at, recurrence, watch, watch_key, app_origin, scope, source_ref, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${vec ? 'VEC_FromText(?)' : 'NULL'})`,
      [
        title, notes, dueAt,
        recurrence ? JSON.stringify(recurrence) : null,
        watch ? JSON.stringify(watch) : null,
        watchKey, caller, scope, JSON.stringify(source),
        ...(vec ? [vec] : []),
      ],
    );
    const rows = await c.query('SELECT * FROM platform_tasks WHERE id = ?', [Number(res.insertId)]);
    await refreshWatchCount(c);
    const todo = toApi(rows[0]);
    dispatch('create', todo);
    return todo;
  } finally {
    c.release();
  }
}

// list({status?, dueBy?, watchOnly?, limit?, offset?}, caller)
// status: 'open' (default) | 'done' | 'dropped' | 'all'. Ordered due-first.
async function list(params = {}, caller = 'horst') {
  assertReady();
  const sc = scopeClause(caller);
  const where = [sc.sql];
  const vals = [sc.param];
  const status = params.status || 'open';
  if (status !== 'all') { where.push('status = ?'); vals.push(status); }
  if (params.watchOnly) where.push('watch_key IS NOT NULL');
  if (params.dueBy) { where.push('COALESCE(snoozed_until, due_at) <= ?'); vals.push(parseDate(params.dueBy, 'dueBy')); }
  const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 500);
  const offset = Math.max(Number(params.offset) || 0, 0);
  const c = await conn();
  try {
    const rows = await c.query(
      `SELECT * FROM platform_tasks WHERE ${where.join(' AND ')}
       ORDER BY (COALESCE(snoozed_until, due_at) IS NULL), COALESCE(snoozed_until, due_at) ASC, created_at DESC
       LIMIT ? OFFSET ?`,
      [...vals, limit, offset],
    );
    return rows.map(toApi);
  } finally {
    c.release();
  }
}

async function get(id, caller = 'horst') {
  assertReady();
  const c = await conn();
  try {
    const sc = scopeClause(caller);
    const rows = await c.query(`SELECT * FROM platform_tasks WHERE id = ? AND ${sc.sql}`, [Number(id), sc.param]);
    return rows.length ? toApi(rows[0]) : null;
  } finally {
    c.release();
  }
}

// update(id, {title?, notes?, dueAt?, recurrence?, scope?}, caller)
// Editing dueAt clears snooze + notified so the nudge re-arms for the new time.
async function update(id, fields = {}, caller = 'horst') {
  assertReady();
  const c = await conn();
  try {
    const row = await loadMutable(c, id, caller);
    const sets = [];
    const vals = [];
    if (fields.title !== undefined) {
      const t = String(fields.title || '').trim().slice(0, 500);
      if (!t) throw new Error('title cannot be empty');
      sets.push('title = ?'); vals.push(t);
      const vec = await embedTitle(t);
      if (vec) { sets.push('embedding = VEC_FromText(?)'); vals.push(vec); }
    }
    if (fields.notes !== undefined) { sets.push('notes = ?'); vals.push(fields.notes != null ? String(fields.notes) : null); }
    if (fields.dueAt !== undefined) {
      sets.push('due_at = ?'); vals.push(parseDate(fields.dueAt, 'dueAt'));
      sets.push('snoozed_until = NULL', 'notified_at = NULL');
    }
    if (fields.recurrence !== undefined) {
      const r = validateRecurrence(fields.recurrence);
      sets.push('recurrence = ?'); vals.push(r ? JSON.stringify(r) : null);
    }
    if (fields.scope !== undefined) {
      if (!['private', 'shared'].includes(fields.scope)) throw new Error('scope must be private|shared');
      sets.push('scope = ?'); vals.push(fields.scope);
    }
    if (!sets.length) return toApi(row);
    await c.query(`UPDATE platform_tasks SET ${sets.join(', ')} WHERE id = ?`, [...vals, Number(row.id)]);
    const rows = await c.query('SELECT * FROM platform_tasks WHERE id = ?', [Number(row.id)]);
    const todo = toApi(rows[0]);
    dispatch('update', todo);
    return todo;
  } finally {
    c.release();
  }
}

// complete(id, caller, resolution) — recurrence re-arm inserts a fresh open
// row (recur_of = this id); done rows are never mutated back to open.
async function complete(id, caller = 'horst', resolution = 'completed') {
  assertReady();
  const c = await conn();
  try {
    const row = await loadMutable(c, id, caller);
    if (row.status === 'done') return { todo: toApi(row), rearmed: null };
    await c.query(
      `UPDATE platform_tasks SET status = 'done', resolution = ?, completed_at = NOW() WHERE id = ?`,
      [String(resolution).slice(0, 64), Number(row.id)],
    );
    let rearmed = null;
    const rule = parseMaybeJson(row.recurrence);
    if (rule && RECUR_UNITS.includes(rule.every)) {
      const due = nextDue(rule, row.due_at);
      const vec = await embedTitle(row.title);
      const res = await c.query(
        `INSERT INTO platform_tasks
           (title, notes, due_at, recurrence, recur_of, app_origin, scope, source_ref, embedding)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${vec ? 'VEC_FromText(?)' : 'NULL'})`,
        [
          row.title, row.notes, due, JSON.stringify(rule), Number(row.id),
          row.app_origin, row.scope, row.source_ref ? JSON.stringify(parseMaybeJson(row.source_ref)) : null,
          ...(vec ? [vec] : []),
        ],
      );
      const rr = await c.query('SELECT * FROM platform_tasks WHERE id = ?', [Number(res.insertId)]);
      rearmed = toApi(rr[0]);
    }
    const rows = await c.query('SELECT * FROM platform_tasks WHERE id = ?', [Number(row.id)]);
    await refreshWatchCount(c);
    const todo = toApi(rows[0]);
    dispatch('complete', todo, rearmed ? { rearmed } : undefined);
    if (rearmed) dispatch('create', rearmed);
    return { todo, rearmed };
  } finally {
    c.release();
  }
}

// snooze(id, {until} | {preset: '30m'|'2h'|'1d'|…}, caller) — clears
// notified_at so the nudge re-fires when the snooze expires. Offered presets
// come from the todoSnoozePresets setting, but any duration-shaped preset is
// honoured — a stale TG card's button keeps working after the list changes.
async function snooze(id, params = {}, caller = 'horst') {
  assertReady();
  let until;
  if (params.until) until = parseDate(params.until, 'until');
  else {
    const ms = parseSnoozePreset(params.preset);
    if (ms == null) throw new Error(`snooze needs until or preset (${snoozePresets().join('|')})`);
    until = new Date(Date.now() + ms);
  }
  const c = await conn();
  try {
    const row = await loadMutable(c, id, caller);
    if (row.status !== 'open') throw new Error(`Todo ${id} is not open`);
    await c.query('UPDATE platform_tasks SET snoozed_until = ?, notified_at = NULL WHERE id = ?', [until, Number(row.id)]);
    const rows = await c.query('SELECT * FROM platform_tasks WHERE id = ?', [Number(row.id)]);
    const todo = toApi(rows[0]);
    dispatch('snooze', todo);
    return todo;
  } finally {
    c.release();
  }
}

async function reopen(id, caller = 'horst') {
  assertReady();
  const c = await conn();
  try {
    const row = await loadMutable(c, id, caller);
    await c.query(
      `UPDATE platform_tasks SET status = 'open', resolution = NULL, completed_at = NULL, notified_at = NULL WHERE id = ?`,
      [Number(row.id)],
    );
    const rows = await c.query('SELECT * FROM platform_tasks WHERE id = ?', [Number(row.id)]);
    await refreshWatchCount(c);
    const todo = toApi(rows[0]);
    dispatch('reopen', todo);
    return todo;
  } finally {
    c.release();
  }
}

// remove(id, caller) — hard delete; this is the chat "Undo".
async function remove(id, caller = 'horst') {
  assertReady();
  const c = await conn();
  try {
    const row = await loadMutable(c, id, caller);
    await c.query('DELETE FROM platform_tasks WHERE id = ?', [Number(row.id)]);
    await refreshWatchCount(c);
    const todo = toApi(row);
    dispatch('delete', todo);
    return { ok: true, todo };
  } finally {
    c.release();
  }
}

async function counts(caller = 'horst') {
  assertReady();
  const c = await conn();
  try {
    const sc = scopeClause(caller);
    const r = await c.query(
      `SELECT
         SUM(status = 'open') AS open,
         SUM(status = 'open' AND COALESCE(snoozed_until, due_at) <= NOW()) AS dueNow,
         SUM(status = 'open' AND watch_key IS NOT NULL) AS waiting,
         SUM(status = 'done') AS done,
         MIN(CASE WHEN status = 'open' THEN COALESCE(snoozed_until, due_at) END) AS nextDue
       FROM platform_tasks WHERE ${sc.sql}`,
      [sc.param],
    );
    return {
      open: Number(r[0]?.open || 0),
      dueNow: Number(r[0]?.dueNow || 0),
      waiting: Number(r[0]?.waiting || 0),
      done: Number(r[0]?.done || 0),
      nextDue: r[0]?.nextDue || null,
    };
  } finally {
    c.release();
  }
}

// similar(title, {limit}, caller) — vector lookup over open rows; the
// create-time brain-check ("similar open todo exists").
async function similar(title, params = {}, caller = 'horst') {
  assertReady();
  const vec = await embedTitle(title);
  if (!vec) return [];
  const limit = Math.min(Math.max(Number(params.limit) || 3, 1), 10);
  const c = await conn();
  try {
    const sc = scopeClause(caller);
    const rows = await c.query(
      `SELECT *, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS dist
       FROM platform_tasks
       WHERE status = 'open' AND embedding IS NOT NULL AND ${sc.sql}
       ORDER BY dist ASC LIMIT ?`,
      [vec, sc.param, limit],
    );
    return rows.filter((r) => Number(r.dist) <= SIMILAR_MAX_DIST).map((r) => ({ ...toApi(r), dist: Number(r.dist) }));
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// Sweep — the heartbeat is the ticker (no cron job of its own).
// Nudge policy: once when due (and once per snooze expiry); overdue items
// re-surface only in the daily briefing, never every heartbeat.
// ---------------------------------------------------------------------------
async function sweepDue(now = new Date()) {
  if (!isReady()) return [];
  const c = await conn();
  try {
    const rows = await c.query(
      `SELECT * FROM platform_tasks
       WHERE status = 'open'
         AND COALESCE(snoozed_until, due_at) IS NOT NULL
         AND COALESCE(snoozed_until, due_at) <= ?
         AND (notified_at IS NULL OR notified_at < COALESCE(snoozed_until, due_at))
       ORDER BY COALESCE(snoozed_until, due_at) ASC LIMIT 50`,
      [now],
    );
    if (rows.length) {
      await c.query(
        `UPDATE platform_tasks SET notified_at = ? WHERE id IN (${rows.map(() => '?').join(',')})`,
        [now, ...rows.map((r) => Number(r.id))],
      );
    }
    return rows.map(toApi);
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// Reply-watch resolution (engine-owned)
// ---------------------------------------------------------------------------
// Both vaults (knownAccounts) — an IMAP-only read missed Gmail OAuth accounts.
function ownAddresses() {
  try {
    return new Set(emailEngine.knownAccounts().map((a) => String(a || '').toLowerCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function headerValues(headersJson, name) {
  const arr = parseMaybeJson(headersJson);
  if (!Array.isArray(arr)) return [];
  const want = name.toLowerCase();
  return arr.filter((h) => String(h?.name || '').toLowerCase() === want).map((h) => String(h?.value || ''));
}

async function openWatchesFor(c, account) {
  const rows = await c.query(
    `SELECT * FROM platform_tasks WHERE status = 'open' AND watch_key LIKE ?`,
    [`reply:${account}:%`],
  );
  return rows;
}

// email:new — {account, messages:[{uid, subject, sender, snippet, date, folder}]}
// The event carries no message ids, so each message is looked up in the mail
// store — but only while open watches exist (in-memory count guard).
async function onEmailNew(evt) {
  if (!isReady() || _openWatches <= 0) return;
  const account = evt?.account;
  const messages = Array.isArray(evt?.messages) ? evt.messages : [];
  if (!account || !messages.length) return;
  const own = ownAddresses();
  const strict = watchStrict(); // References-only: no thread-id fallback
  const c = await conn();
  try {
    const watches = await openWatchesFor(c, account);
    if (!watches.length) return;
    for (const m of messages) {
      let mail;
      try {
        mail = await c.query(
          `SELECT message_id, thread_id, headers, sender, subject FROM \`vc_platform_mail\`.platform_emails
           WHERE account = ? AND uid = ? LIMIT 1`,
          [account, String(m.uid)],
        );
      } catch { continue; }
      if (!mail.length) continue;
      const row = mail[0];
      // Skip the user's own thread activity (Gmail can land it in INBOX).
      const senderAddr = String(row.sender || '').toLowerCase().match(/[\w.+-]+@[\w.-]+/)?.[0];
      if (senderAddr && own.has(senderAddr)) continue;
      const msgId = normalizeMsgId(row.message_id);
      const refs = new Set(
        [...headerValues(row.headers, 'in-reply-to'), ...headerValues(row.headers, 'references')]
          .flatMap((v) => v.match(/<[^>]+>/g) || [v])
          .map(normalizeMsgId)
          .filter(Boolean),
      );
      for (const w of watches) {
        if (w.status !== 'open') continue;
        const watch = parseMaybeJson(w.watch);
        if (!watch) continue;
        const hit = refs.has(watch.messageId)
          || (!strict && watch.threadId && row.thread_id && watch.threadId === row.thread_id && msgId !== watch.messageId);
        if (!hit) continue;
        w.status = 'done'; // local guard against double-complete within this pass
        try {
          const { todo } = await complete(w.id, 'tasks-engine', 'reply-arrived');
          dispatch('watch-resolved', todo, {
            email: { account, uid: String(m.uid), from: row.sender || '', subject: row.subject || '' },
          });
        } catch (err) {
          console.warn(`[tasks-engine] watch complete failed (${w.id}):`, err.message);
        }
      }
    }
  } finally {
    c.release();
  }
}

// email:sent — {account, uid, to, subject, inReplyTo} — answering the watched
// mail yourself also ends the waiting-for.
async function onEmailSent(evt) {
  if (!isReady() || _openWatches <= 0) return;
  const inReplyTo = normalizeMsgId(evt?.inReplyTo);
  if (!inReplyTo) return;
  const c = await conn();
  try {
    const rows = await c.query(
      `SELECT id, watch FROM platform_tasks WHERE status = 'open' AND watch_key IS NOT NULL`,
    );
    for (const r of rows) {
      const watch = parseMaybeJson(r.watch);
      if (watch?.messageId === inReplyTo) {
        try {
          const { todo } = await complete(r.id, 'tasks-engine', 'self-replied');
          dispatch('watch-resolved', todo, { selfReply: true });
        } catch (err) {
          console.warn(`[tasks-engine] self-reply complete failed (${r.id}):`, err.message);
        }
      }
    }
  } finally {
    c.release();
  }
}

function status() {
  return { ready: isReady(), openWatches: _openWatches, snoozePresets: snoozePresets(), watchStrict: watchStrict() };
}

module.exports = {
  init, initSchema, isReady,
  create, list, get, update, complete, snooze, reopen, remove,
  counts, similar, sweepDue, status, snoozePresets,
  // Recurrence internals, exported as a test seam. The stepping decides when
  // every repeating todo next comes due, and a silent change there corrupts
  // owner data with no error anywhere — test/tasks-recurrence.test.js pins it.
  _recurrence: { validateRecurrence, nextDue },
};
