// Embed provider for the platform mail/calendar engines: background embedding
// sweep over platform_emails / platform_calendar_events (hash-guarded, same
// recipe as my-dashboard) and the hybrid similarSearch path — vector ANN
// (VEC_DISTANCE_COSINE) fused with FULLTEXT by reciprocal rank, filtered by a
// nearEnough cosine-distance cutoff. Registers as providers.embed on the email
// engine; calendar-engine delegates via provider('embed').similarSearchCalendar.
const emailEngine = require('./email-engine');
const calendarEngine = require('./calendar-engine');
const embeddings = require('./embeddings');
const { coalesce } = require('../utils');

const BATCH = 128;
const RRF_K = 60;

const conn = () => emailEngine.conn();

// ---------------------------------------------------------------------------
// Sweep — stamp embed_hash on legacy rows, then fill missing vectors.
// ---------------------------------------------------------------------------
// run(): at most one sweep at a time, calls during a sweep coalesce into one
// follow-up pass. kick(): debounced run after sync writes so new mail is
// searchable within seconds, not at the next cron tick.
const { run: schedule, kick } = coalesce(
  () => sweepOnce().catch((e) => console.error('  Email engine: embed sweep failed:', e.message)),
  3000
);

const TABLES = {
  platform_emails: {
    cols: 'id, subject, sender, recipient, cc, snippet, LEFT(body, 6000) AS body',
    text: (r) => emailEngine.emailEmbedText(r),
    hash: (t) => emailEngine.emailEmbedHash(t),
    // Versioned stamps ("<EMBED_VERSION>:<sha1>"): any row without the current
    // prefix is stale — a model swap or embed-text schema change (e.g. v2
    // adding recipient/cc) re-embeds the whole store incrementally through
    // this predicate. The '' sentinel (nothing to embed) is never reselected.
    stale: `embed_hash IS NULL OR (embed_hash <> '' AND embed_hash NOT LIKE '${emailEngine.EMBED_VERSION}:%')`,
    clearOnRestamp: true, // the old vector encodes outdated text — drop it
  },
  platform_calendar_events: {
    cols: 'id, summary, location, description',
    text: (r) => calendarEngine.calendarEmbedText(r),
    hash: (t) => calendarEngine.calendarEmbedHash(t),
    // Versioned like emails (CAL_EMBED_VERSION). Historic stamps were bare
    // sha1 (import-compat with my-dashboard's vectors) — they fail the prefix
    // predicate once, so the first versioned pass re-embeds them incrementally
    // (those vectors may predate the current model and were never comparable).
    stale: `embed_hash IS NULL OR (embed_hash <> '' AND embed_hash NOT LIKE '${calendarEngine.CAL_EMBED_VERSION}:%')`,
    clearOnRestamp: true, // the old vector encodes outdated text/model — drop it
  },
};

// Stamp/restamp pass. Rows inserted while VECTOR was off (or imported without
// a hash) have embed_hash NULL and are invisible to the vector fill; versioned
// tables additionally match rows whose stamp predates the current
// EMBED_VERSION. Both get the current hash ('' sentinel = nothing to embed);
// clearOnRestamp tables also clear the vector so fillVectors re-embeds the row
// — the BATCH-sized, cron-paced catch-up that rolls an embed-text change out
// incrementally instead of as a blocking one-shot rebuild.
async function stampHashes(table, def) {
  for (let guard = 0; guard < 1000; guard++) {
    const c = await conn();
    let rows;
    try {
      rows = await c.query(`SELECT ${def.cols} FROM ${table} WHERE ${def.stale} LIMIT ?`, [BATCH]);
      if (!rows.length) return;
      await c.beginTransaction();
      for (const row of rows) {
        const hash = def.hash(def.text(row)) || '';
        await c.query(
          def.clearOnRestamp
            ? `UPDATE ${table} SET embed_hash = ?, embedding = NULL WHERE id = ?`
            : `UPDATE ${table} SET embed_hash = ? WHERE id = ?`,
          [hash, row.id]
        );
      }
      await c.commit();
    } catch (err) {
      await c.rollback().catch(() => {});
      throw err;
    } finally {
      c.release();
    }
    if (rows.length < BATCH) return;
  }
}

async function fillVectors(table, def) {
  for (let guard = 0; guard < 1000; guard++) {
    const c = await conn();
    let rows;
    try {
      rows = await c.query(
        `SELECT ${def.cols} FROM ${table}
         WHERE embed_hash IS NOT NULL AND embed_hash <> '' AND embedding IS NULL LIMIT ?`,
        [BATCH]
      );
    } finally {
      c.release();
    }
    if (!rows.length) return;
    const vecs = await embeddings.embed(rows.map((r) => def.text(r)));
    const c2 = await conn();
    let written = 0;
    try {
      for (let i = 0; i < rows.length; i++) {
        try {
          await c2.query(
            `UPDATE ${table} SET embedding = VEC_FromText(?) WHERE id = ?`,
            [embeddings.toVectorLiteral(vecs[i]), rows[i].id]
          );
          written++;
        } catch { /* skip bad row, don't abort the batch */ }
      }
    } finally {
      c2.release();
    }
    if (written < rows.length) return; // avoid spinning on rows that won't take a vector
    if (rows.length < BATCH) return;
  }
}

