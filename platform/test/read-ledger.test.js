// The read ledger and its lint reconciliation: a session is told to read a
// capability's sidecar before using it, a PreToolUse hook records the reads it
// makes, and app-lint turns "you were told to" into a check.
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PRO = path.join(__dirname, '..');
const HOOK = path.join(PRO, 'src', 'apps', 'hooks', 'read-ledger.js');
const { lint } = require('../src/apps/app-lint');
const promptBuilder = require('../src/apps/app-builder-prompt');
const capabilities = require('../src/apps/capabilities');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), prefix));
}

// An app directory that already looks like a launched session: it uses
// ctx.email, and the launcher's three files are in place. The baseline is what
// the launch found: nothing, unless a test says otherwise — so every use the
// fixture's files show is new, as in a session that wrote them.
function sessionApp({ inlined = [], manifest = {}, routes, action = 'extend', baseline = {} } = {}) {
  const root = tmpDir('vc-ledger-');
  const dir = path.join(root, 'fx-ledger');
  fs.mkdirSync(path.join(dir, '.vistaclair', 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'),
    JSON.stringify({ name: 'fx-ledger', description: 'ledger fixture', capabilities: {}, ...manifest }, null, 2));
  fs.writeFileSync(path.join(dir, 'routes.js'), routes
    || 'module.exports = (router, ctx) => {\n  router.get("/x", async (q, r) => r.json(await ctx.email.list({ limit: 1 })));\n};\n');
  fs.writeFileSync(path.join(dir, 'APP.md'), '# fx-ledger\n## Purpose\nfixture\n');
  const vc = path.join(dir, '.vistaclair');
  fs.writeFileSync(path.join(vc, 'inlined.json'), JSON.stringify({ at: new Date().toISOString(), action, keys: inlined, baseline }));
  fs.writeFileSync(path.join(vc, 'hooks.json'), '{}');
  fs.writeFileSync(path.join(vc, 'reads.jsonl'), '');
  return dir;
}

function ledger(dir) {
  return fs.readFileSync(path.join(dir, '.vistaclair', 'reads.jsonl'), 'utf-8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l).key);
}

// Make a file look like the session wrote it: mtime after the launch stamp in
// inlined.json. Real sessions get this for free (they run for minutes); a test
// that writes every file in the same millisecond does not.
function wroteAfterLaunch(dir, relPath, body) {
  const file = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (body != null) fs.writeFileSync(file, body);
  const at = JSON.parse(fs.readFileSync(path.join(dir, '.vistaclair', 'inlined.json'), 'utf-8')).at;
  const when = new Date(Date.parse(at) + 5000);
  fs.utimesSync(file, when, when);
}

// Fire the hook exactly as Claude Code does: the event as JSON on stdin.
function fireHook(cwd, payload) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd, hook_event_name: 'PreToolUse', ...payload }),
    encoding: 'utf-8',
  });
  return out;
}

const errorsOf = (dir, rule) => lint(dir).filter((f) => f.level === 'error' && f.rule === rule);

// ---- the hook ---------------------------------------------------------------

test('a Bash read of a section sidecar is recorded under its key', () => {
  const dir = sessionApp();
  fireHook(dir, { tool_name: 'Bash', tool_input: { command: 'sed -n 1,40p .vistaclair/api/telegram.md' } });
  assert.deepStrictEqual(ledger(dir), ['api/telegram']);
});

test('a Read of a section sidecar is recorded, absolute path and all', () => {
  const dir = sessionApp();
  fireHook(dir, { tool_name: 'Read', tool_input: { file_path: path.join(dir, '.vistaclair', 'api', 'ui-dialog.md') } });
  assert.deepStrictEqual(ledger(dir), ['api/ui-dialog']);
});

test('one Bash command naming two files records both', () => {
  const dir = sessionApp();
  fireHook(dir, { tool_name: 'Bash', tool_input: { command: 'cat .vistaclair/api/maps.md .vistaclair/apps/other-app.md' } });
  assert.deepStrictEqual(ledger(dir).sort(), ['api/maps', 'apps/other-app']);
});

