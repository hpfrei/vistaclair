// Golden topology tests for the surfaces perimeter
// (docs/apps.md "Access levels").
//
// The golden is EXPLICIT: for every fixture app the exact set of probe paths
// that must be reachable without the owner cookie is written down here, per
// access level. Any exemption the builder produces that is not in the table —
// or any listed one it fails to produce — fails the suite. There is no
// "compare to the old code" reference any more: the table IS the contract.
const test = require('node:test');
const assert = require('node:assert/strict');

const surfaces = require('../src/apps/surfaces');

// --- Fixture fleet: one app per shape (and the real-world combinations) ---

const FLEET = [
  // plain private app, no auth (db-admin shape)
  { name: 'priv', manifest: {} },
  // the modal's cleared auth stub — still private
  { name: 'priv-stub', manifest: { auth: { telegram: false, email: false, sender: null } } },
  // users level, email only
  { name: 'users-email', manifest: { auth: { email: true } } },
  // a users-level app that still ships the old telegram.html: the file buys it
  // nothing any more — its surface is the derived `app` one, nothing else.
  { name: 'users-tgfile', manifest: { auth: { telegram: true } } },
  // the same file with no auth block at all: private, no cookieless surface.
  { name: 'tgfile-noauth', manifest: {} },
  // open: whole subtree, no login
  { name: 'open', manifest: { surfaces: { public: { pages: ['**'] } } } },
  // legacy open flag
  { name: 'open-legacy', manifest: { public: true } },
  // open + login method → fails closed to users
  { name: 'open-users', manifest: { auth: { email: true }, surfaces: { public: { pages: ['**'] } } } },
  // landing page only (no login)
  { name: 'landing', manifest: { surfaces: { public: { landing: 'landing.html' } } } },
  // legacy landing field
  { name: 'landing-legacy', manifest: { publicHome: 'landing.html' } },
  // malformed landing — must silently disable, never widen
  { name: 'landing-bad', manifest: { publicHome: '../../etc/passwd' } },
  // landing + users: landing wins at the root, entry surface still present
  { name: 'landing-users', manifest: { auth: { telegram: true }, surfaces: { public: { landing: 'landing.html' } } } },
  // narrow public page (my-podcast share.html)
  { name: 'pages', manifest: { surfaces: { public: { pages: ['share.html'] } } } },
  // a foreign entry name is ignored — the entry is derived, always `app`
  { name: 'entry-other', manifest: { auth: { email: true }, surfaces: { user: { entry: 'other' } } } },
  // an entry marker without a login method — nothing
  { name: 'entry-noauth', manifest: { surfaces: { user: { entry: 'app' } } } },
  // licence alone is not a login method
  { name: 'license-only', manifest: { auth: { license: 'x' } } },
  // pixachat shape (migrated manifest, marker kept)
  { name: 'pixachat', manifest: { auth: { telegram: true, whatsapp: true, email: true }, surfaces: { public: { api: ['/api/app', '/api/botqr'] }, user: { entry: 'app' } } } },
  // gymihorst shape after migration
  { name: 'gymihorst', manifest: { auth: { telegram: true, license: { product: 'g' } }, surfaces: { public: { api: ['/api/app/pdf', '/api/app/weblogin', '/api/app/events'] }, user: { entry: 'app' } } } },
  // a public page that claims `login` — the app owns the path, no trap
  { name: 'pages-login', manifest: { auth: { email: true }, surfaces: { public: { pages: ['log*'] } } } },
];

// Probes cover every shape any mechanism ever produced, plus the traversal
// attempts the segment-safe app/** shape must refuse.
const PROBES = [
  '', '/', '/index.html', '/style.css', '/share.html',
  '/telegram.html', '/telegram.css', '/telegram-app.js', '/tg/mod.js', '/tg/nested/x.js',
  '/api/tg', '/api/tg/session', '/api/tg/pdf/tok/report',
  '/api/auth/login', '/api/data', '/api/cron/nudges', '/api/botqr',
  '/landing.html', '/landing.htmlx',
  '/app.html', '/app.css', '/app.js', '/app-app.js',
  '/app/mod.js', '/app/MOD.js', '/app/sub/deep.glb', '/app/main.css', '/app/x',
  '/app/../index.html', '/app/./x.js', '/app/.hidden/x.js', '/app//x.js', '/app/',
  '/api/app', '/api/app/pub/pair', '/api/app/state', '/api/apps', '/api/api/x',
  '/__surface/kit.js', '/__surface/info',
  '/login', '/login/tg/start', '/loginx',
];

const NONE = [];
const ROOT = ['', '/'];
const ENTRY = [...ROOT, '/app.html', '/app.css', '/app/mod.js', '/app/MOD.js', '/app/sub/deep.glb', '/app/main.css', '/app/x',
  '/api/app', '/api/app/pub/pair', '/api/app/state'];
