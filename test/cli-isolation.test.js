// Git isolation of plain CLI sessions (src/cli-isolation.js): an isolated start
// gets its own worktree and dependency links, "land" rebases, checks and
// merges like a worker's landing, close tears down (or keeps, with the reason),
// a restart aborts a landing it cut off. The real CliSessionManager with fake
// sessions, in throwaway repos under a temp VISTACLAIR_HOME; nothing spawns
// `claude`.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const dirs = [];
function tmpDir(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Before anything reads DATA_HOME or the home directory.
const HOME = tmpDir('vc-iso-home-');
process.env.VISTACLAIR_HOME = HOME;
process.env.HOME = HOME;

const CliSessionManager = require('../src/cli-sessions');
const { createCliIsolation } = require('../src/cli-isolation');

class FakeSession {
  constructor(broadcaster) {
    this.broadcaster = broadcaster;
    this.settings = {};
    this.instanceId = `cli-${crypto.randomUUID()}`;
    this.running = false;
    this.sessId = null;
    this.cwd = null;
    this.title = null;
    this._spawnGen = 0;
  }
  getSettings() { return { ...this.settings }; }
  updateSettings(s) { Object.assign(this.settings, s); }
  spawn(cwd, cols, rows, { resumeSessionId } = {}) {
    if (!fs.existsSync(cwd)) throw new Error(`no such directory ${cwd}`);
    this.cwd = cwd;
    this.sessId = resumeSessionId || crypto.randomUUID();
    this.running = true;
  }
  // A pty's exit arrives after kill returns.
  kill() {
    if (!this.running) return;
    this.running = false;
    setImmediate(() => this.broadcaster.broadcast({ type: 'cli:exit' }));
  }
}

class TestManager extends CliSessionManager {
  _createSession(tabId) {
    const s = new FakeSession(this._wrapBroadcaster(tabId));
    s.tabId = tabId;
    this.sessions.set(tabId, s);
    return s;
  }
}

function setup() {
  const broadcasts = [];
  const broadcaster = { broadcast: (m) => broadcasts.push(m) };
  const mgr = new TestManager(1, broadcaster, { deleteSessionData() {} });
  const iso = createCliIsolation({ mgr, broadcaster, dataHome: HOME });
  mgr.isolation = iso;
  const exits = [];
  mgr.addExitListener((tabId, s) => exits.push(iso.onSessionExit(tabId, s)));
  const settled = async () => { await new Promise(r => setImmediate(r)); await Promise.all(exits); };
  const saved = (sessId) => mgr.findSaved(sessId);
  return { mgr, iso, broadcasts, settled, saved };
}

// A repo on `main` with a declared dependency link (.data, gitignored) and an
// optional check.
function repoWith({ check = null } = {}) {
  const repo = tmpDir('vc-iso-repo-');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString().trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.data/\n.check-ran\n');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(repo, '.vistaclair-worktree.json'), JSON.stringify({ links: ['.data'], ...(check ? { check } : {}) }));
  g('add', '.'); g('commit', '-qm', 'init');
  fs.mkdirSync(path.join(repo, '.data'));
  fs.writeFileSync(path.join(repo, '.data', 'db.txt'), 'keep me');
  return { repo, g };
}

function commitAll(dir, files, msg = 'work') {
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', msg]);
}

let seq = 0;
function start(mgr, cwd, extra = {}) {
  const tabId = `tab-iso-${++seq}`;
  mgr.launchSession(tabId, { cwd, cols: 80, rows: 24, isolation: 'worktree', ...extra });
  const session = mgr.get(tabId);
  return { tabId, session, wt: session.getSettings().worktree };
}

test('an isolated start: its own worktree on cli/<id> from the base, links made and recorded, persisted', () => {
  const { mgr, saved } = setup();
  const { repo, g } = repoWith();
  const { session, wt } = start(mgr, repo);
  assert.match(wt.branch, /^cli\/vc-iso-repo-.+-[0-9a-f]{8}$/);
  assert.strictEqual(wt.branch, `cli/${wt.id}`);
  assert.strictEqual(wt.path, path.join(HOME, 'data', 'worktrees', 'cli', wt.id));
  assert.strictEqual(session.cwd, wt.path, 'the session runs in the worktree');
  assert.deepStrictEqual([wt.repo, wt.base, wt.cwd], [repo, 'main', repo]);
  assert.strictEqual(g('rev-parse', wt.branch), g('rev-parse', 'main'));
  const link = path.join(wt.path, '.data');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.strictEqual(fs.readlinkSync(link), path.join(repo, '.data'));
  assert.deepStrictEqual(wt.links, [{ path: link, target: path.join(repo, '.data') }]);
  assert.strictEqual(execFileSync('git', ['-C', wt.path, 'status', '--porcelain']).toString(), '', 'the link is not a change');
  assert.strictEqual(session.title, path.basename(repo), 'named after the directory asked for');
  assert.match(session.getSettings().appendSystemPrompt, new RegExp(`branch \`${wt.branch}\``));
  assert.deepStrictEqual(saved(session.sessId).settings.worktree, wt, 'the saved entry carries it');
});

test('an isolated start in a subdirectory runs in the same subdirectory of the worktree', () => {
  const { mgr } = setup();
  const { repo } = repoWith();
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'sub', 'x.txt'), 'x');
  execFileSync('git', ['-C', repo, 'add', '-A']); execFileSync('git', ['-C', repo, 'commit', '-qm', 'sub']);
  const { session, wt } = start(mgr, path.join(repo, 'sub'));
  assert.strictEqual(session.cwd, path.join(wt.path, 'sub'));
  assert.strictEqual(session.title, 'sub');
});

