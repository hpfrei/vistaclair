// The descriptor's authExemptUpgradePaths must be exactly the peer channel path,
// and peer-channel.handleUpgrade must claim every request on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const peerChannel = require('../src/apps/peer-channel');

test('descriptor declares authExemptUpgradePaths = [CHANNEL_PATH]', () => {
  assert.equal(peerChannel.CHANNEL_PATH, '/api/peer/channel');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const m = src.match(/authExemptUpgradePaths:\s*(\[[^\]]*\])/);
  assert.ok(m, 'index.js declares authExemptUpgradePaths');
  assert.equal(m[1].replace(/\s+/g, ''), "[require('./src/apps/peer-channel').CHANNEL_PATH]");
});

test('handleUpgrade claims every request on CHANNEL_PATH, even unauthenticated', () => {
  for (const headers of [{}, { 'x-vistaclair-peer-token': 'wrong' }]) {
    let destroyed = false;
    const socket = { write() {}, destroy() { destroyed = true; }, remoteAddress: '203.0.113.9' };
    const req = { url: peerChannel.CHANNEL_PATH + '?x=1', headers, socket };
    assert.equal(peerChannel.handleUpgrade(req, socket, Buffer.alloc(0)), true);
    assert.ok(destroyed);
  }
});
