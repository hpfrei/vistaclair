// MCP broker — the live union of every app's platform-exposed tools, served as
// a dynamic, scoped Streamable-HTTP MCP server that Horst, a CLI tab, or any
// owner-class AI can mount for a task (docs/app-tools.md "MCP broker").
//
// Nothing here is a second tool registry: the catalog IS app-tools'
// getPlatformToolUnion() (live — updates on install/remove, no restart),
// collision-namespaced `<app>__<tool>` exactly like the aiPrompt sidecar, and
// every call routes through callAppToolHandler with full spend attribution
// (origin 'mcp', principal 'owner', subscribed — brokered sessions are
// owner-class; app end-users and anonymous visitors never reach the broker,
// their path stays the user-bridge with its audience rules).
//
// Sessions:
//   POST /pro/mcp                     default owner session (full union) —
//                                     owner-authed by core's middleware
//   POST /pro/mcp/sessions           mint a scoped session (owner):
//                                     { task?, tools?, ttlMinutes? } →
//                                     { id, url, token, tools, expiresAt }
//   GET  /pro/mcp/sessions           list active sessions (owner)
//   DELETE /pro/mcp/sessions/:id     revoke (owner)
//   POST /pro/mcp/s/:id              a minted session's endpoint — auth-EXEMPT
//                                     at the core seam; self-authenticates by
//                                     bearer token (same pattern as the peer
//                                     token), so an external AI process can
//                                     connect without the owner cookie.
//
// Side effects: a tool whose short name is a governed action kind
// (horst-governance kind registry — e.g. `telegram.send`) is routed through
// requestAction, so the autonomy dial decides: auto → executed inline,
// propose → the MCP result says "staged for approval". Read-only tools pass
// straight through. This is the same gate every other AI principal gets.
//
// Holder sessions (docs/app-tools.md "Tool grants for orchestration runs"): a
// session bound to an orchestration-run member { type: 'orchestrator'|
// 'worker', runId, address, instanceId, workerId?, orchestrator? }, minted by
// the app-tool packs (app-tool-packs.js) at each spawn. A worker's 'grant'
// session is strictly scoped — an empty list serves NO tools, never a
// fallback; an orchestrator's 'catalog' session serves three meta tools
// (tools_search / tools_describe / tools_call) over the full union. No TTL:
// it lives while its holder runs, revoked by the pack's release and by the
// orphan sweep (holderLiveness). Outside the owner-session cap. Calls carry
// the holder as a typed caller into app-tools' authorizeToolCall, the audit
// and the spend context.
//
// Built-in tools (registerBuiltinTool): platform tools a holder session lists
// and serves beside its app tools when the tool's `when(session)` says so —
// not part of the app tool union, no grant needed. The tool-job tools
// (tool_job_status / tool_job_cancel / tool_job_reply) are built in here;
// artifact-tools.js contributes its own.
//
// Persistence (GUI-reload resilience rule): the session index lives under
// <dataHome>/mcp-broker/sessions.json — a dashboard restart or GUI reload
// never orphans a connected consumer. Tokens are stored as sha256 hashes; the
// plain token exists only in the mint response.
//
// Do not require './app-bridge' from here (cycle); the service modules are
// enough: app-tools (catalog + dispatch), spend-context (attribution),
// horst-governance (lazily, for the side-effect gate).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const appTools = require('./app-tools');
const spendContext = require('./spend-context');
const { core } = require('./core-services');

const SERVER_INFO = { name: 'vistaclair', version: require('../../../package.json').version };
// Newest first; initialize echoes the client's version when we support it.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DEFAULT_TTL_MIN = 60;
const MAX_TTL_MIN = 24 * 60;
const SESSION_CAP = 50;
const HOLDER_CAP = 500;
// A holder session younger than this is never an orphan: the holder process
// is minted for before core registers it as running.
const HOLDER_GRACE_MS = 2 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const HOLDER_TYPES = new Set(['orchestrator', 'worker']);

// Auth-failure rate limiting on the bearer-checked session endpoints (same
// numbers as peer-server / core's authLimiter): 10 bad attempts per IP per
// minute, then 429 for the rest of the window — for BAD tokens only; a valid
// token is checked first and always served.
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 60 * 1000;
const authFails = new Map(); // ip → { count, windowStart }

