// App→app dependency edges — which app may call which other app's tools, and
// how those calls fare. An app that calls another app's tools must have been
// built for that: the edge comes from a change request that reached `done`, a
// `scripts/app-change.js depend` declaration, or the owner approving an
// `observed` edge (a call nobody declared) in Setup → Tools & Access.
// authorizeToolCall (app-tools.js) reads it for `app` callers only; agents
// keep their run grants (app-tool-packs.js) and never appear here.
//
// Persisted at <dataHome>/app-deps.json. An edge:
//   { id, consumer, provider, tools: [names] | ['*'], purpose,
//     status: 'approved' | 'observed' | 'revoked',
//     origin: { type: 'change-request' | 'declared' | 'observed' | 'owner', ref? },
//     contract: { <tool>: contractHash at approval }, snapshot: { <tool>: contractOf },
//     contractStatus: 'ok' | 'changed-compatible' | 'broken', contractProblems: [],
//     createdAt, approvedAt?, revokedAt?, lastCallAt?, calls, errors }
// At most one approved and one observed edge per consumer→provider pair;
// revoked edges stay as history. Only fs/path at load: app-lint requires this
// file for `readEdges` outside the server.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'app-deps.json';
const MODES = ['warn', 'enforce'];
const STATS_SAVE_MS = 2000;
const IDLE_DAYS = 30;
const STATUS_RANK = { ok: 0, 'changed-compatible': 1, broken: 2 };

let deps = {};
let file = null;
let edges = [];
let statsTimer = null;

function init(options = {}) {
  deps = options;
  file = options.dataHome ? path.join(options.dataHome, FILE) : null;
  edges = [];
  if (statsTimer) { clearTimeout(statsTimer); statsTimer = null; }
  load();
  // Seed: an empty store, never invented edges.
  if (file && !fs.existsSync(file)) save();
}

function load() {
  if (!file) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    edges = Array.isArray(data && data.edges) ? data.edges.filter((e) => e && e.id && e.consumer && e.provider) : [];
  } catch { edges = []; }
}

function save() {
  if (statsTimer) { clearTimeout(statsTimer); statsTimer = null; }
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, edges }, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) { console.warn('[app-deps] save failed:', err.message); }
}

// Call stats change on every app→app call: written behind a short debounce.
function saveStatsSoon() {
  if (!file || statsTimer) return;
  statsTimer = setTimeout(save, STATS_SAVE_MS);
  if (statsTimer.unref) statsTimer.unref();
}

function flush() { if (statsTimer) save(); }

// A structural change: persisted at once, the Setup pane told, the cross-app
// sidecars refreshed (deps.onChange, wired in index.js).
function changed(edge) {
  save();
  if (deps.broadcaster) {
    try { deps.broadcaster.broadcast({ type: 'app:deps:changed', edge: edge ? copy(edge) : null }); } catch {}
  }
  if (typeof deps.onChange === 'function') { try { deps.onChange(edge); } catch {} }
}

function copy(e) { return JSON.parse(JSON.stringify(e)); }
function newId() { return `dep_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`; }
function now() { return deps.now ? deps.now() : Date.now(); }

// --- reading ---------------------------------------------------------------

function list() { return edges.map(copy); }
function get(id) { const e = edges.find((x) => x.id === id); return e ? copy(e) : null; }
function forProvider(provider) { return edges.filter((e) => e.provider === provider).map(copy); }
function forConsumer(consumer) { return edges.filter((e) => e.consumer === consumer).map(copy); }
function covers(edge, tool) { return Array.isArray(edge.tools) && (edge.tools.includes('*') || edge.tools.includes(tool)); }
function findPair(consumer, provider, status) {
  return edges.find((e) => e.consumer === consumer && e.provider === provider && e.status === status) || null;
}

// The approved edge that lets `consumer` call `provider`.`tool`, or null.
function approvedFor(consumer, provider, tool) {
  const e = findPair(consumer, provider, 'approved');
  return e && covers(e, tool) ? copy(e) : null;
}

function mode() {
  let m = null;
  try { m = (deps.settings || require('./platform-settings')).get('appDepsEnforce'); } catch {}
  return MODES.includes(m) ? m : 'warn';
}

