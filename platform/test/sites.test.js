// Sites (docs/sites.md): the engine, the runner, the byte-proxy, deploy.
// Offline: a temp apps dir, fixture apps, real child processes on free ports.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const cp = require('child_process');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const sites = require('../src/apps/sites');
const sitesProxy = require('../src/apps/sites-proxy');
const { validateSites } = require('../src/apps/sites-manifest');

// secrets the runner must never see
process.env.AUTH_TOKEN = 'test-auth-token-xyz';
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
process.env.OPENAI_API_KEY = 'sk-openai-test-key';

const HANDLER = `
const fs = require('fs');
module.exports = function createSite(site) {
  const serve = site.static();
  return {
    async request(req, res) {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/hello') return res.end('hello ' + site.name + ' ' + site.port + ' VERSION');
      if (u.pathname === '/read') { try { fs.readFileSync(u.searchParams.get('f')); res.end('read'); } catch (e) { res.end('denied:' + e.code); } return; }
      if (u.pathname === '/call') {
        try { const r = await site.call(u.searchParams.get('name'), { pad: 'x'.repeat(Number(u.searchParams.get('size') || 0)) }); res.end(JSON.stringify({ ok: true, r })); }
        catch (e) { res.end(JSON.stringify({ ok: false, code: e.code, error: e.message })); }
        return;
      }
      if (u.pathname === '/echo') { res.setHeader('set-cookie', ['sid=evil; Path=/', 'keep=1']); return res.end(JSON.stringify({ cookie: req.headers.cookie || null, prefix: req.headers['x-forwarded-prefix'] || null, url: req.url })); }
      if (u.pathname === '/config') return res.end(JSON.stringify(site.config));
      await serve(req, res);
    },
    upgrade(req, socket) {
      socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: echo\\r\\nConnection: Upgrade\\r\\nSet-Cookie: sid=evil\\r\\nSet-Cookie: ok=1\\r\\n\\r\\n');
      socket.pipe(socket);
    },
  };
};
`;

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    r.setTimeout(3000, () => r.destroy(new Error('timeout')));
    r.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, step = 100) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* not yet */ }
    if (Date.now() > end) return null;
    await sleep(step);
  }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

let appsDir, P = {};
const events = [];

function writeApp(name, siteDefs, handler = HANDLER) {
  const d = path.join(appsDir, name);
  fs.mkdirSync(path.join(d, 'site'), { recursive: true });
  fs.writeFileSync(path.join(d, 'site', 'index.js'), handler);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, private: true }));
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ name, sites: siteDefs }, null, 2));
}

test.before(async () => {
  for (const k of ['main', 'api', 'main2', 'hx', 'foreign']) P[k] = await freePort();
  appsDir = makeAppsDir({ fx: {}, hx: {} });
  appManager.setAppsDir(appsDir);
  writeApp('fx', {
    main: { handler: 'site/index.js', defaultPort: P.main, access: 'public', autostart: true },
    api: { handler: 'site/index.js', defaultPort: P.api, access: 'public', platform: 'controlled', autostart: true },
  });
  writeApp('hx', { main: { handler: 'site/index.js', defaultPort: P.hx, access: 'public', autostart: true } });
  // the core .env a fenced site must not read
  fs.mkdirSync(path.join(appsDir, '.core'), { recursive: true });
  fs.writeFileSync(path.join(appsDir, '.core', '.env'), 'AUTH_TOKEN=x\n');
  sites.init({ broadcast() {}, dashboardPort: 3457, proxyPort: 3456 });
  sites.onEvent(e => events.push(e));
});

test.after(async () => {
  await sites.stopAll();
  fs.rmSync(appsDir, { recursive: true, force: true });
});

