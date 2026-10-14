const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const caps = require('./capabilities');
const { conventionNote } = require('./session-folders');
const { buildCliArgs, spawnClaudePty, sanitizeForDashboard, killGracefully, PACKAGE_ROOT, DATA_HOME } = require('./utils');

const INTERACTIONS_DIR = path.join(DATA_HOME, 'interactions');

const PROJECT_ROOT = PACKAGE_ROOT;

const DEFAULT_SETTINGS = {
  modelMap: { fable: null, opus: null, sonnet: null, haiku: null },
  showThinking: false,
};

const SCROLLBACK_LIMIT = 128 * 1024;

class CliSession {
  constructor(proxyPort, broadcaster, store, opts = {}) {
    this.proxyPort = proxyPort;
    this.broadcaster = broadcaster;
    this.store = store;
    this.pty = null;
    this.cwd = null;
    this.tabId = null;
    // 'cli' | 'shell' | null (never spawned). Recorded in the open-tab manifest:
    // a shell has no resumable transcript, so it is never auto-resumed.
    this.kind = null;
    this.sessId = null;
    this._instanceId = null;
    this.title = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.status = 'idle';
    this._mcpConfigFile = null;
    this._scrollback = '';
    this._authToken = opts.authToken || '';
    this._dashboardPort = opts.dashboardPort || 3457;
    this._spawnGen = 0;
    this.hidden = false;
    // The one PTY has one size, but every open dashboard tab renders it. The
    // viewer that last typed (or tapped in) owns the size; the others reflow
    // to whatever it chose instead of fighting over it. Keyed by WebSocket.
    this.owner = null;
    this._viewerSizes = new WeakMap();
  }

  get instanceId() {
    return this._instanceId;
  }

  get running() {
    return this.status === 'running' && this.pty !== null;
  }

  spawn(cwd, cols, rows, { resumeSessionId, autoMemory } = {}) {
    this._spawnGen++;
    if (this.running) this.kill();

    this.cwd = cwd;
    this.kind = 'cli';
    this.autoMemory = autoMemory === true;
    this.status = 'running';

    if (resumeSessionId) {
      this.sessId = resumeSessionId;
    } else {
      this.sessId = crypto.randomUUID();
    }
    this._instanceId = `cli-${this.sessId}`;
    this.store.registerSession(this.instanceId, this.sessId);

    if (resumeSessionId) {
      const store = this.store;
      const sessId = this.sessId;
      const instanceId = this.instanceId;
      const broadcaster = this.broadcaster;
      setImmediate(() => {
        const historical = store.loadSessionIntoMemory(sessId);
        if (historical.length > 0) {
          broadcaster.broadcast({
            type: 'inspector:sessionLoaded',
            sessId,
            instanceId,
            interactions: historical.map(sanitizeForDashboard).filter(Boolean),
          });
        }
      });
    }

    const mergedSettings = { ...this.settings, appendSystemPrompt: buildAppendSystemPrompt(this.settings) };
    const args = ['--dangerously-skip-permissions', ...buildCliArgs(mergedSettings)];
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else {
      args.push('--session-id', this.sessId);
    }

    // MCP config injection
    this._cleanupMcpConfig();
    const mcpConfigFile = this._buildMcpConfig();
    if (mcpConfigFile) args.push('--mcp-config', mcpConfigFile);

    this.pty = spawnClaudePty(args, {
      cwd,
      proxyPort: this.proxyPort,
      instanceId: this.instanceId,
      sourceContext: { tabId: this.tabId },
      cols: cols || 80,
      rows: rows || 24,
      dashboardPort: this._dashboardPort,
      authToken: this._authToken,
      extraEnv: { GIT_CEILING_DIRECTORIES: cwd },
      autoMemory: this.autoMemory,
      // Follows the owner's Claude credential preference (Models page), with
      // automatic fallback to whichever credential is actually configured.
      anthropicApiKey: caps.getInteractiveAuth(DATA_HOME),
    });

    this._scrollback = '';

    this.pty.onData((data) => {
      this._scrollback += data;
      if (this._scrollback.length > SCROLLBACK_LIMIT) {
        this._scrollback = this._scrollback.slice(-SCROLLBACK_LIMIT);
      }
      this.broadcaster.broadcast({ type: 'cli:output', tabId: this.tabId, data });
    });

    const gen = this._spawnGen;
    this.pty.onExit(({ exitCode }) => {
      if (gen !== this._spawnGen) return;
      this._cleanupMcpConfig();
      this.store.unregisterSession(this.instanceId);
      this.status = 'exited';
      this.pty = null;
      this.broadcaster.broadcast({ type: 'cli:exit', tabId: this.tabId, exitCode });
    });

    this.broadcaster.broadcast({
      type: 'cli:spawned',
      tabId: this.tabId,
      instanceId: this.instanceId,
      cwd: this.cwd,
      title: this.title,
      settings: this.settings,
      autoMemory: this.autoMemory,
      hidden: this.hidden,
    });

    this._writeInternalJson({
      mode: 'cli',
      resumed: !!resumeSessionId,
      resumedFrom: resumeSessionId || null,
      autoMemory: this.autoMemory,
    });
  }

