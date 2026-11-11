// User content served by /api/raw-file and /outputs must not run as a live
// page with the dashboard's rights. Active types (html, svg, xml, ...) get
// `Content-Security-Policy: sandbox` without allow-same-origin; passive types
// are answered as before. Every response carries X-Content-Type-Options:
// nosniff. Temp files only; an in-process app on an ephemeral port.
//
//   node --test test/security-user-content.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-uc-'));
process.env.VISTACLAIR_HOME = path.join(tmpRoot, 'home');
for (const m of ['../src/api', '../src/utils']) {
  try { delete require.cache[require.resolve(m)]; } catch {}
}
const createApiRouter = require('../src/api');

const filesDir = path.join(tmpRoot, 'files');
const outputsDir = path.join(tmpRoot, 'outputs');
fs.mkdirSync(filesDir, { recursive: true });
fs.mkdirSync(outputsDir, { recursive: true });

const FILES = {
  'page.html': '<script>fetch("/api/x")</script>',
  'page.htm': '<b>x</b>',
  'doc.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"></html>',
  'pic.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
  'data.xml': '<a/>',
  'code.js': 'alert(1)',
  'pic.png': Buffer.from('89504e470d0a1a0a', 'hex'),
  'doc.pdf': '%PDF-1.4',
  'note.md': '# hi',
  'note.txt': 'hello',
  'data.json': '{"a":1}',
  'noext': 'plain',
};
for (const [name, body] of Object.entries(FILES)) {
  fs.writeFileSync(path.join(filesDir, name), body);
  fs.writeFileSync(path.join(outputsDir, name), body);
}

let server, base;
test.before(async () => {
  const app = express();
  app.use('/api', createApiRouter({}));
  app.use('/outputs', express.static(outputsDir, { setHeaders: createApiRouter.userContentSetHeaders }));
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((r) => server.close(r)));

const ACTIVE = ['page.html', 'page.htm', 'doc.xhtml', 'pic.svg', 'data.xml'];
const PASSIVE = { 'pic.png': 'image/png', 'doc.pdf': 'application/pdf', 'note.md': 'text/markdown', 'note.txt': 'text/plain', 'data.json': 'application/json' };

const viaRaw = (name) => fetch(`${base}/api/raw-file?path=${encodeURIComponent(path.join(filesDir, name))}`);
const viaOutputs = (name) => fetch(`${base}/outputs/${name}`);

function assertSandboxed(resp) {
  const csp = resp.headers.get('content-security-policy') || '';
  assert.match(csp, /(^|[;,]\s*)sandbox(\s|;|,|$)/, `sandbox expected, got "${csp}"`);
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.strictEqual(resp.headers.get('x-content-type-options'), 'nosniff');
}

for (const [label, get] of [['/api/raw-file', viaRaw], ['/outputs', viaOutputs]]) {
  for (const name of ACTIVE) {
    test(`${label}: ${name} is sandboxed without allow-same-origin, nosniff`, async () => {
      const resp = await get(name);
      assert.strictEqual(resp.status, 200);
      assertSandboxed(resp);
      await resp.arrayBuffer();
    });
  }

  test(`${label}: code.js is not an executable same-origin script`, async () => {
    const resp = await get('code.js');
    assert.strictEqual(resp.status, 200);
    assert.strictEqual(resp.headers.get('x-content-type-options'), 'nosniff');
    const type = resp.headers.get('content-type') || '';
    const csp = resp.headers.get('content-security-policy') || '';
    assert.ok(/^text\/plain/.test(type) || (/sandbox/.test(csp) && !/allow-same-origin/.test(csp)), `type ${type}, csp ${csp}`);
    assert.strictEqual(await resp.text(), 'alert(1)');
  });

  for (const [name, mime] of Object.entries(PASSIVE)) {
    test(`${label}: ${name} keeps its type (${mime}) plus nosniff`, async () => {
      const resp = await get(name);
      assert.strictEqual(resp.status, 200);
      assert.ok((resp.headers.get('content-type') || '').startsWith(mime), resp.headers.get('content-type'));
      assert.strictEqual(resp.headers.get('x-content-type-options'), 'nosniff');
      await resp.arrayBuffer();
    });
  }
}

test('/api/raw-file: a range request on an active file is sandboxed too', async () => {
  const resp = await fetch(`${base}/api/raw-file?path=${encodeURIComponent(path.join(filesDir, 'page.html'))}`, { headers: { Range: 'bytes=0-3' } });
  assert.strictEqual(resp.status, 206);
  assertSandboxed(resp);
  await resp.arrayBuffer();
});

test('/api/raw-file: a range request on a passive file keeps 206 and gets nosniff', async () => {
  const resp = await fetch(`${base}/api/raw-file?path=${encodeURIComponent(path.join(filesDir, 'note.txt'))}`, { headers: { Range: 'bytes=0-1' } });
  assert.strictEqual(resp.status, 206);
  assert.strictEqual(resp.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(await resp.text(), 'he');
});

test('/api/raw-file: a file with no extension is not served as a page', async () => {
  const resp = await viaRaw('noext');
  assert.strictEqual(resp.headers.get('x-content-type-options'), 'nosniff');
  await resp.arrayBuffer();
});

test('/api/raw-file: still previews any path (no path restriction added)', async () => {
  const resp = await viaRaw('note.txt');
  assert.strictEqual(resp.status, 200);
  assert.strictEqual(await resp.text(), 'hello');
});
