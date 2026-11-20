// Vista › Files: the deliveries ledger behind the Mini App's Files tab and the
// Horst tab's Files view (agent/horst-deliveries.js).
//
// Asserted over a real HTTP listener on 127.0.0.1 (a throwaway express app in
// this process, never the control-room server): the Mini App routes refuse
// without an initData bearer, the bytes route answers a ticket or the bearer,
// serves Range as 206, and refuses an artifact the ledger does not hold;
// remove unpins and hides; the web list route is owner-only; the owner's
// /pro/artifacts/:id answers Range too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const telegram = require('../src/apps/telegram');
const appIdentity = require('../src/apps/app-identity');
const appManager = require('../src/apps/app-manager');
const art = require('../src/apps/app-artifacts');
const deliveries = require('../src/apps/agent/horst-deliveries');
const miniapp = require('../src/apps/platform-miniapp');
const platformHorst = require('../src/apps/platform-horst');

const OWNER = 42;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-vista-files-'));
art.init({ dir: path.join(tmp, 'artifacts') });
deliveries.init({ dir: path.join(tmp, 'horst') });

// initData: a signed payload is stood in for by the literal 'signed'.
appIdentity.validateInitData = (key, initData) => (initData === 'signed' ? { id: OWNER } : null);
Object.assign(telegram, { getBot: () => ({ restricted: true }), isAllowed: (key, id) => Number(id) === OWNER });
let ownerReq = false;
appManager.setOwnerCheck(() => ownerReq);

const app = express();
app.use(express.json());
miniapp.mountApi(app);
platformHorst.mountApi(app);
app.get('/pro/artifacts/:id', art.serve);
let server;
let base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const http = (p, opts = {}) => fetch(base + p, opts);
const jsonOf = async (res) => ({ status: res.status, body: await res.json() });
let bearer = null;
const authed = (p, opts = {}) => http(p, { ...opts, headers: { 'X-Vista-Session': bearer, 'Content-Type': 'application/json', ...(opts.headers || {}) } });

const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
let song; let pic; let stray; let delivered;

test.before(async () => {
  song = await art.putPlatform(BYTES, { name: 'Sóng 1.mp3', mime: 'audio/mpeg' }, { producer: { platform: 'test' } });
  pic = await art.putPlatform(Buffer.from('\x89PNG pic'), { name: 'pic.png', mime: 'image/png' }, { producer: { platform: 'test' } });
  stray = await art.putPlatform(Buffer.from('not delivered'), { name: 'stray.txt', mime: 'text/plain' }, { producer: { platform: 'test' } });
  delivered = deliveries.record([song.link, pic.link], { source: 'chat', conversationId: 'tg42', title: 'sing and draw' });
});

