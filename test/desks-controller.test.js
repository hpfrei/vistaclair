// The Desks view (public/desks.js) against TabHosts (public/tab-host.js), in
// a fake DOM: restoring windows (tab open → mounted; tab missing →
// placeholder with Reopen / Remove; kind not registered → placeholder, entry
// kept), Return here and Remove from desk send the tab home without closing
// it, deleting a desk sends its tabs home and offers Undo, a tab's own close
// leaves a placeholder, moving to another desk moves the root, phones ignore
// desk membership without changing it.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { makeDom, loadPublic } = require('./desks-fake-dom');

function setup({ phone = false } = {}) {
  const dom = makeDom();
  const { window } = loadPublic(['tab-context-menu.js', 'desk-layout.js', 'tab-host.js', 'desks.js'], { doc: dom.doc });
  const d = dom.doc;
  const mkEl = (cls) => { const e = d.createElement('div'); e.className = cls; d.body.appendChild(e); return e; };
  const strip = mkEl('strip'), content = mkEl('content');
  const els = { headerTab: mkEl('header-tab'), strip: mkEl('desks-strip'), area: mkEl('desks-area'), taskbar: mkEl('desks-taskbar'), empty: mkEl('desks-empty') };
  const sent = [], toasts = [], views = [], reopened = [], closed = [];
  let phoneNow = phone;
  const host = window.createTabHost({
    kind: 'cli', label: 'CLI', icon: '⌨', homeView: 'claude', stripEl: strip, contentEl: content,
    reopen: async (key) => { reopened.push(key); return true; },
  });
  const shown = {};
  const add = (key) => {
    const root = d.createElement('div');
    shown[key] = [];
    return host.add({ key, title: key, root, setShown: (v) => shown[key].push(v), destroy: () => closed.push(key) });
  };
  let n = 0;
  const desks = window.createDesks({
    send: (m) => sent.push(JSON.parse(JSON.stringify(m))), toast: (t) => toasts.push(t), isPhone: () => phoneNow,
    switchView: (v) => views.push(v), newId: () => `new${++n}`, elements: els,
  });
  const win = (key) => els.area.querySelectorAll('.desk-win').find(w => w.dataset.key === key) || null;
  const body = (key) => win(key)?.querySelector('.desk-win-body') || null;
  const state = (desks_) => ({ version: 1, desks: desks_ });
  const W = (key, extra = {}) => ({ kind: 'cli', key, title: key, geom: { x: 0, y: 0, w: 0.5, h: 0.5 }, z: 1, minimized: false, maximized: false, ...extra });
  return { dom, window, host, content, strip, els, sent, toasts, views, reopened, closed, shown, add, desks, win, body, state, W, setPhone: (v) => { phoneNow = v; } };
}

test('restore: an open tab is mounted in its window, a closed one gets Reopen / Remove, an unknown kind is kept', async () => {
  const t = setup();
  const a = t.add('a');
  t.desks.handleMessage({ type: 'desks:state', state: t.state([{ id: 'd1', name: 'Work', windows: [
    t.W('a'), t.W('gone'), { ...t.W('notes'), kind: 'apps' },
  ] }]) });
  assert.strictEqual(a.root.parentNode, t.body('a'), 'mounted');
  assert.ok(t.host.isOnDesk('a'));
  assert.deepStrictEqual(t.shown.a, [true], 'on the selected desk, not minimized: shown');
  const gone = t.win('gone');
  assert.ok(gone.classList.contains('desk-win-placeholder'));
  assert.ok(gone.querySelector('.desk-ph-reopen'));
  assert.ok(gone.querySelector('.desk-ph-remove'));
  const notes = t.els.area.querySelectorAll('.desk-win').find(w => w.dataset.kind === 'apps');
  assert.ok(notes, 'an unregistered kind keeps its window');
  assert.ok(notes.textContent.includes('not installed'));
  assert.strictEqual(notes.querySelector('.desk-ph-reopen'), null);
  assert.strictEqual(t.sent.filter(m => m.type === 'desks:return').length, 0, 'nothing removed by itself');

  // Reopen asks the host; when the tab comes back it is mounted in place.
  gone.querySelector('.desk-ph-reopen').click();
  await new Promise(r => setTimeout(r, 0));
  assert.deepStrictEqual(t.reopened, ['gone']);
  const g = t.add('gone');
  assert.strictEqual(g.root.parentNode, t.body('gone'));
  assert.ok(!t.win('gone').classList.contains('desk-win-placeholder'));
  assert.strictEqual(t.win('gone').querySelector('.desk-ph-reopen'), null);
});

