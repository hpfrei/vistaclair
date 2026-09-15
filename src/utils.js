const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
let _pty;
function getPty() {
  if (!_pty) _pty = require('node-pty');
  return _pty;
}

const os = require('os');

// --- Directory roots ---
// PACKAGE_ROOT: where bundled code lives (lib/, public/, templates/)
const PACKAGE_ROOT = path.dirname(__dirname);

// DATA_HOME: where runtime/user state goes (outputs/, interactions/, data/, capabilities/, mcp-servers/)
// - VISTACLAIR_HOME env var overrides everything
// - Global npm install (inside node_modules): defaults to ~/.vistaclair
// - Local dev (cloned repo): defaults to the package root (backward compatible)
const DATA_HOME = (function resolveDataHome() {
  if (process.env.VISTACLAIR_HOME) return path.resolve(process.env.VISTACLAIR_HOME);
  const sep = path.sep;
  if (PACKAGE_ROOT.includes(sep + 'node_modules' + sep) ||
      PACKAGE_ROOT.endsWith(sep + 'node_modules')) {
    return path.join(os.homedir(), '.vistaclair');
  }
  return PACKAGE_ROOT;
})();

// SIGTERM now, SIGKILL after graceMs if still alive. `target` is a process
// object (ChildProcess/pty) or a raw pid.
function killGracefully(target, graceMs = 3000) {
  const byPid = typeof target === 'number';
  const send = (sig) => {
    if (byPid) { process.kill(target, 0); process.kill(target, sig); }
    else target.kill(sig);
  };
  try { send('SIGTERM'); } catch {}
  const t = setTimeout(() => { try { send('SIGKILL'); } catch {} }, graceMs);
  if (t.unref) t.unref();
}

// Best-effort removal of a file/dir that may not exist.
function tryRm(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

let counter = 0;

const MIME_TYPES = {
  '.html': 'text/html', '.htm': 'text/html',
  '.json': 'application/json', '.js': 'text/javascript',
  '.css': 'text/css', '.txt': 'text/plain', '.md': 'text/markdown',
  '.csv': 'text/csv', '.xml': 'application/xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.aac': 'audio/aac', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.ts': 'text/plain', '.tsx': 'text/plain',
  '.py': 'text/plain', '.rb': 'text/plain', '.go': 'text/plain', '.rs': 'text/plain',
  '.yaml': 'text/plain', '.yml': 'text/plain', '.toml': 'text/plain', '.ini': 'text/plain',
  '.sh': 'text/plain', '.bash': 'text/plain', '.log': 'text/plain', '.env': 'text/plain',
};

function generateId() {
  return `req_${Date.now().toString(36)}_${(counter++).toString(36)}`;
}

// --- Shared claude spawn utilities ---

/**
 * Build CLI args from a spawn-options object (permissionMode, allowedTools,
 * model, effort, system prompts, limits).
 * Returns the base args array (caller adds --resume, --mcp-config, etc.).
 */
// Linux caps a single argv string at MAX_ARG_STRLEN (128 KiB); a prompt over
// that makes exec fail with E2BIG and the CLI dies instantly. Pass big prompts
// via the --…-file flag variants instead. Files are content-hashed (stable name
// per prompt, no churn) and stale ones are swept opportunistically.
const PROMPT_ARG_LIMIT = 100 * 1024;
const PROMPT_FILE_DIR = () => path.join(DATA_HOME, 'data', 'prompt-args');

function _promptArg(args, flag, prompt) {
  if (Buffer.byteLength(prompt) <= PROMPT_ARG_LIMIT) {
    args.push(flag, prompt);
    return;
  }
  const dir = PROMPT_FILE_DIR();
  ensureDir(dir);
  const hash = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);
  const file = path.join(dir, `${hash}.txt`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, prompt);
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    try {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (p !== file && fs.statSync(p).mtimeMs < cutoff) tryRm(p);
      }
    } catch {}
  }
  args.push(`${flag}-file`, file);
}

/**
 * Append the flag block shared verbatim by headless (buildClaudeArgs) and
 * interactive (buildCliArgs) arg builders: model, effort, slash-commands,
 * bare, turn/budget limits, system-prompt flags, and a settings file.
 */
