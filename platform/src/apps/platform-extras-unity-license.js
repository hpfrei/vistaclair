// The Unity licence of the user the server (and the apps) run as, for the
// `unity` platform extra (docs/extras-unity.md, "Licence"). Everything goes
// through bin/unity-license (platform-extras-unity.js renders it):
//   - status: `license status` + `account`, cached, on the unity row of
//     app:extras:status (`license`);
//   - sign-in: `unity-license login --json` prints a one-time URL the owner
//     approves in any browser; the child waits, then `activate` runs. Its state
//     is persisted (<appsDir>/.unity-license.json) and broadcast, so a reload
//     mid-flow shows the same URL; a server restart ends it (`failed`);
//   - the hourly check (internal cron job unity:license-check) re-activates a
//     lapsed licence while signed in, and otherwise tells observe() listeners
//     (the toolchain:license-lapsed sense, capabilities/exec.js) once per lapse;
//   - a Pro / Industry serial, kept in <appsDir>/.unity-license.enc through
//     core's secretStore, handed to `activate` in its env only.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const unity = require('./platform-extras-unity');

const LOGIN_URL_TTL_MS = 5 * 60 * 1000;   // Unity's one-time sign-in link
const LOGIN_TIMEOUT_MS = 6 * 60 * 1000;   // the waiting child is ended after this
const STATUS_MAX_AGE_MS = 60 * 1000;      // a dashboard status read refreshes older than this
const CHECK_JOB = 'unity:license-check';
const CHECK_HANDLER = 'unity.license-check';
const CHECK_SCHEDULE = '17 * * * *';

const IN_FLIGHT = new Set(['starting', 'waiting', 'activating']);

// --- pure parts (test/platform-extras-unity-license.test.js) ---

// One line of `unity auth login` output → the sign-in URL, or null. The --json
// form is a progress object `{"message":"auth_url=<url>"}`; the human form is
// `Sign-in URL:` with the URL on the next line, so any line that is only an
// https URL counts too.
function parseUnityLoginUrl(line) {
  const t = String(line || '').trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      const m = typeof j?.message === 'string' && j.message.match(/^auth_url=(https:\/\/\S+)$/);
      return m ? m[1] : null;
    } catch { return null; }
  }
  const m = t.match(/^(?:Sign-in URL:\s*)?(https:\/\/\S+)$/);
  return m ? m[1] : null;
}

// `unity auth status --json` → { loggedIn, sessionState, name, email } or null.
function parseUnityAccount(text) {
  let j;
  try { j = JSON.parse(String(text || '').trim()); } catch { return null; }
  const d = j && j.data;
  if (!d || typeof d !== 'object') return null;
  return {
    loggedIn: d.loggedIn === true,
    sessionState: d.sessionState ? String(d.sessionState) : null,
    name: d.user?.name ? String(d.user.name) : null,
    email: d.user?.email ? String(d.user.email) : null,
  };
}

// The sign-in state machine. s: { state, url, startedAt, expiresAt,
// finishedAt, error }; returns the next state (s itself when the event does
// not apply). States: idle | starting | waiting | activating | done | failed |
// expired | cancelled.
function signInReducer(s, ev, now = Date.now()) {
  const cur = s && s.state ? s : { state: 'idle' };
  const end = (state, error = null) => ({ ...cur, state, error, finishedAt: now });
  switch (ev.type) {
    case 'start':
      if (IN_FLIGHT.has(cur.state)) return cur;
      return { state: 'starting', url: null, startedAt: now, expiresAt: null, finishedAt: null, error: null };
    case 'url':
      if (cur.state !== 'starting' || !ev.url) return cur;
      return { ...cur, state: 'waiting', url: ev.url, expiresAt: now + LOGIN_URL_TTL_MS };
    case 'loginExit':
      if (cur.state !== 'starting' && cur.state !== 'waiting') return cur;
      if (ev.code === 0) return { ...cur, state: 'activating' };
      if (cur.url && cur.expiresAt && now >= cur.expiresAt) return end('expired', 'the sign-in link expired before it was approved');
      return end('failed', ev.error || `unity auth login exited ${ev.code}`);
    case 'timeout':
      if (cur.state !== 'starting' && cur.state !== 'waiting') return cur;
      return end('expired', 'the sign-in link expired before it was approved');
    case 'activated':
      if (cur.state !== 'activating') return cur;
      return ev.active ? end('done') : end('failed', ev.error || 'signed in, but the licence did not activate');
    case 'cancel':
      if (!IN_FLIGHT.has(cur.state)) return cur;
      return end('cancelled');
    case 'interrupted':
      if (!IN_FLIGHT.has(cur.state)) return cur;
      return end('failed', 'interrupted by a server restart — sign in again');
    default:
      return cur;
  }
}

