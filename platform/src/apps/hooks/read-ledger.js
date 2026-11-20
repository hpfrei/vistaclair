#!/usr/bin/env node
// Read ledger — a PreToolUse hook that records which `.vistaclair/` sidecar files
// an app session actually read.
//
// Why a hook and not a rule in the prompt: every interactive session is spawned
// with `--dangerously-skip-permissions` and edits through Bash (sed, heredocs),
// so nothing about a session's behaviour is observable from its diffs alone. Reads
// ARE observable — they go through `Read` or through a Bash command — and that is
// enough: app-lint then reconciles the code against what was inlined into the
// prompt plus what was read (rule `unread-capability`).
//
// Installed by the launcher as `<appDir>/.vistaclair/hooks.json`, handed to the CLI
// with `--settings`. Appends one JSON line per matched path to
// `<cwd>/.vistaclair/reads.jsonl`, and ONLY when that directory is a live session
// directory (`inlined.json` present) — a read in any other cwd is not this app's.
//
// Never blocks, never fails a tool call: exit 0 on every path.

const fs = require('fs');
const path = require('path');

// Anything the session is pointed at by name. `api-reference` is the whole
// reference, so it counts as every section at once — recorded as `all`.
const REF = /\.vistaclair\/(api\/[a-z0-9-]+|apps\/[^/\s'"]+|scaffolds|appmd-format|appmd-maintenance|migration|platform-request|app-request|api-reference)\.md/g;

function keysIn(text) {
  const out = [];
  if (!text) return out;
  REF.lastIndex = 0;
  let m;
  while ((m = REF.exec(String(text))) !== null) out.push(m[1] === 'api-reference' ? 'all' : m[1]);
  return out;
}

function record(payload) {
  const tool = payload.tool_name;
  const input = payload.tool_input || {};
  let text = null;
  if (tool === 'Read') text = input.file_path;
  else if (tool === 'Bash') text = input.command;
  if (!text) return;

  const keys = keysIn(text);
  if (!keys.length) return;

  const cwd = payload.cwd || process.cwd();
  const dir = path.join(cwd, '.vistaclair');
  if (!fs.existsSync(path.join(dir, 'inlined.json'))) return;   // not a launched session dir

  const at = new Date().toISOString();
  const instanceId = process.env.VISTACLAIR_INSTANCE_ID || null;
  const lines = [...new Set(keys)].map((key) => JSON.stringify({ at, instanceId, key })).join('\n') + '\n';
  fs.appendFileSync(path.join(dir, 'reads.jsonl'), lines, 'utf-8');
}

module.exports = { keysIn, record };

// Only as a hook. Required from a test, the module must not touch stdin.
if (require.main === module) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { data += c; });
  process.stdin.on('end', () => {
    try { record(JSON.parse(data)); } catch {}
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
