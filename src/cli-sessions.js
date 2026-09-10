const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const CliSession = require('./cli-session');
const caps = require('./capabilities');
const { readJSON, writeJSON, tryRm, DATA_HOME, PACKAGE_ROOT } = require('./utils');

const HISTORY_FILE = path.join(DATA_HOME, 'data', 'cli-history.json');
const OPEN_TABS_FILE = path.join(DATA_HOME, 'data', 'cli-open-tabs.json');
// Gap between staggered restore spawns, so a large manifest does not fork every
// `claude` process at the same instant.
const RESTORE_STAGGER_MS = 500;
const RECENT_DIRS_FILE = path.join(DATA_HOME, 'data', 'cli-recent-dirs.json');
const MAX_RECENT_DIRS = 12;

function deleteFullSessionData(store, sessId, cwd, isolated) {
  store.deleteSessionData(sessId);

  const configDir = (isolated === true)
    ? path.join(cwd, '.claude')
    : path.join(os.homedir(), '.claude');

  const slug = cwd.replace(/\//g, '-');
  const projectDir = path.join(configDir, 'projects', slug);

  tryRm(path.join(projectDir, `${sessId}.jsonl`));
  tryRm(path.join(projectDir, sessId));
  tryRm(path.join(configDir, 'file-history', sessId));
  tryRm(path.join(configDir, 'tasks', sessId));
  tryRm(path.join(configDir, 'session-env', sessId));

  const todosDir = path.join(configDir, 'todos');
  try {
    for (const f of fs.readdirSync(todosDir)) {
      if (f.startsWith(sessId + '-')) tryRm(path.join(todosDir, f));
    }
  } catch {}
}

// Roll the native Claude transcript (what `--resume` reads) back by one turn:
// drop the last genuine user prompt and everything after it (its assistant
// replies, tool calls/results, and trailing metadata). A .bak is kept in case
// the rollback needs to be undone. Returns { ok, reason?, cutTimestamp? } where
// cutTimestamp is the epoch-ms time of the removed user prompt, used to flag the
// matching inspector interactions.
function rollbackTranscript(cwd, sessId, isolated) {
  if (!cwd || !sessId) return { ok: false, reason: 'no-session' };
  const configDir = (isolated === true)
    ? path.join(cwd, '.claude')
    : path.join(os.homedir(), '.claude');
  const slug = cwd.replace(/\//g, '-');
  const jsonlPath = path.join(configDir, 'projects', slug, `${sessId}.jsonl`);

  let raw;
  try { raw = fs.readFileSync(jsonlPath, 'utf8'); } catch { return { ok: false, reason: 'no-transcript' }; }

  const lines = raw.split('\n');
  let targetIdx = -1;
  let targetTs = null;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type !== 'user' || o.isMeta || o.isSidechain) continue;
    const content = o.message && o.message.content;
    const isPrompt = typeof content === 'string'
      || (Array.isArray(content) && !content.some(b => b && b.type === 'tool_result'));
    if (isPrompt) { targetIdx = i; targetTs = o.timestamp || null; }
  }
  if (targetIdx < 0) return { ok: false, reason: 'no-user-turn' };

  let out = lines.slice(0, targetIdx).join('\n');
  if (out.length && !out.endsWith('\n')) out += '\n';
  try {
    fs.writeFileSync(jsonlPath + '.bak', raw);
    fs.writeFileSync(jsonlPath, out);
  } catch (e) {
    return { ok: false, reason: 'write-failed' };
  }
  const cutTimestamp = targetTs ? Date.parse(targetTs) : null;
  return { ok: true, cutTimestamp: Number.isFinite(cutTimestamp) ? cutTimestamp : null };
}

