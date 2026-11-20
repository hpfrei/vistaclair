// The platform bus, receiving side (docs/bus.md):
// app subscribers get a fan-out of every envelope that passes the guardrails,
// independent of Horst's policy; a re-publish from inside a handler inherits
// hop/correlation/trust and stops at MAX_APP_HOP; iframe leases ride the
// existing app:bridge:event channel; the log survives a ring reset; and an
// independent app's event reaches subscribers without ever reaching Horst.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bus = require('../src/apps/agent/horst-events');

const dir = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-bus-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const flush = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
const recorder = () => {
  const r = { broadcasts: [], agenda: [], notify: [], errors: [], run: [] };
  r.broadcaster = { broadcast: (m) => r.broadcasts.push(m) };
  r.ruleActions = { agenda: (e) => r.agenda.push(e), notify: (e) => r.notify.push(e), run: async (e) => { r.run.push(e); return null; } };
  r.onSubscriberError = (app, err, env) => r.errors.push({ app, err, env });
  return r;
};
function boot(rec = recorder()) {
  bus._resetForTests();
  bus.init({ dir, broadcaster: rec.broadcaster, ruleActions: rec.ruleActions, onSubscriberError: rec.onSubscriberError });
  return rec;
}
test.beforeEach(() => { for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true }); });

test('matchKind: exact, one segment per *, trailing * eats the rest', () => {
  assert.equal(bus.matchKind('a:b', 'a:b'), true);
  assert.equal(bus.matchKind('a:b', 'a:c'), false);
  assert.equal(bus.matchKind('a:*', 'a:b'), true);
  assert.equal(bus.matchKind('a:*', 'a:b:c'), true);
  assert.equal(bus.matchKind('a:*', 'a'), false);
  assert.equal(bus.matchKind('*:crashloop', 'app:crashloop'), true);
  assert.equal(bus.matchKind('*:crashloop', 'x:app:crashloop'), false);
  assert.equal(bus.matchKind('*:b:*', 'a:b:c'), true);
  assert.equal(bus.matchKind('*:b:*', 'a:c:d'), false);
});

test('a subscriber receives the envelope, with trust, for matching kinds only', async () => {
  boot();
  const got = [];
  const off = bus.subscribe('composer', ['app-a:*'], (env) => got.push(env));
  await bus.publish('thing:done', { n: 1 }, { app: 'app-a', source: 'app' });
  await bus.publish('thing:done', { n: 2 }, { app: 'app-b', source: 'app' });
  await flush();
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, 'app-a:thing:done');
  assert.equal(got[0].app, 'app-a');
  assert.equal(got[0].trust, 'platform');
  assert.equal(got[0].hop, 0);
  assert.deepEqual(got[0].payload, { n: 1 });
  off();
  await bus.publish('thing:done', { n: 3 }, { app: 'app-a', source: 'app' });
  await flush();
  assert.equal(got.length, 1, 'unsubscribed');
  assert.deepEqual(bus.subscribers(), {});
});

test("an 'ignore' policy still delivers to app subscribers; storm-folded events never do", async () => {
  const rec = boot();
  bus.setPolicy('app-a', 'app-a:tick', 'ignore');
  const got = [];
  bus.subscribe('composer', 'app-a:tick', (env) => got.push(env));
  const results = [];
  for (let i = 0; i < 12; i++) results.push(await bus.publish('tick', { i }, { app: 'app-a', source: 'app' }));
  await flush();
  assert.equal(rec.agenda.length, 0, 'ignore: Horst does nothing');
  const folded = results.filter((r) => r.folded).length;
  assert.ok(folded > 0, 'the storm folded some');
  assert.equal(got.length, 12 - folded, 'delivered exactly the non-folded ones');
  assert.equal(results[0].outcome, 'ignored (rule)');
});

test('a re-publish inside a handler: hop+1, inherited correlationId, trust floor, hop cap', async () => {
  const rec = boot();
  const seen = [];
  // A chain of apps that each re-publish what they hear.
  bus.subscribe('b', 'a:*', (env) => { seen.push(env); return bus.publish('echo', {}, { app: 'b', source: 'app', trust: 'owner' }); });
  bus.subscribe('c', 'b:*', (env) => { seen.push(env); return bus.publish('echo', {}, { app: 'c', source: 'app' }); });
  bus.subscribe('d', 'c:*', (env) => { seen.push(env); return bus.publish('echo', {}, { app: 'd', source: 'app' }); });
  bus.subscribe('e', 'd:*', (env) => { seen.push(env); return bus.publish('echo', {}, { app: 'e', source: 'app' }); });
  bus.subscribe('f', 'e:*', (env) => { seen.push(env); });
  const first = await bus.publish('start', {}, { app: 'a', source: 'app', trust: 'untrusted' });
  for (let i = 0; i < 12; i++) await flush();
  const kinds = seen.map((e) => e.kind);
  assert.deepEqual(kinds, ['a:start', 'b:echo', 'c:echo', 'd:echo'], 'e:echo (hop 4) was dropped, so f never hears it');
  assert.deepEqual(seen.map((e) => e.hop), [0, 1, 2, 3]);
  assert.equal(seen[0].correlationId, null, 'the origin has no correlation');
  assert.ok(seen.slice(1).every((e) => e.correlationId === first.id), 'every re-publish carries the first envelope id');
  assert.equal(seen[1].trust, 'untrusted', "b asked for 'owner' but cannot outrank the untrusted event it reacted to");
  const dropped = bus.listAudit({ app: 'e' }).find((i) => i.outcome === 'dropped: hop cap');
  assert.ok(dropped, 'the hop-cap drop is audited');
  assert.equal(dropped.hop, bus.MAX_APP_HOP);
  assert.equal(rec.errors.length, 0);
});

