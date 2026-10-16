// The inspector's session list: one light record per instance that talked
// through the proxy (CLI and SDK tabs, headless ai.prompt runs, external
// Claude Code pointed at the proxy). The dashboard's "Sessions" tab draws its
// cards from this summary alone; a session's interactions reach a browser only
// once it opens that session's tab (src/dashboard-ws.js subscriptions).
//
// Removal lives here too, so it is the same for every browser and also happens
// with none open: each group (cli, app, ext) keeps at most `limit` inactive
// sessions, the oldest going first, and autoclear removes every inactive one.
// A running session is never counted and never removed. Removing a session
// drops it from memory and deletes its interactions/<sessId> dir (turn files,
// totals cache, uploads, SDK feed) confined to that root; Claude Code's own
// transcripts, orchestration session folders and the spend ledger are not
// touched.
const fs = require('fs');
const path = require('path');
const { readJSON, writeJSON, removeInside, DATA_HOME } = require('./utils');
const { toEntry } = require('./session-totals');
const { readRun, runStatus } = require('./run-summary');

const INTERACTIONS_DIR = path.join(DATA_HOME, 'interactions');
const PREFS_FILE = path.join(DATA_HOME, 'data', 'inspector-prefs.json');
const GROUP_LIMIT = 20;
// An external client has no process to watch: it counts as running while a
// request is in flight and for this long after its last one.
const EXT_IDLE_MS = 5 * 60 * 1000;
// A removed instance whose late events (a SessionEnd hook after exit) must not
// bring its card back.
const TOMBSTONE_MS = 30 * 1000;
const SESS_ID_RE = /^[0-9a-f-]{36}$/i;

// cli-<sessId>: CLI and SDK tabs. ext / ext-<id>: external clients. Anything
// else is a headless run: ai.prompt (app-<name>-ai-<hex>) and vistaclair's own
// one-shot helpers (rule-gen-…, mcp-edit-…).
function kindOf(instanceId) {
  if (instanceId.startsWith('cli-')) return 'cli';
  if (instanceId === 'ext' || instanceId.startsWith('ext-')) return 'ext';
  return 'app';
}

// Claude Code names its session in every request's metadata.user_id: a JSON
// object in current versions, `…_session_<uuid>` in older ones.
function externalInstanceId(body) {
  const uid = body?.metadata?.user_id;
  if (typeof uid === 'string') {
    try {
      const sid = JSON.parse(uid)?.session_id;
      if (typeof sid === 'string' && SESS_ID_RE.test(sid)) return `ext-${sid}`;
    } catch {}
    const m = /_session_([0-9a-f-]{36})$/i.exec(uid);
    if (m) return `ext-${m[1]}`;
  }
  return 'ext';
}

// The working directory Claude Code states in its system prompt.
function cwdFromSystem(system) {
  const text = typeof system === 'string' ? system
    : Array.isArray(system) ? system.map(b => (typeof b?.text === 'string' ? b.text : '')).join('\n') : '';
  const m = /(?:Primary working directory|Working directory):\s*(\S+)/.exec(text);
  return m ? m[1] : null;
}

const isLive = (status) => status === 'pending' || status === 'streaming';

class InspectorSessions {
  /**
   * @param {object} opts
   * @param {object} opts.store              InteractionStore
   * @param {object} opts.broadcaster        DashboardBroadcaster (broadcast, onBroadcast)
   * @param {() => object[]} opts.getInstances  live process list (utils.getInstances)
   * @param {(ids: string[]) => void} opts.removeInstances  forget exited processes
   * @param {object} [opts.cliSessionManager]
   */
  constructor({ store, broadcaster, getInstances, removeInstances, cliSessionManager = null,
    getPricing = null, limit = GROUP_LIMIT, extIdleMs = EXT_IDLE_MS, throttleMs = 1000,
    prefsFile = PREFS_FILE, interactionsDir = INTERACTIONS_DIR, tickMs = 15000 } = {}) {
    this.store = store;
    this.broadcaster = broadcaster;
    this.getInstances = getInstances || (() => []);
    this.removeInstances = removeInstances || (() => {});
    this.cliSessionManager = cliSessionManager;
    this.getPricing = getPricing;
    this.limit = limit;
    this.extIdleMs = extIdleMs;
    this.throttleMs = throttleMs;
    this.prefsFile = prefsFile;
    this.interactionsDir = interactionsDir;

    this.sessions = new Map();    // instanceId → record
    this._tombstones = new Map(); // instanceId → removedAt
    this._timer = null;
    this._lastSent = 0;
    this._pendingDeletes = new Set(); // promises, for tests and shutdown
    this.autoClear = readJSON(prefsFile, {})?.autoClear === true;

    // Every process the server already knows (tabs restored at boot).
    for (const inst of this.getInstances()) this._noteInstance(inst);

    this._unlisten = broadcaster.onBroadcast((msg) => this._observe(msg));
    // An external session turns inactive with no event to say so.
    this._tick = setInterval(() => {
      for (const rec of this.sessions.values()) if (rec.kind === 'ext') { this._changed(); break; }
    }, tickMs);
    if (this._tick.unref) this._tick.unref();
  }