// What the hourly check does with a status: ok | reactivate | alert.
function licenceVerdict(status) {
  if (!status || status.error) return { action: 'unknown' };
  if (status.active) return { action: 'ok' };
  if (status.signedIn) return { action: 'reactivate' };
  return { action: 'alert', reason: 'signed-out' };
}

// --- state ---

let appsDir = null;
let onChange = () => {};
let secretStore = null;
let installed = () => false;
let licenseBin = unity.UNITY_LICENSE;       // bin/unity-license (a test points it at a fake)
let modeFile = unity.UNITY_LICENSE_MODE;    // $ROOT/license-mode
let cron = () => require('./platform-cron');
let state = { status: null, signIn: { state: 'idle' }, alert: null, lastReactivation: null };
let child = null;
let childTimer = null;
let started = false; // start() ran: the server is up (tests never call it)
let statusInFlight = null;
let checkInFlight = null;
const observers = new Set();

const stateFile = () => path.join(appsDir, '.unity-license.json');
const serialFile = () => path.join(appsDir, '.unity-license.enc');

function load() {
  try { return { ...state, ...JSON.parse(fs.readFileSync(stateFile(), 'utf-8')) }; } catch { return state; }
}

function save() {
  if (!appsDir) return;
  const tmp = stateFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile());
}

function changed() {
  save();
  try { onChange(); } catch {}
}

function dispatch(ev) {
  const next = signInReducer(state.signIn, ev);
  if (next === state.signIn) return false;
  state.signIn = next;
  changed();
  return true;
}

// The unity row's `license` field. Sync; never touches the CLI.
function snapshot() {
  return {
    status: state.status,
    signIn: state.signIn,
    alert: state.alert,
    lastReactivation: state.lastReactivation,
    serial: hasSerial(),
  };
}

// --- the serial (Pro / Industry) ---

function readSerial() {
  if (!secretStore || !appsDir) return null;
  try { return secretStore.readSecretFile(serialFile(), appsDir, { fallback: {} })?.serial || null; } catch { return null; }
}

function hasSerial() {
  return !!(appsDir && fs.existsSync(serialFile()));
}

// Store (or with an empty value, forget) the serial. The serial itself is never
// returned to the dashboard, logged or written anywhere but the encrypted file;
// license-mode (no secret) tells bin/unity-license ensure not to fall back to
// Personal.
function setSerial(serial) {
  if (!secretStore) throw new Error('no secret store');
  const v = String(serial || '').trim();
  if (v && !/^[A-Z0-9-]{8,64}$/i.test(v)) throw new Error('that does not look like a Unity serial (letters, digits and dashes)');
  if (v) {
    secretStore.writeSecretFile(serialFile(), { serial: v }, appsDir);
    try { fs.writeFileSync(modeFile, 'serial\n'); } catch {}
  } else {
    fs.rmSync(serialFile(), { force: true });
    fs.rmSync(modeFile, { force: true });
  }
  changed();
  return { ok: true, serial: !!v };
}

// --- the CLI, through bin/unity-license ---

function licenseEnv() {
  const env = { ...process.env };
  const serial = readSerial();
  if (serial) env.UNITY_LICENSE_SERIAL = serial;
  return env;
}

