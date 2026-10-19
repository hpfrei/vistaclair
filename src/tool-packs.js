// Tool packs — the seam through which an add-on adds MCP servers, tool
// restrictions and prompt text to dashboard sessions (CLI tabs and Agent SDK
// sessions alike).
//
// A pack:
//   {
//     id,            // unique, [A-Za-z0-9._-]; what settings.toolPacks names
//     description,   // one line, for listings
//     roles,         // subset of ROLES; a session outside them never gets the pack
//                    // (omitted = every role)
//     default,       // true: attached to every session of a matching role;
//                    // otherwise only to one whose settings.toolPacks lists the id
//     build({ settings, instanceId, role, cwd, sessId })
//       -> { mcpServers?, disallowedTools?, appendSystemPrompt? }   // synchronous
//     consumes,      // optional; the settings.grants kinds the pack handles:
//                    // ['tools'] = it reads settings.grants.tools
//     validate({ settings, role })   // optional, synchronous; throws to refuse
//     release({ settings, instanceId, role, sessId, reason })   // optional
//   }
//
// A session's role is its orchestration role ('orchestrator' | 'worker') or
// 'plain' when it is not a run member. build runs once per spawn (a resume
// too). A build that throws, returns a promise or returns a malformed field
// is logged and that pack (or field) is skipped: a pack never breaks a launch.
//
// Grants: an orchestrator hands a worker a fixed list of add-on tools at
// launch (launch_cli / resume_worker `tools`), stored as settings.grants =
// { tools: [...] } on the worker and kept across resume, pause and restart.
// Core never reads the names. The `tools` parameter exists only while a
// registered pack consumes 'tools' (consumedGrants()); a value no applying
// pack consumes is refused (src/orchestration.js).
//
// validate runs for every applying pack before an orchestration launch path
// spawns a worker (launch_cli, resume_worker, a "+" menu worker resume): a
// throw refuses the launch with its message, unlike build. release runs once
// when a session a pack's build contributed to ends (process exit,
// close_worker, pause, tab close, respawn, shutdown), with a short `reason`;
// its errors are logged, never thrown. A pack re-mints in its next build.
//
// The add-on ctx (dashboard profile) names the optional fields this core
// honours in ctx.toolPackFeatures (TOOL_PACK_FEATURES), for feature probing.
//
// toolPackContributions() is the one call the option builders make
// (src/cli-session.js, src/sdk-session.js); it returns the merged
// contributions of every pack that applies. Its disallowedTools join the
// role's list in utils.disallowedToolsFor, for both engines. With no pack registered it
// returns empty contributions, and every session is configured exactly as
// without this module.
//
// Add-ons register packs through their descriptor's `toolPacks` field
// (src/addons.js — removed with the add-on) or ctx.registerToolPack
// (src/addon-host.js, dashboard profile — the add-on unregisters on shutdown).

const ROLES = ['orchestrator', 'worker', 'plain'];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// The settings.grants kinds a pack may consume.
const GRANT_KINDS = ['tools'];
// The optional pack fields this core honours (ctx.toolPackFeatures).
const TOOL_PACK_FEATURES = Object.freeze(['consumes', 'validate', 'release']);

// id -> { id, description, roles, default, build, consumes, validate, release, owner }, in registration order.
const packs = new Map();

// A spawn's contributions -> what its release needs: the packs whose build
// contributed and the build context. Dropped once released.
const spawns = new WeakMap();

function roleOf(settings) {
  const role = settings?.orchestration?.role;
  return role === 'orchestrator' || role === 'worker' ? role : 'plain';
}

// Registers (or, for the same owner, replaces) a pack. Returns its unregister
// function. Throws on a malformed pack or an id another owner holds.
function registerToolPack(pack, { owner = null } = {}) {
  if (!pack || typeof pack !== 'object') throw new Error('tool pack must be an object');
  const { id, build } = pack;
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`tool pack id ${JSON.stringify(id)} is invalid`);
  if (typeof build !== 'function') throw new Error(`tool pack "${id}": build must be a function`);
  let roles = pack.roles == null ? [...ROLES] : pack.roles;
  if (!Array.isArray(roles) || roles.length === 0 || roles.some(r => !ROLES.includes(r))) {
    throw new Error(`tool pack "${id}": roles must be a non-empty subset of ${ROLES.join(', ')}`);
  }
  roles = [...new Set(roles)];
  const consumes = pack.consumes == null ? [] : pack.consumes;
  if (!Array.isArray(consumes) || consumes.some(k => !GRANT_KINDS.includes(k))) {
    throw new Error(`tool pack "${id}": consumes must be an array of ${GRANT_KINDS.join(', ')}`);
  }
  for (const f of ['validate', 'release']) {
    if (pack[f] != null && typeof pack[f] !== 'function') throw new Error(`tool pack "${id}": ${f} must be a function`);
  }
  const existing = packs.get(id);
  if (existing && existing.owner !== owner) throw new Error(`tool pack "${id}" is already registered`);
  const entry = {
    id,
    description: typeof pack.description === 'string' ? pack.description : '',
    roles,
    default: pack.default === true,
    build,
    consumes: [...new Set(consumes)],
    validate: pack.validate || null,
    release: pack.release || null,
    owner,
  };
  if (existing) packs.delete(id);
  packs.set(id, entry);
  return () => { if (packs.get(id) === entry) packs.delete(id); };
}

function unregisterToolPack(id) {
  return packs.delete(id);
}

// Drops every pack an owner registered (an add-on's id, on removal).
function unregisterToolPacksOf(owner) {
  for (const [id, p] of packs) if (p.owner === owner) packs.delete(id);
}

