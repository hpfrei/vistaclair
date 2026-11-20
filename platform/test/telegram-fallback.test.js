// Webhook → long-poll fallback (telegram.js delivery monitor). What must hold:
// a healthy webhook stays a webhook; a dead public URL (tunnel down) or
// Telegram-reported delivery errors delete the webhook WITHOUT dropping
// pending updates and switch the bot to long-poll; once the URL answers again
// the poll loop is stopped and the webhook re-registered; a boot with a dead
// public URL polls; getUpdates never runs while a webhook is registered.
// Real telegram.js over a temp config; fetch is a fake Bot API + fake tunnel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const telegram = require('../src/apps/telegram');

const PUBLIC = 'https://vc.example.ngrok.app';
const APP = 'my-gym';
const TOKEN = 'tok-gym';
const hookUrl = (app = APP) => `${PUBLIC}/pro/telegram/${app}/webhook`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tgfallback-'));
const cfgPath = path.join(dir, '.telegram.enc');
const secretStore = {
  readSecretFile: (p, _d, { fallback }) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } },
  writeSecretFile: (p, obj) => fs.writeFileSync(p, JSON.stringify(obj)),
};

// --- fake Telegram (one bot per token) + fake tunnel ---------------------------
let bots;          // token → { webhookUrl, queue: [update], info: {}, waiters: [] }
let calls;         // [{ token, method, params, webhookUrl }]
let tunnel;        // 'up' | 'down' | 'ngrok-404'
let delivered;     // updates dispatched (via the broadcaster)
let nextUpdate = 1000;

function botState(token) {
  if (!bots.has(token)) bots.set(token, { webhookUrl: '', queue: [], info: {}, waiters: [] });
  return bots.get(token);
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

async function fakeFetch(url, opts = {}) {
  url = String(url);
  const api = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
  if (!api) {
    // The tunnel probe.
    if (tunnel === 'down') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (tunnel === 'ngrok-404') return new Response('ERR_NGROK_3200', { status: 404 });
    assert.equal(opts.headers?.['x-telegram-bot-api-secret-token'], undefined, 'the probe never carries the secret');
    return new Response('', { status: 403 });
  }
  const [, token, method] = api;
  const params = JSON.parse(opts.body || '{}');
  const b = botState(token);
  calls.push({ token, method, params, webhookUrl: b.webhookUrl });
  switch (method) {
    case 'getWebhookInfo':
      return json({ ok: true, result: { url: b.webhookUrl, pending_update_count: b.queue.length, ...b.info } });
    case 'deleteWebhook':
      b.webhookUrl = '';
      if (params.drop_pending_updates) b.queue.length = 0;
      return json({ ok: true, result: true });
    case 'setWebhook':
      b.webhookUrl = params.url;
      b.info = {};
      for (const w of b.waiters.splice(0)) w();
      return json({ ok: true, result: true });
    case 'getUpdates': {
      if (b.webhookUrl) return json({ ok: false, error_code: 409, description: 'Conflict: can\'t use getUpdates method while webhook is active' });
      b.queue = b.queue.filter((u) => u.update_id >= (params.offset || 0));
      if (!b.queue.length && params.timeout > 0) {
        // Long-poll: wait for an update, a setWebhook, or the abort.
        await new Promise((resolve, reject) => {
          const sig = opts.signal;
          if (sig?.aborted) return reject(abortError());
          b.waiters.push(resolve);
          sig?.addEventListener('abort', () => reject(abortError()), { once: true });
        });
        if (b.webhookUrl) return json({ ok: false, error_code: 409, description: 'Conflict: terminated by setWebhook request' });
      }
      return json({ ok: true, result: b.queue.slice() });
    }
    default:
      return json({ ok: true, result: true });
  }
}

// Telegram receives a message for the bot: queued (pending) until consumed.
function incoming(token, text) {
  const b = botState(token);
  const u = { update_id: nextUpdate++, message: { message_id: nextUpdate, chat: { id: 111, type: 'private' }, from: { id: 111 }, text } };
  b.queue.push(u);
  for (const w of b.waiters.splice(0)) w();
  return u;
}

const until = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 30));
const methods = (token = TOKEN) => calls.filter((c) => c.token === token).map((c) => c.method);
const pollsWhileWebhook = () => calls.filter((c) => c.method === 'getUpdates' && c.webhookUrl);

const realFetch = globalThis.fetch;
const warn = console.warn;
const log = console.log;

