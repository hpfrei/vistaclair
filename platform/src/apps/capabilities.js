// Capability registry — the ONE place a platform capability is described, and
// since the module split the ONE place it is IMPLEMENTED for both app surfaces.
//
// Every capability is a module under src/apps/capabilities/<key>.js exporting:
//
//   key, title, headings?, core, gated, external?, methods, prefixes?,
//   impliedBy?, aliases?, runtime?, ctx?, keywords?, summary, migration?
//                                  — the metadata (unchanged vocabulary):
//     key         manifest capability key AND API-reference section key
//     title       human name; must match a heading in _api-reference.md
//     headings    for a capability documented across several sections, the
//                 headings it expects (checked instead of `title`)
//     external    true => dispatched outside the bridge (cli.* lives in index.js)
//     core        platform-baseline flag (a capability every app profile has
//                 from the start). It has NO prompt meaning: every section is
//                 deferred to `.vistaclair/api/<key>.md` and inlined only on a
//                 keyword hit against the request — see sectionsToInline
//     gated       historical "must be declared" flag, now advertisement-worthiness:
//                 nothing is blocked at runtime any more (open-world interior —
//                 every app gets the full platform surface for its profile), but
//                 infer/advertise and the docs still use it to tell substantive
//                 capabilities from cosmetic/app-local surfaces
//     methods     exact bridge method names in this capability
//     prefixes    method prefixes that also belong to it (future methods)
//     impliedBy   other capability keys whose advertisement covers this one
//                 (`ai` is a superset of audio/maps/web-search/embeddings/music)
//     aliases     accepted manifest synonyms, kept so existing manifests keep working
//     runtime     window.* globals app-runtime.js exposes for it
//     ctx         the routes.js `ctx.*` member names this module produces
//     keywords    matched against the user's request to inline the section
//     summary     one line for the section index and the capability brief
//     migration   "if the app hand-rolls X, move to Y" line for the change prompt
//
//   flags        { '<key>.<name>': () => boolean } — feature flags reported by
//                capabilities.has/list beside the module's key, while the
//                module is visible and not revoked and the predicate is true
//                (`fleet.sync`: the fleet data engine is loaded)
//
//   visibility   { standalone: true|false|'partial' } — whether the ctx members
//                exist in an own-process (standalone) app (default: yes). false
//                drops the whole module from that profile; 'partial' lets
//                buildCtx(app) decide per member (it sees app.profile).
//   revocable    true for a module the admin may revoke per app through the
//                spend policy's `grants` (owner services and metered calls).
//                A revoked module is structurally absent from the app's ctx and
//                refused on the Bridge; modules an app needs to boot (db,
//                settings, state, identity, …) are never revocable.
//   buildCtx(app) returns an object whose own keys are exactly `ctx` (a subset
//                only under 'partial'). Getters are preserved. `app` is
//                { name, dir, manifest, broadcaster, profile, caps, legacy,
//                  resolvePath, ctx } — `app.ctx` is the object being filled.
//   bridge       { '<method>': async (app, params, io) => result } — thrown or
//                rejected errors become { error: message } on the wire; `io` is
//                { emitEvent(event, data), method } (one function may serve
//                several method keys and switch on io.method).
//
// Load-time validation refuses to boot on a malformed module, a method claimed
// twice, or a directory that disagrees with ORDER — a drift is a startup error,
// not a runtime surprise. `npm run check:capabilities` adds the cross-file
// invariants (docs markers/headings, runtime globals, ctx parity per profile)
// and `npm test` the behavioural ones.

const fs = require('fs');
const path = require('path');
const { safeJoin } = require('../utils');

// Prompt/section order is load-bearing (the API reference index and the build
// prompt's capability brief follow it), so it is explicit rather than
// alphabetical. Platform baseline first, then the rest.
const ORDER = [
  'fs', 'exec', 'cron', 'jobs', 'ai', 'cli', 'db', 'state', 'settings', 'secrets', 'files', 'http', 'notify',
  'dialogs', 'tasks', 'events', 'ui', 'tools', 'artifacts', 'identity', 'capabilities',
  'audio', 'music', 'maps', 'web-search', 'embeddings', 'memory', 'google', 'email', 'calendar', 'todos',
  'browser', 'telegram', 'whatsapp', 'apps', 'sites', 'analytics', 'licensing', 'platform-cron', 'sysmon', 'print', 'governance', 'spend', 'fleet', 'config',
];

// Members the loader itself owns on every ctx (not produced by any module):
// plain identity/path strings, not privileges. dataDir is the conventional
// per-app data folder; the gated `fs` capability is the bridge's file access.
const LOADER_CTX_MEMBERS = ['appName', 'appDir', 'dataDir', 'basePath'];
const PROFILES = ['host', 'dashboard', 'standalone'];
const VISIBILITY_VALUES = new Set([true, false, 'partial']);

