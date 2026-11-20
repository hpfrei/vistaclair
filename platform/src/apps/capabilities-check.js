#!/usr/bin/env node
// Capability registry drift check — run by `npm run check:capabilities` (and
// CI/pre-restart). Fails when the capability modules disagree with what is
// dispatched, documented, exposed to iframes, declarable, or produced on the
// routes.js ctx. Loading the registry is itself rule 0: a malformed module,
// a method registered twice, or a directory that disagrees with ORDER throws
// with a precise message before any rule below runs.
//
//   1  handler-missing        a listed method has no bridge handler (and is not external)
//   2  handler-unclaimed      a handler key is not in the module's methods
//   3  external-undispatched  an external method is not dispatched by src/apps/index.js
//   4  duplicate-method       a method is listed by two modules
//   5  ctx-mismatch           buildCtx(app) does not produce exactly the `ctx` names
//                             (dashboard: equal; standalone: equal when
//                             visibility is true, strict subset when 'partial')
//   6  ctx-collision          two modules produce the same ctx member
//   7  missing-marker         a capability has no, or more than one, <!-- API:SECTION key=… --> block
//   8  orphan-marker          a marker names an unknown capability
//   9  phantom-runtime        a `runtime` global is not assigned in public/app-runtime.js
//  10  missing-heading        a capability title/heading is not in _api-reference.md
//  11  undeclarable-gate      a substantive (gated:true) capability's key is not
//                             advertisable in a manifest (one vocabulary for
//                             docs, infer/advertise and the broker)
//  12  horst-sense-collision  a sense kind is declared twice or is a builtin bus kind
//  13  horst-sense-unreferenced  a declared sense has no publish site in its module
//  14  horst-policy-invalid   a sense default policy is not a bus policy
//  15  horst-tool-collision   a facet tool name is declared twice or is a brain tool
//  16  horst-tool-shape       a facet tool is neither marked read-only nor a direct-lane
//                             tool of its module / bad schema
//  17  horst-kind-collision   an action kind is declared twice or is governance-internal
//      horst-kind-shape       an autonomous-capable kind lacks its "about" line
//  18  cost-missing           a metered capability lacks spend.service / a unit per method / a default unit price
//  19  metered-ungated        a metered capability's service module never calls spendGate.authorize/wrap
//  20  horst-kind-identity    an action kind does not declare `identity` (the act key
//                             that makes duplicate staging impossible). `null` is a
//                             valid answer — the point is that the key is PRESENT, so
//                             adding a kind is a conscious decision about duplicates
//                             rather than a silent opt-out.
//  21  horst-auto-irreversible  a kind whose DEFAULT dial is autonomous declares
//                             neither `undo` nor `idempotent`. A default is what
//                             happens to owners who never opened the dials, so an
//                             autonomous one may only ever make mistakes the world
//                             can absorb — reversible, or converging on the same
//                             state when repeated. Raising a ceiling is a capability;
//                             raising a DEFAULT is a decision made on someone's behalf.
//  22  horst-brief-shape      a `horst.brief` does not start with "<key>:" or is longer
//                             than one line of Horst's chat system prompt
//      summary-shape          a capability has no `summary`, or one too long for the
//                             section index every build prompt carries
//  23  heading-outside-section a heading a capability declares sits outside its own
//                             <!-- API:SECTION --> block, so .vistaclair/api/<key>.md
//                             would not hold it
//  24  untiered-optional      an <!-- API:SECTION --> block costs more than 12k chars
//                             once inlined (DETAIL blocks counted as stubs), so a
//                             session whose request names the key pays all of it
//  25  reference-basics-size  the always-inline part of _api-reference.md (outside every
//                             SECTION block, index substituted) is over 10k chars, or
//                             buildSectionIndex() is over capabilities.INDEX_MAX
//      detail-block-shape     a DETAIL key is used twice, or a heading a capability
//                             declares sits inside a DETAIL block without opening it
//                             (only a block's FIRST heading survives the slice)
//  26  horst-lane             a module declares no `horst.lane`, leaves a member
//                             unclassified or classifies a non-member, a direct
//                             member has no facet tool (and no `deferred` reason),
//                             or a card member maps to no registered kind (and no
//                             `missing` reason) — capabilities.laneProblems
// `card` is deliberately NOT required per kind: horst-cards.js guarantees the
// floor (a family projector, else a labelled generic card built from the
// payload), so no kind can reach a surface as raw JSON whether it declares one
// or not. test/horst-cards.test.js asserts that for every registered kind.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const INDEX = path.join(ROOT, 'src', 'apps', 'index.js');
const REFERENCE = path.join(ROOT, 'src', 'apps', 'prompts', '_api-reference.md');
const RUNTIME = path.join(ROOT, 'public', 'app-runtime.js');

