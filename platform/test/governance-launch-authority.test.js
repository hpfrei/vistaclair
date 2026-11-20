// Launch authority over the approval plane, as attacks (docs/governance.md,
// docs/remote-sessions.md "The card"):
//   - an app cannot forge a proposal's origin, nor stage or edit a
//     platform-owned kind (peer.session.launch among them); requester() never
//     reads an app's proposal as an orchestrator's;
//   - a prompt or title carrying characters a reader cannot see is refused,
//     and a verbatim card field shows any that slip through as ⟨U+XXXX⟩;
//   - an approve carrying a payload version other than the current one is
//     refused on every surface (Horst tab REST, Mini App, Telegram, an app);
//     the current version is accepted.
// Governance and the cards are the real modules on a temp dir; the master half
// of remote sessions and app-manager's contribution gate are stubs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// app-manager is only the contribution gate here: every app contributes.
const appManagerPath = require.resolve('../src/apps/app-manager');
require.cache[appManagerPath] = {
  id: appManagerPath, filename: appManagerPath, loaded: true,
  exports: { contributes: () => true, requireContribution: async () => {} },
};

// The Mini App's session check, passed through: these tests are about what
// the decide route does once the owner is authenticated.
const miniAuth = require('../src/apps/tg-miniapp-auth');
miniAuth.mountAuth = () => ({
  authed: (handler) => async (req, res) => {
    try { await handler(req, res, {}); } catch (err) { res.status(400).json({ error: err.message }); }
  },
  issueToken: () => 't', resolveToken: () => ({}),
});

const governance = require('../src/apps/governance/horst-governance');
const capabilities = require('../src/apps/capabilities');
const pairing = require('../src/apps/peer-pairing');
const agent = require('../src/apps/peer-remote-agent');
const cards = require('../src/apps/governance/horst-cards');
const textSafety = require('../src/apps/text-safety');
const govCap = require('../src/apps/capabilities/governance');

const KIND = 'peer.session.launch';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-launch-authority-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

pairing.getPeer = (name) => (name === 'pi' ? { id: 'p1', name: 'pi' } : null);
const launches = [];
agent._setDeps({
  master: () => ({ async launch(peer, spec, origin) { launches.push({ peer, spec, origin }); return { tabId: `peer-${peer}-t${launches.length}` }; } }),
});

const executed = [];
const plainKind = (label, extra = {}) => ({
  label, ceiling: 'propose', defaultLevel: 'propose', identity: null,
  validate: () => {}, describe: (p) => `${label} ${p.n ?? ''}`,
  execute: async (p) => { executed.push(p); return { ok: true, summary: label }; }, ...extra,
});
governance.registerPlatformKinds({
  [KIND]: capabilities.horstKinds()[KIND],
  'test.open': plainKind('open', { appProposable: true }),
  'test.closed': plainKind('closed'),
});
governance.init({ dir: path.join(tmp, 'gov'), broadcaster: { broadcast: () => {} } });
governance.registerKind('thing', plainKind('thing'), { app: 'shop' });

const ctx = govCap.buildCtx({ name: 'shop' }).governance;
const bridge = (method, params) => govCap.bridge[method]({ name: 'shop' }, params, { method });
const spec = (prompt, over = {}) => ({ peer: 'pi', mode: 'simple', app: 'shop', auth: 'subscription', prompt, ...over });
const forgedOrigin = { kind: 'orchestrator', ref: 'run-real', title: 'Nightly build' };

// --- F4: an app's proposals ------------------------------------------------

test('an app\'s propose cannot set the origin: governance stamps "app"', async () => {
  const viaCtx = await ctx.propose('shop:thing', { n: 1 }, { origin: agent.ORIGIN });
  assert.equal(viaCtx.proposal.origin, 'app');
  assert.equal(viaCtx.proposal.app, 'shop');
  const viaBridge = await bridge('governance.propose', { kind: 'shop:thing', payload: { n: 2 }, meta: { origin: 'chat' } });
  assert.equal(viaBridge.proposal.origin, 'app');
  assert.equal(viaBridge.proposal.app, 'shop');
});

test('an app cannot propose peer.session.launch (ctx, bridge, or its governed tool path)', async () => {
  const before = governance.listProposals({ kind: KIND }).length;
  await assert.rejects(ctx.propose(KIND, spec('ls', { origin: forgedOrigin }), { origin: agent.ORIGIN }), /platform-owned/);
  await assert.rejects(bridge('governance.propose', { kind: KIND, payload: spec('ls', { origin: forgedOrigin }), meta: { origin: agent.ORIGIN } }), /platform-owned/);
  // mcp-broker's governed-tool branch passes the owning app the same way.
  await assert.rejects(governance.requestAction(KIND, spec('ls'), { origin: 'mcp', app: 'shop' }), /platform-owned/);
  assert.equal(governance.listProposals({ kind: KIND }).length, before, 'no card was filed');
});

