// Files a quick tool returns during a Horst chat turn reach the owner: the
// turn collects the tool results' vc-artifact resource_links (app-tools
// horstTurnFiles), the assistant message carries them (msg.files and a
// `Files:` block for the uris the reply does not name), the deliveries ledger
// records and pins them (Vista › Files), and a Telegram turn sends ONE message:
// the reply with an "Open in Vista" button, as a preview photo when a picture
// came — never the file itself. A job's files go only with its outcome
// (agent/horst-jobs.js), never with a turn.
// Stubbed model, Telegram and conversation dir — no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir, silenceWarn } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const appJobs = require('../src/apps/app-jobs');
const appTools = require('../src/apps/app-tools');
const appBridge = require('../src/apps/app-bridge');
const jobs = require('../src/apps/app-tool-jobs');
const art = require('../src/apps/app-artifacts');
const telegram = require('../src/apps/telegram');
const platformHorst = require('../src/apps/platform-horst');
const platformTelegram = require('../src/apps/platform-telegram');
const horstDeliveries = require('../src/apps/agent/horst-deliveries');

const CHAT = 42;
const appsDir = makeAppsDir({ 'pic-app': {} });
appManager.setAppsDir(appsDir);
appJobs.init({ appsDir });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-horst-turnfiles-'));
art.init({ dir: path.join(tmp, 'artifacts') });
jobs.init({ dataHome: tmp, sendToSession: () => ({ delivered: false }) });

// --- the control bot: every outgoing op in order ------------------------------
const tg = [];
let nextId = 900;
let onUpdate = null;
Object.assign(telegram, {
  status: () => ({ configured: true, restricted: true, allowedChatIds: [String(CHAT)] }),
  getBot: () => ({ restricted: true }),
  isAllowed: (key, chatId) => String(chatId) === String(CHAT),
  claimedOwner: () => CHAT,
  isOwnerAct: (key, chat, from) => chat?.type === 'private' && chat.id === CHAT && from?.id === CHAT,
  hasBot: () => false,
  getPublicUrl: () => 'https://vc.example',
  registerUpdateHandler: (key, fn) => { onUpdate = fn; },
  call: async (key, method, params) => {
    if (method !== 'sendChatAction') tg.push({ method, ...params });
    return { ok: true, result: { message_id: nextId++ } };
  },
  sendPhoto: async (key, args) => { tg.push({ method: 'sendPhoto', ...args }); },
  sendAudio: async (key, args) => { tg.push({ method: 'sendAudio', ...args }); },
  sendDocument: async (key, args) => { tg.push({ method: 'sendDocument', ...args }); },
});

// --- the model: a turn script calls tools with the turn's sessionTag ----------
let script = async () => 'ok';
appBridge.aiPrompt = async (appName, appDir, params) => {
  if (!params.sessionTag) return { text: '' }; // not a chat turn (boot work)
  const call = (app, tool, args = {}, opts) => appTools.callAppToolHandler(app, tool, args, { type: 'platform', sessionTag: params.sessionTag }, opts);
  return { text: await script(call, params) };
};

