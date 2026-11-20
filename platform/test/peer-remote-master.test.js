// Remote sessions, master half (src/apps/peer-remote-master.js): frame
// validation, the core tab (with and without registerExternalSession),
// reconnect catch-up, the ask relay, billing totals, the owner gate and the
// module API — against a stubbed peer channel and core hook.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const prm = require('../src/apps/peer-remote-master');

const tick = () => new Promise((r) => setImmediate(r));
const SLAVE_SESS = '11111111-2222-4333-8444-555555555555';

// A stub channel: two linked peers, a scripted command plane.
function makeEnv({ hook = true, owner = null, listRows = null, dataHome = null, names = ['s1', 's2'] } = {}) {
  const env = { calls: [], msgs: [], registered: new Map(), frameFn: null, eventFn: null, pending: new Map(), tapFns: new Set() };
  env.dataHome = dataHome || fs.mkdtempSync(path.join(os.tmpdir(), 'vc-prm-'));
  env.s1Claude = { loggedIn: true, email: 'Owner@x.io', orgName: 'Org', remoteSessions: { enabled: true } };
  let n = 0;
  env.peerChannel = {
    fleetState: () => ({ peers: [
      { name: names[0], connected: true, claude: env.s1Claude },
      { name: names[1], connected: true, claude: null },
    ] }),
    onRemoteFrame(fn) { env.frameFn = fn; return () => { env.frameFn = null; }; },
    onEvent(fn) { env.eventFn = fn; return () => { env.eventFn = null; }; },
    async remoteCommand(peer, op, args) {
      env.calls.push({ peer, op, args });
      if (op === 'launch') return { tabId: `tab-${++n}`, sessId: SLAVE_SESS, runId: 'r1' };
      if (op === 'list') return listRows ? listRows() : [];
      if (op === 'history') return { events: [{ sessId: SLAVE_SESS, runId: 'r1', ts: 5, off: 0, ev: { sdk: { type: 'assistant', message: { content: [] } } } }, { ev: { bogus: 1 } }], hasMore: false, before: null, totals: { costUsd: 1 } };
      if (op === 'todo') return { todo: '| id |', notes: 'n' };
      return {};
    },
  };
  prm.init({
    broadcaster: {
      broadcast: (m) => { env.msgs.push(m); for (const fn of env.tapFns) fn(m); },
      onBroadcast: (fn) => { env.tapFns.add(fn); return () => env.tapFns.delete(fn); },
    },
    pendingQuestions: env.pending,
    registerExternalSession: hook ? (tabId, adapter) => { env.registered.set(tabId, adapter); return () => env.registered.delete(tabId); } : undefined,
    isOwnerConnection: owner || undefined,
    // Hermetic: never this machine's own Claude login. The cached status names
    // no email yet, so the account comes from claudeAuthInfo.
    claudeStatus: () => ({ loggedIn: true, authMethod: null, email: null, orgName: null }),
    claudeAuthInfo: () => ({ hasSubscription: true, email: 'owner@x.io', orgName: 'Org' }),
    dataHome: env.dataHome,
    peerChannel: env.peerChannel,
  });
  env.frame = (peer, f) => env.frameFn(peer, f);
  env.ops = (op) => env.calls.filter((c) => c.op === op);
  env.done = (keep = false) => { prm.shutdown(); if (!keep) fs.rmSync(env.dataHome, { recursive: true, force: true }); };
  return env;
}

const spec = { mode: 'simple', app: 'notes', prompt: 'do it', auth: 'subscription', title: 'Notes fix' };

test('frames: bad, oversized and unknown frames are dropped and counted', () => {
  const env = makeEnv();
  const before = prm._drops.total;
  assert.equal(prm.validateFrame(null), null);
  assert.equal(prm.validateFrame({ t: 'rs:shell', cmd: 'rm -rf /' }), null);
  assert.equal(prm.validateFrame({ t: 'rs:event', tabId: 'a', ev: { sdk: { type: 'x', s: 'y'.repeat(200 * 1024) } } }), null);
  assert.equal(prm.validateFrame({ t: 'rs:event', tabId: '../../etc/passwd', ev: { sdk: { type: 'x' } } }), null);
  assert.equal(prm.validateFrame({ t: 'rs:event', tabId: 'a', ev: { sdk: { type: 'x' }, user: { text: 'y' } } }), null);
  assert.equal(prm.validateFrame({ t: 'rs:event', tabId: 'a', ev: { platform: { kind: 'exec', cmd: 'x' } } }), null);
  assert.equal(prm.validateFrame({ t: 'rs:state', tabId: 'a', state: 'pwned' }), null);
  assert.equal(prm.validateFrame({ t: 'rs:auth', problem: '<b>x</b>' }), null);
  assert.equal(prm._drops.total - before, 8);
  // Unknown fields fall away, prototype keys never survive.
  const ok = prm.validateFrame(JSON.parse('{"t":"rs:event","tabId":"a","extra":1,"ev":{"sdk":{"type":"assistant","__proto__":{"polluted":1}}}}'));
  assert.deepEqual(Object.keys(ok).sort(), ['ev', 'off', 't', 'tabId', 'ts']);
  assert.equal({}.polluted, undefined);
  assert.ok(!Object.prototype.hasOwnProperty.call(ok.ev.sdk, '__proto__'));
  // A frame from a peer that is not linked is dropped before validation.
  const d = prm._drops.total;
  env.frame('intruder', { t: 'rs:auth', problem: 'x', text: 'y' });
  assert.equal(prm._drops.total, d + 1);
  assert.equal(env.msgs.filter((m) => m.type === 'app:peer:remoteAlert').length, 0);
  env.done();
});