test('an app cannot edit a pending peer.session.launch card; the prompt stays what the owner read', async () => {
  const r = await governance.requestAction(KIND, spec('run the tests', { origin: forgedOrigin }), { origin: agent.ORIGIN });
  const id = r.proposal.id;
  await assert.rejects(ctx.update(id, spec('rm -rf /', { origin: forgedOrigin })), /platform-owned/);
  await assert.rejects(bridge('governance.update', { id, payload: spec('rm -rf /') }), /platform-owned/);
  assert.equal(governance.getProposal(id).payload.prompt, 'run the tests');
  governance.withdrawProposal(id, 'test');
});

test('platform-owned is the default; appProposable opens a platform kind; app kinds stay the app\'s', async () => {
  await assert.rejects(ctx.propose('test.closed', { n: 1 }), /platform-owned/);
  const open = await ctx.propose('test.open', { n: 1 });
  assert.equal(open.mode, 'proposed');
  const edited = await ctx.update(open.proposal.id, { n: 2 });
  assert.equal(edited.payload.n, 2);
  const closed = governance.createProposal('test.closed', { n: 1 }, { origin: 'chat' });
  await assert.rejects(ctx.update(closed.id, { n: 9 }), /platform-owned/);
  assert.equal(governance.updateProposal(closed.id, { n: 3 }, 'ui').payload.n, 3, 'the owner\'s own surfaces still edit it');
  const own = await ctx.propose('shop:thing', { n: 1 });
  assert.equal((await ctx.update(own.proposal.id, { n: 5 })).payload.n, 5);
});

test('the kinds apps may stage are exactly the ones the API reference names; every fleet kind is platform-owned', () => {
  const kinds = capabilities.horstKinds();
  const open = Object.keys(kinds).filter((k) => kinds[k].appProposable === true).sort();
  assert.deepEqual(open, ['calendar.create', 'calendar.delete', 'calendar.update', 'email.modify', 'email.send', 'telegram.send']);
  for (const k of ['app.publish', 'app.data_publish', 'app.rollback', 'peer.keys.sync', 'peer.restart', KIND]) assert.ok(!kinds[k].appProposable, k);
  const apiRef = fs.readFileSync(path.join(__dirname, '../src/apps/prompts/_api-reference.md'), 'utf8');
  for (const k of open) assert.match(apiRef, new RegExp(`Platform kinds you may propose[^]*\`${k.replace('.', '\\.')}\``), k);
});

test('requester() never reads an app\'s proposal as an orchestrator\'s', () => {
  const p = spec('x', { origin: forgedOrigin });
  assert.equal(agent.requester(p, { id: 'p-1', origin: agent.ORIGIN }).kind, 'orchestrator');
  const forged = agent.requester(p, { id: 'p-2', origin: agent.ORIGIN, app: 'shop' });
  assert.equal(forged.kind, 'horst');
  assert.doesNotMatch(forged.label, /Orchestrator|Nightly build|run-real/);
});

// --- F5: characters a reader cannot see ----------------------------------------

const HIDDEN = {
  'zero-width space': 'a\u200Bb', 'zero-width joiner': 'a\u200Db', BOM: '\uFEFFgo',
  'bidi override': 'safe\u202Eevil', 'bidi isolate': 'x\u2066y\u2069', 'tag characters': 'ok\u{E0049}\u{E0047}',
  'carriage return': 'a\rb', bell: 'a\u0007b', 'C1 control': 'a\u0085b',
  'variation selector supplement': 'a\u{E0100}', 'variation selector run': '\u2764\uFE0F\uFE0F',
};

test('checkPayload refuses a prompt or title with an invisible or control character', () => {
  for (const [name, s] of Object.entries(HIDDEN)) {
    assert.throws(() => agent.checkPayload(spec(`do this ${s}`)), /prompt contains an invisible or control character/, name);
    assert.throws(() => agent.checkPayload(spec('ok', { title: s })), /title contains an invisible or control character/, name);
  }
  assert.throws(() => governance.createProposal(KIND, spec('a\u202Eb'), { origin: 'chat' }), /invisible/, 'the kind refuses it at create');
});