test('Return here sends the tab home and does not close it; Remove from desk does the same for a placeholder', () => {
  const t = setup();
  const a = t.add('a');
  t.desks.applyState(t.state([{ id: 'd1', name: 'Work', windows: [t.W('a'), t.W('gone')] }]));
  t.win('a').querySelector('.desk-win-return').click();
  assert.deepStrictEqual(t.sent.filter(m => m.type === 'desks:return'), [{ type: 'desks:return', kind: 'cli', key: 'a' }]);
  assert.strictEqual(a.root.parentNode, t.content, 'home at once');
  assert.ok(!t.host.isOnDesk('a'));
  assert.deepStrictEqual(t.closed, [], 'the session is not closed');
  assert.strictEqual(t.win('a'), null);
  t.win('gone').querySelector('.desk-ph-remove').click();
  assert.deepStrictEqual(t.sent.filter(m => m.type === 'desks:return').map(m => m.key), ['a', 'gone']);
  assert.ok(t.host.has('a'));
});

test('Return here from the strip menu shows it in its home strip', () => {
  const t = setup();
  const a = t.add('a');
  t.desks.applyState(t.state([{ id: 'd1', name: 'Work', windows: [t.W('a')] }]));
  const items = t.host.menuItems('a');
  items.find(i => i.label === 'Return here').onClick();
  assert.strictEqual(a.root.parentNode, t.content);
  assert.strictEqual(t.host.activeKey(), 'a');
  assert.strictEqual(a.root.style.display, '');
  assert.deepStrictEqual(t.views, ['claude']);
});

test('deleting a desk sends every tab on it home, then offers Undo', () => {
  const t = setup();
  const a = t.add('a'), b = t.add('b');
  const desk = { id: 'd1', name: 'Work', windows: [t.W('a'), t.W('b')] };
  t.desks.applyState(t.state([desk, { id: 'd2', name: 'Other', windows: [] }]));
  assert.ok(t.host.isOnDesk('a') && t.host.isOnDesk('b'));
  t.desks.deleteDesk('d1');
  assert.deepStrictEqual(t.sent.filter(m => m.type === 'desks:delete'), [{ type: 'desks:delete', id: 'd1' }]);
  assert.strictEqual(a.root.parentNode, t.content);
  assert.strictEqual(b.root.parentNode, t.content);
  assert.deepStrictEqual(t.closed, []);
  assert.strictEqual(t.toasts.length, 1);
  const undo = t.toasts[0].actions.find(x => x.label === 'Undo');
  assert.ok(undo, 'an Undo action');
  undo.onClick();
  const restore = t.sent.find(m => m.type === 'desks:restore');
  assert.strictEqual(restore.desk.id, 'd1');
  assert.deepStrictEqual(restore.desk.windows.map(w => w.key), ['a', 'b']);
  assert.strictEqual(restore.index, 0);
  // The server's echo puts them back.
  t.desks.applyState(t.state([desk, { id: 'd2', name: 'Other', windows: [] }]));
  assert.strictEqual(a.root.parentNode, t.body('a'));
});

test('a tab\'s own close leaves a placeholder; the entry stays', () => {
  const t = setup();
  t.add('a');
  t.desks.applyState(t.state([{ id: 'd1', name: 'Work', windows: [t.W('a')] }]));
  t.host.remove('a');
  t.desks.render();
  assert.ok(t.win('a').classList.contains('desk-win-placeholder'));
  assert.ok(t.win('a').querySelector('.desk-ph-reopen'));
  assert.strictEqual(t.sent.filter(m => m.type === 'desks:return').length, 0);
});