let deps = null;          // { dir }
let sessions = new Map(); // id → { id, tokenHash, task, toolNames, createdAt, expiresAt, holder?, mode? }
const callCounts = new Map(); // id → number (in-memory only)
const listeners = new Set();  // fn({ event: 'opened'|'closed', session })
let sweepTimer = null;
// holder → true (running) | false (gone) | undefined (unknown: keep). Set by
// app-tool-packs from core's session manager; unset = nothing is an orphan.
let holderLiveness = null;

// ---------------------------------------------------------------------------
// Session store (JSON, atomic writes — same helpers as governance/horst)
// ---------------------------------------------------------------------------

function sessionsPath() { return path.join(deps.dir, 'sessions.json'); }

function persist() {
  const tmp = sessionsPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ sessions: [...sessions.values()] }, null, 2));
  fs.renameSync(tmp, sessionsPath());
}

function init(options) {
  deps = { dir: options.dir };
  fs.mkdirSync(deps.dir, { recursive: true });
  sessions = new Map();
  const now = Date.now();
  try {
    const stored = JSON.parse(fs.readFileSync(sessionsPath(), 'utf8'));
    // Sessions that expired while the server was down are dropped silently —
    // nobody is holding them any more, and the wiring below isn't live yet.
    for (const s of stored.sessions || []) {
      if (s && s.id && s.tokenHash && (s.holder || s.expiresAt > now)) sessions.set(s.id, s);
    }
  } catch {}
  if (sweepTimer) clearInterval(sweepTimer);
  // The first tick is also the boot sweep for holder sessions loaded above:
  // their processes died with the server and a respawn re-mints.
  sweepTimer = setInterval(() => { try { sweep(); sweepOrphans(); } catch {} }, SWEEP_INTERVAL_MS);
  if (sweepTimer.unref) sweepTimer.unref();
}

function onSessionEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function emitSession(event, session) {
  const pub = publicSession(session);
  for (const fn of listeners) { try { fn({ event, session: pub }); } catch {} }
  try { core.broadcaster?.broadcast({ type: 'app:mcp:sessions', sessions: listSessions() }); } catch {}
}

function publicSession(s) {
  return {
    id: s.id, task: s.task || null,
    // null = the live full union (owner session semantics).
    tools: s.toolNames ? s.toolNames.slice() : null,
    createdAt: s.createdAt, expiresAt: s.expiresAt,
    calls: callCounts.get(s.id) || 0,
    ...(s.holder ? { holder: { ...s.holder }, mode: s.mode } : {}),
  };
}

// Retire expired sessions (lazy on every touch + the interval timer).
function sweep() {
  if (!deps) return;
  const now = Date.now();
  let changed = false;
  for (const s of [...sessions.values()]) {
    if (!s.holder && s.expiresAt <= now) {
      sessions.delete(s.id);
      callCounts.delete(s.id);
      changed = true;
      emitSession('closed', s);
    }
  }
  if (changed) persist();
}

// Revoke holder sessions whose holder no longer runs (the periodic tick; the
// first one after boot). An unknown answer keeps the session.
function setHolderLiveness(fn) { holderLiveness = typeof fn === 'function' ? fn : null; }

function sweepOrphans() {
  if (!deps || !holderLiveness) return 0;
  const now = Date.now();
  let n = 0;
  for (const s of [...sessions.values()]) {
    if (!s.holder || now - s.createdAt < HOLDER_GRACE_MS) continue;
    let alive;
    try { alive = holderLiveness(s.holder); } catch { alive = undefined; }
    if (alive === false && revokeSession(s.id)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Catalog — the broker never keeps its own tool registry. Only `platform`/
// `apps`-exposed tools of contributing apps enter (getPlatformToolUnion
// already applies both rules); names are collision-namespaced `<app>__<tool>`
// (the sidecar convention) and routing is by table, never by name parsing —
// pseudo-app owners like '__platform__' contain the separator themselves.
// ---------------------------------------------------------------------------

function catalog() {
  const byName = new Map();
  for (const t of appTools.getPlatformToolUnion()) {
    const ownerApp = t._ownerApp;
    byName.set(`${ownerApp}__${t.name}`, {
      name: `${ownerApp}__${t.name}`,
      ownerApp,
      shortName: t.name,
      kind: t.kind || 'call',
      sideEffects: t.sideEffects || 'writes',
      contractHash: t.contractHash || null,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      def: t,
    });
  }
  return byName;
}

// ---------------------------------------------------------------------------
// Task-based selection — Stage-0 digest material (names, descriptions,
// owners), scored deterministically against the task text. Deliberately
// zero-AI: a session mint must be cheap and dependable; the caller sees the
// proposed subset in the response and can always re-mint with explicit
// `tools`. Nothing matching falls back to the full union rather than a
// useless empty server.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'then',
  'them', 'their', 'have', 'has', 'was', 'are', 'were', 'will', 'would', 'can',
  'could', 'should', 'all', 'any', 'get', 'set', 'you', 'your', 'our', 'not',
  'but', 'use', 'using', 'need', 'want', 'please', 'tool', 'tools', 'app', 'apps',
]);

function tokenize(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z0-9]+/g)?.filter(
    (w) => w.length >= 3 && !STOPWORDS.has(w),
  ) || []);
}

