// Orchestration runs continued on Telegram (platform-tg-runs.js).
//
// What must hold: a binding is the run, never a tab (a resume or a refresh
// moves the orchestrator to another tab); plain chat text never reaches a run;
// only a simple question gets answer buttons, and a question answered anywhere
// else stops looking answerable; the card's message id survives a restart, so
// the same message keeps being edited and nothing is pushed twice; the
// dashboard's handoff routes are the owner's alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const telegram = require('../src/apps/telegram');
const tgSession = require('../src/apps/platform-tg-session');
const tgRuns = require('../src/apps/platform-tg-runs');

const CHAT = 4242;
telegram.getPublicUrl = () => 'https://vc.test';

// --- Fakes ------------------------------------------------------------------

function fakeSession(runId, role = 'orchestrator', name = `orch-${runId}`) {
  return {
    running: true, submits: [], interrupts: 0,
    submit(text) { this.submits.push(text); },
    interrupt() { this.interrupts++; },
    getSettings() { return { name, orchestration: { runId, role } }; },
  };
}

// A world: one run R1 with its orchestrator on tab-A, Telegram recorded.
function world({ runsOptions = {} } = {}) {
  const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tgruns-'));
  const sessions = new Map([['tab-A', fakeSession('r1')]]);
  const run = {
    runId: 'r1', orchestrator: 'orch-r1', engine: 'sdk', closed: false,
    notes: path.join(appsDir, 'orch-r1', 'NOTES.md'),
    pausing: null, paused: null, orchestratorRunning: true, orchestratorTabId: 'tab-A',
    orchestratorSessId: 's-1', orchestratorState: 'busy', pendingEvents: 0,
    workers: [], // no `events`: core's describeRun has none (set one to test the seq path)
  };
  const orchestration = {
    calls: [],
    listRuns: () => [{ runId: 'r1', name: 'orch-r1', title: 'Telegram runs', engine: 'sdk', state: run.orchestratorState, busy: true, paused: !!run.paused, pausing: !!run.pausing, orchestratorTabId: run.orchestratorTabId, workerCount: run.workers.length, updatedAt: 1 }],
    describeRun: (id) => (id === 'r1' ? JSON.parse(JSON.stringify(run)) : null),
    pauseRun: (id) => { orchestration.calls.push(['pause', id]); return { pausing: true }; },
    resumeRun: (id) => { orchestration.calls.push(['resume', id]); return { resumed: true }; },
    refreshOrchestrator: (id) => { orchestration.calls.push(['refresh', id]); return { refreshing: true }; },
  };
  const sent = [];
  let nextId = 100;
  const tgCall = async (method, params) => {
    sent.push({ method, params });
    return method === 'sendMessage' ? { ok: true, result: { message_id: ++nextId } } : { ok: true, result: true };
  };
  const listeners = [];
  const broadcasts = [];
  const broadcaster = {
    broadcast: (m) => { broadcasts.push(m); for (const l of listeners) l(m); },
    onBroadcast: (fn) => listeners.push(fn),
  };
  const statePath = path.join(appsDir, '.tg-sessions.enc');
  const secretStore = {
    readSecretFile: (p, _d, { fallback }) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } },
    writeSecretFile: (p, obj) => fs.writeFileSync(p, JSON.stringify(obj)),
  };
  const pendingQuestions = new Map();
  const w = {
    appsDir, sessions, run, orchestration, sent, broadcasts, broadcaster, pendingQuestions, statePath,
    owner: true, controlChat: CHAT,
    init() {
      listeners.length = 0;
      tgSession.init({
        cliSessionManager: { sessions, get: (t) => sessions.get(t) },
        store: { getAll: () => [], loadSessionIntoMemory: () => [] },
        secretStore, broadcaster, appsDir, proDir: appsDir, pendingQuestions,
        clearPendingQuestionsForTab: () => {}, orchestration,
        isOwnerRequest: () => w.owner, controlChatId: () => w.controlChat,
        runsOptions: { tgCall, cardEditMs: 0, settleMs: 0, refreshDebounceMs: 0, sweepMs: 0, ...runsOptions },
      });
    },
    saved: () => JSON.parse(fs.readFileSync(statePath, 'utf8')),
    ask(askId, tabId, questions) {
      const entry = { formData: { questions }, questions, ctx: { tabId }, answers: [], resolve(a) { entry.answers.push(a); pendingQuestions.delete(askId); } };
      pendingQuestions.set(askId, entry);
      broadcaster.broadcast({ type: 'ask:question', askId, tabId, forms: [{ toolUseId: askId, formData: entry.formData, questions }] });
      return entry;
    },
    // A slave's ask as peer-remote-master.js relays it.
    remoteAsk(askId, tabId, questions, host, sessionTitle) {
      const remote = { peer: host, tabId, sessionTitle };
      const entry = { formData: { questions }, questions, ctx: { tabId }, host, remote, answers: [], resolve(a) { entry.answers.push(a); pendingQuestions.delete(askId); } };
      pendingQuestions.set(askId, entry);
      broadcaster.broadcast({ type: 'ask:question', askId, tabId, host, remote, forms: [{ toolUseId: askId, formData: entry.formData, questions }] });
      return entry;
    },
  };
  w.init();
  return w;
}

const settle = () => new Promise((r) => setTimeout(r, 20)).then(() => tgRuns._settled());

// --- Binding follows the run ------------------------------------------------

test('a run binding follows the run to its current orchestrator tab', async () => {
  const w = world();
  await tgRuns.bind(CHAT, 'r1');
  assert.equal(w.saved().runs.r1.chatId, CHAT);
  assert.equal(w.saved().runs.r1.name, 'orch-r1');
  assert.equal('tabId' in w.saved().runs.r1, false, 'a run binding stores no tab');

  await tgRuns.send(CHAT, 'r1', 'first');
  assert.deepEqual(w.sessions.get('tab-A').submits, ['first']);

  // A resume / refresh: the old tab is gone, the run names the new one.
  w.sessions.get('tab-A').running = false;
  w.sessions.set('tab-B', fakeSession('r1'));
  w.run.orchestratorTabId = 'tab-B';
  await tgRuns.send(CHAT, 'r1', 'second');
  assert.deepEqual(w.sessions.get('tab-B').submits, ['second']);
  assert.deepEqual(w.sessions.get('tab-A').submits, ['first']);

  await tgRuns.interrupt('r1');
  assert.equal(w.sessions.get('tab-B').interrupts, 1);
  await settle();
});