// The Horst facet — what a capability contributes to the platform's resident
// agent: senses (bus kinds it publishes, wired to service hooks), platform
// tools (registered under the __platform__ pseudo-app: read-only, or serving a
// direct-lane member), governance action kinds (proposal-gated) and the lane
// of every member (direct / card / never). Mirrors horst-events POLICIES / KIND_RE and
// horst-governance LEVELS / KIND_RE; those modules stay dependency-light, so
// the vocabulary is repeated here and cross-checked by capabilities-check.
const HORST_POLICIES = new Set(['ignore', 'agenda', 'notify', 'run-action']);
const HORST_LEVELS = new Set(['observe', 'propose', 'auto+notify', 'auto']);
const SENSE_KIND_RE = /^[a-z0-9][a-z0-9._:-]{0,80}$/i;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;
const ACTION_KIND_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const EMPTY_FACET = Object.freeze({ brief: null, senses: Object.freeze([]), wire: null, tools: Object.freeze([]), kinds: Object.freeze({}), lane: null });
const LANES = ['direct', 'card', 'never'];

// The Horst lane of every member (docs/horst-lanes.md): `direct` — Horst calls
// it at once through a facet tool (spend limits apply); `card` — only through a
// governance kind; `never` — app-scoped or forbidden. Shape:
//   { default?, why?, direct: { member: tool | [tools] | { deferred } },
//     card: { member: kind | [kinds] | { missing } }, never: [members] }
// Normalised here; coverage (every member classified, tools and kinds real)
// is laneProblems(), run by capabilities-check.
function validateLane(l, file) {
  if (l == null) return null;
  if (typeof l !== 'object' || Array.isArray(l)) fail(file, '"horst.lane" must be an object');
  if (l.default != null && !LANES.includes(l.default)) fail(file, `horst.lane.default must be one of ${LANES.join(', ')}`);
  if (l.why != null && typeof l.why !== 'string') fail(file, 'horst.lane.why must be a string');
  const seen = new Set();
  const claim = (m) => {
    if (seen.has(m)) fail(file, `horst.lane classifies "${m}" twice`);
    seen.add(m);
  };
  const targets = (lane, field, gap) => {
    const out = {};
    const src = l[lane] == null ? {} : l[lane];
    if (typeof src !== 'object' || Array.isArray(src)) fail(file, `horst.lane.${lane} must be an object of member → ${field}`);
    for (const [m, v] of Object.entries(src)) {
      claim(m);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if (typeof v[gap] !== 'string' || !v[gap]) fail(file, `horst.lane.${lane}["${m}"] must name a ${field} or carry a { ${gap}: reason }`);
        out[m] = Object.freeze({ [gap]: v[gap] });
        continue;
      }
      const list = Array.isArray(v) ? v : [v];
      if (!list.length || list.some((x) => typeof x !== 'string' || !x)) fail(file, `horst.lane.${lane}["${m}"] must name a ${field} or carry a { ${gap}: reason }`);
      out[m] = Object.freeze({ [field + 's']: Object.freeze(list.slice()) });
    }
    return Object.freeze(out);
  };
  const direct = targets('direct', 'tool', 'deferred');
  const card = targets('card', 'kind', 'missing');
  const never = l.never == null ? [] : l.never;
  if (!Array.isArray(never)) fail(file, 'horst.lane.never must be an array of members');
  for (const m of never) claim(m);
  return Object.freeze({ default: l.default || null, why: l.why || null, direct, card, never: Object.freeze(never.slice()) });
}

