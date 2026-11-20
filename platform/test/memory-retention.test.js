// Memory retention: what the store reinforces, keeps and forgets.
//
// Why it needs a test: every rule here fails silently. A recall that
// reinforces promotes whatever sits near the mail traffic; a prune or fold that
// reaches the long tier loses a contract or a bill from recall with nothing
// thrown; a duplicate guard that crosses apps swallows another app's write.
// The owner's standing requirement is that durable records (contracts, bills,
// payments, project decisions) never leave recall.
//
// appDb.getPool() is stubbed with a recording double that answers by SQL shape,
// and embeddings/the extractor are stubbed — what is under test is which
// statements are issued with which predicates. The same flows ran end to end
// against a scratch MariaDB 11.8 with real e5 vectors when this was written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appDb = require('../src/apps/app-db');
const embeddings = require('../src/apps/embeddings');
const appBridge = require('../src/apps/app-bridge');
const mem = require('../src/apps/memory-service');
const maint = require('../src/apps/memory-maintenance');

const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-memret-'));
embeddings.embed = async (input) => (Array.isArray(input) ? input.map(() => new Array(384).fill(0)) : new Array(384).fill(0));

// answer(sql, params) → rows | result, or undefined for [].
async function withDb(answer, fn) {
  const prevPool = appDb.getPool;
  const sql = [];
  appDb.getPool = () => ({
    getConnection: async () => ({
      query: async (q, p = []) => {
        const s = String(q).replace(/\s+/g, ' ').trim();
        if (/^USE /.test(s)) return [];
        sql.push({ q: s, p });
        const meta = /^SELECT v FROM memory_meta WHERE k = \?/.test(s);
        if (meta) return answer.meta && p[0] in answer.meta ? [{ v: answer.meta[p[0]] }] : [];
        const r = answer(s, p);
        return r === undefined ? (/^(INSERT|UPDATE|DELETE)/.test(s) ? { affectedRows: 0, insertId: 0 } : []) : r;
      },
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
      release() {},
    }),
  });
  try {
    await mem.init(appsDir);
    await new Promise((r) => setImmediate(r)); // let the embedding catch-up settle
    sql.length = 0;
    await fn(sql);
  } finally {
    appDb.getPool = prevPool;
  }
}
maint.init(appsDir);

const factRow = (id, tier, extra = {}) => ({ id, subject: 'S', predicate: 'p', value: `v${id}`, content: `S p v${id}`, tier, importance: 0.5, hit_count: 0, app_origin: 'horst', ...extra });

test('recall reinforces only a deliberate lookup, hides expired facts, and has no pending-age window', async () => {
  const answer = (s) => {
    if (/VEC_DISTANCE_COSINE/.test(s) && /FROM memory_facts/.test(s)) return [factRow(1, 'short'), factRow(2, 'long')];
    if (/MATCH\(content\)/.test(s) && /FROM memory_facts/.test(s)) return [];
  };
  await withDb(answer, async (sql) => {
    const res = await mem.recall({ query: 'x', scope_caller: 'horst' });
    assert.equal(res.hits[0].id, 2, 'a long-tier fact outranks a short one one rank above it');
    assert.ok(!sql.some((x) => /^UPDATE memory_facts/.test(x.q)), 'plain recall writes nothing');
    const reads = sql.filter((x) => /FROM memory_facts/.test(x.q));
    assert.ok(reads.every((x) => /expires_at IS NULL OR expires_at > NOW\(\)/.test(x.q)), 'both fact paths hide expired facts');
    const pending = sql.find((x) => /FROM memory_observations/.test(x.q));
    assert.ok(pending && !/INTERVAL/.test(pending.q), 'pending observations have no age window');

    sql.length = 0;
    await mem.recall({ query: 'x', scope_caller: 'horst', reinforce: true });
    assert.ok(sql.some((x) => /^UPDATE memory_facts SET hit_count = hit_count \+ 1/.test(x.q)), 'reinforce:true counts as use');
  });
});

test('history of a relation is empty (the relations table is gone)', async () => {
  await withDb(() => { throw new Error('no query expected'); }, async () => {
    const r = await mem.history({ memory_id: 3, memory_kind: 'relation', scope_caller: 'horst' });
    assert.deepEqual(r.sources, []);
  });
});

