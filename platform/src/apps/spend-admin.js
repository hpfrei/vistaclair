// Admin-facing views and writes for spend policies — what the dashboard's
// Spend overview, the App Config → Spend section, the card tile and the header
// mode pill read, and what they save. Everything is a view of the same
// resolver (spend-policy) and the same ledger (spend-ledger); no surface can
// disagree with another.
const path = require('path');
const appManager = require('./app-manager');
const spendPolicy = require('./spend-policy');
const spendLedger = require('./spend-ledger');
const spendPricing = require('./spend-pricing');
const spendGate = require('./spend-gate');
const deploymentMode = require('./deployment-mode');

function appDir(name) { return path.join(appManager.APPS_DIR, name); }

// Header pill + mode modal.
function modePayload() {
  const d = deploymentMode.detect();
  const host = spendPolicy.loadHost();
  return { mode: d.mode, auto: d.auto, reason: d.reason, override: d.override, enforce: d.enforce, reviewNotice: !!host.reviewNotice };
}

// The capability rows of the permissions grid: what the manifest ADVERTISES
// (open-world: everything is available regardless — the declaration is
// documentation), what the admin revoked, the cost class and who may ever
// trigger it.
function capabilityRows(name, manifest, effective) {
  const capabilities = require('./capabilities');
  const decl = manifest && manifest.capabilities && typeof manifest.capabilities === 'object' ? manifest.capabilities : null;
  return capabilities.all()
    .filter((c) => c.gated || c.cost !== 'free')
    .map((c) => ({
      key: c.key,
      title: c.title,
      cost: c.cost,
      // Only a revocable module can be taken away per app (structurally absent
      // from the ctx, refused on the Bridge, blocked live when metered).
      revocable: !!c.revocable,
      ctxMembers: c.ctx,
      audiences: c.audiences,
      declared: decl ? capabilities.declarationSatisfies(decl, c.key) : false,
      legacy: !decl,
      revoked: !!(effective.grants && effective.grants[c.key] === false),
      methods: c.methods,
    }));
}

function effectiveFor(name, manifest, mode) {
  const e = spendPolicy.resolve(name, mode, manifest);
  return e;
}

// Everything the per-app Spend panel needs.
function appPayload(name, { days = 30 } = {}) {
  const manifest = appManager.readManifest(name) || {};
  const det = deploymentMode.detect();
  const admin = spendPolicy.get(name);
  const effective = { local: effectiveFor(name, manifest, 'local'), deployed: effectiveFor(name, manifest, 'deployed') };
  const summary = spendLedger.summary(name, { days }, appDir(name));
  return {
    app: name,
    mode: det.mode,
    enforce: det.enforce,
    admin,
    manifestSpend: manifest.spend || null,
    effective,
    now: effective[det.mode],
    status: spendGate.status(name, { principal: null }),
    summary,
    storage: { ...spendLedger.storageStatus(name, appDir(name)), capMB: (effective[det.mode].storage || {}).dailyMB ?? 'unlimited' },
    capabilities: capabilityRows(name, manifest, effective[det.mode]),
    pricing: spendPricing.sheet(),
    examples: examples(),
  };
}

// Worked examples from live prices, so "2000 credits" means something.
function examples() {
  const c = (usd) => Math.round(usd * spendPolicy.CREDITS_PER_USD);
  const t = spendPricing.price('ai.transcribe', 'gpt-4o-mini-transcribe', 10 / 60);
  const i = spendPricing.price('ai.image', 'gemini-3.1-flash-image', 1);
  const s = spendPricing.price('ai.webSearch', null, 1);
  return [
    { label: 'One 10-second transcription', credits: c(t.costUsd) },
    { label: 'One generated image', credits: c(i.costUsd) },
    { label: 'One web search', credits: c(s.costUsd) },
    { label: 'One short LLM turn (~2k in / 500 out on a mid-tier model)', credits: c(2000 * 3 / 1e6 + 500 * 15 / 1e6) },
  ];
}