const KIT = ['/__surface/kit.js', '/__surface/info'];
const TRAP = ['/login']; // the login trap: where core's /login lands on a custom domain
const USERS = [...ENTRY, ...KIT, ...TRAP];
const ALL = PROBES.slice();

const EXPECTED = {
  'priv': NONE,
  'priv-stub': NONE,
  'users-email': USERS,
  'users-tgfile': USERS,
  'tgfile-noauth': NONE,
  'open': ALL,
  'open-legacy': ALL,
  'open-users': USERS,
  'landing': [...ROOT, '/landing.html', ...KIT, ...TRAP],
  'landing-legacy': [...ROOT, '/landing.html', ...KIT, ...TRAP],
  'landing-bad': NONE,
  'landing-users': [...USERS, '/landing.html'],
  'pages': ['/share.html', ...KIT],
  'entry-other': USERS,
  'entry-noauth': NONE,
  'license-only': NONE,
  'pixachat': USERS,
  'gymihorst': USERS,
  'pages-login': [...USERS, '/loginx'], // /login exempt by the page glob, not by the trap
};

function exemptSet(app) {
  const pats = surfaces.buildAppPatterns(app.name, app.manifest);
  return PROBES.filter((probe) => pats.some((re) => re.test(`/apps/${app.name}${probe}`)));
}

test('golden topology: every fixture exempts exactly the listed probes', () => {
  for (const app of FLEET) {
    assert.ok(EXPECTED[app.name], `no expectation for ${app.name}`);
    const want = [...new Set(EXPECTED[app.name])].sort();
    const have = exemptSet(app).sort();
    assert.deepEqual(have, want, `${app.name}: exempt set drifted`);
  }
});

test('golden topology: dot-segment and empty-segment probes are never exempt below open', () => {
  for (const app of FLEET) {
    if (surfaces.accessLevel(app.manifest) === 'open') continue;
    const pats = surfaces.buildAppPatterns(app.name, app.manifest);
    for (const probe of ['/app/../index.html', '/app/./x.js', '/app/.hidden/x.js', '/app//x.js', '/app/']) {
      assert.ok(!pats.some((re) => re.test(`/apps/${app.name}${probe}`)), `${app.name}${probe} must not be exempt`);
    }
  }
});

test('golden topology: no exemption ever crosses app namespaces', () => {
  for (const app of FLEET) {
    const pats = surfaces.buildAppPatterns(app.name, app.manifest);
    for (const other of FLEET) {
      if (other.name === app.name) continue;
      for (const probe of PROBES) {
        const p = `/apps/${other.name}${probe}`;
        assert.ok(!pats.some((re) => re.test(p)) || other.name.startsWith(app.name),
          `${app.name} pattern leaked onto ${p}`);
      }
    }
  }
});

// --- Access level derivation ---

test('accessLevel: the auth block is the level; open never coexists with users', () => {
  const lvl = (m) => surfaces.accessLevel(m);
  assert.equal(lvl({}), 'private');
  assert.equal(lvl({ auth: { telegram: false, email: false } }), 'private');
  assert.equal(lvl({ auth: { license: 'x' } }), 'private');
  assert.equal(lvl({ auth: { telegram: true } }), 'users');
  assert.equal(lvl({ auth: { whatsapp: true } }), 'users');
  assert.equal(lvl({ auth: { email: true } }), 'users');
  assert.equal(lvl({ public: true }), 'open');
  assert.equal(lvl({ surfaces: { public: { pages: ['**'] } } }), 'open');
  assert.equal(lvl({ auth: { email: true }, public: true }), 'users', 'fails closed');
  assert.deepEqual(surfaces.readSurfaces({ auth: { email: true }, surfaces: { public: { pages: ['**', 'share.html'] } } }).public.pages, ['share.html']);
  assert.deepEqual(surfaces.loginMethods({ auth: { telegram: true, email: true } }), ['telegram', 'email']);
});

test('readSurfaces: the entry is derived, the marker is only ever "app"', () => {
  assert.equal(surfaces.readSurfaces({ auth: { email: true } }).user.entry, 'app');
  assert.equal(surfaces.readSurfaces({ auth: { email: true }, surfaces: { user: { entry: 'other' } } }).user.entry, 'app');
  assert.equal(surfaces.readSurfaces({ surfaces: { user: { entry: 'app' } } }).user.entry, null);
  assert.equal(surfaces.readSurfaces({ auth: { license: 'x' }, surfaces: { user: { entry: 'app' } } }).user.entry, null);
  assert.equal(surfaces.readSurfaces({ entry: 'app', auth: { email: true } }).user.entry, 'app', 'legacy top-level entry field is irrelevant now');
});

