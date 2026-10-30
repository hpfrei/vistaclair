// The SDK panel's activity rows (public/sdk-activity.js): which main-agent
// calls and background tasks run, from the messages the SDK streams, and how
// a row reads. The message shapes are those of real transcripts.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createActivity, progressOf, fmtAge, describe, MAX } = require('../public/sdk-activity.js');

// Feeds SDK messages the way the panel routes them: the main agent's calls
// from its assistant / tool_result / result messages, the rest as they come.
function feed(act, msgs) {
  for (const [at, m] of msgs) {
    if (m.type === 'assistant' && !m.parent_tool_use_id) {
      for (const b of m.message.content) {
        if (b.type !== 'tool_use') continue;
        act.toolStart(b.id, b.name, at);
        act.toolInput(b.id, { description: b.input.description || '', gist: b.input.command || b.input.file_path || '' });
      }
    } else if (m.type === 'user') {
      for (const b of m.message.content) if (b.type === 'tool_result') act.toolDone(b.tool_use_id);
    } else if (m.type === 'result' && !m.parent_tool_use_id) act.turnEnd();
    else if (m.type === 'tool_progress') act.progress(m, at);
    else if (m.type === 'system') act.system(m, at);
  }
  return act;
}
const call = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const calls = (...bs) => ({ type: 'assistant', message: { content: bs.map(([id, name, input]) => ({ type: 'tool_use', id, name, input })) } });
const done = (id) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const started = (task_id, tool_use_id, description, bg, task_type = 'local_bash', extra = {}) =>
  ({ type: 'system', subtype: 'task_started', task_id, tool_use_id, description, is_backgrounded: bg, task_type, ...extra });
const notified = (task_id, tool_use_id, status = 'completed') => ({ type: 'system', subtype: 'task_notification', task_id, tool_use_id, status, summary: '' });
const updated = (task_id, patch) => ({ type: 'system', subtype: 'task_updated', task_id, patch });
const snapshot = (...tasks) => ({ type: 'system', subtype: 'background_tasks_changed', tasks });
const heartbeat = (id, n, secs) => ({ type: 'tool_progress', tool_use_id: `${id}-heartbeat-${n}`, tool_name: 'Bash', parent_tool_use_id: id, elapsed_time_seconds: secs, heartbeat: true });
const result = { type: 'result', subtype: 'success' };
const keys = (act) => act.items().map((x) => x.key);

test('parallel calls of one reply are all listed, each until its own result', () => {
  const act = feed(createActivity(), [
    [1000, calls(['a', 'Read', { file_path: '/x.js' }], ['b', 'Grep', {}], ['c', 'Bash', { command: 'ls', description: 'List files' }])],
  ]);
  assert.deepStrictEqual(keys(act), ['a', 'b', 'c']);
  feed(act, [[2000, done('b')]]);
  assert.deepStrictEqual(keys(act), ['a', 'c']);
  const c = act.items()[1];
  assert.strictEqual(c.startedAt, 1000);
  assert.strictEqual(describe(c, 1000 + 192000).text, '3m12 Bash · List files');
  feed(act, [[3000, done('a')], [3001, done('c')]]);
  assert.deepStrictEqual(keys(act), []);
});

test('a background Bash outlives the turn and goes with its notification', () => {
  const act = feed(createActivity(), [
    [1000, call('t1', 'Bash', { command: 'node check.mjs', description: 'Run full-world check-pave', run_in_background: true })],
    [1001, snapshot({ task_id: 'bq1', task_type: 'local_bash', description: 'Run full-world check-pave' })],
    [1001, started('bq1', 't1', 'Run full-world check-pave', true)],
    [1100, done('t1')],
    [2000, result],
  ]);
  const items = act.items();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].bg, true);
  assert.strictEqual(items[0].name, 'Bash');
  assert.strictEqual(items[0].startedAt, 1000);   // the call's start, not the task's
  assert.strictEqual(describe(items[0], 1000 + 12 * 60000).text, 'bg 12m Bash · Run full-world check-pave');
  assert.strictEqual(act.bgCount(), 1);
  feed(act, [[9000, updated('bq1', { status: 'completed', end_time: 9000 })], [9000, notified('bq1', 't1')], [9000, snapshot()]]);
  assert.deepStrictEqual(keys(act), []);
});

