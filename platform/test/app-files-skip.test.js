// listAppFiles — what snapshots and the session prompt's file list see — skips
// build output that announces itself with a CACHEDIR.TAG (a crate's target/),
// at any depth, whatever the app-root .gitignore says.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appManager = require('../src/apps/app-manager');

test('a directory carrying CACHEDIR.TAG is not listed; a plain target/ is', (t) => {
  const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-files-skip-'));
  t.after(() => fs.rmSync(appsDir, { recursive: true, force: true }));
  appManager.setAppsDir(appsDir);
  const app = path.join(appsDir, 'rusty');
  const put = (rel, body = 'x') => {
    fs.mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    fs.writeFileSync(path.join(app, rel), body);
  };
  put('manifest.json', JSON.stringify({ name: 'rusty', description: 'x' }));
  put('native/Cargo.toml');
  put('native/src/lib.rs');
  put('native/target/CACHEDIR.TAG', 'Signature: 8a477f597d28d172789f06886806bc55\n');
  put('native/target/release/libkernels.so');
  put('target/notes.md');
  assert.deepEqual(appManager.listAppFiles('rusty').sort(),
    ['manifest.json', 'native/Cargo.toml', 'native/src/lib.rs', 'target/notes.md']);
});
