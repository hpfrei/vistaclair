// sdk:history pages (src/sdk-session.js readTranscriptPage, src/ws/cli-handler.js):
// a transcript is read backwards from its end in chunks, one page at a time,
// never whole; a page's cursor (a byte offset) names the same place while the
// file grows; `hasMore` says whether an older page exists. The run form pages
// each member on its own.
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');

// Before anything reads them: a throwaway data home and $HOME.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-page-')));
process.env.VISTACLAIR_HOME = HOME;
process.env.HOME = HOME;
process.env.VISTACLAIR_DASHBOARD_PORT = '';

const test = require('node:test');
const assert = require('node:assert');
const SdkSession = require('../src/sdk-session');
const { readTranscriptPage, readTranscript, transcriptFile, transcriptTotals, recordedCost, HISTORY_PAGE } = SdkSession;
const cliHandler = require('../src/ws/cli-handler');

const SESS = '11111111-2222-3333-4444-555555555555';
const N = 50000;

function tmpDir() { return fs.mkdtempSync(path.join(HOME, 'sess-')); }

// Envelopes as SdkSession writes them; every tenth one carries a long text so
// lines straddle the reader's chunks.
function envLine(i) {
  const text = i % 10 === 0 ? `${i} ${'x'.repeat(3000)}` : String(i);
  return JSON.stringify({ sessId: SESS, ts: 1700000000000 + i, ev: { sdk: { type: 'assistant', uuid: `u-${i}`, message: { content: [{ type: 'text', text }] } } } });
}
const seqOf = (env) => Number(env.ev.sdk.uuid.slice(2));

function writeFixture(dir, from, to) {
  const out = [];
  for (let i = from; i < to; i++) out.push(envLine(i));
  fs.appendFileSync(transcriptFile(dir), out.join('\n') + '\n');
}

// Bytes read through fs.readSync while `fn` runs; whole-file reads fail the test.
function countReads(fn) {
  const { readSync, readFileSync } = fs;
  let bytes = 0;
  fs.readSync = (...a) => { const n = readSync.apply(fs, a); bytes += n; return n; };
  fs.readFileSync = (p, ...a) => {
    if (String(p).endsWith('transcript.jsonl')) throw new Error('the whole transcript was read');
    return readFileSync.call(fs, p, ...a);
  };
  try { return { result: fn(), bytes }; } finally { fs.readSync = readSync; fs.readFileSync = readFileSync; }
}

const big = tmpDir();
writeFixture(big, 0, N);
const BIG_SIZE = fs.statSync(transcriptFile(big)).size;

test('the newest page: the last 500 envelopes, oldest first, from the tail only', () => {
  const { result: page, bytes } = countReads(() => readTranscriptPage(big, { sessId: SESS }));
  assert.strictEqual(HISTORY_PAGE, 500);
  assert.strictEqual(page.events.length, 500);
  assert.deepStrictEqual(page.events.map(seqOf), Array.from({ length: 500 }, (_, i) => N - 500 + i));
  assert.strictEqual(page.hasMore, true);
  assert.strictEqual(page.before, page.events[0].off);
  assert.ok(bytes < BIG_SIZE / 20, `read ${bytes} of ${BIG_SIZE} bytes`);
  // Each envelope's `off` is where its line starts.
  const fd = fs.openSync(transcriptFile(big), 'r');
  for (const env of [page.events[0], page.events[250], page.events.at(-1)]) {
    const buf = Buffer.alloc(64);
    fs.readSync(fd, buf, 0, 64, env.off);
    assert.ok(buf.toString().startsWith(`{"sessId":"${SESS}"`));
    if (env.off > 0) { fs.readSync(fd, buf, 0, 1, env.off - 1); assert.strictEqual(buf[0], 0x0a); }
  }
  fs.closeSync(fd);
});

