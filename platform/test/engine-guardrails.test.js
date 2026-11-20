// The guardrail walk: a refusal must be reachable from EVERY entry point, not
// just the governed one.
//
// This is the test phase 8A exists to make possible. Before it, every send
// guardrail lived on the `email.send` governance kind's `validate`. Below it,
// `emailEngine.send()` checked one thing (`if (!account) throw`), and the two
// callers that skip the kind checked almost nothing: `ctx.email.send` checked
// nothing at all, and the Bridge checked `account` and `to`. So the platform's
// own invariant — one implementation, many entry points — held for lifecycle,
// for spend and for the perimeter, but not for the single most dangerous act
// the platform performs.
//
// The table below is shared. Each case is asserted three times: through the ctx
// member an in-process app calls, through the Bridge method an iframe calls,
// and through the kind's validate at the freeze point. A guardrail added to one
// path and not the others fails here, which is the point.
const test = require('node:test');
const assert = require('node:assert/strict');

const capabilities = require('../src/apps/capabilities');
// The Bridge resolves its methods through the capability registry; calling the
// resolved handler directly is the same code path an iframe reaches.
const bridgeSend = () => capabilities.dispatch('email.send');
const emailEngine = require('../src/apps/email-engine');

const ctx = capabilities.buildCtx({ name: 'guardrail-probe', dir: __dirname, manifest: {} });
const emailCap = capabilities.all().find((c) => c.key === 'email');
const sendKind = emailCap.horst.kinds['email.send'];

// A payload that passes every guardrail, so each case below differs from the
// baseline in exactly one way.
const ok = () => ({
  account: 'me@example.com',
  to: 'you@example.com',
  subject: 'Quarterly numbers',
  body: 'Attached.',
});

// [name, mutation, expected message fragment]
const REFUSALS = [
  ['a missing account is refused', (p) => { delete p.account; }, /payload requires account/],
  ['a missing recipient is refused', (p) => { delete p.to; }, /payload requires to/],
  ['a missing subject is refused', (p) => { delete p.subject; }, /payload requires subject/],
  ['a missing body is refused', (p) => { delete p.body; }, /payload requires body/],
  ['a blank subject is refused', (p) => { p.subject = '   '; }, /payload requires subject/],

  // Header injection. A reply subject is derived from the parent message, so
  // these are untrusted-input cases, not typos.
  ['a line break in the subject cannot inject a header', (p) => { p.subject = 'Hi\r\nBcc: attacker@evil.test'; }, /line break/],
  ['a line break in the recipient cannot inject a header', (p) => { p.to = 'you@example.com\nBcc: attacker@evil.test'; }, /line break/],
  ['a line break in cc cannot inject a header', (p) => { p.cc = 'a@b.test\r\nBcc: c@d.test'; }, /line break/],
  ['a line break in bcc cannot inject a header', (p) => { p.bcc = 'a@b.test\r\nX-Evil: 1'; }, /line break/],
  ['a line break in the account cannot inject a header', (p) => { p.account = 'me@example.com\r\nX: 1'; }, /line break/],
  ['a line break in In-Reply-To cannot inject a header', (p) => { p.inReplyTo = '<a@x>\r\nX: 1'; }, /line break/],
  ['a line break in References cannot inject a header', (p) => { p.references = '<a@x>\r\nX: 1'; }, /line break/],

  // Attachments.
  ['a non-array attachments field is refused', (p) => { p.attachments = 'file.pdf'; }, /must be an array/],
  ['an attachment without a filename is refused', (p) => { p.attachments = [{ base64Data: 'AAAA' }]; }, /requires a filename/],
  ['an attachment without data is refused', (p) => { p.attachments = [{ filename: 'a.pdf' }]; }, /has no data/],
  ['an attachment with non-base64 data is refused', (p) => { p.attachments = [{ filename: 'a.pdf', base64Data: 'not base64!' }]; }, /valid base64/],
  ['an attachment with a CRLF contentType is refused', (p) => { p.attachments = [{ filename: 'a.pdf', base64Data: 'AAAA', contentType: 'text/plain\r\nX: 1' }]; }, /invalid contentType/],
  ['too many attachments are refused', (p) => { p.attachments = Array.from({ length: 26 }, (_, i) => ({ filename: `a${i}.txt`, base64Data: 'AAAA' })); }, /too many attachments/],
  ['an oversized attachment is refused', (p) => { p.attachments = [{ filename: 'big.bin', base64Data: 'A'.repeat(34 * 1024 * 1024) }]; }, /too large/],

  // The recompose assertion: what is sent must equal what was composed.
  ['a composed reply with no htmlBody is refused', (p) => { p.replyText = 'Thanks!'; }, /requires an htmlBody/],
  ['an empty replyText is refused', (p) => { p.replyText = '   '; p.htmlBody = '<p>x</p>'; }, /non-empty string/],
  ['a non-boolean includeSignature is refused', (p) => { p.replyText = 'Thanks!'; p.htmlBody = '<p>x</p>'; p.includeSignature = 'yes'; }, /must be a boolean/],
];

function payloadFor(mutate) {
  const p = ok();
  mutate(p);
  return p;
}

