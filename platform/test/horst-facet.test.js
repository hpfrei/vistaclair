// The Horst facet of capability modules: senses, read-only tools and action
// kinds are aggregated by the registry, unique across modules, registered into
// governance, and the tool handlers answer over a throwaway apps dir.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { makeAppsDir } = require('./helpers');
const PRO = path.join(__dirname, '..');
const capabilities = require('../src/apps/capabilities');
const appManager = require('../src/apps/app-manager');
const governance = require('../src/apps/governance/horst-governance');
const bus = require('../src/apps/agent/horst-events');

const appsDir = makeAppsDir({ 'hf-db': { capabilities: { db: true } }, 'hf-legacy': {} });
appManager.setAppsDir(appsDir);
const horstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-horst-'));
test.after(() => {
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(horstDir, { recursive: true, force: true });
});

test('facet aggregation: senses, tools and kinds are unique and well-formed', () => {
  const senses = capabilities.horstSenses();
  const tools = capabilities.horstTools();
  const kinds = capabilities.horstKinds();
  assert.ok(senses.length >= 12);
  assert.ok(tools.length >= 13);
  assert.ok(Object.keys(kinds).length >= 13);
  assert.equal(new Set(senses.map((s) => s.key)).size, senses.length);
  assert.equal(new Set(tools.map((t) => t.def.name)).size, tools.length);
  const brain = new Set(require('../src/apps/agent/horst-brain').brainTools().map((t) => t.def.name));
  for (const t of tools) {
    assert.ok(!brain.has(t.def.name), `${t.def.name} collides with a brain tool`);
    assert.equal(t.def.expose, 'platform');
    // Read-only, or serving a direct-lane member of its module (it produces
    // an artifact or an answer, metered — never an outward act).
    if (!/read-only/i.test(t.def.description)) {
      assert.ok(capabilities.laneDirectTools(capabilities.get(t.capability)).has(t.def.name), `${t.def.name} is neither read-only nor a direct-lane tool`);
    }
    assert.equal(typeof t.handler, 'function');
  }
  for (const s of senses) {
    assert.ok(bus.POLICIES.includes(s.defaultPolicy), `${s.key} policy`);
    assert.ok(!bus.BUILTIN_KINDS.some((k) => k.key === s.key), `${s.key} collides with a builtin bus kind`);
    assert.equal(typeof capabilities.get(s.capability).horst.wire, 'function');
  }
  for (const [k, d] of Object.entries(kinds)) {
    assert.ok(governance.LEVELS.includes(d.ceiling), `${k} ceiling`);
    assert.ok(!governance.KINDS[k], `${k} collides with a governance-internal kind`);
  }
  // Every module carries a normalised facet, even with nothing declared.
  for (const cap of capabilities.all()) {
    assert.deepEqual(Object.keys(cap.horst).sort(), ['brief', 'kinds', 'lane', 'senses', 'tools', 'wire']);
  }
});

test('the moved surface is where the plan says it is', () => {
  const kinds = capabilities.horstKinds();
  assert.equal(kinds['email.send'].capability, 'email');
  assert.equal(kinds['calendar.create'].capability, 'calendar');
  assert.equal(kinds['telegram.send'].capability, 'telegram');
  assert.equal(kinds['cron.set'].capability, 'cron');
  assert.equal(kinds['app.restart'].capability, 'apps');
  assert.equal(kinds['job.cancel'].capability, 'jobs');
  assert.equal(kinds['spawn.kill'].capability, 'exec');
  assert.equal(kinds['todo.create'].capability, 'todos');
  // Governance owns exactly one kind: the act that belongs to no capability.
  assert.deepEqual(Object.keys(governance.KINDS).sort(), ['mission.create']);
  const tools = Object.fromEntries(capabilities.horstTools().map((t) => [t.def.name, t.capability]));
  assert.equal(tools.email_search, 'email');
  assert.equal(tools.calendar_list, 'calendar');
  assert.equal(tools.apps_list, 'apps');
  assert.equal(tools.capabilities_list, 'capabilities');
});

