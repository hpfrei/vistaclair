// The remote-host chip in an SDK panel header (public/remote-ask.js hostChipEl,
// public/sdk-panel.js Area header): a session on another machine shows
// "⇄ <host>" with the tooltip "Remote worker on <host>"; a local one shows
// nothing. The host reaches the client in the run description's worker entry
// (src/orchestration.js describeRemote: `host`), the mirrored orchestrator's
// `mirror.host`, and a tab's settings.externalHost (src/external-session.js).
//
//   node --test test/remote-host-chip.test.js

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const { hostChipEl } = require('../public/remote-ask.js');
const { ExternalSession } = require('../src/external-session');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const doc = {
  createElement() {
    return {
      className: '', title: '', childNodes: [],
      appendChild(n) { this.childNodes.push(n); return n; },
      get textContent() { return this.childNodes.map((n) => n.data).join(''); },
    };
  },
  createTextNode: (data) => ({ nodeType: 3, data }),
};

test('hostChipEl: a remote host gives the chip with the tooltip, a local session nothing', () => {
  const chip = hostChipEl(doc, 'hetzner-1', 'sdk-chip sdk-area-host');
  assert.strictEqual(chip.className, 'sdk-chip sdk-area-host');
  assert.strictEqual(chip.textContent, '⇄ hetzner-1');
  assert.strictEqual(chip.title, 'Remote worker on hetzner-1');
  for (const none of [undefined, null, '', '   ', 7, {}]) assert.strictEqual(hostChipEl(doc, none, 'c'), null, String(none));
});

test('hostChipEl: the host is text only and capped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const chip = hostChipEl(doc, evil, 'c');
  assert.strictEqual(chip.childNodes.length, 1);
  assert.strictEqual(chip.childNodes[0].nodeType, 3, 'a text node, not markup');
  assert.strictEqual(chip.textContent, `⇄ ${evil}`);
  const long = hostChipEl(doc, 'h'.repeat(500), 'c');
  assert.strictEqual(Array.from(long.title.slice('Remote worker on '.length)).length, 100);
});

test('the panel header draws the chip from the box\'s host and no HTML is built from it', () => {
  const sdk = read('public/sdk-panel.js');
  assert.match(sdk, /<span class="sdk-chip sdk-area-host hidden"><\/span>/, 'a slot in the header');
  assert.match(sdk, /remoteAsk\?\.hostChipEl\(document, this\.host,/);
  assert.match(sdk, /a\.host = w\.host \|\| null;/, 'a worker box takes the run description\'s host');
  assert.match(sdk, /run\.mirror\?\.host/, 'a mirrored orchestrator takes mirror.host');
  assert.match(sdk, /this\.info\.settings\?\.externalHost/, 'a remote tab\'s own box takes settings.externalHost');
  assert.doesNotMatch(sdk, /hostEl\.innerHTML/);
  assert.match(read('public/sdk-panel.css'), /\.sdk-area-host \{[^}]*text-overflow: ellipsis/);
});

test('the server carries the host to the client: an external tab\'s settings and the run description', () => {
  const ext = new ExternalSession('rs-hetzner-1-1', {
    sessId: '11111111-2222-3333-4444-555555555555', kind: 'sdk', title: 'w1',
    settings: { engine: 'sdk', auth: 'apikey', externalHost: 'hetzner-1' },
    running: true, busy: false, state: 'idle',
    submit() {}, interrupt() {}, setModel() {}, setAuth() {}, historyPage() {}, kill() {}, close() {},
  });
  assert.strictEqual(ext.spawnedMessage().settings.externalHost, 'hetzner-1');
  const orch = read('src/orchestration.js');
  assert.match(orch, /host: w\.host, app: w\.app,/, 'describeRemote');
  assert.match(orch, /mirror: \{ key: run\.mirror\.key, host: run\.mirror\.host,/, 'describeRun');
});
