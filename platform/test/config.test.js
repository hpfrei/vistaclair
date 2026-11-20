// The `config` capability: one registry of what Horst may change about how he
// reads the owner's world, one patch contract, one write path. These pin the
// contract rather than the storage — a patch that passes validatePatch must
// apply, and one that would not apply must fail BEFORE it is staged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/apps/capabilities/config');
const horstSettings = require('../src/apps/agent/horst-settings');
const emailEngine = require('../src/apps/email-engine');
const { configKey } = require('../src/apps/governance/horst-identity');

// Both stores live under one throwaway directory: the engine's label file
// (init sets appsDir) and Horst's settings file (init sets the .horst dir).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-config-'));
emailEngine.init(tmp, null, null);
horstSettings.init({ dir: path.join(tmp, '.horst') });

test('the registry lists exactly the four configurations, each with a schema', () => {
  const keys = config.list().map((c) => c.key);
  assert.deepEqual(keys, ['email.tags', 'horst.docTypes', 'horst.triage', 'horst.notify']);
  for (const c of config.list()) assert.ok(['list', 'fields'].includes(c.schema.type), `${c.key} schema type`);
});

test('an unknown key is refused by name, with the known ones in the message', () => {
  assert.throws(() => config.get('horst.genome'), /unknown configuration "horst.genome".*email\.tags/);
  assert.throws(() => config.validatePatch('dials', {}), /unknown configuration/);
});

test('tags: add / update / remove round-trip through the engine\'s label store', () => {
  const r1 = config.set('email.tags', { add: [{ name: 'Bills · IT services', color: '#0ea5e9' }] }, 'test');
  assert.equal(r1.summary, "Tags: add 'Bills · IT services'");
  const added = r1.after.find((l) => l.name === 'Bills · IT services');
  assert.ok(added && added.id && added.color === '#0ea5e9');

  // Adding a name that exists is success, not a duplicate and not an error.
  const r2 = config.set('email.tags', { add: [{ name: 'bills · it SERVICES' }] });
  assert.equal(r2.after.length, r1.after.length);

  const r3 = config.set('email.tags', { update: [{ id: added.id, name: 'Bills · IT' }] });
  assert.equal(r3.after.find((l) => l.id === added.id).name, 'Bills · IT');

  const r4 = config.set('email.tags', { remove: ['bills · it'] }); // by name, case-insensitively
  assert.ok(!r4.after.some((l) => l.id === added.id));
  assert.equal(r4.summary, "Tags: remove 'bills · it'");
});

test('tags: the patch contract is enforced before anything is written', () => {
  const v = (patch) => config.validatePatch('email.tags', patch);
  assert.throws(() => v({}), /changes nothing/);
  assert.throws(() => v(null), /must be an object/);
  assert.throws(() => v({ add: [{ name: '' }] }), /name must be a non-empty string/);
  assert.throws(() => v({ add: [{ name: 'x'.repeat(61) }] }), /too long/);
  assert.throws(() => v({ add: [{ name: 'ok', color: 'blue' }] }), /color is not in the expected form/);
  assert.throws(() => v({ add: [{ name: 'ok', sender: 'a@b' }] }), /not a field/);
  assert.throws(() => v({ rename: [] }), /not a list operation/);
  assert.throws(() => v({ add: 'Travel' }), /must be an array/);
  assert.throws(() => v({ update: [{ id: 'nope', name: 'x' }] }), /no email\.tags item with id/);
  assert.throws(() => v({ update: [{ name: 'x' }] }), /update takes/);
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `t${i}` }));
  assert.throws(() => v({ add: many }), /at most 24/);
  assert.doesNotThrow(() => v({ add: [{ name: 'Travel' }, { name: 'Insurance' }] }));
});

test('docTypes: "other" is locked, items are sanitised slugs, and the cap holds', () => {
  assert.throws(() => config.validatePatch('horst.docTypes', { remove: ['Other'] }), /cannot be removed/);
  assert.throws(() => config.validatePatch('horst.docTypes', { update: [{ id: 'x' }] }), /no fields to update/);
  const r = config.set('horst.docTypes', { add: ['Insurance Policy'], remove: ['warranty'] });
  assert.ok(r.after.includes('insurance policy'));
  assert.ok(!r.after.includes('warranty'));
  assert.ok(r.after.includes('other'));
  assert.equal(horstSettings.get().docTypes.join(), r.after.join(), 'the settings file is the store');
  assert.equal(r.summary, "Document types: add 'Insurance Policy'; remove 'warranty'");
});

