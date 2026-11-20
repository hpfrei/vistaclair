// Spend policy, ledger, context and gate: the admin's policy resolves by
// deployment mode, `unlimited` short-circuits before the ledger or identity,
// metered calls are ledgered wherever they entered, caps block (or are only
// recorded in observe mode), and LLM sessions are cut mid-run via the marker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const spendPolicy = require('../src/apps/spend-policy');
const spendLedger = require('../src/apps/spend-ledger');
const spendContext = require('../src/apps/spend-context');
const spendGate = require('../src/apps/spend-gate');
const deploymentMode = require('../src/apps/deployment-mode');
const capabilities = require('../src/apps/capabilities');

const appsDir = makeAppsDir({
  'sp-legacy': {},
  'sp-metered': { capabilities: { ai: true, audio: true }, spend: { local: 'unlimited', deployed: { preset: 'metered', caps: { app: { day: 50 }, principal: { day: 10 }, unattributed: { day: 0 } } } } },
  'sp-plain': { capabilities: { ai: true } },
  'sp-llm': { capabilities: { ai: true } },
  'sp-sub': { capabilities: { ai: true } },
  'sp-store': {},
});
appManager.setAppsDir(appsDir);
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-spend-'));
spendPolicy.init({ dataHome });
spendLedger.init({ dataHome });
let slave = false;
let apps = [];
deploymentMode.init({ hostConfig: { isSlave: () => slave }, appManager: { list: () => apps } });

test.after(() => {
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(dataHome, { recursive: true, force: true });
});

const setMode = (mode) => { spendPolicy.saveHost({ mode }); deploymentMode.invalidate(); };
const setEnforce = (v) => { spendPolicy.saveHost({ enforce: v }); deploymentMode.invalidate(); };

// --- policy ------------------------------------------------------------------

test('policy: mode defaults, manifest requests, admin wins, unlimited ignores stray caps', () => {
  const dLocal = spendPolicy.resolve('sp-plain', 'local', {});
  assert.equal(dLocal.preset, 'unlimited');
  assert.equal(dLocal.sources.profile, 'default');
  const dDep = spendPolicy.resolve('sp-plain', 'deployed', {});
  assert.equal(dDep.preset, 'metered');
  assert.equal(dDep.caps.unattributed.day, 0);

  const m = spendPolicy.resolve('sp-metered', 'deployed', appManager.readManifest('sp-metered'));
  assert.equal(m.sources.profile, 'manifest');
  assert.equal(m.caps.app.day, 50);
  assert.equal(m.caps.principal.day, 10);

  spendPolicy.set('sp-metered', { deployed: { preset: 'unlimited', caps: { app: { day: 1 } } } });
  const a = spendPolicy.resolve('sp-metered', 'deployed', appManager.readManifest('sp-metered'));
  assert.equal(a.sources.profile, 'admin');
  assert.equal(a.preset, 'unlimited');
  assert.equal(a.caps.app.day, 'unlimited', 'a preset is exactly its preset');
  assert.ok(spendPolicy.isUnlimited(a));
  spendPolicy.remove('sp-metered');
  assert.equal(spendPolicy.resolve('sp-metered', 'deployed', appManager.readManifest('sp-metered')).sources.profile, 'manifest');
});

test('policy: validation refuses garbage; migrate keeps existing apps unlimited and flags review', () => {
  assert.throws(() => spendPolicy.set('sp-plain', { local: { preset: 'nope' } }), /unknown preset/);
  assert.throws(() => spendPolicy.set('sp-plain', { local: { preset: 'custom', caps: { app: { day: -5 } } } }), /non-negative/);
  assert.throws(() => spendPolicy.set('../evil', { local: 'unlimited' }), /invalid app name/);
  const done = spendPolicy.migrate(['sp-legacy', 'sp-plain']);
  assert.deepEqual(done.sort(), ['sp-legacy', 'sp-plain']);
  assert.deepEqual(spendPolicy.migrate(['sp-legacy']), [], 'idempotent');
  const r = spendPolicy.resolve('sp-legacy', 'deployed', {});
  assert.equal(r.preset, 'unlimited');
  assert.ok(r.migrated);
  assert.equal(spendPolicy.loadHost().reviewNotice, true);
  spendPolicy.remove('sp-plain');
  spendPolicy.remove('sp-legacy');
});

