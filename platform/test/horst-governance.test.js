// Governance bookkeeping: who decided, and the one-time collapse of the
// duplicates the old kind-locked twin scan let through.
//
// Two claims are load-bearing here. First, `via` must survive all the way into
// the audit row: before this, every execution claimed to come from 'approval',
// so audit.json could not tell a Telegram tap from the GUI, nor a human
// approval from an unattended auto-run. Second, a collapse is NOT a decision —
// it writes no ledger row, so it can never be read back as a rejection by the
// proposer-health statistics.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const governance = require('../src/apps/governance/horst-governance');
const decisions = require('../src/apps/governance/horst-decisions');

const dirs = [];
function freshDir(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-gov-'));
  dirs.push(dir);
  if (seed) fs.writeFileSync(path.join(dir, 'proposals.json'), JSON.stringify(seed));
  return dir;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const executed = [];
governance.registerKind('g.create', {
  label: 'Governance test kind',
  ceiling: 'auto',
  defaultLevel: 'propose',
  validate() {},
  describe: (p) => `Do ${p.act}`,
  identity: (p) => (p.act ? `act:${p.act}` : null),
  execute: (p) => { executed.push(p.act); return { ok: true, summary: `did ${p.act}` }; },
});
governance.registerKind('g.fail', {
  label: 'Always fails',
  validate() {},
  describe: () => 'fail',
  identity: () => null,
  execute: () => { throw new Error('boom'); },
});

const withdrawnSeen = [];
const dir = freshDir();
governance.init({ dir, broadcaster: { broadcast() {} }, notifyWithdrawn: (p) => withdrawnSeen.push(p) });
// A migration must leave a store the invariant accepts, so assert rather than log.
governance.__setStrictInvariants(true);

const auditRows = (action) => governance.listAudit().filter((a) => a.action === action);

// --- via reaches the audit row -----------------------------------------------

test('an approval records the surface it came from, not a hardcoded "approval"', async () => {
  const p = governance.createProposal('g.create', { act: 'telegram-one' }, { origin: 'triage' });
  await governance.decide(p.id, 'approve', 'telegram');

  const row = auditRows('executed').find((a) => a.proposalId === p.id);
  assert.ok(row, 'an executed proposal must leave an audit row');
  assert.equal(row.via, 'telegram', 'via was lost between decide() and runExecutor()');
});

test('a failed execution carries its surface too', async () => {
  const p = governance.createProposal('g.fail', {}, { origin: 'triage' });
  await governance.decide(p.id, 'approve', 'miniapp').catch(() => {});

  const row = auditRows('failed').find((a) => a.proposalId === p.id);
  assert.ok(row, 'a failed execution must leave an audit row');
  assert.equal(row.via, 'miniapp');
});

test('an unattended execution is labelled auto, not approval', async () => {
  governance.setDial('g.create', 'auto');
  const res = await governance.requestAction('g.create', { act: 'unattended' }, { origin: 'cron' });
  assert.equal(res.mode, 'executed', `expected an auto run, got ${res.mode}`);

  const row = auditRows('executed').find((a) => a.proposalId === res.proposal.id);
  assert.ok(row);
  assert.equal(row.via, 'auto', 'an autonomous run must not claim a human approved it');
  governance.setDial('g.create', 'propose');
});

// --- the migration ------------------------------------------------------------

test('the boot migration keys stored proposals and collapses duplicate pendings', () => {
  // Ages must sit inside the 7-day TTL: reading the store lazily expires
  // anything older, which would mask the collapse behind an expiry.
  const now = Date.now();
  const seeded = freshDir({
    items: [
      // The proven shape: one act, two pending cards. Newest wins — it carries
      // the better extraction (and, in the live store, the converted kind).
      { id: 'p-old', kind: 'g.create', status: 'pending', payload: { act: 'x' }, createdAt: now - 5 * 60_000, summary: 'Old card' },
      { id: 'p-new', kind: 'g.create', status: 'pending', payload: { act: 'x' }, createdAt: now - 1 * 60_000, summary: 'New card' },
      { id: 'p-other', kind: 'g.create', status: 'pending', payload: { act: 'y' }, createdAt: now - 3 * 60_000, summary: 'A different act' },
      // Already answered: keyed by the backfill, but never collapsed.
      { id: 'p-done', kind: 'g.create', status: 'executed', payload: { act: 'x' }, createdAt: now - 9 * 60_000, summary: 'Done' },
      // No identity: left exactly as it was rather than guessed at.
      { id: 'p-blank', kind: 'g.create', status: 'pending', payload: {}, createdAt: now - 4 * 60_000, summary: 'Unkeyable' },
    ],
  });
  withdrawnSeen.length = 0;
  governance.init({ dir: seeded, broadcaster: { broadcast() {} }, notifyWithdrawn: (p) => withdrawnSeen.push(p) });

  const byId = Object.fromEntries(governance.listProposals({ limit: 100 }).map((p) => [p.id, p]));
  assert.equal(byId['p-new'].status, 'pending', 'the newest card for an act must survive');
  assert.equal(byId['p-old'].status, 'withdrawn', 'the older duplicate must be collapsed');
  assert.equal(byId['p-old'].supersededBy, 'p-new', 'a collapsed card must name its survivor');
  assert.ok(byId['p-old'].withdrawnAt, 'a collapse must be timestamped');
  assert.equal(byId['p-other'].status, 'pending', 'a genuinely different act must not be collapsed');
  assert.equal(byId['p-done'].status, 'executed');
  assert.equal(byId['p-done'].intentKey, 'act:x', 'decided rows are keyed too, so they can suppress a re-stage');
  assert.equal(byId['p-blank'].status, 'pending', 'an unkeyable row must be left alone');
  assert.equal(byId['p-blank'].intentKey, null);

  assert.equal(governance.listProposals({ status: 'pending', limit: 100 }).length, 3);
  assert.equal(withdrawnSeen.length, 1, 'a collapse must retire the cards it hid');
  assert.equal(withdrawnSeen[0].id, 'p-old');

  const collapsed = auditRows('collapsed');
  assert.equal(collapsed.length, 1, 'a collapse is logged, never silent');
  assert.equal(collapsed[0].proposalId, 'p-old');
  assert.match(collapsed[0].summary, /p-new/, 'the audit row must name the survivor');
});

test('a collapse is not a decision: it never reaches the ledger', () => {
  // Proposer health (step 9) reads these numbers. A collapse counted as a
  // rejection would silence a kind the owner never rejected.
  const s = decisions.stats()['g.create'];
  assert.equal(s, undefined, 'the collapsed proposal wrote a decision-ledger row');
});

test('the migration runs once', () => {
  const seeded = dirs[dirs.length - 1];
  assert.ok(fs.existsSync(path.join(seeded, 'gov-meta.json')), 'the marker file must record that the backfill ran');

  // Re-initialising the same store must not collapse anything a second time,
  // and must not re-log.
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });
  assert.equal(auditRows('collapsed').length, 1, 'the migration ran twice');
  assert.deepEqual(
    governance.listProposals({ status: 'pending', limit: 100 }).map((p) => p.id).sort(),
    ['p-blank', 'p-new', 'p-other'],
  );
});

