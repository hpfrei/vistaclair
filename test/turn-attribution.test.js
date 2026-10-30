// Request-time lane attribution (src/turn-attribution.js) and the store's
// completion-time confirm/correct of it (applyResolution). A subagent's turn
// used to render in the main lane until its response was done; these pin the
// decisions that put it in its own lane from the moment its request arrives.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TurnAttributor } = require('../src/turn-attribution');

const PROMPT_A = 'Find every caller of applyResolution in src/ and report the call sites with line numbers.';
const PROMPT_B = 'Read public/inspector-lanes.js and summarise how laneKeyOf decides a turn\'s lane.';
const REMINDER = '<system-reminder>As you answer the user\'s questions, you can use the following context.</system-reminder>';

const tool = (id, name = 'Bash', input = {}) => ({ type: 'tool_use', id, name, input });
const agentCall = (id, prompt, extra = {}) => tool(id, 'Agent', { description: 'look around', subagent_type: 'explorer', prompt, ...extra });
const asst = (...content) => ({ role: 'assistant', content });
const user = (...texts) => ({ role: 'user', content: texts.map(text => ({ type: 'text', text })) });
const results = (...ids) => ({ role: 'user', content: ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: 'ok' })) });

test('a turn with history belongs to the owner of its last assistant message\'s tool calls', () => {
  const att = new TurnAttributor();
  att.noteResponse('main', [tool('t_main')]);
  att.noteResponse('agent-r', [tool('t_r')], { agentId: 'agent-r', agentType: 'coder', description: 'build it' });

  const sub = att.attribute([user('task'), asst(tool('t_r')), results('t_r')]);
  assert.deepStrictEqual(sub, { agentId: 'agent-r', agentType: 'coder', description: 'build it', toolUseId: null });
  assert.strictEqual(att.attribute([user('hi'), asst(tool('t_main')), results('t_main')]), null);
});

test('only the last assistant message counts — a fork carries its parent\'s history', () => {
  const att = new TurnAttributor();
  att.noteResponse('main', [tool('t_main1'), agentCall('t_fork', PROMPT_A)]);
  att.noteResponse('fork-1', [tool('t_f1')], { agentId: 'fork-1', agentType: 'fork' });

  // The fork's later turn: main's messages first, its own last.
  const later = att.attribute([
    user('hi'), asst(tool('t_main1')), results('t_main1'),
    asst(agentCall('t_fork', PROMPT_A)), { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't_fork', content: '' }, { type: 'text', text: PROMPT_A }] },
    asst(tool('t_f1')), results('t_f1'),
  ]);
  assert.strictEqual(later.agentId, 'fork-1');

  // Its first turn: the parent's history ending in the very call, then the directive.
  att.noteSpawn('t_fork', 'fork-1');
  const first = att.attribute([
    user('hi'), asst(agentCall('t_fork', PROMPT_A)),
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't_fork', content: '' }, { type: 'text', text: PROMPT_A }] },
  ]);
  assert.strictEqual(first.agentId, 'fork-1');

  // Main's own next turn after the call returned stays on main.
  assert.strictEqual(att.attribute([user('hi'), asst(agentCall('t_fork', PROMPT_A)), results('t_fork')]), null);
});

test('an agent\'s first turn matches the prompt of the Agent call, even in a later text block', () => {
  const att = new TurnAttributor();
  att.noteResponse('main', [agentCall('t_a', PROMPT_A)]);

  // Agent id not known yet: the pending lane key of the call.
  const pending = att.attribute([user(REMINDER, REMINDER, PROMPT_A)]);
  assert.deepStrictEqual(pending, { agentId: 'pending-t_a', agentType: 'explorer', description: 'look around', toolUseId: 't_a' });

  // Once a SubagentStart (or the meta file) names it: the real id.
  att.noteSpawn('t_a', 'a123');
  assert.strictEqual(att.attribute([user(REMINDER, PROMPT_A)]).agentId, 'a123');
  const viaMeta = new TurnAttributor();
  viaMeta.noteResponse('main', [agentCall('t_a', PROMPT_A)]);
  assert.strictEqual(viaMeta.attribute([user(PROMPT_A)], { agentForCall: id => (id === 't_a' ? 'a999' : null) }).agentId, 'a999');
});

