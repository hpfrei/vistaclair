// Inspector instance views: every open Inspector tab is a deep clone of the
// page's static .inspector-body template, so nothing inside that template may
// carry an id — with two tabs open the page would hold duplicates (invalid
// HTML), and the styles would hang on a name that no longer picks one element.
// The template's pieces are classes. Runs the real inspector.js on the fake DOM.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { loadInspector } = require('./inspector-sandbox');

test('two open Inspector tabs never put the same id in the document twice', () => {
  const s = loadInspector();
  const { mod, document } = s;
  mod.handleMessage({ type: 'init', sessions: [
    { instanceId: 'cli-a', kind: 'cli', status: 'running', label: 'A' },
    { instanceId: 'cli-b', kind: 'cli', status: 'running', label: 'B' },
  ] });
  const a = mod.createInstanceView('cli-a');
  const b = mod.createInstanceView('cli-b');
  for (const v of [a, b]) {
    const box = document.createElement('div');
    document.body.appendChild(box);
    box.appendChild(v.root);
    v.setShown(true);
  }
  s.dom.flushFrames();

  const seen = new Map();
  for (const el of document.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) || 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`);
  assert.deepStrictEqual(dupes, [], 'duplicate ids in the document');

  // And the view's own pieces carry no id at all.
  for (const v of [a, b]) assert.deepStrictEqual(v.root.querySelectorAll('[id]').map(e => e.id), []);
});
