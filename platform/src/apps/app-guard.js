// App failure guard — the ONE place an in-process app's runtime failures are
// recorded and attributed. Every site that invokes app code outside a request
// (Telegram/WhatsApp update handlers, engine event handlers, job runs, tool
// handlers, app-registered governance executors, routes.js setup, the per-app
// error middleware, process-app crashes) reports here instead of a bare
// console.error, so:
//   • the failure is counted per app (ring + sliding window),
//   • the dashboard learns about it (`app:runtimeError`, coalesced),
//   • the owner sees it in the core header bell (`toast:push`, coalesced),
//   • a failure storm becomes ONE `app:crashloop` per cooling window, which the
//     Horst bus turns into an app-triage proposal (platform-horst.js).
// Start failures come here too (app-manager.startApp, the own-process exit
// handler), as do browser errors from app iframes (`app:clientError`).
//
// No requires on app-manager / app-bridge / horst-* — the broadcaster is
// injected (init) and the module is usable with none (records still log).
// `horst` and `__*` pseudo-apps are ignored: platform-internal handlers keep
// their own logging and never count as app failures.

const RING_MAX = 50;                    // recent errors kept per app
const WINDOW_MS = 60 * 1000;            // crash-loop detection window
const CRASHLOOP_MIN = 10;               // failures within WINDOW_MS → crash loop
const COOLING_MS = 5 * 60 * 1000;       // one app:crashloop per cooling window
const BROADCAST_EVERY_MS = 5 * 1000;    // app:runtimeError coalescing per app
const ALERT_EVERY_MS = 60 * 1000;       // header alert per app and kind (start / runtime)
const ERROR_MAX = 500;                  // stored message length

let broadcaster = null;
const apps = new Map();                 // appName → state
const recorded = new WeakSet();         // error objects already recorded (attempt rethrows)

function init(options = {}) {
  broadcaster = options.broadcaster || null;
}

function isApp(name) {
  return typeof name === 'string' && name.length > 0 && name !== 'horst' && !name.startsWith('__');
}

function state(name) {
  let s = apps.get(name);
  if (!s) {
    s = { ring: [], window: [], total: 0, lastBroadcastAt: 0, pendingBroadcast: null, crashloopAt: 0, alertAt: { start: 0, runtime: 0 } };
    apps.set(name, s);
  }
  return s;
}

function message(err) {
  const m = err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err);
  return m.length > ERROR_MAX ? m.slice(0, ERROR_MAX) + '…' : m;
}

function prune(s, now) {
  const cutoff = now - WINDOW_MS;
  while (s.window.length && s.window[0] < cutoff) s.window.shift();
}

// A header alert in the core dashboard bell (core public/toast.js handles
// `toast:push`).
function raiseAlert(appName, title, msg) {
  if (!broadcaster) return;
  try { broadcaster.broadcast({ type: 'toast:push', sender: appName, level: 'error', title, message: msg, ts: Date.now() }); } catch {}
}

// A sync routes.js setup throw is a start failure too (it only runs at mount).
function isStartFailure(entry) {
  return entry.phase === 'start' || entry.surface === 'routes.setup';
}

