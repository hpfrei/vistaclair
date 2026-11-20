// Fleet remote call / job — the MASTER side (docs/fleet-remote.md). An app
// calls a named handler of its own copy on a linked slave, or starts a job
// there, under the owner's approval; the job's progress comes back over the
// peer channel and is pushed to the app (Bridge events, routes.js `.on`, the
// bus). The slave half is fleet-remote-host.js behind peer-server.js's
// /fleet-remote routes. Internal API for the capability layer:
//
//   call(app, peer, name, args, { timeoutMs })     → result | throws err.code
//   start(app, peer, kind, args, { meta })         → { id, proposed?, proposalId? }
//   status(id) · list({ app, peer?, kind?, status? }) · cancel(id) → { ok, remoteCancelled }
//   on(app, 'progress' | 'done', fn) → off · subscribe(fn(event, data)) → off
//   addGrant(p, proposal) · startApproved(p, proposal)   the kinds' executors
//   unregisterApp(app)                                   app stop: drops its listeners
//
// Records persist in <appsDir>/.fleet-remote/ and survive a master restart;
// the live ones are re-synced from the slave's job store whenever its channel
// comes up.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const W = require('./fleet-remote-wire');
const { RemoteError } = W;

const MAX_RECORDS = 200;
const TERMINAL_TTL_MS = 30 * 24 * 3600 * 1000;
const GRANT_TTL_MS = 10 * 60 * 1000;
const RESYNC_MS = 60 * 1000;
const PERSIST_MS = 2000;
const REMOTE_META_MAX = 64 * 1024;
const START_TIMEOUT_MS = 60 * 1000;
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

let opts = {};
let records = [];   // newest first
let grants = [];    // { app, peer, name, argsSha, proposalId, expiresAt }
let persistTimer = null;
let resyncTimer = null;
let offs = [];
const results = new Map();          // id → result (lazy cache of results/<id>.json)
const appListeners = new Map();     // app → Set({ event, fn })
const appCleanups = new Map();      // app → Set(off) — other per-app listeners (dataPublish.on)
const events = new EventEmitter();
events.setMaxListeners(0);
const coalescer = W.makeCoalescer((id, payload) => deliver('fleet:job:progress', payload));

// --- Dependencies (injectable for the fake-peer tests) ----------------------------------

function d(name) {
  if (opts[name]) return opts[name];
  switch (name) {
    case 'client': return require('./peer-client');
    case 'getPeer': return (ref) => require('./peer-pairing').getPeer(ref);
    case 'appExists': return (app) => !!require('./app-manager').readManifest(app);
    case 'stateDir': return path.join(require('./app-manager').APPS_DIR, '.fleet-remote');
    case 'isOnline': return (peer) => { try { return require('./peer-channel').isConnected(peer); } catch { return false; } };
    case 'channel': return require('./peer-channel');
    case 'governance': return require('./governance/horst-governance');
    case 'spendContext': return require('./spend-context');
    default: return null;
  }
}
const stateFile = () => path.join(d('stateDir'), 'jobs.json');
const resultFile = (id) => path.join(d('stateDir'), 'results', `${id}.json`);

function init(options = {}) {
  for (const off of offs) { try { off(); } catch {} }
  offs = [];
  opts = { ...options };
  records = [];
  grants = [];
  results.clear();
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf-8'));
    records = Array.isArray(raw.jobs) ? raw.jobs : [];
    grants = Array.isArray(raw.grants) ? raw.grants : [];
  } catch {}
  prune();
  // Nothing is known about a live job until its slave's channel says so.
  for (const r of records) if (!TERMINAL.has(r.status)) r.link = d('isOnline')(r.peer) ? 'up' : 'down';
  const ch = d('channel');
  if (ch?.onEvent) {
    offs.push(ch.onEvent((ev) => {
      if (ev?.type === 'connected') linkChange(ev.peer, 'up');
      else if (ev?.type === 'disconnected') linkChange(ev.peer, 'down');
    }));
  }
  if (ch?.onFleetFrame) offs.push(ch.onFleetFrame((peer, msg) => onFrame(peer, msg)));
  // A decided remote-job proposal: a denial ends its record at once.
  const bc = options.broadcaster;
  if (bc?.onBroadcast) {
    const un = bc.onBroadcast((msg) => {
      if (msg?.type === 'horst:proposal' && msg.proposal?.kind === 'app.remote_job') checkProposal(byId(msg.proposal.payload?.id), msg.proposal);
    });
    if (typeof un === 'function') offs.push(un);
  }
  if (options.timers !== false) {
    resyncTimer = setInterval(() => { sweep().catch(() => {}); }, RESYNC_MS);
    resyncTimer.unref?.();
    setImmediate(() => { sweep().catch(() => {}); });
  }
}