class CliSessionManager {
  constructor(proxyPort, broadcaster, store, opts = {}) {
    this.proxyPort = proxyPort;
    this.broadcaster = broadcaster;
    this.store = store;
    this.opts = opts;
    this.sessions = new Map();
    this._exitCallbacks = new Map();
    // Per-process identity. Tab IDs embed this so they can never collide with
    // tab IDs minted by a previous server process, and clients use it to detect
    // a restart on any reconnect (even a seamless one without a page reload).
    this.bootId = crypto.randomUUID().slice(0, 8);
    this._tabSeq = 0;
    // Tabs the last restore could not bring back, surfaced to the UI on connect.
    this.droppedTabs = [];
    this._restoring = false;
    this._shuttingDown = false;
  }

  _createSession(tabId) {
    const session = new CliSession(
      this.proxyPort,
      this._wrapBroadcaster(tabId),
      this.store,
      this.opts
    );
    session.tabId = tabId;
    this.sessions.set(tabId, session);
    return session;
  }

  _wrapBroadcaster(tabId) {
    const self = this;
    return {
      broadcast(msg) {
        if (msg.type && msg.type.startsWith('cli:')) {
          msg.tabId = tabId;
        }
        if (msg.type === 'cli:exit') {
          self._onSessionExit(tabId);
        }
        self.broadcaster.broadcast(msg);
      },
    };
  }