let capabilities;
try {
  capabilities = require('./capabilities');
} catch (err) {
  console.error(`capability registry failed to load:\n  ${err.message}`);
  process.exit(1);
}

const problems = [];
const fail = (rule, msg) => problems.push({ rule, msg });
const read = (p) => fs.readFileSync(p, 'utf-8');
const caps = capabilities.all();

// --- 1-4: methods and handlers ----------------------------------------------

const indexSrc = read(INDEX);
const externalDispatched = new Set([...indexSrc.matchAll(/msg\.method === '([a-z][a-zA-Z0-9_.]*)'/g)].map((m) => m[1]));

const claimed = new Map();
for (const cap of caps) {
  for (const m of cap.methods) {
    if (claimed.has(m)) fail('duplicate-method', `method "${m}" listed by both "${claimed.get(m)}" and "${cap.key}"`);
    claimed.set(m, cap.key);
    if (cap.external) {
      if (!externalDispatched.has(m)) fail('external-undispatched', `capability "${cap.key}" lists external method "${m}", which src/apps/index.js does not dispatch`);
    } else if (!capabilities.dispatch(m)) {
      fail('handler-missing', `capability "${cap.key}" lists "${m}" but has no bridge handler for it`);
    }
  }
  for (const m of Object.keys(cap.bridge || {})) {
    const own = cap.methods.includes(m) || cap.prefixes.some((p) => m.startsWith(p));
    if (!own) fail('handler-unclaimed', `capability "${cap.key}" dispatches "${m}", which is not in its methods or prefixes`);
    if (capabilities.capabilityKeyForMethod(m) !== cap.key) {
      fail('handler-unclaimed', `bridge method "${m}" is dispatched by "${cap.key}" but classifies as "${capabilities.capabilityKeyForMethod(m)}"`);
    }
  }
}

// --- 5-6: ctx parity per profile --------------------------------------------

const fakeApp = {
  name: '__capabilities_check__',
  dir: path.join(os.tmpdir(), '__capabilities_check__'),
  broadcaster: { broadcast() {} },
};
const LOADER = new Set(capabilities.LOADER_CTX_MEMBERS);
const ctxOwner = new Map();
for (const profile of ['dashboard', 'standalone']) {
  let ctx;
  try {
    // A legacy (undeclared) manifest grants every capability, so every module
    // that is visible in the profile must produce its members.
    ctx = capabilities.buildCtx({ ...fakeApp, manifest: profile === 'standalone' ? { auth: { email: true } } : {} }, { profile });
  } catch (err) {
    fail('ctx-mismatch', `buildCtx failed for profile "${profile}": ${err.message}`);
    continue;
  }
  const produced = new Set(Object.keys(ctx).filter((k) => !LOADER.has(k) && k !== 'isStandalone'));
  for (const cap of caps) {
    if (!cap.ctx.length) continue;
    const vis = capabilities.visibleIn(cap, profile);
    const have = cap.ctx.filter((n) => produced.has(n));
    if (vis === false) {
      if (have.length) fail('ctx-mismatch', `"${cap.key}" is hidden in profile "${profile}" but ${have.join(', ')} still present`);
    } else if (vis === true) {
      const missing = cap.ctx.filter((n) => !produced.has(n));
      if (missing.length) fail('ctx-mismatch', `"${cap.key}" lists ctx ${missing.join(', ')} but buildCtx did not produce it in profile "${profile}"`);
    } else if (have.length === cap.ctx.length && profile !== 'dashboard') {
      fail('ctx-mismatch', `"${cap.key}" declares visibility.${profile} = 'partial' but produced every member — use true`);
    }
    for (const n of have) {
      if (profile === 'dashboard') ctxOwner.set(n, cap.key);
      else if (ctxOwner.has(n) && ctxOwner.get(n) !== cap.key) fail('ctx-collision', `ctx member "${n}" produced by both "${ctxOwner.get(n)}" and "${cap.key}"`);
    }
  }
  for (const n of produced) {
    if (![...caps].some((c) => c.ctx.includes(n))) fail('ctx-mismatch', `ctx member "${n}" (profile "${profile}") is produced by no capability's ctx list`);
  }
}

