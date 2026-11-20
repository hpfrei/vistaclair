// Memory maintenance — the self-tending passes (plan Part E).
// All jobs are IDLE-GATED (E0): each entry point does a cheap guard query and
// exits silently (no AI, no log, no run-row) when there is no work. They are
// registered as platform-cron 'internal' jobs (persisted, restart-surviving)
// but only do real work when data has actually arrived/changed.
const fs = require('fs');
const path = require('path');
const mem = require('./memory-service');

// Cosine-DISTANCE cutoffs, calibrated for the current embedding model
// (multilingual-e5-small, whose similarity range is compressed vs the old
// bge-small-en — unrelated text already sits near dist 0.15-0.25). Re-check
// these on ANY model swap; the merge/don't-merge spot checks in the plan's
// verification section are the calibration procedure.
// Measured (2026-08, e5): identical 0.00, EN paraphrase ~0.04, DE↔EN same
// fact ~0.08, unrelated 0.20+. Thresholds sit in the gap.
const NEAR_DUPE_MAX_DIST = 0.05;   // consolidator: observation ≈ already-stored fact
const ENTITY_MATCH_MAX_DIST = 0.1; // entity resolution: same real-world entity

// Two texts that differ in any number (amount, date, reference) are different
// facts however close their vectors — "rent 1,200" must still supersede
// "rent 1,100", and September's bill must never fold into October's.
const numbersOf = (s) => (String(s).match(/\d[\d.,:'-]*/g) || []).join('|');
const sameNumbers = (a, b) => numbersOf(a) === numbersOf(b);

// --- Durable records ----------------------------------------------------------
// The long tier is never forgotten: prune and expiry only touch 'short'. A fact
// enters it durable (the extractor's `durable`, or its observation came from a
// filed document or from the owner in chat) or by promotion (runDecay).
// Artifact provenance is detected by artifactId, not type: horst-artifacts
// spreads the caller's source over type:'artifact', so a mail attachment
// arrives as type:'email' with an artifactId.
function refOf(sourceRef) {
  if (!sourceRef) return {};
  if (typeof sourceRef !== 'string') return sourceRef;
  try { return JSON.parse(sourceRef) || {}; } catch { return {}; }
}
function durableSource(sourceRef) {
  const ref = refOf(sourceRef);
  return ref.artifactId != null || ref.type === 'horst-chat';
}

// --- G10: contradictions raise questions -------------------------------------
// Capped per consolidation run (question fatigue is the failure mode) and
// deduped by subject+predicate within the run. Agenda-only (Timeline), never
// TG — the owner can promote the 'memory-conflict' agenda kind if they want
// pushes. Lazy platform-horst require at emit time (no import cycle at load).
const CONFLICT_CAP_PER_RUN = 3;
let _runConflicts = new Map(); // `${subject}|${predicate}` → note
function noteConflict(subject, predicate, oldValue, newValue, mode) {
  const key = `${subject}|${predicate}`;
  if (_runConflicts.has(key) || _runConflicts.size >= CONFLICT_CAP_PER_RUN) return;
  _runConflicts.set(key, { subject, predicate, oldValue: String(oldValue).slice(0, 120), newValue: String(newValue).slice(0, 120), mode });
}
function emitConflicts() {
  if (!_runConflicts.size) return;
  try {
    const horst = require('./platform-horst');
    for (const n of _runConflicts.values()) {
      const q = n.mode === 'superseded'
        ? `Memory updated: ${n.subject} ${n.predicate} was "${n.oldValue}", now "${n.newValue}" — correct?`
        : `Memory conflict: ${n.subject} ${n.predicate} — "${n.oldValue}" vs "${n.newValue}", which is right?`;
      horst.noteMemoryConflict?.(q, n);
    }
  } catch { /* platform-horst absent (tests) — conflicts just aren't surfaced */ }
  _runConflicts = new Map();
}

const platformSettings = require('./platform-settings');

let _appsDir = null;

function init(appsDir) {
  _appsDir = appsDir;
}

// Memory maintenance is HORST-CONTROLLED (user mandate): the memory system is
// Horst's, so its self-tending runs only while Horst does. All four jobs
// (consolidate/decay/compact/archive — AI and SQL-only alike) stop when Horst
// is paused or when the Horst setting memoryMaintenance is off. The platform
// master switch (memoryMaintenanceEnabled) remains as an additional kill
// switch. Horst settings are read directly from the file — this module must
// not require platform-horst (cycle) — which also makes the gate live: no
// restart needed for a pause to take effect.
function enabled() {
  return platformSettings.get('memoryMaintenanceEnabled') !== false && horstAllows();
}

function horstAllows() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(_appsDir, '.horst', 'settings.json'), 'utf8'));
    if (s.paused) return false;
    return s.memoryMaintenance !== false;
  } catch { return true; } // no Horst settings yet — don't strand the memory system
}