// --- the provider's tools ----------------------------------------------------
// Live registry first, the manifest's last registration second, so a stopped
// provider is still checkable. Only `expose: 'apps'` tools are dependable.
function providerTools(provider) {
  let tools = [];
  try { tools = require('./app-tools').getToolsForApp(provider); } catch {}
  if (!tools.length) {
    try {
      const m = appManager().readManifest(provider);
      tools = Array.isArray(m && m.tools) ? m.tools.filter((t) => t && t.name) : [];
    } catch {}
  }
  return tools;
}
function appsTools(provider) { return providerTools(provider).filter((t) => t.expose === 'apps'); }
function appManager() { return deps.appManager || require('./app-manager'); }

function hashOf(tool) {
  if (!tool) return null;
  if (tool.contractHash) return tool.contractHash;
  try { return require('./app-tools').contractHash(tool); } catch { return null; }
}
function contractOf(tool) {
  try { return require('./app-tools').contractOf(tool); } catch { return null; }
}

// Hashes and snapshots of `names` (or every apps tool for '*') as they are now.
// A tool not registered yet is left out; contracts() adopts it on first sight.
function captureContract(provider, names) {
  const tools = providerTools(provider);
  const want = names.includes('*') ? tools.filter((t) => t.expose === 'apps').map((t) => t.name) : names;
  const contract = {};
  const snapshot = {};
  for (const n of want) {
    const t = tools.find((x) => x.name === n);
    if (!t) continue;
    contract[n] = hashOf(t);
    snapshot[n] = contractOf(t);
  }
  return { contract, snapshot };
}

// --- writing ---------------------------------------------------------------

function mergeTools(a, b) {
  if ((a || []).includes('*') || (b || []).includes('*')) return ['*'];
  return [...new Set([...(a || []), ...(b || [])])].sort();
}

// An approved edge consumer→provider for `tools`, merged into the pair's
// approved edge when there is one. `origin` says where it came from. The
// contract of the named tools is captured now.
function declare({ consumer, provider, tools, purpose, origin } = {}) {
  if (!consumer || !provider) return { error: 'consumer and provider are required' };
  if (consumer === provider) return { error: 'an app does not depend on itself' };
  const names = Array.isArray(tools) && tools.length ? tools.map(String) : ['*'];
  const at = now();
  const { contract, snapshot } = captureContract(provider, names);
  let edge = findPair(consumer, provider, 'approved');
  if (edge) {
    edge.tools = mergeTools(edge.tools, names);
    Object.assign(edge.contract, contract);
    edge.snapshot = Object.assign(edge.snapshot || {}, snapshot);
    if (purpose && !String(edge.purpose || '').includes(purpose)) edge.purpose = edge.purpose ? `${edge.purpose}; ${purpose}` : String(purpose);
  } else {
    edge = {
      id: newId(), consumer, provider, tools: mergeTools([], names), purpose: String(purpose || ''),
      status: 'approved', origin: origin || { type: 'owner' }, contract, snapshot,
      contractStatus: 'ok', contractProblems: [], createdAt: at, approvedAt: at, calls: 0, errors: 0,
    };
    edges.push(edge);
  }
  // An observed edge for the same pair whose tools are now all covered is absorbed.
  const obs = findPair(consumer, provider, 'observed');
  if (obs && obs.tools.every((t) => covers(edge, t))) {
    edge.calls += obs.calls || 0;
    edge.errors += obs.errors || 0;
    if (obs.lastCallAt && (!edge.lastCallAt || obs.lastCallAt > edge.lastCallAt)) edge.lastCallAt = obs.lastCallAt;
    edges = edges.filter((e) => e !== obs);
  }
  evaluate(edge);
  changed(edge);
  return { ok: true, edge: copy(edge) };
}

