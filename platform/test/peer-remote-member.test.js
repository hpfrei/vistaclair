// Remote workers, slave side (peer-remote-slave.js member.launch /
// member.submit): the launch guards, one mirror run per master run, deliver →
// rs:msg with its caps, the bounded backlog flushed on reconnect, submit only
// for member tabs, close when the last member goes, re-attach by key after a
// restart, and a core without openMirrorRun. Core's mirror run is a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const hostConfig = require('../src/apps/host-config');
const peerChannel = require('../src/apps/peer-channel');
const remote = require('../src/apps/peer-remote-slave');

const { MAX_ACTIVE, MAX_MEMBERS, MAX_PER_HOUR, BACKLOG_MAX, MSG_RATE_MAX, mirrors } = remote._internals;

const appsDir = makeAppsDir({ 'my-app': {}, 'other-app': {} });
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-outside-'));
fs.writeFileSync(path.join(outside, 'manifest.json'), '{}');
fs.symlinkSync(outside, path.join(appsDir, 'escape'));
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-data-'));
const rsDir = path.join(dataHome, 'remote-sessions');
const auditFile = path.join(rsDir, 'audit.jsonl');
const mirrorsFile = path.join(rsDir, 'mirrors.json');
appManager.setAppsDir(appsDir);
hostConfig.init(appsDir, { dataHome });
hostConfig.setRole('slave');
hostConfig.setSlave({ name: 's1', masterUrl: 'https://master.example:8443', publicUrl: 'https://slave.example', linkStatus: 'linked' });
const KEY = (runId) => `master.example-8443:${runId}`;

// --- fakes -------------------------------------------------------------------