// Cheap run-lock so two ticks (or a manual "run now" + a tick) can't overlap.
// Stored in memory_meta; stale locks (>15 min) are reclaimed.
async function withLock(c, job, fn) {
  const now = Date.now();
  const cur = await mem.metaGet(c, `lock:${job}`);
  if (cur && now - Number(cur) < 15 * 60 * 1000) return { skipped: 'locked' };
  await mem.metaSet(c, `lock:${job}`, now);
  try {
    return await fn();
  } finally {
    await mem.metaSet(c, `lock:${job}`, 0);
  }
}

async function recordRun(c, job, started, summary) {
  await c.query(
    `INSERT INTO memory_maintenance_runs (job, started_at, finished_at, scanned, affected, backlog, ok, error)
     VALUES (?, FROM_UNIXTIME(?), NOW(), ?, ?, ?, ?, ?)`,
    [job, Math.floor(started / 1000), summary.scanned || 0, summary.affected || 0, summary.backlog || 0, summary.ok === false ? 0 : 1, summary.error || null],
  );
  for (const fn of runObservers) { try { fn(job, summary); } catch (err) { console.warn('[memory] run observer failed:', err.message); } }
}

// onRun(fn(job, summary)) — a maintenance pass (consolidate/decay/compact/
// archive/contact-cleanup) recorded a result. Runs are only recorded when a
// pass actually did work (the idle guards exit before locking). Feeds Horst's
// memory:consolidated sense; failures surface separately via cron:failed.
const runObservers = [];
function onRun(fn) {
  runObservers.push(fn);
  return () => { const i = runObservers.indexOf(fn); if (i >= 0) runObservers.splice(i, 1); };
}

// ---------------------------------------------------------------------------
// ONE-TIME contact-fact cleanup (2026-08). Contact facts used to be minted
// from single INBOUND mails — "User corresponds by email with X" for any
// clean-classified sender — which is factually wrong (receiving one mail is
// not corresponding) and fed straight back into classification as a whitelist
// for misclassified spam senders. Mining is now sent-mail-only (horst-triage
// contactMemoryItems); this pass purges what the old rule minted for addresses
// the user never actually wrote to. Facts are soft-forgotten with ledger rows
// (G10, reversible); wrong raw observations are hard-deleted so they can never
// feed a future consolidation. Genuine correspondents re-mint from real sent
// mail going forward — losing one temporarily is the accepted trade
// (owner-approved 2026-08-25).
// ---------------------------------------------------------------------------
const CONTACT_CLEANUP_FLAG = 'contact_cleanup_v1';
let _contactCleanupDone = false;

function refAddresses(sourceRef) {
  // memory_sources.source_ref for email-mined rows carries `from` ("Name" <a@x>).
  try {
    const ref = typeof sourceRef === 'string' ? JSON.parse(sourceRef) : (sourceRef || {});
    if (ref.type !== 'email' || !ref.from) return null;
    const m = String(ref.from).match(/<([^>]+)>/);
    return (m ? m[1] : String(ref.from)).trim().toLowerCase();
  } catch { return null; }
}

