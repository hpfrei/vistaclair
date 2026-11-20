// cli.workspace: an app opens a Claude session in one of its workspaces. The
// regressions this guards are the ones that lose work or leak scope: a folder
// outside `workspaces/`, a relaunch over a running session (core's spawn kills
// the pty it replaces), a session that outlives its app, and one app
// interrupting another's tab.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const apps = require('../src/apps/index');
const appManager = require('../src/apps/app-manager');
const appLifecycle = require('../src/apps/app-lifecycle');
const cliWorkspace = require('../src/apps/cli-workspace');
const { SESSION_STAMPS } = require('../src/apps/app-change-requests');

const PREAMBLE = fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'prompts', '_workspace-preamble.md'), 'utf-8');
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// A stand-in session manager with core's shape: `sessions` holds every tab,
// hidden ones included; one exit callback per tab, cleared when it fires.
function harness({ workspaces = ['scene'] } = {}) {
  const appsDir = tmp('vc-ws-apps-');
  for (const name of ['wsapp', 'other']) {
    fs.mkdirSync(path.join(appsDir, name), { recursive: true });
    fs.writeFileSync(path.join(appsDir, name, 'manifest.json'), JSON.stringify({ name, description: 'x' }));
  }
  for (const w of workspaces) fs.mkdirSync(path.join(appsDir, 'wsapp', 'workspaces', w), { recursive: true });

  const state = { appsDir, launches: [], writes: [], killed: [], removed: [], broadcasts: [], sent: [], exitCbs: new Map() };
  const sessions = new Map();
  const session = (tabId, o) => ({
    tabId, cwd: o.cwd, hidden: !!o.hidden, running: true, settings: { ...(o.settings || {}) },
    getSettings() { return { ...this.settings }; },
  });
  const csm = {
    sessions,
    list: () => [...sessions.values()].filter((s) => !s.hidden),
    get: (id) => sessions.get(id) || null,
    launchSession: (tabId, o) => { state.launches.push({ tabId, o }); sessions.set(tabId, session(tabId, o)); },
    onExit: (tabId, cb) => state.exitCbs.set(tabId, cb),
    kill: (id) => { state.killed.push(id); const s = sessions.get(id); if (s) s.running = false; },
    remove: (id) => { state.removed.push(id); sessions.delete(id); },
    write: (id, data) => state.writes.push({ id, data }),
    writeWhenReady: (id, data, delay) => state.writes.push({ id, data, delay }),
  };
  state.sessions = sessions;
  state.addSession = (tabId, o) => sessions.set(tabId, session(tabId, o));
  // Fire a tab's exit the way core does: drop the session, run the one callback.
  state.exit = (id) => {
    sessions.delete(id);
    const cb = state.exitCbs.get(id);
    state.exitCbs.delete(id);
    if (cb) cb(id);
  };
  const broadcaster = { broadcast: (m) => state.broadcasts.push(m) };
  apps.initSessions({ appsDir, proxyPort: 0, broadcaster, cliSessionManager: csm });
  const ws = { send: (s) => state.sent.push(JSON.parse(s)) };
  state.bridge = async (method, params, name = 'wsapp') => {
    const before = state.sent.length;
    await apps.handleMessage(ws, { type: 'app:bridge', name, id: 1, method, params }, broadcaster);
    return state.sent.slice(before);
  };
  state.call = async (method, params, name) => (await state.bridge(method, params, name)).find((m) => m.type === 'app:bridge:response');
  state.events = (state_) => state.broadcasts.filter((m) => m.type === 'app:bridge:event' && m.event === 'cli:workspace'
    && (!state_ || m.data.state === state_));
  state.real = (w = 'scene') => fs.realpathSync(path.join(appsDir, 'wsapp', 'workspaces', w));
  return state;
}

const OPEN = { dir: 'scene', title: 'Scene', instructions: 'Render the scene with Blender.' };

