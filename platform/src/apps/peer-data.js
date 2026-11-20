// Code bundles for master↔slave publishing: a `git archive` of one app's
// tracked tree at the master's HEAD, deployed by deployCode() below. The slave's apps dir is a plain
// directory (no git checkout) that may hold its own local apps — a deploy
// only ever replaces the published app's directory.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const appManager = require('./app-manager');
const { ensureDir } = require('../utils');

const BUNDLE_KEEP = 3;    // code bundles kept per app for rollback (5B)
const HISTORY_KEEP = 10;  // deploy history entries in .deployed.json

function incomingDir() {
  const dir = path.join(appManager.APPS_DIR, '.peer-incoming');
  ensureDir(dir);
  return dir;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (c) => { stderr += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.trim().slice(0, 400)}`));
    });
  });
}

// Per-host runtime state that never travels in a code bundle and must survive
// a deploy. Everything else in the app dir is replaced by the archive, so
// files deleted on the master really disappear here too. .peer-bundles holds
// the kept code bundles that make rollback possible — it must ride along.
const CODE_PRESERVE = ['.data', '.settings.json', '.host-config.json', '.sites.json', '.state.json', '.env', '.db-config.json', '.secrets_key', '.history', '.peer-backup', '.peer-bundles', 'node_modules'];

// Workspace material (`workspaces/<id>/`, cli.workspace): the tracked half
// (scripts, small data) rides in the bundle, the untracked half — sources,
// work files, published outputs — exists only on this host. So the swap
// carries over every workspace the bundle lacks and, inside a shipped one,
// every entry the bundle lacks; what the bundle ships replaces the local copy.
const WORKSPACES = 'workspaces';
function isDir(p) { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } }
function carryWorkspaces(appDir, srcDir) {
  const from = path.join(appDir, WORKSPACES);
  if (!isDir(from)) return;
  const to = path.join(srcDir, WORKSPACES);
  if (!fs.existsSync(to)) { fs.renameSync(from, to); return; }
  for (const ws of fs.readdirSync(from)) {
    const a = path.join(from, ws);
    const b = path.join(to, ws);
    if (!fs.existsSync(b)) { fs.renameSync(a, b); continue; }
    if (!isDir(a) || !isDir(b)) continue;
    for (const entry of fs.readdirSync(a)) {
      if (!fs.existsSync(path.join(b, entry))) fs.renameSync(path.join(a, entry), path.join(b, entry));
    }
  }
}

function bundlesDir(appDir) { return path.join(appDir, '.peer-bundles'); }
function bundlePathFor(appDir, commit) { return path.join(bundlesDir(appDir), `${commit}.tar.gz`); }

// Keep the newest BUNDLE_KEEP stored code bundles (by mtime; the bundle just
// written is always newest). Never remove the bundle of the CURRENT commit.
function pruneBundles(appDir, currentCommit) {
  try {
    const dir = bundlesDir(appDir);
    const entries = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const e of entries.slice(BUNDLE_KEEP)) {
      if (currentCommit && e.f === `${currentCommit}.tar.gz`) continue;
      fs.rmSync(path.join(dir, e.f), { force: true });
    }
  } catch {}
}

function readDeployedMeta(appDir) {
  try { return JSON.parse(fs.readFileSync(path.join(appDir, '.deployed.json'), 'utf-8')); } catch { return null; }
}

// Deploy an uploaded code bundle (git archive of `<app>/` at the master's
// HEAD) into this host's copy of the app. The caller has stopped the app and
// restarts it afterwards. May create the app dir — the first publish of an
// app lands on an empty slave.
//
// Versioning (5B): the incoming tarball is kept as
// .peer-bundles/<commit>.tar.gz (pruned to BUNDLE_KEEP) and .deployed.json
// carries a history of the last HISTORY_KEEP deploys, so rollbackCode() can
// re-install any kept bundle through this same swap path.
async function deployCode(appName, bundlePath, commit, handle) {
  const appDir = appManager.appDir(appName);
  const ts = Date.now();
  const extractDir = path.join(incomingDir(), `code-${appName}-${ts}`);
  const trashDir = path.join(incomingDir(), `replaced-${appName}-${ts}`);
  ensureDir(extractDir);
  const cleanup = () => {
    try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(trashDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(bundlePath, { force: true }); } catch {}
  };

  try {
    handle?.setProgress(10, 'Extracting code…');
    await run('tar', ['-xzf', bundlePath, '-C', extractDir]);
    const srcDir = path.join(extractDir, appName);
    if (!fs.existsSync(srcDir)) throw new Error(`bundle does not contain "${appName}/"`);
    if (!fs.existsSync(path.join(srcDir, 'manifest.json'))) {
      throw new Error(`bundle has no ${appName}/manifest.json — is the manifest committed on the master?`);
    }

    // Deploy history rides in .deployed.json, which the swap replaces — read
    // it before anything moves.
    const prevMeta = readDeployedMeta(appDir);
    const history = (prevMeta?.history || (prevMeta?.commit ? [{ commit: prevMeta.commit, deployedAt: prevMeta.deployedAt || null }] : []));

    handle?.setProgress(50, 'Installing code…');
    // The swap is one synchronous block: nothing — not even this job's own
    // jobs.json persistence, which recreates <appDir>/.data — may interleave
    // between carrying the runtime files over and the renames.
    if (fs.existsSync(appDir)) {
      for (const entry of fs.readdirSync(appDir)) {
        const keep = CODE_PRESERVE.includes(entry) || entry.endsWith('.enc');
        if (keep && !fs.existsSync(path.join(srcDir, entry))) {
          fs.renameSync(path.join(appDir, entry), path.join(srcDir, entry));
        }
      }
      carryWorkspaces(appDir, srcDir);
      fs.renameSync(appDir, trashDir);
      try {
        fs.renameSync(srcDir, appDir);
      } catch (err) {
        fs.renameSync(trashDir, appDir);
        throw err;
      }
    } else {
      fs.renameSync(srcDir, appDir);
    }
    const entry = { commit, deployedAt: Date.now() };
    fs.writeFileSync(path.join(appDir, '.deployed.json'), JSON.stringify({
      ...entry,
      history: [entry, ...history].slice(0, HISTORY_KEEP),
    }, null, 2));

    // Keep the bundle for rollback (copy — the caller's cleanup removes the
    // original). A failed copy never fails the deploy.
    try {
      ensureDir(bundlesDir(appDir));
      const kept = bundlePathFor(appDir, commit);
      if (fs.existsSync(bundlePath)) {
        fs.copyFileSync(bundlePath, kept);
        // Freshen mtime so re-deploying an old commit makes its bundle newest.
        const now = new Date();
        fs.utimesSync(kept, now, now);
      }
      pruneBundles(appDir, commit);
    } catch (err) {
      console.warn(`  Peer: keeping rollback bundle for "${appName}" failed:`, err.message);
    }

    handle?.setProgress(100, 'Code deployed');
    return { ok: true, commit };
  } finally {
    cleanup();
  }
}

// Roll an app back to a previously deployed commit whose bundle is still kept
// in .peer-bundles/. Same swap path as deployCode (CODE_PRESERVE honored), so
// runtime data stays put. Data is deliberately NOT rolled back — the schema
// may have moved forward; the response lists the .peer-backup timestamps an
// older data import left behind (nothing writes new ones).
async function rollbackCode(appName, commit, handle) {
  const appDir = appManager.appDir(appName);
  if (!fs.existsSync(appDir)) throw new Error(`app "${appName}" is not deployed here`);
  if (!/^[0-9a-f]{7,40}$/i.test(String(commit || ''))) throw new Error('malformed commit');
  const kept = bundlePathFor(appDir, commit);
  if (!fs.existsSync(kept)) {
    const have = availableBundles(appDir);
    throw new Error(`no stored bundle for ${String(commit).slice(0, 10)} — kept: ${have.length ? have.map((c) => c.slice(0, 10)).join(', ') : 'none'}`);
  }

  // deployCode consumes (deletes) its bundlePath — hand it a copy so the
  // stored bundle survives the rollback it powers.
  handle?.setProgress(5, 'Preparing rollback…');
  const work = path.join(incomingDir(), `rollback-${appName}-${Date.now()}.tar.gz`);
  fs.copyFileSync(kept, work);
  const result = await deployCode(appName, work, commit, handle);

  let dataBackups = [];
  try {
    dataBackups = fs.readdirSync(path.join(appDir, '.peer-backup')).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a));
  } catch {}
  return { ...result, rolledBack: true, dataBackups };
}

function availableBundles(appDir) {
  try {
    return fs.readdirSync(bundlesDir(appDir))
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => f.slice(0, -'.tar.gz'.length));
  } catch { return []; }
}

// Deploy history for one app on THIS host: current commit, past deploys, which
// of them still have a stored (rollback-able) bundle, and the .peer-backup/
// timestamps an older data import left behind. Served to the master by peer-server.
function deployHistory(appName) {
  const appDir = appManager.appDir(appName);
  const meta = readDeployedMeta(appDir);
  const bundles = new Set(availableBundles(appDir));
  const history = (meta?.history || (meta?.commit ? [{ commit: meta.commit, deployedAt: meta.deployedAt || null }] : []))
    .map((h) => ({ ...h, bundle: bundles.has(h.commit) }));
  let dataBackups = [];
  try {
    dataBackups = fs.readdirSync(path.join(appDir, '.peer-backup')).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a));
  } catch {}
  return {
    commit: meta?.commit || null,
    deployedAt: meta?.deployedAt || null,
    history,
    bundles: [...bundles],
    dataBackups,
  };
}

// Commit recorded by the last deployCode() for an app, or null.
function deployedCommit(appName) {
  try {
    return JSON.parse(fs.readFileSync(path.join(appManager.appDir(appName), '.deployed.json'), 'utf-8')).commit || null;
  } catch { return null; }
}

module.exports = { deployCode, rollbackCode, deployHistory, deployedCommit, incomingDir, CODE_PRESERVE };
