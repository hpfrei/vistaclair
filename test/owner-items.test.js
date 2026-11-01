// The owner's "your turn" checklist and the locks panel (public/owner-items.js):
// which items count, their order of display, what each kind of item offers the
// owner, and the locks listing. The view (fetching, clicks) is DOM code and is
// not run here.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const O = require('../public/owner-items.js');

const NOW = Date.parse('2026-11-01T12:00:00Z');
const at = (min) => new Date(NOW - min * 60000).toISOString();
const run = { runId: 'r1', name: 'orch-r1', title: 'Fix login', items: [
  { id: 'o1', kind: 'action', what: 'Stop→Start <the server>', why: 'new routes', worker: 'orch-r1-w2-api', at: at(5), state: 'open', blocking: true },
  { id: 'o2', kind: 'decision', what: 'Which port?', options: ['3457', '3458'], recommended: '3458', at: at(90), state: 'open' },
  { id: 'o3', kind: 'action', what: 'Old', at: at(900), state: 'done' },
] };

test('only open items count; runs with nothing open drop out', () => {
  assert.strictEqual(O.countOpen([run, { runId: 'r2', items: [{ state: 'dropped' }] }]), 2);
  assert.deepStrictEqual(O.waitingRuns([run, { runId: 'r2', items: [{ state: 'done' }] }]).map(r => [r.runId, r.items.map(i => i.id)]), [['r1', ['o1', 'o2']]]);
});

test('an action has a Done tick, a decision its options (the recommended one marked) and an answer field; both can be dropped', () => {
  const a = O.itemHtml(run.items[0], run, { now: NOW });
  assert.match(a, /data-act="done" data-run="r1" data-id="o1"/);
  assert.match(a, /data-act="drop"/);
  assert.match(a, /oi-blocking/);
  assert.match(a, /Stop→Start &lt;the server&gt;/, 'escaped');
  assert.match(a, /<span>w2-api<\/span> · <span>5 min<\/span>/, 'proposer without the run prefix, age');
  assert.doesNotMatch(a, /data-answer-for/);
  const d = O.itemHtml(run.items[1], run, { now: NOW });
  assert.match(d, /data-act="option"[^>]*data-answer="3457"/);
  assert.match(d, /vc-btn-primary" data-act="option"[^>]*data-answer="3458"[^>]*>3458 ★/);
  assert.match(d, /data-answer-for="o2"/);
  assert.match(d, /data-act="answer" data-run="r1" data-id="o2"/);
  assert.match(d, /1 h|90 min/);
});

test('the run is named on each item only when several runs wait', () => {
  const two = [run, { runId: 'r2', name: 'orch-r2', items: [{ id: 'o1', kind: 'action', what: 'Other', at: at(1), state: 'open' }] }];
  assert.match(O.checklistHtml(two, { now: NOW }), /class="oi-run" title="run r1">Fix login/);
  assert.doesNotMatch(O.checklistHtml([run], { now: NOW }), /oi-run/);
});

test('the locks panel lists holders and waiters read-only, and is empty with no lock in use', () => {
  assert.strictEqual(O.locksHtml({ locks: [] }), '');
  assert.strictEqual(O.locksHtml(null), '');
  const html = O.locksHtml({ dir: '/x', locks: [{ name: 'gpu', holders: [{ pid: 7, mode: 'exclusive', session: 'orch-r1-w1', command: ['python', 'train.py'], since: NOW - 120000 }], waiters: [{ pid: 9, mode: 'shared', user: 'hp', host: 'box', command: [], since: NOW - 1000 }] }] }, { now: NOW });
  assert.match(html, /oi-lk-name">gpu</);
  assert.match(html, /1 held · 1 waiting/);
  assert.match(html, /orch-r1-w1 \(exclusive\) · python train.py · 2 min/);
  assert.match(html, /waiting: hp@box \(shared\) · just now/);
  assert.doesNotMatch(html, /<button/);
});

test('the panel: header with the count, the checklist, then the locks; nothing when there is nothing', () => {
  assert.strictEqual(O.panelHtml([], null), '');
  const html = O.panelHtml([run], { locks: [{ name: 'gpu', holders: [{ pid: 1 }], waiters: [] }] }, { now: NOW });
  assert.match(html, /Your turn<\/span><span class="oi-count oi-count-on">2 waiting/);
  assert.ok(html.indexOf('oi-list') < html.indexOf('oi-locks'));
  assert.match(O.panelHtml([], null, { emptyText: 'Nothing waits for you in this run.' }), /nothing waiting.*Nothing waits for you/);
});
