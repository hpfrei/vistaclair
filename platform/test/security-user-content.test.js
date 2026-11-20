// Files supplied by outsiders must not run as live pages on the dashboard's
// origin: ctx.files.serve (app media) and Horst's artifact file route answer
// passive types inline with nosniff, and everything else with a CSP sandbox
// that never includes allow-same-origin (an opaque origin cannot reach the
// dashboard cookies or WebSocket). saveBase64 normalises the stored type.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { saveBase64File, serveFile, normalizeMime, isPassiveMime } = require('../src/apps/app-files');
const horstArtifacts = require('../src/apps/agent/horst-artifacts');
const platformHorst = require('../src/apps/platform-horst');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-user-content-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function get(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: urlPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const csp = (h) => [].concat(h['content-security-policy'] || []).join('; ');
const sandboxed = (h) => /(^|[;\s])sandbox(\s|;|$)/.test(csp(h)) && !/allow-same-origin/.test(csp(h));

// --- ctx.files.serve ---------------------------------------------------------

async function serveWith(t, file, opts) {
  const server = http.createServer((req, res) => {
    res.status = (c) => { res.statusCode = c; return res; };
    res.set = (h) => { for (const [k, v] of Object.entries(h)) res.setHeader(k, v); return res; };
    serveFile(res, file, opts);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return server;
}

function fileWith(name, content) {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, content);
  return f;
}

test('serveFile: text/html and image/svg+xml are sandboxed (no allow-same-origin) and nosniff', async (t) => {
  for (const [name, type] of [['a.html', 'text/html'], ['b.svg', 'image/svg+xml'], ['c.xml', 'application/xml'],
    ['d.js', 'application/javascript'], ['e.html', 'TEXT/HTML; charset=utf-8'], ['f.xhtml', 'application/xhtml+xml']]) {
    const srv = await serveWith(t, fileWith(name, '<script>alert(1)</script>'), { mimeType: type });
    const r = await get(srv, '/');
    assert.equal(r.status, 200, type);
    assert.ok(sandboxed(r.headers), `${type}: csp=${csp(r.headers)}`);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', type);
    assert.ok(!/attachment/i.test(r.headers['content-disposition'] || ''), `${type} stays viewable inline`);
  }
});

test('serveFile: a Range response of a scriptable type is sandboxed too', async (t) => {
  const srv = await serveWith(t, fileWith('r.html', '<script>1</script>'), { mimeType: 'text/html' });
  const r = await get(srv, '/', { Range: 'bytes=0-3' });
  assert.equal(r.status, 206);
  assert.ok(sandboxed(r.headers));
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
});

test('serveFile: malformed, missing and octet-stream types are sandboxed', async (t) => {
  for (const type of ['text/html\r\nX-Evil: 1', 'not a type', 'text/html, text/plain', '', undefined, 'application/octet-stream']) {
    const srv = await serveWith(t, fileWith('m.bin', '<html>'), { mimeType: type });
    const r = await get(srv, '/');
    assert.equal(r.headers['content-type'], 'application/octet-stream', JSON.stringify(type));
    assert.ok(sandboxed(r.headers), JSON.stringify(type));
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-evil'], undefined);
  }
});

test('serveFile: png, pdf, audio, video and text/plain stay inline with nosniff', async (t) => {
  const cases = [['image/png', 'x.png'], ['image/jpeg', 'x.jpg'], ['image/gif', 'x.gif'], ['image/webp', 'x.webp'],
    ['image/avif', 'x.avif'], ['application/pdf', 'x.pdf'], ['audio/mpeg', 'x.mp3'], ['video/mp4', 'x.mp4'],
    ['text/plain; charset=utf-8', 'x.txt']];
  for (const [type, name] of cases) {
    const srv = await serveWith(t, fileWith(name, 'bytes'), { mimeType: type });
    const r = await get(srv, '/');
    assert.equal(r.status, 200, type);
    assert.equal(r.headers['content-type'].split(';')[0], type.split(';')[0], type);
    assert.equal(r.headers['x-content-type-options'], 'nosniff', type);
    assert.ok(!/sandbox/.test(csp(r.headers)), `${type} is passive: no sandbox needed`);
    assert.ok(!/attachment/i.test(r.headers['content-disposition'] || ''), type);
  }
});

test('isPassiveMime / normalizeMime', () => {
  for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'audio/ogg', 'video/webm', 'application/pdf', 'text/plain']) {
    assert.equal(isPassiveMime(t), true, t);
  }
  for (const t of ['text/html', 'image/svg+xml', 'text/xml', 'application/xml', 'application/xhtml+xml', 'text/javascript', 'application/octet-stream', 'text/css']) {
    assert.equal(isPassiveMime(t), false, t);
  }
  assert.equal(normalizeMime(' Image/PNG ; foo=bar'), 'image/png');
  assert.equal(normalizeMime('text/html;charset=utf-8'), 'text/html');
  assert.equal(normalizeMime('garbage'), 'application/octet-stream');
  assert.equal(normalizeMime('a/b/c'), 'application/octet-stream');
  assert.equal(normalizeMime(null), 'application/octet-stream');
});

