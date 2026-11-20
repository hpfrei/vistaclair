// Per-session tool gate for platform ai.prompt sessions.
//
// Those sessions run headless with --dangerously-skip-permissions, so CLI-level
// --allowedTools is advisory only. This rule makes the caller's allowedTools an
// actual boundary: it strips tool definitions from the API request so the model
// never sees ungranted tools. The allowlist arrives via a tmpdir marker file
// written by app-bridge.js aiPrompt() (keyed by instanceId, deleted when the
// call ends): {none:true} = strip everything; {tools:[...]} = keep exactly
// those (wildcard suffix '*' supported, e.g. "mcp__app-tools__*").
//
// Sessions without a marker (CLI tabs, legacy ai.prompt calls that passed no
// allowedTools array) are untouched.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function (ctx) {
  const id = ctx.instanceId;
  if (!id || !/^app-[A-Za-z0-9._-]+-ai-[a-f0-9]+$/.test(id)) return;

  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `vistaclair-ai-allowed-${id}.json`), 'utf8'));
  } catch { return; } // no marker → ungated session

  if (spec.none) {
    delete ctx.body.tools;
    delete ctx.body.tool_choice;
    return;
  }

  if (!Array.isArray(ctx.body.tools) || !Array.isArray(spec.tools)) return;

  const exact = new Set(spec.tools);
  const prefixes = spec.tools.filter((t) => typeof t === 'string' && t.endsWith('*')).map((t) => t.slice(0, -1));
  // AskUserQuestion is rewritten to/from its MCP twin by auq-mcp-rewrite —
  // granting either name admits both forms.
  if (exact.has('AskUserQuestion') || exact.has('mcp__integrated__vista-AskUserQuestion')) {
    exact.add('AskUserQuestion');
    exact.add('mcp__integrated__vista-AskUserQuestion');
  }

  ctx.body.tools = ctx.body.tools.filter((t) =>
    t && typeof t.name === 'string' &&
    (exact.has(t.name) || prefixes.some((p) => t.name.startsWith(p))));
};
