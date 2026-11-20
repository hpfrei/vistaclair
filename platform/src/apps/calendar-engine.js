// Platform calendar engine — Google Calendar master store. syncToken
// incremental sync (cron 'calendar.sync', default every 5 min), CRUD
// write-through, calendar selection, engine-resolved colors and a consistent
// `when` label (formatCalendarWhen) for every app. Same seams as email-engine:
// init(appsDir, secretStore, broadcaster), .calendar-engine.json settings,
// events dispatched through email-engine's subscriber registry (one bus).
const fs = require('fs');
const path = require('path');
const emailEngine = require('./email-engine');
const gapi = require('./google-api');
const { singleFlight } = require('../utils');
const googleAuth = require('./google-auth');
const appDb = require('./app-db');
const embeddings = require('./embeddings');
const rrule = require('./rrule');

const EMBED_DIM = embeddings.DIM;

const API = 'https://www.googleapis.com/calendar/v3';

const CALENDAR_SCOPE_ALIASES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

// Google's event color palette (colors.get 'event' section). Cached palette
// from the API overrides these static defaults.
const EVENT_COLORS = {
  '1': '#7986cb', '2': '#33b679', '3': '#8e24aa', '4': '#e67c73',
  '5': '#f6bf26', '6': '#f4511e', '7': '#039be5', '8': '#616161',
  '9': '#3f51b5', '10': '#0b8043', '11': '#d50000',
};

let appsDir = null;
let broadcaster = null;

const SETTINGS_DEFAULTS = {
  syncSchedule: 'every 5 minutes',
  colorPalette: null,   // cached colors.get response {event: {id: {background}}, calendar: {...}}
};

let settings = {};

function settingsPath() {
  return path.join(appsDir, '.calendar-engine.json');
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
}

// --- Push channels (secret) --------------------------------------------------
//
// events.watch channels carry a per-channel shared secret, echoed back by
// Google as X-Goog-Channel-Token and checked in handleWebhook. They used to
// live in `.calendar-engine.json` alongside the sync schedule — plaintext on
// disk, because `init()` took `secretStore` and dropped it on the floor.
//
// They are low-value (a forged notification can only schedule a sync), but
// "low-value" is not a reason to write a shared secret in the clear when the
// platform has one aes-256-gcm store that every other `.enc` file goes through.
// They live in their own file so the harmless settings stay readable.
let secretStore = null;
let channelsPath = null;

function loadChannels() {
  if (!secretStore) return {};
  const data = secretStore.readSecretFile(channelsPath, appsDir, { fallback: null });
  if (data && typeof data === 'object') return data;

  // One-time migration: lift any channels left in the plaintext settings file
  // into the vault, then strike them from disk. Existing installs do not need
  // to re-watch — the tokens keep working, they just stop being readable.
  const legacy = settings.pushChannels;
  if (legacy && typeof legacy === 'object') {
    saveChannels(legacy);
    delete settings.pushChannels;
    saveSettings();
    console.log('  Calendar engine: push-channel secrets migrated into the secret store');
    return legacy;
  }
  return {};
}

function saveChannels(channels) {
  if (!secretStore) return;
  secretStore.writeSecretFile(channelsPath, channels || {}, appsDir);
}

function init(dir, store, bc) {
  appsDir = dir;
  secretStore = store;
  broadcaster = bc;
  channelsPath = path.join(dir, '.calendar-channels.enc');
  settings = loadSettings();
}

const conn = () => emailEngine.conn();
const dispatch = (event, data) => emailEngine.dispatch(event, data);

// ---------------------------------------------------------------------------
// DB — the calendar's own idempotent schema
//
// The tables stay in email-engine's `vc_platform_mail` database: moving the
// schema would be a migration, moving the DDL is not, and one connection pool
// serving both engines is the point of conn() above. What changes is ownership
// — a calendar column no longer requires an edit to the mail engine.
//
// Runs AFTER emailEngine.initSchema() (see index.js initMailEngines): it needs
// the database to exist, and it reads the mail engine's vector probe rather
// than paying for a second one.
// ---------------------------------------------------------------------------
let _ready = false;