test('a withdrawn card is not an answer — it never suppresses a fresh stage', () => {
  // "Collapsed into a sibling" must not read as "you said no". Otherwise the
  // migration would permanently silence the very act it was preserving.
  const seeded = freshDir({
    items: [
      { id: 'p-gone', kind: 'g.create', status: 'withdrawn', intentKey: 'act:z', payload: { act: 'z' }, createdAt: Date.now() - 60_000, summary: 'Collapsed earlier', supersededBy: 'p-vanished' },
    ],
  });
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });

  const fresh = governance.createProposal('g.create', { act: 'z' }, { origin: 'triage' });
  assert.notEqual(fresh.id, 'p-gone');
  assert.equal(fresh.status, 'pending', 'a withdrawn twin wrongly suppressed a new proposal');
  assert.equal(governance.listProposals({ status: 'pending', limit: 100 }).length, 1);
});

// --- withdrawing: folding a card away without answering it ---------------------

const DAY = 24 * 60 * 60 * 1000;

test('withdrawing a card retires it, loudly', () => {
  const seeded = freshDir();
  withdrawnSeen.length = 0;
  governance.init({ dir: seeded, broadcaster: { broadcast() {} }, notifyWithdrawn: (p) => withdrawnSeen.push(p) });

  const p = governance.createProposal('g.create', { act: 'fold-me' }, { origin: 'triage' });
  const out = governance.withdrawProposal(p.id, 'miniapp');

  assert.equal(out.status, 'withdrawn');
  assert.ok(out.withdrawnAt, 'a withdrawal must be timestamped');
  assert.equal(governance.listProposals({ status: 'pending', limit: 100 }).length, 0);
  assert.equal(withdrawnSeen.length, 1, 'the cards already sent for it must be retired');

  const row = auditRows('withdrawn').find((a) => a.proposalId === p.id);
  assert.ok(row, 'a withdrawal is logged, never silent');
  assert.equal(row.via, 'miniapp', 'the audit row must name the surface it came from');
});