// A fresh world: config on disk, telegram.js re-initialised, fake Telegram.
function world({ publicUrl = PUBLIC, apps = { [APP]: { token: TOKEN, mode: 'webhook' } }, registered = true } = {}) {
  telegram.shutdown();
  bots = new Map();
  calls = [];
  delivered = [];
  tunnel = 'up';
  const cfgApps = {};
  for (const [name, a] of Object.entries(apps)) {
    cfgApps[name] = { botId: 1, botUsername: `${name}_bot`, offset: 0, restricted: false, allowedChatIds: [], webhookSecret: 's', addedAt: 1, ...a };
    if (registered && a.mode === 'webhook') botState(a.token).webhookUrl = hookUrl(name);
  }
  fs.writeFileSync(cfgPath, JSON.stringify({ publicUrl, apps: cfgApps }));
  telegram.init(dir, secretStore, {
    broadcast(m) { if (m.type === 'app:bridge:event' && m.event === 'telegram:update') delivered.push(m.data.update_id); },
  });
}

test.before(() => { globalThis.fetch = fakeFetch; console.warn = () => {}; console.log = () => {}; });
test.after(() => { telegram.shutdown(); globalThis.fetch = realFetch; console.warn = warn; console.log = log; });
test.afterEach(async () => { telegram.shutdown(); await settle(); });

test('a healthy webhook stays a webhook: no deleteWebhook, no polling', async () => {
  world();
  telegram.start();
  await telegram.checkDelivery();
  await telegram.checkDelivery();
  const st = telegram.status(APP);
  assert.equal(st.mode, 'webhook');
  assert.equal(st.inbound, 'webhook');
  assert.equal(st.fallback, null);
  assert.ok(!methods().includes('deleteWebhook'));
  assert.ok(!methods().includes('getUpdates'));
  assert.ok(!methods().includes('setWebhook'), 'a correctly registered webhook is not re-registered');
  assert.equal(botState(TOKEN).webhookUrl, hookUrl());
});

test('tunnel down: deleteWebhook (pending kept), then long-poll delivers the queued message', async () => {
  world();
  const queued = incoming(TOKEN, 'sent while the tunnel was down');
  tunnel = 'down';
  telegram.start();
  await telegram.checkDelivery();
  const del = calls.find((c) => c.method === 'deleteWebhook');
  assert.ok(del, 'webhook deleted');
  assert.notEqual(del.params.drop_pending_updates, true, 'pending updates are never dropped');
  const firstPoll = calls.findIndex((c) => c.method === 'getUpdates');
  assert.ok(firstPoll > calls.indexOf(del), 'polling starts only after deleteWebhook');
  await until(() => delivered.includes(queued.update_id));
  const st = telegram.status(APP);
  assert.equal(st.mode, 'webhook', 'configured mode stays webhook');
  assert.equal(st.inbound, 'poll');
  assert.match(st.fallback.reason, /unreachable/);
  assert.ok(telegram.listBots().find((b) => b.appName === APP).fallback);
  // A new message arrives within the long-poll, no tunnel needed.
  const live = incoming(TOKEN, 'hello');
  await until(() => delivered.includes(live.update_id));
  assert.deepEqual(pollsWhileWebhook(), []);
});

test('an ngrok "endpoint offline" page counts as down', async () => {
  world();
  tunnel = 'ngrok-404';
  telegram.start();
  await telegram.checkDelivery();
  assert.equal(telegram.status(APP).inbound, 'poll');
  assert.match(telegram.status(APP).fallback.reason, /HTTP 404/);
});

test('Telegram-reported delivery errors fall back even when the probe passes', async () => {
  world();
  incoming(TOKEN, 'stuck');
  botState(TOKEN).info = { last_error_date: Math.floor(Date.now() / 1000) - 5, last_error_message: 'Connection timed out' };
  telegram.start();
  await telegram.checkDelivery();
  assert.equal(telegram.status(APP).inbound, 'poll');
  assert.match(telegram.status(APP).fallback.reason, /Connection timed out/);
  // Held on poll for a while: the next check does not flip straight back.
  await telegram.checkDelivery();
  assert.equal(telegram.status(APP).inbound, 'poll');
  assert.ok(!methods().includes('setWebhook'));
});

test('an old delivery error with nothing pending is not a failure', async () => {
  world();
  botState(TOKEN).info = { last_error_date: Math.floor(Date.now() / 1000) - 5, last_error_message: 'old' };
  telegram.start();
  await telegram.checkDelivery();
  assert.equal(telegram.status(APP).inbound, 'webhook');
});

