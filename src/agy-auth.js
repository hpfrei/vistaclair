// The Antigravity CLI's (`agy`) own sign-in, driven from the dashboard.
//
// Vistaclair never handles agy's credentials: they live in the OS keyring
// (Secret Service) and are not read, copied or logged here. Whether agy is
// signed in is the exit code of `agy models`; signing in runs the unmodified
// `agy acp --login` in a pty: the dashboard shows its screen and types the
// pasted authorization code into it, nothing more. No output or input of that
// process is logged or stored. Same shape as src/claude-auth.js, whose
// LoginProcess is reused.

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LoginProcess } = require('./claude-auth');

const STATUS_ARGS = ['models'];
const LOGIN_ARGS = ['acp', '--login'];
const STATUS_TTL_MS = 30 * 1000;
const STATUS_TIMEOUT_MS = 15 * 1000;

// Credentials in the server's env would answer for the login: only the Google
// AI subscription login counts.
const CREDENTIAL_ENV = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AGY_ADC_AUTH', 'GOOGLE_APPLICATION_CREDENTIALS'];

// The env of the probe and the login. agy keeps its token in the Secret
// Service, so the process needs the session bus. `login` also keeps agy from
// opening a browser on the server: the owner opens the printed link elsewhere.
function agyEnv({ login = false, env = process.env, uid = process.getuid?.(), runDir = '/run/user' } = {}) {
  const out = { ...env };
  for (const k of CREDENTIAL_ENV) delete out[k];
  out.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  if (!out.DBUS_SESSION_BUS_ADDRESS && uid != null) {
    const bus = path.join(runDir, String(uid), 'bus');
    if (fs.existsSync(bus)) out.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  }
  if (login) {
    out.BROWSER = '/bin/false';
    delete out.DISPLAY;
    delete out.WAYLAND_DISPLAY;
  }
  return out;
}

// The binary: $VISTACLAIR_AGY_BIN, else `agy` on PATH, else ~/.local/bin/agy.
// Null when there is none.
function findAgyBin({ env = process.env, home = os.homedir() } = {}) {
  if (env.VISTACLAIR_AGY_BIN) return fs.existsSync(env.VISTACLAIR_AGY_BIN) ? env.VISTACLAIR_AGY_BIN : null;
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(home, '.local', 'bin'));
  for (const d of dirs) {
    const p = path.join(d, 'agy');
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

const KEYRING_RE = /keyring|secret service|org\.freedesktop\.secrets|DBUS_SESSION_BUS_ADDRESS|dbus/i;
const SIGN_IN_RE = /please sign in|sign in to|authentication required|not logged into antigravity|authentication failed or timed out/i;

// The probe's result → the status the dashboard may see. The model list and
// every other line of output stay here. `result` is { notFound?, exitCode,
// stdout, stderr }. A bare non-zero exit with no known message is 'unknown':
// not provably signed out.
function parseProbe(result) {
  if (!result || result.notFound) return { state: 'not-installed', installed: false, signedIn: false };
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  if (result.exitCode === 0) return { state: 'signed-in', installed: true, signedIn: true };
  if (KEYRING_RE.test(text)) return { state: 'keyring-locked', installed: true, signedIn: false };
  if (SIGN_IN_RE.test(text)) return { state: 'signed-out', installed: true, signedIn: false };
  return { state: 'unknown', installed: true, signedIn: false };
}

function createRunner({ bin, env = agyEnv, timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  return {
    run() {
      return new Promise((resolve) => {
        const file = typeof bin === 'function' ? bin() : (bin || findAgyBin());
        if (!file) return resolve({ notFound: true });
        const child = execFile(file, STATUS_ARGS, {
          env: env(), timeout: timeoutMs, windowsHide: true, cwd: os.homedir(), maxBuffer: 1024 * 1024,
        }, (err, stdout, stderr) => {
          if (err && err.code === 'ENOENT') return resolve({ notFound: true });
          const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
          resolve({ exitCode, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
        child.stdin?.end();
      });
    },
  };
}

// The cached `agy models` probe. Emits 'change' (status) when the answer
// differs from the previous one.
class AuthStatus extends EventEmitter {
  constructor({ runner = createRunner(), ttlMs = STATUS_TTL_MS, now = Date.now } = {}) {
    super();
    this._now = now;
    this.ttlMs = ttlMs;
    this.setRunner(runner);
  }

  setRunner(runner) {
    this._runner = runner;
    this._status = null;
    this._at = null;
    this._inflight = null;
  }

  // The cached answer, refreshed in the background once stale (null before the
  // first run).
  get() {
    if (this._at === null || this._now() - this._at >= this.ttlMs) this.refresh().catch(() => {});
    return this._status;
  }

  peek() { return this._status; }

  refresh() {
    if (this._inflight) return this._inflight;
    const run = Promise.resolve()
      .then(() => this._runner.run())
      .then((out) => { this._set(parseProbe(out)); return this._status; })
      .finally(() => { if (this._inflight === run) this._inflight = null; });
    this._inflight = run;
    return run;
  }

  invalidate() { if (this._at !== null) this._at = -Infinity; }

  _set(status) {
    const changed = JSON.stringify(status) !== JSON.stringify(this._status);
    this._status = status;
    this._at = this._now();
    if (changed) this.emit('change', status);
  }
}

function spawnLoginPty({ cols, rows, bin } = {}) {
  const file = bin || findAgyBin();
  if (!file) throw new Error('agy is not installed');
  return require('node-pty').spawn(file, LOGIN_ARGS, {
    name: 'xterm-256color', cols: cols || 80, rows: rows || 12, cwd: os.homedir(), env: agyEnv({ login: true }),
  });
}

// --- Sign-in needed -----------------------------------------------------------

const AUTH_JSON_ERROR_RE = /authenticat|sign[ -]?in|log(?:ged)? ?in\b|unauthori[sz]ed|\b401\b/i;

function jsonOf(info) {
  if (info.json && typeof info.json === 'object') return info.json;
  try { const j = JSON.parse(String(info.stdout || '').trim()); return j && typeof j === 'object' ? j : null; } catch { return null; }
}

function errorText(json) {
  const e = json && json.error;
  if (!e) return '';
  return typeof e === 'string' ? e : String(e.message || '');
}

// Why an agy run failed for lack of auth: 'keyring-locked', 'sign-in-needed'
// or null. A bare exit 1 is neither: only the messages count.
function agyAuthFailureReason({ exitCode, stdout, stderr, json } = {}) {
  const j = jsonOf({ json, stdout });
  const err = errorText(j);
  const text = `${stderr || ''}\n${err}`;
  if (/keyring is locked|secret keyring|failed to retrieve token|org\.freedesktop\.secrets|secret service/i.test(text)) return 'keyring-locked';
  if (SIGN_IN_RE.test(text)) return 'sign-in-needed';
  if (j && String(j.status).toUpperCase() === 'ERROR' && AUTH_JSON_ERROR_RE.test(err)) return 'sign-in-needed';
  return null;
}

// True when the run failed because agy is signed out (not for a locked
// keyring: that is its own reason, see agyAuthFailureReason).
function isAgySignInNeeded(info) {
  return agyAuthFailureReason(info) === 'sign-in-needed';
}

const authStatus = new AuthStatus();
const loginProcess = new LoginProcess({ spawn: spawnLoginPty });

module.exports = {
  agyEnv,
  findAgyBin,
  parseProbe,
  createRunner,
  AuthStatus,
  LoginProcess,
  spawnLoginPty,
  agyAuthFailureReason,
  isAgySignInNeeded,
  authStatus,
  loginProcess,
  CREDENTIAL_ENV,
};