test('a withdrawal is not a denial: it never reaches the decision ledger', () => {
  // Clearing a stale queue must not teach step 9's proposer health that the
  // kind is unwanted — that would silence a kind the owner never rejected.
  // The ledger is per-store, so this reads the ledger of THIS dir only.
  const seeded = freshDir();
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });
  const p = governance.createProposal('g.create', { act: 'no-ledger' }, { origin: 'triage' });
  governance.withdrawProposal(p.id, 'miniapp');
  assert.equal(decisions.stats()['g.create'], undefined, 'withdrawing wrote a decision-ledger row');
});

test('only a pending card can be withdrawn', async () => {
  const seeded = freshDir();
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });
  const p = governance.createProposal('g.create', { act: 'already-run' }, { origin: 'triage' });
  await governance.decide(p.id, 'approve', 'ui');
  assert.throws(() => governance.withdrawProposal(p.id, 'miniapp'), /already executed/);
});

// --- keeping one longer --------------------------------------------------------

test('extending a card pushes its expiry without rewriting its age', () => {
  const now = Date.now();
  const born = now - 6 * DAY;
  const seeded = freshDir({
    items: [{ id: 'p-old', kind: 'g.create', status: 'pending', payload: { act: 'keep' }, createdAt: born, summary: 'Nearly out of time' }],
  });
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });

  const out = governance.extendProposal('p-old', 7 * DAY, 'miniapp');
  assert.ok(out.expiresAt > Date.now() + 6 * DAY, 'the card must now outlive the default window');
  // The age chip reads createdAt. Bumping it to buy time would make the queue
  // lie about how long the owner has been sitting on the card.
  assert.equal(out.createdAt, born, 'age must keep telling the truth');
  assert.ok(auditRows('extended').some((a) => a.proposalId === 'p-old'), 'an extension is logged');
});

test('an explicit expiry beats the age rule in both directions', () => {
  const now = Date.now();
  const seeded = freshDir({
    items: [
      // 9 days old — past the 7-day default — but explicitly kept.
      { id: 'p-kept', kind: 'g.create', status: 'pending', payload: { act: 'kept' }, createdAt: now - 9 * DAY, expiresAt: now + 3 * DAY, summary: 'Kept' },
      // An hour old, but its explicit expiry has already passed.
      { id: 'p-due', kind: 'g.create', status: 'pending', payload: { act: 'due' }, createdAt: now - 60 * 60 * 1000, expiresAt: now - 1000, summary: 'Due' },
    ],
  });
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });

  const byId = Object.fromEntries(governance.listProposals({ limit: 100 }).map((p) => [p.id, p]));
  assert.equal(byId['p-kept'].status, 'pending', 'an explicit expiry must survive the age cutoff');
  assert.equal(byId['p-due'].status, 'expired', 'an explicit expiry must also be able to expire early');
});

test('an extension must be positive, and cannot make a card permanent', () => {
  const seeded = freshDir();
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });
  const p = governance.createProposal('g.create', { act: 'clamp' }, { origin: 'triage' });

  assert.throws(() => governance.extendProposal(p.id, 0, 'ui'), /positive/);
  assert.throws(() => governance.extendProposal(p.id, -DAY, 'ui'), /positive/);
  assert.throws(() => governance.extendProposal(p.id, 'soon', 'ui'), /positive/);

  const out = governance.extendProposal(p.id, 365 * DAY, 'ui');
  assert.ok(out.expiresAt <= Date.now() + 30 * DAY + 5000, 'the horizon must be capped');
});

// --- how long a question is worth asking ---------------------------------------