// The owner approves an observed edge, or re-approves an approved one whose
// contract changed: either way the stored hashes become the current ones.
function approve(id, { by = 'owner' } = {}) {
  const edge = edges.find((e) => e.id === id);
  if (!edge) return { error: 'unknown dependency' };
  // An observed edge becomes (or joins) the pair's approved edge; declare()
  // absorbs it, its tools being covered by construction.
  if (edge.status === 'observed') {
    return declare({ consumer: edge.consumer, provider: edge.provider, tools: edge.tools, purpose: edge.purpose, origin: { type: by } });
  }
  if (edge.status === 'revoked') {
    edge.status = 'approved';
    edge.revokedAt = undefined;
  }
  const { contract, snapshot } = captureContract(edge.provider, edge.tools);
  edge.contract = contract;
  edge.snapshot = snapshot;
  edge.contractStatus = 'ok';
  edge.contractProblems = [];
  edge.approvedAt = now();
  // A revoked edge re-approved while another approved edge holds the pair: merge.
  const other = edges.find((e) => e !== edge && e.consumer === edge.consumer && e.provider === edge.provider && e.status === 'approved');
  if (other) {
    other.tools = mergeTools(other.tools, edge.tools);
    Object.assign(other.contract, edge.contract);
    other.snapshot = Object.assign(other.snapshot || {}, edge.snapshot);
    edges = edges.filter((e) => e !== edge);
    evaluate(other);
    changed(other);
    return { ok: true, edge: copy(other) };
  }
  changed(edge);
  return { ok: true, edge: copy(edge) };
}

function revoke(id) {
  const edge = edges.find((e) => e.id === id);
  if (!edge) return { error: 'unknown dependency' };
  if (edge.status === 'revoked') return { ok: true, edge: copy(edge) };
  edge.status = 'revoked';
  edge.revokedAt = now();
  changed(edge);
  return { ok: true, edge: copy(edge) };
}

// An app→app call with no approved edge: the pair's observed edge gains the tool.
function observe(consumer, provider, tool) {
  if (!consumer || !provider || consumer === provider) return null;
  let edge = findPair(consumer, provider, 'observed');
  const fresh = !edge;
  if (!edge) {
    edge = {
      id: newId(), consumer, provider, tools: [], purpose: '', status: 'observed',
      origin: { type: 'observed' }, contract: {}, snapshot: {}, contractStatus: 'ok', contractProblems: [],
      createdAt: now(), calls: 0, errors: 0,
    };
    edges.push(edge);
  }
  const grew = tool && !covers(edge, tool);
  if (grew) edge.tools = mergeTools(edge.tools, [tool]);
  if (fresh || grew) changed(edge);
  return copy(edge);
}

// Stats of one app→app call, on the edge that covers it (approved first).
function recordCall(consumer, provider, tool, { ok = true } = {}) {
  const edge = [findPair(consumer, provider, 'approved'), findPair(consumer, provider, 'observed')]
    .find((e) => e && covers(e, tool));
  if (!edge) return null;
  edge.calls = (edge.calls || 0) + 1;
  if (!ok) edge.errors = (edge.errors || 0) + 1;
  edge.lastCallAt = now();
  saveStatsSoon();
  return copy(edge);
}

// --- enforcement (called by app-tools.authorizeToolCall) -----------------------

function declareHint(consumer, provider, tool) {
  return `declare it from a change session on "${consumer}": node ../../platform/scripts/app-change.js depend --on ${provider} --tools ${tool} --why "<why ${consumer} needs it>", or the owner approves it in Setup → Tools & Access`;
}

// → { allow: true } | { allow: true, undeclared: true } | { allow: false, undeclared: true, reason }
function authorize(consumer, provider, tool) {
  if (approvedFor(consumer, provider, tool)) return { allow: true };
  observe(consumer, provider, tool);
  if (mode() === 'enforce') {
    return {
      allow: false, undeclared: true,
      reason: `App "${consumer}" has no approved dependency on "${provider}" for tool "${tool}" (app dependencies are enforced) — ${declareHint(consumer, provider, tool)}`,
    };
  }
  return { allow: true, undeclared: true };
}

