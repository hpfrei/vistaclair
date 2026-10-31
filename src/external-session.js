// External sessions: an Agent SDK session that runs somewhere else (Pro's
// remote sessions, on a federation peer) shown as a normal SDK tab. An add-on
// registers one with ctx.registerExternalSession(tabId, adapter) (see
// src/addon-host.js); CliSessionManager keeps it apart from its own sessions,
// so nothing that spawns, persists, kills, pauses or resumes sessions sees it.
//
//   adapter        { sessId, kind: 'sdk', hidden?, title, settings, running,
//                  busy, state (read live, getters allowed), submit(text,
//                  { images }), interrupt(), setModel(m), setShowThinking(on),
//                  setAuth(auth, { continueTurn }), historyPage({ limit,
//                  before }), kill(), close(), orchestration?() }
//   facade         ExternalSession: the session surface the manager's lookups
//                  (list, getBySessId, sessionDirOf) and cli-handler read.
//                  Every read of the adapter is guarded (a throwing getter
//                  reads as its default); every call goes through call(),
//                  which turns a sync throw into a rejected promise.
//   untrusted      title and settings relay another machine's data. settings
//                  is copied through JSON (no getters, no cycles reach a
//                  broadcast), refused whole above MAX_SETTINGS bytes, and
//                  only SETTINGS' fields survive, type-checked and capped;
//                  a sessionDir outside DATA_HOME (after symlinks) is dropped.
//                  A call() the adapter leaves unanswered rejects after
//                  ExternalSession.callTimeoutMs; its late result is ignored.
//   asks           askOwner / answerRefusal: a pending question of an external
//                  tab is answered only by an ask:answer naming that tab.

const fs = require('fs');
const path = require('path');
const { DATA_HOME } = require('./utils');

const MAX_TAB_ID = 100;
const MAX_TITLE = 200;
const MAX_HOST = 100;
const MAX_STATE = 40;
const MAX_SETTINGS = 16 * 1024;
const MAX_PATH = 4096;
const MAX_ID = 100;
const CALL_TIMEOUT_MS = 30 * 1000;
const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
const TAB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SESS_ID_RE = /^[0-9a-f-]{36}$/i;
const METHODS = ['submit', 'interrupt', 'setModel', 'setShowThinking', 'setAuth', 'historyPage', 'kill', 'close'];

function cap(v, n) {
  return v == null ? '' : String(v).slice(0, n);
}

// A string field: capped, or undefined (dropped) when not a non-empty string.
const str = (n) => (v) => (typeof v === 'string' && v ? v.slice(0, n) : undefined);
const oneOf = (...allowed) => (v) => (allowed.includes(v) ? v : undefined);

// The settings an external tab may carry, as an SDK tab's: field -> its check
// (undefined drops it). engine is always 'sdk'.
const SETTINGS = {
  auth: oneOf('apikey', 'subscription'),
  sessionDir: (v) => (typeof v === 'string' && v.length <= MAX_PATH ? insideDataHome(v) : undefined),
  externalHost: str(MAX_HOST),
  model: str(MAX_TITLE),
  showThinking: (v) => (typeof v === 'boolean' ? v : undefined),
  name: str(MAX_ID),
  modelMap: (v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(MODEL_FAMILIES.map(f => [f, str(MAX_TITLE)(v[f]) || null]))
    : undefined),
  orchestration: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const o = pick(v, {
      runId: str(MAX_ID), role: oneOf('orchestrator', 'worker'), workerId: str(MAX_ID),
      orchestrator: str(MAX_ID), name: str(MAX_ID),
    });
    return o.runId ? o : undefined;
  },
};

function pick(src, checks) {
  const out = {};
  for (const [k, check] of Object.entries(checks)) {
    const v = check(src[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// `dir` resolved, symlinks included (of the part that exists), when that lies
// strictly inside DATA_HOME; else undefined.
function insideDataHome(dir) {
  try {
    const home = fs.realpathSync(DATA_HOME);
    const real = realpathExisting(path.resolve(DATA_HOME, dir));
    return real.startsWith(home + path.sep) ? real : undefined;
  } catch { return undefined; }
}

// realpath of the longest existing prefix, the rest appended.
function realpathExisting(p) {
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(p), ...rest); } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
    }
    const up = path.dirname(p);
    if (up === p) throw new Error('no existing ancestor');
    rest.unshift(path.basename(p));
    p = up;
  }
}

