// Files in and out of Horst's chat: a photo or document the owner sends the
// control bot becomes a vc-artifact (owner principal, Telegram producer) named
// in the turn text; the owner downloads any artifact from /pro/artifacts/:id
// (owner only, resolved by id alone, safe headers); the Horst tab renders the
// uris in a message as download chips. Stubbed Telegram, no model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const { makeAppsDir, silenceWarn } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const art = require('../src/apps/app-artifacts');
const telegram = require('../src/apps/telegram');
const horstArtifacts = require('../src/apps/agent/horst-artifacts');
const platformHorst = require('../src/apps/platform-horst');
const chips = require('../public/horst/horst-artifact-chips');

const appsDir = makeAppsDir({ 'my-blender': {} });
appManager.setAppsDir(appsDir);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-horst-artio-'));
art.init({ dir: path.join(tmp, 'artifacts') });

// --- the Telegram side -------------------------------------------------------

const files = new Map(); // file_id → Buffer
const downloads = [];
telegram.downloadFile = async (key, fileId) => {
  downloads.push(fileId);
  if (!files.has(fileId)) throw new Error('unknown file');
  return { buffer: files.get(fileId), contentType: 'application/octet-stream' };
};
// The memory filing needs the DB; the attachment must not.
horstArtifacts.isReady = () => false;

const ATTACHED = /\[attached: (vc-artifact:\/\/art_[0-9a-f]{16}-[0-9a-f]{4}) (.+) ([a-z0-9.+-]+\/[a-z0-9.+-]+) ([\d.]+ (?:kB|MB))\]/;

test('putPlatform stores bytes for the owner, marks the producer, and refuses a path', async () => {
  const v = await art.putPlatform(Buffer.from('png-bytes'), { name: 'x.png' }, { producer: { platform: 'telegram', chatId: '7' } });
  assert.equal(v.mime, 'image/png');
  assert.equal(v.app, null);
  assert.deepEqual(v.grants, []);
  assert.deepEqual(v.producer, { platform: 'telegram', chatId: '7' });
  assert.ok(art.canRead({ type: 'owner' }, v.uri));
  assert.ok(!art.canRead({ type: 'app', app: 'my-blender' }, v.uri), 'an app reads it only once a tool call names it');
  await assert.rejects(() => art.putPlatform('/etc/passwd', {}, { producer: { platform: 'telegram' } }), /Buffer/);
  await assert.rejects(() => art.putPlatform(Buffer.from('x'), {}, {}), /producer\.platform/);
});

test('a Telegram photo becomes an owner artifact named in the turn text, caption first', async () => {
  files.set('ph-big', Buffer.alloc(300 * 1024, 7));
  const msg = { message_id: 11, chat: { id: 42 }, caption: 'make a 3D model like this', photo: [{ file_id: 'ph-small', file_size: 900 }, { file_id: 'ph-big', file_size: 300 * 1024 }] };
  const { result: r } = await silenceWarn(() => platformHorst.enrichTelegramMedia(msg));
  assert.equal(r.spoken, false);
  assert.ok(r.text.startsWith('make a 3D model like this'), r.text);
  const m = ATTACHED.exec(r.text);
  assert.ok(m, `no attached line in: ${r.text}`);
  assert.equal(m[3], 'image/jpeg');
  assert.equal(m[4], '300 kB');
  const v = art.get(m[1]);
  assert.equal(v.size, 300 * 1024);
  assert.equal(v.producer.platform, 'telegram');
  assert.equal(v.producer.chatId, '42');
  assert.equal(v.producer.messageId, 11);
  assert.equal(art.principalOf({ type: 'horst', conversationId: 'c' }).type, 'owner');
  assert.ok(art.canRead(art.principalOf({ type: 'horst' }), m[1]), 'a Horst caller can pass it on');
  assert.equal(downloads.at(-1), 'ph-big', 'the largest size is the one stored');
});

