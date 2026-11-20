// The read scope of a headless aiPrompt run.
//
// The AI child runs with --dangerously-skip-permissions, so the CLI itself
// refuses nothing, and the proxy gate (ai-tool-gate) only filters tool NAMES.
// This module bounds PATHS: a run granted a file tool may only touch its
// `readRoots` (absolute directories or files). Enforcement is a PreToolUse hook
// the CLI runs before every tool call (`--settings`), plus `--tools <list>` so
// the child does not even register the tools it was not granted. The hook is
// ai-read-scope-hook.js, which calls decide() below; a hook that cannot decide
// (bad input, missing scope file, crash) denies.
//
// Fail closed: planReadScope() proves the hook works (hookSelfTest) and that
// managed settings do not switch hooks off before it lets a run keep a file
// tool; otherwise the file tools are removed from the grant and the plan says
// why. docs/ai-read-scope.md has the threat model and the residual risks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK_SCRIPT = path.join(__dirname, 'ai-read-scope-hook.js');

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead', 'LS']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'Monitor', 'BashOutput', 'KillShell']);
// Tools that touch no path of the host. mcp__* are authorised by the broker.
const SAFE_TOOLS = new Set(['ToolSearch', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'TodoWrite']);
// Never readable, even inside a root (every app dir holds its own).
const DENY_BASENAMES = new Set(['.secrets_key']);
const DENY_PREFIXES = ['/proc', '/sys', '/dev'];

const toolName = (t) => String(t || '').split('(')[0].trim();
const isMcp = (n) => n.startsWith('mcp__');
const isFileTool = (n) => READ_TOOLS.has(n) || WRITE_TOOLS.has(n);
const under = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const denied = (reason) => ({ allow: false, reason });

function lexicallyForbidden(p) {
  return DENY_PREFIXES.some((d) => under(p, d));
}