function shutdown() {
  for (const off of offs) { try { off(); } catch {} }
  offs = [];
  if (resyncTimer) clearInterval(resyncTimer);
  resyncTimer = null;
  flush();
}

// --- Persistence ---------------------------------------------------------------------------

function flush() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try {
    fs.mkdirSync(d('stateDir'), { recursive: true });
    const tmp = stateFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ jobs: records, grants }));
    fs.renameSync(tmp, stateFile());
  } catch (err) {
    console.warn(`[fleet-remote] state save failed: ${err.message}`);
  }
}
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(flush, PERSIST_MS);
  persistTimer.unref?.();
}

function prune() {
  const now = Date.now();
  grants = grants.filter((g) => g && g.expiresAt > now);
  const cutoff = now - TERMINAL_TTL_MS;
  const keep = [];
  let terminalKept = 0;
  for (const r of records) {
    if (!r || !W.isId(r.id)) continue;
    const live = !TERMINAL.has(r.status);
    if (!live && ((r.endedAt || r.updatedAt || 0) < cutoff || keep.length >= MAX_RECORDS)) { dropResult(r.id); continue; }
    if (!live) terminalKept++;
    keep.push(r);
  }
  records = keep;
  return terminalKept;
}
function dropResult(id) {
  results.delete(id);
  try { fs.rmSync(resultFile(id), { force: true }); } catch {}
}
function readResult(rec) {
  if (!rec.hasResult) return null;
  if (results.has(rec.id)) return results.get(rec.id);
  let v = null;
  try { v = JSON.parse(fs.readFileSync(resultFile(rec.id), 'utf-8')); } catch {}
  if (results.size > 50) results.delete(results.keys().next().value);
  results.set(rec.id, v);
  return v;
}

// --- Records ---------------------------------------------------------------------------------

const byId = (id) => (W.isId(id) ? records.find((r) => r.id === id) || null : null);

function publicRec(rec) {
  if (!rec) return null;
  const { args, launching, hasResult, ...rest } = rec;
  return JSON.parse(JSON.stringify({ ...rest, result: readResult(rec) }));
}

function newId() { return 'fr-' + crypto.randomBytes(12).toString('hex'); }

function newRecord(app, peer, kind, { meta, origin, args, sha }) {
  const rec = {
    id: newId(), app, peer, kind, remoteJobId: null, status: 'starting',
    link: d('isOnline')(peer) ? 'up' : 'down', progress: {}, meta: meta ?? null, remoteMeta: {},
    error: null, code: null, origin, proposalId: null, argsSha: sha,
    startedAt: Date.now(), endedAt: null, updatedAt: Date.now(), args,
  };
  records.unshift(rec);
  if (records.length > MAX_RECORDS) prune();
  flush();
  return rec;
}

function status(id) { return publicRec(byId(String(id || ''))); }

function list({ app, peer, kind, status: st } = {}) {
  return records
    .filter((r) => (!app || r.app === app) && (!peer || r.peer === peer) && (!kind || r.kind === kind) && (!st || r.status === st))
    .map(publicRec);
}

// --- Events ------------------------------------------------------------------------------------

// subscribe(fn(event, data)) → unsubscribe.
//   'fleet:job:progress' { id, app, peer, kind, remoteJobId, pct, label, link, meta? }
//   'fleet:job:done'     { id, app, peer, kind, ok, status, result, error }
function subscribe(fn) {
  const a = (x) => fn('fleet:job:progress', x);
  const b = (x) => fn('fleet:job:done', x);
  events.on('fleet:job:progress', a);
  events.on('fleet:job:done', b);
  return () => { events.off('fleet:job:progress', a); events.off('fleet:job:done', b); };
}

