// Reply composition — the guarantees the stitcher exists to provide.
//
// Three of them are load-bearing enough to be worth stating:
//   1. The model's output never reaches the wire unfiltered. A draft that
//      echoes the original is stripped or refused, not sent.
//   2. The quoted trail is the parent message byte-for-byte — provable by
//      reversing the "> " prefixing and comparing, and by quoteSha256.
//   3. The plain-text and HTML parts come out of one call over one block list,
//      so they cannot drift.
//
// Pure: no DB, no model, no network.
const test = require('node:test');
const assert = require('node:assert/strict');

const compose = require('../src/apps/email-compose');
const { htmlToMarkdownish } = require('../src/apps/email-content');

const PARENT = {
  from: 'Anna Beck <anna@example.com>',
  subject: 'AW: Re: Rechnung 4711',
  date: '2026-09-09T10:04:00Z',
  messageId: '<parent@example.com>',
  account: 'me@example.com',
  body: 'Hallo,\n\nkönnen Sie die Rechnung 4711 bis Freitag prüfen?\n\nGrüße\nAnna',
  headers: [{ name: 'References', value: '<root@example.com> <mid@example.com>' }],
};

const unquote = (text) => text.split('\n').map((l) => (l === '>' ? '' : l.replace(/^> /, ''))).join('\n');
const squash = (s) => s.replace(/\s+/g, ' ').trim();

// --- the trail -------------------------------------------------------------

test('the quote is the parent body byte-for-byte', () => {
  const q = compose.buildQuote(PARENT);
  assert.equal(unquote(q.text), PARENT.body);
  assert.equal(q.derived, false);
  assert.equal(q.trimmed, false);
});

test('quoteSha256 identifies the exact source that was quoted', () => {
  const crypto = require('node:crypto');
  const q = compose.buildQuote(PARENT);
  assert.equal(q.sha256, crypto.createHash('sha256').update(PARENT.body, 'utf8').digest('hex'));
});

test('blank lines inside the quote keep a marker', () => {
  // A bare blank line ends the quote for downstream reply-parsers.
  const q = compose.buildQuote(PARENT);
  assert.ok(q.text.split('\n').every((l) => l.startsWith('>')));
});

test('an HTML-only parent is quoted from the HTML and flagged derived', () => {
  const html = '<p>Dear Hans,</p><p>See <a href="https://example.com/invoice/4711">the invoice</a>.</p>';
  // Exactly what the engine backfills at ingest for a mail with no text part.
  const q = compose.buildQuote({ ...PARENT, htmlBody: html, body: htmlToMarkdownish(html) });
  assert.equal(q.derived, true);
  assert.match(q.text, /Dear Hans/);
  // Fidelity, not legibility: the full href survives.
  assert.match(q.text, /https:\/\/example\.com\/invoice\/4711/);
});

test('HTML metacharacters in the parent are escaped into the quote', () => {
  const q = compose.buildQuote({ ...PARENT, body: 'watch out <script>alert(1)</script>' });
  assert.doesNotMatch(q.html, /<script>/);
  assert.match(q.html, /&lt;script&gt;/);
});

test('an oversized trail is trimmed and says so', () => {
  const q = compose.buildQuote({ ...PARENT, body: 'x'.repeat(40 * 1024) });
  assert.equal(q.trimmed, true);
  assert.match(q.text, /trail trimmed/);
});

// --- threading -------------------------------------------------------------

test('References accumulates the parent chain plus the parent itself', () => {
  const h = compose.replyHeaders(PARENT, { account: 'me@example.com' });
  assert.equal(h.references, '<root@example.com> <mid@example.com> <parent@example.com>');
  assert.equal(h.inReplyTo, '<parent@example.com>');
});

test('a parent with only In-Reply-To still yields a chain', () => {
  const h = compose.replyHeaders({ ...PARENT, headers: [{ name: 'In-Reply-To', value: '<a@x>' }] });
  assert.equal(h.references, '<a@x> <parent@example.com>');
});

test('a parent with no chain degrades to the parent Message-ID', () => {
  const h = compose.replyHeaders({ ...PARENT, headers: [] });
  assert.equal(h.references, '<parent@example.com>');
});

test('header lookup is case-insensitive (mailparser lowercases, Gmail does not)', () => {
  const lower = compose.replyHeaders({ ...PARENT, headers: [{ name: 'references', value: '<a@x>' }] });
  const upper = compose.replyHeaders({ ...PARENT, headers: [{ name: 'References', value: '<a@x>' }] });
  assert.equal(lower.references, upper.references);
});

