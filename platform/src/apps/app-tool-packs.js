// App tools for orchestration runs — the two core tool packs Pro registers
// (docs/app-tools.md "Tool grants for orchestration runs", docs/seam.md):
//
//   app-tools-catalog  orchestrator, default: an MCP server `app-tools` with
//                      tools_search / tools_describe / tools_call over the
//                      platform union (a broker 'catalog' holder session).
//   app-tools-grant    worker, consumes core's `tools` launch field
//                      (settings.grants.tools): an MCP server `apps` serving
//                      exactly the granted tools (a strict broker 'grant'
//                      holder session), re-minted at every spawn.
//
// Plain sessions match neither pack's role and get nothing. Both packs only
// mint broker holder sessions; the scope, the authorization and the audit
// live in mcp-broker.js and app-tools.js.

const broker = require('./mcp-broker');

const CATALOG_PACK = 'app-tools-catalog';
const GRANT_PACK = 'app-tools-grant';
const GRANT_FEATURES = ['consumes', 'validate', 'release'];

// Job-kind tools (kind 'job'): how their answer and their outcome arrive.
const JOB_LINE = 'A tool of kind `job` is long-running: unless it ends within `_wait` seconds (default 30, max 120) it returns a jobId, and its result arrives later as a message `tj_… <tool> <status>`. A message `tj_… asks: …` wants an answer through `tool_job_reply`; `tool_job_status` and `tool_job_cancel` manage the jobs of your run.';

const CATALOG_PROMPT = [
  '## App tools',
  'The `app-tools` MCP server gives you the platform\'s app tools. Use `tools_search` and `tools_describe` to pick the tools a task needs.',
  'Give each worker the smallest list it needs through `launch_cli` `tools` (names exactly as `tools_search` returns them); a worker holds those and nothing else.',
  'A worker that lacks a tool reports blocked naming the capability: resume it with a corrected list through `resume_worker` `tools`.',
  'Call a tool yourself with `tools_call` only for a quick lookup; real work goes to a worker.',
  JOB_LINE,
].join('\n');

function grantPrompt(held, missing) {
  const lines = [
    '## App tools',
    'The `apps` MCP server holds exactly these app tools, granted by your orchestrator:',
    ...held.map((t) => `- \`${t.name}\`${t.kind === 'job' ? ' (job)' : ''} — ${t.summary || '(no description)'}`),
  ];
  if (held.some((t) => t.kind === 'job')) lines.push(JOB_LINE);
  if (missing.length) lines.push(`Granted but not available now (their app is not running): ${missing.map((n) => `\`${n}\``).join(', ')}.`);
  lines.push('If you need a tool you do not hold, report blocked naming the capability you need. Never work around a missing tool.');
  return lines.join('\n');
}

function grantedNames(settings) {
  const tools = settings && settings.grants && settings.grants.tools;
  return Array.isArray(tools) ? tools : [];
}

// cwd: the session's working directory (core passes it to build); a
// built-in such as artifact_fetch writes there for the holder.
function holderOf(settings, instanceId, cwd) {
  const o = (settings && settings.orchestration) || {};
  const dir = cwd || (settings && settings.cwd);
  return {
    type: o.role, runId: o.runId, address: settings.name, instanceId,
    ...(typeof dir === 'string' && dir ? { cwd: dir } : {}),
    ...(o.workerId ? { workerId: o.workerId } : {}),
    ...(o.orchestrator ? { orchestrator: o.orchestrator } : {}),
  };
}

// Up to three known names closest to an unknown one: same tool name under
// another app first, then substring and edit-distance neighbours.
function closeMatches(name, known) {
  const short = String(name).split('__').pop().toLowerCase();
  const scored = [];
  for (const k of known) {
    const ks = k.split('__').pop().toLowerCase();
    let d;
    if (ks === short) d = 0;
    else if (k.toLowerCase().includes(short) || String(name).toLowerCase().includes(ks)) d = 1;
    else d = 1 + editDistance(String(name).toLowerCase(), k.toLowerCase());
    if (d <= Math.max(3, Math.floor(String(name).length / 3))) scored.push({ k, d });
  }
  scored.sort((a, b) => a.d - b.d);
  return scored.slice(0, 3).map((s) => s.k);
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

function createPacks({ dashboardPort } = {}) {
  const port = dashboardPort || process.env.DASHBOARD_PORT || '3457';
  const server = (s) => ({
    type: 'http',
    url: `http://127.0.0.1:${port}${s.url}`,
    headers: { Authorization: `Bearer ${s.token}` },
  });

  const catalog = {
    id: CATALOG_PACK,
    description: 'App tools: search, describe and call them; grant workers a fixed list',
    roles: ['orchestrator'],
    default: true,
    build({ settings, instanceId, role, cwd }) {
      if (role !== 'orchestrator') return null;
      const s = broker.createHolderSession({ holder: holderOf(settings, instanceId, cwd), mode: 'catalog' });
      return { mcpServers: { 'app-tools': server(s) }, appendSystemPrompt: CATALOG_PROMPT };
    },
    release({ instanceId }) { broker.revokeHolder({ instanceId, mode: 'catalog' }); },
  };

  const grant = {
    id: GRANT_PACK,
    description: 'App tools a worker\'s orchestrator granted it at launch, and nothing else',
    roles: ['worker'],
    default: true,
    consumes: ['tools'],
    validate({ settings }) {
      const names = grantedNames(settings);
      const bad = names.filter((n) => typeof n !== 'string' || !n);
      if (bad.length) throw new Error('tools: every entry must be a tool name (<app>__<tool>)');
      const known = broker.knownToolNames();
      const unknown = names.filter((n) => !known.includes(n));
      if (!unknown.length) return;
      const parts = unknown.map((n) => {
        const near = closeMatches(n, known);
        return near.length ? `${n} (did you mean ${near.join(', ')}?)` : n;
      });
      throw new Error(`Unknown app tool(s): ${parts.join('; ')}. Find names with tools_search.`);
    },
    build({ settings, instanceId, role, cwd }) {
      // Default for every worker (core accepts `tools` only when a pack that
      // applies consumes it); no grant contributes nothing.
      if (role !== 'worker') return {};
      const names = [...new Set(grantedNames(settings))];
      if (!names.length) return {};
      // A granted tool whose app stopped since validate is named in the
      // prompt, not served; the rest of the grant still holds.
      const held = names.map((n) => broker.catalogEntry(n)).filter(Boolean);
      const missing = names.filter((n) => !held.some((t) => t.name === n));
      const s = broker.createHolderSession({ holder: holderOf(settings, instanceId, cwd), mode: 'grant', tools: held.map((t) => t.name) });
      return { mcpServers: { apps: server(s) }, appendSystemPrompt: grantPrompt(held, missing) };
    },
    // Core releases a spawn before the next one builds (reason 'respawn'), so
    // revoking by instanceId never reaches the successor's session.
    release({ instanceId }) { broker.revokeHolder({ instanceId, mode: 'grant' }); },
  };

  return { catalog, grant };
}