test('deployment mode: auto-detected from host signals, admin override wins', () => {
  setMode('auto');
  assert.equal(deploymentMode.detect().mode, 'local');
  apps = [{ name: 'x', auth: { telegram: true } }];
  deploymentMode.invalidate();
  assert.equal(deploymentMode.detect().mode, 'local', 'a users-level app (login required) is not a deployment signal');
  apps = [{ name: 'x', public: true }];
  deploymentMode.invalidate();
  assert.equal(deploymentMode.detect().mode, 'deployed');
  assert.match(deploymentMode.detect().reason, /open/);
  apps = [{ name: 'x', domain: 'x.example' }];
  deploymentMode.invalidate();
  assert.equal(deploymentMode.detect().mode, 'deployed');
  apps = [];
  slave = true; deploymentMode.invalidate();
  assert.equal(deploymentMode.detect().mode, 'deployed');
  slave = false;
  setMode('deployed');
  assert.equal(deploymentMode.detect().override, 'deployed');
  setMode('auto');
  assert.equal(deploymentMode.detect().mode, 'local');
});

// --- registry metadata ---------------------------------------------------------

test('registry: metered capabilities declare spend metadata; free ones default', () => {
  const ai = capabilities.get('ai');
  assert.equal(ai.cost, 'metered');
  assert.deepEqual([...ai.audiences], ['owner', 'user']);
  assert.equal(ai.spend.service, 'ai-service');
  assert.equal(capabilities.get('fs').cost, 'free');
  assert.deepEqual([...capabilities.get('fs').audiences], ['owner']);
  assert.equal(capabilities.get('http').cost, 'external');
  assert.equal(capabilities.get('spend').core, true);
  assert.equal(spendGate.classify('ai.transcribe').cost, 'metered');
  assert.equal(spendGate.classify('fs.read').cost, 'free');
});

// --- gate ---------------------------------------------------------------------

test('gate: unlimited short-circuits (no identity, no ledger); free methods never gate', () => {
  setMode('local');
  const r = spendGate.authorize('sp-plain', 'ai.prompt', { via: 'ctx' });
  assert.equal(r.unlimited, true);
  assert.equal(r.principal, null);
  const f = spendGate.authorize('sp-plain', 'fs.read', { via: 'ctx' });
  assert.equal(f.free, true);
  const s = spendGate.status('sp-plain', { principal: null });
  assert.equal(s.unlimited, true);
  assert.equal(s.preset, 'unlimited');
});

