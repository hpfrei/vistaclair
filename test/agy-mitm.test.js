// agy-mitm: the loopback MITM for agy workers (docs/agy-inspector.md).
// A fake upstream TLS server poses as the Cloud Code host (its own test CA,
// trusted by the MITM through the upstreamTls seam). It hashes the plaintext it
// receives and sends, and hands it to a plain backend (raw HTTP/1.1 scripts, or
// a Node h2c server). Clients trust only bundle.pem.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const http2 = require('http2');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mitm-'));
process.env.VISTACLAIR_HOME = DATA_HOME;
delete process.env.VISTACLAIR_AGY_INTERCEPT;

const InteractionStore = require('../src/store');
const { toEntry } = require('../src/session-totals');
const { AgyMitm, isPublicAddress, H2_NOTICE } = require('../src/agy-mitm');
const { AgyMitmCA } = require('../src/agy-mitm-ca');

const HOST = 'daily-cloudcode-pa.googleapis.com';
const OPAQUE = 'opaque.example.net';
const FIX = path.join(__dirname, 'fixtures', 'agy');
const fixture = (n) => fs.readFileSync(path.join(FIX, n));
const SENTINEL = 'ya29.SENTINEL-' + crypto.randomBytes(12).toString('hex');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const broadcasts = [];
const broadcaster = { broadcast(m) { broadcasts.push(JSON.parse(JSON.stringify(m))); } };
const store = new InteractionStore(500);
const TAG = 'agy-worker-1';
store.registerSession(TAG, 'sess-agy-1');

let upstreamCA, mitm, upstream, backendMode = 'h1', h1Script = [], h2cServer;
const upstreamConns = [];

// --- the plain backends ------------------------------------------------------

// Answers each HTTP/1.1 request (head + Content-Length body) with the next
// scripted raw response.
const h1Backend = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  let chain = Promise.resolve();
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const at = buf.indexOf('\r\n\r\n');
      if (at === -1) return;
      const head = buf.subarray(0, at).toString('latin1');
      const len = Number((/content-length:\s*(\d+)/i.exec(head) || [0, 0])[1]);
      if (buf.length < at + 4 + len) return;
      buf = buf.subarray(at + 4 + len);
      const next = h1Script.shift();
      if (!next) { sock.destroy(); return; }
      // One response after the other, each in small timed writes.
      chain = chain.then(async () => { for (const part of next) { sock.write(part); await new Promise(r => setTimeout(r, 5)); } });
    }
  });
  sock.on('error', () => {});
});