// An adapter's settings as an external tab shows them: copied, allowlisted.
function cleanSettings(raw) {
  let s = null;
  try {
    const json = JSON.stringify(raw || {});
    if (json && json.length <= MAX_SETTINGS) s = JSON.parse(json);
  } catch {}
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  return { engine: 'sdk', ...pick(s, SETTINGS) };
}

// Throws on a malformed tabId or adapter (registerExternalSession's refusal).
function validate(tabId, adapter) {
  if (typeof tabId !== 'string' || !tabId || tabId.length > MAX_TAB_ID || !TAB_ID_RE.test(tabId)) {
    throw new Error(`external session: tabId must be 1-${MAX_TAB_ID} characters of [A-Za-z0-9._:-]`);
  }
  if (!adapter || typeof adapter !== 'object') throw new Error('external session: adapter must be an object');
  if (!SESS_ID_RE.test(String(adapter.sessId || ''))) throw new Error('external session: adapter.sessId must be a UUID');
  if (adapter.kind !== 'sdk') throw new Error("external session: adapter.kind must be 'sdk'");
  for (const m of METHODS) {
    if (typeof adapter[m] !== 'function') throw new Error(`external session: adapter.${m} must be a function`);
  }
  if (adapter.orchestration != null && typeof adapter.orchestration !== 'function') {
    throw new Error('external session: adapter.orchestration must be a function');
  }
}

class ExternalSession {
  constructor(tabId, adapter) {
    validate(tabId, adapter);
    this.tabId = tabId;
    this.adapter = adapter;
    this.external = true;
    this.kind = 'sdk';
    // Fixed at register: the id every sdk:* message names the session by.
    this.sessId = String(adapter.sessId);
    this.instanceId = `cli-${this.sessId}`;
    this.cwd = null;
    this.autoMemory = false;
    this.pausing = false;
  }

  // One adapter property; `fallback` when reading it throws.
  _read(key, fallback) {
    try { const v = this.adapter[key]; return v === undefined ? fallback : v; } catch { return fallback; }
  }

  get hidden() { return this._read('hidden', false) === true; }
  get title() { return cap(this._read('title', ''), MAX_TITLE) || null; }
  get running() { return this._read('running', false) === true; }
  get busy() { return this._read('busy', false) === true; }
  get state() { return cap(this._read('state', 'idle'), MAX_STATE) || 'idle'; }
  get status() { return this.running ? 'running' : 'exited'; }
  get costUsd() {
    const n = Number(this._read('costUsd', 0));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  getSettings() {
    return cleanSettings(this._read('settings', {}));
  }

  // The settings belong to the add-on: core's in-place updates (cli-isolation's
  // worktree record) do not reach them.
  updateSettings() {}

  // adapter[method](...args) as a promise: a sync throw, a rejection and no
  // answer within ExternalSession.callTimeoutMs all reject, with an Error.
  call(method, ...args) {
    let result;
    try {
      const fn = this.adapter[method];
      if (typeof fn !== 'function') return Promise.reject(new Error(`the external session has no ${method}()`));
      result = Promise.resolve(fn.apply(this.adapter, args)).catch((e) => { throw asError(e); });
    } catch (e) {
      return Promise.reject(asError(e));
    }
    const ms = ExternalSession.callTimeoutMs;
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`the external session did not answer ${method}() within ${ms / 1000} s`)), ms);
      if (timer.unref) timer.unref();
    });
    // The loser of the race settles unobserved: a late rejection is handled.
    result.catch(() => {});
    return Promise.race([result, timeout]).finally(() => clearTimeout(timer));
  }

  hasOrchestration() {
    return typeof this._read('orchestration', null) === 'function';
  }

  // The tab as CliSessionManager.list() shows an SDK tab, plus `external`.
  entry() {
    return {
      tabId: this.tabId,
      kind: 'sdk',
      instanceId: this.instanceId,
      sessId: this.sessId,
      autoMemory: false,
      status: this.status,
      cwd: null,
      title: this.title,
      settings: this.getSettings(),
      busy: this.busy,
      pausing: false,
      state: this.state,
      costUsd: this.costUsd,
      external: true,
    };
  }

  // What SdkSession.spawn broadcasts.
  spawnedMessage() {
    return {
      type: 'cli:spawned',
      tabId: this.tabId,
      instanceId: this.instanceId,
      cwd: null,
      title: this.title,
      settings: this.getSettings(),
      autoMemory: false,
      hidden: this.hidden,
      kind: 'sdk',
      external: true,
    };
  }
}