test('gate: deployed + metered: unattributed blocked, attributed principal spends to its cap, then E_NO_CREDITS', () => {
  setMode('deployed');
  setEnforce(true);
  const app = 'sp-metered';
  assert.throws(() => spendGate.authorize(app, 'ai.transcribe', { via: 'ctx' }), (e) => e.code === 'E_NO_CREDITS' && e.scope === 'unattributed');

  // 10 credits/day per principal, 1 credit per call at $0.001
  spendContext.run({ app, origin: 'route', principal: 'acct:7' }, () => {
    for (let i = 0; i < 10; i++) {
      const r = spendGate.authorize(app, 'ai.transcribe', { via: 'ctx' });
      assert.equal(r.principal, 'acct:7');
      spendGate.settle(app, 'ai.transcribe', { costUsd: 0.001, priced: true, units: 0.2 });
    }
    assert.throws(() => spendGate.authorize(app, 'ai.transcribe', { via: 'ctx' }), (e) => e.code === 'E_NO_CREDITS' && e.scope === 'principal');
    const st = spendGate.status(app);
    assert.equal(st.state.principal.day.spent, 10);
    assert.equal(st.state.principal.day.left, 0);
    assert.equal(st.state.app.day.left, 40);
  });
  // Another principal is unaffected; a meterKey attributes when nothing else does.
  spendContext.run({ app, origin: 'bot', principal: 'tg:99' }, () => {
    assert.equal(spendGate.authorize(app, 'ai.transcribe', { via: 'ctx' }).principal, 'tg:99');
  });
  assert.equal(spendGate.authorize(app, 'ai.prompt', { via: 'ctx', meterKey: 'k1' }).principal, 'meter:k1');
  const sum = spendLedger.summary(app, { days: 1 }, path.join(appsDir, app));
  assert.equal(sum.today.calls, 10);
  assert.equal(sum.byPrincipal['acct:7'].calls, 10);
  assert.equal(sum.byOrigin.route.calls, 10);
  assert.equal(sum.byMethod['ai.transcribe'].units > 1.9, true);
  assert.equal(sum.blocked.E_NO_CREDITS >= 2, true);
});

test('gate: observe mode records would-block decisions but refuses nothing', () => {
  setMode('deployed');
  setEnforce(false);
  const r = spendGate.authorize('sp-metered', 'ai.transcribe', { via: 'ctx' });
  assert.equal(r.ok, true);
  assert.equal(r.wouldBlock, 'E_NO_CREDITS');
  setEnforce(true);
});

test('gate: paused, revoked grant, rate limit, owner audience', () => {
  setMode('deployed');
  spendPolicy.set('sp-plain', { deployed: { preset: 'locked' } });
  assert.throws(() => spendGate.authorize('sp-plain', 'ai.prompt', { via: 'ctx', principal: 'acct:1' }), (e) => e.code === 'E_PAUSED');
  spendPolicy.set('sp-plain', { deployed: { preset: 'custom', grants: { ai: false }, caps: { principal: { day: 1000 } } } });
  assert.throws(() => spendGate.authorize('sp-plain', 'ai.prompt', { via: 'ctx', principal: 'acct:1' }), (e) => e.code === 'E_NOT_GRANTED');
  // A revocation holds under the unlimited preset and is never merely observed.
  spendPolicy.set('sp-plain', { deployed: { preset: 'unlimited', grants: { ai: false } } });
  assert.throws(() => spendGate.authorize('sp-plain', 'ai.prompt', { via: 'ctx', principal: 'acct:1' }), (e) => e.code === 'E_NOT_GRANTED');
  setEnforce(false);
  assert.throws(() => spendGate.authorize('sp-plain', 'ai.prompt', { via: 'ctx', principal: 'acct:1' }), (e) => e.code === 'E_NOT_GRANTED');
  setEnforce(true);
  assert.deepEqual([...spendPolicy.revokedCapabilities('sp-plain', 'deployed')], ['ai']);
  spendPolicy.set('sp-plain', { deployed: { preset: 'unlimited', grants: { db: false, email: false } } });
  assert.deepEqual([...spendPolicy.revokedCapabilities('sp-plain', 'deployed')], ['email'], 'only revocable modules count');
  // The Bridge's refusal, shared with the cli.* methods index.js dispatches itself.
  const { revocationError } = require('../src/apps/app-bridge');
  assert.match(revocationError('sp-plain', 'email.send'), /^E_NOT_GRANTED: email is revoked for this app/);
  assert.equal(revocationError('sp-plain', 'cli.workspace'), null, 'cli is never revocable');
  // seedOpenGrants keeps the preset and adds the owner-service revocations.
  const seeded = spendPolicy.seedOpenGrants('sp-plain', {});
  assert.ok(seeded.includes('telegram'));
  const eff = spendPolicy.resolve('sp-plain', 'deployed', {});
  assert.equal(eff.preset, 'unlimited');
  assert.equal(eff.grants.email, false);
  assert.equal(eff.grants.calendar, false);
  assert.equal(spendPolicy.resolve('sp-plain', 'local', {}).grants.telegram, false, 'seeded in both modes');
  spendPolicy.set('sp-plain', { deployed: { preset: 'custom', caps: { principal: { day: 1000 } }, rate: { principalPerMinute: 2 } } });
  spendGate.authorize('sp-plain', 'ai.prompt', { via: 'ctx', principal: 'acct:2' });
  spendGate.settle('sp-plain', 'ai.prompt', { costUsd: 0.0001, principal: 'acct:2' });
  spendGate.settle('sp-plain', 'ai.prompt', { costUsd: 0.0001, principal: 'acct:2' });
  assert.throws(() => spendGate.authorize('sp-plain', 'ai.prompt', { via: 'ctx', principal: 'acct:2' }), (e) => e.code === 'E_RATE_LIMIT');
  // The owner is never capped by principal caps.
  assert.equal(spendGate.authorize('sp-plain', 'ai.prompt', { via: 'ctx', principal: 'owner' }).ok, true);
  // A user-facing bridge caller can never reach an owner-only method.
  assert.throws(() => spendGate.authorize('sp-plain', 'exec', { via: 'user-bridge', principal: 'acct:1' }), (e) => e.code === 'E_NOT_EXPOSED');
  assert.equal(spendGate.authorize('sp-plain', 'ai.transcribe', { via: 'user-bridge', principal: 'acct:1' }).ok, true);
  spendPolicy.remove('sp-plain');
});

