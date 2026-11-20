// Remote sessions, slave side (docs/federation.md "Remote sessions").
//
// The linked master launches and drives Agent SDK sessions on this slave over
// the existing peer channel (peer-channel.js routes `rs:cmd` frames here and
// sends what this module returns or pushes). No route, port or listener of
// its own: the channel's peer-token upgrade is the only way in.
//
//   master → slave   { type: 'rs:cmd', id, op, args }
//   slave → master   { type: 'rs:reply', id, ok, result | error: { code, message } }
//                    rs:event / rs:ask / rs:askDone / rs:state / rs:auth pushes
//
// Guards, in order: the owner's opt-in (host-config's `remoteSessions`, under
// <dataHome>, set only from this slave's dashboard) → `disabled`; a channel that did not
// arrive over TLS → `not-https`; the op allowlist and argument shapes →
// `bad-args` / `bad-app`; then per op. Every op but launch/list acts only on a
// session this module launched (the `remoteLaunch` stamp, inherited by a
// run's workers) → `not-remote`; the slave's own sessions stay invisible.
// A launch names its billing; the credential is checked here first (no
// fallback to the other one), the API key only when the owner allowed it.
// At most MAX_ACTIVE remote launches live at once (a run counts once),
// MAX_MEMBERS live remote workers, and MAX_PER_HOUR of both started per hour.
// Every launch, refused or not, is one line in the audit file
// (<dataHome>/remote-sessions/audit.jsonl, outside the apps tree a session
// works in).
//
// Remote workers: `member.launch` makes an ordinary worker of a "mirror run"
// (core's ctx.orchestration.openMirrorRun, keyed `<masterPeer>:<runId>`, one
// per master run) whose orchestrator lives on the master. Its report and
// SendMessage come back through deliver() as `rs:msg` pushes (per-member rate
// cap, a bounded backlog while the channel is down); `member.submit` is the
// master orchestrator's SendMessage. Mirror runs and backlogs persist in
// <dataHome>/remote-sessions/mirrors.json and are re-opened by key at init.
const fs = require('fs');
const path = require('path');
const hostConfig = require('./host-config');
const { SESSION_STAMPS } = require('./app-change-requests');
const { invisibleChars } = require('./text-safety');

const STAMP = SESSION_STAMPS.remote;
const OPS = new Set(['launch', 'list', 'subscribe', 'unsubscribe', 'submit', 'interrupt', 'setAuth', 'setModel', 'answer', 'history', 'todo', 'kill', 'member.launch', 'member.submit']);
const CODES = new Set(['disabled', 'not-https', 'bad-app', 'no-credential', 'apikey-not-allowed', 'limit', 'unknown-tab', 'not-remote', 'bad-args', 'unavailable']);
const APP_RE = /^[a-z0-9][a-z0-9-]*$/;
const TAB_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const MODEL_RE = /^[A-Za-z0-9._-]{1,100}(\[1m\])?$/;
const ORIGINS = new Set(['owner', 'horst', 'orchestrator']);
const AUTHS = { apikey: 'api-key', subscription: 'subscription' };
const PROMPT_MAX = 64 * 1024;
const ARGS_MAX = 80 * 1024;
const FOLDER_TEXT_MAX = 48 * 1024;
const MAX_ACTIVE = 3;
const MAX_MEMBERS = 5;   // live mirror-run members, the orchestrator's worker limit
const MAX_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;
const AUDIT_MAX_BYTES = 1024 * 1024;
const TOO_LARGE = { platform: { kind: 'notice', level: 'warning', text: 'event too large to relay' } };
const STATUS_FIELDS = ['authMethod', 'subscriptionType', 'email', 'orgName'];
const ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;   // a run id or a session address
const MEMBER_TEXT_MAX = 32 * 1024;
const REPORT_STATUSES = new Set(['started', 'done', 'failed', 'blocked']);
const BACKLOG_MAX = 50;
const MSG_RATE_MAX = 30;
const MSG_RATE_MS = 60 * 1000;
const CONTROL_RE = /(?![\n\t])\p{Cc}/gu;

let deps = {};          // { broadcaster, cliSessionManager, openCli, pendingQuestions, clearPendingQuestionsForTab, resolveAuth, claudeAuthInfo, appsDir, proDir, coreDir, orchestration }
let link = null;        // the master's live channel: { send, secure, frameCap, subs: Set<tabId> }
let unsubTap = null;
let claudeAuthStatus = null;   // last core `claude-auth:status` status
const remoteRuns = new Set();  // runIds of remote orchestrator launches
const remoteTabs = new Set();  // tabs seen starting as remote sessions
const forwardedAsks = new Set();
// Mirror runs: key → { key, peer, runId, orchestrator: { address, title }, run,
// members: Map<tabId, { address, masterAddress, queue, dropped, sent, timer }> }.
const mirrors = new Map();
let launchTimes = [];
let inflight = 0;
let inflightMembers = 0;