// A query word matches a tool word exactly, or (tools_search only) as a
// prefix of 4+ letters either way ("snap" ~ "snapshot", "emails" ~ "email")
// for half the weight. Task selection stays exact-word.
function wordScore(words, part, weight, prefix) {
  if (words.has(part)) return weight;
  if (!prefix) return 0;
  for (const w of words) {
    if (w.length >= 4 && part.length >= 4 && (part.startsWith(w) || w.startsWith(part))) return weight / 2;
  }
  return 0;
}

function scoreTool(words, tool, prefix) {
  let score = 0;
  for (const part of tokenize(tool.shortName.replace(/[._]/g, ' '))) score += wordScore(words, part, 3, prefix);
  for (const part of tokenize(tool.ownerApp.replace(/[-_]/g, ' '))) score += wordScore(words, part, 2, prefix);
  for (const part of tokenize(tool.description)) score += wordScore(words, part, 1, prefix);
  return score;
}

// The catalog tools matching `text`, best first (ties keep catalog order).
function scoreTools(text, tools = catalog().values(), { prefix = false } = {}) {
  const words = tokenize(text);
  const scored = [];
  for (const tool of tools) {
    const score = scoreTool(words, tool, prefix);
    if (score > 0) scored.push({ tool, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.tool);
}

function selectToolsForTask(task) {
  return scoreTools(task).map((t) => t.name);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

function newSessionId() { return `s-${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`; }
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

// { task?, tools?, ttlMinutes? } → { id, url, token, tools, selection, expiresAt }
// Exactly one of the three scoping shapes:
//   tools given → exactly those (validated against the union);
//   task given  → the digest-selected subset (returned so the caller sees it);
//   neither     → the full platform union (tools: null internally).
function createSession({ task, tools, ttlMinutes } = {}) {
  if (!deps) throw new Error('mcp-broker is not initialized');
  sweep();
  const owned = [...sessions.values()].filter((s) => !s.holder).length;
  if (owned >= SESSION_CAP) throw new Error(`too many active MCP sessions (cap ${SESSION_CAP})`);
  const ttl = Math.min(MAX_TTL_MIN, Math.max(1, Number(ttlMinutes) || DEFAULT_TTL_MIN));

  let toolNames = null;
  let selection = 'all';
  if (Array.isArray(tools) && tools.length) {
    const known = catalog();
    const unknown = tools.filter((t) => !known.has(t));
    if (unknown.length) throw new Error(`unknown tool(s): ${unknown.join(', ')}`);
    toolNames = [...new Set(tools.map(String))];
    selection = 'explicit';
  } else if (typeof task === 'string' && task.trim()) {
    const picked = selectToolsForTask(task);
    if (picked.length) { toolNames = picked; selection = 'task'; }
    // Nothing matched: serve the full union (selection stays 'all') — the
    // response shows exactly what the session got either way.
  }

  const token = crypto.randomBytes(24).toString('hex');
  const session = {
    id: newSessionId(),
    tokenHash: hashToken(token),
    task: typeof task === 'string' ? task.slice(0, 300) : null,
    toolNames,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl * 60 * 1000,
  };
  sessions.set(session.id, session);
  persist();
  emitSession('opened', session);
  return {
    id: session.id,
    url: `/pro/mcp/s/${session.id}`,
    token,
    tools: toolNames ? toolNames.slice() : [...catalog().keys()],
    selection,
    expiresAt: session.expiresAt,
  };
}

// Holder session mint (app-tool packs, at every spawn of a run member).
//   holder: { type: 'orchestrator'|'worker', runId, address, instanceId,
//             workerId?, orchestrator? }
//   mode:   'grant'   — exactly `tools` (validated; [] = no tools at all);
//           'catalog' — the three catalog tools over the full union
//                       (orchestrator holders only).
// A holder's earlier session of the same mode is revoked first: a respawn
// re-mints. → { id, url, token, tools, holder, mode }
function createHolderSession({ holder, mode, tools } = {}) {
  if (!deps) throw new Error('mcp-broker is not initialized');
  if (!holder || !HOLDER_TYPES.has(holder.type)) throw new Error('holder.type must be orchestrator or worker');
  for (const k of ['runId', 'address', 'instanceId']) {
    if (typeof holder[k] !== 'string' || !holder[k]) throw new Error(`holder.${k} is required`);
  }
  if (mode !== 'grant' && mode !== 'catalog') throw new Error('mode must be grant or catalog');
  if (mode === 'catalog' && holder.type !== 'orchestrator') throw new Error('only an orchestrator holds the tool catalog');

  let toolNames = null;
  if (mode === 'grant') {
    if (!Array.isArray(tools)) throw new Error('a grant session needs a tools list');
    const known = catalog();
    const unknown = tools.filter((t) => !known.has(t));
    if (unknown.length) throw new Error(`unknown tool(s): ${unknown.join(', ')}`);
    toolNames = [...new Set(tools.map(String))];
  }
  revokeHolder({ instanceId: holder.instanceId, mode });
  if ([...sessions.values()].filter((s) => s.holder).length >= HOLDER_CAP) {
    throw new Error(`too many holder MCP sessions (cap ${HOLDER_CAP})`);
  }

  const token = crypto.randomBytes(24).toString('hex');
  const clean = { type: holder.type, runId: holder.runId, address: holder.address, instanceId: holder.instanceId };
  if (holder.workerId) clean.workerId = String(holder.workerId);
  if (holder.orchestrator) clean.orchestrator = String(holder.orchestrator);
  // The holder's working directory (the pack's build cwd): where a built-in
  // like artifact_fetch writes for it.
  if (typeof holder.cwd === 'string' && holder.cwd) clean.cwd = holder.cwd;
  const session = {
    id: newSessionId(),
    tokenHash: hashToken(token),
    task: null,
    toolNames,
    createdAt: Date.now(),
    expiresAt: null,
    holder: clean,
    mode,
  };
  sessions.set(session.id, session);
  persist();
  emitSession('opened', session);
  return {
    id: session.id,
    url: `/pro/mcp/s/${session.id}`,
    token,
    tools: mode === 'grant' ? toolNames.slice() : CATALOG_TOOLS.map((t) => t.name),
    holder: { ...clean },
    mode,
  };
}

// Revoke a holder's sessions (a pack's release; a re-mint). → count revoked.
function revokeHolder({ instanceId, mode } = {}) {
  if (!instanceId) return 0;
  let n = 0;
  for (const s of [...sessions.values()]) {
    if (s.holder && s.holder.instanceId === instanceId && (!mode || s.mode === mode) && revokeSession(s.id)) n++;
  }
  return n;
}

function listSessions() {
  sweep();
  return [...sessions.values()].map(publicSession);
}

function revokeSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  sessions.delete(id);
  callCounts.delete(id);
  persist();
  emitSession('closed', s);
  return true;
}

function resolveSession(id, token) {
  sweep();
  const s = sessions.get(id);
  if (!s || !token) return null;
  const given = Buffer.from(hashToken(token));
  const stored = Buffer.from(s.tokenHash);
  try { if (!crypto.timingSafeEqual(given, stored)) return null; } catch { return null; }
  return s;
}

// ---------------------------------------------------------------------------
// MCP protocol (Streamable HTTP, stateless): each POST body is a JSON-RPC
// message; notifications get 202/no body; GET (the optional SSE stream) is 405.
// ---------------------------------------------------------------------------

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }
function textResult(text, isError) {
  return { content: [{ type: 'text', text: String(text) }], ...(isError ? { isError: true } : {}) };
}

// The tools a scope may call right now: a session's stored names resolved
// against the LIVE catalog (a tool whose app was removed silently drops out;
// scope null = owner default session, or an orchestrator's catalog session =
// the full union). A grant session always has a list, so [] stays empty.
function scopeTools(session) {
  const known = catalog();
  if (!session || !session.toolNames) return [...known.values()];
  return session.toolNames.map((n) => known.get(n)).filter(Boolean);
}

// Governed side effect? The tool's SHORT name mapping to a governance kind is
// the contract (e.g. a tool literally named `telegram.send`). Lazy require —
// governance is initialized by platform-horst in the dashboard; if it isn't
// live here, nothing is governed and tools pass through like Horst's own
// executor path.
function governedKind(shortName) {
  try { return require('./governance/horst-governance').kindDef(shortName) ? shortName : null; } catch { return null; }
}

// The caller a session's calls carry: a holder session's typed run identity
// (its scope: the grant list, or null for an orchestrator's full union), else
// the platform caller every owner/task session has always been.
function callerFor(session) {
  const sessionTag = `mcp:${session ? session.id : 'owner'}`;
  if (!session || !session.holder) return { type: 'platform', origin: 'mcp', sessionTag };
  return { ...session.holder, origin: 'mcp', sessionTag, scope: session.toolNames ? session.toolNames.slice() : null };
}

// A handler result as an MCP tool result. A result that already carries
// `content` passes through untouched — every block type (resource_link,
// image, audio, embedded resource …) and `structuredContent`, `_meta`,
// `isError` alike; anything else is wrapped as JSON text.
function toToolResult(result) {
  if (result && typeof result === 'object' && Array.isArray(result.content)) return result;
  return textResult(typeof result === 'string' ? result : JSON.stringify(result ?? null));
}

async function callTool(session, name, args) {
  const tool = scopeTools(session).find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" is not served by this session`);
  if (session) callCounts.set(session.id, (callCounts.get(session.id) || 0) + 1);
  const caller = callerFor(session);

  // Brokered sessions are owner-class: principal 'owner', subscribed, origin
  // 'mcp'. callAppToolHandler nests its own spend context and inherits these
  // (its origin comes from caller.origin), so a ctx.transcribe() inside the
  // tool handler lands in the ledger as app/<owner>/mcp.
  return spendContext.run(
    { app: tool.ownerApp, origin: 'mcp', principal: 'owner', subscribed: true, caller: appTools.callerRecord(caller) },
    async () => {
      const kind = governedKind(tool.shortName);
      if (kind) {
        // This branch never reaches callAppToolHandler, so it authorizes here.
        const authz = appTools.authorizeToolCall(caller, tool.name, { app: tool.ownerApp, tool: tool.shortName });
        if (!authz.allow) throw new Error(authz.reason);
        const governance = require('./governance/horst-governance');
        const r = await governance.requestAction(kind, args || {}, { origin: 'mcp', app: tool.ownerApp === '__platform__' ? null : tool.ownerApp });
        if (r.mode === 'executed') {
          const summary = r.proposal?.result?.summary || 'executed';
          return textResult(r.proposal?.result?.ok === false ? `Executed with failure: ${summary}` : summary);
        }
        if (r.mode === 'proposed') {
          return textResult(`Staged for approval: ${r.proposal.id} — "${r.proposal.summary}". `
            + 'This action is approval-gated; the owner must approve it before it runs. Do not retry.');
        }
        if (r.mode === 'suppressed') {
          return textResult(`Not staged: ${r.reason} (already answered — do not retry).`);
        }
        return textResult(`Observed only — the autonomy dial for "${kind}" is set to observe; nothing was executed.`);
      }
      return toToolResult(await appTools.callAppToolHandler(tool.ownerApp, tool.shortName, args || {}, caller));
    },
  );
}

// ---------------------------------------------------------------------------
// Catalog mode — an orchestrator's three meta tools. Search and describe read
// the live union; tools_call is callTool under the orchestrator's caller.
// ---------------------------------------------------------------------------

const SEARCH_LIMIT = 20;
const SEARCH_LIMIT_MAX = 100;

function summaryOf(description) {
  const line = String(description || '').split(/\n/)[0].trim();
  const sentence = (line.match(/^.*?[.!?](?=\s|$)/) || [line])[0];
  return sentence.length > 140 ? sentence.slice(0, 139) + '…' : sentence;
}

// A compact catalog entry: enough to pick a tool (what it touches included)
// and to notice a contract change (contractHash) without describing it.
function searchEntry(t) {
  return { name: t.name, app: t.ownerApp, kind: t.kind, sideEffects: t.sideEffects, contractHash: t.contractHash, summary: summaryOf(t.description) };
}

function searchTools({ query, app, limit } = {}) {
  let pool = [...catalog().values()];
  if (typeof app === 'string' && app) pool = pool.filter((t) => t.ownerApp === app);
  const q = typeof query === 'string' ? query.trim() : '';
  const exact = q ? pool.find((t) => t.name === q) : null;
  let hits = q ? scoreTools(q, pool, { prefix: true }) : pool;
  if (exact) hits = [exact, ...hits.filter((t) => t !== exact)];
  const n = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Number(limit) || SEARCH_LIMIT));
  return {
    tools: hits.slice(0, n).map(searchEntry),
    total: hits.length,
  };
}

