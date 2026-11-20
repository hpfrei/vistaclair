// A reply staged from chat is composed by code, not by the model: the subject,
// the threading headers, the quoted trail and the sending account come off the
// parent message. The model contributes replyText and nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');

const emailEngine = require('../src/apps/email-engine');
const horst = require('../src/apps/platform-horst');

// Patch the engine's exports in place — platform-horst holds this same object
// and resolves the methods at call time.
const PARENT = {
  id: '6736',
  account: 'hp@issogood.com',
  from: '"Nadine Schommer" <nadineschommer@gmail.com>',
  to: '"HP" <hp@issogood.com>',
  subject: 'Re: Samedan',
  messageId: '<parent-abc@gmail.com>',
  threadId: 'thread-1',
  date: 'Thu, 10 Sep 2026 05:49:21 GMT',
  body: 'Bun di Hans-Peter\n\nDie Miete betraegt CHF 2600.\n\nGruesse\nNadine',
  htmlBody: '',
  headers: [
    { name: 'Message-ID', value: '<parent-abc@gmail.com>' },
    { name: 'References', value: '<root-1@issogood.com>' },
  ],
};

function stubEngine({ parent = PARENT, signature = 'Hans-Peter' } = {}) {
  emailEngine.isReady = () => true;
  emailEngine.accountSettings = () => ({ signature, signatureHtml: '' });
  emailEngine.getEmail = async ({ uid }) => (String(uid) === String(parent.id) ? parent : null);
}

const stage = (payload) => horst.composeChatReply(payload, { origin: 'chat', summary: 's' });

test('a chat reply derives subject, threading and the quoted trail from the parent', async () => {
  stubEngine();
  const { payload, meta } = await stage({
    account: 'hp@issogood.com',
    replyToUid: '6736',
    replyText: 'Danke Nadine — die Zahlung geht morgen raus.',
  });

  // Threading: the model supplied none of these.
  assert.equal(payload.inReplyTo, '<parent-abc@gmail.com>');
  assert.match(payload.references, /<root-1@issogood\.com>/);
  assert.match(payload.references, /<parent-abc@gmail\.com>/);
  assert.equal(payload.threadId, 'thread-1');

  // Subject is derived, not typed — and not double-prefixed.
  assert.equal(payload.subject, 'Re: Samedan');
  assert.equal(payload.to, '"Nadine Schommer" <nadineschommer@gmail.com>');

  // The quoted original is present, with attribution, in both MIME parts.
  assert.match(payload.quotedText, /^> Bun di Hans-Peter/m);
  assert.match(payload.quoteAttribution, /Nadine Schommer/);
  assert.ok(payload.quoteSha256, 'quote is fingerprinted');
  assert.match(payload.body, /Danke Nadine/);
  assert.match(payload.body, /^> Die Miete betraegt CHF 2600\./m);
  assert.match(payload.htmlBody, /Danke Nadine/);

  // The model's words survive verbatim, and the RFC 3676 signature sits
  // between the reply and the quoted trail — not after it.
  assert.equal(payload.replyText, 'Danke Nadine — die Zahlung geht morgen raus.');
  assert.equal(payload.includeSignature, true);
  assert.match(payload.body, /\n-- \nHans-Peter\n/);
  assert.ok(payload.body.indexOf('\n-- \n') < payload.body.indexOf('> Bun di Hans-Peter'));

  // Provenance gives the prior-action check a window that starts at the parent.
  assert.equal(meta.source.type, 'email');
  assert.equal(meta.source.uid, '6736');
  assert.equal(meta.source.account, 'hp@issogood.com');
  assert.equal(meta.origin, 'chat');
});

test('the reply leaves from the account the mail arrived in, not one the model named', async () => {
  // Parent lives in hp@issogood.com; the marker names a different mailbox.
  stubEngine();
  const { payload } = await stage({
    account: 'hp@hpfreilabs.com',
    replyToUid: '6736',
    replyText: 'ok',
  });
  assert.equal(payload.account, 'hp@issogood.com');
});

test('a hand-written "Re:" subject with no parent is refused', async () => {
  stubEngine();
  await assert.rejects(
    () => stage({ account: 'hp@issogood.com', to: 'nadineschommer@gmail.com', subject: 'Re: Samedan', body: 'text' }),
    /replyToUid/,
  );
});

test('a uid that resolves to a different correspondent is refused', async () => {
  stubEngine();
  await assert.rejects(
    () => stage({ account: 'hp@issogood.com', replyToUid: '6736', to: 'someone.else@example.com', replyText: 'ok' }),
    /is from nadineschommer@gmail\.com, not someone\.else@example\.com/,
  );
});

test('an unknown uid and an empty replyText are refused', async () => {
  stubEngine();
  await assert.rejects(() => stage({ account: 'hp@issogood.com', replyToUid: '9999', replyText: 'ok' }), /no message 9999/);
  await assert.rejects(() => stage({ account: 'hp@issogood.com', replyToUid: '6736', replyText: '   ' }), /replyText" is empty/);
});

test('a new-thread send passes through untouched', async () => {
  stubEngine();
  const input = { account: 'hp@issogood.com', to: 'someone@example.com', subject: 'Offer', body: 'Hello' };
  const { payload, meta } = await stage({ ...input });
  assert.deepEqual(payload, input);
  assert.equal(meta.source, undefined);
});