function fail(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function config() { return hostConfig.remoteSessions(); }
function mgr() { return deps.cliSessionManager || null; }
function auditPath() {
  const dir = hostConfig.remoteSessionsDir();
  return dir ? path.join(dir, 'audit.jsonl') : null;
}

// ---------------------------------------------------------------------------
// Identity: which sessions are remote, and their public shape.
// ---------------------------------------------------------------------------

function isRemoteSettings(s) {
  if (!s || typeof s !== 'object') return false;
  const runId = s.orchestration?.runId;
  if (s[STAMP]) {
    if (runId) remoteRuns.add(runId);
    return true;
  }
  return !!runId && remoteRuns.has(runId);
}

function settingsOf(session) {
  try { return session.getSettings() || {}; } catch { return {}; }
}

function tabOfSess(sessId) {
  const m = mgr();
  if (!m || !sessId) return null;
  const s = m.getBySessId?.(sessId);
  return s && isRemoteSettings(settingsOf(s)) ? s.tabId || null : null;
}

function roleOf(settings) {
  const r = settings.orchestration?.role;
  return r === 'orchestrator' || r === 'worker' ? r : 'simple';
}

function appOf(cwd) {
  if (!cwd || !deps.appsDir) return null;
  const rel = path.relative(deps.appsDir, cwd);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep)[0];
}

function credentialOf(settings) {
  return AUTHS[settings.auth] || null;
}

function describe(tabId, session) {
  const st = settingsOf(session);
  return {
    tabId,
    sessId: session.sessId || null,
    runId: st.orchestration?.runId || null,
    role: roleOf(st),
    state: session.running ? (session.state || 'running') : 'exited',
    title: session.title || null,
    app: appOf(session.cwd),
    credential: credentialOf(st),
    costUsd: Number(session.costUsd) || 0,
  };
}

function remoteSession(tabId) {
  if (typeof tabId !== 'string' || !TAB_RE.test(tabId)) throw fail('bad-args', 'tabId must be a tab id');
  const s = mgr()?.get(tabId);
  if (!s) throw fail('unknown-tab', `no session on tab ${tabId}`);
  if (!isRemoteSettings(settingsOf(s))) throw fail('not-remote', `tab ${tabId} is not a remote session`);
  return s;
}

function liveSession(tabId) {
  const s = remoteSession(tabId);
  if (!s.running) throw fail('unknown-tab', `the session on tab ${tabId} is not running`);
  return s;
}

// Remote launches alive now: a run once, a simple session once; or, with
// `members`, the mirror-run members, each once (their own cap). Launches
// still being opened count too, so two racing launches cannot both pass.
function activeUnits({ members = false } = {}) {
  const units = new Set();
  for (const [tabId, s] of mgr()?.sessions || []) {
    if (!s.running) continue;
    const st = settingsOf(s);
    if (!isRemoteSettings(st) || !!st[STAMP]?.member !== members) continue;
    units.add(st.orchestration?.runId && !members ? `run:${st.orchestration.runId}` : `tab:${tabId}`);
  }
  return units.size + (members ? inflightMembers : inflight);
}

// ---------------------------------------------------------------------------
// Credentials and the `claude` block of the status snapshot.
// ---------------------------------------------------------------------------

// Which Claude credentials exist, from core's credential decision: asking for
// one names it when it exists, the other otherwise (resolveAuth's fallback).
function credentials() {
  const resolve = deps.resolveAuth;
  const credentialFor = (mode) => {
    try { return typeof resolve === 'function' ? resolve(mode)?.credential || null : null; } catch { return null; }
  };
  return { apiKey: credentialFor('apikey') === 'api-key', subscription: credentialFor('subscription') === 'subscription' };
}

// Account summary for the master: the fields core's `claude auth status`
// exposes (cached from its claude-auth:status broadcast, which fires on a
// change; email / orgName also from claudeAuthInfo), never a key or token.
function claudeStatus() {
  const creds = credentials();
  let info = {};
  try { info = deps.claudeAuthInfo?.() || {}; } catch {}
  const st = claudeAuthStatus;
  const out = {
    loggedIn: st ? st.loggedIn === true : !!creds.subscription,
    authMethod: st ? null : (creds.subscription ? 'claude.ai' : null),
  };
  for (const k of STATUS_FIELDS) {
    if (st && typeof st[k] === 'string' && st[k]) out[k] = st[k].slice(0, 200);
    // core's claudeAuthInfo names the account itself (null while signed out).
    else if (typeof info[k] === 'string' && info[k]) out[k] = info[k].slice(0, 200);
    else if (out[k] === undefined) out[k] = null;
  }
  const cfg = config();
  return {
    ...out,
    apiKey: creds.apiKey,
    pref: typeof info.pref === 'string' && info.pref ? info.pref : null,
    remoteSessions: { enabled: cfg.enabled, allowApiKey: cfg.allowApiKey },
  };
}

// ---------------------------------------------------------------------------
// Frames to the master. Everything fits the channel's frame cap.
// ---------------------------------------------------------------------------

function sizeOf(frame) {
  try { return Buffer.byteLength(JSON.stringify(frame)); } catch { return Infinity; }
}

function fits(frame) {
  return sizeOf(frame) <= (link?.frameCap || 128 * 1024) - 256;
}

function active() {
  return !!link && link.secure && config().enabled;
}

function push(frame) {
  if (!active() || !fits(frame)) return false;
  try { link.send(frame); } catch { return false; }
  return true;
}

// A relayed user turn carries no images.
function relayEv(ev) {
  if (ev?.user && Array.isArray(ev.user.images) && ev.user.images.length) {
    return { ...ev, user: { ...ev.user, images: [], imagesOmitted: ev.user.images.length } };
  }
  return ev;
}

