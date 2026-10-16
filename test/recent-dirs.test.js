// The "New CLI in directory…" recent list (src/cli-sessions.js) stays at the
// orchestrator level: no worker directories, no run worktrees, nothing deeper
// than an app in vistaclair-apps.
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');

// Before cli-sessions reads them: a throwaway data home and apps directory.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-recent-')));
const APPS = path.join(HOME, 'vistaclair-apps');
process.env.VISTACLAIR_HOME = HOME;
process.env.VISTACLAIR_APPS_DIR = APPS;

const test = require('node:test');
const assert = require('node:assert');
const CliSessionManager = require('../src/cli-sessions');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const RECENT = path.join(HOME, 'data', 'cli-recent-dirs.json');
const paths = (mgr) => mgr.getRecentDirs().map(d => d.path);

test('recent dirs: apps at app level, worktrees and workers left out, others as is', () => {
  const mgr = new CliSessionManager(0, { broadcast() {} }, {});
  const other = path.join(HOME, 'elsewhere', 'deep', 'dir');
  mgr.saveToHistory({ sessId: 's1', cwd: other, settings: {} });
  mgr.saveToHistory({ sessId: 's2', cwd: path.join(APPS, 'my-app', 'src', 'lib'), settings: {} });
  mgr.saveToHistory({ sessId: 's3', cwd: path.join(HOME, 'data', 'worktrees', 'abc123', 'w1', 'my-app'), settings: {} });
  mgr.saveToHistory({ sessId: 's4', cwd: path.join(HOME, 'worker-target'), settings: { orchestration: { role: 'worker' } } });
  mgr.saveToHistory({ sessId: 's5', cwd: APPS, settings: { orchestration: { role: 'orchestrator' } } });
  assert.deepStrictEqual(paths(mgr), [APPS, path.join(APPS, 'my-app'), other]);
});

test('recent dirs written before the rule are mapped on read, and a delete removes the merged entries', () => {
  fs.writeFileSync(RECENT, JSON.stringify([
    { path: path.join(HOME, 'data', 'worktrees', 'r1', 'w2', 'app-a'), lastUsedAt: 5 },
    { path: path.join(APPS, 'app-a', 'web'), lastUsedAt: 4 },
    { path: path.join(APPS, 'app-a'), lastUsedAt: 3 },
    { path: path.join(APPS, 'app-b'), lastUsedAt: 2 },
  ]));
  const mgr = new CliSessionManager(0, { broadcast() {} }, {});
  assert.deepStrictEqual(paths(mgr), [path.join(APPS, 'app-a'), path.join(APPS, 'app-b')]);
  mgr.deleteRecentDir(path.join(APPS, 'app-a'));
  assert.deepStrictEqual(paths(mgr), [path.join(APPS, 'app-b')]);
});