test('validation: P1 builds access public and platform none|controlled; handler in a subdir', () => {
  const ok = validateSites({ a: { handler: 'site/index.js', defaultPort: 8080, access: 'public' } });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.sites.a.platform, 'none');
  assert.equal(ok.sites.a.bind, '127.0.0.1');
  const bad = validateSites({
    u: { handler: 'site/index.js', defaultPort: 8081, access: 'users' },
    v: { handler: 'site/index.js', defaultPort: 8082, access: 'vc' },
    l: { handler: 'site/index.js', defaultPort: 8083, access: 'public', platform: 'loose' },
    r: { handler: 'index.js', defaultPort: 8084, access: 'public' },
    t: { handler: '../x/index.js', defaultPort: 8085, access: 'public' },
    d: { handler: 'site/index.js', defaultPort: 3457, access: 'public' },
    n: { handler: 'site/index.js', defaultPort: 8086 },
  }).errors.join('\n');
  assert.match(bad, /sites\.u\.access: "users" is not built yet/);
  assert.match(bad, /sites\.v\.access: "vc" is not built yet/);
  assert.match(bad, /sites\.l\.platform: "loose" is not built yet/);
  assert.match(bad, /sites\.r\.handler: must live in its own directory/);
  assert.match(bad, /sites\.t\.handler: a relative path inside the app/);
  assert.match(bad, /sites\.d\.defaultPort: 3457 is the dashboard's or the proxy's port/);
  assert.match(bad, /sites\.n\.access: required/);
});

test('1. a declared site serves on its port; a port change restarts it on the new one', async () => {
  const st = await sites.start('fx', 'main');
  assert.equal(st.state, 'running');
  assert.equal(st.port, P.main);
  const r = await get(P.main, '/hello');
  assert.equal(r.status, 200);
  assert.match(r.body, /^hello main/);
  const after = await sites.hostSettings('fx', 'main', { port: P.main2 });
  assert.equal(after.state, 'running');
  assert.equal(after.port, P.main2);
  assert.match((await get(P.main2, '/hello')).body, /^hello main/);
  await assert.rejects(get(P.main, '/hello'), 'the old port is closed');
  // the host record holds it, the manifest is untouched
  assert.equal(JSON.parse(fs.readFileSync(path.join(appsDir, 'fx', '.sites.json'), 'utf8')).main.port, P.main2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(appsDir, 'fx', 'manifest.json'), 'utf8')).sites.main.defaultPort, P.main);
  // a port another site uses is refused
  await assert.rejects(sites.hostSettings('fx', 'api', { port: P.main2 }), /already used by the site fx\/main/);
  await assert.rejects(sites.hostSettings('fx', 'api', { port: 3457 }), /dashboard or the proxy/);
});

test('6. gate: no AUTH_TOKEN / provider key in the runner env; the fence stops reading the core .env', async () => {
  const st = sites.status('fx', 'main');
  const env = fs.readFileSync(`/proc/${st.pid}/environ`, 'utf8');
  assert.ok(!env.includes('test-auth-token-xyz') && !/AUTH_TOKEN=/.test(env), 'no AUTH_TOKEN');
  assert.ok(!env.includes('sk-ant-test-key') && !env.includes('sk-openai-test-key'), 'no provider keys');
  assert.ok(env.includes('VC_SITE_KEY=fx/main'), 'the marker is there');
  if (!sites.fenceAvailable()) { test.skip?.('node lacks --permission'); return; }
  assert.equal(st.fence, 'fenced');
  const r = await get(st.port, `/read?f=${encodeURIComponent(path.join(appsDir, '.core', '.env'))}`);
  assert.equal(r.body, 'denied:ERR_ACCESS_DENIED');
  const own = await get(st.port, `/read?f=${encodeURIComponent(path.join(appsDir, 'fx', 'manifest.json'))}`);
  assert.equal(own.body, 'denied:ERR_ACCESS_DENIED', 'not even its own app root');
});