function eventFrame(tabId, env) {
  const frame = { type: 'rs:event', tabId, sessId: env.sessId || null, ...(env.off != null ? { off: env.off } : {}), ev: relayEv(env.ev) };
  return fits(frame) ? frame : { ...frame, ev: TOO_LARGE };
}

function pushEvent(tabId, env) {
  if (!link?.subs.has(tabId)) return;
  push(eventFrame(tabId, env));
}

// An exited tab leaves remoteTabs; its run leaves remoteRuns once no running
// session of it is left (a run's workers carry the stamp themselves).
function forget(tabId, runId) {
  remoteTabs.delete(tabId);
  if (!runId || !remoteRuns.has(runId)) return;
  for (const [id, s] of mgr()?.sessions || []) {
    if (id !== tabId && s.running && settingsOf(s).orchestration?.runId === runId) return;
  }
  remoteRuns.delete(runId);
}

// Core's broadcasts, seen in-process: events of subscribed remote tabs, the
// questions they ask, their start and end, and a refused login.
function onBroadcast(msg) {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'claude-auth:status') {
    claudeAuthStatus = msg.status && typeof msg.status === 'object' ? msg.status : null;
    return;
  }
  if (msg.type === 'cli:exit') memberEnded(msg.tabId);
  if (!active()) return;
  switch (msg.type) {
    case 'sdk:event': {
      if (!link.subs.size || msg.ev?.sdk?.type === 'stream_event') return;
      const tabId = tabOfSess(msg.sessId);
      if (tabId) pushEvent(tabId, msg);
      break;
    }
    case 'ask:question': {
      const s = msg.tabId ? mgr()?.get(msg.tabId) : null;
      if (!s || !isRemoteSettings(settingsOf(s))) return;
      if (push({ type: 'rs:ask', tabId: msg.tabId, askId: msg.askId, forms: msg.forms || [], title: msg.title || null })) {
        forwardedAsks.add(msg.askId);
      }
      break;
    }
    case 'ask:answered':
    case 'ask:timeout':
      if (forwardedAsks.delete(msg.askId)) push({ type: 'rs:askDone', askId: msg.askId });
      break;
    case 'cli:spawned':
      if (isRemoteSettings(msg.settings)) {
        remoteTabs.add(msg.tabId);
        push({ type: 'rs:state', tabId: msg.tabId, state: 'started', credential: credentialOf(msg.settings || {}) });
      }
      break;
    case 'cli:exit': {
      const s = mgr()?.get(msg.tabId);
      const st = s ? settingsOf(s) : {};
      if (!(s ? isRemoteSettings(st) : remoteTabs.has(msg.tabId))) return;
      push({ type: 'rs:state', tabId: msg.tabId, state: 'exited', exitCode: msg.exitCode ?? null, costUsd: Number(s?.costUsd) || 0, credential: credentialOf(st) });
      forget(msg.tabId, st.orchestration?.runId);
      break;
    }
    case 'claude-auth:needed':
      if (tabOfSess(msg.sessId)) {
        push({ type: 'rs:auth', problem: msg.reason || 'authentication_failed', text: 'The Claude subscription login on this slave was refused: sign in again on the slave\'s dashboard, or switch the session to the API key.' });
      }
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

function plainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function optString(v, max, name) {
  if (v == null) return null;
  if (typeof v !== 'string' || v.length > max) throw fail('bad-args', `${name} must be a string of at most ${max} characters`);
  return v;
}

function realOr(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// An installed app's directory: a direct child of the apps dir after
// symlinks are resolved, with a manifest, and never one holding the Pro or
// core repository.
function resolveApp(app) {
  if (typeof app !== 'string' || app.length > 64 || !APP_RE.test(app)) throw fail('bad-app', 'app must be an app name');
  const appsReal = realOr(deps.appsDir);
  const real = appsReal && realOr(path.join(deps.appsDir, app));
  if (!real || path.dirname(real) !== appsReal) throw fail('bad-app', `no app "${app}" here`);
  let isDir = false;
  try { isDir = fs.statSync(real).isDirectory() && fs.existsSync(path.join(real, 'manifest.json')); } catch {}
  if (!isDir) throw fail('bad-app', `no app "${app}" here`);
  for (const repo of [deps.proDir, deps.coreDir]) {
    const r = repo && realOr(repo);
    if (r && (r === real || r.startsWith(real + path.sep))) throw fail('bad-app', `"${app}" is not an app`);
  }
  return real;
}

function checkBilling(auth) {
  if (!AUTHS[auth]) throw fail('bad-args', 'auth must be "subscription" or "apikey"');
  if (auth === 'apikey' && !config().allowApiKey) throw fail('apikey-not-allowed', 'this slave does not allow remote sessions on its API key');
  const creds = credentials();
  if (!(auth === 'apikey' ? creds.apiKey : creds.subscription)) {
    throw fail('no-credential', auth === 'apikey' ? 'no Anthropic API key is stored on this slave' : 'no Claude subscription is signed in on this slave');
  }
}

async function launch(args, at) {
  const mode = args.mode;
  if (mode !== 'simple' && mode !== 'orchestrator') throw fail('bad-args', 'mode must be "simple" or "orchestrator"');
  const appDir = resolveApp(args.app);
  if (typeof args.prompt !== 'string' || !args.prompt.trim() || Buffer.byteLength(args.prompt) > PROMPT_MAX) {
    throw fail('bad-args', 'prompt must be a non-empty string of at most 64 KB');
  }
  // A prompt the owner approved must be the prompt Claude reads.
  if (invisibleChars(args.prompt).length) throw fail('bad-args', 'prompt contains invisible or control characters');
  const model = optString(args.model, 100, 'model');
  if (model && !MODEL_RE.test(model)) throw fail('bad-args', 'model is not a model name');
  const title = optString(args.title, 200, 'title') || `remote: ${args.app}`;
  if (invisibleChars(title).length) throw fail('bad-args', 'title contains invisible or control characters');
  const origin = args.origin;
  if (!plainObject(origin) || !ORIGINS.has(origin.kind)) throw fail('bad-args', 'origin.kind must be owner, horst or orchestrator');
  const ref = optString(origin.ref, 200, 'origin.ref');
  checkBilling(args.auth);

  launchTimes = launchTimes.filter((t) => at - t < HOUR_MS);
  if (launchTimes.length + inflight + inflightMembers >= MAX_PER_HOUR) throw fail('limit', `at most ${MAX_PER_HOUR} remote launches per hour`);
  if (activeUnits() >= MAX_ACTIVE) throw fail('limit', `at most ${MAX_ACTIVE} remote sessions at once`);
  if (typeof deps.openCli !== 'function') throw fail('disabled', 'this host cannot open Agent SDK sessions');

  const settings = {
    [STAMP]: { origin: { kind: origin.kind, ...(ref ? { ref } : {}) }, at },
    sessionsRoot: path.join(appDir, '.vistaclair', 'sessions'),
    ...(model ? { model } : {}),
  };
  inflight++;
  let res;
  try {
    res = await deps.openCli({
      mode, engine: 'sdk', auth: args.auth, cwd: appDir, title, prompt: args.prompt, autoSubmit: true, settings,
      ...(mode === 'orchestrator' ? { runsDir: path.join(appDir, '.vistaclair', 'orchestrator'), isolation: 'none' } : {}),
    });
  } finally {
    inflight--;
  }
  if (!res || res.cancelled || !res.tabId) throw fail('limit', 'a launch on this app is already pending');
  launchTimes.push(at);
  const s = mgr()?.get(res.tabId);
  const runId = s ? settingsOf(s).orchestration?.runId || null : null;
  if (runId) remoteRuns.add(runId);
  remoteTabs.add(res.tabId);
  return { tabId: res.tabId, sessId: s?.sessId || null, ...(runId ? { runId } : {}) };
}

function list() {
  const out = [];
  for (const [tabId, s] of mgr()?.sessions || []) {
    if (!isRemoteSettings(settingsOf(s))) continue;
    out.push(describe(tabId, s));
    if (out.length >= 100) break;
  }
  return out;
}

function subscribe(args) {
  const s = remoteSession(args.tabId);
  const from = args.fromOff;
  if (from != null && !(Number.isInteger(from) && from >= 0)) throw fail('bad-args', 'fromOff must be a byte offset');
  link.subs.add(args.tabId);
  // What the master missed since `fromOff`, after the reply.
  if (from != null && typeof s.historyPage === 'function') {
    setImmediate(() => {
      let page = null;
      try { page = s.historyPage({ limit: 200 }); } catch { return; }
      const events = (page?.events || []).filter((e) => e.off >= from);
      if (page?.hasMore && page.events?.length && page.events[0].off > from) {
        pushEvent(args.tabId, { sessId: s.sessId, ev: { platform: { kind: 'notice', level: 'warning', text: 'earlier events were not relayed: open the history' } } });
      }
      for (const env of events) pushEvent(args.tabId, env);
    });
  }
  return { tabId: args.tabId, sessId: s.sessId || null };
}

function textArg(v, name) {
  if (typeof v !== 'string' || !v.length || Buffer.byteLength(v) > PROMPT_MAX) throw fail('bad-args', `${name} must be a non-empty string of at most 64 KB`);
  return v;
}

// A run member switches every live member of its run; workers the run
// launches later take the run's own billing.
function setAuth(args) {
  const s = remoteSession(args.tabId);
  if (args.continueTurn != null && typeof args.continueTurn !== 'boolean') throw fail('bad-args', 'continueTurn must be a boolean');
  checkBilling(args.auth);
  const runId = settingsOf(s).orchestration?.runId;
  const members = runId
    ? [...mgr().sessions.values()].filter((m) => m.kind === 'sdk' && settingsOf(m).orchestration?.runId === runId)
    : [s];
  for (const m of members) m.setAuth(args.auth, { continueTurn: m === s && args.continueTurn === true });
  return { auth: args.auth, sessions: members.length };
}

function answer(args) {
  if (typeof args.askId !== 'string' || args.askId.length > 100) throw fail('bad-args', 'askId must be an ask id');
  if (!Array.isArray(args.answer) || args.answer.length > 50 || !args.answer.every(plainObject)) {
    throw fail('bad-args', 'answer must be a list of answers');
  }
  const pending = deps.pendingQuestions?.get?.(args.askId);
  const tabId = pending?.message?.tabId || pending?.ctx?.tabId || null;
  const s = tabId ? mgr()?.get(tabId) : null;
  if (!s || !isRemoteSettings(settingsOf(s)) || typeof pending.resolve !== 'function') {
    throw fail('not-remote', 'no pending question of a remote session has that id');
  }
  pending.resolve(args.answer);
  try { deps.broadcaster?.broadcast({ type: 'ask:answered', askId: args.askId }); } catch {}
  return { answered: true };
}

// One transcript page, shrunk until it fits a frame.
function history(args) {
  const s = remoteSession(args.tabId);
  let limit = args.limit == null ? 100 : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw fail('bad-args', 'limit must be 1..500');
  const before = args.before == null ? null : args.before;
  if (before != null && !(Number.isInteger(before) && before >= 0)) throw fail('bad-args', 'before must be a byte offset');
  if (typeof s.historyPage !== 'function') return { events: [], hasMore: false, before: null, totals: null };
  for (;;) {
    const page = s.historyPage({ limit, before });
    const events = (page.events || []).map((env) => {
      const one = { ...env, ev: relayEv(env.ev) };
      return sizeOf(one) > 16 * 1024 ? { ...env, ev: TOO_LARGE } : one;
    });
    const out = { ...page, events };
    if (fits({ type: 'rs:reply', id: 'x', ok: true, result: out }) || limit === 1) return out;
    limit = Math.max(1, Math.floor(limit / 2));
  }
}

function todo(args) {
  const s = remoteSession(args.tabId);
  const dir = settingsOf(s).sessionDir || (s.sessId ? mgr()?.sessionDirOf?.(s.sessId) : null);
  const read = (name) => {
    if (!dir) return '';
    let text = '';
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return ''; }
    return text.length > FOLDER_TEXT_MAX ? text.slice(0, FOLDER_TEXT_MAX) + '\n… (truncated)' : text;
  };
  return { todo: read('TODO.md'), notes: read('NOTES.md') };
}

// ---------------------------------------------------------------------------
// Remote workers: members of mirror runs whose orchestrator is on the master.
// ---------------------------------------------------------------------------

function mirrorsPath() {
  const dir = hostConfig.remoteSessionsDir();
  return dir ? path.join(dir, 'mirrors.json') : null;
}

// The master this slave is linked to, as the key's first part (one master).
function masterPeer() {
  try {
    return new URL(String(hostConfig.slaveInfo()?.masterUrl || '')).host.replace(/[^A-Za-z0-9.-]/g, '-') || 'master';
  } catch { return 'master'; }
}

function hookAvailable() {
  return typeof deps.orchestration?.openMirrorRun === 'function';
}

function newMember(address, masterAddress, queue = [], dropped = 0) {
  return { address, masterAddress, queue, dropped, sent: [], timer: null };
}

function memberOf(tabId) {
  for (const m of mirrors.values()) {
    const mem = m.members.get(tabId);
    if (mem) return { m, mem };
  }
  return null;
}

let mirrorsDirty = false;   // the file holds a backlog that may have changed since
function saveMirrors() {
  const file = mirrorsPath();
  if (!file) return;
  const out = {};
  let backlog = false;
  for (const [key, m] of mirrors) {
    const members = {};
    for (const [tabId, mem] of m.members) {
      members[tabId] = { address: mem.address, masterAddress: mem.masterAddress, queue: mem.queue, dropped: mem.dropped };
      if (mem.queue.length) backlog = true;
    }
    out[key] = { peer: m.peer, runId: m.runId, orchestrator: m.orchestrator, closed: !!m.closed, members };
  }
  mirrorsDirty = backlog;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(out));
    fs.renameSync(file + '.tmp', file);
  } catch (err) {
    console.warn('[peer-remote] mirrors write failed:', err.message);
  }
}