// How long call() waits for the adapter (tests lower it).
ExternalSession.callTimeoutMs = CALL_TIMEOUT_MS;

// The add-on's error as one for a reply: its message only, capped.
function asError(e) {
  return new Error(cap(e?.message ?? e, 500) || 'external session error');
}

// --- Asks (pendingQuestions entries, answered by dashboard-ws's ask:answer) ---

// Whom a pending question belongs to: { external, tabId, sessId }. External
// when the entry says so (`external: true`, the add-on's tag), carries a
// relayed ask's `host` / `remote` (or its message does), or its tab is an
// external session's. Marks an external entry (external, tabId, sessId).
function askOwner(entry, mgr) {
  if (!entry || typeof entry !== 'object') return { external: false, tabId: null, sessId: null };
  const msg = entry.message && typeof entry.message === 'object' ? entry.message : {};
  const tabOf = (...vs) => vs.find(v => typeof v === 'string' && v) || null;
  const extTab = [entry.tabId, entry.ctx?.tabId, msg.tabId, entry.remote?.tabId, msg.remote?.tabId]
    .find(t => typeof t === 'string' && mgr?.getExternal?.(t)) || null;
  const external = entry.external === true || entry.host != null || entry.remote != null
    || msg.host != null || msg.remote != null || !!extTab;
  if (!external) {
    return { external: false, tabId: tabOf(entry.tabId, msg.tabId, entry.ctx?.tabId), sessId: tabOf(entry.sessId) };
  }
  const tabId = tabOf(entry.tabId, extTab, entry.ctx?.tabId, msg.tabId, entry.remote?.tabId, msg.remote?.tabId);
  const sessId = tabOf(entry.sessId, mgr?.getExternal?.(tabId)?.sessId);
  Object.assign(entry, { external: true, tabId, sessId });
  return { external: true, tabId, sessId };
}

// Why `msg` (an ask:answer) may not resolve `entry`, or null when it may. An
// external ask needs the answer to name its tab (msg.tabId) or session
// (msg.sessId); a local one is answered as before, by its id alone, but never
// through a name that is not its own or that is an external session's.
function answerRefusal(entry, msg, mgr) {
  const owner = askOwner(entry, mgr);
  const tabId = typeof msg.tabId === 'string' && msg.tabId ? msg.tabId : null;
  const sessId = typeof msg.sessId === 'string' && msg.sessId ? msg.sessId : null;
  const wrong = 'that question belongs to another session';
  if (owner.external) {
    if (!tabId && !sessId) return 'an answer to a remote session\'s question must name its tab';
    if (tabId && tabId !== owner.tabId) return wrong;
    if (sessId && sessId !== owner.sessId) return wrong;
    return null;
  }
  if (tabId && (owner.tabId ? tabId !== owner.tabId : !!mgr?.getExternal?.(tabId))) return wrong;
  if (sessId) {
    const named = mgr?.getBySessId?.(sessId);
    if (named?.external) return wrong;
    const own = owner.sessId || (owner.tabId && mgr?.get?.(owner.tabId)?.sessId) || null;
    if (own && own !== sessId) return wrong;
  }
  return null;
}

module.exports = { ExternalSession, validate, cleanSettings, askOwner, answerRefusal, MAX_TITLE, MAX_HOST, MAX_SETTINGS, CALL_TIMEOUT_MS };
