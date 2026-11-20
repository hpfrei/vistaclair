// The peer.session.launch kind (peer-remote-agent.js, declared in
// capabilities/fleet.js): pinned at propose; the card carries the raw request
// (target, app, mode, billing, the prompt verbatim, who asked — a run only
// from a card peer-remote-host filed); Horst's card launches with origin
// horst, a worker card hands over to peer-remote-host; approve only where the
// whole prompt was shown. No agent tool files it any more: the broker lists
// no peer_session_*. peer-remote-master and peer-remote-host are stubs;
// governance and the broker are the real modules on temp dirs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const governance = require('../src/apps/governance/horst-governance');
const capabilities = require('../src/apps/capabilities');
const broker = require('../src/apps/mcp-broker');
const pairing = require('../src/apps/peer-pairing');
const agent = require('../src/apps/peer-remote-agent');

const KIND = 'peer.session.launch';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-remote-agent-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Linked peers, as the pairing store would answer.
pairing.getPeer = (name) => (name === 'pi' ? { id: 'p1', name: 'pi' } : null);

// Everything governance broadcasts (the bus-facing side of the approval plane).
const broadcasts = [];
governance.registerPlatformKinds({ [KIND]: capabilities.horstKinds()[KIND] });
governance.init({ dir: path.join(tmp, 'gov'), broadcaster: { broadcast: (m) => broadcasts.push(m) } });
broker.init({ dir: path.join(tmp, 'broker') });

// --- the peer-remote-master / peer-remote-host stubs --------------------------
const launches = [];
const handed = [];
agent._setDeps({
  master: () => ({
    async launch(peer, spec, origin) {
      launches.push({ peer, spec, origin });
      return { tabId: `peer-${peer}:t${launches.length}`, remoteTabId: `t${launches.length}` };
    },
  }),
  host: () => ({
    async approved(p, proposal) { handed.push({ p, id: proposal.id }); return { ok: true, summary: 'worker started' }; },
  }),
});

const rpc = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });
const pending = () => governance.listProposals({ status: 'pending', kind: KIND });
const cardOf = (p) => require('../src/apps/governance/horst-cards').cardFor(governance.kindDef(KIND), p);
const worker = (over = {}) => ({
  peer: 'pi', mode: 'worker', app: 'shop', auth: 'apikey', prompt: '# Task\nUpgrade <b>deps</b> & run tests.',
  origin: { kind: 'orchestrator', ref: 'run-7', title: 'Fleet upgrade', address: 'orch-7', member: 'w-deps' }, ...over,
});

// -----------------------------------------------------------------------------

test('the kind is ceiling-pinned at propose: raising its dial never takes', () => {
  const def = governance.kindDef(KIND);
  assert.equal(def.ceiling, 'propose');
  assert.equal(def.defaultLevel, 'propose');
  assert.equal(def.identity, null, 'every request is its own launch');
  for (const level of ['auto', 'auto+notify']) {
    const r = governance.setDial(KIND, level, 'test');
    assert.equal(r.level, 'propose');
    assert.equal(r.clamped, true);
    assert.equal(governance.getDials()[KIND].level, 'propose');
  }
});