test('a read of the full reference is recorded as "all"', () => {
  const dir = sessionApp();
  fireHook(dir, { tool_name: 'Bash', tool_input: { command: 'head -200 .vistaclair/api-reference.md' } });
  assert.deepStrictEqual(ledger(dir), ['all']);
});

test('nothing is recorded for another tool, another path, or malformed input', () => {
  const dir = sessionApp();
  fireHook(dir, { tool_name: 'Edit', tool_input: { file_path: '.vistaclair/api/email.md' } });
  fireHook(dir, { tool_name: 'Bash', tool_input: { command: 'cat routes.js' } });
  execFileSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf-8' });
  assert.deepStrictEqual(ledger(dir), []);
});

test('a cwd that is not a launched session directory is left alone', () => {
  const root = tmpDir('vc-ledger-bare-');
  fs.mkdirSync(path.join(root, '.vistaclair'), { recursive: true });
  fireHook(root, { tool_name: 'Bash', tool_input: { command: 'sed -n 1,40p .vistaclair/api/telegram.md' } });
  assert.deepStrictEqual(fs.readdirSync(path.join(root, '.vistaclair')), []);
});

// ---- what the launcher writes ------------------------------------------------

test('writeSidecars records the inlined set, empties the ledger and installs the hook', () => {
  const dir = sessionApp({ inlined: ['stale'], manifest: { capabilities: { email: true } } });
  fs.writeFileSync(path.join(dir, '.vistaclair', 'reads.jsonl'), '{"key":"api/leftover"}\n');
  // appManager resolves the manifest by name, so point it at this fixture's parent.
  require('../src/apps/app-manager').setAppsDir(path.dirname(dir));

  const settingsFile = promptBuilder.writeSidecars(dir, { action: 'extend', appName: 'fx-ledger', userRequest: 'list my email' });
  assert.strictEqual(settingsFile, path.join(dir, '.vistaclair', 'hooks.json'));

  const inlined = JSON.parse(fs.readFileSync(path.join(dir, '.vistaclair', 'inlined.json'), 'utf-8'));
  assert.strictEqual(inlined.action, 'extend');
  // The same set the prompt slicer keeps — one implementation, or the linter
  // would demand a read of a section the session was handed.
  assert.deepStrictEqual(inlined.keys,
    [...promptBuilder.inlinedKeys({ appName: 'fx-ledger', userRequest: 'list my email' })].sort());
  assert.ok(inlined.keys.includes('email'));
  assert.deepStrictEqual(inlined.baseline, { 'routes.js': ['email'] });

  assert.strictEqual(fs.readFileSync(path.join(dir, '.vistaclair', 'reads.jsonl'), 'utf-8'), '');
  assert.ok(fs.existsSync(path.join(dir, '.vistaclair', 'api', 'email.md')));

  const hooks = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
  const entry = hooks.hooks.PreToolUse[0];
  assert.strictEqual(entry.matcher, 'Read|Bash');
  assert.ok(entry.hooks[0].command.includes(HOOK), entry.hooks[0].command);
  assert.ok(fs.existsSync(HOOK));
});

test('a launched change session is handed the hook settings file', async () => {
  const dir = sessionApp({ manifest: { capabilities: { email: true } } });
  const apps = require('../src/apps/index');
  const calls = [];
  apps.initSessions({
    appsDir: path.dirname(dir),
    proxyPort: 0,
    broadcaster: { broadcast() {} },
    cliSessionManager: { launchSession: (tabId, o) => calls.push({ tabId, o }), onExit() {} },
  });
  await apps.launchChangeSession('fx-ledger', { action: 'extend', prompt: 'send a mail' });

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].o.settings.settingsFile, path.join(dir, '.vistaclair', 'hooks.json'));
  // Core turns that option into the flag the CLI understands. Skipped where the
  // core package is not a sibling checkout (Pro never requires core by path).
  const coreUtils = path.join(process.env.VISTACLAIR_CORE_DIR || path.join(PRO, '..'), 'src', 'utils.js');
  if (fs.existsSync(coreUtils)) {
    assert.deepStrictEqual(require(coreUtils).buildCliArgs({ settingsFile: calls[0].o.settings.settingsFile }),
      ['--settings', path.join(dir, '.vistaclair', 'hooks.json')]);
  }
});