test('a .glb document keeps its name and gets the model mime, skipping the memory filing', async () => {
  files.set('doc-glb', Buffer.from('glTF-binary'));
  const msg = { message_id: 12, chat: { id: 42 }, document: { file_id: 'doc-glb', file_name: 'chair v2.glb', mime_type: 'application/octet-stream', file_size: 11 } };
  const { result: r, warnings } = await silenceWarn(() => platformHorst.enrichTelegramMedia(msg));
  const m = ATTACHED.exec(r.text);
  assert.ok(m, r.text);
  assert.equal(m[2], 'chair v2.glb');
  assert.equal(m[3], 'model/gltf-binary');
  assert.equal(art.get(m[1]).name, 'chair v2.glb');
  assert.deepEqual(warnings, [], 'no analysis is attempted on a 3D file');
});

test('an unknown extension takes Telegram\'s mime; a hostile name cannot break the line', async () => {
  files.set('doc-odd', Buffer.from('data'));
  const msg = { chat: { id: 1 }, document: { file_id: 'doc-odd', file_name: 'a]\n[b.xyz', mime_type: 'application/x-thing', file_size: 4 } };
  const { result: r } = await silenceWarn(() => platformHorst.enrichTelegramMedia(msg));
  const m = ATTACHED.exec(r.text);
  assert.ok(m, r.text);
  assert.equal(m[2], 'a___b.xyz');
  assert.equal(m[3], 'application/x-thing');
});