  spawnShell(cwd, cols, rows) {
    if (this.running) this.kill();

    this.cwd = cwd;
    this.kind = 'shell';
    this.status = 'running';
    this._scrollback = '';

    const shell = process.env.SHELL || '/bin/bash';
    const pty = require('node-pty');
    this.pty = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env: { ...process.env },
    });

    this.pty.onData((data) => {
      this._scrollback += data;
      if (this._scrollback.length > SCROLLBACK_LIMIT) {
        this._scrollback = this._scrollback.slice(-SCROLLBACK_LIMIT);
      }
      this.broadcaster.broadcast({ type: 'cli:output', tabId: this.tabId, data });
    });

    this.pty.onExit(({ exitCode }) => {
      this.status = 'exited';
      this.pty = null;
      this.broadcaster.broadcast({ type: 'cli:exit', tabId: this.tabId, exitCode });
    });

    this.broadcaster.broadcast({
      type: 'cli:spawned',
      tabId: this.tabId,
      instanceId: this.instanceId,
      cwd: this.cwd,
      title: this.title,
      settings: this.settings,
    });

  }

  _writeInternalJson(extra = {}) {
    writeInternalJson(this, extra);
  }

  write(data) {
    if (this.pty) this.pty.write(data);
  }

  writeWhenReady(data, timeoutMs = 15000, delayMs = 0) {
    if (!this.pty) return;
    const doWrite = () => {
      if (!this.pty) return;
      if (delayMs > 0) {
        setTimeout(() => { if (this.pty) this.pty.write(data); }, delayMs);
      } else {
        this.pty.write(data);
      }
    };
    const check = () => this._scrollback && this._scrollback.includes('❯');
    if (check()) { doWrite(); return; }
    const start = Date.now();
    const interval = setInterval(() => {
      if (!this.pty) { clearInterval(interval); return; }
      if (check() || Date.now() - start > timeoutMs) {
        clearInterval(interval);
        doWrite();
      }
    }, 300);
  }

  // Send one user turn: the text, then the submitting CR as a separate PTY
  // chunk 400ms later (the CLI reads a chunk with an embedded newline as a
  // paste, so a trailing '\n' never fires Enter). `priority` and `images` are
  // SdkSession's; a terminal has no equivalent.
  submit(text) {
    this.writeWhenReady(String(text));
    this.writeWhenReady('\r', undefined, 400);
  }

  // Esc ends the running turn.
  interrupt() {
    this.write('\x1b');
  }

  resize(cols, rows) {
    if (this.pty) this.pty.resize(cols, rows);
  }

  // A viewer announces the size its terminal would like. Applied only when
  // that viewer owns the session (or nobody live does); otherwise remembered,
  // so claiming later switches the PTY to it without another round trip.
  resizeFrom(ws, cols, rows) {
    if (!cols || !rows) return;
    this._viewerSizes.set(ws, { cols, rows });
    if (this._ownerIsLive() && this.owner !== ws) return;
    this.owner = ws;
    this.resize(cols, rows);
  }

  // Typing or tapping into the terminal makes that viewer the owner and
  // gives the PTY its geometry. Cheap when the owner is unchanged.
  claim(ws) {
    if (this.owner === ws) return;
    this.owner = ws;
    const size = this._viewerSizes.get(ws);
    if (size) this.resize(size.cols, size.rows);
  }

  _ownerIsLive() {
    return !!this.owner && this.owner.readyState === 1; // WebSocket.OPEN
  }

  kill() {
    if (this.pty) {
      const pid = this.pty.pid;
      this.pty = null;
      if (pid) killGracefully(pid);
    }
    this.status = 'idle';
    this._cleanupMcpConfig();
  }

  getScrollback() {
    return this._scrollback;
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
  }

  getSettings() {
    return { ...this.settings };
  }

  _cleanupMcpConfig() {
    if (this._mcpConfigFile) {
      try { fs.unlinkSync(this._mcpConfigFile); } catch {}
      this._mcpConfigFile = null;
    }
  }

  _buildMcpConfig() {
    const servers = buildMcpServers(this._mcpOpts());
    if (Object.keys(servers).length === 0) return null;
    const config = { mcpServers: servers };

    // Random part: two tabs spawned in the same millisecond must not share (and
    // then delete) one config file.
    const tmpFile = path.join(os.tmpdir(), `vistaclair-cli-mcp-${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2));
    this._mcpConfigFile = tmpFile;
    return tmpFile;
  }

  _mcpOpts() {
    return mcpOptsOf(this);
  }

  _orchestratorMcpServer() {
    return orchestratorMcpServer(mcpOptsOf(this));
  }

  _integratedMcpServer() {
    return integratedMcpServer(mcpOptsOf(this));
  }
}

// --- Shared with SdkSession (src/sdk-session.js) ---
// One definition each of what a dashboard session gets on top of Claude Code:
// the appended system prompt, the MCP servers and the internal.json record, so
// a CLI tab and an Agent SDK session of the same settings are configured alike.

// The caller's --append-system-prompt plus the dashboard's own notes: the
// safety note, and (with a session folder) the TODO.md / NOTES.md convention
// and the trusted pause/resume channel (session-folders.js).
function buildAppendSystemPrompt(settings = {}) {
  const safetyNote = `IMPORTANT: A Vistaclair control-room server is running from ${PROJECT_ROOT}. Never restart, stop, kill, or interfere with this server process or its ports. Do not run commands like "npm restart", "kill", "pkill", or "lsof ... | kill" targeting it.`;
  const notes = settings.sessionDir ? `${safetyNote}\n\n${conventionNote(settings.sessionDir)}` : safetyNote;
  return settings.appendSystemPrompt ? settings.appendSystemPrompt + '\n\n' + notes : notes;
}

function mcpOptsOf(session) {
  return { settings: session.settings, instanceId: session.instanceId, dashboardPort: session._dashboardPort, authToken: session._authToken };
}

// Every MCP server a session gets (--mcp-config for a CLI tab, options.mcpServers
// for an SDK session): the integrated bridge and, for a run member, the
// orchestrator tools.
function buildMcpServers(opts) {
  return { ...integratedMcpServer(opts), ...orchestratorMcpServer(opts) };
}

// The tools of an orchestration run (src/orchestration.js), only for a
// session stamped with a role. The role picks the tool set; the engine adds
// SendMessage / ListAgents where Claude Code's own cross-session messaging is
// not available (SDK sessions).
function orchestratorMcpServer({ settings = {}, instanceId, dashboardPort, authToken } = {}) {
  const role = settings.orchestration?.role;
  if (role !== 'orchestrator' && role !== 'worker') return {};
  return {
    orchestrator: {
      command: 'node',
      args: [path.join(PACKAGE_ROOT, 'lib', 'orchestrator-mcp.js')],
      env: {
        VISTACLAIR_DASHBOARD_PORT: String(dashboardPort || process.env.DASHBOARD_PORT || '3457'),
        VISTACLAIR_AUTH_TOKEN: String(authToken || process.env.AUTH_TOKEN || ''),
        VISTACLAIR_INSTANCE_ID: instanceId,
        VISTACLAIR_ORCH_ROLE: role,
        VISTACLAIR_ORCH_ENGINE: settings.engine === 'sdk' ? 'sdk' : 'cli',
      },
    },
  };
}

function integratedMcpServer({ instanceId, dashboardPort, authToken } = {}) {
  let mcpServers;
  try {
    mcpServers = require('./mcp/servers');
  } catch { return {}; }

  const meta = mcpServers.readMeta();
  if (!meta) return {};

  const enabledTools = (meta.tools || []).filter(t => t.enabled);
  if (enabledTools.length === 0) return {};

  const bridgePath = path.join(PACKAGE_ROOT, 'lib', 'mcp-bridge.js');

  const env = {};
  if (meta.env && typeof meta.env === 'object' && !Array.isArray(meta.env)) {
    for (const [k, v] of Object.entries(meta.env)) {
      if (k) env[k] = String(v);
    }
  }
  // Secrets are NOT injected here — the bridge decrypts secrets.enc itself at
  // spawn (via VISTACLAIR_DATA_HOME + slug), so plaintext never hits a tmp
  // config file.
  env.VISTACLAIR_DASHBOARD_PORT = String(dashboardPort || process.env.DASHBOARD_PORT || '3457');
  env.VISTACLAIR_AUTH_TOKEN = String(authToken || process.env.AUTH_TOKEN || '');
  env.VISTACLAIR_DATA_HOME = DATA_HOME;
  env.VISTACLAIR_SERVER_SLUG = mcpServers.INTEGRATED_SLUG;
  env.VISTACLAIR_INSTANCE_ID = instanceId;

  return {
    [mcpServers.INTEGRATED_SLUG]: {
      command: 'node',
      args: [bridgePath, mcpServers.INTEGRATED_SLUG],
      env,
    },
  };
}

// Append one spawn record to interactions/<sessId>/internal.json.
function writeInternalJson(session, extra = {}) {
  const dir = session.sessId ? path.join(INTERACTIONS_DIR, session.sessId) : null;
  if (!dir) return;

  const record = {
    sessId: session.sessId || null,
    tabId: session.tabId || null,
    tabName: session.title || (session.cwd ? path.basename(session.cwd) : null),
    cwd: session.cwd || null,
    hidden: session.hidden || false,
    spawnedAt: new Date().toISOString(),
    ...extra,
  };

  const filePath = path.join(dir, 'internal.json');
  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(entries)) entries = [];
  } catch {}
  entries.push(record);
  fs.writeFile(filePath, JSON.stringify(entries, null, 2), () => {});
}

module.exports = CliSession;
module.exports.buildAppendSystemPrompt = buildAppendSystemPrompt;
module.exports.buildMcpServers = buildMcpServers;
module.exports.writeInternalJson = writeInternalJson;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.SCROLLBACK_LIMIT = SCROLLBACK_LIMIT;