test('gate: LLM settle from the proxy broadcast lands on the registered principal; exhaustion writes the marker', () => {
  setMode('deployed');
  spendPolicy.set('sp-llm', { deployed: { preset: 'custom', caps: { app: { day: 10 }, principal: { day: 10 } } } });
  const id = 'app-sp-llm-ai-deadbeef';
  spendContext.registerInstance(id, { app: 'sp-llm', principal: 'acct:42', origin: 'route' });
  const usage = { input_tokens: 1000, output_tokens: 100 };
  const pricing = { inputCostPerMTok: 3, outputCostPerMTok: 15 };
  assert.equal(spendGate.settleInteraction({ instanceId: id, endpoint: '/v1/messages', usage, pricing }), true);
  const sum = spendLedger.summary('sp-llm', { days: 1 }, path.join(appsDir, 'sp-llm'));
  assert.equal(sum.byPrincipal['acct:42'].inTok, 1000);
  assert.ok(Math.abs(sum.byPrincipal['acct:42'].costUsd - 0.0045) < 1e-9);
  assert.ok(!fs.existsSync(spendGate.markerPath(id)), 'under cap: no marker');
  // Push over the 10-credit cap: the next proxy request would be refused.
  spendGate.settleInteraction({ instanceId: id, endpoint: '/v1/messages', usage: { input_tokens: 200000, output_tokens: 0 }, pricing });
  assert.ok(fs.existsSync(spendGate.markerPath(id)), 'over cap: marker written');
  assert.equal(JSON.parse(fs.readFileSync(spendGate.markerPath(id), 'utf8')).blocked, true);
  spendGate.clearMarker(id);
  spendContext.unregisterInstance(id);
  assert.ok(!fs.existsSync(spendGate.markerPath(id)));
  // A session registered in another process still resolves its app from the id.
  assert.equal(spendContext.appFromInstanceId('app-my-cool-app-ai-0badf00d'), 'my-cool-app');
  spendPolicy.remove('sp-llm');
});

test('gate: alerts fire once per day per bucket', () => {
  setMode('deployed');
  spendPolicy.set('sp-plain', { deployed: { preset: 'custom', caps: { app: { day: 3 }, principal: { day: 2 } } } });
  const seen = [];
  const off = spendGate.observe((ev) => seen.push(ev.type));
  spendGate.settle('sp-plain', 'ai.prompt', { costUsd: 0.0025, principal: 'acct:9' });
  spendGate.settle('sp-plain', 'ai.prompt', { costUsd: 0.0025, principal: 'acct:9' });
  off();
  assert.ok(seen.includes('exhausted'));
  assert.equal(seen.filter((t) => t === 'exhausted').length, 1);
  spendPolicy.remove('sp-plain');
});