// Open, or re-open after a restart (core returns the same run for a key).
function openMirror(m) {
  m.run = deps.orchestration.openMirrorRun({
    key: m.key,
    orchestrator: { address: m.orchestrator.address, host: m.peer },
    deliver: (msg) => deliver(m.key, msg),
  });
  m.closed = false;
  return m.run;
}

// No live member left: the run closes; its record stays until the backlog
// has reached the master.
function closeMirror(m) {
  if (m.closed) return;
  m.closed = true;
  try { m.run?.close?.(); } catch (err) { console.warn('[peer-remote] mirror close failed:', err.message); }
  m.run = null;
  if (![...m.members.values()].some((mem) => mem.queue.length)) dropMirror(m);
  else saveMirrors();
}

function dropMirror(m) {
  for (const mem of m.members.values()) if (mem.timer) clearTimeout(mem.timer);
  mirrors.delete(m.key);
  saveMirrors();
}

function memberEnded(tabId) {
  const hit = memberOf(tabId);
  if (!hit || hit.m.closed) return;
  for (const t of hit.m.members.keys()) {
    if (t !== tabId && mgr()?.get(t)?.running) return;
  }
  closeMirror(hit.m);
}

function capText(v) {
  const s = String(v ?? '');
  if (Buffer.byteLength(s) <= MEMBER_TEXT_MAX) return s;
  return Buffer.from(s).subarray(0, MEMBER_TEXT_MAX - 32).toString('utf8').replace(/�+$/, '') + '\n… (truncated)';
}

