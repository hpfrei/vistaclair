// Run cards (src/run-summary.js) and the cli:savedSessions message that
// carries them (src/cli-sessions.js savedSessionsMessage): one summary per
// orchestration run with its status, last activity, workers and the
// orchestrator's last TODO rows.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { summarizeRuns, runStatus, workerState } = require('../src/run-summary');

const CORE = path.join(__dirname, '..');
const TODO = (rows) => '| id | description | depends on | status |\n|--|--|--|--|\n' + rows.map(r => `| ${r.join(' | ')} |`).join('\n') + '\n';

// A run on disk: run.json and the orchestrator's folder with a 7-row TODO.
function runOnDisk(run = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-runsum-'));
  const runDir = path.join(home, 'proj', '.orchestrator', 'r1');
  const orchDir = path.join(home, 'sessions', 'orch-r1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(orchDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
    runId: 'r1', orchestrator: 'orch-r1', root: path.join(home, 'proj'), isolation: 'worktree', orchestratorDir: orchDir,
    workers: [
      { id: 'w1', name: 'orch-r1-w1-a', title: 'A', lastReport: { status: 'done', summary: 'a done', at: '2026-01-01T00:00:10Z' } },
      { id: 'w2', name: 'orch-r1-w2-b', title: 'B', lastReport: { status: 'started', summary: 'b', at: '2026-01-01T00:00:05Z' } },
    ],
    events: [],
    ...run,
  }));
  const rows = [1, 2, 3, 4, 5, 6, 7].map(i => [String(i), `task ${i}`, '', i < 5 ? 'done' : i === 5 ? 'doing' : 'queued']);
  fs.writeFileSync(path.join(orchDir, 'TODO.md'), TODO(rows));
  const stamp = (role, workerId) => ({ runId: 'r1', role, workerId, orchestrator: 'orch-r1', runDir });
  const entries = [
    { id: 'o1', cwd: path.join(home, 'proj'), title: 'orch', savedAt: 1000, lastInteractionAt: 5000, settings: { model: 'opus', orchestration: stamp('orchestrator') }, group: { runId: 'r1', role: 'orchestrator' } },
    { id: 's1', cwd: path.join(home, 'proj'), savedAt: 900, lastInteractionAt: 4000, settings: { orchestration: stamp('worker', 'w1') }, group: { runId: 'r1', role: 'worker', workerId: 'w1' } },
    { id: 's2', cwd: path.join(home, 'proj'), savedAt: 900, lastInteractionAt: Date.parse('2026-01-02T00:00:00Z'), settings: { orchestration: stamp('worker', 'w2') }, group: { runId: 'r1', role: 'worker', workerId: 'w2' } },
    { id: 'plain', cwd: '/x', savedAt: 1, settings: {} },
  ];
  return { home, runDir, orchDir, entries, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('runStatus: missing, pausing, running, paused, closed, completed, stopped', () => {
  assert.strictEqual(runStatus(null, true), 'missing');
  assert.strictEqual(runStatus({ pausing: true, workers: [] }, true), 'pausing');
  assert.strictEqual(runStatus({ paused: { at: 1 }, workers: [] }, true), 'running');
  assert.strictEqual(runStatus({ paused: { at: 1 }, workers: [] }, false), 'paused');
  assert.strictEqual(runStatus({ closed: true, workers: [] }, false), 'closed');
  assert.strictEqual(runStatus({ workers: [{ lastReport: { status: 'done' } }, { abandoned: true }] }, false), 'completed');
  assert.strictEqual(runStatus({ workers: [{ lastReport: { status: 'started' } }] }, false), 'stopped');
  assert.strictEqual(runStatus({ workers: [] }, false), 'stopped');
});

test('workerState: live state while running, else paused / abandoned / report / exited', () => {
  assert.strictEqual(workerState({}, { running: true, busy: true }), 'busy');
  assert.strictEqual(workerState({}, { running: true, state: 'awaiting' }), 'awaiting');
  assert.strictEqual(workerState({ paused: true }, null), 'paused');
  assert.strictEqual(workerState({ abandoned: true }, null), 'abandoned');
  assert.strictEqual(workerState({ lastReport: { status: 'failed' } }, null), 'failed');
  assert.strictEqual(workerState({ exitedAt: 'x' }, null), 'exited');
  assert.strictEqual(workerState(null, null), 'stopped');
});

test('one summary per run: workers from the record, live counts, last activity, TODO tail', (t) => {
  const d = runOnDisk();
  t.after(d.cleanup);
  const live = { s2: { running: true, busy: true } };
  const runs = summarizeRuns(d.entries, { liveOf: id => live[id] || null });
  assert.strictEqual(runs.length, 1, 'a plain session makes no run');
  const r = runs[0];
  assert.strictEqual(r.runId, 'r1');
  assert.strictEqual(r.orchestrator, 'orch-r1');
  assert.strictEqual(r.status, 'running', 'a running worker makes the run running');
  assert.strictEqual(r.orchestratorSessId, 'o1');
  assert.strictEqual(r.orchestratorRunning, false);
  assert.strictEqual(r.model, 'opus');
  assert.strictEqual(r.lastActivityAt, Date.parse('2026-01-02T00:00:00Z'), 'the newest member activity');
  assert.deepStrictEqual({ total: r.workers.total, running: r.workers.running }, { total: 2, running: 1 });
  const [w1, w2] = r.workers.list;
  assert.deepStrictEqual([w1.name, w1.state, w1.sessId, w1.completed], ['orch-r1-w1-a', 'done', 's1', true]);
  assert.deepStrictEqual([w2.state, w2.running, w2.lastReport.status], ['busy', true, 'started']);
  // No todoTail on the entry: the orchestrator folder from the record.
  assert.deepStrictEqual(r.todo.rows.map(x => x.id), ['3', '4', '5', '6', '7']);
  assert.deepStrictEqual([r.todo.done, r.todo.total, r.todo.doing.id], [4, 7, '5']);
});

test('a run whose record is gone is still a card, marked missing', (t) => {
  const d = runOnDisk();
  t.after(d.cleanup);
  fs.rmSync(path.join(d.runDir, 'run.json'));
  const [r] = summarizeRuns(d.entries);
  assert.strictEqual(r.status, 'missing');
  assert.strictEqual(r.runMissing, true);
  assert.strictEqual(r.workers.total, 2, 'the saved workers stand in for the record');
  assert.strictEqual(r.todo, null);
});

test('cli:savedSessions carries the runs; the orchestrator entry has its TODO tail', (t) => {
  const d = runOnDisk({ paused: { at: '2026-01-01T00:00:00Z' } });
  t.after(d.cleanup);
  const data = path.join(d.home, 'data');
  fs.mkdirSync(data, { recursive: true });
  const proj = path.join(d.home, '.claude', 'projects', path.join(d.home, 'proj').replace(/\//g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const history = d.entries.slice(0, 3).map(e => ({ id: e.id, cwd: e.cwd, title: e.title || null, savedAt: e.savedAt, settings: e.id === 'o1' ? { ...e.settings, sessionDir: d.orchDir } : e.settings }));
  for (const e of history) fs.writeFileSync(path.join(proj, `${e.id}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(data, 'cli-history.json'), JSON.stringify(history));
  const script = `
    const M = require(${JSON.stringify(path.join(CORE, 'src', 'cli-sessions.js'))});
    const mgr = new M(1, { broadcast() {} }, { deleteSessionData() {} });
    process.stdout.write(JSON.stringify(mgr.savedSessionsMessage()));
    process.exit(0);`;
  const r = spawnSync('node', ['-e', script], { env: { ...process.env, VISTACLAIR_HOME: d.home, HOME: d.home, VISTACLAIR_DASHBOARD_PORT: '', VISTACLAIR_AUTH_TOKEN: '' }, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const msg = JSON.parse(r.stdout);
  assert.strictEqual(msg.type, 'cli:savedSessions');
  assert.strictEqual(msg.sessions.length, 3);
  const orch = msg.sessions.find(s => s.id === 'o1');
  assert.deepStrictEqual(orch.todoTail.map(x => x.status), ['done', 'done', 'doing', 'queued', 'queued']);
  assert.strictEqual(msg.sessions.find(s => s.id === 's1').todoTail, undefined, 'only an orchestrator carries TODO rows');
  assert.strictEqual(msg.runs.length, 1);
  const run = msg.runs[0];
  assert.strictEqual(run.status, 'paused');
  assert.strictEqual(run.workers.total, 2);
  assert.strictEqual(run.workers.running, 0);
  assert.deepStrictEqual(run.todo.rows.map(x => x.id), ['3', '4', '5', '6', '7']);
  assert.strictEqual(run.todo.total, 7);
});