test('ordinary text stays allowed: newlines, tabs, emoji with one variation selector', () => {
  for (const s of ['line 1\nline 2\n\tindented', 'I \u2764\uFE0F this', 'text \u263A\uFE0E style', 'Grüße — 日本語 ✓']) {
    assert.doesNotThrow(() => agent.checkPayload(spec(s, { title: s.split('\n')[0] })), JSON.stringify(s));
    assert.deepEqual(textSafety.invisibleChars(s), [], JSON.stringify(s));
  }
});

test('a verbatim card field shows any invisible character that slipped through, on every surface', () => {
  const def = governance.kindDef(KIND);
  const payload = spec('Upgrade deps.\u202E\u200Bthen \u{E0041}push');   // e.g. a card staged before the check
  const card = cards.cardFor(def, { id: 'p-x', kind: KIND, payload, origin: 'chat' });
  const field = card.fields.find((f) => f.label === 'Prompt');
  assert.equal(field.value, 'Upgrade deps.⟨U+202E⟩⟨U+200B⟩then ⟨U+E0041⟩push');
  assert.deepEqual(textSafety.invisibleChars(field.value), []);
  // Telegram: the text projection of the same descriptor.
  assert.match(cards.textCard(card), /⟨U\+202E⟩⟨U\+200B⟩then ⟨U\+E0041⟩push/);
  // The Horst tab and the Mini App: proposal-cards.js over that descriptor.
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/proposal-cards.js'), 'utf8'), sandbox);
  const html = sandbox.window.ProposalCards.renderDescriptorCard(card);
  assert.match(html, /⟨U\+202E⟩⟨U\+200B⟩then ⟨U\+E0041⟩push/);
  assert.doesNotMatch(html, /[\u202E\u200B]|\u{E0041}/u);
});

// --- F12: the payload version an approve carries ---------------------------------

// A pending launch card the owner then edits on one of their surfaces: the
// version shown before the edit is stale.
function editedCard() {
  const p = governance.createProposal(KIND, spec('run the tests'), { origin: 'chat' });
  const stale = governance.payloadVersion(p);
  const now = governance.updateProposal(p.id, spec('run the tests and deploy'), 'ui');
  assert.notEqual(now.version, stale);
  assert.equal(now.version, governance.payloadVersion(governance.getProposal(p.id)));
  return { id: p.id, stale, fresh: now.version };
}
const pendingStill = (id) => assert.equal(governance.getProposal(id).status, 'pending');

function routeOf(mount, suffix) {
  const routes = [];
  const add = (method) => (p, ...handlers) => routes.push({ method, path: p, handlers });
  mount({ get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'), use: () => {} });
  const route = routes.find((r) => r.method === 'POST' && r.path.endsWith(suffix));
  return (id, body) => new Promise((resolve) => {
    const res = { statusCode: 200 };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; resolve(res); return res; };
    route.handlers[route.handlers.length - 1]({ params: { id }, body, headers: {} }, res, (err) => resolve({ statusCode: 500, body: { error: err && err.message } }));
  });
}

test('governance.decide: a stale version is refused and the card stays pending; the current one runs', async () => {
  launches.length = 0;
  const { id, stale, fresh } = editedCard();
  await assert.rejects(governance.decide(id, 'approve', 'ui-full', { version: stale }), (err) => err.code === 'STALE_VERSION');
  await assert.rejects(governance.decide(id, 'approve', 'ui-full', { version: null }), /changed after it was shown/);
  pendingStill(id);
  assert.equal(launches.length, 0);
  assert.equal((await governance.decide(id, 'approve', 'ui-full', { version: fresh })).status, 'executed');
  assert.equal(launches[0].spec.prompt, 'run the tests and deploy');
  // Deny needs no version.
  const q = editedCard();
  assert.equal((await governance.decide(q.id, 'deny', 'telegram', { version: q.stale })).status, 'denied');
});

test('Horst tab REST: a stale or missing version is refused; the current one is approved', async () => {
  const post = routeOf((r) => require('../src/apps/platform-horst').mountApi(r), '/proposals/:id/decide');
  launches.length = 0;
  const { id, stale, fresh } = editedCard();
  for (const body of [{ decision: 'approve', view: 'full', version: stale }, { decision: 'approve', view: 'full' }]) {
    const r = await post(id, body);
    assert.notEqual(r.statusCode, 200, JSON.stringify(body));
    assert.match(JSON.stringify(r.body), /changed after it was shown/);
    pendingStill(id);
  }
  const ok = await post(id, { decision: 'approve', view: 'full', version: fresh });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.proposal.status, 'executed');
  assert.equal(launches.length, 1);
});