async function sweepOnce() {
  if (!emailEngine.isReady() || !emailEngine.vectorEnabled()) return;
  for (const [table, def] of Object.entries(TABLES)) {
    await stampHashes(table, def);
    await fillVectors(table, def);
  }
}

// Cron entry (email.embed-sweep). Single-flight: a tick during a running sweep
// queues one follow-up pass.
async function sweep() {
  schedule();
}

// ---------------------------------------------------------------------------
// Hybrid search — RRF fusion of FULLTEXT + vector ANN (my-dashboard recipe).
// ---------------------------------------------------------------------------
function rrfFuse(keywordRows, semanticRows, limit, idOf) {
  const merged = new Map();
  const add = (rows, bit) => rows.forEach((r, i) => {
    const id = idOf(r);
    const e = merged.get(id) || { row: r, score: 0, both: 0 };
    e.score += 1 / (RRF_K + i + 1);
    e.both |= bit;
    merged.set(id, e);
  });
  add(keywordRows, 1);
  add(semanticRows, 2);
  return [...merged.values()]
    .map((e) => { if (e.both === 3) e.score *= 1.25; return e; }) // found by both = strong signal
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => { e.row.score = e.score; return e.row; });
}

function cutoff(params) {
  const n = params.nearEnough ?? emailEngine.getSetting('nearEnough');
  return typeof n === 'number' ? n : 0.6;
}

// e5 is asymmetric: a search query must be embedded with the `query:` prefix
// and stored content with `passage:`. This passed no options, so every semantic
// search was embedded off-recipe against passage-embedded rows — measurably
// worse ranking, silently. Stored rows stay `passage:` and are untouched, so
// this needs no re-embedding and no embed_hash bump.
async function queryLiteral(text) {
  const vec = await embeddings.embed(text, { kind: 'query' });
  return embeddings.toVectorLiteral(vec);
}

// The vector expression: either an embedded query literal or a "more like
// this" subquery against a stored row's vector (similarTo).
function vectorExpr(literal, subquery) {
  return literal ? 'VEC_FromText(?)' : `(${subquery})`;
}

async function similarSearch(params = {}, appName = null) {
  if (!emailEngine.vectorEnabled()) {
    return emailEngine.listEmails({ ...params, similarSearch: false }, appName);
  }
  const limit = Number(params.limit) || 50;
  const maxDist = cutoff(params);

  // Operators are predicates on both halves of the hybrid, not a post-filter:
  // `from:anna ferry booking` must mean "semantically about a ferry booking,
  // AND from Anna" — a vector search that ignored `from:` would return Bob's
  // mail and then have it thrown away, spending the whole result budget on rows
  // the caller already excluded.
  const q = params.search ? require('./email-query').parseSearchQuery(params.search) : null;
  const freeText = q ? q.freeText : '';

  let literal = null;
  const subVals = [];
  if (params.similarTo?.uid) {
    subVals.push(params.similarTo.account, String(params.similarTo.uid));
  } else if (freeText) {
    literal = await queryLiteral(freeText);
  } else {
    // Operators with no free text ("everything from Anna") is a filter, not a
    // similarity question — the keyword path answers it exactly.
    return emailEngine.listEmails({ ...params, similarSearch: false }, appName);
  }

  const where = ['e.embedding IS NOT NULL'];
  const vals = [];
  if (q?.hasOps) {
    const ops = require('./email-query').operatorSql(q, 'e.', { labels: emailEngine.listLabels() });
    where.push(...ops.where);
    vals.push(...ops.vals);
  }
  if (params.account) { where.push('e.account = ?'); vals.push(params.account); }
  if (params.folder) { where.push('e.folder = ?'); vals.push(params.folder); }
  if (params.since) { where.push('e.date >= ?'); vals.push(new Date(params.since)); }
  if (!params.includeDeleted) where.push('e.is_deleted = FALSE');
  if (params.similarTo?.uid) {
    where.push('NOT (e.account = ? AND e.uid = ?)'); // exclude the reference row itself
    vals.push(params.similarTo.account, String(params.similarTo.uid));
  }

  const expr = vectorExpr(literal,
    'SELECT embedding FROM platform_emails WHERE account = ? AND uid = ?');
  const c = await conn();
  let semRows;
  try {
    semRows = await c.query(
      `SELECT e.*, VEC_DISTANCE_COSINE(e.embedding, ${expr}) AS _dist
       FROM platform_emails e
       WHERE ${where.join(' AND ')}
       ORDER BY _dist ASC LIMIT ?`,
      [...(literal ? [literal] : subVals), ...vals, limit * 2]
    );
  } finally {
    c.release();
  }
  // These rows come from this module's own SQL, so the read path's render mode
  // has to be applied here as well — the keyword half below arrives through
  // listEmails already rendered.
  const semantic = emailEngine.renderRows(semRows
    .filter((r) => Number(r._dist) <= maxDist)
    .map((r) => { const e = emailEngine.toEmail(r); e._dist = Number(r._dist); return e; }), params);

  let keyword = [];
  if (params.search) {
    const kw = await emailEngine.listEmails(
      { ...params, similarSearch: false, limit: limit * 2, offset: 0 }, null);
    keyword = kw.emails;
  }

  const emails = rrfFuse(keyword, semantic, limit, (e) => `${e.account} ${e.id}`);
  const c2 = await conn();
  try {
    // Same readers as the keyword path (listEmails): the caller's own kinds plus
    // the writers it named — a hybrid result must not lose what a plain list shows.
    await emailEngine.attachAnnotations(c2, appName, emails, params.annotationsFrom);
  } finally {
    c2.release();
  }
  return {
    emails, total: emails.length, semantic: true,
    ...(q ? { query: { freeText, hasOps: q.hasOps } } : {}),
  };
}

