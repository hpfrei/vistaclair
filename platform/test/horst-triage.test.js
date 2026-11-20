// Sibling discharge — the reported incident.
//
// Approving an AI-drafted reply in Telegram left a sibling todo pending:
// "Respond to permission request…", mined from the same mail, telling the user
// to do what they had just done. The fix is that the todo and the reply are ONE
// act: a todo whose discharge is a reply carries the reply draft's identity, so
// step 1's machinery can never let both sit in the queue.
//
// `discharge` is chosen by untrusted mail content, so the G9 boundary is
// asserted here too: it can only ever collapse this inward-facing card into an
// existing one. It can never create a proposal, raise a dial, or reach an
// outward kind.
const test = require('node:test');
const assert = require('node:assert/strict');

const triage = require('../src/apps/agent/horst-triage');
const governance = require('../src/apps/governance/horst-governance');
const capabilities = require('../src/apps/capabilities');
const priorAction = require('../src/apps/governance/horst-prior-action');
const ident = require('../src/apps/governance/horst-identity');

governance.registerPlatformKinds(capabilities.horstKinds());

// The provenance triage now stamps on every mail-derived proposal. Before this,
// the stamp was only { type, account, uid } — a todo could not see the thread
// its reply draft was keyed to.
const SOURCE = {
  type: 'email',
  account: 'hp@gmx.ch',
  uid: '122',
  threadId: 'thread-abc',
  messageId: '<msg-122@example.org>',
  subject: 'Permission request',
  from: 'someone@example.org',
  date: '2026-09-08T10:00:00Z',
};

// --- the closed vocabulary ----------------------------------------------------

test('discharge is whitelisted against the closed set', () => {
  const of = (todos) => triage.deriveIntel({ todos }, {}).todos;

  assert.equal(of([{ title: 'Reply to Anna', discharge: 'reply' }])[0].discharge, 'reply');
  assert.equal(of([{ title: 'Pay invoice', discharge: 'pay' }])[0].discharge, 'pay');
  // Absent, unknown, and actively crafted all land on the inert default.
  assert.equal(of([{ title: 'Something' }])[0].discharge, 'other');
  assert.equal(of([{ title: 'Something', discharge: 'nonsense' }])[0].discharge, 'other');
  assert.equal(of([{ title: 'Something', discharge: 'calendar.create' }])[0].discharge, 'other');
  assert.equal(of([{ title: 'Something', discharge: { toString: () => 'reply' } }])[0].discharge, 'other');
});

test('the kind refuses a discharge outside the set', () => {
  const def = governance.kindDef('todo.create');
  assert.throws(() => def.validate({ title: 'x', discharge: 'email.send' }), /invalid discharge/);
  // Absent stays legal — most todos have no mail behind them at all.
  assert.doesNotThrow(() => def.validate({ title: 'x' }));
  assert.doesNotThrow(() => def.validate({ title: 'x', discharge: 'reply' }));
});

// --- one act, two representations --------------------------------------------

test('THE INCIDENT: the todo and the reply draft that discharges it are one act', () => {
  const todo = governance.kindDef('todo.create');
  const send = governance.kindDef('email.send');

  // What triage stages for the mail: a draft reply…
  const draftKey = send.identity({
    account: SOURCE.account,
    to: SOURCE.from,
    subject: `Re: ${SOURCE.subject}`,
    threadId: SOURCE.threadId,
    inReplyTo: SOURCE.messageId,
  });
  // …and the todo mined from the same mail, which replying would complete.
  const todoKey = todo.identity(
    { title: 'Respond to permission request', discharge: 'reply' },
    { source: SOURCE },
  );

  assert.equal(todoKey, draftKey, 'the sibling todo does not share the draft\'s act');
  assert.ok(todoKey.startsWith('reply:'));
});

test('the anchor is the thread, so a later mail in it does not mint a second act', () => {
  const todo = governance.kindDef('todo.create');
  const first = todo.identity({ title: 'Answer them', discharge: 'reply' }, { source: SOURCE });
  const second = todo.identity(
    { title: 'Follow up on the permission request', discharge: 'reply' },
    { source: { ...SOURCE, uid: '140', messageId: '<msg-140@example.org>', subject: 'Re: Permission request' } },
  );
  assert.equal(first, second, 'the same thread produced two acts');
});

test('only "reply" collapses into the draft; every other discharge stays a todo', () => {
  const todo = governance.kindDef('todo.create');
  for (const discharge of ['pay', 'calendar', 'other', undefined]) {
    const key = todo.identity({ title: 'Pay the invoice', dueAt: '2026-09-30', discharge }, { source: SOURCE });
    assert.ok(key.startsWith('todo:'), `discharge "${discharge}" wrongly keyed as a reply`);
  }
  // A bill and a reply raised by the same mail are two different acts.
  assert.notEqual(
    todo.identity({ title: 'Pay', discharge: 'pay' }, { source: SOURCE }),
    todo.identity({ title: 'Pay', discharge: 'reply' }, { source: SOURCE }),
  );
});

test('without thread provenance the todo falls back to its own key', () => {
  const todo = governance.kindDef('todo.create');
  const key = todo.identity(
    { title: 'Respond', discharge: 'reply' },
    { source: { type: 'email', account: 'a@b.c', uid: '9' } },
  );
  assert.ok(key.startsWith('todo:'), 'a reply key was invented without a thread to anchor it');
});

// --- G9: untrusted content decided something ---------------------------------

