// Desk windows must never draw above notifications: window z-indexes are a
// raise counter (public/desks.js: 1 + w.z), so the desk area has to be its
// own stacking context below the toast layer.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
function rule(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('(?:^|\\})\\s*' + esc + '\\s*\\{([^}]*)\\}', 'm').exec(css);
  assert.ok(m, 'rule not found: ' + selector);
  return m[1];
}
const prop = (body, name) => { const m = new RegExp('(?:^|[;\\s])' + name + '\\s*:\\s*([^;]+)').exec(body); return m && m[1].trim(); };

test('window z-index is an unbounded raise counter (so confinement is required)', () => {
  assert.match(read('desks.js'), /zIndex = String\(1 \+ \(w\.z \|\| 0\)\)/);
});

test('.desks-area forms a stacking context, so window z cannot escape it', () => {
  const body = rule(read('desks.css'), '.desks-area');
  const iso = prop(body, 'isolation') === 'isolate';
  const z = prop(body, 'z-index');
  const pos = prop(body, 'position');
  assert.ok(iso || (pos !== 'static' && z != null && z !== 'auto'), '.desks-area must create a stacking context');
});

test('the desk area stacks below the toast layer', () => {
  const area = rule(read('desks.css'), '.desks-area');
  const toast = rule(read('style.css'), '.toast-container');
  const areaZ = Number(prop(area, 'z-index') ?? 0);
  const toastZ = Number(prop(toast, 'z-index'));
  assert.ok(Number.isFinite(toastZ));
  assert.ok(areaZ < toastZ, `desk area z ${areaZ} must be below toast z ${toastZ}`);
});