// Writes the marker that says "the kind-scoped TTL policy shipped at T". Every
// test below controls grandfathering through it, and skips the identity
// backfill so a seeded store is read exactly as written.
function seedPolicy(dir, from) {
  fs.writeFileSync(path.join(dir, 'gov-meta.json'), JSON.stringify({ ttlPolicyFrom: from, identityBackfillAt: 1 }));
}

test('a lifetime belongs to the kind, not to one constant', () => {
  const now = Date.now();
  const seeded = freshDir({
    items: [
      { id: 'p-todo', kind: 'todo.create', status: 'pending', payload: { title: 'Ring the dentist' }, createdAt: now - 4 * DAY, summary: 'Ring the dentist' },
      { id: 'p-rule', kind: 'email.rule.add', status: 'pending', payload: { type: 'sender', value: 'spam@x.de' }, createdAt: now - 4 * DAY, summary: 'Block spam@x.de' },
      { id: 'p-plain', kind: 'g.create', status: 'pending', payload: { act: 'default-ttl' }, createdAt: now - 4 * DAY, summary: 'Default lifetime' },
    ],
  });
  seedPolicy(seeded, now - 30 * DAY);
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });

  const byId = Object.fromEntries(governance.listProposals({ limit: 100 }).map((p) => [p.id, p]));
  assert.equal(byId['p-todo'].status, 'expired', 'a todo mined four days ago is stale (72h)');
  assert.equal(byId['p-rule'].status, 'pending', 'a mail rule is still worth answering after four days (14d)');
  assert.equal(byId['p-plain'].status, 'pending', 'a kind naming no lifetime keeps the 7-day default');
});

test('tightening a lifetime never mass-expires the queue already staged', () => {
  const now = Date.now();
  const seeded = freshDir({
    items: [
      { id: 'p-before', kind: 'todo.create', status: 'pending', payload: { title: 'Staged under the old rule' }, createdAt: now - 4 * DAY, summary: 'Old rule' },
    ],
  });
  // The policy shipped an hour ago; this card was staged four days before that,
  // when seven days was the promise. Shortening a TTL must not retroactively
  // bin a queue the owner never got the chance to read.
  seedPolicy(seeded, now - 60 * 60 * 1000);
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });

  assert.equal(governance.getProposal('p-before').status, 'pending',
    'a card staged under the old rule was expired by the new one');
});

test('a calendar card expires no later than its own event', () => {
  const now = Date.now();
  const dateOnly = (ms) => new Date(ms).toISOString().slice(0, 10);
  const seeded = freshDir({
    items: [
      { id: 'p-past', kind: 'calendar.create', status: 'pending', createdAt: now - 60_000, summary: 'Event already gone',
        payload: { title: 'Dentist', date: dateOnly(now - 2 * DAY), startTime: '09:00' } },
      { id: 'p-future', kind: 'calendar.create', status: 'pending', createdAt: now - 60_000, summary: 'Event ahead',
        payload: { title: 'Dentist', date: dateOnly(now + 3 * DAY), startTime: '09:00' } },
    ],
  });
  seedPolicy(seeded, now - 30 * DAY);
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });

  // Both cards are a minute old, so the age rule would keep them both — only
  // the event date separates them. Approving an appointment that already
  // happened would write a lie into the calendar.
  assert.equal(governance.getProposal('p-past').status, 'expired', 'an event in the past is not worth asking about');
  assert.equal(governance.getProposal('p-future').status, 'pending');
});

// --- a proposer that should stop asking -----------------------------------------

async function denyRun(kind, n, tag) {
  for (let i = 0; i < n; i++) {
    const p = governance.createProposal(kind, { act: `${tag}-${i}` }, { origin: 'triage' });
    await governance.decide(p.id, 'deny', 'ui');
  }
}

test('a kind you keep rejecting stops asking — loudly', async () => {
  const seeded = freshDir();
  const announced = [];
  governance.init({
    dir: seeded,
    broadcaster: { broadcast() {} },
    notifyProposerHealth: (kind, health) => announced.push({ kind, health }),
  });
  await denyRun('g.create', 8, 'reject');

  const out = await governance.requestAction('g.create', { act: 'ninth' }, { checkFirst: true, origin: 'triage' });
  assert.equal(out.mode, 'suppressed');
  assert.equal(out.reason, 'proposer-unhealthy');
  assert.equal(governance.listProposals({ status: 'pending', limit: 100 }).length, 0, 'the card still reached the queue');

  const row = auditRows('suppressed').find((a) => /stopped staging/.test(a.summary || ''));
  assert.ok(row, 'a suppression is always an audit row, never silence');
  assert.equal(announced.length, 1, 'the host must be told, so it can reach the owner in chat');
  assert.equal(announced[0].kind, 'g.create');
});