function validateFacet(h, file) {
  if (h == null) return EMPTY_FACET;
  if (typeof h !== 'object' || Array.isArray(h)) fail(file, '"horst" must be an object');
  if (h.brief != null && (typeof h.brief !== 'string' || !h.brief)) fail(file, '"horst.brief" must be a non-empty string');
  const senses = h.senses == null ? [] : h.senses;
  if (!Array.isArray(senses)) fail(file, '"horst.senses" must be an array');
  const seenKinds = new Set();
  for (const s of senses) {
    if (!s || typeof s.kind !== 'string' || !SENSE_KIND_RE.test(s.kind)) fail(file, `horst sense kind "${s && s.kind}" is invalid`);
    if (typeof s.description !== 'string' || !s.description) fail(file, `horst sense "${s.kind}" needs a description`);
    if (!HORST_POLICIES.has(s.defaultPolicy)) fail(file, `horst sense "${s.kind}" has an invalid defaultPolicy "${s.defaultPolicy}"`);
    if (seenKinds.has(s.kind)) fail(file, `horst sense "${s.kind}" is declared twice`);
    seenKinds.add(s.kind);
  }
  if (senses.length && typeof h.wire !== 'function') fail(file, '"horst.senses" declared but there is no horst.wire({ publish })');
  if (!senses.length && typeof h.wire === 'function') fail(file, 'horst.wire present but "horst.senses" declares nothing');
  const tools = h.tools == null ? [] : h.tools;
  if (!Array.isArray(tools)) fail(file, '"horst.tools" must be an array');
  for (const t of tools) {
    const d = t && t.def;
    if (!d || typeof d.name !== 'string' || !TOOL_NAME_RE.test(d.name)) fail(file, `horst tool name "${d && d.name}" is invalid (${TOOL_NAME_RE})`);
    if (typeof d.description !== 'string' || !d.description) fail(file, `horst tool "${d.name}" needs a description`);
    if (d.inputSchema != null && (typeof d.inputSchema !== 'object' || Array.isArray(d.inputSchema))) fail(file, `horst tool "${d.name}" inputSchema must be an object`);
    if (d.expose != null && d.expose !== 'platform') fail(file, `horst tool "${d.name}" expose must be 'platform' (or omitted)`);
    if (typeof t.handler !== 'function') fail(file, `horst tool "${d.name}" needs a handler(args, caller)`);
  }
  const kinds = h.kinds == null ? {} : h.kinds;
  if (typeof kinds !== 'object' || Array.isArray(kinds)) fail(file, '"horst.kinds" must be an object of kind definitions');
  for (const [k, d] of Object.entries(kinds)) {
    if (!ACTION_KIND_RE.test(k)) fail(file, `horst kind "${k}" is invalid (${ACTION_KIND_RE})`);
    if (!d || typeof d !== 'object') fail(file, `horst kind "${k}" must be an object`);
    if (typeof d.label !== 'string' || !d.label) fail(file, `horst kind "${k}" needs a label`);
    if (!HORST_LEVELS.has(d.ceiling)) fail(file, `horst kind "${k}" has an invalid ceiling "${d.ceiling}"`);
    if (!HORST_LEVELS.has(d.defaultLevel)) fail(file, `horst kind "${k}" has an invalid defaultLevel "${d.defaultLevel}"`);
    if ([...HORST_LEVELS].indexOf(d.defaultLevel) > [...HORST_LEVELS].indexOf(d.ceiling)) fail(file, `horst kind "${k}" defaultLevel exceeds its ceiling`);
    for (const f of ['validate', 'describe', 'execute']) if (typeof d[f] !== 'function') fail(file, `horst kind "${k}" needs a ${f} function`);
    if (d.notify != null && !['tg', 'none'].includes(d.notify)) fail(file, `horst kind "${k}" notify must be 'tg' or 'none'`);
    // card(payload, proposal) → the ONE card descriptor (horst-cards.js), which
    // every surface renders. Optional: a kind that declares none gets the family
    // or generic projector, never raw JSON. Supersedes tgCard.
    if (d.card != null && typeof d.card !== 'function') fail(file, `horst kind "${k}" card must be a function or null`);
    // approveFrom(proposal, via) → null, or why an approval from that surface
    // may not stand (governance.decide refuses it).
    if (d.approveFrom != null && typeof d.approveFrom !== 'function') fail(file, `horst kind "${k}" approveFrom must be a function or null`);
    // compose(payload) → payload with derived fields recomputed from their
    // sources. Applied at every governance freeze point, before validate, so a
    // payload can never be frozen with a rendered form that disagrees with the
    // inputs it claims to derive from.
    if (d.compose != null && typeof d.compose !== 'function') fail(file, `horst kind "${k}" compose must be a function or null`);
    // identity(payload, meta) → a stable act key, or null when this kind cannot
    // be identified from its payload. An explicit `null` is the "no dedupe"
    // declaration; the key must be PRESENT either way (capabilities-check #20),
    // so adding a kind is a conscious decision about duplicate suppression.
    if (d.identity != null && typeof d.identity !== 'function') fail(file, `horst kind "${k}" identity must be a function or null`);
    // Reversibility, declared rather than assumed. A kind whose DEFAULT dial is
    // autonomous runs without anyone reading it first, so the only acceptable
    // mistakes are ones the world can absorb: `undo` (the act can be reversed)
    // or `idempotent` (repeating it converges on the same state). Booleans, not
    // functions — this is a claim about the act, not a mechanism.
    // capabilities-check #21 enforces it; nothing here forces a kind that stays
    // at propose to answer the question.
    for (const f of ['undo', 'idempotent']) {
      if (d[f] != null && typeof d[f] !== 'boolean') fail(file, `horst kind "${k}" ${f} must be a boolean`);
    }
    // appProposable: true opens the kind to apps (ctx.governance.propose /
    // update); absent, the kind is platform-owned and governance refuses an
    // app that stages or edits it.
    if (d.appProposable != null && typeof d.appProposable !== 'boolean') fail(file, `horst kind "${k}" appProposable must be a boolean`);
  }
  return Object.freeze({
    brief: h.brief || null,
    senses: Object.freeze(senses.map((s) => Object.freeze({ kind: s.kind, description: s.description, defaultPolicy: s.defaultPolicy }))),
    wire: typeof h.wire === 'function' ? h.wire : null,
    tools: Object.freeze(tools.map((t) => Object.freeze({ def: Object.freeze({ expose: 'platform', ...t.def }), handler: t.handler }))),
    kinds: Object.freeze(kinds),
    lane: validateLane(h.lane, file),
  });
}

