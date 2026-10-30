// The live lanes' decisions (public/inspector-lanes.js): which lane a turn
// goes to, which result answers which call across turns, how calls and
// results read on one line, and which turns a lane renders.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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

test('a call\'s description shows once, on one line', () => {
  const desc = (n, i) => L.toolLine(n, i).desc;
  assert.strictEqual(desc('Bash', { command: 'npm test', description: '  Run the\n tests ' }), 'Run the tests');
  assert.strictEqual(desc('mcp__x__y', { url: 'https://x', description: 'Why' }), 'Why');
  // Already the call's argument: not twice.
  assert.strictEqual(desc('Agent', { description: 'Find callers', prompt: 'p' }), '');
  assert.strictEqual(desc('mcp__x__y', { thing: 'v', description: 'Only this' }), '');
  assert.strictEqual(desc('Bash', { command: 'ls' }), '');
  assert.strictEqual(desc('Bash', { command: 'ls', description: 42 }), '');
  assert.strictEqual(desc('Read', null), '');
  const long = desc('Bash', { command: 'ls', description: 'y'.repeat(500) });
  assert.ok(long.length <= 160 && long.endsWith('\u2026'));
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

test('media paths in a result: each once, in order, capped with a count', () => {
  const kinds = { png: 'image', jpg: 'image', mp4: 'video', mp3: 'audio', pdf: 'pdf', js: 'text' };
  const categoryOf = p => kinds[p.split('.').pop().toLowerCase()] || 'unknown';
  const text = [
    'Saved /tmp/out/a.png and "/home/u/b.mp4", see /home/u/src/x.js',
    '/tmp/out/a.png again, /home/u/doc.pdf, /home/u/voice.mp3;',
    'relative ./c.png and https://example.com/d.png are not paths',
  ].join('\n');
  assert.deepStrictEqual(L.mediaPaths(text, categoryOf), { items: [
    { path: '/tmp/out/a.png', category: 'image' },
    { path: '/home/u/b.mp4', category: 'video' },
    { path: '/home/u/voice.mp3', category: 'audio' },
  ], more: 0 });
  const many = Array.from({ length: 11 }, (_, k) => `/tmp/f${k}.jpg`).join('\n') + '\n/tmp/f0.jpg';
  const r = L.mediaPaths(many, categoryOf);
  assert.strictEqual(r.items.length, 8);
  assert.strictEqual(r.items[7].path, '/tmp/f7.jpg');
  assert.strictEqual(r.more, 3);
  assert.strictEqual(L.mediaPaths(many, categoryOf, 2).more, 9);
  assert.deepStrictEqual(L.mediaPaths(undefined, categoryOf), { items: [], more: 0 });
});

test('media path detection matches linkifyFilePaths in public/core.js', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
  const core = read('core.js').match(/const _FILE_PATH_RE = (\/.+\/g);/)[1];
  const lanes = read('inspector-lanes.js').match(/const FILE_PATH_RE = (\/.+\/g);/)[1];
  assert.strictEqual(lanes, core);
});

test('a turn\'s usage reads compactly, the full numbers in its title', () => {
  assert.strictEqual(L.fmtTok(456), '456');
  assert.strictEqual(L.fmtTok(12345), '12.3k');
  assert.strictEqual(L.fmtTok(2500000), '2.5M');
  assert.strictEqual(L.fmtTok(undefined), '0');
  const u = L.usageLine({ input_tokens: 2, cache_creation_input_tokens: 584, cache_read_input_tokens: 72931, output_tokens: 1300 });
  assert.deepStrictEqual(u.parts, [
    { kind: 'in', text: '\u21912' }, { kind: 'cw', text: '\u270E584' },
    { kind: 'cr', text: '\u27F372.9k' }, { kind: 'out', text: '\u21931.3k' },
  ]);
  const n = x => x.toLocaleString();
  assert.strictEqual(u.title, `2 input \u00B7 584 cache write \u00B7 ${n(72931)} cache read \u00B7 ${n(1300)} output \u00B7 ${n(73517)} input in all`);
  // No cache: no cache parts, no total. A turn still streaming has input only.
  assert.deepStrictEqual(L.usageLine({ input_tokens: 900, output_tokens: 0, cache_read_input_tokens: 0 }),
    { parts: [{ kind: 'in', text: '\u2191900' }, { kind: 'out', text: '\u21930' }], title: '900 input \u00B7 0 output' });
  assert.deepStrictEqual(L.usageLine({ input_tokens: 5 }).parts, [{ kind: 'in', text: '\u21915' }]);
  assert.strictEqual(L.usageLine({}), null);
  assert.strictEqual(L.usageLine(null), null);
});

test('a call line links the file it names, never half a cut path', () => {
  const read = L.toolLine('Read', { file_path: '/home/u/proj/src/lib/file.js' });
  assert.strictEqual(read.path, '/home/u/proj/src/lib/file.js');
  assert.strictEqual(read.linkable, '');
  // Only what linkifyFilePaths would link: absolute, with an extension.
  assert.strictEqual(L.toolLine('Read', { file_path: 'src/file.js' }).path, '');
  assert.strictEqual(L.toolLine('Read', { file_path: '/home/u/Makefile' }).path, '');
  assert.strictEqual(L.toolLine('Read', { file_path: '/home/u/a b.js' }).path, '');
  const ls = L.toolLine('Bash', { command: 'ls /home/u/a.png' });
  assert.strictEqual(ls.path, '');
  assert.strictEqual(ls.linkable, 'ls /home/u/a.png');
  const long = L.toolLine('Bash', { command: 'cat /home/u/one.txt ' + 'x'.repeat(130) + ' /home/u/very/long/two.txt' });
  assert.ok(long.arg.endsWith('\u2026'));
  assert.ok(long.arg.startsWith(long.linkable));
  assert.ok(long.linkable.includes('/home/u/one.txt') && !long.linkable.includes('/home/u/very'));
});

test('a click in a result body opens the modal, unless it has its own click', () => {
  // A stand-in element: the selectors its closest() answers to.
  const el = (...matches) => ({ closest: sel => sel.split(',').some(x => matches.includes(x.trim())) ? {} : null });
  assert.strictEqual(L.bodyClickOpens(el('.ln-result-body'), ''), true);
  assert.strictEqual(L.bodyClickOpens(el('.ln-result-body', '.file-link', 'a'), ''), false);
  assert.strictEqual(L.bodyClickOpens(el('.ln-result-body', '.ln-thumbs', 'button'), ''), false);
  assert.strictEqual(L.bodyClickOpens(el('.ln-result-body', 'button'), ''), false);  // … N more lines
  assert.strictEqual(L.bodyClickOpens(el('button'), ''), false);                     // the result's line
  assert.strictEqual(L.bodyClickOpens(el('.ln-result-body'), 'dragged text'), false);
  assert.strictEqual(L.bodyClickOpens(null, ''), false);
});

test('only clearly markdown output renders as markdown', () => {
  assert.strictEqual(L.looksLikeMarkdown('# Report\n\n- one\n- two\n'), true);
  assert.strictEqual(L.looksLikeMarkdown('Some **bold** and a [link](http://x)'), true);
  assert.strictEqual(L.looksLikeMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n## Totals'), true);
  assert.strictEqual(L.looksLikeMarkdown('# only a heading, or a shell comment'), false);
  assert.strictEqual(L.looksLikeMarkdown('total 8\n-rw-r--r-- 1 u u 0 a.txt\n'), false);
  assert.strictEqual(L.looksLikeMarkdown('     1\u2192# Title\n     2\u2192\n     3\u2192- a\n     4\u2192- b'), false);
  assert.strictEqual(L.looksLikeMarkdown(''), false);
});

test('the turn holding a call\'s result', () => {
  const items = [
    turn('t1'),
    turn('t2', { request: { _toolResults: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'x' }] } }),
    turn('t3', { request: { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'y' }] }] } }),
  ];
  assert.strictEqual(L.resultHolder(items, 'tu1'), 't2');
  assert.strictEqual(L.resultHolder(items, 'tu2'), 't3');
  assert.strictEqual(L.resultHolder(items, 'nope'), null);
});