test('isolation outside a git repository is refused, nothing launched', () => {
  const { mgr } = setup();
  const plain = tmpDir('vc-iso-plain-');
  assert.throws(() => mgr.launchSession('tab-iso-norepo', { cwd: plain, isolation: 'worktree' }), /needs a git repository/);
  assert.strictEqual(mgr.get('tab-iso-norepo'), null);
});

test('land: rebased onto the moved base, the check run, merged --no-ff with the session title; recorded and broadcast', async () => {
  const { mgr, iso, broadcasts } = setup();
  const { repo, g } = repoWith({ check: 'test -f a.txt && touch .check-ran' });
  const { tabId, session, wt } = start(mgr, repo);
  commitAll(wt.path, { 'a.txt': 'a' });
  commitAll(repo, { 'b.txt': 'b' }, 'owner moved main');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'owner wip');
  const before = g('rev-parse', 'main');

  const r = await iso.land({ tabId });
  assert.strictEqual(r.outcome, 'landed', r.text);
  assert.strictEqual(g('rev-parse', 'main'), r.mergeSha);
  assert.strictEqual(r.preLandSha, before);
  assert.strictEqual(g('rev-parse', 'main^1'), before);
  assert.strictEqual(g('rev-parse', 'main^2'), g('rev-parse', wt.branch), 'its branch, rebased');
  assert.strictEqual(g('log', '-1', '--format=%s', 'main'), `Merge ${wt.branch}: ${session.title}`);
  assert.ok(fs.existsSync(path.join(repo, 'a.txt')));
  assert.ok(fs.existsSync(path.join(wt.path, '.check-ran')), 'the check ran in the worktree');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'unrelated.txt'), 'utf8'), 'owner wip');
  assert.match(r.text, new RegExp(`^landed ${r.mergeSha.slice(0, 8)}: ${wt.branch} merged into main`));

  const rec = session.getSettings().worktree;
  assert.deepStrictEqual([rec.lastLanding.outcome, rec.lastLanding.mergeSha], ['landed', r.mergeSha]);
  assert.deepStrictEqual(rec.landings.map(l => l.mergeSha), [r.mergeSha]);
  assert.ok(fs.existsSync(wt.path), 'a running session keeps its worktree');
  const b = broadcasts.find(m => m.type === 'cli:landing');
  assert.deepStrictEqual([b.tabId, b.outcome, b.mergeSha], [tabId, 'landed', r.mergeSha]);

  const again = await iso.land({ tabId });
  assert.strictEqual(again.outcome, 'nothing', 'nothing new: a no-op');
  assert.strictEqual(g('rev-parse', 'main'), r.mergeSha);
});

