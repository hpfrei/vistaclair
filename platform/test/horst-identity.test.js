// Act identity — the guarantee that Horst cannot stage the same act twice.
//
// The live store produced every case tested here: three calendar.update rows
// sharing one dedupeKey (a create converted in place, then re-staged because the
// twin scan was kind-locked), one appointment staged from three different emails,
// and one event executed three times. The regression at the centre of this file
// is that conversion no longer destroys identity.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ident = require('../src/apps/governance/horst-identity');
const governance = require('../src/apps/governance/horst-governance');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-ident-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Stub kinds standing in for the real calendar pair: same shape, no engine.
// 'test.create' and 'test.update' deliberately share an identity namespace the
// way a create and the update it converts into must.
const executed = [];
governance.registerKind('test.create', {
  label: 'Test create',
  validate(p) { if (!p.title) throw new Error('payload requires title'); },
  describe: (p) => `Create ${p.title}`,
  identity: (p) => ident.calendarKey({ account: p.account, title: p.title, date: p.date, startTime: p.startTime }),
  execute: (p) => { executed.push(p.title); return { ok: true, summary: `made ${p.title}` }; },
});
governance.registerKind('test.update', {
  label: 'Test update',
  validate(p) { if (!p.eventId) throw new Error('payload requires eventId'); },
  describe: (p) => `Update ${p.eventId}`,
  identity: (p) => ident.objectKey('testupd', { account: p.account, id: p.eventId }),
  execute: () => ({ ok: true, summary: 'updated' }),
});
governance.registerKind('test.nokey', {
  label: 'Unidentifiable',
  describe: () => 'no identity',
  execute: () => ({ ok: true }),
});

governance.init({ dir, broadcaster: { broadcast() {} } });
governance.__setStrictInvariants(true);

const pending = () => governance.listProposals({ status: 'pending', limit: 100 });
const reset = () => fs.writeFileSync(path.join(dir, 'proposals.json'), JSON.stringify({ items: [] }));

// --- the key builders --------------------------------------------------------

test('identity collapses the same act across the emails that mentioned it', () => {
  // The live case: "Physiotherapy 2026-08-18 13:30" staged from uid 9308 and
  // again from uid 9322. Different derivations, one appointment.
  const a = ident.calendarKey({ account: 'hp@gmx.ch', title: 'Physiotherapy', date: '2026-08-18', startTime: '13:30' });
  const b = ident.calendarKey({ account: 'hp@gmx.ch', title: 'physiotherapy', date: '2026-08-18', startTime: '13:30' });
  assert.equal(a, b);
  assert.equal(a, 'cal:hp@gmx.ch:physiotherapy:2026-08-18:13:30');
});

test('identity separates acts that genuinely differ', () => {
  const base = { account: 'a@b.c', title: 'Physio', date: '2026-08-18', startTime: '13:30' };
  const keys = new Set([
    ident.calendarKey(base),
    ident.calendarKey({ ...base, date: '2026-08-20' }),      // the next appointment in a series
    ident.calendarKey({ ...base, startTime: '14:30' }),      // same day, different slot
    ident.calendarKey({ ...base, startTime: null }),         // all-day, not 00:00
    ident.calendarKey({ ...base, account: 'other@b.c' }),    // a different calendar
  ]);
  assert.equal(keys.size, 5);
});

test('normalisation folds accents, punctuation and reply prefixes', () => {
  assert.equal(ident.normTitle('Re: Fwd: AW: Café Müller!!'), 'cafe-muller');
  assert.equal(ident.normTitle('Re[2]: Rechnung 4711'), 'rechnung-4711');
});

test('a reply is keyed to the thread, not to the message', () => {
  const viaThread = ident.replyKey({ account: 'a@b.c', threadId: 't-1', subject: 'Rechnung' });
  const viaReply = ident.replyKey({ account: 'a@b.c', threadId: 't-1', subject: 'Re: Rechnung' });
  assert.equal(viaThread, viaReply);
  // Subject is only the fallback anchor when the mail carries no thread id.
  assert.equal(ident.replyKey({ account: 'a@b.c', subject: 'Re: Rechnung' }), 'reply:a@b.c:rechnung');
});

