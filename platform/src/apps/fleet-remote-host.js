// Fleet remote call / job — the SLAVE side (docs/fleet-remote.md). The app
// registers named handlers (ctx.fleet.onCall / onJob); the master's
// fleet-remote.js reaches them through peer-server.js's /fleet-remote routes,
// always for the app it names (same app, never another, no admin surface).
// A started job is an ordinary ctx.jobs job tagged { remote: { peer, id,
// origin } }; its progress goes back over the peer channel as `fr:job` frames,
// coalesced to ≤ 4 a second per job.
//
// remoteContext() is the master's origin as seen by code running inside a
// handler or a remote job, across awaits (AsyncLocalStorage):
//   { via: 'call' | 'job', peer, id, name, origin: { kind, route?, jobId?, tool?, proposalId? }, jobId? }
const { AsyncLocalStorage } = require('async_hooks');
const W = require('./fleet-remote-wire');

class HostError extends Error {
  constructor(message, status = 400, code = 'bad-request') {
    super(String(message).slice(0, W.ERROR_MAX));
    this.status = status;
    this.code = code;
  }
}

const als = new AsyncLocalStorage();
const calls = new Map();   // app → Map(name → { fn, readOnly })
const jobKinds = new Map(); // app → Map(kind → fn)
const sentMeta = new Map(); // slave job id → the meta last sent
let opts = {};
let offChange = null;
let coalescer = null;

function dep(name) {
  if (opts[name]) return opts[name];
  switch (name) {
    case 'appManager': return require('./app-manager');
    case 'hostConfig': return require('./host-config');
    case 'appJobs': return require('./app-jobs');
    case 'send': return (frame) => require('./peer-channel').sendFleetFrame(frame);
    case 'masterHost': return () => { try { return new URL(require('./host-config').slaveInfo()?.masterUrl).hostname; } catch { return null; } };
    default: return null;
  }
}

function init(options = {}) {
  opts = { ...options };
  if (offChange) offChange();
  coalescer = W.makeCoalescer((jobId, frame) => sendFrame(jobId, frame), { perSec: W.EVENTS_PER_SEC });
  offChange = dep('appJobs').onChange((app, job) => onJobChange(app, job));
}

function shutdown() {
  if (offChange) offChange();
  offChange = null;
}

// The master's origin inside a remote handler or job, or null.
function remoteContext() {
  const s = als.getStore();
  return s ? JSON.parse(JSON.stringify(s)) : null;
}

// --- Registry -----------------------------------------------------------------------

function checkRegister(app, name, fn, what) {
  if (!require('./peer-security').isAppName(app)) throw new Error(`bad app name "${app}"`);
  if (!W.isName(name)) throw new Error(`${what} name must match [a-z0-9._:-]{1,64}`);
  if (typeof fn !== 'function') throw new Error(`${what} needs a handler function`);
  if (dep('appManager').appRuntime(app) === 'own-process') {
    throw new Error(`"${app}" runs in its own process — fleet ${what} handlers are in-process only`);
  }
}

function registerCall(app, name, fn, { readOnly = false } = {}) {
  checkRegister(app, name, fn, 'onCall');
  const map = calls.get(app) || new Map();
  const entry = { fn, readOnly: readOnly === true };
  map.set(name, entry);
  calls.set(app, map);
  return () => { if (calls.get(app)?.get(name) === entry) calls.get(app).delete(name); };
}

function registerJob(app, kind, fn) {
  checkRegister(app, kind, fn, 'onJob');
  const map = jobKinds.get(app) || new Map();
  map.set(kind, fn);
  jobKinds.set(app, map);
  return () => { if (jobKinds.get(app)?.get(kind) === fn) jobKinds.get(app).delete(kind); };
}

// app-manager.stopMountedApp (stop, restart, reload): the handlers hold the
// dying module instance. Running remote jobs are app-owned, so app-jobs'
// cleanupApp interrupts them on the same path.
function unregisterApp(app) {
  calls.delete(app);
  jobKinds.delete(app);
}

