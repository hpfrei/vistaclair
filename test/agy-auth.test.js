// "Sign in to Antigravity": the `agy models` probe, the one `agy acp --login`
// pty the dashboard drives (src/agy-auth.js), the sign-in-needed detection and
// the WebSocket handler. agy is a FAKE: a Node script in a temp dir that
// mimics its prompts and exit codes; the real binary is never run.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const agyAuth = require('../src/agy-auth');
const { agyEnv, parseProbe, createRunner, AuthStatus, LoginProcess, spawnLoginPty, isAgySignInNeeded,
  agyAuthFailureReason, findAgyBin, CREDENTIAL_ENV } = agyAuth;
const handler = require('../src/ws/agy-auth-handler');

// --- The fake agy ----------------------------------------------------------
// $FAKE_AGY_DIR/state holds signed-in | signed-out | locked. `models` exits by
// it; `acp --login` prints agy's two lines, reads one line, and on "good-code"
// writes state signed-in and exits 0. Every run appends its argv and the
// sensitive env to $FAKE_AGY_DIR/runs.jsonl.
const FAKE = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const dir = process.env.FAKE_AGY_DIR;
const stateFile = path.join(dir, 'state');
const state = () => fs.readFileSync(stateFile, 'utf8').trim();
const env = {};
for (const k of ['GEMINI_API_KEY','GOOGLE_API_KEY','AGY_ADC_AUTH','GOOGLE_APPLICATION_CREDENTIALS','AGY_CLI_DISABLE_AUTO_UPDATE','BROWSER','DISPLAY','DBUS_SESSION_BUS_ADDRESS']) env[k] = process.env[k] ?? null;
fs.appendFileSync(path.join(dir, 'runs.jsonl'), JSON.stringify({ argv: process.argv.slice(2), env }) + '\\n');
const [cmd, flag] = process.argv.slice(2);
if (cmd === 'models') {
  console.log('Fetching available models...');
  if (state() === 'signed-in') { console.log('gemini-3-pro\\ngemini-3-flash'); process.exit(0); }
  if (state() === 'locked') { console.error('Error: failed to retrieve token: secret keyring is locked'); process.exit(1); }
  console.error('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.');
  process.exit(1);
}
if (cmd === 'acp' && flag === '--login') {
  console.log('Open this link in a browser to log in with Google:\\n\\n  https://accounts.example.com/o/oauth2?x=1\\n');
  console.log('Then paste the authorization code, or the full URL of the page you land on, and press Enter:');
  process.on('SIGTERM', () => process.exit(143));
  if (process.env.FAKE_AGY_HANG) { setInterval(() => {}, 1000); return; }
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    const nl = buf.search(/[\\r\\n]/);
    if (nl < 0) return;
    const line = buf.slice(0, nl);
    fs.appendFileSync(path.join(dir, 'pasted'), line + '|');
    if (line === 'good-code') { fs.writeFileSync(stateFile, 'signed-in'); process.exit(0); }
    console.error('login failed'); process.exit(1);
  });
  process.stdin.on('end', () => { console.error('login cancelled: no authorization code was entered'); process.exit(1); });
}
`;

function fakeAgy(state = 'signed-out') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-fakeagy-'));
  const bin = path.join(dir, 'agy');
  fs.writeFileSync(bin, FAKE, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'state'), state);
  const f = {
    dir, bin,
    set(s) { fs.writeFileSync(path.join(dir, 'state'), s); },
    runs() {
      try { return fs.readFileSync(path.join(dir, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; }
    },
    pasted() { try { return fs.readFileSync(path.join(dir, 'pasted'), 'utf8'); } catch { return ''; } },
    clean() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
  return f;
}

// Run fn with the environment variables set (null deletes), then restore.
async function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// --- The probe ---------------------------------------------------------------

test('parseProbe: exit 0 is signed in and exposes no model list', () => {
  const s = parseProbe({ exitCode: 0, stdout: 'Fetching...\ngemini-3-pro\n', stderr: '' });
  assert.deepEqual(s, { state: 'signed-in', installed: true, signedIn: true });
});

test('parseProbe: signed out, keyring locked, not installed, and an unexplained failure', () => {
  assert.equal(parseProbe({ exitCode: 1, stdout: '', stderr: 'Error: Please sign in to view available models.' }).state, 'signed-out');
  assert.equal(parseProbe({ exitCode: 1, stdout: '', stderr: 'failed to retrieve token: secret keyring is locked' }).state, 'keyring-locked');
  assert.equal(parseProbe({ notFound: true }).state, 'not-installed');
  assert.equal(parseProbe(null).installed, false);
  // A bare failure proves nothing about the login.
  assert.equal(parseProbe({ exitCode: 1, stdout: '', stderr: 'boom' }).state, 'unknown');
  assert.equal(parseProbe({ exitCode: 1, stdout: '', stderr: '' }).signedIn, false);
});

test('the runner runs `agy models` and reads the four states from a fake agy', async () => {
  const f = fakeAgy('signed-in');
  try {
    await withEnv({ FAKE_AGY_DIR: f.dir }, async () => {
    const runner = createRunner({ bin: f.bin });
    assert.equal(parseProbe(await runner.run()).state, 'signed-in');
    f.set('signed-out');
    assert.equal(parseProbe(await runner.run()).state, 'signed-out');
    f.set('locked');
    assert.equal(parseProbe(await runner.run()).state, 'keyring-locked');
    assert.deepEqual(f.runs().map((r) => r.argv), [['models'], ['models'], ['models']]);
    const missing = createRunner({ bin: path.join(f.dir, 'nope') });
    assert.equal(parseProbe(await missing.run()).state, 'not-installed');
    assert.equal(parseProbe(await createRunner({ bin: () => null }).run()).state, 'not-installed');
    });
  } finally { f.clean(); }
});

test('findAgyBin: $VISTACLAIR_AGY_BIN, then PATH, then ~/.local/bin', () => {
  const f = fakeAgy();
  try {
    assert.equal(findAgyBin({ env: { VISTACLAIR_AGY_BIN: f.bin } }), f.bin);
    assert.equal(findAgyBin({ env: { VISTACLAIR_AGY_BIN: path.join(f.dir, 'nope') } }), null);
    assert.equal(findAgyBin({ env: { PATH: f.dir }, home: '/nonexistent' }), f.bin);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-home-'));
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    assert.equal(findAgyBin({ env: { PATH: '/nonexistent' }, home }), null);
    fs.copyFileSync(f.bin, path.join(home, '.local/bin/agy'));
    fs.chmodSync(path.join(home, '.local/bin/agy'), 0o755);
    assert.equal(findAgyBin({ env: { PATH: '/nonexistent' }, home }), path.join(home, '.local/bin/agy'));
    fs.rmSync(home, { recursive: true, force: true });
  } finally { f.clean(); }
});

// --- The environment --------------------------------------------------------

test('credential variables are stripped from the probe and login env, the update check is off', () => {
  const env = agyEnv({ env: {
    GEMINI_API_KEY: 'a', GOOGLE_API_KEY: 'b', AGY_ADC_AUTH: 'c', GOOGLE_APPLICATION_CREDENTIALS: '/x', KEEP: 'yes',
    BROWSER: 'firefox', DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/bus',
  } });
  for (const k of CREDENTIAL_ENV) assert.equal(k in env, false, k);
  assert.equal(env.KEEP, 'yes');
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
  // The probe leaves the display alone; the login never opens a browser.
  assert.equal(env.DISPLAY, ':0');
  const login = agyEnv({ login: true, env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'w', BROWSER: 'firefox', GEMINI_API_KEY: 'a' } });
  assert.equal(login.BROWSER, '/bin/false');
  assert.equal('DISPLAY' in login, false);
  assert.equal('WAYLAND_DISPLAY' in login, false);
  assert.equal('GEMINI_API_KEY' in login, false);
});

test('the session bus is derived from /run/user/<uid>/bus when unset, never overriding a set one', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-run-'));
  try {
    assert.equal('DBUS_SESSION_BUS_ADDRESS' in agyEnv({ env: {}, uid: 4242, runDir }), false);
    fs.mkdirSync(path.join(runDir, '4242'));
    fs.writeFileSync(path.join(runDir, '4242', 'bus'), '');
    assert.equal(agyEnv({ env: {}, uid: 4242, runDir }).DBUS_SESSION_BUS_ADDRESS, `unix:path=${runDir}/4242/bus`);
    assert.equal(agyEnv({ env: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/mine' }, uid: 4242, runDir }).DBUS_SESSION_BUS_ADDRESS, 'unix:path=/mine');
  } finally { fs.rmSync(runDir, { recursive: true, force: true }); }
});

test('the spawned probe and login processes never see the server\'s Google credentials', async () => {
  const f = fakeAgy('signed-out');
  const secrets = { GEMINI_API_KEY: 'k1', GOOGLE_API_KEY: 'k2', AGY_ADC_AUTH: '1', GOOGLE_APPLICATION_CREDENTIALS: '/c.json', FAKE_AGY_DIR: f.dir, BROWSER: 'firefox', DISPLAY: ':9' };
  try {
    await withEnv(secrets, async () => {
      await createRunner({ bin: f.bin }).run();
      const login = new LoginProcess({ spawn: (o) => spawnLoginPty({ ...o, bin: f.bin }) });
      const exited = new Promise((r) => login.on('exit', r));
      login.start({ cols: 80, rows: 12 });
      await new Promise((r) => setTimeout(r, 400));
      login.cancel();
      await exited;
    });
    const [probe, loginRun] = f.runs();
    for (const run of [probe, loginRun]) {
      assert.equal(run.env.GEMINI_API_KEY, null);
      assert.equal(run.env.GOOGLE_API_KEY, null);
      assert.equal(run.env.AGY_ADC_AUTH, null);
      assert.equal(run.env.GOOGLE_APPLICATION_CREDENTIALS, null);
      assert.equal(run.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
    }
    assert.deepEqual(loginRun.argv, ['acp', '--login']);
    assert.equal(loginRun.env.BROWSER, '/bin/false');
    assert.equal(loginRun.env.DISPLAY, null);
  } finally { f.clean(); }
});

// --- The cached status --------------------------------------------------------

test('AuthStatus caches within the TTL, refreshes after it, and emits only on change', async () => {
  let now = 1000, out = { exitCode: 1, stderr: 'Please sign in' }, runs = 0;
  const st = new AuthStatus({ runner: { run: async () => { runs++; return out; } }, ttlMs: 100, now: () => now });
  const changes = [];
  st.on('change', (s) => changes.push(s.state));
  assert.equal(st.get(), null);
  await st.refresh();
  assert.equal(st.get().state, 'signed-out');
  assert.equal(runs, 1);
  now += 50; st.get(); assert.equal(runs, 1);
  now += 100; out = { exitCode: 0 }; st.get();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(runs, 2);
  assert.deepEqual(changes, ['signed-out', 'signed-in']);
  await Promise.all([st.refresh(), st.refresh()]);
  assert.equal(runs, 3);
});

// --- The login (a real pty running the fake agy) ---------------------------------

function collect(login) {
  const c = { out: '', exits: [] };
  login.on('output', (d) => { c.out += d; });
  c.exited = new Promise((r) => login.on('exit', (e) => { c.exits.push(e); r(e); }));
  return c;
}
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 20)); }
}

test('login: the link and paste prompt are relayed, the pasted code is written with \\r, exit 0 re-probes as signed in', async () => {
  const f = fakeAgy('signed-out');
  try {
    await withEnv({ FAKE_AGY_DIR: f.dir }, async () => {
      const login = new LoginProcess({ spawn: (o) => spawnLoginPty({ ...o, bin: f.bin }) });
      const c = collect(login);
      assert.equal(login.start({ cols: 100, rows: 12 }), true);
      await until(() => /press Enter:/.test(c.out));
      assert.match(c.out, /Open this link in a browser to log in with Google:\s+https:\/\/accounts\.example\.com\/o\/oauth2\?x=1\s/);
      assert.match(login.replay, /paste the authorization code/);
      login.write('good-code\r');
      const exit = await c.exited;
      assert.deepEqual(exit, { exitCode: 0, signal: null, reason: 'exit' });
      assert.equal(f.pasted(), 'good-code|');
      // The re-probe after exit 0.
      const st = new AuthStatus({ runner: createRunner({ bin: f.bin }) });
      assert.equal((await st.refresh()).state, 'signed-in');
    });
  } finally { f.clean(); }
});

test('login: a rejected code exits non-zero and the account stays signed out', async () => {
  const f = fakeAgy('signed-out');
  try {
    await withEnv({ FAKE_AGY_DIR: f.dir }, async () => {
      const login = new LoginProcess({ spawn: (o) => spawnLoginPty({ ...o, bin: f.bin }) });
      const c = collect(login);
      login.start({});
      await until(() => /press Enter:/.test(c.out));
      login.write('bad\r');
      assert.equal((await c.exited).exitCode, 1);
      assert.equal((await createRunner({ bin: f.bin }).run()).exitCode, 1);
    });
  } finally { f.clean(); }
});

test('login: cancel sends SIGTERM and reports cancelled; the timeout kills with reason timeout', async () => {
  const f = fakeAgy('signed-out');
  try {
    await withEnv({ FAKE_AGY_DIR: f.dir, FAKE_AGY_HANG: '1' }, async () => {
      const spawn = (o) => spawnLoginPty({ ...o, bin: f.bin });
      const a = new LoginProcess({ spawn });
      const ca = collect(a);
      a.start({});
      await until(() => /press Enter:/.test(ca.out));
      assert.equal(a.cancel(), true);
      const ea = await ca.exited;
      assert.equal(ea.reason, 'cancelled');
      assert.equal(a.running, false);

      const b = new LoginProcess({ spawn, timeoutMs: 300 });
      const cb = collect(b);
      b.start({});
      const eb = await cb.exited;
      assert.equal(eb.reason, 'timeout');
      assert.equal(b.running, false);
    });
  } finally { f.clean(); }
});

test('login: a missing agy is an error at start, not a hang', () => {
  const login = new LoginProcess({ spawn: (o) => spawnLoginPty({ ...o, bin: undefined }) });
  const prev = process.env.VISTACLAIR_AGY_BIN;
  process.env.VISTACLAIR_AGY_BIN = '/nonexistent/agy';
  try { assert.throws(() => login.start({}), /not installed/); } finally {
    if (prev === undefined) delete process.env.VISTACLAIR_AGY_BIN; else process.env.VISTACLAIR_AGY_BIN = prev;
  }
  assert.equal(login.running, false);
});

// --- Sign-in needed -------------------------------------------------------------

test('isAgySignInNeeded: the known messages, in stderr or the -p JSON error', () => {
  for (const msg of ['Authentication required', 'Error: Please sign in', 'Not logged into Antigravity', 'authentication failed or timed out']) {
    assert.equal(isAgySignInNeeded({ exitCode: 1, stderr: `x\n${msg.toUpperCase()}\n` }), true, msg);
    assert.equal(isAgySignInNeeded({ exitCode: 1, json: { status: 'ERROR', error: msg } }), true, msg);
  }
  assert.equal(isAgySignInNeeded({ exitCode: 1, stdout: JSON.stringify({ status: 'ERROR', error: { message: 'Please sign in' } }) }), true);
});

test('isAgySignInNeeded: -p JSON ERROR with an auth-related error', () => {
  assert.equal(isAgySignInNeeded({ exitCode: 1, json: { status: 'ERROR', error: 'Unauthorized (401)' } }), true);
  assert.equal(isAgySignInNeeded({ exitCode: 1, json: { status: 'ERROR', error: 'authentication token rejected' } }), true);
});

test('isAgySignInNeeded: a bare exit 1 or an unrelated error is not enough', () => {
  assert.equal(isAgySignInNeeded({ exitCode: 1 }), false);
  assert.equal(isAgySignInNeeded({ exitCode: 1, stdout: '', stderr: '' }), false);
  assert.equal(isAgySignInNeeded({ exitCode: 1, stderr: 'segmentation fault' }), false);
  assert.equal(isAgySignInNeeded({ exitCode: 1, json: { status: 'ERROR', error: 'model overloaded' } }), false);
  assert.equal(isAgySignInNeeded({ exitCode: 0, json: { status: 'OK' } }), false);
  assert.equal(isAgySignInNeeded({}), false);
  assert.equal(isAgySignInNeeded(), false);
});

test('a locked keyring is its own reason, not "sign in"', () => {
  const info = { exitCode: 1, stderr: 'failed to retrieve token: secret keyring is locked' };
  assert.equal(agyAuthFailureReason(info), 'keyring-locked');
  assert.equal(isAgySignInNeeded(info), false);
  assert.equal(agyAuthFailureReason({ exitCode: 1, stderr: 'Please sign in' }), 'sign-in-needed');
  assert.equal(agyAuthFailureReason({ exitCode: 1 }), null);
});

// --- The WebSocket handler --------------------------------------------------------

function fakePty() {
  const p = {
    written: [], killed: [], dataCbs: [], exitCbs: [],
    onData(cb) { p.dataCbs.push(cb); }, onExit(cb) { p.exitCbs.push(cb); },
    write(d) { p.written.push(d); }, resize() {},
    kill(sig) { p.killed.push(sig); p.exit(143); },
    print(d) { for (const cb of p.dataCbs) cb(d); },
    exit(exitCode) { for (const cb of p.exitCbs) cb({ exitCode, signal: 0 }); },
  };
  return p;
}
function fakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (d) => ws.sent.push(JSON.parse(d));
  ws.of = (t) => ws.sent.filter((m) => m.type === t);
  return ws;
}
function setup() {
  const out = { v: { exitCode: 1, stderr: 'Please sign in' } };
  const authStatus = new AuthStatus({ runner: { run: async () => out.v } });
  const procs = [];
  const login = new LoginProcess({ spawn: (a) => { const p = fakePty(); p.args = a; procs.push(p); return p; } });
  const broadcasts = [];
  const bc = { broadcast: (m) => broadcasts.push(m) };
  return { out, authStatus, login, procs, broadcasts, h: handler.create(bc, { authStatus, login }), bc };
}

test('handler: start relays the screen, a joiner gets the replay, only watchers type', () => {
  const { h, procs, login } = setup();
  const a = fakeWs(), b = fakeWs(), other = fakeWs();
  h.handleMessage(a, { type: 'agy-auth:login:start', cols: 80, rows: 12 });
  assert.deepEqual(a.of('agy-auth:login:started'), [{ type: 'agy-auth:login:started', attached: false, replay: '' }]);
  procs[0].print('Open this link in a browser to log in with Google: https://x/y\r\n');
  h.handleMessage(b, { type: 'agy-auth:login:start' });
  assert.equal(procs.length, 1);
  assert.match(b.of('agy-auth:login:started')[0].replay, /https:\/\/x\/y/);
  h.handleMessage(other, { type: 'agy-auth:login:input', data: 'x' });
  h.handleMessage(b, { type: 'agy-auth:login:input', data: 'code\r' });
  assert.deepEqual(procs[0].written, ['code\r']);
  login.cancel();
});

test('handler: exit 0 re-probes and reports ok with the status; cancel is not a sign-in', async () => {
  const { h, procs, out, broadcasts } = setup();
  const a = fakeWs();
  h.handleMessage(a, { type: 'agy-auth:login:start' });
  out.v = { exitCode: 0 };
  procs[0].exit(0);
  await new Promise((r) => setTimeout(r, 10));
  const [exit] = a.of('agy-auth:login:exit');
  assert.equal(exit.ok, true);
  assert.deepEqual(exit.status, { state: 'signed-in', installed: true, signedIn: true });
  assert.ok(broadcasts.some((m) => m.type === 'agy-auth:status' && m.status?.signedIn && !m.login.running));

  const b = fakeWs();
  h.handleMessage(b, { type: 'agy-auth:login:start' });
  h.handleMessage(b, { type: 'agy-auth:login:cancel' });
  assert.deepEqual(procs[1].killed, ['SIGTERM']);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(b.of('agy-auth:login:exit')[0].ok, false);
  assert.equal(b.of('agy-auth:login:exit')[0].reason, 'cancelled');
});

test('handler: a start that throws reports an error to the dashboard', () => {
  const authStatus = new AuthStatus({ runner: { run: async () => ({}) } });
  const login = new LoginProcess({ spawn: () => { throw new Error('agy is not installed'); } });
  const h = handler.create({ broadcast() {} }, { authStatus, login });
  const a = fakeWs();
  h.handleMessage(a, { type: 'agy-auth:login:start' });
  assert.match(a.of('agy-auth:login:error')[0].error, /not installed/);
});

test('handler: status carries no account detail, only the state', async () => {
  const { h } = setup();
  const a = fakeWs();
  h.handleMessage(a, { type: 'agy-auth:status', refresh: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(a.of('agy-auth:status')[0].status, { state: 'signed-out', installed: true, signedIn: false });
});

test('reportAgyAuthFailure broadcasts agy-auth:needed only for auth failures', () => {
  const { broadcasts, bc } = setup();
  assert.equal(handler.reportAgyAuthFailure({ exitCode: 1 }, bc), null);
  assert.equal(broadcasts.length, 0);
  assert.equal(handler.reportAgyAuthFailure({ exitCode: 1, stderr: 'Authentication required' }, bc), 'sign-in-needed');
  assert.equal(handler.reportAgyAuthFailure({ exitCode: 1, stderr: 'secret keyring is locked' }, bc), 'keyring-locked');
  assert.deepEqual(broadcasts, [
    { type: 'agy-auth:needed', reason: 'sign-in-needed' },
    { type: 'agy-auth:needed', reason: 'keyring-locked' },
  ]);
});

test('the dashboard module sends the pasted code with \\r and shows the four states', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/agy-signin.js'), 'utf8');
  assert.match(src, /data: value \+ '\\r'/);
  for (const s of ['not-installed', 'signed-out', 'keyring-locked', 'signed-in']) assert.ok(src.includes(`'${s}'`), s);
  assert.ok(src.includes("'agy-auth:needed'"));
});

// --- The Models tab section (Gemini provider) ---------------------------------------

test('Models tab: the Antigravity section renders for every state', () => {
  const { renderAgyAuthSection, INSTALL_CMD } = require('../public/agy-auth-section');
  const section = (state) => renderAgyAuthSection(state ? { state } : null);
  for (const st of ['signed-in', 'signed-out', 'keyring-locked', 'not-installed', 'unknown', null]) {
    const html = section(st);
    assert.match(html, /id="agyAuthSection"/, String(st));
    assert.match(html, /Antigravity \(Google AI subscription\)/);
    assert.match(html, /API key above is separate from the Antigravity subscription/);
  }
  assert.match(section('signed-out'), /signed out[\s\S]*data-agy-signin[^>]*>Sign in to Antigravity</);
  assert.match(section('signed-in'), /signed in[\s\S]*data-agy-signin[^>]*>Sign in with another account</);
  assert.match(section('unknown'), /data-agy-signin/);
  // Nothing to click when agy is missing or the keyring is locked: the reason is shown instead.
  assert.doesNotMatch(section('not-installed'), /data-agy-signin/);
  assert.match(section('not-installed'), /not installed/);
  assert.ok(section('not-installed').includes(INSTALL_CMD));
  assert.equal(INSTALL_CMD, 'curl -fsSL https://antigravity.google/cli/install.sh | bash');
  assert.doesNotMatch(section('keyring-locked'), /data-agy-signin/);
  assert.match(section('keyring-locked'), /keyring locked[\s\S]*Secret Service/);
  assert.match(section(null), /checking/);
});

test('Models tab: the section is drawn under the gemini provider and fed by agy-signin.js', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('public/capabilities.js'), /prov\.key === 'gemini'[\s\S]{0,120}renderAgyAuthSection\(state\.agyAuth/);
  assert.match(read('public/agy-signin.js'), /state\.agyAuth = msg\.status/);
  const html = read('public/index.html');
  assert.ok(html.indexOf('agy-auth-section.js') > 0 && html.indexOf('agy-auth-section.js') < html.indexOf('capabilities.js'));
});

test('findAgyBin finds ~/.local/bin/agy when PATH lacks it (a service-started server)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-home-'));
  try {
    fs.mkdirSync(path.join(home, '.local/bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local/bin/agy'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(findAgyBin({ env: { PATH: '/usr/bin:/bin' }, home }), path.join(home, '.local/bin/agy'));
    assert.equal(findAgyBin({ env: {}, home }), path.join(home, '.local/bin/agy'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