function runLicense(args, { timeout = 120000, env } = {}) {
  return new Promise((resolve) => {
    execFile(licenseBin, args, { timeout, env: env || process.env }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Read the licence and the account, cache them, broadcast on change.
async function refreshStatus() {
  if (statusInFlight) return statusInFlight;
  statusInFlight = (async () => {
    const lic = await unity.unityLicenseStatus({ detail: true, bin: licenseBin });
    const acct = await runLicense(['account'], { timeout: 30000 });
    const account = parseUnityAccount(acct.stdout);
    const status = {
      active: lic.active, signedIn: lic.signedIn, products: lic.products, licenses: lic.licenses || [],
      account: account && account.loggedIn ? { name: account.name, email: account.email } : null,
      error: lic.error || null, checkedAt: Date.now(),
    };
    const before = JSON.stringify({ ...state.status, checkedAt: 0 });
    state.status = status;
    if (status.active && state.alert) state.alert = null;
    if (before !== JSON.stringify({ ...status, checkedAt: 0 })) changed(); else save();
    return status;
  })().finally(() => { statusInFlight = null; });
  return statusInFlight;
}

// A dashboard read: refresh in the background when the cache is old.
function kick() {
  if (!started || !appsDir || !installed() || statusInFlight || IN_FLIGHT.has(state.signIn.state)) return;
  if (state.status && Date.now() - (state.status.checkedAt || 0) < STATUS_MAX_AGE_MS) return;
  refreshStatus().catch(() => {});
}

async function activate() {
  const res = await runLicense(['activate'], { env: licenseEnv() });
  const status = await refreshStatus();
  const error = status.active ? null : (res.stderr || res.stdout).trim().slice(-300) || `activation exited ${res.code}`;
  state.lastReactivation = { at: Date.now(), ok: status.active, error };
  changed();
  return { ok: status.active, error };
}

// --- sign-in ---

function startSignIn() {
  if (!installed()) throw new Error('the unity extra is not installed');
  if (IN_FLIGHT.has(state.signIn.state)) return snapshot();
  dispatch({ type: 'start' });
  const p = spawn(licenseBin, ['login', '--json', '--non-interactive'], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: process.env,
  });
  child = p;
  let tail = '';
  const onData = (buf) => {
    const text = buf.toString();
    tail = (tail + text).slice(-2000);
    for (const line of text.split('\n')) {
      const url = parseUnityLoginUrl(line);
      if (url) dispatch({ type: 'url', url });
    }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  childTimer = setTimeout(() => { dispatch({ type: 'timeout' }); killChild(); }, LOGIN_TIMEOUT_MS);
  childTimer.unref?.();
  p.on('error', (err) => {
    endChild(p);
    dispatch({ type: 'loginExit', code: 1, error: err.message });
  });
  p.on('close', (code) => {
    if (child !== p) return;
    endChild(p);
    const lines = tail.split('\n').map((l) => l.trim()).filter((l) => l && !parseUnityLoginUrl(l));
    if (!dispatch({ type: 'loginExit', code, error: lines.slice(-3).join(' ').slice(-300) || null })) return;
    if (state.signIn.state !== 'activating') return;
    activate().then(
      (r) => { dispatch({ type: 'activated', active: r.ok, error: r.error }); if (r.ok) ensureCheckJob(); },
      (err) => dispatch({ type: 'activated', active: false, error: err.message }),
    );
  });
  return snapshot();
}

function endChild(p) {
  if (child === p) child = null;
  clearTimeout(childTimer);
  childTimer = null;
}

function killChild() {
  const p = child;
  if (!p) return;
  endChild(p);
  try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} }
}

function cancelSignIn() {
  killChild();
  dispatch({ type: 'cancel' });
  return snapshot();
}

// The owner's Re-activate (signed in, licence lapsed).
async function reactivate() {
  if (!installed()) throw new Error('the unity extra is not installed');
  if (IN_FLIGHT.has(state.signIn.state)) throw new Error('a sign-in is in progress');
  const r = await activate();
  if (r.ok && state.alert) { state.alert = null; changed(); }
  return { ...r, license: snapshot() };
}

// --- the hourly check ---

function observe(fn) {
  observers.add(fn);
  return () => observers.delete(fn);
}

function raise(reason, error) {
  if (state.alert && state.alert.reason === reason) return; // once per lapse
  state.alert = { reason, at: Date.now(), error: error || null };
  changed();
  for (const fn of observers) {
    try { fn({ type: 'lapsed', toolchain: 'unity', reason, error: error || null }); } catch {}
  }
}

async function check() {
  if (!installed()) return { skipped: 'unity not installed' };
  if (IN_FLIGHT.has(state.signIn.state)) return { skipped: 'sign-in in progress' };
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    const status = await refreshStatus();
    const v = licenceVerdict(status);
    if (v.action === 'unknown') return { ok: false, error: status.error || 'no status' };
    if (v.action === 'ok') return { active: true };
    if (v.action === 'alert') { raise(v.reason); return { active: false, alerted: v.reason }; }
    const r = await activate();
    if (r.ok) { if (state.alert) { state.alert = null; changed(); } return { active: true, reactivated: true }; }
    raise('reactivation-failed', r.error);
    return { active: false, alerted: 'reactivation-failed', error: r.error };
  })().finally(() => { checkInFlight = null; });
  return checkInFlight;
}