// --- subscribers --------------------------------------------------------------

test('policy: subscriber modes validate; separate carries subscriber caps; default is count', () => {
  const p = spendPolicy.normalizeProfile({ preset: 'custom', caps: { app: { day: 20, subscribers: 'separate', subscriberDay: 100 }, principal: { day: 5, subscribers: 'exempt' } } });
  assert.equal(p.caps.app.subscribers, 'separate');
  assert.equal(p.caps.app.subscriberDay, 100);
  assert.equal(p.caps.app.subscriberMonth, 'unlimited');
  assert.equal(p.caps.principal.subscribers, 'exempt');
  assert.equal(spendPolicy.normalizeProfile('metered').caps.app.subscribers, 'count');
  assert.throws(() => spendPolicy.normalizeProfile({ preset: 'custom', caps: { app: { subscribers: 'sometimes' } } }), /subscribers must be one of/);
});

test('gate: separate pools — subscribers draw from subscriber caps, everyone else from the general pool', () => {
  setMode('deployed');
  setEnforce(true);
  const app = 'sp-sub';
  const dir = path.join(appsDir, app);
  spendPolicy.set(app, { deployed: { preset: 'custom', caps: {
    app: { day: 20, subscribers: 'separate', subscriberDay: 100 },
    principal: { day: 5, subscribers: 'separate', subscriberDay: 50 },
    unattributed: { day: 0 },
  } } });

  // Non-subscriber: generic per-user cap (5), general app pool (20).
  const ns = spendContext.run({ app, origin: 'route', principal: 'acct:1', subscribed: false },
    () => spendGate.authorize(app, 'ai.transcribe', { via: 'ctx' }));
  assert.equal(ns.subscribed, false);
  assert.equal(ns.state.source, 'principal');
  assert.equal(ns.state.pool, 'general');
  assert.equal(ns.state.principal.day.cap, 5);
  assert.equal(ns.state.app.day.cap, 20);

  // Subscriber: subscriber per-user cap (50) and subscriber app pool (100).
  spendContext.run({ app, origin: 'route', principal: 'acct:2', subscribed: true }, () => {
    const s = spendGate.authorize(app, 'ai.transcribe', { via: 'ctx' });
    assert.equal(s.subscribed, true);
    assert.equal(s.state.source, 'subscriber');
    assert.equal(s.state.pool, 'subscriber');
    assert.equal(s.state.principal.day.cap, 50);
    assert.equal(s.state.app.day.cap, 100);
    // Their spend lands in the ledger's subscriber slice.
    for (let i = 0; i < 6; i++) spendGate.settle(app, 'ai.transcribe', { costUsd: 0.001, priced: true, units: 1 });
  });
  assert.equal(spendLedger.spent(app, { scope: 'day', view: 'sub' }, dir).credits, 6);
  assert.equal(spendLedger.spent(app, { scope: 'day' }, dir).credits, 6);

  // Drain the GENERAL pool (20) with non-subscriber spend: non-subscribers are
  // now refused at the app scope, subscribers keep going on their own pool.
  spendContext.run({ app, origin: 'route', principal: 'acct:1', subscribed: false }, () => {
    for (let i = 0; i < 4; i++) spendGate.settle(app, 'ai.prompt', { costUsd: 0.005, priced: true, principal: `acct:${10 + i}`, subscribed: false });
    assert.throws(() => spendGate.authorize(app, 'ai.transcribe', { via: 'ctx' }), (e) => e.code === 'E_NO_CREDITS' && e.scope === 'app');
  });
  spendContext.run({ app, origin: 'route', principal: 'acct:2', subscribed: true }, () => {
    assert.equal(spendGate.authorize(app, 'ai.transcribe', { via: 'ctx' }).ok, true);
  });

  // Exempt: a subscribed principal bypasses the per-user cap outright.
  spendPolicy.set(app, { deployed: { preset: 'custom', caps: { principal: { day: 1, subscribers: 'exempt' }, unattributed: { day: 0 } } } });
  spendContext.run({ app, origin: 'route', principal: 'acct:2', subscribed: true }, () => {
    const r = spendGate.authorize(app, 'ai.transcribe', { via: 'ctx' });
    assert.equal(r.state.source, 'subscriber-exempt');
    assert.equal(r.state.principal.day.cap, 'unlimited');
  });
  spendContext.run({ app, origin: 'route', principal: 'acct:2', subscribed: false }, () => {
    assert.throws(() => spendGate.authorize(app, 'ai.transcribe', { via: 'ctx' }), (e) => e.code === 'E_NO_CREDITS');
  });
  spendPolicy.remove(app);
});

