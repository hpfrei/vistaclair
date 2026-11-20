const mariadb = require('mariadb');
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let pool = null;
let config = null;
let configPath = null;
let readyPromise = Promise.resolve();
// Standalone-runner mode: pool authenticates as ONE app's provisioned per-app
// user (grants limited to its own database) instead of the admin user.
let appUserMode = null;

function friendlyDbError(err) {
  const m = err.message || '';
  if (m.includes('Access denied')) return `Access denied for user '${err.sqlMessage?.match(/'([^']+)'/)?.[1] || '?'}'. Check username and password.`;
  if (m.includes('pool failed to retrieve')) return `Cannot connect to MariaDB at the given host/port. Is the service running?`;
  if (m.includes('ECONNREFUSED')) return `Connection refused. MariaDB may not be running on this host/port.`;
  if (m.includes('ETIMEDOUT') || m.includes('connectTimeout')) return `Connection timed out. Check host and port.`;
  if (m.includes('Unknown database')) return `Database '${err.sqlMessage?.match(/'([^']+)'/)?.[1] || '?'}' does not exist.`;
  if (m.includes('ER_DBACCESS_DENIED')) return `User does not have access to the specified database.`;
  return m.split('\n')[0].slice(0, 120);
}

function init(appsDir) {
  configPath = path.join(appsDir, '.db-config.json');
  config = readConfig();
  if (config.host && config.user) {
    readyPromise = connectPoolWithRetry();
  }
}

// After an OS reboot the dashboard service can come up before MariaDB does —
// retry the boot connect for ~30s before giving up so the DB doesn't stay
// dormant until a manual db:connect.
async function connectPoolWithRetry(attempts = 6, delayMs = 5000) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await connectPool();
      return;
    } catch (err) {
      if (i === attempts) {
        console.error('  DB: Auto-connect failed:', friendlyDbError(err));
        notifyStatus({ up: false, host: config?.host || null, port: config?.port || null, error: friendlyDbError(err) });
        return;
      }
      console.warn(`  DB: Auto-connect attempt ${i}/${attempts} failed (${friendlyDbError(err)}), retrying in ${delayMs / 1000}s...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// Standalone-runner init: connect as the app's own provisioned DB user (from
// the .db-config.json `apps` map). The pool can only touch that app's database
// — the admin credentials never enter the runner process's pool.
function initAppUser(appsDir, appName) {
  configPath = path.join(appsDir, '.db-config.json');
  config = readConfig();
  const appCreds = getAppDb(appName);
  if (!appCreds) {
    console.warn(`  DB: No provisioned credentials for app '${appName}' — DB unavailable (provision from the dashboard first).`);
    return;
  }
  appUserMode = { appName, ...appCreds };
  readyPromise = connectPool().catch(err => {
    console.error('  DB: App-user connect failed:', friendlyDbError(err));
  });
}

// Settles once the boot-time auto-connect attempt finishes (success or
// failure); check getPool() afterwards. Lets dependents await instead of poll.
function ready() {
  return readyPromise;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return { host: 'localhost', port: 3306, user: '', password: '', database: '', apps: {} };
  }
}

function saveConfig(cfg) {
  config = { ...config, ...cfg };
  if (!config.apps) config.apps = {};
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

async function connectPool() {
  if (pool) {
    try { await pool.end(); } catch {}
    pool = null;
  }
  const p = mariadb.createPool({
    host: config.host || 'localhost',
    port: config.port || 3306,
    user: appUserMode ? appUserMode.user : config.user,
    password: appUserMode ? appUserMode.password : config.password,
    ...(appUserMode ? { database: appUserMode.database } : {}),
    connectionLimit: 10,
    connectTimeout: 5000,
  });
  try {
    const conn = await p.getConnection();
    conn.release();
  } catch (err) {
    try { await p.end(); } catch {}
    throw err;
  }
  pool = p;
  console.log(`  DB: Connected to ${config.host}:${config.port}`);
  notifyStatus({ up: true, host: config.host || null, port: config.port || null });
}

// onStatus(fn({ up, host, port, error? })) — connection transitions: a
// successful connect, a boot auto-connect that gave up, a disconnect.
// Returns an unsubscribe function. Feeds Horst's db:up / db:down senses.
const statusObservers = [];
function onStatus(fn) {
  statusObservers.push(fn);
  return () => { const i = statusObservers.indexOf(fn); if (i >= 0) statusObservers.splice(i, 1); };
}
function notifyStatus(event) {
  for (const fn of statusObservers) { try { fn(event); } catch (err) { console.warn('[db] status observer failed:', err.message); } }
}

async function connect(cfg) {
  saveConfig(cfg);
  try {
    await connectPool();
  } catch (err) {
    throw new Error(friendlyDbError(err));
  }
  return { ok: true };
}

async function testConnection(cfg) {
  let testPool;
  try {
    testPool = mariadb.createPool({
      host: cfg.host || 'localhost',
      port: cfg.port || 3306,
      user: cfg.user,
      password: cfg.password,
      connectionLimit: 1,
      connectTimeout: 5000,
    });
    const conn = await testPool.getConnection();
    const rows = await conn.query('SELECT 1 AS ok');
    conn.release();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyDbError(err) };
  } finally {
    if (testPool) try { await testPool.end(); } catch {}
  }
}

async function query(sql, params, database) {
  if (!pool) throw new Error('Database not connected. Configure in Apps > Setup.');
  const conn = await pool.getConnection();
  try {
    if (database) await conn.query(`USE \`${database.replace(/`/g, '``')}\``);
    const rows = await conn.query(sql, params);
    if (Array.isArray(rows)) {
      const plain = rows.map(r => ({ ...r }));
      if (rows.meta) plain.meta = rows.meta;
      return plain;
    }
    return { affectedRows: Number(rows.affectedRows), insertId: Number(rows.insertId), warningStatus: rows.warningStatus };
  } finally {
    conn.release();
  }
}