// A worker's report / SendMessage to its orchestrator, from core.
function deliver(key, msg) {
  const m = mirrors.get(key);
  if (!m || !plainObject(msg)) return;
  let tabId = null;
  for (const [t, mem] of m.members) if (mem.address === msg.address) { tabId = t; break; }
  if (!tabId) return;
  let frame;
  if (msg.kind === 'report' && REPORT_STATUSES.has(msg.status)) {
    frame = { type: 'rs:msg', tabId, kind: 'report', status: msg.status, summary: capText(msg.summary) };
  } else if (msg.kind === 'message') {
    frame = { type: 'rs:msg', tabId, kind: 'message', text: capText(msg.text) };
  } else return;
  const mem = m.members.get(tabId);
  mem.queue.push(frame);
  if (mem.queue.length > BACKLOG_MAX) mem.dropped += mem.queue.splice(0, mem.queue.length - BACKLOG_MAX).length;
  pump(m, mem);
}

// Send what a member has queued while the channel is up and its rate window
// allows; the rest waits (and persists) for the window or the reconnect. The
// first frame after a loss says how many were dropped.
function pump(m, mem) {
  const now = Date.now();
  mem.sent = mem.sent.filter((t) => now - t < MSG_RATE_MS);
  while (mem.queue.length && active() && mem.sent.length < MSG_RATE_MAX) {
    const frame = mem.dropped ? { ...mem.queue[0], dropped: mem.dropped } : mem.queue[0];
    if (!push(frame)) break;
    mem.queue.shift();
    mem.dropped = 0;
    mem.sent.push(now);
  }
  if (mem.queue.length && active() && !mem.timer && mem.sent.length >= MSG_RATE_MAX) {
    mem.timer = setTimeout(() => { mem.timer = null; pump(m, mem); }, Math.max(50, MSG_RATE_MS - (now - mem.sent[0])));
    if (mem.timer.unref) mem.timer.unref();
  }
  if (m.closed && ![...m.members.values()].some((x) => x.queue.length)) return dropMirror(m);
  if (mem.queue.length || mirrorsDirty) saveMirrors();
}

