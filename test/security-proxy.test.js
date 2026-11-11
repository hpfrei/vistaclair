// Hardening of the local API proxy (src/proxy.js):
//   1. a request whose Host is not a loopback name (DNS rebinding), or that
//      carries a browser Origin, is refused;
//   2. the stored non-Anthropic provider keys are attached only for callers
//      that present the per-boot proxy secret (which Vistaclair hands to the
//      sessions it starts, through buildClaudeEnv); the Anthropic key is never
//      the proxy's to attach;
//   3. a Gemini key is masked in the inspector payload (header and query form);
//   4. the instance id a caller names is honoured only with the secret.
//
// Everything runs against fake upstreams with fake keys, on ephemeral ports.
//
//   node --test test/security-proxy.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-sec-proxy-')));
process.env.VISTACLAIR_HOME = HOME;

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const caps = require('../src/capabilities');
const utils = require('../src/utils');
const createProxyRouter = require('../src/proxy');

const OAI_KEY = 'sk-fake-openai-0123456789abcdef';
const GEM_KEY = 'AIzaFakeGeminiKey0123456789abcdef';
const ANT_KEY = 'sk-ant-fake-caller-key-0123456789';
const SECRET_HEADER = 'x-vistaclair-proxy-secret';

let seen;            // requests the fake upstream received: { url, headers, body }
let upstream, proxyServer, proxyPort, upstreamPort;
let broadcasts;      // every message the proxy broadcast to the dashboard
let stored;          // interactions the proxy handed to the store

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test.before(async () => {
  upstream = await startServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: { ...req.headers }, body: Buffer.concat(chunks).toString() });
      if (req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'x', usage: { input_tokens: 1, output_tokens: 1 } }));
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: [DONE]\n\n');
      }
    });
  });
  upstreamPort = upstream.address().port;
  const base = `http://127.0.0.1:${upstreamPort}`;

  assert.ok(caps.saveModel(HOME, { name: 'fake-oai', providerKey: 'custom', provider: 'openai', modelId: 'fake-oai-1', apiBaseUrl: `${base}/oai/v1`, apiKey: OAI_KEY, systemPromptMode: 'passthrough' }));
  assert.ok(caps.saveModel(HOME, { name: 'fake-gem', providerKey: 'custom', provider: 'gemini', modelId: 'fake-gem-1', apiBaseUrl: `${base}/gem/v1beta`, apiKey: GEM_KEY, systemPromptMode: 'passthrough' }));
  assert.strictEqual(caps.loadModel(HOME, 'fake-oai').apiKey, OAI_KEY, 'the fake key is stored');

  broadcasts = [];
  stored = [];
  const store = new Proxy({}, {
    get(t, k) {
      if (k === 'add') return (i) => { stored.push(i); };
      return () => {};
    },
  });
  const broadcaster = { broadcast: (m) => { broadcasts.push(JSON.stringify(m)); } };
  const app = express();
  app.use(createProxyRouter(store, broadcaster, base));
  proxyServer = await startServer(app);
  proxyPort = proxyServer.address().port;
});

test.beforeEach(() => { seen = []; broadcasts.length = 0; stored.length = 0; });

test.after(() => {
  proxyServer.close();
  upstream.close();
  fs.rmSync(HOME, { recursive: true, force: true });
});