// Every field the registry holds for a tool, passed through as-is (a new
// field reaches the orchestrator without a change here); `name` is the
// namespaced name, `app` / `tool` its routing.
function describeTools({ names } = {}) {
  const list = Array.isArray(names) ? names : typeof names === 'string' ? [names] : [];
  const known = catalog();
  const tools = [];
  const unknown = [];
  for (const n of list) {
    const t = known.get(n);
    if (!t) { unknown.push(n); continue; }
    const { _ownerApp, ...def } = t.def;
    tools.push({ ...def, name: t.name, app: t.ownerApp, tool: t.shortName, inputSchema: t.inputSchema });
  }
  return { tools, ...(unknown.length ? { unknown } : {}) };
}

function jsonResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

const CATALOG_TOOLS = [
  {
    name: 'tools_search',
    description: 'Search the app tools of this platform. Returns compact entries { name, app, kind, sideEffects (none|writes|external), contractHash, summary }, best match first. Use tools_describe on a name for its input schema, result schema and examples.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What the tool should do, in a few words (or an exact tool name).' },
        app: { type: 'string', description: 'Only tools of this app.' },
        limit: { type: 'integer', description: `Max entries (default ${SEARCH_LIMIT}, max ${SEARCH_LIMIT_MAX}).` },
      },
    },
    handler: (session, args) => jsonResult(searchTools(args)),
  },
  {
    name: 'tools_describe',
    description: 'Full records of app tools by name: description, inputSchema, returns (result schema or prose), sideEffects, artifacts (accepted/produced mime types), examples, version, contractHash and every other field the platform holds for them.',
    inputSchema: {
      type: 'object',
      properties: { names: { type: 'array', items: { type: 'string' }, description: 'Tool names as tools_search returns them (<app>__<tool>).' } },
      required: ['names'],
    },
    handler: (session, args) => jsonResult(describeTools(args)),
  },
  {
    name: 'tools_call',
    description: 'Call an app tool directly, for a quick lookup. Its result is returned as the tool returned it. Side-effect tools may be staged for the owner\'s approval instead of running.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The tool name (<app>__<tool>).' },
        args: { type: 'object', description: 'The tool\'s arguments, per its inputSchema.' },
      },
      required: ['name'],
    },
    handler: (session, args) => {
      if (typeof args.name !== 'string' || !args.name) throw new Error('tools_call requires name');
      return callTool(session, args.name, args.args && typeof args.args === 'object' ? args.args : {});
    },
  },
];

