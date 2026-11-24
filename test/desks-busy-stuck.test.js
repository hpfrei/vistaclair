// The owner's stuck "Removing N…" button on the Sessions tab:
//  1. desks.js renderBusy called .find on a querySelectorAll NodeList (a
//     TypeError in the browser, which has no NodeList.find). It ran on every
//     tab-host event once a desk existed, so the strip's busy dots broke and
//     the error was only logged by tab-host.
//  2. The server's cli:deleteSavedSessionsDone was not routed by core.js to
//     the CLI module, so the button only cleared at the 60 s safety timeout.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeDom, loadPublic } = require('./desks-fake-dom');

test('renderBusy with desk tabs in the strip does not throw (NodeList has no .find)', () => {
  const dom = makeDom();
  dom.doc.strictNodeLists = true;   // querySelectorAll answers a NodeList-like, not an array
  const { window } = loadPublic(['tab-context-menu.js', 'desk-layout.js', 'tab-host.js', 'desks.js'], { doc: dom.doc });
  const d = dom.doc;
  const mkEl = (cls) => { const e = d.createElement('div'); e.className = cls; d.body.appendChild(e); return e; };
  const strip = mkEl('strip'), content = mkEl('content');
  const els = { headerTab: mkEl('header-tab'), strip: mkEl('desks-strip'), area: mkEl('desks-area'), taskbar: mkEl('desks-taskbar'), empty: mkEl('desks-empty') };
  assert.throws(() => els.strip.querySelectorAll('.x').find(() => true), TypeError, 'the fake DOM must behave like a NodeList');
  const host = window.createTabHost({ kind: 'cli', label: 'CLI', icon: '⌨', homeView: 'claude', stripEl: strip, contentEl: content, reopen: async () => true });
  const desks = window.createDesks({ send() {}, toast() {}, isPhone: () => false, switchView() {}, newId: () => 'n1', elements: els });
  host.add({ key: 'a', title: 'a', root: d.createElement('div'), setShown() {}, destroy() {} });
  desks.applyState({ version: 1, desks: [{ id: 'd1', name: 'Work', windows: [{ kind: 'cli', key: 'a', title: 'a', geom: { x: 0, y: 0, w: 0.5, h: 0.5 }, z: 1, minimized: false, maximized: false }] }] });

  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a);
  try {
    host.setBusy('a', true);
    host.remove('a');            // what removeTab does when its session is deleted
  } finally { console.error = orig; }
  assert.deepStrictEqual(errors.map(e => String(e[1] || e[0])), [], 'no listener failed');
  const tab = Array.from(els.strip.querySelectorAll('.desk-tab')).find(b => b.dataset.deskId === 'd1');
  assert.ok(tab, 'the desk tab is in the strip');
  assert.ok(!tab.classList.contains('instance-running'), 'and its busy dot follows the tab (gone with it)');
});

test('core.js routes the batch delete\'s Done to the CLI module (the button ends on it)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'core.js'), 'utf8');
  const at = src.indexOf("window.cliModule?.handleMessage(msg)");
  assert.ok(at > 0);
  const group = src.slice(src.lastIndexOf("case 'cli:output':", at), at);
  assert.ok(group.includes("case 'cli:deleteSavedSessionsDone':"), 'cli:deleteSavedSessionsDone is not routed to cliModule');
  // Every cli: type the server sends for the batch has a route.
  const handler = fs.readFileSync(path.join(__dirname, '..', 'src', 'ws', 'cli-handler.js'), 'utf8');
  const block = handler.slice(handler.indexOf("case 'cli:deleteSavedSessions'"), handler.indexOf("case 'cli:pause'"));
  for (const t of new Set([...block.matchAll(/type: '(cli:[A-Za-z]+)'/g)].map(m => m[1]))) {
    assert.ok(group.includes(`case '${t}':`), `${t} is sent by the batch delete but not routed`);
  }
});