// ---- rule 19 ----------------------------------------------------------------

test('a capability used with its section neither inlined nor read is an error', () => {
  const dir = sessionApp();
  const errs = errorsOf(dir, 'unread-capability');
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0].message, /api\/email/);
  assert.match(errs[0].message, /\.vistaclair\/api\/email\.md/);
});

test('the same app is clean once the read is on the ledger', () => {
  const dir = sessionApp();
  fireHook(dir, { tool_name: 'Bash', tool_input: { command: 'cat .vistaclair/api/email.md' } });
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});

test('a section inlined into the prompt needs no read', () => {
  const dir = sessionApp({ inlined: ['email'] });
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});

test('reading the whole reference covers every section', () => {
  const dir = sessionApp();
  fireHook(dir, { tool_name: 'Read', tool_input: { file_path: '.vistaclair/api-reference.md' } });
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});

test('a core capability is deferred like any other — new use of it is demanded', () => {
  const dir = sessionApp({ routes: 'module.exports = (router, ctx) => { router.get("/x", (q, r) => r.json(ctx.settings.get("k"))); };\n' });
  assert.ok(capabilities.get('settings').core);
  const errs = errorsOf(dir, 'unread-capability');
  assert.deepStrictEqual(errs.map((e) => e.message.match(/`([\w/-]+)` section/)[1]), ['api/settings']);
  assert.match(errs[0].message, /`routes\.js` \(written this session\) uses `ctx\.settings`/);
});

// ---- rule 19: only NEW use is owed ------------------------------------------
// The launch snapshots per-file evidence; what the app already used before the
// session is not a read the session owes, however often it edits that file.

const USES_DB = 'module.exports = (router, ctx) => {\n'
  + '  router.get("/x", async (q, r) => r.json(await ctx.dbQuery("SELECT 1")));\n};\n';

test('use the app had at launch is not demanded, even in a file the session rewrote', () => {
  const dir = sessionApp({ routes: USES_DB, baseline: { 'routes.js': ['db'] } });
  wroteAfterLaunch(dir, 'routes.js');   // a one-line edit to a file full of db calls
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});

test('a capability the session added to an existing file is demanded, and only that one', () => {
  const dir = sessionApp({
    routes: USES_DB.replace('};\n', '  router.get("/y", async (q, r) => r.json(await ctx.aiPrompt({ message: "hi" })));\n};\n'),
    baseline: { 'routes.js': ['db'] },
  });
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability').map((e) => e.message.match(/`([\w/-]+)` section/)[1]), ['api/ai']);
});

test('the baseline the launcher writes is the per-file evidence infer sees', () => {
  const dir = sessionApp({ routes: USES_DB });
  require('../src/apps/app-manager').setAppsDir(path.dirname(dir));
  promptBuilder.writeSidecars(dir, { action: 'extend', appName: 'fx-ledger' });
  const inlined = JSON.parse(fs.readFileSync(path.join(dir, '.vistaclair', 'inlined.json'), 'utf-8'));
  assert.deepStrictEqual(inlined.baseline, { 'routes.js': ['db'] });
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);   // nothing new since the launch
});

test('without a baseline the tell falls back to the file mtime against the launch stamp', () => {
  const dir = sessionApp({ routes: USES_DB, baseline: undefined });
  const p = path.join(dir, '.vistaclair', 'inlined.json');
  const doc = JSON.parse(fs.readFileSync(p, 'utf-8')); delete doc.baseline;
  fs.writeFileSync(p, JSON.stringify(doc));
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);   // same millisecond as the stamp: not "written"
  wroteAfterLaunch(dir, 'routes.js');
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability').map((e) => e.message.match(/`([\w/-]+)` section/)[1]), ['api/db']);
});