// `status()` is what app code (Bridge `db.status`) and Horst (`db_status`) see:
// it never carries the admin password. 2026-11-01: the admin pool itself is
// still handed to in-process apps (capabilities/db.js getDb); narrowing that to
// per-app users is planned (security review A2-H5), not done here.
function status() {
  return {
    connected: !!pool,
    config: config ? { host: config.host, port: config.port, user: config.user } : null,
  };
}

// Dashboard-WebSocket variant for the owner's Setup UI only (public/apps.js
// prefills the password field from it). Never expose this through the Bridge,
// Horst tools or any app-reachable route.
function statusForOwnerUi() {
  const s = status();
  if (s.config) s.config.password = config.password;
  return s;
}

function isConfigured() {
  return !!(config && config.user);
}

async function disconnect() {
  if (pool) {
    try { await pool.end(); } catch {}
    pool = null;
    notifyStatus({ up: false, host: config?.host || null, port: config?.port || null, error: 'disconnected' });
  }
  return { ok: true };
}

function getPool() {
  return pool;
}

function getConfig() {
  return config;
}

// --- Per-app database provisioning ---

function sanitizeDbName(appName) {
  return 'vc_' + appName.replace(/[^a-z0-9]/g, '_');
}

function generatePassword() {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

function getAppDb(appName) {
  if (!config?.apps) return null;
  return config.apps[appName] || null;
}

function getProvisionedApps() {
  return config?.apps || {};
}

// Map of appName → on-disk bytes (data + index) for each provisioned app's DB.
// One grouped query against information_schema; apps without a DB are omitted.
async function getAllDbSizes() {
  if (!pool || !config?.apps) return {};
  const byDbName = {};
  for (const [appName, info] of Object.entries(config.apps)) {
    if (info?.database) byDbName[info.database] = appName;
  }
  const names = Object.keys(byDbName);
  if (names.length === 0) return {};
  try {
    const placeholders = names.map(() => '?').join(',');
    const rows = await query(
      `SELECT table_schema AS db, SUM(data_length + index_length) AS bytes
       FROM information_schema.TABLES
       WHERE table_schema IN (${placeholders})
       GROUP BY table_schema`,
      names,
    );
    const sizes = {};
    // Provisioned-but-empty DBs have no rows in information_schema.TABLES → report 0.
    for (const appName of Object.values(byDbName)) sizes[appName] = 0;
    for (const r of rows || []) {
      const appName = byDbName[r.db];
      if (appName) sizes[appName] = Number(r.bytes) || 0;
    }
    return sizes;
  } catch {
    return {};
  }
}

// startApp, provisionMounted, ctx.provisionDb, the app:status handler and the
// db.provision bridge method can all fire for the same app at once. Without
// this, two callers both pass the config guard, both generate a password, and
// the second's CREATE USER IF NOT EXISTS silently no-ops while still writing
// its password to the config — leaving credentials that MariaDB never had.
const provisioning = new Map();

function provisionApp(appName) {
  if (!pool) return Promise.resolve(null);
  if (!config.apps) config.apps = {};
  if (config.apps[appName]) return Promise.resolve(config.apps[appName]);

  const inFlight = provisioning.get(appName);
  if (inFlight) return inFlight;

  const p = doProvisionApp(appName).finally(() => provisioning.delete(appName));
  provisioning.set(appName, p);
  return p;
}

async function doProvisionApp(appName) {
  const dbName = sanitizeDbName(appName);
  const userName = dbName;
  const password = generatePassword();

  const conn = await pool.getConnection();
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await conn.query(`CREATE USER IF NOT EXISTS '${userName}'@'localhost'`);
    // ALTER unconditionally: CREATE USER IF NOT EXISTS ... IDENTIFIED BY is a
    // no-op on an existing user, so the password we're about to persist has to
    // be applied separately or the config drifts from reality.
    await conn.query(`ALTER USER '${userName}'@'localhost' IDENTIFIED BY ?`, [password]);
    await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${userName}'@'localhost'`);
    await conn.query('FLUSH PRIVILEGES');
  } finally {
    conn.release();
  }

  config.apps[appName] = { database: dbName, user: userName, password };
  saveConfig(config);
  console.log(`  DB: Provisioned database '${dbName}' for app '${appName}'`);
  return config.apps[appName];
}