async function initSchema() {
  if (!appDb.getPool()) return false;
  const c = await conn();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS platform_calendar_sync (
        account VARCHAR(255) NOT NULL,
        calendar_id VARCHAR(500) NOT NULL,
        name VARCHAR(500),
        background_color VARCHAR(20),
        selected TINYINT DEFAULT 0,
        sync_token TEXT,
        last_sync_at TIMESTAMP NULL,
        last_error TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (account, calendar_id(191))
      ) ENGINE=InnoDB
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS platform_calendar_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account VARCHAR(255) NOT NULL,
        event_id VARCHAR(500) NOT NULL,
        calendar_id VARCHAR(500) NOT NULL DEFAULT 'primary',
        summary TEXT,
        description TEXT,
        location VARCHAR(998),
        start_datetime DATETIME,
        start_date VARCHAR(10),
        end_datetime DATETIME,
        end_date VARCHAR(10),
        timezone VARCHAR(100),
        is_all_day BOOLEAN DEFAULT FALSE,
        status VARCHAR(50),
        html_link VARCHAR(998),
        hangout_link VARCHAR(998),
        color_id VARCHAR(10),
        creator_email VARCHAR(255),
        organizer_email VARCHAR(255),
        attendees JSON,
        reminders JSON,
        attachments JSON,
        raw_json JSON,
        recurrence JSON DEFAULT NULL,
        recurring_event_id VARCHAR(500) DEFAULT NULL,
        is_cancelled BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_account_event (account, event_id(191)),
        KEY idx_start (start_datetime),
        FULLTEXT KEY idx_search (summary, description, location)
      ) ENGINE=InnoDB
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS platform_calendar_annotations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        account VARCHAR(255) NOT NULL,
        event_id VARCHAR(500) NOT NULL,
        app_name VARCHAR(128) NOT NULL,
        kind VARCHAR(64) NOT NULL DEFAULT 'default',
        data JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_annotation (account, event_id(191), app_name, kind),
        KEY idx_workqueue (account, app_name, kind, event_id(191))
      ) ENGINE=InnoDB
    `);

    // Recurrence columns are additive ALTERs (the table predates these fields).
    // recurrence = master RRULE array; recurring_event_id = link from an
    // expanded instance back to its series master.
    // is_default marks the ONE calendar per account that receives events created
    // without an explicit calendarId (platform-staged proposals, Horst tool
    // calls). Without it the engine fell back to Google's 'primary', so
    // AI-detected events landed somewhere the user never chose.
    for (const ddl of [
      'ALTER TABLE platform_calendar_events ADD COLUMN recurrence JSON DEFAULT NULL',
      'ALTER TABLE platform_calendar_events ADD COLUMN recurring_event_id VARCHAR(500) DEFAULT NULL',
      'ALTER TABLE platform_calendar_sync ADD COLUMN is_default TINYINT DEFAULT 0',
      'ALTER TABLE platform_calendar_sync ADD COLUMN last_full_sync_at TIMESTAMP NULL',
    ]) {
      try {
        await c.query(ddl);
      } catch (e) {
        if (!/Duplicate column/i.test(e.message)) throw e;
      }
    }

    // Vector column, same additive-ALTER shape the mail side uses and skipped
    // wholesale when the server has no VECTOR support. Nullable on purpose:
    // VECTOR INDEX would require NOT NULL, and at this scale a
    // VEC_DISTANCE_COSINE scan is fine.
    if (emailEngine.vectorEnabled()) {
      try {
        await c.query(`ALTER TABLE platform_calendar_events ADD COLUMN embedding VECTOR(${EMBED_DIM})`);
      } catch (e) {
        if (!/Duplicate column/i.test(e.message)) throw e;
      }
      try {
        await c.query('ALTER TABLE platform_calendar_events ADD COLUMN embed_hash VARCHAR(64) DEFAULT NULL');
      } catch (e) {
        if (!/Duplicate column/i.test(e.message)) throw e;
      }
      // Existing installs created embed_hash as VARCHAR(40) (bare sha1 hex).
      // Versioned stamps ("<EMBED_VERSION>:<sha1>") need more room — widen
      // once, guarded by information_schema so it never rebuilds again.
      const [hashCol] = await c.query(
        `SELECT CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'platform_calendar_events' AND COLUMN_NAME = 'embed_hash'`,
        [emailEngine.DB]
      );
      if (hashCol && Number(hashCol.len) < 64) {
        await c.query('ALTER TABLE platform_calendar_events MODIFY embed_hash VARCHAR(64) DEFAULT NULL');
      }
    }

    _ready = true;
    console.log('  Calendar engine: schema ready');
    return true;
  } catch (err) {
    console.error('  Calendar engine: schema init failed:', err.message);
    return false;
  } finally {
    c.release();
  }
}

function isReady() {
  return _ready && emailEngine.isReady();
}

// App rename: annotations are scoped by app_name (reads filter on it, and the
// unique key spans it) — stale rows would make the renamed app's own
// annotations invisible and let duplicates accumulate. UPDATE IGNORE skips the
// rare row that would collide with one left by a previously-deleted app of the
// new name.
async function renameApp(oldName, newName) {
  const c = await conn();
  try {
    const r = await c.query(
      'UPDATE IGNORE `platform_calendar_annotations` SET app_name = ? WHERE app_name = ?',
      [newName, oldName]
    );
    return Number(r.affectedRows || 0);
  } finally {
    c.release();
  }
}

function calendarAccounts() {
  return googleAuth.listAccounts()
    .filter((a) => (a.grantedScopes || []).some((s) => CALENDAR_SCOPE_ALIASES.includes(s)))
    .map((a) => a.email);
}

// Consistent weekday/wall-clock label for all apps (lifted from my-dashboard).
function formatCalendarWhen(isoOrDate, timeZone) {
  if (!isoOrDate) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(isoOrDate);
  const d = new Date(dateOnly ? `${isoOrDate}T00:00:00Z` : isoOrDate);
  if (isNaN(d)) return isoOrDate;
  try {
    if (dateOnly) {
      return new Intl.DateTimeFormat('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
      }).format(d);
    }
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZoneName: 'short',
      timeZone: timeZone || undefined,
    }).format(d);
  } catch {
    return isoOrDate;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
function parseEventDatetime(dt) {
  if (!dt) return null;
  const d = new Date(dt);
  return isNaN(d) ? null : d;
}

// Same embed-text recipe as my-dashboard db.js calendarEmbedText (plan Q7).
function calendarEmbedText(ev) {
  const parts = [ev.summary, ev.location, ev.description];
  return parts.map((s) => (s || '').toString().trim()).filter(Boolean).join('\n').slice(0, 6000);
}

// Versioned calendar embed stamps ("<model>.<textschema>:<sha1>") — same shape
// as email-engine's emailEmbedHash, with calendar's own text-schema component,
// so a model swap or a calendarEmbedText change re-embeds calendar rows
// incrementally through the email-embed sweep instead of leaving stale vectors.
const CAL_EMBED_TEXT_VERSION = 1;
const CAL_EMBED_VERSION = `${require('./embeddings').MODEL_VERSION}.${CAL_EMBED_TEXT_VERSION}`;

function calendarEmbedHash(text) {
  const h = emailEngine.embedHash(text);
  return h ? `${CAL_EMBED_VERSION}:${h}` : null;
}

async function upsertEvents(account, calendarId, events) {
  if (!events.length) return;
  const vector = emailEngine.vectorEnabled();
  const c = await conn();
  try {
    await c.beginTransaction();
    for (const event of events) {
      const isAllDay = !event.start?.dateTime;
      const startDt = isAllDay ? null : parseEventDatetime(event.start?.dateTime);
      const startDate = isAllDay ? (event.start?.date || null) : null;
      const endDt = isAllDay ? null : parseEventDatetime(event.end?.dateTime);
      const endDate = isAllDay ? (event.end?.date || null) : null;
      const tz = event.start?.timeZone || event.end?.timeZone || null;
      const cancelled = event.status === 'cancelled';
      const eh = vector ? calendarEmbedHash(calendarEmbedText(event)) : null;
      await c.query(
        `INSERT INTO platform_calendar_events (account, event_id, calendar_id, summary, description, location,
          start_datetime, start_date, end_datetime, end_date, timezone, is_all_day, status,
          html_link, hangout_link, color_id, creator_email, organizer_email,
          attendees, reminders, attachments, raw_json, recurrence, recurring_event_id, is_cancelled${vector ? ', embed_hash' : ''})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${vector ? ', ?' : ''})
         ON DUPLICATE KEY UPDATE
           calendar_id=VALUES(calendar_id), summary=VALUES(summary), description=VALUES(description),
           location=VALUES(location), start_datetime=VALUES(start_datetime), start_date=VALUES(start_date),
           end_datetime=VALUES(end_datetime), end_date=VALUES(end_date), timezone=VALUES(timezone),
           is_all_day=VALUES(is_all_day), status=VALUES(status), html_link=VALUES(html_link),
           hangout_link=VALUES(hangout_link), color_id=VALUES(color_id),
           creator_email=VALUES(creator_email), organizer_email=VALUES(organizer_email),
           attendees=VALUES(attendees), reminders=VALUES(reminders),
           attachments=VALUES(attachments), raw_json=VALUES(raw_json),
           recurrence=VALUES(recurrence), recurring_event_id=VALUES(recurring_event_id),
           is_cancelled=VALUES(is_cancelled)${vector ? `,
           embedding=IF(embed_hash <=> VALUES(embed_hash), embedding, NULL), embed_hash=VALUES(embed_hash)` : ''}`,
        [
          account, event.id, calendarId,
          event.summary || null, event.description || null, event.location || null,
          startDt, startDate, endDt, endDate, tz, isAllDay ? 1 : 0,
          event.status || null, event.htmlLink || null, event.hangoutLink || null,
          event.colorId || null,
          event.creator?.email || null, event.organizer?.email || null,
          JSON.stringify(event.attendees || []),
          JSON.stringify(event.reminders || {}),
          JSON.stringify(event.attachments || []),
          JSON.stringify(event),
          event.recurrence ? JSON.stringify(event.recurrence) : null,
          event.recurringEventId || null,
          cancelled ? 1 : 0,
          ...(vector ? [eh] : []),
        ]
      );
    }
    await c.commit();
  } catch (err) {
    await c.rollback().catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

// Calendar color for resolved-event rendering, from the per-calendar metadata
// stored by syncCalendarList. The cached map avoids a query per event.
let _calColorCache = null;
async function calendarColors() {
  if (_calColorCache) return _calColorCache;
  const c = await conn();
  try {
    const rows = await c.query('SELECT account, calendar_id, background_color FROM platform_calendar_sync');
    _calColorCache = new Map(rows.map((r) => [`${r.account} ${r.calendar_id}`, r.background_color]));
    return _calColorCache;
  } finally {
    c.release();
  }
}

function eventPaletteColor(colorId) {
  const palette = getSetting('colorPalette');
  return palette?.event?.[colorId]?.background || EVENT_COLORS[colorId] || null;
}

// Same shape as my-dashboard rowToCalendarEvent, plus engine extras:
// backgroundColor (resolved), when/whenEnd labels, _cancelled.
function toEvent(row, calColors) {
  const parse = (v, fb) => {
    if (v == null) return fb;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fb; } }
    return v;
  };
  const event = {
    id: row.event_id,
    summary: row.summary,
    description: row.description,
    location: row.location,
    status: row.status,
    htmlLink: row.html_link,
    hangoutLink: row.hangout_link,
    colorId: row.color_id,
    creator: row.creator_email ? { email: row.creator_email } : undefined,
    organizer: row.organizer_email ? { email: row.organizer_email } : undefined,
    attendees: parse(row.attendees, []),
    reminders: parse(row.reminders, {}),
    attachments: parse(row.attachments, []),
    _account: row.account,
    _calendarId: row.calendar_id,
  };
  if (row.recurrence != null) {
    event.recurrence = parse(row.recurrence, undefined);
    // The rule the RRULE means, parsed here so no reader has to. This is what
    // lets an editor populate its repeat controls without a second RRULE parser
    // in the browser — and it is null for a rule we cannot model, which an
    // editor should read as "leave this series alone".
    event.recurrenceRule = rrule.fromRRule(event.recurrence);
  }
  if (row.recurring_event_id) event.recurringEventId = row.recurring_event_id;
  if (row.is_all_day) {
    event.start = { date: row.start_date };
    event.end = { date: row.end_date };
  } else {
    event.start = { dateTime: row.start_datetime ? new Date(row.start_datetime).toISOString() : null, timeZone: row.timezone };
    event.end = { dateTime: row.end_datetime ? new Date(row.end_datetime).toISOString() : null, timeZone: row.timezone };
  }
  const calColor = calColors?.get(`${row.account} ${row.calendar_id}`) || '#3b82f6';
  event.backgroundColor = (row.color_id && eventPaletteColor(row.color_id)) || calColor;
  event.when = formatCalendarWhen(row.is_all_day ? row.start_date : event.start.dateTime, row.timezone);
  event.whenEnd = formatCalendarWhen(row.is_all_day ? row.end_date : event.end.dateTime, row.timezone);
  if (row.is_cancelled) event._cancelled = true;
  return event;
}

async function attachAnnotations(c, appName, events) {
  if (!appName || !events.length) return;
  const pairs = events.map((e) => [e._account, e.id]);
  const rows = await c.query(
    `SELECT account, event_id, kind, data FROM platform_calendar_annotations
     WHERE app_name = ? AND (account, event_id) IN (${pairs.map(() => '(?, ?)').join(', ')})`,
    [appName, ...pairs.flat()]
  );
  const byKey = new Map(events.map((e) => [`${e._account} ${e.id}`, e]));
  for (const e of events) e.annotations = {};
  for (const r of rows) {
    const e = byKey.get(`${r.account} ${r.event_id}`);
    if (!e) continue;
    let data = r.data;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch {} }
    e.annotations[r.kind] = data;
  }
}

// Core read API (bridge calendar.events). similarSearch delegates to the
// embed provider when loaded (A8.6).
async function listEvents(params = {}, appName = null) {
  const {
    account, calendarIds, timeMin, timeMax, q,
    includeCancelled = false, limit = 250, offset = 0,
  } = params;

  // Without an account this reads the whole mirror, across every connected
  // calendar account. That is the owner's view of their own data; for an app's
  // user it is a cross-account leak, so they must name the account they mean.
  if (!account && require('./spend-context').isUserFacing()) {
    throw new Error('an explicit account is required');
  }

  if (params.similarSearch && emailEngine.provider('embed')?.similarSearchCalendar) {
    return emailEngine.provider('embed').similarSearchCalendar(params, appName);
  }

  const where = [];
  const vals = [];
  if (account) { where.push('account = ?'); vals.push(account); }
  if (calendarIds?.length) {
    where.push(`calendar_id IN (${calendarIds.map(() => '?').join(',')})`);
    vals.push(...calendarIds);
  }
  if (timeMin) {
    where.push('(start_datetime >= ? OR start_date >= ?)');
    const d = new Date(timeMin);
    vals.push(d, d.toISOString().split('T')[0]);
  }
  if (timeMax) {
    where.push('(start_datetime <= ? OR start_date <= ?)');
    const d = new Date(timeMax);
    vals.push(d, d.toISOString().split('T')[0]);
  }
  if (!includeCancelled) where.push('is_cancelled = FALSE');
  // Recurring-series masters (recurrence set) are the definition, not an
  // occurrence — the displayable rows are the expanded instances synced from
  // Google (recurrence NULL, recurring_event_id set). Hide masters so a created
  // series never renders as a phantom duplicate alongside its instances.
  where.push('recurrence IS NULL');
  // Same sanitiser as the mail engine — one boolean-mode grammar, one place.
  const qTerm = q ? require('./fulltext-query').sanitize(q) : '';
  if (qTerm) { where.push('MATCH(summary, description, location) AGAINST(? IN BOOLEAN MODE)'); vals.push(qTerm); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const c = await conn();
  try {
    const rows = await c.query(
      `SELECT * FROM platform_calendar_events ${whereSql}
       ORDER BY COALESCE(start_datetime, CAST(start_date AS DATETIME)) ASC LIMIT ? OFFSET ?`,
      [...vals, Number(limit), Number(offset)]
    );
    const calColors = await calendarColors();
    const events = rows.map((r) => toEvent(r, calColors));
    await attachAnnotations(c, appName, events);
    return { events, total: events.length, ...(q && !params.similarSearch ? { mode: 'keyword' } : {}) };
  } finally {
    c.release();
  }
}

async function getEvent({ account, eventId }, appName = null) {
  const c = await conn();
  try {
    const rows = await c.query(
      'SELECT * FROM platform_calendar_events WHERE account = ? AND event_id = ?',
      [account, eventId]
    );
    if (!rows.length) return null;
    const calColors = await calendarColors();
    const event = toEvent(rows[0], calColors);
    await attachAnnotations(c, appName, [event]);
    return event;
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// Calendar list + selection (per-calendar rows in platform_calendar_sync)
// ---------------------------------------------------------------------------
async function syncCalendarList(account, token) {
  const list = await gapi.get(`${API}/users/me/calendarList`, token);
  const c = await conn();
  try {
    for (const cal of list.items || []) {
      await c.query(
        `INSERT INTO platform_calendar_sync (account, calendar_id, name, background_color)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), background_color = VALUES(background_color)`,
        [account, cal.id, cal.summary || cal.id, cal.backgroundColor || null]
      );
    }
  } finally {
    c.release();
  }
  _calColorCache = null;
  return (list.items || []).map((cal) => ({
    id: cal.id,
    name: cal.summary || cal.id,
    color: cal.backgroundColor || '#3b82f6',
    primary: !!cal.primary,
  }));
}

async function listCalendars({ account }) {
  const token = await gapi.getToken(gapi.SCOPES.calendar, account);
  const items = await syncCalendarList(account, token);
  const c = await conn();
  try {
    const rows = await c.query(
      'SELECT calendar_id, selected, is_default FROM platform_calendar_sync WHERE account = ?', [account]);
    const sel = new Map(rows.map((r) => [r.calendar_id, r]));
    return items.map((i) => ({
      ...i,
      selected: !!sel.get(i.id)?.selected,
      isDefault: !!sel.get(i.id)?.is_default,
    }));
  } finally {
    c.release();
  }
}

// --- Default calendar --------------------------------------------------------
// THE destination for events created without an explicit calendarId. Every
// surface that creates an event on the user's behalf but has no calendar of its
// own to name — governance proposals staged by triage, Horst tool calls — lands
// here, so AI-detected events sit in the same calendar as the ones the user
// creates by hand. Resolution order: the marked default → the single selected
// calendar → Google's 'primary'.
async function defaultCalendar(account) {
  const c = await conn();
  try {
    const rows = await c.query(
      'SELECT calendar_id, name, is_default, selected FROM platform_calendar_sync WHERE account = ?', [account]);
    const marked = rows.find((r) => r.is_default);
    const selected = rows.filter((r) => r.selected);
    const row = marked || (selected.length === 1 ? selected[0] : null);
    if (!row) return { id: 'primary', name: null };
    return { id: row.calendar_id, name: row.name || null };
  } catch {
    return { id: 'primary', name: null };   // pre-migration schema — never block a create
  } finally {
    c.release();
  }
}

async function defaultCalendarId(account) {
  return (await defaultCalendar(account)).id;
}

async function setDefaultCalendar({ account, calendarId }) {
  const c = await conn();
  try {
    await c.query('UPDATE platform_calendar_sync SET is_default = 0 WHERE account = ?', [account]);
    if (calendarId) {
      await c.query(
        'UPDATE platform_calendar_sync SET is_default = 1 WHERE account = ? AND calendar_id = ?',
        [account, calendarId]
      );
    }
  } finally {
    c.release();
  }
  return { ok: true, account, calendarId: calendarId || null };
}

// Owner-only. This resets `sync_token` for EVERY calendar on the account, so
// the next sync is a full re-list rather than an incremental one — a cheap call
// with an expensive, account-wide consequence. Any app could make it, including
// on behalf of one of its own users.
async function selectCalendars({ account, calendarIds }) {
  if (require('./spend-context').isUserFacing()) {
    throw new Error('choosing which calendars sync is owner-only');
  }
  const ids = calendarIds || [];
  const c = await conn();
  try {
    await c.query('UPDATE platform_calendar_sync SET selected = 0, sync_token = NULL WHERE account = ?', [account]);
    if (ids.length) {
      await c.query(
        `UPDATE platform_calendar_sync SET selected = 1 WHERE account = ? AND calendar_id IN (${ids.map(() => '?').join(',')})`,
        [account, ...ids]
      );
    }
  } finally {
    c.release();
  }
  syncAccount(account);
  return { ok: true, calendarIds: ids };
}

async function colors({ account } = {}) {
  let palette = getSetting('colorPalette');
  if (!palette) {
    const acct = account || calendarAccounts()[0];
    if (acct) {
      const token = await gapi.getToken(gapi.SCOPES.calendar, acct);
      palette = await gapi.get(`${API}/colors`, token);
      setSetting('colorPalette', palette);
    }
  }
  return palette || { event: Object.fromEntries(Object.entries(EVENT_COLORS).map(([k, v]) => [k, { background: v }])), calendar: {} };
}

// ---------------------------------------------------------------------------
// Sync — per selected calendar, events.list with syncToken; 410 ⇒ full re-list.
// singleEvents:true means Google never re-sends expanded instances when a
// recurring master is deleted — the incremental sync misses them. Periodic
// full re-lists (every FULL_SYNC_INTERVAL) reconcile: local rows not returned
// by Google are cancelled. See the `isFullList` / `seen` / reconcile block.
// ---------------------------------------------------------------------------
const running = new Map();
const FULL_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function syncCalendar(account, token, calRow) {
  const calendarId = calRow.calendar_id;
  let syncToken = calRow.sync_token || null;

  // Force a full re-list when the last one was more than 24h ago (or never).
  // This is the only reliable way to catch recurring-master deletions that
  // singleEvents:true incremental sync silently drops.
  if (syncToken) {
    const lastFull = calRow.last_full_sync_at ? new Date(calRow.last_full_sync_at).getTime() : 0;
    if (Date.now() - lastFull > FULL_SYNC_INTERVAL_MS) {
      syncToken = null;
    }
  }
  let pageToken = null;
  // Set when a 410 sends us back to the start. `continue` in a do/while jumps
  // to the CONDITION, and the 410 handler has just cleared pageToken — so
  // without this the loop exits and the sync fetches nothing at all. It
  // recovered on the next run, because the stale token was cleared in the DB,
  // but the re-list the 410 asked for never happened in the run that saw it.
  let restart = false;
  const changed = [];
  // Full re-list (no syncToken): track every event_id Google returns so we can
  // reconcile afterwards — local rows NOT in the set are orphans (deleted in
  // Google while we held a stale token, or recurring-master deletions whose
  // expanded instances singleEvents:true never re-sends as cancelled).
  const isFullList = !syncToken;
  const seen = isFullList ? new Set() : null;

  do {
    restart = false;
    const params = new URLSearchParams({ singleEvents: 'true', maxResults: '250' });
    if (syncToken && !pageToken) params.set('syncToken', syncToken);
    else if (!syncToken) {
      const timeMin = new Date();
      timeMin.setFullYear(timeMin.getFullYear() - 1);
      params.set('timeMin', timeMin.toISOString());
    }
    if (pageToken) params.set('pageToken', pageToken);

    let res;
    try {
      res = await gapi.get(`${API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, token);
    } catch (err) {
      if (err.status === 410) {
        syncToken = null;
        pageToken = null;
        restart = true;
        const c = await conn();
        try {
          await c.query('UPDATE platform_calendar_sync SET sync_token = NULL WHERE account = ? AND calendar_id = ?', [account, calendarId]);
        } finally { c.release(); }
        continue;
      }
      throw err;
    }
    const items = res.items || [];
    if (items.length) {
      await upsertEvents(account, calendarId, items);
      changed.push(...items.map((e) => e.id));
    }
    if (seen) for (const e of items) seen.add(e.id);
    pageToken = res.nextPageToken || null;
    if (res.nextSyncToken) syncToken = res.nextSyncToken;
  } while (pageToken || restart);

  // Reconcile: on a full re-list, cancel any local rows Google didn't return.
  // The full list covers timeMin (1 year ago) → future, so only reconcile that
  // window — older rows predate the query and aren't orphans.
  if (isFullList && seen) {
    const c = await conn();
    try {
      const timeMin = new Date();
      timeMin.setFullYear(timeMin.getFullYear() - 1);
      const rows = await c.query(
        `SELECT event_id FROM platform_calendar_events
         WHERE account = ? AND calendar_id = ? AND is_cancelled = 0
           AND (start_datetime >= ? OR start_date >= ?)`,
        [account, calendarId, timeMin, timeMin.toISOString().slice(0, 10)]
      );
      const orphans = rows.filter((r) => !seen.has(r.event_id)).map((r) => r.event_id);
      if (orphans.length) {
        // Batch in chunks of 500 to stay within query-size limits.
        for (let i = 0; i < orphans.length; i += 500) {
          const batch = orphans.slice(i, i + 500);
          await c.query(
            `UPDATE platform_calendar_events SET is_cancelled = TRUE, status = 'cancelled'
             WHERE account = ? AND calendar_id = ? AND event_id IN (${batch.map(() => '?').join(',')})`,
            [account, calendarId, ...batch]
          );
        }
        changed.push(...orphans);
        console.log(`  Calendar engine [${account}/${calendarId}]: reconciled ${orphans.length} orphaned events`);
      }
    } finally {
      c.release();
    }
  }

  const c = await conn();
  try {
    await c.query(
      `UPDATE platform_calendar_sync SET sync_token = ?, last_sync_at = CURRENT_TIMESTAMP, last_error = NULL${isFullList ? ', last_full_sync_at = CURRENT_TIMESTAMP' : ''} WHERE account = ? AND calendar_id = ?`,
      [syncToken, account, calendarId]
    );
  } finally {
    c.release();
  }
  return changed;
}

