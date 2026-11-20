// Tiering the build prompt. A body a session needs at most one of is not paid for
// by every session: the prompt carries an index or a contract plus a pointer, and
// `.vistaclair/` carries the body. Nothing may be lost in the move — every pointer
// names a file the launcher actually writes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const promptBuilder = require('../src/apps/app-builder-prompt');
const PROMPTS = path.join(__dirname, '..', 'src', 'apps', 'prompts');
const readPrompt = (name) => fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf-8');

// Every pointer in every prompt opens with the same words, so a session meets one
// instruction, not four dialects of it.
const POINTER = '> Deferred to keep this prompt small — read `.vistaclair/';

function tmpApp(name) {
  const root = fs.mkdtempSync(path.join(process.env.VISTACLAIR_FIXTURE_TMP || os.tmpdir(), 'vc-tier-'));
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name, description: 'tiering fixture' }));
  return dir;
}

const detailKeys = () =>
  [...readPrompt('_api-reference').matchAll(/<!-- API:DETAIL key=([a-z0-9-]+) -->/g)].map((m) => m[1]);

// ---- the scaffolds -----------------------------------------------------------

test('the scaffold index is generated from the bodies, so it cannot drift from them', () => {
  const bodyHeadings = [...readPrompt('_scaffolds-detail').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.ok(bodyHeadings.length >= 5);
  assert.deepStrictEqual(promptBuilder.scaffoldEntries().map((e) => e.name), bodyHeadings);

  const index = promptBuilder.buildScaffoldIndex();
  for (const entry of promptBuilder.scaffoldEntries()) {
    assert.ok(entry.purpose, `scaffold "${entry.name}" has no "> purpose" line under its heading`);
    assert.ok(index.includes(`**${entry.name}**`), `scaffold "${entry.name}" has no index line`);
    assert.ok(index.includes(entry.purpose), `scaffold "${entry.name}" lost its purpose in the index`);
  }
  assert.ok(index.includes(`${POINTER}scaffolds.md`), index.slice(-200));
});

test('the build prompt carries the scaffold index, never the scaffold bodies', () => {
  const prompt = promptBuilder.buildPrompt('build', { appName: 'fx-tier', description: 'a notes app' });
  for (const entry of promptBuilder.scaffoldEntries()) assert.ok(prompt.includes(`**${entry.name}**`), entry.name);
  // A line that only exists inside a scaffold body.
  assert.ok(!prompt.includes('// public/app.js — mounted-tier frontend with realtime updates'));
  assert.ok(prompt.includes(`${POINTER}scaffolds.md`));
  // And the session is told when to spend the read, in the stage that decides the shape.
  assert.match(prompt, /read `\.vistaclair\/scaffolds\.md` \(in this directory\)/);
});

// ---- the APP.md format -------------------------------------------------------

test('the APP.md format prompt keeps the contract and defers the rest', () => {
  const prompt = promptBuilder.buildPrompt('build', { appName: 'fx-tier', description: 'a notes app' });
  assert.ok(prompt.includes('**Cells are pointers, not prose.**'));
  assert.match(prompt, /~6,000 tokens \(~24 KB\)/);
  assert.match(prompt, /reading APP\.md and its `APP_<TOPIC>\.md` detail files is as reliable as reading the source/);
  // The section-by-section format and its examples are in the sidecar only.
  assert.ok(!prompt.includes("### Map, don't mirror — the core rule"));
  assert.ok(!prompt.includes('## Where to change what'));
  assert.ok(prompt.includes(`${POINTER}appmd-format.md`));
});

test('a change session is pointed at the same APP.md format file', () => {
  for (const action of ['extend', 'build-tools']) {
    const prompt = promptBuilder.buildPrompt(action, { appName: 'fx-tier', description: 'a notes app' });
    assert.ok(prompt.includes(`${POINTER}appmd-format.md`), `${action} carries no pointer`);
  }
});

// ---- the API:DETAIL sections -------------------------------------------------

test('a DETAIL section is its heading plus the pointer, and Telegram is tiered', () => {
  const ref = promptBuilder.buildApiReference({ appName: 'fx-tier', description: 'reads my email and sends telegram alerts' });
  assert.ok(ref.includes('### Telegram (Per-App Bot)'), 'the base bot API stays inline');
  assert.ok(ref.includes('telegram.sendPhoto'), 'the base bot API stays inline');
  for (const heading of ['#### Mini-apps and app users', '#### Identity & linking across the two contexts',
    '#### Multi-user, email/password, and linking']) {
    assert.ok(ref.includes(heading), `${heading} lost its heading`);
  }
  for (const key of ['telegram-miniapp', 'telegram-identity', 'telegram-auth']) {
    assert.ok(ref.includes(`${POINTER}api/${key}.md`), `${key} has no pointer`);
  }
  // Bodies of the three, gone: a line from each.
  assert.ok(!ref.includes('The legacy `telegram.html` shape is gone.'));
  assert.ok(!ref.includes('ctx.identity.issueLinkCode(user.id)'));
  assert.ok(!ref.includes('**Owner auto-login**'));
});

// ---- what the launcher writes ------------------------------------------------

test('writeSidecars writes both deferred bodies and one file per DETAIL key', () => {
  const dir = tmpApp('fx-tier');
  const settings = promptBuilder.writeSidecars(dir, {
    action: 'build', appName: 'fx-tier', description: 'reads my email and sends telegram alerts',
  });
  assert.ok(settings);
  const vc = path.join(dir, '.vistaclair');

  for (const file of ['scaffolds.md', 'appmd-format.md', 'api-reference.md',
    'api/telegram-miniapp.md', 'api/telegram-identity.md', 'api/telegram-auth.md']) {
    assert.ok(fs.existsSync(path.join(vc, file)), `missing .vistaclair/${file}`);
  }
  // Every pointer the prompt can carry names a file that exists.
  for (const key of detailKeys()) assert.ok(fs.existsSync(path.join(vc, 'api', `${key}.md`)), key);

  // Nothing was lost in the move, and the session gets code it can paste.
  const scaffolds = fs.readFileSync(path.join(vc, 'scaffolds.md'), 'utf-8');
  assert.ok(scaffolds.includes('// public/app.js — mounted-tier frontend with realtime updates'));
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(scaffolds), 'an unresolved placeholder reached the scaffold bodies');
  assert.ok(scaffolds.includes('"name": "fx-tier"'));

  const format = fs.readFileSync(path.join(vc, 'appmd-format.md'), 'utf-8');
  assert.ok(format.includes("### Map, don't mirror — the core rule"));
  assert.ok(format.includes('## Where to change what'));

  const miniapp = fs.readFileSync(path.join(vc, 'api', 'telegram-miniapp.md'), 'utf-8');
  assert.ok(miniapp.startsWith('#### Mini-apps and app users'));
  assert.ok(miniapp.includes('The legacy `telegram.html` shape is gone.'));
});

