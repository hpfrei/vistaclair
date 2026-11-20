// App licensing backend = a provider slot (app-license.setProvider), empty by
// default. No provider: owner full, account free tier, claim unavailable (503
// at the route), products [], validate invalid, release drops the key. A fake
// provider gives an active tier; the gate passes a freemium app's free tier.
// No network is involved anywhere (app-license has no fetch).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const lic = require('../src/apps/app-license');

const cfg = lic.parseManifest({
  product: 'buddy',
  tiers: { 'x-buddy-basic': { ops: 20 }, 'x-buddy-pro': { ops: 200 } },
  free: { ops: 3 },
});
const cfgNoFree = lic.parseManifest('buddy');

// A fake app ctx whose accounts table is a Map.
function fakeCtx(rows) {
  const db = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    appName: 'lp-app',
    db,
    async dbQuery(sql, params) {
      if (/^SELECT id, license_key FROM accounts/.test(sql)) {
        const r = db.get(params[0]);
        return r ? [{ id: r.id, license_key: r.license_key || null }] : [];
      }
      if (/^UPDATE accounts SET license_key=\?/.test(sql)) { db.get(params[1]).license_key = params[0]; return []; }
      if (/^UPDATE accounts SET license_key=NULL/.test(sql)) { db.get(params[0]).license_key = null; return []; }
      throw new Error('unexpected sql ' + sql);
    },
  };
}

function fakeProvider() {
  const calls = [];
  const seats = new Set();
  const good = { valid: true, product: { slug: 'x-buddy-pro' }, license: { expiresAt: '2099-01-01' } };
  return {
    calls, seats,
    validate: async (key, o) => {
      calls.push(['validate', key, o]);
      if (key !== 'GOOD') return { valid: false, error: 'invalid_key' };
      if (o.machineId && !seats.has(o.machineId)) return { valid: false, error: 'seat_not_activated' };
      return good;
    },
    activate: async (key, { seat }) => {
      calls.push(['activate', key, seat]);
      if (key === 'FULL') return { valid: false, error: 'machine_limit' };
      seats.add(seat.machineId);
      return good;
    },
    deactivate: async (key, { seat }) => { calls.push(['deactivate', key, seat]); seats.delete(seat.machineId); return { ok: true }; },
    products: async (product) => { calls.push(['products', product]); return { variants: [{ slug: 'x-buddy-pro', name: 'Pro', checkoutUrl: 'https://pay.example/pro', licenseType: 'sub', durationDays: 30, machineLimit: 1, extra: 'dropped' }] }; },
  };
}

test.beforeEach(() => lic.setProvider(null));
test.after(() => lic.setProvider(null));

test('app-license has no HTTP client or server URL', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/apps/app-license.js'), 'utf8');
  assert.ok(!/fetch\(|licenseServerUrl|licencing\.hpfreilabs/.test(src));
  assert.ok(!('licenseServerUrl' in require('../src/apps/platform-settings').DEFAULTS));
  assert.equal(lic.getProvider(), null);
});

test('no provider: owner gets full access, an account gets the free tier', async () => {
  const ctx = fakeCtx([{ id: 1, license_key: 'OLDKEY' }, { id: 2, license_key: null }]);
  const owner = await lic.getEntitlement(ctx, cfg, { id: 9, is_owner: 1 });
  assert.equal(owner.licensed, true);
  assert.equal(owner.status, 'owner');
  assert.deepEqual(owner.features, { ops: 200 });
  // An account with a stored (legacy) key is still just free: nothing validates it.
  const acct = await lic.getEntitlement(ctx, cfg, { id: 1, license_key: 'OLDKEY' });
  assert.deepEqual(acct, { licensed: false, status: 'free', tier: 'free', features: { ops: 3 }, expiresAt: null });
  assert.equal((await lic.getEntitlement(ctx, cfgNoFree, { id: 2 })).status, 'none');
  assert.equal((await lic.entitlement(ctx, cfg, 1)).status, 'free');
  assert.equal(lic.subscribedFromCache('lp-app', 1), false);
});