test('a worker card shows the raw request: slave, app, mode, billing, the task verbatim, the run and member', async () => {
  const prompt = `${'Line with <script>alert(1)</script> and **markdown**.\n'.repeat(400)}END`;
  const r = await governance.requestAction(KIND, worker({ prompt, title: 'deps' }), { origin: agent.ORIGIN });
  const p = r.proposal;
  assert.equal(p.payload.prompt, prompt, 'the frozen payload is the task, byte for byte');
  const card = cardOf(p);
  const field = (label) => card.fields.find((f) => f.label === label);
  assert.equal(field('Slave').value, 'pi');
  assert.equal(field('App').value, 'shop');
  assert.match(field('Mode').value, /worker of a run/);
  assert.match(field('Billing').value, /API key.*per token/);
  assert.equal(card.accent, 'warn');
  assert.match(card.warn, /per token/);
  assert.match(card.warn, /longer than a Telegram card shows/);
  assert.equal(field('Requested by').value, 'Orchestrator "Fleet upgrade" · run run-7 · member w-deps');
  const tf = field('Task');
  assert.equal(tf.kind, 'code', 'monospace text, not markdown');
  assert.equal(tf.verbatim, true);
  assert.equal(tf.value, prompt, `the whole task (${prompt.length} chars), not an excerpt`);
  assert.match(card.footer, /SendMessage/);
  assert.match(p.summary, /run worker for app "shop" on slave "pi" \(API key/);
  governance.withdrawProposal(p.id, 'test');
});

test('approving a worker card hands the launch to peer-remote-host', async () => {
  handed.length = 0;
  const { proposal } = await governance.requestAction(KIND, worker({ auth: 'subscription' }), { origin: agent.ORIGIN });
  const out = await governance.decide(proposal.id, 'approve', 'ui-full');
  assert.equal(out.status, 'executed');
  assert.equal(handed.length, 1);
  assert.equal(handed[0].id, proposal.id);
  assert.equal(handed[0].p.origin.member, 'w-deps');
});

test('a worker card not filed by peer-remote-host never launches; a worker payload names its member', async () => {
  handed.length = 0;
  const forged = governance.createProposal(KIND, worker({ auth: 'subscription' }), { origin: 'chat' });
  assert.equal(cardOf(forged).fields.find((f) => f.label === 'Requested by').value, 'Horst (chat)');
  const out = await governance.decide(forged.id, 'approve', 'ui-full');
  assert.equal(out.status, 'failed');
  assert.match(out.error, /filed only by a run/);
  assert.equal(handed.length, 0);
  const { origin, ...rest } = worker();
  assert.throws(() => agent.checkPayload({ ...rest, origin: { kind: 'orchestrator', ref: 'run-7' } }), /names its run and member/);
  assert.throws(() => agent.checkPayload({ ...rest, origin: { ...origin, member: 'w​' } }), /invisible/);
  assert.throws(() => agent.checkPayload({ ...rest, origin: { ...origin, extra: 'x' } }), /unknown field "origin.extra"/);
});

test('a card staged by Horst says Horst, whatever origin its payload claims', () => {
  const p = governance.createProposal(KIND, { peer: 'pi', mode: 'orchestrator', app: 'shop', auth: 'subscription', prompt: 'x', origin: { kind: 'orchestrator', ref: 'run-x', title: 'Fake' } }, { origin: 'chat' });
  const card = cardOf(p);
  assert.equal(card.fields.find((f) => f.label === 'Requested by').value, 'Horst (chat)');
  assert.match(card.fields.find((f) => f.label === 'Billing').value, /subscription/);
  assert.equal(card.accent, null);
  governance.withdrawProposal(p.id, 'test');
});

test('the broker lists no peer_session_* tool, on any session', async () => {
  const orch = { type: 'orchestrator', runId: 'run-7', address: 'orch-7', instanceId: 'cli-a' };
  for (const opts of [{ holder: orch, mode: 'catalog' }, { holder: { ...orch, type: 'worker', address: 'w-1', instanceId: 'cli-b' }, mode: 'grant', tools: [] }]) {
    const s = broker.createHolderSession(opts);
    const names = (await broker.handleMessage(s.id, rpc('tools/list'))).result.tools.map((t) => t.name);
    assert.ok(!names.some((n) => n.startsWith('peer_session_')), names.join(','));
    broker.revokeSession(s.id);
  }
  assert.equal(agent.builtinTools, undefined);
});

test('Horst\'s card launches with origin horst and the proposal id', async () => {
  launches.length = 0;
  const payload = { peer: 'pi', mode: 'simple', app: 'shop', auth: 'subscription', prompt: 'Check the logs.' };
  const p = governance.createProposal(KIND, payload, { origin: 'chat' });
  await governance.decide(p.id, 'approve', 'ui-full');
  assert.deepEqual(launches[0].origin, { kind: 'horst', ref: p.id });
});

// --- approve only where the whole prompt was shown -----------------------------
const TG = require('../src/apps/governance/horst-cards').TEXT_BODY_LIMIT;
const horstSpec = (prompt) => ({ peer: 'pi', mode: 'simple', app: 'shop', auth: 'subscription', prompt });

test('a prompt longer than the Telegram card: approve from Telegram is refused, the card stays pending', async () => {
  launches.length = 0;
  const p = governance.createProposal(KIND, horstSpec('y'.repeat(TG + 1)), { origin: 'chat' });
  await assert.rejects(governance.decide(p.id, 'approve', 'telegram'), /Telegram card shows 1200.*shown in full/);
  assert.equal(governance.getProposal(p.id).status, 'pending', 'the refusal does not consume the decision');
  // Other surfaces that never rendered the prompt are refused too.
  await assert.rejects(governance.decide(p.id, 'approve', 'app:shop'), /shown in full/);
  assert.equal(launches.length, 0);
  // Deny stays one tap on Telegram.
  const d = await governance.decide(p.id, 'deny', 'telegram');
  assert.equal(d.status, 'denied');

  // The Mini App's detail and the Horst tab's full card render it whole:
  // approve stands there.
  for (const via of ['miniapp', 'ui-full']) {
    const q = governance.createProposal(KIND, horstSpec('z'.repeat(TG + 500)), { origin: 'chat' });
    assert.equal((await governance.decide(q.id, 'approve', via)).status, 'executed', via);
  }
  assert.equal(launches.length, 2);
});

test('a prompt that fits on the Telegram card keeps approve there', async () => {
  launches.length = 0;
  const p = governance.createProposal(KIND, horstSpec('w'.repeat(TG)), { origin: 'chat' });
  assert.equal((await governance.decide(p.id, 'approve', 'telegram')).status, 'executed');
  assert.equal(launches.length, 1);
});

test('the Telegram card of a truncated prompt carries Deny and the full view, never Approve', () => {
  const platformHorst = require('../src/apps/platform-horst');
  const miniapp = require('../src/apps/platform-miniapp');
  const realUrl = miniapp.miniAppUrl;
  const flat = (kb) => kb.inline_keyboard.flat();
  try {
    for (const url of [null, 'https://vc.example/pro/miniapp/']) {
      miniapp.miniAppUrl = () => url;
      const long = governance.createProposal(KIND, horstSpec('v'.repeat(TG + 1)), { origin: 'chat' });
      const buttons = flat(platformHorst.proposalButtons(long));
      assert.ok(!buttons.some((b) => /approve/.test(b.callback_data || '') || /Approve/.test(b.text)), `no approve (url ${url})`);
      assert.ok(buttons.some((b) => b.callback_data === `horst_prop:${long.id}:deny`), 'deny stays');
      assert.equal(buttons.some((b) => b.web_app && b.web_app.url === url), !!url, 'the full view when the Mini App exists');
      const text = platformHorst.formatProposalForTg(long);
      assert.match(text, /more characters — open to read it all/);
      assert.match(text, /approve it in the Mini App or on the Horst tab's full card/);
      governance.withdrawProposal(long.id, 'test');

      const short = governance.createProposal(KIND, horstSpec('short prompt'), { origin: 'chat' });
      const sb = flat(platformHorst.proposalButtons(short));
      // A fitting prompt gets the card every kind gets: Approve in chat with no
      // Mini App, the Mini App button when there is one.
      if (url) assert.ok(sb.some((b) => b.web_app));
      else assert.ok(sb.some((b) => b.callback_data === `horst_prop:${short.id}:approve:${governance.payloadVersion(short)}`));
      governance.withdrawProposal(short.id, 'test');
    }
  } finally { miniapp.miniAppUrl = realUrl; }
});

// --- the Horst tab: approve from the full card only ----------------------------
test('a plain Horst-tab approve (timeline row, queue preview) is refused; the full card\'s stands', async () => {
  launches.length = 0;
  const p = governance.createProposal(KIND, horstSpec('short prompt'), { origin: 'chat' });
  await assert.rejects(governance.decide(p.id, 'approve', 'ui'), /Open the full card/);
  assert.equal(governance.getProposal(p.id).status, 'pending');
  assert.equal(launches.length, 0);
  assert.equal((await governance.decide(p.id, 'approve', 'ui-full')).status, 'executed');
  assert.equal(launches.length, 1);
  // Deny needs no full view.
  const q = governance.createProposal(KIND, horstSpec('short prompt'), { origin: 'chat' });
  assert.equal((await governance.decide(q.id, 'deny', 'ui')).status, 'denied');
});

test('a pending proposal whose kind refuses a plain ui approve is marked fullViewApprove at every egress', async () => {
  const platformHorst = require('../src/apps/platform-horst');
  broadcasts.length = 0;
  const p = governance.createProposal(KIND, horstSpec('short prompt'), { origin: 'chat' });
  const listed = platformHorst.listProposals({ status: 'pending' }).find((x) => x.id === p.id);
  assert.equal(listed.fullViewApprove, true, 'REST egress (withCards)');
  const sent = broadcasts.find((m) => m.type === 'horst:proposal' && m.proposal.id === p.id);
  assert.equal(sent && sent.proposal.fullViewApprove, true, 'broadcast egress (withCard)');
  // A kind without approveFrom is approved inline as before.
  governance.registerKind('plainkind', { label: 'Plain', ceiling: 'propose', defaultLevel: 'propose', validate: () => null, describe: () => 'plain', execute: async () => ({ ok: true }) }, { app: 'shop' });
  const plain = governance.createProposal('shop:plainkind', {}, { origin: 'chat' });
  assert.ok(!platformHorst.listProposals({ status: 'pending' }).find((x) => x.id === plain.id).fullViewApprove);
  governance.withdrawProposal(p.id, 'test');
  governance.withdrawProposal(plain.id, 'test');
  const after = platformHorst.listProposals({}).find((x) => x.id === p.id);
  assert.ok(!after.fullViewApprove, 'only while pending');
});

test('the decide route maps view "full" to via ui-full, anything else to ui', async () => {
  const platformHorst = require('../src/apps/platform-horst');
  const routes = [];
  const add = (method) => (p, ...handlers) => routes.push({ method, path: p, handlers });
  const router = { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'), use: () => {} };
  platformHorst.mountApi(router);
  const route = routes.find((r) => r.method === 'POST' && r.path.endsWith('/proposals/:id/decide'));
  const post = (id, body) => new Promise((resolve) => {
    const res = { statusCode: 200 };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; resolve(res); return res; };
    route.handlers[route.handlers.length - 1]({ params: { id }, body }, res, (err) => resolve({ statusCode: 500, body: { error: err && err.message } }));
  });
  launches.length = 0;
  const p = governance.createProposal(KIND, horstSpec('short prompt'), { origin: 'chat' });
  const plain = await post(p.id, { decision: 'approve' });
  assert.notEqual(plain.statusCode, 200);
  assert.match(JSON.stringify(plain.body), /Open the full card/);
  assert.equal(governance.getProposal(p.id).status, 'pending');
  const full = await post(p.id, { decision: 'approve', view: 'full', version: governance.payloadVersion(p) });
  assert.equal(full.statusCode, 200);
  assert.equal(full.body.proposal.status, 'executed');
  assert.equal(launches.length, 1);
});

test('the Horst tab offers no inline approve for a fullViewApprove proposal (structural)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/horst/horst.js'), 'utf8');
  const row = src.slice(src.indexOf('pending && r.fullView ?'), src.indexOf(': pending ? `<div class="tl-actions">'));
  assert.ok(row.length > 0, 'the timeline row has its fullView branch');
  assert.ok(!/data-decide="approve"/.test(row) && /data-openprop="\$\{escHtml\(r\.id\)\}"/.test(row));
  assert.match(src, /fullView: !!row\.fullViewApprove/);
  assert.match(src, /preview && p\.fullViewApprove \? \{\s*cls: 'go', primary: true, attrs: 'data-expand'/);
  assert.match(src, /decisionRows\(p, \{ preview: true \}\)/);
  assert.match(src, /btn\.closest\('#propOverlay'\) \? 'full'/);
});