test('a recurring todo is a new act each period', () => {
  const sep = ident.todoKey({ account: 'a@b.c', title: 'Pay rent', dueAt: '2026-09-01' });
  const oct = ident.todoKey({ account: 'a@b.c', title: 'Pay rent', dueAt: '2026-10-01T09:00' });
  assert.notEqual(sep, oct);
});

test('a sender rule and a whole-domain rule are different acts', () => {
  assert.notEqual(ident.ruleKey({ type: 'sender', value: 'x@y.de' }), ident.ruleKey({ type: 'domain', value: 'x@y.de' }));
});

test('an unidentifiable payload yields null, never a throw', () => {
  assert.equal(ident.calendarKey({ account: 'a', title: '', date: '2026-01-01' }), null);
  assert.equal(ident.calendarKey({ account: 'a', title: 'x', date: null }), null);
  assert.equal(ident.objectKey('caldel', { account: 'a', id: '' }), null);
});

// --- the registrars: the likeliest silent failure ----------------------------

test('BOTH registrars carry identity through to the kind def', () => {
  // Both copy def fields explicitly, with no spread. Dropping `identity` from
  // either would disable dedupe everywhere with no error anywhere — so assert
  // it survives registration rather than trusting the copy.
  assert.equal(typeof governance.kindDef('test.create').identity, 'function', 'registerKind dropped identity');

  const capabilities = require('../src/apps/capabilities');
  const platform = capabilities.horstKinds();
  governance.registerPlatformKinds(platform);
  for (const name of ['calendar.create', 'email.send', 'email.rule.add']) {
    assert.equal(typeof governance.kindDef(name).identity, 'function', `registerPlatformKinds dropped identity for ${name}`);
  }
  // And every capability kind declares the key one way or the other (check #20).
  for (const [name, def] of Object.entries(platform)) {
    assert.ok('identity' in def, `capability kind ${name} declares no identity`);
  }
});

test('the real calendar and email kinds identify their acts', () => {
  const cal = governance.kindDef('calendar.create');
  const one = cal.identity({ account: 'a@b.c', title: 'Physio', date: '2026-08-10', startTime: '14:30' });
  const two = cal.identity({ account: 'a@b.c', title: 'Re: Physio', date: '2026-08-10', startTime: '14:30' });
  assert.equal(one, two);

  // A create and a delete of the same event must never share a key, or denying
  // the create would suppress the delete.
  assert.notEqual(one, governance.kindDef('calendar.delete').identity({ account: 'a@b.c', eventId: 'e1' }));

  const send = governance.kindDef('email.send');
  assert.equal(
    send.identity({ account: 'a@b.c', threadId: 'th1', subject: 'Invoice' }),
    send.identity({ account: 'a@b.c', threadId: 'th1', subject: 'Re: Invoice' }),
  );
});

// --- staging: one pending card per act ---------------------------------------

test('the same act staged twice yields one pending proposal', () => {
  reset();
  const payload = { account: 'a@b.c', title: 'Physio', date: '2026-08-10', startTime: '14:30' };
  const first = governance.createProposal('test.create', payload, { origin: 'triage', dedupeKey: 'cal:a:1:0' });
  // A second email, a different derivation — the same appointment.
  const second = governance.createProposal('test.create', { ...payload }, { origin: 'triage', dedupeKey: 'cal:a:2:0' });
  assert.equal(second.id, first.id, 'a second card was staged for one act');
  assert.equal(pending().length, 1);
});

