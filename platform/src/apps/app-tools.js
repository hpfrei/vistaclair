// App MCP tool registry — tools an app's routes.js registers (ctx.registerTools /
// ctx.onToolCall), the expose-level policy, the per-AI-session tool tokens the
// /api/app-tool-call endpoint resolves, the audit ring, and cross-app calls
// (ctx.tools.call). Backs the `tools` capability and every aiPrompt sidecar.

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const appManager = require('./app-manager');
const spendContext = require('./spend-context');
const { core } = require('./core-services');

// --- App MCP tool registry ---
// appName → { tools: Map<toolName, { name, description, inputSchema, returns, timeout, expose, kind,
//   sideEffects, artifacts?, examples?, version?, contractHash }>, handlers: Map<toolName, Function> }
// expose levels are strictly nested: 'self' (own aiPrompt sessions + GUI test),
// 'platform' (+ platform AI and cron), 'apps' (+ other apps via ctx.tools.call).
// There is deliberately NO network/external level — the one non-loopback
// consumer is the MCP broker (mcp-broker.js), which serves the platform union
// exclusively to OWNER-class AI sessions (owner auth / minted bearer tokens),
// never to app users or anonymous traffic.
const appToolRegistry = new Map();
const EXPOSE_LEVELS = new Set(['self', 'platform', 'apps']);
// `returns` says what the result contains: a JSON Schema object (preferred —
// a quick call's `structuredContent` is checked against it, see checkResult)
// or one sentence of prose (still accepted). The inputSchema says what a
// caller passes; nothing said what comes back, so a cross-app caller had to
// call the tool to find out. It travels into the manifest and the
// `.vistaclair/apps/` sidecars (as returnsText) and is snapshotted by a
// change request so an extension can be held to a superset.
const RETURNS_MAX = 300;
// `sideEffects`: 'none' (read-only), 'writes' (changes the app's own state),
// 'external' (sends or spends outside: mail, Telegram, paid APIs). Absent =
// 'writes', the conservative reading. Ordered: escalating it is a breaking
// contract change (compareContracts).
const SIDE_EFFECTS = ['none', 'writes', 'external'];
const EXAMPLES_MAX = 3;
const VERSION_MAX = 40;
const MIME_RE = /^([a-z0-9][a-z0-9.+-]*|\*)\/([a-z0-9][a-z0-9.+-]*|\*)$/i;
// `kind`: 'call' (answers within the call) or 'job' (long-running: runs in the
// provider's ctx.jobs, answers inline when done within the caller's `_wait`,
// else with a job id and delivers the outcome later — app-tool-jobs.js).
const KINDS = new Set(['call', 'job']);
const JOB_NOTE = 'Long-running: returns a jobId unless done within the wait; the result arrives later as a message (tool_job_status / tool_job_cancel / tool_job_reply manage it).';
// What an owner chat turn (Horst) reads instead: the call stages a Start card,
// so the request is settled first and the card carries his plan (`_plan`).
const HORST_JOB_NOTE = 'Long-running: calling it stages a Start card for the owner. First compare the request with this description: if scope, length, language/style or output format is open, or the tool works differently than the owner may expect, ask in one short message with your proposed defaults and wait for the answer; then call it with _plan.';
const PLAN_MAX = 500;