test('triage: fields are typed and bounded, and only the named fields move', () => {
  const v = (patch) => config.validatePatch('horst.triage', patch);
  assert.throws(() => v({}), /sets no field/);
  assert.throws(() => v({ paused: true }), /not a field of horst\.triage/);
  assert.throws(() => v({ spamThresholdSpam: '70' }), /must be a number/);
  assert.throws(() => v({ triageBatch: 26 }), /at most 25/);
  assert.throws(() => v({ triageWindowHours: 0 }), /at least 1/);
  const before = horstSettings.get();
  const r = config.set('horst.triage', { spamThresholdSpam: 70 });
  assert.equal(r.after.spamThresholdSpam, 70);
  assert.equal(r.after.triageBatch, before.triageBatch);
  assert.equal(horstSettings.get().paused, before.paused, 'a triage patch never reaches the leash');
  assert.equal(r.summary, 'Email triage: spamThresholdSpam → 70');
});

test('boolean fields: spam filing and event reminders take true/false only', () => {
  assert.equal(config.get('horst.triage').value.autoFileSpam, true, 'filing is on by default');
  assert.throws(() => config.validatePatch('horst.triage', { autoFileSpam: 'no' }), /true or false/);
  config.set('horst.triage', { autoFileSpam: false });
  assert.equal(horstSettings.get().autoFileSpam, false);
  config.set('horst.triage', { autoFileSpam: true });
  const n = config.get('horst.notify').value;
  assert.deepEqual(n, { eventReminders: true, eventLeadMinutes: 15 });
  assert.throws(() => config.validatePatch('horst.notify', { eventLeadMinutes: 0 }), /at least 1/);
  assert.throws(() => config.validatePatch('horst.notify', { paused: true }), /not a field of horst\.notify/);
  const r = config.set('horst.notify', { eventLeadMinutes: 30 });
  assert.equal(r.after.eventLeadMinutes, 30);
  assert.equal(r.after.eventReminders, true);
});

test('config_get reports the value and whether the store is live', () => {
  const g = config.get('horst.triage');
  assert.equal(g.initialised, true);
  assert.equal(g.value.spamThresholdSpam, 70);
  assert.equal(config.get('email.tags').initialised, true);
});

test('the kind is pinned to propose, dedupes one-item patches and survives a bare payload', () => {
  const kind = config.horst.kinds['config.set'];
  assert.equal(kind.ceiling, 'propose');
  assert.equal(kind.defaultLevel, 'propose');
  assert.equal(kind.notify, 'none');
  assert.equal(kind.describe({}), 'Configuration change');
  assert.throws(() => kind.validate({}), /payload requires key/);
  assert.equal(kind.describe({ key: 'email.tags', patch: { add: [{ name: 'Insurance' }] } }), "Tags: add 'Insurance'");

  const a = configKey({ key: 'email.tags', patch: { add: [{ name: 'Bills · IT services' }] } });
  const b = configKey({ key: 'email.tags', patch: { add: [{ name: ' bills IT services ', color: '#000000' }] } });
  assert.equal(a, b, 'the same tag asked for twice is one act');
  assert.equal(a, 'config:email.tags:add:bills it services');
  assert.notEqual(a, configKey({ key: 'email.tags', patch: { remove: ['Bills · IT services'] } }), 'add and remove never share a key');
  assert.equal(configKey({ key: 'email.tags', patch: { add: [{ name: 'a' }, { name: 'b' }] } }), null, 'a batch is its own act');
  assert.equal(configKey({ key: 'horst.triage', patch: { triageBatch: 5, spamThresholdSpam: 70 } }), 'config:horst.triage:spamThresholdSpam=70,triageBatch=5');
  assert.equal(configKey({}), null);
  assert.equal(kind.identity({ key: 'email.tags', patch: { add: [{ name: 'Insurance' }] } }), 'config:email.tags:add:insurance');
});

test('the registry carries the capability and governance sees the kind', () => {
  const capabilities = require('../src/apps/capabilities');
  assert.ok(capabilities.all().some((c) => c.key === 'config'));
  assert.equal(capabilities.horstKinds()['config.set'].ceiling, 'propose');
  const names = capabilities.horstTools().map((t) => t.def.name);
  assert.ok(names.includes('config_list') && names.includes('config_get'));
});
