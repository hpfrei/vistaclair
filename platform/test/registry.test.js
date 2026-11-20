const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PRO = path.join(__dirname, '..');
const capabilities = require('../src/apps/capabilities');

test('registry loads every module in ORDER', () => {
  const dirKeys = fs.readdirSync(path.join(PRO, 'src/apps/capabilities')).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(dirKeys, capabilities.ORDER.slice().sort());
  assert.equal(capabilities.all().length, 44);
  assert.deepEqual(capabilities.all().map((c) => c.key), capabilities.ORDER);
});

test('every declared method dispatches unless external', () => {
  for (const cap of capabilities.all()) {
    for (const m of cap.methods) {
      if (cap.external) assert.equal(capabilities.dispatch(m), null, `${m} is external`);
      else assert.equal(typeof capabilities.dispatch(m), 'function', `${m} has no handler`);
    }
    for (const m of Object.keys(cap.bridge || {})) {
      assert.ok(cap.methods.includes(m), `${cap.key} dispatches undeclared ${m}`);
    }
  }
  assert.equal(capabilities.dispatch('nope'), null);
});

test('method classification and gating', () => {
  assert.equal(capabilities.capabilityKeyForMethod('calendar.move'), 'calendar');
  assert.equal(capabilities.capabilityKeyForMethod('telegram.sendAudio'), 'telegram');
  assert.equal(capabilities.capabilityKeyForMethod('ai.music.generate'), 'music');
  assert.equal(capabilities.capabilityKeyForMethod('platform.cron.list'), 'platform-cron');
  assert.equal(capabilities.gatingCapabilityForMethod('toast.show'), null);
  assert.equal(capabilities.gatingCapabilityForMethod('jobs.list'), null);
  assert.equal(capabilities.gatingCapabilityForMethod('telegram.send'), 'telegram');
  assert.equal(capabilities.gatingCapabilityForMethod('capabilities.list'), null);
});

test('declaration satisfaction: aliases and implied capabilities', () => {
  assert.ok(capabilities.declarationSatisfies({ ai: true }, 'maps'));
  assert.ok(capabilities.declarationSatisfies({ ai: true }, 'audio'));
  assert.ok(capabilities.declarationSatisfies({ cron: true }, 'platform-cron'));
  assert.ok(capabilities.declarationSatisfies({ license: true }, 'licensing'));
  assert.ok(!capabilities.declarationSatisfies({ db: true }, 'telegram'));
  const known = capabilities.knownDeclarationKeys();
  for (const cap of capabilities.all()) {
    if (!cap.gated) continue;
    assert.ok(known.has(cap.key), `${cap.key} gates methods but is not declarable`);
  }
});

test('metadata invariants the loader enforces', () => {
  for (const cap of capabilities.all()) {
    assert.ok(Object.isFrozen(cap));
    assert.ok(!('public' in cap.visibility), 'the public profile is gone');
    assert.ok([true, false, 'partial'].includes(cap.visibility.standalone));
    assert.equal(typeof cap.revocable, 'boolean');
    if (cap.ctx.length) assert.equal(typeof cap.buildCtx, 'function', `${cap.key} lists ctx but has no buildCtx`);
    else assert.equal(cap.buildCtx, undefined, `${cap.key} has buildCtx but lists no ctx`);
  }
});

function loadWithDir(dir) {
  try {
    execFileSync(process.execPath, ['-e', "require('./src/apps/capabilities')"], {
      cwd: PRO, env: { ...process.env, VISTACLAIR_CAPABILITIES_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return null;
  } catch (err) {
    return String(err.stderr);
  }
}

// Copies live next to the real modules so their relative requires still resolve.
function tempModulesDir() {
  return fs.mkdtempSync(path.join(PRO, 'src/apps', '.caps-test-'));
}

test('a directory that disagrees with ORDER refuses to boot', () => {
  const tmp = tempModulesDir();
  const src = path.join(PRO, 'src/apps/capabilities');
  for (const f of fs.readdirSync(src)) if (f !== 'sysmon.js') fs.copyFileSync(path.join(src, f), path.join(tmp, f));
  const err = loadWithDir(tmp);
  assert.match(err, /disagrees with ORDER/);
  assert.match(err, /missing: sysmon/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a malformed module refuses to boot and names the file', () => {
  const tmp = tempModulesDir();
  const src = path.join(PRO, 'src/apps/capabilities');
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
  // Modules require their siblings by relative path; keep those resolvable.
  fs.writeFileSync(path.join(tmp, 'ui.js'), "module.exports = { key: 'ui', title: 'x', summary: 'x', core: true, gated: 'no' };\n");
  const err = loadWithDir(tmp);
  assert.match(err, /capabilities\/ui\.js: "gated" must be a boolean/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