test('a cross-app tool call is demanded only once the platform defers that app to a sidecar', () => {
  const routes = "module.exports = (router, ctx) => { router.get('/x', async (q, r) => r.json(await ctx.tools.call('other-app', 'do_thing', {}))); };\n";
  const dir = sessionApp({ inlined: ['tools'], routes });
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);   // no sidecar: nothing was withheld

  fs.mkdirSync(path.join(dir, '.vistaclair', 'apps'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vistaclair', 'apps', 'other-app.md'), '# other-app\n');
  const errs = errorsOf(dir, 'unread-capability');
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0].message, /apps\/other-app/);

  fireHook(dir, { tool_name: 'Read', tool_input: { file_path: '.vistaclair/apps/other-app.md' } });
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});

// End to end, with no file placed by hand: the launcher writes the provider's
// sidecar because that provider exists, and THAT is what makes the read due —
// for a call the session ADDS (the launch baseline holds the routes.js before it).
test('the sidecar the launcher writes for a provider is the one rule 19 demands', () => {
  const routes = "module.exports = (router, ctx) => {\n"
    + "  router.get('/x', async (q, r) => r.json(await ctx.tools.call('pixachat', 'send_message', { text: 'hi' })));\n};\n";
  const dir = sessionApp({ routes: 'module.exports = (router, ctx) => {};\n' });
  const appsRoot = path.dirname(dir);
  fs.mkdirSync(path.join(appsRoot, 'pixachat'), { recursive: true });
  fs.writeFileSync(path.join(appsRoot, 'pixachat', 'manifest.json'), JSON.stringify({
    name: 'pixachat', description: 'a provider',
    tools: [{
      name: 'send_message', description: 'post a message', expose: 'apps',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      returns: '{ id, at }',
    }],
  }));
  require('../src/apps/app-manager').setAppsDir(appsRoot);

  // "register tools" is a `tools` keyword: that section is inlined, so the only
  // thing this session owes for the call it then writes is the provider's file.
  promptBuilder.writeSidecars(dir, { action: 'extend', appName: 'fx-ledger', userRequest: 'register tools that talk to pixachat' });
  const sidecar = path.join(dir, '.vistaclair', 'apps', 'pixachat.md');
  assert.ok(fs.existsSync(sidecar), 'the launcher must write a sidecar for every provider');
  assert.match(fs.readFileSync(sidecar, 'utf-8'), /Returns: \{ id, at \}/);
  fs.writeFileSync(path.join(dir, 'routes.js'), routes);

  const errs = errorsOf(dir, 'unread-capability');
  assert.deepStrictEqual(errs.map((e) => e.message.match(/`([\w/-]+)` section/)[1]), ['apps/pixachat']);

  fireHook(dir, { tool_name: 'Read', tool_input: { file_path: sidecar } });
  assert.deepStrictEqual(ledger(dir), ['apps/pixachat']);
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});

test('outside a launched session the rule is silent', () => {
  const dir = sessionApp();
  for (const f of ['inlined.json', 'hooks.json', 'reads.jsonl']) {
    const keep = fs.readFileSync(path.join(dir, '.vistaclair', f), 'utf-8');
    fs.unlinkSync(path.join(dir, '.vistaclair', f));
    assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), [], `removing ${f} must silence the rule`);
    fs.writeFileSync(path.join(dir, '.vistaclair', f), keep);
  }
  assert.strictEqual(errorsOf(dir, 'unread-capability').length, 1);
});

// ---- rule 19: the two bodies EVERY prompt defers ----------------------------
// `scaffolds` and `appmd-format` are not capability sections and are not in the
// api reference: nothing inlines them, so the ledger is the only way to satisfy
// them. What makes them due is the file the session wrote.