// A calendar-capable account that has never had its calendar list read has NO
// platform_calendar_sync rows: calendarAccounts() names it, syncStatus() shows
// nothing, the poll syncs nothing, and Setup → Google lists "0 calendars
// synced" until the owner finds Manage. (Calendar writes still work meanwhile —
// they fall back to Google's `primary` — which is what made it look connected.)
// So the first time an account is seen with no rows at all, read its calendar
// list and select the primary calendar. Only the "no rows at all" case: once
// rows exist the owner's selection (including none) is theirs and never touched.
const discovering = new Map();
function ensureCalendars(account) {
  return singleFlight(discovering, account, async () => {
    const c = await conn();
    let known;
    try {
      known = await c.query('SELECT calendar_id FROM platform_calendar_sync WHERE account = ?', [account]);
    } finally {
      c.release();
    }
    if (known.length) return { discovered: false };
    const token = await gapi.getToken(gapi.SCOPES.calendar, account);
    const items = await syncCalendarList(account, token);
    const primary = items.find((i) => i.primary) || items[0];
    if (primary) {
      const c2 = await conn();
      try {
        await c2.query(
          'UPDATE platform_calendar_sync SET selected = 1 WHERE account = ? AND calendar_id = ?',
          [account, primary.id]);
      } finally {
        c2.release();
      }
    }
    return { discovered: true };
  });
}