test('8. traversal and dotfiles are refused by site.static', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-site-src-'));
  fs.writeFileSync(path.join(src, 'index.html'), '<h1>v1</h1>');
  fs.writeFileSync(path.join(src, '.secret'), 'SECRET');
  fs.mkdirSync(path.join(src, 'sub'));
  fs.writeFileSync(path.join(src, 'sub', 'a.txt'), 'A');
  await sites.publish('fx', 'main', src, { note: 'v1' });
  const port = sites.status('fx', 'main').port;
  assert.equal((await get(port, '/')).body, '<h1>v1</h1>');
  assert.equal((await get(port, '/sub/a.txt')).body, 'A');
  for (const p of ['/../manifest.json', '/%2e%2e/manifest.json', '/sub/..%2f..%2fmanifest.json', '/.secret', '/.vc-snapshot.json', '/sub/%2e%2e/.secret', '/..%5c..%5cmanifest.json', '/%00']) {
    const r = await get(port, p);
    assert.ok(r.status >= 400 && r.status < 500, `${p} → ${r.status}`);
    assert.ok(!/SECRET|"sites"|"id":/.test(r.body), `${p} leaks nothing`);
  }
  // ETag + range
  const full = await get(port, '/index.html');
  assert.ok(full.headers.etag);
  assert.equal((await get(port, '/index.html', { 'if-none-match': full.headers.etag })).status, 304);
  const part = await get(port, '/index.html', { range: 'bytes=0-3' });
  assert.equal(part.status, 206);
  assert.equal(part.body, '<h1>');
  fs.rmSync(src, { recursive: true, force: true });
});

test('5. publishing under a request loop fails no request; rollback switches in < 1 s', async () => {
  const port = sites.status('fx', 'main').port;
  let fails = 0, okCount = 0, stop = false;
  const loop = async () => {
    while (!stop) {
      try { const r = await get(port, '/index.html'); if (r.status === 200 && /<h1>v\d<\/h1>/.test(r.body)) okCount++; else fails++; } catch { fails++; }
    }
  };
  const loops = [loop(), loop(), loop(), loop()];
  const ids = [];
  for (const v of [2, 3, 4]) {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-site-src-'));
    fs.writeFileSync(path.join(src, 'index.html'), `<h1>v${v}</h1>`);
    ids.push((await sites.publish('fx', 'main', src, { note: `v${v}` })).id);
    fs.rmSync(src, { recursive: true, force: true });
    await sleep(100);
  }
  stop = true;
  await Promise.all(loops);
  assert.equal(fails, 0, 'no failed request');
  assert.ok(okCount > 20, `requests ran (${okCount})`);
  assert.equal((await get(port, '/index.html')).body, '<h1>v4</h1>');
  const t0 = Date.now();
  const rb = await sites.rollback('fx', 'main', ids[0]);
  const body = (await get(port, '/index.html')).body;
  const ms = Date.now() - t0;
  assert.equal(body, '<h1>v2</h1>');
  assert.ok(ms < 1000, `rollback took ${ms} ms`);
  assert.equal(rb.id, ids[0]);
  const list = sites.snapshots('fx', 'main');
  assert.equal(list.find(s => s.active).id, ids[0]);
  assert.ok(events.some(e => e.kind === 'site:published' && e.data.rollback === true));
  // keep: the owner's number of snapshots
  await sites.hostSettings('fx', 'main', { keep: 2 });
  assert.equal(sites.snapshots('fx', 'main').length, 2);
  assert.ok(sites.snapshots('fx', 'main').some(s => s.id === ids[0]), 'the active one is kept');
});

test('4. site.call: platform none rejects; controlled serves only registered names, refuses oversize args', async () => {
  // the app behind the site must be running for its handlers to answer
  await appManager.mountRoutes('fx', { broadcast() {} });
  const off = sites.onCall('fx', 'ping', async (args, meta) => ({ pong: true, len: args.pad.length, ip: meta.ipPrefix }));
  const mainPort = sites.status('fx', 'main').port;
  const none = JSON.parse((await get(mainPort, '/call?name=ping')).body);
  assert.equal(none.ok, false);
  assert.equal(none.code, 'platform_none');
  await sites.start('fx', 'api');
  const ok = JSON.parse((await get(P.api, '/call?name=ping&size=10')).body);
  assert.deepEqual(ok, { ok: true, r: { pong: true, len: 10, ip: '127.0.0.0/24' } });
  const unknown = JSON.parse((await get(P.api, '/call?name=nope')).body);
  assert.equal(unknown.code, 'unknown_call');
  const big = JSON.parse((await get(P.api, `/call?name=ping&size=${70 * 1024}`)).body);
  assert.equal(big.code, 'too_large');
  off();
  assert.equal(JSON.parse((await get(P.api, '/call?name=ping')).body).code, 'unknown_call', 'unregistered again');
  // live config reaches the handler without a restart
  const pid = sites.status('fx', 'api').pid;
  sites.setConfig('fx', 'api', { greeting: 'hi' });
  assert.deepEqual(JSON.parse((await until(async () => { const r = await get(P.api, '/config'); return r.body.includes('hi') && r; }, 2000)).body), { greeting: 'hi' });
  assert.equal(sites.status('fx', 'api').pid, pid);
});

