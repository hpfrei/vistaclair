const fs = require('fs');
const path = require('path');
const envDetect = require('./env-detect');
const appManager = require('./app-manager');
const capabilities = require('./capabilities');
const googleAuth = require('./google-auth');
const emailAccounts = require('./email-accounts');
const telegram = require('./telegram');
const platformSettings = require('./platform-settings');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

// Live model registry accessor, injected from apps.init via setModelSource.
let modelSource = () => [];

function setModelSource(fn) {
  if (typeof fn === 'function') modelSource = fn;
}

// Render the list of valid `model:` names so the app-building LLM never emits
// invalid model strings. Grouped by provider, deprecated ones tagged, default named.
function buildAvailableModels(defaultModel) {
  let models;
  try {
    models = modelSource() || [];
  } catch {
    models = [];
  }
  // Only models that can actually be called: advertising one with no credential
  // produced apps that failed on their first ai.prompt.
  const usable = models.filter((m) => m && m.usable);
  if (!usable.length) return '';

  const byProvider = new Map();
  for (const m of usable) {
    const prov = m.providerKey || m.provider || 'custom';
    if (!byProvider.has(prov)) byProvider.set(prov, []);
    byProvider.get(prov).push(m);
  }

  const lines = ['### Available AI models', ''];
  lines.push('Valid `model:` values for `ai.prompt(...)` (pass one of these exact `name` strings):');
  lines.push('');
  for (const [prov, list] of byProvider) {
    lines.push(`**${prov}**`);
    for (const m of list) {
      const tag = (m.lifecycle || 'current') === 'deprecated' ? ' — deprecated' : '';
      const label = m.label && m.label !== m.name ? ` (${m.label})` : '';
      lines.push(`- \`${m.name}\`${label}${tag}`);
    }
    lines.push('');
  }
  lines.push(
    '**Anthropic shorthand**: for Claude models, prefer the bare tier name — `"haiku"`, `"sonnet"`, or `"opus"` — instead of the full versioned name. ' +
    'The platform resolves these to the latest version in that family automatically, so your app never goes stale when Anthropic releases a new version. ' +
    'For non-Anthropic models, use the exact `name` string listed above.\n'
  );
  lines.push(
    `Platform default: \`${defaultModel || '(none)'}\`. Omit \`model:\` to use it. ` +
    'To let the user choose at runtime, call `pickModel()` or `getModels()` (see API Reference) instead of hardcoding a list.'
  );
  return lines.join('\n');
}

