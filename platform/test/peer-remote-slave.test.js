// Remote sessions, slave side (peer-remote-slave.js) and the channel helpers
// both halves use (peer-channel.js): the opt-in, the TLS rule, the op
// allowlist and argument checks, billing without fallback, the caps, remote-
// only ops, relayed events and asks, the snapshot's `claude` block, the
// upgrade's auth-failure limiter and the master's command correlation.
// Everything runs against fakes in a temp apps dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const hostConfig = require('../src/apps/host-config');
const pairing = require('../src/apps/peer-pairing');
const peerChannel = require('../src/apps/peer-channel');
const remote = require('../src/apps/peer-remote-slave');

const appsDir = makeAppsDir({ 'my-app': {}, 'other-app': {} });
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-outside-'));
const fakePro = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-pro-'));
fs.writeFileSync(path.join(outside, 'manifest.json'), '{}');
fs.writeFileSync(path.join(fakePro, 'manifest.json'), '{}');
fs.symlinkSync(outside, path.join(appsDir, 'escape'));
fs.symlinkSync(fakePro, path.join(appsDir, 'pro-link'));
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-data-'));
const auditFile = path.join(dataHome, 'remote-sessions', 'audit.jsonl');
appManager.setAppsDir(appsDir);
hostConfig.init(appsDir, { dataHome });
hostConfig.setRole('slave');
hostConfig.setSlave({ name: 's1', publicUrl: 'https://slave.example', linkStatus: 'linked' });

const TOKEN = 'peer-token-for-tests';
pairing.init({
  appsDir,
  secretStore: {
    readSecretFile: () => ({ tokenHash: crypto.createHash('sha256').update(TOKEN).digest('hex') }),
    writeSecretFile() {},
  },
});

// --- fakes -------------------------------------------------------------------

const listeners = new Set();
const broadcasts = [];
const broadcaster = {
  broadcast(m) { broadcasts.push(m); for (const fn of listeners) fn(m); },
  onBroadcast(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

let seq = 0;
function makeSession(tabId, { cwd, settings = {}, running = true } = {}) {
  const s = {
    tabId, sessId: crypto.randomUUID(), kind: 'sdk', running, state: 'idle', costUsd: 0.5, cwd, title: tabId,
    settings: { auth: 'subscription', ...settings },
    submitted: [], authSet: [],
    getSettings() { return { ...this.settings }; },
    submit(text) { this.submitted.push(text); },
    async interrupt() { this.interrupted = true; },
    setAuth(auth, opts) { this.authSet.push({ auth, opts }); this.settings.auth = auth; return { auth, applied: 'now' }; },
    async setModel(model) { this.model = model; },
    historyPage({ limit }) { return { events: this.events.slice(-limit), hasMore: false, before: null, totals: null }; },
    events: [],
  };
  return s;
}

const sessions = new Map();
const mgr = {
  sessions,
  get: (id) => sessions.get(id) || null,
  getBySessId: (sid) => [...sessions.values()].find((s) => s.sessId === sid) || null,
  kill(id) { const s = sessions.get(id); if (s) s.running = false; },
  sessionDirOf: () => null,
};

const openCalls = [];
async function openCli(opts) {
  openCalls.push(opts);
  const tabId = `tab-${++seq}`;
  const settings = { ...opts.settings, auth: opts.auth };
  if (opts.mode === 'orchestrator') settings.orchestration = { role: 'orchestrator', runId: `run${seq}` };
  sessions.set(tabId, makeSession(tabId, { cwd: opts.cwd, settings }));
  return { tabId, mode: opts.mode, engine: 'sdk', auth: opts.auth };
}

let creds = { apiKey: true, subscription: true };
const SECRET = 'sk-ant-api03-SECRET';
const resolveAuth = (mode) => {
  if (mode === 'apikey' && creds.apiKey) return { credential: 'api-key', key: SECRET };
  if (creds.subscription) return { credential: 'subscription', key: '' };
  return creds.apiKey ? { credential: 'api-key', key: SECRET } : { credential: null, key: '' };
};
const pendingQuestions = new Map();

let frames = [];
function reset({ enabled = true, allowApiKey = false, secure = true, authInfo = {} } = {}) {
  sessions.clear();
  openCalls.length = 0;
  pendingQuestions.clear();
  broadcasts.length = 0;
  creds = { apiKey: true, subscription: true };
  try { fs.rmSync(auditFile); } catch {}
  hostConfig.setRemoteSessions({ enabled, allowApiKey });
  remote.init({
    broadcaster, cliSessionManager: mgr, openCli, pendingQuestions, clearPendingQuestionsForTab() {},
    resolveAuth, claudeAuthInfo: () => ({ hasSubscription: true, pref: 'subscription', ...authInfo }),
    appsDir, proDir: fakePro, coreDir: path.join(os.tmpdir(), 'no-core'),
  });
  frames = [];
  remote.attach({ send: (f) => frames.push(f), secure, frameCap: peerChannel.FRAME_CAP });
}

let cmdSeq = 0;
const cmd = (op, args) => remote.handleFrame({ type: 'rs:cmd', id: `c${++cmdSeq}`, op, args });
const codeOf = (reply) => (reply.ok ? 'ok' : reply.error.code);
const launchArgs = (over = {}) => ({ mode: 'simple', app: 'my-app', prompt: 'do it', auth: 'subscription', origin: { kind: 'owner' }, ...over });
const auditRows = () => {
  try { return fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; }
};

test.after(() => {
  remote.shutdown();
  peerChannel.shutdown();
  for (const d of [appsDir, outside, fakePro, dataHome]) fs.rmSync(d, { recursive: true, force: true });
});

// --- opt-in and TLS ----------------------------------------------------------

test('disabled by default: every op refuses, and a refused launch is audited', async () => {
  reset();
  hostConfig.setRemoteSessions({ enabled: false });
  assert.deepEqual(hostConfig.remoteSessions(), { enabled: false, allowApiKey: false });
  for (const op of ['list', 'launch', 'kill', 'nonsense']) {
    assert.equal(codeOf(await cmd(op, op === 'launch' ? launchArgs() : {})), 'disabled', op);
  }
  assert.equal(openCalls.length, 0);
  const rows = auditRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].app, 'my-app');
  assert.deepEqual(rows[0].result, { ok: false, code: 'disabled' });
});

