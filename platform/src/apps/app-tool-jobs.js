// Tool jobs — the runtime of job-kind app tools (docs/tool-jobs-artifacts.md "Job tools").
//
// A tool registered with `kind: 'job'` is called like any other tool; the
// call path (app-tools.callAppToolHandler) hands it here. The handler runs
// inside the provider app's ctx.jobs (name 'tool:<tool>'), the caller waits
// up to `_wait` seconds, and a job that outlives the wait is answered with its
// id at once. Its outcome is delivered later:
//
//   agent caller (orchestrator / worker of a run)  ctx.sendToSession into the
//       calling session, else its orchestrator, else queued: retried at boot
//       and every minute for 24 h.
//   app caller (ctx.tools.call)  the app's ctx.tools.onJobDone handler;
//       queued until it registers one, a restart included.
//   horst caller (an owner chat turn, app-tools.resolveCaller)  never starts
//       a job itself: stageForHorst hands it to Horst, who stages a confirm
//       card; the approved run's outcome, questions, notes and progress go to
//       the handlers Horst registers (onHorstRoute), queued and retried like
//       the agent route.
//   any other caller (the app's own aiPrompt, platform AI, cron, GUI test)
//       has no route to be told later, so it waits for the end.
//
// The ledger is one JSON file per job under <dataHome>/tool-jobs/, written on
// every transition. Closures do not survive a restart: a record still
// 'running' at boot becomes 'interrupted' and is delivered like any outcome.
// Terminal records are kept 30 days.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 4 * 3600 * 1000;
const MAX_TIMEOUT_MS = 24 * 3600 * 1000;
const WAIT_DEFAULT_S = 30;
const WAIT_MAX_S = 120;
const KEEP_MS = 30 * 24 * 3600 * 1000;
const RETRY_WINDOW_MS = 24 * 3600 * 1000;
const RETRY_INTERVAL_MS = 60 * 1000;
const TEXT_CAP = 4000;
const MAX_RESULT_BYTES = 1024 * 1024;
const LIST_MAX = 50;
const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);
const HOLDER_TYPES = new Set(['orchestrator', 'worker']);
const ID_RE = /^tj_[a-z0-9]+$/;
const FROM = 'tool-job';

let dir = null;
let sendToSession = null;
let retryTimer = null;
const records = new Map(); // id → ledger record
const live = new Map();    // id → { inline, waiters: [fn(rec)], ask: { resolve, reject, timer } | null, timeout, appJobId }
const appHandlers = new Map(); // caller app → { done?, question? }
let horstHandlers = null;      // { stage, done, question, note, progress } (onHorstRoute)
const delivering = new Set();  // ids whose onJobDone is in flight (in memory only)

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

function fileOf(id) { return path.join(dir, `${id}.json`); }

function persist(rec) {
  if (!dir) return;
  try {
    const tmp = fileOf(rec.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, fileOf(rec.id));
  } catch (err) {
    console.warn(`[tool-jobs] persist ${rec.id} failed: ${err.message}`);
  }
}

function prune() {
  const cutoff = Date.now() - KEEP_MS;
  for (const rec of [...records.values()]) {
    if (!TERMINAL.has(rec.status) || (rec.endedAt || 0) >= cutoff) continue;
    records.delete(rec.id);
    try { fs.unlinkSync(fileOf(rec.id)); } catch {}
  }
}

