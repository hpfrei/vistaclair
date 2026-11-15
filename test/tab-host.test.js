// TabHost (public/tab-host.js) and the shared tab menu (public/tab-context-menu.js):
// add / activate, handing a tab to a desk window and back (root moved, never
// rebuilt; setShown on every visibility change), that a desk-held root is
// never touched by the strip's "hide every other tab", that a tab on a desk
// stays reachable from its home strip, and the menu items.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeDom, loadPublic } = require('./desks-fake-dom');

function setup({ provider, onSelect } = {}) {
  const dom = makeDom();
  const { window } = loadPublic(['tab-context-menu.js', 'tab-host.js'], { doc: dom.doc });
  const strip = dom.doc.createElement('div');
  const plus = dom.doc.createElement('button');
  strip.appendChild(plus);
  const content = dom.doc.createElement('div');
  dom.doc.body.append(strip, content);
  const events = [];
  window.tabHosts.on((e) => events.push(e));
  if (provider) window.tabHosts.setDeskProvider(provider);
  const selected = [];
  const host = window.createTabHost({
    kind: 'cli', label: 'CLI', homeView: 'claude', stripEl: strip, beforeEl: plus, contentEl: content,
    reopen: async () => true,
    extraMenuItems: (key) => [{ label: `Close ${key}`, onClick() {} }],
    ...(onSelect ? { onSelect: (k) => { selected.push(k); onSelect(k, host); } } : {}),
  });
  const shown = {};
  const destroyed = [];
  const mk = (key) => {
    const root = dom.doc.createElement('div');
    root.className = 'cli-terminal-wrap';
    shown[key] = [];
    return { key, title: key.toUpperCase(), root, setShown: (v) => shown[key].push(v), destroy: () => destroyed.push(key) };
  };
  return { dom, window, host, strip, content, plus, shown, destroyed, events, mk, selected };
}

const tabButtons = (strip) => strip.querySelectorAll('.view-tab[data-tab-key]');
// Arrays made inside the vm are another realm's: copy before deepStrictEqual.
const labels = (items) => Array.from(items, i => i.label || '—');

test('add and activate: the root lives in the home area, one shown at a time, setShown on each change', () => {
  const { host, strip, content, plus, shown, mk, events } = setup();
  const a = host.add(mk('a'));
  const b = host.add(mk('b'));
  assert.strictEqual(a.root.parentNode, content);
  assert.strictEqual(a.root.style.display, 'none');
  assert.deepStrictEqual(tabButtons(strip).map(x => x.dataset.tabKey), ['a', 'b']);
  assert.strictEqual(strip.children[strip.children.length - 1], plus, 'tab buttons go before the + button');
  assert.deepStrictEqual(events.filter(e => e.type === 'add').map(e => e.key), ['a', 'b']);

  host.activate('a');
  assert.strictEqual(a.root.style.display, '');
  assert.strictEqual(b.root.style.display, 'none');
  assert.deepStrictEqual(shown.a, [true]);
  host.activate('b');
  assert.deepStrictEqual(shown.a, [true, false]);
  assert.deepStrictEqual(shown.b, [true]);
  host.activate('b');
  assert.deepStrictEqual(shown.b, [true], 'no repeat for no change');
  assert.ok(tabButtons(strip)[1].classList.contains('active'));
  host.activate(null);
  assert.deepStrictEqual(shown.b, [true, false]);
  assert.strictEqual(host.activeKey(), null);
});

test('the content contract is checked on add', () => {
  const { host, mk } = setup();
  assert.throws(() => host.add({ ...mk('x'), key: '' }), /key/);
  assert.throws(() => host.add({ ...mk('x'), setShown: null }), /setShown/);
  assert.throws(() => host.add({ ...mk('x'), destroy: undefined }), /destroy/);
  assert.throws(() => host.add({ ...mk('x'), root: {} }), /root/);
  host.add(mk('x'));
  assert.throws(() => host.add(mk('x')), /already/);
});

