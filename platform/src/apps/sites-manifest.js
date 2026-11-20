'use strict';
// The manifest's `sites` block: the one validator (app-lint and the sites
// engine both call it). Pure: no requires beyond fs/path, so app-lint stays cheap.
//
//   "sites": { "<site>": { handler, defaultPort, bind, autostart, access, platform, analytics } }
//
// docs/sites.md. P1 builds access "public" and platform "none" | "controlled";
// the other values are refused with a "not built yet" message.

const fs = require('fs');
const path = require('path');

const SITE_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const BINDS = ['127.0.0.1', '0.0.0.0'];
const ACCESS_BUILT = ['public'];
const ACCESS_LATER = ['users', 'vc'];
const PLATFORM_BUILT = ['none', 'controlled'];
const PLATFORM_LATER = ['loose'];
const KNOWN_KEYS = new Set(['handler', 'defaultPort', 'bind', 'autostart', 'access', 'platform', 'analytics']);
const MIN_PORT = 1024;
const RESERVED_PORTS = [3456, 3457]; // core's proxy and dashboard defaults; the engine adds the live ones

function validPort(p) { return Number.isInteger(p) && p >= MIN_PORT && p <= 65535; }

// -> { errors: [msg], warnings: [msg], sites: { name: normalised } }. `appDir`
// (optional) also checks that the handler file exists.
function validateSites(block, { appDir = null, reservedPorts = RESERVED_PORTS } = {}) {
  const errors = [];
  const warnings = [];
  const sites = {};
  if (block === undefined || block === null) return { errors, warnings, sites };
  if (typeof block !== 'object' || Array.isArray(block)) {
    errors.push('"sites" must be an object of { "<site>": { … } }');
    return { errors, warnings, sites };
  }
  const ports = new Map();
  for (const [name, raw] of Object.entries(block)) {
    const at = `sites.${name}`;
    if (!SITE_NAME_RE.test(name)) { errors.push(`${at}: a site name is lowercase letters, digits and "-", starting with a letter (≤ 31 chars)`); continue; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${at}: must be an object`); continue; }
    for (const k of Object.keys(raw)) if (!KNOWN_KEYS.has(k)) warnings.push(`${at}.${k}: unknown key (known: ${[...KNOWN_KEYS].join(', ')})`);
    const s = {};
    // handler: a .js file inside a subdirectory of the app (the fence grants that directory, never the app root)
    const h = raw.handler;
    if (typeof h !== 'string' || !h.trim()) errors.push(`${at}.handler: required, e.g. "site/index.js"`);
    else {
      const norm = h.replace(/\\/g, '/').replace(/^\.\//, '');
      if (path.isAbsolute(h) || norm.split('/').some(seg => seg === '..' || seg === '')) errors.push(`${at}.handler: a relative path inside the app, without ".."`);
      else if (!norm.includes('/')) errors.push(`${at}.handler: must live in its own directory (e.g. "site/index.js"), not the app root — the site may read only that directory`);
      else if (norm.split('/').some(seg => seg.startsWith('.'))) errors.push(`${at}.handler: no dot-directories in the path`);
      else if (!/\.(c?js)$/.test(norm)) errors.push(`${at}.handler: a .js or .cjs file`);
      else if (appDir && !fs.existsSync(path.join(appDir, norm))) errors.push(`${at}.handler: ${norm} does not exist`);
      else s.handler = norm;
    }
    // defaultPort
    if (!validPort(raw.defaultPort)) errors.push(`${at}.defaultPort: an integer ${MIN_PORT}–65535`);
    else if (reservedPorts.includes(raw.defaultPort)) errors.push(`${at}.defaultPort: ${raw.defaultPort} is the dashboard's or the proxy's port`);
    else if (ports.has(raw.defaultPort)) errors.push(`${at}.defaultPort: ${raw.defaultPort} is also the port of sites.${ports.get(raw.defaultPort)}`);
    else { ports.set(raw.defaultPort, name); s.defaultPort = raw.defaultPort; }
    // bind
    const bind = raw.bind === undefined ? '127.0.0.1' : raw.bind;
    if (!BINDS.includes(bind)) errors.push(`${at}.bind: "127.0.0.1" (default) or "0.0.0.0"`);
    else s.bind = bind;
    // autostart
    if (raw.autostart !== undefined && typeof raw.autostart !== 'boolean') errors.push(`${at}.autostart: true or false`);
    else s.autostart = raw.autostart !== false;
    // access (required: the exposure decision is explicit)
    if (raw.access === undefined) errors.push(`${at}.access: required — "public" (anyone who reaches the port or domain)`);
    else if (ACCESS_LATER.includes(raw.access)) errors.push(`${at}.access: "${raw.access}" is not built yet — only "public" sites exist today`);
    else if (!ACCESS_BUILT.includes(raw.access)) errors.push(`${at}.access: "public" (also planned, not built yet: "users", "vc")`);
    else s.access = raw.access;
    // platform (what the site may use from the platform)
    const platform = raw.platform === undefined ? 'none' : raw.platform;
    if (PLATFORM_LATER.includes(platform)) errors.push(`${at}.platform: "${platform}" is not built yet — use "none" (default) or "controlled"`);
    else if (!PLATFORM_BUILT.includes(platform)) errors.push(`${at}.platform: "none" (default) or "controlled"`);
    else s.platform = platform;
    // analytics: opt in to the platform's privacy-friendly counting (docs/analytics.md)
    let analytics = false;
    if (raw.analytics !== undefined && typeof raw.analytics !== 'boolean') errors.push(`${at}.analytics: true or false`);
    else analytics = raw.analytics === true;
    if (Object.keys(s).length === 6) sites[name] = { ...s, analytics };
  }
  return { errors, warnings, sites };
}

module.exports = { validateSites, validPort, SITE_NAME_RE, BINDS, RESERVED_PORTS, MIN_PORT };