test('an app-change binding resolves its run\'s current orchestrator by stamp', async () => {
  const w = world();
  fs.writeFileSync(w.statePath, JSON.stringify({ sessions: { [CHAT]: { tabId: 'app-x', target: { type: 'app', name: 'x' }, runId: 'r1', startedAt: 1 } }, runs: {} }));
  w.init();
  w.sessions.set('tab-C', fakeSession('r1'));
  w.sessions.get('tab-A').running = false;
  tgSession.sendTurn(CHAT, 'hello');
  assert.deepEqual(w.sessions.get('tab-C').submits, ['hello']);
  await settle();
});

test('sending is refused while the run is pausing or paused', async () => {
  const w = world();
  w.run.pausing = { at: 'x' };
  await assert.rejects(tgRuns.send(CHAT, 'r1', 'hi'), /pausing/);
  w.run.pausing = null;
  w.run.paused = { at: 'x' };
  w.run.orchestratorRunning = false;
  await assert.rejects(tgRuns.send(CHAT, 'r1', 'hi'), /paused — resume/);
  assert.deepEqual(w.sessions.get('tab-A').submits, []);
  await settle();
});

// --- No chat relay ----------------------------------------------------------

test('plain chat text goes to Horst, never to a bound run', async () => {
  const w = world();
  await tgRuns.bind(CHAT, 'r1');
  await settle();

  const platformHorst = require('../src/apps/platform-horst');
  const orig = { reg: telegram.registerUpdateHandler, hasBot: telegram.hasBot, getBot: telegram.getBot, isAllowed: telegram.isAllowed, isOwnerAct: telegram.isOwnerAct, call: telegram.call, chat: platformHorst.chatFromTelegram, reply: platformHorst.sendTurnReply };
  let handler = null;
  const toHorst = [];
  telegram.registerUpdateHandler = (_k, h) => { handler = h; };
  telegram.hasBot = () => false;
  telegram.getBot = () => ({ restricted: true });
  telegram.isAllowed = () => true;
  telegram.isOwnerAct = (_k, chat, from) => chat?.type === 'private' && chat.id === CHAT && from?.id === CHAT;
  telegram.call = async () => ({ ok: true, result: {} });
  platformHorst.chatFromTelegram = async (chatId, text) => { toHorst.push(text); return { text: 'ok', pendingDirectives: [] }; };
  platformHorst.sendTurnReply = async () => {};
  try {
    require('../src/apps/platform-telegram').init('tok', {});
    await handler({ message: { chat: { id: CHAT, type: 'private' }, from: { id: CHAT }, text: 'how is it going?' } });
    assert.deepEqual(toHorst, ['how is it going?']);
    assert.deepEqual(w.sessions.get('tab-A').submits, []);
  } finally {
    telegram.registerUpdateHandler = orig.reg; telegram.hasBot = orig.hasBot; telegram.getBot = orig.getBot;
    telegram.isAllowed = orig.isAllowed; telegram.isOwnerAct = orig.isOwnerAct; telegram.call = orig.call;
    platformHorst.chatFromTelegram = orig.chat; platformHorst.sendTurnReply = orig.reply;
  }
});

// --- Questions --------------------------------------------------------------

test('only one select (≤ 8 options), confirm or toggle question gets buttons', () => {
  const opts = (n) => Array.from({ length: n }, (_, i) => ({ label: `o${i}` }));
  assert.equal(tgRuns.inlineOptions('a1', [{ id: 'q', type: 'select', options: opts(3) }]).length, 3);
  assert.equal(tgRuns.inlineOptions('a1', [{ id: 'q', type: 'select', options: opts(8) }]).length, 8);
  assert.equal(tgRuns.inlineOptions('a1', [{ id: 'q', type: 'select', options: opts(9) }]), null);
  assert.equal(tgRuns.inlineOptions('a1', [{ id: 'q', type: 'select', options: opts(2) }, { id: 'r', type: 'confirm' }]), null);
  assert.equal(tgRuns.inlineOptions('a1', [{ id: 'q', type: 'text' }]), null);
  assert.equal(tgRuns.inlineOptions('a1', [{ id: 'q', type: 'multiselect', options: opts(2) }]), null);
  assert.deepEqual(tgRuns.inlineOptions('a1', [{ id: 'q', type: 'confirm' }]).map((o) => o.value), [true, false]);
  assert.deepEqual(tgRuns.inlineOptions('a1', [{ id: 'q', type: 'toggle' }]).map((o) => o.value), [true, false]);
  // callback_data must fit 64 bytes
  assert.equal(tgRuns.inlineOptions('x'.repeat(60), [{ id: 'q', type: 'confirm' }]), null);
  for (const o of tgRuns.inlineOptions('ask-1792937017925-12', [{ id: 'q', type: 'select', options: opts(8) }])) {
    assert.ok(Buffer.byteLength(o.data) <= 64);
  }
});