function flushMirrors() {
  for (const m of [...mirrors.values()]) for (const mem of m.members.values()) if (mem.queue.length) pump(m, mem);
}

function loadMirrors() {
  const file = mirrorsPath();
  let data = null;
  try { data = file && JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!plainObject(data)) return;
  for (const [key, r] of Object.entries(data)) {
    if (!plainObject(r) || !plainObject(r.members) || !plainObject(r.orchestrator)) continue;
    const m = {
      key, peer: String(r.peer || ''), runId: String(r.runId || ''),
      orchestrator: { address: String(r.orchestrator.address || ''), title: typeof r.orchestrator.title === 'string' ? r.orchestrator.title : null },
      run: null, closed: r.closed === true, members: new Map(),
    };
    for (const [tabId, x] of Object.entries(r.members)) {
      if (!plainObject(x) || typeof x.address !== 'string') continue;
      const queue = Array.isArray(x.queue) ? x.queue.filter(plainObject).slice(-BACKLOG_MAX) : [];
      m.members.set(tabId, newMember(x.address, typeof x.masterAddress === 'string' ? x.masterAddress : null, queue, Number(x.dropped) || 0));
    }
    mirrors.set(key, m);
    if (m.closed || !hookAvailable()) continue;
    try { openMirror(m); } catch (err) {
      console.warn(`[peer-remote] mirror run ${key} did not re-open:`, err.message);
    }
  }
}

// A worker of the master run `runId`, on this slave's app. Every launch guard
// applies; members have their own live cap (the hourly one is shared) and are
// stamped remoteLaunch like any remote session (so no remote-launch tool, and
// every op works on it).
async function memberLaunch(args, at) {
  const { runId, address, orchestrator: orch } = args;
  if (typeof runId !== 'string' || !ID_RE.test(runId)) throw fail('bad-args', 'runId must be a run id');
  if (typeof address !== 'string' || !ID_RE.test(address)) throw fail('bad-args', 'address must be a session address');
  if (!plainObject(orch) || typeof orch.address !== 'string' || !ID_RE.test(orch.address)) throw fail('bad-args', 'orchestrator.address must be a session address');
  const orchTitle = optString(orch.title, 200, 'orchestrator.title');
  const appDir = resolveApp(args.app);
  if (typeof args.task !== 'string' || !args.task.trim() || Buffer.byteLength(args.task) > MEMBER_TEXT_MAX) {
    throw fail('bad-args', 'task must be a non-empty string of at most 32 KB');
  }
  if (invisibleChars(args.task).length) throw fail('bad-args', 'task contains invisible or control characters');
  const model = optString(args.model, 100, 'model');
  if (model && !MODEL_RE.test(model)) throw fail('bad-args', 'model is not a model name');
  const title = optString(args.title, 200, 'title') || `remote: ${args.app}`;
  if (invisibleChars(title).length || invisibleChars(orchTitle).length) throw fail('bad-args', 'title contains invisible or control characters');
  checkBilling(args.auth);
  if (!hookAvailable()) throw fail('unavailable', 'remote workers need a core update on this slave (orchestration.openMirrorRun)');

  launchTimes = launchTimes.filter((t) => at - t < HOUR_MS);
  if (launchTimes.length + inflight + inflightMembers >= MAX_PER_HOUR) throw fail('limit', `at most ${MAX_PER_HOUR} remote launches per hour`);
  if (activeUnits({ members: true }) >= MAX_MEMBERS) throw fail('limit', `at most ${MAX_MEMBERS} remote workers at once`);

  const peer = masterPeer();
  const key = `${peer}:${runId}`;
  let m = mirrors.get(key);
  if (!m) {
    m = { key, peer, runId, orchestrator: { address: orch.address, title: orchTitle }, run: null, closed: false, members: new Map() };
    mirrors.set(key, m);
  }
  inflightMembers++;
  let res;
  try {
    if (!m.run) openMirror(m);
    res = await m.run.launchWorker({
      title, task: args.task, cwd: appDir, auth: args.auth, ...(model ? { model } : {}),
      settings: {
        [STAMP]: { origin: { kind: 'orchestrator', runId, address }, at, member: key },
        sessionsRoot: path.join(appDir, '.vistaclair', 'sessions'),
      },
    });
    if (!res?.tabId || typeof res.address !== 'string') throw fail('unavailable', 'the mirror run did not start a worker');
  } catch (err) {
    if (!m.members.size) closeMirror(m);
    throw err;
  } finally {
    inflightMembers--;
  }
  launchTimes.push(at);
  m.members.set(res.tabId, newMember(res.address, address));
  remoteTabs.add(res.tabId);
  saveMirrors();
  return { tabId: res.tabId, memberAddress: res.address };
}