test('land: a conflict aborts the rebase and leaves the base untouched; uncommitted changes stop it', async () => {
  const { mgr, iso } = setup();
  const { repo, g } = repoWith();
  const { tabId, wt } = start(mgr, repo);
  commitAll(wt.path, { 'f.txt': 'one\nTWO-session\nthree\n' });
  commitAll(repo, { 'f.txt': 'one\nTWO-owner\nthree\n' }, 'owner edit');
  const main = g('rev-parse', 'main');
  const tip = g('rev-parse', wt.branch);

  const r = await iso.land({ tabId });
  assert.strictEqual(r.outcome, 'conflict');
  assert.deepStrictEqual(r.files, ['f.txt']);
  assert.match(r.text, /rebase was aborted, main is untouched/);
  assert.strictEqual(g('rev-parse', 'main'), main, 'base untouched');
  assert.strictEqual(g('rev-parse', wt.branch), tip, 'branch as it was');
  assert.strictEqual(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'one\nTWO-owner\nthree\n');
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'worktrees', wt.id, 'rebase-merge')), 'no rebase left in progress');

  fs.writeFileSync(path.join(wt.path, 'wip.txt'), 'wip');
  const d = await iso.land({ tabId });
  assert.strictEqual(d.outcome, 'dirty');
  assert.deepStrictEqual(d.files, ['?? wip.txt']);
});

test('close without land keeps an unmerged worktree with the reason; landing it later from its saved entry tears it down', async () => {
  const { mgr, iso, broadcasts, settled, saved } = setup();
  const { repo, g } = repoWith();
  const { tabId, session, wt } = start(mgr, repo);
  const sessId = session.sessId;
  commitAll(wt.path, { 'a.txt': 'a' });

  mgr.remove(tabId);
  await settled();
  assert.ok(fs.existsSync(wt.path), 'kept');
  const rec = saved(sessId).settings.worktree;
  assert.match(rec.kept.reason, new RegExp(`branch ${wt.branch} is not merged into main`));
  assert.ok(!rec.removed);
  const b = broadcasts.find(m => m.type === 'cli:worktree');
  assert.deepStrictEqual([b.removed, b.path], [false, wt.path]);
  assert.match(b.kept, /not merged/);

  const r = await iso.land({ sessId });
  assert.strictEqual(r.outcome, 'landed', r.text);
  assert.ok(!fs.existsSync(wt.path), 'landed after its close: the worktree goes');
  assert.ok(!g('branch', '--list', wt.branch), 'branch deleted');
  const after = saved(sessId).settings.worktree;
  assert.ok(after.removed && !after.kept);
  assert.strictEqual(after.lastLanding.mergeSha, r.mergeSha);
});

test('close after land tears down: links unlinked, their target intact, branch deleted; a resume brings the worktree back', async () => {
  const { mgr, iso, settled, saved } = setup();
  const { repo, g } = repoWith();
  const { tabId, session, wt } = start(mgr, repo);
  const sessId = session.sessId;
  commitAll(wt.path, { 'a.txt': 'a' });
  assert.strictEqual((await iso.land({ tabId })).outcome, 'landed');

  session.kill();          // the session exits by itself
  await settled();
  assert.ok(!fs.existsSync(wt.path), 'removed');
  assert.ok(!g('branch', '--list', wt.branch), 'branch deleted');
  assert.strictEqual(fs.readFileSync(path.join(repo, '.data', 'db.txt'), 'utf8'), 'keep me', 'the link target is untouched');
  assert.ok(saved(sessId).settings.worktree.removed);

  // Resumed: the worktree comes back at the same path, links again.
  const entry = saved(sessId);
  const back = mgr.getOrCreate('tab-iso-resume');
  back.updateSettings(entry.settings);
  mgr.spawn('tab-iso-resume', entry.cwd, 80, 24, { resumeSessionId: sessId });
  assert.ok(fs.existsSync(wt.path));
  assert.strictEqual(execFileSync('git', ['-C', wt.path, 'rev-parse', '--abbrev-ref', 'HEAD']).toString().trim(), wt.branch);
  const rec = back.getSettings().worktree;
  assert.ok(!rec.removed);
  assert.ok(fs.lstatSync(path.join(wt.path, '.data')).isSymbolicLink());
});

test('land on close (asked at start): the close lands, then tears down', async () => {
  const { mgr, settled, saved } = setup();
  const { repo, g } = repoWith();
  const { tabId, session, wt } = start(mgr, repo, { landOnClose: true, title: 'fix the parser' });
  assert.strictEqual(wt.landOnClose, true);
  commitAll(wt.path, { 'a.txt': 'a' });
  mgr.remove(tabId);
  await settled();
  assert.strictEqual(g('log', '-1', '--format=%s', 'main'), `Merge ${wt.branch}: fix the parser`);
  assert.ok(!fs.existsSync(wt.path));
  assert.strictEqual(saved(session.sessId).settings.worktree.lastLanding.outcome, 'landed');
});