// A holder runs while core's session manager has a running session with its
// instanceId (CLI tabs and Agent SDK sessions alike). No manager: unknown.
function livenessFrom(cliSessionManager) {
  return (holder) => {
    const all = cliSessionManager && cliSessionManager.sessions;
    if (!all || typeof all.values !== 'function') return undefined;
    for (const s of all.values()) {
      if (s && s.instanceId === holder.instanceId) return !!s.running;
    }
    return false;
  };
}

let registered = [];
let warned = false;

// Feature-probed against the core ctx: the catalog pack needs registerToolPack;
// the grant pack also needs the pack fields core lists in toolPackFeatures
// (consumes / validate / release) — without them an older core would launch
// a worker on a grant it never validates or releases, so it is not offered.
function register(ctx = {}) {
  unregister();
  if (typeof ctx.registerToolPack !== 'function') {
    if (!warned) { warned = true; console.warn('[app-tools] core has no tool packs — orchestration runs get no app tools (update core)'); }
    return [];
  }
  const { catalog, grant } = createPacks({ dashboardPort: ctx.dashboardPort });
  const features = Array.isArray(ctx.toolPackFeatures) ? ctx.toolPackFeatures : [];
  const packs = [catalog];
  if (GRANT_FEATURES.every((f) => features.includes(f))) packs.push(grant);
  else if (!warned) { warned = true; console.warn(`[app-tools] core lacks tool-pack ${GRANT_FEATURES.join('/')} — workers cannot be granted app tools (update core)`); }
  for (const p of packs) {
    try {
      const off = ctx.registerToolPack(p);
      registered.push(typeof off === 'function' ? off : () => ctx.unregisterToolPack?.(p.id));
    } catch (e) {
      console.warn(`[app-tools] tool pack "${p.id}" not registered:`, e.message);
    }
  }
  broker.setHolderLiveness(livenessFrom(ctx.cliSessionManager));
  return packs.map((p) => p.id);
}

function unregister() {
  for (const off of registered) { try { off(); } catch {} }
  registered = [];
}

module.exports = { register, unregister, createPacks, livenessFrom, closeMatches, holderOf, CATALOG_PACK, GRANT_PACK };