test('every Mini App Files route refuses without the initData bearer', async () => {
  for (const [method, p] of [['GET', '/pro/vista/api/files'], ['GET', `/pro/vista/api/files/${delivered[0].id}`],
    ['POST', `/pro/vista/api/files/${delivered[0].id}/remove`], ['GET', `/pro/vista/api/artifacts/${song.id}`]]) {
    const r = await jsonOf(await http(p, { method }));
    assert.equal(r.status, 401, `${method} ${p}`);
    assert.equal(r.body.error, 'unauthorized');
  }
  const bad = await jsonOf(await http('/pro/vista/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: 'forged' }) }));
  assert.equal(bad.status, 401);
  const ok = await jsonOf(await http('/pro/vista/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: 'signed' }) }));
  assert.equal(ok.status, 200);
  bearer = ok.body.token;
});

test('the list: newest first, kinds counted, each file with a ticketed byte URL; detail carries the batch', async () => {
  const r = await jsonOf(await authed('/pro/vista/api/files'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.files.map((f) => f.name).sort(), ['Sóng 1.mp3', 'pic.png']);
  assert.equal(r.body.counts.audio, 1);
  assert.equal(r.body.counts.picture, 1);
  const f = r.body.files.find((x) => x.kind === 'audio');
  assert.match(f.src, new RegExp(`^api/artifacts/${song.id}\\?k=\\d+\\.[A-Za-z0-9_-]{43}$`));
  const only = await jsonOf(await authed('/pro/vista/api/files?kind=picture'));
  assert.deepEqual(only.body.files.map((x) => x.name), ['pic.png']);
  const d = await jsonOf(await authed(`/pro/vista/api/files/${delivered[0].id}`));
  assert.equal(d.body.file.id, delivered[0].id);
  assert.equal(d.body.batch.length, 2);
  assert.deepEqual(d.body.file.previews, [delivered[1].id]);
});

test('the bytes: the ticket alone opens them, with Range as 206 and the proper name', async () => {
  const k = miniapp.ticketFor(song.id);
  const full = await http(`/pro/vista/api/artifacts/${song.id}?k=${k}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'audio/mpeg');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('content-disposition'), "attachment; filename=\"S_ng 1.mp3\"; filename*=UTF-8''S%C3%B3ng%201.mp3");
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), BYTES);

  const part = await http(`/pro/vista/api/artifacts/${song.id}?k=${k}`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000');
  assert.equal(part.headers.get('content-length'), '100');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), BYTES.subarray(100, 200));

  const tail = await http(`/pro/vista/api/artifacts/${song.id}?k=${k}`, { headers: { Range: 'bytes=-10' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-range'), 'bytes 990-999/1000');
  const open = await http(`/pro/vista/api/artifacts/${song.id}?k=${k}`, { headers: { Range: 'bytes=900-' } });
  assert.equal(open.headers.get('content-range'), 'bytes 900-999/1000');
  const past = await http(`/pro/vista/api/artifacts/${song.id}?k=${k}`, { headers: { Range: 'bytes=5000-' } });
  assert.equal(past.status, 416);
  assert.equal(past.headers.get('content-range'), 'bytes */1000');

  // The bearer header works as well (a fetch); a ticket opens only its artifact.
  assert.equal((await authed(`/pro/vista/api/artifacts/${song.id}`)).status, 200);
  assert.equal((await http(`/pro/vista/api/artifacts/${pic.id}?k=${k}`)).status, 401);
  assert.equal((await http(`/pro/vista/api/artifacts/${song.id}?k=${k.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))}`)).status, 401);
  assert.equal(miniapp.ticketValid(song.id, k, Date.now() + 8 * 60 * 60 * 1000), false, 'a ticket expires');
});

test('an artifact the ledger does not hold is refused, even to the bearer', async () => {
  const r = await jsonOf(await authed(`/pro/vista/api/artifacts/${stray.id}`));
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'not a delivered file');
  assert.equal((await http(`/pro/vista/api/artifacts/${stray.id}?k=${miniapp.ticketFor(stray.id)}`)).status, 404);
  assert.equal((await authed('/pro/vista/api/artifacts/..%2F..%2Fetc%2Fpasswd')).status, 404);
});

test('the web Files list is owner-only, over the same ledger, with the owner byte route', async () => {
  ownerReq = false;
  assert.equal((await http('/pro/horst/api/files')).status, 401);
  assert.equal((await http(`/pro/horst/api/files/${delivered[0].id}/remove`, { method: 'POST' })).status, 401);
  ownerReq = true;
  const r = await jsonOf(await http(`/pro/horst/api/files?artifact=${pic.id}`));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.files.map((f) => [f.id, f.src]), [[delivered[1].id, `/pro/artifacts/${pic.id}`]]);
  const part = await http(`/pro/artifacts/${song.id}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(part.status, 206);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), BYTES.subarray(0, 10));
  ownerReq = false;
});

test('remove unpins the artifact and hides it everywhere', async () => {
  assert.ok(art.get(song.uri).pins.some((p) => p.holder === deliveries.HOLDER));
  const r = await jsonOf(await authed(`/pro/vista/api/files/${delivered[0].id}/remove`, { method: 'POST', body: '{}' }));
  assert.equal(r.status, 200);
  assert.ok(r.body.file.removedAt);
  assert.ok(!art.get(song.uri).pins.some((p) => p.holder === deliveries.HOLDER), 'unpinned, so gc takes it');
  const list = await jsonOf(await authed('/pro/vista/api/files'));
  assert.deepEqual(list.body.files.map((f) => f.name), ['pic.png']);
  assert.equal(list.body.counts.audio, 0);
  assert.equal((await authed(`/pro/vista/api/artifacts/${song.id}`)).status, 404, 'its bytes are no longer served');
  assert.equal((await authed(`/pro/vista/api/files/${delivered[0].id}`)).status, 404);
  assert.equal((await authed(`/pro/vista/api/files/${delivered[0].id}/remove`, { method: 'POST', body: '{}' })).status, 400);
  // The ledger survives a reload; a fresh delivery of the same file is a new record.
  deliveries.init({ dir: path.join(tmp, 'horst') });
  assert.deepEqual(deliveries.list().files.map((f) => f.name), ['pic.png']);
  const again = deliveries.record([song.link], { source: 'job', conversationId: 'tg42', title: 'again' });
  assert.notEqual(again[0].id, delivered[0].id);
  assert.ok(art.get(song.uri).pins.some((p) => p.holder === deliveries.HOLDER));
});

test('kinds: pictures, audio, video, 3D models, documents', () => {
  assert.equal(deliveries.kindOf('image/png', 'a.png'), 'picture');
  assert.equal(deliveries.kindOf('audio/ogg', 'a.ogg'), 'audio');
  assert.equal(deliveries.kindOf('video/mp4', 'a.mp4'), 'video');
  assert.equal(deliveries.kindOf('model/gltf-binary', 'a.glb'), 'model');
  assert.equal(deliveries.kindOf('application/octet-stream', 'scene.STL'), 'model');
  assert.equal(deliveries.kindOf('application/pdf', 'a.pdf'), 'document');
});

test('Telegram: no public URL → no button, the text names the Horst tab; a big picture goes as a downscaled preview', async () => {
  const sent = [];
  const photos = [];
  deliveries.init({
    dir: path.join(tmp, 'horst'),
    sendControlMessage: async (chatId, text, markup) => { sent.push({ text, markup }); return []; },
    telegram: { sendPhoto: async (a) => { photos.push(a); return { ok: true }; } },
    miniAppUrl: () => null,
  });
  const doc = await art.putPlatform(Buffer.from('%PDF'), { name: 'r.pdf', mime: 'application/pdf' }, { producer: { platform: 'test' } });
  await deliveries.toTelegram(OWNER, 'Your report.', deliveries.record([doc.link], { source: 'chat', title: 'report' }));
  assert.deepEqual(sent, [{ text: 'Your report.\n\n📁 The file is in the Horst tab › Files.', markup: undefined }]);
  assert.equal(photos.length, 0, 'a document is link only');

  let sharp = null;
  try { sharp = require('sharp'); } catch {}
  if (!sharp) return;
  const raw = Buffer.alloc(1200 * 1200 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919) % 256;
  const big = await sharp(raw, { raw: { width: 1200, height: 1200, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(big.length > 1024 * 1024);
  const v = await art.putPlatform(big, { name: 'big.png', mime: 'image/png' }, { producer: { platform: 'test' } });
  deliveries.init({
    dir: path.join(tmp, 'horst'),
    sendControlMessage: async (chatId, text, markup) => { sent.push({ text, markup }); return []; },
    telegram: { sendPhoto: async (a) => { photos.push(a); return { ok: true }; } },
    miniAppUrl: () => 'https://vc.example/pro/vista/',
  });
  const [d] = deliveries.record([v.link], { source: 'chat', title: 'big' });
  await deliveries.toTelegram(OWNER, 'Big one.', [d]);
  assert.equal(photos.length, 1);
  assert.equal(photos[0].contentType, 'image/jpeg');
  assert.ok(photos[0].photo.length < big.length / 2, 'compressed');
  assert.equal(photos[0].caption, 'Big one.');
  assert.equal(photos[0].options.reply_markup.inline_keyboard[0][0].web_app.url, `https://vc.example/pro/vista/?file=${d.id}`);
});
