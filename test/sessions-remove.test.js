// The Sessions tab's removals through the real cli-handler and a real
// CliSessionManager on a throwaway data home: "Close and remove interaction"
// (cli:closeTab with forget) drops the saved-session record and pushes the new
// list to every client; a plain close, or a refused one, keeps it; the batch
// cli:deleteSavedSessions removes exactly the given ids.
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-sessrm-')));
process.env.VISTACLAIR_HOME = HOME;
process.env.HOME = HOME;
process.env.VISTACLAIR_DASHBOARD_PORT = '';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const CliSessionManager = require('../src/cli-sessions');
const { handleMessage } = require('../src/ws/cli-handler');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

function setup(ids, { closeCheck, deleteRun, orchestration } = {}) {
  const broadcasts = [];
  const mgr = new CliSessionManager(1, { broadcast: (m) => broadcasts.push(m) }, { deleteSessionData() {} });
  const cwd = path.join(HOME, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  for (const h of mgr.listSaved()) mgr.forgetSaved(h.id);   // one history file per process
  for (const id of ids) mgr.saveToHistory({ sessId: id, cwd, title: `t-${id}`, settings: {} });
  const sent = [];
  const ws = { readyState: WebSocket.OPEN, send: (d) => sent.push(JSON.parse(d)) };
  const bc = { cliSessionManager: mgr, broadcast: (m) => broadcasts.push(m), orchestration: orchestration || (closeCheck || deleteRun ? { closeCheck, deleteRun } : undefined) };
  const call = (msg) => handleMessage(ws, msg, bc);
  const listed = () => mgr.listSaved().map(h => h.id).sort();
  // An open tab of a saved session.
  const openTab = (tabId, sessId, settings = {}) => {
    mgr.sessions.set(tabId, {
      sessId, cwd, title: `t-${sessId}`, running: true, getSettings: () => settings, kill() {},
      instanceId: `cli-${tabId}`,
    });
  };
  return { mgr, call, listed, openTab, sent, broadcasts };
}

test('close with forget removes the saved session and pushes the list', () => {
  const t = setup(['a', 'b']);
  t.openTab('tab-1', 'a');
  t.call({ type: 'cli:closeTab', tabId: 'tab-1', forget: true });
  assert.deepStrictEqual(t.listed(), ['b']);
  const push = t.broadcasts.filter(m => m.type === 'cli:savedSessions').pop();
  assert.ok(push, 'every client gets the refreshed list');
  assert.deepStrictEqual(push.sessions.map(s => s.id), ['b']);
});

// "Close and remove interaction" is the Sessions tab row's delete: a worker's
// run record is told (noteMemberDeleted: its run card drops it), an unfinished
// or dirty worker and an orchestrator are refused as the row refuses them.
test('close with forget on a worker goes through the row delete: the run is told', () => {
  const noted = [];
  const orchestration = { closeCheck: () => ({ ok: true }), memberDirty: () => [], noteMemberDeleted: (e, o) => noted.push([e.id, o]) };
  const t = setup(['w1', 'b'], { orchestration });
  t.openTab('tab-1', 'w1', { orchestration: { role: 'worker', runId: 'r1', workerId: 'x' } });
  t.call({ type: 'cli:closeTab', tabId: 'tab-1', forget: true });
  assert.deepStrictEqual(t.listed(), ['b']);
  assert.deepStrictEqual(noted.map(n => n[0]), ['w1'], 'the run record learns the worker is deleted');
  assert.deepStrictEqual(t.broadcasts.filter(m => m.type === 'cli:savedSessions').pop().sessions.map(s => s.id), ['b']);
});

test('close with forget on a worker with a dirty worktree keeps it and asks, like the row', () => {
  const orchestration = { closeCheck: () => ({ ok: true }), memberDirty: () => [{ path: '/w' }], noteMemberDeleted() { throw new Error('must not run'); } };
  const t = setup(['w1'], { orchestration });
  t.openTab('tab-1', 'w1', { orchestration: { role: 'worker', runId: 'r1', workerId: 'x' } });
  t.call({ type: 'cli:closeTab', tabId: 'tab-1', forget: true });
  assert.deepStrictEqual(t.listed(), ['w1']);
  const ask = t.sent.find(m => m.type === 'cli:deleteRefused');
  assert.strictEqual(ask?.sessionId, 'w1');
  assert.match(ask.reason, /uncommitted/);
});

test('close with forget on an orchestrator is refused like the row (its run is deleted as a run)', () => {
  const orchestration = { closeCheck: () => ({ ok: true }) };
  const t = setup(['o'], { orchestration });
  t.openTab('tab-1', 'o', { orchestration: { role: 'orchestrator', runId: 'r1' } });
  t.call({ type: 'cli:closeTab', tabId: 'tab-1', forget: true });
  assert.deepStrictEqual(t.listed(), ['o']);
  assert.match(t.sent.find(m => m.type === 'cli:actionResult')?.error || '', /Delete run/);
});

test('close without forget keeps the saved session', () => {
  const t = setup(['a', 'b']);
  t.openTab('tab-1', 'a');
  t.call({ type: 'cli:closeTab', tabId: 'tab-1', forget: false });
  assert.deepStrictEqual(t.listed(), ['a', 'b']);
});

test('a refused close removes nothing', () => {
  const t = setup(['a', 'b'], { closeCheck: () => ({ ok: false, reason: 'busy', canForce: true }) });
  t.openTab('tab-1', 'a');
  t.call({ type: 'cli:closeTab', tabId: 'tab-1', forget: true });
  assert.deepStrictEqual(t.listed(), ['a', 'b']);
  assert.ok(t.mgr.sessions.has('tab-1'));
  assert.strictEqual(t.sent.find(m => m.type === 'cli:closeRefused')?.forget, true);
});

test('the batch delete removes exactly the given ids and answers one list', () => {
  const t = setup(['a', 'b', 'c', 'd']);
  t.call({ type: 'cli:deleteSavedSessions', ids: ['a', 'c', 'nope'] });
  assert.deepStrictEqual(t.listed(), ['b', 'd']);
  const answers = t.sent.filter(m => m.type === 'cli:savedSessions');
  assert.strictEqual(answers.length, 1);
  assert.deepStrictEqual(answers[0].sessions.map(s => s.id).sort(), ['b', 'd']);
  assert.strictEqual(answers[0].deleted, 2);
  assert.strictEqual(answers[0].skipped, 1);
});

test('the batch skips a running session and an orchestrator, and counts them', () => {
  const t = setup(['a', 'b', 'o']);
  t.mgr.patchSavedSettings('o', () => ({ orchestration: { role: 'orchestrator', runId: 'r1' } }));
  t.openTab('tab-1', 'a');
  t.call({ type: 'cli:deleteSavedSessions', ids: ['a', 'b', 'o'] });
  assert.deepStrictEqual(t.listed(), ['a', 'o']);
  const ans = t.sent.find(m => m.type === 'cli:savedSessions');
  assert.strictEqual(ans.deleted, 1);
  assert.strictEqual(ans.skipped, 2);
});

test('the batch deletes run ids through orchestration.deleteRun, unforced; a refused run is skipped', () => {
  const calls = [];
  const t = setup(['a'], { deleteRun: (runId, opts) => { calls.push([runId, opts]); return runId === 'busy' ? { refused: true, busy: [{}], dirty: [] } : { deleted: 2 }; } });
  t.call({ type: 'cli:deleteSavedSessions', ids: ['a'], runIds: ['r1', 'busy', 'r1'] });
  assert.deepStrictEqual(calls, [['r1', { force: false }], ['busy', { force: false }]]);
  const ans = t.sent.find(m => m.type === 'cli:savedSessions');
  assert.strictEqual(ans.deleted, 2);
  assert.strictEqual(ans.skipped, 1);
  assert.deepStrictEqual(t.listed(), []);
});

test('the batch ends with one cli:deleteSavedSessionsDone, after the list: ok and the counts', () => {
  const t = setup(['a', 'b']);
  t.call({ type: 'cli:deleteSavedSessions', ids: ['a', 'nope'] });
  const types = t.sent.map(m => m.type);
  assert.deepStrictEqual(types.filter(x => x === 'cli:deleteSavedSessionsDone').length, 1);
  assert.ok(types.indexOf('cli:savedSessions') < types.indexOf('cli:deleteSavedSessionsDone'));
  const done = t.sent.find(m => m.type === 'cli:deleteSavedSessionsDone');
  assert.deepStrictEqual({ ok: done.ok, deleted: done.deleted, skipped: done.skipped, error: done.error }, { ok: true, deleted: 1, skipped: 1, error: undefined });
});

test('a failing delete still answers Done, with ok false and the error', () => {
  const t = setup(['a']);
  t.mgr.deleteSavedSession = () => { throw new Error('disk gone'); };
  t.call({ type: 'cli:deleteSavedSessions', ids: ['a'] });
  const done = t.sent.find(m => m.type === 'cli:deleteSavedSessionsDone');
  assert.ok(done, 'Done is sent on an error too');
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.error, 'disk gone');
});
