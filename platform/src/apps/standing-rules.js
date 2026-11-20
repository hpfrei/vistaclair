#!/usr/bin/env node
// The app sessions' standing rules: ONE text (`prompts/_standing-rules.md`), two
// readers. A dashboard-launched session runs with CLAUDE.md discovery off (its
// `.vistaclair/hooks.json`, see app-builder-prompt.js) and gets the rules inlined
// by buildPrompt as {{STANDING_RULES}}. A session opened by hand in an app
// directory reads `<appsDir>/CLAUDE.md`, which is the same text rendered by
// claudeMd() — generated, never hand-edited.
//
//   node src/apps/standing-rules.js [--check] [appsDir]   (npm run apps:claudemd)
//
// Writes `<appsDir>/CLAUDE.md` (default appsDir: app-manager's), or with
// --check exits 1 when the file has drifted from the source.

const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

const read = (name) => fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf-8');

// The rules as a prompt carries them: `###` sections under the template's own
// `## Standing rules` heading.
function standingRules() {
  return read('_standing-rules').trimEnd();
}

// The rules as `<appsDir>/CLAUDE.md`: the same sections one level up, inside the
// file's own header and its workspace clause.
function claudeMd() {
  const rules = standingRules().replace(/^### /gm, '## ');
  return read('_apps-claude-md').split('{{STANDING_RULES}}').join(rules);
}

function claudeMdPath(appsDir) {
  return path.join(appsDir, 'CLAUDE.md');
}

// true when `<appsDir>/CLAUDE.md` matches the source (a missing file counts as drift).
function inSync(appsDir) {
  try { return fs.readFileSync(claudeMdPath(appsDir), 'utf-8') === claudeMd(); } catch { return false; }
}

function writeClaudeMd(appsDir) {
  fs.writeFileSync(claudeMdPath(appsDir), claudeMd(), 'utf-8');
}

module.exports = { standingRules, claudeMd, claudeMdPath, inSync, writeClaudeMd };

if (require.main === module) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const appsDir = path.resolve(args.find((a) => !a.startsWith('--')) || require('./app-manager').APPS_DIR);
  if (check) {
    if (inSync(appsDir)) { console.log(`${claudeMdPath(appsDir)} matches the standing rules`); process.exit(0); }
    console.error(`${claudeMdPath(appsDir)} has drifted from src/apps/prompts/_standing-rules.md — run npm run apps:claudemd`);
    process.exit(1);
  }
  writeClaudeMd(appsDir);
  console.log(`wrote ${claudeMdPath(appsDir)}`);
}