test('a simple question is answered by a button; first answer wins', async () => {
  const w = world();
  await tgRuns.bind(CHAT, 'r1');
  await settle();
  w.sent.length = 0;
  const q = [{ id: 'target', type: 'select', question: 'Where to?', options: [{ label: 'staging' }, { label: 'prod' }] }];
  const entry = w.ask('ask-1-1', 'tab-A', q);
  await settle();
  const msg = w.sent.find((s) => s.method === 'sendMessage' && /Where to\?/.test(s.params.text));
  assert.ok(msg, 'question pushed');
  const buttons = msg.params.reply_markup.inline_keyboard.flat();
  assert.deepEqual(buttons.filter((b) => b.callback_data).map((b) => b.callback_data), ['vq:ask-1-1:0', 'vq:ask-1-1:1']);
  assert.ok(buttons.some((b) => b.web_app && /\?run=r1$/.test(b.web_app.url)), 'an Open button to the run');

  await tgRuns.handleCallback(CHAT, 'vq:ask-1-1:1', { message_id: 1 });
  assert.deepEqual(entry.answers, [[{ id: 'target', question: 'Where to?', answer: 'prod' }]]);
  assert.ok(w.broadcasts.some((b) => b.type === 'ask:answered' && b.askId === 'ask-1-1'));
  const closed = w.sent.find((s) => s.method === 'editMessageText' && /Answered: prod/.test(s.params.text));
  assert.ok(closed && !closed.params.reply_markup, 'closed without buttons');

  await tgRuns.handleCallback(CHAT, 'vq:ask-1-1:0', { message_id: 1 });
  assert.equal(entry.answers.length, 1, 'a second tap answers nothing');
  await settle();
});

test('a question answered elsewhere says so and drops its buttons', async () => {
  const w = world();
  await tgRuns.bind(CHAT, 'r1');
  await settle();
  w.ask('ask-2-1', 'tab-A', [{ id: 'ok', type: 'confirm', question: 'Ship it?' }]);
  await settle();
  const posted = w.sent.find((s) => s.method === 'sendMessage' && /Ship it\?/.test(s.params.text));
  const messageId = 100 + w.sent.filter((s) => s.method === 'sendMessage').indexOf(posted) + 1;
  // The dashboard answers.
  w.pendingQuestions.delete('ask-2-1');
  w.broadcaster.broadcast({ type: 'ask:answered', askId: 'ask-2-1' });
  await settle();
  const edit = w.sent.find((s) => s.method === 'editMessageText' && s.params.message_id === messageId);
  assert.ok(edit, 'the question message is edited');
  assert.match(edit.params.text, /Answered elsewhere/);
  assert.equal(edit.params.reply_markup, undefined);
  assert.deepEqual(w.saved().runs.r1.asks, {});
});

test('a complex question points at the Mini App', async () => {
  const w = world();
  await tgRuns.bind(CHAT, 'r1');
  await settle();
  w.ask('ask-3-1', 'tab-A', [{ id: 'a', type: 'text', question: 'Name?' }, { id: 'b', type: 'confirm', question: 'Sure?' }]);
  await settle();
  const msg = w.sent.find((s) => s.method === 'sendMessage' && /answer in the Mini App/.test(s.params.text));
  assert.ok(msg);
  assert.deepEqual(msg.params.reply_markup.inline_keyboard.flat().filter((b) => b.callback_data), []);
});

// --- Card and pushes --------------------------------------------------------

test('the card is one message, kept across a restart; pushes only for what matters', async () => {
  const w = world();
  await tgRuns.bind(CHAT, 'r1');
  await settle();
  const cardSends = w.sent.filter((s) => s.method === 'sendMessage' && /^💻 Telegram runs/.test(s.params.text));
  assert.equal(cardSends.length, 1);
  const cardId = w.saved().runs.r1.cardId;
  assert.ok(cardId);
  const markup = cardSends[0].params.reply_markup.inline_keyboard.flat();
  assert.ok(markup.some((b) => b.callback_data === 'vr:p:r1'));
  assert.ok(markup.some((b) => b.callback_data === 'vr:x:r1'));
  assert.ok(markup.every((b) => !b.callback_data || Buffer.byteLength(b.callback_data) <= 64));

  // A landing only edits the card; a not-landed is pushed.
  w.sent.length = 0;
  w.run.workers = [{ id: 'w1', name: 'w1', title: 'API', running: false, state: 'exited', lastReport: { status: 'done' } }];
  w.run.events = [{ seq: 1, at: 'x', worker: 'w1', kind: 'landed', text: 'landed abc' }];
  w.broadcaster.broadcast({ type: 'orchestration:run', runId: 'r1' });
  await settle();
  assert.equal(w.sent.filter((s) => s.method === 'sendMessage').length, 0);
  const edit = w.sent.find((s) => s.method === 'editMessageText' && s.params.message_id === cardId);
  assert.match(edit.params.text, /✅ w1 — API: landed/);

  w.sent.length = 0;
  w.run.events.push({ seq: 2, at: 'y', worker: 'w1', kind: 'not landed', text: 'w1 not landed: check failed' });
  w.broadcaster.broadcast({ type: 'orchestration:run', runId: 'r1' });
  await settle();
  assert.equal(w.sent.filter((s) => s.method === 'sendMessage' && /not landed/.test(s.params.text)).length, 1);

  // Truly idle → one push.
  w.sent.length = 0;
  w.run.orchestratorState = 'idle';
  w.broadcaster.broadcast({ type: 'sdk:event', runId: 'r1', sessId: 's-1', ev: { platform: { kind: 'status', state: 'idle' } } });
  await settle();
  assert.equal(w.sent.filter((s) => s.method === 'sendMessage' && /is idle/.test(s.params.text)).length, 1);

  // Restart: the same card is edited, nothing is sent again.
  w.sent.length = 0;
  w.init();
  await settle();
  assert.equal(w.sent.filter((s) => s.method === 'sendMessage').length, 0);
  assert.ok(w.sent.some((s) => s.method === 'editMessageText' && s.params.message_id === cardId));
  assert.equal(w.saved().runs.r1.cardId, cardId);
  assert.equal(fs.existsSync(`${w.statePath}.tmp`), false, 'state written atomically');
});