test('the folder is one name under workspaces/, real, and a directory', async () => {
  const h = harness();
  const outside = tmp('vc-ws-outside-');
  fs.symlinkSync(outside, path.join(h.appsDir, 'wsapp', 'workspaces', 'escape'));
  fs.writeFileSync(path.join(h.appsDir, 'wsapp', 'workspaces', 'file'), 'x');
  const err = async (params) => (await h.call('cli.workspace', { ...OPEN, ...params })).error;
  assert.match(await err({ dir: '..' }), /one workspace name/);
  assert.match(await err({ dir: '../other' }), /one workspace name/);
  assert.match(await err({ dir: 'a/b' }), /one workspace name/);
  assert.match(await err({ dir: 'Scene' }), /one workspace name/);
  assert.match(await err({ dir: 'missing' }), /does not exist/);
  assert.match(await err({ dir: 'escape' }), /outside workspaces\//);
  assert.match(await err({ dir: 'file' }), /not a directory/);
  assert.equal(h.launches.length, 0);
});

test('title and instructions are required, instructions are capped, hidden needs autoSubmit', async () => {
  const h = harness();
  const err = async (params) => (await h.call('cli.workspace', { ...OPEN, ...params })).error;
  assert.match(await err({ title: '' }), /title is required/);
  assert.match(await err({ instructions: undefined }), /instructions are required/);
  assert.match(await err({ instructions: 'x'.repeat(cliWorkspace.INSTRUCTIONS_MAX + 1) }), /exceed 32 KB/);
  assert.match(await err({ hidden: true }), /hidden requires autoSubmit/);
  assert.equal(h.launches.length, 0);
});

test('a launch: ws- tab id, realpath cwd and stamps, resume, preamble first, CLAUDE.md excluded', async () => {
  const h = harness();
  const res = await h.call('cli.workspace', { ...OPEN, prompt: 'go', autoSubmit: true });
  assert.deepEqual(res.result, { tabId: 'ws-wsapp.scene', dir: 'scene', reused: false });
  assert.equal(h.launches.length, 1);
  const { tabId, o } = h.launches[0];
  assert.equal(tabId, 'ws-wsapp.scene');
  assert.equal(o.cwd, h.real());
  assert.equal(o.settings[SESSION_STAMPS.workspace], 'wsapp');
  assert.equal(o.settings[SESSION_STAMPS.workspaceDir], h.real());
  assert.equal(o.settings[SESSION_STAMPS.app], undefined, 'not an app change session');
  assert.deepEqual(o.spawnOpts, { resume: true });
  assert.equal(o.prompt, 'go');
  assert.equal(o.autoSubmit, true);
  assert.equal(o.hidden, false);
  const expected = PREAMBLE.trim().replace(/\{\{APP\}\}/g, 'wsapp').replace(/\{\{DIR\}\}/g, h.real());
  assert.ok(o.settings.appendSystemPrompt.startsWith(expected + '\n\n'));
  assert.ok(o.settings.appendSystemPrompt.endsWith(OPEN.instructions));
  assert.match(o.settings.appendSystemPrompt, /never call it/);
  assert.equal(o.settings.settingsFile, path.join(h.appsDir, 'wsapp', '.data', 'workspaces', 'scene', 'settings.json'));
  const settings = JSON.parse(fs.readFileSync(o.settings.settingsFile, 'utf-8'));
  assert.ok(settings.claudeMdExcludes.includes(path.join(h.appsDir, 'CLAUDE.md')));
  assert.equal(fs.existsSync(path.join(h.appsDir, 'wsapp', '.vistaclair')), false, 'no sidecars');
});

test('started and exited reach the iframe through the broadcaster, once', async () => {
  const h = harness();
  await h.call('cli.workspace', OPEN);
  const [started] = h.events('started');
  assert.deepEqual(started, {
    type: 'app:bridge:event', appName: 'wsapp', event: 'cli:workspace',
    data: { tabId: 'ws-wsapp.scene', dir: 'scene', state: 'started', hidden: false, reused: false },
  });
  await h.call('cli.workspace', OPEN);   // reused: must not arm a second exit report
  h.exit('ws-wsapp.scene');
  assert.deepEqual(h.events('exited').map((m) => m.data), [{ tabId: 'ws-wsapp.scene', dir: 'scene', state: 'exited', hidden: false }]);
  // Nothing about the lifecycle goes to the caller's socket: it may be gone.
  assert.equal(h.sent.filter((m) => m.type === 'app:bridge:event').length, 0);
});

test('a running session is reused, never relaunched, and gets the prompt', async () => {
  const h = harness();
  await h.call('cli.workspace', OPEN);
  const res = await h.call('cli.workspace', { ...OPEN, prompt: 'next frame', autoSubmit: true });
  assert.deepEqual(res.result, { tabId: 'ws-wsapp.scene', dir: 'scene', reused: true });
  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.writes, [
    { id: 'ws-wsapp.scene', data: 'next frame', delay: undefined },
    { id: 'ws-wsapp.scene', data: '\r', delay: 400 },
  ]);
  // Without autoSubmit the prompt is typed, not submitted; without a prompt nothing is.
  h.writes.length = 0;
  await h.call('cli.workspace', { ...OPEN, prompt: 'draft' });
  await h.call('cli.workspace', OPEN);
  assert.deepEqual(h.writes.map((w) => w.data), ['draft']);
  assert.equal(h.events('started').at(-1).data.reused, true);
});