function _appendCommonFlags(args, p) {
  if (p.model) args.push('--model', p.model);
  if (p.effort) args.push('--effort', p.effort);
  if (p.disableSlashCommands) args.push('--disable-slash-commands');
  if (p.bare) args.push('--bare');
  if (p.maxTurns) args.push('--max-turns', String(p.maxTurns));
  if (p.maxBudgetUsd) args.push('--max-budget-usd', String(p.maxBudgetUsd));
  if (p.appendSystemPrompt) _promptArg(args, '--append-system-prompt', p.appendSystemPrompt);
  if (p.systemPrompt) _promptArg(args, '--system-prompt', p.systemPrompt);
  // A caller-supplied Claude Code settings file (hooks, permissions) layered on
  // top of the user's own settings. Add-ons use it to install per-session hooks
  // without generating a project `.claude/settings.json` that would travel with
  // the directory; the file is theirs to write and to keep current.
  if (p.settingsFile) args.push('--settings', p.settingsFile);
  return args;
}

function buildClaudeArgs(opts, { skipTools, outputFormat = 'stream-json' } = {}) {
  const args = ['-p'];
  if (outputFormat === 'stream-json') {
    args.push('--verbose', '--output-format', 'stream-json');
  } else if (outputFormat === 'json') {
    args.push('--output-format', 'json');
  }
  if (!opts) return args;
  if (opts.permissionMode && opts.permissionMode !== 'default') {
    args.push('--permission-mode', opts.permissionMode);
  }
  if (!skipTools) {
    if (opts.allowedTools?.length > 0) {
      args.push('--allowedTools', ...opts.allowedTools);
    }
    args.push('--allowedTools', 'mcp__integrated__*');
  }
  return _appendCommonFlags(args, opts);
}

/**
 * Build CLI args for interactive PTY mode.
 * No -p, --output-format, or --verbose flags.
 */
function buildCliArgs(settings) {
  const args = [];
  if (!settings) return args;
  return _appendCommonFlags(args, settings);
}

/**
 * Spawn `claude` with the proxy URL injected into the environment.
 */
// Live tracking of running Claude processes
// Map<instanceId, { proc, instanceId, spawnedAt, status, sourceContext, cwd }>
const _activeProcesses = new Map();
let _processBroadcaster = null;
function setProcessBroadcaster(broadcaster) { _processBroadcaster = broadcaster; }
function getActiveProcessCount() {
  let count = 0;
  for (const entry of _activeProcesses.values()) {
    if (entry.status === 'running') count++;
  }
  return count;
}

function getInstances() {
  return Array.from(_activeProcesses.values()).map(({ instanceId, spawnedAt, status, cwd, sourceContext }) => ({
    instanceId, spawnedAt, status, cwd: cwd || null, tabId: sourceContext?.tabId || null,
  }));
}

function getInstanceContext(instanceId) {
  const entry = _activeProcesses.get(instanceId);
  return entry?.sourceContext || null;
}

// An isolated session gets its own config root inside the project (transcripts,
// todos, file-history, settings) but NOT its own login: the credentials file is
// SYMLINKED to the global one, so a token refresh — or a `/login` run inside the
// tab — writes through to ~/.claude, the single source of truth that
// caps.hasClaudeSubscription() reads. Copying it (as this used to) let the two
// diverge: the copy rotated its own refresh token, the global file went stale,
// and the dashboard reported "no subscription" for a CLI that was logged in.
function prepareLocalConfigDir(cwd) {
  const localConfigDir = path.join(cwd, '.claude');
  fs.mkdirSync(localConfigDir, { recursive: true });
  const globalCreds = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(globalCreds)) {
    linkCredentials(globalCreds, path.join(localConfigDir, '.credentials.json'));
  }
  return localConfigDir;
}

// Point localCreds at globalCreds. Re-checked on every spawn because an atomic
// write (write-temp + rename) by the CLI replaces the symlink with a regular
// file; the next spawn restores the link. Replacing whatever is there is no more
// destructive than the unconditional copy this replaces. Falls back to a copy
// where symlinks aren't available.
function linkCredentials(globalCreds, localCreds) {
  try {
    if (fs.readlinkSync(localCreds) === globalCreds) return; // throws unless it is a symlink
  } catch {}
  try { fs.unlinkSync(localCreds); } catch {}
  try {
    fs.symlinkSync(globalCreds, localCreds);
  } catch {
    try { fs.copyFileSync(globalCreds, localCreds); } catch {}
  }
}