test('REGRESSION: a converted proposal is still found as its own twin', () => {
  // The proven bug. A calendar.create whose event turns out to exist is
  // converted in place to calendar.update; the old scan required p.kind === kind,
  // so the converted row was invisible and every later pass staged a fresh
  // duplicate — three identical rows in the live store.
  reset();
  const payload = { account: 'a@b.c', title: 'Standup', date: '2026-09-12', startTime: '10:00' };
  const created = governance.createProposal('test.create', payload, {
    origin: 'triage',
    prior: { state: 'partial', label: 'Already in your calendar', suggest: { kind: 'test.update', payload: { account: 'a@b.c', eventId: 'ev-1' } } },
  });
  assert.equal(created.kind, 'test.update', 'the prior verdict did not convert the proposal');
  assert.ok(created.intentKey.startsWith('cal:'), 'conversion must not recompute intentKey');

  const again = governance.createProposal('test.create', { ...payload }, { origin: 'triage' });
  assert.equal(again.id, created.id, 'the converted twin was invisible — the duplicate bug is back');
  assert.equal(pending().length, 1);
  // The converted form is the better one: its payload must survive untouched.
  assert.equal(again.kind, 'test.update');
  assert.equal(again.payload.eventId, 'ev-1', 'a bare create payload overwrote the converted update');
});

test('an executed act is not staged again', () => {
  reset();
  const payload = { account: 'a@b.c', title: 'Physio', date: '2026-08-10', startTime: '14:30' };
  return governance.decide(governance.createProposal('test.create', payload, { origin: 'triage' }).id, 'approve')
    .then(() => {
      assert.deepEqual(executed, ['Physio']);
      const again = governance.createProposal('test.create', { ...payload }, { origin: 'triage' });
      assert.equal(again.status, 'executed');
      assert.equal(pending().length, 0, 'an already-executed act was staged again');
      const row = governance.listAudit().find((a) => a.action === 'suppressed');
      assert.ok(row, 'suppression must leave an audit row, never silence');
    });
});

test('a denied act is not asked again', () => {
  reset();
  const payload = { account: 'a@b.c', title: 'Dentist', date: '2026-08-11', startTime: '09:00' };
  return governance.decide(governance.createProposal('test.create', payload, { origin: 'triage' }).id, 'deny')
    .then(() => {
      governance.createProposal('test.create', { ...payload }, { origin: 'triage' });
      assert.equal(pending().length, 0, '"no" is an answer — it must not be re-asked');
    });
});

test('an explicit chat request is never suppressed', () => {
  reset();
  const payload = { account: 'a@b.c', title: 'Lunch', date: '2026-08-12', startTime: '12:00' };
  return governance.decide(governance.createProposal('test.create', payload, { origin: 'triage' }).id, 'deny')
    .then(() => {
      // The user asked for it by name; they get a card whatever the history says.
      const asked = governance.createProposal('test.create', { ...payload }, { origin: 'chat' });
      assert.equal(asked.status, 'pending');
      assert.equal(pending().length, 1);
    });
});

test('a kind with no identity keeps its old behaviour', () => {
  reset();
  const a = governance.createProposal('test.nokey', { n: 1 }, { origin: 'triage' });
  const b = governance.createProposal('test.nokey', { n: 2 }, { origin: 'triage' });
  assert.notEqual(a.id, b.id);
  assert.equal(pending().length, 2, 'unidentifiable kinds must not be collapsed');
});

// --- the invariant -----------------------------------------------------------

test('saveProposals refuses a store with two pending proposals per act', () => {
  reset();
  const key = 'cal:a@b.c:physio:2026-08-10:14:30';
  fs.writeFileSync(path.join(dir, 'proposals.json'), JSON.stringify({
    items: [
      { id: 'p-1', kind: 'test.create', status: 'pending', intentKey: key, payload: {}, createdAt: Date.now() },
      { id: 'p-2', kind: 'test.create', status: 'pending', intentKey: key, payload: {}, createdAt: Date.now() },
    ],
  }));
  // Any write at all must trip it — the invariant lives in the single write path,
  // not at the call sites that could forget it.
  assert.throws(
    () => governance.createProposal('test.nokey', { n: 3 }, { origin: 'triage' }),
    /invariant violated/,
  );
  reset();
});
