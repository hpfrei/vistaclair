const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const caps = require('./capabilities');
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
  }

  get instanceId() {
    return this._instanceId;
  }

  get running() {
    return this.status === 'running' && this.pty !== null;
  }

  spawn(cwd, cols, rows, { resumeSessionId, isolated, autoMemory } = {}) {
    this._spawnGen++;
    if (this.running) this.kill();

    this.cwd = cwd;
    this.kind = 'cli';
    this.isolated = isolated === true;
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

    const safetyNote = `IMPORTANT: A Vistaclair control-room server is running from ${PROJECT_ROOT}. Never restart, stop, kill, or interfere with this server process or its ports. Do not run commands like "npm restart", "kill", "pkill", or "lsof ... | kill" targeting it.`;
    const mergedSettings = { ...this.settings };
    mergedSettings.appendSystemPrompt = mergedSettings.appendSystemPrompt
      ? mergedSettings.appendSystemPrompt + '\n\n' + safetyNote
      : safetyNote;
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

    // Hook reporters
    const reporterPath = path.join(PROJECT_ROOT, 'lib', 'hook-reporter.js');
    caps.ensureHookReporters(cwd, reporterPath);

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
      isolated: this.isolated,
      autoMemory: this.autoMemory,
      // Interactive sessions prefer the subscription (allowed); fall back to the
      // API key only when no subscription is active.
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
      isolated: this.isolated,
      autoMemory: this.autoMemory,
      hidden: this.hidden,
    });

    this._writeInternalJson({
      mode: 'cli',
      resumed: !!resumeSessionId,
      resumedFrom: resumeSessionId || null,
      isolated: this.isolated,
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
    const dir = this.sessId
      ? path.join(INTERACTIONS_DIR, this.sessId)
      : null;
    if (!dir) return;

    const record = {
      sessId: this.sessId || null,
      tabId: this.tabId || null,
      tabName: this.title || (this.cwd ? path.basename(this.cwd) : null),
      cwd: this.cwd || null,
      hidden: this.hidden || false,
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

  resize(cols, rows) {
    if (this.pty) this.pty.resize(cols, rows);
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
    let mcpServers;
    try {
      mcpServers = require('./mcp/servers');
    } catch { return null; }

    const meta = mcpServers.readMeta();
    if (!meta) return null;

    const enabledTools = (meta.tools || []).filter(t => t.enabled);
    if (enabledTools.length === 0) return null;

    const bridgePath = path.join(PACKAGE_ROOT, 'lib', 'mcp-bridge.js');

    const env = {};
    if (meta.env && typeof meta.env === 'object' && !Array.isArray(meta.env)) {
      for (const [k, v] of Object.entries(meta.env)) {
        if (k) env[k] = String(v);
      }
    }
    // Secrets are NOT injected here — the bridge decrypts secrets.enc itself at
    // spawn (via VISTACLAIR_DATA_HOME + slug), so plaintext never hits this tmp
    // config file.
    env.VISTACLAIR_DASHBOARD_PORT = String(this._dashboardPort || process.env.DASHBOARD_PORT || '3457');
    env.VISTACLAIR_AUTH_TOKEN = String(this._authToken || process.env.AUTH_TOKEN || '');
    env.VISTACLAIR_DATA_HOME = DATA_HOME;
    env.VISTACLAIR_SERVER_SLUG = mcpServers.INTEGRATED_SLUG;
    env.VISTACLAIR_INSTANCE_ID = this.instanceId;

    const config = {
      mcpServers: {
        [mcpServers.INTEGRATED_SLUG]: {
          command: 'node',
          args: [bridgePath, mcpServers.INTEGRATED_SLUG],
          env,
        },
      },
    };

    const tmpFile = path.join(os.tmpdir(), `vistaclair-cli-mcp-${Date.now()}-${process.pid}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2));
    this._mcpConfigFile = tmpFile;
    return tmpFile;
  }
}

module.exports = CliSession;