test('readSurfaces: legacy fields normalize into the canonical shape', () => {
  const s = surfaces.readSurfaces({
    publicHome: 'landing.html',
    auth: { email: true, publicRoutes: ['/api/feed'] },
  });
  assert.equal(s.level, 'users');
  assert.equal(s.public.landing, 'landing.html');
  assert.deepEqual(s.public.api, ['/api/feed']);
  const t = surfaces.readSurfaces({ publicHome: 'old.html', surfaces: { public: { landing: 'new.html' } } });
  assert.equal(t.public.landing, 'new.html', 'explicit surfaces win over the legacy field');
});

// --- app-auth guard prefixes ---

test('guard prefixes: /api/app/pub is implicit at level users; declared extras follow; legacy publicRoutes fold in', () => {
  assert.deepEqual(surfaces.publicApiPrefixes({ auth: { email: true } }), ['/api/app/pub']);
  assert.deepEqual(surfaces.publicApiPrefixes({ auth: { email: true, publicRoutes: ['/api/feed'] } }), ['/api/app/pub', '/api/feed']);
  assert.deepEqual(surfaces.publicApiPrefixes({ auth: { email: true }, surfaces: { public: { api: ['/api/app', '/api/botqr'] } } }), ['/api/app/pub', '/api/app', '/api/botqr']);
  assert.deepEqual(surfaces.publicApiPrefixes({}), [], 'a private app has no guard and no exemptions');
  assert.deepEqual(surfaces.publicApiPrefixes({ surfaces: { public: { api: ['/api/feed'] } } }), ['/api/feed']);
});

test('guard prefixes: matcher semantics (prefix + slash, trailing slash verbatim)', () => {
  const m = { auth: { email: true }, surfaces: { public: { api: ['/api/feed', '/api/pub/'] } } };
  const prefixes = surfaces.publicApiPrefixes(m);
  const allows = (p) => {
    if (!p.startsWith('/api/')) return true;
    if (p.startsWith('/api/auth/')) return true;
    return prefixes.some((pre) => p === pre || p.startsWith(pre.endsWith('/') ? pre : pre + '/'));
  };
  assert.ok(allows('/api/feed') && allows('/api/feed/1') && !allows('/api/feedx'));
  assert.ok(allows('/api/pub/x') && !allows('/api/pub'));
  assert.ok(allows('/api/app/pub/landing') && !allows('/api/app/pubx') && !allows('/api/app/state'));
  assert.ok(!allows('/api/data') && allows('/api/auth/login') && allows('/static.js'));
});

test('guard prefixes never lift the owner cookie (public.api contributes no exempt patterns)', () => {
  const m = { auth: { email: true }, surfaces: { public: { api: ['/api/cron/nudges'] } } };
  const pats = surfaces.buildAppPatterns('x-app', m);
  assert.ok(!pats.some((re) => re.test('/apps/x-app/api/cron/nudges')),
    'a guard exemption must not become an owner-cookie exemption');
});

// --- Validation posture ---

test('validation posture: malformed values disable, never widen', () => {
  assert.equal(surfaces.validLandingPath('../x.html'), null);
  assert.equal(surfaces.validLandingPath('/abs.html'), null);
  assert.equal(surfaces.validLandingPath('a/./b.html'), null);
  assert.equal(surfaces.validLandingPath('landing.html'), 'landing.html');
  assert.equal(surfaces.validPageGlob('../secret/**'), null);
  assert.equal(surfaces.validPageGlob('/abs/*'), null);
  assert.equal(surfaces.validPageGlob('share.html'), 'share.html');
  assert.equal(surfaces.validPageGlob('app/*'), 'app/*');
  assert.equal(surfaces.validPageGlob('**'), '**');
  assert.equal(surfaces.validApiPrefix('/api/auth/steal'), null, 'api/auth is never a declarable exemption');
  assert.equal(surfaces.validApiPrefix('/notapi/x'), null);
  assert.equal(surfaces.validApiPrefix('/api/../x'), null);
  assert.equal(surfaces.validApiPrefix('/api/feed/'), '/api/feed/', 'trailing slash kept verbatim — significant to the guard matcher');
});

test('page globs: * stays inside a segment, ** crosses segments, regex chars are inert', () => {
  const m = { surfaces: { public: { pages: ['docs/*', 'files/**', 'a.b.html'] } } };
  const pats = surfaces.buildAppPatterns('g', m);
  const hit = (p) => pats.some((re) => re.test(p));
  assert.ok(hit('/apps/g/docs/mod.js'));
  assert.ok(!hit('/apps/g/docs/sub/mod.js'), '* must not cross a segment');
  assert.ok(hit('/apps/g/files/a/b/c.html'), '** crosses segments');
  assert.ok(hit('/apps/g/a.b.html'));
  assert.ok(!hit('/apps/g/aXbYhtml'), 'dots must be literal, not regex wildcards');
});

// --- Helpers the request path uses ---