function handlers(app) {
  return {
    calls: [...(calls.get(app) || new Map())].map(([name, h]) => ({ name, readOnly: h.readOnly })),
    jobs: [...(jobKinds.get(app) || new Map()).keys()],
  };
}

// --- Dispatch (peer-server.js) ----------------------------------------------------------

function checkApp(app) {
  const am = dep('appManager');
  if (!require('./peer-security').isAppName(app)) throw new HostError('bad app name', 400, 'bad-app');
  if (!am.readManifest(app)) throw new HostError(`app "${app}" is not installed on this slave`, 404, 'no-app');
  if (!dep('hostConfig').isEnabled(app)) throw new HostError(`app "${app}" is not enabled on this slave`, 409, 'not-enabled');
  if (am.appRuntime(app) === 'own-process') throw new HostError(`app "${app}" runs in its own process — no remote handlers there`, 409, 'own-process');
  if (!(am.getMountedRouter(app) || am.getRunningApp?.(app)?.port)) throw new HostError(`app "${app}" is not running on this slave`, 409, 'not-running');
}

function info(app) {
  checkApp(app);
  return handlers(app);
}

// One call: `require: 'readOnly'` (the master's caller is not the owner and
// holds no grant) runs only a handler the app declared readOnly; any other
// handler answers `needs-approval` without running.
async function call(app, body = {}, { signal: reqSignal } = {}) {
  checkApp(app);
  const { name, args } = body;
  if (!W.isName(name)) throw new HostError('bad call name', 400, 'bad-name');
  try { W.jsonSize(args, W.ARGS_MAX, 'args'); } catch (err) { throw new HostError(err.message, 413, 'too-large'); }
  const h = calls.get(app)?.get(name);
  if (!h) throw new HostError(`app "${app}" has no onCall handler "${name}" on this slave`, 404, 'no-handler');
  if (body.require === 'readOnly' && !h.readOnly) {
    throw new HostError(`"${name}" is not a readOnly handler — it needs the owner's approval`, 409, 'needs-approval');
  }
  let timeoutMs;
  try { timeoutMs = W.clampTimeout(body.timeoutMs); } catch { timeoutMs = W.TIMEOUT_DEFAULT_MS; }
  const origin = W.cleanOrigin(body.origin);
  const peer = dep('masterHost')();
  const id = W.isId(body.callId) ? body.callId : null;
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  timer.unref?.();
  const onAbort = () => ac.abort();
  reqSignal?.addEventListener('abort', onAbort, { once: true });
  const aborted = new Promise((_, reject) => ac.signal.addEventListener('abort', () => reject(new HostError(
    timedOut ? `"${name}" did not answer within ${Math.round(timeoutMs / 1000)} s` : 'the master went away', 504, 'timeout')), { once: true }));
  aborted.catch(() => {});
  const sc = require('./spend-context');
  let result;
  try {
    const run = Promise.resolve().then(() => als.run({ via: 'call', peer, id, name, origin },
      () => sc.run({ app, origin: 'fleet', principal: null }, () => h.fn(args, { peer, origin, signal: ac.signal }))));
    result = await Promise.race([run, aborted]);
  } catch (err) {
    if (err instanceof HostError) throw err;
    throw new HostError(W.cleanError(err) || 'handler failed', 422, 'remote');
  } finally {
    clearTimeout(timer);
    reqSignal?.removeEventListener('abort', onAbort);
  }
  if (result === undefined) result = null;
  try { W.jsonSize(result, W.RESULT_MAX, 'result'); } catch (err) { throw new HostError(err.message, 413, 'too-large'); }
  return { result, readOnly: h.readOnly };
}

function findRemoteJob(app, remoteJobId) {
  if (!W.isJobId(remoteJobId)) throw new HostError('bad job id', 400, 'bad-job');
  const job = dep('appJobs').getJob(app, remoteJobId);
  if (!job || !job.remote) throw new HostError(`no remote job "${remoteJobId}" in app "${app}"`, 404, 'no-job');
  return job;
}

