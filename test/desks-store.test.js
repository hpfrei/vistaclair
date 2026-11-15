// The Desks store (src/desks.js) and its socket handler (src/ws/desks-handler.js):
// create / rename / delete / restore, moving a tab on and off desks, the
// one-desk invariant, the atomic persistence round trip, corrupt-file
// recovery, and that every change reaches every dashboard.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDesksStore } = require('../src/desks');
const desksHandler = require('../src/ws/desks-handler');

const quiet = { error() {}, warn() {} };
function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desks-test-'));
  return path.join(dir, 'data', 'desks.json');
}
const where = (s, kind, key) => s.get().desks.filter(d => d.windows.some(w => w.kind === kind && w.key === key)).map(d => d.id);

test('create, rename, delete a desk', () => {
  const s = createDesksStore({ file: tmpFile(), log: quiet });
  assert.deepStrictEqual(s.get().desks, []);
  assert.ok(s.createDesk({ id: 'd1', name: '  Work  ' }).ok);
  assert.ok(s.createDesk({ id: 'd2' }).ok);
  assert.deepStrictEqual(s.get().desks.map(d => [d.id, d.name]), [['d1', 'Work'], ['d2', 'Desk 2']]);
  assert.strictEqual(s.createDesk({ id: 'd1' }).ok, false, 'ids are unique');
  assert.strictEqual(s.createDesk({ id: 'bad id!' }).ok, false);
  assert.ok(s.renameDesk({ id: 'd1', name: 'Review' }).ok);
  assert.strictEqual(s.get().desks[0].name, 'Review');
  assert.ok(s.renameDesk({ id: 'd1', name: '   ' }).ok, 'an empty name keeps the old one');
  assert.strictEqual(s.get().desks[0].name, 'Review');
  assert.strictEqual(s.renameDesk({ id: 'nope', name: 'x' }).ok, false);
  const del = s.deleteDesk({ id: 'd1' });
  assert.ok(del.ok);
  assert.strictEqual(del.desk.id, 'd1');
  assert.deepStrictEqual(s.get().desks.map(d => d.id), ['d2']);
});

test('move and return: a tab is on at most one desk (moving to B takes it off A)', () => {
  const s = createDesksStore({ file: tmpFile(), log: quiet });
  s.createDesk({ id: 'A' }); s.createDesk({ id: 'B' });
  assert.ok(s.moveTab({ deskId: 'A', kind: 'cli', key: 'orch-1', title: 'one' }).ok);
  assert.deepStrictEqual(where(s, 'cli', 'orch-1'), ['A']);
  assert.ok(s.moveTab({ deskId: 'B', kind: 'cli', key: 'orch-1' }).ok);
  assert.deepStrictEqual(where(s, 'cli', 'orch-1'), ['B'], 'moved to B, gone from A');
  // Same key, other kind: a different tab.
  assert.ok(s.moveTab({ deskId: 'A', kind: 'inspector', key: 'orch-1' }).ok);
  assert.deepStrictEqual(where(s, 'inspector', 'orch-1'), ['A']);
  assert.deepStrictEqual(where(s, 'cli', 'orch-1'), ['B']);
  // Moving again onto the desk it is on keeps one entry.
  assert.ok(s.moveTab({ deskId: 'B', kind: 'cli', key: 'orch-1', title: 'renamed' }).ok);
  assert.strictEqual(s.get().desks[1].windows.filter(w => w.key === 'orch-1').length, 1);
  assert.strictEqual(s.get().desks[1].windows[0].title, 'renamed');
  assert.strictEqual(s.moveTab({ deskId: 'nope', kind: 'cli', key: 'x' }).ok, false);
  assert.strictEqual(s.moveTab({ deskId: 'A', kind: 'BAD KIND', key: 'x' }).ok, false);
  assert.ok(s.returnTab({ kind: 'cli', key: 'orch-1' }).ok);
  assert.deepStrictEqual(where(s, 'cli', 'orch-1'), []);
  assert.strictEqual(s.returnTab({ kind: 'cli', key: 'orch-1' }).ok, false);
});