test('while its call is open, a background task is one row, not two', () => {
  const act = feed(createActivity(), [
    [1000, call('ag', 'Agent', { description: 'Gate facts group A', subagent_type: 'explorer', run_in_background: true })],
    [1002, started('adc', 'ag', 'Gate facts group A', true, 'local_agent', { subagent_type: 'explorer' })],
  ]);
  const items = act.items();
  assert.deepStrictEqual(items.map((x) => [x.key, x.bg, x.name]), [['task:adc', true, 'Agent']]);
  assert.match(describe(items[0], 1000).tip, /Background Agent \(explorer\)/);
});

test('a foreground Bash moved to the background stays listed after its result', () => {
  const act = feed(createActivity(), [
    [1000, call('t2', 'Bash', { command: 'until …; do sleep 30; done' })],
    [1001, started('ba0', 't2', 'until …; do sleep 30; done', false)],
  ]);
  assert.deepStrictEqual(act.items().map((x) => x.bg), [false]);
  feed(act, [
    [5000, snapshot({ task_id: 'ba0', task_type: 'local_bash', description: 'until …' })],
    [5000, updated('ba0', { is_backgrounded: true })],
    [5001, done('t2')],
    [6000, result],
  ]);
  assert.deepStrictEqual(act.items().map((x) => [x.key, x.bg, x.startedAt]), [['task:ba0', true, 1000]]);
});

test('a foreground task finished is not a row; a turn end clears calls whose result never came', () => {
  const act = feed(createActivity(), [
    [1000, call('t3', 'Bash', { command: 'git status', description: 'Show status' })],
    [1001, started('bf', 't3', 'Show status', false)],
    [1002, notified('bf', 't3')],
  ]);
  assert.deepStrictEqual(keys(act), ['t3']);   // the call, until its result
  feed(act, [[1003, call('t4', 'Read', { file_path: '/a' })], [2000, result]]);
  assert.deepStrictEqual(keys(act), []);
  assert.deepStrictEqual(act.size(), { calls: 0, tasks: 0 });
});

test('the snapshot heals a missed notification and adds a task it never saw start', () => {
  const act = feed(createActivity(), [
    [1000, started('old', 'x', 'Old job', true)],
    [1000, started('keep', 'y', 'Kept job', true)],
    [2000, result],
  ]);
  assert.deepStrictEqual(keys(act), ['task:old', 'task:keep']);
  // `old` finished with no notification seen; `new` started before the page.
  feed(act, [[5000, snapshot({ task_id: 'keep', task_type: 'local_bash' }, { task_id: 'new', task_type: 'local_agent', description: 'Classify sites', subagent_type: 'coder' })]]);
  const items = act.items();
  assert.deepStrictEqual(items.map((x) => x.key), ['task:keep', 'task:new']);
  assert.deepStrictEqual([items[1].name, items[1].description, items[1].startedAt], ['Agent', 'Classify sites', 5000]);
  feed(act, [[6000, snapshot()]]);
  assert.deepStrictEqual(keys(act), []);
});

test('killed, failed and stopped are final; a late notification of an unknown task is nothing', () => {
  const act = feed(createActivity(), [
    [1, started('k', 'a', 'A', true)], [1, started('f', 'b', 'B', true)], [1, started('s', 'c', 'C', true)],
  ]);
  assert.strictEqual(act.system(updated('k', { status: 'killed', end_time: 2 }), 2), true);
  assert.strictEqual(act.system(updated('f', { status: 'failed', end_time: 2 }), 2), true);
  assert.strictEqual(act.system(notified('s', 'c', 'stopped'), 2), true);
  assert.strictEqual(act.system(notified('zz', 'q'), 3), false);
  assert.deepStrictEqual(keys(act), []);
});

