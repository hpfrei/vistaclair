#!/usr/bin/env node
// Snapshot the app-facing platform surface so a refactor of how it is BUILT can
// prove it did not change WHAT is built.
//
//   node test/gen-fixtures.js            # (re)write test/fixtures/*
//   node test/gen-fixtures.js --check    # regenerate in memory and diff
//
// Snapshots: the routes.js ctx for every profile (dashboard / public /
// standalone / standalone+auth.email) as a two-level shape listing, the set of
// bridge methods the platform dispatches, and the prompt text the capability
// registry generates. The fixtures were first taken from the pre-module code
// (the 1250-line bridge switch and the monolithic buildAppCtx); test/ctx-profiles
// and test/registry assert the module-based build reproduces them.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PRO = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

const APPS = [
  { name: 'fx-dash', manifest: {}, mode: 'dashboard', file: 'ctx-dashboard.json' },
  // admin grants revoke email + telegram (spend policy written by makeAppsDir)
  { name: 'fx-revoked', manifest: {}, mode: 'dashboard', file: 'ctx-revoked.json', revoked: ['email', 'telegram'] },
  { name: 'fx-standalone', manifest: {}, mode: 'standalone', file: 'ctx-standalone.json' },
  { name: 'fx-standalone-mail', manifest: { auth: { email: true } }, mode: 'standalone', file: 'ctx-standalone-mail.json' },
];

function kindOf(desc) {
  if (desc.get) return 'getter';
  const v = desc.value;
  if (typeof v === 'function') return 'function';
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

// Two-level shape: top-level member kind, and for plain objects their own keys
// with kinds. Values are never recorded (paths differ per machine).
function describe(ctx) {
  const out = {};
  for (const key of Object.keys(ctx).sort()) {
    const desc = Object.getOwnPropertyDescriptor(ctx, key);
    const kind = kindOf(desc);
    const entry = { kind };
    if (kind === 'object') {
      entry.keys = {};
      for (const k of Object.keys(desc.value).sort()) entry.keys[k] = kindOf(Object.getOwnPropertyDescriptor(desc.value, k));
    }
    out[key] = entry;
  }
  return out;
}

function makeAppsDir() {
  const dir = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-fixtures-'));
  // Admin grants live in the spend-policy store (dataHome); revoked modules are
  // structurally absent from the ctx, so the store is part of the fixture.
  const spendPolicy = require('../src/apps/spend-policy');
  spendPolicy.init({ dataHome: path.join(dir, '.data-home') });
  for (const app of APPS) {
    const d = path.join(dir, app.name);
    fs.mkdirSync(path.join(d, 'public'), { recursive: true });
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ name: app.name, ...app.manifest }, null, 2));
    fs.writeFileSync(path.join(d, 'routes.js'), 'module.exports = (router, ctx) => { global.__fxCtx = ctx; };\n');
    if (app.revoked) {
      const grants = Object.fromEntries(app.revoked.map((k) => [k, false]));
      spendPolicy.set(app.name, { local: { preset: 'unlimited', grants }, deployed: { preset: 'unlimited', grants } });
    }
  }
  return dir;
}

async function captureCtx(appManager) {
  const result = {};
  for (const app of APPS) {
    global.__fxCtx = null;
    const origWarn = console.warn;
    console.warn = () => {}; // app-auth mount without a DB warns; not part of the surface
    try {
      await appManager.mountRoutes(app.name, { broadcast() {} }, { mode: app.mode });
    } finally { console.warn = origWarn; }
    const ctx = global.__fxCtx;
    if (!ctx) throw new Error(`routes.js of ${app.name} was not invoked`);
    const shape = describe(ctx);
    const hasAuth = Object.prototype.hasOwnProperty.call(shape, 'auth');
    delete shape.auth; // present only when the auth module could mount (needs a DB)
    result[app.file] = { profile: app.mode === 'standalone' ? 'standalone' : 'dashboard', revoked: app.revoked || [], hasAuth, members: shape };
  }
  return result;
}

function bridgeMethodsFromSource() {
  const src = fs.readFileSync(path.join(PRO, 'src/apps/app-bridge.js'), 'utf-8');
  const found = new Set();
  const start = src.indexOf('function handleBridgeCall');
  if (start !== -1) {
    const sw = src.indexOf('switch (method)', start);
    const end = sw === -1 ? -1 : src.indexOf('\n}\n', sw);
    const body = src.slice(start, end === -1 ? undefined : end);
    for (const m of body.matchAll(/case '([a-z][a-zA-Z0-9_.]*)':/g)) found.add(m[1]);
  }
  const idx = fs.readFileSync(path.join(PRO, 'src/apps/index.js'), 'utf-8');
  for (const m of idx.matchAll(/msg\.method === '([a-z][a-zA-Z0-9_.]*)'/g)) found.add(m[1]);
  return [...found].sort();
}

// After the split the switch is gone; the registry itself is the method list.
function bridgeMethodsFromRegistry(capabilities) {
  const found = new Set();
  for (const cap of capabilities.all()) for (const m of cap.methods || []) found.add(m);
  return [...found].sort();
}

async function generate() {
  const appManager = require('../src/apps/app-manager');
  const capabilities = require('../src/apps/capabilities');
  const appsDir = makeAppsDir();
  appManager.setAppsDir(appsDir);
  const files = {};
  Object.assign(files, await captureCtx(appManager));
  const fromSource = bridgeMethodsFromSource();
  // Since the switch split, index.js dispatches only the external (CLI) methods,
  // so a source scan that finds just those is not the method list — the
  // registry is. The source path stays for a checkout that predates the split.
  const external = capabilities.all().filter((c) => c.external).reduce((n, c) => n + c.methods.length, 0);
  files['bridge-methods.json'] = fromSource.length > external ? fromSource : bridgeMethodsFromRegistry(capabilities);
  files['prompt-section-index.txt'] = capabilities.buildSectionIndex();
  files['prompt-capability-brief.txt'] = capabilities.buildCapabilityBrief();
  files['prompt-migration-rules.txt'] = capabilities.buildMigrationRules();
  // The normal Extend prompt, whole: an orchestration worker's lean prompt must never change it.
  Object.assign(files, require('./prompt-snapshot').extendPrompts());
  fs.rmSync(appsDir, { recursive: true, force: true });
  return files;
}

function serialize(name, value) {
  return name.endsWith('.json') ? JSON.stringify(value, null, 2) + '\n' : value;
}

async function main() {
  const check = process.argv.includes('--check');
  const files = await generate();
  fs.mkdirSync(FIXTURES, { recursive: true });
  let diffs = 0;
  for (const [name, value] of Object.entries(files)) {
    const text = serialize(name, value);
    const file = path.join(FIXTURES, name);
    if (check) {
      const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
      if (existing !== text) { diffs++; console.error(`DIFF ${name}`); }
    } else {
      fs.writeFileSync(file, text);
      console.log(`wrote ${path.relative(PRO, file)}`);
    }
  }
  if (check) {
    console.log(diffs ? `${diffs} fixture(s) differ` : 'fixtures match');
    process.exit(diffs ? 1 : 0);
  }
}

module.exports = { APPS, describe, makeAppsDir, captureCtx, bridgeMethodsFromSource, bridgeMethodsFromRegistry };

if (require.main === module) {
  main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
}