// ---------------------------------------------------------------------------
// Built-in tools — served on a holder session when `when(session)` is true.
// ---------------------------------------------------------------------------

const builtins = new Map(); // name → { name, description, inputSchema, when, handler }

function registerBuiltinTool(def) {
  if (!def || typeof def.name !== 'string' || !def.name) throw new Error('a built-in tool needs a name');
  if (typeof def.handler !== 'function') throw new Error(`built-in tool "${def.name}" needs a handler`);
  if (def.name.includes('__')) throw new Error(`built-in tool "${def.name}": "__" is reserved for app tools`);
  builtins.set(def.name, {
    name: def.name,
    description: def.description || '',
    inputSchema: def.inputSchema || { type: 'object', properties: {} },
    when: typeof def.when === 'function' ? def.when : () => true,
    handler: def.handler,
  });
  return () => { if (builtins.get(def.name)?.handler === def.handler) builtins.delete(def.name); };
}

function builtinsFor(session) {
  if (!session || !session.holder) return [];
  return [...builtins.values()].filter((b) => { try { return !!b.when(session); } catch { return false; } });
}

// A run's principal for the tool-job ledger: any session of the run.
function sessionPrincipal(session) {
  return session && session.holder ? `run:${session.holder.runId}` : 'owner';
}

function holdsJobTool(session) {
  if (!session || !session.toolNames) return false;
  const known = catalog();
  return session.toolNames.some((n) => known.get(n)?.kind === 'job');
}

