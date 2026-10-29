// The live lanes' decisions (public/inspector-lanes.js): which lane a turn
// goes to, which result answers which call across turns, how calls and
// results read on one line, and which turns a lane renders.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/inspector-lanes.js');

const turn = (id, extra = {}) => ({ id, instanceId: 'a', status: 'complete', request: {}, ...extra });
const sub = (agentId, agentType = 'Explore') => ({ subagent: { agentId, agentType } });

test('turns group by agentId; main lane first and always present', () => {
  const items = [
    turn('m1'),
    turn('s1', sub('A')),
    turn('h1', { isHook: true }),
    turn('x1', { ...sub('B'), isMcp: true }),
    turn('t1', sub('B', 'Plan')),
    turn('m2'),
    turn('s2', sub('A')),
    turn('o1', { instanceId: 'other' }),
    turn('n1', { endpoint: '/v1/messages/count_tokens' }),
  ];
  const lanes = L.groupLanes(items, 'a');
  assert.deepStrictEqual(lanes.map(l => [l.key, l.ids]), [
    ['main', ['m1', 'm2']], ['A', ['s1', 's2']], ['B', ['t1']],
  ]);
  assert.strictEqual(lanes[2].subagent.agentType, 'Plan');
  assert.deepStrictEqual(L.groupLanes([], 'a').map(l => l.key), ['main']);
});

test('a tool result in the next turn pairs with the call by tool_use_id', () => {
  const items = [
    turn('t1'),   // calls tu1, tu2
    turn('t2', { request: { _toolResults: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'one' },
      { type: 'tool_result', tool_use_id: 'tu2', content: 'two', is_error: true },
    ] } }),
    // A fetched turn carries its messages instead of the digest.
    turn('t3', { request: { messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'no' }] },
      { role: 'assistant', content: [] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu3', content: 'three' }] },
    ] } }),
  ];
  const idx = L.toolResultIndex(items);
  assert.deepStrictEqual([...idx.keys()], ['tu1', 'tu2', 'tu3']);
  assert.strictEqual(idx.get('tu2').is_error, true);
  assert.strictEqual(idx.get('tu3').content, 'three');
});

test('a tool call reads as one line: icon, name, key argument', () => {
  const line = (n, i) => { const r = L.toolLine(n, i); return `${r.name} ${r.arg}`; };
  assert.strictEqual(line('Read', { file_path: '/home/u/proj/src/lib/file.js' }), 'Read …/src/lib/file.js');
  assert.strictEqual(line('Read', { file_path: 'src/file.js' }), 'Read src/file.js');
  assert.strictEqual(line('Bash', { command: 'npm test\necho done' }), 'Bash npm test …');
  assert.strictEqual(L.toolLine('Bash', { command: 'npm test\necho done' }).title, 'npm test\necho done');
  assert.strictEqual(line('Grep', { pattern: 'foo.*bar' }), 'Grep "foo.*bar"');
  assert.strictEqual(line('Edit', { file_path: '/a/b.js', old_string: 'x' }), 'Edit /a/b.js');
  assert.strictEqual(line('Agent', { description: 'Find callers', prompt: 'long', subagent_type: 'Explore' }), 'Agent Find callers');
  assert.strictEqual(line('Skill', { skill: 'review', args: 'low' }), '/review low');
  assert.strictEqual(line('TodoWrite', { todos: [{}, {}] }), 'TodoWrite 2 todos');
  assert.strictEqual(line('mcp__x__y', { thing: 'v' }), 'mcp__x__y v');
  assert.strictEqual(line('Read', null), 'Read ');
  assert.ok(L.toolLine('Bash', { command: 'x'.repeat(500) }).arg.length <= 160);
});

test('a tool result reads as one dim line', () => {
  assert.deepStrictEqual(L.resultLine({ content: 'a\nb\nc\n' }), { text: '3 lines', error: false, preview: 'a\nb\nc' });
  assert.strictEqual(L.resultLine({ content: 'ok' }).text, 'ok');
  assert.strictEqual(L.resultLine({ content: 'x'.repeat(100) }).text, '1 line');
  assert.strictEqual(L.resultLine({ content: 'a\nb', _truncated: true }).text, '2+ lines');
  assert.strictEqual(L.resultLine({ content: '' }).text, 'no output');
  assert.strictEqual(L.resultLine({ content: [{ type: 'image' }] }).text, '1 image');
  const err = L.resultLine({ content: [{ type: 'text', text: '\nENOENT: no such file\nstack' }], is_error: true });
  assert.strictEqual(err.text, 'error: ENOENT: no such file');
  assert.strictEqual(err.error, true);
  assert.strictEqual(L.resultLine(null), null);
});