function startUpstream() {
  return new Promise(async (resolve) => {
    const leaves = {};
    for (const h of [HOST, OPAQUE]) leaves[h] = await upstreamCA.leaf(h);
    const server = tls.createServer({
      SNICallback: (name, cb) => cb(null, tls.createSecureContext({ key: leaves[name]?.key || leaves[HOST].key, cert: leaves[name]?.cert || leaves[HOST].cert })),
      ALPNCallback: ({ protocols }) => {
        upstreamConns.offered = protocols;
        if (backendMode === 'h2' && protocols.includes('h2')) return 'h2';
        return protocols.includes('http/1.1') ? 'http/1.1' : protocols[0];
      },
    }, (ts) => {
      const rec = { servername: ts.servername, alpn: ts.alpnProtocol, offered: upstreamConns.offered, inHash: crypto.createHash('sha256'), outHash: crypto.createHash('sha256'), inBytes: 0, outBytes: 0 };
      upstreamConns.push(rec);
      const port = backendMode === 'h2' ? h2cServer.address().port : h1Backend.address().port;
      const b = net.connect(port, '127.0.0.1');
      ts.on('data', d => { rec.inHash.update(d); rec.inBytes += d.length; b.write(d); });
      b.on('data', d => { rec.outHash.update(d); rec.outBytes += d.length; ts.write(d); });
      const done = () => { if (!rec.closed) { rec.closed = true; rec.in = rec.inHash.digest('hex'); rec.out = rec.outHash.digest('hex'); } ts.destroy(); b.destroy(); };
      ts.on('end', () => b.end()); b.on('end', () => ts.end());
      ts.on('close', done); b.on('close', done); ts.on('error', done); b.on('error', done);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// --- client helpers ------------------------------------------------------------

function connectTunnel(target, { auth = `${TAG}:${mitm.tags.get(TAG)?.secret}`, port } = {}) {
  return new Promise((resolve, reject) => {
    const headers = auth === null ? {} : { 'proxy-authorization': 'Basic ' + Buffer.from(auth).toString('base64') };
    const req = http.request({ host: '127.0.0.1', port: port || mitm.port(), method: 'CONNECT', path: target, headers });
    req.on('connect', (res, socket) => resolve({ status: res.statusCode, socket, headers: res.headers }));
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', reject);
    req.end();
  });
}

async function tlsThrough(target, servername, { alpn = ['http/1.1'] } = {}) {
  const { status, socket } = await connectTunnel(target);
  assert.strictEqual(status, 200);
  const t = tls.connect({ socket, servername, ca: fs.readFileSync(mitm.bundlePath()), ALPNProtocols: alpn });
  await new Promise((res, rej) => { t.once('secureConnect', res); t.once('error', rej); });
  return t;
}

// Writes raw requests on one TLS connection, waits for `expectBytes` or close.
async function rawExchange(t, chunks, { until }) {
  const sent = crypto.createHash('sha256');
  const got = [];
  t.on('data', d => got.push(d));
  for (const c of chunks) { sent.update(c); t.write(c); await new Promise(r => setTimeout(r, 3)); }
  await new Promise((resolve) => {
    const check = () => { if (until(Buffer.concat(got))) { t.off('data', check); resolve(); } };
    t.on('data', check);
    check();
  });
  return { sentHash: sent.digest('hex'), received: Buffer.concat(got) };
}

function waitFor(pred, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const v = pred(); if (v) return resolve(v); if (Date.now() - t0 > ms) return reject(new Error('timeout')); setTimeout(tick, 10); };
    tick();
  });
}

function closedProof(n) {
  return waitFor(() => (mitm._closed.length >= n ? mitm._closed : null));
}

function chunked(parts) {
  return Buffer.concat([...parts.map(p => Buffer.concat([Buffer.from(p.length.toString(16) + '\r\n'), p, Buffer.from('\r\n')])), Buffer.from('0\r\n\r\n')]);
}

function postHead(p, body, extra = '') {
  return Buffer.from(`POST ${p} HTTP/1.1\r\nHost: ${HOST}\r\nUser-Agent: antigravity/cli/1.5.15 (aidev_client; os_type=linux)\r\nAuthorization: Bearer ${SENTINEL}\r\nCookie: SID=${SENTINEL}\r\nX-Goog-Api-Key: ${SENTINEL}\r\nContent-Type: application/json\r\nAccept-Encoding: gzip\r\n${extra}Content-Length: ${body.length}\r\n\r\n`);
}

// -----------------------------------------------------------------------------

test.before(async () => {
  upstreamCA = new AgyMitmCA({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'agy-up-ca-')), hosts: [HOST, OPAQUE] });
  await upstreamCA.ensure();
  await new Promise(r => h1Backend.listen(0, '127.0.0.1', r));
  h2cServer = http2.createServer();
  h2cServer.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', d => chunks.push(d));
    stream.on('end', () => {
      stream.respond({ ':status': 200, 'content-type': 'application/json', 'set-cookie': `x=${SENTINEL}` });
      stream.end(JSON.stringify({ echo: headers[':path'], n: Buffer.concat(chunks).length }));
    });
  });
  h2cServer.on('error', () => {});
  await new Promise(r => h2cServer.listen(0, '127.0.0.1', r));
  upstream = await startUpstream();
  mitm = new AgyMitm({
    dir: path.join(DATA_HOME, 'agy-mitm'),
    store, broadcaster,
    connectUpstream: () => net.connect(upstream.address().port, '127.0.0.1'),
    upstreamTls: { ca: upstreamCA.caPem },
  });
  mitm._closed = [];
  mitm.on('connection-closed', e => mitm._closed.push(e));
  mitm._hooks = [];
  mitm.on('cloudcode-response', e => mitm._hooks.push(e));
  await mitm.ensureStarted();
  mitm.registerTag(TAG);
});