const DIR = process.env.VISTACLAIR_CAPABILITIES_DIR || path.join(__dirname, 'capabilities');
const COST_VALUES = new Set(['free', 'metered', 'external']);
const AUDIENCE_VALUES = new Set(['owner', 'user', 'anonymous']);

function fail(file, msg) { throw new Error(`capabilities/${file}.js: ${msg}`); }

function validateModule(m, file) {
  if (!m || typeof m !== 'object') fail(file, 'must export an object');
  if (m.key !== file) fail(file, `key "${m.key}" must equal the file name`);
  for (const f of ['title', 'summary']) if (typeof m[f] !== 'string' || !m[f]) fail(file, `"${f}" must be a non-empty string`);
  for (const f of ['core', 'gated']) if (typeof m[f] !== 'boolean') fail(file, `"${f}" must be a boolean`);
  for (const f of ['methods', 'prefixes', 'ctx', 'aliases', 'impliedBy', 'runtime', 'headings']) {
    if (m[f] != null && !Array.isArray(m[f])) fail(file, `"${f}" must be an array`);
  }
  if (m.keywords != null && !(m.keywords instanceof RegExp)) fail(file, '"keywords" must be a RegExp');
  if (m.migration != null && typeof m.migration !== 'string') fail(file, '"migration" must be a string');
  if (m.bridge != null && (typeof m.bridge !== 'object' || Array.isArray(m.bridge))) fail(file, '"bridge" must be an object of handlers');
  for (const [k, fn] of Object.entries(m.bridge || {})) if (typeof fn !== 'function') fail(file, `bridge handler "${k}" must be a function`);
  if (m.external && m.bridge) fail(file, 'an external capability cannot also carry bridge handlers');
  const ctxNames = m.ctx || [];
  if (ctxNames.length && typeof m.buildCtx !== 'function') fail(file, '"ctx" names members but there is no buildCtx(app)');
  if (!ctxNames.length && typeof m.buildCtx === 'function') fail(file, 'buildCtx(app) present but "ctx" names no members');
  for (const n of ctxNames) if (LOADER_CTX_MEMBERS.includes(n)) fail(file, `ctx member "${n}" is loader-owned`);
  // Spend metadata: what a call costs the owner and who may ever trigger it.
  //   cost       'free' (default) | 'metered' (platform-paid, ledgered + gated)
  //              | 'external' (the app's own keys/services — unpriceable here)
  //   audiences  subset of owner / user / anonymous (default ['owner'])
  //   spend      metered modules only: { service, units: { method: unit } } —
  //              the service module that calls spendGate.authorize/wrap and
  //              the unit each method is billed in (checked by capabilities-check)
  if (m.cost != null && !COST_VALUES.has(m.cost)) fail(file, `"cost" must be one of ${[...COST_VALUES].join(', ')}`);
  if (m.audiences != null) {
    if (!Array.isArray(m.audiences) || !m.audiences.length) fail(file, '"audiences" must be a non-empty array');
    for (const a of m.audiences) if (!AUDIENCE_VALUES.has(a)) fail(file, `unknown audience "${a}"`);
  }
  if (m.spend != null && (typeof m.spend !== 'object' || typeof m.spend.service !== 'string' || typeof m.spend.units !== 'object')) {
    fail(file, '"spend" must be { service: string, units: { method: unit } }');
  }
  const visibility = { standalone: true, ...(m.visibility || {}) };
  if ('public' in visibility) fail(file, 'visibility.public is gone — the public ctx profile was replaced by admin grants (declare `revocable: true` instead)');
  for (const p of ['standalone']) {
    if (!VISIBILITY_VALUES.has(visibility[p])) fail(file, `visibility.${p} must be true, false or 'partial'`);
  }
  if (m.revocable != null && typeof m.revocable !== 'boolean') fail(file, '"revocable" must be a boolean');
  if (m.flags != null && (typeof m.flags !== 'object' || Array.isArray(m.flags))) fail(file, '"flags" must be an object of predicates');
  for (const [f, fn] of Object.entries(m.flags || {})) {
    if (!f.startsWith(`${m.key}.`) || !/^[a-z0-9-]+(\.[a-z0-9-]+){1,2}$/.test(f)) fail(file, `flag "${f}" must be "${m.key}.<name>" or "${m.key}.<name>.<sub>"`);
    if (typeof fn !== 'function') fail(file, `flag "${f}" must be a predicate function`);
  }
  return Object.freeze({
    ...m,
    methods: m.methods || [],
    prefixes: m.prefixes || [],
    ctx: ctxNames,
    visibility: Object.freeze(visibility),
    flags: Object.freeze({ ...(m.flags || {}) }),
    revocable: m.revocable === true,
    cost: m.cost || 'free',
    audiences: Object.freeze((m.audiences || ['owner']).slice()),
    spend: m.spend ? Object.freeze({ service: m.spend.service, units: Object.freeze({ ...m.spend.units }) }) : null,
    horst: validateFacet(m.horst, file),
  });
}

