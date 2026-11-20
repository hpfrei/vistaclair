// app-lint: an ai.prompt call without allowedTools gets no tools (warn), and a
// grant that includes Bash / Write / Edit is flagged (warn). Never errors.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lint } = require('../src/apps/app-lint');

const dirs = [];
function appDir(files) {
  const dir = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-aitools-'));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const MANIFEST = JSON.stringify({ name: 'ai-app', description: 'x' });
const findings = (dir, rule) => lint(dir).filter((f) => f.rule === rule);

test('ctx.aiPrompt and Bridge ai.prompt without allowedTools warn', () => {
  const dir = appDir({
    'manifest.json': MANIFEST,
    'routes.js': "module.exports = (r, ctx) => { r.post('/x', async () => ctx.aiPrompt({ message: 'hi', model: 'haiku' })); };\n",
    'public/app.js': "const r = await Bridge.call('ai.prompt', { message: 'hi' });\n",
  });
  const f = findings(dir, 'ai-no-allowed-tools');
  assert.equal(f.length, 2);
  assert.ok(f.every((x) => x.level === 'warn' && /no allowedTools: this call gets no tools; pass \[\] or an explicit list/.test(x.message)));
});

test('allowedTools: [] or an explicit list does not warn', () => {
  const dir = appDir({
    'manifest.json': MANIFEST,
    'routes.js': [
      "module.exports = (r, ctx) => {",
      "  ctx.aiPrompt({ message: 'a', allowedTools: [] });",
      "  ctx.aiPrompt({ message: `b ${JSON.stringify({ a: 1 })}`, allowedTools: ['Read'] });",
      "};", '',
    ].join('\n'),
  });
  assert.deepEqual(findings(dir, 'ai-no-allowed-tools'), []);
  assert.deepEqual(findings(dir, 'ai-risky-allowed-tools'), []);
});

test('allowedTools naming Bash, Write or Edit warns', () => {
  const dir = appDir({
    'manifest.json': MANIFEST,
    'routes.js': [
      "module.exports = (r, ctx) => {",
      "  ctx.aiPrompt({ message: 'a', allowedTools: ['Read', 'Bash'] });",
      "  ctx.aiPrompt({ message: 'b', allowedTools: [\"Edit\"] });",
      "  ctx.aiPrompt({ message: 'c', allowedTools: ['Bash(git status:*)'] });",
      "  ctx.aiPrompt({ message: 'd', allowedTools: ['Read', 'WebFetch'] });",
      "};", '',
    ].join('\n'),
  });
  const f = findings(dir, 'ai-risky-allowed-tools');
  assert.deepEqual(f.map((x) => x.line), [2, 3, 4]);
  assert.ok(f.every((x) => x.level === 'warn'));
});
