// The Vista Mini App's perimeter, asserted structurally rather than trusted.
//
// Two claims that comments cannot enforce:
//
//   1. Mail, Calendar and the Briefing are READ-ONLY. This surface must never
//      become a second, ungoverned action path — acting on a mail here means
//      staging a proposal through the same funnel, never sending directly. A
//      POST appearing under /mail, /calendar or /briefing is that mistake
//      happening.
//   2. /pro/vista is an auth-EXEMPT subtree (Telegram's webview carries no
//      owner cookie), so EVERY route must self-authenticate. A route added
//      without the authed() guard would be silently anonymous.
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');

const miniapp = require('../src/apps/platform-miniapp');
const horst = require('../src/apps/platform-horst');

function fakeRouter() {
  const routes = [];
  const add = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
  return { routes, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') };
}

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

const router = fakeRouter();
miniapp.mountApi(router);

const readOnlySurface = (r) => /\/(mail|calendar|briefing)(\/|$)/.test(r.path);

test('the Mini App mounts a real route table', () => {
  assert.ok(router.routes.length >= 8, `expected the Vista API, got ${router.routes.length} routes`);
  assert.ok(router.routes.every((r) => r.path.startsWith('/pro/vista/api')), 'a route escaped the Vista namespace');
});

test('mail, calendar and briefing are read-only — no write route exists on that surface', () => {
  const surface = router.routes.filter(readOnlySurface);
  assert.ok(surface.length >= 5, `expected the mail+calendar+briefing routes, got ${surface.length}`);
  for (const r of surface) {
    assert.equal(r.method, 'GET', `${r.method} ${r.path} is a write on the read-only surface`);
  }
});

test('the read-only claim is not vacuous: deciding IS a write', () => {
  // If this ever fails, the test above is passing because nothing writes at
  // all, not because the read-only surface is genuinely read-only.
  const decide = router.routes.find((r) => r.path.endsWith('/proposals/:id/decide'));
  assert.ok(decide, 'the decide route vanished');
  assert.equal(decide.method, 'POST');
  assert.ok(router.routes.some((r) => r.method === 'POST' && r.path.endsWith('/proposals/batch')));
});

// The signature toggle is an affordance, not an endpoint. It posts the same
// payload edit that every hand-edit posts, so the write surface must be
// UNCHANGED by it — a dedicated /signature route would mean the flag had become
// a second way to change what gets sent, outside the freeze path.
test('the signature toggle added no route of its own', () => {
  const writes = router.routes.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
  assert.ok(
    !writes.some((w) => /signat/i.test(w)),
    `the toggle grew its own write route: ${writes.join(', ')}`,
  );
  assert.ok(
    writes.some((w) => w.endsWith('/proposals/:id/payload')),
    'the payload edit route the toggle reuses is gone — the toggle now writes nowhere',
  );
});

test('no route on this auth-exempt subtree answers without a bearer', async () => {
  for (const r of router.routes) {
    // The initData exchange is the one route that must be reachable without a
    // bearer — it is what mints one. It still refuses an unsigned caller.
    if (r.path.endsWith('/auth')) continue;
    const handler = r.handlers[r.handlers.length - 1];
    const res = fakeRes();
    await handler({ headers: {}, query: {}, params: {}, body: {} }, res);
    assert.equal(res.statusCode, 401, `${r.method} ${r.path} answered an anonymous caller`);
    assert.equal(res.body.error, 'unauthorized');
  }
});

test('the auth exchange itself refuses an unsigned caller', async () => {
  const auth = router.routes.find((r) => r.path.endsWith('/auth'));
  assert.ok(auth);
  const res = fakeRes();
  await auth.handlers[auth.handlers.length - 1]({ headers: {}, query: {}, params: {}, body: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, 'invalid initData');
});

test('a batch is bounded, so a stale page cannot sweep the whole store', () => {
  assert.ok(Number.isFinite(horst.BATCH_MAX) && horst.BATCH_MAX <= 100, 'the batch cap went missing');
});

// The Mini App and the dashboard's Approvals view decide the same proposals.
// Every route here already delegates; the batch used to be the exception,
// looping over ids in this file with its own cap. One implementation is the
// only way "the Mini App is never a second decision funnel" stays true as
// either surface grows a new bulk action.
test('both approval surfaces share one batch implementation', async () => {
  assert.equal(typeof horst.batchProposals, 'function', 'the shared batch went missing');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'platform-miniapp.js'), 'utf-8');
  assert.ok(/batchProposals\(/.test(src), 'the Mini App stopped calling the shared batch');
  assert.ok(!/for\s*\(const id of/.test(src), 'the Mini App grew a batch loop of its own again');
});

test('the shared batch refuses an unknown action and an empty id list', async () => {
  await assert.rejects(horst.batchProposals({ action: 'delete', ids: ['x'] }), /action must be one of/);
  await assert.rejects(horst.batchProposals({ action: 'deny', ids: [] }), /ids required/);
});