function loadAll() {
  let files;
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort(); }
  catch (err) { throw new Error(`capabilities directory unreadable (${DIR}): ${err.message}`); }
  const ordered = ORDER.slice().sort();
  if (JSON.stringify(files) !== JSON.stringify(ordered)) {
    const missing = ORDER.filter((k) => !files.includes(k));
    const extra = files.filter((k) => !ORDER.includes(k));
    throw new Error(`capabilities/ directory disagrees with ORDER in capabilities.js` +
      (missing.length ? ` — missing: ${missing.join(', ')}` : '') +
      (extra.length ? ` — not in ORDER: ${extra.join(', ')}` : ''));
  }
  return ORDER.map((key) => validateModule(require(path.join(DIR, key + '.js')), key));
}

const CAPABILITIES = loadAll();

// ---- indexes ----------------------------------------------------------------

const byKey = new Map(CAPABILITIES.map((c) => [c.key, c]));

// Horst facet indexes — a sense kind, tool name or action kind may belong to
// exactly one capability (boot-time, same class of error as a duplicate method).
const senseOwner = new Map();
const toolOwner = new Map();
const kindOwner = new Map();
for (const c of CAPABILITIES) {
  for (const s of c.horst.senses) {
    if (senseOwner.has(s.kind)) throw new Error(`capabilities/${c.key}.js: horst sense "${s.kind}" is already declared by "${senseOwner.get(s.kind)}"`);
    senseOwner.set(s.kind, c.key);
  }
  for (const t of c.horst.tools) {
    if (toolOwner.has(t.def.name)) throw new Error(`capabilities/${c.key}.js: horst tool "${t.def.name}" is already declared by "${toolOwner.get(t.def.name)}"`);
    toolOwner.set(t.def.name, c.key);
  }
  for (const k of Object.keys(c.horst.kinds)) {
    if (kindOwner.has(k)) throw new Error(`capabilities/${c.key}.js: horst kind "${k}" is already declared by "${kindOwner.get(k)}"`);
    kindOwner.set(k, c.key);
  }
}

// ---- Horst facet queries ----------------------------------------------------

// Bus kinds contributed by capability modules, in registry order.
function horstSenses() {
  return CAPABILITIES.flatMap((c) => c.horst.senses.map((s) => ({ key: s.kind, description: s.description, defaultPolicy: s.defaultPolicy, capability: c.key })));
}

// Platform tools for the __platform__ pack (read-only or direct-lane), in registry order.
function horstTools() {
  return CAPABILITIES.flatMap((c) => c.horst.tools.map((t) => ({ def: t.def, handler: t.handler, capability: c.key })));
}

// Governance action kinds keyed by kind name; each def carries its capability.
function horstKinds() {
  const out = {};
  for (const c of CAPABILITIES) {
    for (const [k, d] of Object.entries(c.horst.kinds)) out[k] = { ...d, capability: c.key };
  }
  return out;
}

// One line per capability that has something to say about the platform itself;
// buildSystemPrompt injects them under PLATFORM CAPABILITIES in Horst's chat.
function horstBriefs() {
  return CAPABILITIES.filter((c) => c.horst.brief).map((c) => c.horst.brief);
}

// The members a lane classifies: the module's bridge methods, or its ctx
// members when it has no methods (files, identity, tools, licensing).
function laneMembers(cap) {
  return cap.methods.length ? cap.methods.slice() : cap.ctx.slice();
}

// member → { lane, tools? | deferred? | kinds? | missing? }, the default
// filling what the module does not list. Null when the module has no stance.
function laneOf(cap) {
  const l = cap.horst.lane;
  if (!l) return null;
  const out = {};
  for (const [m, t] of Object.entries(l.direct)) out[m] = { lane: 'direct', ...t };
  for (const [m, t] of Object.entries(l.card)) out[m] = { lane: 'card', ...t };
  for (const m of l.never) out[m] = { lane: 'never' };
  for (const m of laneMembers(cap)) if (!out[m] && l.default) out[m] = { lane: l.default };
  return out;
}

