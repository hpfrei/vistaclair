// Capability senses fire from their service hooks: with a recording publish
// wired in, the real services (cron, jobs, spawn, AI observer, sysmon tracker,
// mail sync status) produce exactly the declared kinds.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const capabilities = require('../src/apps/capabilities');
const appManager = require('../src/apps/app-manager');

const appsDir = makeAppsDir({ 's-app': {} });
appManager.setAppsDir(appsDir);
const published = [];
const dispose = capabilities.wireHorstSenses({
  publish: (kind, payload, opts) => { published.push({ kind, payload, opts }); return Promise.resolve({ ok: true }); },
});
test.after(() => {
  dispose();
  try { require('../src/apps/platform-cron').shutdown(); } catch {}
  fs.rmSync(appsDir, { recursive: true, force: true });
});

const ofKind = (k) => published.filter((p) => p.kind === k);
const tick = () => new Promise((r) => setTimeout(r, 30));
function quiet(fn) {
  const oe = console.error; const ow = console.warn;
  console.error = () => {}; console.warn = () => {};
  return Promise.resolve().then(fn).finally(() => { console.error = oe; console.warn = ow; });
}

test('cron: a failing job publishes cron:failed each run and cron:failing once at a streak of 3', async () => {
  const cron = require('../src/apps/platform-cron');
  cron.init({ appsDir });
  const { jobId } = cron.addJob({ name: 'always-fails', schedule: '0 0 1 1 *', target: { type: 'shell', command: 'exit 7' }, appName: 's-app' });
  for (let i = 0; i < 4; i++) await cron.runNow(jobId);
  const failed = ofKind('cron:failed');
  assert.equal(failed.length, 4);
  assert.equal(failed[0].payload.jobId, jobId);
  assert.equal(failed[0].payload.app, 's-app');
  assert.equal(failed[0].opts.dedupeKey, `cron:${jobId}`);
  assert.deepEqual(failed.map((f) => f.payload.streak), [1, 2, 3, 4]);
  assert.equal(ofKind('cron:failing').length, 1);
  cron.removeJob(jobId);
});

test('jobs: a rejecting run publishes job:failed with the app and error', async () => {
  const appJobs = require('../src/apps/app-jobs');
  appJobs.init({ appsDir, broadcaster: { broadcast() {} } });
  await quiet(async () => {
    const { id } = appJobs.startJob('s-app', { name: 'doomed', run: async () => { throw new Error('nope'); } });
    await tick();
    const ev = ofKind('job:failed');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].payload.app, 's-app');
    assert.equal(ev[0].payload.jobId, id);
    assert.equal(ev[0].payload.error, 'nope');
    appJobs.startJob('s-app', { name: 'fine', run: async () => 'ok' });
    await tick();
    assert.equal(ofKind('job:failed').length, 1, 'a successful job publishes nothing');
  });
});