test('Mini App: a stale or missing version is refused; the current one is approved', async () => {
  const post = routeOf((r) => require('../src/apps/platform-miniapp').mountApi(r), '/proposals/:id/decide');
  launches.length = 0;
  const { id, stale, fresh } = editedCard();
  for (const body of [{ decision: 'approve', version: stale }, { decision: 'approve' }]) {
    const r = await post(id, body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.match(r.body.error, /changed after it was shown/);
    pendingStill(id);
  }
  const ok = await post(id, { decision: 'approve', version: fresh });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.proposal.status, 'executed');
  assert.equal(launches.length, 1);
});

test('Telegram: the Approve button carries the version; a card sent before an edit is refused', async () => {
  const platformHorst = require('../src/apps/platform-horst');
  const miniapp = require('../src/apps/platform-miniapp');
  const realUrl = miniapp.miniAppUrl;
  miniapp.miniAppUrl = () => null;   // no Mini App: Approve stays in chat
  try {
    launches.length = 0;
    const p = governance.createProposal(KIND, spec('run the tests'), { origin: 'chat' });
    const approveOf = (q) => platformHorst.proposalButtons(q).inline_keyboard.flat().find((b) => /:approve:/.test(b.callback_data || '')).callback_data;
    const sent = approveOf(p);
    assert.equal(sent, `horst_prop:${p.id}:approve:${governance.payloadVersion(p)}`);
    assert.ok(Buffer.byteLength(sent) <= 64, 'fits Telegram\'s callback_data limit');
    const edited = governance.updateProposal(p.id, spec('run the tests and deploy'), 'miniapp');
    // platform-telegram's handler: horst_prop:<id>:<decision>:<version>.
    const tap = (data) => { const [, id, decision, version] = data.split(':'); return platformHorst.decideProposal(id, decision, 'telegram', { version: version ?? null }); };
    await assert.rejects(tap(sent), /changed after it was shown/);
    await assert.rejects(tap(`horst_prop:${p.id}:approve`), /changed after it was shown/, 'a pre-version card');
    pendingStill(p.id);
    // notifyUpdate re-renders text and keyboard together: the refreshed card approves.
    assert.equal((await tap(approveOf(edited))).status, 'executed');
    assert.equal(launches.length, 1);
    const handler = fs.readFileSync(path.join(__dirname, '../src/apps/platform-telegram.js'), 'utf8');
    assert.match(handler, /const \[, id, decision, version\] = data\.split\(':'\);[\s\S]{0,300}decideProposal\(id, decision, 'telegram', \{ version: version \?\? null \}\)/);
  } finally { miniapp.miniAppUrl = realUrl; }
});

test('an app: a stale version is refused (ctx and bridge); the current one is approved', async () => {
  executed.length = 0;
  const { proposal } = await ctx.propose('shop:thing', { n: 1 });
  const stale = proposal.version || governance.payloadVersion(proposal);
  const edited = governance.updateProposal(proposal.id, { n: 2 }, 'ui');
  await assert.rejects(ctx.decide(proposal.id, 'approve', { version: stale }), /changed after it was shown/);
  await assert.rejects(bridge('governance.decide', { id: proposal.id, decision: 'approve', version: stale }), /changed after it was shown/);
  pendingStill(proposal.id);
  const listed = (await ctx.list({ status: 'pending' })).find((x) => x.id === proposal.id);
  assert.equal(listed.version, edited.version, 'list carries the version to render');
  assert.equal((await ctx.decide(proposal.id, 'approve', { version: listed.version })).status, 'executed');
  assert.deepEqual(executed, [{ n: 2 }]);
});

test('the Horst tab and the Mini App send the version their render shows (structural)', () => {
  const horst = fs.readFileSync(path.join(__dirname, '../public/horst/horst.js'), 'utf8');
  assert.match(horst, /data-decide="approve" data-version="\$\{escHtml\(p\.version \|\| ''\)\}"/, 'full card / queue');
  assert.match(horst, /data-decide="approve" data-pid="\$\{escHtml\(r\.id\)\}" data-version="\$\{escHtml\(r\.version\)\}"/, 'timeline row');
  assert.match(horst, /JSON\.stringify\(\{ decision: btn\.dataset\.decide, view, version \}\)/);
  assert.match(horst, /JSON\.stringify\(\{ decision: btn\.dataset\.decide, version: btn\.dataset\.version \}\)/);
  const vista = fs.readFileSync(path.join(__dirname, '../public/vista/vista.js'), 'utf8');
  assert.match(vista, /data-version="' \+ esc\(p\.version \|\| ''\) \+ '"/);
  assert.match(vista, /body: \{ decision: decision, version: version \}/);
});