// What Setup → Google → Calendar Sync shows: every calendar-capable account,
// each one's synced calendars, and per-account errors (token, API) so a failed
// discovery is visible instead of an empty list.
async function panelStatus() {
  const accounts = calendarAccounts();
  const errors = {};
  await Promise.all(accounts.map(async (a) => {
    try {
      const r = await ensureCalendars(a);
      if (r.discovered) syncAccount(a);   // background: events for the new selection
    } catch (err) {
      errors[a] = err.message;
    }
  }));
  return { accounts, status: await syncStatus(), errors };
}

function syncAccount(account) {
  return singleFlight(running, account, async () => {
    const token = await gapi.getToken(gapi.SCOPES.calendar, account);
    await ensureCalendars(account);
    const c = await conn();
    let cals;
    try {
      cals = await c.query('SELECT * FROM platform_calendar_sync WHERE account = ? AND selected = 1', [account]);
    } finally {
      c.release();
    }
    for (const calRow of cals) {
      try {
        const changed = await syncCalendar(account, token, calRow);
        if (changed.length) {
          dispatch('calendar:changed', {
            account, calendarId: calRow.calendar_id, eventIds: changed,
            action: 'sync', origin: { source: 'sync' },
          });
        }
      } catch (err) {
        console.error(`  Calendar engine [${account}/${calRow.calendar_id}]: ${err.message}`);
        const c2 = await conn();
        try {
          await c2.query(
            'UPDATE platform_calendar_sync SET last_error = ? WHERE account = ? AND calendar_id = ?',
            [err.message, account, calRow.calendar_id]
          );
        } finally { c2.release(); }
      }
    }
    await maintainChannels(account, token, cals);
  }).catch((err) => console.error(`  Calendar engine [${account}]: ${err.message}`));
}