test('heartbeats map to their call and give it its age', () => {
  assert.strictEqual(progressOf(heartbeat('toolu_01', 7, 240)), 'toolu_01');
  assert.strictEqual(progressOf({ tool_use_id: 'toolu_02-heartbeat-12' }), 'toolu_02');
  assert.strictEqual(progressOf({ tool_use_id: 'toolu_03', parent_tool_use_id: 'toolu_agent' }), 'toolu_03');
  const act = createActivity();
  act.toolStart('toolu_01', 'Bash', null);           // start not known (e.g. a seeded record)
  assert.strictEqual(act.items()[0].startedAt, null);
  assert.strictEqual(describe(act.items()[0], 99).age, '');
  assert.strictEqual(act.progress(heartbeat('toolu_01', 0, 30), 31000), true);
  assert.strictEqual(act.items()[0].startedAt, 1000);
  // Close to what is known: left alone (no jitter); far off: corrected.
  assert.strictEqual(act.progress(heartbeat('toolu_01', 1, 60), 61500), false);
  assert.strictEqual(act.progress(heartbeat('toolu_01', 2, 90), 95000), true);
  assert.strictEqual(act.items()[0].startedAt, 5000);
  // An unknown call (a subagent's) is not made a row.
  assert.strictEqual(act.progress(heartbeat('toolu_sub', 0, 30), 40000), false);
  assert.deepStrictEqual(keys(act), ['toolu_01']);
});

test('a replay rebuilds the same rows, aged from the records', () => {
  const t0 = 1793364511160;
  const log = [
    [t0 - 9000, call('old', 'Bash', { command: 'sleep 1', run_in_background: true })],
    [t0 - 8990, started('bold', 'old', 'Old background', true)],
    [t0 - 8000, done('old')],
    [t0 - 7000, result],
    [t0 - 1000, updated('bold', { status: 'completed', end_time: t0 - 1000 })],
    [t0 - 1000, notified('bold', 'old')],
    [t0 - 1000, snapshot()],
    [t0, call('toolu_0117', 'Bash', { command: 'git checkout --ours TODO.md && …', description: 'Resolve TODO.md, finish rebase, re-run gates' })],
    [t0 + 3642, started('b6e', 'toolu_0117', 'Resolve TODO.md, finish rebase, re-run gates', false)],
    ...Array.from({ length: 17 }, (_, n) => [t0 + 30417 + n * 30000, heartbeat('toolu_0117', n, 30 * (n + 1))]),
  ];
  const live = feed(createActivity(), log);
  const replay = feed(createActivity(), log);
  assert.deepStrictEqual(replay.items(), live.items());
  const [item] = replay.items();
  assert.strictEqual(item.key, 'toolu_0117');
  const now = t0 + 9 * 60000;
  assert.strictEqual(describe(item, now).text, '9m00 Bash · Resolve TODO.md, finish rebase, re-run gates');
  assert.match(describe(item, now).tip, /git checkout --ours/);
  // Its notification and result: gone, in both.
  for (const a of [live, replay]) feed(a, [[t0 + 527261, notified('b6e', 'toolu_0117')], [t0 + 527419, done('toolu_0117')]]);
  assert.deepStrictEqual(keys(replay), []);
  assert.deepStrictEqual(keys(live), []);
});

test('clear forgets everything; the maps stay within their cap', () => {
  const act = createActivity({ max: 5 });
  for (let i = 0; i < 20; i++) act.toolStart(`c${i}`, 'Read', i);
  for (let i = 0; i < 20; i++) act.system(started(`fg${i}`, `x${i}`, '', false), i);
  act.system(started('bg', 'y', 'Long', true), 0);
  for (let i = 0; i < 20; i++) act.system(started(`fg2${i}`, `z${i}`, '', false), i);
  assert.deepStrictEqual(act.size(), { calls: 5, tasks: 5 });
  assert.strictEqual(act.bgCount(), 1);   // foreground tasks go first
  assert.deepStrictEqual(keys(act).slice(0, 5), ['c15', 'c16', 'c17', 'c18', 'c19']);
  assert.strictEqual(act.clear(), true);
  assert.deepStrictEqual(act.size(), { calls: 0, tasks: 0 });
  assert.strictEqual(MAX, 200);
});

test('ages read short and grow coarser', () => {
  assert.deepStrictEqual([0, 45e3, 192e3, 599e3, 12 * 60e3, 65 * 60e3, 26 * 3600e3, -5].map(fmtAge),
    ['0s', '45s', '3m12', '9m59', '12m', '1h05', '1d', '0s']);
  assert.strictEqual(describe({ name: 'mcp__orchestrator__report', description: '', gist: '', startedAt: null }, 0, (n) => n.replace(/^mcp__(.+?)__/, '$1 · ')).text,
    'orchestrator · report');
});

test('the dashboard loads it before the panel', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const at = html.indexOf('src="sdk-activity.js"');
  assert.ok(at > 0 && at < html.indexOf('src="sdk-panel.js"'));
});
