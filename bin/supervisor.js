#!/usr/bin/env node
// Supervisor for local mode (`npm start`, `vistaclair`): runs server.js as a
// child and, when the child fails to boot, crash-loops or hangs, binds the
// dashboard port itself and serves a rescue page — reason, log tail, a shell in
// the browser and a "Retry start" button — so a failed startup never leaves the
// port empty.
//
// Deliberately frozen-simple and independent: nothing from src/ or server.js is
// required, so a broken merge there cannot break the rescue path. The owner
// decision mirrors src/auth.js; the Telegram session store mirrors
// src/tg-login.js (read-only).
//
// Server mode (VISTACLAIR_SERVER=1, pm2) is never wrapped.

if (process.env.VISTACLAIR_SERVER === '1') {
  require('../server.js');
  return;
}

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
require('dotenv').config({ quiet: true });
const { WebSocketServer } = require('ws');
let pty = null;
try { pty = require('node-pty'); } catch {}

const ROOT = path.join(__dirname, '..');
const CHILD_SCRIPT = process.env.VISTACLAIR_SUPERVISOR_CHILD || path.join(ROOT, 'server.js');
const ARGS = process.argv.slice(2);
const PORT_ARG = ARGS.find(a => /^\d+$/.test(a));
const PORT = parseInt(PORT_ARG || process.env.DASHBOARD_PORT || '3457');
const HOST = process.env.DASHBOARD_HOST || undefined;
const PING_HOST = HOST && HOST !== '0.0.0.0' && HOST !== '::' ? HOST : '127.0.0.1';
const AUTH_TOKEN = process.env.AUTH_TOKEN || crypto.randomUUID();

const RESTART_EXIT_CODE = 75;       // server.js scheduleRestart() when supervised
const BOOT_TIMEOUT_MS = Number(process.env.VISTACLAIR_BOOT_TIMEOUT_MS) || 120000;
const HEALTH_INTERVAL_MS = Number(process.env.VISTACLAIR_HEALTH_INTERVAL_MS) || 10000;
// Hung = no ping answer for this long. Generous: the running server blocks its
// event loop on purpose during a Pro install (sync git clone + npm install).
const HANG_TIMEOUT_MS = Number(process.env.VISTACLAIR_HANG_TIMEOUT_MS) || 180000;
const HEALTH_FAILS = Math.max(3, Math.ceil(HANG_TIMEOUT_MS / HEALTH_INTERVAL_MS));
const KILL_GRACE_MS = Number(process.env.VISTACLAIR_KILL_GRACE_MS) || 5000;
const CRASH_LIMIT = 3;              // crashes within CRASH_WINDOW_MS → rescue
const CRASH_WINDOW_MS = 60000;
const LOG_LINES = 500;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// Same resolution as src/utils.js (copied, not imported).
const DATA_HOME = (function resolveDataHome() {
  if (process.env.VISTACLAIR_HOME) return path.resolve(process.env.VISTACLAIR_HOME);
  const sep = path.sep;
  if (ROOT.includes(sep + 'node_modules' + sep) || ROOT.endsWith(sep + 'node_modules')) {
    return path.join(os.homedir(), '.vistaclair');
  }
  return ROOT;
})();

// --- Log: echo, ring buffer, file ---

const LOG_FILE = path.join(DATA_HOME, 'data', 'logs', 'server.log');
const lines = [];
const partial = { 1: '', 2: '' };
let logBytes = 0;
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); logBytes = fs.statSync(LOG_FILE).size; } catch {}

function appendLog(text) {
  try {
    if (logBytes > MAX_LOG_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
      logBytes = 0;
    }
    fs.appendFileSync(LOG_FILE, text);
    logBytes += Buffer.byteLength(text);
  } catch {}
}

function out(chunk, fd) {
  const text = chunk.toString();
  (fd === 2 ? process.stderr : process.stdout).write(text);
  appendLog(text);
  const parts = (partial[fd] + text).split('\n');
  partial[fd] = parts.pop();
  lines.push(...parts);
  if (lines.length > LOG_LINES) lines.splice(0, lines.length - LOG_LINES);
}