test('context: subscribed — owner always, licence cache for accounts, anonymous never', () => {
  assert.equal(spendContext.subscribed(), false, 'outside any context');
  spendContext.run({ app: 'sp-plain', principal: 'owner' }, () => assert.equal(spendContext.subscribed(), true));
  spendContext.run({ app: 'sp-plain', principal: 'acct:77' }, () => assert.equal(spendContext.subscribed(), false));
  spendContext.run({ app: 'sp-plain', principal: 'tg:5' }, () => assert.equal(spendContext.subscribed(), false));
  const appLicense = require('../src/apps/app-license');
  appLicense._internal.entCache.set('sp-plain:77', { ent: { licensed: true, status: 'active', tier: 'pro' }, freshUntil: Date.now() + 60000, lastGoodAt: Date.now(), inflight: null });
  assert.equal(appLicense.subscribedFromCache('sp-plain', 77), true);
  spendContext.run({ app: 'sp-plain', principal: 'acct:77' }, () => assert.equal(spendContext.subscribed(), true));
  // A freemium 'free' entitlement is licensed:false → not subscribed.
  appLicense._internal.entCache.set('sp-plain:78', { ent: { licensed: false, status: 'free', tier: 'free' }, freshUntil: Date.now() + 60000, lastGoodAt: 0, inflight: null });
  spendContext.run({ app: 'sp-plain', principal: 'acct:78' }, () => assert.equal(spendContext.subscribed(), false));
  appLicense._internal.entCache.delete('sp-plain:77');
  appLicense._internal.entCache.delete('sp-plain:78');
});

// --- storage ------------------------------------------------------------------

test('storage: deltas per day, grace window, breach pauses the app and emits once', () => {
  setMode('deployed');
  setEnforce(true);
  const app = 'sp-store';
  const dir = path.join(appsDir, app);
  const storageMeter = require('../src/apps/storage-meter');
  spendPolicy.set(app, { deployed: { preset: 'custom', storage: { dailyMB: 1 } } });

  const events = [];
  const off = spendGate.observe((e) => { if (e.type === 'storage-breach') events.push(e); });
  let r = storageMeter.check(app, 1000, dir); // baseline measurement
  assert.equal(r.deltaBytes, 0);
  assert.equal(r.over, false);
  r = storageMeter.check(app, 3e6, dir); // +~3 MB > 1 MB cap — first over
  assert.equal(r.over, true);
  assert.equal(r.overCount, 1);
  assert.equal(events.length, 0, 'grace window: one over-cap measurement is not a breach');
  r = storageMeter.check(app, 3e6, dir); // second consecutive → breach
  assert.equal(events.length, 1);
  assert.equal(events[0].paused, true);
  assert.equal(events[0].capMB, 1);
  const eff = spendPolicy.resolve(app, 'deployed', {});
  assert.equal(eff.paused, true, 'breach pauses the app in its admin policy');
  assert.equal(eff.sources.profile, 'admin');
  assert.throws(() => spendGate.authorize(app, 'ai.prompt', { via: 'ctx', principal: 'acct:1' }), (e) => e.code === 'E_PAUSED');
  storageMeter.check(app, 3.1e6, dir); // still over: no re-emit
  assert.equal(events.length, 1);
  off();

  const st = spendLedger.storageStatus(app, dir);
  assert.ok(st.deltaBytes > 2e6);
  assert.ok(st.measuredAt > 0);
  // Lifting the cap resets the breach counter.
  spendPolicy.set(app, { deployed: { preset: 'custom', storage: { dailyMB: 'unlimited' } } });
  storageMeter.check(app, 5e6, dir);
  assert.equal(spendLedger.storageStatus(app, dir).overCount, 0);
  spendPolicy.remove(app);
});

