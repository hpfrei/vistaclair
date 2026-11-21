// Renaming a desk asks in a dialog that lives outside the strip (not an
// inline input that a strip re-render drops). Double-click and the right-click
// "Rename" both open it; a re-render while it is open changes nothing;
// Cancel / unchanged / empty send nothing.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { makeDom, loadPublic } = require('./desks-fake-dom');

function setup() {
  const dom = makeDom();
  const { window } = loadPublic(['tab-context-menu.js', 'desk-layout.js', 'tab-host.js', 'desks.js'], { doc: dom.doc });
  const d = dom.doc;
  const mkEl = (cls) => { const e = d.createElement('div'); e.className = cls; d.body.appendChild(e); return e; };
  const els = { headerTab: mkEl('header-tab'), strip: mkEl('desks-strip'), area: mkEl('desks-area'), taskbar: mkEl('desks-taskbar'), empty: mkEl('desks-empty') };
  const sent = [], asked = [];
  let answer = null;
  const desks = window.createDesks({
    send: (m) => sent.push(JSON.parse(JSON.stringify(m))), toast() {}, isPhone: () => false, elements: els,
    prompt: (message, opts) => new Promise((resolve) => { asked.push({ message, opts }); answer = resolve; }),
  });
  desks.handleMessage({ type: 'desks:state', state: { version: 1, desks: [{ id: 'd1', name: 'Work', windows: [] }] } });
  const tab = () => els.strip.querySelectorAll('.desk-tab')[0];
  return { window, els, desks, sent, asked, tab, answer: (v) => answer(v) };
}
const tick = () => new Promise((r) => setImmediate(r));

test('double-click opens the dialog prefilled; a strip re-render while open does not lose it; OK sends desks:rename', async () => {
  const t = setup();
  t.tab().dispatch('dblclick');
  assert.strictEqual(t.asked.length, 1);
  assert.strictEqual(t.asked[0].message, 'Rename desk');
  assert.strictEqual(t.asked[0].opts.defaultValue, 'Work');
  assert.strictEqual(t.els.strip.querySelectorAll('.desk-tab-input').length, 0, 'no inline input in the strip');
  t.desks.render(); t.desks.render();   // a state broadcast / busy dot / the selecting click
  t.desks.handleMessage({ type: 'desks:state', state: { version: 1, desks: [{ id: 'd1', name: 'Work', windows: [] }] } });
  t.answer('  Play  ');
  await tick();
  assert.deepStrictEqual(t.sent, [{ type: 'desks:rename', id: 'd1', name: 'Play' }]);
});

test('the right-click Rename item opens the same dialog; a second open while one is up is ignored', async () => {
  const t = setup();
  t.tab().dispatch('contextmenu', { clientX: 5, clientY: 5 });
  const item = t.window.document.querySelectorAll('.tab-ctx-item').find(e => e.textContent === 'Rename');
  assert.ok(item, 'menu has Rename');
  item.click();
  t.tab().dispatch('dblclick');
  assert.strictEqual(t.asked.length, 1);
  t.answer('Home');
  await tick();
  assert.deepStrictEqual(t.sent.map(m => m.name), ['Home']);
});

test('Cancel, an unchanged name and an empty name send nothing', async () => {
  const t = setup();
  for (const v of [null, 'Work', '   ', '']) {
    t.tab().dispatch('dblclick');
    t.answer(v);
    await tick();
  }
  assert.strictEqual(t.asked.length, 4, 'the dialog can be reopened after each');
  assert.deepStrictEqual(t.sent, []);
});
