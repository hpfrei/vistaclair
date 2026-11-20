// Storage metering — how much NEW storage each app wrote today, and the one
// enforcement rule: alert, then pause. Never block an individual write —
// a mid-write failure corrupts app state; a paused app fails cleanly at its
// next metered call (the existing E_PAUSED path).
//
// The sweep runs as a persisted internal cron job (spend.storage-sweep,
// hourly — registered in index.js). Per app it measures
//
//   total = du(app dir) − du(node_modules) + database bytes
//
// and records it in the app's spend ledger (`storage` section: per-day
// first/last, so new-storage/day = last − first with the day's first
// measurement as the midnight baseline). The cap is `storage.dailyMB` in the
// same admin spend policy the credit caps live in (spend-policy.js).
//
// Breach handling (grace: the delta must be over cap on 2 consecutive
// measurements to avoid flapping): pause the app in its admin spend policy
// for the current mode, and emit through the spend gate's observer stream —
// which is already wired to the dashboard toast (app:spend:alert) and to
// Horst's `spend:storage:breach` sense. Attribution is per-app in v1;
// per-principal storage attribution is a future refinement.
const path = require('path');
const { execFile } = require('child_process');

function execAsync(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, ...opts }, (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

async function duBytes(dir) {
  try {
    const out = await execAsync('du', ['-sb', dir]);
    const m = /^(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

// One app's current total in bytes; null when the app dir is unreadable.
async function measure(name, appsDir, dbBytes) {
  const dir = path.join(appsDir, name);
  const all = await duBytes(dir);
  if (all == null) return null;
  const nm = await duBytes(path.join(dir, 'node_modules'));
  return Math.max(0, all - (nm || 0)) + (Number(dbBytes) || 0);
}

// Measure + record + enforce for one app. Split from sweep() for tests.
function check(name, bytes, appDir) {
  const spendLedger = require('./spend-ledger');
  const spendGate = require('./spend-gate');
  const deploymentMode = require('./deployment-mode');

  const st = spendLedger.recordStorage(name, bytes, appDir);
  const det = deploymentMode.detect();
  const profile = spendGate.policyFor(name, det.mode);
  const capMB = profile.storage ? profile.storage.dailyMB : 'unlimited';
  if (capMB === 'unlimited') {
    spendLedger.noteStorageOver(name, false, appDir);
    return { ...st, over: false, capMB };
  }
  const over = st.deltaBytes > Number(capMB) * 1e6;
  const overCount = spendLedger.noteStorageOver(name, over, appDir);
  // Fire exactly once per breach episode: on the measurement that ends the
  // grace window. The counter keeps rising while over, resets when back under.
  if (over && overCount === 2) {
    let paused = false;
    if (det.enforce && !profile.paused) {
      try { pauseApp(name, det.mode, profile); paused = true; }
      catch (err) { console.warn(`[storage] failed to pause ${name}: ${err.message}`); }
    }
    spendGate.reportStorageBreach({
      app: name, deltaBytes: st.deltaBytes, capMB: Number(capMB), bytes,
      mode: det.mode, paused,
    });
  }
  return { ...st, over, overCount, capMB };
}

// Persist the effective profile for the current mode into the admin layer with
// paused: true — the strongest layer, so the pause survives manifest changes.
function pauseApp(name, mode, profile) {
  const spendPolicy = require('./spend-policy');
  const admin = spendPolicy.get(name) || {};
  const prof = {
    preset: profile.preset, caps: profile.caps, overrides: profile.overrides,
    rate: profile.rate, alerts: profile.alerts, storage: profile.storage,
    grants: profile.grants || undefined, paused: true,
  };
  spendPolicy.set(name, { ...admin, [mode]: prof, note: `Paused ${new Date().toISOString().slice(0, 10)}: daily storage cap breached. Un-pause in Spend & permissions.` });
}

async function sweep() {
  const appManager = require('./app-manager');
  const names = appManager.list().map((a) => a.name);
  if (!names.length) return { ok: true, apps: 0 };
  let dbSizes = {};
  try { dbSizes = await require('./app-db').getAllDbSizes(); } catch {}
  let dirSizes = {};
  try { dirSizes = await appManager.getAllDirSizes(names); } catch {}
  let checked = 0;
  for (const name of names) {
    const dir = path.join(appManager.APPS_DIR, name);
    let bytes;
    if (dirSizes[name] != null) {
      const nm = await duBytes(path.join(dir, 'node_modules'));
      bytes = Math.max(0, dirSizes[name] - (nm || 0)) + (Number(dbSizes[name]) || 0);
    } else {
      bytes = await measure(name, appManager.APPS_DIR, dbSizes[name]);
    }
    if (bytes == null) continue;
    try { check(name, bytes, dir); checked++; }
    catch (err) { console.warn(`[storage] check failed for ${name}: ${err.message}`); }
  }
  return { ok: true, apps: checked };
}

module.exports = { sweep, check, measure };