test('a very long chain is capped without losing the root', () => {
  const many = Array.from({ length: 60 }, (_, i) => `<m${i}@x>`).join(' ');
  const h = compose.replyHeaders({ ...PARENT, headers: [{ name: 'References', value: many }] });
  const refs = h.references.split(' ');
  assert.ok(refs.length <= 21);
  assert.equal(refs[0], '<m0@x>');
  assert.equal(refs[refs.length - 1], '<parent@example.com>');
});

// --- subject ---------------------------------------------------------------

test('stacked multilingual prefixes collapse to a single Re:', () => {
  assert.equal(compose.replyHeaders(PARENT).subject, 'Re: Rechnung 4711');
  assert.equal(compose.replyHeaders({ ...PARENT, subject: 'Fwd: WG: Test' }).subject, 'Re: Test');
  assert.equal(compose.replyHeaders({ ...PARENT, subject: 'Re: Hello' }).subject, 'Re: Hello');
});

test('an empty subject still produces a valid one', () => {
  assert.equal(compose.replyHeaders({ ...PARENT, subject: '' }).subject, 'Re:');
});

test('a CRLF in the parent subject cannot reach the payload', () => {
  const h = compose.replyHeaders({ ...PARENT, subject: 'Invoice\r\nBcc: evil@example.com' });
  assert.doesNotMatch(h.subject, /[\r\n]/);
  assert.doesNotMatch(h.to, /[\r\n]/);
});

// --- enforcement -----------------------------------------------------------

test('an appended trail is cut and the real reply kept', () => {
  const r = compose.enforceReplyOnly(
    'Ja, mache ich.\n\nOn Tue, 9 Sep 2026 at 10:04, Anna wrote:\n> können Sie die Rechnung prüfen?',
    { parent: PARENT }
  );
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Ja, mache ich.');
});

test('attribution lines are recognised in EN, DE and FR', () => {
  const cases = [
    'Thanks.\n\nOn Tue, 9 Sep 2026 at 10:04, Anna Beck wrote:\n> hi',
    'Danke.\n\nAm 9. September 2026 schrieb Anna Beck:\n> hallo',
    'Merci.\n\nLe 9 septembre 2026, Anna Beck a écrit :\n> bonjour',
  ];
  for (const raw of cases) {
    const r = compose.enforceReplyOnly(raw, { parent: PARENT });
    assert.equal(r.ok, true, raw);
    assert.doesNotMatch(r.text, /^>/m, raw);
    assert.ok(r.stripped.quoteCutAt > 0, raw);
  }
});

test('an Outlook forwarded-header block is cut', () => {
  const r = compose.enforceReplyOnly(
    'Noted.\n\nFrom: Anna Beck\nSent: Tuesday, 9 September 2026\nTo: Hans\nSubject: Rechnung\n\nbody',
    { parent: PARENT }
  );
  assert.equal(r.text, 'Noted.');
});

test('a reply that merely opens with "On ..." is not cut', () => {
  const raw = 'On Tuesday we agreed the invoice would be checked by Friday, and it will be.';
  const r = compose.enforceReplyOnly(raw, { parent: PARENT });
  assert.equal(r.ok, true);
  assert.equal(r.text, raw);
});

test('output that is only a quote is refused outright', () => {
  const r = compose.enforceReplyOnly('> können Sie die Rechnung prüfen?', { parent: PARENT });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'quote-only');
});

test('a verbatim echo of the original is refused', () => {
  const r = compose.enforceReplyOnly(PARENT.body, { parent: PARENT });
  assert.equal(r.ok, false);
});

test('a short legitimate reply is NOT refused', () => {
  // Fewer than three 8-grams: containment is meaningless and must be skipped.
  const r = compose.enforceReplyOnly('Ja, passt — Donnerstag 10 Uhr.', { parent: PARENT });
  assert.equal(r.ok, true);
});

test('a trailing echo of the configured signature is stripped, not the message', () => {
  const r = compose.enforceReplyOnly('Alles klar.\n\nHans Peter\nVistaClair',
    { parent: PARENT, signature: 'Hans Peter\nVistaClair' });
  assert.equal(r.ok, true);
  assert.equal(r.text, 'Alles klar.');
  assert.equal(r.stripped.signature, true);
});

test('nothing meaningful left after stripping is refused', () => {
  const r = compose.enforceReplyOnly('—\n\n> quoted', { parent: PARENT });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty-after-strip');
});

test('a one-line acknowledgement is a valid reply, not a stripped fragment', () => {
  // Length is not the test for "is this a reply" — these are complete answers,
  // and they are what most replies to a scheduling mail actually look like.
  for (const raw of ['Danke.', 'Will do.', 'Ja, passt.']) {
    assert.equal(compose.enforceReplyOnly(raw, { parent: PARENT }).ok, true, raw);
  }
});

test('empty model output is refused', () => {
  assert.equal(compose.enforceReplyOnly('', { parent: PARENT }).ok, false);
});