let platformTelegramReady = false;
test.before(async () => {
  await silenceWarn(() => platformHorst.init({ appsDir, broadcaster: { broadcast() {} } }));
  platformTelegram.init('test-token', {});
  platformTelegramReady = !!onUpdate;
});
test.after(() => {
  jobs.shutdown();
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

// --- tools --------------------------------------------------------------------
const linkOf = (v) => ({ type: 'resource_link', uri: v.uri, name: v.name, mimeType: v.mime, size: v.size });
const returning = (...links) => ({ content: [{ type: 'text', text: 'made it' }, ...links] });
let quickResult = returning();
let jobResult = returning();
appTools.registerAppTools('__platform__', [
  { name: 'test_image_generate', description: 'Make a picture.', expose: 'platform', sideEffects: 'none' },
]);
appTools.registerAppToolHandler('__platform__', 'test_image_generate', async () => quickResult);
appTools.registerAppTools('pic-app', [
  { name: 'render_film', description: 'Render a film.', expose: 'platform', kind: 'job', sideEffects: 'writes' },
]);
appTools.registerAppToolHandler('pic-app', 'render_film', async () => jobResult);

const put = (bytes, name, mime) => art.putPlatform(Buffer.from(bytes), { name, mime }, { producer: { platform: 'test' } });
const conversation = (id) => JSON.parse(fs.readFileSync(path.join(appsDir, '.horst', 'conversations', `${id}.json`), 'utf8'));
const lastAssistant = (id) => conversation(id).messages.filter((m) => m.role === 'assistant').at(-1);
const sendTg = (text) => onUpdate({ message: { message_id: nextId++, chat: { id: CHAT, type: 'private' }, from: { id: CHAT }, text } });

const VISTA = 'https://vc.example/pro/vista/';
const vistaButton = (markup) => markup.inline_keyboard.at(-1)[0];
const deliveryOf = (uri) => horstDeliveries.list().files.find((d) => d.uri === uri);

test('a Telegram turn with a picture: ONE photo message carrying the reply and the Vista button; the ledger records and pins it', async () => {
  assert.ok(platformTelegramReady, 'the control bot registered its update handler');
  tg.length = 0;
  const png = await put('\x89PNG cat', 'cat.png', 'image/png');
  quickResult = returning(linkOf(png));
  script = async (call) => { await call('__platform__', 'test_image_generate', { prompt: 'a cat' }); return 'Here is your cat.'; };
  await sendTg('draw a cat');

  assert.deepEqual(tg.map((o) => o.method), ['sendPhoto'], 'one message, no upload of the file as such');
  assert.equal(tg[0].caption, 'Here is your cat.', 'no Files block on Telegram');
  assert.equal(tg[0].contentType, 'image/png');
  assert.equal(String(tg[0].chatId), String(CHAT));
  const d = deliveryOf(png.uri);
  assert.ok(d, 'the delivery is in the ledger');
  assert.equal(d.source, 'chat');
  assert.equal(d.kind, 'picture');
  assert.equal(d.title, 'draw a cat', 'titled by the request');
  assert.equal(d.conversationId, `tg${CHAT}`);
  assert.ok(art.get(png.uri).pins.some((p) => p.holder === horstDeliveries.HOLDER && p.reason === 'horst-delivery'));
  assert.deepEqual(vistaButton(tg[0].options.reply_markup), { text: '📁 Open in Vista', web_app: { url: `${VISTA}?file=${d.id}` } });
  const msg = lastAssistant(`tg${CHAT}`);
  assert.match(msg.text, /^Here is your cat\.\n\nFiles:\n- cat\.png \(image\/png, \d+ B\): vc-artifact:\/\/art_/);
  assert.ok(msg.text.includes(png.uri));
  assert.deepEqual(msg.files, [{ uri: png.uri, name: 'cat.png', mimeType: 'image/png', size: png.size }]);
  // The Horst tab chips read the same line.
  const chips = require('../public/horst/horst-artifact-chips');
  assert.equal(chips.refsOf(msg.text)[0].name, 'cat.png');
});

test('an audio file is link only: the reply as one text message with the Vista button', async () => {
  tg.length = 0;
  const mp3 = await put('ID3 song', 'song.mp3', 'audio/mpeg');
  quickResult = returning(linkOf(mp3));
  script = async (call) => { await call('__platform__', 'test_image_generate', {}); return 'A song.'; };
  await sendTg('sing');
  assert.deepEqual(tg.map((o) => o.method), ['sendMessage']);
  assert.equal(tg[0].text, 'A song.');
  assert.deepEqual(vistaButton(tg[0].reply_markup), { text: '📁 Open in Vista', web_app: { url: `${VISTA}?file=${deliveryOf(mp3.uri).id}` } });
  assert.equal(deliveryOf(mp3.uri).kind, 'audio');
});

test('one uri returned twice is delivered once; a uri the reply already names is not appended again', async () => {
  tg.length = 0;
  const a = await put('\x89PNG a', 'a.png', 'image/png');
  const b = await put('PDF b', 'b.pdf', 'application/pdf');
  script = async (call) => {
    quickResult = returning(linkOf(a));
    await call('__platform__', 'test_image_generate', {});
    quickResult = returning(linkOf(a), linkOf(b));
    await call('__platform__', 'test_image_generate', {});
    return `The report is ${b.uri}.`;
  };
  await sendTg('both please');
  assert.deepEqual(tg.map((o) => o.method), ['sendPhoto'], 'the picture is the preview; the pdf is link only');
  assert.equal(tg[0].caption, `The report is ${b.uri}.`);
  assert.equal(vistaButton(tg[0].options.reply_markup).text, '📁 Open in Vista (2 files)');
  const da = deliveryOf(a.uri);
  const db = deliveryOf(b.uri);
  assert.equal(da.batch, db.batch, 'one delivery batch');
  assert.equal(vistaButton(tg[0].options.reply_markup).web_app.url, `${VISTA}?file=${da.id}`);
  assert.equal(horstDeliveries.list().files.filter((d) => d.uri === a.uri).length, 1);
  const msg = lastAssistant(`tg${CHAT}`);
  assert.deepEqual(msg.files.map((f) => f.uri), [a.uri, b.uri]);
  assert.equal(msg.text.split(b.uri).length - 1, 1, 'b named once');
  assert.equal(msg.text.split(a.uri).length - 1, 1, 'a appended once');
  assert.match(msg.text, /\n\nFiles:\n- a\.png \(image\/png, \d+ B\): vc-artifact:\/\/\S+$/);
});

test('a long reply with a picture: the text first with its buttons, then the preview with the Vista button', async () => {
  tg.length = 0;
  const png = await put('\x89PNG long', 'long.png', 'image/png');
  quickResult = returning(linkOf(png));
  const long = 'x'.repeat(1500);
  script = async (call) => { await call('__platform__', 'test_image_generate', {}); return long; };
  await sendTg('a long one');
  assert.deepEqual(tg.map((o) => o.method), ['sendMessage', 'sendPhoto']);
  assert.equal(tg[0].text, long);
  assert.equal(tg[1].caption, '🖼 long.png');
  assert.equal(vistaButton(tg[1].options.reply_markup).web_app.url, `${VISTA}?file=${deliveryOf(png.uri).id}`);
});

test('no double delivery: an approved job run and a horst_job_status call collect nothing for the turn', async () => {
  const film = await put('mp4', 'film.mp4', 'video/mp4');
  jobResult = returning(linkOf(film));
  const sessionTag = 'horst-chat:test-nodouble';
  const release = appTools.bindHorstTurn(sessionTag, { conversationId: 'ui-nodouble', surface: 'ui' });
  const caller = { type: 'platform', sessionTag };
  try {
    const r = await appTools.callAppToolHandler('pic-app', 'render_film', {}, caller, { approved: true, wait: Infinity });
    assert.equal(r.content[1].uri, film.uri, 'the job ran inline');
    assert.deepEqual(appTools.horstTurnFiles(sessionTag), [], 'an approved job delivers through its outcome only');
    const jobId = jobs.list('owner').find((j) => j.caller && j.caller.type === 'horst' && j.tool === 'render_film').id;
    const status = await appTools.callAppToolHandler('__platform__', 'horst_job_status', { jobId }, caller);
    assert.ok(status.content.every((c) => c.type === 'text'), 'status answers in text');
    assert.ok(status.content[0].text.includes(film.uri));
    assert.deepEqual(appTools.horstTurnFiles(sessionTag), [], 'a status call does not re-deliver');
    // A quick tool in the same turn is collected; the release drops the list.
    quickResult = returning(linkOf(film));
    await appTools.callAppToolHandler('__platform__', 'test_image_generate', {}, caller);
    assert.deepEqual(appTools.horstTurnFiles(sessionTag).map((l) => l.uri), [film.uri]);
  } finally { release(); }
  assert.deepEqual(appTools.horstTurnFiles(sessionTag), []);
  // An unbound platform caller collects nothing.
  await appTools.callAppToolHandler('__platform__', 'test_image_generate', {}, caller);
  assert.deepEqual(appTools.horstTurnFiles(sessionTag), []);
});

test('a Horst tab turn appends the file to the message and sends nothing to Telegram', async () => {
  tg.length = 0;
  const png = await put('\x89PNG dog', 'dog.png', 'image/png');
  quickResult = returning(linkOf(png));
  script = async (call) => { await call('__platform__', 'test_image_generate', {}); return 'A dog.'; };
  const routes = {};
  const router = new Proxy({}, { get: (_, method) => (p, ...h) => { routes[`${method} ${p}`] = h.at(-1); } });
  platformHorst.mountApi(router);
  let body = null;
  const res = { status() { return this; }, json(v) { body = v; } };
  await routes['post /pro/horst/api/chat']({ body: { text: 'draw a dog' } }, res);
  const id = body.conversationId;
  const t0 = Date.now();
  while (lastAssistant(id).status === 'thinking') {
    if (Date.now() - t0 > 3000) throw new Error('turn did not finish');
    await new Promise((r) => setTimeout(r, 10));
  }
  const msg = lastAssistant(id);
  assert.match(msg.text, /^A dog\.\n\nFiles:\n- dog\.png \(image\/png, \d+ B\): /);
  assert.ok(msg.text.includes(png.uri));
  assert.deepEqual(msg.files.map((f) => f.uri), [png.uri]);
  assert.deepEqual(tg, []);
  assert.equal(deliveryOf(png.uri).conversationId, id, 'a tab turn delivers to Files too');
});
