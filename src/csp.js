// Content-Security-Policy for the dashboard's own responses (SECURITY.md
// "Content-Security-Policy" documents each allowance).
//
// Second layer behind the renderers' sanitizers (public/render-safe.js,
// ask-safe.js): markup that slips through still cannot run script, because
// script-src allows only files served by this origin, plus the checkout's
// lemon.js (below). Every library is vendored (public/vendor/), and no page
// has an inline <script> or on*= handler (test/csp.test.js keeps it so).
//
// Not applied under /apps/: the add-on sets its own headers there. An add-on
// router's responses are its own too (dropForAddons), so its pages keep the
// policy, or the lack of one, the add-on gives them. While an add-on whose
// client modules are not declared cspReady is loaded, the policy is sent
// report-only (src/addons.js cspBlockers).
//
// VISTACLAIR_CSP=off sends no header (emergency off-switch);
// VISTACLAIR_CSP=report-only sends Content-Security-Policy-Report-Only, so
// the browser console names each violation without blocking it.

const HEADER = 'Content-Security-Policy';
const REPORT_ONLY_HEADER = 'Content-Security-Policy-Report-Only';

const GOOGLE_FONTS_CSS = 'https://fonts.googleapis.com';
const GOOGLE_FONTS_FILES = 'https://fonts.gstatic.com';
// The Pro checkout overlay: lemon.js, loaded by pro-header.js only on the
// teaser, and the checkout it frames. A trusted third party: the only script
// origins besides 'self', as it is served live and cannot be pinned or
// vendored. app.lemonsqueezy.com/js/lemon.js redirects to assets.lemonsqueezy.com.
const LEMON_SCRIPT = ['https://app.lemonsqueezy.com', 'https://assets.lemonsqueezy.com'];
const LEMON_FRAMES = 'https://*.lemonsqueezy.com';

// [directive, sources]. Each allowance beyond 'self' says why.
const DIRECTIVES = [
  // Anything not named below (media, manifest, ...) stays same-origin.
  ['default-src', ["'self'"]],
  // No inline script, no eval; the one third-party origin is lemon.js.
  ['script-src', ["'self'", ...LEMON_SCRIPT]],
  // Inline style attributes are everywhere in the UI and in rendered html
  // fences; Monaco, MathJax and xterm inject <style> elements. Style cannot
  // run script. The Google Fonts stylesheet is the kit's face (index.html).
  ['style-src', ["'self'", "'unsafe-inline'", GOOGLE_FONTS_CSS]],
  // data: for MathJax/Monaco embedded faces; the Google Fonts files.
  ['font-src', ["'self'", 'data:', GOOGLE_FONTS_FILES]],
  // data: for pasted/inline images (render-safe.js allows data:image), blob:
  // for attachment previews (vc-composer.js createObjectURL).
  ['img-src', ["'self'", 'data:', 'blob:']],
  // Audio/video players: same-origin streams, data: URIs (Pro voice samples)
  // and blob: previews.
  ['media-src', ["'self'", 'data:', 'blob:']],
  // The dashboard WebSocket (ws: / wss: on this host). The font origins are
  // for the service worker, whose fetch() of the cached fonts counts as
  // connect (public/sw.js).
  ['connect-src', ["'self'", 'ws:', 'wss:', GOOGLE_FONTS_CSS, GOOGLE_FONTS_FILES]],
  // sw.js; blob: because Monaco starts each language worker from a blob that
  // importScripts its vendored workerMain.js. Only script already running
  // here can make a blob worker, and a worker has no DOM.
  ['worker-src', ["'self'", 'blob:']],
  // Apps are framed same-origin (/apps/<name>/); the LemonSqueezy checkout.
  ['frame-src', ["'self'", LEMON_FRAMES]],
  ['frame-ancestors', ["'self'"]],
  ['object-src', ["'none'"]],
  ['base-uri', ["'self'"]],
];

function buildPolicy() {
  return DIRECTIVES.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

// 'on' (default), 'off' or 'report-only', from VISTACLAIR_CSP.
function mode(env = process.env) {
  const v = String(env.VISTACLAIR_CSP || '').trim().toLowerCase();
  if (['off', '0', 'false', 'no'].includes(v)) return 'off';
  if (v === 'report-only') return 'report-only';
  return 'on';
}

function isAppsPath(reqPath) {
  return reqPath === '/apps' || reqPath.startsWith('/apps/');
}

// Express middleware; mount before every route that serves a page or asset.
// reportOnlyWhen() true downgrades an enforcing policy to report-only for that
// response: server.js passes "an add-on whose client modules still use inline
// handlers is loaded" (src/addons.js cspBlockers), so those keep working and
// their violations still show in the console.
function middleware({ env = process.env, reportOnlyWhen = () => false } = {}) {
  const m = mode(env);
  const policy = buildPolicy();
  return (req, res, next) => {
    if (m !== 'off' && !isAppsPath(req.path)) {
      const reportOnly = m === 'report-only' || !!reportOnlyWhen();
      res.setHeader(reportOnly ? REPORT_ONLY_HEADER : HEADER, policy);
    }
    next();
  };
}

// Mounted just before the add-on routers: a request that reaches them is the
// add-on's to answer, with its own headers.
function dropForAddons(req, res, next) {
  res.removeHeader(HEADER);
  res.removeHeader(REPORT_ONLY_HEADER);
  next();
}

module.exports = { HEADER, REPORT_ONLY_HEADER, DIRECTIVES, buildPolicy, mode, middleware, dropForAddons };