const listeners = new Set();
const broadcaster = {
  broadcast(m) { for (const fn of listeners) fn(m); },
  onBroadcast(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

const sessions = new Map();
const mgr = {
  sessions,
  get: (id) => sessions.get(id) || null,
  getBySessId: (sid) => [...sessions.values()].find((s) => s.sessId === sid) || null,
  kill(id) { const s = sessions.get(id); if (s) s.running = false; },
  sessionDirOf: () => null,
};

function makeSession(tabId, { cwd, settings }) {
  return {
    tabId, sessId: crypto.randomUUID(), kind: 'sdk', running: true, state: 'idle', costUsd: 0, cwd, title: tabId,
    settings, submitted: [],
    getSettings() { return { ...this.settings }; },
    submit(text) { this.submitted.push(text); },
    async interrupt() { this.interrupted = true; },
  };
}

// Core's openMirrorRun, persisted by key across "restarts" like core's.
let seq = 0;
const coreRuns = new Map();   // key → { runId, opens, workers: Map<address, tabId>, submits, kills, closed, deliver }
let launchFails = false;
function openMirrorRun({ key, orchestrator, deliver }) {
  let r = coreRuns.get(key);
  if (!r) {
    r = { runId: `mirror${++seq}`, orchestrator, opens: 0, workers: new Map(), submits: [], kills: [], launches: [], closed: 0 };
    coreRuns.set(key, r);
  }
  r.opens++;
  r.deliver = deliver;
  return {
    async launchWorker(opts) {
      if (launchFails) throw new Error('core refused');
      r.launches.push(opts);
      const n = ++seq;
      const tabId = `tab-${n}`;
      const address = `w${n}`;
      const settings = { ...opts.settings, auth: opts.auth, orchestration: { role: 'worker', runId: r.runId, workerId: address } };
      sessions.set(tabId, makeSession(tabId, { cwd: opts.cwd, settings }));
      r.workers.set(address, tabId);
      return { tabId, address };
    },
    submit(address, text, { from }) { r.submits.push({ address, text, from }); return { delivered: true }; },
    async kill(address) {
      r.kills.push(address);
      const s = sessions.get(r.workers.get(address));
      if (s) s.running = false;
    },
    close() { r.closed++; },
  };
}

let creds = { apiKey: true, subscription: true };
const resolveAuth = (mode) => {
  if (mode === 'apikey' && creds.apiKey) return { credential: 'api-key', key: 'k' };
  if (creds.subscription) return { credential: 'subscription', key: '' };
  return creds.apiKey ? { credential: 'api-key', key: 'k' } : { credential: null, key: '' };
};

async function openCli(opts) {
  const tabId = `tab-${++seq}`;
  sessions.set(tabId, makeSession(tabId, { cwd: opts.cwd, settings: { ...opts.settings, auth: opts.auth } }));
  return { tabId, mode: opts.mode, engine: 'sdk', auth: opts.auth };
}

let frames = [];
const linkUp = (secure = true) => remote.attach({ send: (f) => frames.push(f), secure, frameCap: peerChannel.FRAME_CAP });

// A boot of Pro: init (re-attaches mirror runs from the file), channel up.
function boot({ hook = true, secure = true } = {}) {
  remote.init({
    broadcaster, cliSessionManager: mgr, openCli, pendingQuestions: new Map(), clearPendingQuestionsForTab() {},
    resolveAuth, claudeAuthInfo: () => ({}), appsDir, proDir: path.join(os.tmpdir(), 'no-pro'), coreDir: path.join(os.tmpdir(), 'no-core'),
    ...(hook ? { orchestration: { listRuns: () => [], openMirrorRun } } : { orchestration: { listRuns: () => [] } }),
  });
  frames = [];
  linkUp(secure);
}

function reset({ enabled = true, allowApiKey = false, secure = true, hook = true } = {}) {
  sessions.clear();
  coreRuns.clear();
  launchFails = false;
  creds = { apiKey: true, subscription: true };
  for (const f of [auditFile, mirrorsFile]) { try { fs.rmSync(f); } catch {} }
  hostConfig.setRemoteSessions({ enabled, allowApiKey });
  boot({ hook, secure });
}

let cmdSeq = 0;
const cmd = (op, args) => remote.handleFrame({ type: 'rs:cmd', id: `c${++cmdSeq}`, op, args });
const codeOf = (reply) => (reply.ok ? 'ok' : reply.error.code);
const memberArgs = (over = {}) => ({
  runId: 'run-1', address: 'w-alpha', orchestrator: { address: 'orch-abc', title: 'Big job' },
  title: 'Fix the slave app', task: 'do the thing', app: 'my-app', auth: 'subscription', ...over,
});
const auditRows = () => {
  try { return fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; }
};
const tick = () => new Promise((r) => setImmediate(r));
const msgs = () => frames.filter((f) => f.type === 'rs:msg');

test.after(() => {
  remote.shutdown();
  peerChannel.shutdown();
  for (const d of [appsDir, outside, dataHome]) fs.rmSync(d, { recursive: true, force: true });
});

// --- guards ------------------------------------------------------------------

test('member.launch refuses when disabled, over http, on a bad app, and audits it', async () => {
  reset({ enabled: false });
  assert.equal(codeOf(await cmd('member.launch', memberArgs())), 'disabled');
  const row = auditRows()[0];
  assert.deepEqual(row.origin, { kind: 'orchestrator', runId: 'run-1', address: 'w-alpha' });
  assert.equal(row.mode, 'member');
  assert.deepEqual(row.result, { ok: false, code: 'disabled' });

  reset({ secure: false });
  assert.equal(codeOf(await cmd('member.launch', memberArgs())), 'not-https');

  reset();
  for (const app of ['nope', 'escape', '../my-app', 'My-App']) {
    assert.equal(codeOf(await cmd('member.launch', memberArgs({ app }))), 'bad-app', app);
  }
  assert.equal(coreRuns.size, 0, 'no mirror run opened by a refused launch');
});

test('member.launch: billing is explicit, with no fallback', async () => {
  reset();
  assert.equal(codeOf(await cmd('member.launch', memberArgs({ auth: undefined }))), 'bad-args');
  assert.equal(codeOf(await cmd('member.launch', memberArgs({ auth: 'apikey' }))), 'apikey-not-allowed');
  creds = { apiKey: true, subscription: false };
  assert.equal(codeOf(await cmd('member.launch', memberArgs())), 'no-credential', 'no fallback to the API key');
  assert.equal(coreRuns.size, 0);
});

test('member.launch: invisible characters, oversized task and bad ids are refused', async () => {
  reset();
  for (const over of [
    { task: 'do ‮it' }, { title: 'zero​width' }, { orchestrator: { address: 'orch-abc', title: 'x⁦' } },
    { task: 'x'.repeat(32 * 1024 + 1) }, { task: '  ' }, { runId: 'bad id' }, { address: '' }, { orchestrator: { address: 'o/x' } },
    { model: 'no spaces allowed' },
  ]) {
    assert.equal(codeOf(await cmd('member.launch', memberArgs(over))), 'bad-args', JSON.stringify(over).slice(0, 60));
  }
  assert.equal(coreRuns.size, 0);
});

test('member.launch: members have their own live cap, apart from standalone sessions', async () => {
  reset();
  const standalone = { mode: 'simple', app: 'my-app', prompt: 'p', auth: 'subscription', origin: { kind: 'owner' } };
  for (let i = 0; i < MAX_ACTIVE; i++) assert.equal(codeOf(await cmd('launch', standalone)), 'ok');
  assert.equal(codeOf(await cmd('launch', standalone)), 'limit');
  for (let i = 0; i < MAX_MEMBERS; i++) {
    assert.equal(codeOf(await cmd('member.launch', memberArgs({ runId: `run-${i % 2}`, address: `w${i}` }))), 'ok', 'standalone sessions do not count');
  }
  const r = await cmd('member.launch', memberArgs({ address: 'one-more' }));
  assert.equal(codeOf(r), 'limit', 'members of every run count each');
  assert.match(r.error.message, /remote workers at once/);
  assert.equal(codeOf(await cmd('launch', standalone)), 'limit', 'members do not free a standalone slot');
});

test('member.launch: the hourly cap is shared with standalone launches', async () => {
  reset();
  assert.equal(codeOf(await cmd('launch', { mode: 'simple', app: 'my-app', prompt: 'p', auth: 'subscription', origin: { kind: 'owner' } })), 'ok');
  for (const s of sessions.values()) s.running = false;
  for (let i = 1; i < MAX_PER_HOUR; i++) {
    assert.equal(codeOf(await cmd('member.launch', memberArgs({ address: `w${i}` }))), 'ok');
    for (const s of sessions.values()) s.running = false;
  }
  const r = await cmd('member.launch', memberArgs({ address: 'w-late' }));
  assert.equal(codeOf(r), 'limit');
  assert.match(r.error.message, /per hour/);
  const s = await cmd('launch', { mode: 'simple', app: 'my-app', prompt: 'p', auth: 'subscription', origin: { kind: 'owner' } });
  assert.equal(codeOf(s), 'limit', 'members used up the standalone launches too');
});

test('core without openMirrorRun: member.launch is unavailable', async () => {
  reset({ hook: false });
  const r = await cmd('member.launch', memberArgs());
  assert.equal(codeOf(r), 'unavailable');
  assert.match(r.error.message, /core update/);
  assert.deepEqual(auditRows()[0].result, { ok: false, code: 'unavailable' });
});

// --- launch ------------------------------------------------------------------

test('member.launch: one mirror run per master run, reused; the worker is a stamped remote session', async () => {
  reset();
  const a = await cmd('member.launch', memberArgs({ model: 'opus' }));
  assert.equal(codeOf(a), 'ok');
  assert.match(a.result.tabId, /^tab-/);
  assert.match(a.result.memberAddress, /^w\d+$/);
  const b = await cmd('member.launch', memberArgs({ address: 'w-beta' }));
  assert.equal(codeOf(b), 'ok');
  assert.equal(coreRuns.size, 1, 'the second member reuses the mirror run');
  const run = coreRuns.get(KEY('run-1'));
  assert.equal(run.opens, 1);
  assert.deepEqual(run.orchestrator, { address: 'orch-abc', host: 'master.example-8443' });

  const appDir = fs.realpathSync(path.join(appsDir, 'my-app'));
  const opts = run.launches[0];
  assert.equal(opts.cwd, appDir);
  assert.equal(opts.task, 'do the thing');
  assert.equal(opts.title, 'Fix the slave app');
  assert.equal(opts.auth, 'subscription');
  assert.equal(opts.model, 'opus');
  assert.equal(opts.settings.sessionsRoot, path.join(appDir, '.vistaclair', 'sessions'));
  assert.deepEqual(opts.settings.remoteLaunch.origin, { kind: 'orchestrator', runId: 'run-1', address: 'w-alpha' });
  assert.equal(opts.settings.remoteLaunch.member, KEY('run-1'));

  assert.equal(codeOf(await cmd('member.launch', memberArgs({ runId: 'run-2', address: 'w-gamma' }))), 'ok');
  assert.equal(coreRuns.size, 2, 'another master run → another mirror run');

  // Every existing remote op works on a member tab.
  assert.equal(codeOf(await cmd('interrupt', { tabId: a.result.tabId })), 'ok');
  assert.equal(codeOf(await cmd('todo', { tabId: a.result.tabId })), 'ok');
  const listed = (await cmd('list', {})).result;
  assert.ok(listed.some((x) => x.tabId === a.result.tabId && x.role === 'worker' && x.app === 'my-app'));
  const row = auditRows().find((x) => x.result.ok);
  assert.deepEqual(row.origin, { kind: 'orchestrator', runId: 'run-1', address: 'w-alpha' });
  assert.equal(row.result.tabId, a.result.tabId);
});

test('a failed worker launch closes the mirror run it opened', async () => {
  reset();
  launchFails = true;
  const r = await cmd('member.launch', memberArgs());
  assert.equal(r.ok, false);
  assert.equal(coreRuns.get(KEY('run-1')).closed, 1);
  assert.equal(mirrors.size, 0);
});

// --- deliver → rs:msg ----------------------------------------------------------

test('deliver: reports and messages become rs:msg frames, capped', async () => {
  reset();
  const { tabId, memberAddress } = (await cmd('member.launch', memberArgs())).result;
  const { deliver } = coreRuns.get(KEY('run-1'));
  deliver({ address: memberAddress, kind: 'report', status: 'started', summary: 'on it' });
  deliver({ address: memberAddress, kind: 'message', text: 'a question' });
  deliver({ address: memberAddress, kind: 'report', status: 'paused', summary: 'not a relayed status' });
  deliver({ address: 'someone-else', kind: 'message', text: 'not a member' });
  deliver({ address: memberAddress, kind: 'message', text: 'x'.repeat(40 * 1024) });
  const out = msgs();
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { type: 'rs:msg', tabId, kind: 'report', status: 'started', summary: 'on it' });
  assert.deepEqual(out[1], { type: 'rs:msg', tabId, kind: 'message', text: 'a question' });
  assert.ok(Buffer.byteLength(out[2].text) <= 32 * 1024);
  assert.match(out[2].text, /truncated/);
});

test('deliver: a member is rate-capped; the rest waits in its queue', async () => {
  reset();
  const { memberAddress } = (await cmd('member.launch', memberArgs())).result;
  const { deliver } = coreRuns.get(KEY('run-1'));
  for (let i = 0; i < MSG_RATE_MAX + 5; i++) deliver({ address: memberAddress, kind: 'message', text: `m${i}` });
  assert.equal(msgs().length, MSG_RATE_MAX);
  const [m] = [...mirrors.values()];
  assert.equal([...m.members.values()][0].queue.length, 5);
  assert.ok([...m.members.values()][0].timer, 'a timer sends the rest when the window opens');
});

test('backlog: bounded while the channel is down, persisted, flushed on reconnect', async () => {
  reset();
  const { tabId, memberAddress } = (await cmd('member.launch', memberArgs())).result;
  const { deliver } = coreRuns.get(KEY('run-1'));
  remote.detach();
  for (let i = 0; i < BACKLOG_MAX + 10; i++) deliver({ address: memberAddress, kind: 'message', text: `m${i}` });
  assert.equal(msgs().length, 0);
  const saved = JSON.parse(fs.readFileSync(mirrorsFile, 'utf8'))[KEY('run-1')].members[tabId];
  assert.equal(saved.queue.length, BACKLOG_MAX);
  assert.equal(saved.dropped, 10);
  assert.equal(saved.queue[0].text, 'm10', 'the oldest go first');

  linkUp();
  await tick();
  const out = msgs();
  assert.equal(out.length, MSG_RATE_MAX, 'the flush keeps the rate cap');
  assert.equal(out[0].text, 'm10');
  assert.equal(out[0].dropped, 10, 'the first frame says how many were lost');
  assert.equal(out[1].dropped, undefined);
});

// --- member.submit -------------------------------------------------------------

test('member.submit: only member tabs, from@master, control characters stripped', async () => {
  reset();
  const plain = (await cmd('launch', { mode: 'simple', app: 'my-app', prompt: 'p', auth: 'subscription', origin: { kind: 'owner' } })).result;
  const { tabId, memberAddress } = (await cmd('member.launch', memberArgs())).result;
  const run = coreRuns.get(KEY('run-1'));

  assert.equal(codeOf(await cmd('member.submit', { tabId: plain.tabId, text: 'hi', from: 'orch-abc' })), 'not-remote', 'a remote session that is not a member');
  assert.equal(codeOf(await cmd('member.submit', { tabId: 'tab-none', text: 'hi', from: 'orch-abc' })), 'unknown-tab');
  assert.equal(codeOf(await cmd('member.submit', { tabId, text: 'x'.repeat(32 * 1024 + 1), from: 'orch-abc' })), 'bad-args');
  assert.equal(codeOf(await cmd('member.submit', { tabId, text: '\u0007', from: 'orch-abc' })), 'bad-args');
  assert.equal(codeOf(await cmd('member.submit', { tabId, text: 'hi', from: 'bad from' })), 'bad-args');
  assert.equal(run.submits.length, 0);

  assert.equal(codeOf(await cmd('member.submit', { tabId, text: 'go\u0000 on\nplease', from: 'orch-abc' })), 'ok');
  assert.deepEqual(run.submits, [{ address: memberAddress, text: 'go on\nplease', from: 'orch-abc@master' }]);
});

// --- kill / close --------------------------------------------------------------

test('kill: through the mirror run; the last live member closes it', async () => {
  reset();
  const a = (await cmd('member.launch', memberArgs())).result;
  const b = (await cmd('member.launch', memberArgs({ address: 'w-beta' }))).result;
  const run = coreRuns.get(KEY('run-1'));
  assert.equal(codeOf(await cmd('kill', { tabId: a.tabId })), 'ok');
  assert.deepEqual(run.kills, [a.memberAddress]);
  assert.equal(run.closed, 0, 'a live member is left');
  assert.equal(codeOf(await cmd('kill', { tabId: b.tabId })), 'ok');
  assert.equal(run.closed, 1);
  assert.equal(mirrors.size, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(mirrorsFile, 'utf8')), {});
});