// A path (absolute, or relative to cwd) to its real location, or {deny}.
// A raw ".." is refused outright: path.resolve would collapse `link/..` before
// the link is followed. A missing target resolves through its deepest existing
// ancestor, so a file about to be written is judged by where it would land.
function resolveTarget(p, cwd) {
  if (typeof p !== 'string' || !p) return { deny: 'empty path' };
  if (p.includes('\0')) return { deny: 'invalid path' };
  if (p.startsWith('~')) return { deny: 'a ~ path is not expanded here; give an absolute path' };
  if (p.split(/[\\/]+/).includes('..')) return { deny: 'a ".." segment is not allowed' };
  let abs;
  if (path.isAbsolute(p)) abs = path.normalize(p);
  else if (typeof cwd === 'string' && path.isAbsolute(cwd)) abs = path.join(cwd, p);
  else return { deny: 'a relative path with no working directory' };
  if (lexicallyForbidden(abs)) return { deny: 'that location is not readable' };
  const tail = [];
  let cur = abs;
  for (;;) {
    let real = null;
    try { real = fs.realpathSync(cur); } catch (err) {
      if (err.code !== 'ENOENT') return { deny: `cannot resolve the path (${err.code || 'error'})` };
      try { fs.lstatSync(cur); return { deny: 'a dangling link' }; } catch { /* really missing */ }
    }
    if (real !== null) {
      const full = tail.length ? path.join(real, ...tail) : real;
      return lexicallyForbidden(full) ? { deny: 'that location is not readable' } : { real: full };
    }
    const parent = path.dirname(cur);
    if (parent === cur) return { deny: 'no existing parent' };
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}

function checkPath(p, scope, cwd, what) {
  const r = resolveTarget(p, cwd);
  if (r.deny) return denied(`${what}: ${r.deny}`);
  if (DENY_BASENAMES.has(path.basename(r.real))) return denied(`${what}: that file is never readable`);
  const roots = Array.isArray(scope?.roots) ? scope.roots : [];
  if (!roots.some((root) => under(r.real, root))) return denied(`${what}: ${r.real} is outside the readable roots`);
  return { allow: true };
}

// The directory part of a Glob pattern / Grep glob, as far as it is literal.
function checkGlob(pattern, scope, cwd, what) {
  if (pattern === undefined || pattern === null || pattern === '') return { allow: true };
  if (typeof pattern !== 'string') return denied(`${what}: invalid pattern`);
  if (pattern.includes('\0')) return denied(`${what}: invalid pattern`);
  if (pattern.split(/[\\/]+/).includes('..')) return denied(`${what}: a ".." segment is not allowed`);
  if (pattern.startsWith('~')) return denied(`${what}: a ~ pattern is not allowed`);
  if (/[{,]\s*[/~]/.test(pattern)) return denied(`${what}: an absolute path inside an alternation`);
  if (!pattern.startsWith('/')) return { allow: true }; // relative to the directory checked separately
  const segs = pattern.split('/');
  const lit = [];
  for (const s of segs) { if (/[*?[\]{}!]/.test(s)) break; lit.push(s); }
  const prefix = lit.join('/') || '/';
  return checkPath(prefix, scope, cwd, what);
}

// decide(tool, input, scope, cwd) -> { allow: true } | { allow: false, reason }
// scope = { roots: [real paths], allowShell?: boolean }
function decide(tool, input, scope, cwd) {
  const name = toolName(tool);
  const inp = input && typeof input === 'object' ? input : {};
  if (isMcp(name) || SAFE_TOOLS.has(name)) {
    if (name === 'WebFetch') {
      let proto = '';
      try { proto = new URL(String(inp.url || '')).protocol; } catch { /* below */ }
      if (proto !== 'http:' && proto !== 'https:') return denied('WebFetch: only http(s) URLs');
    }
    return { allow: true };
  }
  if (SHELL_TOOLS.has(name)) {
    return scope?.allowShell === true ? { allow: true } : denied(`${name}: a shell is not available in a read-scoped run`);
  }
  switch (name) {
    case 'Read': case 'Write': case 'Edit':
      return checkPath(inp.file_path, scope, cwd, name);
    case 'NotebookEdit': case 'NotebookRead':
      return checkPath(inp.notebook_path, scope, cwd, name);
    case 'LS':
      return checkPath(inp.path, scope, cwd, name);
    case 'Glob': {
      const dir = checkPath(inp.path || cwd, scope, cwd, name);
      return dir.allow ? checkGlob(inp.pattern, scope, cwd, name) : dir;
    }
    case 'Grep': {
      const dir = checkPath(inp.path || cwd, scope, cwd, name);
      return dir.allow ? checkGlob(inp.glob, scope, cwd, name) : dir;
    }
    default:
      return denied(`${name || 'unknown tool'}: not available in a read-scoped run`);
  }
}

// ---- roots ----------------------------------------------------------------

// Real, existing, absolute paths only. Refused: "/", HOME or an ancestor of it,
// anything in /proc /sys /dev or in ~/.claude, and the apps directory or any
// ancestor of it (it holds the secrets key and every app's data); a platform
// caller names the files it needs. Nested and duplicate roots collapse.
function canonicalizeRoots(roots, { appsDir, home = os.homedir() } = {}) {
  const rejected = [];
  const accepted = [];
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const realApps = appsDir ? real(appsDir) : null;
  const realHome = real(home);
  const claudeDir = realHome ? path.join(realHome, '.claude') : null;
  for (const root of Array.isArray(roots) ? roots : []) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) { rejected.push({ root, reason: 'not an absolute path' }); continue; }
    const r = real(root);
    if (r === null) { rejected.push({ root, reason: 'does not exist' }); continue; }
    if (r === path.parse(r).root) { rejected.push({ root, reason: 'the filesystem root' }); continue; }
    if (lexicallyForbidden(r)) { rejected.push({ root, reason: 'a system directory' }); continue; }
    if (realHome && under(realHome, r)) { rejected.push({ root, reason: 'the home directory or a parent of it' }); continue; }
    if (claudeDir && under(r, claudeDir)) { rejected.push({ root, reason: 'the CLI configuration' }); continue; }
    if (realApps && under(realApps, r)) { rejected.push({ root, reason: 'the apps directory or a parent of it' }); continue; }
    accepted.push(r);
  }
  const unique = [...new Set(accepted)];
  return { roots: unique.filter((r) => !unique.some((o) => o !== r && under(r, o))), rejected };
}