test('paging back walks the whole file in order, without gaps or repeats; the last page says no more', () => {
  const seen = [];
  let before = null;
  let pages = 0;
  for (;;) {
    const page = readTranscriptPage(big, { limit: 1000, before });
    pages++;
    seen.unshift(...page.events.map(seqOf));
    if (!page.hasMore) { assert.strictEqual(page.before, 0); break; }
    assert.ok(page.before > 0 && (before == null || page.before < before));
    before = page.before;
  }
  assert.strictEqual(pages, N / 1000);
  assert.strictEqual(seen.length, N);
  assert.ok(seen.every((v, i) => v === i));
});

test('a cursor stays put while the file is appended to', () => {
  const dir = tmpDir();
  writeFixture(dir, 0, 3000);
  const first = readTranscriptPage(dir, { limit: 500 });
  const second = readTranscriptPage(dir, { limit: 500, before: first.before });
  writeFixture(dir, 3000, 6000);
  const again = readTranscriptPage(dir, { limit: 500, before: first.before });
  assert.deepStrictEqual(again.events.map(seqOf), second.events.map(seqOf));
  assert.deepStrictEqual(again.events.map(seqOf), Array.from({ length: 500 }, (_, i) => 2000 + i));
  assert.strictEqual(again.before, second.before);
  // The newest page moved on.
  assert.strictEqual(readTranscriptPage(dir, { limit: 1 }).events.map(seqOf)[0], 5999);
});

test('hasMore: false when the page reaches the first line; a line still being written waits', () => {
  const dir = tmpDir();
  writeFixture(dir, 0, 10);
  let page = readTranscriptPage(dir, { limit: 10 });
  assert.strictEqual(page.events.length, 10);
  assert.strictEqual(page.hasMore, false);
  assert.strictEqual(page.before, 0);
  page = readTranscriptPage(dir, { limit: 9 });
  assert.strictEqual(page.hasMore, true);
  assert.deepStrictEqual(readTranscriptPage(dir, { limit: 9, before: page.before }).events.map(seqOf), [0]);

  // Half a line at the end (an append in progress) is not a line yet.
  fs.appendFileSync(transcriptFile(dir), envLine(10).slice(0, 30));
  assert.deepStrictEqual(readTranscriptPage(dir, { limit: 2 }).events.map(seqOf), [8, 9]);
  fs.appendFileSync(transcriptFile(dir), envLine(10).slice(30) + '\n');
  assert.deepStrictEqual(readTranscriptPage(dir, { limit: 2 }).events.map(seqOf), [9, 10]);

  // A bad line is skipped; no file is an empty page.
  fs.appendFileSync(transcriptFile(dir), '{not json\n');
  assert.deepStrictEqual(readTranscriptPage(dir, { limit: 1 }).events.map(seqOf), [10]);
  assert.deepStrictEqual(readTranscriptPage(tmpDir()), { events: [], hasMore: false, before: null });
  assert.strictEqual(readTranscript(dir).length, 11);
});

test('image URLs are re-keyed to the session asking', () => {
  const dir = tmpDir();
  fs.writeFileSync(transcriptFile(dir), JSON.stringify({ sessId: 'old', ts: 1, ev: { user: { text: 'see', images: [{ name: 'a.png', url: '/x' }] } } }) + '\n');
  const [env] = readTranscriptPage(dir, { sessId: SESS }).events;
  assert.strictEqual(env.ev.user.images[0].url, `/api/sdk/upload?sessId=${SESS}&name=a.png`);
});

// ---- the sdk:history message ----

function ask(msg, { dirs = {}, run = null } = {}) {
  const sent = [];
  const bc = {
    cliSessionManager: { getBySessId: () => null, sessionDirOf: (id) => dirs[id] || null },
    orchestration: run && { getRun: (id) => (id === run.runId ? run : null), describeRun: () => run },
  };
  cliHandler.handleMessage({ send: (s) => sent.push(JSON.parse(s)) }, msg, bc);
  return sent;
}