// ---- one tier: every capability section is deferred ---------------------------

const capabilities = require('../src/apps/capabilities');
const sectionKeys = () =>
  [...readPrompt('_api-reference').matchAll(/<!-- API:SECTION key=([a-z-]+) -->/g)].map((m) => m[1]);

test('every capability is one deferred block, and a request with no keyword inlines none', () => {
  assert.deepStrictEqual(sectionKeys().sort(), capabilities.all().map((c) => c.key).sort());
  const ref = promptBuilder.buildApiReference({ action: 'extend', appName: 'fx-tier', userRequest: 'tidy the layout', description: 'a bookkeeping helper' });
  assert.ok(ref.length <= 12000, `no-hit reference is ${ref.length} chars`);
  assert.ok(ref.includes('## Section Index'));
  assert.ok(!ref.includes('### File System'), 'a core section is deferred like any other');
  assert.ok(!ref.includes('### Database (Platform MariaDB)'));
  assert.ok(!/^- `[a-z-]+` — .*\*\*\(inlined/m.test(ref), 'no index line is marked inlined');
  // The always-inline material is still there.
  for (const h of ['## Trust Model', '## Frontend Utilities', '## Routes.js Context']) assert.ok(ref.includes(h), h);
  assert.ok(ref.includes(`${POINTER}api/routes-ctx.md`));
});

test('a keyword inlines its section and marks it in the index; the manifest never does', () => {
  const dir = tmpApp('fx-tier-kw');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'fx-tier-kw', description: 'x', capabilities: { db: true, maps: true } }));
  fs.writeFileSync(path.join(dir, 'routes.js'), 'module.exports = (router, ctx) => { ctx.dbQuery("SELECT 1"); };\n');
  require('../src/apps/app-manager').setAppsDir(path.dirname(dir));
  const ref = promptBuilder.buildApiReference({ action: 'extend', appName: 'fx-tier-kw', userRequest: 'add a table for invoices', description: 'x' });
  assert.ok(ref.includes('### Database (Platform MariaDB)'), 'the db keyword inlines db');
  assert.ok(ref.includes('- `db` —') && /`db` — .*\*\*\(inlined; used here\)\*\*/.test(ref), 'db is marked inlined and used');
  assert.ok(!ref.includes('### Maps & Routing'), 'a declared capability is not inlined by its declaration');
  assert.ok(!ref.includes('### AI\n'), 'a capability nobody named is not inlined');
});