test('window patch: geometry is kept as clamped fractions', () => {
  const s = createDesksStore({ file: tmpFile(), log: quiet });
  s.createDesk({ id: 'A' });
  s.moveTab({ deskId: 'A', kind: 'cli', key: 'k', geom: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } });
  assert.deepStrictEqual(s.get().desks[0].windows[0].geom, { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  assert.ok(s.setWindow({ deskId: 'A', kind: 'cli', key: 'k', patch: { geom: { x: -3, y: 9, w: 2, h: 0 }, minimized: true, z: 7 } }).ok);
  const w = s.get().desks[0].windows[0];
  assert.deepStrictEqual(w.geom, { x: 0, y: 1, w: 1, h: 0.05 });
  assert.strictEqual(w.minimized, true);
  assert.strictEqual(w.z, 7);
  assert.ok(s.setWindows({ deskId: 'A', windows: [{ kind: 'cli', key: 'k', patch: { maximized: true, minimized: false } }] }).ok);
  assert.strictEqual(s.get().desks[0].windows[0].maximized, true);
  assert.strictEqual(s.setWindow({ deskId: 'A', kind: 'cli', key: 'none', patch: {} }).ok, false);
});

test('delete then restore (Undo): the desk comes back, minus tabs moved elsewhere meanwhile', () => {
  const s = createDesksStore({ file: tmpFile(), log: quiet });
  s.createDesk({ id: 'A', name: 'Alpha' }); s.createDesk({ id: 'B' });
  s.moveTab({ deskId: 'A', kind: 'cli', key: 'one' });
  s.moveTab({ deskId: 'A', kind: 'cli', key: 'two' });
  const { desk, index } = s.deleteDesk({ id: 'A' });
  assert.deepStrictEqual(where(s, 'cli', 'one'), [], 'deleting a desk sends its tabs home');
  s.moveTab({ deskId: 'B', kind: 'cli', key: 'two' });
  assert.ok(s.restoreDesk({ desk, index }).ok);
  assert.deepStrictEqual(s.get().desks.map(d => d.id), ['A', 'B'], 'back at its place');
  assert.strictEqual(s.get().desks[0].name, 'Alpha');
  assert.deepStrictEqual(where(s, 'cli', 'one'), ['A']);
  assert.deepStrictEqual(where(s, 'cli', 'two'), ['B'], 'restore never puts a tab on two desks');
  assert.strictEqual(s.restoreDesk({ desk, index }).ok, false, 'not twice');
});

test('rekey: the entry follows the tab to its new key', () => {
  const s = createDesksStore({ file: tmpFile(), log: quiet });
  s.createDesk({ id: 'A' });
  s.moveTab({ deskId: 'A', kind: 'cli', key: 'sess-1' });
  assert.ok(s.rekey({ kind: 'cli', from: 'sess-1', to: 'orch-x' }).ok);
  assert.deepStrictEqual(where(s, 'cli', 'orch-x'), ['A']);
  assert.deepStrictEqual(where(s, 'cli', 'sess-1'), []);
});

test('persistence round trip: a new store on the same file sees every change; writes are atomic', () => {
  const file = tmpFile();
  const s = createDesksStore({ file, log: quiet });
  s.createDesk({ id: 'A', name: 'Alpha' });
  s.moveTab({ deskId: 'A', kind: 'cli', key: 'k', title: 'T', geom: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 } });
  s.setWindow({ deskId: 'A', kind: 'cli', key: 'k', patch: { minimized: true } });
  const again = createDesksStore({ file, log: quiet });
  assert.deepStrictEqual(again.get(), s.get());
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['desks.json'], 'no temporary file is left behind');

  // The write goes to a temporary file that is renamed over desks.json.
  const renames = [];
  const orig = fs.renameSync;
  fs.renameSync = (a, b) => { renames.push([path.basename(a), path.basename(b)]); return orig(a, b); };
  try { s.renameDesk({ id: 'A', name: 'Beta' }); } finally { fs.renameSync = orig; }
  assert.strictEqual(renames.length, 1);
  assert.match(renames[0][0], /^desks\.json\..+\.tmp$/);
  assert.strictEqual(renames[0][1], 'desks.json');
});

test('a corrupt file is backed up, the store starts empty and keeps working', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  let s;
  assert.doesNotThrow(() => { s = createDesksStore({ file, log: quiet, now: () => 1234 }); });
  assert.deepStrictEqual(s.get().desks, []);
  assert.strictEqual(fs.readFileSync(`${file}.corrupt-1234`, 'utf8'), '{ not json', 'the bytes are kept');
  assert.ok(s.createDesk({ id: 'A' }).ok);
  assert.deepStrictEqual(createDesksStore({ file, log: quiet }).get().desks.map(d => d.id), ['A']);

  // Valid JSON of the wrong shape is corrupt too.
  fs.writeFileSync(file, '[1,2,3]');
  const t = createDesksStore({ file, log: quiet, now: () => 99 });
  assert.deepStrictEqual(t.get().desks, []);
  assert.ok(fs.existsSync(`${file}.corrupt-99`));
});

test('a file listing a tab on two desks loads with it on the first only', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, desks: [
    { id: 'A', name: 'A', windows: [{ kind: 'cli', key: 'k' }, { kind: 'cli', key: 'bad', geom: 'x' }, { kind: '', key: 'drop' }] },
    { id: 'B', name: 'B', windows: [{ kind: 'cli', key: 'k' }] },
  ] }));
  const s = createDesksStore({ file, log: quiet });
  assert.deepStrictEqual(where(s, 'cli', 'k'), ['A']);
  assert.deepStrictEqual(s.get().desks[0].windows.map(w => w.key), ['k', 'bad'], 'a bad geometry gets a default, the entry stays');
});

test('handler: desks:state on connect, every change broadcast to all, refusals to the sender only', () => {
  const broadcasts = [];
  const bc = { broadcast: (m) => broadcasts.push(m) };
  const h = desksHandler.create(bc, { file: tmpFile() });
  const sent = [];
  const ws = { send: (s) => sent.push(JSON.parse(s)) };
  h.onConnect(ws);
  assert.deepStrictEqual(sent[0], { type: 'desks:state', state: { version: 1, desks: [] } });
  h.handleMessage(ws, { type: 'desks:create', id: 'A', name: 'Alpha' });
  h.handleMessage(ws, { type: 'desks:move', deskId: 'A', kind: 'cli', key: 'k' });
  assert.strictEqual(broadcasts.length, 2);
  assert.ok(broadcasts.every(m => m.type === 'desks:state'));
  assert.deepStrictEqual(broadcasts[1].state.desks[0].windows.map(w => w.key), ['k']);
  h.handleMessage(ws, { type: 'desks:move', deskId: 'nope', kind: 'cli', key: 'k' });
  assert.strictEqual(broadcasts.length, 2);
  assert.deepStrictEqual(sent[sent.length - 1], { type: 'desks:error', op: 'desks:move', error: 'no such desk' });
  h.handleMessage(ws, { type: 'desks:get' });
  assert.strictEqual(sent[sent.length - 1].type, 'desks:state');
  assert.deepStrictEqual(desksHandler.PREFIXES, ['desks:']);
});
