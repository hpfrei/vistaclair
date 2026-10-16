// "Sign in to Claude": the cached `claude auth status --json` and the one
// `claude auth login` pty the dashboard drives (src/claude-auth.js), and the
// WebSocket handler between them and the browser.
//
// Every command here is a stub: the real login is never started.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { parseAuthStatus, isSubscription, AuthStatus, LoginProcess } = require('../src/claude-auth');
const handler = require('../src/ws/claude-auth-handler');

const LIVE = JSON.stringify({
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'user@example.com',
  orgId: 'org-1', orgName: 'Example', subscriptionType: 'max', configDirectory: '/home/u/.claude',
});
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });

test('the status is parsed to the fields the dashboard may see, whatever else the CLI adds', () => {
  const s = parseAuthStatus(`${LIVE}\n`);
  assert.deepEqual(s, {
    loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
    email: 'user@example.com', orgName: 'Example', subscriptionType: 'max',
  });
  assert.equal(isSubscription(s), true);
  const extra = parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', accessToken: 'secret' }));
  assert.equal('accessToken' in extra, false);
});

test('signed out, a Console login and a non-status all read as no subscription', () => {
  const out = parseAuthStatus(SIGNED_OUT);
  assert.equal(out.loggedIn, false);
  assert.equal(isSubscription(out), false);
  assert.equal(isSubscription(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'console' }))), false);
  assert.equal(parseAuthStatus(''), null);
  assert.equal(parseAuthStatus('command not found'), null);
  assert.equal(parseAuthStatus('{"authMethod":"claude.ai"}'), null);
  assert.equal(isSubscription(null), false);
});

// A runner that counts its runs and answers with whatever `out` says now.
function stubRunner(initial) {
  const r = {
    out: initial, sync: 0, async: 0,
    runSync() { r.sync++; return r.out; },
    run() { r.async++; return new Promise((resolve) => setImmediate(() => resolve(r.out))); },
  };
  return r;
}

test('the first get() asks the CLI once; within the TTL the cached answer is served', () => {
  let t = 1000;
  const runner = stubRunner(LIVE);
  const st = new AuthStatus({ runner, ttlMs: 30000, now: () => t });
  assert.equal(st.peek(), null);
  assert.equal(st.get().loggedIn, true);
  t += 29999;
  st.get(); st.get();
  assert.equal(runner.sync, 1);
  assert.equal(runner.async, 0);
});

test('a stale answer is served while one background run refreshes it', async () => {
  let t = 0;
  const runner = stubRunner(LIVE);
  const st = new AuthStatus({ runner, ttlMs: 1000, now: () => t });
  const changes = [];
  st.on('change', (s) => changes.push(s && s.loggedIn));
  st.get();
  runner.out = SIGNED_OUT;
  t = 5000;
  // Stale: the old answer comes back at once, without a synchronous run.
  assert.equal(st.get().loggedIn, true);
  st.get();
  assert.equal(runner.sync, 1);
  await st.refresh(); // joins the run get() started
  assert.equal(runner.async, 1);
  assert.equal(st.get().loggedIn, false);
  assert.deepEqual(changes, [true, false]);
});

test('concurrent refreshes share one run, and an unchanged answer is not a change', async () => {
  const runner = stubRunner(LIVE);
  const st = new AuthStatus({ runner });
  let changes = 0;
  st.on('change', () => changes++);
  const [a, b] = await Promise.all([st.refresh(), st.refresh()]);
  assert.equal(runner.async, 1);
  assert.equal(a, b);
  await st.refresh();
  assert.equal(runner.async, 2);
  assert.equal(changes, 1);
});

test('invalidate() makes the next get() refresh', async () => {
  const runner = stubRunner(LIVE);
  const st = new AuthStatus({ runner, ttlMs: 60000 });
  st.get();
  st.invalidate();
  st.get();
  await st.refresh();
  assert.equal(runner.async, 1);
});

