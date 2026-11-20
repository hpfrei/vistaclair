// Horst's long-running app tools (agent/horst-jobs.js + the horst route of
// app-tool-jobs.js): an owner chat turn that calls a job tool stages an
// app.tool.job card instead of running it; approval starts exactly the frozen
// call without blocking; the outcome lands in the conversation and, for a
// Telegram turn, as ONE message linking to Vista › Files (the ledger record
// and pin per file; a picture's preview photo, no document upload); a
// question round-trips through a Telegram reply or the chat tool; progress is
// one message edited in place, throttled; at most two run at once; nothing but
// an owner chat request starts one; a restart still delivers.
// Stubbed Telegram and conversation store — no network, no model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const appJobs = require('../src/apps/app-jobs');
const appTools = require('../src/apps/app-tools');
const jobs = require('../src/apps/app-tool-jobs');
const art = require('../src/apps/app-artifacts');
const capabilities = require('../src/apps/capabilities');
const governance = require('../src/apps/governance/horst-governance');
const horstJobs = require('../src/apps/agent/horst-jobs');
const horstDeliveries = require('../src/apps/agent/horst-deliveries');

const appsDir = makeAppsDir({ 'blender-app': {} });
appManager.setAppsDir(appsDir);
appJobs.init({ appsDir });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-horstjobs-'));
const horstDir = path.join(tmp, 'horst');
fs.mkdirSync(horstDir, { recursive: true });
art.init({ dir: path.join(tmp, 'artifacts') });
jobs.init({ dataHome: tmp, sendToSession: () => ({ delivered: false }) });

governance.registerPlatformKinds(capabilities.horstKinds());
governance.init({
  dir: horstDir,
  broadcaster: { broadcast() {} },
  notifyDecision: (p) => horstJobs.decided(p),
});
governance.registerLauncher('app.tool.job', (p, proposal) => horstJobs.launch(p, proposal));

// --- stubs: the conversation store and the control bot ----------------------
const CHAT = '42';
const convs = new Map(); // conversationId → [{ text, extra }]
const tg = { messages: [], edits: [], photos: [], documents: [], nextId: 500 };
const deps = {
  dir: horstDir,
  governance,
  appendMessage: (conversationId, text, extra) => {
    if (!convs.has(conversationId)) convs.set(conversationId, []);
    const msg = { text, ...extra };
    convs.get(conversationId).push(msg);
    return msg;
  },
  sendControlMessage: async (chatId, text, markup) => {
    const messageId = tg.nextId++;
    tg.messages.push({ chatId, text, markup, messageId });
    return [{ messageId, text }];
  },
  controlChatId: () => CHAT,
  telegram: {
    call: async (method, params) => { tg.edits.push({ method, ...params }); return { ok: true }; },
    sendPhoto: async (args) => { tg.photos.push(args); },
    sendDocument: async (args) => { tg.documents.push(args); },
  },
  progressEditMs: 80,
};
const VISTA = 'https://vc.example/pro/vista/';
const bootHorst = () => {
  horstDeliveries.init({ dir: horstDir, sendControlMessage: deps.sendControlMessage, telegram: deps.telegram, miniAppUrl: () => VISTA });
  return horstJobs.init(deps);
};
bootHorst();

// --- the provider: make_model parks on a gate per key -----------------------
const gates = new Map();
function gate(key) {
  let open;
  const p = new Promise((r) => { open = r; });
  gates.set(key, { p, open });
  return (v) => open(v);
}
const seen = []; // { args, caller, job }
appTools.registerAppTools('blender-app', [
  { name: 'make_model', description: 'Build a 3D model.', expose: 'platform', kind: 'job', sideEffects: 'writes' },
  { name: 'list_projects', description: 'List projects.', expose: 'platform', sideEffects: 'none' },
]);
appTools.registerAppToolHandler('blender-app', 'make_model', async (args, caller, job) => {
  seen.push({ args, caller, job });
  if (args.ask) {
    const answer = await job.ask(args.ask);
    return { content: [{ type: 'text', text: `roof is ${answer}` }] };
  }
  if (args.steps) for (const [pct, label] of args.steps) job.progress(pct, label);
  if (args.note) job.notify(args.note);
  const v = await gates.get(args.key).p;
  if (v instanceof Error) throw v;
  return v;
});
appTools.registerAppToolHandler('blender-app', 'list_projects', async () => ({ projects: ['p1'] }));

