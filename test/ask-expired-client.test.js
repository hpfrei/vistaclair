// An ask whose tool call ended stays on the dashboard, marked expired
// (public/cli.js): routing of the new ask:* messages and the messages it sends.
// There is no DOM harness for the ask modal, so this checks the source.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cli = fs.readFileSync(path.join(__dirname, '../public/cli.js'), 'utf8');
const core = fs.readFileSync(path.join(__dirname, '../public/core.js'), 'utf8');

test('core.js routes the new ask messages to the CLI module, ask:timeout is gone', () => {
  const block = core.match(/case 'ask:question':[\s\S]*?window\.cliModule\?\.handleAskMessage\(msg\);/)[0];
  for (const t of ['ask:expired', 'ask:closed', 'ask:lateResult', 'ask:answerError']) assert.ok(block.includes(`case '${t}':`), t);
  assert.ok(!core.includes("'ask:timeout'"));
  assert.ok(!cli.includes("'ask:timeout'"));
});

test('cli.js: expired mode switches in place and sends ask:late / ask:discard', () => {
  assert.match(cli, /case 'ask:expired': \{[\s\S]*?open\.expire\(\{ at: msg\.at, reason: msg\.reason \}\)/);
  assert.match(cli, /`This question expired at \$\{askClock\(info\?\.at\)\} — the session moved on\$\{info\?\.reason \? ` \(\$\{info\.reason\}\)` : ''\}`/);
  // A refined reason updates the banner of a form expired already.
  assert.match(cli, /if \(entry\.expired\) \{ if \(expiredText\) expiredText\.textContent = expiredLine\(info\); return; \}/);
  assert.match(cli, /sendWs\(\{ type: 'ask:late', toolUseId: l\.toolUseId, answer: l\.answer, files: l\.files \}\)/);
  assert.match(cli, /sendWs\(\{ type: 'ask:discard', toolUseId: form\.toolUseId \}\)/);
  assert.match(cli, /case 'ask:answered':\n\s+case 'ask:closed': \{\n\s+if \(msg\.askId\) dismissAskModal\(msg\.askId\);/);
  // Closing a tab keeps an expired ask; a server restart drops everything.
  assert.match(cli, /function removeTab\(tabId\) \{[\s\S]*?dismissAskModalsForTab\(tabId, \{ keepExpired: true \}\)/);
  assert.match(cli, /function _teardownAllTabsLocal\(\) \{[\s\S]*?dismissAskModalsForTab\(tabId\);/);
});