// init({ dataHome, sendToSession }) — loads the ledger, turns records left
// 'running' by the previous process into 'interrupted', delivers what is
// undelivered and starts the one-minute retry tick. Calling it again is a
// restart (tests rely on that).
function init(options = {}) {
  if (!options.dataHome) throw new Error('tool-jobs.init requires dataHome');
  dir = path.join(options.dataHome, 'tool-jobs');
  fs.mkdirSync(dir, { recursive: true });
  sendToSession = typeof options.sendToSession === 'function' ? options.sendToSession : null;
  records.clear();
  live.clear();
  appHandlers.clear();
  horstHandlers = null;
  delivering.clear();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (rec && ID_RE.test(rec.id || '')) records.set(rec.id, rec);
    } catch {}
  }
  prune();
  let interrupted = 0;
  for (const rec of records.values()) {
    if (rec.status !== 'running') continue;
    rec.status = 'interrupted';
    rec.endedAt = Date.now();
    rec.error = 'the server stopped while the job ran';
    rec.pendingQuestion = null;
    persist(rec);
    interrupted++;
  }
  if (interrupted) console.log(`  Tool jobs: ${interrupted} interrupted job(s) from previous run`);
  retryUndelivered();
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = setInterval(() => { try { retryUndelivered(); prune(); } catch {} }, RETRY_INTERVAL_MS);
  if (retryTimer.unref) retryTimer.unref();
}

function shutdown() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
}

// ---------------------------------------------------------------------------
// Callers: who owns a job and how its outcome travels
// ---------------------------------------------------------------------------

// The principal that may see, cancel and answer a job: a run (any session of
// it) for agents, the app for an app caller, else the owner (Horst included).
function principalOf(caller) {
  if (caller && HOLDER_TYPES.has(caller.type) && caller.runId) return `run:${caller.runId}`;
  if (caller && caller.type === 'app' && caller.appName) return `app:${caller.appName}`;
  return 'owner';
}

function routeOf(caller) {
  if (caller && HOLDER_TYPES.has(caller.type) && caller.address) return 'agent';
  if (caller && caller.type === 'app' && caller.appName) return 'app';
  if (caller && caller.type === 'horst' && caller.conversationId) return 'horst';
  return null;
}

function canAccess(rec, principal) {
  return principal === 'owner' || rec.principal === principal;
}

function callerSummary(caller) {
  const out = { type: caller.type };
  for (const k of ['appName', 'runId', 'address', 'workerId', 'orchestrator', 'conversationId', 'chatId', 'surface']) if (caller[k]) out[k] = caller[k];
  return out;
}

function waitSeconds(raw) {
  if (raw === undefined || raw === null || raw === '') return WAIT_DEFAULT_S;
  const n = Number(raw);
  if (!Number.isFinite(n)) return WAIT_DEFAULT_S;
  return Math.min(WAIT_MAX_S, Math.max(0, n));
}

function timeoutOf(def) {
  const t = Number(def && def.timeout);
  return Math.min(MAX_TIMEOUT_MS, t > 0 ? t : DEFAULT_TIMEOUT_MS);
}