function loadWithDir(dir) {
  try {
    execFileSync(process.execPath, ['-e', "require('./src/apps/capabilities')"], {
      cwd: PRO, env: { ...process.env, VISTACLAIR_CAPABILITIES_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return null;
  } catch (err) {
    return String(err.stderr);
  }
}
function tempModulesDir() { return fs.mkdtempSync(path.join(PRO, 'src/apps', '.caps-test-')); }
function copyModules(tmp) {
  const src = path.join(PRO, 'src/apps/capabilities');
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(tmp, f));
}
const UI_BASE = "key: 'ui', title: 'x', summary: 'x', core: true, gated: false";

test('a duplicate sense, tool or kind refuses to boot and names both modules', () => {
  const tmp = tempModulesDir();
  copyModules(tmp);
  fs.writeFileSync(path.join(tmp, 'ui.js'), `module.exports = { ${UI_BASE}, horst: { senses: [{ kind: 'cron:failed', description: 'x', defaultPolicy: 'agenda' }], wire() {} } };\n`);
  // ORDER decides which module is named first; both are in the message.
  assert.match(loadWithDir(tmp), /capabilities\/(ui|cron)\.js: horst sense "cron:failed" is already declared by "(cron|ui)"/);
  fs.writeFileSync(path.join(tmp, 'ui.js'), `module.exports = { ${UI_BASE}, horst: { tools: [{ def: { name: 'apps_list', description: 'Read-only.' }, handler() {} }] } };\n`);
  assert.match(loadWithDir(tmp), /capabilities\/(ui|apps)\.js: horst tool "apps_list" is already declared by "(apps|ui)"/);
  fs.writeFileSync(path.join(tmp, 'ui.js'), `module.exports = { ${UI_BASE}, horst: { kinds: { 'email.send': { label: 'x', ceiling: 'propose', defaultLevel: 'propose', validate() {}, describe() {}, execute() {} } } } };\n`);
  assert.match(loadWithDir(tmp), /capabilities\/(ui|email)\.js: horst kind "email.send" is already declared by "(email|ui)"/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a malformed facet refuses to boot with a precise message', () => {
  const tmp = tempModulesDir();
  copyModules(tmp);
  fs.writeFileSync(path.join(tmp, 'ui.js'), `module.exports = { ${UI_BASE}, horst: { senses: [{ kind: 'ui:thing', description: 'x', defaultPolicy: 'agenda' }] } };\n`);
  assert.match(loadWithDir(tmp), /ui\.js: "horst\.senses" declared but there is no horst\.wire/);
  fs.writeFileSync(path.join(tmp, 'ui.js'), `module.exports = { ${UI_BASE}, horst: { kinds: { 'ui.zap': { label: 'x', ceiling: 'propose', defaultLevel: 'auto', validate() {}, describe() {}, execute() {} } } } };\n`);
  assert.match(loadWithDir(tmp), /horst kind "ui.zap" defaultLevel exceeds its ceiling/);
  fs.writeFileSync(path.join(tmp, 'ui.js'), `module.exports = { ${UI_BASE}, horst: { tools: [{ def: { name: 'Bad-Name', description: 'Read-only.' }, handler() {} }] } };\n`);
  assert.match(loadWithDir(tmp), /horst tool name "Bad-Name" is invalid/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('wireHorstSenses scopes publish to the declaring module and survives a throwing wire', async () => {
  const tmp = tempModulesDir();
  copyModules(tmp);
  // A module that publishes a kind it did not declare, and one whose wire throws.
  fs.writeFileSync(path.join(tmp, 'ui.js'), `module.exports = { ${UI_BASE}, horst: { senses: [{ kind: 'ui:mine', description: 'x', defaultPolicy: 'agenda' }], wire({ publish }) { global.__uiPublish = publish; } } };\n`);
  fs.writeFileSync(path.join(tmp, 'dialogs.js'), `module.exports = { key: 'dialogs', title: 'x', summary: 'x', core: true, gated: false, horst: { senses: [{ kind: 'dialogs:x', description: 'x', defaultPolicy: 'agenda' }], wire() { throw new Error('wire exploded'); } } };\n`);
  const script = `
    const c = require('./src/apps/capabilities');
    const seen = []; const warns = [];
    const ow = console.warn; console.warn = (...a) => warns.push(a.join(' '));
    c.wireHorstSenses({ publish: (k, p, o) => { seen.push([k, o]); return { ok: true }; } });
    console.warn = ow;
    Promise.all([global.__uiPublish('ui:mine', {}, { summary: 's' }), global.__uiPublish('cron:failed', {})]).then((r) => {
      console.log(JSON.stringify({ seen, r, warns }));
    });`;
  const out = execFileSync(process.execPath, ['-e', script], { cwd: PRO, env: { ...process.env, VISTACLAIR_CAPABILITIES_DIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const { seen, r, warns } = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(seen, [['ui:mine', { summary: 's' }]]);
  assert.deepEqual(r[1], { dropped: 'undeclared-sense' });
  assert.ok(warns.some((w) => /horst wire failed for "dialogs": wire exploded/.test(w)));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('governance registers the platform kinds once, with their declared ceilings', () => {
  governance.registerPlatformKinds(capabilities.horstKinds());
  governance.init({ dir: horstDir, broadcaster: { broadcast() {} } });
  assert.equal(governance.kindDef('email.send').ceiling, 'propose');
  assert.equal(governance.kindDef('app.restart').ceiling, 'auto+notify');
  assert.equal(governance.kindDef('job.cancel').defaultLevel, 'propose');
  assert.equal(governance.kindDef('nope'), null);
  const dials = governance.getDials();
  for (const k of ['email.send', 'calendar.create', 'telegram.send', 'cron.set', 'app.restart', 'job.cancel', 'spawn.kill', 'mission.create']) {
    assert.ok(dials[k], `dial for ${k}`);
  }
  assert.equal(dials['email.send'].pinNote.length > 0, true);
  assert.throws(() => governance.registerPlatformKinds({ 'email.send': capabilities.horstKinds()['email.send'] }), /registered twice/);
  assert.throws(() => governance.registerPlatformKinds({ 'mission.create': { execute() {}, ceiling: 'propose', defaultLevel: 'propose' } }), /governance-internal/);
  // App-registered kinds can no longer shadow a platform kind.
  assert.throws(() => governance.registerKind('app.restart', { execute() {} }), /built-in platform kind/);
  // Validators are the moved ones.
  assert.throws(() => governance.kindDef('app.restart').validate({ app: 'no-such-app' }), /unknown app/);
  assert.doesNotThrow(() => governance.kindDef('app.restart').validate({ app: 'hf-db' }));
  assert.throws(() => governance.kindDef('email.send').validate({}), /payload requires account/);
});

test('facet tool handlers answer over the apps dir', async () => {
  const tools = Object.fromEntries(capabilities.horstTools().map((t) => [t.def.name, t.handler]));
  const text = (r) => r.content[0].text;
  const apps = JSON.parse(text(await tools.apps_list({})));
  assert.deepEqual(apps.map((a) => a.name).sort(), ['hf-db', 'hf-legacy']);
  assert.equal(apps.find((a) => a.name === 'hf-db').errors, 0);
  assert.equal(text(await tools.apps_list({ withErrors: true })), 'No apps installed.');
  const status = JSON.parse(text(await tools.app_status({ app: 'hf-db' })));
  assert.equal(status.app, 'hf-db');
  assert.deepEqual(status.errors, { count: 0, lastAt: null, lastError: null, recent: [], crashloop: false });
  assert.match(text(await tools.app_status({ app: 'zzz' })), /Unknown app/);
  const log = JSON.parse(text(await tools.app_log({ app: 'hf-db' })));
  assert.equal(log.logTail, null);
  assert.deepEqual(log.recentErrors, []);
  // Open-world: every app can call everything — the tool reports which apps
  // ADVERTISE a capability in their manifest (hf-legacy advertises nothing).
  const caps = JSON.parse(text(await tools.capabilities_list({})));
  assert.deepEqual(caps.find((c) => c.key === 'db').advertisedBy, ['hf-db']);
  assert.deepEqual(caps.find((c) => c.key === 'telegram').advertisedBy, []);
  const one = JSON.parse(text(await tools.capabilities_list({ key: 'cron' })));
  assert.deepEqual(one.horst.senses, ['cron:failed', 'cron:failing']);
  assert.deepEqual(one.horst.kinds, ['cron.set', 'cron.retry']);
  assert.equal(text(await tools.cron_list({})), 'No scheduled jobs.');
  const db = JSON.parse(text(await tools.db_status({})));
  assert.equal(db.connected, false);
  // The chat-parity reads: rules, the reply drafter, the approval queue.
  assert.equal(text(await tools.email_rules({})), 'No spam rules.');
  assert.equal(text(await tools.email_draft_reply({ account: 'me@example.com', uid: '1' })), 'Email engine not connected.');
  assert.equal(text(await tools.proposals_list({})), 'No pending proposals.');
  await governance.createProposal('app.restart', { app: 'hf-db' }, { origin: 'chat' });
  const queue = JSON.parse(text(await tools.proposals_list({})));
  assert.equal(queue.proposals.length, 1);
  assert.equal(queue.proposals[0].kind, 'app.restart');
  assert.equal(queue.proposals[0].origin, 'chat');
  assert.match(queue.proposals[0].age, /^\d+m$/);
  assert.ok(queue.open, 'says where the owner decides');
  assert.equal(text(await tools.proposals_list({ kind: 'email.send' })), 'No pending proposals of kind email.send.');
});

// Every aggregate the registry builds must have a live reader. This is not a
// style rule: `horstBriefs()` fed the cognition digest, phase 8F deleted the
// digest, and the briefs went on being authored in nineteen modules and
// validated at boot while reaching nobody. Nothing failed — a facet part with
// no consumer is invisible, which is exactly why it needs a test.
test('no aggregate of the horst facet is written to nobody', () => {
  const host = fs.readFileSync(path.join(PRO, 'src', 'apps', 'platform-horst.js'), 'utf-8');
  for (const fn of ['horstSenses', 'horstTools', 'horstKinds', 'horstBriefs', 'wireHorstSenses']) {
    assert.ok(typeof capabilities[fn] === 'function', `${fn} is not exported`);
    assert.match(host, new RegExp(`capabilities\\.${fn}\\(`),
      `capabilities.${fn}() has no consumer in platform-horst — the facet part it aggregates is dead`);
  }
  assert.ok(capabilities.horstBriefs().length >= 15, 'the briefs themselves went missing');
});