// One observation through the consolidator. `cur` is the live row already
// holding the same subject+predicate.
async function consolidate({ source, fact, cur }) {
  const prevAi = appBridge.aiPrompt;
  appBridge.aiPrompt = async () => ({ json: { observations: [{ i: 0, facts: [fact], entities: [] }] } });
  const answer = (s) => {
    if (/^SELECT EXISTS\(SELECT 1 FROM memory_observations/.test(s)) return [{ has: 1 }];
    if (/^SELECT id, content, app_origin, scope, source_ref, event_time FROM memory_observations/.test(s)) {
      return [{ id: 7, content: 'obs', app_origin: 'horst', scope: 'shared', source_ref: source, event_time: null }];
    }
    if (/^SELECT id, value, tier FROM memory_facts/.test(s)) return cur ? [cur] : [];
    if (/^INSERT INTO memory_facts/.test(s)) return { affectedRows: 1, insertId: 42 };
    if (/^SELECT COUNT\(\*\) AS n FROM memory_observations/.test(s)) return [{ n: 0 }];
  };
  answer.meta = { contact_cleanup_v1: '1' };
  let log;
  try {
    await withDb(answer, async (sql) => { await maint.runConsolidate(); log = sql; });
  } finally {
    appBridge.aiPrompt = prevAi;
  }
  return log;
}

test('duplicate guards stay inside the observation\'s app and scope', async () => {
  const sql = await consolidate({ source: { type: 'email' }, fact: { subject: 'S', predicate: 'p', value: 'v', confidence: 0.9 } });
  const exact = sql.find((x) => /^SELECT id FROM memory_observations WHERE content = \?/.test(x.q));
  const near = sql.find((x) => /^SELECT id, content, VEC_DISTANCE_COSINE/.test(x.q));
  assert.match(exact.q, /app_origin = \? AND scope = \?/);
  assert.match(near.q, /app_origin = \? AND scope = \?/);
  assert.deepEqual(near.p.slice(1), ['horst', 'shared']);
});

test('a durable record is stored long-tier alongside, never superseding', async () => {
  // Mail attachments arrive as type:'email' carrying an artifactId.
  const sql = await consolidate({
    source: { type: 'email', uid: 3, artifactId: 11 },
    fact: { subject: 'Swisscom', predicate: 'invoice', value: 'October CHF 92', confidence: 0.9 },
    cur: { id: 9, value: 'September CHF 89', tier: 'long' },
  });
  const ins = sql.find((x) => /^INSERT INTO memory_facts/.test(x.q));
  assert.equal(ins.p[7], 'long');
  assert.ok(!sql.some((x) => /^UPDATE memory_facts SET valid_to = NOW\(\) WHERE id = \?/.test(x.q)), 'the earlier record stays live');
});

test('the extractor\'s durable flag and owner-stated facts both land long-tier', async () => {
  for (const [source, fact] of [
    [{ type: 'email' }, { subject: 'A', predicate: 'contract', value: 'signed', durable: true }],
    [{ type: 'horst-chat', conversationId: 'c' }, { subject: 'Project', predicate: 'decision', value: 'go' }],
  ]) {
    const sql = await consolidate({ source, fact });
    assert.equal(sql.find((x) => /^INSERT INTO memory_facts/.test(x.q)).p[7], 'long');
  }
});

test('expiry: a future date is stored, a past one is not stored, a durable fact never expires', async () => {
  const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  let sql = await consolidate({ source: { type: 'email' }, fact: { subject: 'U', predicate: 'location', value: 'Zurich', expires: future } });
  assert.ok(sql.find((x) => /^INSERT INTO memory_facts/.test(x.q)).p[12] instanceof Date);
  sql = await consolidate({ source: { type: 'email' }, fact: { subject: 'U', predicate: 'appt', value: 'dentist', expires: '2020-01-01' } });
  assert.ok(!sql.some((x) => /^INSERT INTO memory_facts/.test(x.q)));
  sql = await consolidate({ source: { type: 'email' }, fact: { subject: 'C', predicate: 'contract', value: 'ends', durable: true, expires: future } });
  assert.equal(sql.find((x) => /^INSERT INTO memory_facts/.test(x.q)).p[12], null);
});

test('a short fact is superseded; a long one is kept and the contradiction stored alongside', async () => {
  let sql = await consolidate({ source: { type: 'email' }, fact: { subject: 'S', predicate: 'p', value: 'new', confidence: 0.9 }, cur: { id: 9, value: 'old', tier: 'short' } });
  assert.ok(sql.some((x) => /^UPDATE memory_facts SET valid_to = NOW\(\) WHERE id = \?/.test(x.q) && x.p[0] === 9));
  sql = await consolidate({ source: { type: 'email' }, fact: { subject: 'S', predicate: 'p', value: 'new', confidence: 0.9 }, cur: { id: 9, value: 'old', tier: 'long' } });
  assert.ok(!sql.some((x) => /SET valid_to = NOW\(\)/.test(x.q) && x.p[0] === 9));
});

// Runs before the retention test: the repair's done-flag is module state.
test('the one-time durable repair runs when its flag is absent', async () => {
  const answer = (s) => (/^SELECT EXISTS/.test(s) ? [{ has: 0 }] : undefined);
  answer.meta = {};
  await withDb(answer, async (sql) => {
    await maint.runDecay();
    assert.ok(sql.some((x) => /^UPDATE memory_facts SET importance = \? WHERE valid_to IS NULL AND tier = 'short'/.test(x.q)), 'grandfather');
    assert.ok(sql.some((x) => /SET f\.tier = 'long'/.test(x.q) && /artifactId/.test(x.q) && /horst-chat/.test(x.q)), 'promote durable provenance');
    assert.ok(sql.some((x) => /^SELECT f\.id, f\.app_origin FROM memory_facts f WHERE f\.valid_to IS NOT NULL/.test(x.q) && /action = 'forget'/.test(x.q)), 'restore, sparing forgotten facts');
    assert.ok(sql.some((x) => /^INSERT INTO memory_meta/.test(x.q) && x.p[0] === 'durable_v1'), 'flag set');
  });
});

test('retention never mutates importance and never touches the long tier', async () => {
  const answer = (s) => { if (/^SELECT EXISTS\( SELECT 1 FROM memory_facts/.test(s)) return [{ has: 1 }]; };
  answer.meta = { durable_v1: '1' };
  await withDb(answer, async (sql) => {
    await maint.runDecay();
    assert.ok(!sql.some((x) => /SET importance/.test(x.q)), 'no time decay of importance');
    const writes = sql.filter((x) => /^UPDATE memory_facts SET (tier|valid_to)/.test(x.q) || /^SELECT id, app_origin FROM memory_facts/.test(x.q));
    assert.equal(writes.length, 3, 'expire, promote, prune');
    assert.ok(writes.every((x) => /tier='short'/.test(x.q)));
    assert.match(writes.find((x) => /SET tier='long'/.test(x.q)).q, /expires_at IS NULL/, 'time-bound facts are never promoted');
  });
});

test('compaction folds short-tier pairs only, and never across different numbers', async () => {
  const answer = (s) => {
    if (/^SELECT a\.id AS keep_id/.test(s)) {
      return [
        { keep_id: 1, keep_value: 'Sept CHF 89', dup_id: 2, dup_value: 'Oct CHF 92', dup_hits: 0 },
        { keep_id: 3, keep_value: "the user's accountant", dup_id: 4, dup_value: 'accountant of the user', dup_hits: 2 },
      ];
    }
  };
  answer.meta = { churn_since_compact: '999' };
  await withDb(answer, async (sql) => {
    const r = await maint.runCompact();
    assert.equal(r.merged, 1);
    assert.match(sql.find((x) => /^SELECT a\.id AS keep_id/.test(x.q)).q, /a\.tier = 'short' AND b\.tier = 'short'/);
    const folds = sql.filter((x) => /superseded_by = \? WHERE id = \?/.test(x.q));
    assert.deepEqual(folds.map((x) => x.p), [[3, 4]]);
  });
});