function capResult(result) {
  if (result === undefined) return null;
  try {
    const size = Buffer.byteLength(JSON.stringify(result));
    if (size > MAX_RESULT_BYTES) return { _truncated: true, note: `Result (${size} bytes) exceeds the ${MAX_RESULT_BYTES}-byte ledger cap; return large output as a resource_link.` };
  } catch {
    return { _truncated: true, note: 'Result was not JSON-serializable.' };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Running a job
// ---------------------------------------------------------------------------

function newId() { return `tj_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`; }

// start({ app, tool, def, handler, args, caller, wait, runHandler })
//   wait: seconds, or Infinity (a caller with no route, callAndWait).
//   runHandler(job, fn): wraps the handler invocation (app-tools' currentCall).
// → Promise: the handler's result when the job ends inside the wait (an error
// is thrown, as from a quick tool), else the started answer.
function start({ app, tool, def, handler, args, caller, wait, runHandler }) {
  if (!dir) throw new Error('tool jobs are not initialized');
  const route = routeOf(caller);
  const id = newId();
  const rec = {
    id, app, tool, name: `${app}__${tool}`,
    caller: callerSummary(caller),
    principal: principalOf(caller),
    status: 'running',
    startedAt: Date.now(), endedAt: null,
    result: null, error: null,
    pendingQuestion: null,
    delivered: false,
    appJobId: null,
  };
  records.set(id, rec);
  persist(rec);
  const entry = { inline: true, waiters: [], ask: null, timeout: null, appJobId: null };
  live.set(id, entry);

  const effectiveWait = route ? wait : Infinity;
  const job = {
    id,
    signal: null,
    progress: (pct, label) => {
      if (entry.handle) entry.handle.setProgress(pct, label);
      if (route === 'horst') toHorst('progress', rec, { pct, label });
    },
    notify: (text) => notify(id, text),
    ask: (question, opts) => ask(id, question, opts),
  };

  entry.timeout = setTimeout(() => cancelInternal(id, 'error', 'timed out'), timeoutOf(def));
  if (entry.timeout.unref) entry.timeout.unref();

  const ended = new Promise((resolve) => entry.waiters.push(resolve));
  const appJobs = require('./app-jobs');
  try {
    const started = appJobs.startJob(app, {
      name: `tool:${tool}`,
      meta: { toolJobId: id, tool, caller: rec.caller },
      run: async (handle) => {
        entry.handle = handle;
        job.signal = handle.signal;
        handle.signal.addEventListener('abort', () => {
          // Aborted by app-jobs itself (the provider app stopped): ours ends too.
          finish(id, 'interrupted', { error: 'the provider app stopped while the job ran' });
        }, { once: true });
        try {
          const r = await runHandler(job, () => handler(args, caller, job));
          finish(id, 'done', { result: r });
          return r;
        } catch (err) {
          finish(id, 'error', { error: err && err.message ? err.message : String(err) });
          throw err;
        }
      },
    });
    entry.appJobId = started.id;
    rec.appJobId = started.id;
    if (!TERMINAL.has(rec.status)) persist(rec);
  } catch (err) {
    finish(id, 'error', { error: err.message });
  }

  const answer = (view) => {
    if (view) {
      if (view.status === 'done') return view.result;
      throw new Error(view.status === 'cancelled' ? `tool job ${id} was cancelled` : `${view.error || view.status}`);
    }
    entry.inline = false;
    return {
      content: [{ type: 'text', text: `Started ${id} (${rec.name}); the result will arrive as a message.` }],
      structuredContent: { jobId: id, status: 'running', tool: rec.name },
    };
  };
  // `_wait: 0` answers now: only a job that already ended (a synchronous
  // throw) is answered inline.
  if (effectiveWait === 0) return TERMINAL.has(rec.status) ? ended.then(answer) : Promise.resolve(answer(null));
  let waitTimer = null;
  const timedOut = effectiveWait === Infinity ? new Promise(() => {}) : new Promise((resolve) => {
    waitTimer = setTimeout(() => resolve(null), effectiveWait * 1000);
  });
  return Promise.race([ended, timedOut]).then((view) => {
    clearTimeout(waitTimer);
    return answer(view);
  });
}

function finish(id, status, { result, error } = {}) {
  const rec = records.get(id);
  if (!rec || TERMINAL.has(rec.status)) return false;
  const entry = live.get(id);
  live.delete(id);
  rec.status = status;
  rec.endedAt = Date.now();
  if (result !== undefined) rec.result = capResult(result);
  rec.error = error || null;
  rec.pendingQuestion = null;
  if (entry) {
    clearTimeout(entry.timeout);
    if (entry.ask) {
      clearTimeout(entry.ask.timer);
      entry.ask.reject(new Error(status === 'cancelled' ? 'the tool job was cancelled' : `the tool job ended (${status})`));
      entry.ask = null;
    }
  }
  // Answered inline (the caller still waited) or nobody to tell: delivered.
  if ((entry && entry.inline) || !routeOf(rec.caller)) rec.delivered = true;
  persist(rec);
  if (entry) {
    // The inline waiter gets the raw result (the ledger copy may be capped).
    const view = { ...rec, result: result !== undefined ? result : rec.result };
    for (const w of entry.waiters) { try { w(view); } catch {} }
  }
  if (!rec.delivered) deliver(rec);
  return true;
}

function cancelInternal(id, status, error) {
  const rec = records.get(id);
  if (!rec || TERMINAL.has(rec.status)) return false;
  const entry = live.get(id);
  finish(id, status, { error });
  // Aborts the handler's signal; the abort listener sees a terminal record.
  if (entry && entry.appJobId) {
    try { require('./app-jobs').cancelJob(rec.app, entry.appJobId); } catch {}
  }
  return true;
}

// ---------------------------------------------------------------------------
// Messages to the caller: the outcome, notes, questions
// ---------------------------------------------------------------------------

function trySend(address, text) {
  if (!address || !sendToSession) return false;
  try {
    const r = sendToSession(address, text, { from: FROM });
    return !!(r && r.delivered);
  } catch (err) {
    console.warn(`[tool-jobs] send to ${address} failed: ${err.message}`);
    return false;
  }
}

// The calling session, else its orchestrator.
function sendToCaller(rec, text) {
  return trySend(rec.caller.address, text) || trySend(rec.caller.orchestrator, text);
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

function asToolResult(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) return result;
  if (result === null || result === undefined) return { content: [] };
  return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
}

// `tj_… <app>__<tool> <status> (<duration>)`, the result's text (capped unless
// `full`), one line per resource_link.
function formatOutcome(rec, { full = false } = {}) {
  const lines = [`${rec.id} ${rec.name} ${rec.status} (${fmtDuration((rec.endedAt || Date.now()) - rec.startedAt)})`];
  if (rec.status === 'interrupted') lines.push(`Interrupted: ${rec.error || 'the provider stopped'}. Calling the tool again should continue the work.`);
  else if (rec.error) lines.push(`Error: ${rec.error}`);
  const res = asToolResult(rec.result);
  let text = res.content.filter((b) => b && b.type === 'text').map((b) => String(b.text)).join('\n');
  if (!text && res.structuredContent) text = JSON.stringify(res.structuredContent);
  if (text) {
    if (!full && text.length > TEXT_CAP) text = `${text.slice(0, TEXT_CAP)}\n… (truncated: tool_job_status { "jobId": "${rec.id}" } has the full result)`;
    lines.push(text);
  }
  for (const b of res.content) {
    if (!b || b.type !== 'resource_link') continue;
    const meta = [b.mimeType || 'unknown type', ...(Number.isFinite(b.size) ? [`${b.size} bytes`] : [])].join(', ');
    lines.push(`- ${b.uri} (${meta})`);
  }
  return lines.join('\n');
}

function deliver(rec) {
  const route = routeOf(rec.caller);
  if (route === 'agent') {
    if (sendToCaller(rec, formatOutcome(rec))) { rec.delivered = true; persist(rec); }
    return;
  }
  if (route === 'horst') {
    if (!horstHandlers || !horstHandlers.done || delivering.has(rec.id)) return;
    delivering.add(rec.id);
    Promise.resolve().then(() => horstHandlers.done(publicRecord(rec))).then(() => {
      rec.delivered = true;
    }, (err) => {
      console.warn(`[tool-jobs] Horst delivery failed for ${rec.id}: ${err && err.message}`);
    }).finally(() => { delivering.delete(rec.id); persist(rec); });
    return;
  }
  if (route === 'app') {
    const h = appHandlers.get(rec.caller.appName);
    if (!h || !h.done || delivering.has(rec.id)) return;
    delivering.add(rec.id);
    Promise.resolve().then(() => h.done(publicRecord(rec))).then(() => {
      rec.delivered = true;
    }, (err) => {
      console.warn(`[tool-jobs] onJobDone of ${rec.caller.appName} failed for ${rec.id}: ${err && err.message}`);
    }).finally(() => { delivering.delete(rec.id); persist(rec); });
  }
}

function deliverQuestion(rec) {
  const q = rec.pendingQuestion;
  if (!q || q.delivered) return;
  const route = routeOf(rec.caller);
  if (route === 'agent') {
    if (sendToCaller(rec, `${rec.id} asks: ${q.text} (answer with tool_job_reply)`)) { q.delivered = true; persist(rec); }
    return;
  }
  if (route === 'horst') {
    if (!horstHandlers || !horstHandlers.question) return;
    q.delivered = true;
    persist(rec);
    Promise.resolve().then(() => horstHandlers.question(publicRecord(rec))).catch((err) => {
      console.warn(`[tool-jobs] Horst question delivery failed for ${rec.id}: ${err && err.message}`);
      if (rec.pendingQuestion === q) { q.delivered = false; persist(rec); }
    });
    return;
  }
  if (route === 'app') {
    const h = appHandlers.get(rec.caller.appName);
    if (!h || !h.question) return;
    q.delivered = true;
    persist(rec);
    Promise.resolve().then(() => h.question(publicRecord(rec))).then((answer) => {
      if (answer !== undefined && answer !== null && rec.pendingQuestion === q) reply(rec.id, String(answer), rec.principal);
    }, (err) => {
      console.warn(`[tool-jobs] onJobQuestion of ${rec.caller.appName} failed for ${rec.id}: ${err && err.message}`);
      if (rec.pendingQuestion === q) { q.delivered = false; persist(rec); }
    });
  }
}

function notify(id, text) {
  const rec = records.get(id);
  if (!rec || TERMINAL.has(rec.status)) return false;
  const route = routeOf(rec.caller);
  if (route === 'horst') return toHorst('note', rec, String(text));
  if (route !== 'agent') return false;
  return sendToCaller(rec, `${id} note: ${String(text)}`);
}

// Best-effort, fire-and-forget: a note or a progress tick (never queued).
function toHorst(kind, rec, value) {
  const fn = horstHandlers && horstHandlers[kind];
  if (!fn) return false;
  Promise.resolve().then(() => fn(publicRecord(rec), value)).catch((err) => {
    console.warn(`[tool-jobs] Horst ${kind} for ${rec.id} failed: ${err && err.message}`);
  });
  return true;
}

function ask(id, question, { timeoutMs } = {}) {
  const rec = records.get(id);
  const entry = live.get(id);
  if (!rec || !entry || TERMINAL.has(rec.status)) return Promise.reject(new Error('the tool job is not running'));
  if (!routeOf(rec.caller)) return Promise.reject(new Error('this caller cannot answer questions (it has no message route)'));
  if (entry.ask) return Promise.reject(new Error('a question is already pending'));
  return new Promise((resolve, reject) => {
    entry.ask = { resolve, reject, timer: null };
    if (Number(timeoutMs) > 0) {
      entry.ask.timer = setTimeout(() => {
        if (!entry.ask) return;
        entry.ask = null;
        rec.pendingQuestion = null;
        persist(rec);
        reject(new Error('no answer in time'));
      }, Number(timeoutMs));
      if (entry.ask.timer.unref) entry.ask.timer.unref();
    }
    rec.pendingQuestion = { text: String(question), askedAt: Date.now(), delivered: false };
    persist(rec);
    deliverQuestion(rec);
  });
}

// Undelivered outcomes and questions to agents and Horst (boot + every
// minute, 24 h).
function retryUndelivered() {
  const now = Date.now();
  for (const rec of records.values()) {
    const route = routeOf(rec.caller);
    if (route !== 'agent' && route !== 'horst') continue;
    if (TERMINAL.has(rec.status)) {
      if (!rec.delivered && now - (rec.endedAt || 0) < RETRY_WINDOW_MS) deliver(rec);
    } else if (rec.pendingQuestion && !rec.pendingQuestion.delivered) {
      deliverQuestion(rec);
    }
  }
}

// ---------------------------------------------------------------------------
// Managing jobs (broker built-ins, ctx.tools, the owner)
// ---------------------------------------------------------------------------

function publicRecord(rec) {
  const out = { ...rec };
  if (rec.appJobId && rec.status === 'running') {
    try {
      const j = require('./app-jobs').getJob(rec.app, rec.appJobId);
      if (j && j.progress && Object.keys(j.progress).length) out.progress = { ...j.progress };
    } catch {}
  }
  return out;
}

function access(id, principal) {
  const rec = typeof id === 'string' ? records.get(id) : null;
  if (!rec || !canAccess(rec, principal)) throw new Error(`No tool job "${id}"`);
  return rec;
}

function get(id, principal) { return publicRecord(access(id, principal)); }

function list(principal, { limit } = {}) {
  return [...records.values()]
    .filter((r) => canAccess(r, principal))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, Math.min(LIST_MAX, Math.max(1, Number(limit) || LIST_MAX)))
    .map(publicRecord);
}

function cancel(id, principal) {
  const rec = access(id, principal);
  if (TERMINAL.has(rec.status)) return { ok: false, status: rec.status, error: `tool job already ${rec.status}` };
  cancelInternal(id, 'cancelled', null);
  return { ok: true, status: 'cancelled' };
}

function reply(id, text, principal) {
  const rec = access(id, principal);
  const entry = live.get(id);
  if (!entry || !entry.ask || !rec.pendingQuestion) throw new Error(`tool job ${id} has no pending question`);
  const { resolve, timer } = entry.ask;
  clearTimeout(timer);
  entry.ask = null;
  rec.pendingQuestion = null;
  persist(rec);
  resolve(String(text ?? ''));
  return { ok: true };
}

// An app's caller-side handlers (ctx.tools.onJobDone / onJobQuestion). The
// app's queued outcomes and questions flush on registration.
function onJobDone(appName, fn) {
  if (typeof fn !== 'function') throw new Error('onJobDone requires a handler function');
  const h = appHandlers.get(appName) || {};
  h.done = fn;
  appHandlers.set(appName, h);
  for (const rec of records.values()) {
    if (routeOf(rec.caller) === 'app' && rec.caller.appName === appName && TERMINAL.has(rec.status) && !rec.delivered) deliver(rec);
  }
  return () => { if (appHandlers.get(appName)?.done === fn) delete appHandlers.get(appName).done; };
}

function onJobQuestion(appName, fn) {
  if (typeof fn !== 'function') throw new Error('onJobQuestion requires a handler function');
  const h = appHandlers.get(appName) || {};
  h.question = fn;
  appHandlers.set(appName, h);
  for (const rec of records.values()) {
    if (routeOf(rec.caller) === 'app' && rec.caller.appName === appName && rec.status === 'running') deliverQuestion(rec);
  }
  return () => { if (appHandlers.get(appName)?.question === fn) delete appHandlers.get(appName).question; };
}

// The app stopped: its handlers die with its module instance.
function clearApp(appName) { appHandlers.delete(appName); }

// Horst's side of the horst route (agent/horst-jobs.js, at platform-horst
// init): stage(call) → the tool result an owner chat turn gets instead of a
// run; done(rec) → Promise (resolved = delivered); question(rec); note(rec,
// text); progress(rec, { pct, label }). Queued outcomes and questions flush
// on registration (a restart included).
function onHorstRoute(handlers) {
  horstHandlers = handlers && typeof handlers === 'object' ? handlers : null;
  if (horstHandlers) retryUndelivered();
  return () => { if (horstHandlers === handlers) horstHandlers = null; };
}

// A horst caller's job-tool call (app-tools.callAppToolHandler).
async function stageForHorst(call) {
  if (!horstHandlers || !horstHandlers.stage) throw new Error('job tools cannot be started from this chat (Horst is not initialized)');
  return horstHandlers.stage(call);
}

module.exports = {
  init, shutdown, start, get, list, cancel, reply, onJobDone, onJobQuestion, clearApp,
  onHorstRoute, stageForHorst,
  principalOf, waitSeconds, formatOutcome, retryUndelivered,
  WAIT_DEFAULT_S, WAIT_MAX_S, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS,
};
