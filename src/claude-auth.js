// The `claude` CLI's own sign-in, driven from the dashboard.
//
// Vistaclair never handles Claude credentials. Whether a subscription is
// active is whatever `claude auth status --json` says (the CLI's credential
// file is its internal format and is not read here), and signing in runs the
// unmodified `claude auth login --claudeai` in a pty: the dashboard shows its
// screen and types into it (the code its "Paste code here" prompt asks for),
// nothing more. No output or input of that process is logged or stored.

const { EventEmitter } = require('events');
const { execFile, execFileSync } = require('child_process');
const os = require('os');

const STATUS_ARGS = ['auth', 'status', '--json'];
const LOGIN_ARGS = ['auth', 'login', '--claudeai'];
// `auth status` takes ~150-250 ms; within the TTL callers get the cached
// answer, after it the cached one while a background run refreshes it.
const STATUS_TTL_MS = 30 * 1000;
const STATUS_TIMEOUT_MS = 10 * 1000;
// A pasted code the CLI rejects leaves it waiting forever, and so does a
// browser tab nobody finishes.
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_KILL_GRACE_MS = 3000;
const LOGIN_REPLAY_MAX = 64 * 1024;

// A credential in the server's own env would answer for the login: with
// ANTHROPIC_API_KEY set, `auth status` reports authMethod "api_key" even
// though a subscription login exists. Spawns choose their credential
// themselves (buildClaudeEnv), so what is asked here is the login alone.
function cliEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

// The fields the dashboard may see. The CLI prints no secrets today; this
// keeps it that way whatever it adds.
const STATUS_FIELDS = ['authMethod', 'apiProvider', 'email', 'orgName', 'subscriptionType'];

// `auth status --json` output → { loggedIn, authMethod, ... } or null when it
// is not a status at all (CLI missing, crashed, changed shape). A signed-out
// CLI exits 1 but still prints the JSON, so the exit code is not consulted.
function parseAuthStatus(text) {
  let raw;
  try { raw = JSON.parse(String(text || '').trim()); } catch { return null; }
  if (!raw || typeof raw !== 'object' || typeof raw.loggedIn !== 'boolean') return null;
  const status = { loggedIn: raw.loggedIn };
  for (const k of STATUS_FIELDS) status[k] = typeof raw[k] === 'string' && raw[k] ? raw[k] : null;
  return status;
}

// Signed in to a Claude subscription (Pro/Max/Team), not a Console API login.
function isSubscription(status) {
  return !!status && status.loggedIn === true && status.authMethod === 'claude.ai';
}