// A node-pty-shaped process. `stubborn` ignores SIGTERM.
function fakePty({ stubborn = false } = {}) {
  const p = {
    written: [], killed: [], size: null, dataCbs: [], exitCbs: [], stubborn,
    onData(cb) { p.dataCbs.push(cb); },
    onExit(cb) { p.exitCbs.push(cb); },
    write(d) { p.written.push(d); },
    resize(c, r) { p.size = [c, r]; },
    kill(sig) { p.killed.push(sig); if (!p.stubborn || sig === 'SIGKILL') p.exit(sig === 'SIGKILL' ? 137 : 143); },
    print(d) { for (const cb of p.dataCbs) cb(d); },
    exit(exitCode) { for (const cb of p.exitCbs) cb({ exitCode, signal: 0 }); },
  };
  return p;
}

function fakeSpawner(opts) {
  const s = (args) => { const p = fakePty(opts); p.args = args; s.procs.push(p); return p; };
  s.procs = [];
  return s;
}

test('there is only ever one login process', () => {
  const spawn = fakeSpawner();
  const login = new LoginProcess({ spawn });
  assert.equal(login.start({ cols: 90, rows: 12 }), true);
  assert.equal(login.start({ cols: 90, rows: 12 }), false);
  assert.equal(spawn.procs.length, 1);
  assert.deepEqual(spawn.procs[0].args, { cols: 90, rows: 12 });
  assert.equal(login.running, true);
  login.cancel();
});

test('cancel kills the process and reports why it ended', () => {
  const spawn = fakeSpawner();
  const login = new LoginProcess({ spawn });
  const exits = [];
  login.on('exit', (e) => exits.push(e));
  login.start();
  assert.equal(login.cancel(), true);
  assert.deepEqual(spawn.procs[0].killed, ['SIGTERM']);
  assert.equal(login.running, false);
  assert.deepEqual(exits, [{ exitCode: 143, signal: null, reason: 'cancelled' }]);
  assert.equal(login.cancel(), false);
  // A new one may start once the old one is gone.
  assert.equal(login.start(), true);
  assert.equal(spawn.procs.length, 2);
  login.cancel();
});

test('a process that ignores SIGTERM is SIGKILLed', async () => {
  const spawn = fakeSpawner({ stubborn: true });
  const login = new LoginProcess({ spawn, killGraceMs: 5 });
  const exits = [];
  login.on('exit', (e) => exits.push(e));
  login.start();
  login.cancel();
  assert.equal(login.running, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(spawn.procs[0].killed, ['SIGTERM', 'SIGKILL']);
  assert.equal(login.running, false);
  assert.equal(exits[0].reason, 'cancelled');
});

test('a login nobody finishes is killed at the timeout', async () => {
  const spawn = fakeSpawner();
  const login = new LoginProcess({ spawn, timeoutMs: 5 });
  const exit = new Promise((r) => login.once('exit', r));
  login.start();
  // The manager's timer is unref'd; this one keeps the test's loop alive.
  const hold = setTimeout(() => {}, 1000);
  assert.equal((await exit).reason, 'timeout');
  clearTimeout(hold);
  assert.equal(login.running, false);
});

test('output is streamed and kept for a late viewer until the process exits', () => {
  const spawn = fakeSpawner();
  const login = new LoginProcess({ spawn });
  const seen = [];
  login.on('output', (d) => seen.push(d));
  login.start();
  const p = spawn.procs[0];
  p.print('Opening browser to sign in…\r\n');
  p.print('Paste code here if prompted > ');
  assert.equal(seen.length, 2);
  assert.equal(login.replay, 'Opening browser to sign in…\r\nPaste code here if prompted > ');
  login.write('the-code\r');
  login.resize(100, 14);
  assert.deepEqual(p.written, ['the-code\r']);
  assert.deepEqual(p.size, [100, 14]);
  p.exit(0);
  assert.equal(login.replay, '');
  login.write('late');
  assert.deepEqual(p.written, ['the-code\r']);
});

// --- The WebSocket handler -------------------------------------------------

function fakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1; // WebSocket.OPEN
  ws.sent = [];
  ws.send = (data) => ws.sent.push(JSON.parse(data));
  ws.of = (type) => ws.sent.filter((m) => m.type === type);
  return ws;
}