function record(appName, surface, err, extra) {
  if (!isApp(appName)) return null;
  // One failure, one record: an error attempt() recorded and rethrew is not
  // counted again by a caller further up (app-manager.startApp).
  if (err && typeof err === 'object') {
    if (recorded.has(err)) return null;
    recorded.add(err);
  }
  const now = Date.now();
  const s = state(appName);
  const entry = { at: now, surface: String(surface || 'unknown'), error: message(err), ...(extra || {}) };
  s.ring.push(entry);
  if (s.ring.length > RING_MAX) s.ring.splice(0, s.ring.length - RING_MAX);
  s.total++;
  s.window.push(now);
  prune(s, now);
  console.error(`[app:${appName}] ${entry.surface} error: ${entry.error}`);

  // Coalesced dashboard notice — at most one per app per BROADCAST_EVERY_MS,
  // always carrying the latest count so a storm reads as a number, not a flood.
  if (broadcaster) {
    const send = () => {
      s.lastBroadcastAt = Date.now();
      s.pendingBroadcast = null;
      const last = s.ring[s.ring.length - 1];
      try { broadcaster.broadcast({ type: 'app:runtimeError', appName, surface: last.surface, error: last.error, count: s.total }); } catch {}
    };
    if (now - s.lastBroadcastAt >= BROADCAST_EVERY_MS) send();
    else if (!s.pendingBroadcast) {
      s.pendingBroadcast = setTimeout(send, BROADCAST_EVERY_MS - (now - s.lastBroadcastAt));
      s.pendingBroadcast.unref?.();
    }
  }

  // Crash loop: enough failures inside the window, announced once per cooling
  // window. The announcement is what the Horst bus reacts to.
  if (s.window.length >= CRASHLOOP_MIN && now - s.crashloopAt >= COOLING_MS) {
    s.crashloopAt = now;
    const surfaces = [...new Set(s.ring.slice(-s.window.length).map((e) => e.surface))];
    if (broadcaster) {
      try { broadcaster.broadcast({ type: 'app:crashloop', appName, count: s.window.length, windowMs: WINDOW_MS, lastError: entry.error, surfaces }); } catch {}
    }
    raiseAlert(appName, 'Crash loop', `${s.window.length} failures in a minute. Last: ${entry.surface}: ${entry.error}`);
  } else if (!(s.crashloopAt > 0 && now - s.crashloopAt < COOLING_MS)) {
    // Header alert: one per app per ALERT_EVERY_MS and kind; none while a crash
    // loop is announced (that alert already said it). The rest is on the card.
    const kind = isStartFailure(entry) ? 'start' : 'runtime';
    if (now - s.alertAt[kind] >= ALERT_EVERY_MS) {
      s.alertAt[kind] = now;
      const more = kind === 'runtime' && s.total > 1 ? ` (${s.total} errors so far)` : '';
      raiseAlert(appName, kind === 'start' ? 'Start failed' : 'Runtime error', `${entry.surface}: ${entry.error}${more}`);
    }
  }
  return entry;
}

// Fire-and-forget invocation of app code: sync and async failures are recorded
// and swallowed (the caller has nobody to report to).
function run(appName, surface, thunk) {
  try {
    const r = thunk();
    if (r && typeof r.then === 'function') r.then(undefined, (err) => { record(appName, surface, err); });
  } catch (err) {
    record(appName, surface, err);
  }
}

// Attributed invocation for callers that handle the error themselves: records
// and rethrows (sync or async).
function attempt(appName, surface, thunk) {
  let r;
  try { r = thunk(); }
  catch (err) { record(appName, surface, err); throw err; }
  if (r && typeof r.then === 'function') {
    return r.then(undefined, (err) => { record(appName, surface, err); throw err; });
  }
  return r;
}

function status(appName) {
  const s = apps.get(appName);
  if (!s) return { count: 0, lastAt: null, lastError: null, recent: [], crashloop: false };
  const now = Date.now();
  prune(s, now);
  const last = s.ring[s.ring.length - 1] || null;
  return {
    count: s.total,
    lastAt: last ? last.at : null,
    lastError: last ? `${last.surface}: ${last.error}` : null,
    recent: s.ring.slice(-5).map((e) => ({ at: e.at, surface: e.surface, error: e.error })),
    crashloop: s.crashloopAt > 0 && now - s.crashloopAt < COOLING_MS,
  };
}

function recent(appName, limit = RING_MAX) {
  const s = apps.get(appName);
  return s ? s.ring.slice(-limit) : [];
}

// A (re)start or stop opens a fresh detection window; the ring (history) stays.
// Exception: a restart right after a PROCESS crash keeps the window — an
// own-process app records exactly one failure per life, so a crash→restart→
// crash cycle (manual, autostart, or an auto-dial app.restart) must accumulate
// toward crashloop detection instead of being zeroed by every restart.
function resetWindow(appName) {
  const s = apps.get(appName);
  if (!s) return;
  const last = s.ring[s.ring.length - 1];
  if (!(last && last.surface === 'process' && Date.now() - last.at < WINDOW_MS)) {
    s.window = [];
    s.crashloopAt = 0;
  }
  if (s.pendingBroadcast) { clearTimeout(s.pendingBroadcast); s.pendingBroadcast = null; }
}

// Tests only.
function _reset() {
  for (const s of apps.values()) if (s.pendingBroadcast) clearTimeout(s.pendingBroadcast);
  apps.clear();
}

module.exports = {
  init, record, run, attempt, status, recent, resetWindow, isApp, _reset,
  WINDOW_MS, CRASHLOOP_MIN, COOLING_MS, BROADCAST_EVERY_MS, ALERT_EVERY_MS,
};