// Raw request, so Host and Origin can be set freely (fetch forbids Host).
function call({ path: p = '/v1/messages', body, headers = {}, host, method = 'POST' }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const h = { ...headers };
    if (payload) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload); }
    h.host = host === undefined ? `127.0.0.1:${proxyPort}` : host;
    const req = http.request({ host: '127.0.0.1', port: proxyPort, path: p, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const msg = (model) => ({ model, max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] });
const secret = () => utils.getProxySecret();
const withSecret = (extra = {}) => ({ [SECRET_HEADER]: secret(), ...extra });

// ---------------------------------------------------------------- item 1

test('item 1: a foreign Host header is refused and nothing reaches an upstream', async () => {
  for (const host of ['evil.example', `evil.example:${proxyPort}`, `127.0.0.1.evil.example:${proxyPort}`, `localhost.evil.example:${proxyPort}`, `attacker.test:80`]) {
    const r = await call({ body: msg('claude-sonnet-4-5'), headers: { 'x-api-key': ANT_KEY }, host });
    assert.ok(r.status >= 400 && r.status < 500, `Host ${host}: refused (got ${r.status})`);
  }
  assert.strictEqual(seen.length, 0, 'no refused request was forwarded');
});

test('item 1: a loopback Host with the proxy port is accepted', async () => {
  for (const host of [`127.0.0.1:${proxyPort}`, `localhost:${proxyPort}`, `[::1]:${proxyPort}`]) {
    seen.length = 0;
    const r = await call({ body: msg('claude-sonnet-4-5'), headers: { 'x-api-key': ANT_KEY }, host });
    assert.strictEqual(r.status, 200, `Host ${host}`);
    assert.strictEqual(seen.length, 1);
  }
});

test('item 1: a loopback name on another port is refused', async () => {
  const r = await call({ body: msg('claude-sonnet-4-5'), host: `localhost:${proxyPort + 1}` });
  assert.ok(r.status >= 400 && r.status < 500, `got ${r.status}`);
  assert.strictEqual(seen.length, 0);
});

test('item 1: a request carrying a browser Origin is refused, also on the catch-all and GET', async () => {
  const r = await call({ body: msg('claude-sonnet-4-5'), headers: { origin: 'https://evil.example' } });
  assert.ok(r.status >= 400 && r.status < 500, `messages: got ${r.status}`);
  const r2 = await call({ path: '/v1/models', method: 'GET', headers: { origin: 'null' } });
  assert.ok(r2.status >= 400 && r2.status < 500, `catch-all: got ${r2.status}`);
  assert.strictEqual(seen.length, 0);
});

// ---------------------------------------------------------------- item 2

test('item 2: OpenAI-style request without the secret reaches the upstream with no stored key', async () => {
  const r = await call({ body: msg('fake-oai') });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(seen.length, 1);
  assert.ok(seen[0].url.startsWith('/oai/v1/chat/completions'));
  assert.ok(!JSON.stringify(seen[0].headers).includes(OAI_KEY), 'the stored key is not attached');
  assert.ok(!seen[0].headers.authorization, 'no authorization header at all');
});

test('item 2: Gemini-style request without the secret reaches the upstream with no stored key', async () => {
  const r = await call({ body: msg('fake-gem') });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(seen.length, 1);
  assert.ok(seen[0].url.startsWith('/gem/v1beta/models/fake-gem-1:streamGenerateContent'));
  assert.ok(!JSON.stringify(seen[0]).includes(GEM_KEY), 'the stored key is nowhere in the request');
  assert.ok(!seen[0].headers['x-goog-api-key']);
});

test('item 2: a wrong secret is treated as no secret', async () => {
  await call({ body: msg('fake-oai'), headers: { [SECRET_HEADER]: 'x'.repeat(secret().length) } });
  await call({ body: msg('fake-gem'), headers: { [SECRET_HEADER]: 'short' } });
  assert.strictEqual(seen.length, 2);
  assert.ok(!JSON.stringify(seen).includes(OAI_KEY) && !JSON.stringify(seen).includes(GEM_KEY));
});

test('item 2: with the secret the stored key is attached (OpenAI and Gemini)', async () => {
  const r1 = await call({ body: msg('fake-oai'), headers: withSecret() });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(seen[0].headers.authorization, `Bearer ${OAI_KEY}`);
  const r2 = await call({ body: msg('fake-gem'), headers: withSecret() });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(seen[1].headers['x-goog-api-key'], GEM_KEY);
});

test('item 2: the secret itself is never forwarded upstream', async () => {
  await call({ body: msg('fake-oai'), headers: withSecret() });
  await call({ body: msg('claude-sonnet-4-5'), headers: withSecret({ 'x-api-key': ANT_KEY }) });
  assert.strictEqual(seen.length, 2);
  for (const s of seen) assert.ok(!JSON.stringify(s).includes(secret()), 'secret not forwarded');
});

test('item 2: Anthropic passthrough is the same with and without the secret', async () => {
  const a = await call({ body: msg('claude-sonnet-4-5'), headers: { 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01' } });
  const b = await call({ body: msg('claude-sonnet-4-5'), headers: withSecret({ 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01' }) });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(b.status, 200);
  assert.strictEqual(seen.length, 2);
  for (const s of seen) {
    assert.strictEqual(s.url, '/v1/messages');
    assert.strictEqual(s.headers['x-api-key'], ANT_KEY, 'the caller\'s own key goes through untouched');
    assert.strictEqual(s.headers['anthropic-version'], '2023-06-01');
  }
  // A caller with no credential gets none added.
  seen.length = 0;
  await call({ body: msg('claude-sonnet-4-5') });
  assert.ok(!seen[0].headers['x-api-key'] && !seen[0].headers.authorization);
});

test('item 2: the secret is long enough and stable for the process', () => {
  assert.ok(typeof secret() === 'string' && secret().length >= 32);
  assert.strictEqual(secret(), utils.getProxySecret());
});

test('item 2: the environment built for a session carries what it needs to present the secret', async () => {
  const env = utils.buildClaudeEnv({ proxyPort, instanceId: 'cli-abc', extraEnv: {}, autoMemory: false });
  const lines = String(env.ANTHROPIC_CUSTOM_HEADERS || '').split('\n');
  const line = lines.find((l) => l.toLowerCase().startsWith(`${SECRET_HEADER}:`));
  assert.ok(line, 'ANTHROPIC_CUSTOM_HEADERS names the secret header');
  assert.strictEqual(line.slice(line.indexOf(':') + 1).trim(), secret());
  // Presenting it the way the Claude CLI does makes the stored key attach.
  const presented = line.slice(0, line.indexOf(':')).trim().toLowerCase();
  const r = await call({ body: msg('fake-oai'), headers: { [presented]: line.slice(line.indexOf(':') + 1).trim() } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(seen[0].headers.authorization, `Bearer ${OAI_KEY}`);
});

test('item 2: a caller-supplied ANTHROPIC_CUSTOM_HEADERS is kept next to the secret, and cannot replace it', () => {
  const env = utils.buildClaudeEnv({ proxyPort, instanceId: 'cli-abc', extraEnv: { ANTHROPIC_CUSTOM_HEADERS: 'X-Mine: 1' }, autoMemory: false });
  assert.ok(env.ANTHROPIC_CUSTOM_HEADERS.includes('X-Mine: 1'));
  assert.ok(env.ANTHROPIC_CUSTOM_HEADERS.includes(secret()));
  const spoofed = utils.buildClaudeEnv({ proxyPort, instanceId: 'cli-abc', extraEnv: { ANTHROPIC_CUSTOM_HEADERS: `${SECRET_HEADER}: nope` }, autoMemory: false });
  const mine = spoofed.ANTHROPIC_CUSTOM_HEADERS.split('\n').filter((l) => l.toLowerCase().startsWith(`${SECRET_HEADER}:`));
  assert.strictEqual(mine.length, 1);
  assert.ok(mine[0].includes(secret()));
});

test('item 2: a session without a proxy port gets no proxy URL and no secret header', () => {
  const env = utils.buildClaudeEnv({ instanceId: 'cli-abc', extraEnv: {}, autoMemory: false });
  assert.strictEqual(env.ANTHROPIC_BASE_URL, undefined);
  assert.ok(!String(env.ANTHROPIC_CUSTOM_HEADERS || '').includes(secret()));
});

// ---------------------------------------------------------------- item 3

test('item 3: the Gemini key is not in the inspector payload (header form)', async () => {
  const r = await call({ body: msg('fake-gem'), headers: withSecret() });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(seen[0].headers['x-goog-api-key'], GEM_KEY, 'the upstream still gets the key');
  const all = broadcasts.join('\n');
  assert.ok(all.includes('translatedHeaders'), 'a translated turn was broadcast');
  assert.ok(!all.includes(GEM_KEY), 'the Gemini key never appears in a broadcast');
  const last = JSON.parse(broadcasts.filter((b) => b.includes('translatedHeaders')).pop());
  const hdrs = last.interaction.translatedHeaders;
  assert.ok(hdrs['x-goog-api-key'], 'the header is kept as a placeholder for the curl export');
  assert.ok(/API_KEY/.test(hdrs['x-goog-api-key']), 'masked, like the other providers');
  assert.ok(!JSON.stringify(stored.map((i) => i.translatedHeaders)).includes(GEM_KEY), 'nor in what the store keeps');
});

test('item 3: OpenAI header stays masked', async () => {
  await call({ body: msg('fake-oai'), headers: withSecret() });
  const all = broadcasts.join('\n');
  assert.ok(!all.includes(OAI_KEY));
  assert.ok(all.includes('Bearer $API_KEY'));
});

test('item 3: sanitizeForDashboard masks a Gemini key in headers and in the URL query', () => {
  const i = {
    id: 'x', request: { model: 'm' }, response: { status: 200, headers: {}, body: null },
    timing: {},
    endpoint: `https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse&key=${GEM_KEY}`,
    requestHeaders: { 'x-goog-api-key': GEM_KEY, 'x-api-key': ANT_KEY, authorization: `Bearer ${OAI_KEY}` },
    translatedHeaders: { 'x-goog-api-key': GEM_KEY, 'X-Goog-Api-Key': GEM_KEY, Authorization: `Bearer ${OAI_KEY}`, 'Content-Type': 'application/json' },
  };
  const out = JSON.stringify(utils.sanitizeForDashboard(i));
  for (const k of [GEM_KEY, OAI_KEY, ANT_KEY]) assert.ok(!out.includes(k), 'no key survives');
  assert.ok(out.includes('application/json'), 'harmless headers are kept');
  assert.ok(out.includes('alt=sse'), 'the rest of the query is kept');
});

test('item 3: maskUrlSecrets handles key= and api_key= in any query position', () => {
  assert.ok(!utils.maskUrlSecrets(`http://h/p?key=${GEM_KEY}`).includes(GEM_KEY));
  assert.ok(!utils.maskUrlSecrets(`http://h/p?a=1&api_key=${GEM_KEY}&b=2`).includes(GEM_KEY));
  assert.strictEqual(utils.maskUrlSecrets('http://h/p?a=1&b=2'), 'http://h/p?a=1&b=2');
  assert.strictEqual(utils.maskUrlSecrets('/v1/messages'), '/v1/messages');
});

// ---------------------------------------------------------------- item 4

test('item 4: an instance id named in the URL is honoured only with the secret', async () => {
  await call({ path: '/i/cli-victim-session/v1/messages', body: msg('claude-sonnet-4-5') });
  assert.strictEqual(stored.length, 1);
  assert.notStrictEqual(stored[0].instanceId, 'cli-victim-session', 'a caller cannot file its turns under another session');

  stored.length = 0;
  await call({ path: '/i/cli-victim-session/v1/messages', body: msg('claude-sonnet-4-5'), headers: withSecret() });
  assert.strictEqual(stored.length, 1);
  assert.strictEqual(stored[0].instanceId, 'cli-victim-session', 'a Vistaclair session keeps its id');
});
