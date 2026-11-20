#!/usr/bin/env node
// Capability ADVERTISEMENT — derive an app's manifest `capabilities` object
// from what its code actually uses. Open-world: the declaration never gates
// anything (every app gets the full platform surface) — it is documentation
// of what the app uses and a routing hint for platform tooling (docs
// inlining, the admin's spend panel, the MCP broker). Run it after building
// or changing an app to keep the advertisement honest.
//
//   node src/apps/capabilities-infer.js <appDir>            # report + diff
//   node src/apps/capabilities-infer.js <appDir> --write    # merge into manifest.json
//   node src/apps/capabilities-infer.js <appDir> --check    # report + what --write
//                                                          # would apply; exit 1 if any
//   node src/apps/capabilities-infer.js <appDir> --json
//
// Server side: routes.js, every file it (transitively) requires by relative
// path, and lib/**/*.js — `ctx.<member>` roots and `const { a, b } = ctx`.
// Client side: public/**/*.{js,html} (vendored bundles skipped) —
// `Bridge.call('<method>')` literals and the registry's runtime globals that
// the file does not itself declare. Every observed name maps through the
// capability registry (ctx list / method classification / runtime list).
//
// The derived advertisement names every substantive (gated:true in the
// registry's vocabulary) capability observed. It never removes a key the
// manifest already declares, and it never invents `microphone` (an iframe
// permission, not a platform capability) — an existing one is kept. Cosmetic /
// app-local capabilities are reported, not advertised.
//
// The same pass derives the manifest's `events` block (platform bus
// advertisement): `emits` from `ctx.events.declare([...])` and
// `ctx.events.emit('literal')`, `listens` from `ctx.events.subscribe(...)`
// and `Bridge.bus(...)` literals. `--write` merges it the same way — an
// existing `emits[kind]` (description/schema) wins, `listens` is unioned,
// and the block is omitted when both are empty.

const fs = require('fs');
const path = require('path');
const capabilities = require('./capabilities');
const { isVendored } = require('./app-lint');

const SKIP = new Set(['node_modules', '.git', '.data', '.vistaclair', 'public', 'dist', 'build', 'vendor']);
// The cli.workspace folders (`<appDir>/workspaces/`) are the app's material,
// not its code: never scanned, even when routes.js requires into one.
const WORKSPACES = 'workspaces';
const INFRA = new Set([...capabilities.LOADER_CTX_MEMBERS, 'isStandalone', 'auth', 'capabilities']);

function readOr(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } }
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

// ---- server scan ------------------------------------------------------------

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, base + '.js', path.join(base, 'index.js')]) {
    try { if (fs.statSync(cand).isFile()) return cand; } catch {}
  }
  return null;
}

function walkJs(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJs(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function serverFiles(appDir) {
  const seen = new Set();
  const queue = [path.join(appDir, 'routes.js'), ...walkJs(path.join(appDir, 'lib'))];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f) || !fs.existsSync(f)) continue;
    if (!path.resolve(f).startsWith(path.resolve(appDir) + path.sep)) continue;
    if (path.resolve(f).startsWith(path.resolve(appDir, WORKSPACES) + path.sep)) continue;
    seen.add(f);
    const src = readOr(f) || '';
    for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      if (m[1].endsWith('.json')) continue;
      const r = resolveRelative(f, m[1]);
      if (r && !r.includes(`${path.sep}node_modules${path.sep}`)) queue.push(r);
    }
  }
  return [...seen];
}

function scanServer(appDir) {
  const roots = new Map(); // member -> files
  const add = (name, file) => { if (!roots.has(name)) roots.set(name, new Set()); roots.get(name).add(path.relative(appDir, file)); };
  const files = serverFiles(appDir);
  for (const f of files) {
    const src = stripComments(readOr(f) || '');
    for (const m of src.matchAll(/(?<![\w$.])ctx\.([A-Za-z_$][\w$]*)/g)) add(m[1], f);
    for (const m of src.matchAll(/\{([^}]+)\}\s*=\s*ctx(?![\w$])/g)) {
      for (const part of m[1].split(',')) {
        const name = part.split(':')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) add(name, f);
      }
    }
  }
  return { files, roots };
}

// ---- client scan ------------------------------------------------------------