function deliver(event, payload) {
  events.emit(event, payload);
  const set = appListeners.get(payload.app);
  if (!set) return;
  const short = event === 'fleet:job:progress' ? 'progress' : 'done';
  const { app, ...data } = payload;
  for (const l of [...set]) {
    if (l.event !== short) continue;
    try {
      const r = l.fn(JSON.parse(JSON.stringify(data)));
      if (r && typeof r.catch === 'function') r.catch((err) => guardRecord(app, err));
    } catch (err) { guardRecord(app, err); }
  }
}
function guardRecord(app, err) {
  try { require('./app-guard').record(app, 'fleet.jobs.on', err); } catch { console.warn(`[fleet-remote] ${app} listener threw: ${err?.message}`); }
}

// on(app, 'progress' | 'done', fn) → off. Dropped with the app (unregisterApp).
function on(app, event, fn) {
  if (event !== 'progress' && event !== 'done') throw new Error("event must be 'progress' or 'done'");
  if (typeof fn !== 'function') throw new Error('listener must be a function');
  const set = appListeners.get(app) || new Set();
  const l = { event, fn };
  set.add(l);
  appListeners.set(app, set);
  return () => { set.delete(l); };
}

// Another per-app listener the capability layer holds for the app
// (dataPublish.on); unregisterApp calls its off.
function trackAppListener(app, off) {
  const set = appCleanups.get(app) || new Set();
  set.add(off);
  appCleanups.set(app, set);
  return () => { if (set.delete(off)) off(); };
}

// app-manager.stopMountedApp: the app's listeners hold the dying module.
function unregisterApp(app) {
  appListeners.delete(app);
  for (const off of appCleanups.get(app) || []) { try { off(); } catch {} }
  appCleanups.delete(app);
}

function emitProgress(rec, metaPatch) {
  const prev = coalescer.pending(rec.id);
  const meta = prev?.meta || metaPatch ? { ...(prev?.meta || {}), ...(metaPatch || {}) } : undefined;
  const payload = {
    id: rec.id, app: rec.app, peer: rec.peer, kind: rec.kind, remoteJobId: rec.remoteJobId,
    pct: rec.progress?.pct ?? null, label: rec.progress?.label ?? null, link: rec.link,
    ...(meta ? { meta } : {}),
  };
  coalescer.push(rec.id, payload);
}

function end(rec, st, { result, error, code } = {}) {
  if (TERMINAL.has(rec.status)) return;
  rec.status = st;
  rec.endedAt = Date.now();
  rec.updatedAt = Date.now();
  rec.error = error ?? null;
  rec.code = code ?? null;
  delete rec.args;
  delete rec.launching;
  if (result !== undefined && result !== null) {
    try {
      fs.mkdirSync(path.dirname(resultFile(rec.id)), { recursive: true });
      fs.writeFileSync(resultFile(rec.id), JSON.stringify(result));
      rec.hasResult = true;
      results.set(rec.id, result);
    } catch (err) { console.warn(`[fleet-remote] result save failed for ${rec.id}: ${err.message}`); }
  }
  flush();
  coalescer.flush(rec.id);   // the last progress before done is never dropped
  coalescer.drop(rec.id);
  deliver('fleet:job:done', {
    id: rec.id, app: rec.app, peer: rec.peer, kind: rec.kind, ok: st === 'done', status: st,
    result: result ?? null, error: rec.error,
  });
}

// --- Origin and governance --------------------------------------------------------------------

// Who is asking, as the platform classified it on this host: the owner's
// click (a route the owner requested, or a ctx.jobs job it started) or an AI
// tool call, cron, a bot update, an app user.
function classifyOrigin() {
  const sc = d('spendContext');
  const s = sc.current() || {};
  const base = {};
  if (typeof s.route === 'string') base.route = s.route.slice(0, 200);
  if (W.isJobId(s.jobId)) base.jobId = s.jobId;
  const caller = sc.caller();
  if (caller) {
    const tool = `${caller.type || 'tool'}${caller.appName ? `:${caller.appName}` : ''}`;
    return { kind: caller.type === 'cron' ? 'cron' : 'ai', tool, ...base };
  }
  if (sc.principal() === 'owner') return { kind: 'owner', ...base };
  const o = sc.origin();
  if (o === 'cron') return { kind: 'cron', ...base };
  if (o === 'bot') return { kind: 'bot', ...base };
  return { kind: 'user', ...base };
}

function governanceOrigin() {
  const sc = d('spendContext');
  return sc.caller()?.type || sc.origin() || 'app';
}