test('without events in describeRun, a failed or blocked last report is pushed once', async () => {
  const w = world();
  w.run.workers = [{ id: 'w1', name: 'w1', title: 'API', running: false, state: 'exited', lastReport: { status: 'done', summary: 'ok', at: '2026-10-25T10:00:00.000Z' } }];
  await tgRuns.bind(CHAT, 'r1');
  await settle();
  w.sent.length = 0;
  w.run.workers[0].lastReport = { status: 'blocked', summary: 'needs a key', at: '2026-10-25T10:05:00.000Z' };
  w.broadcaster.broadcast({ type: 'orchestration:run', runId: 'r1' });
  await settle();
  w.broadcaster.broadcast({ type: 'orchestration:run', runId: 'r1' });
  await settle();
  const pushes = w.sent.filter((s) => s.method === 'sendMessage');
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].params.text, /w1 reported blocked: needs a key/);
  const card = w.sent.filter((s) => s.method === 'editMessageText').pop();
  assert.match(card.params.text, /⛔ w1 — API: blocked/);
});

test('disconnect drops the binding and tells the dashboard', async () => {
  const w = world();
  await tgRuns.bind(CHAT, 'r1');
  await tgRuns.handleCallback(CHAT, 'vr:x:r1');
  await settle();
  assert.equal(w.saved().runs.r1, undefined);
  assert.deepEqual(w.broadcasts.filter((b) => b.type === 'tg:binding').map((b) => [b.runId, b.name, b.bound]), [['r1', 'orch-r1', true], ['r1', 'orch-r1', false]]);
});

// --- Transcript -------------------------------------------------------------

test('the transcript is read incrementally after its cursor', async () => {
  const transcript = require('../src/apps/tg-run-transcript');
  transcript._reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tgtr-'));
  const file = path.join(dir, 'transcript.jsonl');
  const line = (ev, ts = 1) => `${JSON.stringify({ sessId: 's', ts, ev })}\n`;
  const assistant = (content, parent = null) => ({ sdk: { type: 'assistant', parent_tool_use_id: parent, message: { content } } });
  fs.writeFileSync(file, [
    line({ user: { id: 'u1', text: 'go', pending: true } }),
    line({ user: { id: 'u1', text: 'go' } }),
    line(assistant([{ type: 'text', text: 'On it.' }])),
    line(assistant([{ type: 'tool_use', name: 'Read' }])),
    line(assistant([{ type: 'tool_use', name: 'Bash' }], 'toolu_sub')), // a subagent's: dropped
    line({ platform: { kind: 'status', state: 'busy' } }),
  ].join(''));
  const source = { kind: 'sdk', file, orchestrator: 'orch-r1' };

  const first = transcript.read(source, null);
  assert.equal(first.reset, true);
  assert.deepEqual(first.transcript.map((e) => [e.role, e.text]), [['user', 'go'], ['assistant', 'On it.'], ['tools', '🔧 1 tool: Read']]);
  assert.equal(first.transcript[2].open, true, 'a turn still calling tools');

  fs.appendFileSync(file, [
    line(assistant([{ type: 'tool_use', name: 'Edit' }, { type: 'tool_use', name: 'Read' }])),
    line(assistant([{ type: 'text', text: 'Done.' }])),
    line({ platform: { kind: 'message', from: 'w1', to: 'orch-r1', text: 'hi boss' } }),
  ].join('') + '{"partial":');
  const second = transcript.read(source, first.cursor);
  assert.equal(second.reset, false);
  assert.deepEqual(second.transcript.map((e) => [e.id, e.role, e.text]), [
    ['2', 'tools', '🔧 3 tools: Read, Edit'], ['3', 'assistant', 'Done.'], ['4', 'user', 'hi boss'],
  ]);
  assert.equal(second.transcript[0].toolCount, 3);
  assert.equal(second.transcript[2].from, 'w1');

  const third = transcript.read(source, second.cursor);
  assert.deepEqual(third.transcript, []);
  assert.equal(third.reset, false);

  // Another source's cursor, or one from the future: start over.
  assert.equal(transcript.read(source, 'deadbeef.2').reset, true);
  assert.equal(transcript.read(source, `${second.cursor.split('.')[0]}.99`).reset, true);
});