test('new user text: the newest user message, reminders out, tool-only turns none', () => {
  assert.strictEqual(L.newUserText([{ role: 'user', content: [
    { type: 'text', text: '<system-reminder>r</system-reminder>' }, { type: 'text', text: 'Do it' },
  ] }]), 'Do it');
  assert.strictEqual(L.newUserText([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] }]), null);
  assert.strictEqual(L.newUserText([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]), null);
  assert.strictEqual(L.turnUserText({ request: { _newUserText: 'digest' } }), 'digest');
  assert.strictEqual(L.turnUserText({ request: { messages: [{ role: 'user', content: 'full' }] } }), 'full');
});

test('an Agent call links to the subagent it ran', () => {
  const prompt = 'Search the repository for every caller of renderLane and report back';
  const calls = { m1: [{ id: 'tuA', name: 'Agent', input: { prompt } }, { id: 'tuB', name: 'Agent', input: { prompt: 'short' } }],
                  m2: [{ id: 'tuC', name: 'Agent', input: { prompt: 'Another long prompt that is surely over thirty characters' } }] };
  const items = [
    turn('m1'),
    turn('s1', { ...sub('agent-1'), request: { _firstUserText: prompt + ' with more' } }),
    turn('p1', { subagent: { agentId: 'pending-tuB' } }),
    turn('m2'),
    turn('h1', { isHook: true, hookEvent: 'PostToolUse', toolName: 'Agent', toolUseId: 'tuC', request: { _agentId: 'agent-3' } }),
  ];
  const links = L.agentLinks(items, i => calls[i.id] || []);
  assert.strictEqual(links.get('tuA'), 'agent-1');
  assert.strictEqual(links.get('tuB'), 'pending-tuB');
  assert.strictEqual(links.get('tuC'), 'agent-3');
});

test('a subagent lane is done once its call has a result, it stopped, or it went idle', () => {
  const now = 100000;
  assert.strictEqual(L.laneDone({ live: true, resultSeen: true }, now), false);
  assert.strictEqual(L.laneDone({ live: false, resultSeen: true }, now), true);
  assert.strictEqual(L.laneDone({ live: false, stopped: true }, now), true);
  assert.strictEqual(L.laneDone({ live: false, lastActivity: now - 5000 }, now), false);
  assert.strictEqual(L.laneDone({ live: false, lastActivity: now - L.LIMITS.IDLE_DONE_MS }, now), true);
});

test('a lane renders its newest turns, capped, and pages back on demand', () => {
  const ids = Array.from({ length: 100 }, (_, k) => `t${k}`);
  assert.deepStrictEqual(L.laneWindow(ids), { from: 80, to: 100 });
  // Following the live end: new turns join, the oldest leave past the cap.
  assert.deepStrictEqual(L.laneWindow(ids, { fromId: 't50', toId: null }), { from: 60, to: 100 });
  assert.deepStrictEqual(L.laneWindow(ids, { fromId: 't70', toId: null }), { from: 70, to: 100 });
  // A window paged back keeps its ends.
  assert.deepStrictEqual(L.laneWindow(ids, { fromId: 't30', toId: 't59' }), { from: 30, to: 60 });
  // An anchor that left the page starts over at the end.
  assert.deepStrictEqual(L.laneWindow(ids, { fromId: 'gone', toId: null }), { from: 80, to: 100 });
  assert.deepStrictEqual(L.pageOlder(ids, { from: 80, to: 100 }), { from: 60, to: 100 });
  assert.deepStrictEqual(L.pageOlder(ids, { from: 60, to: 100 }), { from: 40, to: 80 });
  assert.deepStrictEqual(L.pageOlder(ids, { from: 5, to: 40 }), { from: 0, to: 40 });
});

test('a result shows its first 50 rows inline, the rest behind "more"', () => {
  const text = Array.from({ length: 120 }, (_, k) => `row ${k + 1}`).join('\n');
  const r = L.resultRows(text);
  assert.strictEqual(r.head.split('\n').length, 50);
  assert.strictEqual(r.head.split('\n')[49], 'row 50');
  assert.strictEqual(r.more, 70);
  assert.strictEqual(r.rest.split('\n')[0], 'row 51');
  assert.strictEqual(r.head + '\n' + r.rest, text);
  assert.deepStrictEqual(L.resultRows('a\nb'), { head: 'a\nb', rest: '', more: 0 });
  assert.strictEqual(L.resultRows('x\n'.repeat(50).slice(0, -1)).more, 0);
  assert.strictEqual(L.resultRows(text, 100).more, 20);
  assert.deepStrictEqual(L.resultRows(undefined), { head: '', rest: '', more: 0 });
});
