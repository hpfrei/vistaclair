const fs = require('fs');
const path = require('path');
const http = require('http');
const spendContext = require('./spend-context');
const { proxyEnv } = require('./proxy-env');

let appsDir = null;
let appManager = null;
let broadcaster = null;
let spawnClaudeFn = null;
let buildClaudeArgsFn = null;
let proxyPort = 3456;
let authToken = null; // core's internal owner credential for loopback app-api calls
let jobs = {};
let timers = new Map(); // jobId → timeout handle
// Registry for 'internal' target jobs — in-process functions (e.g. memory
// maintenance). Persisted like any job, but executed by calling the registered
// handler rather than spawning a process. Handlers are re-registered at boot.
const internalHandlers = new Map(); // handlerName → async fn

function registerInternal(name, fn) {
  internalHandlers.set(name, fn);
}

function configPath() {
  return path.join(appsDir, '.platform-cron.json');
}

function loadJobs() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    return JSON.parse(raw).jobs || {};
  } catch {
    return {};
  }
}

function saveJobs() {
  const dir = path.dirname(configPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ jobs }, null, 2));
  fs.renameSync(tmp, configPath());
}

function parseCronExpression(expr) {
  // Support simple format: "every N seconds/minutes/hours"
  const simple = expr.match(/^every\s+(\d+)\s*(s|sec|seconds?|m|min|minutes?|h|hr|hours?)$/i);
  if (simple) {
    const n = parseInt(simple[1], 10);
    const unit = simple[2][0].toLowerCase();
    const mult = { s: 1000, m: 60000, h: 3600000 };
    return { type: 'interval', ms: n * (mult[unit] || 60000) };
  }

  // Cron expression parsing (5-field: min hour dom month dow)
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  try {
    const CronParser = require('cron-parser');
    const interval = CronParser.parseExpression(expr);
    return { type: 'cron', expression: expr, _parser: () => CronParser.parseExpression(expr) };
  } catch {
    return null;
  }
}

function getNextRunMs(parsed) {
  if (parsed.type === 'interval') return parsed.ms;
  if (parsed.type === 'cron') {
    try {
      const interval = parsed._parser();
      const next = interval.next().toDate();
      const ms = next.getTime() - Date.now();
      return Math.max(ms, 1000);
    } catch {
      return 60000;
    }
  }
  return 60000;
}

// setTimeout delays must fit a 32-bit signed int (~24.8 days) or Node clamps
// them to 1ms and fires immediately. For longer schedules (e.g. monthly cron)
// we re-arm in capped chunks until the real fire time is reached.
const MAX_TIMEOUT = 2147483647;

function scheduleJob(jobId) {
  clearTimer(jobId);
  const job = jobs[jobId];
  if (!job || !job.enabled) return;

  const parsed = parseCronExpression(job.schedule);
  if (!parsed) return;

  // Arm a timer for `ms`, chunking anything beyond MAX_TIMEOUT so a long delay
  // never overflows. When the full delay elapses, run `onFire`.
  function arm(ms, onFire) {
    if (ms > MAX_TIMEOUT) {
      timers.set(jobId, setTimeout(() => arm(ms - MAX_TIMEOUT, onFire), MAX_TIMEOUT));
    } else {
      timers.set(jobId, setTimeout(onFire, Math.max(ms, 1)));
    }
  }

  function tick() {
    executeJob(jobId).then(() => {
      if (jobs[jobId]?.enabled) arm(getNextRunMs(parsed), tick);
    });
  }

  arm(getNextRunMs(parsed), tick);
}

function clearTimer(jobId) {
  const timer = timers.get(jobId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(jobId);
  }
}