test('a CLI run\'s transcript comes from the store, cached per session', () => {
  const transcript = require('../src/apps/tg-run-transcript');
  transcript._reset();
  const list = [
    { id: 'i1', timestamp: 1, request: { messages: [{ role: 'user', content: 'start' }] }, response: { body: { content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Grep' }] } } },
    { id: 'h1', timestamp: 2, isHook: true, request: { messages: [{ role: 'user', content: 'hook' }] } },
  ];
  let loads = 0;
  const store = { loadSessionIntoMemory: () => { loads++; return list; } };
  const a = transcript.read({ kind: 'cli', store, sessId: 'S' }, null);
  assert.deepEqual(a.transcript.map((e) => e.role), ['user', 'assistant', 'tools']);
  list.push({ id: 'i2', timestamp: 3, request: { messages: [{ role: 'user', content: [{ type: 'tool_result' }] }] }, response: { body: { content: [{ type: 'text', text: 'found it' }] } } });
  const b = transcript.read({ kind: 'cli', store, sessId: 'S' }, a.cursor);
  assert.deepEqual(b.transcript.map((e) => [e.role, e.text]), [['tools', '🔧 1 tool: Grep'], ['assistant', 'found it']]);
  assert.equal(loads, 2);
});

test('the Mini App run view carries the shapes the client builds against', async () => {
  const w = world();
  w.run.workers = [{ id: 'w1', name: 'w1', title: 'API', running: true, state: 'busy', lastReport: null, progress: { done: 1, total: 3 } }];
  w.run.events = [{ seq: 3, at: 'z', worker: 'w1', kind: 'report', text: 'w1 reported update: x' }];
  w.ask('ask-9-1', 'tab-A', [{ id: 'q', type: 'confirm', question: 'Go?' }]);
  const d = await tgRuns.runDetail('r1', null, CHAT);
  assert.deepEqual(Object.keys(d).sort(), ['bound', 'busy', 'cursor', 'engine', 'events', 'name', 'pausing', 'paused', 'pendingQuestions', 'reset', 'runId', 'state', 'title', 'transcript', 'workers'].sort());
  assert.deepEqual(d.workers[0], { workerId: 'w1', name: 'w1', title: 'API', state: 'busy', lastReport: null, progress: { done: 1, total: 3 } });
  assert.deepEqual(d.pendingQuestions.map((q) => q.askId), ['ask-9-1']);
  assert.equal(d.events[0].seq, 3);
  await settle();
});

test('a relayed remote ask belongs to the run that requested its session', async () => {
  const origins = {
    'peer-s1-tab-1': { kind: 'orchestrator', ref: 'r1' },
    'peer-s1-tab-2': { kind: 'owner' },
  };
  const w = world({ runsOptions: { remoteStatus: (tabId) => (origins[tabId] ? { tabId, origin: origins[tabId] } : null) } });
  await tgRuns.bind(CHAT, 'r1');
  await settle();
  w.sent.length = 0;
  const q = [{ id: 'go', type: 'confirm', question: 'Deploy &lt;b&gt;?' }];
  const entry = w.remoteAsk('peer-s1-ask-1', 'peer-s1-tab-1', q, `s1\u0007${'h'.repeat(120)}`, `Build\n${'t'.repeat(200)}`);
  w.remoteAsk('peer-s1-ask-2', 'peer-s1-tab-2', q, 's1', 'Owner session');
  await settle();

  const d = await tgRuns.runDetail('r1', null, CHAT);
  assert.deepEqual(d.pendingQuestions.map((p) => p.askId), ['peer-s1-ask-1'], 'an owner-launched remote ask is no run\'s');
  const { remote } = d.pendingQuestions[0];
  assert.equal(remote.host, `s1${'h'.repeat(98)}`);
  assert.equal(remote.session, `Build${'t'.repeat(115)}`);

  const pushed = w.sent.filter((s) => s.method === 'sendMessage' && /Deploy/.test(s.params.text));
  assert.equal(pushed.length, 1, 'only the run\'s remote ask is pushed');
  assert.ok(pushed[0].params.text.startsWith(`Remote · ${remote.host} · ${remote.session}\n`));
  assert.equal(pushed[0].params.parse_mode, undefined);
  assert.ok(pushed[0].params.text.includes('Deploy <b>?'), 'the master\'s markdown escapes come off in plain text');

  // Answered like a local ask; the owner's remote ask is not this run's.
  const router = fakeRouter();
  tgRuns.mountApi(router, '/pro/tg-session/api', (h) => async (req, res) => h(req, res, { chatId: CHAT }));
  const hit = (key, body, params) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    router.routes.get(key)({ body, query: {}, params, headers: {} }, res);
  });
  const answer = (askId, tabId) => hit('POST /pro/tg-session/api/run/:runId/answer', { askId, answer: [{ id: 'go', question: 'Deploy?', answer: true }], ...(tabId ? { tabId } : {}) }, { runId: 'r1' });
  assert.equal((await hit('GET /pro/tg-session/api/runs', {}, {})).body.runs[0].pendingQuestions, 1);
  assert.equal((await answer('peer-s1-ask-2', 'peer-s1-tab-2')).status, 404);
  // As core's ask:answer: a remote ask's answer must name its own tab.
  assert.equal(remote.tabId, 'peer-s1-tab-1');
  assert.match((await answer('peer-s1-ask-1')).body.error, /must name its tab/);
  assert.match((await answer('peer-s1-ask-1', 'peer-s1-tab-2')).body.error, /another session/);
  assert.deepEqual(entry.answers, []);
  assert.deepEqual((await answer('peer-s1-ask-1', remote.tabId)).body, { ok: true });
  assert.deepEqual(entry.answers, [[{ id: 'go', question: 'Deploy?', answer: true }]]);
  assert.ok(w.broadcasts.some((b) => b.type === 'ask:answered' && b.askId === 'peer-s1-ask-1'));
  assert.ok(w.pendingQuestions.has('peer-s1-ask-2'));
  await settle();
});

test('a local ask has no remote key', async () => {
  const w = world();
  w.ask('ask-10-1', 'tab-A', [{ id: 'q', type: 'confirm', question: 'Go?' }]);
  const d = await tgRuns.runDetail('r1', null, CHAT);
  assert.equal('remote' in d.pendingQuestions[0], false);
  await settle();
});

// --- Owner-only handoff routes ----------------------------------------------

function fakeRouter() {
  const routes = new Map();
  return { routes, post: (p, h) => routes.set(`POST ${p}`, h), get: (p, h) => routes.set(`GET ${p}`, h) };
}

function call(router, key, body = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); },
    };
    router.routes.get(key)({ body, query: {}, params: {}, headers: {} }, res);
  });
}

test('the handoff routes are the owner\'s, outside the exempt Mini App subtree', async () => {
  const w = world();
  const router = fakeRouter();
  tgRuns.mountHandoff(router);
  for (const key of router.routes.keys()) assert.doesNotMatch(key, /\/pro\/tg-session/);

  w.owner = false;
  assert.equal((await call(router, 'POST /pro/tg-handoff/bind', { runId: 'r1' })).status, 403);
  assert.equal((await call(router, 'GET /pro/tg-handoff/bindings')).status, 403);
  assert.equal(tgRuns.getBinding('r1'), null);

  w.owner = true;
  w.controlChat = null;
  const noBot = await call(router, 'POST /pro/tg-handoff/bind', { runId: 'r1' });
  assert.equal(noBot.status, 400);
  assert.match(noBot.body.error, /Telegram is not configured/);

  w.controlChat = CHAT;
  assert.deepEqual((await call(router, 'POST /pro/tg-handoff/bind', { runId: 'r1' })).body, { ok: true, runId: 'r1', bound: true });
  assert.deepEqual((await call(router, 'GET /pro/tg-handoff/bindings')).body, { runs: ['r1'] });
  assert.ok(w.broadcasts.some((b) => b.type === 'tg:binding' && b.runId === 'r1' && b.bound === true && b.name === 'orch-r1'));
  assert.deepEqual((await call(router, 'POST /pro/tg-handoff/unbind', { runId: 'r1' })).body, { ok: true, runId: 'r1', bound: false });
  assert.deepEqual((await call(router, 'GET /pro/tg-handoff/bindings')).body, { runs: [] });
  await settle();
});