// What keeps a lane honest. `kindNames` is every registered kind (the
// capability kinds plus governance's own) and `toolNames` every tool of
// Horst's pack (the facet tools plus the brain pull tools); the caller passes
// them so this module never requires governance or the agent. → [message]
function laneProblems(cap, {
  kindNames = new Set(Object.keys(horstKinds())),
  toolNames = new Set(horstTools().map((t) => t.def.name)),
} = {}) {
  const l = cap.horst.lane;
  if (!l) return [`capability "${cap.key}" declares no horst.lane — every module states Horst's stance on its members (direct, card or never)`];
  const out = [];
  const members = new Set(laneMembers(cap));
  const lanes = laneOf(cap);
  for (const m of members) {
    if (!lanes[m]) out.push(`capability "${cap.key}" leaves member "${m}" unclassified — list it under direct, card or never, or give the lane a default`);
  }
  for (const m of Object.keys(lanes)) {
    if (!members.has(m)) out.push(`capability "${cap.key}" classifies "${m}", which is not one of its members (${[...members].join(', ') || 'none'})`);
  }
  for (const [m, x] of Object.entries(lanes)) {
    if (x.lane === 'direct' && !x.tools && !x.deferred) out.push(`capability "${cap.key}": direct member "${m}" has no Horst tool — name the tool that serves it, or { deferred: reason }`);
    for (const t of x.tools || []) if (!toolNames.has(t)) out.push(`capability "${cap.key}": direct member "${m}" names tool "${t}", which is not in Horst's tool pack`);
    if (x.lane === 'card' && !x.kinds && !x.missing) out.push(`capability "${cap.key}": card member "${m}" maps to no kind — name the governance kind, or { missing: reason }`);
    for (const k of x.kinds || []) if (!kindNames.has(k)) out.push(`capability "${cap.key}": card member "${m}" names kind "${k}", which is not registered`);
  }
  return out;
}

// Every facet tool that serves a direct member (the tools that may produce
// rather than only read — still metered, never an outward act).
function laneDirectTools(cap) {
  const own = new Set(cap.horst.tools.map((t) => t.def.name));
  const lanes = laneOf(cap) || {};
  return new Set(Object.values(lanes).flatMap((x) => (x.lane === 'direct' && x.tools) || []).filter((t) => own.has(t)));
}

// Subscribe every module's senses to their service hooks. A wire that throws
// is logged and skipped — one broken sense never costs Horst the others.
// Returns a dispose function (tests; the dashboard never unwires).
function wireHorstSenses({ publish }) {
  if (typeof publish !== 'function') throw new Error('wireHorstSenses requires a publish function');
  const disposers = [];
  for (const c of CAPABILITIES) {
    if (!c.horst.wire) continue;
    const scoped = (kind, payload, opts) => {
      if (!senseOwner.has(kind) || senseOwner.get(kind) !== c.key) {
        return Promise.resolve({ dropped: 'undeclared-sense' });
      }
      try { return Promise.resolve(publish(kind, payload, opts || {})); }
      catch (err) { return Promise.resolve({ dropped: `publish-threw: ${err.message}` }); }
    };
    try {
      const d = c.horst.wire({ publish: scoped });
      if (typeof d === 'function') disposers.push(d);
    } catch (err) {
      console.warn(`[capabilities] horst wire failed for "${c.key}": ${err.message}`);
    }
  }
  return () => { for (const d of disposers) { try { d(); } catch {} } };
}

// method -> capability key (exact), and a prefix table for everything else.
const exactMethod = new Map();
const prefixEntries = [];
for (const c of CAPABILITIES) {
  for (const m of c.methods || []) exactMethod.set(m, c.key);
  for (const p of c.prefixes || []) prefixEntries.push([p, c.key]);
}
// Longest prefix first so `ai.music.` beats `ai.` and `platform.cron.` beats `cron.`.
prefixEntries.sort((a, b) => b[0].length - a[0].length);

function get(key) { return byKey.get(key) || null; }
function all() { return CAPABILITIES.slice(); }

// The capability a bridge method belongs to, or null when it is unclassified.
function capabilityKeyForMethod(method) {
  if (!method) return null;
  if (exactMethod.has(method)) return exactMethod.get(method);
  for (const [prefix, key] of prefixEntries) {
    if (method.startsWith(prefix)) return key;
  }
  return null;
}

// The capability that gates a method at runtime — null means "never gated"
// (cosmetic or app-local surfaces such as toasts, jobs and tasks).
function gatingCapabilityForMethod(method) {
  const key = capabilityKeyForMethod(method);
  if (!key) return null;
  const cap = byKey.get(key);
  return cap && cap.gated ? key : null;
}