async function similarSearchCalendar(params = {}, appName = null) {
  if (!emailEngine.vectorEnabled()) {
    return calendarEngine.listEvents({ ...params, similarSearch: false }, appName);
  }
  const limit = Number(params.limit) || 50;
  const maxDist = cutoff(params);

  let literal = null;
  const subVals = [];
  if (params.similarTo?.eventId) {
    subVals.push(params.similarTo.account, params.similarTo.eventId);
  } else if (params.q || params.search) {
    literal = await queryLiteral(params.q || params.search);
  } else {
    return calendarEngine.listEvents({ ...params, similarSearch: false }, appName);
  }

  const where = ['e.embedding IS NOT NULL'];
  const vals = [];
  if (params.account) { where.push('e.account = ?'); vals.push(params.account); }
  if (params.calendarIds?.length) {
    where.push(`e.calendar_id IN (${params.calendarIds.map(() => '?').join(',')})`);
    vals.push(...params.calendarIds);
  }
  if (params.timeMin) {
    where.push('(e.start_datetime >= ? OR e.start_date >= ?)');
    const d = new Date(params.timeMin);
    vals.push(d, d.toISOString().split('T')[0]);
  }
  if (params.timeMax) {
    where.push('(e.start_datetime <= ? OR e.start_date <= ?)');
    const d = new Date(params.timeMax);
    vals.push(d, d.toISOString().split('T')[0]);
  }
  if (!params.includeCancelled) where.push('e.is_cancelled = FALSE');
  if (params.similarTo?.eventId) {
    where.push('NOT (e.account = ? AND e.event_id = ?)');
    vals.push(params.similarTo.account, params.similarTo.eventId);
  }

  const expr = vectorExpr(literal,
    'SELECT embedding FROM platform_calendar_events WHERE account = ? AND event_id = ?');
  const c = await conn();
  let semRows;
  try {
    semRows = await c.query(
      `SELECT e.*, VEC_DISTANCE_COSINE(e.embedding, ${expr}) AS _dist
       FROM platform_calendar_events e
       WHERE ${where.join(' AND ')}
       ORDER BY _dist ASC LIMIT ?`,
      [...(literal ? [literal] : subVals), ...vals, limit * 2]
    );
  } finally {
    c.release();
  }
  const calColors = await calendarEngine.calendarColors();
  const semantic = semRows
    .filter((r) => Number(r._dist) <= maxDist)
    .map((r) => { const e = calendarEngine.toEvent(r, calColors); e._dist = Number(r._dist); return e; });

  let keyword = [];
  if (params.q || params.search) {
    const kw = await calendarEngine.listEvents(
      { ...params, q: params.q || params.search, similarSearch: false, limit: limit * 2, offset: 0 }, null);
    keyword = kw.events;
  }

  const events = rrfFuse(keyword, semantic, limit, (e) => `${e._account} ${e.id}`);
  const c2 = await conn();
  try {
    await calendarEngine.attachAnnotations(c2, appName, events);
  } finally {
    c2.release();
  }
  return { events, total: events.length, semantic: true };
}

// Kick the sweep shortly after sync writes (plan A3: "kicked immediately after
// each sync batch"). Backfill suppresses per-message events, so the cron tick
// covers backfill; these handlers cover steady-state deltas.
emailEngine.registerHandler('_embed', 'email:new', kick);
emailEngine.registerHandler('_embed', 'email:backfill-progress', kick);
emailEngine.registerHandler('_embed', 'calendar:changed', kick);

emailEngine.registerProvider('embed', { sweep, similarSearch, similarSearchCalendar });

module.exports = { sweep, similarSearch, similarSearchCalendar };
