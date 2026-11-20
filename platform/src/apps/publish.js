// Master-side "publish app to slave" orchestration + the app:peer:* /
// app:publish:* WS surface for the dashboard (including the key-sync messages,
// whose work lives in peer-keys.js).
//
// A publish runs as ONE persistent app-jobs job on the master (GUI-reload
// resilient: the wizard reattaches via app:publish:status and lives off the
// job:update broadcasts). The job drives the slave's /api/peer/* control plane:
//
//   preflight → commit/push if needed → enable on slave → pack this app's code
//   at HEAD (git archive) → stream to slave → slave swaps it in → forced npm
//   install → [toolchains: install the platform extras manifest.toolchains
//   names that the slave lacks] → restart on slave → health probe.
//
// App data never rides along: an app that copies data to a slave does so with
// the fleet data publish (fleet-data.js, docs/fleet-data.md).
//
// Code travels as a per-app bundle, never as a repo checkout: the slave's apps
// dir is a plain directory that may hold its own local apps, and only the
// published app's tracked files are ever replaced there.
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { exec: execCb } = require('child_process');
const hostConfig = require('./host-config');
const hostVersions = require('./host-versions');
const pairing = require('./peer-pairing');
const peerClient = require('./peer-client');
const peerData = require('./peer-data');
const peerKeys = require('./peer-keys');
const appManager = require('./app-manager');
const appJobs = require('./app-jobs');
const platformExtras = require('./platform-extras');

const execAsync = promisify(execCb);

let broadcaster = null;

const STEP_DEFS = [
  { key: 'preflight', label: 'Check git & peer' },
  { key: 'enable', label: 'Enable app on slave' },
  { key: 'code', label: 'Send code to slave' },
  { key: 'install', label: 'Install dependencies' },
  { key: 'toolchains', label: 'Install toolchains' },
  { key: 'restart', label: 'Restart app' },
  { key: 'health', label: 'Health check' },
];

let offFleetData = null;

function init(options) {
  broadcaster = options.broadcaster || null;
  offFleetData?.();
  offFleetData = null;
  if (broadcaster) {
    try {
      offFleetData = require('./fleet-data').subscribe((event, d) => {
        try {
          if (event === 'fleet:data:progress') {
            broadcaster.broadcast({ type: 'app:fleet:data:progress', transfer: {
              id: d.id, app: d.app, peer: d.peer, name: d.name, dir: d.dir === 'up' ? 'up' : 'down', status: 'running', phase: d.phase, label: d.label ?? null,
              sentBytes: d.sentBytes, needBytes: d.needBytes, blobs: d.blobs?.total, blobsNeed: d.blobs?.need, blobsDone: d.blobs?.done,
            } });
          } else {
            broadcaster.broadcast(dataTransfersMsg());
          }
        } catch {}
      });
    } catch (err) {
      console.warn('[publish] fleet data events not wired:', err.message);
    }
  }
}

// --- Data publishes on the peers panel (fleet-data.js, docs/fleet-data.md) ---
// The panel lists the master's persisted transfer records (so a reload
// reattaches), patches rows from the engine's progress events and cancels
// through the engine. Starting one belongs to the app's own UI. `dir: 'up'`
// rows are a slave's publishes to this master (docs/fleet-data-up.md).
function dataTransferRow(r) {
  return {
    id: r.id, app: r.app, peer: r.peer, name: r.name, dir: r.dir === 'up' ? 'up' : 'down', status: r.status, phase: r.phase, label: r.label ?? null,
    sentBytes: r.sentBytes ?? 0, needBytes: r.needBytes ?? null, totalBytes: r.totalBytes ?? null,
    blobs: r.blobs ?? null, blobsNeed: r.blobsNeed ?? null, blobsDone: r.blobsDone ?? 0,
    summary: r.summary ?? null, error: r.error ?? null,
    startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null, updatedAt: r.updatedAt ?? null,
  };
}

