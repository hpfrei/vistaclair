const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const CliSession = require('./cli-session');
const SdkSession = require('./sdk-session');
const caps = require('./capabilities');
const folders = require('./session-folders');
const { summarizeRuns, tailOf } = require('./run-summary');
const { readJSON, writeJSON, tryRm, DATA_HOME, PACKAGE_ROOT } = require('./utils');

const HISTORY_FILE = path.join(DATA_HOME, 'data', 'cli-history.json');
const OPEN_TABS_FILE = path.join(DATA_HOME, 'data', 'cli-open-tabs.json');
// Default root of the per-session folders (TODO.md, NOTES.md); a launch may
// name its own (settings.sessionsRoot — Pro puts an app's inside the app).
const SESSIONS_ROOT = path.join(DATA_HOME, 'data', 'sessions');
// Gap between staggered restore spawns, so a large manifest does not fork every
// `claude` process at the same instant.
const RESTORE_STAGGER_MS = 500;
const RECENT_DIRS_FILE = path.join(DATA_HOME, 'data', 'cli-recent-dirs.json');
const MAX_RECENT_DIRS = 12;
// The recent list stays at the orchestrator level: never deeper than an app.
const APPS_DIR = process.env.VISTACLAIR_APPS_DIR || path.join(PACKAGE_ROOT, 'vistaclair-apps');
const WORKTREES_DIR = path.join(DATA_HOME, 'data', 'worktrees');

