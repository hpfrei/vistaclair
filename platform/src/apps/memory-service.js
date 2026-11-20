// Platform memory service — a single shared, self-tending knowledge store for all
// platform apps. Reuses the existing MariaDB pool (no new server).
//
// Three storage layers (see plan Part E):
//   1. memory_observations  — raw append-only intake. remember() = one cheap INSERT.
//   2. memory_facts/entities — consolidated, deduped, embedded knowledge (recall surface).
//   3. memory_sources       — append-only provenance ledger (audit spine, never edited).
//
// Recall is vector ANN + FULLTEXT fused by reciprocal-rank, zero AI on the fast path.
// Writes are µs-cheap; the intelligence (extract/reconcile) runs in the idle-gated
// consolidator (see memory-maintenance.js).
const appDb = require('./app-db');
const platformSettings = require('./platform-settings');
const embeddings = require('./embeddings');

const DB = 'vc_platform_memory';
const EMBED_DIM = embeddings.DIM;
const EMBED_V = embeddings.MODEL_VERSION; // stamped on every row we embed

let _appsDir = null;
let _ready = false;

// Embeddings are provided by the shared ./embeddings module (same singleton
// apps use). embed() here always returns an array-of-vectors for the internal
// callers that pass an array; vecText is the MariaDB VECTOR literal helper.
async function embed(texts, kind = 'passage') {
  const arr = Array.isArray(texts) ? texts : [texts];
  if (arr.length === 0) return [];
  const out = await embeddings.embed(arr, { kind });
  return Array.isArray(out[0]) ? out : [out];
}

function vecText(v) {
  return embeddings.toVectorLiteral(v);
}

// ---------------------------------------------------------------------------
// Schema — idempotent. CREATE IF NOT EXISTS + additive ALTER .catch().
// ---------------------------------------------------------------------------
async function conn() {
  const pool = appDb.getPool();
  if (!pool) throw new Error('Database not connected. Configure in Apps > Setup.');
  const c = await pool.getConnection();
  await c.query(`USE \`${DB}\``);
  return c;
}