function listToolPacks() {
  return [...packs.values()].map(p => ({ id: p.id, description: p.description, roles: [...p.roles], default: p.default }));
}

// The packs a session gets: those of its role that are default or that its
// settings.toolPacks opts into. Unknown ids in settings.toolPacks are ignored.
function packsFor(settings) {
  const role = roleOf(settings);
  const optIn = Array.isArray(settings?.toolPacks) ? settings.toolPacks.filter(x => typeof x === 'string') : [];
  return [...packs.values()].filter(p => p.roles.includes(role) && (p.default || optIn.includes(p.id)));
}

// The grant kinds some registered pack consumes (any role): what the
// orchestrator MCP offers as launch parameters.
function consumedGrants() {
  const kinds = new Set();
  for (const p of packs.values()) for (const k of p.consumes) kinds.add(k);
  return GRANT_KINDS.filter(k => kinds.has(k));
}

// Whether a pack that applies to these settings consumes the grant kind.
function grantConsumed(settings, kind) {
  return packsFor(settings).some(p => p.consumes.includes(kind));
}

// Every applying pack's validate, before a spawn. Throws the first refusal.
function validateToolPacks({ settings = {} } = {}) {
  const role = roleOf(settings);
  for (const p of packsFor(settings)) {
    if (!p.validate) continue;
    const r = p.validate({ settings: { ...settings }, role });
    if (r && typeof r.then === 'function') {
      r.catch?.(() => {});
      throw new Error(`tool pack "${p.id}": validate returned a promise (it must be synchronous)`);
    }
  }
}

// Ends a spawn's packs: each contributing pack's release, once. Best effort.
function releaseToolPacks(contributions, reason = 'exit') {
  const rec = contributions && spawns.get(contributions);
  if (!rec) return;
  spawns.delete(contributions);
  const { built, ctx } = rec;
  for (const p of built) {
    if (!p.release) continue;
    try {
      const r = p.release({ ...ctx, settings: { ...ctx.settings }, reason: String(reason) });
      r?.catch?.((e) => console.error(`  Tool pack "${p.id}": release failed:`, e?.message || e));
    } catch (e) {
      console.error(`  Tool pack "${p.id}": release failed:`, e?.message || e);
    }
  }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Every applying pack's build, merged: MCP servers (the first pack to name a
// server keeps it), disallowed tools (deduplicated, in order) and prompt
// texts (joined by a blank line). `packs` lists the ids that contributed.
function toolPackContributions({ settings = {}, instanceId, cwd, sessId } = {}) {
  const out = { packs: [], mcpServers: {}, disallowedTools: [], appendSystemPrompt: '' };
  const selected = packsFor(settings);
  if (!selected.length) return out;
  const role = roleOf(settings);
  const prompts = [];
  const built = [];
  for (const p of selected) {
    let r;
    try {
      r = p.build({ settings: { ...settings }, instanceId, role, cwd, sessId });
      if (r && typeof r.then === 'function') {
        r.catch?.(() => {});
        throw new Error('build returned a promise (it must be synchronous)');
      }
    } catch (e) {
      console.error(`  Tool pack "${p.id}": build failed, skipped:`, e?.message || e);
      continue;
    }
    if (r == null) { out.packs.push(p.id); built.push(p); continue; }
    if (!isPlainObject(r)) {
      console.error(`  Tool pack "${p.id}": build returned no object, skipped`);
      continue;
    }
    out.packs.push(p.id);
    built.push(p);
    if (r.mcpServers != null) {
      if (!isPlainObject(r.mcpServers)) console.error(`  Tool pack "${p.id}": mcpServers is not an object, ignored`);
      else for (const [name, cfg] of Object.entries(r.mcpServers)) {
        if (!name || !isPlainObject(cfg)) { console.error(`  Tool pack "${p.id}": MCP server "${name}" is malformed, ignored`); continue; }
        if (Object.hasOwn(out.mcpServers, name)) { console.error(`  Tool pack "${p.id}": MCP server "${name}" is already supplied by another pack, ignored`); continue; }
        out.mcpServers[name] = cfg;
      }
    }
    if (r.disallowedTools != null) {
      if (!Array.isArray(r.disallowedTools)) console.error(`  Tool pack "${p.id}": disallowedTools is not an array, ignored`);
      else for (const t of r.disallowedTools) {
        if (typeof t === 'string' && t && !out.disallowedTools.includes(t)) out.disallowedTools.push(t);
      }
    }
    if (r.appendSystemPrompt != null) {
      if (typeof r.appendSystemPrompt !== 'string') console.error(`  Tool pack "${p.id}": appendSystemPrompt is not a string, ignored`);
      else if (r.appendSystemPrompt.trim()) prompts.push(r.appendSystemPrompt);
    }
  }
  out.appendSystemPrompt = prompts.join('\n\n');
  if (built.some(p => p.release)) spawns.set(out, { built, ctx: { settings: { ...settings }, instanceId, role, sessId } });
  return out;
}

// Core's server names win over a pack's: the pack's entry is dropped and logged.
function mergeMcpServers(core, packServers = {}) {
  const merged = { ...core };
  for (const [name, cfg] of Object.entries(packServers)) {
    if (Object.hasOwn(merged, name)) { console.error(`  Tool pack MCP server "${name}" collides with a core server, ignored`); continue; }
    merged[name] = cfg;
  }
  return merged;
}

module.exports = {
  ROLES,
  GRANT_KINDS,
  TOOL_PACK_FEATURES,
  roleOf,
  registerToolPack,
  unregisterToolPack,
  unregisterToolPacksOf,
  listToolPacks,
  toolPackContributions,
  consumedGrants,
  grantConsumed,
  validateToolPacks,
  releaseToolPacks,
  mergeMcpServers,
};