// --- context ------------------------------------------------------------------

test('context: route middleware resolves the principal lazily from the request; jobs inherit it', async () => {
  const mw = spendContext.middleware('sp-plain');
  let inner = null;
  await new Promise((resolve) => {
    mw({ account: { id: 5 }, headers: {}, query: {} }, {}, () => {
      // nested: a job started from this route keeps the account
      spendContext.run({ origin: 'job' }, () => {
        inner = { principal: spendContext.principal(), origin: spendContext.origin(), app: spendContext.app() };
      });
      resolve();
    });
  });
  assert.deepEqual(inner, { principal: 'acct:5', origin: 'job', app: 'sp-plain' });
  assert.equal(spendContext.principal(), null, 'outside any context');
  // bind() re-enters the request's context after a body parser dropped it.
  const req2 = { account: { id: 8 }, headers: {}, query: {} };
  mw(req2, {}, () => {});
  assert.equal(spendContext.principal(), null);
  assert.equal(spendContext.bind(req2, () => spendContext.principal()), 'acct:8');
  assert.equal(spendContext.bind({}, () => 'plain'), 'plain');
  assert.equal(spendContext.principalFromRequest('sp-plain', { headers: {}, query: {} }), null);
});

// --- ledger -------------------------------------------------------------------

test('ledger: legacy .ai-usage.json is imported once and ai.usage keeps its shape', () => {
  const appDir = path.join(appsDir, 'sp-legacy');
  const day = spendLedger.dayKey();
  fs.writeFileSync(path.join(appDir, '.ai-usage.json'), JSON.stringify({ v: 1, days: { [day]: { _app: { calls: 3, inTok: 300, outTok: 30, cacheTok: 0, costUsd: 0.03 }, 'acct:1': { calls: 1, inTok: 100, outTok: 10, cacheTok: 0, costUsd: 0.01 } } } }));
  const q = spendLedger.query(appDir, { days: 7 });
  assert.equal(q.calls, 3);
  assert.equal(q.inTok, 300);
  assert.ok(Math.abs(q.costUsd - 0.03) < 1e-9);
  const k = spendLedger.query(appDir, { days: 7, meterKey: 'acct:1' });
  assert.equal(k.calls, 1);
  assert.equal(k.meterKey, 'acct:1');
  // New writes land in the v2 file under dataHome, never in the app dir.
  spendLedger.record({ app: 'sp-legacy', appDir, method: 'ai.image', costUsd: 0.04, units: 1, principal: 'owner', origin: 'bridge' });
  spendLedger.flushAll();
  const v2 = JSON.parse(fs.readFileSync(path.join(dataHome, 'spend-ledger', 'sp-legacy.json'), 'utf8'));
  assert.equal(v2.v, 2);
  assert.equal(v2.days[day].methods['ai.image'].calls, 1);
  assert.equal(v2.days[day].principals.owner.units, 1);
  assert.equal(spendLedger.query(appDir, { days: 1 }).calls, 4);
});