// ---- the plan -------------------------------------------------------------

// Hook proof, run once per hook-script version: the real script, a throwaway
// scope. An inside Read must pass and /proc/self/environ must be refused.
let selfTestCache = null;
function hookSelfTest() {
  let key;
  try { key = `${process.execPath}:${fs.statSync(HOOK_SCRIPT).mtimeMs}`; } catch (err) { return { ok: false, error: `hook script missing (${err.code || err.message})` }; }
  if (selfTestCache && selfTestCache.key === key) return selfTestCache.result;
  let dir = null;
  let result;
  try {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-scope-test-')));
    const file = path.join(dir, 'probe.txt');
    fs.writeFileSync(file, 'x');
    const scopeFile = path.join(dir, 'scope.json');
    fs.writeFileSync(scopeFile, JSON.stringify({ v: 1, roots: [dir] }));
    const run = (tool_input) => spawnSync(process.execPath, [HOOK_SCRIPT, scopeFile], {
      input: JSON.stringify({ tool_name: 'Read', tool_input, cwd: dir }), encoding: 'utf8', timeout: 10000,
    });
    const inside = run({ file_path: file });
    const outside = run({ file_path: '/proc/self/environ' });
    result = inside.status === 0 && outside.status === 2
      ? { ok: true }
      : { ok: false, error: `hook self-test failed (inside=${inside.status}, outside=${outside.status})` };
  } catch (err) {
    result = { ok: false, error: `hook self-test failed: ${err.message}` };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  selfTestCache = { key, result };
  return result;
}

// Managed settings can switch hooks off for every flag/user setting; then the
// hook cannot be relied on.
function managedHooksBlocked() {
  const files = ['/etc/claude-code/managed-settings.json'];
  try {
    for (const f of fs.readdirSync('/etc/claude-code/managed-settings.d')) if (f.endsWith('.json')) files.push(path.join('/etc/claude-code/managed-settings.d', f));
  } catch { /* none */ }
  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (err) { if (err.code === 'ENOENT') continue; return true; }
    if (s && (s.disableAllHooks === true || s.allowManagedHooksOnly === true)) return true;
  }
  return false;
}

const DEFAULT_PROBES = { hookSelfTest, managedHooksBlocked };

