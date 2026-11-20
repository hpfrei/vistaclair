// The dashboard's tool counts (app card → Tools) come from app:tools:updated.
// Pro's apps.js loads after the socket opens, so the copies sent on connect
// can be dropped; its own app:list request must bring the tool lists back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const apps = require('../src/apps/index');
const appTools = require('../src/apps/app-tools');

const appsDir = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-tools-gui-'));
test.after(() => {
  appTools.clearAppTools('live-app');
  fs.rmSync(appsDir, { recursive: true, force: true });
});

test('app:list request re-sends every app\'s tool list', async () => {
  const manifests = {
    'live-app': { name: 'live-app', description: 'x' },
    'stopped-app': { name: 'stopped-app', description: 'x', tools: [{ name: 'make', expose: 'apps', kind: 'job' }] },
    'no-tools': { name: 'no-tools', description: 'x' },
  };
  for (const [name, m] of Object.entries(manifests)) {
    fs.mkdirSync(path.join(appsDir, name), { recursive: true });
    fs.writeFileSync(path.join(appsDir, name, 'manifest.json'), JSON.stringify(m));
  }
  apps.initSessions({ appsDir, broadcaster: { broadcast() {} } });
  appTools.registerAppTools('live-app', [{ name: 'make_model', expose: 'apps', kind: 'job' }]);

  const sent = [];
  await apps.handleMessage({ send: (s) => sent.push(JSON.parse(s)) }, { type: 'app:list' }, { broadcast() {} });

  assert.ok(sent.some((m) => m.type === 'app:list'));
  const tools = Object.fromEntries(sent.filter((m) => m.type === 'app:tools:updated').map((m) => [m.appName, m.tools.map((t) => t.name)]));
  assert.deepEqual(tools, { 'live-app': ['make_model'], 'stopped-app': ['make'] });
});
