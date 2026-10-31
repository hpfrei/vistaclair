// Remote sessions (public/remote-ask.js): the host badge of a tab whose
// session runs on another machine and the label of an ask:question it raised.
// The strings are untrusted, so they are capped and only ever set as text.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { capText, hostBadgeLabel, remoteAskLabel, remoteLabelEl, HOST_MAX, TITLE_MAX } = require('../public/remote-ask.js');

// Just enough document for remoteLabelEl: text nodes stay text, and an
// element's innerHTML is the escaped serialisation a browser would give.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const stubDoc = {
  createElement(tag) {
    return {
      tagName: tag.toUpperCase(),
      className: '',
      childNodes: [],
      appendChild(n) { this.childNodes.push(n); return n; },
      get textContent() { return this.childNodes.map((n) => n.data).join(''); },
      get innerHTML() { return this.childNodes.map((n) => esc(n.data)).join(''); },
      set innerHTML(_) { throw new Error('innerHTML must not be set'); },
    };
  },
  createTextNode(data) { return { nodeType: 3, data: String(data) }; },
};

test('remote ask label: host and session title', () => {
  const msg = { type: 'ask:question', askId: 'a1', host: 'lab-box', remote: { peer: 'p1', tabId: 't1', sessionTitle: 'api-refactor' } };
  assert.strictEqual(remoteAskLabel(msg), 'Remote · lab-box · api-refactor');
});

test('remote ask label: no session title omits that part', () => {
  assert.strictEqual(remoteAskLabel({ host: 'lab-box', remote: { peer: 'p1', tabId: 't1' } }), 'Remote · lab-box');
  assert.strictEqual(remoteAskLabel({ host: 'lab-box' }), 'Remote · lab-box');
  assert.strictEqual(remoteAskLabel({ host: 'lab-box', remote: { sessionTitle: '   ' } }), 'Remote · lab-box');
});

test('a local ask (no host) gets no remote label', () => {
  assert.strictEqual(remoteAskLabel({ type: 'ask:question', askId: 'a1', title: 'w', cwd: '/x', forms: [] }), null);
  assert.strictEqual(remoteAskLabel({ host: '', remote: { sessionTitle: 'x' } }), null);
  assert.strictEqual(remoteAskLabel({ host: 42 }), null);
  assert.strictEqual(remoteAskLabel(null), null);
});

test('tab host badge: "Remote · <host>" only with settings.externalHost', () => {
  assert.strictEqual(hostBadgeLabel({ engine: 'sdk', externalHost: 'lab-box' }), 'Remote · lab-box');
  assert.strictEqual(hostBadgeLabel({ engine: 'sdk' }), null);
  assert.strictEqual(hostBadgeLabel(undefined), null);
});

test('long host and session title are capped with an ellipsis', () => {
  assert.strictEqual(HOST_MAX, 100);
  assert.strictEqual(TITLE_MAX, 200);
  const host = 'h'.repeat(500);
  const title = 't'.repeat(500);
  const label = remoteAskLabel({ host, remote: { sessionTitle: title } });
  const [, h, t] = label.split(' · ');
  assert.strictEqual(Array.from(h).length, 100);
  assert.ok(h.endsWith('…'));
  assert.strictEqual(Array.from(t).length, 200);
  assert.ok(t.endsWith('…'));
  assert.strictEqual(Array.from(hostBadgeLabel({ externalHost: host }).slice('Remote · '.length)).length, 100);
  // At the limit nothing is cut; control characters are flattened.
  assert.strictEqual(capText('x'.repeat(100), 100), 'x'.repeat(100));
  assert.strictEqual(capText('a\nb\u0007c', 100), 'a b c');
  assert.strictEqual(capText({ toString: () => 'x' }, 100), '');
});

test('HTML-like input stays literal text', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const label = remoteAskLabel({ host: evil, remote: { sessionTitle: '<b>hi</b>&amp;' } });
  assert.strictEqual(label, 'Remote · <img src=x onerror=alert(1)> · <b>hi</b>&amp;');
  const el = remoteLabelEl(stubDoc, label, 'cli-ask-header-remote');
  assert.strictEqual(el.className, 'cli-ask-header-remote');
  assert.strictEqual(el.childNodes.length, 1);
  assert.strictEqual(el.childNodes[0].nodeType, 3, 'a text node, not markup');
  assert.strictEqual(el.textContent, label);
  assert.ok(!el.innerHTML.includes('<img'), 'serialises escaped');
  assert.ok(el.innerHTML.includes('&lt;img'));
});

test('the page loads the helper before the modules that use it, and they set it as text', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const at = html.indexOf('src="remote-ask.js"');
  assert.ok(at > 0, 'index.html loads remote-ask.js');
  assert.ok(at < html.indexOf('src="sdk-panel.js"') && at < html.indexOf('src="cli.js"'));
  const cli = fs.readFileSync(path.join(__dirname, '../public/cli.js'), 'utf8');
  assert.match(cli, /remoteAsk\?\.remoteAskLabel\(msg\)/);
  assert.match(cli, /remoteLabelEl\(document, meta\.remoteLabel/);
  assert.match(cli, /t\?\.external === true/, 'an external tab is an SDK tab');
  const sdk = fs.readFileSync(path.join(__dirname, '../public/sdk-panel.js'), 'utf8');
  assert.match(sdk, /remoteAsk\?\.hostBadgeLabel\(info\.settings\)/);
});
