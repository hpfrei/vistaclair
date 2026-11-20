// /api/peer/* — the master↔slave control channel. Mounted inside pro's router
// and declared auth-exempt at the core seam; every route self-authenticates
// (same pattern as the Telegram/WhatsApp webhooks):
//
//   Master-role routes (pairing intake, called by registering slaves):
//     POST /register                     body { name, publicUrl, token, pollSecret }
//     GET  /register/:id/status          header X-Vistaclair-Poll-Secret
//
//   Slave-role routes (control plane, called by the linked master):
//     header X-Vistaclair-Peer-Token on every request; long operations return
//     a job id backed by the standard app-jobs engine, polled via GET /jobs.
//     GET  /ping                         handshake { role, deployed, … }
//     GET  /access?v=2                   one-time dashboard login link + public URL
//     POST /restart                      whole-server restart (host restart path)
//     POST /kill                         emergency kill-switch — shuts vistaclair off
//     POST /keys                         apply the master's API keys + models
//     POST /apps/:name/enable|disable    maintain the enabled-apps allowlist
//     POST /apps/:name/code              streamed git-archive upload → deploy { jobId }
//     POST /pull                         legacy git pull --ff-only (pre-bundle masters)
//     POST /apps/:name/install           forced npm install → { jobId }
//     POST /apps/:name/data              streamed tar.gz upload → import { jobId }
//     POST /apps/:name/rollback          body { commit } — re-install a kept code bundle → { jobId }
//     GET  /apps/:name/history           deploy history + kept bundles + data backups
//     POST /apps/:name/restart           mount-cycle restart
//     GET  /apps/:name/status            app health + db + deps
//     GET  /jobs/:name/:id               job record (master's polling target)
//     GET  /extras?ids=a,b&actions=1     platform extras state (+ owner actions)
//     POST /extras/:id/install           start the extra's own installer
//     /fleet-data/:name/…                fleet data publish (fleet-data-receive.js,
//                                        docs/fleet-data.md): GET info, POST plan,
//                                        GET|DELETE /:transfer/:msha, PUT
//                                        /:transfer/:msha/blobs/:sha?offset=, POST
//                                        /:transfer/:msha/commit → { jobId }
//     /fleet-data-up/:name/…             the up direction (fleet-data-up.js,
//                                        docs/fleet-data-up.md): GET manifest,
//                                        GET a byte range of an offered blob
//     /fleet-remote/:name/…              fleet remote call / job (fleet-remote-host.js,
//                                        docs/fleet-remote.md): GET info, POST call,
//                                        POST jobs, GET|DELETE jobs/:job
const fs = require('fs');
const path = require('path');
const express = require('express');
const { promisify } = require('util');
const { exec: execCb, execFile: execFileCb } = require('child_process');
const hostConfig = require('./host-config');
const hostVersions = require('./host-versions');
const pairing = require('./peer-pairing');
const peerData = require('./peer-data');
const peerKeys = require('./peer-keys');
const appManager = require('./app-manager');
const appJobs = require('./app-jobs');
const appDb = require('./app-db');
const platformExtras = require('./platform-extras');
const fleetDataReceive = require('./fleet-data-receive');
const fleetDataManifest = require('./fleet-data-manifest');
const fleetRemoteHost = require('./fleet-remote-host');
const fleetRemoteWire = require('./fleet-remote-wire');

const execAsync = promisify(execCb);
const execFileAsync = promisify(execFileCb);
const VALID_APP_NAME = /^[a-z0-9][a-z0-9-]*$/;

// Auth-failure rate limiting (mirrors core's authLimiter): 10 bad attempts per
// client per minute, then 429 for the rest of the window. Only failures are
// limited: a correct token is checked first and always passes, so nobody can
// lock the master out. The channel upgrade (/api/peer/channel) counts into the
// same window.
const authFails = new Map(); // client ip → { count, windowStart }
const FAIL_LIMIT = 10;
const FAIL_WINDOW_MS = 60 * 1000;

