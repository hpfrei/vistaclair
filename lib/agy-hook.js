#!/usr/bin/env node
// agy (Antigravity CLI) hook for Vistaclair agy sessions (docs/agy-workers.md).
// Installed by src/agy-worker-config.js in <worktree>/.agents/hooks.json for
// SessionStart, PreInvocation, PreToolUse, PostToolUse and Stop:
//
//   node lib/agy-hook.js <event>      (stdin: agy's hook JSON, env: agy's env)
//
// - PreToolUse is decided HERE, from the policy file ($VISTACLAIR_AGY_POLICY),
//   with no server round trip. agy reads `{}` as deny, so every path prints an
//   explicit decision; a broken policy file denies.
// - SessionStart (a new conversation only) injects the policy's
//   `sessionStartText` (the role card) as a systemMessage.
// - PreInvocation (once per model call) asks the server for queued messages
//   (POST /api/orchestration/agy-hook) and injects them. It fails open: no
//   server, an error or a slow answer prints `{}`, which injects nothing.
// - PostToolUse and Stop print `{}`.
//
// The policy file is role-agnostic: `writeRoots`, `mainConversation`,
// `pausing`, `deny` (name → reason), `sessionStartText`. agy's own subagents
// run in the same agy process and hit this hook with their own conversationId,
// so the write fence holds inside them too.
// It holds no secret; the session token is only in the env.
const fs = require('fs');
const path = require('path');
const http = require('http');

// agy's file-writing tools (hook-side names; the init list has a few aliases).
const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'write_to_file', 'replace_file_content',
  'multi_replace_file_content', 'sed_file', 'notebook_edit',
]);
const PATH_KEYS = ['Path', 'TargetFile', 'AbsolutePath', 'FilePath', 'File', 'path', 'file_path', 'target_file'];

// swarm is the one subagent cap: uncapped parallel fan-out would drain the
// Google quota. Single native subagents (invoke_subagent, define_subagent,
// manage_subagents, browser_subagent) are allowed.
const SWARM_REASON = 'swarm (uncapped parallel subagents) is off; spawn one subagent at a time with invoke_subagent';

// Denied by default, each with the Vistaclair replacement (D6). A policy's own
// `deny` map overrides or extends these.
const DEFAULT_DENY = {
  ask_question: 'Workers cannot ask the owner directly: ask the orchestrator with mcp_orchestrator_SendMessage, or call mcp_orchestrator_report with status "blocked" and ownerItems.',
  ask_permission: 'Not available here: ask the orchestrator with mcp_orchestrator_SendMessage, or report blocked.',
  ask_custom_permission: 'Not available here: ask the orchestrator with mcp_orchestrator_SendMessage, or report blocked.',
  swarm: SWARM_REASON,
  run_workflow: 'agy workflows are not used here: do the steps yourself, or one at a time with invoke_subagent.',
  schedule: 'Scheduling is not available to workers: the orchestrator schedules work. Ask it with mcp_orchestrator_SendMessage.',
};
const SEND_MESSAGE_REASON = 'To message the orchestrator or a peer use mcp_orchestrator_SendMessage.';
const PAUSING_REASON = 'You are being paused: do not start subagents now. Finish the current step and report.';
const SUBAGENT_STARTS = new Set(['invoke_subagent', 'browser_subagent', 'swarm']);

// Names that are allowed without being logged as unknown.
const KNOWN_ALLOWED = new Set([
  'read_file', 'view_file', 'list_dir', 'find_by_name', 'grep_search', 'search_web',
  'read_url', 'read_url_content', 'list_resources', 'read_resource', 'manage_task',
  'run_command', 'command_status', 'send_command_input', 'wait', 'wait_5_seconds', 'finish',
  'call_mcp_tool', 'generate_image', 'invoke_subagent', 'define_subagent', 'manage_subagents',
  'browser_subagent', 'send_message', 'manage_inbox',
  'list_permissions', 'notebook_execution', 'delete_knowledge', 'search_marketplace', 'list_plugin_accounts',
  'open_browser_url', 'read_browser_page', 'list_browser_pages', 'browser_click_element', 'browser_drag_pixel_to_pixel',
  'browser_get_dom', 'browser_get_network_request', 'browser_input', 'browser_list_network_requests',
  'browser_mouse_down', 'browser_mouse_up', 'browser_move_mouse', 'browser_press_key', 'browser_refresh_page',
  'browser_resize_window', 'browser_scroll', 'browser_scroll_dom', 'browser_select_option',
  'capture_browser_console_logs', 'capture_browser_screenshot', 'click_browser_pixel', 'execute_browser_javascript',
  ...WRITE_TOOLS,
]);

const allow = () => ({ decision: 'allow' });
const deny = (reason) => ({ decision: 'deny', reason });