test('a restored tab is found by its stamp, and an exited one is relaunched', async () => {
  const h = harness();
  h.addSession('tab-b1-4', { cwd: h.real(), settings: { [SESSION_STAMPS.workspace]: 'wsapp', [SESSION_STAMPS.workspaceDir]: h.real() } });
  const res = await h.call('cli.workspace', OPEN);
  assert.deepEqual(res.result, { tabId: 'tab-b1-4', dir: 'scene', reused: true });
  assert.equal(h.launches.length, 0);
  assert.ok(h.exitCbs.has('tab-b1-4'));
  h.exit('tab-b1-4');
  assert.equal(h.events('exited')[0].data.tabId, 'tab-b1-4');
  assert.equal((await h.call('cli.workspace', OPEN)).result.reused, false);
  assert.equal(h.launches[0].tabId, 'ws-wsapp.scene');
});

test('a hidden session opens no tab; a visible one does', async () => {
  const h = harness({ workspaces: ['scene', 'bake'] });
  const hidden = await h.bridge('cli.workspace', { ...OPEN, prompt: 'go', autoSubmit: true, hidden: true });
  assert.equal(hidden.find((m) => m.type === 'app:bridge:response').result.tabId, 'ws-wsapp.scene');
  assert.equal(hidden.filter((m) => m.type === 'app:cliSpawned').length, 0);
  assert.equal(h.launches[0].o.hidden, true);
  assert.equal(h.events('started')[0].data.hidden, true);
  const visible = await h.bridge('cli.workspace', { ...OPEN, dir: 'bake' });
  assert.deepEqual(visible.filter((m) => m.type === 'app:cliSpawned'), [{ type: 'app:cliSpawned', appName: 'wsapp', tabId: 'ws-wsapp.bake' }]);
});