  _onSessionExit(tabId) {
    const session = this.sessions.get(tabId);
    if (session?.sessId && session.cwd) {
      this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated, autoMemory: session.autoMemory });
    }
    const cb = this._exitCallbacks.get(tabId);
    if (cb) {
      this._exitCallbacks.delete(tabId);
      try { cb(tabId); } catch (e) { console.error('Session exit callback error:', e); }
    }
    this.sessions.delete(tabId);
    this._persistOpenTabs();
    this.broadcastTabs();
  }

  saveAllToHistory() {
    for (const [, session] of this.sessions) {
      if (session?.sessId && session.cwd) {
        this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated, autoMemory: session.autoMemory });
      }
    }
  }

  // --- History persistence ---

  _loadHistory() {
    return readJSON(HISTORY_FILE, []);
  }

  saveToHistory(entry) {
    const history = this._loadHistory();
    const sessId = entry.sessId || `sess-${Date.now()}`;
    const existing = history.find(h => h.id === sessId);
    const deduped = history.filter(h => h.id !== sessId);
    const now = Date.now();
    deduped.unshift({
      id: sessId,
      cwd: entry.cwd,
      title: entry.title || null,
      settings: entry.settings || {},
      isolated: entry.isolated === true,
      autoMemory: entry.autoMemory === true,
      startedAt: existing?.startedAt || now,
      savedAt: now,
    });
    writeJSON(HISTORY_FILE, deduped);
    this.recordRecentDir(entry.cwd);
  }

  // --- Open-tab manifest ---
  // The set of tabs to bring back after a restart, owned by the server. The
  // client no longer replays a sessionStorage record, so recovery cannot race
  // between browser windows and no longer depends on a dashboard being open when
  // the server restarts. Entries store session *identity*, never tabIds:
  // nextTabId deliberately embeds the per-process bootId so a tabId must not
  // outlive its process.
  _persistOpenTabs() {
    // Suppressed in two windows where the live session map is not a truthful
    // picture of "tabs that should come back":
    //  - during restoreOpenTabs's staggered spawns, where the first restore would
    //    otherwise rewrite the manifest with only itself in it;
    //  - during shutdown, where killAll's pty exits each fire _onSessionExit and
    //    would empty the manifest just before the process dies.
    if (this._restoring || this._shuttingDown) return;
    const entries = [];
    for (const [tabId, session] of this.sessions) {
      if (session.hidden) continue;          // app-driven, hidden from the strip
      if (tabId.startsWith('app-')) continue; // app action tabs, not user tabs
      if (!session.cwd) continue;             // created but never spawned
      entries.push({
        sessId: session.sessId || null,
        kind: session.kind === 'shell' ? 'shell' : 'cli',
        cwd: session.cwd,
        title: session.title || null,
        settings: session.getSettings(),
        isolated: session.isolated === true,
        autoMemory: session.autoMemory === true,
      });
    }
    writeJSON(OPEN_TABS_FILE, entries);
  }

  // Bring back the tabs that were open when the previous process stopped. Called
  // once at startup. Tabs that cannot be restored are reported on
  // `this.droppedTabs` so the UI can say what went missing instead of letting
  // them vanish silently.
  restoreOpenTabs() {
    const entries = readJSON(OPEN_TABS_FILE, []);
    this.droppedTabs = [];
    if (!Array.isArray(entries) || entries.length === 0) return { restored: 0, dropped: 0 };

    const toRestore = [];
    for (const e of entries) {
      if (!e || !e.cwd) continue;
      const label = e.title || e.cwd;
      if (e.kind === 'shell') {
        // A shell has no transcript; only its cwd could be restored, which would
        // look like the tab came back when its state did not.
        this.droppedTabs.push({ reason: 'shell', title: label, cwd: e.cwd });
        continue;
      }
      if (!e.sessId) continue;
      // `claude --resume <id>` exits immediately when the native transcript is
      // missing, which the UI reads as the tab dying the moment it opened.
      if (!this._transcriptExists(e.cwd, e.sessId, e.isolated === true)) {
        this.droppedTabs.push({ reason: 'no-transcript', title: label, cwd: e.cwd });
        continue;
      }
      toRestore.push(e);
    }

    if (toRestore.length === 0) {
      this._persistOpenTabs();
      return { restored: 0, dropped: this.droppedTabs.length };
    }

    this._restoring = true;
    toRestore.forEach((entry, i) => {
      setTimeout(() => {
        try {
          this._restoreOne(entry);
        } catch (err) {
          console.error(`  CLI tab restore failed for ${entry.cwd}: ${err.message}`);
        }
        if (i === toRestore.length - 1) {
          this._restoring = false;
          this._persistOpenTabs();
          this.broadcastTabs();
        }
      }, i * RESTORE_STAGGER_MS);
    });
    return { restored: toRestore.length, dropped: this.droppedTabs.length };
  }

  _restoreOne(entry) {
    const tabId = this.nextTabId();
    const session = this.getOrCreate(tabId);
    // Set title and settings before spawning: _assignTitle and the model
    // fill-when-absent rule both no-op on an already-populated session, so the
    // tab comes back with exactly the identity and model it had before.
    session.title = entry.title || null;
    if (entry.settings) session.updateSettings(entry.settings);
    this.spawn(tabId, entry.cwd, 80, 24, {
      resumeSessionId: entry.sessId,
      isolated: entry.isolated === true,
      autoMemory: entry.autoMemory === true,
    });
  }

  // Session ids the interactions sweep must not touch: everything the restore
  // manifest will bring back, plus everything still listed as a saved session.
  // Deliberately lighter than getSavedSessions(), which stats every transcript.
  getPinnedSessionIds() {
    const pinned = new Set();
    for (const session of this.sessions.values()) {
      if (session.sessId) pinned.add(session.sessId);
    }
    const entries = readJSON(OPEN_TABS_FILE, []);
    if (Array.isArray(entries)) {
      for (const e of entries) if (e?.sessId) pinned.add(e.sessId);
    }
    for (const h of this._loadHistory()) {
      if (h?.id) pinned.add(h.id);
    }
    return pinned;
  }

  getSavedSessions() {
    const history = this._loadHistory();
    const runningIds = new Set();
    for (const session of this.sessions.values()) {
      if (session.sessId && session.running) runningIds.add(session.sessId);
    }
    for (const entry of history) {
      const stat = this._getJsonlStat(entry);
      entry.jsonlSize = stat.size;
      entry.lastInteractionAt = stat.mtime || entry.savedAt;
      entry.lastEntrySize = stat.lastEntrySize;
      if (!entry.startedAt) entry.startedAt = entry.savedAt;
      entry.isRunning = runningIds.has(entry.id);
    }
    return history;
  }

  _transcriptExists(cwd, sessId, isolated) {
    if (!cwd || !sessId) return false;
    const configDir = (isolated === true)
      ? path.join(cwd, '.claude')
      : path.join(os.homedir(), '.claude');
    const slug = cwd.replace(/\//g, '-');
    const jsonlPath = path.join(configDir, 'projects', slug, `${sessId}.jsonl`);
    try { return fs.statSync(jsonlPath).size > 0; } catch { return false; }
  }

  _getJsonlStat(entry) {
    const configDir = (entry.isolated === true)
      ? path.join(entry.cwd, '.claude')
      : path.join(os.homedir(), '.claude');
    const slug = entry.cwd.replace(/\//g, '-');
    const jsonlPath = path.join(configDir, 'projects', slug, `${entry.id}.jsonl`);
    try {
      const st = fs.statSync(jsonlPath);
      return { size: st.size, mtime: st.mtimeMs, lastEntrySize: this._getLastEntrySize(jsonlPath, st.size) };
    } catch {
      return { size: 0, mtime: 0, lastEntrySize: 0 };
    }
  }

  // Byte length of the final non-empty line (the last interaction) in a .jsonl session log.
  _getLastEntrySize(jsonlPath, fileSize) {
    if (!fileSize) return 0;
    const READ = Math.min(fileSize, 256 * 1024);
    let fd;
    try {
      fd = fs.openSync(jsonlPath, 'r');
      const buf = Buffer.alloc(READ);
      fs.readSync(fd, buf, 0, READ, fileSize - READ);
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(l => l.length > 0);
      if (!lines.length) return 0;
      return Buffer.byteLength(lines[lines.length - 1], 'utf8');
    } catch {
      return 0;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    }
  }

  // --- Recent directories ---

  _loadRecentDirs() {
    const dirs = readJSON(RECENT_DIRS_FILE, []);
    return Array.isArray(dirs) ? dirs : [];
  }

  recordRecentDir(cwd) {
    if (!cwd) return;
    const now = Date.now();
    const dirs = this._loadRecentDirs().filter(d => d.path !== cwd);
    dirs.unshift({ path: cwd, lastUsedAt: now });
    writeJSON(RECENT_DIRS_FILE, dirs.slice(0, MAX_RECENT_DIRS));
  }

  getRecentDirs() {
    return this._loadRecentDirs();
  }

  deleteRecentDir(dirPath) {
    const dirs = this._loadRecentDirs().filter(d => d.path !== dirPath);
    writeJSON(RECENT_DIRS_FILE, dirs);
  }

  deleteSavedSession(id) {
    for (const session of this.sessions.values()) {
      if (session.sessId === id && session.running) return;
    }
    const history = this._loadHistory();
    const entry = history.find(s => s.id === id);
    const filtered = history.filter(s => s.id !== id);
    writeJSON(HISTORY_FILE, filtered);
    if (entry) {
      deleteFullSessionData(this.store, id, entry.cwd, entry.isolated);
    } else {
      this.store.deleteSessionData(id);
    }
  }

  // --- Active sessions ---

  getOrCreate(tabId) {
    if (!tabId) return null;
    let session = this.sessions.get(tabId);
    if (!session) {
      session = this._createSession(tabId);
    }
    return session;
  }

  get(tabId) {
    return this.sessions.get(tabId) || null;
  }

  spawn(tabId, cwd, cols, rows, { resumeSessionId, isolated, autoMemory } = {}) {
    const session = this.getOrCreate(tabId);
    if (session.sessId && session.cwd) {
      this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated, autoMemory: session.autoMemory });
    }
    this._assignTitle(session, cwd, resumeSessionId);
    // Pin the model into the tab's own settings so the spawn always carries an
    // explicit --model, and so a resume re-uses the model the session ran with
    // rather than whatever the global default happens to be now. Only filled
    // when absent: a restored tab arrives with its model already set.
    if (!session.getSettings().model) {
      session.updateSettings({ model: caps.getCliModelPref(DATA_HOME) });
    }
    session.spawn(cwd, cols, rows, { resumeSessionId, isolated, autoMemory });
    // Persist immediately so session survives ungraceful server death
    this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated, autoMemory: session.autoMemory });
    this._persistOpenTabs();
    this.broadcastTabs();
  }

  write(tabId, data) {
    const session = this.sessions.get(tabId);
    if (session) session.write(data);
  }

  writeWhenReady(tabId, data, delayMs) {
    const session = this.sessions.get(tabId);
    if (session) session.writeWhenReady(data, undefined, delayMs);
  }

  resize(tabId, cols, rows) {
    const session = this.sessions.get(tabId);
    if (session) session.resize(cols, rows);
  }

  kill(tabId) {
    const session = this.sessions.get(tabId);
    if (session) session.kill();
  }

  remove(tabId) {
    const session = this.sessions.get(tabId);
    if (session) {
      if (session.sessId && session.cwd) {
        this.saveToHistory({ sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), isolated: session.isolated });
      }
      if (session.sessId) {
        this.store.deleteSessionData(session.sessId);
        tryRm(path.join(PACKAGE_ROOT, 'uploads', session.sessId));
      }
      session.kill();
      this.sessions.delete(tabId);
      this._persistOpenTabs();
    }
  }

  // Shutdown path. Freezes the open-tab manifest first: these sessions are being
  // killed because the process is stopping, not because the user closed them, so
  // the manifest must keep listing them for the next boot to restore.
  killAll() {
    this._shuttingDown = true;
    for (const session of this.sessions.values()) {
      session.kill();
    }
  }

  list() {
    const tabs = [];
    for (const [tabId, session] of this.sessions) {
      if (session.hidden) continue;
      tabs.push({
        tabId,
        instanceId: session.instanceId,
        sessId: session.sessId,
        isolated: session.isolated,
        autoMemory: session.autoMemory,
        status: session.status,
        cwd: session.cwd,
        title: session.title,
        settings: session.getSettings(),
      });
    }
    return tabs;
  }

  nextTabId() {
    // Embed the per-process bootId and a monotonic counter so a tab ID is
    // unique across restarts. A stale client tab from a previous process can
    // therefore never be re-bound to a session in this process by key collision.
    let id;
    do {
      id = `tab-${this.bootId}-${++this._tabSeq}`;
    } while (this.sessions.has(id));
    return id;
  }

  // Give a session a stable display title. The title is the cwd basename, with
  // a -2, -3, … suffix when a live sibling already holds that name. A resumed
  // session reclaims the title it was saved under, so a tab keeps its identity
  // across a server restart instead of having the suffix re-derived from the
  // order the tabs happen to come back in. Titles set by the caller
  // (launchSession's opts.title, for app tabs) are left alone.
  _assignTitle(session, cwd, resumeSessionId) {
    if (session.title) return;

    const taken = new Set();
    for (const other of this.sessions.values()) {
      if (other !== session && other.title) taken.add(other.title);
    }

    if (resumeSessionId) {
      const saved = this._loadHistory().find(h => h.id === resumeSessionId);
      if (saved?.title && !taken.has(saved.title)) {
        session.title = saved.title;
        return;
      }
    }

    const base = path.basename((cwd || '').replace(/\/+$/, '')) || cwd || 'cli';
    let candidate = base;
    let n = 1;
    while (taken.has(candidate)) candidate = `${base}-${++n}`;
    session.title = candidate;
  }

  updateSettings(tabId, settings) {
    const session = this.sessions.get(tabId);
    if (session) {
      session.updateSettings(settings);
      // settings carries the pinned --model, so the manifest must follow it.
      this._persistOpenTabs();
      return true;
    }
    return false;
  }

  getSettingsByInstanceId(instanceId) {
    for (const session of this.sessions.values()) {
      if (session.instanceId === instanceId) {
        return session.getSettings();
      }
    }
    return null;
  }

  getByInstanceId(instanceId) {
    for (const session of this.sessions.values()) {
      if (session.instanceId === instanceId) return session;
    }
    return null;
  }

  launchSession(tabId, opts = {}) {
    const session = this.getOrCreate(tabId);
    if (opts.title !== undefined) session.title = opts.title;
    if (opts.settings) session.updateSettings(opts.settings);
    if (opts.hidden != null) session.hidden = opts.hidden;

    let resumeSessionId;
    const so = opts.spawnOpts || {};
    if (so.resumeSessionId) {
      // Explicit resume target (Pro's storybook "open step as tab"): the caller
      // names the session; we only verify Claude's native transcript exists so
      // the tab does not die on open ("No conversation found").
      const cwd = opts.cwd || session.cwd;
      if (!/^[0-9a-f-]{36}$/i.test(String(so.resumeSessionId))) {
        throw new Error('resumeSessionId must be a UUID');
      }
      if (!this._transcriptExists(cwd, so.resumeSessionId, so.isolated === true)) {
        throw new Error(`no transcript for session ${so.resumeSessionId} in ${cwd}`);
      }
      resumeSessionId = so.resumeSessionId;
    } else if (so.resume) {
      const cwd = opts.cwd || session.cwd;
      if (session.sessId && this._transcriptExists(cwd, session.sessId, session.isolated)) {
        resumeSessionId = session.sessId;
      } else if (opts.cwd) {
        const history = this._loadHistory();
        const match = history.find(h => h.cwd === opts.cwd);
        // Only resume if Claude's native transcript actually exists — otherwise
        // `claude --resume <id>` exits immediately ("No conversation found"),
        // which the client reads as the tab dying right after it opened.
        if (match && this._transcriptExists(opts.cwd, match.id, match.isolated)) {
          resumeSessionId = match.id;
        }
      }
    }

    this.spawn(tabId, opts.cwd, opts.cols, opts.rows, { resumeSessionId });

    if (opts.prompt && opts.autoSubmit) {
      // Write the prompt and the submitting CR as separate PTY chunks: the CLI
      // treats a chunk with an embedded newline as a paste (newline inserted,
      // not submitted), so a trailing '\n' never fires Enter.
      session.writeWhenReady(opts.prompt);
      session.writeWhenReady('\r', undefined, 400);
    }
  }

  // Roll a CLI session back one user/assistant turn: truncate the native
  // transcript (what `--resume` reads) so the last turn no longer counts toward
  // context, and flag the matching inspector interactions as deleted (kept for
  // viewing, struck through in the timeline). The running process is left alone.
  removeLastInteractionTurn(tabId) {
    const session = this.sessions.get(tabId);
    if (!session || !session.sessId || !session.cwd) return { ok: false, reason: 'no-session' };
    const sessId = session.sessId;

    const result = rollbackTranscript(session.cwd, sessId, session.isolated);
    if (!result.ok) return result;

    const deletedIds = this.store.markSessionTurnDeleted(sessId, result.cutTimestamp);
    if (deletedIds.length) {
      this.broadcaster.broadcast({ type: 'inspector:turnsDeleted', sessId, instanceId: `cli-${sessId}`, ids: deletedIds });
    }
    return { ok: true, deletedCount: deletedIds.length };
  }

  onExit(tabId, callback) {
    this._exitCallbacks.set(tabId, callback);
  }

  broadcastTabs() {
    this.broadcaster.broadcast({ type: 'cli:tabs', bootId: this.bootId, tabs: this.list() });
  }
}

module.exports = CliSessionManager;
