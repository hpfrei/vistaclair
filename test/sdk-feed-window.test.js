// The SDK panel's feed window (public/sdk-panel.js, its pure part): how many
// of the oldest entries go (down to FEED_MAX while following, past the hard
// cap only while the reader is scrolled back), the "Load earlier" cursor taken
// from the oldest entry kept, and the capped maps. Then the window against a
// real transcript: trimmed while lines are appended, the page it asks for
// joins the entries kept without a gap or a repeat.
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-feedwin-')));
process.env.VISTACLAIR_HOME = HOME;
process.env.HOME = HOME;
const { readTranscriptPage, transcriptFile } = require('../src/sdk-session');

// sdk-panel.js in a sandbox with just what its top level touches.
function loadPanel() {
  const noop = () => {};
  const window = {
    dashboard: { sendWs: noop, state: {}, escHtml: String, renderMarkdown: noop, renderMarkdownDebounced: noop, cancelRenderDebounce: noop, registerModule: noop, _tabHooks: { onChange: noop } },
  };
  const ctx = vm.createContext({ window, document: { addEventListener: noop }, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sdk-panel.js'), 'utf8'), ctx);
  return window.sdkPanel._feedWindow;
}
const W = loadPanel();

test('feedExcess: down to the cap while following; scrolled back only past the hard cap', () => {
  const { feedExcess, FEED_MAX, FEED_HARD_MAX } = W;
  assert.strictEqual(FEED_MAX, 500);
  assert.strictEqual(feedExcess(500, true), 0);
  assert.strictEqual(feedExcess(501, true), 1);
  assert.strictEqual(feedExcess(1700, true), 1200);
  assert.strictEqual(feedExcess(1700, false), 0);
  assert.strictEqual(feedExcess(FEED_HARD_MAX + 5, false), 5);
  assert.strictEqual(feedExcess(FEED_HARD_MAX + 5, true), FEED_HARD_MAX + 5 - FEED_MAX);
});

test('cursorAbove: the oldest stored entry kept; none stored keeps the cursor', () => {
  const cursorAbove = (...a) => { const r = W.cursorAbove(...a); return r === a[1] ? r : { ...r }; };   // a plain object (the sandbox's has its own prototype)
  const cur = { before: 10, hasMore: true };
  assert.deepStrictEqual(cursorAbove([null, null, 120, 90], cur), { before: 120, hasMore: true });
  assert.deepStrictEqual(cursorAbove([0, 50], cur), { before: 0, hasMore: false });
  assert.strictEqual(cursorAbove([null, undefined], cur), cur);
  // It stops at the first one (a generator over the feed's nodes).
  let pulled = 0;
  function* offs() { for (const o of [null, 7, 8, 9]) { pulled++; yield o; } }
  cursorAbove(offs(), cur);
  assert.strictEqual(pulled, 2);
});

test('capOldest: the oldest go, those it may drop only', () => {
  const { capOldest } = W;
  const seen = new Set(Array.from({ length: 10 }, (_, i) => i));
  capOldest(seen, 4);
  assert.deepStrictEqual([...seen], [6, 7, 8, 9]);
  const tools = new Map([['a', { done: false }], ['b', { done: true }], ['c', { done: true }], ['d', { done: false }]]);
  capOldest(tools, 2, (t) => t.done);
  assert.deepStrictEqual([...tools.keys()], ['a', 'd']);
});

test('the window over a transcript: trimmed as lines arrive, "Load earlier" joins without a gap', () => {
  const { feedExcess, cursorAbove, PAGE } = W;
  const dir = fs.mkdtempSync(path.join(HOME, 'sess-'));
  const file = transcriptFile(dir);
  const line = (i) => JSON.stringify({ sessId: 's', ts: i, ev: { sdk: { type: 'assistant', uuid: `u-${i}` } } });
  fs.writeFileSync(file, Array.from({ length: 2000 }, (_, i) => line(i)).join('\n') + '\n');
  const seq = (env) => Number(env.ev.sdk.uuid.slice(2));

  // The newest page; one entry per envelope (offset, seq), and some entries
  // drawn from no stored line (deltas, local notices).
  const first = readTranscriptPage(dir, { limit: PAGE });
  let feed = first.events.map(e => ({ off: e.off, seq: seq(e) }));
  let top = { before: first.before, hasMore: first.hasMore };
  // Live: each append broadcasts the offset its line starts at.
  for (let i = 2000; i < 2300; i++) {
    const off = fs.statSync(file).size;
    fs.appendFileSync(file, line(i) + '\n');
    feed.push({ off, seq: i });
    if (i % 50 === 0) feed.push({ off: null, seq: null });
    const n = feedExcess(feed.length, true);
    if (n > 0) { feed = feed.slice(n); top = cursorAbove(feed.map(e => e.off), top); }
  }
  assert.strictEqual(feed.length, 500);
  const oldest = feed.find(e => e.seq != null).seq;
  assert.ok(top.hasMore);
  const older = readTranscriptPage(dir, { limit: PAGE, before: top.before });
  assert.strictEqual(older.events.length, PAGE);
  assert.strictEqual(seq(older.events.at(-1)), oldest - 1, 'the page ends right before the oldest entry kept');
  assert.deepStrictEqual(older.events.map(seq), Array.from({ length: PAGE }, (_, i) => oldest - PAGE + i));
});