  close() {
    clearInterval(this._tick);
    if (this._timer) clearTimeout(this._timer);
    this._unlisten?.();
  }

  _record(instanceId, at) {
    let rec = this.sessions.get(instanceId);
    if (!rec) {
      rec = {
        instanceId, kind: kindOf(instanceId),
        label: null, cwd: null, model: null, sessId: null,
        firstAt: at || Date.now(), lastAt: at || Date.now(),
        turns: 0, apiCalls: 0, cost: 0, hasCost: false,
        totals: null, inflight: new Set(),
      };
      if (rec.kind === 'cli') {
        const sessId = instanceId.slice(4);
        if (SESS_ID_RE.test(sessId)) rec.sessId = sessId;
      }
      this.sessions.set(instanceId, rec);
      this._tombstones.delete(instanceId);
      // A CLI tab's figures cover its whole session on disk, not only what
      // this process saw (a resumed tab, a server restart).
      if (rec.kind === 'cli' && rec.sessId) {
        try { rec.totals = this.store.totals.get(rec.sessId); } catch {}
      }
    }
    if (!rec.sessId) {
      const sessId = this.store.sessionMap?.get(instanceId);
      if (sessId) rec.sessId = sessId;
    }
    return rec;
  }

  _tombstoned(instanceId) {
    const at = this._tombstones.get(instanceId);
    if (at == null) return false;
    if (Date.now() - at < TOMBSTONE_MS) return true;
    this._tombstones.delete(instanceId);
    return false;
  }

  _noteInstance(inst) {
    if (!inst?.instanceId) return;
    if (inst.status !== 'running' && !this.sessions.has(inst.instanceId)) return;
    const rec = this._record(inst.instanceId, inst.spawnedAt);
    if (inst.cwd) rec.cwd = inst.cwd;
    if (inst.status === 'running') rec.lastAt = Math.max(rec.lastAt, inst.spawnedAt || 0);
  }

  _observe(msg) {
    switch (msg.type) {
      case 'interaction:start': {
        const i = msg.interaction;
        if (!i) return;
        const id = i.instanceId || 'ext';
        if (this._tombstoned(id) && !this._processRunning(id)) return;
        const rec = this._record(id, i.timestamp);
        rec.lastAt = Math.max(rec.lastAt, i.timestamp || Date.now());
        if (isLive(i.status)) rec.inflight.add(i.id);
        if (i.isHook) {
          if (i.hookEvent === 'UserPromptSubmit') rec.turns++;
          if (!rec.cwd && typeof i.request?.cwd === 'string') rec.cwd = i.request.cwd;
        } else if (!i.isMcp) {
          if (i.request?.model) rec.model = i.request.model;
          if (rec.kind === 'ext' && !rec.cwd) rec.cwd = cwdFromSystem(i.request?.system);
        }
        this._changed();
        return;
      }
      case 'interaction:complete': {
        const i = msg.interaction;
        if (!i) return;
        const rec = this.sessions.get(i.instanceId || 'ext');
        if (!rec) return;
        rec.inflight.delete(i.id);
        rec.lastAt = Math.max(rec.lastAt, Date.now());
        if (!i.isHook && !i.isMcp) {
          rec.apiCalls++;
          if (i.usage) {
            const cost = toEntry(0, { usage: i.usage, pricing: i.pricing, model: i.request?.model }, this.getPricing)[8];
            if (cost != null) { rec.cost += cost; rec.hasCost = true; }
          }
        }
        this._changed();
        return;
      }
      case 'interaction:error': {
        const id = this.store.interactions.get(msg.interactionId)?.instanceId || 'ext';
        const rec = this.sessions.get(id);
        if (rec?.inflight.delete(msg.interactionId)) this._changed();
        return;
      }
      case 'claude:instances':
        for (const inst of msg.instances || []) this._noteInstance(inst);
        if (msg.event === 'spawn' && msg.instanceId) {
          this._tombstones.delete(msg.instanceId);
          this._record(msg.instanceId);
        }
        this._changed();
        return;
      case 'inspector:sessionTotals': {
        const rec = this.sessions.get(msg.instanceId);
        if (rec && msg.totals) { rec.totals = msg.totals; this._changed(); }
        return;
      }
      case 'cli:tabs':
      case 'cli:spawned':
        this._changed();
        return;
    }
  }