for (const [name, mutate, expected] of REFUSALS) {
  test(`ctx.email.send: ${name}`, async () => {
    await assert.rejects(() => ctx.email.send(payloadFor(mutate)), expected);
  });

  test(`Bridge email.send: ${name}`, async () => {
    await assert.rejects(
      () => bridgeSend()({ name: 'guardrail-probe' }, payloadFor(mutate)),
      expected,
    );
  });

  test(`email.send kind: ${name}`, () => {
    assert.throws(() => sendKind.validate(payloadFor(mutate)), expected);
  });
}

// The composed-reply assertion needs a real render to disagree with, so it is
// built rather than mutated: recompose() the sources, then corrupt the body.
test('a composed body that disagrees with its own sources is refused on every path', async () => {
  const compose = require('../src/apps/email-compose');
  const composed = compose.recompose({
    ...ok(),
    replyText: 'Sounds good — Tuesday works.',
    htmlBody: '<p>placeholder</p>',
  });
  assert.equal(composed.composeVersion, compose.COMPOSE_VERSION);

  // Untouched, it passes the assertion (it may still fail later, on the unknown
  // account — that is a different guardrail, asserted below).
  assert.doesNotThrow(() => {
    try { sendKind.validate(composed); } catch (err) {
      if (/disagrees with its own sources/.test(err.message)) throw err;
    }
  });

  const tampered = { ...composed, body: `${composed.body}\n\nPS: wire the money to 1234.` };
  const expected = /disagrees with its own sources/;
  assert.throws(() => sendKind.validate(tampered), expected);
  await assert.rejects(() => ctx.email.send(tampered), expected);
  await assert.rejects(
    () => bridgeSend()({ name: 'guardrail-probe' }, tampered),
    expected,
  );
});

// accountType used to fall through to 'gmail' for any address without IMAP
// credentials, so a removed or typo'd account surfaced as an opaque Google
// token error. On the send path it is now refused by name.
test('an unknown account is refused by name, not sent to Gmail', () => {
  assert.equal(emailEngine.accountType('nobody@example.com'), 'gmail', 'sync callers keep the lenient form');
  assert.throws(
    () => emailEngine.accountType('nobody@example.com', { strict: true }),
    /unknown email account "nobody@example.com"/,
  );
});

test('an otherwise valid send still cannot leave for an unknown account', async () => {
  await assert.rejects(() => ctx.email.send(ok()), /unknown email account/);
});

// The structural half: every governance kind whose executor performs an engine
// write must have its refusals reachable from the ctx path too. Table-driven,
// so a new kind joins it by name rather than by someone remembering to.
//
// `entry` is the ctx path a surface would call for the same act. A kind listed
// with `entry: null` is one whose act has no ctx equivalent by design.
const KIND_ENTRY_POINTS = {
  'email.send': 'email.send',
  'email.rule.add': 'email.rules.add',
  'email.rule.remove': 'email.rules.remove',
  'email.tags.set': 'email.tags.set',
  'email.folder.create': 'email.createFolder',
  'calendar.move': 'calendar.move',
  // Guests are an invite's whole point; the ctx path that carries them is create.
  'calendar.invite': 'calendar.create',
  'todo.update': 'todos.update',
};

test('every governed engine write has a ctx entry point that shares its guardrails', () => {
  const kinds = capabilities.horstKinds();
  const covered = Object.keys(KIND_ENTRY_POINTS);
  for (const name of covered) {
    assert.ok(kinds[name], `${name} is in the walk table but is no longer a registered kind`);
    const entry = KIND_ENTRY_POINTS[name];
    if (entry === null) continue;
    const member = entry.split('.').reduce((o, k) => (o == null ? o : o[k]), ctx);
    assert.equal(typeof member, 'function', `${name} claims ctx entry point "${entry}", which is not callable`);
  }
});

// A sender rule on one of the owner's own addresses would trash their own mail
// as it syncs back. The refusal lives in emailEngine.addRule; the kind's
// validate calls the same assertion at the freeze point. Walked the same way
// as the send refusals: ctx, Bridge, kind.
test('a sender rule on an own address is refused on every path', async (t) => {
  const accounts = require('../src/apps/email-accounts');
  t.mock.method(accounts, 'list', () => [{ email: 'me@example.com' }]);
  const expected = /one of your own accounts/;
  const own = { type: 'sender', value: 'Me@Example.com' };
  await assert.rejects(async () => ctx.email.rules.add({ ...own }), expected);
  await assert.rejects(async () => capabilities.dispatch('email.rules.add')({ name: 'guardrail-probe' }, { ...own }, { method: 'email.rules.add' }), expected);
  assert.throws(() => emailCap.horst.kinds['email.rule.add'].validate({ ...own }), expected);
  // A domain rule on the owner's domain stays the owner's choice.
  assert.doesNotThrow(() => emailEngine.assertRuleAllowed({ type: 'domain', value: 'example.com' }));
});

test('a sender rule naming an own address never matches, even if one was stored before the guard', (t) => {
  const accounts = require('../src/apps/email-accounts');
  t.mock.method(accounts, 'list', () => [{ email: 'me@example.com' }]);
  const stale = [{ id: 'r_old', type: 'sender', value: 'me@example.com' }];
  assert.equal(emailEngine.matchSenderRule('Me <me@example.com>', stale), null);
  assert.ok(emailEngine.matchSenderRule('Other <other@example.com>', [{ id: 'r2', type: 'sender', value: 'other@example.com' }]));
});
