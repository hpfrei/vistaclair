#!/usr/bin/env node
// PreToolUse hook the AI CLI runs for a read-scoped aiPrompt run (wired by
// ai-read-scope.hookSettingsJson). argv[2] = the call's scope file. Exit 0 =
// allow (no output); exit 2 = deny, with the reason on stderr for the model.
// Anything that goes wrong (bad stdin, missing or corrupt scope file, a throw)
// is a deny: this script must never fail open.
'use strict';
const fs = require('fs');

function deny(reason) {
  try { process.stderr.write(`Read scope: ${reason}\n`); } catch { /* nothing left to do */ }
  process.exit(2);
}
process.on('uncaughtException', (err) => deny(`internal error (${err && err.message})`));

try {
  const { decide } = require('./ai-read-scope');
  const scopeFile = process.argv[2];
  if (!scopeFile) deny('no scope file');
  const scope = JSON.parse(fs.readFileSync(scopeFile, 'utf8'));
  if (!scope || scope.v !== 1 || !Array.isArray(scope.roots)) deny('invalid scope file');
  const event = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!event || typeof event.tool_name !== 'string') deny('unreadable tool call');
  const verdict = decide(event.tool_name, event.tool_input, scope, event.cwd);
  if (verdict.allow !== true) deny(verdict.reason || 'denied');
  process.exit(0);
} catch (err) {
  deny(`internal error (${err && err.message})`);
}