test('sdk:history: the newest page by default, older pages by cursor, `from` echoing it', () => {
  const [newest] = ask({ type: 'sdk:history', sessId: SESS }, { dirs: { [SESS]: big } });
  assert.strictEqual(newest.sessId, SESS);
  assert.strictEqual(newest.from, null);
  assert.strictEqual(newest.events.length, 500);
  assert.strictEqual(newest.hasMore, true);
  const [older] = ask({ type: 'sdk:history', sessId: SESS, before: newest.before, limit: 200 }, { dirs: { [SESS]: big } });
  assert.strictEqual(older.from, newest.before);
  assert.deepStrictEqual(older.events.map(seqOf), Array.from({ length: 200 }, (_, i) => N - 700 + i));
  // An unknown session: an empty page.
  const other = '99999999-2222-3333-4444-555555555555';
  assert.deepStrictEqual(ask({ type: 'sdk:history', sessId: other })[0], { type: 'sdk:history', sessId: other, from: null, events: [], hasMore: false, before: null, totals: null });
});

test('sdk:history for a run pages each member with its own cursor', () => {
  const w = '22222222-2222-3333-4444-555555555555';
  const small = tmpDir();
  writeFixture(small, 0, 30);
  const run = { runId: 'r1', orchestratorSessId: SESS, workers: [{ sessId: w }] };
  const dirs = { [SESS]: big, [w]: small };
  const [first] = ask({ type: 'sdk:history', runId: 'r1', limit: 20 }, { dirs, run });
  assert.deepStrictEqual(first.sessions.map(x => [x.sessId, x.events.length, x.hasMore]), [[SESS, 20, true], [w, 20, true]]);
  const before = Object.fromEntries(first.sessions.map(x => [x.sessId, x.before]));
  const [next] = ask({ type: 'sdk:history', runId: 'r1', limit: 20, before }, { dirs, run });
  const bySess = Object.fromEntries(next.sessions.map(x => [x.sessId, x]));
  assert.deepStrictEqual(bySess[SESS].events.map(seqOf), Array.from({ length: 20 }, (_, i) => N - 40 + i));
  assert.deepStrictEqual(bySess[w].events.map(seqOf), Array.from({ length: 10 }, (_, i) => i));
  assert.strictEqual(bySess[w].hasMore, false);
  assert.strictEqual(bySess[w].from, before[w]);
});

// ---- whole-transcript totals ----