function dataTransfersMsg() {
  let transfers = [];
  try { transfers = require('./fleet-data').list({}).map(dataTransferRow); } catch {}
  return { type: 'app:fleet:data:list', transfers };
}

async function cancelDataTransfer(id) {
  const fleetData = require('./fleet-data');
  if (typeof id !== 'string' || !fleetData.status(id)) return { ok: false, error: 'unknown transfer' };
  try { return await fleetData.cancel(id); } catch (err) { return { ok: false, error: err.message }; }
}

function fmtBytes(n) {
  if (n == null) return null;
  if (n > 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  if (n > 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

// Publish only ships committed content (`git archive HEAD -- <app>/`), so a dirty
// app has to be committed first. The commit is scoped to this one app
// (`git add -- <app>/`), and so is this message: it is generated from that app's
// own porcelain counts. The wizard prefills it and the user can overwrite it; an
// empty box falls back to here rather than failing the run.
function defaultCommitMessage(appName, git) {
  const changed = (git?.modified || 0) + (git?.staged || 0);
  const bits = [];
  if (changed) bits.push(`${changed} modified`);
  if (git?.untracked) bits.push(`${git.untracked} new`);
  return `Publish ${appName}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

function latestPublishJob(appName) {
  return appJobs.listJobs(appName, { limit: 50 }).find((j) => j.name.startsWith('publish:')) || null;
}

function latestRollbackJob(appName) {
  return appJobs.listJobs(appName, { limit: 50 }).find((j) => j.name.startsWith('rollback:')) || null;
}

// What the wizard needs before the run: linked peers and the app's git state.
async function preflight(appName) {
  const git = await appManager.getGitStatus(appName);
  return {
    appName,
    ...pairing.listPeersPublic(),
    git,
    suggestedCommitMessage: git?.dirty ? defaultCommitMessage(appName, git) : null,
    toolchains: [].concat(appManager.readManifest(appName)?.toolchains || []),
    running: latestPublishJob(appName)?.status === 'running' ? latestPublishJob(appName) : null,
  };
}

// --- Toolchains: the platform extras manifest.toolchains names, on the slave ---
// The mapping and install order are platform-extras.js's (extrasForToolchains);
// the state and the install are the slave's own extras installer, reached via
// GET /extras and POST /extras/:id/install (peer-server.js). The slave's install
// record outlives this job: a cancelled or master-restarted publish leaves it
// running there, and the next publish attaches to it (install → alreadyRunning).
const EXTRA_POLL_MS = 5000;
const EXTRA_UNREACHABLE_MS = 5 * 60 * 1000;
const EXTRA_DEADLINE_MS = 8 * 3600 * 1000;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener?.('abort', done); resolve(); }
    signal?.addEventListener?.('abort', done, { once: true });
  });
}

async function slaveExtras(client, peer, ids, { signal, actions = false } = {}) {
  try {
    return await client.call(peer, `/extras?ids=${encodeURIComponent(ids.join(','))}${actions ? '&actions=1' : ''}`, { signal, timeoutMs: actions ? 120000 : 30000 });
  } catch (err) {
    if (err.status === 404) throw new Error(`${peer.name} cannot report its platform extras (HTTP 404) — update vistaclair-pro there`);
    throw err;
  }
}

// What publishing this app does to the slave's toolchains: one row per extra,
// in install order. state: present | install | installing | unknown (the
// slave's vistaclair-pro does not know the extra).
async function toolchainPlan(peer, toolchains, { signal, actions = false, client = peerClient } = {}) {
  const { ids, unknown } = platformExtras.extrasForToolchains(toolchains);
  if (!ids.length) return { ids, unknown, rows: [], actions: [] };
  const r = await slaveExtras(client, peer, ids, { signal, actions });
  const byId = new Map((r?.extras || []).map((e) => [e.id, e]));
  const rows = ids.map((id) => {
    const e = byId.get(id);
    if (!e) return { id, state: 'unknown' };
    return {
      id, title: e.title, size: e.size,
      state: e.installed ? 'present' : e.installing ? 'installing' : 'install',
      progress: e.progress || 0, label: e.label || '', lastError: e.error || null, sudoOk: e.sudoOk !== false,
    };
  });
  return { ids, unknown, rows, actions: r?.actions || [] };
}

// Wait for one extra's install on the slave to end. Progress is the slave's
// own (installer phases); a slave that stays unreachable for 5 minutes fails
// the wait, an install the slave lost (restart) fails with its error.
async function waitExtra(client, peer, id, { signal, onProgress, pollMs = EXTRA_POLL_MS, unreachableMs = EXTRA_UNREACHABLE_MS, deadlineMs = EXTRA_DEADLINE_MS } = {}) {
  const start = Date.now();
  let lastOk = start;
  for (;;) {
    if (signal?.aborted) throw new Error(`cancelled — the ${id} install keeps running on ${peer.name}`);
    let e;
    try {
      const r = await slaveExtras(client, peer, [id], { signal });
      e = (r?.extras || []).find((x) => x.id === id);
      lastOk = Date.now();
    } catch (err) {
      if (signal?.aborted) continue;
      if (Date.now() - lastOk > unreachableMs) throw new Error(`${peer.name} unreachable while installing ${id}: ${err.message}`);
      await sleep(pollMs, signal);
      continue;
    }
    if (!e) throw new Error(`${peer.name} no longer reports the ${id} extra`);
    if (!e.installing) {
      if (e.installed) return;
      throw new Error(`${id} install failed on ${peer.name}: ${e.error || 'it ended without the extra being detected'}`);
    }
    onProgress?.(e.progress || 0, e.label || '');
    if (Date.now() - start > deadlineMs) throw new Error(`${id} install on ${peer.name} still running after ${Math.round(deadlineMs / 3600000)} h — it keeps running there; publish again once it is done`);
    await sleep(pollMs, signal);
  }
}

// The `toolchains` step: present → skipped, missing → installed in order, a
// failed install fails the publish, an owner action the slave reports (the
// Unity licence) → a warning on the step and in the result, never silent.
async function ensureToolchains(peer, toolchains, { signal, onProgress, client = peerClient, waitOpts } = {}) {
  const plan = await toolchainPlan(peer, toolchains, { signal, client });
  const warnings = plan.unknown.map((k) => `unknown toolchain "${k}" in manifest.toolchains — ignored`);
  const present = [];
  const installed = [];
  const n = plan.rows.length;
  for (let i = 0; i < n; i++) {
    const row = plan.rows[i];
    if (row.state === 'unknown') throw new Error(`${peer.name} does not know the "${row.id}" extra — update vistaclair-pro there`);
    if (row.state === 'present') { present.push(row.id); continue; }
    onProgress?.(i, n, 0, `${row.id}: starting on ${peer.name}`);
    const r = await client.call(peer, `/extras/${encodeURIComponent(row.id)}/install`, { method: 'POST', signal });
    if (!r?.alreadyInstalled) {
      await waitExtra(client, peer, row.id, {
        signal,
        ...waitOpts,
        onProgress: (pct, label) => onProgress?.(i, n, pct, `${row.id} on ${peer.name}: ${label || 'installing'} (${pct}%)`),
      });
    }
    installed.push(row.id);
  }
  if (plan.ids.length) {
    const r = await slaveExtras(client, peer, plan.ids, { signal, actions: true });
    for (const a of r?.actions || []) warnings.push(`${peer.name}: ${a.action}`);
  }
  const bits = [];
  if (installed.length) bits.push(`installed ${installed.join(', ')}`);
  if (present.length) bits.push(`present ${present.join(', ')}`);
  return { present, installed, warnings, detail: [bits.join(' · ') || 'none', ...warnings.map((w) => `⚠ ${w}`)].join(' · ') };
}

function startPublish({ appName, peer: peerRef, commitMessage }) {
  if (hostConfig.isSlave()) throw new Error('This instance is a slave — publish from the master.');
  if (!appManager.readManifest(appName)) throw new Error(`unknown app "${appName}"`);
  const peer = pairing.getPeer(peerRef);
  if (!peer) throw new Error('unknown peer — link a slave first');
  const running = latestPublishJob(appName);
  if (running?.status === 'running') throw new Error('A publish for this app is already running');

  const declared = appManager.readManifest(appName).toolchains;
  const toolchains = Array.isArray(declared) ? declared : [];
  const steps = STEP_DEFS
    .filter((s) => toolchains.length || s.key !== 'toolchains')
    .map((s) => ({ ...s, status: 'pending', detail: null }));

  const { id } = appJobs.startJob(appName, {
    name: `publish:${peer.name}`,
    owner: 'platform',
    meta: { publish: true, peer: peer.name, peerUrl: peer.baseUrl, steps },
    run: async (job) => {
      const setStep = (key, status, detail) => {
        const s = steps.find((x) => x.key === key);
        if (s) { s.status = status; if (detail !== undefined) s.detail = detail; }
        job.setMeta({ steps });
      };
      const runStep = async (key, pct, fn) => {
        setStep(key, 'running');
        job.setProgress(pct, steps.find((s) => s.key === key)?.label);
        try {
          const out = await fn();
          // A step may finish as 'warn' ({ status, detail }): done, with something the owner must see.
          if (out && typeof out === 'object') setStep(key, out.status || 'done', out.detail ?? null);
          else setStep(key, 'done', out ?? null);
        } catch (err) {
          setStep(key, 'failed', err.message);
          throw err;
        }
      };

      let masterHead = null;
      const warnings = [];

      await runStep('preflight', 3, async () => {
        const ping = await peerClient.call(peer, '/ping', { signal: job.signal, timeoutMs: 15000 });
        if (ping.role !== 'slave') throw new Error(`peer "${peer.name}" is not in slave mode`);
        const git = await appManager.getGitStatus(appName);
        if (!git) throw new Error('vistaclair-apps is not a git repository');
        if (git.dirty) {
          // Only this app's files are staged; other apps' changes stay uncommitted.
          await appManager.gitCommit(appName, commitMessage?.trim() || defaultCommitMessage(appName, git));
        }
        const after = await appManager.getGitStatus(appName);
        if (after.dirty) throw new Error('App still has uncommitted changes after commit');
        if (after.ahead > 0) await appManager.gitPush();
        masterHead = (await execAsync('git rev-parse HEAD', { cwd: appManager.APPS_DIR, timeout: 5000 })).stdout.trim();
        return `at ${masterHead.slice(0, 10)}`;
      });

      await runStep('enable', 10, async () => {
        await peerClient.call(peer, `/apps/${appName}/enable`, { method: 'POST', signal: job.signal });
      });

      await runStep('code', 15, async () => {
        const tracked = (await execAsync(`git ls-files -- ${appName}/`, { cwd: appManager.APPS_DIR, timeout: 10000 })).stdout.trim();
        if (!tracked) throw new Error(`app "${appName}" has no committed files`);
        job.setProgress(15, 'Packing code…');
        const bundlePath = path.join(peerData.incomingDir(), `code-${appName}-${Date.now()}.tar.gz`);
        try {
          await execAsync(`git archive --format=tar.gz -o ${JSON.stringify(bundlePath)} HEAD -- ${appName}/`, { cwd: appManager.APPS_DIR, timeout: 120000 });
          const size = fs.statSync(bundlePath).size;
          const { jobId } = await peerClient.uploadFile(peer, `/apps/${appName}/code?commit=${masterHead}`, bundlePath, {
            signal: job.signal,
            onProgress: (sent, total) => {
              const pct = 16 + Math.round((sent / total) * 12);
              job.setProgress(pct, `Uploading code… ${fmtBytes(sent)} / ${fmtBytes(total)}`);
            },
          });
          const done = await peerClient.pollJob(peer, appName, jobId, {
            signal: job.signal,
            timeoutMs: 10 * 60 * 1000,
            onProgress: (pct, label) => job.setProgress(28, label || 'Deploying on slave…'),
          });
          if (done.result?.commit && done.result.commit !== masterHead) {
            throw new Error(`slave deployed ${String(done.result.commit).slice(0, 10)} instead of ${masterHead.slice(0, 10)}`);
          }
          return `${fmtBytes(size)} at ${masterHead.slice(0, 10)}`;
        } finally {
          try { fs.rmSync(bundlePath, { force: true }); } catch {}
        }
      });

      await runStep('install', 30, async () => {
        const { jobId } = await peerClient.call(peer, `/apps/${appName}/install`, { method: 'POST', signal: job.signal });
        const done = await peerClient.pollJob(peer, appName, jobId, {
          signal: job.signal,
          timeoutMs: 10 * 60 * 1000,
          onProgress: (pct, label) => job.setProgress(30, label || 'npm install…'),
        });
        return done.result?.skipped ? 'no package.json' : 'installed';
      });

      if (toolchains.length) {
        await runStep('toolchains', 31, async () => {
          const r = await ensureToolchains(peer, toolchains, {
            signal: job.signal,
            onProgress: (i, n, pct, label) => job.setProgress(31 + Math.round(13 * ((i + pct / 100) / n)), label),
          });
          warnings.push(...r.warnings);
          return { status: r.warnings.length ? 'warn' : 'done', detail: r.detail };
        });
      }

      await runStep('restart', 90, async () => {
        await peerClient.call(peer, `/apps/${appName}/restart`, { method: 'POST', signal: job.signal, timeoutMs: 120000 });
      });

      await runStep('health', 95, () => waitHealthy(peer, appName, job));

      job.setProgress(100, warnings.length ? 'Published — with warnings' : 'Published');
      return { ok: true, peer: peer.name, head: masterHead, warnings, appUrl: `${peer.baseUrl.replace(/\/+$/, '')}/apps/${appName}/` };
    },
  });
  return { jobId: id };
}

// Health poll shared by publish and rollback: the app must report healthy on
// the slave (and its self-probe must not fail) within the deadline.
async function waitHealthy(peer, appName, job, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    if (job.signal.aborted) throw new Error('cancelled');
    last = await peerClient.call(peer, `/apps/${appName}/status`, { signal: job.signal, timeoutMs: 10000 });
    if (last.health === 'ok' && last.probe?.ok !== false) {
      return last.probe ? `HTTP ${last.probe.status}` : 'running';
    }
    if (Date.now() > deadline) {
      throw new Error(`app is not healthy on the slave: ${JSON.stringify({ health: last.health, db: last.db, probe: last.probe })}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Roll an app on a peer back to a previously published commit (5B). Runs as
// one persistent master-side job like a publish (GUI-reload resilient via
// app:publish:rollbackStatus); the code swap happens on the slave from its
// kept .peer-bundles/<commit>.tar.gz. Data is NOT rolled back — the result
// carries any .peer-backup timestamps an older data import left on the slave.
function startRollback({ appName, peer: peerRef, commit }) {
  if (hostConfig.isSlave()) throw new Error('This instance is a slave — roll back from the master.');
  if (!appManager.readManifest(appName)) throw new Error(`unknown app "${appName}"`);
  const peer = pairing.getPeer(peerRef);
  if (!peer) throw new Error('unknown peer');
  if (!/^[0-9a-f]{7,40}$/i.test(String(commit || ''))) throw new Error('malformed commit');
  if (latestPublishJob(appName)?.status === 'running') throw new Error('A publish for this app is running — wait for it to finish');
  if (latestRollbackJob(appName)?.status === 'running') throw new Error('A rollback for this app is already running');

  const steps = [
    { key: 'preflight', label: 'Check peer' },
    { key: 'rollback', label: `Install ${String(commit).slice(0, 10)} on slave` },
    { key: 'restart', label: 'Restart app' },
    { key: 'health', label: 'Health check' },
  ].map((s) => ({ ...s, status: 'pending', detail: null }));

  const { id } = appJobs.startJob(appName, {
    name: `rollback:${peer.name}`,
    owner: 'platform',
    meta: { rollback: true, peer: peer.name, peerUrl: peer.baseUrl, commit, steps },
    run: async (job) => {
      const setStep = (key, status, detail) => {
        const s = steps.find((x) => x.key === key);
        if (s) { s.status = status; if (detail !== undefined) s.detail = detail; }
        job.setMeta({ steps });
      };
      const runStep = async (key, pct, fn) => {
        setStep(key, 'running');
        job.setProgress(pct, steps.find((s) => s.key === key)?.label);
        try {
          const detail = await fn();
          setStep(key, 'done', detail ?? null);
        } catch (err) {
          setStep(key, 'failed', err.message);
          throw err;
        }
      };

      let dataBackups = [];
      await runStep('preflight', 5, async () => {
        const ping = await peerClient.call(peer, '/ping', { signal: job.signal, timeoutMs: 15000 });
        if (ping.role !== 'slave') throw new Error(`peer "${peer.name}" is not in slave mode`);
      });
      await runStep('rollback', 15, async () => {
        const { jobId } = await peerClient.call(peer, `/apps/${appName}/rollback`, { method: 'POST', body: { commit }, signal: job.signal });
        const done = await peerClient.pollJob(peer, appName, jobId, {
          signal: job.signal,
          timeoutMs: 10 * 60 * 1000,
          onProgress: (pct, label) => job.setProgress(40, label || 'Rolling back on slave…'),
        });
        dataBackups = done.result?.dataBackups || [];
        return `now at ${String(commit).slice(0, 10)}`;
      });
      await runStep('restart', 80, async () => {
        await peerClient.call(peer, `/apps/${appName}/restart`, { method: 'POST', signal: job.signal, timeoutMs: 120000 });
      });
      await runStep('health', 90, () => waitHealthy(peer, appName, job));

      job.setProgress(100, 'Rolled back');
      return { ok: true, peer: peer.name, commit, dataBackups };
    },
  });
  return { jobId: id };
}

// One entry point for all app:peer:* / app:publish:* / app:fleet:* WS
// messages — returns true when the message was handled here.
async function handleWs(msg, send, bc) {
  switch (msg.type) {
    case 'app:peer:list':
      send({ type: 'app:peer:list', ...pairing.listPeersPublic() });
      return true;

    case 'app:peer:remove':
      pairing.removePeer(msg.id);
      send({ type: 'app:peer:list', ...pairing.listPeersPublic() });
      return true;

    case 'app:peer:test': {
      const peer = pairing.getPeer(msg.id);
      if (!peer) { send({ type: 'app:peer:testResult', id: msg.id, ok: false, error: 'unknown peer' }); return true; }
      try {
        const ping = await peerClient.call(peer, '/ping', { timeoutMs: 10000 });
        // Compare the slave's vc / vc-pro checkouts against this master's —
        // the GUI flags slaves running outdated software.
        let versions = null;
        try { versions = await hostVersions.compareToSlave(ping.versions); } catch {}
        send({ type: 'app:peer:testResult', id: msg.id, ok: true, ping, versions });
      } catch (err) {
        send({ type: 'app:peer:testResult', id: msg.id, ok: false, error: err.message });
      }
      return true;
    }

    // The master's own record of how far it believes a slave's data-publish
    // origin (fleet-data-up.js decide()). Default off.
    case 'app:peer:trustOwnerClicks':
      pairing.updatePeer(msg.id, { trustOwnerClicks: msg.value === true });
      send({ type: 'app:peer:list', ...pairing.listPeersPublic() });
      return true;

    case 'app:peer:access': {
      const peer = pairing.getPeer(msg.id);
      if (!peer) { send({ type: 'app:peer:accessResult', id: msg.id, ok: false, error: 'unknown peer' }); return true; }
      try {
        const r = await require('./peer-access').fetchAccess(peerClient, peer);
        send({ type: 'app:peer:accessResult', id: msg.id, ...r, url: r.url || peer.baseUrl });
      } catch (err) {
        send({ type: 'app:peer:accessResult', id: msg.id, ok: false, error: err.message });
      }
      return true;
    }

    // Key sync (peer-keys.js). The preview is what the confirm dialog shows —
    // provider names and counts only, never key values.
    case 'app:peer:keysPreview': {
      try {
        send({ type: 'app:peer:keysPreviewResult', id: msg.id, ok: true, preview: peerKeys.preview() });
      } catch (err) {
        send({ type: 'app:peer:keysPreviewResult', id: msg.id, ok: false, error: err.message });
      }
      return true;
    }

    case 'app:peer:keysStatus':
      send({ type: 'app:peer:keysStatus', peers: peerKeys.syncState() });
      return true;

    case 'app:peer:syncKeys': {
      try {
        const r = await peerKeys.syncToPeer(msg.id, { replace: !!msg.replace });
        send({ type: 'app:peer:keysResult', id: msg.id, ok: true, ...r });
      } catch (err) {
        send({ type: 'app:peer:keysResult', id: msg.id, ok: false, error: err.message });
      }
      return true;
    }

    case 'app:peer:restart':
    case 'app:peer:kill': {
      const op = msg.type === 'app:peer:kill' ? 'kill' : 'restart';
      const peer = pairing.getPeer(msg.id);
      if (!peer) { send({ type: 'app:peer:opResult', id: msg.id, op, ok: false, error: 'unknown peer' }); return true; }
      try {
        await peerClient.call(peer, `/${op}`, { method: 'POST', timeoutMs: 15000 });
        send({ type: 'app:peer:opResult', id: msg.id, op, ok: true });
      } catch (err) {
        send({ type: 'app:peer:opResult', id: msg.id, op, ok: false, error: err.message });
      }
      return true;
    }

    case 'app:peer:slaveStatus':
      send({ type: 'app:peer:slaveStatus', ...pairing.slaveStatus() });
      return true;

    case 'app:peer:slaveStart': {
      try {
        await pairing.startPairing({ name: msg.name, masterUrl: msg.masterUrl, publicUrl: msg.publicUrl });
        send({ type: 'app:peer:slaveStartResult', ok: true });
      } catch (err) {
        send({ type: 'app:peer:slaveStartResult', ok: false, error: err.message });
      }
      send({ type: 'app:peer:slaveStatus', ...pairing.slaveStatus() });
      return true;
    }

    // The remote-session opt-in (peer-remote-slave.js) — this dashboard is the
    // only place it changes; no rs:cmd and no /api/peer route touches it.
    case 'app:peer:remoteSessions':
      try { hostConfig.setRemoteSessions({ enabled: msg.enabled, allowApiKey: msg.allowApiKey }); } catch (err) {
        console.warn('[publish] remote sessions not changed:', err.message);
      }
      bc?.broadcast?.({ type: 'app:peer:slaveStatus', ...pairing.slaveStatus() });
      return true;

    case 'app:peer:slaveReset':
      pairing.resetPairing();
      send({ type: 'app:peer:slaveStatus', ...pairing.slaveStatus() });
      return true;

    case 'app:publish:preflight': {
      try {
        send({ type: 'app:publish:preflight', ...(await preflight(msg.name)) });
      } catch (err) {
        send({ type: 'app:publish:preflight', appName: msg.name, error: err.message });
      }
      return true;
    }

    // The wizard's per-peer toolchain plan: what the toolchains step will
    // install on the chosen slave, and what it will warn about.
    case 'app:publish:toolchains': {
      const reply = { type: 'app:publish:toolchains', appName: msg.name, peer: msg.peer };
      try {
        const peer = pairing.getPeer(msg.peer);
        if (!peer) throw new Error('unknown peer');
        const manifest = appManager.readManifest(msg.name);
        if (!manifest) throw new Error(`unknown app "${msg.name}"`);
        // setupUrl: the slave's own Setup → Extras, where its owner actions are done.
        send({ ...reply, setupUrl: `${peer.baseUrl.replace(/\/+$/, '')}/?setup=extras`, ...(await toolchainPlan(peer, manifest.toolchains, { actions: true })) });
      } catch (err) {
        send({ ...reply, error: err.message });
      }
      return true;
    }

    case 'app:publish:start': {
      try {
        const { jobId } = startPublish({ appName: msg.name, peer: msg.peer, commitMessage: msg.commitMessage });
        send({ type: 'app:publish:started', appName: msg.name, jobId });
      } catch (err) {
        send({ type: 'app:publish:started', appName: msg.name, error: err.message });
      }
      return true;
    }

    case 'app:publish:status':
      send({ type: 'app:publish:status', appName: msg.name, job: latestPublishJob(msg.name) });
      return true;

    case 'app:publish:cancel': {
      const job = msg.jobId ? appJobs.getJob(msg.name, msg.jobId) : latestPublishJob(msg.name);
      if (job) appJobs.cancelJob(msg.name, job.id);
      send({ type: 'app:publish:status', appName: msg.name, job: latestPublishJob(msg.name) });
      return true;
    }

    // Fleet (5B/5C): per-peer deploy history, rollback and the live fleet view.
    case 'app:publish:history': {
      const peer = pairing.getPeer(msg.peer);
      if (!peer) { send({ type: 'app:publish:history', peer: msg.peer, appName: msg.name, error: 'unknown peer' }); return true; }
      if (!appManager.readManifest(msg.name)) { send({ type: 'app:publish:history', peer: peer.name, appName: msg.name, error: `unknown app "${msg.name}"` }); return true; }
      try {
        const r = await peerClient.call(peer, `/apps/${msg.name}/history`, { timeoutMs: 15000 });
        send({ type: 'app:publish:history', peer: peer.name, appName: msg.name, ...r });
      } catch (err) {
        send({ type: 'app:publish:history', peer: peer.name, appName: msg.name, error: err.message });
      }
      return true;
    }

    case 'app:publish:rollback': {
      try {
        const { jobId } = startRollback({ appName: msg.name, peer: msg.peer, commit: msg.commit });
        send({ type: 'app:publish:rollbackStarted', appName: msg.name, peer: msg.peer, jobId });
      } catch (err) {
        send({ type: 'app:publish:rollbackStarted', appName: msg.name, peer: msg.peer, error: err.message });
      }
      return true;
    }

    case 'app:publish:rollbackStatus':
      send({ type: 'app:publish:rollbackStatus', appName: msg.name, job: latestRollbackJob(msg.name) });
      return true;

    case 'app:fleet:state':
      send({ type: 'app:fleet:state', ...(await require('./peer-channel').fleetStateDetailed()) });
      return true;

    case 'app:fleet:data:list':
      send(dataTransfersMsg());
      return true;

    // Owner cancel of a running data publish (the engine aborts the run and
    // clears the slave's inbox); every dashboard gets the new list.
    case 'app:fleet:data:cancel': {
      const r = await cancelDataTransfer(msg.id);
      send({ type: 'app:fleet:data:cancelResult', id: msg.id, ...r });
      send(dataTransfersMsg());
      return true;
    }
  }
  return false;
}

module.exports = { init, handleWs, STEP_DEFS, dataTransfersMsg, startPublish, startRollback, preflight, latestPublishJob, latestRollbackJob, toolchainPlan, ensureToolchains, waitExtra };
