// bin/supervisor.js: the child lifecycle (boot crash, boot timeout, restart
// exit code, crash loop, hang, Retry) and the rescue page's owner auth. The
// child is test/fixtures/supervisor-child.js, whose behaviour each start reads
// from a control file; every supervisor gets its own port and VISTACLAIR_HOME.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { writeSecretFile } = require('../src/secret-store');

const SUPERVISOR = path.join(__dirname, '..', 'bin', 'supervisor.js');
const CHILD = path.join(__dirname, 'fixtures', 'supervisor-child.js');
const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');

let ptyAvailable = false;
try { require('node-pty'); ptyAvailable = true; } catch {}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitFor(fn, timeoutMs = 10000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

function request(port, { path: p = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, agent: false, timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0 }));
    if (body) req.write(body);
    req.end();
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function supervise(t, mode, { env = {}, tg = false } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-sup-')));
  const port = await freePort();
  const ctrl = path.join(home, 'ctrl');
  const spawnsFile = path.join(home, 'spawns');
  fs.writeFileSync(ctrl, mode);
  fs.writeFileSync(spawnsFile, '');
  if (tg) writeSecretFile(path.join(home, 'tg-login.enc'), { botToken: '1:abc', ownerUserId: '42' }, home);
  const fullEnv = {
    ...process.env,
    VISTACLAIR_SUPERVISOR_CHILD: CHILD, VISTACLAIR_HOME: home, DASHBOARD_PORT: String(port), DASHBOARD_HOST: '127.0.0.1',
    AUTH_TOKEN: TOKEN, VISTACLAIR_BOOT_TIMEOUT_MS: '3000', VISTACLAIR_HEALTH_INTERVAL_MS: '300', VISTACLAIR_HANG_TIMEOUT_MS: '900', VISTACLAIR_KILL_GRACE_MS: '500',
    FAKE_CTRL: ctrl, FAKE_SPAWNS: spawnsFile, ...env,
  };
  delete fullEnv.VISTACLAIR_SERVER;
  delete fullEnv.VISTA_SECRETS_KEY;
  delete fullEnv.VISTACLAIR_SUPERVISED;
  for (const [k, v] of Object.entries(fullEnv)) if (v === undefined) delete fullEnv[k];
  const proc = spawn(process.execPath, [SUPERVISOR], { cwd: home, env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  proc.stdout.on('data', d => { output += d; });
  proc.stderr.on('data', d => { output += d; });
  const spawns = () => fs.readFileSync(spawnsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  t.after(async () => {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM');
      await waitFor(() => proc.exitCode !== null || proc.signalCode !== null, 5000, 'supervisor exit').catch(() => proc.kill('SIGKILL'));
    }
    for (const s of spawns()) { try { process.kill(s.pid, 'SIGKILL'); } catch {} }
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    proc, port, home, ctrl, spawns, output: () => output,
    rescued: (timeoutMs) => waitFor(async () => {
      const r = await request(port, { path: '/api/ping' });
      return r.status === 503 && r.json?.rescue ? r.json : null;
    }, timeoutMs, 'rescue mode'),
    up: (timeoutMs) => waitFor(async () => {
      const r = await request(port, { path: '/api/ping' });
      return r.status === 200 && r.json?.ok ? r.json : null;
    }, timeoutMs, 'server up'),
  };
}

const tokenCookie = { cookie: `token=${TOKEN}` };

function wsOpen(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rescue/ws`, { headers });
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    ws.on('open', () => resolve({ ws, msgs }));
    ws.on('unexpected-response', (req, res) => resolve({ status: res.statusCode }));
    ws.on('error', () => resolve({ status: 0 }));
  });
}

const output = (msgs) => msgs.filter(m => m.type === 'output').map(m => m.data).join('');

test('boot crash → rescue page on the port with the log tail; static-token auth', async (t) => {
  const s = await supervise(t, 'crash', { env: { VISTACLAIR_RESCUE_NO_PTY: '1' } });
  await s.rescued();

  // No credential: the page redirects to the login, status and WS are refused.
  const anon = await request(s.port, { path: '/' });
  assert.strictEqual(anon.status, 302);
  assert.strictEqual(anon.headers.location, '/login');
  assert.strictEqual((await request(s.port, { path: '/rescue/status' })).status, 401);
  assert.strictEqual((await wsOpen(s.port, { origin: `http://127.0.0.1:${s.port}` })).status, 401);

  // Token from a truly-local caller: the page, with the reason and the escaped log.
  const page = await request(s.port, { path: '/', headers: tokenCookie });
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /exited during startup \(exit code 3\)/);
  assert.match(page.body, /BOOM: fake boot failure &lt;script&gt;/);
  assert.strictEqual((await request(s.port, { path: '/', headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.strictEqual((await request(s.port, { path: '/', headers: { cookie: 'token=wrong' } })).status, 302);
  const status = await request(s.port, { path: '/rescue/status', headers: tokenCookie });
  assert.match(status.json.log, /BOOM: fake boot failure <script>/);
  // Telegram login not configured: the token works through a proxy too (as src/auth.js).
  assert.strictEqual((await request(s.port, { path: '/', headers: { ...tokenCookie, 'x-forwarded-for': '1.2.3.4' } })).status, 200);
  // Dashboard API calls get a JSON 503.
  const api = await request(s.port, { path: '/api/config', headers: tokenCookie });
  assert.strictEqual(api.status, 503);
  assert.strictEqual(api.json.rescue, true);

  // Login form sets the same cookie as server.js authCookie().
  const ok = await request(s.port, { path: '/login', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${TOKEN}` });
  assert.strictEqual(ok.status, 302);
  assert.strictEqual(ok.headers.location, '/');
  assert.deepStrictEqual(ok.headers['set-cookie'], [`token=${TOKEN}; HttpOnly; SameSite=Lax; Path=/`]);
  const bad = await request(s.port, { path: '/login', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=nope' });
  assert.strictEqual(bad.headers.location, '/login?error=1');

  // WebSocket: foreign or missing Origin refused even with the token.
  assert.strictEqual((await wsOpen(s.port, { ...tokenCookie, origin: 'http://evil.example' })).status, 403);
  assert.strictEqual((await wsOpen(s.port, tokenCookie)).status, 403);
  // Fallback shell (no PTY): one command at a time, output streamed back.
  const { ws, msgs } = await wsOpen(s.port, { ...tokenCookie, origin: `http://127.0.0.1:${s.port}` });
  await waitFor(() => msgs.find(m => m.type === 'hello'), 3000, 'hello');
  assert.strictEqual(msgs[0].mode, 'exec');
  ws.send(JSON.stringify({ type: 'exec', cmd: 'echo hi-$((1+1)); pwd' }));
  await waitFor(() => msgs.find(m => m.type === 'exit'), 5000, 'command exit');
  assert.match(output(msgs), /hi-2/);
  assert.match(output(msgs), new RegExp(path.join(__dirname, '..').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  ws.close();
});

test('Telegram configured: token only from truly-local callers; a valid sid is accepted', async (t) => {
  const s = await supervise(t, 'crash', { tg: true });
  const sid = crypto.randomBytes(32).toString('hex');
  const expired = crypto.randomBytes(32).toString('hex');
  const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
  fs.writeFileSync(path.join(s.home, 'sessions.json'), JSON.stringify([
    { id: 'a', sidHash: hash(sid), createdAt: Date.now(), expiresAt: Date.now() + 60000 },
    { id: 'b', sidHash: hash(expired), createdAt: 0, expiresAt: Date.now() - 1000 },
  ]));
  await s.rescued();
  const xff = { 'x-forwarded-for': '1.2.3.4' };

  assert.strictEqual((await request(s.port, { path: '/', headers: { ...tokenCookie, ...xff } })).status, 302);
  assert.strictEqual((await request(s.port, { path: '/rescue/status', headers: { authorization: `Bearer ${TOKEN}`, ...xff } })).status, 401);
  assert.strictEqual((await request(s.port, { path: '/', headers: tokenCookie })).status, 200);
  assert.strictEqual((await request(s.port, { path: '/', headers: { cookie: `sid=${sid}`, ...xff } })).status, 200);
  assert.strictEqual((await request(s.port, { path: '/', headers: { cookie: `sid=${expired}`, ...xff } })).status, 302);

  // Remote login form: no token form, and a POST with the right token is refused.
  const login = await request(s.port, { path: '/login', headers: xff });
  assert.match(login.body, /Telegram login is configured/);
  assert.doesNotMatch(login.body, /name="token"/);
  const post = await request(s.port, { path: '/login', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...xff }, body: `token=${TOKEN}` });
  assert.strictEqual(post.headers.location, '/login?error=1');

  const origin = { origin: `http://127.0.0.1:${s.port}` };
  assert.strictEqual((await wsOpen(s.port, { ...tokenCookie, ...xff, ...origin })).status, 401);
  const { ws, msgs } = await wsOpen(s.port, { cookie: `sid=${sid}`, ...xff, ...origin });
  await waitFor(() => msgs.find(m => m.type === 'hello'), 3000, 'hello');
  if (ptyAvailable && msgs[0].mode === 'pty') {
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    ws.send(JSON.stringify({ type: 'input', data: 'echo pty-$((2+3))\r' }));
    await waitFor(() => /pty-5/.test(output(msgs)), 8000, 'pty output');
  }
  ws.close();

  // An unreadable Telegram config fails closed: the token stays local-only.
  fs.writeFileSync(path.join(s.home, 'tg-login.enc'), 'garbage');
  assert.strictEqual((await request(s.port, { path: '/', headers: { ...tokenCookie, ...xff } })).status, 302);
});

test('boot timeout → child killed, rescue', async (t) => {
  const s = await supervise(t, 'hang-boot', { env: { VISTACLAIR_BOOT_TIMEOUT_MS: '1500' } });
  await s.rescued();
  const [first] = s.spawns();
  assert.strictEqual(alive(first.pid), false);
  const status = await request(s.port, { path: '/rescue/status', headers: tokenCookie });
  assert.match(status.json.reason, /did not answer \/api\/ping within 1\.5s/);
  assert.match(status.json.log, /fake: hanging during boot/);
});

test('exit code 75 → fresh child without rescue; same token, NO_OPEN after the first; SIGTERM stops all', async (t) => {
  const s = await supervise(t, 'ok', { env: { AUTH_TOKEN: undefined } });
  const first = await s.up();
  await waitFor(() => /server is up/.test(s.output()), 5000, 'supervisor sees the child up');
  await request(s.port, { path: '/restart' });
  const second = await waitFor(async () => {
    const r = await request(s.port, { path: '/api/ping' });
    assert.notStrictEqual(r.status, 503, 'rescue mode after a requested restart:\n' + s.output());
    return r.status === 200 && r.json.pid !== first.pid ? r.json : null;
  }, 10000, 'second child');
  const spawns = s.spawns();
  assert.strictEqual(spawns.length, 2);
  assert.ok(spawns[0].token && spawns[0].token === spawns[1].token, 'generated token kept across restarts');
  assert.deepStrictEqual(spawns.map(x => x.supervised), ['1', '1']);
  assert.deepStrictEqual(spawns.map(x => x.noOpen), [null, '1']);

  s.proc.kill('SIGTERM');
  await waitFor(() => s.proc.exitCode !== null, 5000, 'supervisor exit');
  assert.strictEqual(s.proc.exitCode, 0);
  assert.strictEqual(alive(second.pid), false);
});

test('crash loop → rescue after 3 crashes', async (t) => {
  const s = await supervise(t, 'crash-after-healthy');
  await s.rescued(20000);
  assert.strictEqual(s.spawns().length, 3);
  const status = await request(s.port, { path: '/rescue/status', headers: tokenCookie });
  assert.match(status.json.reason, /crashed 3 times/);
});

test('hang while running → child killed (SIGKILL after grace), rescue', async (t) => {
  const s = await supervise(t, 'stop-answering');
  await s.up();
  await s.rescued(15000);
  const [first] = s.spawns();
  assert.strictEqual(alive(first.pid), false);
  const status = await request(s.port, { path: '/rescue/status', headers: tokenCookie });
  assert.match(status.json.reason, /stopped answering/);
  assert.match(status.json.log, /ignoring SIGTERM/);
});

test('Retry start → the child is started again', async (t) => {
  const s = await supervise(t, 'crash');
  const { epoch } = await s.rescued();
  assert.strictEqual((await request(s.port, { path: '/rescue/retry', method: 'POST' })).status, 401);
  assert.strictEqual((await request(s.port, { path: '/rescue/retry', method: 'POST', headers: { ...tokenCookie, origin: 'http://evil.example' } })).status, 403);

  // Still broken: rescue comes back with a new epoch.
  assert.strictEqual((await request(s.port, { path: '/rescue/retry', method: 'POST', headers: tokenCookie })).status, 200);
  await waitFor(async () => (await request(s.port, { path: '/api/ping' })).json?.epoch > epoch, 10000, 'new rescue');
  assert.strictEqual(s.spawns().length, 2);

  // Fixed: the dashboard comes up.
  fs.writeFileSync(s.ctrl, 'ok');
  assert.strictEqual((await request(s.port, { path: '/rescue/retry', method: 'POST', headers: tokenCookie })).status, 200);
  await s.up();
  assert.strictEqual(s.spawns().length, 3);
});
