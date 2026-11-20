// Surfaces — THE one perimeter declaration (docs/apps.md "Access levels",
// superseding 03-surfaces.md).
//
// In the open-world platform the perimeter is the only wall. This module is the
// single place that decides which of an app's paths an anonymous visitor may
// reach without the owner cookie. It is PURE: no logging, no filesystem, no
// clock — callers that want to warn (app-manager at mount, app-lint, the
// access CLI) do so themselves.
//
// The access LEVEL of an app is derived from its manifest, never toggled on
// its own:
//
//   private  no login method in `auth`            nothing is cookieless
//   users    auth.telegram | auth.whatsapp | auth.email
//            → the fixed `app` entry surface:      /apps/<n>/            (302 → app.html)
//                                                  /apps/<n>/app.html, app.css
//                                                  /apps/<n>/app/**      (any file, any depth)
//                                                  /apps/<n>/api/app/*   (behind app-auth's
//                                                    default-deny guard; /api/app/pub/* is the
//                                                    anonymous convention, guard-exempt)
//   open     surfaces.public.pages includes "**" AND no login method
//            → the whole subtree. Never combined with a login method: an app
//              with users (and usually a bot) must not be flipped open, so the
//              "**" is dropped (fail closed to `users`) when both are present.
//
// The manifest may additionally declare narrow anonymous surfaces (manifest-
// only escape hatches, not in the UI):
//
//   "surfaces": {
//     "public": {
//       "landing": "landing.html",       // served at the app root for non-owners (302)
//       "pages": ["share.html"],         // static globs exempt from the owner cookie
//       "api":   ["/api/feed"]           // extra app-auth guard exemptions (NOT cookie
//     }                                  //   exemptions — parity with the old auth.publicRoutes)
//   }                                    // (no `user` key: the entry surface is always
//                                        //  `app`, derived from `auth` — never declared)
//
// Semantics, precisely:
//   • public.pages — globs relative to the app subtree. `*` matches within one
//     path segment, `**` any depth. `["**"]` is the whole-subtree case (level open).
//   • public.landing — one page; the app ROOT and the page itself go cookie-
//     exempt so the anonymous 302 (index.js) can run instead of /login. The
//     landing wins over app.html at the root.
//   • public.api — prefix exemptions from app-auth's default-deny guard ONLY.
//   • The landing kit is served at /apps/<name>/__surface/* and is exempt by
//     construction for any app with an anonymous surface.
//   • The login trap: /apps/<name>/login is exempt wherever the root 302 runs
//     (unless a public page claims it), and index.js sends non-owners on to the
//     root target. A custom domain maps `/` onto the app subtree, so core's
//     absolute /login redirect arrives there — without the trap it loops.
//
// Path-safety: every pattern is anchored and segment-shaped (no segment may be
// empty, "." or ".."); index.js additionally refuses dot-segment requests
// before dispatch, because core matches exemptions against the raw path and
// express.static would normalise `app/../index.html` to the owner SPA.
//
// Back-compat: readSurfaces() normalizes the legacy fields (`public`,
// `publicHome`, `auth.publicRoutes`) into this shape at read time, in this one
// place. New writes (config modal, migrations) emit the canonical block.
//
// Posture throughout: a malformed value silently disables its feature rather
// than widening the exempt surface.

const ENTRY = 'app';                       // the one cookieless entry surface
const LOGIN_TRAP = 'login';                // where core's /login lands on a custom domain
const PUB_API_PREFIX = '/api/app/pub';     // anonymous API convention at level users
const LEVELS = ['private', 'users', 'open'];

function cleanName(name) {
  return String(name || '').replace(/[^a-z0-9-]/g, '');
}

// A simple relative path inside the app's own subtree ("landing.html",
// "public-pages/index.html"). No absolute prefix, no dot-segments, no
// backslash, nothing outside the safe set.
function validLandingPath(p) {
  if (typeof p !== 'string' || !p) return null;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(p)) return null; // no leading / or .
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return p;
}