// One-time-per-boot sweep for the pre-symlink shape. Isolated spawns used to drop
// a COPY of ~/.claude/.credentials.json into <cwd>/.claude; a copy refreshes and
// ROTATES its own token, so it drifts from the global file and can invalidate it.
// Any copy still lying around is dead weight at best — remove it. An isolated
// session recreates the symlink through prepareLocalConfigDir on its next spawn.
//
// Bounded to directories this install already knows about (package root, data
// home, the CLI's recent-dirs list, the cwds in CLI session history), so it never
// walks the filesystem. Idempotent and cheap: after the first pass there is
// nothing left to find. Running it from server.js boot is also how a slave
// install picks it up — a slave runs this same server.
function pruneLegacyCredentialCopies() {
  const globalCreds = path.join(os.homedir(), '.claude', '.credentials.json');
  // Never prune the last remaining login: with no global file, a local copy may
  // be the only credentials on the box.
  if (!fs.existsSync(globalCreds)) return { removed: 0, paths: [], skipped: 'no-global-credentials' };

  const dirs = new Set([PACKAGE_ROOT, DATA_HOME]);
  for (const e of readJSON(path.join(DATA_HOME, 'data', 'cli-recent-dirs.json'), []) || []) {
    if (e && typeof e.path === 'string') dirs.add(e.path);
  }
  for (const e of readJSON(path.join(DATA_HOME, 'data', 'cli-history.json'), []) || []) {
    if (e && typeof e.cwd === 'string') dirs.add(e.cwd);
  }

  const paths = [];
  for (const dir of dirs) {
    const creds = path.join(dir, '.claude', '.credentials.json');
    try {
      if (path.resolve(creds) === path.resolve(globalCreds)) continue; // never the global file
      const st = fs.lstatSync(creds);  // throws when absent
      if (!st.isFile()) continue;      // a symlink is the fixed shape — leave it
      fs.unlinkSync(creds);
      paths.push(creds);
    } catch {}
  }
  return { removed: paths.length, paths };
}

/**
 * Build the environment a spawned `claude` process inherits: proxy base URL
 * (instance-scoped), isolated config dir, auto-memory toggle, and the
 * VISTACLAIR_* handshake vars. Shared by spawnClaude and spawnClaudePty.
 */
function buildClaudeEnv({ cwd, proxyPort, dashboardPort, authToken, instanceId, extraEnv, isolated, autoMemory, anthropicApiKey }) {
  const env = { ...process.env, ...extraEnv };
  delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  // Only set the API key when one is explicitly provided (headless / -p mode).
  // When absent, leave env untouched so the spawn runs as-is (subscription OAuth).
  if (anthropicApiKey) env.ANTHROPIC_API_KEY = anthropicApiKey;
  if (proxyPort) {
    env.ANTHROPIC_BASE_URL = `http://localhost:${proxyPort}/i/${encodeURIComponent(instanceId)}`;
  } else {
    delete env.ANTHROPIC_BASE_URL;
  }
  // Only an EXPLICITLY isolated session gets a project-local config root. Every
  // other site branches on `isolated === true`; defaulting to isolation here sent
  // headless spawns' transcripts to <cwd>/.claude while the session record said
  // ~/.claude, so --resume / rollback / delete looked in the wrong place.
  if (isolated === true) env.CLAUDE_CONFIG_DIR = prepareLocalConfigDir(cwd);
  if (!autoMemory) env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  if (dashboardPort) env.VISTACLAIR_DASHBOARD_PORT = String(dashboardPort);
  if (authToken) env.VISTACLAIR_AUTH_TOKEN = authToken;
  env.VISTACLAIR_INSTANCE_ID = instanceId;
  return env;
}

/**
 * Register a freshly-spawned process in the live-instance map, broadcast the
 * spawn, and return the exit handler to wire to the proc's exit event
 * (`.on('exit')` for child_process, `.onExit()` for pty). Shared by both spawns.
 */