test('concurrent agents with different prompts each get their own lane', () => {
  const att = new TurnAttributor();
  att.noteResponse('main', [agentCall('t_a', PROMPT_A), agentCall('t_b', PROMPT_B, { subagent_type: 'coder' })]);
  att.noteSpawn('t_a', 'aaa');
  att.noteSpawn('t_b', 'bbb');

  const b1 = att.attribute([user(REMINDER, PROMPT_B)]);
  const a1 = att.attribute([user(PROMPT_A)]);
  assert.strictEqual(b1.agentId, 'bbb');
  assert.strictEqual(b1.agentType, 'coder');
  assert.strictEqual(a1.agentId, 'aaa');

  // Their streamed tool calls carry each agent on to its next turn.
  att.noteResponse(a1.agentId, [tool('t_a1')], a1);
  att.noteResponse(b1.agentId, [tool('t_b1')], b1);
  assert.strictEqual(att.attribute([user(PROMPT_A), asst(tool('t_a1')), results('t_a1')]).agentId, 'aaa');
  assert.strictEqual(att.attribute([user(PROMPT_B), asst(tool('t_b1')), results('t_b1')]).agentId, 'bbb');
});

test('no history and no matching prompt is the main thread', () => {
  const att = new TurnAttributor();
  assert.strictEqual(att.attribute([user('hello')]), null);
  att.noteResponse('main', [agentCall('t_a', PROMPT_A)]);
  assert.strictEqual(att.attribute([user('Command: ls -la\nWhat is the prefix?')]), null);
  assert.strictEqual(att.attribute(undefined), null);
});

test('a text-only reply is found by its text; an unseen tool call falls back to the trace', () => {
  const att = new TurnAttributor();
  att.noteResponse('agent-r', [{ type: 'text', text: 'All done, the report is above.' }], { agentId: 'agent-r', agentType: 'explorer' });
  const resumed = att.attribute([user(PROMPT_A), asst({ type: 'text', text: 'All done, the report is above.' }), user('one more thing')]);
  assert.strictEqual(resumed.agentId, 'agent-r');

  const traced = att.attribute([user('x'), asst(tool('t_unseen')), results('t_unseen')],
    { resolveToolUseId: id => (id === 't_unseen' ? 'agent-q' : null) });
  assert.strictEqual(traced.agentId, 'agent-q');
});

// --- The store: request-time stamp, completion-time confirm/correct ---

function freshStore(home) {
  process.env.VISTACLAIR_HOME = home;
  for (const m of ['../src/store', '../src/utils', '../src/capabilities']) delete require.cache[require.resolve(m)];
  const InteractionStore = require('../src/store');
  return new InteractionStore(200);
}

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-test-'));
  const store = freshStore(home);
  const sent = [];
  store.setBroadcaster({ broadcast: m => sent.push(m) });
  store.registerSession('cli-s1', 's1');
  return { store, sent, home };
}

let seq = 0;
function turn(store, messages, response = []) {
  const id = `req_${++seq}`;
  const interaction = {
    id, instanceId: 'cli-s1', endpoint: '/v1/messages', timestamp: Date.now() + seq,
    request: { model: 'm', messages },
    response: { status: 200, headers: { 'request-id': `rid_${id}` }, body: { content: response }, sseEvents: [] },
    timing: { startedAt: 0 }, status: 'pending',
  };
  store.attributeTurn(interaction);
  store.add(interaction);
  return interaction;
}
const complete = (store, i) => { i.status = 'complete'; store.save(i.id); };