test('exec: a spawn exiting non-zero publishes spawn:failed; a deliberate kill does not', async () => {
  const spawnManager = require('../src/apps/spawn-manager');
  const app = { name: 's-app', dir: appsDir };
  spawnManager.spawn(app, { command: 'exit 3' }, () => {});
  await new Promise((r) => setTimeout(r, 300));
  const ev = ofKind('spawn:failed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.code, 3);
  assert.equal(ev[0].payload.app, 's-app');
  const { spawnId } = spawnManager.spawn(app, { command: 'sleep 5' }, () => {});
  spawnManager.kill(spawnId);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(ofKind('spawn:failed').length, 1, 'killed spawns are not failures');
});

test('ai: failures, one auth alert per process, and model substitutions', () => {
  const ai = require('../src/apps/ai-service');
  ai.notifyObservers({ type: 'failed', app: 's-app', model: 'sonnet', code: 1, auth: false, error: 'AI failed (code 1): boom' });
  ai.notifyObservers({ type: 'failed', app: 's-app', model: null, code: 1, auth: true, error: 'Claude is not authenticated.' });
  ai.notifyObservers({ type: 'failed', app: 's-app', model: null, code: 1, auth: true, error: 'Claude is not authenticated.' });
  ai.notifyObservers({ type: 'substituted', app: 's-app', deadModel: 'claude-3-old', replacement: 'claude-sonnet-5' });
  assert.equal(ofKind('ai:failed').length, 1);
  assert.equal(ofKind('ai:failed')[0].payload.model, 'sonnet');
  assert.equal(ofKind('ai:auth-required').length, 1);
  assert.equal(ofKind('ai:model-substituted').length, 1);
  assert.equal(ofKind('ai:model-substituted')[0].payload.replacement, 'claude-sonnet-5');
});

test('ai: a dead model an app called and a dead default each reach the owner (notify)', () => {
  const ai = require('../src/apps/ai-service');
  ai.notifyModelUnavailable('s-app', 'ai.tts', 'tts-9000', 'unknown');
  ai.notifyModelUnavailable('s-app', 'ai.tts', 'tts-9000', 'unknown');
  ai.notifyObservers({ type: 'default-missing', target: 'media.ai.image', label: 'Default image model', model: 'old-image', reason: 'missing', candidate: 'gemini-3.1-flash-image' });
  assert.deepEqual(ofKind('ai:model-unavailable').map((e) => [e.payload.app, e.payload.method, e.payload.model]), [['s-app', 'ai.tts', 'tts-9000']]);
  assert.match(ofKind('ai:default-missing')[0].opts.summary, /Default image model: "old-image" is missing — proposed gemini-3\.1-flash-image/);
  const policy = Object.fromEntries(capabilities.horstSenses().map((s) => [s.key, s.defaultPolicy]));
  for (const k of ['ai:model-substituted', 'ai:model-unavailable', 'ai:default-missing']) assert.equal(policy[k], 'notify', k);
});

test('sysmon: the pressure tracker reports one transition per state change', () => {
  const sysmon = require('../src/apps/platform-sysmon');
  const ok = { mem: { total: 100, available: 50 }, disk: { total: 100, free: 50 }, load1: 1, cpus: 4 };
  const lowMem = { ...ok, mem: { total: 100, available: 5 } };
  const highLoad = { ...ok, load1: 9 };
  const t = sysmon.pressureTracker();
  assert.equal(t.feed(ok), null);
  assert.equal(t.feed(lowMem).state, 'pressure');
  assert.equal(t.feed(lowMem), null, 'still under pressure: no repeat');
  assert.equal(t.feed(highLoad), null, 'a different reason while under pressure: no repeat');
  assert.equal(t.feed(ok).state, 'recovered');
  assert.equal(t.feed(ok), null);
  assert.deepEqual(sysmon.evaluatePressure(lowMem).map((r) => r.kind), ['memory']);
  assert.deepEqual(sysmon.evaluatePressure({ ...lowMem, disk: { total: 100, free: 1 } }).map((r) => r.kind), ['memory', 'disk']);
});

test('sysmon: watchPressure drives the sense on its own clock', async () => {
  const sysmon = require('../src/apps/platform-sysmon');
  const samples = [
    { mem: { total: 100, available: 5 }, disk: { total: 100, free: 50 }, load1: 1, cpus: 4 },
    { mem: { total: 100, available: 5 }, disk: { total: 100, free: 50 }, load1: 1, cpus: 4 },
    { mem: { total: 100, available: 50 }, disk: { total: 100, free: 50 }, load1: 1, cpus: 4 },
  ];
  const changes = [];
  const stop = sysmon.watchPressure({ intervalMs: 5, sampler: () => samples.shift() || samples[0] || { mem: { total: 100, available: 50 }, cpus: 4, load1: 0 }, onChange: (c) => changes.push(c.state) });
  await new Promise((r) => setTimeout(r, 80));
  stop();
  assert.deepEqual(changes, ['pressure', 'recovered']);
});

test('email: a sync blip inside the grace window publishes nothing', () => {
  const emailEngine = require('../src/apps/email-engine');
  emailEngine.dispatch('email:sync:status', { account: 'a@x', state: 'error', error: 'Failed to establish connection in required time' });
  emailEngine.dispatch('email:sync:status', { account: 'a@x', state: 'error', error: 'connect ECONNREFUSED 1.2.3.4:993' });
  emailEngine.dispatch('email:sync:status', { account: 'b@x', state: 'error', error: 'connect ECONNREFUSED 1.2.3.4:993' });
  emailEngine.dispatch('email:sync:status', { account: 'a@x', state: 'watching', error: null });
  emailEngine.dispatch('email:sync:status', { account: 'b@x', state: 'watching', error: null });
  assert.equal(ofKind('email:sync:failed').length, 0);
  assert.equal(ofKind('email:sync:recovered').length, 0);
});

test('email: syncAlertTracker reports a lasting failure once and its recovery once', async () => {
  const { syncAlertTracker } = require('../src/apps/email-engine');
  const seen = [];
  const t = syncAlertTracker({ graceMs: 20, onFailed: (f) => seen.push(['failed', f.account, f.error]), onRecovered: (r) => seen.push(['recovered', r.account]) });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  t.feed({ account: 'a@x', state: 'error', error: 'timeout' });
  t.feed({ account: 'a@x', state: 'idle' }); // a reconnect starting does not reset the clock
  t.feed({ account: 'a@x', state: 'error', error: 'refused' });
  await wait(50);
  assert.deepEqual(seen, [['failed', 'a@x', 'refused']], 'one report, carrying the latest error');
  t.feed({ account: 'a@x', state: 'error', error: 'timeout' });
  t.feed({ account: 'a@x', state: undefined }); // backfill progress only
  await wait(50);
  assert.equal(seen.length, 1, 'still failing: no repeat');
  t.feed({ account: 'a@x', state: 'watching' });
  t.feed({ account: 'a@x', state: 'watching' });
  assert.deepEqual(seen.at(-1), ['recovered', 'a@x']);
  assert.equal(seen.length, 2, 'one recovery');
  // A blip that heals inside the window, and an episode ended by disabling.
  t.feed({ account: 'a@x', state: 'error', error: 'timeout' });
  t.feed({ account: 'a@x', state: 'backfilling' });
  t.feed({ account: 'b@x', state: 'error', error: 'timeout' });
  t.feed({ account: 'b@x', state: 'disabled' });
  await wait(50);
  assert.equal(seen.length, 2);
  t.feed({ account: 'c@x', state: 'error', error: 'timeout' });
  t.dispose();
  await wait(50);
  assert.equal(seen.length, 2, 'dispose cancels a pending report');
});

test('calendar: a sync-discovered change is sensed; a change Horst just made is not', () => {
  const emailEngine = require('../src/apps/email-engine');
  // Made elsewhere and discovered by sync — this is the news.
  emailEngine.dispatch('calendar:changed', {
    account: 'a@x', calendarId: 'primary', eventIds: ['e1', 'e2'], action: 'sync', origin: { source: 'sync' },
  });
  // Writes made through this platform, by an approved proposal or an app. If
  // these published, Horst would sense his own actions coming back at him.
  for (const action of ['create', 'update', 'delete', 'move']) {
    emailEngine.dispatch('calendar:changed', {
      account: 'a@x', calendarId: 'primary', eventIds: ['e9'], action, origin: { source: 'bridge' },
    });
  }
  // A sync tick that found nothing is not an event.
  emailEngine.dispatch('calendar:changed', {
    account: 'a@x', calendarId: 'primary', eventIds: [], action: 'sync', origin: { source: 'sync' },
  });

  const ev = ofKind('calendar:changed');
  assert.equal(ev.length, 1, 'only the sync-discovered change with events in it');
  assert.deepEqual(ev[0].payload.eventIds, ['e1', 'e2']);
  assert.equal(ev[0].payload.count, 2);
  assert.equal(ev[0].opts.dedupeKey, 'calendar-changed:a@x:primary');
  assert.match(ev[0].opts.summary, /2 calendar events changed/);
});

test('every published kind was declared by its module (nothing leaks past the scope)', () => {
  const declared = new Set(capabilities.horstSenses().map((s) => s.key));
  for (const p of published) assert.ok(declared.has(p.kind), `${p.kind} is undeclared`);
  assert.ok(published.length >= 10);
});
