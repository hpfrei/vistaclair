// The exactness gate for the ctx surface: the module-built ctx must reproduce
// the fixtures for every profile. After an intentional surface change run
// `npm run test:fixtures` and review the diff.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const gen = require('./gen-fixtures');
const { silenceWarn } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const capabilities = require('../src/apps/capabilities');

const FIXTURES = path.join(__dirname, 'fixtures');
const ADDED_MEMBERS = [];

test('ctx profiles match the fixtures', async () => {
  const appsDir = gen.makeAppsDir();
  appManager.setAppsDir(appsDir);
  const { result: now } = await silenceWarn(() => gen.captureCtx(appManager));
  fs.rmSync(appsDir, { recursive: true, force: true });
  for (const app of gen.APPS) {
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, app.file), 'utf-8'));
    const actual = now[app.file];
    assert.equal(actual.profile, expected.profile);
    for (const m of ADDED_MEMBERS) {
      assert.ok(actual.members[m], `${app.file}: ${m} missing`);
      delete actual.members[m];
    }
    assert.deepEqual(actual.members, expected.members, `${app.file} ctx shape drifted`);
  }
});

test('bridge method set matches the fixture', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'bridge-methods.json'), 'utf-8'));
  const actual = gen.bridgeMethodsFromRegistry(capabilities);
  assert.deepEqual(actual, expected.slice().sort());
});

test('prompt text matches the fixtures (regenerate with npm run test:fixtures after an intentional change)', () => {
  const cases = [
    ['prompt-section-index.txt', capabilities.buildSectionIndex(), 0],
    ['prompt-capability-brief.txt', capabilities.buildCapabilityBrief(), 0],
    ['prompt-migration-rules.txt', capabilities.buildMigrationRules(), 0],
  ];
  for (const [file, text, extra] of cases) {
    const old = fs.readFileSync(path.join(FIXTURES, file), 'utf-8').split('\n');
    const now = text.split('\n');
    const removed = old.filter((l) => !now.includes(l));
    const added = now.filter((l) => !old.includes(l));
    assert.deepEqual(removed, [], `${file}: lines removed`);
    assert.equal(added.length, extra, `${file}: unexpected additions ${JSON.stringify(added)}`);
  }
});