// The master orchestrator's SendMessage to one of its workers here.
async function memberSubmit(args) {
  remoteSession(args.tabId);
  const hit = memberOf(args.tabId);
  if (!hit || hit.m.closed) throw fail('not-remote', `tab ${args.tabId} is not a remote worker`);
  if (!hit.m.run) throw fail('unavailable', 'remote workers need a core update on this slave (orchestration.openMirrorRun)');
  const text = typeof args.text === 'string' ? args.text.replace(CONTROL_RE, '') : '';
  if (!text.trim() || Buffer.byteLength(text) > MEMBER_TEXT_MAX) throw fail('bad-args', 'text must be a non-empty string of at most 32 KB');
  if (typeof args.from !== 'string' || !ID_RE.test(args.from)) throw fail('bad-args', 'from must be a session address');
  await hit.m.run.submit(hit.mem.address, text, { from: `${args.from}@master` });
  return { submitted: true };
}

async function dispatch(op, args, at) {
  switch (op) {
    case 'launch': return launch(args, at);
    case 'list': return list();
    case 'subscribe': return subscribe(args);
    case 'unsubscribe':
      remoteSession(args.tabId);
      link.subs.delete(args.tabId);
      return { tabId: args.tabId };
    case 'submit': {
      const s = liveSession(args.tabId);
      s.submit(textArg(args.text, 'text'), {});
      return { submitted: true };
    }
    case 'interrupt':
      await liveSession(args.tabId).interrupt();
      return { interrupted: true };
    case 'setAuth': return setAuth(args);
    case 'setModel': {
      const s = liveSession(args.tabId);
      const model = optString(args.model, 100, 'model');
      if (!model || !MODEL_RE.test(model)) throw fail('bad-args', 'model is not a model name');
      await s.setModel(model);
      return { model };
    }
    case 'answer': return answer(args);
    case 'history': return history(args);
    case 'todo': return todo(args);
    case 'kill': {
      remoteSession(args.tabId);
      try { deps.clearPendingQuestionsForTab?.(args.tabId); } catch {}
      const hit = memberOf(args.tabId);
      if (hit?.m.run) {
        await hit.m.run.kill(hit.mem.address);
        memberEnded(args.tabId);
      } else {
        mgr().kill(args.tabId);
      }
      return { killed: true };
    }
    case 'member.launch': return memberLaunch(args, at);
    case 'member.submit': return memberSubmit(args);
    default:
      throw fail('bad-args', 'unknown op');
  }
}

function audit(entry) {
  const file = auditPath();
  if (!file) return;
  try {
    if (fs.statSync(file).size > AUDIT_MAX_BYTES) fs.renameSync(file, file + '.1');
  } catch {}
  try { fs.appendFileSync(file, JSON.stringify(entry) + '\n'); } catch (err) {
    console.warn('[peer-remote] audit write failed:', err.message);
  }
}

function auditOrigin(args) {
  const o = plainObject(args) && plainObject(args.origin) ? args.origin : null;
  if (!o) return null;
  return { kind: String(o.kind || '').slice(0, 20), ...(o.ref != null ? { ref: String(o.ref).slice(0, 200) } : {}) };
}