// The real path of p, resolving symlinks through its deepest existing ancestor.
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch {}
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest.unshift(path.basename(cur));
    cur = up;
  }
}

function inside(root, p) {
  const r = realish(root);
  return p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

function targetPath(args) {
  if (!args || typeof args !== 'object') return null;
  for (const k of PATH_KEYS) if (typeof args[k] === 'string' && args[k]) return args[k];
  return null;
}

// The PreToolUse decision: { decision: 'allow' } or { decision: 'deny', reason },
// plus `unknown: name` for a name this table does not know (allowed).
function decide(policy, input) {
  if (!policy || typeof policy !== 'object') return deny('Vistaclair policy unavailable.');
  const call = (input && input.toolCall) || {};
  const name = String(call.name || '');
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  const denyMap = { ...DEFAULT_DENY, ...(policy.deny || {}) };

  // No new subagent work while the session is being paused.
  if (policy.pausing && SUBAGENT_STARTS.has(name)) return deny(PAUSING_REASON);
  if (Object.prototype.hasOwnProperty.call(denyMap, name) && denyMap[name]) return deny(denyMap[name]);

  if (WRITE_TOOLS.has(name)) {
    const raw = targetPath(args);
    if (!raw) return deny(`${name}: no target path found in the call.`);
    const roots = (policy.writeRoots || []).filter(Boolean);
    const p = realish(path.isAbsolute(raw) ? raw : path.join(input.cwd || roots[0] || '/', raw));
    if (roots.some(r => inside(r, p))) return allow();
    return deny(`${raw} is outside your worktree: you may only write inside ${roots.join(' or ')}.`);
  }

  if (name === 'send_message') {
    // A subagent replying to its parent runs in its own conversation.
    const conv = input.conversationId;
    if (policy.mainConversation && conv && conv !== policy.mainConversation) return allow();
    return deny(SEND_MESSAGE_REASON);
  }

  if (name.startsWith('mcp_') || KNOWN_ALLOWED.has(name)) return allow();
  return { decision: 'allow', unknown: name };
}

function readPolicy(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sessionStartAnswer(policy) {
  const text = policy && policy.sessionStartText;
  return text ? { injectSteps: [{ systemMessage: { systemMessage: String(text) } }] } : {};
}

// POST to the dashboard; resolves the parsed answer or null (never rejects).
function post(env, body, timeoutMs) {
  return new Promise((resolve) => {
    const port = env.VISTACLAIR_DASHBOARD_PORT;
    const token = env.VISTACLAIR_SESSION_TOKEN;
    if (!port || !token || !env.VISTACLAIR_INSTANCE_ID) return resolve(null);
    const data = JSON.stringify({ instanceId: env.VISTACLAIR_INSTANCE_ID, ...body });
    const req = http.request({
      hostname: '127.0.0.1', port: parseInt(port, 10), path: '/api/orchestration/agy-hook', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-vistaclair-session': token },
      agent: false,
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', c => { out += c; });
      res.on('end', () => { try { resolve(JSON.parse(out)); } catch { resolve(null); } });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(data);
  });
}

function pickInject(answer) {
  return answer && Array.isArray(answer.injectSteps) && answer.injectSteps.length ? { injectSteps: answer.injectSteps } : {};
}

async function run(event, input, env = process.env) {
  const policy = readPolicy(env.VISTACLAIR_AGY_POLICY || '');
  switch (event) {
    case 'PreToolUse': {
      const d = decide(policy, input);
      if (d.unknown) await post(env, { event: 'unknown-tool', name: d.unknown }, 1500);
      return d.decision === 'allow' ? allow() : deny(d.reason);
    }
    case 'SessionStart':
      return sessionStartAnswer(policy);
    case 'PreInvocation':
      return pickInject(await post(env, { event: 'PreInvocation', conversationId: input && input.conversationId, invocationNum: input && input.invocationNum }, 3000));
    default:
      return {};
  }
}

function main() {
  const event = process.argv[2] || '';
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { data += c; });
  process.stdin.on('end', async () => {
    let input = {};
    try { input = JSON.parse(data || '{}'); } catch {}
    let out;
    try { out = await run(event, input); } catch { out = event === 'PreToolUse' ? deny('Vistaclair hook error.') : {}; }
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  });
  // Hard stop well inside agy's 10 s hook timeout.
  setTimeout(() => {
    process.stdout.write(JSON.stringify(event === 'PreToolUse' ? deny('Vistaclair hook timed out.') : {}) + '\n');
    process.exit(0);
  }, 8000).unref();
}

if (require.main === module) main();

module.exports = { decide, run, realish, sessionStartAnswer, DEFAULT_DENY, WRITE_TOOLS };