// Does a manifest's `capabilities` ADVERTISEMENT cover `key`? Accepts the key
// itself, any declared alias, or any capability that implies it (e.g. `ai`
// implies `maps`). Since the open-world switch this decides nothing at runtime
// — it drives the docs, the admin UI's "Declared" column and the phase-2
// broker's tool selection hints.
function declarationSatisfies(caps, key) {
  const cap = byKey.get(key);
  if (!cap) return false;
  const names = [key, ...(cap.aliases || []), ...(cap.impliedBy || [])];
  for (const n of names) if (caps[n] === true) return true;
  // An implying capability's own aliases count too.
  for (const parent of cap.impliedBy || []) {
    const p = byKey.get(parent);
    for (const a of (p && p.aliases) || []) if (caps[a] === true) return true;
  }
  return false;
}

// Every manifest key this registry recognises — used by the validator and to
// warn about an advertised capability the registry does not know.
function knownDeclarationKeys() {
  const out = new Set();
  for (const c of CAPABILITIES) {
    out.add(c.key);
    for (const a of c.aliases || []) out.add(a);
  }
  return out;
}

// ---- prompt generators ------------------------------------------------------

// The `## Section Index` body for the API reference: one line per capability,
// so nothing is ever invisible while almost nothing is inlined. `inlined` are
// the keys this prompt carries in full, `used` the keys the app's code already
// shows (from capabilities-infer) — an annotation, never a reason to inline.
// Also names the reference material that is not a capability. Kept under
// INDEX_MAX chars by capabilities-check.
const INDEX_MAX = 4000;
function buildSectionIndex({ inlined = new Set(), used = new Set() } = {}) {
  const lines = [
    'All available at runtime. **(inlined)** = section is in this prompt; **(used here)** = this',
    'app\'s code already calls it. For a section not inlined, read `.vistaclair/api/<key>.md`',
    'BEFORE using it — app-lint checks (`unread-capability`). Advertise what you use in',
    '`manifest.json` → `capabilities` (`npm run infer:capabilities -- <appDir> --write`).',
    '',
  ];
  for (const c of CAPABILITIES) {
    const marks = [inlined.has(c.key) && 'inlined', used.has(c.key) && 'used here'].filter(Boolean);
    lines.push(`- \`${c.key}\` — ${c.summary}${marks.length ? ` **(${marks.join('; ')})**` : ''}`);
  }
  lines.push(
    '',
    'Not capabilities, same dir: `api/routes-ctx.md` (routes.js setup, loader ctx, OAuth',
    'redirect, own-process), `api/toolchains.md` (Android, Blender, Rust, Godot, Unity), `migration.md`',
    '(code the platform replaces — read it first), `platform-request.md` / `app-request.md`',
    '(asking for a surface), `scaffolds.md`, `appmd-format.md`, `api-reference.md` (all; large).',
  );
  return lines.join('\n');
}

