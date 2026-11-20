// app-manager.accessInfo — the admin's public picture of one app (the Public
// URL block in App Config → Access).
//
// The perimeter itself is golden-tested in surfaces.test.js; what is asserted
// here is the COMPOSITION on top of it: which external base wins, the URL that
// base yields, and the four mismatches an admin is warned about — above all a
// guard exemption that is dead (nothing lifts the owner login off it) or wide
// (the app's whole API surface opted out of the platform's default-deny guard).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const telegram = require('../src/apps/telegram');

const dir = makeAppsDir({
  // users level, entry page shipped
  users: { auth: { telegram: true } },
  // users level, no public/app.html
  'no-entry': { auth: { email: true } },
  // the pixachat shape: a wide declared exemption and a dead one
  pixachat: { auth: { telegram: true }, surfaces: { public: { api: ['/api/app', '/api/botqr'] } } },
  // a recorded custom domain
  domained: { auth: { telegram: true }, domain: 'pixachat.com' },
  // a domain on a private app
  'domained-private': { domain: 'example.com' },
  // a landing page that was never written
  landing: { surfaces: { public: { landing: 'landing.html' } } },
  // whole subtree
  open: { surfaces: { public: { pages: ['**'] } } },
});
appManager.setAppsDir(dir);
for (const name of ['users', 'pixachat', 'domained', 'domained-private', 'open']) {
  fs.writeFileSync(path.join(dir, name, 'public', 'app.html'), '<!doctype html>');
}

const codes = (info) => info.warnings.map((w) => w.code);

test('accessInfo: an unknown app throws', () => {
  assert.throws(() => appManager.accessInfo('nope'), /not found/);
});

test('accessInfo: level, channels and paths come from surfaces', () => {
  const info = appManager.accessInfo('users');
  assert.equal(info.level, 'users');
  assert.deepEqual(info.channels, ['telegram']);
  assert.ok(info.paths.includes('/apps/users/app.html'));
  assert.ok(info.paths.includes('/apps/users/app/**'));
  assert.ok(info.paths.includes('/apps/users/__surface/*'));
  assert.equal(info.hasEntryPage, true);

  const open = appManager.accessInfo('open');
  assert.equal(open.level, 'open');
  assert.deepEqual(open.paths, ['/apps/open/**']);
});

test('accessInfo: with no external address configured there is no base', () => {
  const info = appManager.accessInfo('users');
  assert.equal(info.base, null);
  assert.equal(info.baseSource, null);
  assert.equal(info.entryUrl, null);
  assert.ok(codes(info).includes('no-base'));
});

test('accessInfo: the platform public URL is the base, and serves under /apps/', (t) => {
  t.mock.method(telegram, 'getPublicUrl', () => 'https://host.example');
  const info = appManager.accessInfo('users');
  assert.equal(info.base, 'https://host.example');
  assert.equal(info.baseSource, 'public-url');
  assert.equal(info.entryUrl, 'https://host.example/apps/users/');
  assert.ok(!codes(info).includes('no-base'));
});

test('accessInfo: a recorded domain wins, and is proxied at the app root', (t) => {
  t.mock.method(telegram, 'getPublicUrl', () => 'https://host.example');
  const info = appManager.accessInfo('domained');
  assert.equal(info.baseSource, 'domain');
  assert.equal(info.base, 'https://pixachat.com');
  assert.equal(info.entryUrl, 'https://pixachat.com/');
  // Two origins now serve the app — Telegram only ever opens the platform one.
  assert.ok(codes(info).includes('two-origins'));
});

test('telegram URLs: the platform base by default, the recorded domain on request', () => {
  // No public URL in the test env: the default stays null even with a domain.
  assert.equal(telegram.webAppUrl('domained'), null);
  assert.equal(telegram.entryUrl('domained'), null);
  assert.equal(telegram.webAppUrl('domained', { customDomain: true }), 'https://pixachat.com/');
  assert.equal(telegram.entryUrl('domained', { customDomain: true }), 'https://pixachat.com/app.html');
  // No domain recorded → the platform answer, unchanged.
  assert.equal(telegram.entryUrl('users', { customDomain: true }), telegram.entryUrl('users'));
});

test('accessInfo: a domain on a private app is flagged', () => {
  const info = appManager.accessInfo('domained-private');
  assert.equal(info.level, 'private');
  assert.ok(codes(info).includes('domain-private'));
});

test('accessInfo: a missing entry page and a missing landing page are flagged', () => {
  assert.ok(codes(appManager.accessInfo('no-entry')).includes('no-entry-page'));
  assert.ok(codes(appManager.accessInfo('landing')).includes('landing-missing'));
  assert.ok(!codes(appManager.accessInfo('users')).includes('no-entry-page'));
});

test('accessInfo: guard exemptions are answered against the cookie exemptions', () => {
  const info = appManager.accessInfo('pixachat');
  const by = Object.fromEntries(info.guardExempt.map((g) => [g.prefix, g]));

  // The built-in anonymous convention: not declared by the app, always reachable.
  assert.equal(by['/api/app/pub'].declared, false);
  assert.equal(by['/api/app/pub'].cookieless, true);

  // Declared and reachable — but it takes the platform's default-deny guard
  // off the app's WHOLE api surface.
  assert.equal(by['/api/app'].cookieless, true);
  assert.ok(codes(info).includes('api-guard-off'));

  // Declared, guard-exempt, and still behind the owner login: a dead route for
  // anonymous callers.
  assert.equal(by['/api/botqr'].cookieless, false);
  assert.ok(codes(info).includes('api-not-cookieless'));
});