function say(msg) {
  out(`[supervisor ${new Date().toISOString()}] ${msg}\n`, 1);
}

function logTail() {
  return [...lines, partial[1], partial[2]].filter(Boolean).join('\n');
}

process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// --- Child lifecycle ---

let child = null;
let state = 'idle';          // booting | running | rescue | stopping
let killReason = null;
let firstBoot = true;
let crashes = [];
let timers = {};
let rescue = null;           // { kind, code, signal, count, at, epoch }
let epoch = 0;
let stopping = false;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ping(timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: PING_HOST, port: PORT, path: '/api/ping', agent: false, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try { resolve(res.statusCode === 200 && JSON.parse(body).ok === true); } catch { resolve(false); }
      });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function clearTimers() {
  clearTimeout(timers.boot);
  clearInterval(timers.health);
  clearTimeout(timers.kill);
  timers = {};
}

async function startChild() {
  await closeRescue();
  if (stopping) return;
  const env = { ...process.env, AUTH_TOKEN, VISTACLAIR_SUPERVISED: '1' };
  if (!firstBoot) env.NO_OPEN = '1';
  firstBoot = false;
  state = 'booting';
  killReason = null;
  const c = spawn(process.execPath, [CHILD_SCRIPT, ...ARGS], { cwd: process.cwd(), env, stdio: ['inherit', 'pipe', 'pipe'] });
  child = c;
  say(`starting ${path.basename(CHILD_SCRIPT)}${c.pid ? ` (pid ${c.pid})` : ''}`);
  c.stdout.on('data', d => out(d, 1));
  c.stderr.on('data', d => out(d, 2));
  let exited = false;
  const onExit = (code, signal) => {
    if (exited) return;
    exited = true;
    // Let the pipes drain so the log tail holds the last words.
    let done = false;
    const finish = () => { if (!done) { done = true; childExited(c, code, signal); } };
    c.once('close', finish);
    setTimeout(finish, 500);
  };
  c.on('exit', onExit);
  c.on('error', (err) => { say(`failed to start: ${err.message}`); if (c.exitCode === null && !c.pid) onExit(null, null); });

  timers.boot = setTimeout(() => {
    if (child === c && state === 'booting') stopChild(`boot-timeout`);
  }, BOOT_TIMEOUT_MS);
  while (child === c && state === 'booting' && !killReason) {
    if (await ping(2000)) {
      if (child === c && state === 'booting' && !killReason) onHealthy(c);
      return;
    }
    await sleep(500);
  }
}

function onHealthy(c) {
  state = 'running';
  clearTimeout(timers.boot);
  say(`server is up on port ${PORT}`);
  let fails = 0;
  let busy = false;
  timers.health = setInterval(async () => {
    if (busy || child !== c || state !== 'running') return;
    busy = true;
    const ok = await ping(Math.min(5000, HEALTH_INTERVAL_MS));
    busy = false;
    if (child !== c || state !== 'running') return;
    if (ok) { fails = 0; return; }
    if (++fails >= HEALTH_FAILS) stopChild('hung');
  }, HEALTH_INTERVAL_MS);
}

function stopChild(reason) {
  const c = child;
  if (!c) return;
  killReason = reason;
  clearInterval(timers.health);
  clearTimeout(timers.boot);
  say(reason === 'hung' ? `server stopped answering /api/ping — stopping it` : `server did not come up within ${BOOT_TIMEOUT_MS / 1000}s — stopping it`);
  try { c.kill('SIGTERM'); } catch {}
  timers.kill = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, KILL_GRACE_MS);
}