test('root redirect: landing wins over app.html; open and private never redirect', () => {
  assert.equal(surfaces.rootRedirectTarget({ auth: { email: true }, surfaces: { public: { landing: 'l.html' } } }), 'l.html');
  assert.equal(surfaces.rootRedirectTarget({ auth: { email: true } }), 'app.html');
  assert.equal(surfaces.rootRedirectTarget({ public: true, publicHome: 'l.html' }), null);
  assert.equal(surfaces.rootRedirectTarget({}), null);
  assert.equal(surfaces.rootRedirectTarget({ surfaces: { user: { entry: 'app' } } }), null, 'no login method → no cookieless entry');
  assert.equal(surfaces.rootRedirectTarget({ surfaces: { public: { landing: 'l.html' } } }), 'l.html');
});

test('login trap: sends non-owners to the root target, never where a page claims it', () => {
  assert.equal(surfaces.loginRedirectTarget({ auth: { telegram: true } }), 'app.html');
  assert.equal(surfaces.loginRedirectTarget({ auth: { email: true }, surfaces: { public: { landing: 'l.html' } } }), 'l.html');
  assert.equal(surfaces.loginRedirectTarget({ surfaces: { public: { landing: 'l.html' } } }), 'l.html');
  assert.equal(surfaces.loginRedirectTarget({ public: true }), null);
  assert.equal(surfaces.loginRedirectTarget({}), null);
  assert.equal(surfaces.loginRedirectTarget({ auth: { email: true }, surfaces: { public: { pages: ['log*'] } } }), null);
  // the trap pattern exists exactly where the target does
  for (const app of FLEET) {
    const trapped = surfaces.buildAppPatterns(app.name, app.manifest).some((re) => re.source === `^\\/apps\\/${app.name}\\/login$`);
    const target = surfaces.loginRedirectTarget(app.manifest);
    assert.equal(trapped, !!target && surfaces.accessLevel(app.manifest) !== 'open', app.name);
  }
});

test('isFullyPublic / hasPublicSurface', () => {
  assert.ok(surfaces.isFullyPublic({ public: true }));
  assert.ok(surfaces.isFullyPublic({ surfaces: { public: { pages: ['**'] } } }));
  assert.ok(!surfaces.isFullyPublic({ auth: { email: true }, public: true }));
  assert.ok(!surfaces.isFullyPublic({ surfaces: { public: { pages: ['share.html'] } } }));

  assert.ok(surfaces.hasPublicSurface({ publicHome: 'l.html' }));
  assert.ok(surfaces.hasPublicSurface({ auth: { email: true } }));
  assert.ok(surfaces.hasPublicSurface({ auth: { telegram: true } }), 'users level is a kit surface');
  assert.ok(surfaces.hasPublicSurface({ public: true }));
  assert.ok(surfaces.hasPublicSurface({ surfaces: { public: { pages: ['share.html'] } } }));
  assert.ok(!surfaces.hasPublicSurface({}));
  assert.ok(!surfaces.hasPublicSurface({ auth: { license: 'x' } }));
});

test('describePatterns renders the same shapes the builder compiles', () => {
  const d = surfaces.describePatterns('pixachat', { auth: { email: true } });
  assert.deepEqual(d, ['/apps/pixachat/', '/apps/pixachat/app.html', '/apps/pixachat/app.css', '/apps/pixachat/app/**', '/apps/pixachat/api/app/*', '/apps/pixachat/login', '/apps/pixachat/__surface/*']);
  assert.deepEqual(surfaces.describePatterns('o', { public: true }), ['/apps/o/**']);
  assert.deepEqual(surfaces.describePatterns('p', {}), []);
});

// --- Landing kit (surface-kit.js) ---

test('surface kit: asset allowlist is traversal-proof and info is gated on a public surface', () => {
  const kit = require('../src/apps/surface-kit');
  // buildInfo never leaks more than method flags + public identity
  const info = kit.buildInfo('x', { title: 'X', description: 'd', auth: { email: true, license: { product: 'x-pro' } }, surfaces: { public: { landing: 'l.html' } } });
  assert.deepEqual(Object.keys(info).sort(), ['app', 'description', 'entry', 'landing', 'license', 'methods', 'title']);
  assert.equal(info.license.product, 'x-pro');
  assert.equal(info.methods.email, true);
  assert.equal(info.landing, 'l.html');
  assert.equal(info.entry, 'app');

  // middleware: URL shapes that must fall through (next) rather than serve
  const mw = kit.middleware();
  const misses = ['/x/__surface/../secret.js', '/x/__surface/a/b.js', '/x/__surface/.env', '/x/__surface/kit.exe', '/x/other/kit.js'];
  for (const url of misses) {
    let nexted = false;
    mw({ url, method: 'GET' }, {}, () => { nexted = true; });
    assert.ok(nexted, `${url} must not be served`);
  }
});