function setup() {
  const runner = stubRunner(SIGNED_OUT);
  const authStatus = new AuthStatus({ runner });
  const spawn = fakeSpawner();
  const login = new LoginProcess({ spawn });
  const broadcasts = [];
  const bc = { broadcast: (m) => broadcasts.push(m) };
  const h = handler.create(bc, { authStatus, login });
  return { runner, authStatus, spawn, login, broadcasts, h };
}

test('the dashboard that starts a login sees it; a second one joins it with what was printed', () => {
  const { h, spawn, login } = setup();
  const a = fakeWs(), b = fakeWs(), other = fakeWs();
  h.handleMessage(a, { type: 'claude-auth:login:start', cols: 80, rows: 12, hostBrowser: false });
  assert.deepEqual(a.of('claude-auth:login:started'), [{ type: 'claude-auth:login:started', attached: false, replay: '' }]);
  assert.deepEqual(spawn.procs[0].args, { cols: 80, rows: 12, hostBrowser: false });
  spawn.procs[0].print('visit: https://claude.com/cai/oauth/authorize?x\r\n');
  h.handleMessage(b, { type: 'claude-auth:login:start', cols: 80, rows: 12 });
  assert.equal(spawn.procs.length, 1);
  assert.equal(b.of('claude-auth:login:started')[0].attached, true);
  assert.match(b.of('claude-auth:login:started')[0].replay, /oauth\/authorize/);
  spawn.procs[0].print('Paste code here if prompted > ');
  assert.equal(a.of('claude-auth:login:output').length, 2);
  assert.equal(b.of('claude-auth:login:output').length, 1);
  // Keystrokes only from a dashboard that is watching the login.
  h.handleMessage(other, { type: 'claude-auth:login:input', data: 'x' });
  h.handleMessage(b, { type: 'claude-auth:login:input', data: 'code\r' });
  assert.deepEqual(spawn.procs[0].written, ['code\r']);
  assert.equal(other.sent.length, 0);
  login.cancel();
});

test('when the login exits the status is re-checked and reported to its viewers', async () => {
  const { h, spawn, runner, broadcasts } = setup();
  const a = fakeWs();
  h.handleMessage(a, { type: 'claude-auth:login:start', cols: 80, rows: 12 });
  runner.out = LIVE;
  spawn.procs[0].exit(0);
  await new Promise((r) => setTimeout(r, 10));
  const [exit] = a.of('claude-auth:login:exit');
  assert.equal(exit.ok, true);
  assert.equal(exit.reason, 'exit');
  assert.equal(exit.status.email, 'user@example.com');
  // Every dashboard hears of the new login, the hasSubscription flag included.
  assert.ok(broadcasts.some((m) => m.type === 'claude-auth:status' && m.subscription === true && m.login.running === false));
  assert.ok(broadcasts.some((m) => m.type === 'prefs:claudeAuth'));
});

test('cancel from the dashboard kills the login and is not reported as a sign-in', async () => {
  const { h, spawn } = setup();
  const a = fakeWs();
  h.handleMessage(a, { type: 'claude-auth:login:start', cols: 80, rows: 12 });
  h.handleMessage(a, { type: 'claude-auth:login:cancel' });
  assert.deepEqual(spawn.procs[0].killed, ['SIGTERM']);
  await new Promise((r) => setTimeout(r, 10));
  const [exit] = a.of('claude-auth:login:exit');
  assert.equal(exit.reason, 'cancelled');
  assert.equal(exit.ok, false);
});