// Page globs: the landing-path charset plus `*`. `**` alone is the whole-subtree
// case. Dot-segments and empty segments are rejected the same way.
function validPageGlob(g) {
  if (typeof g !== 'string' || !g) return null;
  if (g === '**') return g;
  if (!/^[A-Za-z0-9_*][A-Za-z0-9._*/-]*$/.test(g)) return null;
  if (g.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return g;
}

// Guard-exemption prefixes must live under /api/ (the guard only inspects /api/
// paths, so anything else was always dead) and never under /api/auth/ (already
// exempt with its own semantics). Returned VERBATIM — a trailing slash is
// significant to the guard's matcher ('/api/pub/' does not allow '/api/pub').
function validApiPrefix(p) {
  if (typeof p !== 'string') return null;
  if (!/^\/api\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(p)) return null;
  if (p.split('/').some((seg) => seg === '.' || seg === '..')) return null;
  if (p === '/api/auth' || p.startsWith('/api/auth/')) return null;
  return p;
}

function authBlock(manifest) {
  const auth = manifest && manifest.auth;
  return auth && typeof auth === 'object' ? auth : {};
}

// True when the manifest declares a login method — the ONE signal that lifts an
// app from private to users. It also mounts app-auth's default-deny guard,
// which is the precondition for the cookieless entry surface.
function hasLoginMethod(manifest) {
  const auth = authBlock(manifest);
  return !!(auth.email || auth.telegram || auth.whatsapp);
}

// The login channels an app declares (for the card chip and the CLI).
function loginMethods(manifest) {
  const auth = authBlock(manifest);
  return ['telegram', 'whatsapp', 'email'].filter((k) => !!auth[k]);
}

// Normalize a manifest into the canonical surfaces shape. Never throws; every
// invalid value is dropped. Legacy fields are folded in additively (an explicit
// `surfaces` value wins over the legacy field it replaces). The `**` glob is
// dropped when a login method is present (see the header).
function readSurfaces(manifest) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const s = m.surfaces && typeof m.surfaces === 'object' ? m.surfaces : {};
  const pub = s.public && typeof s.public === 'object' ? s.public : {};
  const login = hasLoginMethod(m);

  const pages = [];
  for (const g of Array.isArray(pub.pages) ? pub.pages : []) {
    const v = validPageGlob(g);
    if (v && !pages.includes(v)) pages.push(v);
  }
  const api = [];
  for (const p of Array.isArray(pub.api) ? pub.api : []) {
    const v = validApiPrefix(p);
    if (v && !api.includes(v)) api.push(v);
  }
  let landing = validLandingPath(pub.landing);

  // --- Legacy normalization (the back-compat shim, in its one place) ---
  if (m.public === true && !pages.includes('**')) pages.push('**');
  if (!landing) landing = validLandingPath(m.publicHome);
  for (const p of Array.isArray(authBlock(m).publicRoutes) ? authBlock(m).publicRoutes : []) {
    const v = validApiPrefix(p);
    if (v && !api.includes(v)) api.push(v);
  }

  // Open never coexists with users: drop the whole-subtree glob, keep the rest.
  const openIdx = pages.indexOf('**');
  if (openIdx >= 0 && login) pages.splice(openIdx, 1);

  const level = pages.includes('**') ? 'open' : login ? 'users' : 'private';
  return {
    level,
    public: { landing, pages, api },
    user: { entry: login ? ENTRY : null },
  };
}

// The derived access level: 'private' | 'users' | 'open'.
function accessLevel(manifest) {
  return readSurfaces(manifest).level;
}

// Whole-subtree public (level open). Kept as a named predicate for the spend
// overview pill and the tests.
function isFullyPublic(manifest) {
  return accessLevel(manifest) === 'open';
}

// Any anonymous-reachable surface at all (a level above private, a landing page
// or narrow public pages). Gates the landing-kit info endpoint.
function hasPublicSurface(manifest) {
  const s = readSurfaces(manifest);
  return s.level !== 'private' || !!s.public.landing || s.public.pages.length > 0;
}

// Where the app root should 302 non-owner visitors: the landing page wins over
// the entry surface (more specific); an open app redirects nowhere (its root
// already serves everyone). Returns a path relative to /apps/<name>/. The
// caller (index.js) checks that an `app.html` target actually exists.
function rootRedirectTarget(manifest) {
  const s = readSurfaces(manifest);
  if (s.level === 'open') return null;
  if (s.public.landing) return s.public.landing;
  if (s.user.entry) return `${s.user.entry}.html`;
  return null;
}

// True when a declared public page already serves `login` — the app owns the
// path then, and the trap stays out of its way.
function pagesClaimLogin(srf) {
  return srf.public.pages.some((g) => new RegExp(`^${pageGlobSource(g)}$`).test(LOGIN_TRAP));
}

// Where /apps/<name>/login sends non-owners (the login trap, see the header):
// the root target, or null when there is no trap (open, private without a
// landing, or a public page claiming the path).
function loginRedirectTarget(manifest) {
  const srf = readSurfaces(manifest);
  if (pagesClaimLogin(srf)) return null;
  return rootRedirectTarget(manifest);
}

// The prefixes app-auth's default-deny guard lets through without a session:
// the anonymous convention first (level users), then the declared extras
// (legacy auth.publicRoutes folded in by readSurfaces).
function publicApiPrefixes(manifest) {
  const s = readSurfaces(manifest);
  const out = [];
  if (s.user.entry) out.push(PUB_API_PREFIX);
  for (const p of s.public.api) if (!out.includes(p)) out.push(p);
  return out;
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// THE glob → regex-source compiler (pages only; `**` whole-subtree is special-
// cased by the caller). `**` matches any depth, `*` within one segment.
function pageGlobSource(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; } else out += '[^/]*';
    } else {
      out += escRe(c);
    }
  }
  return out;
}