test('the rule waits for evidence before silencing anything', async () => {
  const seeded = freshDir();
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });
  await denyRun('g.create', 7, 'few');

  const out = await governance.requestAction('g.create', { act: 'still-asking' }, { checkFirst: true, origin: 'triage' });
  assert.equal(out.mode, 'proposed', 'seven denials is not yet a pattern — this guards the test above from passing vacuously');
});

test('a proposal the owner asked for is never suppressed by proposer health', async () => {
  const seeded = freshDir();
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });
  await denyRun('g.create', 9, 'direct');

  // No checkFirst: createProposal is the "you asked for this" path, and it must
  // stay reachable however poor the kind's record is. Health suppresses a
  // PROPOSER, never a capability.
  const p = governance.createProposal('g.create', { act: 'i-asked' }, { origin: 'chat' });
  assert.equal(p.status, 'pending');
});

test('proposer health can be switched off', async () => {
  const seeded = freshDir();
  governance.init({ dir: seeded, broadcaster: { broadcast() {} }, proposerHealthOn: () => false });
  await denyRun('g.create', 9, 'off');

  const out = await governance.requestAction('g.create', { act: 'ask-anyway' }, { checkFirst: true, origin: 'triage' });
  assert.equal(out.mode, 'proposed', 'the owner asked to keep being asked');
});

test('a reversibility claim survives both registrars', () => {
  // The plan's likeliest silent failure: both registrars copy def fields
  // EXPLICITLY, so a field they forget degrades with no error anywhere. Here
  // that would strip the only justification an autonomous default has.
  governance.registerPlatformKinds({
    'demo.reversible': {
      label: 'x', ceiling: 'auto+notify', defaultLevel: 'auto+notify',
      validate() {}, describe: () => 'x', execute() {}, idempotent: true,
    },
  });
  assert.equal(governance.kindDef('demo.reversible').idempotent, true, 'the platform registrar dropped idempotent');

  governance.registerKind('claim', { execute() {}, undo: true, idempotent: true, ceiling: 'auto' }, { app: 'demo' });
  const appKind = governance.kindDef('demo:claim');
  assert.equal(appKind.undo, true, 'the app registrar dropped undo');
  assert.equal(appKind.idempotent, true, 'the app registrar dropped idempotent');
  assert.equal(appKind.defaultLevel, 'propose', 'an app kind must never grant itself an autonomous default');
});

test('an expired card cannot be kept alive after the fact', () => {
  const now = Date.now();
  const seeded = freshDir({
    items: [{ id: 'p-lapsed', kind: 'g.create', status: 'pending', payload: { act: 'lapsed' }, createdAt: now - 9 * DAY, summary: 'Lapsed' }],
  });
  governance.init({ dir: seeded, broadcaster: { broadcast() {} } });
  // Reading the store expired it first — extending must not resurrect it.
  assert.throws(() => governance.extendProposal('p-lapsed', 7 * DAY, 'miniapp'), /already expired/);
});

// --- the freeze point: compose runs BEFORE validate ---------------------------
//
// The reply composer in the Horst modal edits ONE field — `replyText` — and
// posts the whole payload back, stale `body`/`htmlBody` and all. It cannot do
// otherwise: only the server owns `renderParts`, so the browser has no way to
// stitch the two MIME parts itself.
//
// That only works because `freeze` runs `def.compose` before `def.validate`.
// Swap the two lines and email.send's "composed body disagrees with its own
// sources" assertion fires on every edit — a failure that no unit test of
// either half would catch, because each half is correct on its own.
const capabilities = require('../src/apps/capabilities');
const compose = require('../src/apps/email-compose');
governance.registerPlatformKinds(capabilities.horstKinds());