async function init(appsDir) {
  _appsDir = appsDir;
  const pool = appDb.getPool();
  if (!pool) {
    // DB not configured yet — defer. init() is called again on db:connect.
    return false;
  }
  const c = await pool.getConnection();
  try {
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\``);
    await c.query(`USE \`${DB}\``);

    await c.query(`
      CREATE TABLE IF NOT EXISTS memory_observations (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        content TEXT NOT NULL,
        app_origin VARCHAR(128) NOT NULL,
        scope ENUM('private','shared','global') NOT NULL DEFAULT 'shared',
        source_ref JSON,
        natural_key VARCHAR(255),
        event_time TIMESTAMP NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        consolidated_at TIMESTAMP NULL,
        UNIQUE KEY uniq_natural (app_origin, natural_key),
        KEY idx_unconsolidated (consolidated_at, created_at),
        FULLTEXT KEY ft_content (content)
      ) ENGINE=InnoDB
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS memory_entities (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(64),
        app_origin VARCHAR(128) NOT NULL,
        scope ENUM('private','shared','global') NOT NULL DEFAULT 'shared',
        embedding VECTOR(${EMBED_DIM}) NOT NULL,
        importance FLOAT NOT NULL DEFAULT 0.5,
        last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        VECTOR INDEX (embedding),
        KEY idx_name (name),
        FULLTEXT KEY ft_name (name)
      ) ENGINE=InnoDB
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS memory_facts (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        entity_id BIGINT NULL,
        subject VARCHAR(255) NOT NULL,
        predicate VARCHAR(128) NOT NULL,
        value TEXT NOT NULL,
        content TEXT NOT NULL,
        app_origin VARCHAR(128) NOT NULL,
        scope ENUM('private','shared','global') NOT NULL DEFAULT 'shared',
        tier ENUM('short','long') NOT NULL DEFAULT 'short',
        embedding VECTOR(${EMBED_DIM}) NOT NULL,
        importance FLOAT NOT NULL DEFAULT 0.5,
        hit_count INT NOT NULL DEFAULT 0,
        event_time TIMESTAMP NULL,
        last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        valid_to TIMESTAMP NULL,
        superseded_by BIGINT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        VECTOR INDEX (embedding),
        KEY idx_subj_pred (subject, predicate),
        KEY idx_current (valid_to, tier, importance),
        KEY idx_entity (entity_id),
        FULLTEXT KEY ft_content (content)
      ) ENGINE=InnoDB
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS memory_sources (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        memory_id BIGINT NOT NULL,
        memory_kind ENUM('fact','entity','relation') NOT NULL,
        action ENUM('insert','update','supersede','merge','reinforce','forget') NOT NULL,
        app_origin VARCHAR(128) NOT NULL,
        source_ref JSON,
        confidence FLOAT,
        recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        supersedes_source_id BIGINT NULL,
        KEY idx_memory (memory_kind, memory_id),
        KEY idx_chain (supersedes_source_id)
      ) ENGINE=InnoDB
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS memory_sources_archive LIKE memory_sources
    `).catch(() => {});

    await c.query(`
      CREATE TABLE IF NOT EXISTS memory_maintenance_runs (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        job VARCHAR(64) NOT NULL,
        started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMP NULL,
        scanned INT DEFAULT 0,
        affected INT DEFAULT 0,
        backlog INT DEFAULT 0,
        ok TINYINT DEFAULT 1,
        error TEXT NULL,
        KEY idx_job (job, started_at)
      ) ENGINE=InnoDB
    `);

    // Single-row meta for cross-run counters (churn, one-time flags, run-locks).
    await c.query(`
      CREATE TABLE IF NOT EXISTS memory_meta (
        k VARCHAR(64) PRIMARY KEY,
        v TEXT
      ) ENGINE=InnoDB
    `);

    // Migration: natural_key uniqueness was global, so two apps writing the same
    // key silently swallowed each other's observations. Make it per-app.
    // Detect the old single-column index shape (natural_key first) and swap it;
    // loosening uniqueness can never fail on existing data.
    const oldIdx = await c.query(
      `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'memory_observations'
         AND INDEX_NAME = 'uniq_natural' AND COLUMN_NAME = 'natural_key' AND SEQ_IN_INDEX = 1`,
      [DB],
    ).catch(() => []);
    if (oldIdx.length && Number(oldIdx[0].n)) {
      await c.query(
        'ALTER TABLE memory_observations DROP INDEX uniq_natural, ADD UNIQUE KEY uniq_natural (app_origin, natural_key)',
      );
      console.log('  Memory: migrated natural_key uniqueness to per-app');
    }

    // Per-row embedding version. A row whose embed_v is not the current model
    // version carries a vector from a DIFFERENT model — not comparable, so the
    // catch-up below re-embeds it. Old/other code paths that write an embedding
    // without knowing this column leave it NULL and are detected automatically.
    await c.query('ALTER TABLE memory_facts ADD COLUMN embed_v SMALLINT NULL, ADD KEY idx_embed_v (embed_v)').catch(() => {});
    await c.query('ALTER TABLE memory_entities ADD COLUMN embed_v SMALLINT NULL, ADD KEY idx_embed_v (embed_v)').catch(() => {});
    // Time-bound facts ("in Zurich until Friday") carry the date they stop
    // being true; recall hides them from then on, the retention pass retires them.
    await c.query('ALTER TABLE memory_facts ADD COLUMN expires_at TIMESTAMP NULL').catch(() => {});
    // 'forget' provenance action (owner-driven curation via Horst chat —
    // ownerForget below). Extending an enum at the tail is an instant metadata
    // change; the archive is kept in step so compaction's INSERT..SELECT can
    // carry forget rows. On stores that already have the value this is a no-op.
    const SOURCE_ACTIONS = "ENUM('insert','update','supersede','merge','reinforce','forget') NOT NULL";
    await c.query(`ALTER TABLE memory_sources MODIFY action ${SOURCE_ACTIONS}`).catch(() => {});
    await c.query(`ALTER TABLE memory_sources_archive MODIFY action ${SOURCE_ACTIONS}`).catch(() => {});
    _ready = true;
    console.log('  Memory: schema ready');
    // Model-version marker: vectors from a previous embedding model are not
    // comparable — re-embed in the background when the model changed.
    migrateEmbeddings().catch((err) => console.warn('  Memory: embedding migration failed:', err.message));
    return true;
  } catch (err) {
    console.error('  Memory: schema init failed:', err.message);
    return false;
  } finally {
    c.release();
  }
}

function isReady() {
  return _ready && !!appDb.getPool();
}