  _processRunning(instanceId) {
    for (const inst of this.getInstances()) {
      if (inst.instanceId === instanceId && inst.status === 'running') return true;
    }
    const session = this.cliSessionManager?.getByInstanceId?.(instanceId);
    return !!session?.running;
  }

  // Turns still marked in flight that the store no longer holds as live (an
  // interaction evicted or dropped without a terminal event) stop counting.
  _streaming(rec) {
    for (const id of rec.inflight) {
      const i = this.store.interactions.get(id);
      if (!i || !isLive(i.status)) rec.inflight.delete(id);
    }
    return rec.inflight.size > 0;
  }

  _status(rec, running) {
    if (this._streaming(rec)) return 'streaming';
    if (rec.kind === 'ext') return Date.now() - rec.lastAt < this.extIdleMs ? 'running' : 'inactive';
    return running.has(rec.instanceId) ? 'running' : 'inactive';
  }

  _runningSet() {
    const running = new Set();
    for (const inst of this.getInstances()) if (inst.status === 'running') running.add(inst.instanceId);
    for (const tab of this.cliSessionManager?.list?.() || []) {
      if (tab.instanceId && tab.status === 'running') running.add(tab.instanceId);
    }
    return running;
  }

  _labelOf(rec) {
    if (rec.kind === 'cli') {
      const session = this.cliSessionManager?.getByInstanceId?.(rec.instanceId);
      if (session) {
        if (session.cwd) rec.cwd = session.cwd;
        const label = session.title || (session.cwd ? path.basename(session.cwd.replace(/\/+$/, '')) : null);
        if (label) rec.label = label;
      }
      return rec.label || (rec.cwd ? path.basename(rec.cwd) : 'CLI');
    }
    if (rec.kind === 'app') {
      const m = /^app-(.+)-ai-[0-9a-f]+$/.exec(rec.instanceId);
      return m ? `${m[1]} · AI` : rec.instanceId.replace(/-\d+$/, '');
    }
    return rec.instanceId === 'ext' ? 'External' : `External ${rec.instanceId.slice(4, 12)}`;
  }

  // A CLI session's orchestration stamp (run, role, worker), from its live
  // session or its saved entry; resolved once per session. `saved` reads the
  // history at most once per list().
  _orchOf(rec, saved) {
    if (rec.kind !== 'cli') return null;
    if (rec.orch !== undefined) return rec.orch;
    const mgr = this.cliSessionManager;
    let settings = mgr?.getByInstanceId?.(rec.instanceId)?.getSettings?.() || null;
    let known = !!settings?.orchestration;
    if (!known && rec.sessId) {
      const entry = saved().get(rec.sessId);
      settings = entry?.settings || null;
      known = !!entry;
    }
    const st = settings?.orchestration;
    // `name` is the member's cross-session address (a worker's --name).
    const orch = st?.runId ? {
      runId: st.runId, role: st.role, workerId: st.workerId || null,
      name: (st.role === 'orchestrator' ? st.orchestrator : settings.name) || null, runDir: st.runDir || null,
    } : null;
    // Not live and not saved yet: look again next time.
    if (known) rec.orch = orch;
    return orch;
  }

  /** The cards, newest activity first, with each one's status. */
  list() {
    const running = this._runningSet();
    const out = [];
    let history = null;
    const saved = () => {
      if (!history) history = new Map((this.cliSessionManager?.listSaved?.() || []).map(e => [e.id, e]));
      return history;
    };
    for (const rec of this.sessions.values()) {
      const t = rec.totals;
      const orch = this._orchOf(rec, saved);
      out.push({
        instanceId: rec.instanceId,
        kind: rec.kind,
        label: this._labelOf(rec),
        cwd: rec.cwd,
        model: rec.model,
        status: this._status(rec, running),
        turns: t ? t.turns : rec.turns,
        apiCalls: t ? t.apiCalls : rec.apiCalls,
        cost: t ? (t.hasCost ? t.cost : null) : (rec.hasCost ? rec.cost : null),
        firstAt: rec.firstAt,
        lastAt: Math.max(rec.lastAt, t?.lastAt || 0),
        orchestration: orch ? { runId: orch.runId, role: orch.role, workerId: orch.workerId, name: orch.name } : null,
      });
    }
    return out.sort((a, b) => b.lastAt - a.lastAt);
  }

