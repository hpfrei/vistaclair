// Gmail MIME assembly — the three bugs that only became reachable once replies
// started carrying a derived subject and a quoted trail.
//
// `buildMimeMessage` hand-rolls raw headers, so every one of these is a
// property of string concatenation rather than of a library:
//   1. References was emitted only inside the In-Reply-To branch, so a payload
//      carrying an accumulated chain but no parent Message-ID lost the chain.
//   2. Header values were interpolated with no CR/LF stripping. Reply subjects
//      are derived from the parent message — untrusted mail — so a subject
//      containing a line break could inject a Bcc.
//   3. The text/plain part carried no Content-Transfer-Encoding while the HTML
//      part was base64, quietly corrupting non-ASCII bodies.
//
// Everything is asserted by parsing the output back with mailparser (already a
// dependency, via the IMAP sync path) rather than by matching our own strings.
const test = require('node:test');
const assert = require('node:assert/strict');
const { simpleParser } = require('mailparser');

const { buildMimeMessage } = require('../src/apps/email-sync-gmail');

const base = { from: 'me@example.com', to: 'you@example.com', subject: 'Hi', body: 'Hello there' };

test('References survives without In-Reply-To', async () => {
  const raw = buildMimeMessage({ ...base, references: '<a@x> <b@x>' });
  assert.match(raw, /^References: <a@x> <b@x>$/m);
  assert.doesNotMatch(raw, /^In-Reply-To:/m);

  const parsed = await simpleParser(raw);
  const refs = [].concat(parsed.references || []);
  assert.deepEqual(refs, ['<a@x>', '<b@x>']);
});

test('In-Reply-To and References are both emitted when both are present', async () => {
  const raw = buildMimeMessage({ ...base, inReplyTo: '<b@x>', references: '<a@x> <b@x>' });
  const parsed = await simpleParser(raw);
  assert.equal(parsed.inReplyTo, '<b@x>');
  assert.deepEqual([].concat(parsed.references), ['<a@x>', '<b@x>']);
});

test('In-Reply-To alone still back-fills References (unchanged behaviour)', async () => {
  const parsed = await simpleParser(buildMimeMessage({ ...base, inReplyTo: '<b@x>' }));
  assert.equal(parsed.inReplyTo, '<b@x>');
  assert.deepEqual([].concat(parsed.references), ['<b@x>']);
});

test('a CRLF in the subject cannot inject a header', async () => {
  const raw = buildMimeMessage({ ...base, subject: 'Invoice\r\nBcc: evil@example.com' });
  assert.doesNotMatch(raw, /\r\nBcc:/i);

  const parsed = await simpleParser(raw);
  assert.equal(parsed.bcc, undefined);
  assert.equal(parsed.subject, 'Invoice Bcc: evil@example.com');
});

test('a CRLF in a recipient cannot inject a header', async () => {
  const raw = buildMimeMessage({ ...base, to: 'you@example.com\r\nBcc: evil@example.com' });
  assert.doesNotMatch(raw, /\r\nBcc:/i);
  assert.equal((await simpleParser(raw)).bcc, undefined);
});

test('a CRLF in an attachment filename cannot inject a header', async () => {
  const raw = buildMimeMessage({
    ...base,
    attachments: [{ filename: 'ok.pdf\r\nBcc: evil@example.com', contentType: 'application/pdf', base64Data: Buffer.from('x').toString('base64') }],
  });
  assert.doesNotMatch(raw, /\r\nBcc:/i);
  assert.equal((await simpleParser(raw)).bcc, undefined);
});

test('a non-ASCII subject is encoded and round-trips', async () => {
  const subject = 'Rückfrage zur Rechnung — €100';
  const raw = buildMimeMessage({ ...base, subject });
  assert.match(raw, /^Subject: =\?utf-8\?B\?/m); // RFC 2047 encoded-word, not raw 8-bit
  assert.equal((await simpleParser(raw)).subject, subject);
});

test('a non-ASCII plain-text body survives', async () => {
  const body = 'Grüße aus München — tschüss! 😀';
  const raw = buildMimeMessage({ ...base, body });
  assert.match(raw, /Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64/);
  assert.equal((await simpleParser(raw)).text.trim(), body);
});

test('an HTML body yields multipart/alternative with both parts intact', async () => {
  const body = 'Plain grüße';
  const htmlBody = '<p>HTML gr&uuml;ße</p>';
  const parsed = await simpleParser(buildMimeMessage({ ...base, body, htmlBody }));
  assert.equal(parsed.text.trim(), body);
  assert.match(parsed.html, /HTML/);
  // Both parts must be present — a client picking either one gets a real body.
  assert.ok(parsed.text && parsed.html);
});

test('an empty body does not corrupt the message', async () => {
  const parsed = await simpleParser(buildMimeMessage({ ...base, body: '' }));
  assert.equal((parsed.text || '').trim(), '');
  assert.equal(parsed.subject, 'Hi');
});