function childExited(c, code, signal) {
  if (c !== child) return;
  child = null;
  const was = state;
  clearTimers();
  say(`server exited (${signal ? `signal ${signal}` : `code ${code}`})`);
  if (stopping) return process.exit(0);
  if (killReason) return enterRescue({ kind: killReason, code, signal });
  const restart = code === RESTART_EXIT_CODE;
  if (restart && was === 'running') {
    say('restart requested — starting a fresh server');
    return startChild();
  }
  if (!restart && was === 'booting') return enterRescue({ kind: 'boot-crash', code, signal });
  // Unexpected exit while running (or a restart before healthy): respawn,
  // unless it keeps happening.
  const now = Date.now();
  crashes = crashes.filter(t => now - t < CRASH_WINDOW_MS);
  crashes.push(now);
  if (crashes.length >= CRASH_LIMIT) return enterRescue({ kind: 'crash-loop', code, signal, count: crashes.length });
  say(restart ? 'restart requested — starting a fresh server' : 'unexpected exit — respawning');
  startChild();
}

function reasonText(r) {
  const how = r.signal ? `signal ${r.signal}` : `exit code ${r.code}`;
  switch (r.kind) {
    case 'boot-crash': return `The server exited during startup (${how}).`;
    case 'boot-timeout': return `The server did not answer /api/ping within ${BOOT_TIMEOUT_MS / 1000}s of starting, so it was stopped.`;
    case 'crash-loop': return `The server crashed ${r.count} times within ${CRASH_WINDOW_MS / 1000}s (last: ${how}).`;
    case 'hung': return `The server stopped answering /api/ping for ${HANG_TIMEOUT_MS / 1000}s, so it was stopped.`;
    default: return 'The server is not running.';
  }
}

function enterRescue(info) {
  state = 'rescue';
  crashes = [];
  rescue = { ...info, at: Date.now(), epoch: ++epoch };
  say(`RESCUE MODE: ${reasonText(rescue)}`);
  say(`rescue page: http://localhost:${PORT}/ (log tail, shell, Retry start)`);
  listenRescue();
}

function shutdown(sig) {
  if (stopping) { try { child?.kill('SIGKILL'); } catch {} return; }
  stopping = true;
  state = 'stopping';
  closeRescue();
  if (!child) return process.exit(0);
  try { child.kill(sig); } catch {}
  setTimeout(() => { try { child?.kill('SIGKILL'); } catch {} }, KILL_GRACE_MS).unref();
}

// --- Owner auth (mirrors src/auth.js; fail closed) ---

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

function isLoopbackSocket(socket, req) {
  return LOOPBACK.has(socket?.remoteAddress) && !req?.headers?.['x-forwarded-for'];
}

// tg-login's configured(): botToken && ownerUserId in the encrypted
// <DATA_HOME>/tg-login.enc (src/secret-store.js format). No file → not
// configured; a file we cannot read → assume configured (fail closed).
function tgConfigured() {
  let raw;
  try { raw = fs.readFileSync(path.join(DATA_HOME, 'tg-login.enc'), 'utf-8'); } catch { return false; }
  try {
    const keyHex = process.env.VISTA_SECRETS_KEY || fs.readFileSync(path.join(DATA_HOME, '.secrets_key'), 'utf-8').trim();
    const { iv, tag, data } = JSON.parse(raw);
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    const config = JSON.parse(decipher.update(data, 'hex', 'utf-8') + decipher.final('utf-8'));
    return !!(config.botToken && config.ownerUserId);
  } catch {
    return true;
  }
}

// tg-login's getSession(): sha256(sid) matches an unexpired entry.
function validSid(sid) {
  if (!sid || typeof sid !== 'string') return false;
  try {
    const hash = crypto.createHash('sha256').update(sid).digest('hex');
    const sessions = JSON.parse(fs.readFileSync(path.join(DATA_HOME, 'sessions.json'), 'utf-8'));
    return Array.isArray(sessions) && sessions.some(s => s && s.sidHash === hash && s.expiresAt > Date.now());
  } catch {
    return false;
  }
}

function tokenLoginAllowed(socket, req) {
  return isLoopbackSocket(socket, req) || !tgConfigured();
}