// One rs:cmd frame → its rs:reply (null when the frame has no usable id).
async function handleFrame(msg) {
  const id = msg?.id;
  if (!((typeof id === 'string' && id.length > 0 && id.length <= 64) || Number.isSafeInteger(id))) return null;
  const op = msg.op;
  const args = msg.args == null ? {} : msg.args;
  const at = Date.now();
  let reply;
  try {
    if (!config().enabled) throw fail('disabled', 'remote sessions are switched off on this slave');
    if (!link?.secure) throw fail('not-https', 'remote sessions need the channel over HTTPS');
    if (typeof op !== 'string' || !OPS.has(op)) throw fail('bad-args', 'unknown op');
    if (!plainObject(args) || sizeOf(args) > ARGS_MAX) throw fail('bad-args', 'args must be an object of at most 80 KB');
    const result = await dispatch(op, args, at);
    reply = { type: 'rs:reply', id, ok: true, result: result ?? null };
    if (!fits(reply)) throw fail('limit', 'the reply is too large to relay');
  } catch (err) {
    const code = CODES.has(err.code) ? err.code : 'bad-args';
    reply = { type: 'rs:reply', id, ok: false, error: { code, message: String(err.message || code).slice(0, 300) } };
  }
  if (op === 'launch' || op === 'member.launch') {
    const a = plainObject(args) ? args : {};
    const member = op === 'member.launch';
    audit({
      at: new Date(at).toISOString(),
      origin: member ? { kind: 'orchestrator', runId: String(a.runId ?? '').slice(0, 100), address: String(a.address ?? '').slice(0, 100) } : auditOrigin(a),
      app: typeof a.app === 'string' ? a.app.slice(0, 64) : null,
      mode: member ? 'member' : typeof a.mode === 'string' ? a.mode.slice(0, 20) : null,
      auth: typeof a.auth === 'string' ? a.auth.slice(0, 20) : null,
      result: reply.ok ? { ok: true, tabId: reply.result.tabId, ...(reply.result.runId ? { runId: reply.result.runId } : {}) } : { ok: false, code: reply.error.code },
    });
  }
  return reply;
}

// ---------------------------------------------------------------------------
// The channel's view of the request: TLS or not.
// ---------------------------------------------------------------------------

function isLoopback(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1';
}

// The master reached this slave over TLS when the socket itself is TLS, or a
// reverse proxy on this host (the TCP peer is loopback) says it terminated
// HTTPS — X-Forwarded-Proto from anyone else is not believed, and only its
// last value counts (the one that proxy set; earlier ones came from the client).
// And the URL the master was given at pairing (the slave's publicUrl) must be
// https://.
function channelSecure(req) {
  const pub = String(hostConfig.slaveInfo()?.publicUrl || '');
  if (!/^https:\/\//i.test(pub)) return false;
  const socket = req?.socket || {};
  if (socket.encrypted) return true;
  const xfp = String(req?.headers?.['x-forwarded-proto'] || '').split(',').pop().trim().toLowerCase();
  return isLoopback(socket.remoteAddress) && xfp === 'https';
}

// The master's channel opened (one at a time) / closed.
function attach({ send, secure, frameCap }) {
  link = { send, secure: !!secure, frameCap: frameCap || 128 * 1024, subs: new Set() };
  forwardedAsks.clear();
  // The workers' backlog, after the reply-less hello has had its turn.
  setImmediate(flushMirrors);
}

function detach() {
  link = null;
  forwardedAsks.clear();
  for (const m of mirrors.values()) for (const mem of m.members.values()) {
    if (mem.timer) { clearTimeout(mem.timer); mem.timer = null; }
  }
}

// Launches of the last hour, from the audit file: a restart does not reset
// the hourly cap.
function seedLaunchTimes(now = Date.now()) {
  launchTimes = [];
  let text = '';
  const file = auditPath();
  if (!file) return;
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return; }
  for (const line of text.split('\n')) {
    let row = null;
    try { row = JSON.parse(line); } catch { continue; }
    const t = Date.parse(row?.at);
    if (row?.result?.ok && Number.isFinite(t) && now - t < HOUR_MS) launchTimes.push(t);
  }
}

function init(options = {}) {
  shutdown();
  deps = {
    broadcaster: options.broadcaster || null,
    cliSessionManager: options.cliSessionManager || null,
    openCli: typeof options.openCli === 'function' ? options.openCli : null,
    pendingQuestions: options.pendingQuestions || null,
    clearPendingQuestionsForTab: options.clearPendingQuestionsForTab || null,
    resolveAuth: options.resolveAuth || null,
    claudeAuthInfo: options.claudeAuthInfo || null,
    appsDir: options.appsDir || null,
    proDir: options.proDir || null,
    coreDir: options.coreDir || null,
    // Core's run board; openMirrorRun is feature-detected (remote workers).
    orchestration: options.orchestration || null,
  };
  try { unsubTap = deps.broadcaster?.onBroadcast?.(onBroadcast) || null; } catch {}
  seedLaunchTimes();
  loadMirrors();
}

// Mirror runs are not closed here: they outlive a restart and re-open by key.
function shutdown() {
  if (unsubTap) { try { unsubTap(); } catch {} unsubTap = null; }
  detach();
  mirrors.clear();
  mirrorsDirty = false;
  link = null;
  remoteRuns.clear();
  remoteTabs.clear();
  forwardedAsks.clear();
  launchTimes = [];
  inflight = 0;
  inflightMembers = 0;
}

module.exports = {
  init, shutdown, attach, detach, handleFrame, channelSecure, claudeStatus,
  // exported for tests
  _internals: { onBroadcast, isRemoteSettings, MAX_ACTIVE, MAX_MEMBERS, MAX_PER_HOUR, TOO_LARGE, OPS, remoteRuns, remoteTabs, mirrors, BACKLOG_MAX, MSG_RATE_MAX },
};