// Cheap store counts for the map / brain browser.
async function counts() {
  if (!isReady()) return null;
  const c = await conn();
  try {
    const [f, e, o] = await Promise.all([
      c.query('SELECT COUNT(*) AS n FROM memory_facts WHERE valid_to IS NULL'),
      c.query('SELECT COUNT(*) AS n FROM memory_entities'),
      c.query('SELECT COUNT(*) AS n FROM memory_observations'),
    ]);
    return { facts: Number(f[0].n), entities: Number(e[0].n), observations: Number(o[0].n) };
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// Embedding-model migration — one-time, resumable, local-only (no API cost).
// The memory_meta 'embedding_model' marker is written ONLY after a full pass,
// so an interrupted run simply re-runs at next boot (UPDATEs are idempotent).
// Recall stays functional during migration: mixed vectors degrade ranking,
// the FULLTEXT half of RRF is unaffected.
// ---------------------------------------------------------------------------
let _migrating = false;
async function migrateEmbeddings() {
  if (!isReady() || _migrating) return;
  const V = embeddings.MODEL_VERSION;
  const current = `${embeddings.MODEL}@v${V}`;
  const c = await conn();
  try {
    // Row-level, not marker-level: a global "model changed?" flag cannot see
    // rows written by a process running OTHER code (e.g. the previous build
    // still live while this one deploys) — those carry a foreign model's
    // vector with embed_v NULL and would stay stale forever behind a flag.
    // Scanning for embed_v <> V is cheap (indexed) and self-healing.
    const tables = [
      { table: 'memory_facts', textOf: (r) => r.content || [r.subject, r.predicate, r.value].filter(Boolean).join(' ') },
      { table: 'memory_entities', textOf: (r) => `${r.name} ${r.type || ''}`.trim() },
    ];
    let staleTotal = 0;
    for (const { table } of tables) {
      const n = await c.query(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE embedding IS NOT NULL AND (embed_v IS NULL OR embed_v <> ?)`, [V]);
      staleTotal += Number(n[0]?.n || 0);
    }
    if (!staleTotal) {
      await metaSet(c, 'embedding_model', current);
      return;
    }
    _migrating = true;
    const stored = await metaGet(c, 'embedding_model', null);
    console.log(`  Memory: ${staleTotal} row(s) carry a foreign embedding (${stored === current ? 'written by another build' : `${stored || 'unset'} → ${current}`}) — re-embedding…`);
    for (const { table, textOf } of tables) {
      let total = 0;
      // Cursor-free: each pass takes the next stale batch, and stamping
      // embed_v shrinks the remaining set — so an interrupted run simply
      // resumes where it stopped at the next boot.
      for (;;) {
        const rows = await c.query(
          `SELECT * FROM \`${table}\` WHERE embedding IS NOT NULL AND (embed_v IS NULL OR embed_v <> ?) ORDER BY id ASC LIMIT 128`,
          [V],
        );
        if (!rows.length) break;
        const vecs = await embed(rows.map(textOf)); // passage kind (stored content)
        for (let i = 0; i < rows.length; i++) {
          await c.query(`UPDATE \`${table}\` SET embedding = VEC_FromText(?), embed_v = ? WHERE id = ?`, [vecText(vecs[i]), V, Number(rows[i].id)]);
        }
        total += rows.length;
      }
      if (total) console.log(`  Memory: re-embedded ${total} row(s) in ${table}`);
    }
    await metaSet(c, 'embedding_model', current);
    console.log('  Memory: embedding catch-up complete');
  } finally {
    _migrating = false;
    c.release();
  }
}

// ---------------------------------------------------------------------------
// Meta helpers (counters / locks).
// ---------------------------------------------------------------------------
async function metaGet(c, key, fallback = null) {
  const r = await c.query('SELECT v FROM memory_meta WHERE k = ?', [key]);
  return r.length ? r[0].v : fallback;
}
async function metaSet(c, key, val) {
  await c.query(
    'INSERT INTO memory_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    [key, String(val)],
  );
}
async function metaBump(c, key, delta) {
  await c.query(
    'INSERT INTO memory_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = CAST(v AS SIGNED) + ?',
    [key, String(delta), delta],
  );
}

// ---------------------------------------------------------------------------
// remember() — fast append. Zero AI. The intelligence happens in consolidation.
// remember({ content, scope?, source?, event_time?, app_origin })
// ---------------------------------------------------------------------------
async function remember(params) {
  if (!isReady()) throw new Error('Memory service not ready (DB not connected).');
  const content = (params.content || '').trim();
  if (!content) throw new Error('remember requires content');
  const appOrigin = params.app_origin || params.appName || 'platform';
  const scope = ['private', 'shared', 'global'].includes(params.scope) ? params.scope : 'shared';
  const source = params.source || { type: appOrigin === 'platform' ? 'user' : 'app', app: appOrigin };
  // Natural key makes re-mining idempotent (re-ingesting the same email is a no-op).
  const naturalKey = params.natural_key
    || (source && source.type && (source.messageId || source.eventId || source.sessionId)
      ? `${source.type}:${source.messageId || source.eventId || `${source.sessionId}:${source.turn ?? ''}`}`
      : null);

  const c = await conn();
  try {
    const res = await c.query(
      `INSERT INTO memory_observations (content, app_origin, scope, source_ref, natural_key, event_time)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      [content, appOrigin, scope, JSON.stringify(source), naturalKey, params.event_time ? new Date(params.event_time) : null],
    );
    const inserted = Number(res.affectedRows) > 0 && Number(res.insertId) > 0;
    return { ok: true, observationId: Number(res.insertId) || null, deduped: !inserted };
  } finally {
    c.release();
  }
}

// Bulk variant — one transaction, for mining. All idempotent via natural_key.
async function rememberBatch(items) {
  if (!isReady()) throw new Error('Memory service not ready (DB not connected).');
  if (!Array.isArray(items) || items.length === 0) return { ok: true, inserted: 0 };
  const pool = appDb.getPool();
  const c = await pool.getConnection();
  let inserted = 0;
  try {
    await c.query(`USE \`${DB}\``);
    await c.beginTransaction();
    for (const it of items) {
      const content = (it.content || '').trim();
      if (!content) continue;
      const appOrigin = it.app_origin || it.appName || 'platform';
      const scope = ['private', 'shared', 'global'].includes(it.scope) ? it.scope : 'shared';
      const source = it.source || { type: 'app', app: appOrigin };
      const naturalKey = it.natural_key
        || (source && source.type && (source.messageId || source.eventId || source.sessionId)
          ? `${source.type}:${source.messageId || source.eventId || `${source.sessionId}:${source.turn ?? ''}`}`
          : null);
      const res = await c.query(
        `INSERT INTO memory_observations (content, app_origin, scope, source_ref, natural_key, event_time)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = id`,
        [content, appOrigin, scope, JSON.stringify(source), naturalKey, it.event_time ? new Date(it.event_time) : null],
      );
      if (Number(res.insertId) > 0 && Number(res.affectedRows) > 0) inserted++;
    }
    await c.commit();
    return { ok: true, inserted, received: items.length };
  } catch (err) {
    try { await c.rollback(); } catch {}
    throw err;
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// recall() — vector ANN + FULLTEXT fused by RRF + recent-observations union.
// Zero AI on the fast path; optional ai.prompt distill when distill:true.
// Scope filter at every read: shared/global OR (private AND own app_origin).
// recall({ query, scope_caller, limit?, withSources?, distill?, subject?, reinforce? })
// subject: optional entity scope — restricts both search paths to facts whose
// subject matches (entity-first retrieval: at store sizes where global
// similarity decays, association by entity is the precise path).
// reinforce: count this recall as USE of the hits (hit_count/last_seen), which
// feeds promotion. Only deliberate lookups pass it (Horst's memory_search) —
// prompt tasters, triage and browsing retrieve on every event, and counting
// those promoted whatever sat near the traffic rather than what was useful.
// ---------------------------------------------------------------------------
function scopeClause(caller, alias = '') {
  const p = alias ? `${alias}.` : '';
  return {
    sql: `(${p}scope IN ('shared','global') OR (${p}scope = 'private' AND ${p}app_origin = ?))`,
    param: caller,
  };
}

async function recall(params) {
  if (!isReady()) throw new Error('Memory service not ready (DB not connected).');
  const query = (params.query || '').trim();
  if (!query) throw new Error('recall requires a query');
  const caller = params.scope_caller || params.app_origin || 'platform';
  const limit = Math.min(params.limit || platformSettings.get('memoryRecallLimit') || 12, 50);
  const subject = (params.subject || '').trim();
  const subjSql = subject ? ' AND subject LIKE ?' : '';
  const subjVal = subject ? [`%${subject}%`] : [];
  const live = 'valid_to IS NULL AND (expires_at IS NULL OR expires_at > NOW())';

  const c = await conn();
  try {
    const sc = scopeClause(caller);

    // --- Path A: vector ANN (semantic). Degrades gracefully if embed fails. ---
    let vectorRows = [];
    try {
      // Callers may pass a pre-computed query vector (params.queryVec) to avoid
      // redundant embed() calls when recalling in a batch — e.g. horst-triage
      // batch-embeds all email queries in one inference then fans out recalls.
      const qvec = params.queryVec || (await embed(query, 'query'))[0];
      const qv = vecText(qvec);
      vectorRows = await c.query(
        `SELECT id, subject, predicate, value, content, importance, tier, hit_count, event_time, app_origin,
                VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS dist
         FROM memory_facts
         WHERE ${live} AND embedding IS NOT NULL AND ${sc.sql}${subjSql}
         ORDER BY dist ASC
         LIMIT ?`,
        [qv, sc.param, ...subjVal, limit * 2],
      );
    } catch (err) {
      // Embedding unavailable (cold/offline) — FULLTEXT-only fallback (degradation rule).
      vectorRows = [];
    }

    // --- Path B: FULLTEXT (exact/rare tokens). ---
    let ftRows = [];
    try {
      ftRows = await c.query(
        `SELECT id, subject, predicate, value, content, importance, tier, hit_count, event_time, app_origin,
                MATCH(content) AGAINST (? IN NATURAL LANGUAGE MODE) AS score
         FROM memory_facts
         WHERE ${live} AND ${sc.sql}${subjSql}
           AND MATCH(content) AGAINST (? IN NATURAL LANGUAGE MODE)
         ORDER BY score DESC
         LIMIT ?`,
        [query, caller, ...subjVal, query, limit * 2],
      );
    } catch {
      ftRows = [];
    }

    // --- Fuse by reciprocal-rank (RRF). ---
    const K = 60;
    const fused = new Map();
    vectorRows.forEach((r, i) => {
      const e = fused.get(r.id) || { row: r, score: 0, both: false };
      e.score += 1 / (K + i + 1);
      e.vector = true;
      fused.set(r.id, e);
    });
    ftRows.forEach((r, i) => {
      const e = fused.get(r.id) || { row: r, score: 0 };
      e.score += 1 / (K + i + 1);
      if (e.vector) { e.score *= 1.25; e.both = true; } // boost rows hit by both paths
      e.row = e.row || r;
      fused.set(r.id, e);
    });

    // Long-tier facts (durable records, owner-stated, re-observed) win ties.
    for (const e of fused.values()) if (e.row.tier === 'long') e.score *= 1.15;

    let ranked = [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((e) => ({
        id: Number(e.row.id),
        subject: e.row.subject,
        predicate: e.row.predicate,
        value: e.row.value,
        content: e.row.content,
        tier: e.row.tier,
        hit_count: e.row.hit_count != null ? Number(e.row.hit_count) : null,
        importance: e.row.importance,
        event_time: e.row.event_time,
        app_origin: e.row.app_origin,
        matched_by: e.both ? 'both' : (e.vector ? 'vector' : 'fulltext'),
      }));

    // --- Pending-observations union: a written fact may not be consolidated yet
    // (backlog, or maintenance paused with Horst) — no age window, so nothing
    // written is ever invisible. ---
    let recent = [];
    try {
      recent = await c.query(
        `SELECT id, content, app_origin, created_at
         FROM memory_observations
         WHERE consolidated_at IS NULL AND ${sc.sql}
           AND MATCH(content) AGAINST (? IN NATURAL LANGUAGE MODE)
         ORDER BY created_at DESC
         LIMIT ?`,
        [sc.param, query, Math.max(3, Math.floor(limit / 2))],
      );
    } catch {
      recent = [];
    }
    const recentItems = recent.map((r) => ({
      id: `obs:${Number(r.id)}`,
      content: r.content,
      app_origin: r.app_origin,
      pending: true,
    }));

    // --- Reinforce (deliberate lookups only): bump hit_count/last_seen/importance (drives promotion). ---
    if (params.reinforce === true && ranked.length) {
      const ids = ranked.map((r) => r.id);
      await c.query(
        `UPDATE memory_facts
         SET hit_count = hit_count + 1, last_seen = NOW(),
             importance = LEAST(1.0, importance + 0.02)
         WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids,
      ).catch(() => {});
    }

    // --- Optional provenance. ---
    if (params.withSources && ranked.length) {
      const depth = params.sourceDepth === 'full' ? 'full' : 'current';
      for (const r of ranked) {
        r.sources = await sourcesFor(c, 'fact', r.id, depth);
      }
    }

    const result = { hits: ranked, recent: recentItems, query };

    // --- Optional distillation (the ONLY AI call, opt-in). ---
    if (params.distill && (ranked.length || recentItems.length)) {
      try {
        const appBridge = require('./app-bridge');
        const facts = [...ranked.map((r) => `- ${r.content}`), ...recentItems.map((r) => `- (recent) ${r.content}`)].join('\n');
        const out = await appBridge.aiPrompt('platform', _appsDir, {
          model: platformSettings.memoryAiModel(), // memory AI: haiku/deepseek only, never the chat model
          allowedTools: [], // pure text distillation — tools would let it write memory back (echo loop)
          systemPrompt: 'You distill stored memory into a direct answer. Use ONLY the provided facts. If they do not answer the question, say so plainly. Be concise.',
          message: `Question: ${query}\n\nStored facts:\n${facts}\n\nAnswer:`,
        });
        result.answer = out.text;
      } catch (err) {
        result.answer = null;
        result.distillError = err.message;
      }
    }

    return result;
  } finally {
    c.release();
  }
}

// Walk the provenance ledger for a memory row.
async function sourcesFor(c, kind, memoryId, depth) {
  const rows = await c.query(
    `SELECT id, action, app_origin, source_ref, confidence, recorded_at, supersedes_source_id
     FROM memory_sources WHERE memory_kind = ? AND memory_id = ? ORDER BY recorded_at DESC`,
    [kind, memoryId],
  );
  const norm = rows.map((r) => ({
    action: r.action,
    app_origin: r.app_origin,
    source_ref: r.source_ref,
    confidence: r.confidence,
    recorded_at: r.recorded_at,
  }));
  return depth === 'full' ? norm : norm.slice(0, 1);
}

// ---------------------------------------------------------------------------
// bySource — "what was remembered from THIS artifact".
// recall() is text-driven and cannot answer it: a surface showing one email
// wants the memories mined from that exact message, not the ones that read
// similarly. Covers both stages of the pipeline — freshly mined observations
// (written immediately by the miner) and the facts they were consolidated into
// (reached through the memory_sources provenance ledger).
// Scope is enforced with the same scopeClause() every other read uses, so this
// cannot become a way to read another app's private rows by guessing an id.
// ---------------------------------------------------------------------------
async function bySource({ type = 'email', account, uid, limit = 25 } = {}, caller = 'platform') {
  if (!isReady()) throw new Error('Memory service not ready.');
  if (!uid) throw new Error('bySource requires uid');
  const cap = Math.min(Number(limit) || 25, 100);
  const c = await conn();
  try {
    const match = [`JSON_UNQUOTE(JSON_EXTRACT(o.source_ref, '$.uid')) = ?`];
    const vals = [String(uid)];
    if (account) { match.push(`JSON_UNQUOTE(JSON_EXTRACT(o.source_ref, '$.account')) = ?`); vals.push(account); }
    if (type) { match.push(`JSON_UNQUOTE(JSON_EXTRACT(o.source_ref, '$.type')) = ?`); vals.push(type); }
    const sc = scopeClause(caller, 'o');

    const observations = await c.query(
      `SELECT o.id, o.content, o.app_origin, o.event_time, o.created_at, o.consolidated_at
         FROM memory_observations o
        WHERE ${match.join(' AND ')} AND ${sc.sql}
        ORDER BY o.created_at DESC LIMIT ?`,
      [...vals, sc.param, cap],
    );

    // Same predicate, one hop further: sources → the fact each one produced.
    const scf = scopeClause(caller, 'f');
    const facts = await c.query(
      `SELECT DISTINCT f.id, f.subject, f.predicate, f.value, f.content, f.importance,
              f.event_time, f.app_origin
         FROM memory_sources o
         JOIN memory_facts f ON f.id = o.memory_id AND o.memory_kind = 'fact'
        WHERE ${match.join(' AND ')} AND f.valid_to IS NULL AND ${scf.sql}
        ORDER BY f.importance DESC LIMIT ?`,
      [...vals, scf.param, cap],
    );

    return { observations, facts };
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// forget / update / entities / history — direct data ops.
// ---------------------------------------------------------------------------
async function forget(params) {
  if (!isReady()) throw new Error('Memory service not ready.');
  const caller = params.scope_caller || params.app_origin || 'platform';
  if (!params.id) throw new Error('forget requires id');
  const c = await conn();
  try {
    // Soft-forget: mark superseded so provenance survives; never hard-delete here.
    // Destructive ops require ownership — shared visibility never grants deletion.
    const res = await c.query(
      'UPDATE memory_facts SET valid_to = NOW() WHERE id = ? AND valid_to IS NULL AND app_origin = ?',
      [params.id, caller],
    );
    return { ok: true, forgotten: Number(res.affectedRows) };
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// Owner curation — "forget X" / "that's outdated, now it's Y" from Horst chat.
//
// Unlike forget() above these are NOT on the app bridge: they skip the
// app_origin ownership check because the human owner outranks whichever app
// happened to mine the fact (the same deliberate deviation tasks-engine
// documents for shared todos). Only owner-authed surfaces may call them —
// today that is platform-horst's chat markers (<horst-forget> /
// <horst-supersede>); the bridge/ctx surface stays owner-only forget().
// Both are soft: the row and its provenance chain survive, only recall stops
// seeing it — and both append a memory_sources ledger row, so the user's
// curation is as auditable as any consolidator decision (G10).
// ---------------------------------------------------------------------------
async function ownerForget({ id, reason = null, via = 'chat' } = {}) {
  if (!isReady()) throw new Error('Memory service not ready.');
  const factId = Number(id);
  if (!Number.isFinite(factId) || factId <= 0) throw new Error('ownerForget requires a numeric fact id');
  const c = await conn();
  try {
    const rows = await c.query(
      'SELECT id, subject, predicate, value, content, app_origin FROM memory_facts WHERE id = ? AND valid_to IS NULL',
      [factId],
    );
    if (!rows.length) throw new Error(`fact #${factId} not found (already forgotten, or not a consolidated fact)`);
    await c.query('UPDATE memory_facts SET valid_to = NOW() WHERE id = ?', [factId]);
    await c.query(
      `INSERT INTO memory_sources (memory_id, memory_kind, action, app_origin, source_ref, confidence)
       VALUES (?, 'fact', 'forget', 'horst', ?, 1.0)`,
      [factId, JSON.stringify({ type: 'owner', via, ...(reason ? { reason: String(reason).slice(0, 300) } : {}) })],
    );
    return { ok: true, fact: rows[0] };
  } finally {
    c.release();
  }
}

// Supersede = link old→new: the old fact is tombstoned with `superseded_by`
// pointing at the correction, and the ledger row chains to the old fact's
// latest source — exactly the shape the consolidator writes, so the Brain
// tab's provenance unfold reads a chat correction like any other supersede.
async function ownerSupersede({ id, content, via = 'chat' } = {}) {
  if (!isReady()) throw new Error('Memory service not ready.');
  const factId = Number(id);
  if (!Number.isFinite(factId) || factId <= 0) throw new Error('ownerSupersede requires a numeric fact id');
  const text = String(content || '').trim();
  if (!text) throw new Error('ownerSupersede requires the corrected fact text');
  const [vec] = await embed(text); // passage (stored content) — before the tx, keeps the lock window short
  const c = await conn();
  try {
    await c.beginTransaction();
    const rows = await c.query('SELECT * FROM memory_facts WHERE id = ? AND valid_to IS NULL FOR UPDATE', [factId]);
    if (!rows.length) {
      await c.rollback();
      throw new Error(`fact #${factId} not found (already forgotten or superseded)`);
    }
    const old = rows[0];
    const ins = await c.query(
      `INSERT INTO memory_facts (entity_id, subject, predicate, value, content, app_origin, scope, tier, embedding, embed_v, importance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, VEC_FromText(?), ?, ?)`,
      [
        old.entity_id, old.subject, old.predicate, text.slice(0, 4000), text.slice(0, 4000),
        // Owner-stated, so long tier: never pruned (docs/memory.md, "Durable").
        old.app_origin, old.scope, 'long', vecText(vec), EMBED_V,
        // A correction straight from the owner is at least as trustworthy as
        // what it replaces — never demote below the old importance.
        Math.max(Number(old.importance) || 0.5, 0.6),
      ],
    );
    const newId = Number(ins.insertId);
    await c.query('UPDATE memory_facts SET valid_to = NOW(), superseded_by = ? WHERE id = ?', [newId, factId]);
    const prevSrc = await c.query(
      "SELECT id FROM memory_sources WHERE memory_kind='fact' AND memory_id=? ORDER BY recorded_at DESC LIMIT 1",
      [factId],
    );
    await c.query(
      `INSERT INTO memory_sources (memory_id, memory_kind, action, app_origin, source_ref, confidence, supersedes_source_id)
       VALUES (?, 'fact', 'supersede', 'horst', ?, 1.0, ?)`,
      [newId, JSON.stringify({ type: 'owner', via }), prevSrc.length ? Number(prevSrc[0].id) : null],
    );
    await c.commit();
    return { ok: true, newFactId: newId, oldFact: { id: Number(old.id), content: old.content } };
  } catch (err) {
    try { await c.rollback(); } catch {}
    throw err;
  } finally {
    c.release();
  }
}

async function entities(params) {
  if (!isReady()) throw new Error('Memory service not ready.');
  const caller = params.scope_caller || params.app_origin || 'platform';
  const c = await conn();
  try {
    const sc = scopeClause(caller);
    const rows = await c.query(
      `SELECT id, name, type, importance, last_seen, app_origin
       FROM memory_entities WHERE ${sc.sql}
       ORDER BY importance DESC, last_seen DESC LIMIT ?`,
      [sc.param, Math.min(params.limit || 50, 200)],
    );
    return { entities: rows.map((r) => ({ ...r, id: Number(r.id) })) };
  } finally {
    c.release();
  }
}

async function history(params) {
  if (!isReady()) throw new Error('Memory service not ready.');
  if (!params.memory_id) throw new Error('history requires memory_id');
  const caller = params.scope_caller || params.app_origin || 'platform';
  const kind = params.memory_kind || 'fact';
  const c = await conn();
  try {
    // Provenance is only visible when the memory row itself is (same rule as recall) —
    // otherwise any app could read another app's private source_ref by guessing ids.
    if (kind !== 'fact' && kind !== 'entity') return { memory_id: Number(params.memory_id), sources: [] };
    const table = kind === 'entity' ? 'memory_entities' : 'memory_facts';
    const sc = scopeClause(caller);
    const vis = await c.query(
      `SELECT 1 FROM ${table} WHERE id = ? AND ${sc.sql} LIMIT 1`,
      [params.memory_id, sc.param],
    );
    if (!vis.length) return { memory_id: Number(params.memory_id), sources: [] };
    const chain = await sourcesFor(c, kind, params.memory_id, 'full');
    return { memory_id: Number(params.memory_id), sources: chain };
  } finally {
    c.release();
  }
}

// Live status for the settings pane.
async function status() {
  if (!isReady()) return { ready: false };
  const c = await conn();
  try {
    const [obs] = await c.query('SELECT COUNT(*) AS total, SUM(consolidated_at IS NULL) AS pending FROM memory_observations');
    const [facts] = await c.query("SELECT SUM(tier='short' AND valid_to IS NULL) AS short_, SUM(tier='long' AND valid_to IS NULL) AS long_, COUNT(*) AS total FROM memory_facts");
    const [src] = await c.query('SELECT COUNT(*) AS total FROM memory_sources');
    const [ent] = await c.query('SELECT COUNT(*) AS total FROM memory_entities');
    const runs = await c.query('SELECT job, started_at, finished_at, scanned, affected, backlog, ok, error FROM memory_maintenance_runs ORDER BY started_at DESC LIMIT 8');
    return {
      ready: true,
      observations: { total: Number(obs.total || 0), pending: Number(obs.pending || 0) },
      facts: { short: Number(facts.short_ || 0), long: Number(facts.long_ || 0), total: Number(facts.total || 0) },
      entities: Number(ent.total || 0),
      ledger: Number(src.total || 0),
      lastRuns: runs.map((r) => ({ ...r, ok: !!r.ok })),
    };
  } finally {
    c.release();
  }
}

// App rename: re-home every memory row, or private-scope recall (which filters
// on app_origin) silently loses the app's memories. UPDATE IGNORE because
// memory_observations has a unique key over (app_origin, natural_key) — a rare
// collision with rows left by a previously-deleted app of the new name is
// skipped rather than aborting the whole migration.
async function renameApp(oldName, newName) {
  const c = await conn();
  try {
    let rows = 0;
    for (const t of ['memory_observations', 'memory_entities', 'memory_facts',
                     'memory_sources', 'memory_sources_archive']) {
      const r = await c.query(`UPDATE IGNORE \`${t}\` SET app_origin = ? WHERE app_origin = ?`, [newName, oldName]);
      rows += Number(r.affectedRows || 0);
    }
    return rows;
  } finally {
    c.release();
  }
}

module.exports = {
  init, isReady, status, renameApp,
  remember, rememberBatch, recall, bySource, forget, ownerForget, ownerSupersede, entities, history,
  // internals shared with memory-maintenance.js
  conn, embed, vecText, metaGet, metaSet, metaBump, sourcesFor, scopeClause,
  DB, EMBED_DIM,
  counts,
  EMBED_V,
};
