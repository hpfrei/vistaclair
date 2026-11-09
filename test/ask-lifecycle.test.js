// An AskUserQuestion form whose asking call ended (src/ask-lifecycle.js): the
// tool and the MCP bridge end their dashboard request when the call ends
// (real lib/mcp-bridge.js against a fake dashboard), every expiry path marks
// the form expired instead of live, and the owner's late answer goes to the
// session as one message, or is discarded. Run members' delivery (refresh,
// busy, not running) is in test/orchestration.test.js. Fakes only: nothing
// here spawns `claude` or talks to a running dashboard.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createAskLifecycle, lateText, LATE_RE } = require('../src/ask-lifecycle');
const { createOrchestration } = require('../src/orchestration');
const { waitFor } = require('./wait-for');

const CORE = path.join(__dirname, '..');
const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmpDir() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-ask-')));
  dirs.push(d);
  return d;
}

// --- The tool and the bridge: the call's end closes the dashboard request ---

// A fake /api/ask that never answers; the bridge runs the real integrated
// server. `end`: how the call ends (cancel: Claude Code's notifications/cancelled
// on an interrupt or its MCP tool timeout; stdin: the client process gone).
async function bridgeCall(end) {
  let closed = null;
  let arrived = null;
  const asked = new Promise(r => { arrived = r; });
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => arrived(JSON.parse(body)));
    res.on('close', () => { closed = Date.now(); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [path.join(CORE, 'lib', 'mcp-bridge.js'), 'integrated'], {
    env: { ...process.env, VISTACLAIR_DASHBOARD_PORT: String(srv.address().port), VISTACLAIR_DATA_HOME: '', VISTACLAIR_INSTANCE_ID: 'cli-x', NODE_NO_WARNINGS: '1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'vista-AskUserQuestion', arguments: { questions: [{ id: 'q', question: 'Ship?' }] } } });
    const body = await asked;
    assert.strictEqual(body.instanceId, 'cli-x');
    assert.strictEqual(closed, null, 'the ask waits');
    if (end === 'cancel') send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'interrupted' } });
    else child.stdin.end();
    await waitFor(() => closed !== null, { what: 'the ask request closed', timeoutMs: 5000 });
    if (end === 'stdin') await waitFor(() => exited, { what: 'the bridge exited', timeoutMs: 5000 });
    return { closed: closed !== null, exited };
  } finally {
    child.kill('SIGKILL');
    srv.close();
  }
}

test('bridge: a cancelled call (interrupt, MCP tool timeout) closes its /api/ask request', async () => {
  const r = await bridgeCall('cancel');
  assert.ok(r.closed);
});

test('bridge: its client gone (stdin closed), the bridge exits and the request closes', async () => {
  const r = await bridgeCall('stdin');
  assert.ok(r.closed && r.exited);
});

