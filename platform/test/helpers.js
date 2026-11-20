// Shared test scaffolding: a throwaway apps dir with a few apps, wired into
// app-manager so mountRoutes / handleBridgeCall resolve against it.
const fs = require('fs');
const os = require('os');
const path = require('path');

function silenceWarn(fn) {
  const orig = console.warn;
  const captured = [];
  console.warn = (...a) => captured.push(a.join(' '));
  return Promise.resolve().then(fn).finally(() => { console.warn = orig; }).then((r) => ({ result: r, warnings: captured }));
}

function makeAppsDir(apps) {
  const dir = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-test-'));
  for (const [name, manifest] of Object.entries(apps)) {
    const d = path.join(dir, name);
    fs.mkdirSync(path.join(d, 'public'), { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ name, ...manifest }, null, 2));
    fs.writeFileSync(path.join(d, 'routes.js'), 'module.exports = (router, ctx) => { global.__testCtx = ctx; };\n');
  }
  return dir;
}

// Promise-shaped handleBridgeCall: resolves with the single response object.
function call(appBridge, appName, method, params, onEvent) {
  return new Promise((resolve, reject) => {
    let responses = 0;
    appBridge.handleBridgeCall(appName, { id: 'x', method, params }, (r) => {
      responses++;
      if (responses > 1) reject(new Error(`second response for ${method}`));
      else resolve(r);
    }, onEvent || (() => {}));
  });
}

module.exports = { silenceWarn, makeAppsDir, call };