test('G9: a crafted discharge can only ever collapse an inward card', () => {
  const todo = governance.kindDef('todo.create');
  // Whatever the mail says, identity() returns a key in one of exactly two
  // namespaces — both inward-facing. It cannot name a calendar or rule act, and
  // being a pure string it cannot stage, execute, or raise a dial.
  for (const discharge of [...ident.DISCHARGE, 'nonsense', '../../calendar', null]) {
    const key = todo.identity({ title: 'x', discharge }, { source: SOURCE });
    assert.ok(typeof key === 'string' && key.length, `no key for discharge "${discharge}"`);
    assert.ok(/^(reply|todo):/.test(key), `discharge "${discharge}" escaped into "${key}"`);
  }
  // The worst a crafted 'reply' achieves is suppressing the mail's OWN todo:
  // the key it collapses into is anchored to that same mail's thread.
  const crafted = todo.identity({ title: 'x', discharge: 'reply' }, { source: SOURCE });
  assert.ok(crafted.includes(SOURCE.threadId), 'a crafted discharge reached beyond its own thread');
});

// --- the world check ----------------------------------------------------------

test('todos are now checked against the world before they are staged', () => {
  // The "you replied from your phone" case, which identity alone cannot reach:
  // no draft was ever staged, so there is no sibling to share an act with.
  assert.equal(priorAction.hasChecker('todo.create'), true, 'todo.create has no prior-action checker');
});

// The tag the classifier wished it had is returned for the sweep to record —
// and is the only field deriveIntel emits that no annotation ever carries.
test('suggestedTag survives only when it is new, short and a string', () => {
  const of = (raw) => triage.deriveIntel(raw, {}).suggestedTag;
  assert.equal(of({ suggestedTag: '  Insurance ' }), 'Insurance');
  assert.equal(of({ suggestedTag: 'x'.repeat(80) }).length, 40);
  assert.equal(of({ suggestedTag: ['Insurance'] }), null);
  assert.equal(of({}), null);
  // The vocabulary is empty in a test process, so any name is new; a name
  // already in it is not a suggestion (pinned by the vocab check in the code).
});

// Two sightings of one name are one proposal; a third refreshes it; a denial
// ends it. The dedupe key is the one chat produces for the same ask.
test('tag sightings become ONE config.set proposal, and a denied one never returns', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tagsight-'));
  fs.mkdirSync(path.join(tmp, '.horst'), { recursive: true });
  governance.init({ dir: path.join(tmp, '.horst'), broadcaster: { broadcast() {} } });
  triage.init({ appsDir: tmp });
  const mail = (uid, subject) => ({ account: 'hp@gmx.ch', id: uid, subject });
  const pending = () => governance.listProposals({ kind: 'config.set' }).filter((p) => p.status === 'pending');

  await triage.recordTagSighting(mail('1', 'Your policy renewal'), 'Insurance');
  assert.equal(pending().length, 0, 'one sighting is not a pattern');
  await triage.recordTagSighting(mail('2', 'Claim received'), 'insurance');
  assert.equal(pending().length, 1);
  const p = pending()[0];
  assert.equal(p.dedupeKey, 'config:email.tags:add:insurance');
  assert.equal(p.intentKey, ident.configKey(p.payload), 'the act key is the one chat would produce');
  assert.deepEqual(p.payload, { key: 'email.tags', patch: { add: [{ name: 'insurance' }] } });
  await triage.recordTagSighting(mail('3', 'Premium due'), 'Insurance');
  assert.equal(pending().length, 1, 'a third sighting refreshes, never twins');

  await governance.decide(p.id, 'deny', 'test');
  await triage.recordTagSighting(mail('4', 'Renewal reminder'), 'Insurance');
  assert.equal(pending().length, 0, 'the owner said no — it stays no');
});

test('the tags backfill writes one document per judged message, once', async () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const emailEngine = require('../src/apps/email-engine');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tagfill-'));
  fs.mkdirSync(path.join(tmp, '.horst'), { recursive: true });
  triage.init({ appsDir: tmp });
  const saved = { listAnnotations: emailEngine.listAnnotations, assignTags: emailEngine.assignTags, listLabels: emailEngine.listLabels };
  const assigned = [];
  let lists = 0;
  emailEngine.listLabels = () => [{ id: 'travel-01ab', name: 'Travel' }, { id: 'bills-3f9a', name: 'Bills' }];
  emailEngine.assignTags = async (account, uid, ids) => { assigned.push([account, uid, ids]); return { ok: true }; };
  emailEngine.listAnnotations = async () => (lists++ ? [] : [
    { account: 'a@x.test', uid: '1', data: { v: 4, labels: ['Travel', 'nobody'] }, updatedAt: new Date(1) },
    { account: 'a@x.test', uid: '2', data: { v: 4, labels: [] }, updatedAt: new Date(2) },
    { account: 'a@x.test', uid: '3', data: { v: 4, labels: ['Bills'], migratedFrom: 'x' }, updatedAt: new Date(3) },
  ]);
  try {
    assert.deepEqual(await triage.backfillTags(), { written: 1 });
    assert.deepEqual(assigned, [['a@x.test', '1', ['travel-01ab']]], 'unknown names and seeded placeholders write nothing');
    assert.deepEqual(await triage.backfillTags(), { skipped: 'done' }, 'the marker makes the second call free');
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, '.horst', 'tags-backfill.json'), 'utf8')).done, true);
  } finally {
    Object.assign(emailEngine, saved);
  }
});