test.after(async () => {
  await mitm.stop();
  upstream.close(); h1Backend.close(); h2cServer.close();
});

test('1. 407 without the secret; 403 for a port other than 443 and for loopback; 405 for plain requests', async () => {
  assert.strictEqual((await connectTunnel(`${HOST}:443`, { auth: null })).status, 407);
  assert.strictEqual((await connectTunnel(`${HOST}:443`, { auth: `${TAG}:${'0'.repeat(64)}` })).status, 407);
  assert.strictEqual((await connectTunnel(`${HOST}:443`, { auth: `nobody:${mitm.tags.get(TAG).secret}` })).status, 407);
  assert.strictEqual((await connectTunnel(`${HOST}:8443`)).status, 403);
  assert.strictEqual((await connectTunnel('127.0.0.1:443')).status, 403);
  assert.strictEqual((await connectTunnel('[::1]:443')).status, 403);
  assert.strictEqual((await connectTunnel('localhost:443')).status, 403);
  // A name that resolves to a private address: the real lookup path.
  const m2 = new AgyMitm({ dir: path.join(DATA_HOME, 'agy-mitm'), lookup: (h, o, cb) => cb(null, [{ address: '10.1.2.3', family: 4 }]) });
  await m2.ensureStarted();
  m2.registerTag('t2');
  assert.strictEqual((await connectTunnel('intra.example.com:443', { auth: `t2:${m2.tags.get('t2').secret}`, port: m2.port() })).status, 403);
  await m2.stop();
  const plain = await new Promise(r => http.get({ host: '127.0.0.1', port: mitm.port(), path: 'http://example.com/' }, res => { res.resume(); r(res.statusCode); }));
  assert.strictEqual(plain, 405);
  assert.ok(!isPublicAddress('192.168.1.1') && !isPublicAddress('169.254.1.1') && !isPublicAddress('fd00::1') && isPublicAddress('142.250.1.1'));
});

let decoded;  // the streamGenerateContent interaction of test 2