test('the media file a call names, for a thumbnail on its line', () => {
  const kinds = { png: 'image', mp4: 'video', mp3: 'audio', js: 'text' };
  const categoryOf = p => kinds[p.split('.').pop().toLowerCase()] || 'unknown';
  const shot = '/tmp/claude-1000/77c5675a-7a85-4084-991b-841fa7584523/images/1.png';
  assert.deepStrictEqual(L.callMedia({ file_path: shot }, categoryOf), { path: shot, category: 'image' });
  assert.deepStrictEqual(L.callMedia({ path: '/home/u/a.js', video_path: '/home/u/b.MP4' }, categoryOf),
    { path: '/home/u/b.MP4', category: 'video' });
  assert.deepStrictEqual(L.callMedia({ audio_path: '/home/u/c.mp3' }, categoryOf), { path: '/home/u/c.mp3', category: 'audio' });
  assert.strictEqual(L.callMedia({ file_path: 'rel/1.png' }, categoryOf), null);
  assert.strictEqual(L.callMedia({ file_path: '/home/u/a.js' }, categoryOf), null);
  assert.strictEqual(L.callMedia({ command: 'cat /home/u/1.png' }, categoryOf), null);
  assert.strictEqual(L.callMedia(null, categoryOf), null);
  // The result's strip leaves out what the call's line already shows.
  const r = L.mediaPaths(`saved ${shot} and /home/u/2.png`, categoryOf, 8, [shot]);
  assert.deepStrictEqual(r.items.map(m => m.path), ['/home/u/2.png']);
});

test('a call\'s media keys match the tool detail\'s in public/inspector.js', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
  const keys = (src, name) => src.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`))[1].replace(/\\s+/g, '');
  assert.strictEqual(keys(read('inspector-lanes.js'), 'INPUT_PATH_KEYS'), keys(read('inspector.js'), '_TOOL_PATH_KEYS'));
});
