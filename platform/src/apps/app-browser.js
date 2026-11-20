// Hermetic headless renderer (platform capability `browser.screenshot`).
//
// Renders an app-provided HTML document plus the app's OWN on-disk assets to a
// PNG, with ZERO network egress. The browser never talks to the HTTP server (no
// loopback, no route, no token): every resource the page requests is fulfilled
// in-process via request interception, served either from the inline HTML or
// from files under the app's sandboxed `rootDir` (same `safeJoin` guard the `fs`
// bridge uses). Anything else — other origins, paths escaping the sandbox,
// missing files — is aborted, so the page has no ambient network access. SSRF
// and data-on-the-wire are gone by construction, not mitigated. There is
// deliberately no `{url}` mode.
//
// One shared Chromium is launched lazily and reused; an idle timer closes it to
// free RAM. The engine is the full `puppeteer` package (bundled Chromium), so it
// runs on a server with no system Chrome and no display.

const path = require('path');
const fs = require('fs');
const { safeJoin } = require('../utils');

// Synthetic origin for the rendered page. It never resolves — every request is
// intercepted before any DNS/network — but it gives relative specifiers
// (./tg/three-module.js, ./tg/body.glb) a base to resolve against.
const ORIGIN = 'https://render.local';
const ENTRY_PATH = '/index.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

const MAX_CONCURRENT = 4;

let _browserPromise = null;
let _idleTimer = null;
let _active = 0;
const IDLE_MS = 60_000;

async function getBrowser() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (_browserPromise) {
    try {
      const b = await _browserPromise;
      if (b.connected !== false && b.process()?.killed !== true) return b;
    } catch { /* fall through to relaunch */ }
    _browserPromise = null;
  }
  const puppeteer = require('puppeteer');
  _browserPromise = puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      // Software-rendered WebGL via ANGLE + SwiftShader: full WebGL with NO GPU
      // and no display. This is what lets three.js / WebGL canvases render in the
      // headless capture. (Do NOT add --disable-gpu — it suppresses this path and
      // makes getContext('webgl') return null.)
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--hide-scrollbars',
    ],
  });
  return _browserPromise;
}

function scheduleIdleClose() {
  if (_idleTimer) clearTimeout(_idleTimer);
  _idleTimer = setTimeout(async () => {
    _idleTimer = null;
    if (_active > 0 || !_browserPromise) return;
    const p = _browserPromise;
    _browserPromise = null;
    try { const b = await p; await b.close(); } catch { /* already gone */ }
  }, IDLE_MS);
  if (_idleTimer.unref) _idleTimer.unref();
}

// Render `html` (+ sandboxed local assets under rootDir) to a PNG Buffer.
//   { html, rootDir, appName?, width?, height?, deviceScaleFactor?, fullPage?,
//     waitForFunction?, timeoutMs? }
async function screenshot(opts) {
  const {
    html,
    rootDir,
    width = 1200,
    height = 630,
    deviceScaleFactor = 2,
    fullPage = false,
    waitForFunction,
    timeoutMs = 15_000,
  } = opts || {};

  if (typeof html !== 'string' || !html) throw new Error('screenshot: `html` (string) is required');
  if (!rootDir) throw new Error('screenshot: `rootDir` is required');
  const root = path.resolve(rootDir);

  if (_active >= MAX_CONCURRENT) throw new Error('screenshot: renderer busy, too many concurrent renders');

  _active++;
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({
      width: Math.max(1, Math.floor(width)),
      height: Math.max(1, Math.floor(height)),
      deviceScaleFactor: Math.max(1, Math.min(4, deviceScaleFactor)),
    });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      let url;
      try { url = new URL(req.url()); } catch { return req.abort(); }

      // Only our synthetic origin is serviceable; anything else (real hosts,
      // data: to other origins, etc.) has no network path → abort.
      if (`${url.protocol}//${url.host}` !== ORIGIN) return req.abort();

      // Entry document → the inline HTML.
      if (url.pathname === ENTRY_PATH || url.pathname === '/') {
        return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
      }

      // Any other same-origin path → a file under the app's sandbox. safeJoin
      // throws on traversal; a missing file or any error → abort.
      try {
        const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const filePath = safeJoin(root, rel);
        const body = fs.readFileSync(filePath);
        return req.respond({ status: 200, contentType: mimeFor(filePath), body });
      } catch {
        return req.abort();
      }
    });

    await page.goto(`${ORIGIN}${ENTRY_PATH}`, { waitUntil: 'load', timeout: timeoutMs });

    // Async-render gate: wait until the page signals it has drawn. Default looks
    // for window.__shotReady === true (set by the app once WebGL/canvas/async
    // content has rendered); a custom predicate can be supplied.
    const predicate = waitForFunction || 'window.__shotReady === true';
    await page.waitForFunction(predicate, { timeout: timeoutMs });

    return await page.screenshot({ type: 'png', fullPage });
  } finally {
    if (page) { try { await page.close(); } catch { /* ignore */ } }
    _active--;
    scheduleIdleClose();
  }
}

async function shutdown() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (!_browserPromise) return;
  const p = _browserPromise;
  _browserPromise = null;
  try { const b = await p; await b.close(); } catch { /* ignore */ }
}

module.exports = { screenshot, shutdown };