async function runContactCleanup(c) {
  if (_contactCleanupDone) return;
  if (await mem.metaGet(c, CONTACT_CLEANUP_FLAG)) { _contactCleanupDone = true; return; }
  const engine = require('./email-engine');
  if (!engine.isReady?.()) return; // mail store not up yet — retry next tick
  const started = Date.now();
  const sentTo = await engine.sentRecipientAddresses();
  const wrote = (addr) => sentTo.has(String(addr || '').trim().toLowerCase());

  // 1) Raw contact observations: keep only addresses the user has written to.
  //    ALL origins — my-dashboard's legacy in-app miner (pre-absorption) minted
  //    the same shape, and shared-scope recall surfaces its rows to Horst too.
  const obs = await c.query(
    `SELECT id, natural_key FROM memory_observations
      WHERE natural_key LIKE 'contact:%'`,
  );
  const obsDelete = obs
    .filter((o) => !wrote(String(o.natural_key).slice('contact:'.length)))
    .map((o) => o.id);
  for (let i = 0; i < obsDelete.length; i += 200) {
    const chunk = obsDelete.slice(i, i + 200);
    await c.query(`DELETE FROM memory_observations WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk);
  }

  // 2) "corresponds by email with" facts: forget unless SOME email source
  //    shows the user actually wrote to that address.
  const facts = await c.query(
    `SELECT id FROM memory_facts
      WHERE predicate = 'corresponds by email with' AND valid_to IS NULL`,
  );
  let forgotten = 0;
  const forgetFact = async (id) => {
    await c.query('UPDATE memory_facts SET valid_to = NOW() WHERE id = ? AND valid_to IS NULL', [id]);
    await appendSource(c, 'fact', id, 'forget', 'horst',
      { type: 'maintenance', job: 'contact-cleanup', reason: 'minted from inbound-only mail — user never wrote to this address' }, 1.0, null);
    forgotten++;
  };
  for (const f of facts) {
    const sources = await c.query(
      `SELECT source_ref FROM memory_sources WHERE memory_kind = 'fact' AND memory_id = ?`, [f.id],
    );
    const addrs = sources.map((s) => refAddresses(s.source_ref)).filter(Boolean);
    if (!addrs.some((a) => wrote(a))) await forgetFact(f.id);
  }

  // 3) "email address" facts: forget only the self-attested ones — the value
  //    is the sender address of the fact's own source mail (the "Brooke Allen
  //    email address brookeallen@…" pattern), and the user never wrote to it.
  //    Addresses mined from real correspondence content are untouched.
  const addrFacts = await c.query(
    `SELECT id, value FROM memory_facts
      WHERE predicate = 'email address' AND valid_to IS NULL`,
  );
  for (const f of addrFacts) {
    const value = String(f.value || '').trim().toLowerCase();
    if (!value.includes('@') || wrote(value)) continue;
    const sources = await c.query(
      `SELECT source_ref FROM memory_sources WHERE memory_kind = 'fact' AND memory_id = ?`, [f.id],
    );
    const addrs = sources.map((s) => refAddresses(s.source_ref)).filter(Boolean);
    if (addrs.length && addrs.every((a) => a === value)) await forgetFact(f.id);
  }

  await mem.metaSet(c, CONTACT_CLEANUP_FLAG, Date.now());
  await recordRun(c, 'contact-cleanup', started, {
    scanned: obs.length + facts.length + addrFacts.length,
    affected: obsDelete.length + forgotten,
  });
  _contactCleanupDone = true;
  console.log(`[memory] contact cleanup: ${obsDelete.length}/${obs.length} observations deleted, ${forgotten} facts forgotten (${sentTo.size} written-to addresses kept)`);
}

// ---------------------------------------------------------------------------
// CONSOLIDATOR — observations -> facts/entities. AI extract + cosine-cluster + reconcile.
// ---------------------------------------------------------------------------
async function runConsolidate() {
  if (!enabled() || !mem.isReady()) return { skipped: true };
  const c = await mem.conn();
  try {
    // One-time cleanup runs ahead of the E0 guard (it must fire even when
    // nothing is unconsolidated); after the flag is set this is a no-op.
    await runContactCleanup(c).catch((err) => console.warn('[memory] contact cleanup failed:', err.message));

    // E0 guard: nothing unconsolidated -> exit silently.
    const [g] = await c.query('SELECT EXISTS(SELECT 1 FROM memory_observations WHERE consolidated_at IS NULL LIMIT 1) AS has');
    if (!Number(g.has)) return { skipped: 'idle' };

    return await withLock(c, 'consolidate', async () => {
      const started = Date.now();
      const batch = platformSettings.get('memoryConsolidateBatch') || 200;
      const obs = await c.query(
        `SELECT id, content, app_origin, scope, source_ref, event_time
         FROM memory_observations WHERE consolidated_at IS NULL ORDER BY created_at ASC LIMIT ?`,
        [batch],
      );
      if (!obs.length) return { skipped: 'idle' };

      let affected = 0;
      const appBridge = require('./app-bridge');

      // Phase 1 — cheap idempotency guards, per observation. The SAME fact
      // must never burn an extraction session twice. Skip (mark consolidated,
      // reinforce) when:
      //   a) an identical observation content was already consolidated, or
      //   b) a live fact is embedding-near AND carries the same numbers
      //      (digit equality keeps value updates — "rent 1,200" — flowing
      //      to the extractor so supersede still works).
      // Both within the observation's own app and scope — matching across
      // them let one app's private fact swallow another app's observation.
      const needExtract = [];
      for (const o of obs) {
        try {
          const dup = await c.query(
            `SELECT id FROM memory_observations
              WHERE content = ? AND consolidated_at IS NOT NULL AND id <> ? AND app_origin = ? AND scope = ? LIMIT 1`,
            [o.content, o.id, o.app_origin, o.scope],
          );
          let known = dup.length > 0;
          if (!known) {
            const [ovec] = await mem.embed(o.content);
            const near = await c.query(
              `SELECT id, content, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS dist
               FROM memory_facts WHERE valid_to IS NULL AND app_origin = ? AND scope = ? ORDER BY dist ASC LIMIT 1`,
              [mem.vecText(ovec), o.app_origin, o.scope],
            );
            if (near.length && Number(near[0].dist) < NEAR_DUPE_MAX_DIST && sameNumbers(near[0].content, o.content)) {
              known = true;
              const tier = durableSource(o.source_ref) ? ", tier = 'long'" : '';
              await c.query(`UPDATE memory_facts SET hit_count = hit_count + 1, last_seen = NOW()${tier} WHERE id = ?`, [near[0].id]);
            }
          }
          if (known) {
            await c.query('UPDATE memory_observations SET consolidated_at = NOW() WHERE id = ?', [o.id]);
            affected++;
            continue;
          }
        } catch { /* guard is best-effort — fall through to extraction */ }
        needExtract.push(o);
      }

      // Phase 2 — grouped extraction: several observations per AI call.
      // Sizing (user mandate: stay well under 10% of haiku's context): at most
      // GROUP_MAX_ITEMS observations and GROUP_MAX_CHARS of content per call —
      // ~3-4k tokens of prompt, small enough that extraction quality per
      // observation doesn't degrade, ~15x fewer sessions than one-per-obs.
      const GROUP_MAX_ITEMS = 15;
      const GROUP_MAX_CHARS = 12000;
      const OBS_MAX_CHARS = 4000; // a single huge observation is truncated in-prompt
      const groups = [];
      let cur = [], curChars = 0;
      for (const o of needExtract) {
        const len = Math.min(String(o.content).length, OBS_MAX_CHARS);
        if (cur.length && (cur.length >= GROUP_MAX_ITEMS || curChars + len > GROUP_MAX_CHARS)) {
          groups.push(cur); cur = []; curChars = 0;
        }
        cur.push(o); curChars += len;
      }
      if (cur.length) groups.push(cur);

      for (const group of groups) {
        // index → {facts, entities}; missing index after the call = degrade to
        // a raw fact so nothing is lost.
        const results = new Map();
        try {
          const numbered = group
            .map((o, i) => `[${i}] ${String(o.content).slice(0, OBS_MAX_CHARS)}`)
            .join('\n---\n');
          const out = await appBridge.aiPrompt('platform', _appsDir, {
            // memoryAiModel, NOT directModel: on a heavyweight chat model a
            // big backlog becomes hundreds of expensive calls (the 2026-08
            // backfill burn).
            model: platformSettings.memoryAiModel(),
            expectJson: true,
            // NO tools: with the full sidecar attached, the extractor model was
            // calling apps' remember tools and re-storing what it extracted —
            // each echo became a new observation and another AI session (the
            // 2026-08 "Chesa Quadrellas" loop). Extraction needs zero tools.
            allowedTools: [],
            systemPrompt:
              'You extract structured memory from a numbered list of observations. Return ONLY JSON: '
              + '{"observations":[{"i":<number>,"facts":[{"subject","predicate","value","importance":0..1,"confidence":0..1,"durable":bool,"expires":"YYYY-MM-DD"|null}],'
              + '"entities":[{"name","type"}]}]} — exactly one entry per input observation, keyed by its [i]. '
              + 'subject = the entity the fact is about; predicate = the attribute; value = the content. '
              + 'Decompose compound statements into multiple facts. Empty arrays when an observation contains nothing factual. '
              // Durable = the long tier, never forgotten (see durableSource).
              + 'durable = true for records the user must be able to find years later: contracts, bills, invoices, payments, '
              + 'obligations, legal/financial/medical/tax records, warranties, project issues and decisions. '
              + 'expires = the date a NON-durable fact stops being true (a trip, an appointment, a temporary state), else null. '
              // Canonical-English store: observations arrive in any language
              // (DE+EN here); one fact language keeps dedupe, contradiction
              // comparison and FULLTEXT consistent. Vectors are multilingual,
              // so recall in any language still finds these.
              + 'Write facts in ENGLISH regardless of the observation\'s language; keep proper nouns, amounts, and quoted phrases verbatim.',
            message: `Observations:\n${numbered}`,
          });
          for (const entry of (Array.isArray(out.json?.observations) ? out.json.observations : [])) {
            const i = Number(entry?.i);
            if (!Number.isInteger(i) || i < 0 || i >= group.length) continue;
            results.set(i, {
              facts: Array.isArray(entry.facts) ? entry.facts : [],
              entities: Array.isArray(entry.entities) ? entry.entities : [],
            });
          }
        } catch { /* whole group degrades to raw facts below */ }

        for (let i = 0; i < group.length; i++) {
          const o = group[i];
          const r = results.get(i) || {
            facts: [{ subject: o.app_origin, predicate: 'note', value: o.content, importance: 0.25, confidence: 0.3, raw: true }],
            entities: [],
          };
          await reconcileAndPersist(c, o, r.facts, r.entities);
          await c.query('UPDATE memory_observations SET consolidated_at = NOW() WHERE id = ?', [o.id]);
          affected++;
        }
      }

      // churn counter feeds the compaction idle-gate.
      await mem.metaBump(c, 'churn_since_compact', affected);

      const [b] = await c.query('SELECT COUNT(*) AS n FROM memory_observations WHERE consolidated_at IS NULL');
      const backlog = Number(b.n);
      await recordRun(c, 'consolidate', started, { scanned: obs.length, affected, backlog });
      console.log(`  Memory: consolidated ${affected} observation(s), ${backlog} pending`);
      return { ok: true, affected, backlog };
    });
  } catch (err) {
    console.error('  Memory: consolidate failed:', err.message);
    return { ok: false, error: err.message };
  } finally {
    c.release();
  }
}

// "YYYY-MM-DD" → end of that day; anything else → null.
function parseExpiry(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T23:59:59`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function insertFact(c, obs, { entityId, subject, predicate, value, content, tier, vec, importance, expiresAt }) {
  const ins = await c.query(
    `INSERT INTO memory_facts (entity_id, subject, predicate, value, content, app_origin, scope, tier, embedding, embed_v, importance, event_time, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, VEC_FromText(?), ?, ?, ?, ?)`,
    [entityId, subject, predicate, value, content, obs.app_origin, obs.scope, tier, mem.vecText(vec), mem.EMBED_V, importance, obs.event_time, expiresAt],
  );
  return Number(ins.insertId);
}

// For each candidate fact: embed, reconcile against the live rows for the same
// subject+predicate (reinforce / supersede / store alongside), persist + append
// provenance — all in one transaction per observation.
//   - the same value anywhere among the live rows → reinforce it;
//   - a durable fact is a RECORD: a new value is stored alongside (September's
//     bill does not supersede August's), no conflict question;
//   - a long-tier current row is never auto-superseded: both stand and the
//     owner is asked (G10) — the long tier is never lost to an extraction;
//   - otherwise a confident new value supersedes, a doubtful one coexists.
async function reconcileAndPersist(c, obs, facts, entitiesList) {
  const source = obs.source_ref || { type: 'app', app: obs.app_origin };
  const obsDurable = durableSource(obs.source_ref);
  await c.beginTransaction();
  try {
    // Entities first (so facts can link).
    const entityIds = {};
    for (const e of entitiesList || []) {
      if (!e.name) continue;
      const [evec] = await mem.embed(`${e.name} ${e.type || ''}`.trim());
      const existing = await c.query(
        `SELECT id, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS dist
         FROM memory_entities WHERE app_origin = ? OR scope IN ('shared','global')
         ORDER BY dist ASC LIMIT 1`,
        [mem.vecText(evec), obs.app_origin],
      ).catch(() => []);
      if (existing.length && Number(existing[0].dist) < ENTITY_MATCH_MAX_DIST) {
        entityIds[e.name.toLowerCase()] = Number(existing[0].id);
        await c.query('UPDATE memory_entities SET last_seen = NOW(), importance = LEAST(1.0, importance + 0.05) WHERE id = ?', [existing[0].id]);
      } else {
        const r = await c.query(
          `INSERT INTO memory_entities (name, type, app_origin, scope, embedding, embed_v, importance)
           VALUES (?, ?, ?, ?, VEC_FromText(?), ?, 0.5)`,
          [e.name, e.type || null, obs.app_origin, obs.scope, mem.vecText(evec), mem.EMBED_V],
        );
        entityIds[e.name.toLowerCase()] = Number(r.insertId);
      }
    }

    for (const f of facts) {
      if (!f.subject || !f.value) continue;
      const predicate = f.predicate || 'fact';
      const value = String(f.value).trim();
      const durable = obsDurable || f.durable === true;
      // Durable facts never expire (their dates live in the value); a fact
      // already past its expiry is not worth storing.
      const expiresAt = durable ? null : parseExpiry(f.expires);
      if (expiresAt && expiresAt.getTime() < Date.now()) continue;
      const content = `${f.subject} ${predicate} ${value}`.trim();
      const [fvec] = await mem.embed(content);
      const importance = Math.max(0, Math.min(1, Number(f.importance) || 0.5));
      const confidence = Math.max(0, Math.min(1, Number(f.confidence) ?? 0.7));
      const fact = {
        entityId: entityIds[String(f.subject).toLowerCase()] || null,
        subject: f.subject, predicate, value, content, vec: fvec,
        tier: durable ? 'long' : 'short', importance, expiresAt,
      };

      const same = await c.query(
        `SELECT id FROM memory_facts
         WHERE subject = ? AND predicate = ? AND value = ? AND valid_to IS NULL AND app_origin = ?
         LIMIT 1 FOR UPDATE`,
        [f.subject, predicate, value, obs.app_origin],
      );
      if (same.length) {
        const id = Number(same[0].id);
        await c.query(
          `UPDATE memory_facts SET hit_count = hit_count + 1, last_seen = NOW(), importance = LEAST(1.0, importance + 0.03)${durable ? ", tier = 'long'" : ''} WHERE id = ?`,
          [id],
        );
        await appendSource(c, 'fact', id, 'reinforce', obs.app_origin, source, confidence, null);
        continue;
      }

      const cur = await c.query(
        `SELECT id, value, tier FROM memory_facts
         WHERE subject = ? AND predicate = ? AND valid_to IS NULL AND app_origin = ?
         ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        [f.subject, predicate, obs.app_origin],
      );
      if (!cur.length || durable) {
        const id = await insertFact(c, obs, fact);
        await appendSource(c, 'fact', id, 'insert', obs.app_origin, source, confidence, null);
      } else if (cur[0].tier !== 'long' && confidence >= 0.5) {
        // New value, confident -> supersede (history stays walkable via the ledger).
        const row = cur[0];
        await c.query('UPDATE memory_facts SET valid_to = NOW() WHERE id = ?', [row.id]);
        const id = await insertFact(c, obs, fact);
        await c.query('UPDATE memory_facts SET superseded_by = ? WHERE id = ?', [id, row.id]);
        const prevSrc = await c.query('SELECT id FROM memory_sources WHERE memory_kind=\'fact\' AND memory_id=? ORDER BY recorded_at DESC LIMIT 1', [row.id]);
        await appendSource(c, 'fact', id, 'supersede', obs.app_origin, source, confidence, prevSrc.length ? Number(prevSrc[0].id) : null);
      } else {
        // A doubtful value, or one contradicting a long-tier fact: store it
        // alongside and never destroy the current row — exactly the G10 case,
        // raise the question and let the owner resolve it.
        noteConflict(f.subject, predicate, cur[0].value, value, 'coexisting');
        const id = await insertFact(c, obs, { ...fact, importance: importance * 0.7 });
        await appendSource(c, 'fact', id, 'insert', obs.app_origin, source, confidence, null);
      }
    }
    await c.commit();
    emitConflicts();
  } catch (err) {
    try { await c.rollback(); } catch {}
    _runConflicts = new Map();
    throw err;
  }
}

async function appendSource(c, kind, memoryId, action, appOrigin, sourceRef, confidence, supersedesId) {
  await c.query(
    `INSERT INTO memory_sources (memory_id, memory_kind, action, app_origin, source_ref, confidence, supersedes_source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [memoryId, kind, action, appOrigin, JSON.stringify(sourceRef), confidence, supersedesId],
  );
}

// ---------------------------------------------------------------------------
// RETENTION — expire time-bound facts, promote short->long, prune stale
// low-value ones. Idle-gated. The long tier is never touched. Importance is
// what the extractor (or the owner) assigned and is never mutated by time: a
// fact is forgotten because it was minor from the start AND nothing ever
// brought it up again, not because nobody happened to search for it.
// ---------------------------------------------------------------------------
const DURABLE_REPAIR_FLAG = 'durable_v1';
let _durableRepairDone = false;

// A memory_sources row whose provenance makes its fact durable (see
// durableSource). JSON_UNQUOTE first: rows written from a string source_ref
// hold a JSON string literal; on an object it is the identity.
const DURABLE_SOURCE_SQL = `EXISTS (SELECT 1 FROM memory_sources s
  WHERE s.memory_kind = 'fact' AND s.memory_id = f.id
    AND (JSON_EXTRACT(JSON_UNQUOTE(s.source_ref), '$.artifactId') IS NOT NULL
      OR JSON_UNQUOTE(JSON_EXTRACT(JSON_UNQUOTE(s.source_ref), '$.type')) = 'horst-chat'))`;

// ONE-TIME repair (2026-09) for the retired nightly decay, which subtracted the
// cumulative days-since-seen every night (a 0.5 fact reached the floor in ~8
// days) and soft-pruned whatever no recall had touched:
//   a) no live fact is lost to the rule change — importances the old decay
//      crushed are lifted to the floor;
//   b) facts from filed documents or from the owner join the long tier;
//   c) those same facts, if the old decay pruned them, are restored. Pruning
//      wrote no ledger row, so "pruned" = retired, not superseded or folded,
//      no 'forget' row (owner forgets and contact-cleanup write one), and no
//      live fact already carrying the same value.
// Email-mined records the old decay pruned cannot be told apart mechanically
// and stay retired; their mails and attachments remain in the mail store.
async function runDurableRepair(c, floor) {
  if (_durableRepairDone) return;
  if (await mem.metaGet(c, DURABLE_REPAIR_FLAG)) { _durableRepairDone = true; return; }
  const started = Date.now();
  const lifted = await c.query(
    "UPDATE memory_facts SET importance = ? WHERE valid_to IS NULL AND tier = 'short' AND importance < ?",
    [floor, floor],
  );
  const promoted = await c.query(
    `UPDATE memory_facts f SET f.tier = 'long' WHERE f.valid_to IS NULL AND f.tier = 'short' AND ${DURABLE_SOURCE_SQL}`,
  );
  const pruned = await c.query(
    `SELECT f.id, f.app_origin FROM memory_facts f
      WHERE f.valid_to IS NOT NULL AND f.superseded_by IS NULL AND f.tier = 'short' AND f.hit_count = 0
        AND ${DURABLE_SOURCE_SQL}
        AND NOT EXISTS (SELECT 1 FROM memory_sources x WHERE x.memory_kind = 'fact' AND x.memory_id = f.id AND x.action = 'forget')
        AND NOT EXISTS (SELECT 1 FROM memory_facts n WHERE n.valid_to IS NULL AND n.subject = f.subject
                          AND n.predicate = f.predicate AND n.value = f.value AND n.app_origin = f.app_origin)`,
  );
  for (const f of pruned) {
    await c.query("UPDATE memory_facts SET valid_to = NULL, tier = 'long' WHERE id = ?", [f.id]);
    await appendSource(c, 'fact', Number(f.id), 'reinforce', f.app_origin,
      { type: 'maintenance', job: 'durable-restore', reason: 'pruned by the retired decay; durable provenance' }, 1.0, null);
  }
  await mem.metaSet(c, DURABLE_REPAIR_FLAG, Date.now());
  const affected = Number(lifted.affectedRows) + Number(promoted.affectedRows) + pruned.length;
  await recordRun(c, 'durable-repair', started, { affected });
  _durableRepairDone = true;
  console.log(`[memory] durable repair: ${Number(lifted.affectedRows)} importances lifted, ${Number(promoted.affectedRows)} facts promoted, ${pruned.length} pruned facts restored`);
}

async function runDecay() {
  if (!enabled() || !mem.isReady()) return { skipped: true };
  const c = await mem.conn();
  try {
    const ttl = platformSettings.get('memoryShortTtlDays') || 14;
    const promoteHits = platformSettings.get('memoryPromoteHitCount') || 3;
    const floor = platformSettings.get('memoryImportanceFloor') ?? 0.3;

    // One-time repair runs ahead of the E0 guard; after the flag it is a no-op.
    await runDurableRepair(c, floor).catch((err) => console.warn('[memory] durable repair failed:', err.message));

    // Promotion skips time-bound facts: what stops being true is not long-term.
    const promotable = "tier='short' AND expires_at IS NULL AND (hit_count >= ? OR importance >= 0.8)";
    const expired = "tier='short' AND expires_at <= NOW()";
    const prunable = "tier='short' AND hit_count = 0 AND importance < ? AND last_seen < (NOW() - INTERVAL ? DAY)";

    // E0 guard: anything to expire, promote or prune? else skip.
    const [g] = await c.query(
      `SELECT EXISTS(
         SELECT 1 FROM memory_facts WHERE valid_to IS NULL AND ((${promotable}) OR (${expired}) OR (${prunable}))
         LIMIT 1) AS has`,
      [promoteHits, floor, ttl],
    );
    if (!Number(g.has)) return { skipped: 'idle' };

    return await withLock(c, 'decay', async () => {
      const started = Date.now();
      // Expire: soft-retire with a ledger row, like every other forgetting.
      const gone = await c.query(`SELECT id, app_origin FROM memory_facts WHERE valid_to IS NULL AND ${expired}`);
      for (const f of gone) {
        await c.query('UPDATE memory_facts SET valid_to = NOW() WHERE id = ? AND valid_to IS NULL', [f.id]);
        await appendSource(c, 'fact', Number(f.id), 'forget', f.app_origin, { type: 'maintenance', job: 'expire' }, 1.0, null);
      }
      const promo = await c.query(`UPDATE memory_facts SET tier='long' WHERE valid_to IS NULL AND ${promotable}`, [promoteHits]);
      // Prune: soft (valid_to) — the row and its ledger survive.
      const prune = await c.query(`UPDATE memory_facts SET valid_to = NOW() WHERE valid_to IS NULL AND ${prunable}`, [floor, ttl]);
      const affected = gone.length + Number(promo.affectedRows) + Number(prune.affectedRows);
      await recordRun(c, 'decay', started, { affected });
      console.log(`  Memory: retention — expired ${gone.length}, promoted ${Number(promo.affectedRows)}, pruned ${Number(prune.affectedRows)} fact(s)`);
      return { ok: true, affected };
    });
  } catch (err) {
    console.error('  Memory: retention failed:', err.message);
    return { ok: false, error: err.message };
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// COMPACTION — vector-driven near-duplicate merge. Churn-gated.
// ---------------------------------------------------------------------------
async function runCompact() {
  if (!enabled() || !mem.isReady()) return { skipped: true };
  const c = await mem.conn();
  try {
    const threshold = platformSettings.get('memoryCompactChurnThreshold') || 50;
    const churn = Number(await mem.metaGet(c, 'churn_since_compact', 0));
    // E0 guard: not enough new facts since last compaction -> skip.
    if (churn < threshold) return { skipped: 'idle' };

    return await withLock(c, 'compact', async () => {
      const started = Date.now();
      const maxDist = 1 - (platformSettings.get('memoryDedupeCosine') || platformSettings.DEFAULTS.memoryDedupeCosine);
      // Every near-duplicate pair in one pass. Same subject, predicate, app and
      // scope only — facts never merge across apps or scopes — so the join
      // stays inside idx_subj_pred groups. Short tier only: the long tier is
      // never folded away, and a short fact near a long one is usually the
      // contradiction stored alongside it, awaiting the owner's answer.
      const pairs = await c.query(
        `SELECT a.id AS keep_id, a.value AS keep_value, b.id AS dup_id, b.value AS dup_value, b.hit_count AS dup_hits,
                VEC_DISTANCE_COSINE(a.embedding, b.embedding) AS dist
           FROM memory_facts a
           JOIN memory_facts b ON b.subject = a.subject AND b.predicate = a.predicate
                              AND b.app_origin = a.app_origin AND b.scope = a.scope AND b.id > a.id
          WHERE a.valid_to IS NULL AND b.valid_to IS NULL AND a.tier = 'short' AND b.tier = 'short'
            AND VEC_DISTANCE_COSINE(a.embedding, b.embedding) <= ?
          ORDER BY a.id ASC, dist ASC`,
        [maxDist],
      );
      let merged = 0;
      const folded = new Set();
      for (const p of pairs) {
        const keep = Number(p.keep_id), dup = Number(p.dup_id);
        if (folded.has(keep) || folded.has(dup)) continue;
        if (!sameNumbers(p.keep_value, p.dup_value)) continue; // different amounts/dates = different records
        // Fold dup into the older row: sum hits, supersede dup, record merge provenance.
        await c.query('UPDATE memory_facts SET hit_count = hit_count + ? WHERE id = ?', [Number(p.dup_hits) || 0, keep]);
        await c.query('UPDATE memory_facts SET valid_to = NOW(), superseded_by = ? WHERE id = ?', [keep, dup]);
        await appendSource(c, 'fact', keep, 'merge', 'platform', { type: 'compaction', mergedFrom: dup }, 1.0, null);
        folded.add(dup);
        merged++;
      }
      await mem.metaSet(c, 'churn_since_compact', 0);
      // Index hygiene after large churn.
      if (merged > 0) await c.query('OPTIMIZE TABLE memory_facts').catch(() => {});
      await recordRun(c, 'compact', started, { scanned: pairs.length, affected: merged });
      console.log(`  Memory: compaction merged ${merged} duplicate fact(s)`);
      return { ok: true, merged };
    });
  } catch (err) {
    console.error('  Memory: compaction failed:', err.message);
    return { ok: false, error: err.message };
  } finally {
    c.release();
  }
}

// ---------------------------------------------------------------------------
// LEDGER ARCHIVAL — roll off dead-lineage source rows. Idle-gated.
// ---------------------------------------------------------------------------
async function runArchive() {
  if (!enabled() || !mem.isReady()) return { skipped: true };
  const c = await mem.conn();
  try {
    const days = platformSettings.get('memoryLedgerRetentionDays') || 365;
    // E0 guard: any old source row tied to a no-longer-current fact?
    const [g] = await c.query(
      `SELECT EXISTS(
         SELECT 1 FROM memory_sources s
         WHERE s.memory_kind='fact' AND s.recorded_at < (NOW() - INTERVAL ? DAY)
           AND EXISTS(SELECT 1 FROM memory_facts f WHERE f.id = s.memory_id AND f.valid_to IS NOT NULL)
         LIMIT 1) AS has`,
      [days],
    );
    if (!Number(g.has)) return { skipped: 'idle' };

    return await withLock(c, 'archive', async () => {
      const started = Date.now();
      await c.beginTransaction();
      const moved = await c.query(
        `INSERT INTO memory_sources_archive
         SELECT s.* FROM memory_sources s
         WHERE s.memory_kind='fact' AND s.recorded_at < (NOW() - INTERVAL ? DAY)
           AND EXISTS(SELECT 1 FROM memory_facts f WHERE f.id = s.memory_id AND f.valid_to IS NOT NULL)`,
        [days],
      );
      await c.query(
        `DELETE s FROM memory_sources s
         WHERE s.memory_kind='fact' AND s.recorded_at < (NOW() - INTERVAL ? DAY)
           AND EXISTS(SELECT 1 FROM memory_facts f WHERE f.id = s.memory_id AND f.valid_to IS NOT NULL)`,
        [days],
      );
      await c.commit();
      const affected = Number(moved.affectedRows);
      await recordRun(c, 'archive', started, { affected });
      console.log(`  Memory: archived ${affected} dead-lineage source row(s)`);
      return { ok: true, affected };
    });
  } catch (err) {
    try { (await mem.conn()).release(); } catch {}
    console.error('  Memory: archive failed:', err.message);
    return { ok: false, error: err.message };
  } finally {
    c.release();
  }
}

// Manual "Run maintenance now" — forces all passes past their cadence (still idle-gated).
async function runAll() {
  const r1 = await runConsolidate();
  const r2 = await runDecay();
  const r3 = await runCompact();
  const r4 = await runArchive();
  return { consolidate: r1, decay: r2, compact: r3, archive: r4 };
}

module.exports = { init, runConsolidate, runDecay, runCompact, runArchive, runAll, onRun };