// The hourly job, registered once the extra is installed (dedup by name).
function ensureCheckJob() {
  if (!installed()) return;
  try {
    const c = cron();
    if (c.list().some((j) => j.name === CHECK_JOB)) return;
    const res = c.addJob({ name: CHECK_JOB, schedule: CHECK_SCHEDULE, target: { type: 'internal', handler: CHECK_HANDLER } });
    if (!res.ok) console.warn(`[extras] ${CHECK_JOB}: ${res.error}`);
  } catch (err) {
    console.warn(`[extras] ${CHECK_JOB}: ${err.message}`);
  }
}

// bin/unity-license and bin/unity-login as the current code renders them: a
// licence-script fix reaches an installed extra without a reinstall.
function refreshScripts() {
  if (!installed()) return [];
  const out = [];
  for (const [file, body] of [[unity.UNITY_LICENSE, unity.renderUnityLicense()], [unity.UNITY_LOGIN, unity.renderUnityLogin()]]) {
    try {
      if (fs.readFileSync(file, 'utf-8') === body) continue;
      fs.writeFileSync(`${file}.part`, body, { mode: 0o755 });
      fs.renameSync(`${file}.part`, file);
      out.push(file);
    } catch (err) {
      console.warn(`[extras] unity: cannot refresh ${file}: ${err.message}`);
    }
  }
  return out;
}

// options: { appsDir, onChange, secretStore, installed, licenseBin?, modeFile?, cron? }
// (the last three for tests).
function init(options) {
  appsDir = options.appsDir;
  onChange = options.onChange || (() => {});
  secretStore = options.secretStore || null;
  installed = options.installed || (() => false);
  licenseBin = options.licenseBin || unity.UNITY_LICENSE;
  modeFile = options.modeFile || unity.UNITY_LICENSE_MODE;
  cron = options.cron ? () => options.cron : () => require('./platform-cron');
  killChild();
  state = { status: null, signIn: { state: 'idle' }, alert: null, lastReactivation: null };
  state = load();
  // A sign-in child does not survive a restart.
  const next = signInReducer(state.signIn, { type: 'interrupted' });
  if (next !== state.signIn) { state.signIn = next; save(); }
  try { cron().registerInternal(CHECK_HANDLER, () => check()); } catch {}
}

// Server boot (index.js, once platform-cron runs): refresh the installed
// scripts, register the hourly check, and let dashboard reads refresh status.
function start() {
  started = true;
  refreshScripts();
  ensureCheckJob();
}

module.exports = {
  LOGIN_URL_TTL_MS, LOGIN_TIMEOUT_MS, CHECK_JOB, CHECK_HANDLER, CHECK_SCHEDULE,
  parseUnityLoginUrl, parseUnityAccount, signInReducer, licenceVerdict,
  init, start, snapshot, kick, refreshStatus, startSignIn, cancelSignIn, reactivate, setSerial, check, observe,
  ensureCheckJob, refreshScripts,
};