test('2+3. byte identity both ways (keep-alive: chunked SSE, gzip JSON, gzip SSE) and one decoded interaction per model call', async () => {
  backendMode = 'h1';
  const before = upstreamConns.length;
  const reqBody = fixture('stream-request.json');
  const sse = fixture('stream-response.sse');
  const sseParts = [sse.subarray(0, 100), sse.subarray(100, 517), sse.subarray(517)];
  const lca = zlib.gzipSync(fixture('load-code-assist.json'));
  const toolSse = zlib.gzipSync(fixture('stream-response-tool.sse'));
  const r1 = [Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nSet-Cookie: s=${SENTINEL}\r\nTransfer-Encoding: chunked\r\n\r\n`), ...chunked(sseParts).toString('latin1').match(/[\s\S]{1,90}/g).map(s => Buffer.from(s, 'latin1'))];
  const r2 = [Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: ${lca.length}\r\n\r\n`), lca];
  const r3 = [Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n'), chunked([toolSse.subarray(0, 50), toolSse.subarray(50)])];
  h1Script = [r1, r2, r3];
  const expected = Buffer.concat([...r1, ...r2, ...r3]);

  const env2 = Buffer.from(JSON.stringify({ ...JSON.parse(reqBody), requestId: 'agent/daf70115-49b0-476a-ac2d-31b44d303f63/2/x/3' }));
  const gzReq = zlib.gzipSync(env2);
  const t = await tlsThrough(`${HOST}:443`, HOST);
  assert.strictEqual(t.alpnProtocol, 'http/1.1');
  const { sentHash, received } = await rawExchange(t, [
    postHead('/v1internal:streamGenerateContent?alt=sse', reqBody), reqBody.subarray(0, 700), reqBody.subarray(700),
    postHead('/v1internal:loadCodeAssist', Buffer.from('{}')), Buffer.from('{}'),
    postHead('/v1internal:streamGenerateContent?alt=sse', gzReq, 'Content-Encoding: gzip\r\n'), gzReq,
  ], { until: (b) => b.length >= expected.length });
  t.end();
  const closed = await closedProof(1);
  const proof = closed[closed.length - 1];
  const up = await waitFor(() => (upstreamConns[before]?.closed ? upstreamConns[before] : null));

  // Client plaintext == what the upstream received; upstream sent == what the client received.
  assert.strictEqual(up.in, sentHash);
  assert.strictEqual(sha(received), sha(expected));
  assert.strictEqual(up.out, sha(expected));
  // The MITM's own per-connection proof agrees with both ends.
  assert.strictEqual(proof.match, true);
  assert.strictEqual(proof.digests.c2u.in, sentHash);
  assert.strictEqual(proof.digests.c2u.out, sentHash);
  assert.strictEqual(proof.digests.u2c.in, sha(expected));
  assert.strictEqual(proof.digests.u2c.out, sha(expected));
  // Mirroring: the upstream was offered exactly the client's ALPN list and SNI.
  assert.deepStrictEqual(up.offered, ['http/1.1']);
  assert.strictEqual(up.servername, HOST);
  assert.strictEqual(upstreamConns.length, before + 1, 'one upstream connection per client connection');

  const model = await waitFor(() => {
    const l = store.getAll().filter(i => i.instanceId === TAG && i.provider === 'agy' && i.status !== 'pending');
    return l.length >= 2 ? l : null;
  });
  assert.strictEqual(model.length, 2, 'one interaction per model call; loadCodeAssist is not one');
  decoded = model[0];
  const it = decoded;
  assert.strictEqual(it.status, 'complete');
  assert.strictEqual(it.translatedFrom, 'agy');
  assert.strictEqual(it.request.model, 'gemini-3.8-flash-low');
  assert.deepStrictEqual(it.request.system.map(s => s.text), ['You are Antigravity, a coding agent.', 'Workspace: /work']);
  const blocks = it.request.messages.flatMap(m => m.content.map(c => c.type));
  for (const k of ['text', 'thinking', 'tool_use', 'tool_result']) assert.ok(blocks.includes(k), k);
  assert.deepStrictEqual(it.response.body.content, [
    { type: 'thinking', thinking: 'The file says hello.' },
    { type: 'text', text: 'It says: hello from note' },
  ]);
  assert.deepStrictEqual(it.usage, { input_tokens: 2149, output_tokens: 19, cache_read_input_tokens: 7281 });
  assert.strictEqual(it.response.meta.traceId, '58e4ba589c56e021');
  assert.strictEqual(it.pricing.credential, 'agy-subscription');
  assert.strictEqual(it.pricing.provider, 'agy');
  assert.strictEqual(toEntry(1, { usage: it.usage, pricing: it.pricing })[8], 0, 'cost is $0, not "no price"');
  assert.deepStrictEqual(Object.keys(it.requestHeaders).sort(), ['content-type', 'user-agent']);
  assert.ok(!it.subagent, 'the first conversation is the main lane');
  // The gzip SSE call decoded too.
  assert.deepStrictEqual(model[1].response.body.content.map(b => b.type), ['thinking', 'tool_use']);
  // loadCodeAssist reached the hook (gzip decoded), not the Inspector.
  const h = mitm._hooks.find(e => e.path === '/v1internal:loadCodeAssist');
  assert.strictEqual(h.json.paidTier.name, 'Google AI Pro');
  assert.strictEqual(h.instanceId, TAG);
  // Persisted under the registered session.
  const files = fs.readdirSync(path.join(DATA_HOME, 'interactions', 'sess-agy-1')).filter(f => f.endsWith('.json'));
  assert.ok(files.length >= 2);
});