test.after(() => {
  jobs.shutdown();
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const record = (id) => JSON.parse(fs.readFileSync(path.join(tmp, 'tool-jobs', `${id}.json`), 'utf8'));
const textOf = (r) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const reset = () => {
  convs.clear(); seen.length = 0;
  tg.messages.length = 0; tg.edits.length = 0; tg.photos.length = 0; tg.documents.length = 0;
};

// One owner chat turn: the platform caller core builds from the sidecar token,
// with the turn's sessionTag bound as platform-horst.runChat binds it.
let turnSeq = 0;
function chatTurn({ conversationId = 'tg42', chatId = CHAT, surface = 'telegram' } = {}) {
  const sessionTag = `horst-chat:test${++turnSeq}`;
  const release = appTools.bindHorstTurn(sessionTag, { conversationId, chatId, surface });
  const caller = { type: 'platform', instanceId: `inst-${turnSeq}`, sessionTag };
  return { caller, release, call: (tool, args) => appTools.callAppToolHandler('blender-app', tool, args, caller) };
}

// Stage from chat and approve from Telegram → the started job's id.
async function startJob(args, turnOpts) {
  const turn = chatTurn(turnOpts);
  const staged = await turn.call('make_model', args);
  turn.release();
  const p = await governance.decide(staged.structuredContent.proposalId, 'approve', 'telegram');
  assert.equal(p.status, 'executed', p.error);
  const id = p.result.summary.match(/tj_[a-z0-9]+/)[0];
  return { id, proposal: p };
}

function finishAll() {
  for (const [key, g] of gates) { g.open({ content: [{ type: 'text', text: `closed ${key}` }] }); gates.delete(key); }
}

test('a job tool called from owner chat stages an app.tool.job card instead of running', async () => {
  reset();
  const turn = chatTurn();
  const r = await turn.call('make_model', { prompt: 'a lighthouse', style: 'low-poly', _wait: 60 });
  turn.release();
  assert.equal(seen.length, 0, 'nothing ran');
  assert.match(textOf(r), /Staged \S+: blender-app__make_model starts only when the owner taps Start/);
  assert.match(textOf(r), /Do not wait/);
  assert.equal(r.structuredContent.status, 'awaiting-approval');
  const p = governance.getProposal(r.structuredContent.proposalId);
  assert.equal(p.kind, 'app.tool.job');
  assert.equal(p.status, 'pending');
  assert.equal(p.origin, 'chat');
  assert.deepEqual(p.payload, { app: 'blender-app', tool: 'make_model', args: { prompt: 'a lighthouse', style: 'low-poly' }, conversationId: 'tg42', chatId: CHAT });
  const card = require('../src/apps/governance/horst-cards').cardFor(governance.kindDef('app.tool.job'), p);
  assert.deepEqual(card.fields.map((f) => f.label), ['Plan', 'Arguments']);
  assert.match(card.fields[0].value, /^no plan given/);
  assert.match(card.fields[1].value, /a lighthouse/);
  assert.match(textOf(r), /No _plan was given/);
  assert.equal(jobs.list('owner').filter((j) => j.caller.type === 'horst').length, 0, 'no ledger record');
  await governance.decide(p.id, 'deny', 'telegram');
  assert.match(convs.get('tg42').at(-1).text, /Not started — you declined blender-app › make_model/);
});

test('_plan: stripped from the args, frozen on the payload, first on every card projection and in the decision ledger', async () => {
  reset();
  const cards = require('../src/apps/governance/horst-cards');
  const decisions = require('../src/apps/governance/horst-decisions');
  const plan = '30-min German episode on 20th-century Europe, two hosts, turning points from 1914 to 1989.';
  const turn = chatTurn();
  const r = await turn.call('make_model', { prompt: 'europe', _plan: `  ${plan}  `, _wait: 5 });
  turn.release();
  assert.doesNotMatch(textOf(r), /No _plan/);
  const p = governance.getProposal(r.structuredContent.proposalId);
  assert.deepEqual(p.payload, { app: 'blender-app', tool: 'make_model', args: { prompt: 'europe' }, plan, conversationId: 'tg42', chatId: CHAT });
  assert.match(p.summary, /^Start blender-app › make_model: 30-min German episode/);
  const card = cards.cardFor(governance.kindDef('app.tool.job'), p);
  assert.deepEqual(card.fields.map((f) => f.label), ['Plan', 'Arguments']);
  assert.equal(card.fields[0].value, plan);
  assert.equal(card.subtitle, null, 'nothing between the title and the plan');
  // Telegram's text projection: the plan right under the title, the raw args after it.
  const text = cards.textCard(card);
  assert.ok(text.indexOf(plan) > 0 && text.indexOf(plan) < text.indexOf('"prompt"'));
  assert.equal(text.split('\n').findIndex((l) => l === plan), 3);
  // The decision ledger keeps it.
  assert.equal(decisions.compactPayload('app.tool.job', p.payload).plan, plan);
  // Approval runs the frozen args: the tool never sees _plan.
  const open = gate('eu');
  const q = await governance.decide(governance.createProposal('app.tool.job', { ...p.payload, args: { key: 'eu' } }, { origin: 'chat' }).id, 'approve', 'telegram');
  assert.equal(q.status, 'executed', q.error);
  assert.deepEqual(seen.at(-1).args, { key: 'eu' });
  open({ content: [{ type: 'text', text: 'ok' }] });
  await governance.decide(p.id, 'deny', 'telegram');
  // A plan the kind would refuse: too long is capped at staging; a reserved key in args is refused.
  const long = chatTurn();
  const r2 = await long.call('make_model', { prompt: 'x', _plan: 'y'.repeat(900) });
  long.release();
  assert.equal(governance.getProposal(r2.structuredContent.proposalId).payload.plan.length, appTools.PLAN_MAX);
  await governance.decide(r2.structuredContent.proposalId, 'deny', 'telegram');
  assert.throws(() => governance.createProposal('app.tool.job', { app: 'blender-app', tool: 'make_model', args: { _plan: 'x' }, conversationId: 'c' }, { origin: 'chat' }), /reserved _plan/);
});

test('_plan is Horst\'s alone: listed only in an owner chat turn\'s schema, ignored for any other caller', async () => {
  reset();
  const tool = appTools.getToolsForApp('blender-app').find((t) => t.name === 'make_model');
  const plain = appTools.callerView(tool);
  const horst = appTools.callerView(tool, { horst: true });
  assert.ok(plain.inputSchema.properties._wait && !plain.inputSchema.properties._plan);
  assert.ok(horst.inputSchema.properties._plan && !horst.inputSchema.properties._wait);
  assert.match(horst.description, /^Build a 3D model\. Long-running: calling it stages a Start card/);
  assert.match(horst.description, /ask in one short message with your proposed defaults and wait/);
  const union = (o) => appTools.getPlatformToolUnion(o).find((t) => t._ownerApp === 'blender-app' && t.name === 'make_model');
  assert.ok(union().inputSchema.properties._wait && !union().inputSchema.properties._plan);
  assert.ok(union({ horst: true }).inputSchema.properties._plan);
  const turn = chatTurn();
  assert.equal(appTools.isHorstTurn(turn.caller.sessionTag), true);
  turn.release();
  assert.equal(appTools.isHorstTurn(turn.caller.sessionTag), false);
  assert.deepEqual(appTools.contractOf(horst).inputSchema.properties, tool.inputSchema ? tool.inputSchema.properties || {} : {});
  // An unbound platform caller (cron, platform AI outside a chat turn) runs
  // the job and waits for it: its _plan never reaches the tool.
  const open = gate('np');
  const run = appTools.callAppToolHandler('blender-app', 'make_model', { key: 'np', _plan: 'ignored' }, { type: 'platform' });
  await until(() => seen.length === 1);
  assert.deepEqual(seen[0].args, { key: 'np' });
  open({ content: [{ type: 'text', text: 'ok' }] });
  assert.deepEqual(await run, { content: [{ type: 'text', text: 'ok' }] });
});

test('the persona carries the clarify-then-confirm rule', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'platform-horst.js'), 'utf8');
  const persona = src.slice(src.indexOf('const PERSONA = `'), src.indexOf('Special markers you may use'));
  assert.match(persona, /Clarify first: compare the request with the tool's description and contract/);
  assert.match(persona, /ask in ONE short message that proposes your defaults, and wait for the answer/);
  assert.match(persona, /A specific request needs no questions/);
  assert.match(persona, /Always pass _plan/);
});

