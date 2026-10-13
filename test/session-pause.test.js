// Pausing a plain CLI session (src/session-control.js): the hook replies that
// carry the pause to the session and its subagents, the launch denials, the
// Stop conditions (no subagents or background tasks, a fresh resume note), the
// quiet close and the resume. A fake manager stands in for the PTYs.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSessionControl, mergeReplies } = require('../src/session-control');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function setup() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-pause-'));
  dirs.push(folder);
  fs.writeFileSync(path.join(folder, 'TODO.md'), '| id | description | depends on | status |\n|--|--|--|--|\n');
  fs.writeFileSync(path.join(folder, 'NOTES.md'), '# Notes\n');
  const writes = [];
  const history = [];
  const closed = [];
  const broadcasts = [];
  const sessions = new Map();
  const mk = (tabId, sessId) => ({
    tabId, sessId, instanceId: `cli-${tabId}`, running: true, busy: false, cwd: folder, title: 'demo', settings: { sessionDir: folder },
    getSettings() { return { ...this.settings }; },
    updateSettings(s) { Object.assign(this.settings, s); },
    writeWhenReady(d) { writes.push({ tabId, d }); },
    write(d) { writes.push({ tabId, d }); },
  });
  let seq = 0;
  const mgr = {
    sessions,
    get: (id) => sessions.get(id) || null,
    getByInstanceId(id) { for (const s of sessions.values()) if (s.instanceId === id) return s; return null; },
    saveToHistory(e) { history.unshift({ id: e.sessId, cwd: e.cwd, settings: e.settings, ...(e.flags?.paused ? { paused: true } : {}), ...(e.flags?.interrupted ? { interrupted: true } : {}) }); },
    findSaved: (id) => history.find(h => h.id === id) || null,
    lost: new Set(),
    transcriptExists: (cwd, id) => !mgr.lost.has(id),
    forgetSaved(id) { const i = history.findIndex(h => h.id === id); if (i >= 0) history.splice(i, 1); },
    launchSession(tabId, o) {
      const s = mgr.getOrCreate(tabId);
      s.title = o.title; s.updateSettings(o.settings || {}); s.sessId = 'fresh-' + tabId; s.running = true; s.cwd = o.cwd;
      if (o.prompt) writes.push({ tabId, d: o.prompt });
    },
    closeQuiet(tabId) { sessions.get(tabId).running = false; sessions.delete(tabId); closed.push(tabId); },
    nextTabId: () => `tab-r-${++seq}`,
    getOrCreate(tabId) { if (!sessions.has(tabId)) sessions.set(tabId, mk(tabId, null)); return sessions.get(tabId); },
    spawn(tabId, cwd, c, r, { resumeSessionId }) { const s = sessions.get(tabId); s.sessId = resumeSessionId; s.running = true; },
    broadcastTabs() {},
  };
  const s = mk('tab-1', '11111111-1111-1111-1111-111111111111');
  sessions.set('tab-1', s);
  const control = createSessionControl({ mgr, broadcaster: { broadcast: m => broadcasts.push(m) }, finalizeDelayMs: 5, interruptSettleMs: 5 });
  const hook = (input) => control.reply(s.instanceId, input);
  const typed = () => writes.filter(w => w.tabId === 'tab-1').map(w => w.d).join('');
  const note = () => fs.writeFileSync(path.join(folder, 'NOTES.md'), '# Notes\n\n## Resume\n\nstep 2 is next\n');
  return { mgr, control, s, hook, typed, note, folder, history, closed, broadcasts, writes };
}

const ctx = (r) => JSON.parse(r.stdout || '{}').hookSpecificOutput?.additionalContext || '';
const block = (r) => { const o = JSON.parse(r.stdout || '{}'); return o.decision === 'block' ? o.reason : null; };