test('moving to desk B takes the root out of desk A\'s window; the tab is in one place', () => {
  const t = setup();
  const a = t.add('a');
  t.desks.applyState(t.state([{ id: 'A', name: 'A', windows: [t.W('a')] }, { id: 'B', name: 'B', windows: [] }]));
  const inA = t.body('a');
  t.host.menuItems('a')[0].submenu.find(i => i.label === 'B').onClick();
  const move = t.sent.find(m => m.type === 'desks:move');
  assert.deepStrictEqual([move.deskId, move.kind, move.key], ['B', 'cli', 'a']);
  t.desks.applyState(t.state([{ id: 'A', name: 'A', windows: [] }, { id: 'B', name: 'B', windows: [t.W('a')] }]));
  const wins = t.els.area.querySelectorAll('.desk-win').filter(w => w.dataset.key === 'a');
  assert.strictEqual(wins.length, 1, 'one window');
  assert.strictEqual(a.root.parentNode, wins[0].querySelector('.desk-win-body'));
  assert.ok(!inA.contains(a.root));
  assert.deepStrictEqual(t.shown.a, [true, false], 'B is not the selected desk: hidden');
  t.desks.setActive('B');
  assert.deepStrictEqual(t.shown.a, [true, false, true]);
});

test('New desk… from the tab menu creates the desk and moves the tab, in that order', () => {
  const t = setup();
  t.add('a');
  t.desks.applyState(t.state([]));
  t.host.menuItems('a')[0].submenu.find(i => i.input).input.onSubmit('Fresh');
  assert.deepStrictEqual(t.sent.map(m => m.type), ['desks:create', 'desks:move']);
  assert.deepStrictEqual([t.sent[0].id, t.sent[0].name], ['new1', 'Fresh']);
  assert.strictEqual(t.sent[1].deskId, 'new1');
});

test('the chip in the home strip shows the desk; clicking it goes to the window', () => {
  const t = setup();
  t.add('a');
  t.desks.applyState(t.state([{ id: 'd1', name: 'Work', windows: [t.W('a', { minimized: true })] }]));
  const btn = t.strip.querySelector('.view-tab[data-tab-key]');
  assert.strictEqual(btn.querySelector('.tab-desk-chip').textContent, 'on desk Work');
  btn.click();
  assert.deepStrictEqual(t.views, ['desks']);
  assert.deepStrictEqual(t.sent.find(m => m.type === 'desks:window').patch, { minimized: false }, 'a minimized window is restored');
});

test('minimize hides the window but keeps it in the taskbar; Tile all lays every window out', () => {
  const t = setup();
  t.add('a'); t.add('b');
  t.desks.applyState(t.state([{ id: 'd1', name: 'Work', windows: [t.W('a'), t.W('b', { z: 2 })] }]));
  t.win('a').querySelector('.desk-win-min').click();
  assert.strictEqual(t.win('a').style.display, 'none');
  assert.deepStrictEqual(t.shown.a, [true, false]);
  assert.strictEqual(t.els.taskbar.querySelectorAll('.desk-task').length, 2);
  assert.ok(t.els.taskbar.querySelectorAll('.desk-task')[0].classList.contains('minimized'));
  t.desks.tileAll();
  const tile = t.sent.find(m => m.type === 'desks:windows');
  assert.deepStrictEqual(tile.windows.map(w => [w.key, w.patch.geom.w, w.patch.minimized]), [['a', 0.5, false], ['b', 0.5, false]]);
  assert.strictEqual(t.win('a').style.display, '');
});

test('on a phone desk membership is ignored and the state is not changed', () => {
  const t = setup({ phone: true });
  const a = t.add('a');
  t.desks.applyState(t.state([{ id: 'd1', name: 'Work', windows: [t.W('a')] }]));
  assert.strictEqual(a.root.parentNode, t.content, 'home');
  assert.ok(!t.host.isOnDesk('a'));
  assert.strictEqual(t.host.menuItems('a').length, 0, 'no Move to desk');
  assert.strictEqual(t.sent.length, 0, 'nothing sent');
  assert.strictEqual(t.desks.state().desks[0].windows.length, 1);
  t.setPhone(false);
  t.desks.render();
  assert.strictEqual(a.root.parentNode, t.body('a'), 'back on its desk at desktop width');
});