// --- contract protection -----------------------------------------------------
// Each approved edge is judged against the contract it was approved with:
// unchanged → ok; changed but compareContracts finds nothing incompatible →
// changed-compatible; incompatible, removed or no longer exposed to apps →
// broken. A tool the edge names that was not registered at approval is
// adopted (its first contract becomes the approved one).
function evaluate(edge) {
  if (edge.status !== 'approved') return false;
  const tools = providerTools(edge.provider);
  if (!tools.length) return false; // provider unknown right now: keep the last verdict
  let status = 'ok';
  const problems = [];
  let adopted = false;
  const names = edge.tools.includes('*') ? Object.keys(edge.contract || {}) : edge.tools;
  for (const n of names) {
    const t = tools.find((x) => x.name === n);
    const was = (edge.contract || {})[n];
    if (!t) {
      if (was) { status = 'broken'; problems.push(`${n}: no longer registered`); }
      continue;
    }
    if (!was) {
      edge.contract[n] = hashOf(t);
      edge.snapshot = edge.snapshot || {};
      edge.snapshot[n] = contractOf(t);
      adopted = true;
      continue;
    }
    if (t.expose !== 'apps') { status = 'broken'; problems.push(`${n}: no longer exposed to apps (expose: ${t.expose})`); continue; }
    if (hashOf(t) === was) continue;
    const before = (edge.snapshot || {})[n];
    let cmp = { compatible: false, problems: ['the contract changed and the approved contract is unknown'] };
    if (before) { try { cmp = require('./app-tools').compareContracts(before, t); } catch {} }
    if (cmp.compatible) {
      if (STATUS_RANK[status] < STATUS_RANK['changed-compatible']) status = 'changed-compatible';
    } else {
      status = 'broken';
      for (const p of cmp.problems || []) problems.push(`${n}: ${p}`);
    }
  }
  const prev = edge.contractStatus || 'ok';
  const prevProblems = JSON.stringify(edge.contractProblems || []);
  edge.contractStatus = status;
  edge.contractProblems = problems;
  const moved = prev !== status || prevProblems !== JSON.stringify(problems) || adopted;
  if (status === 'broken' && prev !== 'broken') notifyBroken(edge);
  return moved;
}

function notifyBroken(edge) {
  if (!deps.broadcaster) return;
  try {
    deps.broadcaster.broadcast({
      type: 'toast:push', sender: 'Tool dependencies', level: 'error', ts: now(),
      title: `${edge.provider} broke a tool ${edge.consumer} depends on`,
      message: `${(edge.contractProblems || []).join('; ')} — review in Setup → Tools & Access`,
    });
  } catch {}
}

// The provider's tools were registered or a contract changed: re-judge every
// approved edge on it. Returns the edges whose verdict moved.
function checkProvider(provider) {
  const moved = [];
  for (const e of edges) {
    if (e.provider === provider && e.status === 'approved' && evaluate(e)) moved.push(e);
  }
  if (moved.length) changed(moved.length === 1 ? moved[0] : null);
  return moved.map(copy);
}

// The broadcast tap (index.js): registrations and contract changes.
function observeBroadcast(msg) {
  if (!msg || !msg.appName) return;
  if (msg.type === 'app:tools:updated' || msg.type === 'app:tools:contractChanged') checkProvider(msg.appName);
}

// --- sources -----------------------------------------------------------------

// A change request on an app's tool reached `done` (app-change-requests.js):
// the asking app was built for the tool, so it may call it.
function fromChangeRequest(rec) {
  if (!rec || !rec.from || !rec.to || !rec.interface || rec.interface.kind !== 'tool') return null;
  const res = declare({
    consumer: rec.from, provider: rec.to, tools: [rec.interface.name],
    purpose: rec.reason || '', origin: { type: 'change-request', ref: rec.id },
  });
  return res.error ? null : res.edge;
}

// `scripts/app-change.js depend --on <provider> --tools a,b --why "…"`, from
// an app change tab (identified like `request`, app-change-requests.callerApp).
function depend({ instanceId, on, tools, why } = {}) {
  const cr = require('./app-change-requests');
  const caller = cr.callerApp(instanceId);
  if (!caller) return { error: cr.callerError(instanceId) };
  const consumer = caller.app;
  const provider = typeof on === 'string' ? on.trim() : '';
  if (!provider) return { error: 'missing --on <app>' };
  if (provider === consumer) return { error: 'an app does not depend on itself' };
  let manifest = null;
  try { manifest = appManager().readManifest(provider); } catch {}
  if (!manifest) return { error: `no app named "${provider}" is installed here` };
  if (manifest.platformContribution === false) return { error: `"${provider}" is independent — its tools are not callable by other apps` };
  const names = (Array.isArray(tools) ? tools : String(tools || '').split(','))
    .map((t) => String(t).trim()).filter(Boolean);
  if (!names.length) return { error: 'missing --tools <a,b> (or --tools "*")' };
  if (!why || !String(why).trim()) return { error: 'missing --why "<one line: what this app uses them for>"' };
  const exposed = appsTools(provider).map((t) => t.name);
  if (!names.includes('*')) {
    const all = providerTools(provider);
    const unknown = names.filter((n) => !all.some((t) => t.name === n));
    if (unknown.length) return { error: `"${provider}" has no tool ${unknown.join(', ')} — tools exposed to apps: ${exposed.join(', ') || 'none'}` };
    const notApps = names.filter((n) => !exposed.includes(n));
    if (notApps.length) return { error: `${notApps.join(', ')} ${notApps.length > 1 ? 'are' : 'is'} not exposed to apps (expose: 'apps') by "${provider}" — ask for it with a change request instead` };
  } else if (!exposed.length) {
    return { error: `"${provider}" exposes no tool to apps` };
  }
  return declare({ consumer, provider, tools: names.includes('*') ? ['*'] : names, purpose: String(why).trim().slice(0, 500), origin: { type: 'declared' } });
}