// planReadScope -> {
//   scoped, active, allowedTools (the grant to use), builtinTools (for --tools),
//   roots, allowShell, stripped, reason, tier }
// scoped: the grant held a file tool (or a shell, for the platform caller).
// active: the hook enforces `roots` for this run.
function planReadScope({ appName, appDir, appsDir, allowedTools, readRoots, probes = DEFAULT_PROBES }) {
  const grant = Array.isArray(allowedTools) ? allowedTools : [];
  if (readRoots !== undefined && readRoots !== null && !Array.isArray(readRoots)) throw new Error('readRoots must be an array of absolute paths');
  const isPlatform = appName === 'platform';
  const names = grant.map(toolName);
  const scoped = names.some((n) => isFileTool(n) || (isPlatform && SHELL_TOOLS.has(n)));
  const plan = { scoped, active: false, allowedTools: grant, builtinTools: [], roots: [], allowShell: false, stripped: [], reason: null, tier: 'none' };
  if (!scoped) return plan;

  let reason = null;
  let roots = [];
  const candidate = readRoots ?? (isPlatform ? [] : [appDir]);
  if (isPlatform && !(Array.isArray(candidate) && candidate.length)) {
    reason = 'platform callers must pass readRoots (absolute files or directories); file tools removed';
  } else {
    const c = canonicalizeRoots(candidate, { appsDir });
    roots = c.roots;
    if (!isPlatform) {
      const realApp = (() => { try { return fs.realpathSync(appDir); } catch { return null; } })();
      const inside = realApp ? roots.filter((r) => under(r, realApp)) : [];
      if (inside.length !== roots.length) c.rejected.push({ root: '(outside the app directory)', reason: 'an app may only read inside its own directory' });
      roots = inside;
    }
    if (!roots.length) {
      reason = `no usable readRoots (${c.rejected.map((x) => `${x.root}: ${x.reason}`).join('; ') || 'none given'}); file tools removed`;
    }
  }
  if (roots.length) {
    let blocked = null;
    try {
      const st = probes.hookSelfTest();
      if (!st.ok) blocked = st.error || 'hook self-test failed';
      else if (probes.managedHooksBlocked()) blocked = 'managed settings disable hooks';
    } catch (err) { blocked = `hook check failed: ${err.message}`; }
    if (blocked) { roots = []; reason = `read-scope hook unavailable (${blocked}); file tools removed`; }
  }

  const keep = [];
  for (const t of grant) {
    const n = toolName(t);
    const fileTool = isFileTool(n);
    const shell = SHELL_TOOLS.has(n);
    const ok = isMcp(n) || SAFE_TOOLS.has(n)
      || (fileTool && roots.length > 0)
      || (shell && !isPlatform);
    // With roots, anything that is neither a path tool, a safe tool nor an
    // app's own shell (agents, workflows, a future tool) is dropped too.
    if (ok) keep.push(t); else plan.stripped.push(n);
  }
  plan.allowedTools = keep;
  plan.roots = roots;
  plan.active = roots.length > 0;
  plan.tier = plan.active ? 'hook' : 'none';
  plan.allowShell = !isPlatform && keep.some((t) => SHELL_TOOLS.has(toolName(t)));
  plan.reason = roots.length ? (plan.stripped.length ? `tools removed from a read-scoped grant: ${plan.stripped.join(', ')}` : null) : reason;
  const builtin = keep.filter((t) => !isMcp(toolName(t))).map(toolName);
  plan.builtinTools = keep.length ? [...new Set([...builtin, 'ToolSearch'])] : [];
  return plan;
}

// What a caller sees on the result of the call.
function publicScope(plan) {
  return { tier: plan.tier, roots: plan.roots, stripped: plan.stripped, reason: plan.reason };
}

// ---- the hook wiring -------------------------------------------------------

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function hookSettingsJson(scopeFile) {
  return JSON.stringify({
    // A user setting must not switch our hook off (flag settings win).
    disableAllHooks: false,
    hooks: {
      PreToolUse: [{
        matcher: '*',
        hooks: [{ type: 'command', command: `${shellQuote(process.execPath)} ${shellQuote(HOOK_SCRIPT)} ${shellQuote(scopeFile)}`, timeout: 30 }],
      }],
    },
  });
}

function scopeFilePath(instanceId) {
  return path.join(os.tmpdir(), `vistaclair-ai-scope-${instanceId}.json`);
}

// Keyed by the call's instanceId like the ai-tool-gate marker; mode 0600.
function writeScopeFile(instanceId, plan) {
  const file = scopeFilePath(instanceId);
  fs.writeFileSync(file, JSON.stringify({ v: 1, roots: plan.roots, allowShell: plan.allowShell }), { mode: 0o600 });
  return file;
}

module.exports = {
  HOOK_SCRIPT, READ_TOOLS, WRITE_TOOLS, SHELL_TOOLS, SAFE_TOOLS,
  decide, resolveTarget, canonicalizeRoots, planReadScope, publicScope, hookSelfTest, managedHooksBlocked,
  hookSettingsJson, writeScopeFile, scopeFilePath, shellQuote,
};