const defaultRunner = {
  run() {
    return new Promise((resolve) => {
      execFile('claude', STATUS_ARGS, { env: cliEnv(), timeout: STATUS_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => resolve(String(stdout || '')));
    });
  },
  runSync() {
    try {
      return String(execFileSync('claude', STATUS_ARGS, {
        env: cliEnv(), timeout: STATUS_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      }));
    } catch (e) { return String(e.stdout || ''); }
  },
};

// The cached `auth status`. Emits 'change' (status) when the answer differs
// from the previous one.
class AuthStatus extends EventEmitter {
  constructor({ runner = defaultRunner, ttlMs = STATUS_TTL_MS, now = Date.now } = {}) {
    super();
    this._now = now;
    this.ttlMs = ttlMs;
    this.setRunner(runner);
  }

  // Swap the command (tests); forgets the cached answer.
  setRunner(runner) {
    this._runner = runner;
    this._status = null;
    this._at = null;
    this._inflight = null;
  }

  // For synchronous callers: the cached answer, refreshed in the background
  // once stale. Only the very first call, with nothing cached yet, waits for
  // the CLI (server.js primes the cache at startup so that is rare).
  get() {
    if (this._at === null) this._set(parseAuthStatus(this._runner.runSync()));
    else if (this._now() - this._at >= this.ttlMs) this.refresh().catch(() => {});
    return this._status;
  }

  // The cached answer without running anything (null before the first run).
  peek() { return this._status; }

  // Run the command now; concurrent calls share one run.
  refresh() {
    if (this._inflight) return this._inflight;
    const run = Promise.resolve()
      .then(() => this._runner.run())
      .then((out) => { this._set(parseAuthStatus(out)); return this._status; })
      .finally(() => { if (this._inflight === run) this._inflight = null; });
    this._inflight = run;
    return run;
  }

  // The login may have changed under the cache (an SDK session's call was
  // refused): the next get() refreshes.
  invalidate() { if (this._at !== null) this._at = -Infinity; }

  _set(status) {
    const changed = JSON.stringify(status) !== JSON.stringify(this._status);
    this._status = status;
    this._at = this._now();
    if (changed) this.emit('change', status);
  }
}

// `claude auth login` would open a browser on the server's desktop, with a
// localhost callback only a browser on that machine can reach. Unless the
// dashboard runs on the same machine, $BROWSER (which the CLI honours) is a
// no-op and the user opens the printed URL wherever they are, then pastes the
// code it shows.
function spawnLoginPty({ cols, rows, hostBrowser }) {
  const env = cliEnv();
  if (!hostBrowser && process.platform !== 'win32') env.BROWSER = 'true';
  return require('node-pty').spawn('claude', LOGIN_ARGS, {
    name: 'xterm-256color', cols: cols || 80, rows: rows || 12, cwd: os.homedir(), env,
  });
}

// The one `claude auth login` process. Emits 'output' (data) while it runs and
// 'exit' ({ exitCode, signal, reason }) once, reason being 'exit', 'cancelled',
// 'timeout' or whatever cancel() was given. `spawn` returns a node-pty-shaped
// process (onData, onExit, write, resize, kill).
class LoginProcess extends EventEmitter {
  constructor({ spawn = spawnLoginPty, timeoutMs = LOGIN_TIMEOUT_MS, killGraceMs = LOGIN_KILL_GRACE_MS } = {}) {
    super();
    this._spawn = spawn;
    this.timeoutMs = timeoutMs;
    this.killGraceMs = killGraceMs;
    this._proc = null;
    this._replay = '';
  }

  get running() { return !!this._proc; }

  // What it printed so far, for a dashboard that attaches mid-login.
  get replay() { return this._replay; }

  // Start the login. False when one is already running: there is only ever one.
  start(opts = {}) {
    if (this._proc) return false;
    const proc = this._spawn(opts);
    this._proc = proc;
    this._replay = '';
    this._reason = null;
    proc.onData((data) => {
      if (this._proc !== proc) return;
      this._replay = (this._replay + data).slice(-LOGIN_REPLAY_MAX);
      this.emit('output', data);
    });
    proc.onExit(({ exitCode, signal } = {}) => {
      if (this._proc !== proc) return;
      clearTimeout(this._timer);
      clearTimeout(this._killTimer);
      this._proc = null;
      this._replay = '';
      this.emit('exit', { exitCode: exitCode ?? null, signal: signal || null, reason: this._reason || 'exit' });
    });
    this._timer = setTimeout(() => this.cancel('timeout'), this.timeoutMs);
    this._timer.unref?.();
    return true;
  }

  write(data) {
    if (this._proc && typeof data === 'string' && data) this._proc.write(data);
  }

  resize(cols, rows) {
    if (!this._proc || !(cols > 0) || !(rows > 0)) return;
    try { this._proc.resize(Math.floor(cols), Math.floor(rows)); } catch {}
  }

  // Kill it (SIGTERM, then SIGKILL if it lingers). False when none is running.
  cancel(reason = 'cancelled') {
    const proc = this._proc;
    if (!proc) return false;
    if (!this._reason) this._reason = reason;
    try { proc.kill('SIGTERM'); } catch {}
    clearTimeout(this._killTimer);
    this._killTimer = setTimeout(() => {
      if (this._proc === proc) { try { proc.kill('SIGKILL'); } catch {} }
    }, this.killGraceMs);
    this._killTimer.unref?.();
    return true;
  }
}

const authStatus = new AuthStatus();
const loginProcess = new LoginProcess();

module.exports = {
  parseAuthStatus,
  isSubscription,
  AuthStatus,
  LoginProcess,
  authStatus,
  loginProcess,
};
