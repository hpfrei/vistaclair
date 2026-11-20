// IMAP threading.
//
// The sync path used to write the row's own uid into thread_id, so every IMAP
// message was a thread of one and "has this thread been answered?" fell back to
// matching normalised subjects. These tests pin the replacement: the thread is
// whatever RFC 5322's References/In-Reply-To say it is.
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeId, referencedIds, threadIdFor, MAX_THREAD_ID } = require('../src/apps/email-threading');

const hdrs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));

test('angle brackets are delimiters, not part of the identifier', () => {
  assert.equal(normalizeId('<a@x.test>'), 'a@x.test');
  assert.equal(normalizeId('  <a@x.test>  '), 'a@x.test');
  assert.equal(normalizeId('a@x.test'), 'a@x.test');
  assert.equal(normalizeId(''), '');
  assert.equal(normalizeId(null), '');
});

test('References is read root-first, then In-Reply-To, without duplicates', () => {
  const ids = referencedIds(hdrs({
    References: '<root@x.test> <mid@x.test>',
    'In-Reply-To': '<mid@x.test>',
  }));
  assert.deepEqual(ids, ['root@x.test', 'mid@x.test']);
});

test('header names match case-insensitively — clients disagree about spelling', () => {
  assert.deepEqual(referencedIds(hdrs({ REFERENCES: '<r@x.test>' })), ['r@x.test']);
  assert.deepEqual(referencedIds(hdrs({ 'in-reply-to': '<p@x.test>' })), ['p@x.test']);
});

test('References folded across lines still parses', () => {
  assert.deepEqual(
    referencedIds(hdrs({ References: '<a@x.test>\r\n <b@x.test>\r\n\t<c@x.test>' })),
    ['a@x.test', 'b@x.test', 'c@x.test'],
  );
});

test('a reply is filed under the thread root', () => {
  const reply = { headers: hdrs({ References: '<root@x.test> <p@x.test>' }), messageId: '<r@x.test>', id: '42' };
  assert.equal(threadIdFor(reply), 'root@x.test');
});

test('In-Reply-To alone is enough — not every client sends References', () => {
  const reply = { headers: hdrs({ 'In-Reply-To': '<root@x.test>' }), messageId: '<r@x.test>', id: '42' };
  assert.equal(threadIdFor(reply), 'root@x.test');
});

test('a thread the store already decided on wins over the root id', () => {
  // The root was never delivered here, or arrived under another id; whatever
  // the parent is filed under is what keeps the thread whole.
  const reply = { headers: hdrs({ References: '<gone@x.test> <p@x.test>' }), messageId: '<r@x.test>', id: '42' };
  assert.equal(threadIdFor(reply, new Map([['p@x.test', 'existing-thread']])), 'existing-thread');
});

test('a message referencing nothing is its own thread', () => {
  assert.equal(threadIdFor({ headers: [], messageId: '<solo@x.test>', id: '42' }), 'solo@x.test');
});

test('a message with no Message-ID at all falls back to its uid', () => {
  assert.equal(threadIdFor({ headers: [], messageId: '', id: '42' }), '42');
  assert.equal(threadIdFor({ headers: [], id: '42' }), '42');
});

test('an oversized root becomes a stable digest, because the column is bounded', () => {
  const huge = `<${'x'.repeat(400)}@x.test>`;
  const a = threadIdFor({ headers: hdrs({ References: huge }), id: '1' });
  const b = threadIdFor({ headers: hdrs({ References: huge }), id: '2' });
  assert.equal(a, b, 'the same thread must get the same id');
  assert.ok(a.length <= MAX_THREAD_ID);
});

test('two replies to the same root land in the same thread; an unrelated one does not', () => {
  const root = '<root@x.test>';
  const one = threadIdFor({ headers: hdrs({ References: root }), messageId: '<a@x.test>', id: '1' });
  const two = threadIdFor({ headers: hdrs({ 'In-Reply-To': root }), messageId: '<b@x.test>', id: '2' });
  const other = threadIdFor({ headers: hdrs({ References: '<elsewhere@x.test>' }), messageId: '<c@x.test>', id: '3' });
  assert.equal(one, two);
  assert.notEqual(one, other);
});

test('the same subject is not a thread — that is the fallback this replaces', () => {
  const a = threadIdFor({ headers: hdrs({ Subject: 'Re: invoice' }), messageId: '<a@x.test>', id: '1' });
  const b = threadIdFor({ headers: hdrs({ Subject: 'Re: invoice' }), messageId: '<b@x.test>', id: '2' });
  assert.notEqual(a, b);
});