function registerAppTools(appName, toolDefs) {
  if (!appToolRegistry.has(appName)) {
    appToolRegistry.set(appName, { tools: new Map(), handlers: new Map() });
  }
  const entry = appToolRegistry.get(appName);
  let manifestTools = null;
  const previous = (name) => {
    if (entry.tools.has(name)) return entry.tools.get(name);
    if (manifestTools === null) {
      try { manifestTools = (appManager.readManifest(appName) || {}).tools; } catch {}
      if (!Array.isArray(manifestTools)) manifestTools = [];
    }
    return manifestTools.find((t) => t && t.name === name) || null;
  };
  const changed = [];
  for (const tool of toolDefs) {
    const expose = tool.expose || 'self';
    if (!EXPOSE_LEVELS.has(expose)) {
      throw new Error(`Tool "${tool.name}": invalid expose "${tool.expose}" (must be self|platform|apps)`);
    }
    const kind = tool.kind || 'call';
    if (!KINDS.has(kind)) throw new Error(`Tool "${tool.name}": invalid kind "${tool.kind}" (must be call|job)`);
    const sideEffects = tool.sideEffects === undefined ? 'writes' : tool.sideEffects;
    if (!SIDE_EFFECTS.includes(sideEffects)) {
      throw new Error(`Tool "${tool.name}": invalid sideEffects "${tool.sideEffects}" (must be none|writes|external)`);
    }
    // A job's timeout is its maximum runtime (default 4 h, max 24 h).
    const jobs = kind === 'job' ? require('./app-tool-jobs') : null;
    const def = {
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      returns: normalizeReturns(appName, tool),
      timeout: jobs ? Math.min(jobs.MAX_TIMEOUT_MS, tool.timeout || jobs.DEFAULT_TIMEOUT_MS) : tool.timeout || 180000,
      expose,
      kind,
      sideEffects,
    };
    const artifacts = normalizeArtifacts(appName, tool);
    if (artifacts) def.artifacts = artifacts;
    const examples = normalizeExamples(appName, tool, def.inputSchema);
    if (examples) def.examples = examples;
    if (tool.version !== undefined) {
      if (typeof tool.version === 'string' && tool.version.trim()) def.version = tool.version.trim().slice(0, VERSION_MAX);
      else warnTool(appName, tool.name, 'version must be a non-empty string — ignored');
    }
    def.contractHash = contractHash(def);
    const prev = previous(tool.name);
    const before = prev ? prev.contractHash || contractHash(prev) : null;
    if (before && before !== def.contractHash) {
      changed.push({ tool: tool.name, before, after: def.contractHash, ...compareContracts(prev, def) });
    }
    entry.tools.set(tool.name, def);
  }
  const toolArray = getToolsForApp(appName);
  const manifestUpdates = { tools: toolArray };
  // Apps that provide tools beyond themselves must be running to serve calls;
  // default them to autostart unless the user explicitly opted out.
  if (toolArray.some((t) => t.expose !== 'self')) {
    try {
      const manifest = appManager.readManifest(appName);
      if (manifest && manifest.autostart === undefined) manifestUpdates.autostart = true;
    } catch {}
  }
  try { appManager.updateManifest(appName, manifestUpdates); } catch {}
  if (core.broadcaster) {
    core.broadcaster.broadcast({ type: 'app:tools:updated', appName, tools: toolArray });
    for (const c of changed) {
      core.broadcaster.broadcast({ type: 'app:tools:contractChanged', appName, tool: c.tool, before: c.before, after: c.after, compatible: c.compatible, problems: c.problems });
    }
  }
}

// --- The tool contract ---
// Registration never fails over a malformed optional field: it is warned and
// dropped (sideEffects, expose and kind are the exceptions — policy reads them).
function warnTool(appName, toolName, msg) {
  console.warn(`[app-tools] ${appName}.${toolName}: ${msg}`);
}

function normalizeReturns(appName, tool) {
  const r = tool.returns;
  if (r === undefined || r === null || r === '') return '';
  if (typeof r === 'string') return r.trim().slice(0, RETURNS_MAX);
  if (typeof r === 'object' && !Array.isArray(r)) {
    try { return JSON.parse(JSON.stringify(r)); } catch {}
  }
  warnTool(appName, tool.name, 'returns must be a JSON Schema object or a string — ignored');
  return '';
}

function normalizeArtifacts(appName, tool) {
  const a = tool.artifacts;
  if (a === undefined || a === null) return null;
  if (typeof a !== 'object' || Array.isArray(a)) {
    warnTool(appName, tool.name, 'artifacts must be { accepts?: [mime], produces?: [mime] } — ignored');
    return null;
  }
  const out = {};
  for (const key of ['accepts', 'produces']) {
    if (a[key] === undefined) continue;
    const list = Array.isArray(a[key]) ? a[key] : [a[key]];
    const ok = list.filter((m) => typeof m === 'string' && MIME_RE.test(m.trim())).map((m) => m.trim().toLowerCase());
    if (ok.length !== list.length) warnTool(appName, tool.name, `artifacts.${key}: dropped entries that are not a mime type or glob like 'image/*'`);
    if (ok.length) out[key] = [...new Set(ok)];
  }
  return Object.keys(out).length ? out : null;
}

function normalizeExamples(appName, tool, inputSchema) {
  const ex = tool.examples;
  if (ex === undefined || ex === null) return null;
  if (!Array.isArray(ex)) {
    warnTool(appName, tool.name, 'examples must be an array of { args, note? } — ignored');
    return null;
  }
  if (ex.length > EXAMPLES_MAX) warnTool(appName, tool.name, `${ex.length} examples, only the first ${EXAMPLES_MAX} are kept`);
  const out = [];
  ex.slice(0, EXAMPLES_MAX).forEach((e, i) => {
    if (!e || typeof e !== 'object' || !e.args || typeof e.args !== 'object' || Array.isArray(e.args)) {
      warnTool(appName, tool.name, `example ${i + 1} has no args object — dropped`);
      return;
    }
    const problems = checkShallow(inputSchema, e.args);
    if (problems.length) warnTool(appName, tool.name, `example ${i + 1} does not fit inputSchema: ${problems.join('; ')}`);
    const item = { args: e.args };
    if (typeof e.note === 'string' && e.note.trim()) item.note = e.note.trim().slice(0, RETURNS_MAX);
    out.push(item);
  });
  return out.length ? out : null;
}

