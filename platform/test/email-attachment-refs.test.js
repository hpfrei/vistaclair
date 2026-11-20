// Forwarding an attachment must not mean carrying it.
//
// The app this replaces resolved "forward attachments" itself: it fetched the
// bytes inside its own proposal executor, which is why the act had to stay an
// app kind. The engine resolves them now, at send time, from a reference in the
// payload — so the proposal ledger carries a pointer, every entry point gets the
// same behaviour, and a reference that cannot be fetched refuses the send
// instead of quietly mailing a forward with nothing attached.
const test = require('node:test');
const assert = require('node:assert/strict');

const capabilities = require('../src/apps/capabilities');
const emailEngine = require('../src/apps/email-engine');

const emailCap = capabilities.all().find((c) => c.key === 'email');
const sendKind = emailCap.horst.kinds['email.send'];

const withRef = (att) => ({
  account: 'me@example.com',
  to: 'you@example.com',
  subject: 'Fwd: invoice',
  body: 'See attached.',
  attachments: [att],
});

const REF = { attachmentId: 'att-1', uid: '4711', filename: 'invoice.pdf' };

test('a reference attachment is accepted at every entry point', () => {
  // Bytes are the only shape the old validator knew; a ref would have been
  // refused as "has no data" at the freeze point, before it could be resolved.
  assert.doesNotThrow(() => emailEngine.validateSend(withRef(REF)));
  assert.doesNotThrow(() => sendKind.validate(withRef(REF)));
});

test('a ref may name its own account and content type', () => {
  assert.doesNotThrow(() => emailEngine.validateSend(withRef({
    ...REF, account: 'other@example.com', mimeType: 'application/pdf',
  })));
});

test('an attachmentId without a message is not a ref, and is refused as bytes', () => {
  assert.throws(() => emailEngine.validateSend(withRef({ attachmentId: 'att-1' })), /requires a filename/);
  assert.throws(
    () => emailEngine.validateSend(withRef({ attachmentId: 'att-1', filename: 'a.pdf' })),
    /has no data/,
  );
});

test('a ref cannot smuggle a header break through its filename', () => {
  assert.throws(
    () => emailEngine.validateSend(withRef({ ...REF, filename: 'a.pdf\r\nBcc: attacker@evil.test' })),
    /invalid filename/,
  );
});

test('refs resolve to bytes, and inline attachments pass through untouched', async () => {
  const asked = [];
  const out = await emailEngine.resolveSendAttachments('me@example.com', [
    REF,
    { filename: 'notes.txt', contentType: 'text/plain', base64Data: 'aGk=' },
  ], async (args) => {
    asked.push(args);
    return { filename: 'stored.pdf', mimeType: 'application/pdf', data: 'QUJD' };
  });
  assert.deepEqual(asked, [{ account: 'me@example.com', uid: '4711', attachmentId: 'att-1' }]);
  assert.deepEqual(out[0], { filename: 'invoice.pdf', contentType: 'application/pdf', base64Data: 'QUJD' });
  assert.deepEqual(out[1], { filename: 'notes.txt', contentType: 'text/plain', base64Data: 'aGk=' });
});

test('a ref reads from its own account when it names one', async () => {
  const asked = [];
  await emailEngine.resolveSendAttachments('me@example.com', [{ ...REF, account: 'work@example.com' }],
    async (args) => { asked.push(args); return { data: 'QUJD' }; });
  assert.equal(asked[0].account, 'work@example.com');
});

test('an unfetchable reference refuses the send rather than dropping the file', async () => {
  await assert.rejects(
    emailEngine.resolveSendAttachments('me@example.com', [REF], async () => { throw new Error('gone'); }),
    /invoice\.pdf.*could not be fetched.*gone/,
  );
});

test('the size ceiling applies to what was fetched, not to what was promised', async () => {
  // The ref itself is three fields long; only the resolved bytes can be over
  // the limit, so the ceiling has to be re-checked after resolution.
  const big = 'A'.repeat(40 * 1024 * 1024);
  await assert.rejects(
    emailEngine.resolveSendAttachments('me@example.com', [REF], async () => ({ data: big })),
    /too large/,
  );
});

test('a payload with no refs is handed on as the same array', async () => {
  const inline = [{ filename: 'a.txt', base64Data: 'aGk=' }];
  assert.equal(await emailEngine.resolveSendAttachments('me@example.com', inline), inline);
  assert.equal(await emailEngine.resolveSendAttachments('me@example.com', undefined), undefined);
});