test('4. the sentinel bearer appears nowhere under DATA_HOME, in broadcasts or in stored interactions', async () => {
  assert.ok(decoded, 'test 2 ran');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(DATA_HOME)) {
    assert.ok(!fs.readFileSync(f).includes(SENTINEL), `sentinel in ${path.relative(DATA_HOME, f)}`);
  }
  assert.ok(broadcasts.length > 0);
  assert.ok(!JSON.stringify(broadcasts).includes(SENTINEL), 'sentinel in a broadcast');
  assert.ok(!JSON.stringify(store.getAll()).includes(SENTINEL), 'sentinel in the store');
  assert.ok(!JSON.stringify(mitm.stats(TAG)).includes(SENTINEL));
});

test('5. a non-decoded host is tunnelled raw: the client sees the upstream\'s own certificate', async () => {
  const n = store.getAll().length;
  const { status, socket } = await connectTunnel(`${OPAQUE}:443`);
  assert.strictEqual(status, 200);
  const t = tls.connect({ socket, servername: OPAQUE, ca: upstreamCA.caPem });
  await new Promise((res, rej) => { t.once('secureConnect', res); t.once('error', rej); });
  assert.match(t.getPeerCertificate().issuer.CN, /agy-mitm CA/);
  assert.strictEqual(t.getPeerCertificate().fingerprint256, new crypto.X509Certificate((await upstreamCA.leaf(OPAQUE)).cert).fingerprint256);
  t.destroy();
  assert.strictEqual(store.getAll().length, n, 'nothing recorded');
  assert.ok(mitm.stats(TAG).hosts[OPAQUE].connections >= 1);
});

test('kill switch: interception off → the Cloud Code host is a plain tunnel too; on again → intercepted', async () => {
  assert.strictEqual(mitm.interceptionEnabled(), true, 'default on');
  assert.strictEqual(mitm.setInterception(false), false);
  try {
    const n = store.getAll().length;
    const { status, socket } = await connectTunnel(`${HOST}:443`);
    assert.strictEqual(status, 200);
    const t = tls.connect({ socket, servername: HOST, ca: upstreamCA.caPem });
    await new Promise((res, rej) => { t.once('secureConnect', res); t.once('error', rej); });
    const upstreamLeaf = new crypto.X509Certificate((await upstreamCA.leaf(HOST)).cert);
    assert.strictEqual(t.getPeerCertificate().fingerprint256, upstreamLeaf.fingerprint256, 'the upstream\'s own leaf: no interception');
    t.destroy();
    assert.strictEqual(store.getAll().length, n);
    // The env override wins over the file.
    mitm.setInterception(true);
    process.env.VISTACLAIR_AGY_INTERCEPT = '0';
    assert.strictEqual(mitm.interceptionEnabled(), false);
  } finally {
    delete process.env.VISTACLAIR_AGY_INTERCEPT;
    mitm.setInterception(true);
  }
  const t2 = await tlsThrough(`${HOST}:443`, HOST);
  assert.match(t2.getPeerCertificate().issuer.CN, /agy-mitm CA/);
  assert.notStrictEqual(t2.getPeerCertificate().fingerprint256, new crypto.X509Certificate((await upstreamCA.leaf(HOST)).cert).fingerprint256);
  t2.destroy();
});

