// What an inspector tab keeps in the browser: the full-detail budget, the
// per-session timeline cap, and how a live summary or a fetched detail is
// merged into what the page already has (public/inspector-retention.js).
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const R = require('../public/inspector-retention.js');

const NOW = 1_000_000_000;
const full = (id, extra = {}) => ({
  id, instanceId: 'a', status: 'complete', timestamp: NOW - 1000,
  request: { messages: [{ role: 'user', content: 'hi' }] }, response: { body: {} }, ...extra,
});

test('past the budget, the least recently used full turns are trimmed', () => {
  const items = Array.from({ length: 15 }, (_, k) => full(`t${k}`));
  const recentFull = items.map(i => i.id);
  const plan = R.compactionPlan(items, { recentFull, activeInstance: 'a', now: NOW, budget: 10 });
  assert.deepStrictEqual(plan.map(p => p.id), ['t0', 't1', 't2', 't3', 't4']);
  assert.ok(plan.every(p => !p.dropStream));
});

test('the selection and split panes stay full; summaries are left alone', () => {
  const items = [full('sel'), full('pane'), full('old'), { ...full('sum'), _summary: true }];
  const plan = R.compactionPlan(items, { recentFull: [], keep: new Set(['sel', 'pane']), activeInstance: 'a', now: NOW });
  assert.deepStrictEqual(plan.map(p => p.id), ['old']);
});

test('recent turns of a tab not on screen are trimmed too', () => {
  const items = [full('a1'), full('b1', { instanceId: 'b' })];
  const plan = R.compactionPlan(items, { recentFull: ['a1', 'b1'], activeInstance: 'a', now: NOW });
  assert.deepStrictEqual(plan.map(p => p.id), ['b1']);
});

test('a live turn is trimmed but keeps its stream; a stuck one loses it', () => {
  const streaming = full('live', { status: 'streaming', timing: { startedAt: NOW - 1000 }, response: { sseEvents: [{}] } });
  const stuck = { ...full('stuck', { status: 'pending', timing: { startedAt: NOW - R.LIMITS.STUCK_LIVE_MS - 1 }, response: { sseEvents: [{}] } }), _summary: true };
  const plan = R.compactionPlan([streaming, stuck], { recentFull: [], activeInstance: 'a', now: NOW });
  assert.deepStrictEqual(plan, [{ id: 'live', dropStream: false }, { id: 'stuck', dropStream: true }]);
  assert.ok(R.isStuckLive(stuck, NOW));
  assert.ok(!R.isStuckLive(streaming, NOW));
  assert.ok(!R.isStuckLive(full('done', { timing: { startedAt: 0 } }), NOW), 'a finished turn is never stuck');
  // A stuck turn already selected stays — until the inspector is hidden.
  assert.deepStrictEqual(R.compactionPlan([stuck], { keep: new Set(['stuck']), now: NOW }), []);
});

test('hidden, every full turn goes — the selection and recent ones included', () => {
  const items = [full('sel'), full('recent'), { ...full('sum'), _summary: true }];
  const plan = R.compactionPlan(items, { recentFull: ['recent'], keep: new Set(['sel']), activeInstance: 'a', hidden: true, now: NOW });
  assert.deepStrictEqual(plan.map(p => p.id), ['sel', 'recent']);
});

test('the timeline cap drops the oldest turns of that session down to the cap', () => {
  const items = [];
  for (let k = 0; k < 12; k++) items.push({ id: `a${k}`, instanceId: 'a', status: 'complete' });
  items.push({ id: 'b0', instanceId: 'b', status: 'complete' });
  assert.deepStrictEqual(R.timelineTrim(items, 'a', { cap: 10, slack: 2 }), [], 'within the slack: nothing');
  items.push({ id: 'a12', instanceId: 'a', status: 'complete' });
  assert.deepStrictEqual(R.timelineTrim(items, 'a', { cap: 10, slack: 2 }), ['a0', 'a1', 'a2']);
  assert.deepStrictEqual(R.timelineTrim(items, 'b', { cap: 10, slack: 2 }), [], 'per session');
});