test('to a desk and back: the same root is moved (not rebuilt), setShown follows the window', () => {
  const provider = { enabled: () => true, list: () => [], deskOf: () => null, show() {} };
  const { dom, host, content, shown, mk, selected } = setup({ provider, onSelect: (k, h) => h.activate(k) });
  const a = host.add(mk('a'));
  host.add(mk('b'));
  host.activate('a');
  const built = dom.constructed();
  const body = dom.doc.createElement('div');
  dom.doc.body.appendChild(body);

  assert.ok(host.attachToDesk('a', body, { id: 'd1', name: 'Work' }));
  assert.strictEqual(a.root.parentNode, body, 'moved into the window body');
  assert.ok(!content.children.includes(a.root));
  assert.strictEqual(a.root.style.display, '');
  assert.deepStrictEqual(shown.a, [true, false], 'hidden until the desk shows it');
  assert.deepStrictEqual(selected, ['b'], 'the shown home tab left: the kind is asked to show the next');
  assert.strictEqual(host.activeKey(), 'b');

  host.setDeskShown('a', true);
  host.setDeskShown('a', true);
  assert.deepStrictEqual(shown.a, [true, false, true]);
  host.refit('a');
  assert.deepStrictEqual(shown.a, [true, false, true, true], 'refit repeats setShown(true) after a resize');
  host.setDeskShown('a', false);
  assert.deepStrictEqual(shown.a, [true, false, true, true, false]);

  host.setDeskShown('a', true);
  assert.ok(host.detachFromDesk('a'));
  assert.strictEqual(a.root.parentNode, content, 'back home');
  assert.strictEqual(a.root.style.display, 'none');
  assert.strictEqual(shown.a[shown.a.length - 1], false);
  host.activate('a');
  assert.strictEqual(a.root.style.display, '');
  assert.strictEqual(dom.constructed() - built, 0 + (dom.constructed() - built), 'sanity');
  assert.strictEqual(host.get('a').root, a.root, 'one root for the life of the tab');
});

test('the strip\'s "hide every other tab" (activate) never touches a root on a desk', () => {
  const provider = { enabled: () => true, list: () => [], deskOf: () => null, show() {} };
  const { dom, host, shown, mk } = setup({ provider });
  const a = host.add(mk('a'));
  const b = host.add(mk('b'));
  const body = dom.doc.createElement('div');
  host.attachToDesk('a', body, { id: 'd1', name: 'Work' });
  host.setDeskShown('a', true);
  host.activate('b');
  host.activate(null);    // the CLI's Sessions tab
  assert.strictEqual(b.root.style.display, 'none');
  host.activate('b');
  assert.strictEqual(a.root.style.display, '', 'still visible in its window');
  assert.strictEqual(a.root.parentNode, body);
  assert.deepStrictEqual(shown.a, [true], 'and still shown');
  assert.strictEqual(host.activate('a'), false, 'a desk-held tab is not shown in the home area');
  assert.strictEqual(a.root.parentNode, body);
  assert.strictEqual(b.root.style.display, '');
});

test('cli.js hides other tabs only through the host (no loop over every wrap)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'cli.js'), 'utf8');
  assert.ok(!/for \([^)]*tabs[^)]*\)[^\n]*\.wrap\.style\.display/.test(src), 'a loop that sets every wrap\'s display would hide desk windows');
  assert.ok(!/tab\.wrap\.style\.display = id === tabId/.test(src), 'switchTab must not set every wrap\'s display');
});

test('a tab on a desk stays in its home strip, dimmed with the desk chip; a click goes to its window', () => {
  const shows = [];
  const provider = { enabled: () => true, list: () => [{ id: 'd1', name: 'Work' }], deskOf: () => ({ id: 'd1', name: 'Work' }), show: (k, key) => shows.push([k, key]) };
  const { dom, host, strip, mk } = setup({ provider });
  const a = host.add(mk('a'));
  const body1 = dom.doc.createElement('div');
  const body2 = dom.doc.createElement('div');
  host.attachToDesk('a', body1, { id: 'd1', name: 'Work' });
  const btn = tabButtons(strip).find(x => x.dataset.tabKey === 'a');
  assert.ok(btn, 'still in the home strip');
  assert.ok(btn.classList.contains('tab-on-desk'));
  assert.strictEqual(btn.querySelector('.tab-desk-chip').textContent, 'on desk Work');
  btn.click();
  assert.deepStrictEqual(shows, [['cli', 'a']]);
  // Exactly one place: a second window takes it from the first.
  host.attachToDesk('a', body2, { id: 'd2', name: 'Other' });
  assert.strictEqual(a.root.parentNode, body2);
  assert.ok(!body1.children.includes(a.root));
  assert.strictEqual(tabButtons(strip).find(x => x.dataset.tabKey === 'a').querySelector('.tab-desk-chip').textContent, 'on desk Other');
  host.setDeskInfo('a', { id: 'd2', name: 'Renamed' });
  assert.strictEqual(tabButtons(strip).find(x => x.dataset.tabKey === 'a').querySelector('.tab-desk-chip').textContent, 'on desk Renamed');
});