test('quick tools from chat run as before; app-chat turns cannot stage; unbound platform callers are untouched', async () => {
  reset();
  const turn = chatTurn();
  assert.deepEqual(await turn.call('list_projects', {}), { projects: ['p1'] });
  turn.release();
  const appTurn = chatTurn({ conversationId: 'app-x-default', chatId: null, surface: 'app' });
  await assert.rejects(appTurn.call('make_model', { prompt: 'x' }), /only from the owner's own chat/);
  appTurn.release();
  // A released tag is a plain platform caller again (expose levels unchanged).
  assert.equal(appTools.resolveCaller(turn.caller).type, 'platform');
  assert.equal(appTools.exposeAllows({ expose: 'platform' }, 'blender-app', { type: 'horst' }), true);
  assert.equal(appTools.exposeAllows({ expose: 'self' }, 'blender-app', { type: 'horst' }), false);
});

test('approval starts exactly the stored call and returns without blocking; the outcome reaches the chat, the deliveries ledger and ONE Telegram message', async () => {
  reset();
  const open = gate('lh');
  const t0 = Date.now();
  const { id, proposal } = await startJob({ prompt: 'a lighthouse', key: 'lh' });
  assert.ok(Date.now() - t0 < 1000, 'approval did not wait for the job');
  assert.equal(seen[0].caller.type, 'horst');
  assert.equal(seen[0].caller.conversationId, 'tg42');
  assert.deepEqual(seen[0].args, { prompt: 'a lighthouse', key: 'lh' });
  assert.match(proposal.result.summary, /^Started tj_/);
  assert.equal(record(id).status, 'running');
  assert.equal(record(id).principal, 'owner');
  assert.match(convs.get('tg42')[0].text, /▶ Started blender-app › make_model/);
  await until(() => tg.messages.some((m) => m.text.startsWith('⏳ blender-app › make_model')));

  // The provider's artifacts: a preview PNG, the .glb, and one above 50 MB.
  const png = await art.put('blender-app', Buffer.from('\x89PNG fake preview'), { name: 'preview-1.png', mime: 'image/png' });
  const glb = await art.put('blender-app', Buffer.from('glTF fake model'), { name: 'lighthouse.glb' });
  const big = await art.put('blender-app', Buffer.alloc(51 * 1024 * 1024, 1), { name: 'huge.blend' });
  open({
    content: [{ type: 'text', text: 'Low-poly lighthouse ready.' }, glb.link, png.link, big.link],
    structuredContent: { project: 'lighthouse-1', model: { uri: glb.uri, name: 'lighthouse.glb', size: glb.size, format: 'glb' }, previews: [png.uri] },
  });
  await until(() => record(id).delivered === true);
  await until(() => tg.photos.length === 1);

  const out = convs.get('tg42').at(-1);
  assert.match(out.text, /^✅ blender-app › make_model done/);
  assert.match(out.text, /Low-poly lighthouse ready\./);
  assert.match(out.text, /project: lighthouse-1/);
  assert.ok(out.text.includes(glb.uri) && out.text.includes(png.uri), 'artifact uris kept for later turns');
  assert.match(out.text, /again with project "lighthouse-1"/);
  assert.deepEqual(out.job, { id, status: 'done' });

  // The ledger: one record per file, one batch, each artifact pinned.
  const { files } = horstDeliveries.list({ batch: horstDeliveries.list().files.find((d) => d.jobId === id).batch });
  assert.deepEqual(files.map((d) => d.name).sort(), ['huge.blend', 'lighthouse.glb', 'preview-1.png']);
  for (const d of files) {
    assert.equal(d.source, 'job');
    assert.equal(d.jobId, id);
    assert.equal(d.app, 'blender-app');
    assert.equal(d.tool, 'make_model');
    assert.equal(d.conversationId, 'tg42');
    assert.equal(d.title, 'Low-poly lighthouse ready.');
    assert.ok(art.get(d.uri).pins.some((p) => p.holder === horstDeliveries.HOLDER && p.reason === 'horst-delivery'));
  }
  const model = files.find((d) => d.name === 'lighthouse.glb');
  assert.equal(model.kind, 'model');
  assert.deepEqual(model.previews, [files.find((d) => d.kind === 'picture').id], 'the model shows its delivered preview');

  // Telegram: the preview photo carries the outcome (no uri lines) and the
  // Vista button; no document, no second message, no 50 MB note.
  assert.equal(tg.documents.length, 0, 'no file is uploaded');
  const photo = tg.photos[0];
  assert.equal(photo.contentType, 'image/png');
  assert.ok(Buffer.isBuffer(photo.photo));
  assert.match(photo.caption, /^✅ blender-app › make_model done/);
  assert.ok(!photo.caption.includes('vc-artifact://'), 'no uri lines on Telegram');
  const button = photo.options.reply_markup.inline_keyboard.at(-1)[0];
  assert.equal(button.text, '📁 Open in Vista (3 files)');
  assert.equal(button.web_app.url, `${VISTA}?file=${model.id}`, 'the button deep-links the first file of the delivery');
  assert.ok(!tg.messages.some((m) => /^✅ blender-app/.test(m.text)), 'the outcome is the photo, not a second message');
  // The progress message was closed with the outcome line.
  assert.ok(tg.edits.some((e) => e.method === 'editMessageText' && /^✅ blender-app › make_model done/.test(e.text)));
});

test('a question reaches Telegram and the chat; a reply to it answers the job; horst_job_reply answers from chat', async () => {
  reset();
  const { id } = await startJob({ ask: 'Which roof colour?' });
  await until(() => tg.messages.some((m) => m.text.includes('Which roof colour?')));
  const q = tg.messages.find((m) => m.text.includes('Which roof colour?'));
  assert.equal(q.markup.force_reply, true);
  assert.match(convs.get('tg42').find((m) => m.job && m.job.question).text, /asks: Which roof colour\?/);
  assert.equal(horstJobs.answerFromTelegram(CHAT, 9999, 'red'), null, 'an unrelated reply is not an answer');
  const a = horstJobs.answerFromTelegram(CHAT, q.messageId, 'red');
  assert.equal(a.ok, true);
  await until(() => record(id).delivered === true);
  assert.match(convs.get('tg42').at(-1).text, /roof is red/);
  assert.equal(horstJobs.answerFromTelegram(CHAT, q.messageId, 'blue'), null, 'answered once');

  // The Horst tab path: Horst passes the owner's answer with the chat tool.
  reset();
  const { id: id2 } = await startJob({ ask: 'Add a door?' }, { conversationId: 'c-ui', chatId: null, surface: 'ui' });
  await until(() => record(id2).pendingQuestion);
  assert.equal(tg.messages.length, 0, 'a Horst-tab job does not write to Telegram');
  const reply = horstJobs.tools().find((t) => t.def.name === 'horst_job_reply');
  await assert.rejects(reply.handler({ jobId: id2, text: 'yes' }, { type: 'platform' }), /only Horst's owner chat/);
  await reply.handler({ jobId: id2, text: 'yes' }, { type: 'horst', conversationId: 'c-ui' });
  await until(() => record(id2).delivered === true);
  assert.match(convs.get('c-ui').at(-1).text, /roof is yes/);
});

test('progress is one Telegram message edited in place, throttled to the latest state', async () => {
  reset();
  const open = gate('pg');
  const { id } = await startJob({ key: 'pg' });
  await until(() => tg.messages.some((m) => m.text.startsWith('⏳')) && seen.some((x) => x.job.id === id));
  const msg = tg.messages.find((m) => m.text.startsWith('⏳'));
  const job = seen.find((x) => x.job.id === id).job;
  const editsOf = () => tg.edits.filter((e) => e.message_id === msg.messageId);
  job.progress(10, 'mesh');
  job.progress(20, 'roof');
  job.progress(30, 'lamp');
  await sleep(20);
  assert.equal(editsOf().length, 0, 'inside the throttle window nothing is edited');
  await until(() => editsOf().length === 1);
  assert.match(editsOf()[0].text, /^⏳ blender-app › make_model — 30% lamp/);
  job.notify('using 12 segments');
  await until(() => editsOf().length === 2);
  assert.match(editsOf()[1].text, /30% lamp\n📝 using 12 segments/);
  // An identical tick edits nothing.
  job.progress(30, 'lamp');
  await sleep(200);
  assert.equal(editsOf().length, 2);
  assert.equal(tg.messages.filter((m) => m.text.startsWith('⏳')).length, 1, 'one progress message per job');
  open({ content: [{ type: 'text', text: 'done' }] });
  await until(() => record(id).delivered === true);
});

test('at most two Horst jobs run at once; a third approval fails with a clear message', async () => {
  reset();
  gate('c1'); gate('c2');
  await startJob({ key: 'c1' });
  await startJob({ key: 'c2' });
  const turn = chatTurn();
  const staged = await turn.call('make_model', { key: 'c3' });
  turn.release();
  assert.match(textOf(staged), /already running/);
  const p = await governance.decide(staged.structuredContent.proposalId, 'approve', 'telegram');
  assert.equal(p.status, 'failed');
  assert.match(p.error, /2 long-running tools are already running/);
  assert.match(convs.get('tg42').at(-1).text, /⏸ Not started/);
  assert.equal(horstJobs.runningJobs().length, 2);
  finishAll();
  await until(() => horstJobs.runningJobs().length === 0);
});

test('routines, triage and missions cannot start a job tool', async () => {
  reset();
  const payload = { app: 'blender-app', tool: 'make_model', args: { key: 'x' }, conversationId: 'tg42', chatId: CHAT };
  const r = await governance.requestAction('app.tool.job', payload, { origin: 'triage' });
  assert.equal(r.mode, 'proposed', 'ceiling propose: never executed unattended');
  const p = await governance.decide(r.proposal.id, 'approve', 'ui');
  assert.equal(p.status, 'failed');
  assert.match(p.error, /only from the owner's chat request/);
  assert.equal(seen.length, 0);
  const kind = capabilities.horstKinds()['app.tool.job'];
  assert.equal(kind.ceiling, 'propose');
  assert.equal(kind.defaultLevel, 'propose');
  // Structurally: among Horst's AI calls only the chat turn is granted app tools.
  const src = path.join(__dirname, '..', 'src', 'apps');
  const files = ['platform-horst.js', ...fs.readdirSync(path.join(src, 'agent')).map((f) => `agent/${f}`), ...fs.readdirSync(path.join(src, 'governance')).map((f) => `governance/${f}`)];
  const grants = [];
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(src, f), 'utf8');
    for (const m of text.matchAll(/allowedTools:\s*\[([^\]]*)\]/g)) if (/mcp__app-tools/.test(m[1])) grants.push(f);
  }
  assert.deepEqual(grants, ['platform-horst.js']);
  const horstSrc = fs.readFileSync(path.join(src, 'platform-horst.js'), 'utf8');
  assert.equal((horstSrc.match(/mcp__app-tools__\*/g) || []).length, 1, 'one grant: runChat');
});