const jobIdProp = { type: 'string', description: 'The tool job id (tj_…).' };
const JOB_BUILTINS = [
  {
    name: 'tool_job_status',
    description: 'Status of a long-running app tool job: with jobId its full record and result; without, the jobs of this run, newest first.',
    inputSchema: { type: 'object', properties: { jobId: jobIdProp } },
    handler: (args, session) => {
      const jobs = require('./app-tool-jobs');
      const who = sessionPrincipal(session);
      if (!args.jobId) {
        const list = jobs.list(who).map((j) => ({
          id: j.id, tool: j.name, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
          ...(j.progress ? { progress: j.progress } : {}),
          ...(j.pendingQuestion ? { question: j.pendingQuestion.text } : {}),
        }));
        return jsonResult({ jobs: list });
      }
      const rec = jobs.get(args.jobId, who);
      const lines = [jobs.formatOutcome(rec, { full: true })];
      if (rec.progress) lines.push(`Progress: ${[rec.progress.pct !== undefined ? `${rec.progress.pct}%` : null, rec.progress.label].filter(Boolean).join(' ')}`);
      if (rec.pendingQuestion) lines.push(`Asks: ${rec.pendingQuestion.text} (answer with tool_job_reply)`);
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: rec };
    },
  },
  {
    name: 'tool_job_cancel',
    description: 'Cancel a running app tool job of this run.',
    inputSchema: { type: 'object', properties: { jobId: jobIdProp }, required: ['jobId'] },
    handler: (args, session) => jsonResult(require('./app-tool-jobs').cancel(args.jobId, sessionPrincipal(session))),
  },
  {
    name: 'tool_job_reply',
    description: 'Answer the question a running app tool job asked (the "tj_… asks:" message).',
    inputSchema: { type: 'object', properties: { jobId: jobIdProp, text: { type: 'string', description: 'The answer.' } }, required: ['jobId', 'text'] },
    handler: (args, session) => jsonResult(require('./app-tool-jobs').reply(args.jobId, args.text, sessionPrincipal(session))),
  },
];
for (const t of JOB_BUILTINS) {
  registerBuiltinTool({ ...t, when: (s) => s.mode === 'catalog' || holdsJobTool(s) });
}