test('6. openssl verify rejects a leaf for example.com signed by the CA (name constraints)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-leaf-'));
  const first = (pem) => pem.slice(0, pem.indexOf('-----END CERTIFICATE-----') + 26);
  fs.writeFileSync(path.join(dir, 'bad.pem'), first((await mitm.ca.leaf('example.com')).cert));
  fs.writeFileSync(path.join(dir, 'good.pem'), first((await mitm.ca.leaf(HOST)).cert));
  const verify = (f) => { try { return execFileSync('openssl', ['verify', '-CAfile', mitm.ca.certPath, f], { stdio: 'pipe' }).toString(); } catch (e) { return 'FAIL ' + e.stdout + e.stderr; } };
  assert.match(verify(path.join(dir, 'good.pem')), /: OK/);
  assert.match(verify(path.join(dir, 'bad.pem')), /FAIL[\s\S]*permitted subtree violation/);
  // Node's verifier (OpenSSL) agrees.
  const t = await new Promise((resolve) => {
    const leafP = mitm.ca.leaf('example.com');
    leafP.then(leaf => {
      const s = tls.createServer({ key: leaf.key, cert: leaf.cert }, c => c.end()).listen(0, '127.0.0.1', () => {
        const c = tls.connect({ port: s.address().port, host: '127.0.0.1', servername: 'example.com', ca: mitm.ca.caPem });
        c.on('error', e => { s.close(); resolve(e.code); });
        c.on('secureConnect', () => { c.destroy(); s.close(); resolve('connected'); });
      });
    });
  });
  // Node reports OpenSSL's "permitted subtree violation" (error 47) as UNSPECIFIED.
  assert.strictEqual(t, 'UNSPECIFIED');
});

test('7. the key is mode 0600 in a 0700 dir; the bundle has the system CAs plus this CA', () => {
  assert.strictEqual(fs.statSync(mitm.ca.keyPath).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(mitm.ca.dir).mode & 0o777, 0o700);
  const bundle = fs.readFileSync(mitm.bundlePath(), 'utf8');
  assert.ok(bundle.endsWith(mitm.ca.caPem));
  assert.ok((bundle.match(/BEGIN CERTIFICATE/g) || []).length > 10);
  assert.ok(!fs.readdirSync(mitm.ca.dir).some(f => f.startsWith('.leaf-')), 'no leaf key left on disk');
});

test('8. a 429 is stored as an error interaction with its JSON body, and reaches the hook', async () => {
  backendMode = 'h1';
  const err = fixture('error-429.json');
  h1Script = [[Buffer.from(`HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Length: ${err.length}\r\n\r\n`), err]];
  const reqBody = Buffer.from(JSON.stringify({ ...JSON.parse(fixture('stream-request.json')), requestId: 'agent/daf70115-49b0-476a-ac2d-31b44d303f63/9/y/4' }));
  const t = await tlsThrough(`${HOST}:443`, HOST);
  const n0 = store.getAll().length;
  await rawExchange(t, [postHead('/v1internal:streamGenerateContent?alt=sse', reqBody), reqBody], { until: b => b.includes('exhausted your capacity') && b.toString().trim().endsWith('}') });
  t.destroy();
  const it = await waitFor(() => store.getAll().slice(n0).find(i => i.provider === 'agy' && i.status === 'error'));
  assert.strictEqual(it.response.status, 429);
  assert.strictEqual(it.response.body.error.status, 'RESOURCE_EXHAUSTED');
  assert.match(it.response.error, /exhausted your capacity/);
  assert.ok(broadcasts.some(b => b.type === 'interaction:error' && b.interactionId === it.id));
  const h = await waitFor(() => mitm._hooks.find(e => e.status === 429));
  assert.strictEqual(h.json.error.details[0].reason, 'QUOTA_EXHAUSTED');
});