function _trackProcess(instanceId, proc, sourceContext, cwd, autoMemory) {
  _activeProcesses.set(instanceId, { proc, instanceId, spawnedAt: Date.now(), status: 'running', sourceContext: { ...sourceContext, autoMemory: autoMemory === true }, cwd: cwd || null });
  _broadcastInstances('spawn', instanceId);
  return () => {
    const entry = _activeProcesses.get(instanceId);
    // Only mark exited if this proc is still the current one (avoids race on respawn)
    if (entry && entry.proc === proc) {
      entry.status = 'exited';
      _broadcastInstances('exit', instanceId);
      // One-shot headless spawns (app ai.prompt / json-repair) fire frequently
      // (cron, memory jobs) and would accumulate in this map forever. Drop them
      // after the exit broadcast — the inspector rebuilds their tabs from the
      // persisted interactions, not from this live-process list.
      const srcType = entry.sourceContext?.type;
      if (srcType === 'ai-prompt' || srcType === 'json-repair') {
        _activeProcesses.delete(instanceId);
      }
    }
  };
}

function spawnClaude(args, { cwd, proxyPort, dashboardPort, authToken, instanceId, sourceContext, extraEnv, isolated, autoMemory, anthropicApiKey }) {
  if (!instanceId) throw new Error('spawnClaude requires instanceId');
  const env = buildClaudeEnv({ cwd, proxyPort, dashboardPort, authToken, instanceId, extraEnv, isolated, autoMemory, anthropicApiKey });
  const proc = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.on('exit', _trackProcess(instanceId, proc, sourceContext, cwd, autoMemory));
  return proc;
}

/**
 * Spawn `claude` in interactive PTY mode with the proxy URL injected.
 */
function spawnClaudePty(args, { cwd, proxyPort, instanceId, sourceContext, cols, rows, dashboardPort, authToken, extraEnv, isolated, autoMemory, anthropicApiKey }) {
  if (!instanceId) throw new Error('spawnClaudePty requires instanceId');
  const env = buildClaudeEnv({ cwd, proxyPort, dashboardPort, authToken, instanceId, extraEnv, isolated, autoMemory, anthropicApiKey });

  const ptyProc = getPty().spawn('claude', args, {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd,
    env,
  });

  ptyProc.onExit(_trackProcess(instanceId, ptyProc, sourceContext, cwd, autoMemory));
  return ptyProc;
}

function killInstance(instanceId) {
  const entry = _activeProcesses.get(instanceId);
  if (!entry || entry.status !== 'running') return false;
  try { entry.proc.kill('SIGTERM'); } catch {}
  return true;
}

function removeInstances(instanceIds) {
  for (const id of instanceIds) {
    const entry = _activeProcesses.get(id);
    if (entry && entry.status !== 'running') _activeProcesses.delete(id);
  }
}

function _broadcastInstances(event, instanceId) {
  if (_processBroadcaster) {
    const instances = getInstances();
    const count = instances.filter(i => i.status === 'running').length;
    _processBroadcaster.broadcast({ type: 'claude:instances', event, instanceId, instances, count });
  }
}

const CLAUDE_AUTH_ERROR_RE = /not logged in|authentication failed|session has expired|please run.*claude login|invalid.*credentials|could not authenticate|oauth.*token.*expired|unauthorized|401.*auth|auth.*error|re-?authenticate/i;

function isClaudeAuthError(stderrText) {
  if (!stderrText) return false;
  return CLAUDE_AUTH_ERROR_RE.test(stderrText);
}

function describeClaudeError(exitCode, stderrText) {
  if (isClaudeAuthError(stderrText)) {
    return 'Claude is not authenticated. Run "claude login" in a terminal to re-authenticate.';
  }
  if (exitCode !== 0 && stderrText) {
    return `Claude CLI error (exit ${exitCode}): ${stderrText.trim().split('\n')[0]}`;
  }
  if (exitCode !== 0) {
    return `Claude CLI exited with code ${exitCode}`;
  }
  return null;
}