test('recovery: the poll loop stops, its offset is confirmed, then the webhook is re-registered', async () => {
  world();
  tunnel = 'down';
  telegram.start();
  await telegram.checkDelivery();
  const a = incoming(TOKEN, 'during the outage');
  await until(() => delivered.includes(a.update_id));
  tunnel = 'up';
  const before = calls.length;
  await telegram.checkDelivery();
  const after = calls.slice(before);
  const setIdx = after.findIndex((c) => c.method === 'setWebhook');
  assert.ok(setIdx >= 0, 'webhook re-registered');
  assert.equal(after[setIdx].params.url, hookUrl());
  // The offset reached while polling is confirmed before the webhook takes over.
  const confirm = after.slice(0, setIdx).filter((c) => c.method === 'getUpdates' && c.params.timeout === 0);
  assert.ok(confirm.length >= 1);
  assert.equal(confirm[0].params.offset, a.update_id + 1);
  await settle();
  assert.ok(!after.slice(setIdx + 1).some((c) => c.method === 'getUpdates'), 'no getUpdates after setWebhook');
  const st = telegram.status(APP);
  assert.equal(st.inbound, 'webhook');
  assert.equal(st.fallback, null);
  // Later traffic goes to the webhook (stays queued here), never to a poll.
  incoming(TOKEN, 'after recovery');
  await settle();
  assert.deepEqual(pollsWhileWebhook(), []);
  assert.equal(delivered.length, 1, 'nothing delivered twice');
});

test('boot with a dead public URL comes up polling', async () => {
  world();
  const queued = incoming(TOKEN, 'sent before the boot');
  tunnel = 'down';
  telegram.start();             // the first check runs at start, no interval wait
  await until(() => delivered.includes(queued.update_id));
  assert.equal(telegram.status(APP).inbound, 'poll');
  assert.deepEqual(pollsWhileWebhook(), []);
});

test('the control bot falls back the same way', async () => {
  world({ apps: { __platform__: { token: 'tok-ctl', mode: 'webhook' } } });
  tunnel = 'down';
  telegram.start();
  await telegram.checkDelivery();
  assert.equal(telegram.status('__platform__').inbound, 'poll');
  const m = incoming('tok-ctl', '/status');
  await until(() => delivered.includes(m.update_id));
});

test('a bot another process owns is never touched', async () => {
  world({ apps: { [APP]: { token: TOKEN, mode: 'webhook' }, other: { token: 'tok-other', mode: 'webhook' } } });
  tunnel = 'down';
  telegram.start((n) => n === APP);
  await telegram.checkDelivery();
  assert.equal(telegram.status(APP).inbound, 'poll');
  assert.deepEqual(methods('tok-other'), []);
  assert.equal(telegram.status('other').inbound, 'webhook');
});

test('the reserved __platform__ key never aborts the delivery check or the poll sync', async () => {
  const { runsInDashboardProcess } = require('../src/apps/app-manager');
  assert.equal(runsInDashboardProcess('__platform__'), true);
  // `strict` stands in for readManifest → appDir, which throws on a name that
  // is not an app name; the real filter answers before reaching it.
  const strict = (n) => { if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) throw new Error(`Invalid app name: "${n}"`); return true; };
  world({ apps: { __platform__: { token: 'tok-platform', mode: 'webhook' }, [APP]: { token: TOKEN, mode: 'webhook' } } });
  tunnel = 'down';
  telegram.start((n) => (n === '__platform__' ? runsInDashboardProcess(n) : strict(n)));
  assert.doesNotThrow(() => telegram.syncPolling());
  await telegram.checkDelivery();
  assert.equal(telegram.status(APP).inbound, 'poll', 'the app bot is still checked and falls back');
  assert.ok(methods().includes('deleteWebhook'));
  assert.equal(telegram.status('__platform__').inbound, 'poll', 'the platform bot is handled by this process');
});

test('a failed deleteWebhook never starts polling', async () => {
  world();
  tunnel = 'down';
  globalThis.fetch = async (url, opts) => (/deleteWebhook$/.test(String(url)) ? json({ ok: false, description: 'Too Many Requests' }) : fakeFetch(url, opts));
  try {
    telegram.start();
    await telegram.checkDelivery();
    await settle();
  } finally { globalThis.fetch = fakeFetch; }
  assert.equal(telegram.status(APP).inbound, 'webhook');
  assert.ok(!methods().includes('getUpdates'));
});

test('an unregistered webhook is registered again when the URL answers', async () => {
  world({ registered: false });
  telegram.start();
  await telegram.checkDelivery();
  assert.equal(botState(TOKEN).webhookUrl, hookUrl());
  assert.equal(telegram.status(APP).inbound, 'webhook');
});

test('no public URL: poll bots stay on poll, no probe, no getWebhookInfo', async () => {
  world({ publicUrl: '', apps: { [APP]: { token: TOKEN, mode: 'poll' } } });
  telegram.start();
  await telegram.checkDelivery();
  assert.ok(!methods().includes('getWebhookInfo'));
  const m = incoming(TOKEN, 'hi');
  await until(() => delivered.includes(m.update_id));
  assert.equal(telegram.status(APP).inbound, 'poll');
});

// --- status fields, check-now (the dashboard chip), Horst's telegram_status ---