function readPrompt(name) {
  const filePath = path.join(PROMPTS_DIR, name + '.md');
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

// Substituted values may themselves contain placeholders — `_api-reference.md`
// embeds {{AVAILABLE_MODELS}}, for instance — so this runs to a fixed point rather
// than making a single ordered pass. A single pass would silently leak a raw
// `{{PLACEHOLDER}}` into the prompt whenever a nested var happened to be
// substituted before its host. MAX_PASSES bounds a self-referential value.
const MAX_SUBSTITUTION_PASSES = 5;

function substitute(template, vars) {
  const entries = Object.entries(vars);
  let result = template;
  for (let pass = 0; pass < MAX_SUBSTITUTION_PASSES; pass++) {
    let changed = false;
    for (const [key, value] of entries) {
      const token = `{{${key}}}`;
      if (!result.includes(token)) continue;
      changed = true;
      // split/join is a literal replace — a `$&` or `$1` inside a value (e.g. a
      // regex in the migration rules) can't be reinterpreted as a backreference.
      result = result.split(token).join(value || '');
    }
    if (!changed) break;
  }
  return result;
}

function formatDbCli(dbInfo) {
  if (!dbInfo || !dbInfo.configured) {
    return 'No MariaDB connection is configured. The user can set it up in Apps > Setup.';
  }
  if (!dbInfo.database) {
    return "The app's database will be auto-provisioned when the app starts. Use `ctx.provisionDb()` in routes.js to provision on demand.";
  }
  const host = dbInfo.host || 'localhost';
  const port = dbInfo.port || 3306;
  const esc = dbInfo.password.replace(/'/g, "'\\''");
  return `### Direct Database Access

Your app's MariaDB credentials:
- Host: ${host}  Port: ${port}
- Database: ${dbInfo.database}
- User: ${dbInfo.user}
- Password: ${dbInfo.password}

Connect via CLI:
  mysql -u ${dbInfo.user} -p'${esc}' -h ${host} -P ${port} ${dbInfo.database}

Use this for schema inspection, ad-hoc queries, data fixes, and debugging.
For application code, always use ctx.dbQuery() (routes.js) or Bridge.call('db.query') (frontend).`;
}

// Slice the API reference down to the always-inline basics, the index, and only the
// sections the request's wording selects. Which sections exist and what selects them
// comes from the capability registry (src/apps/capabilities.js) — the same source the
// runtime uses, so the vocabulary an app is taught is the vocabulary that is enforced.
// Every section stays discoverable via the index, and each is written to
// <appDir>/.vistaclair/api/<key>.md at launch so a deferred section is one small read.
//
// Which sections this launch inlines. ONE implementation: the prompt slicer and the
// `inlined.json` the read ledger reconciles against must name the same set, or
// app-lint would demand a read of a section the session was handed. The manifest is
// deliberately NOT consulted — what the app already uses annotates the index (see
// usedKeys) but does not buy a section into every turn of the session. A build-tools
// session is about tools by definition, so that one section is always in.
function inlinedKeys({ action, userRequest, description } = {}) {
  const keep = capabilities.sectionsToInline({ text: `${userRequest || ''}\n${description || ''}` });
  if (action === 'build-tools') keep.add('tools');
  return keep;
}

// The capability keys the app's code already shows (capabilities-infer): an
// annotation on the index line, nothing more. Empty for a build (no code yet)
// or when the app cannot be scanned.
function usedKeys(appName) {
  if (!appName) return new Set();
  try {
    const { infer } = require('./capabilities-infer');
    return new Set(infer(appManager.appDir(appName)).used.keys());
  } catch { return new Set(); }
}

function buildApiReference({ action, appName, userRequest, description } = {}) {
  const full = readPrompt('_api-reference');
  if (!full) return '';

  const keep = inlinedKeys({ action, userRequest, description });
  const index = capabilities.buildSectionIndex({ inlined: keep, used: usedKeys(appName) });

  // Drop any section whose key isn't in `keep` — its index line is the stub. Markers
  // are matched non-greedily so adjacent sections don't collapse into one.
  const blockRe = /<!-- API:SECTION key=([a-z-]+) -->\n([\s\S]*?)\n<!-- \/API:SECTION -->\n?/g;
  const result = full
    .replace('{{CAPABILITY_INDEX}}', index)
    .replace(blockRe, (match, key, body) => (keep.has(key) ? body : ''))
    .replace(DETAIL_BLOCK_RE, (match, key, body) => detailStub(key, body))
    .replace(/<!-- \/?API:INDEX -->\n?/g, '');

  return result.replace(/\n{3,}/g, '\n\n');
}

// API:DETAIL blocks are deep per-feature specs (component attribute/method/event tables,
// long examples) that a session only needs when its task touches that exact feature.
// Unlike API:SECTION they are never inlined — each is replaced by its heading plus a
// pointer to a single small per-section sidecar file (`.vistaclair/api/<key>.md`), so
// the recovery cost is one targeted Read of ~1-2k tokens, not a read of the full
// 120KB reference. The sidecar files are written by writeSidecars at launch.
const DETAIL_BLOCK_RE = /<!-- API:DETAIL key=([a-z0-9-]+) -->\n([\s\S]*?)\n<!-- \/API:DETAIL -->\n?/g;

// ONE wording for every deferred body, so a session meets the same sentence whether
// the pointer stands in for an API:DETAIL block, the scaffold code or the APP.md
// format: what was deferred, which file holds it, and when to read it. The read
// ledger records that read and app-lint demands it (rule `unread-capability`).
function sidecarPointer(file, when, holds) {
  return `> Deferred to keep this prompt small — read \`.vistaclair/${file}\` **${when}**: ${holds}.`;
}

function detailStub(key, body) {
  const heading = body.match(/^(#{2,4} .+)/);
  const pointer = sidecarPointer(`api/${key}.md`, 'before using or modifying this feature',
    'the complete attribute/method/event reference and examples');
  return (heading ? heading[1] + '\n\n' : '') + pointer + '\n\n';
}

// The scaffold bodies are ~22k chars of code of which a build session needs one or
// two, so `{{SCAFFOLDS}}` carries an index and `.vistaclair/scaffolds.md` carries the
// bodies. The index is GENERATED from those bodies — one line per `##` heading plus
// the `>` purpose line beneath it — so index and body cannot drift: a scaffold added,
// renamed or removed changes both in the same edit.
function scaffoldEntries() {
  const lines = readPrompt('_scaffolds-detail').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^## (.+)$/);
    if (!heading) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j++;
    const purpose = (lines[j] || '').match(/^> (.+)$/);
    out.push({ name: heading[1], purpose: purpose ? purpose[1] : '' });
  }
  return out;
}

function buildScaffoldIndex() {
  const entries = scaffoldEntries();
  if (!entries.length) return '';
  return entries.map((e) => `- **${e.name}**${e.purpose ? ` — ${e.purpose}` : ''}`).join('\n') +
    '\n\n' + sidecarPointer('scaffolds.md',
      'before writing `routes.js` or anything under `public/`',
      'the full working code of every scaffold listed above');
}

const APPMD_FORMAT_POINTER = sidecarPointer('appmd-format.md',
  'before writing or updating APP.md',
  'the section-by-section format with examples, the map-don\'t-mirror rule, the ' +
  '`APP_<TOPIC>.md` detail-file rules and the sizing guidance');

// The two request procedures and the migration guidance are read by the few
// sessions that need them, not by every session.
const REQUESTS_POINTER =
  sidecarPointer('platform-request.md',
    'the moment the platform lacks something you need (an API, an engine, a ctx member)',
    'the request procedure: check the gap is real, do not hand-roll, log it in ' +
    '`../PLATFORM_GAPS.md`, tell the user') + '\n' +
  sidecarPointer('app-request.md',
    'when the change needs ANOTHER app to change (a new tool, event or route on its side)',
    'the cross-app request procedure and how to consume the other app\'s tools ' +
    '(`.vistaclair/apps/<app>.md`) in the meantime');

const MIGRATION_POINTER = sidecarPointer('migration.md',
  'before refactoring anything the app hand-rolls (polling, own DB driver, own AI ' +
  'calls, own IMAP/OAuth, own job maps, own approval queue)',
  'the platform-provided replacement for each pattern, the connected mail/Google ' +
  'accounts this app can use, and the tools other running apps expose');

// {{FILE_LIST}} backstop: listAppFiles already filters dependency dirs and the app's
// .gitignore, but a legitimately huge tree (asset packs, generated fixtures) must not
// dominate the prompt either. Any top-level directory with more files than this is
// rolled up to one line naming the exact command that enumerates it — the session
// spends one cheap tool call when (and only when) it actually needs that listing.
const FILE_LIST_MAX_PER_DIR = 50;

function buildFileList(files) {
  const rootFiles = [];
  const groups = new Map();
  for (const f of files) {
    const i = f.indexOf('/');
    if (i === -1) { rootFiles.push(f); continue; }
    const top = f.slice(0, i);
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(f);
  }
  const lines = [...rootFiles];
  let rolledUp = false;
  for (const [top, list] of groups) {
    if (list.length <= FILE_LIST_MAX_PER_DIR) {
      lines.push(...list);
    } else {
      rolledUp = true;
      lines.push(`${top}/ — ${list.length} files (not listed here; run \`find ${top} -type f\` when you need them)`);
    }
  }
  if (rolledUp) {
    lines.push('(Directories marked "not listed here" are summarized to keep this prompt small — enumerate them with the given command only when your task touches them.)');
  }
  return lines.join('\n');
}

// Root APP.md size budget (it is injected in full into every change session, so every
// token is re-paid on every future turn). Numbers are approximate by design — a rough
// ~4 chars/token estimate for markdown prose is plenty to drive the compaction nudge.
const APP_MD_BUDGET_TOKENS = 6000; // target root size
const APP_MD_HARD_TOKENS = 8000; // over this, compaction this session is mandatory

// Measure the app's current root APP.md and emit a status line for the change prompt so the
// session knows whether it is in compaction territory. Returns '' when there is no APP.md.
function buildAppMdBudget(appName) {
  let raw = '';
  try { raw = appManager.readAppMd(appName) || ''; } catch { raw = ''; }
  if (!raw) return '';
  const bytes = Buffer.byteLength(raw, 'utf8');
  const tokens = Math.round(bytes / 4);
  const kb = Math.round(bytes / 1024);
  const n = (x) => x.toLocaleString('en-US');
  const head =
    `### APP.md size budget (measured)\n` +
    `The root APP.md is currently **~${n(tokens)} tokens (${kb} KB)** against a target of ` +
    `**~${n(APP_MD_BUDGET_TOKENS)} tokens** (hard ceiling ~${n(APP_MD_HARD_TOKENS)}). It is ` +
    `injected in full into every change session, so every token is re-paid on every future turn.`;
  let verdict;
  if (tokens > APP_MD_HARD_TOKENS) {
    verdict =
      `\n\n**It is over the hard ceiling — before you finish this session you MUST compact it** ` +
      `back under the target by moving deep detail into \`APP_<TOPIC>.md\` files (see the APP.md ` +
      `maintenance rules below): pointer-only routing cells, one-line file/function entries, deep WHY ` +
      `relocated. **Relocate, never delete an invariant or gotcha.** Do this even though it isn't what ` +
      `the user asked for — an over-budget map taxes every future session.`;
  } else if (tokens > APP_MD_BUDGET_TOKENS) {
    verdict =
      `\n\n**It is over the target.** As you make your change, compact the sections you touch ` +
      `(pointer-only routing cells, one-line file/function entries, outsource deep detail) so the ` +
      `root trends back under budget — don't add to the bloat.`;
  } else {
    verdict =
      `\n\nIt is within budget. Keep it there: if your change pushes a section past its cap, ` +
      `outsource the detail to an \`APP_<TOPIC>.md\` file per the rules below rather than letting the root grow.`;
  }
  return head + verdict;
}

function buildAccountsSummary(appName) {
  const lines = ['### Connected Accounts (Platform-Level)\n'];
  try {
    const gStatus = googleAuth.status();
    if (gStatus.accounts && gStatus.accounts.length > 0) {
      const accs = gStatus.accounts.map(a => `${a.email} (scopes: ${(a.grantedScopes || []).map(s => s.split('/').pop()).join(', ')})`).join(', ');
      lines.push(`**Google accounts**: ${accs}`);
    } else {
      lines.push('**Google accounts**: none configured');
    }
  } catch { lines.push('**Google accounts**: unavailable'); }
  try {
    const emailAccs = emailAccounts.list();
    if (emailAccs.length > 0) {
      const shown = emailAccs.slice(0, 5).map(a => `${a.email} (${a.provider || 'custom'})`).join(', ');
      const suffix = emailAccs.length > 5 ? ` ...${emailAccs.length} total` : '';
      lines.push(`**Email accounts**: ${shown}${suffix}`);
    } else {
      lines.push('**Email accounts**: none configured');
    }
  } catch { lines.push('**Email accounts**: unavailable'); }
  try {
    const t = telegram.status(appName);
    if (t.configured) {
      lines.push(`**Telegram bot (this app)**: @${t.botUsername} — configured`);
    } else {
      lines.push('**Telegram bot (this app)**: none configured (opt-in — only wire Telegram if the user explicitly asks; the user binds a bot token in Apps → Setup → Telegram)');
    }
  } catch { lines.push('**Telegram bot (this app)**: unavailable'); }
  lines.push('\nMail and calendar data for all these accounts is already synced by the platform engines — access it via `ctx.email.*` / `ctx.calendar.*` (or `email.*`/`calendar.*` bridge calls), never raw IMAP/SMTP/Gmail/Calendar APIs. Other surfaces: `ctx.googleAuth.*` (non-mail Google APIs) and `ctx.telegram.*` (see API Reference).');
  return lines.join('\n');
}

// --- What the other apps offer ------------------------------------------------
// Two live sources, read through their module object at call time so a harness
// can stub either: the tool registry holds what a MOUNTED app registered this
// boot, the bus catalog holds every kind an app ever declared (it survives
// restarts). Both are preferred over the manifest, which is only as fresh as the
// last registration — the same live-first / manifest-second order `snapshotTool`
// uses in app-change-requests.js.
function liveAppsTools(app) {
  try {
    return (require('./app-tools').getToolsForApp(app) || []).filter((t) => t && t.expose === 'apps');
  } catch { return []; }
}

function declaredEventCatalog() {
  try { return require('./agent/horst-events').catalog().declared || {}; } catch { return {}; }
}

// The kind a subscriber actually matches on the bus. Kinds are namespaced by app
// at emit time, so a manifest that lists a bare `order:opened` is shown as
// `mt4:order:opened` — what `ctx.events.subscribe` has to be given.
function busKind(app, kind) {
  const k = String(kind || '').trim();
  return !k || k.startsWith(`${app}:`) ? k : `${app}:${k}`;
}

// manifest.events.emits is an object map, an array of kinds or an array of
// { kind, description } — all three shapes are written by something (the
// inference pass, a hand-edited manifest, ctx.events.declare).
function manifestEventKinds(app, emits) {
  const out = [];
  if (!emits) return out;
  if (Array.isArray(emits)) {
    for (const e of emits) {
      const kind = typeof e === 'string' ? e : e?.kind;
      if (kind) out.push({ kind: busKind(app, kind), description: (typeof e === 'object' && e?.description) || '' });
    }
  } else if (typeof emits === 'object') {
    for (const [kind, v] of Object.entries(emits)) {
      out.push({ kind: busKind(app, kind), description: (v && typeof v === 'object' ? v.description : v) || '' });
    }
  }
  return out;
}

// Every app this one may compose with: it exposes a tool to apps, or it declares
// a kind on the bus, or both. Independent apps (platformContribution: false) are
// excluded — their tools are inert to other apps and their events never route.
function crossAppProviders(appName) {
  const declared = declaredEventCatalog();
  const providers = [];
  try {
    for (const app of appManager.list()) {
      if (app.name === appName) continue;
      if (app.platformContribution === false) continue; // independent — tools not callable
      const live = liveAppsTools(app.name);
      const tools = live.length ? live : (app.tools || []).filter((t) => t && t.expose === 'apps');
      const fromBus = Object.entries(declared[app.name] || {})
        .map(([kind, v]) => ({ kind, description: (v && v.description) || '' }));
      const events = fromBus.length ? fromBus : manifestEventKinds(app.name, app.events?.emits);
      if (!tools.length && !events.length) continue;
      providers.push({
        name: app.name,
        runtime: app.runtime || 'in-process',
        running: Boolean(app.running),
        callable: (app.runtime || 'in-process') === 'in-process',
        tools: tools.slice().sort((a, b) => String(a.name).localeCompare(String(b.name))),
        events: events.slice().sort((a, b) => a.kind.localeCompare(b.kind)),
      });
    }
  } catch { return providers; }
  return providers.sort((a, b) => a.name.localeCompare(b.name));
}

// The app→app dependency edges (app-deps.js) as the prompts read them. Empty
// when the store is not initialized (fixtures, tests without a dataHome).
function depEdges(filter) {
  try { return require('./app-deps').list().filter((e) => e.status !== 'revoked' && filter(e)); } catch { return []; }
}
function depTools(e) { return e.tools.includes('*') ? 'all its apps tools' : e.tools.join(', '); }

// The provider side: which apps call this one's tools. A few lines in the
// change prompt and in migration.md; nothing when no app depends on it.
function buildUsedBy(appName) {
  const used = depEdges((e) => e.provider === appName);
  if (!used.length) return '';
  return [
    '### Used by other apps',
    '',
    ...used.map((e) => `- **${e.consumer}** (${depTools(e)})${e.status === 'observed' ? ' — calls it without a declared dependency' : ''}`),
    '',
    'Keep these tools backwards compatible (the change-request rules): new parameters optional with defaults that reproduce today\'s behaviour, nothing renamed, removed or newly required, the result a superset. A breaking change is shown to the owner as a broken dependency.',
  ].join('\n');
}

// One line per provider in `.vistaclair/migration.md`, the detail in `.vistaclair/apps/<app>.md`.
// An own-process app is reachable on the bus but NOT through `ctx.tools.call`
// (app-tools.js refuses it: the call is in-process), so the line says so rather
// than letting a session discover it at runtime.
function buildCrossAppTools(appName) {
  const lines = ['### Tools From Other Apps\n'];
  const providers = crossAppProviders(appName);
  for (const p of providers) {
    const counts = `${p.tools.length} tool${p.tools.length === 1 ? '' : 's'}, ` +
      `${p.events.length} event kind${p.events.length === 1 ? '' : 's'}`;
    const suffix = p.callable ? '' : ' — not callable via `ctx.tools.call`; subscribe on the bus';
    lines.push(`- **${p.name}** (${p.runtime}, ${p.running ? 'running' : 'stopped'}) — ${counts} — ` +
      `\`.vistaclair/apps/${p.name}.md\`${suffix}`);
  }
  if (!providers.length) lines.push('No other app currently exposes a tool or declares an event kind.');
  lines.push('');
  if (providers.length) {
    lines.push(sidecarPointer('apps/<app>.md',
      'before calling that app\'s tools or subscribing to its events',
      'every tool with its parameters, which are required, and what the result contains, plus every kind the app declares'));
    lines.push('');
  }
  lines.push(
    'Call these from routes.js with `await ctx.tools.call(appName, toolName, args)` — prefer this over reimplementing a capability another app already provides. ' +
    'When you build something reusable (data lookup, notification, device control), register it as a tool with `expose: \'apps\'` so other apps can compose with it. ' +
    'Expose levels: `self` (default, own AI sessions only), `platform` (adds platform AI + cron), `apps` (adds other apps). ' +
    'Tools are never reachable from the network — loopback only.'
  );
  const usedBy = buildUsedBy(appName);
  if (usedBy) lines.push('', usedBy);
  lines.push('', platformDutyRules());
  return lines.join('\n');
}

// Standing platform-duty directives (Architecture D, 2026-08). Written with the
// cross-app tools block into `.vistaclair/migration.md`; the templates' Architecture
// Rules carry the one-line version and point here. These are the rules that keep
// the platform's agent (Horst) universal: apps are instruments; the platform owns
// AI initiative.
function platformDutyRules() {
  return [
    '### Platform Duty Rules (Architecture D — apps are instruments, Horst is the operator)',
    '',
    'These rules apply to apps that contribute to the platform (the default). The owner can mark an app INDEPENDENT (`manifest.platformContribution: false` — App Config toggle): it is then invisible to the platform agent (no tool union, no bus events, no digest, no governance) and rules 1, 2 and 5 do not apply. Do not set this flag yourself — it is the owner\'s call.',
    '',
    '1. **Expose what serves the platform.** Any tool useful beyond this app\'s own UI (lookups, domain actions, notifications) MUST carry `expose: \'platform\'` (platform AI + cron can call it) or `expose: \'apps\'` (other apps too), with a description good enough that an agent who has never seen this app can pick it correctly. Tools left at `self` are invisible to the platform agent.',
    '2. **Declare your events.** Meaningful state changes are published to the platform bus: `ctx.events.emit(kind, payload, { summary })`, with kinds advertised once at mount via `ctx.events.declare([{ kind, description }])`. Declared events are the platform agent\'s senses; undeclared apps are invisible to it until first emission.',
    '3. **Durable user-life facts go to platform memory, not private tables.** Facts about the user\'s life (contacts, bookings, deadlines, preferences) belong in `ctx.memory.remember`/`rememberBatch` with `scope: \'shared\'`, a `natural_key` for idempotence, and a `source` for provenance — they must survive this app\'s uninstall. Bulk domain content (transcripts, media, articles) stays in the app\'s own DB, searchable via `ctx.embed`; push only distilled facts up.',
    '4. **No autonomous AI initiative in apps.** Event-triggered AI (classifying arrivals, auto-drafting replies, unsolicited pushes, background AI sweeps) is the platform agent\'s lane — do NOT wire `ctx.email.on`/bus handlers to `ctx.aiPrompt`. User-clicked AI assist (a button the user presses) is fine. If arrival-time intelligence exists (e.g. the `email-intel` annotation), consume it instead of classifying yourself.',
    '5. **Mutating actions an AI initiates go through governance.** Never build an app-local approval queue. Stage via `ctx.governance.propose(kind, payload, meta)`; register app-specific kinds at mount with `ctx.governance.registerKind(kind, { label, validate, describe, execute, notify })` (auto-namespaced `<app>:<kind>`, always human-approved). Render pending proposals from `ctx.governance.list`/bridge `governance.list`; decide via `governance.decide`. User-initiated actions (the user clicked Send) run directly — the click is the approval.',
  ].join('\n');
}

// `profile: 'worker'` is the lean prompt of an orchestration run's worker
// (`prompts/extend-worker.md`, extend only): APP.md, the standing rules, how to
// work and the architecture rules, with the API reference, the file list and the
// APP.md maintenance block left to sidecars the worker reads on demand. Any other
// action, and any other profile, is the full prompt, unchanged.
function hasWorkerProfile(action) { return action === 'extend'; }

function buildPrompt(action, { appName, description, userRequest, proxyPort, dbInfo, profile }) {
  const worker = profile === 'worker' && hasWorkerProfile(action);
  const template = readPrompt(worker ? 'extend-worker' : action);
  if (!template) return userRequest || '';

  const env = envDetect.detect();
  let envSummary = envDetect.summary();
  // Live install-state of the optional platform extras (Setup > Extras), so
  // sessions know which optional capabilities (ai.music.*, gui-mode, ffprobe)
  // are usable right now vs. need the user to install them first.
  try {
    const extras = require('./platform-extras').list()
      .map((x) => `${x.id}: ${x.installed ? 'installed' : x.installing ? 'installing' : 'NOT installed'}`)
      .join(', ');
    envSummary += `\nPlatform extras (user-installable via Apps > Setup > Extras): ${extras}`;
  } catch {}
  const scaffolds = readPrompt('_scaffolds');
  const appMdFormat = readPrompt('_appmd-format');
  const appMdMaintenance = worker ? '' : readPrompt('_appmd-maintenance');
  const apiReference = worker ? '' : buildApiReference({ action, appName, userRequest, description });

  const sudoStatus = env.hasSudo
    ? 'You have passwordless sudo access. You can install system packages (sudo apt-get install -y ...), manage systemd services, and modify system configuration.'
    : 'You do NOT have sudo access. You cannot install system packages or manage services. Work only with tools already available (see Available tools above). If a required tool is missing, tell the user to install it manually.';

  const vars = {
    APP_NAME: appName || 'unnamed',
    DESCRIPTION: description || '',
    USER_REQUEST: userRequest || '',
    ENV_SUMMARY: envSummary,
    SUDO_STATUS: sudoStatus,
    API_REFERENCE: apiReference,
    DB_CLI: formatDbCli(dbInfo),
    SCAFFOLDS: scaffolds,
    SCAFFOLD_INDEX: buildScaffoldIndex(),
    APPMD_FORMAT: appMdFormat,
    APPMD_FORMAT_POINTER,
    REQUESTS_POINTER,
    MIGRATION_POINTER,
    APPMD_MAINTENANCE: appMdMaintenance,
    // The apps-repo standing rules, inlined: these sessions run with CLAUDE.md off (hooksSettings).
    STANDING_RULES: require('./standing-rules').standingRules(),
    AVAILABLE_MODELS: buildAvailableModels(platformSettings.get('directModel')),
    // Generated from the capability registry — never hand-maintained. See capabilities.js.
    // The section index is substituted inside buildApiReference (it is annotated per launch).
    CAPABILITY_BRIEF: capabilities.buildCapabilityBrief(),
    FILE_LIST: '',
    APP_MD: '',
    APP_MD_BUDGET: '',
    USED_BY: '',
  };

  if (appName && action !== 'build') {
    vars.APP_MD = appManager.readAppMd(appName) || '(no APP.md)';
    if (worker) {
      // No file list (`ls` on demand), no size-budget line (a docs worker reads the
      // maintenance sidecar); the backward-compatibility duty stays.
      vars.USED_BY = buildUsedBy(appName);
    } else {
      const files = appManager.listAppFiles(appName);
      vars.FILE_LIST = buildFileList(files) || '(empty)';
      vars.APP_MD_BUDGET = [buildAppMdBudget(appName), buildUsedBy(appName)].filter(Boolean).join('\n\n');
    }
  }

  return substitute(template, vars);
}

// The API reference with its generated placeholders (the capability index, the
// model catalog) substituted, split into the same per-key sections the sidecar
// writes: { text, sections: { <key>: body } }.
function apiReferenceIndex() {
  const full = readPrompt('_api-reference');
  if (!full) return { text: '', sections: {} };
  const substituted = substitute(full, {
    CAPABILITY_INDEX: capabilities.buildSectionIndex(),
    AVAILABLE_MODELS: buildAvailableModels(platformSettings.get('directModel')),
  });
  // DETAIL blocks FIRST, because they nest inside SECTION ones: a single pass with
  // one regex would end a SECTION body at the first nested `</API:DETAIL>`. Each
  // detail body becomes its own file and leaves the same pointer behind in its
  // parent's file that the prompt carries — so the read stays small either way.
  const sections = {};
  const outer = substituted.replace(DETAIL_BLOCK_RE, (match, key, body) => {
    sections[key] = body + '\n';
    return detailStub(key, body);
  });
  const optionalRe = /<!-- API:SECTION key=([a-z-]+) -->\n([\s\S]*?)\n<!-- \/API:SECTION -->/g;
  for (const m of outer.matchAll(optionalRe)) sections[m[1]] = m[2] + '\n';
  const text = substituted.replace(/<!-- \/?API:(SECTION|DETAIL|INDEX)[^>]*-->\n?/g, '');
  return { text, sections };
}

// Write `file` only when its content differs, so a refresh that changes nothing
// leaves every mtime alone. Returns whether it wrote.
function writeIfChanged(file, content) {
  try { if (fs.readFileSync(file, 'utf-8') === content) return false; } catch {}
  fs.writeFileSync(file, content, 'utf-8');
  return true;
}

// Write the COMPLETE api reference (markers stripped) to <appDir>/.vistaclair/api-reference.md
// so a change session can read any section that wasn't inlined into its prompt, plus
// one small file per section. Pushes the relative paths it holds into `files` and
// those it (re)wrote or removed into `changed`.
function writeApiReferenceSidecar(appDir, { files = [], changed = [] } = {}) {
  const { text: clean, sections } = apiReferenceIndex();
  if (!clean) return;
  const dir = path.join(appDir, '.vistaclair');
  const apiDir = path.join(dir, 'api');
  fs.mkdirSync(apiDir, { recursive: true });

  // One small file per section, so a session pointed at a section it lacks reads
  // ~1-2k tokens, not the whole reference. SECTION bodies (inlined only on a
  // keyword hit) and DETAIL bodies (always deferred) both land here, keyed exactly
  // as the inline pointers and the section index name them. A key the reference
  // no longer has loses its file.
  const keep = new Set();
  for (const [key, body] of Object.entries(sections)) {
    const rel = `api/${key}.md`;
    keep.add(`${key}.md`);
    files.push(rel);
    if (writeIfChanged(path.join(apiDir, `${key}.md`), body)) changed.push(rel);
  }
  for (const f of fs.readdirSync(apiDir)) {
    if (f.endsWith('.md') && !keep.has(f)) { fs.rmSync(path.join(apiDir, f), { force: true }); changed.push(`api/${f}`); }
  }
  files.push('api-reference.md');
  if (writeIfChanged(path.join(dir, 'api-reference.md'), clean)) changed.push('api-reference.md');
}

// `.vistaclair/` is never committed with the app. Launch path only.
function ensureGitignored(appDir) {
  const giPath = path.join(appDir, '.gitignore');
  let gi = '';
  try { gi = fs.readFileSync(giPath, 'utf-8'); } catch {}
  if (!/^\.vistaclair\/?\s*$/m.test(gi)) {
    fs.writeFileSync(giPath, (gi && !gi.endsWith('\n') ? gi + '\n' : gi) + '.vistaclair/\n', 'utf-8');
  }
}

// One provider per file: what a session needs to compose with that app, and
// nothing else. The tools with their parameters, which of them are required and
// what the result contains (`returns`), the kinds it declares, and whether
// `ctx.tools.call` can reach it at all.
function crossAppSidecar(p, consumer) {
  const out = [`# ${p.name} — tools and events`, ''];
  out.push(p.callable
    ? `Runtime **${p.runtime}**, currently **${p.running ? 'running' : 'stopped'}** (a stopped in-process app is lazy-mounted on the first call). ` +
      `Call a tool below with \`await ctx.tools.call('${p.name}', '<tool>', args)\`.`
    : `Runtime **${p.runtime}**, currently **${p.running ? 'running' : 'stopped'}**. ` +
      `\`ctx.tools.call\` is in-process and CANNOT reach this app — react to its events on the platform bus instead, ` +
      `or ask for what you need with a change request.`);
  if (p.callable && p.tools.length && consumer) {
    const dep = depEdges((e) => e.consumer === consumer && e.provider === p.name && e.status === 'approved')[0];
    out.push('', dep
      ? `Declared dependency: **yes** (${depTools(dep)}).`
      : `Declared dependency: **no** — before calling, declare it: \`node ../../platform/scripts/app-change.js depend --on ${p.name} --tools <t1,t2> --why "<why>"\`. An undeclared call is flagged, or refused when the owner enforces dependencies.`);
  }

  out.push('', '## Tools');
  if (!p.tools.length) {
    out.push('', `${p.name} exposes no tool to other apps.`);
  } else {
    for (const t of p.tools) {
      const props = (t.inputSchema && t.inputSchema.properties) || {};
      const required = new Set(Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : []);
      out.push('', `### \`${t.name}\``, '', t.description || '_(no description)_');
      if (t.kind === 'job') out.push('', 'Kind: **job** — long-running. `ctx.tools.call` returns the result when it ends within `_wait` (default 30 s), else `{ structuredContent: { jobId } }` and the outcome reaches `ctx.tools.onJobDone`; `ctx.tools.callAndWait` waits for the end.');
      const params = Object.entries(props).map(([name, s]) => {
        const type = (s && s.type) || 'any';
        const desc = (s && s.description) ? ` — ${s.description}` : '';
        return `- \`${name}\` (${type}${required.has(name) ? ', **required**' : ''})${desc}`;
      });
      out.push('', params.length ? 'Parameters:' : 'Parameters: none.', ...params);
      const returns = require('./app-tools').returnsText(t.returns);
      out.push('', returns ? `Returns: ${returns}` : 'Returns: not documented by that app — inspect the result before relying on a field.');
    }
  }

  out.push('', '## Events');
  if (!p.events.length) {
    out.push('', `${p.name} declares no kind on the platform bus.`);
  } else {
    out.push('', `Subscribe in \`routes.js\`: \`ctx.events.subscribe(['${p.events[0].kind}'], handler)\` (\`${p.name}:*\` matches all of them).`, '');
    for (const e of p.events) out.push(`- \`${e.kind}\`${e.description ? ` — ${e.description}` : ''}`);
  }
  return out.join('\n') + '\n';
}

// Mirrors the provider list exactly: an app that stopped exposing tools must not
// leave a sidecar behind, or app-lint would demand a read of a file that no
// longer describes anything (rule `unread-capability`). Unchanged files are not
// rewritten.
function writeCrossAppSidecars(appDir, appName, { files = [], changed = [] } = {}) {
  const dir = path.join(appDir, '.vistaclair', 'apps');
  const providers = crossAppProviders(appName);
  let existing = [];
  try { existing = fs.readdirSync(dir); } catch {}
  if (!providers.length) {
    for (const f of existing) changed.push(`apps/${f}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set(providers.map((p) => `${p.name}.md`));
  for (const f of existing) {
    if (!keep.has(f)) { fs.rmSync(path.join(dir, f), { recursive: true, force: true }); changed.push(`apps/${f}`); }
  }
  for (const p of providers) {
    const rel = `apps/${p.name}.md`;
    files.push(rel);
    if (writeIfChanged(path.join(dir, `${p.name}.md`), crossAppSidecar(p, appName))) changed.push(rel);
  }
}

// What produced the copies: the vc version (root package.json) and, from a git
// checkout, its short sha. Read once per process.
const VC_ROOT = path.resolve(__dirname, '..', '..', '..');
let vcVersion = null;
function platformVersion() {
  if (vcVersion) return vcVersion;
  let version = '';
  try { version = JSON.parse(fs.readFileSync(path.join(VC_ROOT, 'package.json'), 'utf-8')).version || ''; } catch {}
  let commit = '';
  try {
    commit = require('child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'],
      { cwd: VC_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {}
  vcVersion = { version, commit };
  return vcVersion;
}

// The platform-doc copies in `<appDir>/.vistaclair/`: api/<key>.md,
// api-reference.md and apps/<app>.md — and NOTHING a running session depends on
// (inlined.json, reads.jsonl, hooks.json, scaffolds.md, migration.md, ...). Run at
// every launch (writeSidecars), at Pro boot and after another app's tools change
// (doc-copies.js), so a session opened by hand or running across a platform
// update reads current docs. Each file is written only when its content changed.
// `api/.generated.json` stamps `{ at, version, commit, files }`; it moves only
// when a copy or the platform version did. `crossApp: false` skips apps/.
// Returns { files, changed } (paths relative to .vistaclair/). Throws on I/O errors.
function refreshDocCopies(appDir, appName, { api = true, crossApp = true } = {}) {
  const files = [];
  const changed = [];
  if (api) writeApiReferenceSidecar(appDir, { files, changed });
  if (crossApp) writeCrossAppSidecars(appDir, appName, { files, changed });
  if (api) {
    const stampFile = path.join(appDir, '.vistaclair', 'api', '.generated.json');
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(stampFile, 'utf-8')); } catch {}
    const { version, commit } = platformVersion();
    if (fs.existsSync(path.dirname(stampFile)) && (changed.length || !prev || prev.version !== version || prev.commit !== commit
      || JSON.stringify(prev.files) !== JSON.stringify(files))) {
      fs.writeFileSync(stampFile, JSON.stringify({ at: new Date().toISOString(), version, commit, files }, null, 2) + '\n', 'utf-8');
    }
  }
  return { files, changed };
}

// The PreToolUse hook that records which sidecar files a session reads. Written
// into the app directory per launch and handed to the CLI as `--settings`, NOT
// as a generated `.claude/settings.json`: a project settings file would travel
// with the app on publish and outlive the session that needed it.
const READ_LEDGER_HOOK = path.resolve(__dirname, 'hooks', 'read-ledger.js');

// The same file switches CLAUDE.md discovery off: the session's instructions are
// its prompt, which carries the standing rules ({{STANDING_RULES}}), so no
// CLAUDE.md — the apps-repo copy, a nested one a Read would pull in, or one above
// the apps dir — can add to or contradict them. The env switch covers every
// source; `claudeMdExcludes` is the documented net for the apps tree should the
// switch ever stop working. Hooks and --append-system-prompt are unaffected.
function claudeMdExcludes() {
  const dirs = new Set([appManager.APPS_DIR]);
  try { dirs.add(fs.realpathSync(appManager.APPS_DIR)); } catch {}
  return [...dirs].map((d) => path.join(d, '**', 'CLAUDE.md'));
}

function hooksSettings() {
  return {
    env: { CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' },
    claudeMdExcludes: claudeMdExcludes(),
    hooks: {
      PreToolUse: [{
        matcher: 'Read|Bash',
        hooks: [{ type: 'command', command: `node ${JSON.stringify(READ_LEDGER_HOOK)}`, timeout: 5 }],
      }],
    },
  };
}

// The migration sidecar: what the app may hand-roll that the platform provides,
// plus the two launch-specific facts that decide a migration (which accounts are
// connected, which other apps expose tools). Deferred from the prompt to a pointer.
function migrationSidecar(appName) {
  return [
    '# Migration guidance', '',
    capabilities.buildMigrationRules(), '',
    '## Connected accounts', '', buildAccountsSummary(appName), '',
    '## Other apps\' tools', '', buildCrossAppTools(appName), '',
  ].join('\n');
}

// Per-file capability evidence at launch. Rule 19 (`unread-capability`) demands
// a read only for evidence that is NEW against this snapshot — an app that used
// `db` in thirty places before the session started does not owe a db read for a
// CSS change. Missing (scan failed) → app-lint falls back to file mtimes.
function evidenceBaseline(appDir) {
  try {
    const { infer, evidenceByFile } = require('./capabilities-infer');
    return evidenceByFile(infer(appDir));
  } catch { return undefined; }
}

// Everything `<appDir>/.vistaclair/` holds for ONE launch, written together so the
// files cannot disagree:
//   api-reference.md, api/<key>.md   the readable reference (refreshDocCopies)
//   api/.generated.json              the copies' stamp (refreshDocCopies)
//   scaffolds.md, appmd-format.md    the two prompt bodies the prompt defers to a pointer
//   appmd-maintenance.md             the APP.md maintenance block: inlined into a full change
//                                    prompt, a pointer in the lean worker prompt
//   migration.md                     the migration rules + accounts + cross-app tools
//   platform-request.md              how to ask the platform for a missing surface
//   app-request.md                   how to ask another app for a change
//   apps/<app>.md                    one per app that exposes a tool or declares a kind (refreshDocCopies)
//   inlined.json                     the sections this prompt carries, and the
//                                    per-file capability evidence at launch (baseline).
//                                    `profile: 'worker'` (the launch is an orchestration
//                                    run whose workers get the lean prompt): `keys: []`
//                                    and `profile: 'worker'` — see markWorkerProfile.
//   reads.jsonl                      truncated — a new session starts with an empty ledger
//   hooks.json                       the --settings file that installs the read hook
// app-lint reconciles new code against inlined ∪ ledger (rule 19). Best-effort: a
// failure here must never stop a launch, it only costs the session the check.
// Returns the settings file to hand the CLI, or null when nothing was written.
function writeSidecars(appDir, { action = '', appName = '', userRequest = '', description = '', profile = '' } = {}) {
  try {
    refreshDocCopies(appDir, appName);
    const dir = path.join(appDir, '.vistaclair');
    if (!fs.existsSync(dir)) return null;
    ensureGitignored(appDir);
    // The scaffold code and the full APP.md format: deferred from the prompt to a
    // pointer, so the body has to be readable here. `{{APP_NAME}}` is resolved —
    // the session copies this code, it must not paste a placeholder.
    fs.writeFileSync(path.join(dir, 'scaffolds.md'),
      substitute(readPrompt('_scaffolds-detail'), { APP_NAME: appName || 'my-app' }), 'utf-8');
    fs.writeFileSync(path.join(dir, 'appmd-format.md'), readPrompt('_appmd-format-detail'), 'utf-8');
    fs.writeFileSync(path.join(dir, 'appmd-maintenance.md'),
      substitute(readPrompt('_appmd-maintenance'), { APPMD_FORMAT_POINTER }), 'utf-8');
    fs.writeFileSync(path.join(dir, 'migration.md'), migrationSidecar(appName), 'utf-8');
    fs.writeFileSync(path.join(dir, 'platform-request.md'), readPrompt('_platform-request'), 'utf-8');
    fs.writeFileSync(path.join(dir, 'app-request.md'), readPrompt('_app-request'), 'utf-8');
    const lean = profile === 'worker' && hasWorkerProfile(action);
    const keys = lean ? [] : [...inlinedKeys({ action, userRequest, description })].sort();
    const baseline = action === 'build' ? {} : evidenceBaseline(appDir);
    fs.writeFileSync(path.join(dir, 'inlined.json'),
      JSON.stringify({ at: new Date().toISOString(), action, ...(lean ? { profile: 'worker' } : {}), keys, baseline }, null, 2) + '\n', 'utf-8');
    fs.writeFileSync(path.join(dir, 'reads.jsonl'), '', 'utf-8');
    const settingsFile = path.join(dir, 'hooks.json');
    fs.writeFileSync(settingsFile, JSON.stringify(hooksSettings(), null, 2) + '\n', 'utf-8');
    return settingsFile;
  } catch {
    return null;
  }
}

// inlined.json is ONE file per app dir, written at launch, and every session of
// a run reads it through app-lint. When the owner picks Simple / Orchestrator
// after the sidecars were written (a terminal launch), the launcher cannot know
// whether the run's workers get the lean prompt; this rewrites the stamp once
// core reports the mode. Lean workers never saw an inlined section, so the stamp
// says so (`keys: []`, `profile: 'worker'`) and app-lint demands a read of every
// section they use. The orchestrator, which has the full prompt, shares the
// stamp: the cost is one spurious read request for a section it was handed,
// never a missed one. Same `at` and `baseline`; best-effort like writeSidecars.
function markWorkerProfile(appDir) {
  try {
    const file = path.join(appDir, '.vistaclair', 'inlined.json');
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!hasWorkerProfile(doc.action)) return false;
    fs.writeFileSync(file, JSON.stringify({ ...doc, profile: 'worker', keys: [] }, null, 2) + '\n', 'utf-8');
    return true;
  } catch { return false; }
}

module.exports = {
  markWorkerProfile, hasWorkerProfile,
  buildPrompt, readPrompt, setModelSource, buildApiReference, inlinedKeys, writeSidecars, refreshDocCopies,
  scaffoldEntries, buildScaffoldIndex, crossAppProviders, buildCrossAppTools, buildUsedBy,
};