function isLoopback(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1';
}

// The client the limiter counts: the TCP peer, or — behind a reverse proxy on
// this host (the TCP peer is loopback) — the hop that proxy appended last to
// X-Forwarded-For. Nobody else's X-Forwarded-For is believed.
function clientIp(req) {
  const sock = req?.socket?.remoteAddress || '?';
  if (!isLoopback(sock)) return sock;
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',').map((v) => v.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1].slice(0, 64) : sock;
}

function rateLimited(ip) {
  const now = Date.now();
  const entry = authFails.get(ip);
  if (!entry || now - entry.windowStart > FAIL_WINDOW_MS) return false;
  return entry.count >= FAIL_LIMIT;
}

function recordFail(ip) {
  const now = Date.now();
  const entry = authFails.get(ip);
  if (!entry || now - entry.windowStart > FAIL_WINDOW_MS) {
    authFails.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
  if (authFails.size > 1000) authFails.clear();
}

// Successful /register calls per IP (separate from the failure window).
const REGISTER_LIMIT = 5;
const REGISTER_WINDOW_MS = 3600 * 1000;
const registerOk = new Map();

function registerLimited(ip) {
  const e = registerOk.get(ip);
  return !!e && Date.now() - e.windowStart <= REGISTER_WINDOW_MS && e.count >= REGISTER_LIMIT;
}

function recordRegister(ip) {
  const now = Date.now();
  const e = registerOk.get(ip);
  if (!e || now - e.windowStart > REGISTER_WINDOW_MS) registerOk.set(ip, { count: 1, windowStart: now });
  else e.count++;
  if (registerOk.size > 1000) {
    for (const [k, v] of registerOk) if (now - v.windowStart > REGISTER_WINDOW_MS) registerOk.delete(k);
    if (registerOk.size > 1000) registerOk.delete(registerOk.keys().next().value);
  }
}

// One-time login link from core: POST /api/login/login-link is loopback-only
// and needs core's internal header (the same credential platform-cron uses).
// → { path: '/login/once?k=…', expiresInMs }.
async function mintLoginLinkViaCore({ authToken, port }) {
  if (!authToken) throw new Error('no core credential');
  const res = await fetch(`http://127.0.0.1:${port}/api/login/login-link`, {
    method: 'POST',
    headers: { 'x-vistaclair-internal': authToken },
    signal: AbortSignal.timeout(5000),
    redirect: 'manual',
  });
  if (!res.ok) throw new Error(`core answered HTTP ${res.status}`);
  const j = await res.json();
  if (typeof j?.path !== 'string' || !/^\/login\/once\?k=[0-9a-f]{64}$/.test(j.path)) throw new Error('core returned no login link');
  return { path: j.path, expiresInMs: Number(j.expiresInMs) || null };
}

function createPeerRouter(opts = {}) {
  const router = express.Router();
  const broadcaster = opts.broadcaster || null;
  const mintLoginLink = opts.mintLoginLink || (() => mintLoginLinkViaCore({
    authToken: opts.authToken,
    port: opts.dashboardPort || require('./core-services').core.dashboardPort || process.env.DASHBOARD_PORT || 3457,
  }));

  // ---- Pairing intake (this host as MASTER) --------------------------------

  router.post('/register', express.json({ limit: '32kb' }), (req, res) => {
    const ip = clientIp(req);
    if (rateLimited(ip)) return res.status(429).json({ error: 'too many attempts' });
    if (hostConfig.isSlave()) { recordFail(ip); return res.status(404).json({ error: 'not a master' }); }
    // Successful registrations are limited per IP too (each one files an
    // approval card and may push to Telegram).
    if (registerLimited(ip)) return res.status(429).json({ error: 'too many registrations — try again later' });
    const result = pairing.handleRegister(req.body || {});
    if (result.status !== 200) recordFail(ip);
    if (result.status !== 200) return res.status(result.status).json({ error: result.error });
    recordRegister(ip);
    res.json({ id: result.id });
  });

  router.get('/register/:id/status', (req, res) => {
    const ip = clientIp(req);
    const result = hostConfig.isSlave() ? { status: 404, error: 'not a master' }
      : pairing.handleRegisterStatus(req.params.id, req.headers['x-vistaclair-poll-secret'] || '');
    if (result.status === 200) return res.json({ status: result.requestStatus });
    if (rateLimited(ip)) return res.status(429).json({ error: 'too many attempts' });
    recordFail(ip);
    res.status(result.status).json({ error: result.error });
  });

  // ---- Control plane (this host as SLAVE) ----------------------------------

  router.use((req, res, next) => {
    // 404 (not 403) when unpaired or mis-roled: an unpaired host doesn't
    // advertise that a control plane exists at all.
    const paired = hostConfig.isSlave() && pairing.hasPeerToken();
    if (paired && pairing.verifyPeerToken(req.headers['x-vistaclair-peer-token'] || '')) return next();
    const ip = clientIp(req);
    if (rateLimited(ip)) return res.status(429).json({ error: 'too many attempts' });
    recordFail(ip);
    return paired ? res.status(403).json({ error: 'forbidden' }) : res.status(404).json({ error: 'not found' });
  });

  const appParam = (req, res) => {
    const name = req.params.name;
    if (!VALID_APP_NAME.test(name || '')) { res.status(400).json({ error: 'bad app name' }); return null; }
    return name;
  };

  router.get('/ping', async (req, res) => {
    // appsRepoHead is legacy (pull-based masters); bundle-deployed slaves
    // report per-app commits in `deployed` instead.
    let appsRepoHead = null;
    try { appsRepoHead = (await execAsync('git rev-parse HEAD', { cwd: appManager.APPS_DIR, timeout: 5000 })).stdout.trim(); } catch {}
    const deployed = {};
    for (const app of hostConfig.enabledApps() || []) {
      const commit = peerData.deployedCommit(app);
      if (commit) deployed[app] = commit;
    }
    let versions = null;
    try { versions = await hostVersions.getVersions(); } catch {}
    res.json({
      ok: true,
      role: hostConfig.role(),
      name: hostConfig.slaveInfo()?.name || null,
      appsRepoHead,
      deployed,
      versions,
      enabledApps: hostConfig.enabledApps() || [],
      dbConnected: !!appDb.getPool(),
    });
  });

  // Owner access to this slave's GUI: hand the master a short-lived, single-use
  // login link (core's /login/once, minted over loopback) and the public URL.
  // The permanent dashboard token never leaves this host. Only a master that
  // asks with ?v=2 gets an answer; an older master (which expected `token`)
  // gets a clear error instead.
  router.get('/access', async (req, res) => {
    if (req.query.v !== '2') {
      return res.status(426).json({ error: 'this slave no longer hands out its dashboard token: update the master (vc) to open its dashboard with a one-time login link' });
    }
    let link;
    try { link = await mintLoginLink(); } catch (err) {
      return res.status(502).json({ error: `could not mint a login link on this slave: ${err.message}` });
    }
    res.json({
      ok: true,
      loginPath: link.path,
      expiresInMs: link.expiresInMs,
      url: (hostConfig.slaveInfo()?.publicUrl || '').replace(/\/+$/, '') || null,
    });
  });

  // Provider API keys + model registry pushed by the master (peer-keys.js).
  // JSON parsed on this route only — the streamed upload routes below must keep
  // their raw bodies. The registry can hold dozens of models, hence 1mb.
  router.post('/keys', express.json({ limit: '1mb' }), (req, res) => {
    if (!peerKeys.canApply()) return res.status(501).json({ error: 'key sync not supported by this host build' });
    try {
      res.json({ ok: true, ...peerKeys.applyKeys(req.body) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Whole-server restart (distinct from /apps/:name/restart) — rides the
  // host's normal restart path, same as the dashboard's own restart flows.
  router.post('/restart', (req, res) => {
    if (typeof opts.scheduleRestart !== 'function') return res.status(501).json({ error: 'restart not supported by this host build' });
    res.json({ ok: true });
    console.log('  Peer: server restart requested by master');
    opts.scheduleRestart();
  });

  // Emergency kill-switch: turns vistaclair OFF on this slave. Under pm2 a
  // bare exit would be respawned, so ask pm2 to stop this process id first;
  // outside pm2 (or if the pm2 CLI is missing) a plain exit is the shutdown.
  router.post('/kill', (req, res) => {
    res.json({ ok: true });
    console.log('  Peer: KILL-SWITCH received from master — shutting down');
    setTimeout(() => {
      const pmId = process.env.pm_id;
      if (pmId !== undefined) {
        execFileCb('pm2', ['stop', String(pmId)], { timeout: 10000 }, () => process.exit(0));
        setTimeout(() => process.exit(0), 15000);
      } else {
        process.exit(0);
      }
    }, 300);
  });

  router.post('/apps/:name/enable', (req, res) => {
    const name = appParam(req, res); if (!name) return;
    const enabledApps = hostConfig.enableApp(name);
    try { broadcaster?.broadcast({ type: 'app:peer:slaveStatus', ...pairing.slaveStatus() }); } catch {}
    res.json({ ok: true, enabledApps });
  });

  router.post('/apps/:name/disable', async (req, res) => {
    const name = appParam(req, res); if (!name) return;
    const enabledApps = hostConfig.disableApp(name);
    try { await appManager.stopApp(name); } catch {}
    try { broadcaster?.broadcast({ type: 'app:peer:slaveStatus', ...pairing.slaveStatus() }); } catch {}
    res.json({ ok: true, enabledApps });
  });

  router.post('/pull', async (req, res) => {
    const git = async (...args) => (await execFileAsync('git', args, { cwd: appManager.APPS_DIR, timeout: 60000 })).stdout.trim();
    try {
      const before = await git('rev-parse', 'HEAD');
      let output = '';
      try {
        output = await git('pull', '--ff-only');
      } catch (err) {
        return res.status(409).json({ error: `git pull failed: ${(err.stderr || err.message || '').trim().slice(0, 500)}`, before });
      }
      const after = await git('rev-parse', 'HEAD');
      res.json({ ok: true, before, after, output: output.slice(0, 500) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Streamed code-bundle upload: raw tar.gz body, a `git archive` of the app's
  // tracked tree at the master's HEAD; ?commit= records what is being
  // deployed. Unlike /data this may CREATE the app dir — the first publish of
  // an app lands on a slave that has nothing on disk yet. The app is stopped
  // before the deploy job starts (stopApp aborts an app's running jobs, so
  // stopping inside the job would kill it).
  router.post('/apps/:name/code', (req, res) => {
    const name = appParam(req, res); if (!name) return;
    if (!hostConfig.isEnabled(name)) return res.status(409).json({ error: `app "${name}" is not enabled on this slave` });
    const commit = String(req.query.commit || '');
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) return res.status(400).json({ error: 'missing or malformed ?commit=' });

    const bundlePath = path.join(peerData.incomingDir(), `code-upload-${name}-${Date.now()}.tar.gz`);
    const out = fs.createWriteStream(bundlePath);
    let failed = false;
    const fail = (status, message) => {
      if (failed) return;
      failed = true;
      try { out.destroy(); } catch {}
      try { fs.rmSync(bundlePath, { force: true }); } catch {}
      if (!res.headersSent) res.status(status).json({ error: message });
    };
    req.on('error', (err) => fail(400, `upload failed: ${err.message}`));
    out.on('error', (err) => fail(500, `write failed: ${err.message}`));
    out.on('close', async () => {
      if (failed) return;
      try {
        try { await appManager.stopApp(name); } catch {}
        const { id } = appJobs.startJob(name, {
          name: 'peer:code-deploy',
          meta: { peer: true, bundleBytes: fs.statSync(bundlePath).size, commit },
          // The deployed bundle carries manifest.json — a changed `public` flag
          // must reach the auth-exempt patterns now, not at the next restart.
          run: (job) => peerData.deployCode(name, bundlePath, commit, job).then((result) => {
            if (typeof opts.rebuildPublicExemptions === 'function') {
              try { opts.rebuildPublicExemptions(); } catch {}
            }
            return result;
          }),
        });
        res.json({ jobId: id });
      } catch (err) {
        fail(500, err.message);
      }
    });
    req.pipe(out);
  });

  router.post('/apps/:name/install', (req, res) => {
    const name = appParam(req, res); if (!name) return;
    if (!hostConfig.isEnabled(name)) return res.status(409).json({ error: `app "${name}" is not enabled on this slave` });
    if (!fs.existsSync(appManager.appDir(name))) return res.status(404).json({ error: `app "${name}" not deployed yet — publish its code first` });
    const { id } = appJobs.startJob(name, {
      name: 'peer:install',
      meta: { peer: true },
      run: async (job) => {
        job.setProgress(10, 'npm install…');
        if (!fs.existsSync(path.join(appManager.appDir(name), 'package.json'))) {
          return { skipped: true, reason: 'no package.json' };
        }
        await execAsync('npm install', { cwd: appManager.appDir(name), timeout: 300000 });
        job.setProgress(100, 'Dependencies installed');
        return { ok: true };
      },
    });
    res.json({ jobId: id });
  });

  // Versioned rollback (5B): re-install a kept code bundle from
  // .peer-bundles/<commit>.tar.gz through the same swap path as a deploy
  // (CODE_PRESERVE honored). Data is NOT rolled back; the job result lists
  // any .peer-backup timestamps an older data import left behind.
  router.post('/apps/:name/rollback', express.json({ limit: '4kb' }), async (req, res) => {
    const name = appParam(req, res); if (!name) return;
    if (!hostConfig.isEnabled(name)) return res.status(409).json({ error: `app "${name}" is not enabled on this slave` });
    if (!fs.existsSync(appManager.appDir(name))) return res.status(404).json({ error: `app "${name}" not deployed yet` });
    const commit = String(req.body?.commit || '');
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) return res.status(400).json({ error: 'missing or malformed commit' });
    try {
      try { await appManager.stopApp(name); } catch {}
      const { id } = appJobs.startJob(name, {
        name: 'peer:rollback',
        meta: { peer: true, commit },
        run: (job) => peerData.rollbackCode(name, commit, job).then((result) => {
          // The restored bundle carries an older manifest.json — a reverted
          // `surfaces`/public flip must reach the auth exemptions now.
          if (typeof opts.rebuildPublicExemptions === 'function') {
            try { opts.rebuildPublicExemptions(); } catch {}
          }
          return result;
        }),
      });
      res.json({ jobId: id });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Deploy history + kept rollback bundles + data-backup timestamps (5B/5C).
  router.get('/apps/:name/history', (req, res) => {
    const name = appParam(req, res); if (!name) return;
    if (!fs.existsSync(appManager.appDir(name))) return res.status(404).json({ error: `app "${name}" not deployed yet` });
    try {
      res.json({ ok: true, ...peerData.deployHistory(name) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/apps/:name/restart', async (req, res) => {
    const name = appParam(req, res); if (!name) return;
    if (!hostConfig.isEnabled(name)) return res.status(409).json({ error: `app "${name}" is not enabled on this slave` });
    try {
      await appManager.restartApp(name, broadcaster);
      try { broadcaster?.broadcast({ type: 'app:list', apps: appManager.list() }); } catch {}
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.stack || err.message });
    }
  });

  router.get('/apps/:name/status', async (req, res) => {
    const name = appParam(req, res); if (!name) return;
    const status = appManager.getAppStatus(name);
    // The manager's own view: mounted/running. No HTTP self-fetch — a request
    // to the app would carry core's owner token (x-vistaclair-internal) into
    // app code, so the probe never authenticates against an app.
    const serving = !!(appManager.getMountedRouter(name) || appManager.getRunningApp(name)?.port);
    const probe = serving ? { ok: status.health === 'ok', source: 'app-manager' } : null;
    res.json({ ...status, enabled: hostConfig.isEnabled(name), probe });
  });

  router.get('/jobs/:name/:id', (req, res) => {
    const name = appParam(req, res); if (!name) return;
    const job = appJobs.getJob(name, req.params.id);
    if (!job) return res.status(404).json({ error: 'job not found' });
    const { id, status, progress, meta, result, error, createdAt, finishedAt } = job;
    res.json({ id, status, progress, meta, result, error, createdAt, finishedAt });
  });

  // Platform extras, for publish's `toolchains` step (publish.js). The state
  // is platformExtras.list() (probe + the installer's persisted progress); an
  // install is the same one Setup → Extras starts, so the Setup pane shows it
  // too, and its record is what the master polls (no second job). `actions`
  // asks for what an installed extra still needs from the owner here (the
  // Unity licence; may take a while — it asks the Unity CLI).
  router.get('/extras', async (req, res) => {
    const ids = String(req.query.ids || '').split(',').map((v) => v.trim()).filter(Boolean);
    try {
      const all = platformExtras.list();
      const extras = ids.length ? all.filter((e) => ids.includes(e.id)) : all;
      const actions = req.query.actions === '1' ? await platformExtras.ownerActions(extras.map((e) => e.id)) : [];
      res.json({ ok: true, extras, actions });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/extras/:id/install', (req, res) => {
    const id = String(req.params.id || '');
    if (!platformExtras.list().some((e) => e.id === id)) return res.status(404).json({ error: `unknown extra "${id}"` });
    try {
      res.json(platformExtras.install(id));
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  // ---- Fleet data publish (docs/fleet-data.md) -----------------------------
  // The receiver side of the master's fleet-data.js. Every answer of these
  // routes carries a `code`, so a master can tell a refusal from a slave whose
  // vc predates them (bare 404).
  const fd = (fn) => async (req, res) => {
    const name = appParam(req, res); if (!name) return;
    try {
      res.json({ ok: true, code: 'ok', ...(await fn(name, req)) });
    } catch (err) {
      if (err instanceof fleetDataReceive.FleetDataError) {
        return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
      }
      res.status(500).json({ error: err.message, code: 'error' });
    }
  };
  const manifestLimit = fleetDataManifest.MAX_MANIFEST_BYTES + 1024 * 1024;

  router.get('/fleet-data/:name', fd(async (name) => fleetDataReceive.info(name)));

  router.post('/fleet-data/:name/plan', express.json({ limit: manifestLimit }), fd(async (name, req) => {
    const b = req.body || {};
    return fleetDataReceive.plan(name, { name: b.name, manifest: b.manifest, sha: b.sha, open: b.open === true });
  }));

  router.get('/fleet-data/:name/:transfer/:msha', fd(async (name, req) => fleetDataReceive.status(name, req.params.transfer, req.params.msha)));

  // One chunk, streamed: ?offset=<n>, Content-Length ≤ CHUNK_MAX, raw body.
  router.put('/fleet-data/:name/:transfer/:msha/blobs/:sha', (req, res, next) => {
    const offset = /^\d{1,16}$/.test(String(req.query.offset ?? '')) ? Number(req.query.offset) : NaN;
    const lenHdr = req.headers['content-length'];
    const length = /^\d{1,16}$/.test(String(lenHdr ?? '')) ? Number(lenHdr) : NaN;
    if (length > fleetDataReceive.CHUNK_MAX) {
      // Refuse before reading; close so the unread body is not drained.
      res.set('Connection', 'close');
      return res.status(413).json({ error: `chunk over ${fleetDataReceive.CHUNK_MAX / 1048576} MB`, code: 'chunk-too-big' });
    }
    return fd(async (name) => fleetDataReceive.writeChunk(name, req.params.transfer, req.params.msha, req.params.sha, offset, length, req))(req, res, next);
  });

  router.post('/fleet-data/:name/:transfer/:msha/commit', fd(async (name, req) => fleetDataReceive.commit(name, req.params.transfer, req.params.msha)));

  router.delete('/fleet-data/:name/:transfer/:msha', fd(async (name, req) => fleetDataReceive.cancel(name, req.params.transfer, req.params.msha)));

  // ---- Fleet data publish, up direction (docs/fleet-data-up.md) -------------
  // This slave's own publishes to its master: the master (the token holder)
  // reads the manifest and pulls byte ranges of what the app offered, and
  // nothing else. Errors carry `code` like the routes above.
  const fdUp = () => require('./fleet-data-up');
  const upErr = (res, err) => {
    if (err instanceof fdUp().UpError) return res.status(err.status).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message, code: 'error' });
  };
  router.get('/fleet-data-up/:name/:transfer/:msha/manifest', (req, res) => {
    const name = appParam(req, res); if (!name) return;
    try { res.json({ ok: true, code: 'ok', ...fdUp().offered(name, req.params.transfer, req.params.msha) }); } catch (err) { upErr(res, err); }
  });
  router.get('/fleet-data-up/:name/:transfer/:msha/blobs/:sha', async (req, res) => {
    const name = appParam(req, res); if (!name) return;
    const int = (v) => (/^\d{1,16}$/.test(String(v ?? '')) ? Number(v) : NaN);
    let range;
    try { range = await fdUp().openRange(name, req.params.transfer, req.params.msha, req.params.sha, int(req.query.offset), int(req.query.length)); } catch (err) { return upErr(res, err); }
    res.status(200).set({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(range.length) });
    if (!range.length) return res.end();
    const stream = fs.createReadStream(range.file, { start: range.start, end: range.start + range.length - 1 });
    stream.on('error', () => res.destroy());
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  });

  // ---- Fleet remote call / job (docs/fleet-remote.md) -----------------------
  // The slave half of fleet-remote.js: the app named in the path only. Every
  // answer carries a `code` (a bare 404 = a slave predating these routes).
  const fr = (fn) => async (req, res) => {
    const name = appParam(req, res); if (!name) return;
    try {
      res.json({ ok: true, code: 'ok', ...(await fn(name, req, res)) });
    } catch (err) {
      if (err instanceof fleetRemoteHost.HostError) return res.status(err.status).json({ error: err.message, code: err.code });
      res.status(500).json({ error: fleetRemoteWire.cleanError(err), code: 'error' });
    }
  };
  const frJson = (req, res, next) => express.json({ limit: fleetRemoteWire.ARGS_MAX + 64 * 1024 })(req, res, (err) => {
    if (!err) return next();
    const big = err.type === 'entity.too.large';
    res.status(big ? 413 : 400).json({ error: big ? 'args over 256 KB' : 'bad JSON body', code: big ? 'too-large' : 'bad-request' });
  });

  router.get('/fleet-remote/:name', fr(async (name) => fleetRemoteHost.info(name)));

  router.post('/fleet-remote/:name/call', frJson, fr(async (name, req, res) => {
    // The master gave up (its timeout, its app stopped): abort the handler.
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    return fleetRemoteHost.call(name, req.body || {}, { signal: ac.signal });
  }));

  router.post('/fleet-remote/:name/jobs', frJson, fr(async (name, req) => fleetRemoteHost.startJob(name, req.body || {})));

  router.get('/fleet-remote/:name/jobs/:job', fr(async (name, req) => fleetRemoteHost.jobStatus(name, req.params.job)));

  router.delete('/fleet-remote/:name/jobs/:job', fr(async (name, req) => fleetRemoteHost.cancelJob(name, req.params.job)));

  return router;
}

// The limiter is shared with the channel upgrade (peer-channel.js handleUpgrade).
module.exports = { createPeerRouter, rateLimited, recordFail, clientIp };