  // One record per run among the sessions: its status from the run record
  // (running while any member listed here is), the orchestrator's address and
  // how many workers the run has. The Sessions tab groups a run into one card.
  _runs(sessions) {
    const members = new Map();
    for (const s of sessions) {
      const o = s.orchestration;
      if (!o) continue;
      const m = members.get(o.runId) || { runDir: null, running: false };
      m.runDir = m.runDir || this.sessions.get(s.instanceId)?.orch?.runDir || null;
      if (s.status !== 'inactive') m.running = true;
      members.set(o.runId, m);
    }
    const runs = {};
    for (const [runId, m] of members) {
      const run = readRun(m.runDir);
      runs[runId] = {
        status: runStatus(run, m.running),
        orchestrator: run?.orchestrator || null,
        workers: run ? (run.workers || []).length : null,
      };
    }
    return runs;
  }

  summaryMessage(sessions = this.list()) {
    return { type: 'inspector:sessions', sessions, runs: this._runs(sessions), autoClear: this.autoClear, limit: this.limit };
  }

  // Throttled push: at most one summary per throttleMs, the last change always
  // included.
  _changed() {
    if (this._timer) return;
    const wait = Math.max(0, this._lastSent + this.throttleMs - Date.now());
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, wait);
    if (this._timer.unref) this._timer.unref();
  }

  /** Apply pruning / autoclear, then push the summary to every browser. */
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    let sessions = this.list();
    const doomed = this._toPrune(sessions);
    if (doomed.length) {
      this._remove(doomed);
      sessions = sessions.filter(s => !doomed.includes(s.instanceId));
    }
    this._lastSent = Date.now();
    this.broadcaster.broadcast(this.summaryMessage(sessions));
  }

  _toPrune(sessions) {
    const doomed = [];
    const kept = { cli: 0, app: 0, ext: 0 };
    // Newest first, so whatever passes the limit is the oldest.
    for (const s of sessions) {
      if (s.status !== 'inactive') continue;
      if (this.autoClear || ++kept[s.kind] > this.limit) doomed.push(s.instanceId);
    }
    return doomed;
  }

  /** Remove every inactive session of one kind ('cli' | 'app' | 'ext'). */
  clearKind(kind) {
    const doomed = this.list().filter(s => s.kind === kind && s.status === 'inactive').map(s => s.instanceId);
    if (doomed.length) this._remove(doomed);
    this.flush();
    return doomed;
  }

  setAutoClear(on) {
    this.autoClear = !!on;
    const prefs = readJSON(this.prefsFile, {}) || {};
    prefs.autoClear = this.autoClear;
    try { writeJSON(this.prefsFile, prefs); } catch {}
    this.flush();
  }

  // Drop sessions from memory and disk. Callers only pass inactive ones; a dir
  // another remaining session still uses (or a live registration points at)
  // stays.
  _remove(instanceIds) {
    const removed = [];
    for (const id of instanceIds) {
      const rec = this.sessions.get(id);
      if (!rec) continue;
      this.sessions.delete(id);
      this._tombstones.set(id, Date.now());
      removed.push(id);
      const ownDir = rec.sessId && !this._sessIdInUse(rec.sessId) ? rec.sessId : null;
      this.store.forgetSession(id, ownDir);
      if (ownDir) this._deleteDir(ownDir);
    }
    if (!removed.length) return;
    this.removeInstances(removed);
    this.broadcaster.broadcast({ type: 'inspector:sessionsRemoved', instanceIds: removed });
  }

  _sessIdInUse(sessId) {
    for (const rec of this.sessions.values()) if (rec.sessId === sessId) return true;
    for (const v of this.store.sessionMap?.values() || []) if (v === sessId) return true;
    return false;
  }

  _deleteDir(sessId) {
    if (!SESS_ID_RE.test(sessId)) return;
    const p = removeInside(this.interactionsDir, path.join(this.interactionsDir, sessId))
      .catch((err) => { if (err.code !== 'ENOENT') console.error(`inspector: could not delete session ${sessId}:`, err.message); });
    this._pendingDeletes.add(p);
    p.finally(() => this._pendingDeletes.delete(p));
    // Uploads an older version kept outside the session dir.
    const legacy = path.join(DATA_HOME, 'uploads');
    if (fs.existsSync(path.join(legacy, sessId))) {
      const q = removeInside(legacy, path.join(legacy, sessId)).catch(() => {});
      this._pendingDeletes.add(q);
      q.finally(() => this._pendingDeletes.delete(q));
    }
  }

  /** Resolves once every delete started so far has finished. */
  settled() {
    return Promise.all([...this._pendingDeletes]);
  }
}

module.exports = { InspectorSessions, externalInstanceId, kindOf, cwdFromSystem, GROUP_LIMIT, EXT_IDLE_MS };