test('a leased subscriber gets app:bridge:event / bus:event and expires with its ttl', async () => {
  const rec = boot();
  const r = bus.leaseSubscribe('iframe-app', ['app-a:*'], 1000);
  assert.equal(r.ttlMs, 5000, 'ttl clamped to the minimum');
  assert.deepEqual(bus.subscribers(), { 'app-a:*': ['iframe-app'] });
  await bus.publish('x', { a: 1 }, { app: 'app-a', source: 'app' });
  const ev = rec.broadcasts.filter((m) => m.type === 'app:bridge:event' && m.event === 'bus:event');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].appName, 'iframe-app');
  assert.equal(ev[0].data.kind, 'app-a:x');
  // Expire it by hand (no real clock in a test): the sweep runs on each publish.
  bus.leaseSubscribe('iframe-app', ['app-a:*'], 5000);
  const realNow = Date.now;
  Date.now = () => realNow() + 6000;
  try {
    await bus.publish('y', {}, { app: 'app-a', source: 'app' });
  } finally { Date.now = realNow; }
  assert.equal(rec.broadcasts.filter((m) => m.event === 'bus:event').length, 1, 'expired lease: nothing more');
  assert.deepEqual(bus.subscribers(), {});
  bus.leaseSubscribe('iframe-app', 'app-a:*');
  bus.unlease('iframe-app');
  assert.deepEqual(bus.subscribers(), {});
});

test('removeApp clears both the in-process handlers and the lease', async () => {
  boot();
  bus.subscribe('gone', 'a:*', () => {});
  bus.leaseSubscribe('gone', 'b:*');
  bus.subscribe('stays', 'a:*', () => {});
  bus.removeApp('gone');
  assert.deepEqual(bus.subscribers(), { 'a:*': ['stays'] });
});

test('history: oldest first, since/kinds filters, and from the file after a ring reset', async () => {
  const rec = boot();
  await bus.publish('one', { i: 1 }, { app: 'app-a', source: 'app' });
  const t = Date.now();
  await new Promise((r) => setTimeout(r, 5));
  await bus.publish('two', { i: 2 }, { app: 'app-a', source: 'app' });
  await bus.publish('three', { i: 3 }, { app: 'app-b', source: 'app' });
  const all = bus.history();
  assert.deepEqual(all.map((e) => e.kind), ['app-a:one', 'app-a:two', 'app-b:three']);
  assert.deepEqual(bus.history({ since: t }).map((e) => e.kind), ['app-a:two', 'app-b:three']);
  assert.deepEqual(bus.history({ kinds: 'app-a:*' }).map((e) => e.kind), ['app-a:one', 'app-a:two']);
  assert.deepEqual(bus.history({ sinceId: all[0].id }).map((e) => e.kind), ['app-a:two', 'app-b:three']);
  assert.deepEqual(bus.history({ limit: 1 }).map((e) => e.kind), ['app-b:three'], 'no cursor → the recent tail');
  assert.ok(fs.existsSync(path.join(dir, 'events-log.jsonl')));
  // A restart: the ring is gone, the file is not.
  bus._resetForTests();
  bus.init({ dir, broadcaster: rec.broadcaster, ruleActions: rec.ruleActions });
  assert.deepEqual(bus.history().map((e) => e.payload.i), [1, 2, 3], 'reloaded from the file tail');
  assert.deepEqual(bus.history({ kinds: ['app-b:*'] }).map((e) => e.kind), ['app-b:three']);
  bus._resetForTests();
  assert.deepEqual(bus.history(), [], 'not ready → empty');
});

test("horst:false — on the bus and in the log, delivered to subscribers, never routed to Horst", async () => {
  const rec = boot();
  const got = [];
  bus.subscribe('composer', 'indie:*', (env) => got.push(env));
  const r = await bus.publish('went', { ok: 1 }, { app: 'indie', source: 'app', horst: false });
  await flush();
  assert.equal(r.outcome, 'app-only');
  assert.equal(r.policy, null);
  assert.equal(got.length, 1);
  assert.equal(rec.agenda.length + rec.notify.length + rec.run.length, 0, 'no rule action ran');
  const a = bus.listAudit({ app: 'indie' })[0];
  assert.equal(a.outcome, 'app-only');
  assert.equal(a.policy, null);
  assert.equal(a.delivered, 1);
  assert.equal(bus.history({ kinds: 'indie:*' }).length, 1);
  assert.equal(bus.catalog().discovered.indie['indie:went'].horst, false, 'the catalog greys it');
  bus.declare('indie', [{ kind: 'told', description: 'x' }], { horst: false, via: 'manifest' });
  const d = bus.catalog().declared.indie['indie:told'];
  assert.equal(d.horst, false);
  assert.equal(d.manifest, true);
});

test('a throwing handler reaches onSubscriberError with the app and the envelope; the publisher is unaffected', async () => {
  const rec = boot();
  bus.subscribe('bad', 'a:*', () => { throw new Error('boom'); });
  bus.subscribe('good', 'a:*', async () => { await new Promise((r) => setTimeout(r, 1)); throw new Error('later'); });
  const r = await bus.publish('x', {}, { app: 'a', source: 'app' });
  assert.equal(r.outcome, '→ agenda');
  assert.equal(r.delivered, 2);
  for (let i = 0; i < 100 && rec.errors.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(rec.errors.map((e) => `${e.app}:${e.err.message}`).sort(), ['bad:boom', 'good:later']);
  assert.equal(rec.errors[0].env.kind, 'a:x');
});

test('declare before init is a refused no-op, not a throw', () => {
  bus._resetForTests();
  assert.deepEqual(bus.declare('x', [{ kind: 'k' }]), { ok: false, added: 0, dropped: 'not-ready' });
});