function staticTokenOk(req) {
  if (safeEqual(cookieValue(req.headers.cookie, 'token'), AUTH_TOKEN)) return true;
  const authHeader = req.headers.authorization;
  return typeof authHeader === 'string' && authHeader.startsWith('Bearer ') && safeEqual(authHeader.slice(7), AUTH_TOKEN);
}

function isOwner(socket, req) {
  if (isLoopbackSocket(socket, req) && safeEqual(req.headers['x-vistaclair-internal'], AUTH_TOKEN)) return true;
  if (validSid(cookieValue(req.headers.cookie, 'sid'))) return true;
  return tokenLoginAllowed(socket, req) && staticTokenOk(req);
}

// A browser always sends Origin on a WebSocket; it must name this host.
function originOk(req, required) {
  const origin = req.headers.origin;
  if (!origin) return !required;
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || host === req.headers['x-forwarded-host'];
  } catch { return false; }
}

// Login attempts: 10 per minute per client, like server.js authLimiter.
const attempts = new Map();
function rateLimited(req) {
  const xff = req.headers['x-forwarded-for'];
  const key = (xff && LOOPBACK.has(req.socket.remoteAddress)) ? String(xff).split(',').pop().trim() : req.socket.remoteAddress;
  const now = Date.now();
  if (attempts.size > 1000) attempts.clear();
  const hits = (attempts.get(key) || []).filter(t => now - t < 60000);
  hits.push(now);
  attempts.set(key, hits);
  return hits.length > 10;
}

// --- Rescue server ---

let rescueServer = null;
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const shells = new Set();

function listenRescue() {
  const srv = http.createServer((req, res) => {
    try { handleHttp(req, res); } catch (e) {
      say(`rescue request failed: ${e.message}`);
      try { res.statusCode = 500; res.end(); } catch {}
    }
  });
  srv.on('upgrade', handleUpgrade);
  rescueServer = srv;
  let warned = false;
  const tryListen = () => { if (rescueServer === srv) srv.listen(PORT, HOST); };
  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && rescueServer === srv) {
      if (!warned) { warned = true; say(`port ${PORT} still in use — waiting to serve the rescue page`); }
      setTimeout(tryListen, 1000);
    } else {
      say(`rescue server error: ${err.message}`);
    }
  });
  srv.on('listening', () => say(`rescue page listening on port ${PORT}`));
  tryListen();
}

function closeRescue() {
  const srv = rescueServer;
  rescueServer = null;
  for (const s of shells) s.kill();
  for (const ws of wss.clients) ws.terminate();
  if (!srv) return Promise.resolve();
  return new Promise((resolve) => {
    if (!srv.listening) return resolve();
    srv.close(() => resolve());
    srv.closeAllConnections?.();
  });
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, 'application/json', JSON.stringify(obj));
const redirect = (res, to, headers = {}) => { res.writeHead(302, { location: to, ...headers }); res.end(); };
const authCookie = (value) => `token=${value}; HttpOnly; SameSite=Lax; Path=/`;

function readBody(req, cb) {
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 8192) req.destroy(); });
  req.on('end', () => cb(new URLSearchParams(body)));
}