test('cli.interrupt reaches only the calling app\'s own tabs', async () => {
  const h = harness();
  await h.call('cli.workspace', OPEN);
  h.addSession('ws-other.x', { settings: { [SESSION_STAMPS.workspace]: 'other', [SESSION_STAMPS.workspaceDir]: '/x' } });
  // Change tabs core restored under a boot id keep their stamp: the app's own is reachable, another's is not.
  h.addSession('tab-b1-7', { settings: { [SESSION_STAMPS.app]: 'wsapp' } });
  h.addSession('tab-b1-8', { settings: { [SESSION_STAMPS.app]: 'other' } });
  for (const tabId of ['app-other', 'app-other-tools', 'ws-other.x', 'tab-b1-8', 'tab-b1-9']) {
    assert.match((await h.call('cli.interrupt', { tabId })).error, /not one of this app's CLI sessions/, tabId);
  }
  assert.equal(h.writes.length, 0);
  assert.deepEqual((await h.call('cli.interrupt', { tabId: 'ws-wsapp.scene', count: 2 })).result, { tabId: 'ws-wsapp.scene', sent: 2 });
  assert.equal((await h.call('cli.interrupt', {})).result.tabId, 'app-wsapp');
  assert.equal((await h.call('cli.interrupt', { tabId: 'app-wsapp-tools' })).result.tabId, 'app-wsapp-tools');
  assert.equal((await h.call('cli.interrupt', { tabId: 'tab-b1-7' })).result.tabId, 'tab-b1-7');
});

test('workspace sessions end with their app: stop, rename, delete — not a closed tab', async (t) => {
  const h = harness({ workspaces: ['scene', 'bake'] });
  await h.call('cli.workspace', OPEN);
  await h.call('cli.workspace', { ...OPEN, dir: 'bake', prompt: 'go', autoSubmit: true, hidden: true });
  h.addSession('ws-other.x', { settings: { [SESSION_STAMPS.workspace]: 'other' } });
  assert.deepEqual(cliWorkspace.workspaceSessionsOf('wsapp').map((s) => s.tabId).sort(), ['ws-wsapp.bake', 'ws-wsapp.scene']);

  const broadcaster = { broadcast() {} };
  await apps.handleMessage({ send() {} }, { type: 'app:close', name: 'wsapp' }, broadcaster);
  assert.deepEqual(h.killed, [], 'closing a tab ends nothing');
  await apps.handleMessage({ send() {} }, { type: 'app:stop', name: 'wsapp' }, broadcaster);
  assert.deepEqual(h.killed.filter((id) => id.startsWith('ws-')).sort(), ['ws-wsapp.bake', 'ws-wsapp.scene']);

  // Rename and delete go through app-lifecycle; the directory moves are stubbed.
  const { rename, remove } = appManager;
  t.after(() => { appManager.rename = rename; appManager.remove = remove; });
  appManager.rename = async (oldName, newName) => ({ ok: true, oldName, newName });
  appManager.remove = async () => ({ ok: true });
  h.killed.length = 0;
  await appLifecycle.renameApp('wsapp', 'wsapp2');
  assert.deepEqual(h.killed.sort(), ['ws-wsapp.bake', 'ws-wsapp.scene']);
  await appLifecycle.deleteApp('wsapp');
  assert.deepEqual(h.removed.sort(), ['ws-wsapp.bake', 'ws-wsapp.scene']);
  assert.ok(h.sessions.has('ws-other.x'), 'another app\'s session is untouched');
});

test('workspaces/ is not listed for snapshots or the prompt file list', () => {
  const h = harness();
  fs.writeFileSync(path.join(h.appsDir, 'wsapp', 'workspaces', 'scene', 'model.js'), 'x');
  fs.mkdirSync(path.join(h.appsDir, 'wsapp', 'lib', 'workspaces'), { recursive: true });
  fs.writeFileSync(path.join(h.appsDir, 'wsapp', 'lib', 'workspaces', 'code.js'), 'x');
  assert.deepEqual(appManager.listAppFiles('wsapp').sort(), ['lib/workspaces/code.js', 'manifest.json']);
});

test('cli.workspaces lists the calling app\'s own sessions by workspace name, restored and hidden ones included', async () => {
  const h = harness({ workspaces: ['scene', 'bake'] });
  await h.call('cli.workspace', OPEN);
  await h.call('cli.workspace', { ...OPEN, dir: 'bake', prompt: 'go', autoSubmit: true, hidden: true });
  // A tab core restored under a boot id keeps its stamps; another app's session is never listed.
  h.addSession('tab-b1-3', { settings: { [SESSION_STAMPS.workspace]: 'wsapp', [SESSION_STAMPS.workspaceDir]: h.real('scene') } });
  h.addSession('ws-other.x', { settings: { [SESSION_STAMPS.workspace]: 'other', [SESSION_STAMPS.workspaceDir]: '/x' } });
  const all = (await h.call('cli.workspaces', {})).result;
  assert.deepEqual(all.map((s) => [s.tabId, s.dir, s.running, s.hidden]).sort(), [
    ['tab-b1-3', 'scene', true, false],
    ['ws-wsapp.bake', 'bake', true, true],
    ['ws-wsapp.scene', 'scene', true, false],
  ]);
  assert.deepEqual((await h.call('cli.workspaces', { dir: 'bake' })).result.map((s) => s.tabId), ['ws-wsapp.bake']);
  h.exit('ws-wsapp.bake');
  assert.deepEqual((await h.call('cli.workspaces', { dir: 'bake' })).result, []);
  assert.match((await h.call('cli.workspaces', { dir: '../x' })).error, /one workspace name/);
});