test('accessInfo: a users app with no extra declarations gets neither api warning', () => {
  const info = appManager.accessInfo('users');
  assert.deepEqual(info.guardExempt.map((g) => g.prefix), ['/api/app/pub']);
  assert.ok(!codes(info).includes('api-guard-off'));
  assert.ok(!codes(info).includes('api-not-cookieless'));
});

// ---- Website domain: the one field, its nginx block and its Check ----------

test('normalizeDomain: a bare lowercase hostname or null; anything else refused', () => {
  assert.equal(appManager.normalizeDomain(''), null);
  assert.equal(appManager.normalizeDomain('  '), null);
  assert.equal(appManager.normalizeDomain(null), null);
  assert.equal(appManager.normalizeDomain('GymiHorst.HPfreilabs.com'), 'gymihorst.hpfreilabs.com');
  assert.equal(appManager.normalizeDomain('https://gymihorst.hpfreilabs.com/'), 'gymihorst.hpfreilabs.com');
  for (const bad of ['localhost', 'a.com/path', 'a.com:8443', 'a b.com', '-a.com', 'a..com', 'http://a.com/x']) {
    assert.throws(() => appManager.normalizeDomain(bad), /not a hostname/, bad);
  }
});

test('setAppConfig: the domain is stored normalized, empty clears it, junk is refused', () => {
  const lifecycle = require('../src/apps/app-lifecycle');
  lifecycle.setAppConfig('users', { domain: 'https://Web.Example.com/' });
  assert.equal(appManager.readManifest('users').domain, 'web.example.com');
  assert.throws(() => lifecycle.setAppConfig('users', { domain: 'web.example.com/app' }), /not a hostname/);
  assert.equal(appManager.readManifest('users').domain, 'web.example.com');
  lifecycle.setAppConfig('users', { domain: '' });
  assert.ok(!appManager.readManifest('users').domain);
});

test('accessInfo: the website URL and the nginx block for this host', () => {
  const info = appManager.accessInfo('domained');
  assert.equal(info.websiteUrl, 'https://pixachat.com/app.html');
  assert.match(info.nginx, /server_name pixachat\.com;/);
  assert.match(info.nginx, /proxy_pass http:\/\/127\.0\.0\.1:[^/]+\/apps\/domained\/;/);
  for (const h of ['Host', 'X-Forwarded-Host', 'X-Forwarded-Proto']) assert.match(info.nginx, new RegExp(`proxy_set_header ${h} `));
  assert.match(info.nginx, /proxy_buffering off;/);
  // No domain → no website URL; the block still shows with a placeholder.
  const plain = appManager.accessInfo('users');
  assert.equal(plain.websiteUrl, null);
  assert.match(plain.nginx, /server_name <your-domain>;/);
});

// checkDomain over a scripted network: dns.lookup and fetch are stubbed, so
// every verdict is decided by the redirect chain alone.
function stubNet(t, { resolves = true, routes = {} }) {
  const dns = require('dns');
  t.mock.method(dns.promises, 'lookup', async (host) => {
    if (!resolves) { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; }
    return [{ address: '203.0.113.7', family: 4 }];
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    const r = routes[url];
    if (!r) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return new Response(r.status >= 300 && r.status < 400 ? null : 'x', { status: r.status, headers: r.location ? { location: r.location } : {} });
  });
}

test('checkDomain: no domain, no DNS, no HTTPS answer', async (t) => {
  assert.equal((await appManager.checkDomain('users')).status, 'no-domain');
  stubNet(t, { resolves: false });
  assert.equal((await appManager.checkDomain('domained')).status, 'dns');
  t.mock.restoreAll();
  stubNet(t, { routes: {} });
  const r = await appManager.checkDomain('domained');
  assert.equal(r.status, 'unreachable');
  assert.equal(r.ok, false);
});

test('checkDomain: the platform root 302 then a 200 is ok; the typed value is checked', async (t) => {
  stubNet(t, { routes: {
    'https://pixachat.com/': { status: 302, location: 'app.html' },
    'https://pixachat.com/app.html': { status: 200 },
  } });
  const r = await appManager.checkDomain('domained');
  assert.equal(r.status, 'ok');
  assert.equal(r.ok, true);
  assert.deepEqual(r.addresses, ['203.0.113.7']);
  // The unsaved field value wins over the recorded one.
  assert.equal((await appManager.checkDomain('users', 'other.example.com')).status, 'unreachable');
  await assert.rejects(appManager.checkDomain('users', 'bad/path'), /not a hostname/);
});

test('checkDomain: a login loop, an off-domain redirect and a bare 200 are not ok', async (t) => {
  stubNet(t, { routes: {
    'https://pixachat.com/': { status: 302, location: '/login' },
    'https://pixachat.com/login': { status: 302, location: '/login' },
  } });
  assert.equal((await appManager.checkDomain('domained')).status, 'loop');
  t.mock.restoreAll();
  stubNet(t, { routes: { 'https://pixachat.com/': { status: 301, location: 'https://host.example/' } } });
  assert.equal((await appManager.checkDomain('domained')).status, 'not-here');
  t.mock.restoreAll();
  stubNet(t, { routes: { 'https://pixachat.com/': { status: 200 } } });
  assert.equal((await appManager.checkDomain('domained')).status, 'not-here');
  t.mock.restoreAll();
  stubNet(t, { routes: { 'https://pixachat.com/': { status: 502 } } });
  assert.equal((await appManager.checkDomain('domained')).status, 'not-here');
});