// The artifact store's built-ins, when that module exists.
try {
  for (const t of require('./artifact-tools').builtinTools || []) registerBuiltinTool(t);
} catch (err) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') console.warn('[mcp-broker] artifact built-ins not registered:', err && err.message);
}

// The sound-effect built-in (ElevenLabs via ai.sfx), for the same holder sessions.
try {
  for (const t of require('./sound-tools').builtinTools || []) registerBuiltinTool(t);
} catch (err) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') console.warn('[mcp-broker] sound built-ins not registered:', err && err.message);
}

async function callBuiltin(tool, session, args) {
  if (session) callCounts.set(session.id, (callCounts.get(session.id) || 0) + 1);
  const r = await tool.handler(args || {}, session);
  return r && typeof r === 'object' && Array.isArray(r.content) ? r : jsonResult(r ?? null);
}

// What a session lists: the catalog tools for a catalog session, else its
// scope; then the built-ins that apply to it.
function listedTools(session) {
  const own = session && session.mode === 'catalog' ? CATALOG_TOOLS : scopeTools(session);
  return [...own, ...builtinsFor(session)];
}

async function dispatchCall(session, name, args) {
  const builtin = builtinsFor(session).find((t) => t.name === name);
  if (builtin) return callBuiltin(builtin, session, args);
  if (session && session.mode === 'catalog') {
    const meta = CATALOG_TOOLS.find((t) => t.name === name);
    if (!meta) throw new Error(`Tool "${name}" is not served by this session`);
    return meta.handler(session, args || {});
  }
  return callTool(session, name, args);
}