const PARENT = {
  from: 'Anna Beck <anna@example.com>',
  subject: 'Rechnung 4711',
  date: '2026-09-09T10:04:00Z',
  messageId: '<parent@example.com>',
  account: 'me@example.com',
  body: 'Hallo,\n\nkönnen Sie die Rechnung 4711 bis Freitag prüfen?\n\nGrüße\nAnna',
};

function draftPayload() {
  return {
    account: 'me@example.com',
    to: 'anna@example.com',
    ...compose.composeReply(PARENT, {
      replyText: 'Ich schaue es mir an.',
      signatureText: 'Hans Peter',
      signatureHtml: '<strong>Hans Peter</strong>',
      includeSignature: true,
    }),
  };
}

test('an edited replyText is recomposed before it is validated', () => {
  governance.init({ dir: freshDir(), broadcaster: { broadcast() {} } });
  const p = governance.createProposal('email.send', draftPayload(), { origin: 'triage' });
  const staleBody = p.payload.body;

  // Exactly what the composer posts: a new replyText beside the OLD rendered
  // parts. Validate would refuse this payload as handed to it.
  const edited = governance.updateProposal(p.id, {
    ...p.payload,
    replyText: 'Ich überweise den Betrag bis Freitag.',
  });

  assert.match(edited.payload.body, /Ich überweise den Betrag bis Freitag\./);
  assert.match(edited.payload.htmlBody, /Ich überweise den Betrag bis Freitag\./);
  assert.notEqual(edited.payload.body, staleBody, 'the stale rendering was stored verbatim');
  assert.doesNotMatch(edited.payload.body, /Ich schaue es mir an\./, 'the old draft survived into the body');
  // The trail and the signature are untouched: one field was edited, one
  // changed. What gets sent is what the editor showed.
  assert.match(edited.payload.body, /^> Hallo,$/m);
  assert.match(edited.payload.body, /Hans Peter/);
});

test('the signature toggle is a boolean the server acts on, not a body the browser sends', () => {
  governance.init({ dir: freshDir(), broadcaster: { broadcast() {} } });
  const p = governance.createProposal('email.send', draftPayload(), { origin: 'triage' });

  const off = governance.updateProposal(p.id, { ...p.payload, includeSignature: false });
  assert.doesNotMatch(off.payload.body, /Hans Peter/);
  assert.doesNotMatch(off.payload.htmlBody, /Hans Peter/);
});

test('a body posted beside a replyText is overwritten, not trusted', () => {
  governance.init({ dir: freshDir(), broadcaster: { broadcast() {} } });
  const p = governance.createProposal('email.send', draftPayload(), { origin: 'triage' });

  // A composed reply's rendered parts are OUTPUT. A surface that posts its own
  // body alongside the sources loses it at the freeze point — there is no path
  // from the browser to the wire that skips renderParts.
  const out = governance.updateProposal(p.id, {
    ...p.payload,
    body: 'Überweisen Sie an DE00 1111',
    htmlBody: '<p>Überweisen Sie an DE00 1111</p>',
  });

  assert.doesNotMatch(out.payload.body, /DE00 1111/);
  assert.doesNotMatch(out.payload.htmlBody, /DE00 1111/);
  assert.match(out.payload.body, /Ich schaue es mir an\./, 'the payload\u2019s own sources should have won');
});

// --- the edit reaches the ledger ----------------------------------------------
//
// The hole this closes: an app surface whose only way to honour an owner's edit
// was to dismiss the proposal and perform the act itself. That loses the whole
// decision — the ledger learns nothing, and the proposer keeps drafting the
// thing the owner keeps rewriting. Editing THROUGH the proposal writes ONE row
// that says both "approved" and "but not as drafted".
test('an edited approval lands in the ledger as one row carrying the diff', async () => {
  governance.init({ dir: freshDir(), broadcaster: { broadcast() {} } });
  const p = governance.createProposal('email.send', draftPayload(), { origin: 'triage' });

  governance.updateProposal(p.id, {
    ...p.payload,
    replyText: 'Ich überweise den Betrag bis Freitag.',
  }, 'app:my-dashboard');
  // The send itself fails here (no such account) — irrelevant: a decision is
  // recorded because it was made, not because it worked out.
  await governance.decide(p.id, 'approve', 'app:my-dashboard');

  const [row] = decisions.list({ kind: 'email.send' });
  assert.equal(row.proposalId, p.id);
  assert.equal(row.decision, 'approve');
  assert.equal(row.via, 'app:my-dashboard', 'the surface that decided is part of the record');
  assert.equal(row.edited, true);
  assert.deepEqual(row.editedFields, ['replyText'], 'body/htmlBody are recomputed, not edits');

  const diff = row.editDiff.find((d) => d.field === 'replyText');
  assert.match(diff.before, /Ich schaue es mir an\./);
  assert.match(diff.after, /Ich überweise den Betrag bis Freitag\./);

  // One decision, not two: nothing dismissed the proposal and acted beside it.
  assert.equal(decisions.list({ kind: 'email.send' }).length, 1);
});