function ledger(row) {
  try { d('governance').audit(row); } catch (err) { console.warn(`[fleet-remote] ledger row failed: ${err.message}`); }
}

function addGrant(p, proposal) {
  const g = { app: p.app, peer: p.peer, name: p.name, argsSha: p.argsSha, proposalId: proposal?.id || null, expiresAt: Date.now() + GRANT_TTL_MS };
  grants = grants.filter((x) => !(x.app === g.app && x.peer === g.peer && x.name === g.name && x.argsSha === g.argsSha));
  grants.push(g);
  prune();
  flush();
  return g;
}

function takeGrant(app, peer, name, sha) {
  prune();
  const i = grants.findIndex((g) => g.app === app && g.peer === peer && g.name === name && g.argsSha === sha);
  if (i < 0) return null;
  const [g] = grants.splice(i, 1);
  flush();
  return g;
}

function restoreGrant(g) {
  if (!g || g.expiresAt <= Date.now()) return;
  grants.push(g);
  flush();
}

// --- Transport ----------------------------------------------------------------------------------

function resolvePeer(ref) {
  const p = d('getPeer')(typeof ref === 'object' && ref ? (ref.name || ref.id) : String(ref || ''));
  if (!p) throw new Error(`unknown peer "${typeof ref === 'object' ? ref?.name : ref}" — link a slave first`);
  return p;
}

const SLAVE_CODES = {
  'no-app': 'E_NOT_RUNNING', 'not-enabled': 'E_NOT_RUNNING', 'not-running': 'E_NOT_RUNNING',
  'no-handler': 'E_NO_HANDLER', 'own-process': 'E_NO_HANDLER',
  'too-large': 'E_TOO_LARGE', timeout: 'E_TIMEOUT', remote: 'E_REMOTE',
};

// A peer-client failure → RemoteError. `timedOut` = our own deadline fired.
function mapError(err, peer, { timedOut } = {}) {
  if (err instanceof RemoteError) return err;
  if (timedOut) return new RemoteError('E_TIMEOUT', `slave "${peer.name}" did not answer in time`);
  const body = err?.body;
  const code = body && typeof body.code === 'string' ? body.code : null;
  if (err?.step === 'too-large') return new RemoteError('E_TOO_LARGE', `the answer from "${peer.name}" is over the size cap`);
  if (code === 'needs-approval') return new RemoteError('E_REFUSED', W.cleanError(body.error), { needsApproval: true });
  if (code && SLAVE_CODES[code]) return new RemoteError(SLAVE_CODES[code], W.cleanError(body.error) || code, { slaveCode: code });
  if (code === 'no-job') return new RemoteError('E_REMOTE', W.cleanError(body.error) || code, { slaveCode: code });
  if (err?.status === 404 && !code) {
    return new RemoteError('E_NO_HANDLER', `vistaclair-pro on "${peer.name}" predates fleet remote calls — update vistaclair-pro there`);
  }
  if (!err?.status || err.status === 403 || err.status === 429 || err.status >= 502) {
    return new RemoteError('E_OFFLINE', `slave "${peer.name}" is not reachable: ${W.cleanError(err?.message)}`);
  }
  return new RemoteError('E_REMOTE', W.cleanError(body?.error || err?.message) || 'remote error');
}

async function slaveCall(peer, apiPath, { method = 'GET', body, timeoutMs = START_TIMEOUT_MS, maxBytes = W.RESULT_MAX + 64 * 1024 } = {}) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  timer.unref?.();
  try {
    return await d('client').call(peer, apiPath, { method, body, timeoutMs: timeoutMs + 1000, signal: ac.signal, maxBytes });
  } catch (err) {
    throw mapError(err, peer, { timedOut });
  } finally {
    clearTimeout(timer);
  }
}

// --- call -----------------------------------------------------------------------------------------