test('before the server sends desks:state (an old server) there is no Move to desk', () => {
  const t = setup();
  t.add('a');
  assert.strictEqual(t.host.menuItems('a').length, 0);
});

test('a rekeyed tab keeps its window', () => {
  const t = setup();
  const a = t.add('tab:1');
  t.desks.applyState(t.state([{ id: 'd1', name: 'Work', windows: [t.W('tab:1')] }]));
  t.host.rekey('tab:1', 'orch-x');
  assert.deepStrictEqual(t.sent.find(m => m.type === 'desks:rekey'), { type: 'desks:rekey', kind: 'cli', from: 'tab:1', to: 'orch-x' });
  assert.strictEqual(a.root.parentNode, t.body('orch-x'));
  assert.ok(t.host.isOnDesk('orch-x'));
});

test('busy: host.setBusy shows the dot on the Desks header tab, the desk tab and the window; rekey, rename, delete and phones follow', () => {
  const t = setup();
  const running = (e) => e.classList.contains('instance-running');
  const deskTab = (id) => t.els.strip.querySelectorAll('.desk-tab').find(b => b.dataset.deskId === id);
  const stripBtn = (key) => t.strip.querySelectorAll('.view-tab[data-tab-key]').find(b => b.dataset.tabKey === key);
  t.add('a'); t.add('b');
  t.desks.applyState(t.state([{ id: 'd1', name: 'Work', windows: [t.W('a')] }, { id: 'd2', name: 'Two', windows: [] }]));
  assert.ok(!running(t.els.headerTab));

  assert.strictEqual(t.host.setBusy('a', true), true);
  assert.strictEqual(t.host.setBusy('a', true), false, 'no change, no event');
  assert.ok(t.host.isBusy('a'));
  assert.deepStrictEqual(Array.from(t.host.busyKeys()), ['a']);
  assert.ok(running(t.els.headerTab) && running(deskTab('d1')) && !running(deskTab('d2')));
  assert.ok(t.win('a').classList.contains('desk-win-busy'));
  assert.ok(running(stripBtn('a')), 'the strip button too (host-drawn)');
  t.host.render();
  assert.ok(running(stripBtn('a')), 'and after a redraw');

  // A busy tab at home does not light Desks.
  t.host.setBusy('b', true);
  assert.ok(!running(deskTab('d2')));
  t.host.setBusy('b', false);

  // rekey keeps busy and the window; rename keeps the dot on the tab.
  t.host.rekey('a', 'a2');
  assert.ok(running(deskTab('d1')) && running(t.els.headerTab));
  assert.ok(t.win('a2').classList.contains('desk-win-busy'));
  t.desks.renameDesk('d1', 'Renamed');
  assert.ok(running(deskTab('d1')));

  // The window moves to desk 2.
  t.desks.applyState(t.state([{ id: 'd1', name: 'Renamed', windows: [] }, { id: 'd2', name: 'Two', windows: [t.W('a2')] }]));
  assert.ok(!running(deskTab('d1')) && running(deskTab('d2')) && running(t.els.headerTab));

  // A phone ignores desks: the tab is home again, nothing lights on Desks.
  t.setPhone(true);
  t.desks.render();
  assert.ok(!running(t.els.headerTab));
  t.setPhone(false);
  t.desks.render();
  assert.ok(running(t.els.headerTab));

  // The desk goes: its tab goes home, the header tab clears. Busy off clears too.
  t.desks.applyState(t.state([{ id: 'd1', name: 'Renamed', windows: [] }]));
  assert.ok(!running(t.els.headerTab));
  t.desks.applyState(t.state([{ id: 'd1', name: 'Renamed', windows: [t.W('a2')] }]));
  assert.ok(running(t.els.headerTab));
  t.host.setBusy('a2', false);
  assert.ok(!running(t.els.headerTab) && !running(deskTab('d1')) && !t.win('a2').classList.contains('desk-win-busy'));
  assert.ok(!running(stripBtn('a2')));
});