test('a member exiting on its own closes the run when none is left', async () => {
  reset();
  const a = (await cmd('member.launch', memberArgs())).result;
  sessions.get(a.tabId).running = false;
  broadcaster.broadcast({ type: 'cli:exit', tabId: a.tabId, exitCode: 0 });
  assert.equal(coreRuns.get(KEY('run-1')).closed, 1);
  assert.equal(mirrors.size, 0);
});

test('a closed run keeps its backlog until the master has it', async () => {
  reset();
  const a = (await cmd('member.launch', memberArgs())).result;
  const { deliver } = coreRuns.get(KEY('run-1'));
  remote.detach();
  deliver({ address: a.memberAddress, kind: 'report', status: 'done', summary: 'finished' });
  sessions.get(a.tabId).running = false;
  broadcaster.broadcast({ type: 'cli:exit', tabId: a.tabId, exitCode: 0 });
  assert.equal(coreRuns.get(KEY('run-1')).closed, 1);
  assert.equal(mirrors.size, 1, 'kept for its backlog');
  linkUp();
  await tick();
  assert.deepEqual(msgs().map((f) => f.status), ['done']);
  assert.equal(mirrors.size, 0);
});

// --- restart -------------------------------------------------------------------

test('re-attach by key after a restart: backlog, deliver and submit keep working', async () => {
  reset();
  const a = (await cmd('member.launch', memberArgs())).result;
  remote.detach();
  coreRuns.get(KEY('run-1')).deliver({ address: a.memberAddress, kind: 'report', status: 'blocked', summary: 'need a decision' });

  remote.shutdown();                     // the slave restarts
  boot();
  const run = coreRuns.get(KEY('run-1'));
  assert.equal(run.opens, 2, 're-opened with the same key');
  assert.equal(run.closed, 0, 'a restart does not close the run');
  await tick();
  assert.deepEqual(msgs().map((f) => [f.tabId, f.status]), [[a.tabId, 'blocked']], 'the backlog survived the restart');

  run.deliver({ address: a.memberAddress, kind: 'message', text: 'after restart' });
  assert.equal(msgs().at(-1).text, 'after restart');
  assert.equal(codeOf(await cmd('member.submit', { tabId: a.tabId, text: 'decided', from: 'orch-abc' })), 'ok');
  assert.equal(run.submits[0].from, 'orch-abc@master');

  assert.equal(codeOf(await cmd('member.launch', memberArgs({ address: 'w-beta' }))), 'ok');
  assert.equal(coreRuns.size, 1, 'the re-attached mirror run is reused');
});

test('restart onto a core without the hook: members known, submit unavailable', async () => {
  reset();
  const a = (await cmd('member.launch', memberArgs())).result;
  remote.shutdown();
  boot({ hook: false });
  assert.equal(codeOf(await cmd('member.submit', { tabId: a.tabId, text: 'hi', from: 'orch-abc' })), 'unavailable');
  assert.equal(codeOf(await cmd('kill', { tabId: a.tabId })), 'ok', 'kill falls back to the session manager');
  assert.equal(sessions.get(a.tabId).running, false);
});