test('h2: mirrored ALPN, several streams on one connection relayed byte-identical, not decoded, one notice', async () => {
  backendMode = 'h2';
  const before = upstreamConns.length;
  const closedBefore = mitm._closed.length;
  const n0 = store.getAll().length;
  const t = await tlsThrough(`${HOST}:443`, HOST, { alpn: ['h2', 'http/1.1'] });
  assert.strictEqual(t.alpnProtocol, 'h2');
  const session = http2.connect(`https://${HOST}`, { createConnection: () => t });
  const one = (i) => new Promise((resolve, reject) => {
    const s = session.request({ ':method': 'POST', ':path': `/v1internal:streamGenerateContent?n=${i}`, authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' });
    const out = [];
    s.on('data', d => out.push(d));
    s.on('end', () => resolve(JSON.parse(Buffer.concat(out).toString())));
    s.on('error', reject);
    s.end(Buffer.alloc(1000 + i, 'x'));
  });
  const res = await Promise.all([1, 2, 3, 4, 5].map(one));
  assert.deepStrictEqual(res.map(r => r.n), [1001, 1002, 1003, 1004, 1005]);
  await new Promise(r => session.close(r));
  const proof = (await waitFor(() => (mitm._closed.length > closedBefore ? mitm._closed : null))).at(-1);
  const up = await waitFor(() => (upstreamConns[before]?.closed ? upstreamConns[before] : null));
  assert.strictEqual(upstreamConns.length, before + 1);
  assert.deepStrictEqual(up.offered, ['h2', 'http/1.1']);
  assert.strictEqual(up.alpn, 'h2');
  assert.strictEqual(proof.alpn, 'h2');
  assert.strictEqual(proof.match, true);
  assert.strictEqual(proof.digests.c2u.out, up.in, 'what the MITM wrote upstream is what the upstream got');
  assert.strictEqual(proof.digests.u2c.in, up.out, 'what the upstream sent is what the MITM read');
  const added = store.getAll().slice(n0);
  assert.strictEqual(added.filter(i => i.provider === 'agy').length, 0, 'h2 is not decoded');
  assert.strictEqual(added.filter(i => i.request?.params?.notice === H2_NOTICE).length, 1, 'one notice per connection');
  assert.ok(broadcasts.some(b => b.type === 'agy-mitm:notice' && b.message === H2_NOTICE));
  backendMode = 'h1';
});

test('an upstream failure reaches the client as a closed connection, never as an HTTP response', async () => {
  const m3 = new AgyMitm({
    dir: path.join(DATA_HOME, 'agy-mitm'), store, broadcaster,
    connectUpstream: () => net.connect(1, '127.0.0.1'),   // refused
    upstreamTls: { ca: upstreamCA.caPem },
  });
  await m3.ensureStarted();
  m3.registerTag('t3');
  const { status, socket } = await connectTunnel(`${HOST}:443`, { auth: `t3:${m3.tags.get('t3').secret}`, port: m3.port() });
  assert.strictEqual(status, 200);
  const got = [];
  socket.on('data', d => got.push(d));
  socket.on('error', () => {});
  const t = tls.connect({ socket, servername: HOST, ca: fs.readFileSync(m3.bundlePath()) });
  const r = await new Promise(resolve => { t.on('error', e => resolve(e.code || 'error')); t.on('secureConnect', () => resolve('connected')); });
  assert.notStrictEqual(r, 'connected');
  assert.ok(!Buffer.concat(got).includes('HTTP/1.1'), 'no synthesized HTTP response');
  assert.ok(m3.totals.upstreamFailures >= 1);
  await m3.stop();
});

test('revokeTag closes the tag\'s connections and later CONNECTs get 407', async () => {
  const id = 'agy-worker-revoke';
  const { proxyUrl } = mitm.registerTag(id);
  assert.match(proxyUrl, new RegExp(`^http://${id}:[0-9a-f]{64}@127\\.0\\.0\\.1:${mitm.port()}$`));
  assert.strictEqual(mitm.registerTag(id).proxyUrl, proxyUrl, 'stable per worker');
  const secret = mitm.tags.get(id).secret;
  const { socket } = await connectTunnel(`${OPAQUE}:443`, { auth: `${id}:${secret}` });
  const closed = new Promise(r => socket.on('close', r));
  assert.strictEqual(mitm.revokeTag(id), true);
  await closed;
  assert.strictEqual((await connectTunnel(`${OPAQUE}:443`, { auth: `${id}:${secret}` })).status, 407);
});