async function call(app, peerRef, name, args, { timeoutMs } = {}) {
  if (!require('./peer-security').isAppName(app) || !d('appExists')(app)) throw new Error(`unknown app "${app}"`);
  if (!W.isName(name)) throw new Error('call name must match [a-z0-9._:-]{1,64}');
  const argsBytes = W.jsonSize(args === undefined ? null : args, W.ARGS_MAX, 'args');
  const ms = W.clampTimeout(timeoutMs);
  const peer = resolvePeer(peerRef);
  if (!d('isOnline')(peer.name)) throw new RemoteError('E_OFFLINE', `slave "${peer.name}" is not connected`);
  const origin = classifyOrigin();
  const sha = W.argsSha(args);
  let grant = null;
  if (origin.kind !== 'owner') {
    grant = takeGrant(app, peer.name, name, sha);
    if (grant) origin.proposalId = grant.proposalId;
  }
  const mode = origin.kind === 'owner' ? 'owner' : grant ? 'granted' : 'readOnly';
  const callId = newId();
  const what = `"${name}" of app "${app}" on slave "${peer.name}" (args ${sha.slice(0, 12)}…)`;
  let res;
  try {
    res = await slaveCall(peer, `/fleet-remote/${app}/call`, {
      method: 'POST',
      body: { name, args: args === undefined ? null : args, origin, timeoutMs: ms, require: mode === 'readOnly' ? 'readOnly' : null, callId },
      timeoutMs: ms + 2000,
    });
  } catch (err) {
    if (err.needsApproval) return refuseCall(app, peer, name, sha, args, argsBytes, origin);
    // The handler never ran: the grant stays for the retry.
    if (grant && ['E_OFFLINE', 'E_NOT_RUNNING', 'E_NO_HANDLER'].includes(err.code)) restoreGrant(grant);
    if (mode !== 'readOnly' && ['E_REMOTE', 'E_TIMEOUT', 'E_TOO_LARGE'].includes(err.code)) {
      ledger({ action: 'executed', kind: 'app.remote_call', ok: false, via: `app:${app}`, proposalId: grant?.proposalId || null,
        peer: peer.name, name, argsSha: sha, origin, summary: `Remote call ${what} — ${mode === 'owner' ? "owner's click" : 'approved retry'}: ${err.code}` });
    }
    console.log(`[fleet-remote] call ${app}/${name} → ${peer.name} (${origin.kind}) failed: ${err.code}`);
    throw err;
  }
  const result = res?.result === undefined ? null : res.result;
  W.jsonSize(result, W.RESULT_MAX, 'result');
  const readOnly = res?.readOnly === true;
  if (!readOnly) {
    ledger({ action: 'executed', kind: 'app.remote_call', ok: true, via: `app:${app}`, proposalId: grant?.proposalId || null,
      peer: peer.name, name, argsSha: sha, origin, summary: `Remote call ${what} — ${mode === 'owner' ? "owner's click" : `approved (${grant?.proposalId})`}` });
  }
  console.log(`[fleet-remote] call ${app}/${name} → ${peer.name} (${origin.kind}${readOnly ? ', readOnly' : ''}) ok`);
  return result;
}

// A non-readOnly handler from a caller that is not the owner: stage the card
// (a pending twin collapses into it) and refuse; approving grants one retry.
async function refuseCall(app, peer, name, sha, args, argsBytes, origin) {
  const payload = { app, peer: peer.name, name, argsSha: sha, argsSummary: W.argsSummary(args), argsBytes, origin };
  const r = await d('governance').requestAction('app.remote_call', payload, { origin: governanceOrigin() });
  const proposalId = r?.proposal?.id || null;
  if (r?.mode === 'suppressed') {
    throw new RemoteError('E_REFUSED', `the owner already refused remote call "${name}" with these args`, { proposalId: r.prior?.id || null });
  }
  throw new RemoteError('E_REFUSED', `remote call "${name}" on "${peer.name}" needs the owner's approval — proposal ${proposalId}; retry the identical call after approval`, { proposalId });
}

// --- jobs ------------------------------------------------------------------------------------------

function checkMeta(meta) {
  if (meta === undefined || meta === null) return null;
  if (typeof meta !== 'object' || Array.isArray(meta)) throw new Error('meta must be a JSON object');
  W.jsonSize(meta, W.META_MAX, 'meta');
  return JSON.parse(JSON.stringify(meta));
}

