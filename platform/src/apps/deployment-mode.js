// Deployment mode — a HOST fact that decides which spend profile applies.
//
//   local     this control room serves its owner on a trusted network
//   deployed  strangers can reach it: paired as a slave peer, or an app is
//             OPEN or has a domain. A users-level app (login required) is
//             deliberately NOT a signal: Telegram-only mini-apps do not expose
//             the host.
//
// Auto-detected from those signals; the admin can pin either mode in the host
// settings (spend-policy _host.json). Per-request LAN detection is deliberately
// NOT used — forwarded headers are spoofable, a host fact is not.
const spendPolicy = require('./spend-policy');

let deps = {};
let cached = null; // { at, value }
const CACHE_MS = 5000;

function init(options = {}) {
  deps = options; // { hostConfig, appManager }
  cached = null;
}

function autoDetect() {
  try { if (deps.hostConfig && deps.hostConfig.isSlave()) return { mode: 'deployed', reason: 'This host is paired as a slave peer' }; } catch {}
  try {
    const surfaces = require('./surfaces');
    for (const a of (deps.appManager ? deps.appManager.list() : [])) {
      if (!a) continue;
      if (surfaces.accessLevel(a) === 'open') return { mode: 'deployed', reason: `App "${a.name}" is open (reachable by anyone, no login)` };
      if (a.domain) return { mode: 'deployed', reason: `App "${a.name}" has a custom domain` };
    }
  } catch {}
  return { mode: 'local', reason: 'No slave pairing, open app or custom domain detected' };
}

// { mode, auto, reason, override }
function detect() {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const host = spendPolicy.loadHost();
  const auto = autoDetect();
  const override = host.mode === 'local' || host.mode === 'deployed' ? host.mode : null;
  const value = { mode: override || auto.mode, auto: auto.mode, reason: auto.reason, override, enforce: host.enforce !== false };
  cached = { at: now, value };
  return value;
}

function mode() { return detect().mode; }

function invalidate() { cached = null; }

function setOverride(value) {
  const v = value === 'local' || value === 'deployed' ? value : 'auto';
  spendPolicy.saveHost({ mode: v });
  cached = null;
  return detect();
}

module.exports = { init, detect, mode, invalidate, setOverride, autoDetect };
