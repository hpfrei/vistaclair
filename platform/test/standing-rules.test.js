// The app sessions' standing rules: one text, two readers. A dashboard-launched
// session runs with CLAUDE.md discovery off (its hooks.json) and gets the rules
// inlined in its prompt; `<appsDir>/CLAUDE.md` is the same text, generated, for
// sessions opened by hand.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const appManager = require('../src/apps/app-manager');
const promptBuilder = require('../src/apps/app-builder-prompt');
const rules = require('../src/apps/standing-rules');

const INSTALLED_APPS_DIR = appManager.APPS_DIR;

const dirs = [];
test.after(() => {
  appManager.setAppsDir(INSTALLED_APPS_DIR);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('every session prompt that runs with CLAUDE.md off carries the standing rules', () => {
  const text = rules.standingRules();
  assert.match(text, /^### Scope/m);
  assert.match(text, /### In an orchestration run/);
  for (const action of ['extend', 'build', 'build-tools']) {
    const prompt = promptBuilder.buildPrompt(action, { appName: action === 'build' ? 'fx-rules' : undefined, description: 'd', userRequest: 'u' });
    assert.ok(prompt.includes(text), `${action} lacks the standing rules`);
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt), `${action} has an unsubstituted placeholder`);
    assert.ok(!prompt.includes('project instructions (`CLAUDE.md`)'), `${action} still points at CLAUDE.md`);
  }
});

test('the launch settings switch CLAUDE.md discovery off and keep the read-ledger hook', () => {
  const root = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-rules-'));
  dirs.push(root);
  const dir = path.join(root, 'fx-rules');
  fs.mkdirSync(path.join(dir, '.vistaclair'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'fx-rules', description: 'x' }));
  appManager.setAppsDir(root);

  const file = promptBuilder.writeSidecars(dir, { action: 'extend', appName: 'fx-rules' });
  const settings = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(settings.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1');
  assert.ok(settings.claudeMdExcludes.includes(path.join(root, '**', 'CLAUDE.md')), JSON.stringify(settings.claudeMdExcludes));
  assert.ok(settings.hooks.PreToolUse.length, 'the read-ledger hook is still installed');
});

test('the generated CLAUDE.md is the same rules, one heading level up', () => {
  const md = rules.claudeMd();
  assert.match(md, /^# App sessions: standing rules/);
  assert.match(md, /^## Scope$/m);
  assert.match(md, /^## Workspace sessions$/m);
  assert.ok(!md.includes('{{'));
  assert.ok(!/^### /m.test(md));
  assert.ok(md.includes(rules.standingRules().replace(/^### /gm, '## ')));
});

test('the installed apps CLAUDE.md matches the standing rules (npm run apps:claudemd)', (t) => {
  if (!fs.existsSync(rules.claudeMdPath(INSTALLED_APPS_DIR))) return t.skip('no apps directory installed');
  assert.ok(rules.inSync(INSTALLED_APPS_DIR), 'run npm run apps:claudemd');
});