test('3. kill -9 of the runner while the parent lives: serving again within 10 s, crash count 1, site:crashed', async () => {
  const before = sites.status('fx', 'api');
  const c0 = before.crashCount;
  process.kill(before.pid, 'SIGKILL');
  const t0 = Date.now();
  const back = await until(async () => (await get(P.api, '/hello')).status === 200 && sites.status('fx', 'api').pid !== before.pid, 10000);
  assert.ok(back, 'serves again');
  assert.ok(Date.now() - t0 < 10000);
  const after = sites.status('fx', 'api');
  assert.equal(after.crashCount, c0 + 1);
  assert.equal(after.state, 'running');
  assert.ok(events.some(e => e.kind === 'site:crashed' && e.site === 'api'), 'site:crashed emitted');
  assert.equal(sites.crashes('fx', 'api').length, c0 + 1);
});

test('7. a foreign listener on the port: a plain-language error naming it, and it stays alive', async () => {
  const holder = cp.spawn(process.execPath, ['-e', `require('net').createServer().listen(${P.foreign}, '127.0.0.1', () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise(r => holder.stdout.once('data', r));
  try {
    await sites.hostSettings('fx', 'api', { port: P.foreign });
    const st = sites.status('fx', 'api');
    assert.equal(st.state, 'error');
    assert.match(st.lastError, new RegExp(`port ${P.foreign} is in use by another program: node \\(pid ${holder.pid}`));
    await assert.rejects(sites.start('fx', 'api'), /in use by another program/);
    assert.ok(alive(holder.pid), 'the foreign process is untouched');
  } finally {
    holder.kill('SIGKILL');
  }
  await sites.hostSettings('fx', 'api', { port: P.api });
  assert.equal((await sites.start('fx', 'api')).state, 'running');
});

test('9. the byte-proxy passes HTTP and WebSocket through and strips the sid/token cookies', async () => {
  const proxy = http.createServer((req, res) => sitesProxy.middleware({ authToken: 'test-auth-token-xyz' })(req, res, () => { res.statusCode = 418; res.end(); }));
  proxy.on('upgrade', (req, socket, head) => { if (!sitesProxy.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const pp = proxy.address().port;
  try {
    const r = await get(pp, '/s/fx/main/echo?q=1', { cookie: 'sid=OWNER; token=OWNERTOK; other=1', authorization: 'Bearer test-auth-token-xyz' });
    assert.equal(r.status, 200);
    const seen = JSON.parse(r.body);
    assert.equal(seen.cookie, 'other=1', 'owner cookies never reach the site');
    assert.equal(seen.prefix, '/s/fx/main');
    assert.equal(seen.url, '/echo?q=1');
    assert.deepEqual(r.headers['set-cookie'], ['keep=1'], 'a site cannot set sid/token');
    assert.equal((await get(pp, '/s/fx/nosuch/x')).status, 404);
    assert.equal((await get(pp, '/s/fx/main')).status, 301);
    // WebSocket-style upgrade
    const sock = net.connect(pp, '127.0.0.1');
    await new Promise(r => sock.once('connect', r));
    sock.write('GET /s/fx/main/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: echo\r\nCookie: sid=OWNER\r\n\r\n');
    let got = '';
    sock.on('data', d => { got += d.toString(); });
    await until(() => got.includes('\r\n\r\n'), 2000, 20);
    assert.match(got, /^HTTP\/1\.1 101/);
    assert.ok(!/sid=evil/.test(got), 'no sid Set-Cookie on the upgrade');
    assert.match(got, /Set-Cookie: ok=1/);
    sock.write('ping-123');
    assert.ok(await until(() => got.includes('ping-123'), 2000, 20), 'bytes pass both ways');
    sock.destroy();
  } finally {
    proxy.close();
  }
});

test('10. the per-host port survives a simulated deployCode; unchanged code keeps the runner', async () => {
  const peerData = require('../src/apps/peer-data');
  await sites.restart('fx', 'main'); // test 4's mount installed deps (package-lock.json): a fresh hash
  const port = sites.status('fx', 'main').port;
  assert.equal(port, P.main2);
  const pid = sites.status('fx', 'main').pid;
  const bundle = (handlerText) => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-bundle-'));
    const src = path.join(work, 'fx');
    fs.cpSync(path.join(appsDir, 'fx'), src, { recursive: true, filter: (s) => !/\/\.(data|sites\.json)/.test(s) });
    if (handlerText) fs.writeFileSync(path.join(src, 'site', 'index.js'), handlerText);
    const out = path.join(work, 'b.tar.gz');
    cp.execSync(`tar -czf ${JSON.stringify(out)} -C ${JSON.stringify(work)} fx`);
    return out;
  };
  const h0 = sites._codeHash('fx', 'main');
  assert.equal(sites._runtimes.get('fx/main').codeHash, h0, 'hash at spawn = hash now');
  await peerData.deployCode('fx', bundle(null), 'a'.repeat(40), null);
  assert.equal(sites._codeHash('fx', 'main'), h0, 'same code, same hash');
  assert.equal(JSON.parse(fs.readFileSync(path.join(appsDir, 'fx', '.sites.json'), 'utf8')).main.port, P.main2, '.sites.json preserved');
  const same = await sites.afterCodeSwap('fx');
  assert.ok(same.kept.includes('main'), JSON.stringify(same));
  assert.equal(sites.status('fx', 'main').pid, pid, 'same code: no restart');
  assert.equal((await get(P.main2, '/index.html')).status, 200, 'snapshots resolve in the new dir');
  await peerData.deployCode('fx', bundle(HANDLER.replace('VERSION', 'V2')), 'b'.repeat(40), null);
  const changed = await sites.afterCodeSwap('fx');
  assert.ok(changed.restarted.includes('main'));
  assert.equal(sites.status('fx', 'main').port, P.main2);
  assert.match((await get(P.main2, '/hello')).body, /V2$/);
  assert.equal(sites.health('fx').ok, true);
});

test('2. SIGKILL of the parent: the runner is gone within 2 s; a new parent autostarts it', async () => {
  const harness = path.join(appsDir, '.core', 'harness.js');
  fs.writeFileSync(harness, `
    const appManager = require(${JSON.stringify(require.resolve('../src/apps/app-manager'))});
    const sites = require(${JSON.stringify(require.resolve('../src/apps/sites'))});
    appManager.setAppsDir(${JSON.stringify(appsDir)});
    sites.init({ broadcast() {} });
    sites.autostartAll().then(() => console.log(JSON.stringify(sites.status('hx', 'main'))));
    setInterval(() => {}, 1000);
  `);
  const boot = async () => {
    const parent = cp.spawn(process.execPath, [harness], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    parent.stdout.on('data', d => { out += d; });
    const line = await until(() => out.includes('\n') && out, 15000, 50);
    return { parent, st: JSON.parse(line.split('\n')[0]) };
  };
  const a = await boot();
  assert.equal(a.st.state, 'running');
  assert.equal((await get(P.hx, '/hello')).status, 200);
  a.parent.kill('SIGKILL');
  const t0 = Date.now();
  const gone = await until(() => !alive(a.st.pid), 2000, 25);
  assert.ok(gone, `runner ${a.st.pid} gone within 2 s (${Date.now() - t0} ms)`);
  const b = await boot();
  try {
    assert.equal(b.st.state, 'running');
    assert.notEqual(b.st.pid, a.st.pid);
    assert.equal((await get(P.hx, '/hello')).status, 200);
  } finally {
    b.parent.kill('SIGKILL');
    await until(() => !alive(b.st.pid), 2000, 25);
  }
});