test('a build session that wrote routes.js must have read the scaffolds', () => {
  const dir = sessionApp({ action: 'build', inlined: ['email'] });
  wroteAfterLaunch(dir, 'routes.js');
  const errs = errorsOf(dir, 'unread-capability');
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0].message, /`scaffolds` section/);
  assert.match(errs[0].message, /\.vistaclair\/scaffolds\.md/);

  fireHook(dir, { tool_name: 'Read', tool_input: { file_path: '.vistaclair/scaffolds.md' } });
  assert.deepStrictEqual(ledger(dir), ['scaffolds']);
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});

test('a frontend written under public/ demands the scaffolds just as routes.js does', () => {
  const dir = sessionApp({ action: 'build', inlined: ['email'] });
  wroteAfterLaunch(dir, 'public/app.js', 'async function init() {}\ninit();\n');
  assert.strictEqual(errorsOf(dir, 'unread-capability').length, 1);
  fireHook(dir, { tool_name: 'Bash', tool_input: { command: 'cat .vistaclair/scaffolds.md' } });
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});

test('a change session is not asked for the scaffolds — it has an app to follow', () => {
  const dir = sessionApp({ action: 'extend', inlined: ['email'] });
  wroteAfterLaunch(dir, 'routes.js');
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});

test('writing APP.md demands the APP.md format, in any action', () => {
  const dir = sessionApp({ inlined: ['email'] });
  wroteAfterLaunch(dir, 'APP.md');
  const errs = errorsOf(dir, 'unread-capability');
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0].message, /`appmd-format` section/);

  fireHook(dir, { tool_name: 'Read', tool_input: { file_path: '.vistaclair/appmd-format.md' } });
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});

test('an untouched APP.md is not a write, so nothing is demanded', () => {
  const dir = sessionApp({ inlined: ['email'] });
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});

test('reading the whole api reference does not cover them — they are not in it', () => {
  const dir = sessionApp({ action: 'build', inlined: ['email'] });
  wroteAfterLaunch(dir, 'routes.js');
  wroteAfterLaunch(dir, 'APP.md');
  fireHook(dir, { tool_name: 'Read', tool_input: { file_path: '.vistaclair/api-reference.md' } });
  assert.deepStrictEqual(
    errorsOf(dir, 'unread-capability').map((e) => e.message.match(/`([a-z-]+)` section/)[1]).sort(),
    ['appmd-format', 'scaffolds']);
});

// ---- rule 19: the Telegram DETAIL sections ----------------------------------

const TG_BOT = 'module.exports = (router, ctx) => {\n'
  + "  ctx.telegram.onUpdate(async (u) => { await ctx.telegram.send(u.message.chat.id, 'hi'); });\n};\n";

test('a plain bot needs none of the Telegram detail sections', () => {
  const dir = sessionApp({ inlined: ['telegram'], routes: TG_BOT });
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});

test('each Telegram surface the app builds demands its own detail section', () => {
  const dir = sessionApp({
    inlined: ['telegram', 'identity'],
    routes: TG_BOT.replace('};\n', "  router.get('/api/app/feed', (q, r) => r.json(ctx.identity.resolve(q)));\n"
      + "  router.post('/api/auth/login', (q, r) => r.json({}));\n};\n"),
  });
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'public', 'app.html'), '<!DOCTYPE html>\n');
  assert.deepStrictEqual(
    errorsOf(dir, 'unread-capability').map((e) => e.message.match(/`api\/([a-z-]+)` section/)[1]).sort(),
    ['telegram-auth', 'telegram-identity', 'telegram-miniapp']);

  for (const key of ['telegram-miniapp', 'telegram-identity', 'telegram-auth']) {
    fireHook(dir, { tool_name: 'Read', tool_input: { file_path: `.vistaclair/api/${key}.md` } });
  }
  assert.deepStrictEqual(errorsOf(dir, 'unread-capability'), []);
});