test('status carries the last check: OK while healthy, the reason while down', async () => {
  world();
  telegram.start();
  await telegram.checkDelivery();
  let st = telegram.status(APP);
  assert.equal(st.monitored, true);
  assert.equal(st.lastCheck.ok, true);
  assert.ok(Date.now() - st.lastCheck.at < 5000);
  tunnel = 'down';
  await telegram.checkDelivery();
  st = telegram.status(APP);
  assert.equal(st.lastCheck.ok, false);
  assert.match(st.lastCheck.reason, /unreachable/);
  assert.equal(st.fallback.reason, st.lastCheck.reason);
});

test('checkNow runs the monitor for that one bot and returns its fresh status', async () => {
  world({ apps: { [APP]: { token: TOKEN, mode: 'webhook' }, second: { token: 'tok-2', mode: 'webhook' } } });
  botState('tok-2').webhookUrl = hookUrl('second');
  telegram.start();
  await telegram.checkDelivery();
  calls.length = 0;
  tunnel = 'down';
  const r = await telegram.checkNow(APP);
  assert.equal(r.ok, true);
  assert.equal(r.status.inbound, 'poll');
  assert.match(r.status.fallback.reason, /unreachable/);
  assert.deepEqual(methods('tok-2'), [], 'only the asked-for bot is checked');
  assert.equal(telegram.status('second').inbound, 'webhook');
  // Back up: the next check-now recovers it.
  tunnel = 'up';
  const back = await telegram.checkNow(APP);
  assert.equal(back.status.inbound, 'webhook');
  assert.equal(back.status.fallback, null);
  assert.equal(back.status.lastCheck.ok, true);
  assert.deepEqual(pollsWhileWebhook(), []);
});

test('checkNow joins a running check instead of doubling it', async () => {
  world();
  telegram.start();             // start's own check is in flight
  const r = await telegram.checkNow(APP);
  assert.equal(r.ok, true);
  assert.equal(methods().filter((m) => m === 'getWebhookInfo').length, 2, 'start check + the asked check, run one after the other');
});

test('checkNow refuses a bot another process consumes, and an unknown bot', async () => {
  world({ apps: { [APP]: { token: TOKEN, mode: 'webhook' }, other: { token: 'tok-other', mode: 'webhook' } } });
  telegram.start((n) => n === APP);
  const r = await telegram.checkNow('other');
  assert.equal(r.ok, false);
  assert.match(r.error, /own process/);
  assert.equal(r.status.monitored, false);
  assert.deepEqual(methods('tok-other'), []);
  assert.equal((await telegram.checkNow('nope')).ok, false);
});

test('Horst telegram_status reports inbound, fallback and the last check', async () => {
  world();
  tunnel = 'down';
  telegram.start();
  await telegram.checkDelivery();
  const cap = require('../src/apps/capabilities/telegram');
  const tool = cap.horst.tools.find((t) => t.def.name === 'telegram_status');
  const out = JSON.parse((await tool.handler({})).content[0].text);
  const bot = out.bots.find((b) => b.app === APP);
  assert.equal(bot.mode, 'webhook');
  assert.equal(bot.inbound, 'poll');
  assert.match(bot.fallback.reason, /unreachable/);
  assert.equal(bot.lastCheck.ok, false);
  assert.ok(!Number.isNaN(Date.parse(bot.lastCheck.at)));
  assert.equal(out.publicUrlConfigured, true);
  assert.ok(!JSON.stringify(out).includes(TOKEN), 'never a token');
});

test('checkNow always answers in time: a slow check returns the status so far, pending', async () => {
  world();
  telegram.start();
  await telegram.checkDelivery();
  // The probe hangs (a dead host that never resets the connection) until released.
  let release;
  const hung = new Promise((r) => { release = r; });
  globalThis.fetch = async (url, opts) => {
    if (!/api\.telegram\.org/.test(String(url))) { await hung; tunnel = 'down'; }
    return fakeFetch(url, opts);
  };
  try {
    const t0 = Date.now();
    const r = await telegram.checkNow(APP, { maxMs: 60 });
    assert.ok(Date.now() - t0 < 1000, 'answered without waiting for the check');
    assert.equal(r.ok, true);
    assert.equal(r.pending, true);
    assert.equal(r.status.inbound, 'webhook', 'the status so far');
    // The check goes on and its outcome still lands.
    release();
    await telegram.checkDelivery();
    assert.equal(telegram.status(APP).inbound, 'poll');
  } finally { globalThis.fetch = fakeFetch; }
});

test('checkNow on a quick check carries no pending flag', async () => {
  world();
  telegram.start();
  const r = await telegram.checkNow(APP);
  assert.equal(r.ok, true);
  assert.equal(r.pending, undefined);
});