test('an idle session is typed the pause, then closes once its note is written', async () => {
  const { control, s, hook, typed, note, history, closed, broadcasts } = setup();
  control.pause('tab-1');
  assert.match(typed(), /\[vistaclair pause\][\s\S]*Never touch the app's own process or the vistaclair server/);
  assert.strictEqual(s.pausing, true);
  await wait(15);   // file mtimes come from a coarse clock
  hook({ hook_event_name: 'UserPromptSubmit' });
  assert.match(block(hook({ hook_event_name: 'Stop' })), /## Resume/, 'no note: asked once');
  assert.deepStrictEqual(closed, []);
  note();
  assert.deepStrictEqual(hook({ hook_event_name: 'Stop', stop_hook_active: true }), {});
  await wait(20);
  assert.deepStrictEqual(closed, ['tab-1']);
  assert.strictEqual(history[0].paused, true);
  assert.ok(broadcasts.some(b => b.type === 'cli:paused'));
});

test('a busy session hears it through hook context, its subagents too, and launches are denied', async () => {
  const { control, hook, typed } = setup();
  hook({ hook_event_name: 'UserPromptSubmit' });
  control.pause('tab-1');
  assert.strictEqual(typed(), '', 'busy: nothing typed');
  assert.match(ctx(hook({ hook_event_name: 'PostToolUse', tool_name: 'Read' })), /\[vistaclair pause\]/);
  assert.strictEqual(ctx(hook({ hook_event_name: 'PostToolUse', tool_name: 'Read' })), '', 'once per agent');
  assert.match(ctx(hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'a1' })), /return your result now/);
  assert.strictEqual(hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent' }).exitCode, 2);
  assert.strictEqual(hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__orchestrator__launch_cli' }).exitCode, 2);
  assert.deepStrictEqual(hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit' }), {});
});

test('running subagents or background tasks hold the pause; the session is asked to stop validation once', async () => {
  const { control, hook, note, closed } = setup();
  hook({ hook_event_name: 'UserPromptSubmit' });
  hook({ hook_event_name: 'SubagentStart', agent_id: 'a1' });
  control.pause('tab-1');
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Read' });
  await wait(15);
  note();
  assert.match(block(hook({ hook_event_name: 'Stop' })), /still running.*validation/s);
  assert.deepStrictEqual(hook({ hook_event_name: 'Stop', stop_hook_active: true }), {});
  hook({ hook_event_name: 'SubagentStop', agent_id: 'a1' });
  assert.deepStrictEqual(hook({ hook_event_name: 'Stop', background_tasks: [{ id: 'b' }] }), {});
  await wait(20);
  assert.deepStrictEqual(closed, [], 'a background task still runs');
  hook({ hook_event_name: 'Stop' });
  await wait(20);
  assert.deepStrictEqual(closed, ['tab-1']);
});

test('busy at pause with no tool call before stopping: the Stop delivers the text', () => {
  const { control, hook } = setup();
  hook({ hook_event_name: 'UserPromptSubmit' });
  control.pause('tab-1');
  assert.match(block(hook({ hook_event_name: 'Stop' })), /\[vistaclair pause\]/);
});

test('interrupt closes a pause that does not finish, as interrupted; resume tells it so', async () => {
  const { control, s, history, closed, mgr, writes } = setup();
  control.pause('tab-1');
  assert.throws(() => control.interrupt('tab-2'), /not pausing/);
  control.interrupt('tab-1');
  await wait(20);
  assert.deepStrictEqual(closed, ['tab-1']);
  assert.strictEqual(history[0].interrupted, true);
  const { tabId } = control.resumeSaved(s.sessId);
  assert.strictEqual(mgr.get(tabId).sessId, s.sessId);
  assert.match(writes.filter(w => w.tabId === tabId).map(w => w.d).join(''), /\[vistaclair resume\] This session was interrupted/);
  assert.throws(() => control.resumeSaved(s.sessId), /already running/);
});

test('a resume whose transcript is gone starts fresh in the same folder', async () => {
  const { control, s, note, hook, history, mgr, writes, folder } = setup();
  control.pause('tab-1');
  await wait(15);
  note();
  hook({ hook_event_name: 'Stop' });
  await wait(20);
  mgr.lost.add(s.sessId);
  assert.throws(() => control.resumeSaved(s.sessId, { fallback: false }), /transcript is gone/);
  const r = control.resumeSaved(s.sessId);
  assert.strictEqual(r.fresh, true);
  const fresh = mgr.get(r.tabId);
  assert.notStrictEqual(fresh.sessId, s.sessId);
  assert.strictEqual(fresh.settings.sessionDir, folder, 'same folder');
  assert.match(writes.filter(w => w.tabId === r.tabId).map(w => w.d).join(''), /could not be restored[\s\S]*## Resume/);
  assert.strictEqual(history.find(h => h.id === s.sessId), undefined, 'the lost entry leaves the list');
});

test('a TODO left untouched for 30 tool calls gets one reminder; liveOf shows the session', () => {
  const { control, hook, s, folder } = setup();
  hook({ hook_event_name: 'UserPromptSubmit' });
  hook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'a.js' } });
  let reminders = 0;
  for (let i = 0; i < 40; i++) if (/without a TODO\.md update/.test(ctx(hook({ hook_event_name: 'PostToolUse', tool_name: 'Read' })))) reminders++;
  assert.strictEqual(reminders, 1);
  const live = control.liveOf(s);
  assert.strictEqual(live.busy, true);
  assert.deepStrictEqual(live.edited, [path.join(folder, 'a.js')]);
  assert.strictEqual(live.recent.length, 5);
});

test('mergeReplies: a deny or block wins, contexts are joined', () => {
  const c = (t) => ({ stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: t } }) });
  assert.strictEqual(mergeReplies('PreToolUse', {}, { exitCode: 2, stderr: 'no' }).exitCode, 2);
  assert.strictEqual(JSON.parse(mergeReplies('Stop', c('x'), { stdout: '{"decision":"block","reason":"r"}' }).stdout).decision, 'block');
  assert.strictEqual(ctx(mergeReplies('PostToolUse', c('a'), c('b'))), 'a\n\nb');
  assert.deepStrictEqual(mergeReplies('PostToolUse', {}, {}), {});
});