function handleHttp(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // The dashboard and the rescue page both poll this to tell "booting" (no
  // answer) from "rescue" (503 + epoch) from "up" (the real server's 200).
  if (p === '/api/ping') return sendJson(res, 503, { ok: false, rescue: true, epoch });

  if (p === '/login' && req.method === 'POST') {
    if (rateLimited(req)) return sendJson(res, 429, { error: 'Too many attempts, try again in a minute' });
    return readBody(req, (params) => {
      if (tokenLoginAllowed(req.socket, req) && safeEqual(params.get('token'), AUTH_TOKEN)) {
        return redirect(res, '/', { 'set-cookie': authCookie(AUTH_TOKEN) });
      }
      redirect(res, '/login?error=1');
    });
  }
  if (p === '/login/auto') {
    if (rateLimited(req)) return sendJson(res, 429, { error: 'Too many attempts, try again in a minute' });
    if (isLoopbackSocket(req.socket, req) && safeEqual(url.searchParams.get('token'), AUTH_TOKEN)) {
      return redirect(res, '/', { 'set-cookie': authCookie(AUTH_TOKEN) });
    }
    return redirect(res, '/login');
  }
  if (p === '/login') {
    if (isOwner(req.socket, req)) return redirect(res, '/');
    return send(res, 200, 'text/html; charset=utf-8', loginPage(tokenLoginAllowed(req.socket, req), url.searchParams.has('error')));
  }

  if (!isOwner(req.socket, req)) {
    if (p.startsWith('/api/') || p.startsWith('/rescue/')) return sendJson(res, 401, { error: 'Unauthorized' });
    return redirect(res, '/login');
  }

  if (p === '/rescue/status') {
    return sendJson(res, 200, { state, reason: rescue && reasonText(rescue), epoch, log: stripAnsi(logTail()) });
  }
  if (p === '/rescue/retry' && req.method === 'POST') {
    if (!originOk(req, false)) return sendJson(res, 403, { error: 'Bad origin' });
    if (state !== 'rescue') return sendJson(res, 409, { error: `Not in rescue mode (${state})` });
    say('Retry start requested from the rescue page');
    state = 'booting';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }), () => startChild());
  }
  if (p.startsWith('/api/') || p.startsWith('/rescue/')) {
    return sendJson(res, 503, { error: 'Server is down — rescue mode', rescue: true });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Rescue mode' });
  send(res, 200, 'text/html; charset=utf-8', rescuePage());
}