// One JSON-RPC message → a response object, or null for notifications.
// `session` is a live session record, or null for the owner default endpoint.
async function handleMessage(session, msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
    return rpcError(msg && msg.id !== undefined ? msg.id : null, -32600, 'Invalid request');
  }
  if (msg.method.startsWith('notifications/')) return null;
  const id = msg.id !== undefined ? msg.id : null;
  try {
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, {
          tools: listedTools(session).map((t) => ({
            name: t.name, description: t.description, inputSchema: t.inputSchema,
          })),
        });
      case 'tools/call': {
        const { name, arguments: args } = msg.params || {};
        if (typeof name !== 'string') return rpcError(id, -32602, 'tools/call requires params.name');
        try {
          return rpcResult(id, await dispatchCall(session, name, args));
        } catch (err) {
          // Tool execution failures are tool RESULTS (isError), not protocol errors.
          return rpcResult(id, textResult(`Error: ${err.message}`, true));
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (err) {
    return rpcError(id, -32603, err.message);
  }
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function rateLimited(ip) {
  const e = authFails.get(ip);
  return !!e && Date.now() - e.windowStart <= FAIL_WINDOW_MS && e.count >= FAIL_LIMIT;
}
function recordFail(ip) {
  const now = Date.now();
  const e = authFails.get(ip);
  if (!e || now - e.windowStart > FAIL_WINDOW_MS) authFails.set(ip, { count: 1, windowStart: now });
  else e.count++;
  if (authFails.size > 1000) authFails.clear();
}

async function respond(res, session, body) {
  const messages = Array.isArray(body) ? body : [body];
  if (Array.isArray(body) && !body.length) return res.status(400).json(rpcError(null, -32600, 'Empty batch'));
  const out = [];
  for (const m of messages) {
    const r = await handleMessage(session, m);
    if (r) out.push(r);
  }
  if (!out.length) return res.status(202).end(); // notifications only
  res.json(Array.isArray(body) ? out : out[0]);
}

function createRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  // ---- Minted scoped sessions (auth-EXEMPT at the core seam — the ONLY
  // exempt paths under /pro/mcp; self-authenticate by bearer token) ----------
  router.post('/s/:id', async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || '?';
    const h = String(req.headers.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    // The token is checked first: only failures are limited, so a legitimate
    // client is served even while its address is locked out by bad guesses
    // (an attacker sharing its address cannot lock it out).
    const session = resolveSession(req.params.id, token);
    if (!session) {
      if (rateLimited(ip)) return res.status(429).json({ error: 'too many attempts' });
      recordFail(ip);
      return res.status(401).json({ error: 'unauthorized' });
    }
    await respond(res, session, req.body);
  });
  router.get('/s/:id', (req, res) => res.status(405).json({ error: 'SSE stream not supported; POST JSON-RPC messages' }));

  // ---- Owner surface (core's auth middleware already ran) ------------------
  router.post('/sessions', (req, res) => {
    try {
      res.json(createSession(req.body || {}));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  router.get('/sessions', (req, res) => res.json({ sessions: listSessions() }));
  router.delete('/sessions/:id', (req, res) => {
    if (!revokeSession(req.params.id)) return res.status(404).json({ error: 'session not found' });
    res.json({ ok: true });
  });

  // Default owner session: the full platform union, no minting needed.
  router.post('/', async (req, res) => { await respond(res, null, req.body); });
  router.get('/', (req, res) => res.status(405).json({ error: 'SSE stream not supported; POST JSON-RPC messages' }));

  return router;
}

// ---------------------------------------------------------------------------
// __platform__ pack contribution (registered by platform-horst's tool pack):
// Horst can see who else is working through the broker.
// ---------------------------------------------------------------------------

const sessionsTool = {
  def: {
    name: 'mcp_sessions_list',
    description: 'Read-only: list the active MCP broker sessions — other AI processes currently holding a scoped platform tool server. Each entry: { id, task, tools (null = full union), createdAt, expiresAt (null for an orchestration-run holder session), calls, holder?, mode? }.',
    inputSchema: { type: 'object', properties: {} },
    expose: 'platform',
  },
  handler: async () => ({ sessions: listSessions() }),
};

module.exports = {
  init, createRouter,
  createSession, listSessions, revokeSession, selectToolsForTask,
  createHolderSession, revokeHolder, setHolderLiveness, sweepOrphans, registerBuiltinTool,
  knownToolNames: () => [...catalog().keys()],
  catalogEntry: (name) => { const t = catalog().get(name); return t ? searchEntry(t) : null; },
  searchTools, describeTools, CATALOG_TOOLS: CATALOG_TOOLS.map((t) => t.name),
  onSessionEvent, sessionsTool,
  // Exposed for tests (and any in-process consumer that wants the protocol
  // without HTTP): resolve a session record by id, handle one JSON-RPC message.
  // An unknown/expired id is an error, never a silent fall-through to the
  // full-union owner scope.
  handleMessage: (sessionId, msg) => {
    if (!sessionId) return handleMessage(null, msg);
    const s = sessions.get(sessionId);
    if (!s) return Promise.resolve(rpcError(msg && msg.id !== undefined ? msg.id : null, -32000, 'Unknown session'));
    return handleMessage(s, msg);
  },
  sweep,
};