test('cancel and status from chat act on Horst jobs only', async () => {
  reset();
  gate('cx');
  const { id } = await startJob({ key: 'cx' });
  const [status, cancel] = ['horst_job_status', 'horst_job_cancel'].map((n) => horstJobs.tools().find((t) => t.def.name === n));
  assert.match(status.def.description, /Read-only/);
  const listed = JSON.parse(textOf(await status.handler({}, { type: 'horst' })));
  assert.ok(listed.jobs.some((j) => j.id === id && j.status === 'running'));
  await assert.rejects(cancel.handler({ jobId: id }, { type: 'platform' }), /only Horst's owner chat/);
  await cancel.handler({ jobId: id }, { type: 'horst', conversationId: 'tg42' });
  await until(() => record(id).delivered === true);
  assert.match(convs.get('tg42').at(-1).text, /^🚫 blender-app › make_model cancelled/);
  gates.delete('cx');
});

test('a restart delivers an undelivered outcome once Horst registers again', async () => {
  reset();
  gate('rs');
  const { id } = await startJob({ key: 'rs' });
  // The server dies mid-run: the ledger still says running; boot sweeps it.
  jobs.init({ dataHome: tmp, sendToSession: () => ({ delivered: false }) });
  assert.equal(record(id).status, 'interrupted');
  assert.equal(record(id).delivered, false, 'no Horst handler yet');
  bootHorst();
  await until(() => record(id).delivered === true);
  const out = convs.get('tg42').at(-1);
  assert.match(out.text, /^⚠️ blender-app › make_model interrupted/);
  assert.match(out.text, /Asking again should continue/);
  // The progress message tracked before the restart is closed, not orphaned.
  await until(() => tg.edits.some((e) => /^⚠️ blender-app › make_model interrupted/.test(e.text || '')));
  gates.delete('rs');
});