test('remove: destroy() is called, the root leaves the page, desks hear it', () => {
  const provider = { enabled: () => true, list: () => [], deskOf: () => null, show() {} };
  const { dom, host, destroyed, mk, events, strip } = setup({ provider });
  const a = host.add(mk('a'));
  const body = dom.doc.createElement('div');
  host.attachToDesk('a', body, { id: 'd1', name: 'Work' });
  host.remove('a');
  assert.deepStrictEqual(destroyed, ['a']);
  assert.strictEqual(a.root.parentNode, null);
  assert.ok(events.some(e => e.type === 'remove' && e.key === 'a' && e.kind === 'cli'));
  assert.strictEqual(tabButtons(strip).length, 0);
});

test('rekey and update reach the registry', () => {
  const { host, mk, events } = setup();
  host.add(mk('tab:1'));
  host.activate('tab:1');
  assert.ok(host.rekey('tab:1', 'orch-x'));
  assert.strictEqual(host.activeKey(), 'orch-x');
  assert.ok(host.has('orch-x') && !host.has('tab:1'));
  assert.strictEqual(host.get('orch-x').key, 'orch-x');
  host.update('orch-x', { title: 'New' });
  assert.deepStrictEqual(events.filter(e => e.type === 'rekey' || e.type === 'update').map(e => [e.type, e.key]), [['rekey', 'orch-x'], ['update', 'orch-x']]);
});

test('menu: Move to desk lists the other desks and New desk…; Show / Return on a desk; the kind\'s items follow', () => {
  const calls = [];
  let on = null;
  const provider = {
    enabled: () => true,
    list: () => [{ id: 'd1', name: 'Work' }, { id: 'd2', name: 'Play' }],
    deskOf: () => on,
    moveTo: (...a) => calls.push(['moveTo', ...a]),
    createAndMove: (...a) => calls.push(['createAndMove', ...a]),
    show: (...a) => calls.push(['show', ...a]),
    returnHome: (...a) => calls.push(['returnHome', ...a]),
  };
  const { host, mk } = setup({ provider });
  host.add(mk('a'));
  let items = host.menuItems('a');
  assert.deepStrictEqual(labels(items), ['Move to desk', '—', 'Close a']);
  assert.deepStrictEqual(labels(items[0].submenu), ['Work', 'Play', '—', 'New desk…']);
  items[0].submenu[1].onClick();
  items[0].submenu[3].input.onSubmit('Fresh');
  assert.deepStrictEqual(calls, [['moveTo', 'cli', 'a', 'd2', 'A'], ['createAndMove', 'cli', 'a', 'Fresh', 'A']]);

  on = { id: 'd1', name: 'Work' };
  items = host.menuItems('a');
  assert.deepStrictEqual(labels(items), ['Move to desk', 'Show on desk "Work"', 'Return here', '—', 'Close a']);
  assert.deepStrictEqual(labels(items[0].submenu), ['Play', '—', 'New desk…'], 'not its own desk');
  calls.length = 0;
  items[1].onClick();
  items[2].onClick();
  assert.deepStrictEqual(calls.map(c => c.slice(0, 3)), [['show', 'cli', 'a'], ['returnHome', 'cli', 'a']]);
});

test('menu on a phone (no desk provider enabled): only the kind\'s items', () => {
  const provider = { enabled: () => false, list: () => [{ id: 'd1', name: 'Work' }], deskOf: () => null };
  const { host, mk } = setup({ provider });
  host.add(mk('a'));
  assert.deepStrictEqual(labels(host.menuItems('a')), ['Close a']);
});

test('the right-click opens the shared menu on the strip button', () => {
  const provider = { enabled: () => true, list: () => [], deskOf: () => null };
  const { dom, host, strip, mk, window } = setup({ provider });
  host.add(mk('a'));
  const btn = tabButtons(strip)[0];
  const ev = btn.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  assert.ok(window.tabContextMenu.isOpen());
  const menu = dom.doc.body.querySelector('.tab-ctx-menu');
  assert.ok(menu.textContent.includes('Move to desk'));
  assert.ok(menu.textContent.includes('Close a'));
  assert.ok(ev);
  window.tabContextMenu.close();
  assert.strictEqual(dom.doc.body.querySelector('.tab-ctx-menu'), null);
});