async function start(app, peerRef, kind, args, { meta } = {}) {
  if (!require('./peer-security').isAppName(app) || !d('appExists')(app)) throw new Error(`unknown app "${app}"`);
  if (!W.isName(kind)) throw new Error('job kind must match [a-z0-9._:-]{1,64}');
  const argsBytes = W.jsonSize(args === undefined ? null : args, W.ARGS_MAX, 'args');
  const m = checkMeta(meta);
  const peer = resolvePeer(peerRef);
  const origin = classifyOrigin();
  const sha = W.argsSha(args);
  const a = args === undefined ? null : JSON.parse(JSON.stringify(args));
  if (origin.kind === 'owner') {
    if (!d('isOnline')(peer.name)) throw new RemoteError('E_OFFLINE', `slave "${peer.name}" is not connected`);
    const rec = newRecord(app, peer.name, kind, { meta: m, origin, args: a, sha });
    try {
      await launch(rec, peer);
    } catch (err) {
      end(rec, 'failed', { error: err.message, code: err.code || 'E_REMOTE' });
      err.id = rec.id;
      throw err;
    }
    ledger({ action: 'executed', kind: 'app.remote_job', ok: true, via: `app:${app}`, proposalId: null,
      peer: peer.name, name: kind, argsSha: sha, origin,
      summary: `Remote job "${kind}" of app "${app}" on slave "${peer.name}" (args ${sha.slice(0, 12)}…) — owner's click, ${rec.id}` });
    return { id: rec.id };
  }
  // A pending twin (same app, slave, kind, args) is the same request.
  const twin = records.find((r) => r.app === app && r.peer === peer.name && r.kind === kind && r.argsSha === sha
    && r.status === 'starting' && r.proposalId && proposalStatus(r.proposalId) === 'pending');
  if (twin) return { id: twin.id, proposed: true, proposalId: twin.proposalId };
  const rec = newRecord(app, peer.name, kind, { meta: m, origin, args: a, sha });
  const payload = { app, peer: peer.name, kind, id: rec.id, argsSha: sha, argsSummary: W.argsSummary(args), argsBytes, meta: m, origin };
  let r;
  try {
    r = await d('governance').requestAction('app.remote_job', payload, { origin: governanceOrigin() });
  } catch (err) {
    records = records.filter((x) => x !== rec);
    flush();
    throw err;
  }
  if (r?.mode === 'suppressed') {
    end(rec, 'cancelled', { error: 'the owner already refused this remote job', code: 'E_REFUSED' });
    throw new RemoteError('E_REFUSED', `the owner already refused remote job "${kind}" with these args`, { id: rec.id });
  }
  if (r?.mode === 'executed') return { id: rec.id };
  rec.proposalId = r?.proposal?.id || null;
  flush();
  return { id: rec.id, proposed: true, proposalId: rec.proposalId };
}

// POST the start; the slave is idempotent per record id, so a retry (after a
// master restart mid-start) attaches to the job already running.
async function launch(rec, peer) {
  rec.launching = true;
  flush();
  const res = await slaveCall(peer, `/fleet-remote/${rec.app}/jobs`, {
    method: 'POST', body: { kind: rec.kind, args: rec.args ?? null, id: rec.id, origin: rec.origin },
  });
  if (!W.isJobId(res?.remoteJobId)) throw new RemoteError('E_REMOTE', `slave "${peer.name}" sent no job id`);
  if (TERMINAL.has(rec.status)) {
    // Cancelled while the start was on the wire: cancel it there too.
    rec.remoteJobId = res.remoteJobId;
    rec.cancelPending = true;
    delete rec.args;
    flush();
    resyncOne(rec, peer).catch(() => {});
    return;
  }
  rec.remoteJobId = res.remoteJobId;
  if (rec.status === 'starting') rec.status = 'running';
  rec.link = 'up';
  rec.updatedAt = Date.now();
  delete rec.args;
  delete rec.launching;
  flush();
  emitProgress(rec);
}

// app.remote_job's executor: start the approved record under its id.
async function startApproved(p, proposal) {
  const rec = byId(p.id);
  if (!rec) throw new Error(`remote job record ${p.id} is gone`);
  if (rec.status !== 'starting') throw new Error(`remote job ${p.id} is already ${rec.status}`);
  if (W.argsSha(rec.args) !== p.argsSha) throw new Error('the stored args do not match the approved sha');
  rec.origin = { ...rec.origin, proposalId: proposal?.id || rec.proposalId || null };
  const peer = resolvePeer(rec.peer);
  try {
    if (!d('isOnline')(peer.name)) throw new RemoteError('E_OFFLINE', `slave "${peer.name}" is not connected`);
    await launch(rec, peer);
  } catch (err) {
    end(rec, 'failed', { error: err.message, code: err.code || 'E_REMOTE' });
    throw err;
  }
  return { ok: true, id: rec.id, remoteJobId: rec.remoteJobId, summary: `Remote job "${rec.kind}" of "${rec.app}" started on "${rec.peer}" (${rec.id})` };
}