test('the cap skips the selection and turns still live', () => {
  const items = [
    { id: 'sel', instanceId: 'a', status: 'complete' },
    { id: 'live', instanceId: 'a', status: 'streaming' },
    ...Array.from({ length: 6 }, (_, k) => ({ id: `t${k}`, instanceId: 'a', status: 'complete' })),
  ];
  assert.deepStrictEqual(R.timelineTrim(items, 'a', { cap: 5, slack: 0, keep: new Set(['sel']) }), ['t0', 't1', 't2']);
});

test('a live summary keeps the events, gauge, subagent guess and fetched conversation', () => {
  const local = {
    id: 'x', status: 'streaming', _respChars: 42, subagent: { agentId: 'g' }, _subagentInferred: true,
    request: { model: 'm', messages: [{ role: 'user', content: 'q' }], tools: [{ name: 'T' }], system: 's' },
    response: { sseEvents: [{ eventType: 'message_start' }] },
  };
  const incoming = {
    id: 'x', status: 'complete', _summary: true,
    request: { model: 'm', _messageCount: 1, _toolCount: 1 }, response: { status: 200, body: { content: [] } },
  };
  const m = R.mergeLiveUpdate(local, incoming);
  assert.strictEqual(m.status, 'complete');
  assert.strictEqual(m.response.sseEvents, local.response.sseEvents);
  assert.strictEqual(m.response.status, 200);
  assert.strictEqual(m._respChars, 42);
  assert.deepStrictEqual(m.subagent, { agentId: 'g' });
  assert.strictEqual(m._subagentInferred, true);
  assert.strictEqual(m.request.messages, local.request.messages, 'the fetched conversation stays');
  assert.strictEqual(m.request.tools, local.request.tools);
  assert.strictEqual(m._summary, undefined, 'the turn is whole again');

  const cut = R.mergeLiveUpdate(local, { ...incoming, response: { body: {}, _bodyTruncated: true } });
  assert.strictEqual(cut._summary, true, 'a cut body still wants the detail');

  const fromSummary = R.mergeLiveUpdate({ ...local, _summary: true, request: { model: 'm' } }, incoming);
  assert.strictEqual(fromSummary.request.messages, undefined, 'nothing is invented');
  assert.strictEqual(fromSummary._summary, true);
});

test('a fetched detail keeps local events and sizes, and never revives a finished turn', () => {
  const local = {
    id: 'x', status: 'complete', timing: { duration: 5 }, usage: { output_tokens: 3 }, _respChars: 9,
    request: { _messageCount: 2, _messagesChars: 1234 }, response: { body: { content: ['done'] }, sseEvents: [{}] },
  };
  const detail = {
    id: 'x', status: 'streaming', timing: {}, request: { messages: [{}, {}] }, response: { status: 200 },
  };
  const m = R.mergeDetail(local, detail);
  assert.strictEqual(m.status, 'complete');
  assert.deepStrictEqual(m.timing, { duration: 5 });
  assert.deepStrictEqual(m.usage, { output_tokens: 3 });
  assert.deepStrictEqual(m.response.body, { content: ['done'] });
  assert.strictEqual(m.response.sseEvents, local.response.sseEvents);
  assert.strictEqual(m.request._messagesChars, 1234);
  assert.strictEqual(m.request.messages.length, 2);
  assert.strictEqual(m._respChars, 9);
  assert.strictEqual(detail.response.sseEvents, undefined, 'the reply object is not touched');
});

test('the interner keeps one copy per text per session, dropped with the session', () => {
  const i = R.createInterner();
  const a = 'x'.repeat(10);
  const b = 'x'.repeat(10);
  assert.strictEqual(i.intern('s1', a), a);
  assert.strictEqual(i.intern('s1', b), a);
  assert.strictEqual(i.intern('s2', b), b);
  assert.strictEqual(i.size('s1'), 1);
  i.drop('s1');
  assert.strictEqual(i.size('s1'), 0);
  assert.strictEqual(i.size(), 1);
  assert.strictEqual(i.intern('s1', null), null);
});