test('no provider: claim is licensing_unavailable, validate invalid, products []', async () => {
  const ctx = fakeCtx([{ id: 1, license_key: null }]);
  assert.deepEqual(await lic.claim(ctx, cfg, 1, 'GOOD'), { ok: false, error: 'licensing_unavailable' });
  assert.equal(ctx.db.get(1).license_key, null);
  assert.deepEqual(await lic.validateKey({ key: 'GOOD', product: 'buddy' }), { valid: false, error: 'licensing_unavailable' });
  assert.deepEqual(await lic.products(cfg), { product: 'buddy', variants: [] });
  assert.equal(await lic.checkoutUrl(cfg), null);
});

test('no provider: release drops the key and returns ok; stored keys are otherwise untouched', async () => {
  const ctx = fakeCtx([{ id: 1, license_key: 'OLDKEY' }, { id: 2, license_key: 'KEEP' }]);
  assert.deepEqual(await lic.release(ctx, cfg, 1), { ok: true });
  assert.equal(ctx.db.get(1).license_key, null);
  await lic.getEntitlement(ctx, cfg, { id: 2, license_key: 'KEEP' });
  await lic.claim(ctx, cfg, 2, 'X');
  assert.equal(ctx.db.get(2).license_key, 'KEEP');
});

// The real app-auth routes, mounted on an express router with a fake ctx.
async function withRoutes(manifest, rows, fn) {
  const express = require('express');
  const appAuth = require('../src/apps/app-auth');
  const db = new Map(rows.map((r) => [r.id, { ...r }]));
  const ctx = {
    appName: 'lp-route', basePath: '/apps/lp-route', db,
    ensureSchema: async () => {},
    identity: { resolve: () => ({ via: 'session', userId: 1 }), hashPassword: (x) => x },
    async dbQuery(sql, params) {
      if (/^SELECT .* FROM accounts WHERE id=\?/.test(sql)) { const r = db.get(params[0]); return r ? [r] : []; }
      if (/^UPDATE accounts SET license_key=NULL/.test(sql)) { db.get(params[0]).license_key = null; return []; }
      if (/^UPDATE accounts SET license_key=\?/.test(sql)) { db.get(params[1]).license_key = params[0]; return []; }
      return [];
    },
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  await appAuth.mount(router, ctx, manifest);
  app.use(router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const call = async (method, p, body) => {
    const r = await globalThis.fetch(`http://127.0.0.1:${srv.address().port}${p}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try { await fn(call, ctx); } finally { srv.close(); }
}

test('routes: no provider - claim 503, products [], me.license free, release ok', async () => {
  const manifest = { auth: { email: true, license: { product: 'buddy', free: { ops: 3 } } } };
  await withRoutes(manifest, [{ id: 1, email: 'a@b.c', license_key: 'OLDKEY' }], async (call, ctx) => {
    const claim = await call('POST', '/api/auth/license/claim', { key: 'GOOD' });
    assert.equal(claim.status, 503);
    assert.equal(claim.body.error, 'licensing_unavailable');
    assert.deepEqual((await call('GET', '/api/auth/license/products')).body, { product: 'buddy', variants: [] });
    const me = await call('GET', '/api/auth/me');
    assert.equal(me.body.license.status, 'free');
    assert.deepEqual(me.body.license.features, { ops: 3 });
    assert.equal(ctx.db.get(1).license_key, 'OLDKEY', 'stored key untouched');
    assert.deepEqual((await call('POST', '/api/auth/license/release')).body, { ok: true });
    assert.equal(ctx.db.get(1).license_key, null);
  });
});

test('fake provider: claim takes a seat, entitlement is an active tier, products map variants', async () => {
  const p = fakeProvider();
  lic.setProvider(p);
  assert.equal(lic.getProvider(), p);
  const ctx = fakeCtx([{ id: 1, license_key: null }, { id: 2, license_key: null }]);
  const bad = await lic.claim(ctx, cfg, 1, 'NOPE');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_key');
  const lim = await lic.claim(ctx, cfg, 2, 'FULL');
  assert.equal(lim.ok, false);
  const ok = await lic.claim(ctx, cfg, 1, 'GOOD');
  assert.equal(ok.ok, true);
  assert.equal(ok.license.tier, 'x-buddy-pro');
  assert.equal(ok.license.status, 'active');
  assert.deepEqual(ok.license.features, { ops: 200 });
  assert.equal(ctx.db.get(1).license_key, 'GOOD');
  assert.ok(p.seats.has('vc:lp-app:acct:1'));
  const ent = await lic.entitlement(ctx, cfg, 1);
  assert.equal(ent.licensed, true);
  assert.equal(lic.subscribedFromCache('lp-app', 1), true);
  const pr = await lic.products(cfg);
  assert.deepEqual(pr.variants.map((v) => v.checkoutUrl), ['https://pay.example/pro']);
  assert.ok(!('extra' in pr.variants[0]));
  assert.deepEqual(await lic.release(ctx, cfg, 1), { ok: true });
  assert.equal(ctx.db.get(1).license_key, null);
  assert.ok(!p.seats.has('vc:lp-app:acct:1'));
});

test('fake provider: machine_limit and seat_not_activated codes', async () => {
  const p = fakeProvider();
  lic.setProvider(p);
  const ctx = fakeCtx([{ id: 5, license_key: null }, { id: 6, license_key: 'GOOD' }]);
  const lim = await lic.claim(ctx, cfg, 5, 'FULL');
  // validate('FULL') fails first with the provider's own code, so the limit path is exercised via activate directly
  assert.equal(lim.ok, false);
  lic.setProvider({ ...p, validate: async () => ({ valid: true, product: { slug: 'x-buddy-pro' } }), activate: async () => ({ valid: false, error: 'machine_limit' }) });
  const lim2 = await lic.claim(ctx, cfg, 5, 'FULL');
  assert.equal(lim2.error, 'machine_limit');
  // a stored key whose seat is missing self-heals: activate once, then validate
  lic.setProvider(p);
  const ent = await lic.getEntitlement(ctx, cfg, { id: 6, license_key: 'GOOD' });
  assert.equal(ent.status, 'active');
  assert.ok(p.calls.some((c) => c[0] === 'activate'));
});

test('fake provider: a throwing provider is unreachable, not invalid', async () => {
  lic.setProvider({ validate: async () => { throw new Error('down'); }, activate: async () => { throw new Error('down'); }, deactivate: async () => { throw new Error('down'); }, products: async () => { throw new Error('down'); } });
  const ctx = fakeCtx([{ id: 1, license_key: 'GOOD' }]);
  assert.equal((await lic.getEntitlement(ctx, cfgNoFree, { id: 1, license_key: 'GOOD' })).status, 'unreachable');
  assert.equal((await lic.getEntitlement(ctx, cfg, { id: 1, license_key: 'GOOD' })).status, 'free');
  assert.deepEqual(await lic.claim(ctx, cfg, 1, 'GOOD'), { ok: false, error: 'license_server_unreachable', retryable: true });
  assert.deepEqual((await lic.products(cfg)).variants, []);
  assert.throws(() => lic.setProvider({ validate() {} }), /needs a activate/);
});

function gateRun(ctx, c, account) {
  return new Promise((resolve) => {
    const res = { status(s) { this.s = s; return this; }, json(b) { resolve({ status: this.s, body: b }); } };
    lic.gate(ctx, c)({ account }, res, () => resolve({ passed: true }));
  });
}

test('gate: no provider passes the free tier, owner passes, unlicensed non-freemium gets 402', async () => {
  const ctx = fakeCtx([]);
  assert.deepEqual(await gateRun(ctx, cfg, { id: 1 }), { passed: true });
  assert.deepEqual(await gateRun(ctx, cfgNoFree, { id: 9, is_owner: 1 }), { passed: true });
  const r = await gateRun(ctx, cfgNoFree, { id: 1, license_key: 'OLDKEY' });
  assert.equal(r.status, 402);
  assert.equal(r.body.error, 'license_required');
});

test('gate: with a provider an active key passes a non-freemium app', async () => {
  lic.setProvider(fakeProvider());
  const ctx = fakeCtx([{ id: 1, license_key: null }]);
  assert.equal((await gateRun(ctx, cfgNoFree, { id: 1, license_key: 'GOOD' })).passed, true);
  assert.equal((await gateRun(ctx, cfgNoFree, { id: 2, license_key: 'BAD' })).status, 402);
});