function proposalStatus(id) {
  try { return d('governance').getProposal(id)?.status || null; } catch { return null; }
}

// A proposed start whose proposal was denied, withdrawn or expired ends.
function checkProposal(rec, proposal) {
  if (!rec || rec.status !== 'starting' || !rec.proposalId || rec.launching) return;
  const st = proposal && proposal.id === rec.proposalId ? proposal.status : proposalStatus(rec.proposalId);
  if (st === 'denied' || st === 'expired' || st === 'withdrawn' || st === null) {
    end(rec, 'cancelled', { error: `refused: proposal ${rec.proposalId} ${st || 'is gone'}`, code: 'E_REFUSED' });
  }
}

async function cancel(id) {
  const rec = byId(String(id || ''));
  if (!rec) throw new Error(`unknown remote job "${id}"`);
  if (TERMINAL.has(rec.status)) return { ok: false, remoteCancelled: false, status: rec.status };
  if (!rec.remoteJobId) {
    const pending = rec.proposalId && proposalStatus(rec.proposalId) === 'pending';
    if (rec.launching) rec.cancelPending = true;
    end(rec, 'cancelled', { error: 'cancelled before it started' });
    if (pending) { try { d('governance').withdrawProposal(rec.proposalId, `app:${rec.app}`); } catch {} }
    return { ok: true, remoteCancelled: false };
  }
  const peer = resolvePeer(rec.peer);
  let remoteCancelled = false;
  try {
    const r = await slaveCall(peer, `/fleet-remote/${rec.app}/jobs/${rec.remoteJobId}`, { method: 'DELETE', timeoutMs: 15000 });
    remoteCancelled = r?.cancelled === true;
    if (!remoteCancelled) {
      // It ended there first: take its real end.
      await resyncOne(rec, peer);
      if (TERMINAL.has(rec.status)) return { ok: false, remoteCancelled: false, status: rec.status };
    }
  } catch (err) {
    if (err.code === 'E_OFFLINE' || err.code === 'E_TIMEOUT') rec.cancelPending = true;
  }
  end(rec, 'cancelled', { error: null });
  return { ok: true, remoteCancelled };
}

// --- Channel: frames, link, resync --------------------------------------------------------------

const SLAVE_TERMINAL = new Set(['done', 'error', 'cancelled', 'interrupted']);

function onFrame(peerName, msg) {
  if (msg?.type !== 'fr:job') return;
  const rec = byId(msg.id);
  if (!rec || rec.peer !== peerName || rec.app !== msg.app || TERMINAL.has(rec.status)) return;
  if (!W.isJobId(msg.remoteJobId)) return;
  if (rec.remoteJobId && rec.remoteJobId !== msg.remoteJobId) return;
  if (!rec.remoteJobId) {
    if (!rec.launching) return;   // never asked this slave to start it
    rec.remoteJobId = msg.remoteJobId;
  }
  rec.link = 'up';
  if (rec.status === 'starting') rec.status = 'running';
  rec.progress = W.cleanProgress(msg.progress);
  const patch = W.cleanMeta(msg.meta);
  if (patch) mergeMeta(rec, patch);
  rec.updatedAt = Date.now();
  persistSoon();
  emitProgress(rec, patch);
  if (SLAVE_TERMINAL.has(msg.status)) {
    // The end value (≤ 1 MB) does not fit a frame: read the slave's record.
    resyncOne(rec, resolvePeer(rec.peer)).catch(() => {});
  }
}

function mergeMeta(rec, patch) {
  const next = { ...(rec.remoteMeta || {}), ...patch };
  if (W.bytesOf(next) <= REMOTE_META_MAX) rec.remoteMeta = next;
}