test('a mirror run (orchestrator on the master) is skipped: no list entry, no bind, pause, resume or refresh', async () => {
  const w = world();
  const mirror = { key: 'k1', host: 'master', orchestrator: 'orch-m1', closed: false };
  const listOrig = w.orchestration.listRuns;
  w.orchestration.listRuns = () => [
    ...listOrig(),
    { runId: 'm1', name: 'orch-m1', title: 'orch-m1 on master', engine: 'sdk', state: 'mirror', busy: false, paused: false, pausing: false, orchestratorTabId: null, workerCount: 1, updatedAt: 2, mirror: { host: 'master', orchestrator: 'orch-m1' } },
  ];
  const describeOrig = w.orchestration.describeRun;
  w.orchestration.describeRun = (id) => (id === 'm1'
    ? { runId: 'm1', orchestrator: 'orch-m1', engine: 'sdk', closed: false, pausing: false, paused: null, orchestratorRunning: false, orchestratorTabId: null, orchestratorState: 'exited', pendingEvents: 0, workers: [], mirror }
    : describeOrig(id));
  w.init();
  await settle();

  // The Sessions list offers r1 only.
  w.sent.length = 0;
  await tgRuns.handleCallback(CHAT, 'vr_list');
  const view = w.sent.find((m) => m.method === 'sendMessage');
  const buttons = view.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(buttons.includes('vr:b:r1'));
  assert.ok(!buttons.some((d) => /:m1$/.test(d || '')));
  assert.ok(!/orch-m1/.test(view.params.text));

  // The Mini App's run list leaves it out too.
  const router = fakeRouter();
  tgRuns.mountApi(router, '/pro/tg-session/api', (h) => async (req, res) => { await h(req, res, { chatId: CHAT }); });
  const listed = await new Promise((resolve) => router.routes.get('GET /pro/tg-session/api/runs')({ body: {}, query: {}, params: {}, headers: {} }, { status() { return this; }, json: resolve }));
  assert.deepEqual(listed.runs.map((r) => r.runId), ['r1']);

  // Every action is refused, and core is never asked.
  for (const op of ['b', 'p', 'r']) {
    w.sent.length = 0;
    await tgRuns.handleCallback(CHAT, `vr:${op}:m1`);
    const said = w.sent.find((m) => m.method === 'sendMessage');
    assert.match(said.params.text, /mirror of orch-m1 on master/);
  }
  await assert.rejects(() => tgRuns.refreshOrchestrator('m1'), /mirror/);
  assert.deepEqual(w.orchestration.calls, []);
  assert.ok(!fs.existsSync(w.statePath) || !w.saved().runs?.m1);
  await settle();
});

test('without ctx.orchestration the run features are off', async () => {
  const w = world();
  tgRuns.init({ state: { get: () => ({}), save() {} } });
  assert.equal(tgRuns.enabled(), false);
  const router = fakeRouter();
  tgRuns.mountHandoff(router);
  assert.equal((await call(router, 'POST /pro/tg-handoff/bind', { runId: 'r1' })).status, 403);
  assert.ok(w);
});

test('the Mini App reads 404 for an unknown run, and for runs on a core without them', async () => {
  const w = world();
  const router = fakeRouter();
  // authed as tg-miniapp-auth builds it: errors become 400.
  const authed = (h) => async (req, res) => { try { await h(req, res, { chatId: CHAT }); } catch (err) { res.status(400).json({ error: err.message }); } };
  tgRuns.mountApi(router, '/pro/tg-session/api', authed);
  const get = (key, params) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    router.routes.get(key)({ body: {}, query: {}, params, headers: {} }, res);
  });
  assert.equal((await get('GET /pro/tg-session/api/run/:runId', { runId: 'nope' })).status, 404);
  const ok = await get('GET /pro/tg-session/api/runs', {});
  assert.deepEqual(ok.body.runs.map((r) => [r.runId, r.bound, r.pendingQuestions]), [['r1', false, 0]]);

  tgRuns.init({ state: { get: () => ({}), save() {} } });
  const off = await get('GET /pro/tg-session/api/runs', {});
  assert.equal(off.status, 404);
  assert.match(off.body.error, /not found/i); // the client's legacy-fallback test
  assert.ok(w);
});

// --- The Mini App's remote list ------------------------------------------------
//
// A slave's ask from a session the owner or Horst launched belongs to no run:
// GET runs lists it under `remote` (peer → session, with the session's state
// and cost), answered over POST remote/answer. A run's remote ask stays the
// run's alone; everything from the slave stays plain text.

function miniApi() {
  const router = fakeRouter();
  // authed as tg-miniapp-auth builds it: errors become 400.
  tgRuns.mountApi(router, '/pro/tg-session/api', (h) => async (req, res) => { try { await h(req, res, { chatId: CHAT }); } catch (err) { res.status(400).json({ error: err.message }); } });
  const hit = (key, body = {}, params = {}) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    router.routes.get(key)({ body, query: {}, params, headers: {} }, res);
  });
  return {
    runs: () => hit('GET /pro/tg-session/api/runs'),
    answer: (body) => hit('POST /pro/tg-session/api/remote/answer', body),
  };
}

function remoteWorld() {
  const origins = {
    'peer-s1:t1': { kind: 'orchestrator', ref: 'r1' },
    'peer-s1:t2': { kind: 'owner' },
    'peer-s1:t3': { kind: 'horst', ref: 'p-1' },
    'peer-s1:t4': { kind: 'orchestrator', ref: 'gone' }, // a run no longer listed
    'peer-s2:t5': { kind: 'owner' },
  };
  const status = {
    'peer-s1:t2': { state: 'awaiting', costUsd: 1.25 },
    'peer-s1:t3': { state: '<b>x</b>', costUsd: Number.NaN },
  };
  return world({ runsOptions: { remoteStatus: (tabId) => (origins[tabId] ? { tabId, origin: origins[tabId], ...(status[tabId] || {}) } : null) } });
}

const confirmQ = [{ id: 'go', type: 'confirm', question: 'Deploy &lt;b&gt;?' }];