async function executeJob(jobId) {
  const job = jobs[jobId];
  if (!job) return { ok: false, error: 'Job not found' };

  const startTime = Date.now();
  job.lastRunAt = startTime;
  job.runCount = (job.runCount || 0) + 1;

  let result;
  try {
    if (job.target.type === 'app-api') {
      result = await executeAppApi(job.target);
    } else if (job.target.type === 'shell') {
      result = await executeShell(job.target, job);
    } else if (job.target.type === 'ai') {
      result = await executeAi(job.target);
    } else if (job.target.type === 'tool') {
      result = await executeTool(job.target, job);
    } else if (job.target.type === 'internal') {
      result = await spendContext.run({ app: job.appName || '_host', origin: 'cron', principal: null }, () => executeInternal(job.target));
    } else {
      result = { ok: false, error: `Unknown target type: ${job.target.type}` };
    }
  } catch (err) {
    result = { ok: false, error: err.message };
  }

  const duration = Date.now() - startTime;
  job.lastResult = result.ok ? (result.output || result.text || 'OK') : null;
  job.lastError = result.ok ? null : (result.error || 'Unknown error');
  job.lastDuration = duration;

  if (!job.history) job.history = [];
  job.history.unshift({
    timestamp: startTime,
    duration,
    ok: result.ok,
    output: truncate(result.output || result.text || result.error || '', 2000),
    status: result.status,
  });
  if (job.history.length > 20) job.history = job.history.slice(0, 20);

  saveJobs();

  // Observers (Horst's cron senses): streak = consecutive failures ending now.
  if (resultObservers.length) {
    let streak = 0;
    for (const h of job.history) { if (h.ok) break; streak++; }
    for (const fn of resultObservers) { try { fn(job, result, streak); } catch (err) { console.warn('[cron] result observer failed:', err.message); } }
  }

  if (broadcaster) {
    broadcaster.broadcast({ type: 'app:setup:cronResult', jobId, result: job.history[0] });
    // App-scoped jobs (created via the per-app bridge cron.schedule) also emit a
    // cron:result bridge event so in-app Bridge.on('cron:result') listeners fire.
    // The client routes app:bridge:event to the owning app's iframe by appName.
    if (job.appName) {
      broadcaster.broadcast({
        type: 'app:bridge:event',
        appName: job.appName,
        event: 'cron:result',
        data: {
          jobId,
          stdout: result.output || '',
          stderr: result.error || '',
          code: result.ok ? 0 : (result.status || 1),
        },
      });
    }
  }

  return result;
}

function truncate(str, max) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + '...(truncated)';
}

// A standalone app is served by its own runner process; its port is published
// in <appsDir>/.standalone.json by the runner. Cron stays central (single
// scheduler) but its app-api calls must hit the runner, not the dashboard.
function standaloneRunnerEntry(app) {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(appsDir, '.standalone.json'), 'utf-8'));
    return reg[app] || null;
  } catch { return null; }
}
function standaloneRunnerPort(app) { return standaloneRunnerEntry(app)?.port || null; }

async function executeAppApi(target) {
  const { app, method, path: apiPath } = target;
  if (!appManager) return { ok: false, error: 'App manager not available' };

  let port = process.env.DASHBOARD_PORT || 3457;
  // Credential for this call. In-process apps are reached through the
  // dashboard, whose gate needs core's internal header; the dashboard strips
  // it before the app runs (index.js), so app code never sees it. An app
  // process (own-process child, standalone runner) is called directly and gets
  // only its own per-app cron signature — never AUTH_TOKEN.
  let credential = authToken ? { 'x-vistaclair-internal': authToken } : {};
  if (appManager.readManifest?.(app)?.standalone === true) {
    const reg = standaloneRunnerEntry(app);
    if (!reg?.port) return { ok: false, error: `Standalone app '${app}' has no registered runner (is its app-runner process up?)` };
    port = reg.port;
    credential = reg.cronSecret ? { 'x-vistaclair-cron-sig': reg.cronSecret } : {};
  } else {
    const mounted = appManager.getMountedRouter(app);
    if (!mounted) {
      // Own-process apps run in their own child on a loopback port — hit
      // the child directly.
      const running = appManager.getRunningApp?.(app);
      if (!running?.port) return { ok: false, error: `App '${app}' is not running` };
      port = running.port;
      const sig = appManager.getCronSecret?.(app);
      credential = sig ? { 'x-vistaclair-cron-sig': sig } : {};
    }
  }

  const fullPath = `/apps/${app}${apiPath}`;

  return new Promise((resolve) => {
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: fullPath,
      method: (method || 'POST').toUpperCase(),
      // `credential` (above): the call resolves via:'owner' through app-auth's
      // default-deny guard instead of bouncing to /login.
      headers: { 'Content-Type': 'application/json', 'x-vistaclair-cron': 'true', ...credential },
      timeout: 60000,
    };

    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, output: body, status: res.statusCode });
        } else {
          resolve({ ok: false, error: `HTTP ${res.statusCode}: ${body.slice(0, 500)}`, status: res.statusCode });
        }
      });
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Request timed out (60s)' }); });
    req.on('error', (err) => { resolve({ ok: false, error: err.message }); });
    req.end();
  });
}