/**
 * Run a headless Claude that writes an artifact file, then read it back.
 *
 * Collapses the repeated "spawn claude → pipe prompt to stdin → wait with a
 * SIGTERM-then-SIGKILL timeout → check the expected file exists → read it →
 * describeClaudeError" dance used by proxy-rule generation/editing and MCP
 * tool AI-editing. Pure lifecycle wrapper — callers keep their own meta.json
 * handling and require()/syntax validation around it.
 *
 * @returns {Promise<{exitCode, stderr, fileExists, source?}>}
 *   Rejects only on spawn 'error'. A missing expectFile is reported via
 *   fileExists:false (callers decide how to surface it with describeClaudeError).
 */
function runClaudeArtifactTask({
  prompt,
  cwd,
  proxyPort,
  instanceId,
  expectFile = null,
  allowedTools,
  permissionMode = 'bypassPermissions',
  timeoutMs = 300000,
  anthropicApiKey,
}) {
  return new Promise((resolve, reject) => {
    const args = buildClaudeArgs({ permissionMode, allowedTools });
    const proc = spawnClaude(args, { cwd, proxyPort, instanceId, anthropicApiKey });

    const timer = setTimeout(() => killGracefully(proc), timeoutMs);

    let stderr = '';
    proc.stdout.on('data', () => {});
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });

    proc.on('close', (exitCode) => {
      clearTimeout(timer);
      const fileExists = expectFile ? fs.existsSync(expectFile) : true;
      let source;
      if (fileExists && expectFile) {
        try { source = fs.readFileSync(expectFile, 'utf-8'); } catch {}
      }
      resolve({ exitCode, stderr, fileExists, source });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

/**
 * Create a stream-json line parser.
 * Buffers chunks, splits on newlines, JSON.parses each complete line.
 * Calls onEvent(event) for valid JSON, onRaw(line) for non-JSON lines.
 * Returns { write(chunk), flush() → lastEvent? }.
 */
// --- Output directory sandboxing ---

const OUTPUTS_DIR = path.join(DATA_HOME, 'outputs');

// --- File I/O utilities ---

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Resolve `rel` against `base` and guarantee the result stays inside `base`.
 * Single source of truth for path-traversal containment in core.
 * Throws 'Path traversal not allowed' if the resolved path escapes base.
 */
function safeJoin(base, rel) {
  const resolved = path.resolve(base, rel);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error('Path traversal not allowed');
  }
  return resolved;
}

function readJSON(filePath, defaultValue = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return defaultValue;
  }
}

function writeJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

const FORWARD_REQUEST_HEADERS = [
  'x-api-key',
  'authorization',
  'anthropic-version',
  'anthropic-beta',
  'content-type',
];

const FORWARD_RESPONSE_HEADERS = [
  'content-type',
  'x-request-id',
  'request-id',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-limit',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset',
];

function filterRequestHeaders(headers) {
  const out = {};
  for (const key of FORWARD_REQUEST_HEADERS) {
    if (headers[key]) out[key] = headers[key];
  }
  return out;
}

function filterResponseHeaders(headers) {
  const out = {};
  for (const key of FORWARD_RESPONSE_HEADERS) {
    const val = headers.get ? headers.get(key) : headers[key];
    if (val) out[key] = val;
  }
  return out;
}

function _truncateImageData(data) {
  return typeof data === 'string' && data.length > 200
    ? data.slice(0, 100) + '...[truncated]'
    : data;
}

function _truncateImageBlock(block) {
  if (block.type === 'image' && block.source?.data) {
    return { ...block, source: { ...block.source, data: _truncateImageData(block.source.data) } };
  }
  return block;
}

function _sanitizeContentBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  let changed = false;
  const out = blocks.map(block => {
    const tb = _truncateImageBlock(block);
    if (tb !== block) { changed = true; return tb; }
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      let innerChanged = false;
      const innerOut = block.content.map(inner => {
        const ti = _truncateImageBlock(inner);
        if (ti !== inner) innerChanged = true;
        return ti;
      });
      if (innerChanged) { changed = true; return { ...block, content: innerOut }; }
    }
    return block;
  });
  return changed ? out : blocks;
}

function _truncateHookToolResponse(tr) {
  if (!tr || typeof tr !== 'object') return tr;
  if (tr.type === 'image' && tr.file?.base64) {
    return { ...tr, file: { ...tr.file, base64: _truncateImageData(tr.file.base64) } };
  }
  if (Array.isArray(tr)) {
    let changed = false;
    const out = tr.map(item => {
      const t = _truncateHookToolResponse(item);
      if (t !== item) changed = true;
      return t;
    });
    return changed ? out : tr;
  }
  return tr;
}