// --- the ledger answers "what happened to this message?" ----------------------
//
// The app that renders an inbox wants an approved/denied chip beside each
// message. Until now the only way to get one was to record every approval a
// second time, in a table of its own — which then outlived nothing, because the
// ledger is the durable copy and the app's was the one that drifted. The row
// carries the source message, so the read exists where the decisions already do.
test('a decision is findable by the message it was about', async () => {
  governance.init({ dir: freshDir(), broadcaster: { broadcast() {} } });
  const source = { type: 'email', account: 'me@example.com', uid: '4711', subject: 'Rechnung 4711', from: 'anna@example.com' };

  const approved = governance.createProposal('email.send', draftPayload(), { origin: 'triage', source });
  await governance.decide(approved.id, 'approve', 'ui');
  const denied = governance.createProposal('email.send', { ...draftPayload(), subject: 'Nope' }, { origin: 'triage', source });
  await governance.decide(denied.id, 'deny', 'telegram');
  // A decision about a different message must not leak into this one's answer.
  // A different thread as well as a different uid: the reply identity is the
  // thread anchor, so a same-thread twin would be collapsed rather than staged.
  const other = governance.createProposal('email.send', { ...draftPayload(), inReplyTo: '<other@example.com>' }, {
    origin: 'triage', source: { ...source, uid: '9999' },
  });
  await governance.decide(other.id, 'deny', 'ui');

  const byUid = decisions.bySource({ account: 'me@example.com', uids: ['4711', '1234'] });
  assert.deepEqual(Object.keys(byUid), ['4711'], 'a message with no decisions is absent, not empty');
  assert.equal(byUid['4711'].length, 2);
  // Newest first: the chip shows the latest word on the message.
  assert.equal(byUid['4711'][0].decision, 'deny');
  assert.equal(byUid['4711'][0].via, 'telegram');
  assert.equal(byUid['4711'][1].decision, 'approve');
  assert.equal(byUid['4711'][1].kind, 'email.send');

  // Mechanical fields only — an inbox badge is downstream of untrusted mail, so
  // the payload and the edit diff stay out of it (G9).
  assert.deepEqual(Object.keys(byUid['4711'][0]).sort(),
    ['at', 'decision', 'edited', 'kind', 'outcome', 'proposalId', 'summary', 'via']);

  assert.deepEqual(decisions.bySource({ account: 'someone-else@example.com', uids: ['4711'] }), {},
    'the account is part of the identity of a uid');
  assert.deepEqual(decisions.bySource({ uids: ['4711'] }), {});
  assert.deepEqual(decisions.bySource({ account: 'me@example.com', uids: [] }), {});
});

// One mail can carry two extracted events, and the owner may take one and
// refuse the other. Without the index the chips are indistinguishable, and the
// app is back to keeping its own per-event table — which is the duplication the
// ledger read exists to end.
test('two decisions about the same message stay apart when they are about different parts of it', async () => {
  governance.init({ dir: freshDir(), broadcaster: { broadcast() {} } });
  const source = { type: 'email', account: 'me@example.com', uid: '8080' };

  const first = governance.createProposal('g.create', { act: 'kickoff' }, {
    origin: 'triage', source: { ...source, eventIdx: 0 },
  });
  await governance.decide(first.id, 'approve', 'ui');
  const second = governance.createProposal('g.create', { act: 'retro' }, {
    origin: 'triage', source: { ...source, eventIdx: 1 },
  });
  await governance.decide(second.id, 'deny', 'ui');

  const rows = decisions.bySource({ account: 'me@example.com', uids: ['8080'] })['8080'];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.eventIdx, r.decision]), [[1, 'deny'], [0, 'approve']]);
});