async function executeShell(target, job) {
  const { exec } = require('child_process');
  // App-scoped jobs run in the app's own directory with the proxy URL injected,
  // matching the per-app bridge cron behavior they replaced.
  const cwd = job?.appName && appManager ? path.join(appManager.APPS_DIR, job.appName) : appsDir;
  const env = job?.appName
    ? { ...process.env, ...proxyEnv(process.env, proxyPort) }
    : process.env;
  return new Promise((resolve) => {
    exec(target.command, {
      cwd,
      env,
      encoding: 'utf-8',
      timeout: 120000,
      maxBuffer: 5 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: stderr || err.message, output: stdout });
      } else {
        resolve({ ok: true, output: stdout, error: stderr || null });
      }
    });
  });
}

async function executeAi(target) {
  if (!spawnClaudeFn) return { ok: false, error: 'AI not available' };

  const appBridge = require('./app-bridge');
  try {
    const result = await appBridge.aiPrompt('platform', appsDir, {
      message: target.message,
      systemPrompt: target.systemPrompt || undefined,
      model: target.model || 'haiku',
      authMode: target.authMode || undefined,
    });
    return { ok: true, text: result?.text || JSON.stringify(result) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Direct app-tool invocation ({type:'tool', app, tool, args}). Lazy-mounts a
// stopped in-process target. Expose enforcement lives centrally in
// callAppToolHandler; all failures (deleted app, expose downgrade, mount
// failure) surface as job errors without touching the scheduler.
async function executeTool(target, job) {
  const appBridge = require('./app-bridge');
  const { app, tool, args } = target;
  try {
    if (appBridge.getToolsForApp(app).length === 0 && appManager) {
      const manifest = appManager.readManifest?.(app);
      if (!manifest) return { ok: false, error: `App '${app}' not found` };
      if (appManager.appRuntime?.(app) !== 'in-process') {
        return { ok: false, error: `App '${app}' is not running (tool jobs require an in-process app)` };
      }
      await appManager.startApp(app, broadcaster);
    }
    const result = await appBridge.callAppToolHandler(app, tool, args || {}, {
      type: 'cron',
      appName: job.appName || null,
    });
    return { ok: true, output: typeof result === 'string' ? result : JSON.stringify(result) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function executeInternal(target) {
  const fn = internalHandlers.get(target.handler);
  if (!fn) return { ok: false, error: `No internal handler registered: ${target.handler}` };
  try {
    const out = await fn();
    // Idle early-exits return {skipped:...}; surface them but treat as OK (no-op).
    return { ok: out?.ok !== false, output: JSON.stringify(out || {}) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function init(options) {
  appsDir = options.appsDir;
  appManager = options.appManager || null;
  broadcaster = options.broadcaster || null;
  spawnClaudeFn = options.spawnClaude || null;
  buildClaudeArgsFn = options.buildClaudeArgs || null;
  if (options.proxyPort) proxyPort = options.proxyPort;
  authToken = options.authToken || null;

  jobs = loadJobs();
  for (const jobId of Object.keys(jobs)) {
    if (jobs[jobId].enabled) scheduleJob(jobId);
  }
  const count = Object.keys(jobs).length;
  if (count > 0) console.log(`  Cron: ${count} job(s) loaded`);
}

function shutdown() {
  for (const jobId of timers.keys()) clearTimer(jobId);
}

function listJobs() {
  return Object.values(jobs).map(j => ({
    id: j.id,
    name: j.name,
    schedule: j.schedule,
    target: j.target,
    enabled: j.enabled,
    appName: j.appName || null,
    createdAt: j.createdAt,
    lastRunAt: j.lastRunAt,
    lastResult: j.lastResult,
    lastError: j.lastError,
    lastDuration: j.lastDuration,
    runCount: j.runCount || 0,
  }));
}

function addJob(job) {
  if (!job.name) return { ok: false, error: 'Name is required' };
  if (!job.schedule) return { ok: false, error: 'Schedule is required' };
  if (!job.target?.type) return { ok: false, error: 'Target type is required' };

  const parsed = parseCronExpression(job.schedule);
  if (!parsed) return { ok: false, error: `Invalid schedule: "${job.schedule}". Use a cron expression (e.g. "*/5 * * * *") or "every N seconds/minutes/hours".` };

  if (job.target.type === 'app-api' && (!job.target.app || !job.target.path)) {
    return { ok: false, error: 'App API target requires app and path' };
  }
  if (job.target.type === 'shell' && !job.target.command) {
    return { ok: false, error: 'Shell target requires a command' };
  }
  if (job.target.type === 'ai' && !job.target.message) {
    return { ok: false, error: 'AI target requires a message' };
  }
  if (job.target.type === 'tool' && (!job.target.app || !job.target.tool)) {
    return { ok: false, error: 'Tool target requires app and tool' };
  }
  if (job.target.type === 'internal' && !job.target.handler) {
    return { ok: false, error: 'Internal target requires a handler name' };
  }

  // Idempotency: app-scoped jobs re-register on every app mount/restart. Without
  // this guard each restart appends an identical row, accumulating duplicates that
  // all fire on their own timers. Reuse the existing job instead.
  if (job.appName) {
    const dupe = Object.values(jobs).find(j =>
      j.appName === job.appName &&
      j.schedule === job.schedule &&
      j.target?.type === job.target.type &&
      j.target?.command === job.target.command &&
      j.target?.path === job.target.path &&
      j.target?.app === job.target.app
    );
    if (dupe) return { ok: true, jobId: dupe.id, deduped: true };
  }

  const id = 'job-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  jobs[id] = {
    id,
    name: job.name,
    schedule: job.schedule,
    target: job.target,
    enabled: job.enabled !== false,
    appName: job.appName || null,
    createdAt: Date.now(),
    lastRunAt: null,
    lastResult: null,
    lastError: null,
    lastDuration: null,
    runCount: 0,
    history: [],
  };
  saveJobs();
  if (jobs[id].enabled) scheduleJob(id);
  return { ok: true, jobId: id };
}

// --- Per-app cron (backs the bridge cron.* methods) ---

function listByApp(appName) {
  return Object.values(jobs)
    .filter(j => j.appName === appName)
    .map(j => ({ jobId: j.id, schedule: j.schedule, command: j.target?.command }));
}

// Remove every job owned by an app (used when the app is deleted, not stopped).
function removeByApp(appName) {
  let changed = false;
  for (const [id, job] of Object.entries(jobs)) {
    if (job.appName === appName) {
      clearTimer(id);
      delete jobs[id];
      changed = true;
    }
  }
  if (changed) saveJobs();
}

function updateJob(id, updates) {
  if (!jobs[id]) return { ok: false, error: 'Job not found' };
  const job = jobs[id];
  if (updates.name !== undefined) job.name = updates.name;
  if (updates.schedule !== undefined) {
    const parsed = parseCronExpression(updates.schedule);
    if (!parsed) return { ok: false, error: `Invalid schedule: "${updates.schedule}"` };
    job.schedule = updates.schedule;
  }
  if (updates.target !== undefined) job.target = updates.target;
  if (updates.enabled !== undefined) job.enabled = updates.enabled;
  saveJobs();
  scheduleJob(id);
  return { ok: true };
}

function removeJob(id) {
  if (!jobs[id]) return { ok: false, error: 'Job not found' };
  clearTimer(id);
  delete jobs[id];
  saveJobs();
  return { ok: true };
}

function enableJob(id) { return updateJob(id, { enabled: true }); }
function disableJob(id) { return updateJob(id, { enabled: false }); }

async function runNow(id) {
  if (!jobs[id]) return { ok: false, error: 'Job not found' };
  return executeJob(id);
}

function getHistory(id, limit) {
  if (!jobs[id]) return [];
  return (jobs[id].history || []).slice(0, limit || 10);
}

function renameApp(oldName, newName) {
  let changed = false;
  for (const job of Object.values(jobs)) {
    if (job.target?.app === oldName) {
      job.target.app = newName;
      changed = true;
    }
    // job.appName is the ownership key: shell jobs resolve their cwd from it,
    // results are routed to the app's iframe by it, and listByApp/removeByApp
    // filter on it — leaving it stale strands the job under a dead name.
    if (job.appName === oldName) {
      job.appName = newName;
      changed = true;
    }
  }
  if (changed) saveJobs();
}

// onResult(fn(job, result, streak)) — called after every run is persisted.
// Returns an unsubscribe function.
const resultObservers = [];
function onResult(fn) {
  resultObservers.push(fn);
  return () => { const i = resultObservers.indexOf(fn); if (i >= 0) resultObservers.splice(i, 1); };
}

module.exports = { init, shutdown, list: listJobs, addJob, updateJob, removeJob, enableJob, disableJob, runNow, getHistory, renameApp, listByApp, removeByApp, registerInternal, onResult };