function handleUpgrade(req, socket, head) {
  const reject = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`); socket.destroy(); };
  if (new URL(req.url, 'http://x').pathname !== '/rescue/ws') return reject(503, 'Service Unavailable');
  if (!isOwner(socket, req)) return reject(401, 'Unauthorized');
  if (!originOk(req, true)) return reject(403, 'Forbidden');
  wss.handleUpgrade(req, socket, head, (ws) => openShell(ws));
}

// --- Shell over the WebSocket: a PTY when node-pty loads, else one command at a time ---

const SHELL = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh');

function shellEnv() {
  const env = { ...process.env, TERM: 'xterm-256color' };
  delete env.VISTACLAIR_SUPERVISED;
  return env;
}

function openShell(ws) {
  const sendMsg = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  let term = null;
  let ptyError = null;
  if (pty && process.env.VISTACLAIR_RESCUE_NO_PTY !== '1') {
    try {
      term = pty.spawn(SHELL, process.platform === 'win32' ? [] : ['-l'], { name: 'xterm-256color', cols: 100, rows: 30, cwd: ROOT, env: shellEnv() });
    } catch (e) { ptyError = e.message; }
  } else {
    ptyError = pty ? 'disabled' : 'node-pty could not be loaded';
  }
  let proc = null;
  const handle = {
    kill() {
      try { term?.kill(); } catch {}
      if (proc) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} } }
    },
  };
  shells.add(handle);
  sendMsg({ type: 'hello', mode: term ? 'pty' : 'exec', shell: SHELL, cwd: ROOT, ptyError });

  if (term) {
    term.onData((data) => sendMsg({ type: 'output', data }));
    term.onExit(({ exitCode }) => { sendMsg({ type: 'exit', code: exitCode }); ws.close(); });
  }
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (term) {
      if (m.type === 'input' && typeof m.data === 'string') term.write(m.data);
      else if (m.type === 'resize') {
        const cols = m.cols | 0, rows = m.rows | 0;
        if (cols > 0 && rows > 0 && cols < 1000 && rows < 1000) term.resize(cols, rows);
      }
    } else if (m.type === 'exec' && typeof m.cmd === 'string' && !proc) {
      const args = process.platform === 'win32' ? ['/d', '/s', '/c', m.cmd] : ['-c', m.cmd];
      proc = spawn(SHELL, args, { cwd: ROOT, env: shellEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      proc.stdout.on('data', d => sendMsg({ type: 'output', data: d.toString() }));
      proc.stderr.on('data', d => sendMsg({ type: 'output', data: d.toString() }));
      proc.on('error', (e) => sendMsg({ type: 'output', data: `${e.message}\n` }));
      proc.on('close', (code, signal) => { proc = null; sendMsg({ type: 'exit', code: signal || code }); });
    } else if (m.type === 'kill') {
      if (proc) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} } }
    }
  });
  ws.on('close', () => { handle.kill(); shells.delete(handle); });
}

// --- Pages ---

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)?|\x1b[@-Z\\-_]/g, '');

const STYLE = `
  * { box-sizing: border-box; }
  body { margin: 0; background: #1a1b26; color: #c0caf5; font: 13px 'SF Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace; }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 16px; margin: 0 0 8px; } h2 { font-size: 13px; color: #7aa2f7; margin: 16px 0 6px; }
  .reason { background: #2d1f2a; border: 1px solid #f7768e; border-radius: 6px; padding: 10px 12px; color: #f7768e; }
  .muted { color: #565f89; font-size: 11px; }
  pre { background: #16161e; border: 1px solid #414868; border-radius: 6px; padding: 8px; margin: 0; overflow: auto; white-space: pre-wrap; word-break: break-all; }
  #log { max-height: 40vh; } #out { height: 40vh; }
  button { background: #7aa2f7; color: #1a1b26; border: 0; border-radius: 4px; padding: 7px 14px; font: inherit; font-weight: 600; cursor: pointer; }
  button.secondary { background: #414868; color: #c0caf5; } button:disabled { opacity: .5; cursor: default; }
  input { background: #16161e; color: #c0caf5; border: 1px solid #414868; border-radius: 4px; padding: 7px 10px; font: inherit; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  #term { height: 45vh; background: #16161e; border: 1px solid #414868; border-radius: 6px; padding: 4px; }
  .box { max-width: 420px; margin: 12vh auto; background: #24283b; border: 1px solid #414868; border-radius: 8px; padding: 28px; }
  .box input { width: 100%; } .box button { width: 100%; margin-top: 12px; } .err { color: #f7768e; margin-top: 8px; }
`;

function loginPage(tokenAllowed, error) {
  const body = tokenAllowed ? `
    <form method="POST" action="/login">
      <p class="muted">Enter the dashboard access token (AUTH_TOKEN, printed in the server's terminal).</p>
      <input type="password" name="token" placeholder="Access token" autofocus>
      ${error ? '<div class="err">Invalid token.</div>' : ''}
      <button type="submit">Log in</button>
    </form>` : `
    <p>Telegram login is configured, so the access token only works from the host itself — and Telegram login
    is unavailable while the server is down.</p>
    <p class="muted">If this browser already has a Telegram session it is accepted here; otherwise open
    <code>http://localhost:${PORT}/</code> on the host machine to reach the rescue page.</p>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>vistaclair — rescue login</title><style>${STYLE}</style></head><body>
<div class="box"><h1>vistaclair — server is down</h1><p class="muted">Rescue mode: log in to see why and fix it.</p>${body}</div></body></html>`;
}

function rescuePage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>vistaclair — rescue</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.min.js"></script>
<style>${STYLE}</style></head><body><div class="wrap">
<h1>vistaclair — server is down (rescue mode)</h1>
<div class="reason" id="reason">${esc(rescue ? reasonText(rescue) : 'The server is not running.')}</div>
<div class="muted" style="margin-top:6px">Since ${esc(new Date(rescue?.at || Date.now()).toLocaleString())} · full log: ${esc(LOG_FILE)}</div>
<div class="row"><button id="retry">Retry start</button><button class="secondary" id="refresh">Refresh log</button><span id="status" class="muted"></span></div>
<h2>Log tail</h2>
<pre id="log">${esc(stripAnsi(logTail()))}</pre>
<h2>Shell <span class="muted" id="shellInfo"></span></h2>
<div id="term"></div>
<div id="fallback" style="display:none"><pre id="out"></pre>
  <div class="row"><input id="cmd" style="flex:1" placeholder="command, e.g. git log --oneline -5" autocomplete="off"><button id="run">Run</button><button class="secondary" id="kill">Stop</button></div></div>
</div>
<script>
const EPOCH = ${epoch};
const $ = (id) => document.getElementById(id);
const logEl = $('log'); logEl.scrollTop = logEl.scrollHeight;

$('refresh').onclick = async () => {
  const r = await fetch('/rescue/status', { cache: 'no-store' }).catch(() => null);
  if (!r || !r.ok) return;
  const s = await r.json();
  $('reason').textContent = s.reason || s.state;
  logEl.textContent = s.log; logEl.scrollTop = logEl.scrollHeight;
};

$('retry').onclick = async () => {
  $('retry').disabled = true;
  const r = await fetch('/rescue/retry', { method: 'POST' }).catch(() => null);
  if (!r || !r.ok) { $('status').textContent = 'Retry failed: ' + (r ? r.status : 'no answer'); $('retry').disabled = false; return; }
  const started = Date.now();
  const poll = async () => {
    $('status').textContent = 'Starting server… ' + Math.round((Date.now() - started) / 1000) + 's';
    try {
      const p = await fetch('/api/ping', { cache: 'no-store' });
      const j = await p.json().catch(() => ({}));
      if (p.ok && j.ok) return location.href = '/';
      if (j.rescue && j.epoch !== EPOCH) return location.reload();
    } catch {}
    setTimeout(poll, 1500);
  };
  setTimeout(poll, 1000);
};

const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/rescue/ws');
const wsSend = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
let term = null, fit = null;
const strip = (s) => s.replace(/\\x1b\\[[0-9;?]*[ -\\/]*[@-~]|\\x1b\\][^\\x07]*\\x07?/g, '');
function lineMode(mode) {
  $('term').style.display = 'none'; $('fallback').style.display = '';
  const run = () => {
    const v = $('cmd').value; if (!v) return;
    if (mode === 'pty') wsSend({ type: 'input', data: v + '\\r' });
    else { $('out').textContent += '$ ' + v + '\\n'; wsSend({ type: 'exec', cmd: v }); }
    $('cmd').value = '';
  };
  $('run').onclick = run;
  $('cmd').onkeydown = (e) => { if (e.key === 'Enter') run(); };
  $('kill').onclick = () => mode === 'pty' ? wsSend({ type: 'input', data: '\\x03' }) : wsSend({ type: 'kill' });
}
function write(data) {
  if (term) return term.write(data);
  const out = $('out'); out.textContent += strip(data); out.scrollTop = out.scrollHeight;
}
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === 'hello') {
    $('shellInfo').textContent = '— ' + m.shell + ' in ' + m.cwd + (m.mode === 'exec' ? ' (one command at a time; ' + (m.ptyError || 'no PTY') + ')' : '');
    if (m.mode === 'pty' && window.Terminal) {
      term = new Terminal({ fontSize: 13, theme: { background: '#16161e' } });
      if (window.FitAddon) { fit = new FitAddon.FitAddon(); term.loadAddon(fit); }
      term.open($('term'));
      const resize = () => { if (fit) fit.fit(); wsSend({ type: 'resize', cols: term.cols, rows: term.rows }); };
      resize(); window.addEventListener('resize', resize);
      term.onData((d) => wsSend({ type: 'input', data: d }));
      term.focus();
    } else lineMode(m.mode);
  } else if (m.type === 'output') write(m.data);
  else if (m.type === 'exit') write('\\r\\n[exited ' + m.code + ']\\r\\n');
};
ws.onclose = () => { $('shellInfo').textContent += ' — disconnected (reload the page for a new shell)'; };
</script></body></html>`;
}

// --- Main ---

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));
process.on('uncaughtException', (err) => say(`internal error: ${err.stack || err.message}`));
process.on('unhandledRejection', (err) => say(`internal error: ${err?.stack || err}`));

say(`supervising ${path.basename(CHILD_SCRIPT)} on port ${PORT} (log: ${LOG_FILE})`);
startChild();