function _isInside(dir, root) {
  const rel = path.relative(root, dir);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// How `cwd` shows in the recent list: a directory inside an app as the app
// (vistaclair-apps/<app>), a run's worktree not at all (null), others as is.
function _recentDirOf(cwd) {
  if (!cwd) return null;
  if (_isInside(cwd, WORKTREES_DIR)) return null;
  if (_isInside(cwd, APPS_DIR)) {
    const app = path.relative(APPS_DIR, cwd).split(path.sep)[0];
    return app ? path.join(APPS_DIR, app) : APPS_DIR;
  }
  return cwd;
}

// Claude Code's own config root; every spawn reads and writes it (core never
// sets CLAUDE_CONFIG_DIR).
const CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude');

// The native transcript `--resume` reads for a session started in `cwd`.
function _jsonlPath(cwd, sessId) {
  return path.join(CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/\//g, '-'), `${sessId}.jsonl`);
}

// A session folder is only ever removed where session-folders put it: a
// `<root>/sessions/<key>` directory. Anything else in settings is left alone.
function removeSessionFolder(dir) {
  if (!dir || path.basename(path.dirname(dir)) !== 'sessions') return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function deleteFullSessionData(store, sessId, cwd) {
  store.deleteSessionData(sessId);

  const configDir = CLAUDE_CONFIG_DIR;
  const jsonlPath = _jsonlPath(cwd, sessId);

  tryRm(jsonlPath);
  tryRm(path.join(path.dirname(jsonlPath), sessId));
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
function rollbackTranscript(cwd, sessId) {
  if (!cwd || !sessId) return { ok: false, reason: 'no-session' };
  const jsonlPath = _jsonlPath(cwd, sessId);

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
    // Listeners for every tab's exit (addExitListener), unlike the one-shot
    // per-tab onExit callback. Called with the session before it is dropped.
    this._exitListeners = [];
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

  // engine 'sdk' (settings.engine) makes an Agent SDK session, anything else a
  // PTY CliSession. Both have the surface everything here uses.
  _createSession(tabId, engine = 'cli') {
    const Kind = engine === 'sdk' ? SdkSession : CliSession;
    const session = new Kind(
      this.proxyPort,
      this._wrapBroadcaster(tabId),
      this.store,
      this.opts
    );
    session.tabId = tabId;
    if (engine === 'sdk') {
      session.onStateChange = () => this.noteSessionState(session);
      session.onSettingsChange = () => this.noteSettingsChanged(session);
    }
    this.sessions.set(tabId, session);
    return session;
  }

  // The session for a spawn, of the class its settings' engine asks for. A tab
  // created as one kind and launched as the other (cli:open sizes the tab
  // before the launch decides) is replaced; the old object is retired first so
  // its exit can never report on the new one.
  _sessionForSpawn(tabId) {
    const session = this.getOrCreate(tabId);
    const engine = session.getSettings().engine === 'sdk' ? 'sdk' : 'cli';
    if ((session instanceof SdkSession) === (engine === 'sdk')) return session;
    session._spawnGen++;
    if (session.running) session.kill('respawn');
    const next = this._createSession(tabId, engine);
    next.title = session.title;
    next.hidden = session.hidden;
    next.owner = session.owner;
    next.updateSettings(session.getSettings());
    return next;
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
      this.saveToHistory(this._historyEntry(session));
    }
    // Drop the ended session before the callbacks run: a callback may relaunch
    // into the same tabId, and that new session must stay listed.
    if (this.sessions.get(tabId) === session) this.sessions.delete(tabId);
    const cb = this._exitCallbacks.get(tabId);
    if (cb) {
      this._exitCallbacks.delete(tabId);
      try { cb(tabId); } catch (e) { console.error('Session exit callback error:', e); }
    }
    this._notifyExit(tabId, session);
    this._persistOpenTabs();
    this.broadcastTabs();
  }

  saveAllToHistory() {
    for (const [, session] of this.sessions) {
      if (session?.sessId && session.cwd) {
        this.saveToHistory(this._historyEntry(session));
      }
    }
  }

  _historyEntry(session) {
    return { sessId: session.sessId, cwd: session.cwd, title: session.title, settings: session.getSettings(), autoMemory: session.autoMemory };
  }

  // --- History persistence ---

  _loadHistory() {
    return readJSON(HISTORY_FILE, []);
  }

  // `flags` ({ paused, interrupted, pausedAt }) mark how a session left; any
  // later save without them (a resume's spawn) clears them.
  saveToHistory(entry) {
    const history = this._loadHistory();
    const sessId = entry.sessId || `sess-${Date.now()}`;
    const existing = history.find(h => h.id === sessId);
    const deduped = history.filter(h => h.id !== sessId);
    const now = Date.now();
    const flags = entry.flags || {};
    deduped.unshift({
      id: sessId,
      // An SDK session resumes as one (its settings carry the engine too).
      kind: entry.settings?.engine === 'sdk' ? 'sdk' : 'cli',
      cwd: entry.cwd,
      title: entry.title || null,
      settings: entry.settings || {},
      autoMemory: entry.autoMemory === true,
      startedAt: existing?.startedAt || now,
      savedAt: now,
      ...(flags.paused ? { paused: true } : {}),
      ...(flags.interrupted ? { interrupted: true } : {}),
      ...(flags.pausedAt ? { pausedAt: flags.pausedAt } : {}),
    });
    writeJSON(HISTORY_FILE, deduped);
    // A worker's directory is its orchestrator's pick, not the user's.
    if (entry.settings?.orchestration?.role !== 'worker') this.recordRecentDir(entry.cwd);
  }

  findSaved(id) {
    return this._loadHistory().find(h => h.id === id) || null;
  }

  // The raw history, newest first (orchestration finds a paused run's members).
  listSaved() {
    return this._loadHistory();
  }

  // Drop a history entry without touching its transcript (a superseded run
  // member: the fresh session replacing it carries the state forward).
  forgetSaved(id) {
    writeJSON(HISTORY_FILE, this._loadHistory().filter(h => h.id !== id));
  }

  // --- Open-tab manifest ---
  // The tabs open right now, owned by the server and rewritten on every change,
  // so it is current even after a crash. At boot its entries go to the saved
  // sessions (bootOpenTabs). Entries store session *identity*, never tabIds:
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
      if (!session.cwd) continue;             // created but never spawned
      const settings = session.getSettings();
      entries.push({
        sessId: session.sessId || null,
        kind: session.kind === 'shell' ? 'shell' : session.kind === 'sdk' ? 'sdk' : 'cli',
        cwd: session.cwd,
        title: session.title || null,
        settings,
        autoMemory: session.autoMemory === true,
        // Mid-turn when the process died: the boot archive marks it interrupted.
        busy: session.busy === true,
        // Only a plain user tab may reopen by itself (cli.reopenTabsAtBoot):
        // app action tabs, hidden tabs and orchestration run members come back
        // only from the "+" menu, where a run is resumed as a whole.
        reopenable: !session.hidden && !tabId.startsWith('app-') && !settings.orchestration,
      });
    }
    writeJSON(OPEN_TABS_FILE, entries);
  }

  // A session's busy flag changed (session-control): the manifest must know, so
  // a crash right now still leaves an "interrupted" marker.
  noteSessionState() {
    this._persistOpenTabs();
  }

  // A live session's settings changed in place (an SDK model switch): the
  // manifest and its saved entry follow, so a restart or a resume keeps it.
  noteSettingsChanged(session) {
    if (session?.sessId && session.cwd) this.saveToHistory(this._historyEntry(session));
    this._persistOpenTabs();
    this.broadcastTabs();
  }

  // Boot: what to do with the tabs the previous process left open. By default
  // nothing reopens — every one of them goes to the "+" menu (archiveOpenTabs).
  // The owner can opt back into reopening plain tabs (app-prefs
  // `cliReopenTabsAtBoot`); run members and app tabs are archived either way.
  bootOpenTabs() {
    const reopen = caps.readAppPrefs(DATA_HOME).cliReopenTabsAtBoot === true;
    if (!reopen) return { restored: 0, ...this.archiveOpenTabs() };
    return this.restoreOpenTabs();
  }

  // Move every manifest entry into the saved sessions (history) without
  // spawning anything. An entry that was mid-turn is marked interrupted. This is
  // what covers a crash or power loss, where saveAllToHistory never ran.
  archiveOpenTabs(pred = () => true) {
    const entries = readJSON(OPEN_TABS_FILE, []);
    let archived = 0;
    const rest = [];
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || !e.cwd || e.kind === 'shell' || !e.sessId) continue;
      if (!pred(e)) { rest.push(e); continue; }
      if (!this._transcriptExists(e.cwd, e.sessId)) continue;
      const saved = this.findSaved(e.sessId);
      this.saveToHistory({
        sessId: e.sessId, cwd: e.cwd, title: e.title, settings: e.settings, autoMemory: e.autoMemory,
        // A pause that completed already wrote its flags; keep them.
        flags: saved?.paused ? { paused: true, pausedAt: saved.pausedAt } : e.busy ? { interrupted: true, pausedAt: Date.now() } : {},
      });
      archived++;
    }
    writeJSON(OPEN_TABS_FILE, rest);
    return { archived };
  }

  // Bring back the plain tabs that were open when the previous process stopped
  // (only with cliReopenTabsAtBoot). Everything else is archived first. Tabs
  // that cannot be restored are reported on `this.droppedTabs` so the UI can
  // say what went missing instead of letting them vanish silently.
  restoreOpenTabs() {
    const { archived } = this.archiveOpenTabs(e => e.reopenable === false || this.findSaved(e.sessId)?.paused === true);
    const entries = readJSON(OPEN_TABS_FILE, []);
    this.droppedTabs = [];
    if (!Array.isArray(entries) || entries.length === 0) return { restored: 0, dropped: 0, archived };

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
      if (!this._transcriptExists(e.cwd, e.sessId)) {
        this.droppedTabs.push({ reason: 'no-transcript', title: label, cwd: e.cwd });
        continue;
      }
      toRestore.push(e);
    }

    if (toRestore.length === 0) {
      this._persistOpenTabs();
      return { restored: 0, dropped: this.droppedTabs.length, archived };
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
    return { restored: toRestore.length, dropped: this.droppedTabs.length, archived };
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
    return this._savedSessions().history;
  }

  // The cli:savedSessions message: the saved sessions, and one summary per
  // orchestration run among them (the CLI view's Sessions tab draws a run as
  // one card).
  savedSessionsMessage() {
    const { history, runs } = this._savedSessions();
    const live = new Map();
    for (const [tabId, session] of this.sessions) {
      if (session.sessId) live.set(session.sessId, { tabId, running: session.running, busy: session.busy, state: session.state });
    }
    return { type: 'cli:savedSessions', sessions: history, runs: summarizeRuns(history, { runs, liveOf: id => live.get(id) || null }) };
  }

  _savedSessions() {
    const history = this._loadHistory();
    const runningIds = new Set();
    for (const session of this.sessions.values()) {
      if (session.sessId && session.running) runningIds.add(session.sessId);
    }
    const runs = new Map();   // runDir -> run.json, read once per call
    for (const entry of history) {
      const stat = this._getJsonlStat(entry);
      entry.jsonlSize = stat.size;
      entry.lastInteractionAt = stat.mtime || entry.savedAt;
      entry.lastEntrySize = stat.lastEntrySize;
      if (!entry.startedAt) entry.startedAt = entry.savedAt;
      entry.isRunning = runningIds.has(entry.id);
      const dir = entry.settings?.sessionDir;
      const folder = dir ? folders.readFolder(dir) : null;
      if (folder) entry.progress = { ...folder.progress, updatedAt: folder.todoUpdatedAt, hasResume: !!folder.resume };
      // Orchestration run members make one card with their orchestrator in
      // the Sessions tab, which shows the orchestrator's last TODO rows; a
      // worker's own close/delete rules need its last report.
      const st = entry.settings?.orchestration;
      if (folder && st?.role === 'orchestrator') entry.todoTail = tailOf(folder.items);
      if (st?.runId) {
        if (!runs.has(st.runDir)) runs.set(st.runDir, readJSON(path.join(st.runDir || '', 'run.json'), null));
        const run = runs.get(st.runDir);
        const w = st.role === 'worker' ? run?.workers?.find(x => x.id === st.workerId) : null;
        entry.group = {
          runId: st.runId, role: st.role, workerId: st.workerId || null,
          orchestrator: run?.orchestrator || st.orchestrator || null,
          lastReport: w?.lastReport ? { status: w.lastReport.status, summary: String(w.lastReport.summary || '').slice(0, 200) } : null,
          completed: !!w && (w.abandoned || ['done', 'failed'].includes(w.lastReport?.status)),
          runMissing: !run,
        };
      }
    }
    return { history, runs };
  }

  transcriptExists(cwd, sessId) {
    return this._transcriptExists(cwd, sessId);
  }

  _transcriptExists(cwd, sessId) {
    if (!cwd || !sessId) return false;
    try { return fs.statSync(_jsonlPath(cwd, sessId)).size > 0; } catch { return false; }
  }

  _getJsonlStat(entry) {
    const jsonlPath = _jsonlPath(entry.cwd, entry.id);
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

  // Entries written before the orchestrator-level rule are mapped on read:
  // worktrees dropped, a directory inside an app merged into the app.
  _loadRecentDirs() {
    const dirs = readJSON(RECENT_DIRS_FILE, []);
    if (!Array.isArray(dirs)) return [];
    const seen = new Set();
    const out = [];
    for (const d of dirs) {
      const p = _recentDirOf(d?.path);
      if (!p || seen.has(p)) continue;
      seen.add(p);
      out.push({ ...d, path: p });
    }
    return out;
  }

  recordRecentDir(cwd) {
    cwd = _recentDirOf(cwd);
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
      deleteFullSessionData(this.store, id, entry.cwd);
      removeSessionFolder(entry.settings?.sessionDir);
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

  spawn(tabId, cwd, cols, rows, { resumeSessionId, autoMemory } = {}) {
    const session = this._sessionForSpawn(tabId);
    if (session.sessId && session.cwd) {
      this.saveToHistory(this._historyEntry(session));
    }
    // An SDK run's workers are areas of its panel, never tabs of their own.
    const st = session.getSettings();
    if (st.engine === 'sdk' && st.orchestration?.role === 'worker') session.hidden = true;
    this._assignTitle(session, cwd, resumeSessionId);
    // Pin the model into the tab's own settings so the spawn always carries an
    // explicit --model, and so a resume re-uses the model the session ran with
    // rather than whatever the global default happens to be now. Only filled
    // when absent: a restored tab arrives with its model already set.
    if (!session.getSettings().model) {
      session.updateSettings({ model: caps.getCliModelPref(DATA_HOME) });
    }
    // The session folder (TODO.md, NOTES.md): minted once, then kept in the
    // settings so a resume or a fresh restart lands in the same folder. A run
    // member is keyed by its --name, everything else by title + random.
    let sessionDir = session.getSettings().sessionDir;
    if (!sessionDir) {
      const s = session.getSettings();
      sessionDir = path.join(s.sessionsRoot || SESSIONS_ROOT, s.name ? folders.slugify(s.name, 64) : folders.mintKey(session.title));
      session.updateSettings({ sessionDir });
    }
    try { folders.ensureFolder(sessionDir, session.title); } catch (e) { console.error(`  session folder ${sessionDir}: ${e.message}`); }
    try {
      session.spawn(cwd, cols, rows, { resumeSessionId, autoMemory });
    } catch (e) {
      // Refused before anything ran (an SDK session without an API key): no
      // half-made tab is left behind.
      if (!session.running) {
        this.sessions.delete(tabId);
        this.broadcastTabs();
      }
      throw e;
    }
    // Persist immediately so session survives ungraceful server death
    this.saveToHistory(this._historyEntry(session));
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

  resizeFrom(ws, tabId, cols, rows) {
    const session = this.sessions.get(tabId);
    if (session) session.resizeFrom(ws, cols, rows);
  }

  claim(ws, tabId) {
    const session = this.sessions.get(tabId);
    if (session) session.claim(ws);
  }

  kill(tabId) {
    const session = this.sessions.get(tabId);
    if (session) session.kill();
  }

  remove(tabId) {
    const session = this.sessions.get(tabId);
    if (session) {
      if (session.sessId && session.cwd) {
        this.saveToHistory(this._historyEntry(session));
      }
      if (session.sessId) {
        this.store.deleteSessionData(session.sessId);
        tryRm(path.join(PACKAGE_ROOT, 'uploads', session.sessId));
      }
      session.kill('tab_close');
      // The pty's own exit arrives after the session is gone from the map, so a
      // closed tab is reported here.
      this._notifyExit(tabId, session);
      this.sessions.delete(tabId);
      this._persistOpenTabs();
    }
  }

  // Close a tab that is being paused: it is already saved (with its flags), so
  // no history write, no inspector-data delete and no exit callbacks or
  // listeners — to its owner (an app's exit check, an orchestrator) a paused
  // session has not ended. `reason` reaches the tool packs' release.
  closeQuiet(tabId, reason = 'closed') {
    const session = this.sessions.get(tabId);
    if (!session) return;
    this._exitCallbacks.delete(tabId);
    this.sessions.delete(tabId);
    session.kill(reason);
    this._persistOpenTabs();
    this.broadcastTabs();
  }

  // Shutdown path. Freezes the open-tab manifest first: these sessions are being
  // killed because the process is stopping, not because the user closed them, so
  // the manifest must keep listing them for the next boot to restore.
  killAll() {
    this._shuttingDown = true;
    for (const session of this.sessions.values()) {
      session.kill('shutdown');
    }
  }

  list() {
    const tabs = [];
    for (const [tabId, session] of this.sessions) {
      if (session.hidden) continue;
      const sdk = session instanceof SdkSession;
      tabs.push({
        tabId,
        kind: sdk ? 'sdk' : session.kind === 'shell' ? 'shell' : 'cli',
        instanceId: session.instanceId,
        sessId: session.sessId,
        autoMemory: session.autoMemory,
        status: session.status,
        cwd: session.cwd,
        title: session.title,
        settings: session.getSettings(),
        busy: session.busy === true,
        pausing: session.pausing === true,
        ...(sdk ? { state: session.state, costUsd: session.costUsd } : {}),
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

  // A finished proxied request: an SDK session adds its priced usage to the
  // running cost of the turn in progress.
  noteInteraction(interaction) {
    const session = interaction?.instanceId ? this.getByInstanceId(interaction.instanceId) : null;
    if (session?.kind === 'sdk') session.addRequestCost(interaction.usage, interaction.pricing);
  }

  getByInstanceId(instanceId) {
    for (const session of this.sessions.values()) {
      if (session.instanceId === instanceId) return session;
    }
    return null;
  }

  // The live session with this id (hidden ones included), or null.
  getBySessId(sessId) {
    if (!sessId) return null;
    for (const session of this.sessions.values()) {
      if (session.sessId === sessId) return session;
    }
    return null;
  }

  // A session's folder, live or saved: where an SDK session keeps its
  // transcript.jsonl and uploads/.
  sessionDirOf(sessId) {
    const live = this.getBySessId(sessId);
    if (live) return live.getSettings().sessionDir || null;
    return this.findSaved(sessId)?.settings?.sessionDir || null;
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
      if (!this._transcriptExists(cwd, so.resumeSessionId)) {
        throw new Error(`no transcript for session ${so.resumeSessionId} in ${cwd}`);
      }
      resumeSessionId = so.resumeSessionId;
    } else if (so.resume) {
      const cwd = opts.cwd || session.cwd;
      if (session.sessId && this._transcriptExists(cwd, session.sessId)) {
        resumeSessionId = session.sessId;
      } else if (opts.cwd) {
        const history = this._loadHistory();
        const match = history.find(h => h.cwd === opts.cwd);
        // Only resume if Claude's native transcript actually exists — otherwise
        // `claude --resume <id>` exits immediately ("No conversation found"),
        // which the client reads as the tab dying right after it opened.
        if (match && this._transcriptExists(opts.cwd, match.id)) {
          resumeSessionId = match.id;
        }
      }
    }

    this.spawn(tabId, opts.cwd, opts.cols, opts.rows, { resumeSessionId, autoMemory: opts.autoMemory === true });

    // spawn may have replaced the session object (engine change).
    if (opts.prompt && opts.autoSubmit) this.sessions.get(tabId).submit(opts.prompt, { from: opts.promptFrom });
  }

  // Roll a CLI session back one user/assistant turn: truncate the native
  // transcript (what `--resume` reads) so the last turn no longer counts toward
  // context, and flag the matching inspector interactions as deleted (kept for
  // viewing, struck through in the timeline). The running process is left alone.
  removeLastInteractionTurn(tabId) {
    const session = this.sessions.get(tabId);
    if (!session || !session.sessId || !session.cwd) return { ok: false, reason: 'no-session' };
    const sessId = session.sessId;

    const result = rollbackTranscript(session.cwd, sessId);
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

  // Called as fn(tabId, session) when any tab's process exits (not on server
  // shutdown). Covers tabs restored under a new id without per-tab arming.
  addExitListener(fn) {
    this._exitListeners.push(fn);
  }

  _notifyExit(tabId, session) {
    if (!session || this._shuttingDown) return;
    for (const fn of this._exitListeners) {
      try { fn(tabId, session); } catch (e) { console.error('Session exit listener error:', e); }
    }
  }

  broadcastTabs() {
    this.broadcaster.broadcast({ type: 'cli:tabs', bootId: this.bootId, tabs: this.list() });
  }
}

module.exports = CliSessionManager;