function sanitizeForDashboard(interaction) {
  if (!interaction || typeof interaction !== 'object') return null;
  const clone = { ...interaction };
  clone.response = { ...interaction.response };
  clone.timing = { ...interaction.timing };
  if (interaction.usage) clone.usage = { ...interaction.usage };
  if (interaction.request) {
    clone.request = { ...interaction.request };
    if (interaction.request.messages) {
      clone.request.messages = interaction.request.messages.map(msg => {
        if (!Array.isArray(msg.content)) return msg;
        const sanitized = _sanitizeContentBlocks(msg.content);
        return sanitized !== msg.content ? { ...msg, content: sanitized } : msg;
      });
    }
    if (interaction.isHook) {
      if (interaction.request.tool_response) {
        clone.request.tool_response = _truncateHookToolResponse(interaction.request.tool_response);
        clone.response = { ...clone.response, body: clone.request.tool_response };
      }
      if (Array.isArray(interaction.request.tool_calls)) {
        clone.request.tool_calls = interaction.request.tool_calls.map(tc => {
          if (!tc.tool_response) return tc;
          return { ...tc, tool_response: _truncateHookToolResponse(tc.tool_response) };
        });
      }
    }
  }
  if (interaction.requestHeaders) {
    clone.requestHeaders = { ...interaction.requestHeaders };
    for (const key of ['x-api-key', 'authorization']) {
      if (clone.requestHeaders[key]) {
        clone.requestHeaders[key] = '[redacted]';
      }
    }
  }
  return clone;
}

// --- AskUserQuestion file upload processing ---

/**
 * Process uploaded files from an ask:answer message.
 * Saves files to outputs/_uploads/<toolUseId>/, patches the answer array with relative paths.
 * @param {string} toolUseId - The tool_use_id for namespacing
 * @param {Array} files - Array of { questionId, name, data } where data is a base64 data URL
 * @param {Array} answer - The answer array to patch (file-type entries get path arrays)
 * @returns {Array} The patched answer array
 */
function processUploadedFiles(toolUseId, files, answer) {
  if (!files || !files.length) return answer;

  const uploadDir = path.join(OUTPUTS_DIR, '_uploads', toolUseId);
  ensureDir(uploadDir);

  // Group files by questionId
  const byQuestion = {};
  for (const f of files) {
    if (!byQuestion[f.questionId]) byQuestion[f.questionId] = [];

    // Sanitize filename: strip path separators, limit length, allowlist chars
    let safeName = (f.name || 'file').replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
    if (safeName.length > 200) safeName = safeName.slice(0, 200);

    // Decode base64 data URL
    const match = (f.data || '').match(/^data:[^;]*;base64,(.+)$/);
    if (!match) continue;

    const buffer = Buffer.from(match[1], 'base64');
    const filePath = path.join(uploadDir, safeName);
    fs.writeFileSync(filePath, buffer);

    // Relative path from project root (files live under outputs/)
    const relPath = `outputs/_uploads/${toolUseId}/${safeName}`;
    byQuestion[f.questionId].push(relPath);
  }

  // Patch answer entries
  if (Array.isArray(answer)) {
    for (const entry of answer) {
      if (byQuestion[entry.id]) {
        entry.answer = byQuestion[entry.id];
      }
    }
  }

  return answer;
}

// --- File placement for prompt attachments ---

module.exports = {
  generateId,
  filterRequestHeaders,
  filterResponseHeaders,
  sanitizeForDashboard,
  buildClaudeArgs,
  spawnClaude,
  pruneLegacyCredentialCopies,
  buildCliArgs,
  spawnClaudePty,
  setProcessBroadcaster,
  getActiveProcessCount,
  getInstances,
  getInstanceContext,
  killInstance,
  removeInstances,
  runClaudeArtifactTask,
  isClaudeAuthError,
  describeClaudeError,
  safeJoin,
  killGracefully,
  tryRm,
  MIME_TYPES,
  PACKAGE_ROOT,
  DATA_HOME,
  OUTPUTS_DIR,
  ensureDir,
  readJSON,
  writeJSON,
  processUploadedFiles,
};