// One path segment that can never be "", "." or "..": it must start with a
// word character and may then contain dots. Used for the app/** subtree.
const SEGMENT = '[A-Za-z0-9_-][A-Za-z0-9_.-]*';
const SUBTREE = `(?:${SEGMENT}/)*${SEGMENT}`;

// The `app` entry surface, anchored to one app. Exactly five shapes; the bare
// <entry>.js / <entry>-app.js shapes of the old generalized entry are gone
// (every app's public/app.js is its owner dashboard script).
function entrySurfacePatterns(name) {
  const n = cleanName(name);
  if (!n) return [];
  return [
    new RegExp(`^/apps/${n}/?$`),                        // root — lets the non-owner 302 run
    new RegExp(`^/apps/${n}/${ENTRY}\\.html$`),
    new RegExp(`^/apps/${n}/${ENTRY}\\.css$`),
    new RegExp(`^/apps/${n}/${ENTRY}/${SUBTREE}$`),      // app/** — any file, dot-safe segments
    new RegExp(`^/apps/${n}/api/${ENTRY}(/.*)?$`),
  ];
}

// Compile one app's normalized surfaces into owner-cookie exemption patterns.
// public.api contributes NOTHING here — guard-exemption only, by design.
function compilePatterns(name, srf) {
  const n = cleanName(name);
  if (!n) return [];
  const out = [];
  const pages = srf.public.pages;

  if (srf.level === 'open') {
    // Whole subtree (root included) — every other shape is subsumed.
    out.push(new RegExp(`^/apps/${n}(/.*)?$`));
    return out;
  }

  if (srf.public.landing) {
    // The root must be exempt so the anonymous 302 (index.js) can run instead
    // of core's /login redirect; the landing page must be self-contained.
    out.push(new RegExp(`^/apps/${n}/?$`));
    out.push(new RegExp(`^/apps/${n}/${escRe(srf.public.landing)}$`));
  }

  for (const g of pages) {
    out.push(new RegExp(`^/apps/${n}/${pageGlobSource(g)}$`));
  }

  if (srf.user.entry) out.push(...entrySurfacePatterns(n));

  // The login trap — index.js answers it, so it never reaches the app.
  if ((srf.public.landing || srf.user.entry) && !pagesClaimLogin(srf)) {
    out.push(new RegExp(`^/apps/${n}/${LOGIN_TRAP}$`));
  }

  // The landing kit (surface-kit.js) — exempt by construction wherever there is
  // an anonymous surface to serve it to.
  if (srf.public.landing || srf.user.entry || pages.length) {
    out.push(new RegExp(`^/apps/${n}/__surface(/.*)?$`));
  }

  return out;
}

// The one entry point for the exemption rebuild: everything the owner cookie
// must not gate for this app — all of it derived from the manifest.
function buildAppPatterns(name, manifest) {
  return compilePatterns(name, readSurfaces(manifest));
}

// Human-readable rendering of the exemption set (access CLI, config modal).
function describePatterns(name, manifest) {
  const n = cleanName(name);
  const srf = readSurfaces(manifest);
  const out = [];
  if (srf.level === 'open') return [`/apps/${n}/**`];
  if (srf.public.landing) out.push(`/apps/${n}/`, `/apps/${n}/${srf.public.landing}`);
  for (const g of srf.public.pages) out.push(`/apps/${n}/${g}`);
  if (srf.user.entry) {
    out.push(`/apps/${n}/`, `/apps/${n}/${ENTRY}.html`, `/apps/${n}/${ENTRY}.css`, `/apps/${n}/${ENTRY}/**`, `/apps/${n}/api/${ENTRY}/*`);
  }
  if ((srf.public.landing || srf.user.entry) && !pagesClaimLogin(srf)) out.push(`/apps/${n}/${LOGIN_TRAP}`);
  if (srf.public.landing || srf.user.entry || srf.public.pages.length) out.push(`/apps/${n}/__surface/*`);
  return [...new Set(out)];
}

module.exports = {
  ENTRY,
  LOGIN_TRAP,
  PUB_API_PREFIX,
  LEVELS,
  readSurfaces,
  accessLevel,
  loginMethods,
  hasLoginMethod,
  buildAppPatterns,
  compilePatterns,
  entrySurfacePatterns,
  describePatterns,
  isFullyPublic,
  hasPublicSurface,
  rootRedirectTarget,
  loginRedirectTarget,
  publicApiPrefixes,
  // exported for tests / validation reuse
  validLandingPath,
  validPageGlob,
  validApiPrefix,
  pageGlobSource,
};