test('a document above the 20 MB bot download limit is refused with a clear note, never downloaded', async () => {
  const before = downloads.length;
  const msg = { chat: { id: 1 }, document: { file_id: 'huge', file_name: 'scan.blend', file_size: 34 * 1024 * 1024 } };
  const r = await platformHorst.enrichTelegramMedia(msg);
  assert.equal(r.text, '');
  assert.match(r.note, /scan\.blend is 34\.0 MB/);
  assert.match(r.note, /20 MB/);
  const withCaption = await platformHorst.enrichTelegramMedia({ ...msg, caption: 'rig this' });
  assert.match(withCaption.text, /^rig this\n\n\[attachment not received: scan\.blend, 34\.0 MB/);
  assert.equal(downloads.length, before);
});

test('Horst is told he may pass an attached uri to a tool, and that the attachment alone never calls one', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/apps/platform-horst.js'), 'utf-8');
  assert.match(src, /arrives as a line \[attached: vc-artifact:\/\//);
  assert.match(src, /an attachment alone is never a reason to call a tool/);
});

// --- the download route --------------------------------------------------------

let server; let base;
test.before(async () => {
  const app = express();
  const router = express.Router();
  art.mountApi(router);
  app.use(router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  appManager.setOwnerCheck((req) => req.headers['x-test-owner'] === '1');
});
test.after(() => server && server.close());

const owner = { headers: { 'x-test-owner': '1' } };

test('the owner gets the bytes with type, length, filename and safe headers', async () => {
  const v = await art.putPlatform(Buffer.from('PNGDATA'), { name: 'Grüße "photo".png' }, { producer: { platform: 'telegram' } });
  const res = await fetch(`${base}/pro/artifacts/${v.id}`, owner);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('content-length'), '7');
  const cd = res.headers.get('content-disposition');
  assert.match(cd, /^inline; filename="Gr__e _photo_.png"; filename\*=UTF-8''Gr%C3%BC%C3%9Fe%20%22photo%22.png$/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.equal(await res.text(), 'PNGDATA');
  const dl = await fetch(`${base}/pro/artifacts/${v.id}?download=1`, owner);
  assert.match(dl.headers.get('content-disposition'), /^attachment;/);
  const head = await fetch(`${base}/pro/artifacts/${v.id}`, { ...owner, method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '7');
});

test('an app-made artifact is served too; html never renders inline', async () => {
  fs.writeFileSync(path.join(appsDir, 'my-blender', 'page.html'), '<script>alert(1)</script>');
  const v = await art.put('my-blender', 'page.html');
  const res = await fetch(`${base}/pro/artifacts/${v.id}`, owner);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/html');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="page\.html"/);
});

test('unauthenticated and non-owner requests are refused', async () => {
  const v = await art.putPlatform(Buffer.from('secret'), { name: 's.txt' }, { producer: { platform: 'telegram' } });
  assert.equal((await fetch(`${base}/pro/artifacts/${v.id}`)).status, 401);
  assert.equal((await fetch(`${base}/pro/artifacts/${v.id}`, { headers: { 'x-test-owner': '0' } })).status, 401);
  appManager.setOwnerCheck(null);
  try { assert.equal((await fetch(`${base}/pro/artifacts/${v.id}`, owner)).status, 401, 'no owner check wired → refuse'); }
  finally { appManager.setOwnerCheck((req) => req.headers['x-test-owner'] === '1'); }
});

test('an unknown id is 404 and a path never reaches the filesystem', async () => {
  assert.equal((await fetch(`${base}/pro/artifacts/art_0123456789abcdef-0000`, owner)).status, 404);
  for (const p of ['..%2F..%2Fetc%2Fpasswd', '%2e%2e%2fmeta', 'art_0123456789abcdef-0000%2F..', 'meta']) {
    const res = await fetch(`${base}/pro/artifacts/${p}`, owner);
    assert.equal(res.status, 404, p);
  }
  // A tampered record cannot point its blob elsewhere.
  const v = await art.putPlatform(Buffer.from('ok'), { name: 'ok.txt' }, { producer: { platform: 'telegram' } });
  const metaFile = path.join(tmp, 'artifacts', 'meta', `${v.id}.json`);
  const rec = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
  rec.sha256 = '../../../../etc/passwd';
  fs.writeFileSync(metaFile, JSON.stringify(rec));
  art.init({ dir: path.join(tmp, 'artifacts') }); // reload records from disk
  assert.equal((await fetch(`${base}/pro/artifacts/${v.id}`, owner)).status, 404);
});

// --- the chips ---------------------------------------------------------------------

test('a job outcome\'s file lines become chips; images get a thumbnail', () => {
  const text = [
    '✅ my-blender make_model done (2m 10s) — job_1',
    '',
    'Files:',
    '- chair.glb (model/gltf-binary, 1.2 MB): vc-artifact://art_0123456789abcdef-aaaa',
    '- preview.png (image/png, 80 kB): vc-artifact://art_fedcba9876543210-bbbb',
  ].join('\n');
  const refs = chips.refsOf(text);
  assert.deepEqual(refs.map((r) => [r.id, r.name, r.mime, r.size]), [
    ['art_0123456789abcdef-aaaa', 'chair.glb', 'model/gltf-binary', '1.2 MB'],
    ['art_fedcba9876543210-bbbb', 'preview.png', 'image/png', '80 kB'],
  ]);
  const html = chips.chipsHtml(text);
  assert.match(html, /href="\/pro\/artifacts\/art_0123456789abcdef-aaaa\?download=1" download="chair\.glb"/);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /<img src="\/pro\/artifacts\/art_fedcba9876543210-bbbb"/);
  assert.match(html, /<a class="art-files" href="#files" data-art-files="art_0123456789abcdef-aaaa"/);
  assert.equal((html.match(/data-art-files=/g) || []).length, 2, 'every chip links to Files');
});

test('an attached line and a bare uri become chips; names are escaped; no uri, no chips', () => {
  const text = 'look\n[attached: vc-artifact://art_1111111111111111-cccc <b>x</b> 2.jpg image/jpeg 1.2 MB]\nand vc-artifact://art_2222222222222222-dddd twice vc-artifact://art_2222222222222222-dddd';
  const refs = chips.refsOf(text);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].name, '<b>x</b> 2.jpg');
  assert.equal(refs[0].mime, 'image/jpeg');
  assert.equal(refs[1].name, 'art_2222222222222222-dddd');
  const html = chips.chipsHtml(text);
  assert.ok(!html.includes('<b>'), 'the name is escaped');
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; 2\.jpg/);
  assert.equal(chips.chipsHtml('no files here'), '');
});