test('a build-tools session always has the tools section', () => {
  const keys = promptBuilder.inlinedKeys({ action: 'build-tools', userRequest: 'change the summary output' });
  assert.ok(keys.has('tools'));
  assert.ok(!promptBuilder.inlinedKeys({ action: 'extend', userRequest: 'change the summary output' }).has('tools'));
});

test('the index stays within its budget, one line per capability', () => {
  const index = capabilities.buildSectionIndex();
  assert.ok(index.length <= capabilities.INDEX_MAX, `${index.length} > ${capabilities.INDEX_MAX}`);
  for (const c of capabilities.all()) assert.ok(index.includes(`- \`${c.key}\` — `), c.key);
  for (const file of ['api/routes-ctx.md', 'api/toolchains.md', 'migration.md', 'platform-request.md', 'app-request.md', 'scaffolds.md', 'appmd-format.md']) {
    assert.ok(index.includes(`\`${file}\``), `index does not name ${file}`);
  }
});

test('writeSidecars writes the migration and request sidecars, and the launch baseline', () => {
  const dir = tmpApp('fx-tier-sc');
  fs.writeFileSync(path.join(dir, 'routes.js'), 'module.exports = (router, ctx) => { ctx.dbQuery("SELECT 1"); };\n');
  require('../src/apps/app-manager').setAppsDir(path.dirname(dir));
  promptBuilder.writeSidecars(dir, { action: 'extend', appName: 'fx-tier-sc', userRequest: 'list my email' });
  const vc = path.join(dir, '.vistaclair');
  for (const key of sectionKeys()) assert.ok(fs.existsSync(path.join(vc, 'api', `${key}.md`)), key);
  assert.ok(fs.existsSync(path.join(vc, 'api', 'routes-ctx.md')));
  assert.match(fs.readFileSync(path.join(vc, 'api', 'toolchains.md'), 'utf-8'), /^### Toolchains/);
  const migration = fs.readFileSync(path.join(vc, 'migration.md'), 'utf-8');
  assert.match(migration, /^# Migration guidance/);
  assert.match(migration, /## Connected accounts/);
  assert.match(fs.readFileSync(path.join(vc, 'platform-request.md'), 'utf-8'), /^# When the platform is missing something/);
  assert.match(fs.readFileSync(path.join(vc, 'app-request.md'), 'utf-8'), /^# When another app must change/);
  const inlined = JSON.parse(fs.readFileSync(path.join(vc, 'inlined.json'), 'utf-8'));
  assert.deepStrictEqual(inlined.keys, ['email']);
  assert.deepStrictEqual(inlined.baseline, { 'routes.js': ['db'] });
});

test('the change prompts stay small: the body is brief and the reference is an index', () => {
  const dir = tmpApp('fx-tier-size');
  fs.writeFileSync(path.join(dir, 'routes.js'), 'module.exports = (router, ctx) => {};\n');
  fs.writeFileSync(path.join(dir, 'APP.md'), '# fx-tier-size\n## Purpose\nfixture\n');
  require('../src/apps/app-manager').setAppsDir(path.dirname(dir));
  for (const [action, max] of [['extend', 50000], ['build-tools', 50000], ['build', 60000]]) {
    const prompt = promptBuilder.buildPrompt(action, { appName: 'fx-tier-size', description: 'a bookkeeping helper', userRequest: 'tidy the layout' });
    assert.ok(prompt.length <= max, `${action} prompt is ${prompt.length} chars (max ${max})`);
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(prompt), `${action}: unresolved placeholder`);
  }
});