// Cron entry ('calendar.sync'). No-ops until the email-engine schema is up
// (both engines share vc_platform_mail).
async function runSync() {
  if (!emailEngine.isReady()) return;
  for (const account of calendarAccounts()) {
    await syncAccount(account);
  }
}

// A full sync per account, triggered by an unauthenticated-to-the-engine call
// from any app. Rate-limited per account so a loop in app code (or a user
// hammering a refresh button) cannot turn into sustained Google API traffic and
// a quota ban for every account on the box.
const SYNC_NOW_MIN_INTERVAL_MS = 30 * 1000;
const lastSyncNow = new Map();

async function syncNow({ account } = {}) {
  const accounts = account ? [account] : calendarAccounts();
  const now = Date.now();
  const fresh = [];
  for (const a of accounts) {
    const last = lastSyncNow.get(a) || 0;
    if (now - last < SYNC_NOW_MIN_INTERVAL_MS) continue;
    lastSyncNow.set(a, now);
    fresh.push(a);
  }
  for (const a of fresh) await syncAccount(a);
  // Always returns current status, so a throttled call is a no-op rather than an
  // error: the caller wanted to know the state, and it is already fresh.
  return syncStatus({ account });
}

async function syncStatus({ account } = {}) {
  const c = await conn();
  try {
    const rows = account
      ? await c.query('SELECT * FROM platform_calendar_sync WHERE account = ?', [account])
      : await c.query('SELECT * FROM platform_calendar_sync');
    return rows.map((r) => ({
      account: r.account,
      calendarId: r.calendar_id,
      name: r.name,
      color: r.background_color,
      selected: !!r.selected,
      lastSyncAt: r.last_sync_at,
      lastError: r.last_error,
    }));
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// Push channels (events.watch) — near-instant change delivery, layered on top
// of the poll. Strictly gated on the platform's public HTTPS URL (the one
// telegram.js owns; Google delivers push over HTTPS only): no URL, no
// channels. The 5-min poll stays on as fallback and source of truth — a
// notification only pulls syncAccount forward. Channels are (re)created from
// syncAccount before they expire and stopped when the calendar is deselected
// or the public URL changes/disappears; ones orphaned by a removed account
// simply age out at Google's expiration.
// ---------------------------------------------------------------------------
const PUSH_WEBHOOK_PATH = '/pro/calendar/webhook';
const PUSH_RENEW_BEFORE_MS = 60 * 60 * 1000;  // recreate channels expiring within the hour

function pushBase() {
  try {
    const base = (require('./telegram').getPublicUrl() || '').replace(/\/+$/, '');
    return /^https:\/\//i.test(base) ? base : '';
  } catch {
    return '';
  }
}

async function stopChannel(ch, token) {
  try {
    await gapi.post(`${API}/channels/stop`, token, { id: ch.id, resourceId: ch.resourceId });
  } catch (err) {
    // 404 = already gone (expired); anything else is logged, never fatal.
    if (err.status !== 404) console.warn(`  Calendar engine [${ch.account}/${ch.calendarId}]: channels.stop: ${err.message}`);
  }
}

// Called from syncAccount (already per-account single-flight) with the
// selected-calendar rows: opens missing channels, renews expiring ones, stops
// stale ones (deselected calendar, changed/removed public URL). Best-effort —
// a watch failure leaves that calendar on the poll alone.
async function maintainChannels(account, token, cals) {
  const crypto = require('crypto');
  const base = pushBase();
  const address = base ? `${base}${PUSH_WEBHOOK_PATH}` : null;
  const channels = { ...loadChannels() };
  const wanted = new Set(cals.map((r) => `${account} ${r.calendar_id}`));
  let dirty = false;

  for (const [key, ch] of Object.entries(channels)) {
    if (ch.account !== account) continue;
    const stale = !address || !wanted.has(key) || ch.address !== address;
    const expiring = ch.expiration && ch.expiration - Date.now() < PUSH_RENEW_BEFORE_MS;
    if (!stale && !expiring) continue;
    await stopChannel(ch, token);
    delete channels[key];
    dirty = true;
  }

  if (address) {
    for (const calRow of cals) {
      const key = `${account} ${calRow.calendar_id}`;
      if (channels[key]) continue;
      const body = {
        id: crypto.randomUUID(),
        type: 'web_hook',
        address,
        // Per-channel shared secret, echoed back by Google as
        // X-Goog-Channel-Token and checked in handleWebhook. Low-value on
        // purpose: a forged notification can only schedule a sync.
        token: crypto.randomBytes(24).toString('hex'),
      };
      try {
        const res = await gapi.post(`${API}/calendars/${encodeURIComponent(calRow.calendar_id)}/events/watch`, token, body);
        channels[key] = {
          account,
          calendarId: calRow.calendar_id,
          id: res.id || body.id,
          resourceId: res.resourceId || null,
          token: body.token,
          address,
          expiration: res.expiration ? Number(res.expiration) : null,
        };
        dirty = true;
      } catch (err) {
        console.warn(`  Calendar engine [${account}/${calRow.calendar_id}]: events.watch: ${err.message}`);
      }
    }
  }

  if (dirty) saveChannels(channels);
}

// Route handler body for POST /pro/calendar/webhook (mounted in
// platform/index.js, auth-exempt). Google sends headers only, no body:
// channel id + token identify/authenticate the channel, resource state says
// why. Returns true for a known+authentic channel (route answers 200; false
// → 404 so Google backs off forged/forgotten channels).
function handleWebhook(headers) {
  const channelId = headers['x-goog-channel-id'];
  const channelToken = headers['x-goog-channel-token'];
  if (!channelId || !channelToken) return false;
  const ch = Object.values(loadChannels()).find((c) => c.id === channelId);
  if (!ch || ch.token !== channelToken) return false;
  // 'sync' is the channel-creation handshake, not a change. Everything else
  // ('exists') pulls the poll forward — the sync itself stays source of truth.
  if (headers['x-goog-resource-state'] !== 'sync'
      && emailEngine.isReady()
      && calendarAccounts().includes(ch.account)) {
    syncAccount(ch.account);
  }
  return true;
}

// ---------------------------------------------------------------------------
// CRUD write-through — Google first, then DB, then calendar:changed.
// Timezone is resolved engine-side ONLY (kills the app's dual-resolution bug).
// ---------------------------------------------------------------------------
// The domain shape is the ONLY accepted input. There used to be a second
// branch here that passed a raw Google event body straight through, which is
// how the app ended up owning half of this: it built `conferenceData`,
// `reminders.overrides`, `sendUpdates` and the RRULE strings itself, and the
// engine could not express any of them. Two implementations of one duty, with
// the app's the only complete one.
//
// Everything Google-shaped is now built here, from fields that describe intent
// ("add a Meet link", "remind me 10 minutes before") rather than transport.
function buildEventBody(d) {
  if (d.event) {
    throw new Error('calendar: pass event fields (title, date, startTime, attendees, addMeet, reminderMinutes, recurrence), not a raw Google event body');
  }
  const tz = d.timezone || process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  // `undefined` = the caller did not mention this field, and the write leaves it
  // alone. An empty string or an empty array is an explicit CLEAR and is sent as
  // one. Keeping those two apart is what lets an edit be a PATCH (see
  // updateEvent) instead of a whole-resource replace that wipes what it omits.
  const event = {};
  const title = d.title ?? d.summary;
  if (title !== undefined) event.summary = title;
  if (d.location !== undefined) event.location = d.location;
  if (d.description !== undefined) event.description = d.description;
  if (d.allDay) {
    event.start = { date: d.date };
    // Google's all-day end is EXCLUSIVE: a one-day event ends the next day.
    const ed = new Date(`${d.endDate || d.date}T00:00:00Z`);
    ed.setUTCDate(ed.getUTCDate() + 1);
    event.end = { date: ed.toISOString().split('T')[0] };
  } else if (d.date && d.startTime) {
    // endDate carries a timed event across midnight; without it the end is the
    // same day, which is the overwhelmingly common case.
    event.start = { dateTime: `${d.date}T${d.startTime}:00`, timeZone: tz };
    event.end = { dateTime: `${d.endDate || d.date}T${d.endTime || d.startTime}:00`, timeZone: tz };
  } else if (d.start) {
    // Explicit instants, for callers that already hold them (a sync round-trip,
    // a series edit). Timezone is still resolved here and nowhere else.
    event.start = withTimeZone(d.start, tz);
    event.end = withTimeZone(d.end, tz);
  }
  // An empty array is "remove everyone", which is a real edit; a null entry is
  // dropped rather than crashing on a.email.
  if (Array.isArray(d.attendees)) {
    event.attendees = d.attendees
      .map((a) => (typeof a === 'string' ? { email: a } : a))
      .filter((a) => a && a.email);
  }
  if (d.colorId !== undefined) event.colorId = d.colorId ? String(d.colorId) : null;

  // "Remind me N minutes before" — one override, which is what every surface
  // actually offers. A caller wanting Google's full reminder structure passes
  // `reminders` and we take it as given.
  if (d.reminderMinutes === null) {
    event.reminders = { useDefault: true }; // explicitly back to the calendar's own default
  } else if (d.reminderMinutes !== undefined && isFinite(Number(d.reminderMinutes))) {
    event.reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: Number(d.reminderMinutes) }] };
  } else if (d.reminders) {
    event.reminders = d.reminders;
  }

  if (Array.isArray(d.attachments)) {
    event.attachments = d.attachments
      .filter((a) => a && a.fileUrl)
      .map((a) => ({ fileUrl: a.fileUrl, title: a.title || undefined }));
  }

  // Meet: a request id unique per create is what makes Google mint a link
  // rather than reuse one. Moving an event between calendars preserves it,
  // which is why moveEvent exists instead of copy-then-delete.
  if (d.addMeet) {
    event.conferenceData = { createRequest: { requestId: `meet_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  }

  // Absent = leave whatever series the event already has alone. Explicitly
  // empty/false = make it a single event. A rule object = set that series.
  if (d.recurrence !== undefined && d.recurrence !== null) {
    const r = d.recurrence;
    if (Array.isArray(r) && r.length) {
      throw new Error('calendar: recurrence is a rule object ({ freq|every, interval|n, byday, count, until }) — the engine writes the RRULE');
    }
    const clear = r === false || r === 'none' || (Array.isArray(r) && !r.length);
    event.recurrence = clear ? [] : rrule.toRRule(r, { allDay: !!d.allDay });
  }
  return event;
}

// Timezone is resolved engine-side ONLY, on every path into Google.
function withTimeZone(obj, tz) {
  if (!obj || obj.date || !obj.dateTime || obj.timeZone) return obj;
  return { ...obj, timeZone: tz };
}

// The query params Google needs for the body we just built. Each of these is
// an opt-in that Google ignores the corresponding field without, silently — so
// deriving them from the body is the only way they cannot be forgotten.
function writeQuery(body, d) {
  const qs = new URLSearchParams();
  // Attendees present means this is an invitation, and not telling them is
  // almost never what was meant. Callers may still say 'none' deliberately.
  // An empty attendee list is a removal, and the people being removed are
  // exactly the ones who need telling — so the key's PRESENCE decides, not its
  // length. Same for attachments: Google drops the field entirely, including a
  // deliberate clear, unless supportsAttachments says otherwise.
  if (body.attendees || d.sendUpdates) qs.set('sendUpdates', d.sendUpdates || 'all');
  if (body.conferenceData) qs.set('conferenceDataVersion', '1');
  if (body.attachments) qs.set('supportsAttachments', 'true');
  return qs.size ? `?${qs}` : '';
}

// --- Recurrence scope helpers ---------------------------------------------
// Google syncs expanded INSTANCES (recurringEventId → master). Editing/deleting
// a whole series or "this and following" means mutating the MASTER's RRULE.
function eventUrl(calendarId, id) {
  return `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(id)}`;
}
// The absolute instant of a Google start/end.
//
// A dateTime that carries its own offset (or Z) is unambiguous. A naive one
// means wall time in the EVENT's timeZone — which is not the server's, and
// Date.parse assumes the server's. That is how editing a whole recurring series
// shifted it by the wrong amount, silently, whenever the calendar's timezone
// differed from the box's: the delta between the edited instance and the
// original was computed across two different clocks.
function startMs(s) {
  if (!s) return NaN;
  if (!s.dateTime) return Date.parse(`${s.date}T00:00:00Z`);
  // 'Z', '+01:00' or '-05:00' after the date portion = explicit offset.
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(s.dateTime)) return Date.parse(s.dateTime);
  return wallTimeMs(s.dateTime, s.timeZone);
}

// The instant at which `naive` ("YYYY-MM-DDTHH:MM:SS") reads as the wall clock
// in `timeZone`. Two passes because a zone's offset depends on the instant it
// is asked about, and the first guess can land on the wrong side of a DST
// boundary; the second settles it.
function wallTimeMs(naive, timeZone) {
  const asIfUtc = Date.parse(`${naive}Z`);
  if (!timeZone || isNaN(asIfUtc)) return Date.parse(naive);
  let guess = asIfUtc;
  try {
    for (let i = 0; i < 2; i++) guess = asIfUtc - zoneOffsetMs(guess, timeZone);
  } catch {
    return Date.parse(naive); // unknown zone — the old behaviour, not a crash
  }
  return guess;
}

// How far `timeZone` is ahead of UTC at a given instant.
function zoneOffsetMs(instant, timeZone) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant)).reduce((a, x) => (a[x.type] = x.value, a), {});
  // hour can format as '24' for midnight in some ICU builds.
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - instant;
}
function shiftDateObj(obj, deltaMs) {
  if (obj.date) {
    const d = new Date(`${obj.date}T00:00:00Z`);
    d.setTime(d.getTime() + deltaMs);
    return { date: d.toISOString().slice(0, 10) };
  }
  const d = new Date(obj.dateTime);
  d.setTime(d.getTime() + deltaMs);
  return { dateTime: d.toISOString(), timeZone: obj.timeZone };
}
function getGoogleEvent(account, calendarId, id, token) {
  return gapi.get(eventUrl(calendarId, id), token);
}

// --- Free/busy ---------------------------------------------------------------
//
// "When is this person free?" had no implementation anywhere: the app answered
// it by pulling a window of events into the browser and comparing every pair,
// which only ever saw the calendars it had already fetched and could not see a
// declined invitation or a calendar the owner had not selected.
//
// Google answers it directly, and authoritatively — freeBusy reports busy
// intervals across calendars the account can see, including ones whose event
// detail it may not read. `calendarIds` defaults to the account's selected
// calendars, which is what "am I free" means to the owner.
async function freeBusy({ account, timeMin, timeMax, calendarIds } = {}) {
  if (!account) throw new Error('account required');
  if (!timeMin || !timeMax) throw new Error('timeMin and timeMax required');
  const from = new Date(timeMin);
  const to = new Date(timeMax);
  if (isNaN(from) || isNaN(to)) throw new Error('timeMin and timeMax must be dates');
  if (to <= from) throw new Error('timeMax must be after timeMin');
  // Google caps a freeBusy query at ~3 months; refuse here with a sentence
  // rather than relaying a 400.
  if (to - from > 90 * 24 * 3600 * 1000) throw new Error('freeBusy window may not exceed 90 days');

  let ids = calendarIds;
  if (!ids || !ids.length) {
    const c = await conn();
    try {
      const rows = await c.query(
        'SELECT calendar_id FROM platform_calendar_sync WHERE account = ? AND selected = 1', [account]);
      ids = rows.map((r) => r.calendar_id);
    } finally {
      c.release();
    }
    if (!ids.length) ids = ['primary'];
  }

  const token = await gapi.getToken(gapi.SCOPES.calendar, account);
  const res = await gapi.post(`${API}/freeBusy`, token, {
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    items: ids.map((id) => ({ id })),
  });

  // Google reports per-calendar errors inline rather than failing the call (a
  // calendar that went away, a lost share). Surface them instead of quietly
  // returning "free" for a calendar nobody could read — a false "free" is the
  // one answer this function must never give.
  const calendars = {};
  const errors = [];
  for (const [id, entry] of Object.entries(res.calendars || {})) {
    if (entry.errors?.length) {
      errors.push({ calendarId: id, reason: entry.errors.map((e) => e.reason).join(', ') });
      continue;
    }
    calendars[id] = (entry.busy || []).map((b) => ({ start: b.start, end: b.end }));
  }

  // The merged view is what a caller almost always wants: one sorted list of
  // busy intervals with overlaps collapsed, so "is this slot free" is a scan.
  const all = Object.values(calendars).flat()
    .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }))
    .sort((a, b) => a.start - b.start);
  const busy = [];
  for (const iv of all) {
    const last = busy[busy.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      busy.push({ start: iv.start, end: iv.end });
    }
  }

  return {
    account,
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    calendars,
    busy: busy.map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() })),
    errors: errors.length ? errors : undefined,
  };
}

// Free slots of at least `minMinutes`, derived from the merged busy list — the
// question "when could this meeting go?" rather than "when is it busy?".
// Intentionally naive about working hours: the caller knows what hours mean to
// this owner, the engine knows only what the calendars say.
async function availability({ account, timeMin, timeMax, calendarIds, minMinutes = 30 } = {}) {
  const fb = await freeBusy({ account, timeMin, timeMax, calendarIds });
  const minMs = Math.max(1, Number(minMinutes) || 30) * 60000;
  const windowEnd = new Date(fb.timeMax);
  const slots = [];
  let cursor = new Date(fb.timeMin);
  for (const b of fb.busy) {
    const start = new Date(b.start);
    if (start - cursor >= minMs) slots.push({ start: cursor.toISOString(), end: start.toISOString() });
    const end = new Date(b.end);
    if (end > cursor) cursor = end;
  }
  if (windowEnd - cursor >= minMs) slots.push({ start: cursor.toISOString(), end: windowEnd.toISOString() });
  return { ...fb, minMinutes: Math.max(1, Number(minMinutes) || 30), free: slots };
}

async function createEvent(params, origin = { source: 'bridge' }) {
  const { account } = params;
  // No explicit calendar → the account's default (see defaultCalendarId), not
  // Google's 'primary': a caller that names no calendar means "the user's
  // calendar", which is the one they configured.
  const calendarId = params.calendarId || await defaultCalendarId(account);
  const token = await gapi.getToken(gapi.SCOPES.calendar, account);
  const body = buildEventBody(params);
  const event = await gapi.post(`${API}/calendars/${encodeURIComponent(calendarId)}/events${writeQuery(body, params)}`, token, body);
  await upsertEvents(account, calendarId, [event]);
  // A recurring create stores only the master; instances arrive on next sync.
  if (body.recurrence?.length) syncAccount(account);
  dispatch('calendar:changed', { account, calendarId, eventIds: [event.id], action: 'create', origin });
  mineEventToMemory(event);
  return event;
}

// Deterministic bookkeeping: every created event becomes a shared memory
// observation ("the user now has this plan"), whatever surface created it —
// app UI, governance approval, or Horst directly. Deduped via natural_key;
// fire-and-forget so memory being down never breaks a create.
function mineEventToMemory(event) {
  try {
    const mem = require('./memory-service');
    if (!mem.isReady()) return;
    const title = (event?.summary || '').trim();
    if (!title) return;
    const start = event.start?.dateTime || event.start?.date || null;
    const when = start ? formatCalendarWhen(start, event.start?.timeZone || null) : null;
    const atts = (event.attendees || []).map((a) => a.email).filter(Boolean);
    let txt = `User has a calendar event: "${title}"`;
    if (when) txt += ` on ${when}`;
    if (event.location) txt += ` at ${event.location}`;
    if (atts.length) txt += ` with ${atts.slice(0, 8).join(', ')}`;
    txt += '.';
    const keyBasis = `${title}|${start || ''}`.toLowerCase();
    mem.remember({
      content: txt,
      scope: 'shared',
      app_origin: 'platform',
      natural_key: 'event:' + require('crypto').createHash('sha1').update(keyBasis).digest('hex').slice(0, 16),
      event_time: start && /\d{4}-\d{2}-\d{2}T/.test(start) ? start : undefined,
      source: { type: 'user', app: 'platform-calendar' },
    }).catch(() => {});
  } catch { /* memory is best-effort */ }
}

async function updateEvent(params, origin = { source: 'bridge' }) {
  const { account, eventId } = params;
  const calendarId = params.calendarId || 'primary';
  const scope = params.scope || 'single';
  const token = await gapi.getToken(gapi.SCOPES.calendar, account);

  // Single occurrence (or a plain event): edit just this id.
  //
  // PATCH, not PUT. Google's events.update REPLACES the whole resource, so every
  // field the caller did not send is CLEARED — an update carrying {eventId,
  // title} wiped the description, the attendees, the reminders and, on a series
  // master, the recurrence rule itself. The app never saw it because its form
  // round-trips every field; Horst's calendar.update kind sends only what
  // changed, which is the shape this method is for. buildEventBody keeps
  // "absent" and "explicitly empty" apart so a clear is still a clear.
  if (scope === 'single') {
    const edit = params.patch || buildEventBody(params);
    const event = await gapi.request('PATCH', eventUrl(calendarId, eventId) + writeQuery(edit, params), { token, body: edit });
    await upsertEvents(account, calendarId, [event]);
    dispatch('calendar:changed', { account, calendarId, eventIds: [event.id], action: 'update', origin });
    return event;
  }

  // Recurring scopes operate on the series master.
  const instance = await getGoogleEvent(account, calendarId, eventId, token);
  const masterId = instance.recurringEventId || eventId;
  const edited = buildEventBody(params);

  if (scope === 'all') {
    const master = await getGoogleEvent(account, calendarId, masterId, token);
    const patch = {};
    for (const k of ['summary', 'location', 'description', 'colorId', 'attendees', 'reminders']) {
      if (edited[k] !== undefined) patch[k] = edited[k];
    }
    if (edited.recurrence !== undefined) patch.recurrence = edited.recurrence;
    // Shift the whole series by (editedStart − originalInstanceStart); duration
    // from the edited start/end, else preserve the master's duration.
    if (edited.start && instance.start) {
      const delta = startMs(edited.start) - startMs(instance.start);
      patch.start = delta ? shiftDateObj(master.start, delta) : master.start;
      const dur = edited.end
        ? startMs(edited.end) - startMs(edited.start)
        : startMs(master.end) - startMs(master.start);
      patch.end = shiftDateObj(patch.start, dur);
    }
    const event = await gapi.request('PATCH', eventUrl(calendarId, masterId), { token, body: patch });
    await upsertEvents(account, calendarId, [event]);
    syncAccount(account);
    dispatch('calendar:changed', { account, calendarId, eventIds: [event.id], action: 'update', origin });
    return event;
  }

  // following: cap the old series before this instance, start a fresh series here.
  const master = await getGoogleEvent(account, calendarId, masterId, token);
  const until = rrule.untilBefore(instance.start);
  await gapi.request('PATCH', eventUrl(calendarId, masterId), { token, body: { recurrence: rrule.capUntil(master.recurrence, until) } });
  const newBody = buildEventBody(params);
  if (!newBody.start) { newBody.start = instance.start; newBody.end = instance.end; }
  if (newBody.recurrence === undefined) newBody.recurrence = master.recurrence;
  delete newBody.id;
  const created = await gapi.post(`${API}/calendars/${encodeURIComponent(calendarId)}/events${writeQuery(newBody, params)}`, token, newBody);
  await upsertEvents(account, calendarId, [created]);
  syncAccount(account);
  dispatch('calendar:changed', { account, calendarId, eventIds: [created.id, masterId], action: 'update', origin });
  return created;
}

async function deleteEvent(params, origin = { source: 'bridge' }) {
  const { account, eventId } = params;
  const calendarId = params.calendarId || 'primary';
  const scope = params.scope || 'single';
  const token = await gapi.getToken(gapi.SCOPES.calendar, account);

  if (scope === 'single') {
    await gapi.del(eventUrl(calendarId, eventId), token);
    const c = await conn();
    try {
      await c.query(
        "UPDATE platform_calendar_events SET is_cancelled = TRUE, status = 'cancelled' WHERE account = ? AND event_id = ?",
        [account, eventId]
      );
    } finally {
      c.release();
    }
    dispatch('calendar:changed', { account, calendarId, eventIds: [eventId], action: 'delete', origin });
    return { ok: true };
  }

  const instance = await getGoogleEvent(account, calendarId, eventId, token);
  const masterId = instance.recurringEventId || eventId;

  if (scope === 'all') {
    await gapi.del(eventUrl(calendarId, masterId), token);
    const c = await conn();
    try {
      await c.query(
        "UPDATE platform_calendar_events SET is_cancelled = TRUE, status = 'cancelled' WHERE account = ? AND (event_id = ? OR recurring_event_id = ?)",
        [account, masterId, masterId]
      );
    } finally {
      c.release();
    }
    syncAccount(account);
    dispatch('calendar:changed', { account, calendarId, eventIds: [masterId], action: 'delete', origin });
    return { ok: true };
  }

  // following: truncate the series (no master delete), cancel this + later instances locally.
  const master = await getGoogleEvent(account, calendarId, masterId, token);
  const until = rrule.untilBefore(instance.start);
  await gapi.request('PATCH', eventUrl(calendarId, masterId), { token, body: { recurrence: rrule.capUntil(master.recurrence, until) } });
  const cutoff = startMs(instance.start);
  const cutoffDate = instance.start.date || new Date(cutoff).toISOString().slice(0, 10);
  const c = await conn();
  try {
    await c.query(
      `UPDATE platform_calendar_events SET is_cancelled = TRUE, status = 'cancelled'
       WHERE account = ? AND recurring_event_id = ?
         AND ((start_datetime IS NOT NULL AND start_datetime >= ?)
           OR (start_date IS NOT NULL AND start_date >= ?))`,
      [account, masterId, new Date(cutoff), cutoffDate]
    );
  } finally {
    c.release();
  }
  syncAccount(account);
  dispatch('calendar:changed', { account, calendarId, eventIds: [masterId], action: 'update', origin });
  return { ok: true };
}

// Native events.move — relocates an event to another calendar on the same
// account while PRESERVING conference data (Meet links), which the old
// copy-then-delete dance destroyed. The event keeps its id, so the same-id
// upsert (uq_account_event) flips the mirrored row's calendar_id to the
// destination immediately — no wait for the next poll.
async function moveEvent(params, origin = { source: 'bridge' }) {
  const { account, eventId, destinationCalendarId } = params;
  const calendarId = params.calendarId || 'primary';
  if (!destinationCalendarId) throw new Error('destinationCalendarId required');
  const token = await gapi.getToken(gapi.SCOPES.calendar, account);
  const qs = new URLSearchParams({ destination: destinationCalendarId });
  if (params.sendUpdates) qs.set('sendUpdates', params.sendUpdates);
  let event;
  try {
    event = await gapi.post(`${eventUrl(calendarId, eventId)}/move?${qs}`, token);
  } catch (err) {
    // Google restricts moves: only the organizer may move an event with other
    // guests (403), and recurring instances can't be moved at all (400). Strip
    // the transport prefix so apps can show Google's own message as-is (e.g.
    // "You need to be the organizer of the event to perform this operation.");
    // keep .status/.reason so callers can still tell "not allowed" apart.
    if (err.status === 400 || err.status === 403) {
      const clean = new Error(err.message.replace(/^POST [^:]+: /, ''));
      clean.status = err.status;
      clean.reason = err.reason;
      throw clean;
    }
    throw err;
  }
  await upsertEvents(account, destinationCalendarId, [event]);
  dispatch('calendar:changed', { account, calendarId: destinationCalendarId, eventIds: [event.id], action: 'move', origin });
  return event;
}

// ---------------------------------------------------------------------------
// Annotations — symmetric to email annotations
// ---------------------------------------------------------------------------
async function annotate({ account, eventId, kind = 'default', data }, appName) {
  if (!appName) throw new Error('annotate requires an app identity');
  if (!account || !eventId) throw new Error('annotate requires account and eventId');
  const c = await conn();
  try {
    await c.query(
      `INSERT INTO platform_calendar_annotations (account, event_id, app_name, kind, data)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [account, eventId, appName, kind, JSON.stringify(data ?? null)]
    );
  } finally {
    c.release();
  }
  dispatch('calendar:annotated', { account, eventId, appName, kind });
  return { ok: true };
}

