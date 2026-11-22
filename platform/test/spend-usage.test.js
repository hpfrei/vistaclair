// ai.usage / ctx.aiUsage: from/to windows, groupBy, apiUsd vs billedUsd, no age
// cutoff (month shards), old ledger files, bad params. Throwaway dataHome.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const spendLedger = require('../src/apps/spend-ledger');
const spendGate = require('../src/apps/spend-gate');

const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-usage-'));
const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-usage-apps-'));
spendLedger.init({ dataHome });
test.after(() => {
  fs.rmSync(dataHome, { recursive: true, force: true });
  fs.rmSync(appsDir, { recursive: true, force: true });
});

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} !== ${b}`);
const dayAgo = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
const T = (o) => ({ calls: 0, costUsd: 0, inTok: 0, outTok: 0, cacheTok: 0, units: 0, unpriced: 0, ...o });
const mkApp = (name) => { const d = path.join(appsDir, name); fs.mkdirSync(d, { recursive: true }); return d; };
// A pre-model-tracking v2 ledger file: totals and principals only, no `usage`.
function oldDay(calls, cost, principals) {
  return { total: T({ calls, costUsd: cost, inTok: calls * 100, outTok: calls * 10 }), sub: T({}), principals, origins: {}, methods: {}, blocked: {} };
}
const writeLedger = (app, days) => {
  fs.mkdirSync(path.join(dataHome, 'spend-ledger'), { recursive: true });
  fs.writeFileSync(path.join(dataHome, 'spend-ledger', `${app}.json`), JSON.stringify({ v: 2, days }));
};

test('legacy call: no new params returns the original fields, numerically the same', () => {
  const appDir = mkApp('u-legacy');
  const today = dayAgo(0);
  writeLedger('u-legacy', {
    [today]: oldDay(3, 0.03, { 'meter:a': T({ calls: 2, costUsd: 0.02, inTok: 200, outTok: 20 }), _app: T({ calls: 1, costUsd: 0.01, inTok: 100, outTok: 10 }) }),
    [dayAgo(2)]: oldDay(1, 0.5, { _app: T({ calls: 1, costUsd: 0.5, inTok: 100, outTok: 10 }) }),
  });
  const q = spendLedger.query(appDir, {});
  assert.equal(q.meterKey, null);
  assert.equal(q.days, 30);
  assert.equal(q.calls, 4);
  assert.equal(q.inTok, 400);
  assert.equal(q.outTok, 40);
  close(q.costUsd, 0.53);
  // superset
  assert.equal(q.from, dayAgo(29));
  assert.equal(q.to, today);
  close(q.billedUsd, 0.53);
  close(q.apiUsd, 0.53, 'pre-model days were recorded at list price');
  assert.deepEqual(Object.keys(q.total).sort(), ['apiUsd', 'billedUsd', 'cacheTok', 'calls', 'inTok', 'outTok', 'unpriced']);
  assert.equal(q.rows, undefined);
  const k = spendLedger.query(appDir, { meterKey: 'a', days: 7 });
  assert.equal(k.calls, 2);
  assert.equal(k.meterKey, 'a');
  assert.equal(k.days, 7);
  close(k.costUsd, 0.02);
  assert.equal(spendLedger.query(appDir, { days: 1 }).calls, 3);
});

test('from/to are inclusive UTC days; days ends at `to`', () => {
  const appDir = mkApp('u-range');
  writeLedger('u-range', {
    [dayAgo(5)]: oldDay(1, 1, { _app: T({ calls: 1, costUsd: 1 }) }),
    [dayAgo(4)]: oldDay(1, 2, { _app: T({ calls: 1, costUsd: 2 }) }),
    [dayAgo(3)]: oldDay(1, 4, { _app: T({ calls: 1, costUsd: 4 }) }),
    [dayAgo(2)]: oldDay(1, 8, { _app: T({ calls: 1, costUsd: 8 }) }),
  });
  const q = spendLedger.query(appDir, { from: dayAgo(4), to: dayAgo(3) });
  assert.equal(q.days, 2);
  assert.equal(q.calls, 2);
  close(q.costUsd, 6);
  close(q.apiUsd, 6);
  const one = spendLedger.query(appDir, { from: dayAgo(4), to: dayAgo(4) });
  assert.equal(one.days, 1);
  close(one.costUsd, 2);
  // `days` counted back from `to`; `from` wins over `days`
  const d = spendLedger.query(appDir, { to: dayAgo(3), days: 2 });
  assert.equal(d.from, dayAgo(4));
  close(d.costUsd, 6);
  close(spendLedger.query(appDir, { from: dayAgo(4), to: dayAgo(3), days: 99 }).costUsd, 6);
  // from alone runs to today
  close(spendLedger.query(appDir, { from: dayAgo(3) }).costUsd, 12);
});

test('record stores the model; groupBy day/model/meterKey combos are exact and sorted', () => {
  const appDir = mkApp('u-group');
  const base = { app: 'u-group', appDir, method: 'ai.prompt', origin: 'route', units: 1, priced: true };
  spendLedger.record({ ...base, principal: 'meter:alice', model: 'claude-b', costUsd: 0.2, apiUsd: 0.2, inTok: 1000, outTok: 100, cacheTok: 50 });
  spendLedger.record({ ...base, principal: 'meter:alice', model: 'claude-a', costUsd: 0.1, apiUsd: 0.1, inTok: 500, outTok: 50 });
  spendLedger.record({ ...base, principal: 'meter:bob', model: 'claude-a', costUsd: 0.3, apiUsd: 0.3, inTok: 1500, outTok: 150 });
  spendLedger.record({ ...base, principal: null, model: 'claude-a', costUsd: 0.05, apiUsd: 0.05, inTok: 10, outTok: 1 });
  spendLedger.record({ app: 'u-group', appDir, method: 'ai.transcribe', principal: 'owner', origin: 'bridge', costUsd: 0.04, units: 1, priced: true });
  const all = spendLedger.query(appDir, {});
  assert.equal(all.calls, 5);
  close(all.billedUsd, 0.69);
  close(all.apiUsd, 0.69);
  assert.equal(all.rows, undefined);

  const byModel = spendLedger.query(appDir, { groupBy: 'model' });
  assert.deepEqual(byModel.rows.map((r) => r.model), [null, 'claude-a', 'claude-b']);
  assert.deepEqual(Object.keys(byModel.rows[1]).sort(), ['apiUsd', 'billedUsd', 'cacheTok', 'calls', 'inTok', 'model', 'outTok', 'unpriced']);
  const a = byModel.rows.find((r) => r.model === 'claude-a');
  assert.equal(a.calls, 3);
  assert.equal(a.inTok, 2010);
  close(a.apiUsd, 0.45);
  close(byModel.rows.find((r) => r.model === 'claude-b').apiUsd, 0.2);
  assert.equal(byModel.rows.find((r) => r.model === 'claude-b').cacheTok, 50);

  const byKey = spendLedger.query(appDir, { groupBy: ['meterKey'] });
  assert.deepEqual(byKey.rows.map((r) => r.meterKey), [null, 'alice', 'bob', 'owner']);
  close(byKey.rows[0].billedUsd, 0.05, 'unattributed → meterKey null');
  close(byKey.rows.find((r) => r.meterKey === 'alice').billedUsd, 0.3);

  const dmk = spendLedger.query(appDir, { groupBy: ['day', 'model', 'meterKey'] });
  assert.equal(dmk.rows.length, 5);
  assert.ok(dmk.rows.every((r) => r.day === dayAgo(0)));
  assert.deepEqual(dmk.rows.map((r) => [r.model, r.meterKey]), [[null, 'owner'], ['claude-a', null], ['claude-a', 'alice'], ['claude-a', 'bob'], ['claude-b', 'alice']]);
  // rows add up to the total, in every grouping
  for (const q of [byModel, byKey, dmk]) {
    close(q.rows.reduce((s, r) => s + r.apiUsd, 0), all.apiUsd);
    assert.equal(q.rows.reduce((s, r) => s + r.calls, 0), all.calls);
  }
  // meterKey filter + groupBy
  const alice = spendLedger.query(appDir, { meterKey: 'alice', groupBy: 'model' });
  assert.deepEqual(alice.rows.map((r) => r.model), ['claude-a', 'claude-b']);
  assert.equal(alice.calls, 2);
  // legacy fields agree with total
  assert.equal(dmk.calls, dmk.total.calls);
  close(dmk.costUsd, dmk.billedUsd);
  // same-day rows sort by day first when several days exist
  const ledgerDays = mkApp('u-group2');
  writeLedger('u-group2', { [dayAgo(1)]: oldDay(1, 1, { _app: T({ calls: 1, costUsd: 1 }) }), [dayAgo(3)]: oldDay(1, 1, { 'meter:x': T({ calls: 1, costUsd: 1 }) }) });
  const dd = spendLedger.query(ledgerDays, { groupBy: ['day', 'meterKey'] });
  assert.deepEqual(dd.rows.map((r) => [r.day, r.meterKey]), [[dayAgo(3), 'x'], [dayAgo(1), null]]);
  assert.deepEqual(dd.rows.map((r) => r.model), [undefined, undefined]);
});

test('subscription call: list-price apiUsd, billedUsd as recorded', () => {
  const appDir = mkApp('u-sub');
  const pricing = { inputCostPerMTok: 3, outputCostPerMTok: 15, cacheReadCostPerMTok: 0.3, cacheCreateCostPerMTok: 3.75 };
  const usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 400 };
  // The settle path of a subscribed principal (owner): the recorded cost is the list price.
  const listUsd = (1000 * 3 + 200 * 15 + 5000 * 0.3 + 400 * 3.75) / 1e6;
  fs.mkdirSync(path.join(appsDir, 'u-sub'), { recursive: true });
  const sg = require('../src/apps/spend-gate');
  const appManager = require('../src/apps/app-manager');
  appManager.setAppsDir(appsDir);
  const spendContext = require('../src/apps/spend-context');
  spendContext.registerInstance('app-u-sub-ai-abcd1234', { app: 'u-sub', principal: 'owner', subscribed: true, origin: 'route' });
  assert.equal(sg.settleInteraction({ instanceId: 'app-u-sub-ai-abcd1234', endpoint: '/v1/messages', usage, pricing, request: { model: 'claude-sonnet-x' } }), true);
  const q = spendLedger.query(appDir, { groupBy: 'model' });
  assert.equal(q.rows.length, 1);
  assert.equal(q.rows[0].model, 'claude-sonnet-x');
  close(q.rows[0].apiUsd, listUsd);
  close(q.rows[0].billedUsd, listUsd);
  assert.equal(q.rows[0].inTok, 1000);
  assert.equal(q.rows[0].cacheTok, 5400);
  assert.equal(q.calls, 1);
  // an explicit billed figure below list price stays what it was recorded as
  spendLedger.record({ app: 'u-sub', appDir, method: 'ai.prompt', principal: 'owner', model: 'claude-sonnet-x', costUsd: 0, apiUsd: 0.5, subscribed: true, inTok: 10 });
  const q2 = spendLedger.query(appDir, { groupBy: 'model' });
  close(q2.rows[0].apiUsd, listUsd + 0.5);
  close(q2.rows[0].billedUsd, listUsd);
  // an unpriced call adds nothing and is counted
  spendLedger.record({ app: 'u-sub', appDir, method: 'ai.prompt', principal: 'owner', model: 'weird', costUsd: 0, priced: false, inTok: 5 });
  assert.equal(spendLedger.query(appDir, {}).total.unpriced, 1);
});

test('no age cutoff: old days survive a flush, move to month shards, and answer any range', () => {
  const appDir = mkApp('u-old');
  writeLedger('u-old', {
    '2020-03-15': oldDay(2, 0.2, { 'meter:a': T({ calls: 2, costUsd: 0.2, inTok: 200, outTok: 20 }) }),
    '2020-03-16': oldDay(1, 0.1, { _app: T({ calls: 1, costUsd: 0.1, inTok: 100, outTok: 10 }) }),
    '2021-07-01': oldDay(1, 1, { 'meter:a': T({ calls: 1, costUsd: 1 }) }),
    [dayAgo(200)]: oldDay(1, 3, { _app: T({ calls: 1, costUsd: 3 }) }),
  });
  // days far beyond any former window are not clamped
  const wide = spendLedger.query(appDir, { days: 4000 });
  assert.equal(wide.days, 4000);
  assert.equal(wide.calls, 5);
  // a record triggers a flush that must keep every day
  spendLedger.record({ app: 'u-old', appDir, method: 'ai.prompt', principal: 'meter:a', model: 'm', costUsd: 0.5, inTok: 1 });
  spendLedger.flushAll();
  const main = JSON.parse(fs.readFileSync(path.join(dataHome, 'spend-ledger', 'u-old.json'), 'utf8'));
  const thisMonth = dayAgo(0).slice(0, 7);
  assert.ok(Object.keys(main.days).every((d) => d.startsWith(thisMonth)), 'the main file holds the current month only');
  const shard = JSON.parse(fs.readFileSync(path.join(dataHome, 'spend-ledger', 'u-old', '2020-03.json'), 'utf8'));
  assert.deepEqual(Object.keys(shard.days).sort(), ['2020-03-15', '2020-03-16']);
  assert.ok(fs.existsSync(path.join(dataHome, 'spend-ledger', 'u-old', '2021-07.json')));
  // a fresh process (drop the in-memory cache) reads the shards back
  const fresh = require('child_process').spawnSync(process.execPath, ['-e', `
    const l = require(${JSON.stringify(path.resolve(__dirname, '../src/apps/spend-ledger'))});
    l.init({ dataHome: ${JSON.stringify(dataHome)} });
    const q = l.query(${JSON.stringify(appDir)}, { from: '2020-03-01', to: '2020-03-31', groupBy: ['day', 'meterKey'] });
    const all = l.query(${JSON.stringify(appDir)}, { from: '2000-01-01', groupBy: 'model' });
    process.stdout.write(JSON.stringify({ q, all }));
  `], { encoding: 'utf8' });
  assert.equal(fresh.status, 0, fresh.stderr);
  const out = JSON.parse(fresh.stdout);
  assert.deepEqual(out.q.rows.map((r) => [r.day, r.meterKey, r.calls]), [['2020-03-15', 'a', 2], ['2020-03-16', null, 1]]);
  assert.equal(out.all.calls, 6);
  close(out.all.billedUsd, 0.2 + 0.1 + 1 + 3 + 0.5);
  assert.equal(out.q.days, 31);
});

test('caps are untouched: spent() and summary() still sum the same buckets', () => {
  const appDir = mkApp('u-caps');
  spendLedger.record({ app: 'u-caps', appDir, method: 'ai.prompt', principal: 'meter:z', model: 'm', costUsd: 0.25, apiUsd: 9, inTok: 1 });
  close(spendLedger.spent('u-caps', { scope: 'day' }, appDir).costUsd, 0.25);
  close(spendLedger.spent('u-caps', { scope: 'day', view: 'principal', key: 'meter:z' }, appDir).costUsd, 0.25);
  close(spendLedger.summary('u-caps', { days: 5 }, appDir).today.costUsd, 0.25);
  assert.equal(spendLedger.summary('u-caps', { days: 500 }, appDir).days, 366);
});

test('a session folded per model keeps one call and an exact model split', () => {
  const appDir = mkApp('u-session');
  const mk = (model, usage, pricing) => ({ instanceId: 'app-u-session-ai-1', request: { model }, usage, pricing });
  const p = { inputCostPerMTok: 1, outputCostPerMTok: 5 };
  const items = [
    mk('m1', { input_tokens: 1000, output_tokens: 100 }, p),
    mk('m2', { input_tokens: 2000, output_tokens: 200 }, p),
    mk('m1', { input_tokens: 500, output_tokens: 50 }, p),
    { instanceId: 'app-u-session-ai-1', isHook: true, usage: { input_tokens: 9 } },
  ];
  spendLedger.init({ dataHome, store: { getAll: () => items } });
  const u = spendLedger.usageOfInstance('app-u-session-ai-1');
  assert.equal(u.turns, 3);
  assert.equal(u.model, 'm2');
  close(u.apiUsd, (3500 * 1 + 350 * 5) / 1e6);
  assert.equal(spendLedger.recordSession('u-session', appDir, 'app-u-session-ai-1', { principal: 'owner', origin: 'route', subscribed: true }), true);
  const q = spendLedger.query(appDir, { groupBy: 'model' });
  assert.equal(q.calls, 1, 'one aiPrompt session is still one call');
  assert.deepEqual(q.rows.map((r) => [r.model, r.inTok]), [['m1', 1500], ['m2', 2000]]);
  close(q.apiUsd, (3500 + 1750) / 1e6);
});

test('bad params throw a clear E_BAD_PARAMS error', () => {
  const appDir = mkApp('u-bad');
  const bad = (params, re) => assert.throws(() => spendLedger.query(appDir, params), (e) => e.code === 'E_BAD_PARAMS' && re.test(e.message));
  bad({ from: '2024-1-1' }, /from must be/);
  bad({ to: 'yesterday' }, /to must be/);
  bad({ from: 20240101 }, /from must be/);
  bad({ from: '2024-02-30' }, /not a calendar day/);
  bad({ from: '2024-05-02', to: '2024-05-01' }, /after to/);
  bad({ groupBy: 'user' }, /groupBy must be/);
  bad({ groupBy: ['day', 'nope'] }, /groupBy must be/);
  bad({ groupBy: 5 }, /groupBy must be/);
  bad([], /object/);
  // lenient where it always was
  assert.equal(spendLedger.query(appDir, { days: 'x' }).days, 30);
  assert.equal(spendLedger.query(appDir, null).days, 30);
});

test('surface: bridge and ctx share one function; ai.models carries the cache prices', async () => {
  const ai = require('../src/apps/capabilities/ai');
  const appDir = mkApp('u-surface');
  spendLedger.record({ app: 'u-surface', appDir, method: 'ai.prompt', principal: 'meter:q', model: 'm', costUsd: 1, inTok: 1 });
  const app = { name: 'u-surface', dir: appDir };
  const viaBridge = await ai.bridge['ai.usage'](app, { groupBy: 'meterKey' });
  const viaCtx = ai.buildCtx(app).aiUsage({ groupBy: 'meterKey' });
  assert.deepEqual(viaBridge, viaCtx);
  assert.deepEqual(viaBridge.rows.map((r) => r.meterKey), ['q']);
  await assert.rejects(ai.bridge['ai.usage'](app, { groupBy: 'x' }), /groupBy/);
  const { publicModelShape } = require('../src/apps/ai-service');
  const m = publicModelShape({ name: 'n', inputCostPerMTok: 3, outputCostPerMTok: 15, cacheReadCostPerMTok: 0.3, cacheCreateCostPerMTok: 3.75 });
  assert.equal(m.cacheReadCostPerMTok, 0.3);
  assert.equal(m.cacheWriteCostPerMTok, 3.75);
  const bare = publicModelShape({ name: 'n' });
  assert.equal(bare.cacheReadCostPerMTok, null);
  assert.equal(bare.cacheWriteCostPerMTok, null);
});