// --- 7-8: section markers ----------------------------------------------------

// Every capability is one deferrable block, inlined only on a keyword hit; the
// slicer and the sidecar writer both key on the marker, so a capability without
// exactly one block is either always inlined (no block) or split (two).
const reference = read(REFERENCE);
const markerCount = new Map();
for (const m of reference.matchAll(/<!-- API:SECTION key=([a-z-]+) -->/g)) markerCount.set(m[1], (markerCount.get(m[1]) || 0) + 1);

for (const cap of caps) {
  const n = markerCount.get(cap.key) || 0;
  if (n === 0) {
    fail('missing-marker',
      `capability "${cap.key}" has no <!-- API:SECTION key=${cap.key} --> block in prompts/_api-reference.md, ` +
      `so its docs are inlined into every prompt and never reach .vistaclair/api/${cap.key}.md`);
  } else if (n > 1) {
    fail('missing-marker', `capability "${cap.key}" has ${n} <!-- API:SECTION key=${cap.key} --> blocks — exactly one`);
  }
}
for (const key of markerCount.keys()) {
  if (!capabilities.get(key)) fail('orphan-marker', `_api-reference.md marks key=${key}, but no such capability exists in the registry`);
}

// --- 9: runtime globals ------------------------------------------------------

const runtimeSrc = read(RUNTIME);
const exposed = new Set([...runtimeSrc.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]));
for (const cap of caps) {
  for (const sym of cap.runtime || []) {
    if (!exposed.has(sym)) {
      fail('phantom-runtime',
        `capability "${cap.key}" lists runtime global "${sym}", which public/app-runtime.js does not assign`);
    }
  }
}

// --- 10: headings ------------------------------------------------------------