// --- saveBase64 --------------------------------------------------------------

const B64 = Buffer.from('hello').toString('base64');

test('saveBase64 normalises the stored type and never rejects an upload that worked', () => {
  const app = path.join(tmp, 'app');
  const ok = (data, opts) => saveBase64File(app, data, opts).mimeType;
  assert.equal(ok(B64, { mimeType: 'Image/PNG; charset=x' }), 'image/png');
  assert.equal(ok(`data:IMAGE/JPEG;base64,${B64}`), 'image/jpeg');
  assert.equal(ok(B64, { mimeType: 'text/html;charset=utf-8' }), 'text/html');
  assert.equal(ok(B64, { mimeType: 'no good <type>' }), 'application/octet-stream');
  assert.equal(ok(B64, { mimeType: 'text/html\r\nX: y' }), 'application/octet-stream');
  assert.equal(ok(`data:garbage,${B64}`), 'application/octet-stream');
  assert.equal(ok(B64), 'application/octet-stream');
  const r = saveBase64File(app, B64, { mimeType: 'image/png' });
  assert.ok(r.path.endsWith('.png') && fs.existsSync(r.path), 'extension still follows the normalised type');
});

// --- Horst artifact file route -----------------------------------------------

async function artifactServer(t, file) {
  horstArtifacts.isReady = () => true;
  horstArtifacts.get = async () => ({ id: 1, file_ref: {} });
  horstArtifacts.getFileBuffer = async () => file;
  const router = express.Router();
  platformHorst.mountApi(router);
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return server;
}

test('artifact file route: a text/html attachment is sandboxed, nosniff, not allow-same-origin', async (t) => {
  for (const contentType of ['text/html', 'image/svg+xml', 'application/xml', 'TEXT/HTML; charset=utf-8', 'bogus', undefined]) {
    const srv = await artifactServer(t, { buffer: Buffer.from('<script>1</script>'), filename: 'a.html', contentType });
    const r = await get(srv, '/pro/horst/api/artifacts/1/file');
    assert.equal(r.status, 200, String(contentType));
    assert.ok(sandboxed(r.headers), `${contentType}: csp=${csp(r.headers)}`);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
});

test('artifact file route: a pdf and a png stay inline', async (t) => {
  for (const [contentType, filename] of [['application/pdf', 'inv.pdf'], ['image/png', 'x.png']]) {
    const srv = await artifactServer(t, { buffer: Buffer.from('bytes'), filename, contentType });
    const r = await get(srv, '/pro/horst/api/artifacts/1/file');
    assert.equal(r.headers['content-type'].split(';')[0], contentType);
    assert.match(r.headers['content-disposition'], /^inline/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(!/sandbox/.test(csp(r.headers)));
  }
});

test('artifact file route: a hostile filename cannot break the header', async (t) => {
  const srv = await artifactServer(t, { buffer: Buffer.from('x'), filename: 'a"\r\nSet-Cookie: x=1.pdf', contentType: 'application/pdf' });
  const r = await get(srv, '/pro/horst/api/artifacts/1/file');
  assert.equal(r.status, 200);
  assert.equal(r.headers['set-cookie'], undefined);
});
