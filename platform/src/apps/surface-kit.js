// Landing kit (docs/apps.md "Landing kit") — the platform primitives a
// public-facing app needs on its anonymous surfaces, generalized from what
// pixachat had to hand-roll and what app-auth.js already provides server-side:
//
//   GET /apps/<name>/__surface/kit.js    the VistaSurface landing widget
//   GET /apps/<name>/__surface/kit.css   its theme (CSS custom properties)
//   GET /apps/<name>/__surface/info      per-app JSON the widget renders from:
//                                        enabled login methods, licence product,
//                                        the Telegram bot deep link, entry/landing
//
// The /__surface/* namespace is exempt from the owner cookie by construction —
// surfaces.compilePatterns adds it for every app that declares an anonymous
// surface (landing, pages, or a user entry) — and this middleware is mounted
// BEFORE the app dispatch in index.js, so app code can never shadow or spoof
// it. Apps opt in by referencing the kit from their landing page; nothing is
// forced on bespoke landings (pixachat's keeps working until migrated).
//
// The `info` endpoint is the only dynamic piece and it serves NOTHING secret:
// method flags, the app title/description, the public bot username, licence
// product slug. It still 404s for apps without a public surface so a private
// app's bot identity is not enumerable by the owner-cookie-less internet
// (private apps' /__surface/* is not cookie-exempt anyway — defense in depth).

const fs = require('fs');
const path = require('path');

const KIT_DIR = path.join(__dirname, '..', '..', 'public', 'surface-kit');

// Strict allowlist shape for static kit assets: single flat filename, js/css
// only. No separators, no dot-segments — nothing can escape KIT_DIR.
const ASSET_RE = /^[a-z0-9][a-z0-9-]*\.(?:js|css)$/;

function buildInfo(name, manifest) {
  const surfaces = require('./surfaces');
  const auth = manifest.auth && typeof manifest.auth === 'object' ? manifest.auth : {};
  const srf = surfaces.readSurfaces(manifest);

  let telegram = null;
  if (auth.telegram) {
    try {
      const bot = require('./telegram').getBot(name);
      if (bot && bot.botUsername) {
        telegram = { username: bot.botUsername, link: `https://t.me/${bot.botUsername}?start=link` };
      }
    } catch {}
  }

  return {
    app: name,
    title: typeof manifest.title === 'string' && manifest.title ? manifest.title : name,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    methods: { email: !!auth.email, telegram: !!auth.telegram, whatsapp: !!auth.whatsapp },
    // Tier variants + checkout links come from GET api/auth/license/products
    // (already auth-exempt); this only says whether the section exists.
    license: auth.license ? { product: (auth.license && auth.license.product) || (typeof auth.license === 'string' ? auth.license : null) } : null,
    entry: srf.user.entry,
    landing: srf.public.landing,
  };
}

// Express middleware for the pro /apps router: serves /<app>/__surface/<asset>.
function middleware() {
  return (req, res, next) => {
    const m = req.url.match(/^\/([a-z0-9][a-z0-9-]*)\/__surface\/([^/?#]+)(\?.*)?$/);
    if (!m) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const [, name, asset] = m;

    let manifest = null;
    try { manifest = require('./app-manager').readManifest(name); } catch {}
    if (!manifest) return next();

    if (asset === 'info') {
      if (!require('./surfaces').hasPublicSurface(manifest)) return res.status(404).json({ error: 'no_public_surface' });
      res.set('Cache-Control', 'no-cache');
      return res.json(buildInfo(name, manifest));
    }

    if (!ASSET_RE.test(asset)) return next();
    const file = path.join(KIT_DIR, asset);
    if (!fs.existsSync(file)) return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(file);
  };
}

module.exports = { middleware, buildInfo };