// Start one remote job. Idempotent per master record id: a retried start
// returns the job already running for it.
async function startJob(app, body = {}) {
  checkApp(app);
  const { kind, args, id } = body;
  if (!W.isName(kind)) throw new HostError('bad job kind', 400, 'bad-name');
  if (!W.isId(id)) throw new HostError('bad remote id', 400, 'bad-id');
  try { W.jsonSize(args, W.ARGS_MAX, 'args'); } catch (err) { throw new HostError(err.message, 413, 'too-large'); }
  const appJobs = dep('appJobs');
  const existing = appJobs.listJobs(app, { limit: 200 }).find((j) => j.remote?.id === id);
  if (existing) return { remoteJobId: existing.id, attached: true };
  const fn = jobKinds.get(app)?.get(kind);
  if (!fn) throw new HostError(`app "${app}" has no onJob handler "${kind}" on this slave`, 404, 'no-handler');
  const origin = W.cleanOrigin(body.origin);
  const peer = dep('masterHost')();
  const base = { via: 'job', peer, id, name: kind, origin };
  let spec;
  try {
    spec = await als.run(base, () => fn(args, { peer, origin }));
  } catch (err) {
    throw new HostError(W.cleanError(err) || 'onJob handler failed', 422, 'remote');
  }
  if (!spec || typeof spec !== 'object' || typeof spec.run !== 'function') {
    throw new HostError(`onJob "${kind}" must return a ctx.jobs.start spec { name?, meta?, run }`, 422, 'remote');
  }
  const meta = spec.meta && typeof spec.meta === 'object' && !Array.isArray(spec.meta) ? spec.meta : {};
  const r = appJobs.startJob(app, {
    name: typeof spec.name === 'string' && spec.name ? spec.name.slice(0, 200) : kind,
    meta,
    remote: { peer, id, origin },
    run: (job) => als.run({ ...base, jobId: job.id }, () => spec.run(job)),
  });
  return { remoteJobId: r.id };
}

function jobStatus(app, remoteJobId) {
  checkApp(app);
  const j = findRemoteJob(app, remoteJobId);
  return { job: { id: j.id, name: j.name, status: j.status, progress: j.progress || {}, meta: j.meta || {}, result: j.result ?? null, error: j.error ?? null, createdAt: j.createdAt, finishedAt: j.finishedAt ?? null, remote: j.remote } };
}

function cancelJob(app, remoteJobId) {
  const j = findRemoteJob(app, remoteJobId);
  const r = dep('appJobs').cancelJob(app, j.id);
  return { cancelled: !!r.ok, status: dep('appJobs').getJob(app, j.id)?.status || null, ...(r.ok ? {} : { reason: r.error }) };
}

// --- Progress push --------------------------------------------------------------------------

const TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

function onJobChange(app, job) {
  if (!coalescer || !job.remote || !W.isId(job.remote.id)) return;
  const frame = { type: 'fr:job', app, id: job.remote.id, remoteJobId: job.id, status: job.status, progress: W.cleanProgress(job.progress) };
  coalescer.push(job.id, { frame, meta: job.meta });
  if (TERMINAL.has(job.status)) {
    coalescer.flush(job.id);
    coalescer.drop(job.id);
    sentMeta.delete(job.id);
  }
}

function sendFrame(jobId, { frame, meta }) {
  const patch = W.metaPatch(sentMeta.get(jobId), meta);
  const out = { ...frame };
  if (patch) {
    if (W.bytesOf(patch) <= W.META_MAX) out.meta = patch;
    else out.metaDropped = true;
  }
  const sent = dep('send')(out);
  if (sent && patch && !TERMINAL.has(frame.status)) sentMeta.set(jobId, JSON.parse(JSON.stringify(meta || {})));
}

module.exports = {
  init, shutdown, remoteContext,
  registerCall, registerJob, unregisterApp, handlers,
  info, call, startJob, jobStatus, cancelJob,
  HostError,
};