const OLD = '0aaaaaaa-2222-3333-4444-555555555555';
const line = (sessId, ev) => JSON.stringify({ sessId, ts: 1, ev });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || 'cost'}: ${a} !== ${b}`);

// A folder two sessions ran in: OLD (cost and two compactions up front),
// then SESS (its costs early, a fresh restart's baseUsd on them), then one
// long turn of tool events far past the newest page and the 256 KB tail.
function costlyFixture() {
  const dir = tmpDir();
  fs.writeFileSync(transcriptFile(dir), [
    line(OLD, { sdk: { type: 'system', subtype: 'compact_boundary', parent_tool_use_id: null, compact_metadata: { trigger: 'auto' } } }),
    line(OLD, { sdk: { type: 'result', total_cost_usd: 3 } }),
    line(OLD, { sdk: { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } } }),
    line(OLD, { platform: { kind: 'status', state: 'exited', costUsd: 4 } }),
    // A subagent's compaction is not the session's.
    line(SESS, { sdk: { type: 'system', subtype: 'compact_boundary', parent_tool_use_id: 'toolu_1' } }),
    line(SESS, { platform: { kind: 'status', state: 'busy', costUsd: 4, baseUsd: 4 } }),
    line(SESS, { sdk: { type: 'result', total_cost_usd: 1.25 } }),
    line(SESS, { platform: { kind: 'status', state: 'busy', costUsd: 5.25, baseUsd: 4 } }),
    line(SESS, { sdk: { type: 'system', subtype: 'compact_boundary', parent_tool_use_id: null } }),
  ].join('\n') + '\n');
  writeFixture(dir, 0, 3000);
  return dir;
}

test('totals: the whole transcript\'s cost and compactions when the newest page holds none', () => {
  const dir = costlyFixture();
  assert.ok(fs.statSync(transcriptFile(dir)).size > 2 * 256 * 1024, 'past the old tail read');
  const page = readTranscriptPage(dir);
  assert.strictEqual(page.events.length, HISTORY_PAGE);
  assert.ok(page.events.every(e => e.ev.sdk?.type === 'assistant'), 'no status, result or compaction on the page');
  const t = transcriptTotals(dir);
  near(t.costUsd, 5.25, 'OLD 4 + SESS 1.25, each once');
  assert.strictEqual(t.compactions, 3, 'the main agent\'s, every session id\'s');
  near(recordedCost(dir, SESS), 1.25);
  near(recordedCost(dir, OLD), 4);
  assert.strictEqual(recordedCost(dir, '99999999-2222-3333-4444-555555555555'), 0);
  // No transcript: zeros.
  assert.deepStrictEqual({ ...transcriptTotals(tmpDir()), own: null }, { costUsd: 0, compactions: 0, own: null });
});

test('totals: cached, and only the bytes appended since are read', () => {
  const dir = costlyFixture();
  transcriptTotals(dir);
  const { result: same, bytes: none } = countReads(() => transcriptTotals(dir));
  assert.strictEqual(none, 0, 'nothing new: nothing read');
  near(same.costUsd, 5.25);
  const tail = [
    line(SESS, { sdk: { type: 'system', subtype: 'compact_boundary', parent_tool_use_id: null } }),
    line(SESS, { platform: { kind: 'status', state: 'idle', costUsd: 6, baseUsd: 4 } }),
  ].join('\n') + '\n';
  fs.appendFileSync(transcriptFile(dir), tail);
  // Half a line still being written waits for the next read.
  fs.appendFileSync(transcriptFile(dir), line(SESS, { sdk: { type: 'result', total_cost_usd: 9 } }).slice(0, 20));
  const { result: t, bytes } = countReads(() => transcriptTotals(dir));
  assert.ok(bytes < Buffer.byteLength(tail) + 100, `read ${bytes} bytes`);
  near(t.costUsd, 6);
  assert.strictEqual(t.compactions, 4);
  fs.appendFileSync(transcriptFile(dir), line(SESS, { sdk: { type: 'result', total_cost_usd: 9 } }).slice(20) + '\n');
  near(transcriptTotals(dir).costUsd, 13, 'OLD 4 + SESS 9');
});

test('sdk:history: every page carries the whole folder\'s totals', () => {
  const dir = costlyFixture();
  const [newest] = ask({ type: 'sdk:history', sessId: SESS }, { dirs: { [SESS]: dir } });
  assert.deepStrictEqual(Object.keys(newest).sort(), ['before', 'events', 'from', 'hasMore', 'sessId', 'totals', 'type']);
  assert.deepStrictEqual(newest.totals, { costUsd: 5.25, compactions: 3 });
  const [older] = ask({ type: 'sdk:history', sessId: SESS, before: newest.before }, { dirs: { [SESS]: dir } });
  assert.deepStrictEqual(older.totals, newest.totals);
  // The run form: each member its own folder's.
  const w = '22222222-2222-3333-4444-555555555555';
  const small = tmpDir();
  fs.writeFileSync(transcriptFile(small), line(w, { platform: { kind: 'status', state: 'idle', costUsd: 0.5 } }) + '\n');
  const run = { runId: 'r2', orchestratorSessId: SESS, workers: [{ sessId: w }] };
  const [r] = ask({ type: 'sdk:history', runId: 'r2' }, { dirs: { [SESS]: dir, [w]: small }, run });
  assert.deepStrictEqual(r.sessions.map(x => [x.sessId, x.totals]), [[SESS, { costUsd: 5.25, compactions: 3 }], [w, { costUsd: 0.5, compactions: 0 }]]);
});