// The Spend overview: one row per app, host policy, pricing sheet, mode.
function overview() {
  const det = deploymentMode.detect();
  const host = spendPolicy.loadHost();
  const rows = appManager.list().map((a) => {
    const manifest = appManager.readManifest(a.name) || {};
    const eff = effectiveFor(a.name, manifest, det.mode);
    const other = effectiveFor(a.name, manifest, det.mode === 'local' ? 'deployed' : 'local');
    const sum = spendLedger.summary(a.name, { days: 30 }, appDir(a.name));
    const capabilities = require('./capabilities');
    const decl = manifest.capabilities && typeof manifest.capabilities === 'object' ? manifest.capabilities : null;
    // "Spends on" = what the app plausibly spends: its advertisement, or every
    // metered capability when it advertises nothing (it may use any of them).
    const metered = capabilities.all().filter((c) => c.cost === 'metered' && (!decl || capabilities.declarationSatisfies(decl, c.key))).map((c) => c.key);
    const external = !decl || capabilities.declarationSatisfies(decl, 'http');
    return {
      app: a.name, running: !!a.running, access: require('./surfaces').accessLevel(a),
      preset: eff.preset, paused: eff.paused, source: eff.sources.profile, migrated: eff.migrated,
      otherMode: det.mode === 'local' ? 'deployed' : 'local', otherPreset: other.preset,
      today: sum.today, month: sum.month, window: sum.window, blocked: sum.blocked,
      appDayCap: eff.caps.app.day, appMonthCap: eff.caps.app.month,
      metered, external,
    };
  });
  return {
    mode: modePayload(),
    host: { local: spendPolicy.resolveHost('local'), deployed: spendPolicy.resolveHost('deployed'), enforce: host.enforce !== false, unitPrices: host.unitPrices || {} },
    hostSummary: spendLedger.summary('_host', { days: 30 }),
    platformSummary: spendLedger.summary('platform', { days: 30 }),
    rows,
    pricing: spendPricing.sheet(),
    examples: examples(),
  };
}

// Card tiles: today / 30d credits + the effective preset per app.
function gridMeta(names) {
  const det = deploymentMode.detect();
  const out = {};
  for (const name of names || []) {
    try {
      const manifest = appManager.readManifest(name) || {};
      const eff = effectiveFor(name, manifest, det.mode);
      const sum = spendLedger.summary(name, { days: 30 }, appDir(name));
      const st = spendLedger.storageStatus(name, appDir(name));
      out[name] = {
        preset: eff.preset, paused: eff.paused, today: sum.today.credits, window: sum.window.credits, cap: eff.caps.app.day, blocked: Object.values(sum.blocked).reduce((a, b) => a + b, 0),
        storageDelta: st.measuredAt ? st.deltaBytes : null, storageCapMB: (eff.storage || {}).dailyMB ?? 'unlimited',
      };
    } catch {}
  }
  return out;
}

function setPolicy(name, policy) {
  const mode = deploymentMode.mode();
  const before = spendPolicy.revokedCapabilities(name, mode);
  if (policy === null) { spendPolicy.remove(name); }
  else {
    const saved = spendPolicy.set(name, policy);
    // A saved policy ends the "migrated, please review" state for this app.
    if (saved.migrated) { delete saved.migrated; spendPolicy.set(name, { ...saved }); }
  }
  const after = spendPolicy.revokedCapabilities(name, mode);
  if (!sameSet(before, after)) broadcastRestartHint(name, 'Restart to apply the changed capability revocations');
  return spendPolicy.get(name);
}

function setHost(patch) {
  const p = { ...(patch || {}) };
  const prevMode = deploymentMode.mode();
  if (p.mode !== undefined) { deploymentMode.setOverride(p.mode); delete p.mode; }
  const saved = spendPolicy.saveHost(p);
  deploymentMode.invalidate();
  broadcastModeChangeHints(prevMode, deploymentMode.mode());
  return saved;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

// Revocations are applied when routes.js mounts, so a change reaches a running
// app only on restart. The dashboard shows the hint on the card (app:needRestart).
function broadcastRestartHint(name, reason) {
  const b = require('./core-services').core.broadcaster;
  if (b) b.broadcast({ type: 'app:needRestart', appName: name, reason });
}

// The mode flipped (override, domain, open flip, pairing): every app whose
// revoked set differs between the two modes now runs with the wrong one.
function broadcastModeChangeHints(prevMode, nextMode) {
  if (prevMode === nextMode) return;
  for (const a of appManager.list()) {
    if (!a || !a.running) continue;
    if (!sameSet(spendPolicy.revokedCapabilities(a.name, prevMode), spendPolicy.revokedCapabilities(a.name, nextMode))) {
      broadcastRestartHint(a.name, `Restart to apply the ${nextMode}-mode capability revocations`);
    }
  }
}

module.exports = { modePayload, appPayload, overview, gridMeta, setPolicy, setHost, examples, broadcastRestartHint, broadcastModeChangeHints };
