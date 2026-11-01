// Load order of the session modules: a circular require leaves a destructured
// import undefined, and only the entry point decides which one. Each module is
// loaded first in its own process, since require's cache hides the order here.
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-module-load-')));

const test = require('node:test');
const assert = require('node:assert');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

for (const mod of ['proxy', 'sdk-session', 'run-summary', 'inspector-sessions']) {
  test(`src/${mod} loaded first: no import cut short by a circular require`, () => {
    const res = spawnSync(process.execPath, ['-e', `require('./src/${mod}')`], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, VISTACLAIR_HOME: HOME },
      encoding: 'utf-8',
    });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /circular dependency/);
  });
}