test('frames: path-like and HTML fields are never used as such', () => {
  // A user turn's image srcs would be master URLs: inline rasters only.
  const ev = prm.cleanEv({ user: { id: 'u', text: 'hi', images: ['/api/raw-file?path=/etc/passwd', { src: '/etc/shadow' }, 'data:image/png;base64,AAAA'] } });
  assert.deepEqual(ev.user.images, ['data:image/png;base64,AAAA']);
  const q = prm.cleanQuestion({
    id: 'x"]', type: 'number', question: '<img src=x onerror=alert(1)> ![p](/etc/passwd) [l](javascript:alert(1)) `c`',
    min: '"><script>', max: 5, defaultValue: '1" onfocus="x',
    images: ['/etc/passwd', 'https://evil/x.png', { src: 'data:image/svg+xml;base64,PHN2Zz4=' }, { src: 'data:image/gif;base64,R0lG', caption: 'c' }],
  }, 3);
  assert.equal(q.id, 'q3');
  assert.ok(!q.question.includes('<') && !/(^|[^\\])\[/.test(q.question) && !/(^|[^\\])`/.test(q.question));
  assert.equal(q.min, undefined);
  assert.equal(q.max, 5);
  assert.equal(q.defaultValue, undefined);
  assert.deepEqual(q.images, [{ src: 'data:image/gif;base64,R0lG', caption: 'c' }]);
  // A file upload would answer with master paths: a textarea instead.
  const f = prm.cleanQuestion({ type: 'file', question: 'Upload', accept: '.png' }, 0);
  assert.equal(f.type, 'textarea');
  assert.equal(f.accept, undefined);
  // Master tab ids keep to core's rule ([A-Za-z0-9._:-], ≤ 100): a lossy or long one is hashed.
  const TAB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
  assert.equal(prm.masterTabIdOf('s1', 'tab-1'), 'peer-s1:tab-1');
  for (const [p, t] of [['s1', 'a_b'], ['s_1', 'x'], ['s1', 'y'.repeat(128)], ['p'.repeat(64), 'tab:1.2']]) {
    assert.match(prm.masterTabIdOf(p, t), TAB_ID_RE);
  }
  assert.notEqual(prm.masterTabIdOf('s1', 'a_b'), prm.masterTabIdOf('s1', 'a-b'));
  assert.notEqual(prm.masterTabIdOf('s1', 'y'.repeat(128)), prm.masterTabIdOf('s1', `${'y'.repeat(127)}z`));
});

test('tab: registered with core hook, events relayed under a master sessId, closed cleanly', async () => {
  const env = makeEnv();
  const r = await prm.launch('s1', spec, { kind: 'owner' });
  assert.equal(r.tabId, 'peer-s1:tab-1');
  assert.equal(r.remoteTabId, 'tab-1');
  assert.notEqual(r.sessId, SLAVE_SESS);
  assert.match(r.sessId, /^[0-9a-f-]{36}$/);
  const launchCall = env.ops('launch')[0];
  assert.equal(launchCall.peer, 's1');
  assert.deepEqual(launchCall.args.origin, { kind: 'owner' });
  assert.deepEqual(env.ops('subscribe')[0].args, { tabId: 'tab-1', fromOff: 0 });
  const ad = env.registered.get(r.tabId);
  assert.ok(ad, 'registered as a core tab');
  assert.equal(ad.kind, 'sdk');
  assert.equal(ad.settings.externalHost, 's1');
  assert.equal(ad.settings.engine, 'sdk');
  assert.ok(ad.settings.sessionDir.startsWith(path.join(env.dataHome, 'peer-remote', r.sessId)));
  assert.equal(ad.title, '[s1] Notes fix');

  env.frame('s1', { t: 'rs:event', tabId: 'tab-1', sessId: SLAVE_SESS, runId: 'r1', off: 10, ev: { sdk: { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } } } });
  const sdk = env.msgs.filter((m) => m.type === 'sdk:event');
  assert.equal(sdk.length, 1);
  assert.equal(sdk[0].sessId, r.sessId);
  assert.equal(sdk[0].runId, undefined);
  assert.equal(sdk[0].off, 10);

  // Adapter → command plane, scoped to the slave tab.
  ad.submit('next');
  ad.interrupt();
  await ad.setModel('sonnet');
  await assert.rejects(ad.setModel('x y'));
  assert.deepEqual(await ad.setAuth('apikey', { continueTurn: true }), { auth: 'apikey', applied: 'remote' });
  await tick();
  assert.deepEqual(env.ops('submit')[0].args, { tabId: 'tab-1', text: 'next' });
  assert.equal(env.ops('interrupt').length, 1);
  assert.deepEqual(env.ops('setAuth')[0].args, { tabId: 'tab-1', auth: 'apikey', continueTurn: true });
  assert.throws(() => ad.submit('x', { images: [{}] }));

  // History is fetched from the slave and rewritten, never stored here.
  const page = await ad.historyPage({ limit: 50 });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].sessId, r.sessId);
  assert.equal(page.events[0].runId, undefined);
  assert.deepEqual(env.ops('history')[0].args, { tabId: 'tab-1', limit: 50 });
  // Cursors are numbers: a numeric string is read as one, anything else dropped.
  await ad.historyPage({ limit: '20', before: '4096' });
  await ad.historyPage({ before: 'x; rm' });
  await ad.historyPage({ before: -1 });
  await ad.historyPage({ before: 1.5 });
  assert.deepEqual(env.ops('history').slice(1).map((c) => c.args), [{ tabId: 'tab-1', limit: 20, before: 4096 }, { tabId: 'tab-1' }, { tabId: 'tab-1' }, { tabId: 'tab-1' }]);

  // TODO/NOTES mirror, then gone with the tab.
  env.frame('s1', { t: 'rs:event', tabId: 'tab-1', off: 20, ev: { platform: { kind: 'files', todo: true, notes: false } } });
  await tick(); await tick();
  const dir = ad.settings.sessionDir;
  assert.equal(fs.readFileSync(path.join(dir, 'TODO.md'), 'utf8'), '| id |');

  // Exit keeps the tab; close unregisters, kills nothing (exited), removes the mirror.
  env.frame('s1', { t: 'rs:event', tabId: 'tab-1', ev: { sdk: { type: 'result', result: 'all done' } } });
  const states = [];
  const un = prm.onState((e) => states.push(e));
  env.frame('s1', { t: 'rs:state', tabId: 'tab-1', state: 'exited', exitCode: 0, costUsd: 0.25, credential: 'subscription' });
  un();
  assert.equal(states[0].type, 'exited');
  assert.equal(states[0].costUsd, 0.25);
  assert.equal(states[0].resultText, 'all done');
  assert.ok(env.registered.has(r.tabId), 'kept until closed');
  assert.equal(prm.status(r.tabId).state, 'exited');
  assert.ok(env.msgs.some((m) => m.type === 'cli:exit' && m.tabId === r.tabId));
  ad.close();
  await tick();
  assert.ok(!env.registered.has(r.tabId));
  assert.equal(prm.status(r.tabId), null);
  assert.ok(!fs.existsSync(dir));
  assert.equal(env.ops('kill').length, 0, 'an exited session is not killed again');
  assert.equal(env.ops('unsubscribe').length, 1);
  env.done();
});

test('tab: without the core hook there is no tab, but state and cost are tracked', async () => {
  const env = makeEnv({ hook: false });
  const r = await prm.launch('s1', spec, { kind: 'horst', ref: 'card-1' });
  assert.equal(env.registered.size, 0);
  assert.equal(prm.status(r.tabId).tab, false);
  env.frame('s1', { t: 'rs:event', tabId: 'tab-1', ev: { platform: { kind: 'status', state: 'busy', costUsd: 0.1, credential: 'subscription' } } });
  assert.equal(env.msgs.filter((m) => m.type === 'sdk:event').length, 0);
  assert.equal(prm.status(r.tabId).costUsd, 0.1);
  assert.equal(prm.status(r.tabId).state, 'busy');
  await prm.kill(r.tabId);
  assert.deepEqual(env.ops('kill')[0].args, { tabId: 'tab-1' });
  await assert.rejects(prm.kill('peer-s1:nope'), { code: 'unknown-tab' });
  env.done();
});

test('reconnect: list, re-adopt and resubscribe from the last offset seen', async () => {
  let rows = [];
  const env = makeEnv({ listRows: () => rows });
  const r = await prm.launch('s1', spec, { kind: 'owner' });
  env.frame('s1', { t: 'rs:event', tabId: 'tab-1', off: 100, ev: { sdk: { type: 'assistant' } } });
  env.frame('s1', { t: 'rs:event', tabId: 'tab-1', off: 250, ev: { sdk: { type: 'assistant' } } });
  rows = [
    { tabId: 'tab-1', sessId: SLAVE_SESS, state: 'idle', title: 'Notes fix', app: 'notes', credential: 'subscription', costUsd: 0 },
    { tabId: 'w-7', sessId: SLAVE_SESS, runId: 'r1', role: 'worker', state: 'busy', title: 'worker', app: 'notes' },
    { tabId: '../x', state: 'busy' },
  ];
  env.calls.length = 0;
  env.eventFn({ type: 'disconnected', peer: 's1' });
  env.eventFn({ type: 'connected', peer: 's1' });
  await tick(); await tick();
  const subs = env.ops('subscribe').map((c) => c.args);
  assert.deepEqual(subs.find((a) => a.tabId === 'tab-1'), { tabId: 'tab-1', fromOff: 250 });
  assert.deepEqual(subs.find((a) => a.tabId === 'w-7'), { tabId: 'w-7', fromOff: 0 });
  assert.ok(env.registered.has('peer-s1:w-7'), 'a new worker tab is adopted');
  assert.equal(env.registered.get(r.tabId).sessId, r.sessId, 'the master sessId survives');
  // A tab the slave no longer lists has exited.
  rows = [];
  env.eventFn({ type: 'connected', peer: 's1' });
  await tick(); await tick();
  assert.equal(prm.status(r.tabId).state, 'exited');
  env.done();
});

test('tab: a peer no longer linked has its tabs closed and unregistered', async () => {
  const env = makeEnv();
  const r = await prm.launch('s1', spec, { kind: 'owner' });
  const r2 = await prm.launch('s2', spec, { kind: 'owner' });
  assert.ok(env.registered.has(r.tabId) && env.registered.has(r2.tabId));
  for (const fn of env.tapFns) fn({ type: 'app:fleet:state', peers: [{ name: 's2', connected: true }] });
  assert.ok(!env.registered.has(r.tabId), 'unregistered with its peer');
  assert.equal(prm.status(r.tabId), null);
  assert.ok(env.registered.has(r2.tabId), 'the linked peer keeps its tab');
  env.done();
});

test('asks: namespaced ids, no collision with a local ask, answer to the right peer, askDone cleanup', async () => {
  const env = makeEnv();
  const r = await prm.launch('s1', spec, { kind: 'owner' });
  // A master-local question that happens to hold the id the relay would use.
  let localResolved = false;
  env.pending.set('peer-s1:a1', { message: null, resolve: () => { localResolved = true; } });
  const form = { toolUseId: 'a1', formData: { title: 'Pick', questions: [{ id: 'c', question: 'Which <b>one</b>?', options: [{ label: 'A', preview: '![x](/etc/passwd)' }, { label: 'B' }] }] } };
  env.frame('s1', { t: 'rs:ask', tabId: 'tab-1', askId: 'a1', title: 'Question', forms: [form] });
  const q = env.msgs.find((m) => m.type === 'ask:question');
  assert.ok(q, 'relayed to the dashboard');
  assert.notEqual(q.askId, 'peer-s1:a1');
  assert.ok(q.askId.startsWith('peer-s1:a1'));
  assert.equal(q.title, '[s1] Question');
  assert.equal(q.host, 's1');
  assert.deepEqual(q.remote, { peer: 's1', tabId: r.tabId, sessionTitle: 'Notes fix' });
  assert.equal(q.tabId, r.tabId);
  assert.equal(q.cwd, undefined, 'no cwd: nothing resolves against the master disk');
  assert.ok(!q.forms[0].questions[0].question.includes('<b>'));
  assert.ok(!/(^|[^\\])\]\(/.test(q.forms[0].questions[0].options[0].preview), 'image syntax escaped');
  const entry = env.pending.get(q.askId);
  assert.equal(entry.host, 's1');
  assert.deepEqual(entry.remote, q.remote);
  assert.equal(entry.message, q);

  // The same askId from another peer is its own entry.
  const r2 = await prm.launch('s2', spec, { kind: 'owner' });
  env.frame('s2', { t: 'rs:ask', tabId: r2.remoteTabId, askId: 'a1', title: 'Other', forms: [form] });
  const q2 = env.msgs.filter((m) => m.type === 'ask:question')[1];
  assert.ok(q2.askId.startsWith('peer-s2:'));

  // Core's ask:answer resolves the entry → the answer goes to s1 only, with the slave's id.
  entry.resolve([{ id: 'c', question: 'Which?', answer: 'A' }]);
  await tick();
  const ans = env.ops('answer');
  assert.equal(ans.length, 1);
  assert.equal(ans[0].peer, 's1');
  assert.deepEqual(ans[0].args, { askId: 'a1', answer: [{ id: 'c', question: 'Which?', answer: 'A' }] });
  assert.ok(!env.pending.has(q.askId));
  assert.ok(!localResolved);
  assert.ok(env.pending.has('peer-s1:a1'), 'the local question is untouched');

  // s1's askDone cannot touch s2's entry; s2's removes it and dismisses it.
  env.frame('s1', { t: 'rs:askDone', askId: 'a1' });
  assert.ok(env.pending.has(q2.askId));
  env.frame('s2', { t: 'rs:askDone', askId: 'a1' });
  assert.ok(!env.pending.has(q2.askId));
  assert.ok(env.msgs.some((m) => m.type === 'ask:answered' && m.askId === q2.askId));
  assert.ok(env.pending.has('peer-s1:a1'));

  // Module API answer.
  env.frame('s1', { t: 'rs:ask', tabId: 'tab-1', askId: 'a2', title: 'Again', forms: [{ ...form, toolUseId: 'a2' }] });
  const q3 = env.msgs.filter((m) => m.type === 'ask:question').pop();
  await prm.answer(q3.askId, [{ id: 'c', question: '', answer: 'B' }]);
  await tick();
  assert.deepEqual(env.ops('answer').pop().args.askId, 'a2');
  await assert.rejects(prm.answer('peer-s1:a1', []), { code: 'unknown-ask' });
  env.done();
});

test('billing: per-peer totals per credential, usage-limit hits, same account', async () => {
  const env = makeEnv();
  await prm.launch('s1', spec, { kind: 'owner' });
  const status = (costUsd, credential) => env.frame('s1', { t: 'rs:event', tabId: 'tab-1', ev: { platform: { kind: 'status', state: 'busy', costUsd, credential } } });
  status(0.5, 'api-key');
  status(1.0, 'api-key');
  status(1.5, 'subscription');
  env.frame('s1', { t: 'rs:event', tabId: 'tab-1', ev: { platform: { kind: 'usage-limit', text: 'limit', apiKey: true } } });
  const s1 = prm.sessionsState().peers.find((p) => p.peer === 's1');
  assert.deepEqual(s1.totals, { apiKeyUsd: 1, subscriptionUsd: 0.5, limitHits: 1 });
  assert.equal(s1.sameAccount, true);
  assert.equal(s1.claude.remoteSessions.enabled, true);
  assert.equal(prm.sessionsState().peers.find((p) => p.peer === 's2').sameAccount, null);
  assert.equal(prm.sameAccount({ email: 'a@x.io', orgName: 'O' }, { email: 'b@x.io', orgName: 'O' }), false);
  env.done();
});

test('owner gate: launch refused from a non-owner connection, allowed from the owner', async () => {
  const ws = {};
  let env = makeEnv({ owner: () => false });
  const sent = [];
  assert.equal(await prm.handleWs(ws, { type: 'app:peer:session:launch', reqId: 'q', peer: 's1', ...spec }, (m) => sent.push(m)), true);
  assert.equal(sent[0].type, 'app:peer:session:launchResult');
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].code, 'not-owner');
  assert.equal(env.ops('launch').length, 0);
  assert.equal(await prm.handleWs(ws, { type: 'app:peer:session:kill', tabId: 'x' }, (m) => sent.push(m)), true);
  assert.equal(sent[1].code, 'not-owner');
  env.done();

  env = makeEnv({ owner: (c) => c === ws });
  sent.length = 0;
  await prm.handleWs(ws, { type: 'app:peer:session:launch', reqId: 'q', peer: 's1', ...spec }, (m) => sent.push(m));
  assert.equal(sent[0].ok, true);
  assert.equal(sent[0].tabId, 'peer-s1:tab-1');
  assert.deepEqual(env.ops('launch')[0].args.origin, { kind: 'owner' });
  await prm.handleWs(ws, { type: 'app:peer:session:launch', peer: 'nobody', ...spec }, (m) => sent.push(m));
  assert.equal(sent[1].code, 'unknown-peer');
  await prm.handleWs(ws, { type: 'app:peer:session:launch', peer: 's1', ...spec, mode: 'root' }, (m) => sent.push(m));
  assert.equal(sent[2].code, 'bad-args');
  await prm.handleWs(ws, { type: 'app:peer:session:list' }, (m) => sent.push(m));
  assert.equal(sent[3].type, 'app:peer:sessions:state');
  assert.equal(await prm.handleWs(ws, { type: 'app:peer:list' }, () => {}), false, 'other app:peer:* pass through');
  env.done();
});

test('no bus or Horst emission; rs:auth is one dashboard alert', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'peer-remote-master.js'), 'utf8');
  assert.ok(!/require\([^)]*(horst|governance|agent\/)/i.test(src), 'no Horst/bus/governance require');
  const bus = require('../src/apps/agent/horst-events');
  const published = [];
  const orig = bus.publish;
  bus.publish = (...a) => { published.push(a); return orig.apply(bus, a); };
  try {
    const env = makeEnv();
    await prm.launch('s1', spec, { kind: 'owner' });
    env.frame('s1', { t: 'rs:event', tabId: 'tab-1', ev: { sdk: { type: 'result', result: 'SECRET slave text' } } });
    env.frame('s1', { t: 'rs:ask', tabId: 'tab-1', askId: 'a9', title: 't', forms: [{ toolUseId: 'a9', formData: { questions: [{ question: 'q' }] } }] });
    env.frame('s1', { t: 'rs:auth', problem: 'logged-out', text: 'Claude is not signed in', extra: 'x' });
    env.frame('s1', { t: 'rs:state', tabId: 'tab-1', state: 'exited', exitCode: 1 });
    assert.equal(published.length, 0);
    const types = new Set(env.msgs.map((m) => m.type));
    for (const t of types) assert.ok(['sdk:event', 'ask:question', 'ask:answered', 'cli:exit', 'app:peer:remoteAlert', 'app:peer:session:notice', 'app:peer:sessions:state'].includes(t), t);
    const alerts = env.msgs.filter((m) => m.type === 'app:peer:remoteAlert');
    assert.deepEqual(alerts, [{ type: 'app:peer:remoteAlert', peer: 's1', problem: 'logged-out', text: 'Claude is not signed in' }]);
    assert.ok(!JSON.stringify(prm.sessionsState()).includes('SECRET'), 'the dashboard summary carries no transcript text');
    env.done();
  } finally {
    bus.publish = orig;
  }
});

test('alerts: the last auth alert per peer survives a reload and a restart until dismissed or signed in again', async () => {
  let env = makeEnv();
  const alertOf = (peer) => prm.sessionsState().peers.find((p) => p.peer === peer).alert;
  assert.equal(alertOf('s1'), null);
  // Core's own reason has an underscore.
  env.frame('s1', { t: 'rs:auth', problem: 'authentication_failed', text: 'Sign in again <b>now</b>', extra: 1 });
  const a = alertOf('s1');
  assert.equal(a.problem, 'authentication_failed');
  assert.equal(a.text, 'Sign in again <b>now</b>', 'plain text; the UI renders it with textContent');
  assert.equal(typeof a.at, 'number');
  assert.deepEqual(Object.keys(a).sort(), ['at', 'problem', 'text']);
  assert.equal(alertOf('s2'), null);
  env.frame('s1', { t: 'rs:auth', problem: 'x'.repeat(41), text: 'dropped' });
  assert.equal(alertOf('s1').problem, 'authentication_failed');

  // A restart: a new init over the same data dir.
  const dataHome = env.dataHome;
  env.done(true);
  env = makeEnv({ dataHome });
  assert.equal(alertOf('s1').problem, 'authentication_failed');

  // Dismiss: owner only.
  env.done(true);
  env = makeEnv({ dataHome, owner: () => false });
  const sent = [];
  assert.equal(await prm.handleWs({}, { type: 'app:peer:remoteAlert:dismiss', peer: 's1' }, (m) => sent.push(m)), true);
  assert.equal(sent[0].code, 'not-owner');
  assert.ok(alertOf('s1'));
  env.done(true);
  env = makeEnv({ dataHome });
  await prm.handleWs({}, { type: 'app:peer:remoteAlert:dismiss', peer: 's1' }, (m) => sent.push(m));
  assert.deepEqual(sent[1], { type: 'app:peer:remoteAlert:dismissResult', ok: true, peer: 's1', dismissed: true });
  assert.equal(alertOf('s1'), null);
  env.done(true);
  env = makeEnv({ dataHome });
  assert.equal(alertOf('s1'), null, 'the dismissal is persisted');

  // A slave still reporting loggedIn keeps it; signed out then in again clears it.
  env.frame('s1', { t: 'rs:auth', problem: 'authentication_failed', text: 't' });
  const fleet = () => ({ type: 'app:fleet:state', peers: env.peerChannel.fleetState().peers });
  for (const fn of env.tapFns) fn(fleet());
  assert.ok(alertOf('s1'));
  env.s1Claude.loggedIn = false;
  for (const fn of env.tapFns) fn(fleet());
  assert.ok(alertOf('s1'), 'still signed out');
  env.s1Claude.loggedIn = true;
  for (const fn of env.tapFns) fn(fleet());
  assert.equal(alertOf('s1'), null, 'a fresh sign-in clears it');
  env.done();
});

// ---------------------------------------------------------------------------
// A malicious slave (security review F1 F2 F3 F6 F7 F13 F14 F19): every frame
// below is an attack; each test asserts it is neutralised.
// ---------------------------------------------------------------------------

// Every string inside a value, with its key.
function strings(v, key = null, out = []) {
  if (typeof v === 'string') out.push([key, v]);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, key, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, k, out);
  return out;
}

const XSS = '<img src=x onerror=alert(1)>';

test('attack F1: HTML in text, thinking, deltas, tool io and history reaches the SDK panel escaped', async () => {
  const env = makeEnv();
  const r = await prm.launch('s1', spec, { kind: 'owner' });
  const ev = (sdk) => env.frame('s1', { t: 'rs:event', tabId: 'tab-1', ev: { sdk } });
  ev({ type: 'assistant', message: { id: 'm1', content: [
    { type: 'text', text: `a < b && c ${XSS} "q" 'x' [click](javascript:alert(1)) [k](JavaScript\\:x)` },
    { type: 'thinking', thinking: `<script>alert(1)</script>` },
    { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: `echo ${XSS}`, description: '<b>x</b>' } },
  ] } });
  ev({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: XSS } } });
  ev({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: XSS } } });
  ev({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: XSS } } });
  ev({ type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: `{"command":"echo ${XSS}"}` } } });
  ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: XSS }] }, { type: 'text', text: XSS }] } });
  ev({ type: 'result', result: `<b>done</b>` });
  const out = env.msgs.filter((m) => m.type === 'sdk:event').map((m) => m.ev);
  assert.equal(out.length, 7);
  for (const [key, s] of strings(out)) {
    assert.ok(!/[<>]/.test(s), `${key}: ${s}`);
    if (key !== 'partial_json') assert.ok(!/["']/.test(s), `${key}: ${s}`);
    assert.ok(!/(java|vb)script\\?:/i.test(s), `${key}: ${s}`);
  }
  const text = out[0].sdk.message.content[0].text;
  assert.ok(text.startsWith('a &lt; b &amp;&amp; c &lt;img src=x onerror=alert(1)&gt; &quot;q&quot; &#39;x&#39;'), 'entities, which markdown reads as the characters');
  assert.equal(out[0].sdk.message.content[2].name, 'Bash');
  assert.equal(out[0].sdk.type, 'assistant', 'the structure core reads is kept');
  // partial_json still parses, and the value is escaped.
  assert.equal(JSON.parse(out[4].sdk.event.delta.partial_json).command, 'echo &lt;img src=x onerror=alert(1)&gt;');
  // The master's own copy of the result stays plain text (the agent's lastText).
  const states = [];
  const un = prm.onState((e) => states.push(e));
  env.frame('s1', { t: 'rs:state', tabId: 'tab-1', state: 'exited', exitCode: 0 });
  un();
  assert.equal(states[0].resultText, '<b>done</b>');

  // A history page: the same escaping.
  env.peerChannel.remoteCommand = async (peer, op) => (op === 'history'
    ? { events: [{ ts: 1, off: 0, ev: { sdk: { type: 'assistant', message: { content: [{ type: 'text', text: XSS }, { type: 'thinking', thinking: XSS }] } } } }] }
    : {});
  const page = await env.registered.get(r.tabId).historyPage({});
  assert.deepEqual(page.events[0].ev.sdk.message.content.map((b) => b.text || b.thinking), ['&lt;img src=x onerror=alert(1)&gt;', '&lt;img src=x onerror=alert(1)&gt;']);
  env.done();
});

test('attack F2: a showIf that breaks out of its single-quoted attribute is dropped; ask fields keep safe shapes', () => {
  const breakout = { questionId: 'zz', notEquals: "a' style='position:fixed;inset:0' onmouseover='alert(1)' x='" };
  const f = prm.validateFrame({ t: 'rs:ask', tabId: 't1', askId: 'a1', forms: [{ formData: { questions: [
    { id: 'q1', type: 'text', question: 'x', showIf: breakout },
    { id: 'q2', type: 'text', question: 'x', showIf: { questionId: 'q1', equals: 'Yes', onmouseover: 'x', nested: { a: 1 } } },
    { id: 'q3', type: 'text', question: 'x', showIf: { questionId: "q1' x='", equals: 'a' } },
    { id: 'q4', type: 'text', question: 'x', showIf: { questionId: 'q1', equals: { toString: 'x' } } },
    { id: 'q5', type: 'toggle', question: 'x', showIf: { questionId: 'q1', notEquals: false } },
    { id: 'q6', type: 'text', question: 'x', showIf: { questionId: 'q1', includes: 'a&#39;b' } },
    { id: 'q7', type: 'text', question: 'x', showIf: { questionId: 'q1', equals: 'y'.repeat(101) } },
  ] } }] });
  const qs = f.forms[0].questions;
  assert.deepEqual(qs.map((q) => q.showIf), [undefined, { questionId: 'q1', equals: 'Yes' }, undefined, undefined, { questionId: 'q1', notEquals: false }, undefined, undefined]);
  // As core builds the attribute (escHtml leaves ' alone): never a quote inside.
  for (const q of qs) if (q.showIf) assert.ok(!JSON.stringify(q.showIf).includes("'"));
  // The other attribute-bound fields: ids by rule, numbers finite, the rest text core escapes.
  const q = prm.cleanQuestion({ id: "x' y", type: 'number', question: 'n', min: "1' x='", max: 2, step: 0.5, defaultValue: '3', placeholder: 'p\u0000', options: [{ label: 'a\u0007"' }] }, 0);
  assert.equal(q.id, 'q0');
  assert.equal(q.min, undefined);
  assert.equal(q.defaultValue, undefined);
  assert.equal(q.placeholder, 'p');
  assert.equal(q.options[0].label, 'a"');
});

test('attack F3: a peer named "prod" cannot reach "prod-2"\'s tab or question through look-alike ids', async () => {
  const env = makeEnv({ names: ['prod-2', 'prod'] });
  const honest = await prm.launch('prod-2', spec, { kind: 'orchestrator', ref: 'run-1' });  // its tab-1
  const evil = await prm.launch('prod', spec, { kind: 'owner' });                          // its tab-2
  assert.notEqual(prm.masterTabIdOf('prod', '2:tab-1'), honest.tabId);
  assert.notEqual(prm.masterTabIdOf('prod', '2-tab-1'), honest.tabId);
  // Injective over a spread of look-alikes.
  const ids = new Set();
  const pairs = [];
  for (const p of ['prod', 'prod-2', 'prod-', 'p', 'Prod', 'prod:2', 'a'.repeat(41)]) {
    for (const t of ['tab-1', '2-tab-1', '2:tab-1', ':tab-1', '-2-tab-1', 'x'.repeat(128), `${'x'.repeat(127)}y`, '.a']) pairs.push([p, t]);
  }
  for (const [p, t] of pairs) {
    const id = prm.masterTabIdOf(p, t);
    assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/);
    ids.add(id);
  }
  assert.equal(ids.size, pairs.length);

  // (a) events, (b) exit, (c) result text, (d) cost — aimed at prod-2's tab.
  for (const tabId of ['2:tab-1', '2-tab-1']) {
    env.frame('prod', { t: 'rs:event', tabId, ev: { sdk: { type: 'assistant', message: { content: [{ type: 'text', text: 'forged' }] } } } });
    env.frame('prod', { t: 'rs:event', tabId, ev: { platform: { kind: 'status', state: 'busy', costUsd: 99, credential: 'api-key' } } });
    env.frame('prod', { t: 'rs:event', tabId, ev: { sdk: { type: 'result', result: 'forged result' } } });
    env.frame('prod', { t: 'rs:state', tabId, state: 'exited', exitCode: 1 });
  }
  const hs = prm.status(honest.tabId);
  assert.equal(hs.running, true);
  assert.equal(hs.costUsd, 0);
  assert.equal(env.msgs.filter((m) => m.type === 'sdk:event' && m.sessId === honest.sessId).length, 0);
  assert.deepEqual(prm.sessionsState().peers.find((p) => p.peer === 'prod-2').totals, { apiKeyUsd: 0, subscriptionUsd: 0, limitHits: 0 });

  // (e) prod-2's question cannot be replaced, dismissed or answered by prod.
  const form = (q, id) => [{ toolUseId: id, formData: { questions: [{ id: 'q1', type: 'text', question: q }] } }];
  env.frame('prod-2', { t: 'rs:ask', tabId: 'tab-1', askId: 'a1', forms: form('honest question', 'a1') });
  const hq = env.msgs.find((m) => m.type === 'ask:question');
  env.frame('prod', { t: 'rs:ask', tabId: evil.remoteTabId, askId: '2:a1', forms: form('ATTACKER question', '2:a1') });
  env.frame('prod', { t: 'rs:ask', tabId: evil.remoteTabId, askId: '2-a1', forms: form('ATTACKER question', '2-a1') });
  env.frame('prod', { t: 'rs:askDone', askId: 'a1' });
  const entry = env.pending.get(hq.askId);
  assert.equal(entry.host, 'prod-2');
  assert.equal(entry.formData.questions[0].question, 'honest question');
  entry.resolve([{ id: 'q1', question: '', answer: 'owner secret' }]);
  await tick();
  assert.deepEqual(env.ops('answer').map((c) => [c.peer, c.args.askId]), [['prod-2', 'a1']]);
  env.done();
});

test('attack F6: asks for unknown tabs are dropped; 5000 asks stay capped per tab and per peer', async () => {
  const env = makeEnv();
  const form = [{ formData: { questions: [{ id: 'q', type: 'text', question: 'spam' }] } }];
  const before = prm._drops.byReason['unknown-tab'] || 0;
  for (let i = 0; i < 50; i++) env.frame('s1', { t: 'rs:ask', tabId: 'nope', askId: `x${i}`, forms: form });
  assert.equal(env.pending.size, 0);
  assert.equal(env.msgs.filter((m) => m.type === 'ask:question').length, 0, 'no modal opens');
  assert.equal(prm._drops.byReason['unknown-tab'] - before, 50);

  const t = [];
  for (let i = 0; i < 6; i++) t.push(await prm.launch('s1', spec, { kind: 'owner' }));
  for (let i = 0; i < 5000; i++) env.frame('s1', { t: 'rs:ask', tabId: t[i % 6].remoteTabId, askId: `a${i}`, forms: form });
  await tick();
  assert.ok(env.pending.size <= 20, `${env.pending.size} pending`);
  assert.equal(prm._sizes('s1').asks, env.pending.size);
  for (const x of t) assert.ok([...env.pending.values()].filter((e) => e.ctx.tabId === x.tabId).length <= 5);
  // The newest survive; the evicted were cancelled to the slave and dismissed.
  assert.ok(env.pending.has(prm.masterTabIdOf('s1', 'a4999')));
  const cancels = env.ops('answer').filter((c) => c.args.answer[0].id === '_cancelled');
  assert.equal(cancels.length, 5000 - env.pending.size);
  assert.ok(env.msgs.some((m) => m.type === 'ask:answered' && m.askId === prm.masterTabIdOf('s1', 'a0')));
  env.done();
});

test('attack F7: list adopts only launched tabs and their run, capped; forced resyncs are rate-limited', async () => {
  let rows = [];
  const env = makeEnv({ listRows: () => rows });
  await tick();
  const r = await prm.launch('s1', spec, { kind: 'orchestrator', ref: 'run-9' });  // tab-1, run r1
  rows = [
    { tabId: 'tab-1', runId: 'r1', state: 'busy' },
    ...Array.from({ length: 199 }, (_, i) => ({ tabId: `plant-${i}`, runId: i < 100 ? 'r1' : `other-${i}`, state: 'busy' })),
  ];
  env.eventFn({ type: 'connected', peer: 's1' });
  await tick(); await tick();
  const mine = prm.sessionsState().peers.find((p) => p.peer === 's1').sessions;
  assert.equal(mine.length, 50, 'capped per peer');
  assert.ok(mine.every((s) => s.runId === 'r1'), 'only the launched run\'s members');
  assert.ok(mine.filter((s) => s.tabId !== r.tabId).every((s) => s.origin?.ref === 'run-9'));
  assert.ok(!env.registered.has(prm.masterTabIdOf('s1', 'plant-150')));

  // A flood of `started` for unknown tabs inside the gap of the list s2's
  // connect ran: no list now (one is left for the gap's end).
  env.calls.length = 0;
  for (let i = 0; i < 500; i++) env.frame('s2', { t: 'rs:state', tabId: `u${i}`, state: 'started' });
  for (let i = 0; i < 500; i++) env.frame('s2', { t: 'rs:event', tabId: `u${i}`, ev: { sdk: { type: 'x' } } });
  await tick();
  assert.equal(env.ops('list').length, 0);
  assert.equal(prm.sessionsState().peers.find((p) => p.peer === 's2').sessions.length, 0, 's2 launched nothing: nothing adopted');
  env.done();
});

test('attack F7: a restart re-adopts what this master launched; stale mirror folders are removed', async () => {
  let rows = [];
  let env = makeEnv({ listRows: () => rows });
  const r = await prm.launch('s1', spec, { kind: 'orchestrator', ref: 'run-3' });
  const dataHome = env.dataHome;
  const stale = path.join(dataHome, 'peer-remote', '0a1b2c3d-0000-4000-8000-000000000000');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'TODO.md'), 'x');
  env.done(true);
  rows = [{ tabId: r.remoteTabId, runId: 'r1', state: 'busy' }, { tabId: 'w-1', runId: 'r1', state: 'busy' }, { tabId: 'stray', state: 'busy' }];
  env = makeEnv({ dataHome, listRows: () => rows });
  assert.ok(!fs.existsSync(stale));
  await tick(); await tick();
  const sessions = prm.sessionsState().peers.find((p) => p.peer === 's1').sessions;
  assert.deepEqual(sessions.map((s) => s.remoteTabId).sort(), [r.remoteTabId, 'w-1']);
  assert.deepEqual(sessions.find((s) => s.remoteTabId === r.remoteTabId).origin, { kind: 'orchestrator', ref: 'run-3' });
  env.done();
});

test('attack F13 / F14: autolinks in relayed ask text are broken; closed tabs are capped and forgotten with the peer', async () => {
  const t = prm.mdText('see https://evil.example/x, HTTP://e.io and www.evil.example or WWW.x.io');
  assert.ok(!/:\/\//.test(t) && !/www\./i.test(t), t);
  assert.ok(t.includes('https&#58;//evil.example/x') && t.includes('www&#46;evil.example'), 'reads the same as an entity');
  const q = prm.cleanQuestion({ question: 'go to https://x.io', options: [{ label: 'a', description: 'www.x.io', preview: 'http://y.io' }] }, 0);
  assert.ok(!/:\/\/|www\./.test(JSON.stringify(q)));

  const env = makeEnv();
  for (let i = 0; i < 205; i++) {
    const r = await prm.launch('s1', spec, { kind: 'owner' });
    env.registered.get(r.tabId).close();
  }
  assert.equal(prm._sizes('s1').closed, 200);
  assert.equal(prm._sizes('s1').launched, 200);
  for (const fn of env.tapFns) fn({ type: 'app:fleet:state', peers: [{ name: 's2', connected: true }] });
  assert.deepEqual(prm._sizes('s1'), { closed: 0, launched: 0, asks: 0 });
  env.done();
});

test('attack F19: a slave error message is one plain line before it is logged or returned', async () => {
  const env = makeEnv();
  env.peerChannel.remoteCommand = async () => {
    throw Object.assign(new Error('refused\n[peer-remote] forged log line\u001b[31m\r x'), { code: 'bad code\n' });
  };
  const sent = [];
  await prm.handleWs({}, { type: 'app:peer:session:launch', reqId: 'q', peer: 's1', ...spec }, (m) => sent.push(m));
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].code, 'error');
  assert.equal(sent[0].error, 'refused [peer-remote] forged log line[31m x');
  env.done();
});

test('attack F7: a gated resync still runs at the gap\'s end, so a new run member is adopted', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let rows = [];
  const env = makeEnv({ listRows: () => rows });
  await prm.launch('s1', spec, { kind: 'owner' });   // tab-1, run r1
  rows = [{ tabId: 'tab-1', runId: 'r1', state: 'busy' }, { tabId: 'w-2', runId: 'r1', state: 'busy' }];
  env.calls.length = 0;
  for (let i = 0; i < 20; i++) env.frame('s1', { t: 'rs:state', tabId: 'w-2', state: 'started' });
  await tick();
  assert.equal(env.ops('list').length, 0, 'inside the gap');
  t.mock.timers.tick(5000);
  await tick(); await tick();
  assert.equal(env.ops('list').length, 1, 'one list for the whole flood');
  assert.ok(prm.status(prm.masterTabIdOf('s1', 'w-2')), 'the member is adopted');
  env.done();
});