// --- the Setup → Tools & Access picture ----------------------------------------

function health({ auditEntries } = {}) {
  const t = now();
  const exposedUnused = [];
  let appNames = [];
  try { appNames = appManager().list().map((a) => a.name); } catch {}
  for (const app of appNames) {
    for (const tool of appsTools(app)) {
      const used = edges.some((e) => e.provider === app && e.status !== 'revoked' && covers(e, tool.name));
      if (!used) exposedUnused.push({ app, tool: tool.name });
    }
  }
  const idle = edges
    .filter((e) => e.status === 'approved' && (e.lastCallAt || e.approvedAt || e.createdAt) < t - IDLE_DAYS * 86400e3)
    .map((e) => ({ id: e.id, consumer: e.consumer, provider: e.provider, lastCallAt: e.lastCallAt || null }));
  let audit = auditEntries;
  if (!audit) { try { audit = require('./app-tools').getToolAudit(200); } catch { audit = []; } }
  const undeclared = (audit || []).filter((a) => a && a.undeclared).slice(0, 20)
    .map((a) => ({ ts: a.ts, consumer: a.callerApp, provider: a.appName, tool: a.toolName, ok: a.ok, error: a.error || null }));
  return { exposedUnused, idle, idleDays: IDLE_DAYS, undeclared };
}

// Live broker holder sessions, read-only: run → member address → tools.
function agentGrants() {
  let sessions = [];
  try { sessions = require('./mcp-broker').listSessions(); } catch { return []; }
  const runs = new Map();
  for (const s of sessions) {
    if (!s.holder) continue;
    const runId = s.holder.runId || '?';
    if (!runs.has(runId)) runs.set(runId, { runId, members: [] });
    runs.get(runId).members.push({
      address: s.holder.address, type: s.holder.type, mode: s.mode,
      tools: s.tools, calls: s.calls || 0, createdAt: s.createdAt,
    });
  }
  return [...runs.values()].sort((a, b) => a.runId.localeCompare(b.runId))
    .map((r) => ({ ...r, members: r.members.sort((a, b) => String(a.address).localeCompare(String(b.address))) }));
}

function overview() {
  flush();
  return { mode: mode(), edges: list(), health: health(), agentGrants: agentGrants() };
}

// --- outside the server ---------------------------------------------------------
// app-lint reads the edges without a running server. `dataHome` defaults to
// the apps dir's parent (core's dataHome holds the apps dir), then
// <apps>/../data. Absent or unreadable → null.
function readEdges({ dataHome, appDir } = {}) {
  const candidates = [];
  if (dataHome) candidates.push(path.join(dataHome, FILE));
  if (process.env.VISTACLAIR_DATA_HOME) candidates.push(path.join(process.env.VISTACLAIR_DATA_HOME, FILE));
  if (appDir) {
    const appsDir = path.dirname(path.resolve(appDir));
    candidates.push(path.join(path.dirname(appsDir), FILE), path.join(path.dirname(appsDir), 'data', FILE));
  }
  for (const f of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (data && Array.isArray(data.edges)) return data.edges;
    } catch {}
  }
  return null;
}

module.exports = {
  init, list, get, declare, approve, revoke, observe, recordCall, forProvider, forConsumer,
  approvedFor, covers, authorize, mode, checkProvider, observeBroadcast, fromChangeRequest, depend,
  health, agentGrants, overview, readEdges, flush, MODES, FILE,
};