function walkPublic(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'vendor') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkPublic(p, out);
    else if (/\.(js|html)$/.test(e.name) && !/\.min\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

function scanClient(appDir) {
  const methods = new Map();   // method -> files
  const globals = new Map();   // runtime global -> files
  const dynamic = new Set();   // files with non-literal Bridge.call
  const runtimeNames = new Map();
  for (const cap of capabilities.all()) for (const g of cap.runtime || []) runtimeNames.set(g, cap.key);
  const add = (map, name, file) => { if (!map.has(name)) map.set(name, new Set()); map.get(name).add(path.relative(appDir, file)); };
  const files = walkPublic(path.join(appDir, 'public'));
  for (const f of files) {
    const raw = readOr(f) || '';
    if (isVendored(raw)) continue;
    const src = stripComments(raw);
    for (const m of src.matchAll(/Bridge\.call\(\s*(['"`])([a-z][\w.]*)\1/g)) add(methods, m[2], f);
    for (const m of src.matchAll(/Bridge\.call\(\s*(?!['"`])/g)) { void m; dynamic.add(path.relative(appDir, f)); }
    for (const [g] of runtimeNames) {
      const declared = new RegExp(`(?:function\\s+${g}\\s*\\(|(?:const|let|var)\\s+${g}\\b|\\b${g}\\s*[:=]\\s*(?:async\\s*)?(?:function|\\())`).test(src);
      if (declared) continue;
      if (new RegExp(`(?<![\\w$.])${g}\\s*\\(`).test(src)) add(globals, g, f);
    }
  }
  return { files, methods, globals, dynamic };
}

// ---- events (platform bus) ---------------------------------------------------

// The balanced-paren argument slice starting right after `open` (the index of
// the '(' itself). Strings are skipped so a ')' inside one does not end it.
function balancedSlice(src, open) {
  let depth = 0; let q = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  return src.slice(open + 1);
}

// First argument of a call as kind literals: 'a' → ['a'], ['a','b'] → both,
// anything else (a variable) → [].
function firstArgLiterals(argSlice) {
  const t = argSlice.trimStart();
  const one = t.match(/^(['"`])([^'"`]+)\1/);
  if (one) return [one[2]];
  if (t[0] !== '[') return [];
  const inner = balancedSlice(t, 0); // t starts with '[' → the bracket's inside
  return [...inner.matchAll(/(['"`])([^'"`]+)\1/g)].map((m) => m[2]);
}

// Every event literal in one source file (comments stripped by the caller):
//   declares  [{ kind, description, index }]  from events.declare([{ kind, description }])
//   emits     [{ kind, index }]               from events.emit('kind'
//   listens   [{ pattern, index }]            from events.subscribe('p' | ['p'], …) and Bridge.bus('p' | ['p'], …)
function extractEventLiterals(src) {
  const out = { declares: [], emits: [], listens: [] };
  for (const m of src.matchAll(/events\.declare\s*\(/g)) {
    const slice = balancedSlice(src, m.index + m[0].length - 1);
    for (const o of slice.matchAll(/\{[^{}]*\}/g)) {
      const kind = o[0].match(/\bkind\s*:\s*(['"`])([^'"`]+)\1/);
      if (!kind) continue;
      const desc = o[0].match(/\bdescription\s*:\s*(['"`])([^'"`]*)\1/);
      out.declares.push({ kind: kind[2], description: desc ? desc[2] : '', index: m.index + m[0].length + o.index });
    }
  }
  for (const m of src.matchAll(/events\.emit\s*\(\s*(['"`])([^'"`]+)\1/g)) out.emits.push({ kind: m[2], index: m.index });
  for (const m of src.matchAll(/(?:events\.subscribe|Bridge\.bus)\s*\(/g)) {
    for (const p of firstArgLiterals(balancedSlice(src, m.index + m[0].length - 1))) out.listens.push({ pattern: p, index: m.index });
  }
  return out;
}

// { emits: { kind: { description } }, listens: [pattern] } for the manifest.
function scanEvents(appDir) {
  const emits = {};
  const listens = new Set();
  for (const f of serverFiles(appDir)) {
    const lit = extractEventLiterals(stripComments(readOr(f) || ''));
    for (const d of lit.declares) if (!emits[d.kind] || (!emits[d.kind].description && d.description)) emits[d.kind] = { description: d.description };
    for (const e of lit.emits) if (!emits[e.kind]) emits[e.kind] = { description: '' };
    for (const l of lit.listens) listens.add(l.pattern);
  }
  for (const f of walkPublic(path.join(appDir, 'public'))) {
    const raw = readOr(f) || '';
    if (isVendored(raw)) continue;
    for (const m of stripComments(raw).matchAll(/Bridge\.bus\s*\(/g)) {
      for (const p of firstArgLiterals(balancedSlice(raw, m.index + m[0].length - 1))) listens.add(p);
    }
  }
  return { emits, listens: [...listens].sort() };
}

// Merge the derived block into the declared one: the manifest's descriptions
// and schemas win, listens are unioned, and nothing is ever removed.
function mergeEvents(declared, derived) {
  const emits = { ...((declared && declared.emits) || {}) };
  for (const [k, v] of Object.entries(derived.emits)) {
    if (!emits[k]) emits[k] = { description: v.description || '' };
    else if (typeof emits[k] === 'object' && !emits[k].description && v.description) emits[k] = { ...emits[k], description: v.description };
  }
  const listens = [...new Set([...((declared && declared.listens) || []), ...derived.listens])].sort();
  const out = {};
  if (Object.keys(emits).length) out.emits = emits;
  if (listens.length) out.listens = listens;
  return Object.keys(out).length ? out : null;
}

// ---- mapping ----------------------------------------------------------------

function infer(appDir) {
  const manifestPath = path.join(appDir, 'manifest.json');
  const manifest = JSON.parse(readOr(manifestPath) || '{}');
  const declared = manifest.capabilities && typeof manifest.capabilities === 'object' ? manifest.capabilities : null;

  const server = scanServer(appDir);
  const client = scanClient(appDir);
  const events = scanEvents(appDir);
  const declaredEvents = manifest.events && typeof manifest.events === 'object' ? manifest.events : null;

  const ctxOwner = new Map();
  for (const cap of capabilities.all()) for (const n of cap.ctx) ctxOwner.set(n, cap.key);

  // key -> { why: Set(evidence), files: Set(relFile) }. `why` names the tell,
  // `files` says where it was seen — the read ledger compares that against the
  // baseline a session started from.
  const used = new Map();
  const use = (key, why, files) => {
    if (!used.has(key)) used.set(key, { why: new Set(), files: new Set() });
    const u = used.get(key);
    u.why.add(why);
    for (const f of files) u.files.add(f);
  };
  const unmapped = [];

  for (const [name, files] of server.roots) {
    if (INFRA.has(name)) continue;
    const key = ctxOwner.get(name);
    if (key) use(key, `ctx.${name}`, files);
    else unmapped.push(`ctx.${name} (${[...files].join(', ')})`);
  }
  for (const [method, files] of client.methods) {
    const key = capabilities.capabilityKeyForMethod(method);
    if (key) use(key, `Bridge.call('${method}')`, files);
    else unmapped.push(`Bridge.call('${method}') (${[...files].join(', ')})`);
  }
  for (const [g, files] of client.globals) {
    const cap = capabilities.all().find((c) => (c.runtime || []).includes(g));
    if (cap) use(cap.key, `${g}()`, files);
  }

  const derived = {};
  const ungated = [];
  for (const key of capabilities.ORDER) {
    if (!used.has(key)) continue;
    if (capabilities.get(key).gated) derived[key] = true;
    else ungated.push(key);
  }
  if (declared && declared.microphone) derived.microphone = true;

  const diff = { add: [], keep: [], unobserved: [] };
  for (const key of Object.keys(derived)) (declared && declared[key] ? diff.keep : diff.add).push(key);
  for (const key of Object.keys(declared || {})) if (!derived[key]) diff.unobserved.push(key);

  return {
    appDir, manifestPath, manifest, declared, derived, diff, used, ungated, unmapped,
    events, declaredEvents, mergedEvents: mergeEvents(declaredEvents, events),
    dynamic: [...client.dynamic], serverFiles: server.files.map((f) => path.relative(appDir, f)), clientFiles: client.files.length,
    files: [...server.files, ...client.files].map((f) => path.relative(appDir, f)),
  };
}

// Which sidecar each file shows evidence of: { relFile: [key, …] }, every
// scanned file present (an empty list means "existed, used nothing"). Keys are
// capability keys plus the sidecars app-lint reconciles the same way: a
// cross-app tool (`apps/<name>`, from `ctx.tools.call('<name>'`) and the
// Telegram DETAIL surfaces (`telegram-miniapp` / `-identity` / `-auth`, only
// when the app uses telegram at all). A launch snapshots this into
// `inlined.json.baseline`, so a later lint can tell new use from old.
function evidenceByFile(result) {
  const out = {};
  for (const f of result.files) out[f] = [];
  for (const [key, u] of result.used) {
    for (const f of u.files) (out[f] ||= []).push(key);
  }
  const telegram = result.used.has('telegram');
  for (const f of result.files) {
    if (!/\.js$/.test(f)) continue;
    const src = stripComments(readOr(path.join(result.appDir, f)) || '');
    for (const m of src.matchAll(/ctx\.tools\.call\(\s*(['"`])([a-z][\w-]*)\1/g)) out[f].push(`apps/${m[2]}`);
    if (!telegram) continue;
    if (/\bapi\/app\b/.test(src)) out[f].push('telegram-miniapp');
    if (/\b(issueLinkCode|redeemLinkCode|issueSession|validateInitData)\b/.test(src) || /\bctx\.identity\b/.test(src)) out[f].push('telegram-identity');
    if (/\bapi\/auth\b/.test(src) || /\bapp-auth\b/.test(src) || /\bVistaAuth\b/.test(src)) out[f].push('telegram-auth');
  }
  if (telegram && fs.existsSync(path.join(result.appDir, 'public', 'app.html'))) (out['public/app.html'] ||= []).push('telegram-miniapp');
  for (const f of Object.keys(out)) out[f] = [...new Set(out[f])].sort();
  return out;
}

// The manifest `--write` would leave behind. Key order follows the existing
// manifest; a key it does not have is appended.
function nextManifest(result) {
  const manifest = { ...result.manifest, capabilities: { ...(result.declared || {}), ...result.derived } };
  if (result.mergedEvents) manifest.events = result.mergedEvents;
  else delete manifest.events;
  return manifest;
}

function writeManifest(result) {
  const manifest = nextManifest(result);
  fs.writeFileSync(result.manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return manifest.capabilities;
}

// What `--write` would change, as lines plus a `changed` verdict. The verdict
// compares the whole object (so a back-filled description counts), the lines
// name the parts a reader can act on.
function pending(result) {
  const next = nextManifest(result);
  const changed = JSON.stringify(next) !== JSON.stringify(result.manifest);
  const lines = [];
  for (const k of result.diff.add) lines.push(`+ capabilities.${k}`);
  const declaredEmits = (result.declaredEvents && result.declaredEvents.emits) || {};
  for (const k of Object.keys((next.events && next.events.emits) || {})) {
    if (!declaredEmits[k]) lines.push(`+ events.emits["${k}"]`);
  }
  const declaredListens = new Set((result.declaredEvents && result.declaredEvents.listens) || []);
  for (const p of (next.events && next.events.listens) || []) {
    if (!declaredListens.has(p)) lines.push(`+ events.listens["${p}"]`);
  }
  return { changed, lines };
}

function report(r) {
  const lines = [];
  lines.push(`${path.basename(r.appDir)} — scanned ${r.serverFiles.length} server file(s), ${r.clientFiles} client file(s)`);
  lines.push(`  manifest capabilities: ${r.declared ? JSON.stringify(r.declared) : 'none (nothing advertised)'}`);
  lines.push(`  derived advertisement: ${JSON.stringify(r.derived)}`);
  for (const k of r.diff.add) lines.push(`  + ${k}  ← ${[...r.used.get(k).why].join(', ')}`);
  for (const k of r.diff.keep) lines.push(`  = ${k}`);
  for (const k of r.diff.unobserved) lines.push(`  ? ${k}  (advertised, not observed — kept)`);
  if (r.ungated.length) lines.push(`  used, not worth advertising (app-local/cosmetic): ${r.ungated.join(', ')}`);
  if (r.unmapped.length) lines.push(`  unmapped: ${r.unmapped.join('; ')}`);
  const ek = Object.keys(r.events.emits);
  if (ek.length || r.events.listens.length) lines.push(`  events: emits ${ek.length ? ek.join(', ') : '—'}; listens ${r.events.listens.length ? r.events.listens.join(', ') : '—'}`);
  for (const k of ek) if (!r.events.emits[k].description && !(r.declaredEvents && r.declaredEvents.emits && r.declaredEvents.emits[k])) lines.push(`  ! ${k}  emitted but never declared (add it to ctx.events.declare or manifest.events.emits)`);
  if (r.dynamic.length) lines.push(`  non-literal Bridge.call in: ${r.dynamic.join(', ')} (review by hand)`);
  return lines.join('\n');
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  const json = argv.includes('--json');
  const appDir = path.resolve(args[0] || process.cwd());
  if (check && write) {
    console.error('--check and --write are exclusive (--check never writes)');
    return 2;
  }
  if (!fs.existsSync(path.join(appDir, 'manifest.json'))) {
    console.error(`no manifest.json in ${appDir}`);
    return 2;
  }
  const r = infer(appDir);
  const p = check ? pending(r) : null;
  if (json) {
    const out = { ...r, used: Object.fromEntries([...r.used].map(([k, v]) => [k, { why: [...v.why], files: [...v.files] }])), manifest: undefined };
    if (p) out.pending = p;
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(report(r));
  }
  if (write) {
    const caps = writeManifest(r);
    if (!json) console.log(`  wrote ${path.relative(process.cwd(), r.manifestPath)}: ${JSON.stringify(caps)}`);
  }
  if (p) {
    if (!json) {
      if (!p.changed) console.log('  manifest is true to the code — --write would change nothing.');
      else {
        console.log('  --write would apply:');
        for (const line of p.lines) console.log(`    ${line}`);
        if (!p.lines.length) console.log('    (descriptions / key order only)');
        console.log(`  run: node ${path.relative(process.cwd(), __filename)} ${args[0] || '.'} --write`);
      }
    }
    return p.changed ? 1 : 0;
  }
  return 0;
}

module.exports = { infer, evidenceByFile, report, writeManifest, nextManifest, pending, scanEvents, extractEventLiterals, mergeEvents };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