test('the reset copy of the ask tool ends its request on a cancel too', () => {
  for (const f of ['vista-ask-user-question.js', 'vista-ask-user-question.original.js']) {
    const src = fs.readFileSync(path.join(CORE, 'mcp-servers', 'integrated', 'tools', f), 'utf8');
    assert.match(src, /extra\?\.signal\?\.addEventListener\("abort", giveUp/, f);
  }
});

// --- The lifecycle, plain sessions ---

function fakeMgr() {
  const sessions = new Map();
  const submits = [];
  const mk = (tabId, sessId, { kind = 'cli', running = true } = {}) => ({
    tabId, sessId, instanceId: `cli-${sessId}`, kind, running, title: `T ${tabId}`, settings: {},
    getSettings() { return { ...this.settings }; },
    submit(text, opts) { submits.push({ tabId, text, opts }); },
  });
  return {
    sessions, submits,
    add(tabId, sessId, o) { const s = mk(tabId, sessId, o); sessions.set(tabId, s); return s; },
    get: (tabId) => sessions.get(tabId) || null,
    getByInstanceId(id) { for (const s of sessions.values()) if (s.instanceId === id) return s; return null; },
    getBySessId(id) { for (const s of sessions.values()) if (s.sessId === id) return s; return null; },
  };
}

function setup({ grace = 0 } = {}) {
  const mgr = fakeMgr();
  const pendingQuestions = new Map();
  const broadcasts = [];
  const broadcaster = { broadcast: (m) => broadcasts.push(m) };
  const dataHome = tmpDir();
  const orch = createOrchestration({ mgr: { ...mgr, sessions: mgr.sessions }, broadcaster, pendingQuestions, coreRoot: CORE, dataHome });
  const lc = createAskLifecycle({ pendingQuestions, broadcaster, mgr, orchestration: orch, dataHome, closeGraceMs: grace, sweepMs: 0 });
  const QUESTIONS = [{ id: 'db', header: 'Storage', question: 'Which database?', options: [{ label: 'Postgres', description: 'the default' }, { label: 'SQLite' }] }];
  // One /api/ask of `session`, as server.js does it.
  function ask(session, { toolUseId = 'toolu_1', agentId } = {}) {
    if (toolUseId) lc.onHook(session.instanceId, { hook_event_name: 'PreToolUse', tool_name: 'mcp__integrated__vista-AskUserQuestion', tool_use_id: toolUseId, ...(agentId ? { agent_id: agentId } : {}) });
    let askId;
    const p = orch.askUser({ questions: QUESTIONS, instanceId: session.instanceId, tabId: session.tabId, onPending: (id) => { askId = id; } });
    lc.track(askId, { instanceId: session.instanceId, tabId: session.tabId });
    const outcome = p.then(a => ({ answer: a }), e => ({ error: e }));
    return { askId, outcome };
  }
  const audit = () => { try { return fs.readFileSync(path.join(dataHome, 'data', 'late-answers.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };
  return { mgr, pendingQuestions, broadcasts, lc, orch, ask, audit, dataHome, QUESTIONS };
}

const ANSWER = [{ id: 'db', question: 'Which database?', answer: 'SQLite — the data is small' }];
const expiredOf = (broadcasts, askId) => broadcasts.find(m => m.type === 'ask:expired' && m.askId === askId);

test('live: an answer to a form whose call still waits resolves it exactly as before; nothing expires after', async () => {
  const { mgr, pendingQuestions, broadcasts, lc, ask } = setup();
  const s = mgr.add('tab-1', 's1');
  const { askId, outcome } = ask(s);
  assert.ok(broadcasts.find(m => m.type === 'ask:question' && m.askId === askId));
  pendingQuestions.get(askId).resolve(ANSWER);
  assert.deepStrictEqual((await outcome).answer, ANSWER);
  lc.settled(askId);
  // Its normal end follows: nothing left to expire.
  lc.onHook(s.instanceId, { hook_event_name: 'PostToolUse', tool_name: 'mcp__integrated__vista-AskUserQuestion', tool_use_id: 'toolu_1' });
  lc.onHook(s.instanceId, { hook_event_name: 'Stop' });
  assert.strictEqual(broadcasts.filter(m => m.type === 'ask:expired').length, 0);
  assert.strictEqual(lc.expired.size, 0);
});

test('expiry: the tool call interrupted (PostToolUseFailure of that tool_use_id) — kept, expired, waiter rejected', async () => {
  const { mgr, pendingQuestions, broadcasts, lc, ask, audit } = setup();
  const s = mgr.add('tab-1', 's1');
  const other = ask(s, { toolUseId: 'toolu_other' });
  const { askId, outcome } = ask(s, { toolUseId: 'toolu_1' });
  lc.onHook(s.instanceId, { hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__integrated__vista-AskUserQuestion', tool_use_id: 'toolu_1', is_interrupt: true });
  const ev = expiredOf(broadcasts, askId);
  assert.ok(ev, 'ask:expired broadcast');
  assert.strictEqual(ev.reason, 'tool call interrupted');
  assert.ok(!Number.isNaN(Date.parse(ev.at)));
  assert.ok(!pendingQuestions.has(askId), 'no longer live (an answer is refused, the auto-refresh is not held)');
  assert.ok(pendingQuestions.has(other.askId), 'another call of the session is untouched');
  assert.strictEqual((await outcome).error.expired, true);
  assert.deepStrictEqual(lc.expiredInfo(askId), { at: ev.at, reason: 'tool call interrupted' });
  // A reconnecting dashboard gets it back, marked.
  const replayed = [];
  lc.replay(m => replayed.push(m));
  assert.strictEqual(replayed.length, 1);
  assert.strictEqual(replayed[0].type, 'ask:question');
  assert.deepStrictEqual(replayed[0].expired, { at: ev.at, reason: 'tool call interrupted' });
  assert.deepStrictEqual(audit().map(r => [r.event, r.toolUseId]), [['expired', 'toolu_1']]);
});

test('expiry: the request closed (the tool gave up / its process ended); a precise reason within the grace wins', async () => {
  const a = setup();
  const s = a.mgr.add('tab-1', 's1');
  const { askId } = a.ask(s);
  a.lc.requestClosed(askId);
  assert.strictEqual(expiredOf(a.broadcasts, askId).reason, 'tool call interrupted, timed out or its process ended');

  const b = setup({ grace: 30 });
  const s2 = b.mgr.add('tab-1', 's2');
  const r = b.ask(s2);
  b.lc.requestClosed(r.askId);
  assert.ok(!b.pendingQuestions.has(r.askId), 'at once: an answer can no longer reach the call');
  b.lc.onSessionEnd('tab-1', s2, 'exit');
  const ev = b.broadcasts.filter(m => m.type === 'ask:expired');
  assert.deepStrictEqual(ev.map(m => m.reason), ['tool call interrupted, timed out or its process ended', 'session exited'], 'refined');
  assert.strictEqual(ev[0].at, ev[1].at, 'still expired when the request closed');
  assert.strictEqual(b.lc.expiredInfo(r.askId).reason, 'session exited');
  await new Promise(res => setTimeout(res, 60));
  b.lc.onHook(s2.instanceId, { hook_event_name: 'Stop' });
  assert.strictEqual(b.broadcasts.filter(m => m.type === 'ask:expired').length, 2, 'after the grace nothing changes it');
});

test('expiry: the turn ends (Stop) — the main thread\'s ask, not a background subagent\'s; that one at its SubagentStop', () => {
  const { mgr, broadcasts, lc, ask } = setup();
  const s = mgr.add('tab-1', 's1');
  const main = ask(s, { toolUseId: 'toolu_main' });
  const sub = ask(s, { toolUseId: 'toolu_sub', agentId: 'agent-7' });
  lc.onHook(s.instanceId, { hook_event_name: 'Stop' });
  assert.strictEqual(expiredOf(broadcasts, main.askId).reason, 'turn ended');
  assert.strictEqual(expiredOf(broadcasts, sub.askId), undefined);
  lc.onHook(s.instanceId, { hook_event_name: 'SubagentStop', agent_id: 'agent-7' });
  assert.strictEqual(expiredOf(broadcasts, sub.askId).reason, 'subagent ended');
});

test('expiry: session exit, close, restart, SessionEnd and the sweep backstop', () => {
  const { mgr, broadcasts, lc, ask } = setup();
  const reasonOf = (id) => expiredOf(broadcasts, id)?.reason;
  const s1 = mgr.add('tab-1', 's1');
  const a1 = ask(s1);
  lc.onSessionEnd('tab-1', s1, 'exit');
  assert.strictEqual(reasonOf(a1.askId), 'session exited');

  const s2 = mgr.add('tab-2', 's2');
  const a2 = ask(s2);
  lc.onSessionEnd('tab-2', s2, 'pause');
  assert.strictEqual(reasonOf(a2.askId), 'session paused');

  // Respawned in place (same instance): its SessionStart ends the old calls.
  const s3 = mgr.add('tab-3', 's3');
  const a3 = ask(s3);
  lc.onHook(s3.instanceId, { hook_event_name: 'SessionStart', source: 'compact' });
  assert.strictEqual(reasonOf(a3.askId), undefined, 'a compaction ends no call');
  lc.onHook(s3.instanceId, { hook_event_name: 'SessionStart', source: 'resume' });
  assert.strictEqual(reasonOf(a3.askId), 'session restarted');

  const s4 = mgr.add('tab-4', 's4');
  const a4 = ask(s4);
  lc.onHook(s4.instanceId, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  assert.strictEqual(reasonOf(a4.askId), 'session ended (prompt_input_exit)');

  const s5 = mgr.add('tab-5', 's5');
  const a5 = ask(s5);
  lc.sweep();
  assert.strictEqual(reasonOf(a5.askId), undefined, 'running: kept live');
  s5.running = false;
  lc.sweep();
  assert.strictEqual(reasonOf(a5.askId), 'session no longer running');
});

test('the late message: prefix, the note, the question and options verbatim, the answer, the times', () => {
  const entry = {
    askedAt: '2026-11-09T14:02:00', expiredAt: '2026-11-09T14:20:00', reason: 'tool call interrupted',
    questions: [{ id: 'db', header: 'Storage', question: 'Which database?', options: [{ label: 'Postgres', description: 'the default' }, { label: 'SQLite' }] }],
  };
  const text = lateText(entry, ANSWER, '2026-11-09T15:10:00');
  assert.match(text, LATE_RE);
  assert.ok(text.startsWith('Late answer to your question from 14:02:\n'), text);
  assert.ok(text.includes('Your question had already ended at 14:20 (tool call interrupted); you may have continued without this answer. Check whether it changes anything you did since, adjust if needed, and tell the owner.'));
  assert.ok(text.includes('Asked 2026-11-09 14:02 · expired 2026-11-09 14:20 · answered 2026-11-09 15:10.'));
  assert.ok(text.includes('1. [Storage] Which database?\n   Options:\n   - Postgres — the default\n   - SQLite'));
  assert.ok(text.includes('1. Which database?\n   → SQLite — the data is small'));
  assert.ok(!text.startsWith('['), 'owner text, not a notice');
});

test('send as message: an idle plain session gets one prompt; a busy SDK session takes it next; the form closes everywhere', async () => {
  const { mgr, broadcasts, lc, ask, audit } = setup();
  const s = mgr.add('tab-1', 's1');
  const { askId } = ask(s);
  lc.onSessionEnd('tab-1', s, 'exit');
  // The tab's session again (a restart): it is the current one.
  const again = mgr.add('tab-1', 's1');
  const r = lc.sendLate(askId, ANSWER);
  assert.deepStrictEqual({ ok: r.ok, how: r.how }, { ok: true, how: 'submitted' });
  assert.strictEqual(r.message, `Late answer sent to ${again.title}.`);
  assert.strictEqual(mgr.submits.length, 1);
  assert.match(mgr.submits[0].text, /^Late answer to your question from \d\d:\d\d:\n/);
  assert.match(mgr.submits[0].text, /\(session exited\)/);
  assert.ok(broadcasts.find(m => m.type === 'ask:closed' && m.askId === askId && m.how === 'sent'));
  assert.deepStrictEqual(lc.sendLate(askId, ANSWER), { ok: false, error: 'that question is no longer open' }, 'once');
  assert.deepStrictEqual(audit().map(x => x.event), ['expired', 'sent']);

  const sdk = mgr.add('tab-2', 's2', { kind: 'sdk' });
  sdk.busy = true;
  const b = ask(sdk);
  lc.onHook(sdk.instanceId, { hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__integrated__vista-AskUserQuestion', tool_use_id: 'toolu_1', is_interrupt: true });
  assert.strictEqual(lc.sendLate(b.askId, ANSWER).how, 'submitted');
  assert.deepStrictEqual(mgr.submits[1].opts, { priority: 'next', from: 'owner' }, 'read after its running tool calls');
});

test('send as message with no session running: queued, the owner told, submitted at its next start', () => {
  const { mgr, lc, ask, dataHome } = setup();
  const s = mgr.add('tab-1', 's1');
  const { askId } = ask(s);
  mgr.sessions.delete('tab-1');
  lc.onSessionEnd('tab-1', s, 'tab_close');
  const r = lc.sendLate(askId, ANSWER);
  assert.strictEqual(r.how, 'queued-not-running');
  assert.match(r.message, /^No session is running at T tab-1: the late answer is queued for its next start\.$/);
  assert.strictEqual(mgr.submits.length, 0);
  assert.ok(fs.existsSync(path.join(dataHome, 'data', 'late-answers-queue.json')));
  // Another tab starting takes nothing; the conversation resumed elsewhere does.
  const other = mgr.add('tab-9', 's9');
  lc.onHook(other.instanceId, { hook_event_name: 'SessionStart', source: 'startup' });
  assert.strictEqual(mgr.submits.length, 0);
  const back = mgr.add('tab-5', 's1');
  lc.onHook(back.instanceId, { hook_event_name: 'SessionStart', source: 'resume' });
  assert.strictEqual(mgr.submits.length, 1);
  assert.strictEqual(mgr.submits[0].tabId, 'tab-5');
  assert.match(mgr.submits[0].text, /^Late answer to your question/);
  assert.ok(!fs.existsSync(path.join(dataHome, 'data', 'late-answers-queue.json')), 'taken once');
});

test('discard: closes the form, recorded, nothing sent', () => {
  const { mgr, broadcasts, lc, ask, audit } = setup();
  const s = mgr.add('tab-1', 's1');
  const { askId } = ask(s);
  lc.onSessionEnd('tab-1', s, 'exit');
  const r = lc.discard(askId);
  assert.strictEqual(r.ok, true);
  assert.ok(broadcasts.find(m => m.type === 'ask:closed' && m.askId === askId && m.how === 'discarded'));
  assert.strictEqual(mgr.submits.length, 0);
  assert.deepStrictEqual(audit().map(x => x.event), ['expired', 'discarded']);
  assert.strictEqual(audit()[1].questions, 'Which database?');
  assert.strictEqual(lc.expired.size, 0);
  const replayed = [];
  lc.replay(m => replayed.push(m));
  assert.strictEqual(replayed.length, 0);
});

test('a tab killed or closed by the owner: its /api/ask form is left to expire at the session\'s end (it used to vanish silently)', () => {
  const proxy = require('../src/proxy');
  const pq = proxy.pendingQuestions;
  const rejected = [];
  pq.set('ask-api', { ctx: { tabId: 'tab-k' }, instanceId: 'cli-k', reject: () => rejected.push('ask-api') });
  pq.set('ask-other', { ctx: { tabId: 'tab-k' }, reject: () => rejected.push('ask-other') });
  try {
    proxy.clearPendingQuestionsForTab('tab-k');
    assert.deepStrictEqual(rejected, ['ask-other']);
    assert.ok(pq.has('ask-api'));
  } finally { pq.delete('ask-api'); pq.delete('ask-other'); }
});