async function fileOf(home, store, id) {
  const fp = store.filePaths.get(id);
  for (let k = 0; k < 50; k++) {
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { await new Promise(r => setTimeout(r, 10)); }
  }
  throw new Error('not written');
}

test('the store stamps a subagent turn provisionally at request time and the trace confirms it', async () => {
  const { store, sent, home } = setup();
  const parent = turn(store, [user('go')]);
  // The Agent call's block is complete mid-stream; its agent starts at once.
  store.noteToolUse(parent, agentCall('t_a', PROMPT_A));
  const hook = { id: 'hook-1', instanceId: 'cli-s1', isHook: true, hookEvent: 'SubagentStart', hookAgentId: 'aaa',
    subagent: { agentId: 'aaa', agentType: 'explorer', description: 'look around', toolUseId: 't_a' },
    request: {}, response: {}, timing: {}, status: 'complete' };
  store.add(hook);
  store.save(hook.id);

  const first = turn(store, [user(REMINDER, PROMPT_A)], [tool('t_a1')]);
  assert.strictEqual(first.subagent.agentId, 'aaa');
  assert.strictEqual(first.subagentProvisional, true);
  complete(store, first);
  assert.strictEqual((await fileOf(home, store, first.id)).subagentProvisional, true);

  store.applyResolution('s1', 'request', `rid_${first.id}`, 'aaa');
  assert.strictEqual(first.subagentProvisional, undefined);
  assert.strictEqual(first.subagent.agentId, 'aaa');
  assert.strictEqual(first.subagent.agentType, 'explorer');
  const enriched = sent.filter(m => m.type === 'interaction:enriched' && m.interactionId === first.id);
  assert.strictEqual(enriched.length, 1);
  assert.strictEqual(enriched[0].subagent.agentId, 'aaa');
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual((await fileOf(home, store, first.id)).subagentProvisional, undefined);

  // A resolution equal to a confirmed stamp changes nothing.
  store.applyResolution('s1', 'request', `rid_${first.id}`, 'aaa');
  assert.strictEqual(sent.filter(m => m.type === 'interaction:enriched' && m.interactionId === first.id).length, 1);

  // Its next turn follows from the tool call it made.
  const next = turn(store, [user(PROMPT_A), asst(tool('t_a1')), results('t_a1')]);
  assert.strictEqual(next.subagent.agentId, 'aaa');
});

test('the trace corrects a wrong provisional stamp, including back to main', () => {
  const { store, sent } = setup();
  const parent = turn(store, [user('go')]);
  store.noteToolUse(parent, agentCall('t_a', PROMPT_A));

  // Guessed for the pending agent; the trace names another one.
  const a = turn(store, [user(PROMPT_A)]);
  assert.strictEqual(a.subagent.agentId, 'pending-t_a');
  complete(store, a);
  store.applyResolution('s1', 'request', `rid_${a.id}`, 'real-a');
  assert.strictEqual(a.subagent.agentId, 'real-a');
  assert.strictEqual(a.subagentProvisional, undefined);
  // ...and the call's later first-turn matches use the real id.
  assert.strictEqual(turn(store, [user(PROMPT_A)]).subagent.agentId, 'real-a');

  // Guessed for a subagent; the trace says main: the stamp goes.
  const b = turn(store, [user(PROMPT_A)]);
  complete(store, b);
  store.applyResolution('s1', 'request', `rid_${b.id}`, 'main');
  assert.strictEqual(b.subagent, undefined);
  assert.strictEqual(b.subagentProvisional, undefined);
  const toMain = sent.find(m => m.type === 'interaction:enriched' && m.interactionId === b.id);
  assert.strictEqual(toMain.subagent, null);

  // A main turn the request already put on main gets no broadcast.
  const c = turn(store, [user('plain')]);
  complete(store, c);
  store.applyResolution('s1', 'request', `rid_${c.id}`, 'main');
  assert.strictEqual(sent.some(m => m.type === 'interaction:enriched' && m.interactionId === c.id), false);
});