test('a server shutdown tears nothing down; a restart aborts the landing it cut off and records it', async () => {
  const { mgr, iso, settled, saved } = setup();
  const { repo, g } = repoWith();
  const { session, wt } = start(mgr, repo);
  const sessId = session.sessId;
  commitAll(wt.path, { 'f.txt': 'one\nTWO-session\nthree\n' });
  commitAll(repo, { 'f.txt': 'one\nTWO-owner\nthree\n' }, 'owner edit');
  const main = g('rev-parse', 'main');

  mgr.saveAllToHistory();
  mgr.killAll();
  await settled();
  assert.ok(fs.existsSync(wt.path), 'kept over a shutdown');
  assert.ok(!saved(sessId).settings.worktree.kept, 'no teardown ran');

  // The process died mid-rebase: a conflicted rebase in the worktree and the
  // in-flight marker on disk.
  try { execFileSync('git', ['-C', wt.path, 'rebase', 'main'], { stdio: 'pipe' }); } catch {}
  assert.ok(fs.existsSync(path.join(repo, '.git', 'worktrees', wt.id, 'rebase-merge')));
  fs.writeFileSync(path.join(HOME, 'data', 'cli-landings.json'), JSON.stringify({ [wt.id]: { sessId, repo, path: wt.path, branch: wt.branch, base: 'main' } }));

  const out = iso.recover();
  assert.strictEqual(out.length, 1);
  assert.match(out[0].text, /cut off by a restart \(rebase aborted\); main is as before/);
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'worktrees', wt.id, 'rebase-merge')), 'rebase aborted');
  assert.strictEqual(g('rev-parse', 'main'), main);
  assert.ok(fs.existsSync(wt.path), 'the worktree stays');
  assert.strictEqual(saved(sessId).settings.worktree.lastLanding.outcome, 'interrupted');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(HOME, 'data', 'cli-landings.json'), 'utf8')), {});
  assert.deepStrictEqual(iso.recover(), [], 'once');
});

test('a non-isolated session is unaffected: its own directory, no worktree, nothing at close; land refuses it', async () => {
  const { mgr, iso, broadcasts, settled, saved } = setup();
  const { repo, g } = repoWith();
  const worktreesBefore = g('worktree', 'list');
  mgr.launchSession('tab-iso-plain', { cwd: repo, cols: 80, rows: 24 });
  const session = mgr.get('tab-iso-plain');
  assert.strictEqual(session.cwd, repo);
  assert.ok(!session.getSettings().worktree);
  assert.ok(!session.getSettings().appendSystemPrompt);
  assert.strictEqual(g('worktree', 'list'), worktreesBefore);
  const r = await iso.land({ tabId: 'tab-iso-plain' });
  assert.strictEqual(r.outcome, 'error');
  assert.match(r.text, /not started with isolation "worktree"/);
  const sessId = session.sessId;
  mgr.remove('tab-iso-plain');
  await settled();
  assert.ok(!saved(sessId).settings.worktree);
  assert.ok(!broadcasts.some(m => m.type === 'cli:worktree' || m.type === 'cli:landing'));
});

test('openCli: a simple session passes isolation through; unasked, none', async () => {
  const { mgr } = setup();
  const { repo } = repoWith();
  const { createOrchestration } = require('../src/orchestration');
  const orch = createOrchestration({
    mgr, broadcaster: { broadcast() {} }, pendingQuestions: new Map(), coreRoot: path.join(__dirname, '..'), dataHome: HOME,
    credentials: () => ({ apiKey: true, subscription: false }), models: () => [],
  });
  const r = await orch.openCli({ cwd: repo, mode: 'simple', engine: 'cli', isolation: 'worktree', landOnClose: true });
  const wt = mgr.get(r.tabId).getSettings().worktree;
  assert.ok(wt && wt.landOnClose, 'isolated');
  assert.strictEqual(mgr.get(r.tabId).cwd, wt.path);
  const plain = await orch.openCli({ cwd: repo, mode: 'simple', engine: 'cli' });
  assert.ok(!mgr.get(plain.tabId).getSettings().worktree, 'not asked: not isolated');
});
