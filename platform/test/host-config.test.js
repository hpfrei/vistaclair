// Per-host config on a slave mirror — App Config on an app the master
// published here writes .host-config.json, never the master's manifest.json,
// and the overlay survives the next publish (CODE_PRESERVE).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const peerData = require('../src/apps/peer-data');

const dir = makeAppsDir({
  mirror: { description: 'from master', domain: 'master.example.com', auth: { telegram: true } },
  local: { description: 'mine' },
});
appManager.setAppsDir(dir);
fs.writeFileSync(path.join(dir, 'mirror', '.deployed.json'), JSON.stringify({ commit: 'abc1234' }));
const manifestOf = (name) => JSON.parse(fs.readFileSync(path.join(dir, name, 'manifest.json'), 'utf-8'));
const overlayPath = path.join(dir, 'mirror', '.host-config.json');

test('a local app writes its manifest', () => {
  appManager.updateHostConfig('local', { domain: 'mine.example.com' });
  assert.equal(manifestOf('local').domain, 'mine.example.com');
  assert.equal(fs.existsSync(path.join(dir, 'local', '.host-config.json')), false);
});

test('a mirror writes the overlay; the manifest reads merged', () => {
  appManager.updateHostConfig('mirror', { domain: 'slave.example.com', auth: { telegram: true } });
  assert.equal(manifestOf('mirror').domain, 'master.example.com', 'master manifest untouched');
  assert.deepEqual(JSON.parse(fs.readFileSync(overlayPath, 'utf-8')), { domain: 'slave.example.com' }, 'unchanged keys are not pinned');
  assert.equal(appManager.readManifest('mirror').domain, 'slave.example.com');
  assert.deepEqual(appManager.list().find((a) => a.name === 'mirror').hostConfig, ['domain']);
});

test('clearing a key masks the published value', () => {
  appManager.updateHostConfig('mirror', { domain: null, surfaces: undefined });
  assert.equal('domain' in appManager.readManifest('mirror'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(overlayPath, 'utf-8')), { domain: null });
});

test('setting a key back to the published value drops the overlay', () => {
  appManager.updateHostConfig('mirror', { domain: 'master.example.com' });
  assert.equal(fs.existsSync(overlayPath), false);
  assert.equal(appManager.list().find((a) => a.name === 'mirror').hostConfig, undefined);
});

test('the overlay is kept across a publish', () => {
  assert.ok(peerData.CODE_PRESERVE.includes('.host-config.json'));
});
