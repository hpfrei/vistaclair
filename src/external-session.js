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
//   untrusted      title and settings.externalHost relay another machine's
//                  data: coerced to strings and capped. settings is copied
//                  through JSON (no getters, no cycles reach a broadcast).

const MAX_TAB_ID = 100;
const MAX_TITLE = 200;
const MAX_HOST = 100;
const MAX_STATE = 40;
const TAB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SESS_ID_RE = /^[0-9a-f-]{36}$/i;
const METHODS = ['submit', 'interrupt', 'setModel', 'setShowThinking', 'setAuth', 'historyPage', 'kill', 'close'];

function cap(v, n) {
  return v == null ? '' : String(v).slice(0, n);
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
    let s = {};
    try { s = JSON.parse(JSON.stringify(this.adapter.settings || {})) || {}; } catch {}
    if (typeof s !== 'object' || Array.isArray(s)) s = {};
    s.engine = 'sdk';
    if (s.externalHost != null) s.externalHost = cap(s.externalHost, MAX_HOST);
    return s;
  }

  // The settings belong to the add-on: core's in-place updates (cli-isolation's
  // worktree record) do not reach them.
  updateSettings() {}

  // adapter[method](...args) as a promise: a sync throw or a rejection both
  // reject, with an Error.
  call(method, ...args) {
    try {
      const fn = this.adapter[method];
      if (typeof fn !== 'function') return Promise.reject(new Error(`the external session has no ${method}()`));
      return Promise.resolve(fn.apply(this.adapter, args)).catch((e) => { throw asError(e); });
    } catch (e) {
      return Promise.reject(asError(e));
    }
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

// The add-on's error as one for a reply: its message only, capped.
function asError(e) {
  return new Error(cap(e?.message ?? e, 500) || 'external session error');
}

module.exports = { ExternalSession, validate, MAX_TITLE, MAX_HOST };