test('remote list: the relayed asks no listed run holds, by peer → session, none twice', async () => {
  const w = remoteWorld();
  const hostile = '<img src=x onerror=alert(1)>‮\u0007';
  w.remoteAsk('peer-s1:a1', 'peer-s1:t1', confirmQ, 's1', 'Run member');
  w.remoteAsk('peer-s1:a2', 'peer-s1:t2', confirmQ, 's1', hostile + 'x'.repeat(200));
  w.remoteAsk('peer-s1:a3', 'peer-s1:t2', confirmQ, 's1', hostile + 'x'.repeat(200));
  w.remoteAsk('peer-s1:a4', 'peer-s1:t3', confirmQ, 's1', 'Horst asked');
  w.remoteAsk('peer-s1:a5', 'peer-s1:t4', confirmQ, 's1', 'Orphan');
  w.remoteAsk('peer-s2:a6', 'peer-s2:t5', confirmQ, `s2\u0000${'h'.repeat(150)}`, 'Other peer');
  w.ask('ask-local', 'tab-A', confirmQ);
  await settle();

  const { status, body } = await miniApi().runs();
  assert.equal(status, 200);
  assert.equal(body.runs[0].pendingQuestions, 2, 'the run counts its local and its remote ask');
  const shape = body.remote.map((g) => [g.host, g.sessions.map((s) => [s.tabId, s.session, s.state, s.costUsd, s.asks.map((a) => a.askId)])]);
  assert.deepEqual(shape, [
    ['s1', [
      ['peer-s1:t2', `<img src=x onerror=alert(1)>${'x'.repeat(92)}`, 'awaiting', 1.25, ['peer-s1:a2', 'peer-s1:a3']],
      ['peer-s1:t3', 'Horst asked', null, null, ['peer-s1:a4']],
      ['peer-s1:t4', 'Orphan', null, null, ['peer-s1:a5']],
    ]],
    [`s2${'h'.repeat(98)}`, [['peer-s2:t5', 'Other peer', null, null, ['peer-s2:a6']]]],
  ]);
  // Plain text, never HTML: the label is the literal string, controls and bidi gone.
  const a2 = body.remote[0].sessions[0].asks[0];
  assert.deepEqual(a2.remote, { host: 's1', session: body.remote[0].sessions[0].session, tabId: 'peer-s1:t2' });
  assert.deepEqual(a2.questions, confirmQ, 'the question as the master cleaned it; the client sets it as text');

  // No duplicates: the run's list and the remote list split the relayed asks.
  const runIds = (await tgRuns.runDetail('r1', null, CHAT)).pendingQuestions.map((p) => p.askId);
  const remoteIds = body.remote.flatMap((g) => g.sessions.flatMap((s) => s.asks.map((a) => a.askId)));
  assert.deepEqual(runIds.sort(), ['ask-local', 'peer-s1:a1']);
  assert.equal(remoteIds.filter((id) => runIds.includes(id)).length, 0);
  assert.equal(remoteIds.length + runIds.length, w.pendingQuestions.size);
  await settle();
});

test('remote list: answered over remote/answer only for its own question and tab', async () => {
  const w = remoteWorld();
  const runAsk = w.remoteAsk('peer-s1:a1', 'peer-s1:t1', confirmQ, 's1', 'Run member');
  const owners = w.remoteAsk('peer-s1:a2', 'peer-s1:t2', confirmQ, 's1', 'Owner session');
  const local = w.ask('ask-local', 'tab-A', confirmQ);
  await settle();
  const api = miniApi();
  const ans = [{ id: 'go', question: 'Deploy?', answer: true }];

  assert.equal((await api.answer({ askId: 'peer-s1:a1', answer: ans, tabId: 'peer-s1:t1' })).status, 404, 'a run\'s ask is answered in the run');
  assert.equal((await api.answer({ askId: 'ask-local', answer: ans, tabId: 'tab-A' })).status, 404, 'a local ask is no remote one');
  assert.equal((await api.answer({ askId: 'nope', answer: ans, tabId: 'peer-s1:t2' })).status, 404);
  assert.equal((await api.answer({ askId: 'peer-s1:a2', answer: 'yes', tabId: 'peer-s1:t2' })).status, 400);
  const unnamed = await api.answer({ askId: 'peer-s1:a2', answer: ans });
  assert.equal(unnamed.status, 400);
  assert.match(unnamed.body.error, /must name its tab/);
  assert.match((await api.answer({ askId: 'peer-s1:a2', answer: ans, tabId: 'peer-s1:t1' })).body.error, /another session/);
  assert.deepEqual([runAsk.answers, owners.answers, local.answers], [[], [], []]);

  assert.deepEqual((await api.answer({ askId: 'peer-s1:a2', answer: ans, tabId: 'peer-s1:t2' })).body, { ok: true });
  assert.deepEqual(owners.answers, [ans]);
  assert.ok(w.broadcasts.some((b) => b.type === 'ask:answered' && b.askId === 'peer-s1:a2'));
  assert.deepEqual((await api.runs()).body.remote, []);
  assert.equal((await api.answer({ askId: 'peer-s1:a2', answer: ans, tabId: 'peer-s1:t2' })).status, 404, 'first answer wins');
  await settle();
});

