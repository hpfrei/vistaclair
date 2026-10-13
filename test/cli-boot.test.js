// Boot and the "+" menu (src/cli-sessions.js): what happens to the tabs the
// previous process left open — archived into the saved sessions by default
// (busy → interrupted, paused kept), plain tabs reopened only with
// cliReopenTabsAtBoot — and the grouping of run members. Runs in a child
// process with its own VISTACLAIR_HOME and HOME; nothing spawns `claude`.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CORE = path.join(__dirname, '..');

function scenario(reopen) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-boot-')));
  const data = path.join(home, 'data');
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  const ids = { idle: 'a'.repeat(8) + '-0000-0000-0000-000000000001', busy: 'a'.repeat(8) + '-0000-0000-0000-000000000002', worker: 'a'.repeat(8) + '-0000-0000-0000-000000000003', paused: 'a'.repeat(8) + '-0000-0000-0000-000000000004' };
  const proj = path.join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  for (const id of Object.values(ids)) fs.writeFileSync(path.join(proj, `${id}.jsonl`), '{}\n');

  const runDir = path.join(cwd, '.orchestrator', 'abc123');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ runId: 'abc123', orchestrator: 'orch-abc123', workers: [{ id: 'w1', lastReport: { status: 'started', summary: 's' } }] }));
  const workerDir = path.join(data, 'sessions', 'orch-abc123-w1-a');
  fs.mkdirSync(workerDir, { recursive: true });
  fs.writeFileSync(path.join(workerDir, 'TODO.md'), '| id | description | depends on | status |\n|--|--|--|--|\n| 1 | a | – | done |\n| 2 | b | 1 | doing |\n');
  fs.writeFileSync(path.join(workerDir, 'NOTES.md'), '## Resume\nb half done\n');

  const tab = (sessId, extra = {}) => ({ sessId, cwd, title: sessId.slice(-1), settings: {}, reopenable: true, busy: false, ...extra });
  fs.writeFileSync(path.join(data, 'cli-open-tabs.json'), JSON.stringify([
    tab(ids.idle), tab(ids.busy, { busy: true }), tab(ids.paused),
    tab(ids.worker, { reopenable: false, settings: { sessionDir: workerDir, orchestration: { runId: 'abc123', role: 'worker', workerId: 'w1', runDir } } }),
  ]));
  fs.writeFileSync(path.join(data, 'cli-history.json'), JSON.stringify([{ id: ids.paused, cwd, settings: {}, paused: true, pausedAt: 1 }]));
  if (reopen) fs.writeFileSync(path.join(data, 'app-prefs.json'), JSON.stringify({ cliReopenTabsAtBoot: true }));

  const script = `
    const M = require(${JSON.stringify(path.join(CORE, 'src', 'cli-sessions.js'))});
    const mgr = new M(1, { broadcast() {} }, { deleteSessionData() {} });
    const restored = [];
    mgr._restoreOne = (e) => restored.push(e.sessId);
    const boot = mgr.bootOpenTabs();
    setTimeout(() => {
      const saved = mgr.getSavedSessions();
      process.stdout.write(JSON.stringify({ boot, restored, saved, manifest: require('fs').readFileSync(${JSON.stringify(path.join(data, 'cli-open-tabs.json'))}, 'utf8') }));
      process.exit(0);
    }, 1200);`;
  const r = spawnSync('node', ['-e', script], { env: { ...process.env, VISTACLAIR_HOME: home, HOME: home, VISTACLAIR_DASHBOARD_PORT: '', VISTACLAIR_AUTH_TOKEN: '' }, encoding: 'utf8', timeout: 20000 });
  fs.rmSync(home, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, r.stderr);
  return { ids, ...JSON.parse(r.stdout) };
}

test('by default nothing reopens: every open tab becomes a saved session', () => {
  const { ids, boot, restored, saved, manifest } = scenario(false);
  assert.strictEqual(boot.restored, 0);
  assert.strictEqual(boot.archived, 4);
  assert.deepStrictEqual(restored, []);
  assert.deepStrictEqual(JSON.parse(manifest), []);
  const by = Object.fromEntries(saved.map(s => [s.id, s]));
  assert.strictEqual(by[ids.busy].interrupted, true, 'mid-turn at shutdown: interrupted');
  assert.strictEqual(by[ids.idle].interrupted, undefined);
  assert.strictEqual(by[ids.paused].paused, true, 'a completed pause keeps its flag');

  const w = by[ids.worker];
  assert.deepStrictEqual(w.group, { runId: 'abc123', role: 'worker', workerId: 'w1', orchestrator: 'orch-abc123', lastReport: { status: 'started', summary: 's' }, completed: false, runMissing: false });
  assert.strictEqual(w.progress.total, 2);
  assert.strictEqual(w.progress.done, 1);
  assert.strictEqual(w.progress.doing.id, '2');
  assert.strictEqual(w.progress.hasResume, true);
});

test('cliReopenTabsAtBoot reopens plain tabs only; run members and paused sessions are archived', () => {
  const { ids, boot, restored, saved } = scenario(true);
  assert.strictEqual(boot.archived, 2);
  assert.deepStrictEqual(restored.sort(), [ids.idle, ids.busy].sort());
  assert.ok(saved.some(s => s.id === ids.worker && s.group?.role === 'worker'));
});