async function annotations({ account, eventId, kinds, scope = 'mine' }, appName) {
  const c = await conn();
  try {
    const where = ['account = ?', 'event_id = ?'];
    const vals = [account, eventId];
    if (scope !== 'all') { where.push('app_name = ?'); vals.push(appName); }
    if (kinds?.length) { where.push(`kind IN (${kinds.map(() => '?').join(',')})`); vals.push(...kinds); }
    const rows = await c.query(
      `SELECT app_name, kind, data, updated_at FROM platform_calendar_annotations WHERE ${where.join(' AND ')}`,
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

module.exports = {
  init,
  initSchema,
  isReady,
  renameApp,
  getSetting,
  setSetting,
  formatCalendarWhen,
  calendarAccounts,
  calendarColors,
  toEvent,
  attachAnnotations,
  upsertEvents,
  listEvents,
  getEvent,
  listCalendars,
  selectCalendars,
  defaultCalendar,
  defaultCalendarId,
  setDefaultCalendar,
  colors,
  runSync,
  syncNow,
  syncStatus,
  ensureCalendars,
  panelStatus,
  freeBusy,
  availability,
  createEvent,
  updateEvent,
  deleteEvent,
  moveEvent,
  handleWebhook,
  annotate,
  annotations,
  calendarEmbedText,
  calendarEmbedHash,
  CAL_EMBED_VERSION,
  // Test seam. The reconcile inside syncCalendar is the one place in this
  // engine that CANCELS events nobody asked it to touch, so it is worth
  // exercising directly rather than through syncNow's account plumbing.
  _sync: { syncCalendar },
};
