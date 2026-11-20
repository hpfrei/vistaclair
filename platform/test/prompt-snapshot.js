// The normal (non-orchestration) Extend prompt, rendered against a fixed fixture
// app with the machine-dependent inputs stubbed. Shared by test/gen-fixtures.js
// (writes test/fixtures/prompt-extend-*.txt) and test/lean-worker-prompt.test.js
// (asserts the prompt still equals them byte for byte).
const fs = require('fs');
const os = require('os');
const path = require('path');

// A tmp apps dir with one app: a manifest, an APP.md, a few files. Returns
// { root, restore } — restore() puts the stubs and the apps dir back.
function fixtureApp(name = 'fx-snap') {
  const appManager = require('../src/apps/app-manager');
  const envDetect = require('../src/apps/env-detect');
  const extras = require('../src/apps/platform-extras');
  const root = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-snap-'));
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name, description: 'snapshot fixture' }));
  fs.writeFileSync(path.join(dir, 'APP.md'), `# ${name}\n\nSNAPSHOT-APP-MD-MARKER: a fixture app.\n`);
  fs.writeFileSync(path.join(dir, 'routes.js'), 'module.exports = () => {};\n');
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<html></html>\n');
  const prevDir = appManager.APPS_DIR;
  const saved = { detect: envDetect.detect, summary: envDetect.summary, list: extras.list };
  appManager.setAppsDir(root);
  envDetect.detect = () => ({ hasSudo: true });
  envDetect.summary = () => 'ENV-STUB';
  extras.list = () => [{ id: 'x', installed: true }];
  return {
    root, dir, name,
    restore() {
      appManager.setAppsDir(prevDir);
      Object.assign(envDetect, { detect: saved.detect, summary: saved.summary });
      extras.list = saved.list;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

// request text -> prompt, for the two cases that differ: no keyword (no section
// inlined) and a keyword (the Maps section inlined).
const CASES = { 'prompt-extend-plain.txt': '', 'prompt-extend-maps.txt': 'show a map with a route to the place' };

function extendPrompts(buildOpts = {}) {
  const promptBuilder = require('../src/apps/app-builder-prompt');
  const fx = fixtureApp();
  try {
    const out = {};
    for (const [file, userRequest] of Object.entries(CASES)) {
      out[file] = promptBuilder.buildPrompt('extend', { appName: fx.name, description: 'snapshot fixture', userRequest, ...buildOpts });
    }
    return out;
  } finally { fx.restore(); }
}

module.exports = { fixtureApp, extendPrompts, CASES };