// Apply the slave's own job record.
function applyRemote(rec, job) {
  if (TERMINAL.has(rec.status)) return;
  const progress = W.cleanProgress(job.progress);
  const meta = W.cleanMeta(job.meta);
  const changed = JSON.stringify(progress) !== JSON.stringify(rec.progress || {});
  const patch = meta ? W.metaPatch(rec.remoteMeta, meta) : null;
  rec.progress = progress;
  if (meta && W.bytesOf(meta) <= REMOTE_META_MAX) rec.remoteMeta = meta;
  rec.updatedAt = Date.now();
  if (changed || patch) emitProgress(rec, patch);
  const st = job.status;
  if (st === 'running' || st === 'pending') { if (rec.status === 'starting') rec.status = 'running'; persistSoon(); return; }
  if (st === 'done') {
    let result = job.result === undefined ? null : job.result;
    try { W.jsonSize(result, W.RESULT_MAX, 'result'); } catch { return end(rec, 'failed', { error: 'the job result is over 1 MB', code: 'E_TOO_LARGE' }); }
    return end(rec, 'done', { result });
  }
  if (st === 'error') return end(rec, 'failed', { error: W.cleanError(job.error) || 'failed', code: 'E_REMOTE' });
  if (st === 'cancelled') return end(rec, 'cancelled', { error: null });
  return end(rec, 'failed', { error: `interrupted on ${rec.peer}`, code: 'E_REMOTE' });
}

async function resyncOne(rec, peer) {
  if (TERMINAL.has(rec.status) && !rec.cancelPending) return;
  if (rec.cancelPending && rec.remoteJobId) {
    try {
      await slaveCall(peer, `/fleet-remote/${rec.app}/jobs/${rec.remoteJobId}`, { method: 'DELETE', timeoutMs: 15000 });
      delete rec.cancelPending;
      flush();
    } catch (err) { if (err.code === 'E_OFFLINE' || err.code === 'E_TIMEOUT') return; delete rec.cancelPending; }
    return;
  }
  if (TERMINAL.has(rec.status)) return;
  if (!rec.remoteJobId) {
    // Started (owner or approved) but no answer before a master restart: the
    // slave's start is idempotent per id, so ask again.
    if (rec.launching && rec.args !== undefined) {
      try { await launch(rec, peer); } catch (err) {
        if (err.code !== 'E_OFFLINE' && err.code !== 'E_TIMEOUT') end(rec, 'failed', { error: err.message, code: err.code });
      }
    }
    return;
  }
  let res;
  try {
    res = await slaveCall(peer, `/fleet-remote/${rec.app}/jobs/${rec.remoteJobId}`, { timeoutMs: 15000, maxBytes: W.RESULT_MAX + 128 * 1024 });
  } catch (err) {
    if (err.slaveCode === 'no-job' || err.code === 'E_NO_HANDLER' || err.code === 'E_NOT_RUNNING') {
      // The slave lost it (its record pruned, its app gone, an older build).
      return end(rec, 'failed', { error: `interrupted on ${rec.peer}`, code: 'E_REMOTE' });
    }
    return;   // unreachable: stays as it is, link from the channel
  }
  if (!res?.job || typeof res.job !== 'object') return;
  if (rec.link !== 'up') { rec.link = 'up'; emitProgress(rec); }
  applyRemote(rec, res.job);
}

function linkChange(peerName, link) {
  for (const rec of records) {
    if (rec.peer !== peerName || TERMINAL.has(rec.status) || rec.link === link) continue;
    rec.link = link;
    rec.updatedAt = Date.now();
    emitProgress(rec);
  }
  persistSoon();
  if (link === 'up') resyncPeer(peerName).catch(() => {});
}

async function resyncPeer(peerName) {
  let peer;
  try { peer = resolvePeer(peerName); } catch { return; }
  for (const rec of records.filter((r) => r.peer === peerName && (!TERMINAL.has(r.status) || r.cancelPending))) {
    await resyncOne(rec, peer);
  }
}

// The periodic belt: proposals decided while nobody listened, frames the
// rate window dropped, a link that came up before init.
async function sweep() {
  const peers = new Set();
  for (const rec of records) {
    if (rec.status === 'starting' && rec.proposalId) checkProposal(rec);
    if ((!TERMINAL.has(rec.status) || rec.cancelPending) && d('isOnline')(rec.peer)) peers.add(rec.peer);
  }
  for (const p of peers) await resyncPeer(p);
}

module.exports = {
  init, shutdown, flush,
  call, start, status, list, cancel,
  on, subscribe, trackAppListener, unregisterApp,
  addGrant, startApproved, classifyOrigin, sweep,
  GRANT_TTL_MS,
  // tests
  _records: () => records, _grants: () => grants, _onFrame: onFrame, _linkChange: linkChange,
};