// Level 2-4: ctx-only surfaces (identity, capabilities) are documented as
// sub-sections of the section that introduces them.
const headings = [...reference.matchAll(/^#{2,4} (.+)$/gm)].map((m) => ({ text: m[1], at: m.index }));
const headingMatches = (h, want) => h === want || h.startsWith(want + ' ') || h.startsWith(want + '(');
const matches = (want) => headings.some((h) => headingMatches(h.text, want));
for (const cap of caps) {
  // A capability documented across several sections declares `headings`; otherwise
  // its display title must itself name a section.
  for (const want of cap.headings || [cap.title]) {
    if (!matches(want)) {
      fail('missing-heading',
        `capability "${cap.key}" expects a section titled "${want}" but prompts/_api-reference.md has no ` +
        `matching heading (the section index would point at a section that doesn't exist)`);
    }
  }
}

// --- 11: one vocabulary ------------------------------------------------------

// Every substantive capability a method classifies under must be an
// advertisable manifest key — the docs, infer/advertise and the broker all
// speak the same vocabulary (nothing gates at runtime any more).
const declarable = capabilities.knownDeclarationKeys();
for (const m of [...claimed.keys()]) {
  const gate = capabilities.gatingCapabilityForMethod(m);
  if (gate && !declarable.has(gate)) {
    fail('undeclarable-gate',
      `method "${m}" classifies under "${gate}", which is not an advertisable manifest key — the docs/infer vocabulary would diverge from the registry`);
  }
}

// --- 12-17: the Horst facet --------------------------------------------------

// Senses: unique across modules AND the bus's builtin lifecycle table; the
// kind literal must appear in the module source at least twice (declaration +
// the publish site inside wire), so a declared sense nobody publishes fails.
const busKinds = new Set(require('./agent/horst-events').BUILTIN_KINDS.map((k) => k.key));
const busPolicies = new Set(require('./agent/horst-events').POLICIES);
const senseSeen = new Map();
for (const cap of caps) {
  const src = read(path.join(ROOT, 'src', 'apps', 'capabilities', `${cap.key}.js`));
  for (const s of cap.horst.senses) {
    if (busKinds.has(s.kind)) fail('horst-sense-collision', `capability "${cap.key}" declares sense "${s.kind}", which is a builtin bus kind`);
    if (senseSeen.has(s.kind)) fail('horst-sense-collision', `sense "${s.kind}" declared by both "${senseSeen.get(s.kind)}" and "${cap.key}"`);
    senseSeen.set(s.kind, cap.key);
    if (!busPolicies.has(s.defaultPolicy)) fail('horst-policy-invalid', `sense "${s.kind}" default policy "${s.defaultPolicy}" is not a bus policy`);
    const occurrences = src.split(`'${s.kind}'`).length - 1;
    if (occurrences < 2) fail('horst-sense-unreferenced', `capability "${cap.key}" declares sense "${s.kind}" but never publishes it (the literal appears ${occurrences} time(s); expected the declaration and a publish site)`);
  }
}

// Tools: unique across modules and the brain pull tools; well-formed defs.
const brainToolNames = new Set(require('./agent/horst-brain').brainTools().map((t) => t.def.name));
const toolSeen = new Map();
for (const cap of caps) {
  const directTools = capabilities.laneDirectTools(cap);
  for (const t of cap.horst.tools) {
    const n = t.def.name;
    if (brainToolNames.has(n)) fail('horst-tool-collision', `capability "${cap.key}" declares tool "${n}", which is a brain pull tool`);
    if (toolSeen.has(n)) fail('horst-tool-collision', `tool "${n}" declared by both "${toolSeen.get(n)}" and "${cap.key}"`);
    toolSeen.set(n, cap.key);
    if (!/read-only/i.test(t.def.description) && !directTools.has(n)) fail('horst-tool-shape', `tool "${n}" (${cap.key}) must say "Read-only" in its description, or serve a direct-lane member of its module — facet tools never act outward; outward acts are governance kinds`);
    const schema = t.def.inputSchema;
    if (schema && schema.type !== 'object') fail('horst-tool-shape', `tool "${n}" (${cap.key}) inputSchema.type must be "object"`);
  }
}

// Kinds: unique across modules and governance's own (mission.create).
const govKinds = new Set(Object.keys(require('./governance/horst-governance').KINDS));
const kindSeen = new Map();
for (const cap of caps) {
  for (const [k, d] of Object.entries(cap.horst.kinds)) {
    if (govKinds.has(k)) fail('horst-kind-collision', `capability "${cap.key}" declares kind "${k}", which is governance-internal`);
    if (kindSeen.has(k)) fail('horst-kind-collision', `kind "${k}" declared by both "${kindSeen.get(k)}" and "${cap.key}"`);
    kindSeen.set(k, cap.key);
    if (d.ceiling !== 'propose' && !d.about) fail('horst-kind-shape', `kind "${k}" (${cap.key}) can run without a human (ceiling ${d.ceiling}) and must carry an "about" line for the dials UI`);
    // 20: a kind with no identity() cannot be deduplicated — the same act
    // re-derived from a second email stages a second card, and an executed one
    // can be executed again. `identity: null` declares that is intended.
    if (!('identity' in d)) fail('horst-kind-identity', `kind "${k}" (${cap.key}) declares no "identity" — without an act key it can never be deduplicated (staging the same act twice, or repeating an executed one). Declare identity(payload, meta), or identity: null if repeats are legitimate`);
    // 21: an autonomous DEFAULT runs before anyone has read it. Only a
    // reversible or idempotent act may be shipped that way.
    if (String(d.defaultLevel || '').startsWith('auto') && !d.undo && !d.idempotent) {
      fail('horst-auto-irreversible', `kind "${k}" (${cap.key}) defaults to "${d.defaultLevel}" but declares neither undo nor idempotent — an owner who never opened the dials would have this run unattended with no way back. Declare idempotent: true (repeating converges) or undo: true (it can be reversed), or default it to propose`);
    }
  }
}

// --- 26: lanes ----------------------------------------------------------------
// Every member has Horst's stance, and the stance is backed: a direct member by
// a facet tool of its own module, a card member by a registered kind — or a
// reason in the module's own declaration (deferred / missing).
{
  const kindNames = new Set([...govKinds, ...kindSeen.keys()]);
  const toolNames = new Set([...brainToolNames, ...toolSeen.keys()]);
  for (const cap of caps) for (const msg of capabilities.laneProblems(cap, { kindNames, toolNames })) fail('horst-lane', msg);
}

// --- 18-19: spend metadata ----------------------------------------------------
// A metered capability must name the service module that gates it, bill every
// method in a declared unit, and have a default unit price (spend-pricing.js)
// unless the unit is tokens (priced by the model registry) or 'free'.
{
  const pricing = require('./spend-pricing');
  for (const cap of caps) {
    if (cap.cost !== 'metered') continue;
    if (!cap.spend || !cap.spend.service) { fail('cost-missing', `capability "${cap.key}" is metered but declares no spend.service`); continue; }
    const svc = path.join(ROOT, 'src', 'apps', cap.spend.service + '.js');
    let src = '';
    try { src = read(svc); } catch { fail('metered-ungated', `capability "${cap.key}" names spend.service "${cap.spend.service}" but src/apps/${cap.spend.service}.js does not exist`); }
    if (src && !/spendGate\.(authorize|wrap)\(/.test(src)) fail('metered-ungated', `capability "${cap.key}": src/apps/${cap.spend.service}.js never calls spendGate.authorize/wrap — its metered methods bypass the spend policy`);
    for (const m of cap.methods) {
      const unit = cap.spend.units[m];
      if (!unit) { fail('cost-missing', `metered method "${m}" (${cap.key}) has no spend.units entry`); continue; }
      if (unit === 'free' || unit === 'tokens') continue;
      if (!pricing.UNITS[unit]) fail('cost-missing', `metered method "${m}" (${cap.key}) uses unknown unit "${unit}"`);
      if (!pricing.DEFAULTS[m]) fail('cost-missing', `metered method "${m}" (${cap.key}) has no default unit price in spend-pricing.js`);
      else if (pricing.DEFAULTS[m].unit !== unit) fail('cost-missing', `metered method "${m}" (${cap.key}) is billed in "${unit}" but spend-pricing.js prices it per "${pricing.DEFAULTS[m].unit}"`);
    }
  }
}

// --- revocable: only modules an app can boot without ------------------------
// A revoked module is physically absent from the app's ctx (capabilities.js
// buildCtx). The members every routes.js may assume at setup — identity, db,
// settings, state, events, files, jobs, spend, capabilities — must therefore
// never be revocable, and a revocable module must be an owner service or a
// metered call (something the admin has a reason to take away per app).
{
  const NEVER = new Set(['identity', 'db', 'events', 'settings', 'state', 'files', 'jobs', 'spend', 'capabilities', 'fs', 'exec', 'cron', 'secrets', 'notify', 'dialogs', 'tasks', 'ui', 'tools', 'cli', 'http']);
  for (const cap of caps) {
    if (cap.revocable && NEVER.has(cap.key)) fail('revocable-core', `capability "${cap.key}" is revocable but apps rely on it at boot — grants may only remove owner services and metered calls`);
    if (cap.revocable && !cap.gated && cap.cost !== 'metered') fail('revocable-core', `capability "${cap.key}" is revocable but neither gated (an owner service) nor metered`);
  }
}

// --- 22: brief and summary shape ---------------------------------------------
// A `horst.brief` is the capability's one line in Horst's chat system prompt
// (PLATFORM CAPABILITIES, buildSystemPrompt in platform-horst.js); a `summary`
// is its one line in the section index every build prompt carries. The two
// texts are never compared — this rule is here so a renamed module cannot keep
// a brief that still names the old key, and so neither line can grow into a
// section that is re-paid on every prompt.
{
  const BRIEF_MAX = 250;
  const SUMMARY_MAX = 80;
  for (const cap of caps) {
    const brief = cap.horst.brief;
    if (brief) {
      if (!brief.startsWith(`${cap.key}:`)) {
        fail('horst-brief-shape', `capability "${cap.key}" declares a horst.brief that does not start with "${cap.key}:" — Horst reads the briefs as one unlabelled list, so a line naming another key (or none) is unattributable: "${brief.slice(0, 60)}…"`);
      }
      if (brief.length > BRIEF_MAX) {
        fail('horst-brief-shape', `capability "${cap.key}" has a ${brief.length}-character horst.brief (max ${BRIEF_MAX}) — a brief is one line of every chat system prompt, not a section`);
      }
    }
    const summary = (cap.summary || '').trim();
    if (!summary) {
      fail('summary-shape', `capability "${cap.key}" has no summary — the section index and capabilities_list would list it blank`);
    } else if (summary.length > SUMMARY_MAX) {
      fail('summary-shape', `capability "${cap.key}" has a ${summary.length}-character summary (max ${SUMMARY_MAX}) — the section index carries one line per capability into every build prompt`);
    }
  }
}

// --- 23: a capability's headings lie inside its own block ---------------------
// buildApiReference drops a whole <!-- API:SECTION key=… --> block unless the
// request mentions that key, and writeSidecars writes each block to
// `.vistaclair/api/<key>.md`. A heading a capability declares that sits outside
// its block (inline, or inside ANOTHER capability's block) is documentation the
// index points at but the sidecar does not hold. API:DETAIL blocks nested inside
// the right SECTION are fine: the stub keeps the heading, the sidecar the body.
const sectionRanges = [];
{
  const re = /<!-- API:SECTION key=([a-z-]+) -->\n([\s\S]*?)\n<!-- \/API:SECTION -->/g;
  for (let m = re.exec(reference); m; m = re.exec(reference)) {
    sectionRanges.push({ key: m[1], start: m.index, end: m.index + m[0].length, body: m[2] });
  }
  const sectionAt = (at) => sectionRanges.find((r) => at > r.start && at < r.end);
  for (const cap of caps) {
    for (const want of cap.headings || [cap.title]) {
      const hits = headings.filter((h) => headingMatches(h.text, want));
      if (!hits.length) continue; // rule 10 reports a missing heading
      // Another block may mention the same heading (telegram's mini-app pages
      // repeat "Identity & linking"); the section proper has to be in its own.
      if (hits.some((h) => (sectionAt(h.at) || {}).key === cap.key)) continue;
      const block = sectionAt(hits[0].at);
      fail('heading-outside-section',
        `capability "${cap.key}" declares the section "${want}", but that heading in prompts/_api-reference.md ` +
        (block ? `sits inside the <!-- API:SECTION key=${block.key} --> block` : 'sits outside every <!-- API:SECTION --> block') +
        ` — .vistaclair/api/${cap.key}.md would not hold it and the index would point at a heading no prompt contains`);
    }
  }
}

// What a prompt pays for an API:DETAIL block: app-builder-prompt's detailStub
// (the block's first heading plus a ~180-char pointer), mirrored here so the
// size rules measure the sliced text without requiring the prompt builder.
const detailStubRe = /<!-- API:DETAIL key=([a-z0-9-]+) -->\n([\s\S]*?)\n<!-- \/API:DETAIL -->\n?/g;
const detailStub = (match, key, body) => {
  const heading = body.match(/^(#{2,4} .+)/);
  return (heading ? heading[1] + '\n\n' : '') + ' '.repeat(180) + '\n\n';
};

// --- 24: a big block must be tiered, and its DETAIL keys must work -------------
// An API:SECTION block is paid in full by every session whose request mentions
// the capability — so past a certain size it needs a second tier: an API:DETAIL
// block, which the prompt replaces by its heading plus a pointer to
// `.vistaclair/api/<key>.md` (~300 chars instead of thousands). Measured AFTER
// that replacement, so a block that already tiers its depth is judged on what a
// prompt actually pays. The ceiling is deliberately generous: this catches a
// section that grew into a manual, not one that is merely thorough.
{
  const OPTIONAL_MAX = 12000;
  for (const r of sectionRanges) {
    const paid = r.body.replace(detailStubRe, detailStub).length;
    if (paid <= OPTIONAL_MAX) continue;
    fail('untiered-optional',
      `the <!-- API:SECTION key=${r.key} --> block in prompts/_api-reference.md costs ${paid} chars once inlined ` +
      `(max ${OPTIONAL_MAX}) — every session whose request mentions "${r.key}" pays all of it. Wrap the deep ` +
      `sub-sections in <!-- API:DETAIL key=… --> markers so they become a heading plus a pointer to .vistaclair/api/<key>.md`);
  }

  const detailRe = /<!-- API:DETAIL key=([a-z0-9-]+) -->\n([\s\S]*?)\n<!-- \/API:DETAIL -->/g;
  const seen = new Set();
  const bodies = [];
  for (let m = detailRe.exec(reference); m; m = detailRe.exec(reference)) {
    const key = m[1];
    // The key IS the sidecar filename and the pointer target: two blocks sharing
    // one key would write one file over the other.
    if (seen.has(key)) {
      fail('detail-block-shape', `two <!-- API:DETAIL key=${key} --> blocks share one key — both would write .vistaclair/api/${key}.md`);
    }
    seen.add(key);
    const start = m.index + `<!-- API:DETAIL key=${key} -->\n`.length;
    bodies.push({ key, start, end: start + m[2].length });
  }
  // detailStub keeps ONLY the block's first line if it is a heading. So a heading
  // a capability declares (rule 10, which reads the file whole) survives the slice
  // only when it opens its block — anywhere deeper and the section index points at
  // a heading no prompt contains.
  for (const cap of caps) {
    for (const want of cap.headings || [cap.title]) {
      for (const h of headings.filter((x) => headingMatches(x.text, want))) {
        const block = bodies.find((b) => h.at >= b.start && h.at < b.end);
        if (!block || h.at === block.start) continue;
        fail('detail-block-shape',
          `capability "${cap.key}" expects the section "${want}", but that heading sits INSIDE the ` +
          `<!-- API:DETAIL key=${block.key} --> block instead of opening it — the prompt keeps only a ` +
          `block's first heading, so this one is replaced by a pointer with no title`);
      }
    }
  }
  // That every one of those keys actually becomes a `.vistaclair/api/<key>.md`
  // file is asserted against a real writeSidecars run in test/read-ledger.test.js
  // — requiring the prompt builder here would drag the whole app runtime into a
  // static check.
}

// --- 25: the always-inline part of the reference stays small -------------------
// Everything outside the SECTION blocks (intro, Trust Model, Frontend Utilities,
// the bus intro, App APIs, the routes-ctx stub) plus the generated section index
// is what EVERY session pays before a single capability is inlined. That is the
// whole point of the deferral, so it is bounded here; the index separately, since
// it is one line per capability and grows with the registry.
{
  const BASICS_MAX = 10000;
  const index = capabilities.buildSectionIndex();
  if (index.length > capabilities.INDEX_MAX) {
    fail('reference-basics-size', `buildSectionIndex() is ${index.length} chars (max ${capabilities.INDEX_MAX}) — shorten summaries or the intro, every prompt carries it`);
  }
  const basics = reference
    .replace(/<!-- API:SECTION key=[a-z-]+ -->\n[\s\S]*?\n<!-- \/API:SECTION -->\n?/g, '')
    .replace(detailStubRe, detailStub)
    .replace(/<!-- \/?API:INDEX -->\n?/g, '')
    .replace('{{CAPABILITY_INDEX}}', index);
  if (basics.length > BASICS_MAX) {
    fail('reference-basics-size', `the always-inline part of prompts/_api-reference.md is ${basics.length} chars (max ${BASICS_MAX}) — move prose into the capability section that owns it`);
  }
}

// --- report ------------------------------------------------------------------

const byRule = new Map();
for (const p of problems) {
  if (!byRule.has(p.rule)) byRule.set(p.rule, []);
  byRule.get(p.rule).push(p.msg);
}

if (problems.length === 0) {
  const ctxMembers = new Set(caps.flatMap((c) => c.ctx));
  console.log(
    `capabilities OK — ${caps.length} capabilities (every section deferred), ` +
    `${claimed.size} bridge methods (${capabilities.dispatchedMethods().length} dispatched, ` +
    `${caps.filter((c) => c.external).reduce((n, c) => n + c.methods.length, 0)} external), ` +
    `${ctxMembers.size} ctx members, ` +
    `horst facet: ${senseSeen.size} senses, ${toolSeen.size} tools, ${kindSeen.size} kinds — all classified, documented, declarable and produced.`
  );
  process.exit(0);
}

console.error(`capability registry drift — ${problems.length} problem(s):\n`);
for (const [rule, msgs] of byRule) {
  console.error(`[${rule}]`);
  for (const m of msgs) console.error(`  - ${m}`);
  console.error('');
}
process.exit(1);