// Compact capability brief for the build prompt's capability-audit stage: the
// keys, and the one fact a build must not get wrong. The per-key summaries are
// in the section index the same prompt carries.
function buildCapabilityBrief() {
  return [
    `**Platform capabilities** (all available at runtime; advertise the ones you use in \`manifest.json\` → \`capabilities\`): ${CAPABILITIES.map((c) => `\`${c.key}\``).join(', ')}.`,
    'One line each, with where to read more, in the Section Index below.',
    '',
    'Media AI (audio in/out, image generation, translation), Maps and Web Search all use',
    'platform-managed keys — never ask the user for an API key for them.',
  ].join('\n');
}

// "If the app hand-rolls X, move it to Y" list for the change prompt.
function buildMigrationRules() {
  const withRules = CAPABILITIES.filter((c) => c.migration);
  const lines = [
    'When modifying existing apps, look for these patterns and migrate to platform services.',
    'Each one deletes app code rather than adding it:',
    '',
  ];
  for (const c of withRules) lines.push(`- **${c.title}**: ${c.migration}`);
  return lines.join('\n');
}

// Which sections to inline, given the request text: the ones whose keywords the
// request mentions, and nothing else. What the app already uses is NOT a reason
// — an app that uses `db` in thirty places does not need the db section paid
// for on every turn of a session about its CSS; the index annotates it instead.
// A module without `keywords` is never inlined (fleet, config: Horst's surfaces).
function sectionsToInline({ text = '' } = {}) {
  const keep = new Set();
  for (const c of CAPABILITIES) {
    if (c.keywords && c.keywords.test(text)) keep.add(c.key);
  }
  return keep;
}

// ---- dispatch ---------------------------------------------------------------

// bridge method -> handler. A method claimed by two modules is a boot error.
const handlers = new Map();
const handlerOwner = new Map();
for (const c of CAPABILITIES) {
  for (const [m, fn] of Object.entries(c.bridge || {})) {
    if (handlers.has(m)) throw new Error(`bridge method "${m}" is registered by both "${handlerOwner.get(m)}" and "${c.key}"`);
    handlers.set(m, fn);
    handlerOwner.set(m, c.key);
  }
}
function dispatch(method) { return handlers.get(method) || null; }
function dispatchedMethods() { return [...handlers.keys()]; }

// ---- ctx --------------------------------------------------------------------

// Where a capability's ctx members show up. host/dashboard see everything.
function visibleIn(cap, profile) {
  if (profile === 'host' || profile === 'dashboard') return true;
  return cap.visibility[profile];
}

// Is this module structurally removed for the app? Only a `revocable` module
// can be, and only when the admin's grants say so (spend-policy
// revokedCapabilities). `revoked` is a Set of capability keys or null.
function isRevoked(cap, revoked) {
  return !!(cap.revocable && revoked && revoked.has(cap.key));
}

// Feature detection: the capability surface of a PROFILE for one app (open-
// world — the manifest's declaration is an advertisement and grants nothing),
// each module's live `flags` listed right after its key.
// `has`/`list` report every capability whose ctx/bridge exists here, so an app
// can still ask "does this platform expose telegram to me?" — a revoked module
// answers false, in agreement with its absence from the ctx. `legacy`
// survives as pure information: a manifest without a `capabilities` object
// advertises nothing (no longer warned — that is a fine state to be in).
function makeCaps(manifest, profile = 'dashboard', revoked = null) {
  const caps = manifest && manifest.capabilities;
  const legacy = !caps || typeof caps !== 'object';
  const keys = [];
  for (const c of CAPABILITIES) {
    if (visibleIn(c, profile) === false || isRevoked(c, revoked)) continue;
    keys.push(c.key);
    for (const [flag, on] of Object.entries(c.flags)) {
      let yes = false;
      try { yes = on() === true; } catch {}
      if (yes) keys.push(flag);
    }
  }
  const set = new Set(keys);
  return Object.freeze({ legacy, has: (key) => set.has(key), list: () => keys.slice() });
}

// The routes.js ctx for one app in one profile. Every app gets the full
// platform surface for its runtime — interior trust; the only structural
// stripping is the admin's grants (`revoked`, revocable modules only) and the
// own-process perimeter (visibility.standalone):
//   host        everything — what the turnkey auth module receives (never revoked)
//   dashboard   everything minus revoked modules (the in-process app surface)
//   standalone  own-process app (visibility.standalone) minus revoked modules
function buildCtx({ name, dir, manifest, broadcaster }, { profile = 'dashboard', revoked = null } = {}) {
  if (!PROFILES.includes(profile)) throw new Error(`unknown ctx profile "${profile}"`);
  manifest = manifest || {};
  const caps = makeCaps(manifest, profile, revoked);
  const ctx = { appName: name, appDir: dir, dataDir: path.join(dir, '.data'), basePath: `/apps/${name}` };
  const app = {
    name, dir, manifest, broadcaster, profile, caps, legacy: caps.legacy,
    resolvePath: (rel) => safeJoin(dir, rel),
    ctx,
  };
  const owner = new Map();
  for (const cap of CAPABILITIES) {
    if (!cap.ctx.length) continue;
    const vis = visibleIn(cap, profile);
    if (vis === false) continue;
    if (isRevoked(cap, revoked)) continue;
    const members = cap.buildCtx(app) || {};
    const produced = Object.keys(members);
    for (const key of produced) {
      if (!cap.ctx.includes(key)) throw new Error(`capability "${cap.key}" produced undeclared ctx member "${key}"`);
      if (owner.has(key)) throw new Error(`ctx member "${key}" produced by both "${owner.get(key)}" and "${cap.key}"`);
      owner.set(key, cap.key);
      Object.defineProperty(ctx, key, { ...Object.getOwnPropertyDescriptor(members, key), configurable: true, enumerable: true });
    }
    if (vis === true && produced.length !== cap.ctx.length) {
      throw new Error(`capability "${cap.key}" produced ${produced.length} of its ${cap.ctx.length} ctx members in profile "${profile}" (only visibility 'partial' may omit)`);
    }
  }
  if (profile === 'standalone') ctx.isStandalone = true;
  return ctx;
}

module.exports = {
  CAPABILITIES, ORDER, LOADER_CTX_MEMBERS, PROFILES,
  all, get,
  capabilityKeyForMethod,
  gatingCapabilityForMethod,
  declarationSatisfies,
  knownDeclarationKeys,
  INDEX_MAX, buildSectionIndex,
  buildCapabilityBrief,
  buildMigrationRules,
  sectionsToInline,
  dispatch, dispatchedMethods,
  visibleIn, isRevoked, makeCaps, buildCtx,
  // Horst facet
  horstSenses, horstTools, horstKinds, horstBriefs, wireHorstSenses,
  LANES, validateLane, laneMembers, laneOf, laneProblems, laneDirectTools,
};