test('a channel that is not TLS refuses with not-https', async () => {
  reset({ secure: false });
  assert.equal(codeOf(await cmd('list', {})), 'not-https');
  assert.equal(codeOf(await cmd('launch', launchArgs())), 'not-https');
  assert.equal(openCalls.length, 0);
});

test('channelSecure: TLS socket, or a loopback proxy saying https, and an https publicUrl', () => {
  assert.equal(remote.channelSecure({ socket: { encrypted: true }, headers: {} }), true);
  assert.equal(remote.channelSecure({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https' } }), true);
  assert.equal(remote.channelSecure({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-proto': 'http, https' } }), true, 'the proxy appended https last');
  assert.equal(remote.channelSecure({ socket: { remoteAddress: '203.0.113.9' }, headers: { 'x-forwarded-proto': 'https' } }), false, 'a remote client cannot claim https');
  assert.equal(remote.channelSecure({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), false, 'plain loopback is not TLS');
  hostConfig.setSlave({ publicUrl: 'http://slave.example' });
  try {
    assert.equal(remote.channelSecure({ socket: { encrypted: true }, headers: {} }), false, 'paired over http');
  } finally {
    hostConfig.setSlave({ publicUrl: 'https://slave.example' });
  }
});

// --- launch ------------------------------------------------------------------

test('launch: opens an SDK session on the app with the remote stamp, no billing ask', async () => {
  reset();
  const r = await cmd('launch', launchArgs({ mode: 'orchestrator', model: 'opus', title: 'Fix it', origin: { kind: 'horst', ref: 'card-1' } }));
  assert.equal(codeOf(r), 'ok');
  assert.match(r.result.tabId, /^tab-/);
  assert.ok(r.result.sessId);
  assert.ok(r.result.runId);
  const o = openCalls[0];
  const appDir = fs.realpathSync(path.join(appsDir, 'my-app'));
  assert.equal(o.engine, 'sdk');
  assert.equal(o.auth, 'subscription');
  assert.equal(o.mode, 'orchestrator');
  assert.equal(o.cwd, appDir);
  assert.equal(o.autoSubmit, true);
  assert.equal(o.runsDir, path.join(appDir, '.vistaclair', 'orchestrator'));
  assert.equal(o.settings.sessionsRoot, path.join(appDir, '.vistaclair', 'sessions'));
  assert.deepEqual(o.settings.remoteLaunch.origin, { kind: 'horst', ref: 'card-1' });
  assert.equal(o.settings.model, 'opus');
  assert.ok(!broadcasts.some((m) => m.type === 'ask:question'), 'no confirmApiKeyBilling-style ask');
  const row = auditRows()[0];
  assert.equal(row.mode, 'orchestrator');
  assert.equal(row.auth, 'subscription');
  assert.deepEqual(row.origin, { kind: 'horst', ref: 'card-1' });
  assert.equal(row.result.ok, true);
  const listed = (await cmd('list', {})).result;
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ['app', 'costUsd', 'credential', 'role', 'runId', 'sessId', 'state', 'tabId', 'title'].sort());
  assert.equal(listed[0].role, 'orchestrator');
  assert.equal(listed[0].app, 'my-app');
  assert.equal(listed[0].credential, 'subscription');
});

test('bad app and path traversal are refused', async () => {
  reset();
  for (const app of ['../my-app', 'My-App', 'nope', 'escape', 'pro-link', '', 7, 'my-app/..']) {
    assert.equal(codeOf(await cmd('launch', launchArgs({ app }))), 'bad-app', String(app));
  }
  assert.equal(openCalls.length, 0);
});

test('an explicit auth without its credential is no-credential, never the other one', async () => {
  reset({ allowApiKey: true });
  creds = { apiKey: true, subscription: false };
  assert.equal(codeOf(await cmd('launch', launchArgs({ auth: 'subscription' }))), 'no-credential');
  creds = { apiKey: false, subscription: true };
  assert.equal(codeOf(await cmd('launch', launchArgs({ auth: 'apikey' }))), 'no-credential');
  assert.equal(openCalls.length, 0);
  assert.equal(auditRows().at(-1).result.code, 'no-credential');
});

test('apikey only when the owner allowed it', async () => {
  reset({ allowApiKey: false });
  assert.equal(codeOf(await cmd('launch', launchArgs({ auth: 'apikey' }))), 'apikey-not-allowed');
  hostConfig.setRemoteSessions({ allowApiKey: true });
  const r = await cmd('launch', launchArgs({ auth: 'apikey' }));
  assert.equal(codeOf(r), 'ok');
  assert.equal(openCalls[0].auth, 'apikey');
});

test('caps: 3 live remote launches (a run once), 10 per hour', async () => {
  reset();
  const orch = await cmd('launch', launchArgs({ mode: 'orchestrator' }));
  // A worker of that run: inherits the stamp, counts with its run.
  const orchSettings = sessions.get(orch.result.tabId).getSettings();
  sessions.set('tab-worker', makeSession('tab-worker', { cwd: orchSettings.sessionsRoot, settings: { remoteLaunch: orchSettings.remoteLaunch, orchestration: { role: 'worker', runId: orch.result.runId } } }));
  assert.equal(codeOf(await cmd('launch', launchArgs())), 'ok');
  assert.equal(codeOf(await cmd('launch', launchArgs())), 'ok');
  assert.equal(codeOf(await cmd('launch', launchArgs())), 'limit', 'fourth live unit');
  assert.equal(auditRows().at(-1).result.code, 'limit');
  // Ended sessions free their slot; the hourly cap still counts them.
  for (const s of sessions.values()) s.running = false;
  for (let i = 3; i < 10; i++) {
    assert.equal(codeOf(await cmd('launch', launchArgs())), 'ok', `launch ${i + 1}`);
    for (const s of sessions.values()) s.running = false;
  }
  assert.equal(codeOf(await cmd('launch', launchArgs())), 'limit', 'eleventh in the hour');
  // A restart does not reset the hour: it is seeded from the audit file.
  remote.init({ broadcaster, cliSessionManager: mgr, openCli, resolveAuth, appsDir });
  remote.attach({ send: () => {}, secure: true });
  assert.equal(codeOf(await cmd('launch', launchArgs())), 'limit');
  assert.equal(fs.existsSync(path.join(appsDir, '.remote-sessions.jsonl')), false, 'no audit in the apps dir');
});

test('argument checks: unknown op, bad shapes, oversize prompt', async () => {
  reset();
  assert.equal(codeOf(await cmd('setRemoteSessions', { enabled: true })), 'bad-args');
  assert.equal(codeOf(await cmd('__proto__', {})), 'bad-args');
  assert.equal(codeOf(await cmd('list', [])), 'bad-args');
  assert.equal(codeOf(await cmd('launch', launchArgs({ mode: 'yolo' }))), 'bad-args');
  assert.equal(codeOf(await cmd('launch', launchArgs({ prompt: 'x'.repeat(64 * 1024 + 1) }))), 'bad-args');
  assert.equal(codeOf(await cmd('launch', launchArgs({ origin: { kind: 'peer' } }))), 'bad-args');
  assert.equal(codeOf(await cmd('launch', launchArgs({ model: 'opus; rm -rf' }))), 'bad-args');
  assert.equal(codeOf(await cmd('submit', { tabId: '../../x', text: 'hi' })), 'bad-args');
  assert.equal(await remote.handleFrame({ type: 'rs:cmd', op: 'list' }), null, 'no id, no reply');
  assert.equal(openCalls.length, 0);
});

// --- remote-only ops ---------------------------------------------------------

test('ops on a local tab are not-remote, a missing tab unknown-tab; list hides local sessions', async () => {
  reset();
  sessions.set('local-1', makeSession('local-1', { cwd: path.join(appsDir, 'my-app') }));
  for (const [op, args] of [['submit', { text: 'hi' }], ['interrupt', {}], ['kill', {}], ['subscribe', {}], ['history', {}], ['todo', {}], ['setModel', { model: 'opus' }], ['setAuth', { auth: 'subscription' }], ['unsubscribe', {}]]) {
    assert.equal(codeOf(await cmd(op, { tabId: 'local-1', ...args })), 'not-remote', op);
    assert.equal(codeOf(await cmd(op, { tabId: 'tab-none', ...args })), 'unknown-tab', op);
  }
  assert.equal(sessions.get('local-1').running, true);
  assert.deepEqual((await cmd('list', {})).result, []);
});

test('ops on a remote tab act on it', async () => {
  reset();
  const { tabId } = (await cmd('launch', launchArgs())).result;
  const s = sessions.get(tabId);
  assert.equal(codeOf(await cmd('submit', { tabId, text: 'next' })), 'ok');
  assert.deepEqual(s.submitted, ['next']);
  assert.equal(codeOf(await cmd('interrupt', { tabId })), 'ok');
  assert.equal(s.interrupted, true);
  assert.equal(codeOf(await cmd('setModel', { tabId, model: 'sonnet' })), 'ok');
  assert.equal(s.model, 'sonnet');
  assert.equal(codeOf(await cmd('setAuth', { tabId, auth: 'apikey' })), 'apikey-not-allowed');
  assert.equal(codeOf(await cmd('setAuth', { tabId, auth: 'subscription', continueTurn: true })), 'ok');
  assert.deepEqual(s.authSet, [{ auth: 'subscription', opts: { continueTurn: true } }]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-folder-'));
  fs.writeFileSync(path.join(dir, 'TODO.md'), '| id |');
  s.settings.sessionDir = dir;
  assert.deepEqual((await cmd('todo', { tabId })).result, { todo: '| id |', notes: '' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(codeOf(await cmd('kill', { tabId })), 'ok');
  assert.equal(s.running, false);
  assert.equal(codeOf(await cmd('submit', { tabId, text: 'more' })), 'unknown-tab', 'ended');
});

// --- relayed events, asks, state ----------------------------------------------

test('events: only subscribed tabs, no deltas, images stripped, oversize replaced', async () => {
  reset();
  const { tabId, sessId } = (await cmd('launch', launchArgs())).result;
  broadcaster.broadcast({ type: 'sdk:event', sessId, off: 0, ev: { sdk: { type: 'assistant' } } });
  assert.equal(frames.filter((f) => f.type === 'rs:event').length, 0, 'not subscribed yet');
  assert.equal(codeOf(await cmd('subscribe', { tabId })), 'ok');
  broadcaster.broadcast({ type: 'sdk:event', sessId, off: 10, ev: { sdk: { type: 'assistant', n: 1 } } });
  broadcaster.broadcast({ type: 'sdk:event', sessId, ev: { sdk: { type: 'stream_event' } } });
  broadcaster.broadcast({ type: 'sdk:event', sessId, off: 20, ev: { user: { id: 'u', text: 'look', images: [{ data: 'x'.repeat(1000) }] } } });
  broadcaster.broadcast({ type: 'sdk:event', sessId, off: 30, ev: { sdk: { type: 'assistant', big: 'y'.repeat(peerChannel.FRAME_CAP) } } });
  const evs = frames.filter((f) => f.type === 'rs:event');
  assert.equal(evs.length, 3);
  assert.deepEqual(evs[0], { type: 'rs:event', tabId, sessId, off: 10, ev: { sdk: { type: 'assistant', n: 1 } } });
  assert.deepEqual(evs[1].ev.user, { id: 'u', text: 'look', images: [], imagesOmitted: 1 });
  assert.deepEqual(evs[2].ev, { platform: { kind: 'notice', level: 'warning', text: 'event too large to relay' } });
  for (const f of frames) assert.ok(Buffer.byteLength(JSON.stringify(f)) <= peerChannel.FRAME_CAP);
  // A local session's events never leave.
  sessions.set('local-1', makeSession('local-1', {}));
  broadcaster.broadcast({ type: 'sdk:event', sessId: sessions.get('local-1').sessId, ev: { sdk: { type: 'assistant' } } });
  assert.equal(frames.filter((f) => f.type === 'rs:event').length, 3);
  assert.equal(codeOf(await cmd('unsubscribe', { tabId })), 'ok');
  broadcaster.broadcast({ type: 'sdk:event', sessId, off: 40, ev: { sdk: { type: 'assistant' } } });
  assert.equal(frames.filter((f) => f.type === 'rs:event').length, 3);
});

test('state and auth pushes for remote tabs only', async () => {
  reset();
  const { tabId, sessId } = (await cmd('launch', launchArgs())).result;
  broadcaster.broadcast({ type: 'cli:spawned', tabId, settings: sessions.get(tabId).getSettings() });
  broadcaster.broadcast({ type: 'cli:spawned', tabId: 'local-x', settings: {} });
  broadcaster.broadcast({ type: 'cli:exit', tabId, exitCode: 0 });
  broadcaster.broadcast({ type: 'claude-auth:needed', reason: 'authentication_failed', sessId });
  broadcaster.broadcast({ type: 'claude-auth:needed', reason: 'authentication_failed', sessId: 'not-ours' });
  const st = frames.filter((f) => f.type === 'rs:state');
  assert.deepEqual(st.map((f) => [f.tabId, f.state]), [[tabId, 'started'], [tabId, 'exited']]);
  assert.equal(st[1].costUsd, 0.5);
  assert.equal(st[1].credential, 'subscription');
  assert.equal(frames.filter((f) => f.type === 'rs:auth').length, 1);
});

test('asks: a remote tab\'s question is relayed; answer resolves only remote asks', async () => {
  reset();
  const { tabId } = (await cmd('launch', launchArgs())).result;
  sessions.set('local-1', makeSession('local-1', {}));
  const answered = {};
  const ask = (askId, tab) => {
    const message = { type: 'ask:question', askId, toolUseIds: [askId], forms: [{ toolUseId: askId, formData: {}, questions: [] }], title: 't', tabId: tab };
    pendingQuestions.set(askId, { message, ctx: { tabId: tab }, resolve: (a) => { answered[askId] = a; pendingQuestions.delete(askId); } });
    broadcaster.broadcast(message);
  };
  ask('ask-remote', tabId);
  ask('ask-local', 'local-1');
  const relayed = frames.filter((f) => f.type === 'rs:ask');
  assert.deepEqual(relayed.map((f) => f.askId), ['ask-remote']);
  assert.equal(relayed[0].tabId, tabId);
  assert.equal(codeOf(await cmd('answer', { askId: 'ask-local', answer: [{ id: 'q', answer: 'yes' }] })), 'not-remote');
  assert.equal(codeOf(await cmd('answer', { askId: 'ask-gone', answer: [] })), 'not-remote');
  assert.equal(codeOf(await cmd('answer', { askId: 'ask-remote', answer: 'yes' })), 'bad-args');
  assert.equal(answered['ask-local'], undefined);
  assert.equal(codeOf(await cmd('answer', { askId: 'ask-remote', answer: [{ id: 'q', answer: 'yes' }] })), 'ok');
  assert.deepEqual(answered['ask-remote'], [{ id: 'q', answer: 'yes' }]);
  assert.deepEqual(frames.filter((f) => f.type === 'rs:askDone'), [{ type: 'rs:askDone', askId: 'ask-remote' }]);
});

// --- snapshot ------------------------------------------------------------------

test('the snapshot\'s claude block carries status fields and flags, never a secret', () => {
  reset({ allowApiKey: true });
  broadcaster.broadcast({ type: 'claude-auth:status', status: { loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', orgName: 'Org', subscriptionType: 'max', apiProvider: 'firstParty', token: 'oauth-SECRET' } });
  const cl = remote.claudeStatus();
  assert.deepEqual(cl, {
    loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'a@b.c', orgName: 'Org',
    apiKey: true, pref: 'subscription', remoteSessions: { enabled: true, allowApiKey: true },
  });
  assert.ok(!JSON.stringify(cl).includes('SECRET'));
  const cleaned = peerChannel.cleanClaude({ ...cl, key: SECRET, apiKey: SECRET, extra: 1 });
  assert.equal(cleaned.apiKey, false, 'a non-boolean apiKey is not a key carrier');
  assert.ok(!JSON.stringify(cleaned).includes('SECRET'));
  assert.equal(cleaned.extra, undefined);
});

test('the snapshot names the account from claudeAuthInfo when the cached status has none', () => {
  reset({ authInfo: { email: 'core@b.c', orgName: 'CoreOrg' } });
  broadcaster.broadcast({ type: 'claude-auth:status', status: { loggedIn: true, authMethod: 'claude.ai' } });
  assert.deepEqual([remote.claudeStatus().email, remote.claudeStatus().orgName], ['core@b.c', 'CoreOrg']);
  broadcaster.broadcast({ type: 'claude-auth:status', status: { loggedIn: true, email: 'cached@b.c' } });
  assert.deepEqual([remote.claudeStatus().email, remote.claudeStatus().orgName], ['cached@b.c', 'CoreOrg']);
  reset();
  broadcaster.broadcast({ type: 'claude-auth:status', status: { loggedIn: true } });
  assert.deepEqual([remote.claudeStatus().email, remote.claudeStatus().orgName], [null, null]);
});

// --- channel: upgrade limiter + an end-to-end command ---------------------------

test('upgrade: bad tokens count into the per-IP auth-failure window, then 429', () => {
  const ip = '198.51.100.77';
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    let written = '';
    const socket = { write(s) { written += s; }, destroy() {} };
    const handled = peerChannel.handleUpgrade({ url: '/api/peer/channel?token=' + TOKEN, headers: {}, socket: { remoteAddress: ip } }, socket, Buffer.alloc(0));
    assert.equal(handled, true);
    statuses.push(written.split(' ')[1]);
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill('404'), 'a query-string token is not a token');
  assert.deepEqual(statuses.slice(10), ['429', '429']);
});

test('end to end over a real channel: hello carries claude, rs:cmd gets its rs:reply', async () => {
  reset({ enabled: true });
  remote.detach();
  peerChannel.init({ broadcaster });
  const WebSocket = require('ws');
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => peerChannel.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const open = (headers) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/peer/channel`, { headers });
    const got = [];
    ws.on('message', (d) => got.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({ ws, got }));
    ws.on('error', reject);
  });
  const waitFor = async (got, pred) => {
    for (let i = 0; i < 200; i++) { const m = got.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('timed out');
  };
  try {
    // A loopback proxy that terminated TLS.
    const a = await open({ 'X-Vistaclair-Peer-Token': TOKEN, 'X-Forwarded-Proto': 'https' });
    const hello = await waitFor(a.got, (m) => m.t === 'hello');
    assert.equal(hello.claude.remoteSessions.enabled, true);
    assert.ok(!JSON.stringify(hello).includes(SECRET));
    a.ws.send(JSON.stringify({ type: 'rs:cmd', id: 'e1', op: 'list', args: {} }));
    assert.deepEqual(await waitFor(a.got, (m) => m.id === 'e1'), { type: 'rs:reply', id: 'e1', ok: true, result: [] });
    a.ws.close();
    // Plain http: the same command is refused.
    const b = await open({ 'X-Vistaclair-Peer-Token': TOKEN });
    b.ws.send(JSON.stringify({ type: 'rs:cmd', id: 'e2', op: 'list', args: {} }));
    assert.equal((await waitFor(b.got, (m) => m.id === 'e2')).error.code, 'not-https');
    b.ws.close();
  } finally {
    peerChannel.shutdown();
    await new Promise((r) => server.close(r));
  }
});

// --- master half: remoteCommand -------------------------------------------------

function fakeConn(name) {
  const c = peerChannel._newConn({ name, baseUrl: 'https://s.example', token: 't' });
  const sent = [];
  c.connected = true;
  c.ws = { send: (f) => sent.push(JSON.parse(f)), terminate() {} };
  peerChannel._conns.set(name, c);
  return { c, sent };
}

test('remoteCommand: replies settle by id, errors carry the slave code', async () => {
  const { c, sent } = fakeConn('m1');
  try {
    const p1 = peerChannel.remoteCommand('m1', 'list', {});
    const p2 = peerChannel.remoteCommand('m1', 'kill', { tabId: 't' });
    assert.deepEqual(sent.map((f) => [f.type, f.op]), [['rs:cmd', 'list'], ['rs:cmd', 'kill']]);
    // Out of order, plus a stray reply for nothing pending.
    peerChannel._handleRemoteFrame(c, { type: 'rs:reply', id: 'nope', ok: true, result: 1 });
    peerChannel._handleRemoteFrame(c, { type: 'rs:reply', id: sent[1].id, ok: false, error: { code: 'not-remote', message: 'no' } });
    peerChannel._handleRemoteFrame(c, { type: 'rs:reply', id: sent[0].id, ok: true, result: [{ tabId: 'x' }] });
    assert.deepEqual(await p1, [{ tabId: 'x' }]);
    await assert.rejects(p2, (e) => e.code === 'not-remote');
    assert.equal(c.pending.size, 0);
  } finally {
    peerChannel._conns.delete('m1');
  }
});

test('remoteCommand: offline, timeout, reject-on-disconnect; pushes reach onRemoteFrame', async () => {
  await assert.rejects(peerChannel.remoteCommand('nobody', 'list', {}), (e) => e.code === 'offline');
  const { c } = fakeConn('m2');
  const keepAlive = setTimeout(() => {}, 5000);   // the command timer is unref'd
  try {
    await assert.rejects(peerChannel.remoteCommand('m2', 'list', {}, { timeoutMs: 20 }), (e) => e.code === 'timeout');
    assert.equal(c.pending.size, 0);
    const p = peerChannel.remoteCommand('m2', 'list', {});
    peerChannel._dropConn(c);
    await assert.rejects(p, (e) => e.code === 'disconnected');
    const got = [];
    const un = peerChannel.onRemoteFrame((peer, f) => got.push([peer, f.type]));
    peerChannel._handleRemoteFrame(c, { type: 'rs:event', tabId: 't', ev: {} });
    peerChannel._handleRemoteFrame(c, { type: 'rs:cmd', id: 'x', op: 'list' });
    peerChannel._handleRemoteFrame(c, { type: 'rs:state', tabId: 't', state: 'exited' });
    un();
    peerChannel._handleRemoteFrame(c, { type: 'rs:auth' });
    assert.deepEqual(got, [['m2', 'rs:event'], ['m2', 'rs:state']]);
  } finally {
    clearTimeout(keepAlive);
    peerChannel._conns.delete('m2');
  }
});

// --- attacks from the security review (F5, F8, F9, F11, F14) --------------------

// One upgrade attempt over a real socket: 'open', or the HTTP status refused.
function tryUpgrade(port, headers) {
  const WebSocket = require('ws');
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/peer/channel`, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (req, res) => { resolve(String(res.statusCode)); req.destroy(); });
    ws.on('error', () => resolve('error'));
  });
}

test('F8 upgrade: an outsider behind the loopback proxy cannot lock out the correct token', async () => {
  reset({ enabled: true });
  remote.detach();
  peerChannel.init({ broadcaster });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => peerChannel.handleUpgrade(req, socket, head));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    // The proxy appends the real client last; a client-supplied first hop is not the key.
    const attacker = { 'X-Forwarded-For': '10.9.9.9, 203.0.113.50', 'X-Forwarded-Proto': 'https' };
    const bad = [];
    for (let i = 0; i < 12; i++) bad.push(await tryUpgrade(port, { ...attacker, 'X-Vistaclair-Peer-Token': `wrong-${i}` }));
    assert.deepEqual(bad, [...Array(10).fill('404'), '429', '429'], 'bad attempts are still limited');
    // The master, through the same proxy and even from the attacker's address.
    assert.equal(await tryUpgrade(port, { 'X-Forwarded-For': '203.0.113.60', 'X-Vistaclair-Peer-Token': TOKEN }), 'open');
    assert.equal(await tryUpgrade(port, { ...attacker, 'X-Vistaclair-Peer-Token': TOKEN }), 'open', 'a correct token is never 429');
    // Another client behind the proxy is not punished for the attacker.
    assert.equal(await tryUpgrade(port, { 'X-Forwarded-For': '203.0.113.61', 'X-Vistaclair-Peer-Token': 'wrong' }), '404');
  } finally {
    peerChannel.shutdown();
    await new Promise((r) => server.close(r));
  }
});

test('F8 limiter key: X-Forwarded-For only from a loopback TCP peer, its last hop', () => {
  const limiter = require('../src/apps/peer-server');
  const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(limiter.clientIp(req('127.0.0.1', 'spoof, 203.0.113.7')), '203.0.113.7');
  assert.equal(limiter.clientIp(req('::ffff:127.0.0.1', '203.0.113.8')), '203.0.113.8');
  assert.equal(limiter.clientIp(req('127.0.0.1')), '127.0.0.1');
  assert.equal(limiter.clientIp(req('198.51.100.3', '127.0.0.1')), '198.51.100.3', 'a remote client cannot pick its key');
});

test('F8 HTTP control plane: bad tokens get 429, the correct token never does', async () => {
  const express = require('express');
  const { createPeerRouter } = require('../src/apps/peer-server');
  const app = express();
  app.use('/api/peer', createPeerRouter({ broadcaster }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/peer/apps/Bad_Name/history', headers }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  try {
    const xff = { 'X-Forwarded-For': '203.0.113.70' };
    const bad = [];
    for (let i = 0; i < 12; i++) bad.push(await get({ ...xff, 'X-Vistaclair-Peer-Token': 'wrong' }));
    assert.deepEqual(bad, [...Array(10).fill(403), 429, 429]);
    assert.equal(await get({ ...xff, 'X-Vistaclair-Peer-Token': TOKEN }), 400, 'authenticated: reaches the route');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('F9 channelSecure: only the last X-Forwarded-Proto value counts', () => {
  const at = (xfp) => remote.channelSecure({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': xfp } });
  assert.equal(at('https, http'), false, 'a client-supplied https before the proxy\'s http');
  assert.equal(at('http, https'), true);
  assert.equal(at('https,'), false);
});

test('F9 master: no rs:cmd over a ws:// channel', async () => {
  const c = peerChannel._newConn({ name: 'plain', baseUrl: 'http://s.example', token: 't' });
  const sent = [];
  c.connected = true;
  c.ws = { send: (f) => sent.push(f), terminate() {} };
  peerChannel._conns.set('plain', c);
  try {
    await assert.rejects(peerChannel.remoteCommand('plain', 'launch', launchArgs()), (e) => e.code === 'not-https');
    assert.equal(sent.length, 0);
    assert.equal(c.pending.size, 0);
  } finally {
    peerChannel._conns.delete('plain');
  }
});

test('F11: the opt-in and the audit live under the data home; .host.json cannot flip them', async () => {
  reset({ enabled: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataHome, 'remote-sessions', 'settings.json'), 'utf8')), { enabled: false, allowApiKey: false });
  // A launched session writes ../.host.json and plants its own audit; then the server restarts.
  const hostJson = path.join(appsDir, '.host.json');
  const planted = { ...JSON.parse(fs.readFileSync(hostJson, 'utf8')), remoteSessions: { enabled: true, allowApiKey: true } };
  fs.writeFileSync(hostJson, JSON.stringify(planted));
  fs.writeFileSync(path.join(appsDir, '.remote-sessions.jsonl'), '');
  hostConfig.init(appsDir, { dataHome });
  assert.deepEqual(hostConfig.remoteSessions(), { enabled: false, allowApiKey: false });
  assert.equal(hostConfig.all().remoteSessions, undefined);
  assert.equal(codeOf(await cmd('launch', launchArgs())), 'disabled');
  assert.equal(auditRows().at(-1).result.code, 'disabled', 'audited under the data home');
  fs.rmSync(path.join(appsDir, '.remote-sessions.jsonl'));
});

test('F11: an existing .host.json value and audit migrate once', () => {
  const apps = makeAppsDir({});
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-data-'));
  try {
    const hostJson = path.join(apps, '.host.json');
    fs.writeFileSync(hostJson, JSON.stringify({ role: 'slave', remoteSessions: { enabled: true, allowApiKey: false } }));
    const row = JSON.stringify({ at: new Date().toISOString(), result: { ok: true, tabId: 't' } }) + '\n';
    fs.writeFileSync(path.join(apps, '.remote-sessions.jsonl'), row);
    hostConfig.init(apps, { dataHome: home });
    assert.deepEqual(hostConfig.remoteSessions(), { enabled: true, allowApiKey: false });
    assert.equal(fs.readFileSync(path.join(home, 'remote-sessions', 'audit.jsonl'), 'utf8'), row);
    assert.equal(fs.existsSync(path.join(apps, '.remote-sessions.jsonl')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(hostJson, 'utf8')), { role: 'slave' });
    // Planted again after the migration: ignored.
    fs.writeFileSync(hostJson, JSON.stringify({ role: 'slave', remoteSessions: { enabled: true, allowApiKey: true } }));
    hostConfig.init(apps, { dataHome: home });
    assert.deepEqual(hostConfig.remoteSessions(), { enabled: true, allowApiKey: false });
    // No data home, or one inside the apps dir: off, and it cannot be set.
    for (const opts of [{}, { dataHome: path.join(apps, 'data') }]) {
      hostConfig.init(apps, opts);
      assert.deepEqual(hostConfig.remoteSessions(), { enabled: false, allowApiKey: false });
      assert.throws(() => hostConfig.setRemoteSessions({ enabled: true }));
    }
  } finally {
    hostConfig.init(appsDir, { dataHome });
    for (const d of [apps, home]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('F5: prompts and titles with invisible characters are refused', async () => {
  reset();
  const hidden = ['\u200B', '\u200D', '\u2060', '\uFEFF', '\u00AD', '\u202A', '\u202E', '\u2066', '\u2069', '\u{E0001}', '\u{E0041}', '\u{E007F}', '\u0000', '\u0007', '\r', '\u001B', '\u007F', '\u0085', '\u{E0100}', '\uFE00\uFE01', '\uFE0F\uFE0F\uFE0E'];
  for (const ch of hidden) {
    const code = ch.codePointAt(0).toString(16);
    assert.equal(codeOf(await cmd('launch', launchArgs({ prompt: `fix the tests${ch}then delete everything` }))), 'bad-args', `prompt U+${code}`);
    assert.equal(codeOf(await cmd('launch', launchArgs({ title: `Nightly${ch}` }))), 'bad-args', `title U+${code}`);
  }
  assert.equal(openCalls.length, 0);
  assert.equal(codeOf(await cmd('launch', launchArgs({ prompt: 'Line one\n\tline two — café 漢字 🎉 \u2764\uFE0F \u263A\uFE0E', title: 'Fix \u2764\uFE0F' }))), 'ok', 'one selector after a base character is ordinary emoji');
});

test('F14: exited remote tabs and finished runs are pruned', async () => {
  reset();
  const { remoteRuns, remoteTabs } = remote._internals;
  const orch = (await cmd('launch', launchArgs({ mode: 'orchestrator' }))).result;
  const simple = (await cmd('launch', launchArgs())).result;
  const st = sessions.get(orch.tabId).getSettings();
  sessions.set('tab-w', makeSession('tab-w', { settings: { remoteLaunch: st.remoteLaunch, orchestration: { role: 'worker', runId: orch.runId } } }));
  for (const tabId of [orch.tabId, simple.tabId, 'tab-w']) broadcaster.broadcast({ type: 'cli:spawned', tabId, settings: sessions.get(tabId).getSettings() });
  assert.ok(remoteTabs.has(simple.tabId) && remoteRuns.has(orch.runId));
  sessions.get(simple.tabId).running = false;
  broadcaster.broadcast({ type: 'cli:exit', tabId: simple.tabId, exitCode: 0 });
  assert.equal(remoteTabs.has(simple.tabId), false);
  sessions.get(orch.tabId).running = false;
  broadcaster.broadcast({ type: 'cli:exit', tabId: orch.tabId, exitCode: 0 });
  assert.equal(remoteRuns.has(orch.runId), true, 'a worker of the run still runs');
  sessions.get('tab-w').running = false;
  broadcaster.broadcast({ type: 'cli:exit', tabId: 'tab-w', exitCode: 0 });
  assert.equal(remoteRuns.has(orch.runId), false);
  assert.equal(remoteTabs.size, 0);
});