// The real relay: asks from two slaves, answered from Telegram, reach their
// own slave only, under the slave's ask id.
test('remote answers from Telegram reach the right peer (peer-remote-master)', async () => {
  const prm = require('../src/apps/peer-remote-master');
  const w = world();
  const calls = [];
  let n = 0;
  let frameFn = null;
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tgruns-prm-'));
  prm.init({
    broadcaster: w.broadcaster, pendingQuestions: w.pendingQuestions, dataHome,
    registerExternalSession: () => () => {},
    claudeStatus: () => null, claudeAuthInfo: () => null,
    peerChannel: {
      fleetState: () => ({ peers: [{ name: 's1', connected: true, claude: null }, { name: 's2', connected: true, claude: null }] }),
      onRemoteFrame(fn) { frameFn = fn; return () => { frameFn = null; }; },
      onEvent() { return () => {}; },
      async remoteCommand(peer, op, args) {
        calls.push({ peer, op, args });
        return op === 'launch' ? { tabId: `tab-${++n}` } : op === 'list' ? [] : {};
      },
    },
  });
  try {
    const spec = { mode: 'simple', app: 'notes', prompt: 'do it', auth: 'subscription' };
    const t1 = await prm.launch('s1', { ...spec, title: 'Owner on s1' }, { kind: 'owner' });
    const t2 = await prm.launch('s2', { ...spec, title: 'Horst on s2' }, { kind: 'horst', ref: 'p-1' });
    const t3 = await prm.launch('s1', { ...spec, title: 'Run member' }, { kind: 'orchestrator', ref: 'r1' });
    frameFn('s2', { t: 'rs:state', tabId: t2.remoteTabId, state: 'started', costUsd: 0.5, credential: 'subscription' });
    const form = (id) => ({ toolUseId: id, formData: { title: 'Go?', questions: [{ id: 'go', type: 'confirm', question: 'Go?' }] } });
    await tgRuns.bind(CHAT, 'r1');
    for (const [peer, t] of [['s1', t1], ['s2', t2], ['s1', t3]]) frameFn(peer, { t: 'rs:ask', tabId: t.remoteTabId, askId: `a-${t.remoteTabId}`, title: 'Q', forms: [form(`a-${t.remoteTabId}`)] });
    await settle();

    const api = miniApi();
    const { body } = await api.runs();
    const sessions = body.remote.flatMap((g) => g.sessions.map((s) => ({ host: g.host, ...s })));
    assert.deepEqual(sessions.map((s) => [s.host, s.tabId, s.session]), [['s1', t1.tabId, 'Owner on s1'], ['s2', t2.tabId, 'Horst on s2']]);
    const s2 = sessions[1];
    assert.deepEqual([s2.state, s2.costUsd], ['busy', 0.5]);

    const ans = [{ id: 'go', question: 'Go?', answer: true }];
    const a = s2.asks[0];
    assert.deepEqual((await api.answer({ askId: a.askId, answer: ans, tabId: a.remote.tabId })).body, { ok: true });
    await settle();
    assert.deepEqual(calls.filter((c) => c.op === 'answer'), [{ peer: 's2', op: 'answer', args: { askId: `a-${t2.remoteTabId}`, answer: ans } }]);

    // The run's remote ask: a chat button answers it for the tab it was posted for.
    const runAsk = [...w.pendingQuestions.keys()].find((id) => id.includes(t3.remoteTabId));
    assert.equal(tgRuns.getBinding('r1').asks[runAsk].tabId, t3.tabId);
    await tgRuns.handleCallback(CHAT, `vq:${runAsk}:0`);
    await settle();
    assert.deepEqual(calls.filter((c) => c.op === 'answer').at(-1), { peer: 's1', op: 'answer', args: { askId: `a-${t3.remoteTabId}`, answer: [{ id: 'go', question: 'Go?', answer: true }] } });
    assert.equal(calls.filter((c) => c.op === 'answer' && c.args.askId === `a-${t1.remoteTabId}`).length, 0, 's1\'s owner ask is still open');
  } finally {
    prm.shutdown();
    fs.rmSync(dataHome, { recursive: true, force: true });
  }
  await settle();
});

// The Mini App subtree is auth-exempt: the bearer from tg-miniapp-auth is the
// perimeter, and only the restricted bot's allowlisted owner gets one.
test('the remote list and its answer refuse unauthenticated and non-owner requests', async () => {
  const crypto = require('crypto');
  const TOKEN = '123456:AAHfake-bot-token-for-tests';
  const saved = { getToken: telegram.getToken, getBot: telegram.getBot, isAllowed: telegram.isAllowed };
  telegram.getToken = () => TOKEN;
  telegram.getBot = () => ({ restricted: true });
  telegram.isAllowed = (_k, id) => Number(id) === CHAT;
  const initData = (user) => {
    const p = new URLSearchParams({ user: JSON.stringify(user), auth_date: String(Math.floor(Date.now() / 1000)) });
    const check = [...p].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
    return p.toString();
  };
  try {
    const w = remoteWorld();
    const owners = w.remoteAsk('peer-s1:a2', 'peer-s1:t2', confirmQ, 's1', 'Owner session');
    const router = fakeRouter();
    tgSession.mountApi(router);
    const hit = (key, body = {}, headers = {}) => new Promise((resolve) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
      router.routes.get(key)({ body, query: {}, params: {}, headers }, res);
    });
    const runs = (headers) => hit('GET /pro/tg-session/api/runs', {}, headers);
    const answer = (headers) => hit('POST /pro/tg-session/api/remote/answer', { askId: 'peer-s1:a2', answer: [{ id: 'go', answer: true }], tabId: 'peer-s1:t2' }, headers);

    assert.equal((await runs({})).status, 401);
    assert.equal((await answer({})).status, 401);
    assert.equal((await runs({ 'x-tg-session': 'forged' })).status, 401);
    assert.equal((await answer({ 'x-tg-session': 'forged' })).status, 401);
    assert.equal((await hit('POST /pro/tg-session/api/auth', { initData: initData({ id: 9999 }) })).status, 403, 'not the owner');
    assert.equal((await hit('POST /pro/tg-session/api/auth', { initData: initData({ id: CHAT }).replace(/hash=./, 'hash=0') })).status, 401);
    assert.deepEqual(owners.answers, []);

    const { body } = await hit('POST /pro/tg-session/api/auth', { initData: initData({ id: CHAT }) });
    const headers = { 'x-tg-session': body.token };
    assert.equal((await runs(headers)).body.remote[0].sessions[0].asks[0].askId, 'peer-s1:a2');
    assert.deepEqual((await answer(headers)).body, { ok: true });
    assert.equal(owners.answers.length, 1);
    await settle();
  } finally {
    Object.assign(telegram, saved);
  }
});