// Called on app DELETION only (stop/rename preserve the database). Drops the
// app's database, its dedicated user, and the config entry together — leaving
// any one behind means an app re-created under the same name silently inherits
// the old data, and abandoned databases/users accumulate forever.
//
// Destructive and irreversible: the app's data is gone. Returns
// { ok: false, reason } instead of throwing when there is nothing to do.
async function deprovisionApp(appName) {
  // A provision racing a delete would re-create what we just dropped.
  const inFlight = provisioning.get(appName);
  if (inFlight) await inFlight.catch(() => {});

  const info = config?.apps?.[appName];
  if (!info) return { ok: false, reason: 'not-provisioned' };
  // Without a pool we can't drop anything — keep the config entry so the
  // database stays discoverable (and reclaimable) rather than orphaning it.
  if (!pool) return { ok: false, reason: 'db-offline', ...info };

  const conn = await pool.getConnection();
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${info.database.replace(/`/g, '``')}\``);
    await conn.query(`DROP USER IF EXISTS '${info.user.replace(/'/g, "''")}'@'localhost'`);
    await conn.query('FLUSH PRIVILEGES');
  } finally {
    conn.release();
  }

  delete config.apps[appName];
  saveConfig(config);
  console.log(`  DB: Dropped database '${info.database}' and user '${info.user}' for deleted app '${appName}'`);
  return { ok: true, ...info };
}

// --- System checks ---

function checkSudo() {
  return require('./env-detect').detect().hasSudo;
}

function checkMariadb() {
  try {
    const out = execSync('mariadb --version 2>/dev/null || mysql --version 2>/dev/null', { timeout: 3000, encoding: 'utf-8' });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : out.trim().slice(0, 60);
  } catch {
    return null;
  }
}

function renameAppDb(oldName, newName) {
  if (!config?.apps?.[oldName]) return;
  config.apps[newName] = config.apps[oldName];
  delete config.apps[oldName];
  saveConfig(config);
}

async function cleanup() {
  await disconnect();
}

module.exports = {
  init, initAppUser, ready, connect, testConnection, query, status, statusForOwnerUi, disconnect, onStatus,
  getPool, getConfig, isConfigured, cleanup, friendlyDbError,
  provisionApp, deprovisionApp, getAppDb, getProvisionedApps, getAllDbSizes, sanitizeDbName, renameAppDb,
  checkSudo, checkMariadb,
};