// --- the one-source seam ---------------------------------------------------

test('derived blocks round-trip: the HTML part renders back to the text part', () => {
  // Applies to derived blocks only — quote and signature are pre-authored
  // twins and are allowed to differ between the two parts by design.
  const p = compose.composeReply({ ...PARENT, body: '', htmlBody: '' }, {
    replyText: 'Hallo Anna,\n\nja, ich schaue bis Donnerstag drauf.\n\nViele Grüße',
    includeSignature: false,
  });
  assert.equal(squash(htmlToMarkdownish(p.htmlBody)), squash(p.body));
});

test('renderParts always returns both sides', () => {
  const { text, html } = compose.renderParts([{ type: 'para', text: 'hello' }]);
  assert.ok(text.length > 0);
  assert.ok(html.length > 0);
});

test('the HTML fragment has no unterminated style attribute', () => {
  const p = compose.composeReply(PARENT, { replyText: 'Kurz und gut.', includeSignature: false });
  // A double quote inside style="…" would close it early and corrupt the mail.
  for (const m of p.htmlBody.matchAll(/style="([^"]*)"/g)) assert.doesNotMatch(m[1], /"/);
  assert.match(p.htmlBody, /<blockquote type="cite"/);
});

test('a URL in the reply becomes a link with an intact href', () => {
  const p = compose.composeReply(PARENT, { replyText: 'Siehe https://example.com/x?a=1&b=2', includeSignature: false });
  assert.match(p.htmlBody, /href="https:\/\/example\.com\/x\?a=1&amp;b=2"/);
  assert.match(p.body, /https:\/\/example\.com\/x\?a=1&b=2/);
});

// --- signature -------------------------------------------------------------

const SIG = { signatureText: 'Hans Peter\nVistaClair', signatureHtml: '<strong>Hans Peter</strong><br>VistaClair' };

test('each authored signature part lands on its own side', () => {
  const p = compose.composeReply(PARENT, { replyText: 'Kurz und gut.', ...SIG, includeSignature: true });
  assert.match(p.body, /^-- $/m); // RFC 3676 delimiter, trailing space intact
  assert.match(p.body, /Hans Peter\nVistaClair/);
  assert.match(p.htmlBody, /<strong>Hans Peter<\/strong>/);
});

test('an empty signatureHtml falls back to the generated rendering', () => {
  const p = compose.composeReply(PARENT, {
    replyText: 'Kurz und gut.', signatureText: 'Hans Peter', signatureHtml: '', includeSignature: true,
  });
  assert.match(p.body, /Hans Peter/);
  assert.match(p.htmlBody, /Hans Peter/);
});

test('includeSignature:false yields neither the delimiter nor either part', () => {
  const p = compose.composeReply(PARENT, { replyText: 'Kurz und gut.', ...SIG, includeSignature: false });
  assert.doesNotMatch(p.body, /^-- $/m);
  assert.doesNotMatch(p.body, /Hans Peter/);
  assert.doesNotMatch(p.htmlBody, /Hans Peter/);
});

// --- recompose (the toggle's correctness proof) -----------------------------

test('recompose rebuilds the parts from the payload sources alone', () => {
  const on = compose.composeReply(PARENT, { replyText: 'Kurz und gut.', ...SIG, includeSignature: true });
  const off = compose.recompose({ ...on, includeSignature: false });
  assert.doesNotMatch(off.body, /Hans Peter/);
  assert.doesNotMatch(off.htmlBody, /Hans Peter/);
  // …and back again, losslessly: no model call, no settings read.
  const backOn = compose.recompose({ ...off, includeSignature: true });
  assert.equal(backOn.body, on.body);
  assert.equal(backOn.htmlBody, on.htmlBody);
});

test('recompose leaves the quoted trail untouched', () => {
  const on = compose.composeReply(PARENT, { replyText: 'Kurz und gut.', ...SIG, includeSignature: true });
  const off = compose.recompose({ ...on, includeSignature: false });
  assert.equal(off.quotedText, on.quotedText);
  assert.equal(off.quoteSha256, on.quoteSha256);
  assert.match(off.body, /^> Hallo,$/m);
});

test('a payload with no replyText passes through untouched', () => {
  // Hand-composed sends and app kinds must keep working.
  const plain = { account: 'me@example.com', to: 'x@y', subject: 'Hi', body: 'raw' };
  assert.equal(compose.recompose(plain), plain);
});

test('composeReply stamps the version the freeze-time assertion is gated on', () => {
  const p = compose.composeReply(PARENT, { replyText: 'Kurz und gut.', includeSignature: false });
  assert.equal(p.composeVersion, compose.COMPOSE_VERSION);
});