test('ledger: unpriced calls are counted and flagged, never silently zero', () => {
  const spendPricing = require('../src/apps/spend-pricing');
  assert.equal(spendPricing.price('ai.nonexistent', null, 3).priced, false);
  assert.ok(Math.abs(spendPricing.price('ai.transcribe', 'gpt-4o-mini-transcribe', 2).costUsd - 0.006) < 1e-9);
  spendPolicy.saveHost({ unitPrices: { 'ai.transcribe': 0.01 } });
  assert.equal(spendPricing.rateFor('ai.transcribe', 'whisper-1').source, 'admin');
  assert.equal(spendPricing.rateFor('ai.transcribe', 'whisper-1').rate, 0.01);
  spendPolicy.saveHost({ unitPrices: {} });
  assert.ok(spendPricing.sheet().some((r) => r.method === 'ai.image' && r.unit === 'image'));
});

// --- the host budget (phase 8F, F-4) -----------------------------------------
//
// Horst's LLM calls already passed the gate under the `platform` pseudo-app;
// they were uncapped only because the host profile shipped `unlimited`. Giving
// it a real budget has one trap, and these tests exist to keep it shut: the
// heartbeat, the briefing and every cron job with no app run with
// `principal: null`, so a preset whose unattributed cap is zero refuses all of
// them the moment it is selected.

test('host: the default is a real budget, and platform spend is no longer unlimited', () => {
  const local = spendPolicy.resolveHost('local');
  assert.equal(local.preset, 'budgeted');
  assert.equal(spendPolicy.isUnlimited(local), false, 'unlimited returns before the ledger — the cap would never be read');
  assert.equal(local.caps.app.day, 2000);
  assert.ok(local.caps.unattributed.day > 0, 'work with no user to bill must still be allowed to run');
});

test('host: "metered" is refused — it would block every heartbeat', () => {
  assert.throws(() => spendPolicy.saveHost({ host: { local: { preset: 'metered' } } }), /no user to attribute/);
  assert.equal(spendPolicy.resolveHost('local').preset, 'budgeted', 'the refusal left the stored profile alone');
  for (const preset of spendPolicy.HOST_PRESETS) {
    spendPolicy.saveHost({ host: { local: { preset } } });
    assert.equal(spendPolicy.resolveHost('local').preset, preset);
  }
  spendPolicy.saveHost({ host: { local: { preset: 'budgeted' } } });
});

test('host: raising the budget raises the bucket unattributed work actually draws on', () => {
  spendPolicy.saveHost({ host: { local: { preset: 'budgeted', caps: { app: { day: 5000 } } } } });
  const p = spendPolicy.resolveHost('local');
  assert.equal(p.caps.app.day, 5000);
  assert.equal(p.caps.unattributed.day, 5000, 'or the admin sets 5000 and watches the heartbeat refused at 2000');
  spendPolicy.saveHost({ host: { local: { preset: 'budgeted' } } });
});

test('host: an unattributed platform call spends to the cap, then is refused and the owner is told', () => {
  setMode('local');
  spendPolicy.saveHost({ host: { local: { preset: 'budgeted', caps: { app: { day: 20, month: 1000 } } } } });
  const alerts = [];
  const off = spendGate.observe((ev) => alerts.push(ev));
  try {
    // No principal: this is the heartbeat's shape, not a user's.
    assert.equal(spendGate.authorize('platform', 'ai.prompt', { principal: null }).ok, true);
    spendGate.settle('platform', 'ai.prompt', { costUsd: 0.05, principal: null }); // 50 credits > 20
    assert.throws(() => spendGate.authorize('platform', 'ai.prompt', { principal: null }), (err) => err.code === 'E_NO_CREDITS');
    const ex = alerts.filter((a) => a.type === 'exhausted');
    assert.equal(ex.length, 1, 'one owner-facing alert, not one per refused call');
    assert.equal(ex[0].app, 'platform');
  } finally {
    off();
    spendPolicy.saveHost({ host: { local: { preset: 'budgeted' } } });
  }
});