// Shallow, cheap JSON Schema check: the value's type, its enum, and for an
// object its required keys, its top-level property types / enums and (when
// additionalProperties is false) unknown keys. Nothing nested. → [problem]
// ([] = fits). Used for examples, a call's structuredContent and app-lint.
function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeFits(schema, v) {
  if (!schema || typeof schema !== 'object' || schema.type === undefined) return true;
  const t = jsonType(v);
  return [].concat(schema.type).some((want) => want === t || (want === 'number' && t === 'integer'));
}

function enumFits(schema, v) {
  return !schema || !Array.isArray(schema.enum) || schema.enum.some((e) => e === v);
}

function checkShallow(schema, value) {
  if (!schema || typeof schema !== 'object') return [];
  if (!typeFits(schema, value)) return [`expected ${[].concat(schema.type).join('|')}, got ${jsonType(value)}`];
  if (!enumFits(schema, value)) return [`${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  if (jsonType(value) !== 'object') return [];
  const out = [];
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const k of Array.isArray(schema.required) ? schema.required : []) {
    if (value[k] === undefined) out.push(`"${k}" is required`);
  }
  for (const [k, v] of Object.entries(value)) {
    const ps = props[k];
    if (!ps) {
      if (schema.additionalProperties === false) out.push(`"${k}" is not a known property`);
      continue;
    }
    if (v === undefined) continue;
    if (!typeFits(ps, v)) out.push(`"${k}" should be ${[].concat(ps.type).join('|')}, got ${jsonType(v)}`);
    else if (!enumFits(ps, v)) out.push(`"${k}" is not one of ${JSON.stringify(ps.enum)}`);
  }
  return out;
}

// The contract a caller depends on: what goes in (the reserved `_wait` and
// `_plan` of a job tool are the platform's, not the provider's), what comes out, how it
// answers and what it touches. Description, timeout, expose, examples and
// version are not part of it.
function contractOf(tool) {
  const schema = (tool && tool.inputSchema) || { type: 'object', properties: {} };
  const inputSchema = { ...schema };
  if (schema.properties && typeof schema.properties === 'object') {
    const { _wait, _plan, ...props } = schema.properties;
    inputSchema.properties = props;
  }
  if (Array.isArray(schema.required)) inputSchema.required = schema.required.filter((k) => k !== '_wait' && k !== '_plan');
  return {
    inputSchema,
    returns: (tool && tool.returns) || '',
    kind: (tool && tool.kind) || 'call',
    sideEffects: (tool && tool.sideEffects) || 'writes',
  };
}

// Canonical JSON: object keys sorted at every depth, a schema's `required`
// list sorted (it is a set), arrays otherwise in order.
function canonical(v, key) {
  if (Array.isArray(v)) {
    const items = v.map((x) => canonical(x));
    return `[${(key === 'required' && v.every((x) => typeof x === 'string') ? items.sort() : items).join(',')}]`;
  }
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k], k)}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

function contractHash(tool) {
  return crypto.createHash('sha256').update(canonical(contractOf(tool))).digest('hex');
}

// compareContracts(before, after) — tool defs (or contractOf records) → { compatible, problems }.
// The change-request rule: a caller written against `before` still works
// against `after`. Added optional input properties and added result
// properties are fine; a removed or renamed input property, a newly required
// one, a narrowed type or enum, a kind change, an escalated sideEffects, and
// a removed or retyped result property are not. Shallow (top level), as
// checkShallow is. A prose `returns` is never compared — a reworded sentence
// is not a broken caller — but dropping a result schema is.
function compareContracts(before, after) {
  const b = contractOf(before);
  const a = contractOf(after);
  const problems = [];
  const types = (s) => (s && s.type !== undefined ? [].concat(s.type) : null);
  const narrower = (bs, as) => {
    const bt = types(bs);
    const at = types(as);
    if (at && (!bt || bt.some((t) => !at.includes(t) && !(t === 'integer' && at.includes('number'))))) return 'type';
    if (Array.isArray(as && as.enum) && (!Array.isArray(bs && bs.enum) || bs.enum.some((e) => !as.enum.includes(e)))) return 'enum';
    return null;
  };
  const bp = b.inputSchema.properties || {};
  const ap = a.inputSchema.properties || {};
  for (const k of Object.keys(bp)) {
    if (!(k in ap)) { problems.push(`input "${k}" was removed`); continue; }
    const n = narrower(bp[k], ap[k]);
    if (n) problems.push(`input "${k}" has a narrower ${n}`);
  }
  const breq = new Set(b.inputSchema.required || []);
  for (const k of a.inputSchema.required || []) if (!breq.has(k)) problems.push(`input "${k}" became required`);
  if (b.kind !== a.kind) problems.push(`kind changed from ${b.kind} to ${a.kind}`);
  if (SIDE_EFFECTS.indexOf(a.sideEffects) > SIDE_EFFECTS.indexOf(b.sideEffects)) {
    problems.push(`sideEffects escalated from ${b.sideEffects} to ${a.sideEffects}`);
  }
  if (b.returns && typeof b.returns === 'object') {
    if (!a.returns || typeof a.returns !== 'object') {
      problems.push('the result schema was dropped');
    } else {
      const n = narrower(b.returns, a.returns);
      if (n) problems.push(`the result has a different ${n}`);
      const brp = b.returns.properties || {};
      const arp = a.returns.properties || {};
      for (const k of Object.keys(brp)) {
        if (!(k in arp)) problems.push(`result "${k}" was removed`);
        else if (narrower(brp[k], arp[k])) problems.push(`result "${k}" changed type`);
      }
    }
  }
  return { compatible: problems.length === 0, problems };
}

// A schema `returns` as one line of text, for the readers that print it
// (the cross-app sidecars, change-request snapshots): its description, then
// its top-level shape.
function schemaShape(s, depth = 0) {
  if (!s || typeof s !== 'object') return 'any';
  if (s.type === 'array' || s.items) return `[${depth < 2 ? schemaShape(s.items, depth + 1) : '…'}]`;
  if (s.properties && typeof s.properties === 'object' && depth < 2) {
    const req = new Set(Array.isArray(s.required) ? s.required : []);
    return `{ ${Object.entries(s.properties).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${schemaShape(v, depth + 1)}`).join(', ')} }`;
  }
  return s.type !== undefined ? [].concat(s.type).join('|') : 'any';
}

function returnsText(returns) {
  if (!returns) return '';
  if (typeof returns === 'string') return returns;
  const desc = typeof returns.description === 'string' ? returns.description.trim() : '';
  const text = `${desc ? desc + ' — ' : ''}${schemaShape(returns)}`;
  return text.length > RETURNS_MAX ? text.slice(0, RETURNS_MAX - 1) + '…' : text;
}

// A quick call's `structuredContent` against a schema `returns`: a mismatch is
// logged, never fails the call. Returns the result untouched.
function checkResult(appName, toolName, tool, result) {
  try {
    if (!tool || !tool.returns || typeof tool.returns !== 'object') return result;
    if (!result || typeof result !== 'object' || result.structuredContent === undefined || result.isError) return result;
    const problems = checkShallow(tool.returns, result.structuredContent);
    if (problems.length) warnTool(appName, toolName, `structuredContent does not match returns: ${problems.join('; ')}`);
  } catch {}
  return result;
}

function registerAppToolHandler(appName, toolName, handler) {
  if (!appToolRegistry.has(appName)) {
    appToolRegistry.set(appName, { tools: new Map(), handlers: new Map() });
  }
  appToolRegistry.get(appName).handlers.set(toolName, handler);
}

// A tool as an outside caller sees it: a job tool's description says how it
// answers, and its schema admits the reserved `_wait` — or, for an owner chat
// turn (opts.horst), the reserved `_plan` the Start card leads with.
function callerView(tool, opts = {}) {
  if (tool.kind !== 'job') return tool;
  const schema = tool.inputSchema || { type: 'object', properties: {} };
  const reserved = opts.horst
    ? { _plan: { type: 'string', maxLength: PLAN_MAX, description: 'Your plan in plain words for the owner\'s Start card: 1-3 sentences on what this run will make (scope, length, language, style). Always pass it.' } }
    : { _wait: { type: 'integer', minimum: 0, maximum: 120, description: 'Seconds to wait for the result before a jobId is returned (default 30, max 120, 0 = return at once).' } };
  return {
    ...tool,
    description: `${tool.description ? tool.description.trimEnd() + ' ' : ''}${opts.horst ? HORST_JOB_NOTE : JOB_NOTE}`,
    inputSchema: { ...schema, properties: { ...(schema.properties || {}), ...reserved } },
  };
}

function getToolsForApp(appName) {
  const entry = appToolRegistry.get(appName);
  if (!entry) return [];
  return Array.from(entry.tools.values());
}

// Union of every registered app's platform-or-wider tools, for platform AI
// sessions (cron 'ai' jobs, setup assistant). Only running (registered) apps
// contribute — exposed tools default the app to autostart, so this is
// normally complete. opts.horst: the view of an owner chat turn (callerView).
function getPlatformToolUnion(opts = {}) {
  const out = [];
  // One duty, one implementation — the runtime half of app-lint's
  // duplicate-duty rule, scoped exactly as that rule is: against the PLATFORM's
  // own tools (the __platform__ pack), not against other apps. Two apps may
  // both call something 'server_status'; every consumer namespaces the union by
  // owner (`<app>__<tool>` in ai-service's sidecar and the MCP broker's
  // catalog), so those two coexist and route correctly. What cannot coexist is
  // an app re-implementing a tool the platform already provides: Horst then has
  // two 'email_search' entries in his digest and picks one at random, which is
  // the very duplication phase 8 exists to end. First registration wins — the
  // platform pack registers at boot — and the refusal is said out loud instead
  // of being silent, as it was until now.
  const platformNames = new Set();
  const platformPack = appToolRegistry.get('__platform__');
  if (platformPack) for (const t of platformPack.tools.values()) platformNames.add(t.name);

  for (const [app, entry] of appToolRegistry) {
    // Independent apps (platformContribution: false) are invisible to platform
    // sessions — their tools never enter the union or Horst's digest.
    if (!app.startsWith('__') && !appManager.contributes(app)) continue;
    for (const t of entry.tools.values()) {
      if (t.expose !== 'platform' && t.expose !== 'apps') continue;
      if (app !== '__platform__' && platformNames.has(t.name)) {
        console.warn(`[app-tools] refusing "${t.name}" from app "${app}": the platform already provides that tool — expose it as 'self' if the app's own AI needs its version`);
        continue;
      }
      out.push({ ...callerView(t, opts), _ownerApp: app });
    }
  }
  return out;
}

function clearAppTools(appName) {
  appToolRegistry.delete(appName);
  // Its caller-side job handlers (ctx.tools.onJobDone) die with it too.
  require('./app-tool-jobs').clearApp(appName);
}

// caller: { type: 'self'|'platform'|'app'|'cron'|'gui-test', appName? }, or a
// holder caller from an orchestration run's broker session (mcp-broker.js):
// { type: 'orchestrator'|'worker', runId, address, workerId?, orchestrator?,
// instanceId, scope } — platform-class for expose purposes; or the horst
// caller of an owner chat turn (resolveCaller below), platform-class too.
const HOLDER_TYPES = new Set(['orchestrator', 'worker']);

// --- Horst chat turns ---
// platform-horst binds the sessionTag of each chat turn's aiPrompt to where
// the turn came from; a platform caller carrying a bound tag is the typed
// `horst` caller { type: 'horst', conversationId, chatId?, surface,
// instanceId, sessionTag }. Tags are random per turn and released when the
// turn ends. app-tool-jobs routes a horst caller's job outcome back to the
// conversation (docs/tool-jobs-artifacts.md "Job tools"). The resource_links a
// quick tool returns during the turn are kept per turn (horstTurnFiles), so
// runChat delivers them with the reply; a job's files go with its outcome.
const horstTurns = new Map(); // sessionTag → { conversationId, chatId, surface }
const horstTurnLinks = new Map(); // sessionTag → [resource_link], unique by uri

function bindHorstTurn(sessionTag, { conversationId, chatId = null, surface = 'ui' } = {}) {
  if (!sessionTag || !conversationId) throw new Error('bindHorstTurn requires sessionTag and conversationId');
  horstTurns.set(sessionTag, { conversationId: String(conversationId), chatId: chatId == null ? null : String(chatId), surface: String(surface) });
  horstTurnLinks.set(sessionTag, []);
  return () => { horstTurns.delete(sessionTag); horstTurnLinks.delete(sessionTag); };
}

function isHorstTurn(sessionTag) { return !!sessionTag && horstTurns.has(sessionTag); }

function resolveCaller(caller) {
  if (!caller || caller.type !== 'platform' || !caller.sessionTag) return caller;
  const turn = horstTurns.get(caller.sessionTag);
  return turn ? { ...caller, type: 'horst', ...turn } : caller;
}

// The vc-artifact resource_links of a horst caller's quick-tool result, kept
// for its turn while the turn is bound.
function collectTurnFiles(caller, result) {
  const list = caller.type === 'horst' && horstTurnLinks.get(caller.sessionTag);
  if (!list || !result || !Array.isArray(result.content)) return;
  for (const b of result.content) {
    if (!b || b.type !== 'resource_link' || typeof b.uri !== 'string' || !b.uri.startsWith('vc-artifact://')) continue;
    if (!list.some((l) => l.uri === b.uri)) list.push({ ...b });
  }
}

function horstTurnFiles(sessionTag) {
  return (horstTurnLinks.get(sessionTag) || []).map((l) => ({ ...l }));
}

function exposeAllows(tool, appName, caller) {
  // Independent apps (platformContribution: false): only the app itself (and
  // the GUI tester) may call its tools — expose levels beyond self are inert.
  const external = caller.type === 'platform' || caller.type === 'horst' || caller.type === 'app' || HOLDER_TYPES.has(caller.type)
    || (caller.type === 'cron' && caller.appName !== appName);
  if (external && !appName.startsWith('__') && !appManager.contributes(appName)) return false;
  switch (caller.type) {
    case 'self':
    case 'gui-test':
      return true;
    case 'platform':
    case 'horst':
    case 'orchestrator':
    case 'worker':
      return tool.expose === 'platform' || tool.expose === 'apps';
    case 'cron':
      // an app's own cron jobs may call its own self tools
      return caller.appName === appName || tool.expose === 'platform' || tool.expose === 'apps';
    case 'app':
      return tool.expose === 'apps';
    default:
      return false;
  }
}

// --- The one authorization choke point ---
// Every app-tool call passes here exactly once: callAppToolHandler (aiPrompt
// sidecars, ctx.tools.call, cron, the GUI tester, the broker's plain calls)
// and the broker's governed-kind branch, which never reaches a handler.
// `toolName` is the namespaced `<app>__<tool>`; `target` is its routing
// ({ app, tool }), recorded at catalog time because the name is not reliably
// parseable. → { allow: true } | { allow: false, reason }.
//
// The expose levels, a holder caller's strict scope (a worker's grant; null =
// the orchestrator's full union), and for an `app` caller the app→app
// dependency edges (app-deps.js): no approved edge → recorded as observed and
// allowed with `undeclared: true` ('warn', the default), or refused
// ('enforce', the appDepsEnforce platform setting). A tool's side-effect
// policy would plug in here too.
function authorizeToolCall(caller, toolName, target) {
  const entry = appToolRegistry.get(target.app);
  const tool = entry && entry.tools.get(target.tool);
  if (!tool) return { allow: false, reason: `No tool "${target.tool}" in app "${target.app}"` };
  if (!exposeAllows(tool, target.app, caller)) {
    return { allow: false, reason: `Tool "${target.tool}" in "${target.app}" is not exposed to ${caller.type} callers (expose: ${tool.expose})` };
  }
  if (HOLDER_TYPES.has(caller.type) && caller.scope !== null && !(Array.isArray(caller.scope) && caller.scope.includes(toolName))) {
    return { allow: false, reason: `Tool "${toolName}" is not granted to this ${caller.type}` };
  }
  if (isAppToApp(caller, target.app)) return require('./app-deps').authorize(caller.appName, target.app, target.tool);
  return { allow: true };
}

function isAppToApp(caller, appName) {
  return caller.type === 'app' && !!caller.appName && caller.appName !== appName;
}

// Call stats on the edge an app→app call ran under (app-deps.recordCall).
function recordDepCall(caller, appName, toolName, ok) {
  if (!isAppToApp(caller, appName)) return;
  try { require('./app-deps').recordCall(caller.appName, appName, toolName, { ok }); } catch {}
}

// The caller as the audit and the spend context record it: the existing
// { type, appName } shape, plus the run identity of a holder caller.
function callerRecord(caller) {
  const out = { type: caller.type, appName: caller.appName || null };
  if (HOLDER_TYPES.has(caller.type)) {
    for (const k of ['runId', 'address', 'workerId', 'orchestrator']) if (caller[k]) out[k] = caller[k];
  }
  if (caller.type === 'horst') {
    for (const k of ['conversationId', 'chatId', 'surface']) if (caller[k]) out[k] = caller[k];
  }
  return out;
}

// --- Tool-call audit (in-memory ring, newest last) ---
const TOOL_AUDIT_MAX = 200;
const toolAudit = []; // { ts, callerType, callerApp, caller, appName, toolName, durationMs, ok, error?, undeclared? }

function getToolAudit(limit = 50) {
  return toolAudit.slice(-limit).reverse();
}

function recordToolCall(entryData) {
  toolAudit.push(entryData);
  if (toolAudit.length > TOOL_AUDIT_MAX) toolAudit.splice(0, toolAudit.length - TOOL_AUDIT_MAX);
  const who = entryData.callerApp ? `${entryData.callerType}:${entryData.callerApp}`
    : entryData.caller && entryData.caller.address ? `${entryData.callerType}:${entryData.caller.address}` : entryData.callerType;
  console.log(`  Tools: [${who} → ${entryData.appName}.${entryData.toolName}] ${entryData.durationMs}ms ${entryData.ok ? 'ok' : `error: ${entryData.error}`}`);
  if (core.broadcaster) core.broadcaster.broadcast({ type: 'app:tools:auditEvent', entry: entryData });
}

// --- The call in progress ---
// currentCall() → { caller, app, tool, callId, jobId } inside a tool handler
// (quick or job, including the ctx.jobs run of a job tool), else null. Read by
// platform code that acts on the caller's behalf (the artifact store grants
// what a handler stores to its caller).
const callStore = new AsyncLocalStorage();
function currentCall() { return callStore.getStore() || null; }
function newCallId() { return `tc_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`; }

// Artifact refs (`vc-artifact://art_…`) in a call's args that the caller may
// read become readable by the target app. A no-op without the artifact store.
function grantArgArtifacts(appName, args, caller) {
  let art;
  try { art = require('./app-artifacts'); } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return;
    throw err;
  }
  if (typeof art.extractRefs !== 'function') return;
  const refs = art.extractRefs(args) || [];
  if (!refs.length) return;
  const who = art.principalOf(caller);
  const target = art.principalOf({ type: 'app', appName });
  for (const ref of refs) {
    try { if (art.canRead(who, ref)) art.grant(ref, target); } catch {}
  }
}

// opts.wait (seconds; Infinity = until it ends) overrides a job tool's `_wait`
// — ctx.tools.callAndWait. Quick tools ignore it.
// opts.approved: a horst caller's job tool runs instead of being staged (the
// approved app.tool.job proposal, agent/horst-jobs.js).
async function callAppToolHandler(appName, toolName, args, caller = { type: 'self' }, opts = {}) {
  caller = resolveCaller(caller);
  const entry = appToolRegistry.get(appName);
  if (!entry) throw new Error(`No tools registered for app "${appName}"`);
  const tool = entry.tools.get(toolName);
  const handler = entry.handlers.get(toolName);
  if (!tool || !handler) throw new Error(`No handler for tool "${toolName}" in app "${appName}"`);
  const who = callerRecord(caller);
  // Through module.exports: the choke point is one replaceable binding.
  const authz = module.exports.authorizeToolCall(caller, `${appName}__${toolName}`, { app: appName, tool: toolName });
  const flag = authz.undeclared ? { undeclared: true } : {};
  if (!authz.allow) {
    recordToolCall({ ts: Date.now(), callerType: caller.type, callerApp: caller.appName || null, caller: who, appName, toolName, durationMs: 0, ok: false, error: authz.reason, ...flag });
    recordDepCall(caller, appName, toolName, false);
    throw new Error(authz.reason);
  }
  grantArgArtifacts(appName, args, caller);
  const startedAt = Date.now();
  const audit = { ts: startedAt, callerType: caller.type, callerApp: caller.appName || null, caller: who, appName, toolName, ...flag };
  if (tool.kind === 'job' && caller.type === 'horst' && !opts.approved) {
    // An owner chat turn never starts a job: it stages the confirm card, its
    // `_plan` on the payload beside the args. The provider is not involved,
    // so a refusal is not its failure (no app-guard).
    const { _wait, _plan, ...rest } = args || {};
    const plan = typeof _plan === 'string' && _plan.trim() ? _plan.trim().slice(0, PLAN_MAX) : undefined;
    try {
      const staged = await require('./app-tool-jobs').stageForHorst({ app: appName, tool: toolName, args: rest, plan, caller });
      recordToolCall({ ...audit, durationMs: Date.now() - startedAt, ok: true });
      return staged;
    } catch (err) {
      recordToolCall({ ...audit, durationMs: Date.now() - startedAt, ok: false, error: err.message });
      throw err;
    }
  }
  try {
    // Spend attribution: a tool call spends on behalf of the AI session that
    // made it (its principal was captured when aiPrompt started). Callers that
    // are themselves an entry point (the MCP broker) carry their own origin.
    const session = caller && caller.instanceId ? spendContext.instanceInfo(caller.instanceId) : null;
    const spend = { app: appName, origin: (caller && caller.origin) || 'tool', principal: session ? session.principal : (spendContext.principal() || null), caller: who };
    const callId = newCallId();
    let result;
    if (tool.kind === 'job') {
      const jobs = require('./app-tool-jobs');
      // `_plan` is Horst's, read only when staging: any other caller's is dropped.
      const { _wait, _plan, ...rest } = args || {};
      result = await spendContext.run(spend, () => jobs.start({
        app: appName, tool: toolName, def: tool, args: rest, caller,
        handler: async (a, c, j) => checkResult(appName, toolName, tool, await handler(a, c, j)),
        wait: opts.wait !== undefined ? opts.wait : jobs.waitSeconds(_wait),
        runHandler: (job, fn) => callStore.run({ caller, app: appName, tool: toolName, callId, jobId: job.id }, fn),
      }));
    } else {
      result = await spendContext.run(spend, () => callStore.run({ caller, app: appName, tool: toolName, callId, jobId: null }, () => handler(args, caller)));
      checkResult(appName, toolName, tool, result);
      collectTurnFiles(caller, result);
    }
    recordToolCall({ ...audit, durationMs: Date.now() - startedAt, ok: true });
    recordDepCall(caller, appName, toolName, !(result && result.isError));
    return result;
  } catch (err) {
    recordToolCall({ ...audit, durationMs: Date.now() - startedAt, ok: false, error: err.message });
    recordDepCall(caller, appName, toolName, false);
    require('./app-guard').record(appName, `tools.${toolName}`, err, { callerType: caller.type });
    throw err;
  }
}

// --- Ephemeral per-AI-session tool tokens ---
// Minted per aiPrompt call, passed to the MCP sidecar instead of the platform
// AUTH_TOKEN, revoked when the session ends. In-memory only.
const toolSessionTokens = new Map(); // token → { appName, instanceId, allowedTools: Map<fullName, { ownerApp, shortName }> }

// tools: [{ name, ownerApp, shortName }] — the full sidecar name plus its
// routing target. Routing is recorded at mint time because the full name is
// NOT reliably parseable: pseudo-app owners like '__platform__' contain the
// '__' separator themselves (e.g. '__platform____email_get').
function mintToolToken(appName, instanceId, tools, sessionTag) {
  const token = crypto.randomBytes(24).toString('hex');
  toolSessionTokens.set(token, {
    appName,
    instanceId,
    sessionTag: sessionTag || undefined,
    allowedTools: new Map(tools.map((t) => [t.name, { ownerApp: t.ownerApp, shortName: t.shortName }])),
  });
  return token;
}

function resolveToolToken(token) {
  return token ? toolSessionTokens.get(token) || null : null;
}

function revokeToolToken(token) {
  toolSessionTokens.delete(token);
}

// In-process app→app tool call (backs ctx.tools.call). Lazy-mounts a stopped
// in-process target; expose enforcement happens in callAppToolHandler.
async function callCrossAppTool(callerApp, targetApp, tool, args, opts) {
  if (targetApp === callerApp) {
    return callAppToolHandler(targetApp, tool, args, { type: 'self', appName: callerApp }, opts);
  }
  if (!appToolRegistry.has(targetApp)) {
    const manifest = appManager.readManifest(targetApp);
    if (!manifest) throw new Error(`App "${targetApp}" not found`);
    if (appManager.appRuntime(targetApp) !== 'in-process') {
      throw new Error(`App "${targetApp}" runs in its own process (runtime: "own-process") — cross-app tools require an in-process app`);
    }
    await appManager.startApp(targetApp, core.broadcaster);
  }
  return callAppToolHandler(targetApp, tool, args, { type: 'app', appName: callerApp }, opts);
}

module.exports = {
  registerAppTools, registerAppToolHandler, getToolsForApp, getPlatformToolUnion, clearAppTools,
  exposeAllows, authorizeToolCall, callerRecord, getToolAudit, recordToolCall, callAppToolHandler,
  mintToolToken, resolveToolToken, revokeToolToken, callCrossAppTool, callerView, currentCall, JOB_NOTE, HORST_JOB_NOTE, PLAN_MAX,
  bindHorstTurn, isHorstTurn, resolveCaller, horstTurnFiles,
  SIDE_EFFECTS, checkShallow, contractOf, contractHash, compareContracts, returnsText,
};
