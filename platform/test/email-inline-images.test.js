// Inline `cid:` images, from sync to the rendered body.
//
// The Content-ID is the only thing that links `<img src="cid:logo">` in a body
// to the bytes of the part that carries the logo. Both sync parsers used to
// drop it, which made the reference unresolvable for every consumer — the
// sanitiser let `cid:` through, nothing could rewrite it, and the image
// rendered as its alt text with nothing on the row to say so.
//
// These tests run the parsers on hand-built provider payloads: no mailbox, no
// network, no database — the capture is pure.
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseGmailMessage } = require('../src/apps/email-sync-gmail');
const { parseImapMessage } = require('../src/apps/email-sync-imap');
const { renderEmail } = require('../src/apps/html-sanitize');

// --- IMAP (mailparser) -----------------------------------------------------

const imapParsed = (attachments) => ({
  from: { text: 'shop@example.test' }, to: { text: 'me@example.test' },
  subject: 'Order', date: new Date('2026-01-02T03:04:05Z'),
  text: 'order', html: '<img src="cid:logo"><p>order</p>',
  headers: new Map(), attachments,
});

test('IMAP keeps the part Content-ID and marks the part inline', () => {
  const msg = parseImapMessage(imapParsed([
    { filename: 'logo.png', contentType: 'image/png', size: 10, cid: 'logo@shop', contentDisposition: 'inline', related: true },
    { filename: 'invoice.pdf', contentType: 'application/pdf', size: 20, contentDisposition: 'attachment' },
  ]), 5, new Set(), 'INBOX');

  assert.equal(msg.attachments[0].contentId, 'logo@shop');
  assert.equal(msg.attachments[0].inline, true);
  // An ordinary attachment carries neither field — its metadata is unchanged.
  assert.equal(msg.attachments[1].contentId, undefined);
  assert.equal(msg.attachments[1].inline, undefined);
  assert.deepEqual(Object.keys(msg.attachments[1]), ['id', 'filename', 'mimeType', 'size']);
});

test('IMAP stores the Content-ID bare, however the header spelled it', () => {
  const msg = parseImapMessage(imapParsed([
    { filename: 'a.png', contentType: 'image/png', size: 1, contentId: '<logo@shop>' },
  ]), 5, new Set(), 'INBOX');
  assert.equal(msg.attachments[0].contentId, 'logo@shop');
});

// --- Gmail -----------------------------------------------------------------

const gmailMsg = (parts) => ({
  id: 'm1', threadId: 't1', labelIds: ['INBOX'], snippet: 's', internalDate: '1',
  payload: {
    headers: [{ name: 'From', value: 'shop@example.test' }, { name: 'Subject', value: 'Order' }],
    parts,
  },
});

test('Gmail reads Content-ID off the part headers walk() used to ignore', () => {
  const msg = parseGmailMessage(gmailMsg([
    { mimeType: 'text/html', body: { data: Buffer.from('<img src="cid:logo">').toString('base64url') } },
    {
      mimeType: 'image/png', filename: 'logo.png',
      headers: [{ name: 'Content-ID', value: '<logo>' }, { name: 'Content-Disposition', value: 'inline; filename="logo.png"' }],
      body: { attachmentId: 'ANGj-x', size: 10 },
    },
    { mimeType: 'application/pdf', filename: 'invoice.pdf', headers: [{ name: 'Content-Disposition', value: 'attachment' }], body: { attachmentId: 'ANGj-y', size: 20 } },
  ]));

  assert.equal(msg.attachments[0].contentId, 'logo');
  assert.equal(msg.attachments[0].inline, true);
  assert.equal(msg.attachments[1].contentId, undefined);
  assert.equal(msg.attachments[1].inline, undefined);
});

test('a Gmail part with no headers at all is parsed as it always was', () => {
  const msg = parseGmailMessage(gmailMsg([
    { mimeType: 'application/pdf', filename: 'invoice.pdf', body: { attachmentId: 'A', size: 20 } },
  ]));
  assert.deepEqual(msg.attachments, [{ id: 'A', filename: 'invoice.pdf', mimeType: 'application/pdf', size: 20 }]);
});

// --- end to end ------------------------------------------------------------

test('what sync captured is what the read path matches against', () => {
  const msg = parseImapMessage(imapParsed([
    { filename: 'logo.png', contentType: 'image/png', size: 10, cid: 'logo', related: true },
  ]), 5, new Set(), 'INBOX');
  const out = renderEmail(msg, 'sanitized', { inlineImageBase: '/apps/my-dashboard/att/' });
  assert.match(out.htmlBody, /src="\/apps\/my-dashboard\/att\/0"/);
  assert.equal(out.htmlInlineImages, 1);
});
