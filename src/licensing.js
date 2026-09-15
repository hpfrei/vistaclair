// VistaClair Pro licensing: license-server communication, signature
// verification, install/update of the Pro add-on, and the /api/pro/* routes.
//
// This module owns the license/network state (productInfo, customerPortalUrl,
// licenseInfo, proUpdateAvailable). The Pro *module lifecycle* (the loaded
// `pro` object, proLicenseValid, proClientModules) stays in server.js as the
// composition root and is bridged here via the `lifecycle` adapter passed to
// createLicenseRouter().

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const caps = require('./capabilities');

const OFFLINE_GRACE_DAYS = 7;

function createLicensing({ dataHome, isDev, env = process.env }) {
  const proDir = path.join(dataHome, 'vistaclair-pro');
  const LICENSE_SERVER = isDev
    ? env.DEV_LICENCING_SERVER
    : (env.PROD_LICENCING_SERVER || 'https://licencing.hpfreilabs.com');
  const PRODUCT_SLUG = env.HPFREILABS_PRODUCT || 'vistaclair-pro-subscription';

  // License/network state owned by this module.
  let productInfo = null;
  let customerPortalUrl = null;
  let licenseInfo = null;
  let proUpdateAvailable = false;
  let proUpdateInfo = null;
  let proUpdateError = null;

  function getMachineId() {
    const os = require('os');
    let raw = null;
    if (process.platform === 'linux') {
      try { raw = fs.readFileSync('/etc/machine-id', 'utf-8').trim(); } catch {}
    } else if (process.platform === 'darwin') {
      try {
        const out = require('child_process').execSync('ioreg -rd1 -c IOPlatformExpertDevice', { encoding: 'utf-8', timeout: 5000 });
        const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
        if (m) raw = m[1];
      } catch {}
    } else if (process.platform === 'win32') {
      try {
        const out = require('child_process').execSync('wmic csproduct get UUID', { encoding: 'utf-8', timeout: 5000 });
        const lines = out.trim().split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2 && lines[1] !== 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF') raw = lines[1];
      } catch {}
    }
    if (!raw) raw = os.hostname() + '|' + os.userInfo().username;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  function fetchSigningKey() {
    return new Promise((resolve, reject) => {
      const keyUrl = new URL('/api/signing-key', LICENSE_SERVER);
      const mod = keyUrl.protocol === 'https:' ? require('https') : require('http');
      const r = mod.request(keyUrl, { timeout: 10000 }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => resolve(data.trim()));
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
      r.end();
    });
  }

  function verifySignature(signedFields, signature, publicKeyPem) {
    if (!signature || !signedFields || !publicKeyPem) return false;
    try {
      const pubKey = crypto.createPublicKey(publicKeyPem);
      const canonical = JSON.stringify(signedFields);
      return crypto.verify(null, Buffer.from(canonical), pubKey, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }

  async function validateLicense() {
    const licPath = path.join(dataHome, 'data', 'license.json');
    if (!fs.existsSync(licPath)) return { valid: false, reason: 'no-key' };

    let stored;
    try { stored = JSON.parse(fs.readFileSync(licPath, 'utf-8')); } catch { return { valid: false, reason: 'corrupt' }; }
    if (!stored.key) return { valid: false, reason: 'no-key' };

    const machineId = getMachineId();

    try {
      const https = require('https');
      const licUrl = new URL('/api/validate', LICENSE_SERVER);
      const body = JSON.stringify({ key: stored.key, product: PRODUCT_SLUG, machineId });

      const response = await new Promise((resolve, reject) => {
        const mod = licUrl.protocol === 'https:' ? https : require('http');
        const r = mod.request(licUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 }, (resp) => {
          let data = '';
          resp.on('data', c => data += c);
          resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid response')); } });
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
        r.write(body);
        r.end();
      });

      if (response.valid && response.signature) {
        // Fetch and cache public key if we don't have it or if it changed
        if (!stored.signingKey) {
          try { stored.signingKey = await fetchSigningKey(); }
          catch (err) { console.warn('  Pro: signing-key fetch failed:', err.message); }
        }
        if (stored.signingKey && verifySignature(response.signedFields, response.signature, stored.signingKey)) {
          stored.lastValidation = response.signedFields;
          stored.lastSignature = response.signature;
          fs.writeFileSync(licPath, JSON.stringify(stored));
        }
      }

      const result = {
        valid: !!response.valid,
        reason: response.valid ? 'ok' : (response.error || 'invalid'),
        customerPortalUrl: response.customerPortalUrl || null,
        licenseInfo: response.valid ? {
          email: response.license?.email || null,
          expiresAt: response.license?.expiresAt || null,
          productName: response.product?.name || null,
        } : null,
      };
      // Cache for /status reads.
      if (result.customerPortalUrl) customerPortalUrl = result.customerPortalUrl;
      if (result.licenseInfo) licenseInfo = result.licenseInfo;
      return result;
    } catch {
      if (stored.lastValidation && stored.lastSignature && stored.signingKey) {
        if (verifySignature(stored.lastValidation, stored.lastSignature, stored.signingKey)) {
          const ageMs = Date.now() - new Date(stored.lastValidation.validatedAt).getTime();
          if (ageMs <= OFFLINE_GRACE_DAYS * 24 * 60 * 60 * 1000) {
            return { valid: true, reason: 'offline-grace' };
          }
          return { valid: false, reason: 'offline-grace-expired' };
        }
      }
      return { valid: false, reason: 'offline-no-cache' };
    }
  }

  async function fetchProductInfo() {
    try {
      const https = require('https');
      const infoUrl = new URL(`/api/product/group/${PRODUCT_SLUG}`, LICENSE_SERVER);
      const data = await new Promise((resolve, reject) => {
        const mod = infoUrl.protocol === 'https:' ? https : require('http');
        const r = mod.request(infoUrl, { timeout: 10000 }, (resp) => {
          let buf = '';
          resp.on('data', c => buf += c);
          resp.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error('Invalid response')); } });
        });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
        r.end();
      });
      productInfo = data;
    } catch {}
  }

  function rewriteGitUrl(url, auth) {
    const parsed = new URL(url);
    const target = new URL(LICENSE_SERVER);
    parsed.protocol = target.protocol;
    parsed.hostname = target.hostname;
    parsed.port = target.port;
    if (auth) parsed.username = auth.username;
    if (auth) parsed.password = auth.password;
    return parsed.toString();
  }

  function npmInstall(dir) {
    if (!fs.existsSync(path.join(dir, 'package.json'))) return;
    const { execFileSync } = require('child_process');
    console.log(`[pro] Installing dependencies in ${path.basename(dir)}...`);
    try {
      execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'pipe', timeout: 600000 });
      console.log(`[pro] Dependencies installed in ${path.basename(dir)}`);
    } catch (err) {
      const detail = (err.stderr || err.stdout || err.message || '').toString().trim().split('\n').slice(-5).join('\n');
      console.error(`[pro] npm install failed in ${path.basename(dir)}: ${detail}`);
      throw new Error(`Dependency install failed in ${path.basename(dir)}. Run 'npm install' there manually.`);
    }
  }

  function installPro(response, licenseKey) {
    const { execFileSync } = require('child_process');
    const creds = response.gitCredentials
      ? { username: encodeURIComponent(response.gitCredentials.username), password: encodeURIComponent(response.gitCredentials.password) }
      : null;

    if (!fs.existsSync(proDir)) {
      const cloneUrl = rewriteGitUrl(response.gitUrl, creds);
      const safeUrl = cloneUrl.replace(/:\/\/[^@]+@/, '://***@');
      console.log(`[pro] Cloning from ${safeUrl}`);
      try {
        execFileSync('git', ['clone', cloneUrl, 'vistaclair-pro'], { cwd: dataHome, stdio: 'pipe', timeout: 60000 });
        console.log('[pro] Clone successful');
      } catch (err) {
        console.error(`[pro] Clone failed: ${err.message}`);
        throw err;
      }
    }
    // Always install/refresh deps: a prior run may have cloned but failed here,
    // leaving the module unloadable (Cannot find module ...) and the GUI stuck
    // in a needsRestart loop.
    npmInstall(proDir);

    if (response.extras) {
      for (const extra of response.extras) {
        const dir = path.join(dataHome, extra.name);
        if (!fs.existsSync(dir)) {
          const extraUrl = rewriteGitUrl(extra.gitUrl, creds);
          try {
            execFileSync('git', ['clone', extraUrl, extra.name], { cwd: dataHome, stdio: 'pipe', timeout: 60000 });
          } catch (e) {
            if (!extra.optional) throw e;
            continue;
          }
        }
        try {
          npmInstall(dir);
        } catch (e) {
          if (!extra.optional) throw e;
        }
      }
    }

    ensureDir(path.join(dataHome, 'data'));
    fs.writeFileSync(path.join(dataHome, 'data', 'license.json'), JSON.stringify({ key: licenseKey, activatedAt: new Date().toISOString() }));
  }

  function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // --- Pro update lock -------------------------------------------------------
  // The explicit pref lives in data/app-prefs.json (proUpdatesDisabled). On top
  // of that, an install whose git origin does not point at the license server is
  // treated as a dev checkout (the maintained codebase) and is locked by
  // default — a stray click on Update must never overwrite the source of truth.

  // data/app-prefs.json is owned by capabilities.js — one reader/writer pair
  // for the file, not a second copy here.
  const readAppPrefs = () => caps.readAppPrefs(dataHome);

  function setProUpdatesDisabled(disabled) {
    const prefs = readAppPrefs();
    prefs.proUpdatesDisabled = !!disabled;
    ensureDir(path.join(dataHome, 'data'));
    caps.writeAppPrefs(dataHome, prefs);
  }

  function isDevInstall() {
    if (!fs.existsSync(proDir)) return false;
    try {
      const { execSync } = require('child_process');
      const originUrl = execSync('git remote get-url origin', { cwd: proDir, encoding: 'utf-8', timeout: 5000 }).trim();
      if (!/^https?:\/\//.test(originUrl)) return true; // ssh/local remote — never a licensed clone
      return new URL(originUrl).hostname !== new URL(LICENSE_SERVER).hostname;
    } catch {
      return false;
    }
  }

  // Resolve the effective lock. Explicit pref wins; unset falls back to
  // dev-install auto-detection.
  function getUpdateLock() {
    const pref = readAppPrefs().proUpdatesDisabled;
    const dev = isDevInstall();
    if (pref === true) return { disabled: true, reason: 'setting', devInstall: dev };
    if (pref === false) return { disabled: false, reason: null, devInstall: dev };
    if (dev) return { disabled: true, reason: 'dev-install', devInstall: true };
    return { disabled: false, reason: null, devInstall: false };
  }

  function gitCommitInfo(cwd, ref) {
    const { execSync } = require('child_process');
    const out = execSync(`git log -1 --format=%h%x1f%cI%x1f%s ${ref}`, { cwd, encoding: 'utf-8', timeout: 10000 }).trim();
    const [hash, date, subject] = out.split('\x1f');
    return { hash, date, subject };
  }

  function checkProUpdates() {
    if (!fs.existsSync(proDir)) return;
    try {
      const { execSync } = require('child_process');
      execSync('git fetch', { cwd: proDir, stdio: 'pipe', timeout: 30000 });
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: proDir, encoding: 'utf-8' }).trim();
      // left = commits only in upstream (behind), right = only in HEAD (ahead)
      const counts = execSync('git rev-list --left-right --count @{u}...HEAD', { cwd: proDir, encoding: 'utf-8' }).trim();
      const [behind, ahead] = counts.split(/\s+/).map(n => parseInt(n, 10) || 0);
      // Tracked changes only: untracked files (e.g. a .claude/ dir) survive a
      // reset, so counting them would flag an update forever.
      const dirty = execSync('git status --porcelain --untracked-files=no', { cwd: proDir, encoding: 'utf-8' }).trim().length > 0;
      // Compare CONTENT, not history: the update server republishes its
      // release commit, so a clone can be "1 behind, 1 ahead" while holding
      // byte-identical files. Equal tree hashes ⇒ nothing to update.
      let sameContent = false;
      try {
        const localTree = execSync('git rev-parse "HEAD^{tree}"', { cwd: proDir, encoding: 'utf-8' }).trim();
        const remoteTree = execSync('git rev-parse "@{u}^{tree}"', { cwd: proDir, encoding: 'utf-8' }).trim();
        sameContent = !!localTree && localTree === remoteTree;
      } catch {}
      // A licensed clone is a disposable MIRROR of the update server, not a
      // working repo: nothing the user authored lives here. Its "local
      // commits" are an artefact of how the server publishes (it can
      // republish/rewrite its release commit), so divergence is normal and is
      // resolved by resetting to the server — never by merging.
      const mirror = !isDevInstall();
      proUpdateInfo = {
        branch,
        ahead,
        behind,
        dirty,
        mirror,
        sameContent,
        local: gitCommitInfo(proDir, 'HEAD'),
        remote: gitCommitInfo(proDir, '@{u}'),
        checkedAt: new Date().toISOString(),
      };
      // A mirror should match the server exactly, so any real deviation —
      // different content or local modifications — is fixable by updating,
      // while a republished commit with an identical tree is not. A dev
      // checkout only counts commits it lacks; being ahead is unpushed work.
      proUpdateAvailable = mirror ? (dirty || !sameContent) : behind > 0;
      if (proUpdateAvailable) console.log(`[pro] Update available: ${behind} commit(s) behind${ahead ? `, ${ahead} ahead` : ''}${mirror && ahead ? ' (mirror — will reset to server)' : ''}`);
      proUpdateError = null;
    } catch (err) {
      // Surface the failure: swallowing it left the UI showing "Up to date"
      // while every fetch was failing.
      proUpdateError = ((err.stderr && err.stderr.toString()) || err.message || 'check failed').trim().slice(0, 400);
      console.warn('[pro] Update check failed:', proUpdateError);
    }
  }

  // Claim/activate share the same flow: POST to the license server, install on success.
  async function claimOrActivate(endpoint, payload) {
    const https = require('https');
    const os = require('os');
    const machineId = getMachineId();
    const body = JSON.stringify({ ...payload, product: PRODUCT_SLUG, machineId, hostname: os.hostname(), username: os.userInfo().username });
    const url = new URL(endpoint, LICENSE_SERVER);

    const response = await new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : require('http');
      const r = mod.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 30000 }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid response')); } });
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
      r.write(body);
      r.end();
    });

    if (!response.valid) return { ok: false, error: response.error || 'Activation failed' };
    installPro(response, response.key);
    return { ok: true };
  }

  /**
   * Build the /api/pro/* router. `lifecycle` bridges to the loaded-module state
   * that server.js owns:
   *   getPro(), getProLicenseValid(), setProLicenseValid(v),
   *   getProClientModules(), isProLoaded(), getPro().update(), scheduleRestart(),
   *   revalidate() → re-runs validateLicense and updates proLicenseValid.
   */
  function createLicenseRouter(lifecycle) {
    const router = express.Router();

    router.post('/pro/claim', async (req, res) => {
      const { orderId } = req.body;
      if (!orderId) return res.status(400).json({ error: 'Order ID required' });
      try {
        const result = await claimOrActivate('/api/claim', { orderId });
        if (!result.ok) return res.json(result);
        res.json({ ok: true, message: 'Pro activated. Restarting...' });
        lifecycle.scheduleRestart();
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    router.post('/pro/activate', async (req, res) => {
      const { key } = req.body;
      if (!key) return res.status(400).json({ error: 'License key required' });
      try {
        const result = await claimOrActivate('/api/activate', { key });
        if (!result.ok) return res.json(result);
        res.json({ ok: true, message: 'Pro activated. Restarting...' });
        lifecycle.scheduleRestart();
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    router.post('/pro/update', async (req, res) => {
      try {
        const { execSync } = require('child_process');
        if (!fs.existsSync(proDir)) return res.json({ ok: false, error: 'Pro not installed' });
        const lock = getUpdateLock();
        if (lock.disabled) {
          return res.status(403).json({
            ok: false,
            error: lock.reason === 'dev-install'
              ? 'Updates are disabled: this install is a development checkout (git origin is not the license server).'
              : 'Updates are disabled by setting on this machine.',
          });
        }
        const before = execSync('git rev-parse HEAD', { cwd: proDir, encoding: 'utf-8' }).trim();
        // A licensed mirror is hard-synced to the server (fast-forward can't
        // cross a republished release commit, and there is no local work to
        // preserve). A dev checkout only ever fast-forwards. Never `git clean`
        // in either case — node_modules and other untracked runtime files live
        // here. A failure must surface: silently reporting success made the
        // GUI claim "Already up to date" while nothing had been updated.
        try {
          if (isDevInstall()) {
            execSync('git pull --ff-only', { cwd: proDir, stdio: 'pipe', timeout: 30000 });
          } else {
            execSync('git fetch', { cwd: proDir, stdio: 'pipe', timeout: 30000 });
            execSync('git reset --hard @{u}', { cwd: proDir, stdio: 'pipe', timeout: 30000 });
          }
        } catch (err) {
          const detail = ((err.stderr && err.stderr.toString()) || err.message || '').trim().slice(0, 400);
          console.warn('  Pro: update failed:', detail);
          return res.status(500).json({ ok: false, error: `Update failed: ${detail}` });
        }
        const after = execSync('git rev-parse HEAD', { cwd: proDir, encoding: 'utf-8' }).trim();
        const pro = lifecycle.getPro();
        if (pro?.update) await pro.update();
        const updated = before !== after;
        proUpdateAvailable = false;
        checkProUpdates();
        res.json({ ok: true, updated, version: after.slice(0, 8) });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    router.post('/pro/update-lock', (req, res) => {
      const { disabled } = req.body || {};
      if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled (boolean) required' });
      try {
        setProUpdatesDisabled(disabled);
        res.json({ ok: true, updateLock: getUpdateLock() });
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    router.post('/pro/update-check', (req, res) => {
      checkProUpdates();
      res.json({ ok: true, updateAvailable: proUpdateAvailable, updateInfo: proUpdateInfo, updateError: proUpdateError, updateLock: getUpdateLock() });
    });

    router.get('/pro/status', async (req, res) => {
      if (req.query.check === '1') {
        await lifecycle.revalidate();
      }
      const installed = fs.existsSync(proDir);
      const proLicenseValid = lifecycle.getProLicenseValid();
      const loaded = lifecycle.isProLoaded();
      res.json({
        installed,
        licensed: proLicenseValid,
        loaded,
        clientModules: loaded ? lifecycle.getProClientModules() : undefined,
        needsRestart: installed && proLicenseValid && !loaded,
        updateAvailable: proUpdateAvailable,
        updateInfo: proUpdateInfo,
        updateError: proUpdateError,
        updateLock: installed ? getUpdateLock() : undefined,
        customerPortalUrl: proLicenseValid ? customerPortalUrl : undefined,
        licenseInfo: proLicenseValid ? licenseInfo : undefined,
        productInfo: (!loaded && !proLicenseValid) ? productInfo : undefined,
      });
    });

    router.post('/pro/restart', (req, res) => {
      if (!lifecycle.getProLicenseValid() || !fs.existsSync(proDir)) return res.status(400).json({ error: 'Not ready' });
      res.json({ ok: true });
      lifecycle.scheduleRestart();
    });

    return router;
  }

  return {
    proDir,
    LICENSE_SERVER,
    PRODUCT_SLUG,
    getMachineId,
    validateLicense,
    fetchProductInfo,
    installPro,
    npmInstall,
    checkProUpdates,
    getUpdateLock,
    createLicenseRouter,
    get proUpdateAvailable() { return proUpdateAvailable; },
    get proUpdateInfo() { return proUpdateInfo; },
    get proUpdateError() { return proUpdateError; },
    get productInfo() { return productInfo; },
  };
}

module.exports = { createLicensing };
