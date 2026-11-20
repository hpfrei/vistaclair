// The mail search query language.
//
// These operators used to live in my-dashboard, where they were applied by
// post-filtering a page the engine had already chosen — so a search for
// `from:anna` found Anna only if she happened to be in the last N messages.
// Moving them into the engine makes them predicates; these tests pin both the
// parse and the SQL, because "it compiled" is not the same as "it filters".
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSearchQuery, operatorSql } = require('../src/apps/email-query');

const sql = (raw) => operatorSql(parseSearchQuery(raw));

test('bare words are free text, not operators', () => {
  const q = parseSearchQuery('ferry booking naxos');
  assert.equal(q.hasOps, false);
  assert.equal(q.freeText, 'ferry booking naxos');
  assert.deepEqual(operatorSql(q).where, []);
});

test('an operator is removed from the free text it was mixed into', () => {
  const q = parseSearchQuery('from:anna ferry booking');
  assert.deepEqual(q.from, ['anna']);
  assert.equal(q.freeText, 'ferry booking', 'the operator must not also reach FULLTEXT');
});

test('a quoted value survives the space inside it', () => {
  const q = parseSearchQuery('subject:"ferry booking" naxos');
  assert.deepEqual(q.subject, ['ferry booking']);
  assert.equal(q.freeText, 'naxos');
});

test('every documented operator parses', () => {
  const q = parseSearchQuery('from:a to:b cc:c participant:d with:e subject:f account:g acct:h in:inbox folder:sent is:unread has:attachment before:2026-02-01 after:2026-01-01 any:literal');
  assert.deepEqual(q.from, ['a']);
  assert.deepEqual(q.to, ['b']);
  assert.deepEqual(q.cc, ['c']);
  assert.deepEqual(q.participant, ['d', 'e']);
  assert.deepEqual(q.subject, ['f']);
  assert.deepEqual(q.account, ['g', 'h']);
  assert.deepEqual(q.folder, ['inbox', 'sent']);
  assert.equal(q.unread, true);
  assert.equal(q.hasAttachment, true);
  assert.ok(q.before && q.after);
  assert.equal(q.freeText, 'literal');
});

test('is:read is the opposite of is:unread, not the absence of it', () => {
  assert.equal(parseSearchQuery('is:read').unread, false);
  assert.equal(parseSearchQuery('is:unread').unread, true);
  assert.equal(parseSearchQuery('hello').unread, undefined);
});

test('a colon in prose is not a failed operator', () => {
  for (const raw of ['Re: your booking', 'see https://x.test/a', 'note: call back', 'is:whatever']) {
    const q = parseSearchQuery(raw);
    assert.equal(q.hasOps, false, raw);
    assert.ok(q.freeText.length, `${raw} lost its text`);
  }
});

test('an unparseable date stays free text rather than silently matching everything', () => {
  const q = parseSearchQuery('after:soon');
  assert.equal(q.after, null);
  assert.equal(q.hasOps, false);
  assert.equal(q.freeText, 'after:soon');
});

test('any: forces a literal that would otherwise be read as an operator', () => {
  const q = parseSearchQuery('any:"from:anna"');
  assert.deepEqual(q.from, []);
  assert.equal(q.freeText, 'from:anna');
});

// --- compilation to SQL ----------------------------------------------------

test('to: matches cc as well — being copied in is still being written to', () => {
  const { where, vals } = sql('to:anna@x.test');
  assert.equal(where.length, 1);
  assert.match(where[0], /recipient LIKE \?.*OR.*cc LIKE \?/);
  assert.deepEqual(vals, ['%anna@x.test%', '%anna@x.test%']);
});

test('participant: searches every header the address can be in', () => {
  const { where } = sql('with:anna');
  assert.match(where[0], /sender/);
  assert.match(where[0], /recipient/);
  assert.match(where[0], /cc/);
});

test('two values of one operator are OR, two operators are AND', () => {
  const orOne = sql('from:anna from:bob');
  assert.equal(orOne.where.length, 1, 'one operator is one predicate');
  assert.match(orOne.where[0], /OR/);
  const andTwo = sql('from:anna is:unread');
  assert.equal(andTwo.where.length, 2);
});

test('subject terms narrow rather than widen', () => {
  const { where } = sql('subject:ferry subject:booking');
  assert.equal(where.length, 2, 'two subject terms must both match');
});

test('a folder matches every spelling the providers store it under', () => {
  const { where, vals } = sql('in:junk');
  assert.match(where[0], /LOWER\(e\.folder\) IN/);
  assert.ok(vals.includes('spam') && vals.includes('junk'), 'junk and spam are one folder');
  assert.ok(vals.includes('[gmail]/spam'), 'Gmail spells it differently');
  assert.deepEqual(sql('in:bin').vals.includes('trash'), true);
});

test('has:attachment asks the store, not a widened page', () => {
  assert.match(sql('has:attachment').where[0], /JSON_LENGTH\(e\.attachment_meta\) > 0/);
});

test('before is exclusive and after is inclusive, so two searches never double-count a day', () => {
  assert.match(sql('before:2026-02-01').where[0], /date < \?/);
  assert.match(sql('after:2026-01-01').where[0], /date >= \?/);
});

test('every value is a bound parameter — the query language is not a SQL surface', () => {
  const { where, vals } = sql(`from:"x' OR 1=1 --" subject:"'; DROP TABLE platform_emails; --"`);
  for (const w of where) assert.doesNotMatch(w, /DROP|OR 1=1/i);
  assert.equal(vals.length, where.length, 'one placeholder per value');
  // Values are folded to lower case (LIKE is case-insensitive anyway) — the
  // point is that the text survives as a VALUE and never as syntax.
  assert.ok(vals.some((v) => /drop table/i.test(String(v))), 'the text itself is still searched for, as a value');
});

test('the alias is the caller\'s, so the same predicates work in the vector query', () => {
  const { where } = operatorSql(parseSearchQuery('from:anna'), '');
  assert.match(where[0], /^\(sender LIKE/);
});

// ── tag: — the one operator that reads an annotation ─────────────────────────

const VOCAB = [{ id: 'bills-it-3f9a', name: 'Bills · IT services' }, { id: 'travel-01ab', name: 'Travel' }];
const tagSql = (raw) => operatorSql(parseSearchQuery(raw), 'e.', { labels: VOCAB });

test('tag: is an operator, so a query that is only a tag still filters', () => {
  const q = parseSearchQuery('tag:travel-01ab');
  assert.equal(q.hasOps, true, 'left out of hasOps the operator would be silently dropped');
  assert.deepEqual(q.tag, ['travel-01ab']);
  assert.equal(q.freeText, '');
});

test('a tag predicate reads the platform tags document and honours the tombstone', () => {
  const { where, vals } = tagSql('tag:travel-01ab');
  assert.equal(where.length, 1);
  assert.match(where[0], /^EXISTS \(SELECT 1 FROM platform_email_annotations t WHERE t\.account = e\.account AND t\.email_uid = e\.uid AND t\.app_name = 'platform' AND t\.kind = 'tags'/);
  assert.match(where[0], /JSON_EXTRACT\(t\.data, \?\) IS NOT NULL AND JSON_VALUE\(t\.data, \?\) IS NULL\)$/);
  assert.deepEqual(vals, ['$.tags."travel-01ab"', '$.tags."travel-01ab".removed'], 'the path is a bound value, never SQL text');
});

test('a tag name resolves to its id, case-insensitively and with the space inside it', () => {
  const { vals } = tagSql('tag:"bills · it SERVICES"');
  assert.equal(vals[0], '$.tags."bills-it-3f9a"');
});

test('a tag nobody has matches nothing — never everything', () => {
  const { where, vals } = tagSql('tag:insurance');
  assert.deepEqual(where, ['1 = 0']);
  assert.deepEqual(vals, []);
});

test('-tag: excludes, and a tombstoned tag counts as absent', () => {
  const { where } = tagSql('-tag:Travel');
  assert.match(where[0], /^NOT EXISTS \(/);
  assert.match(where[0], /JSON_VALUE\(t\.data, \?\) IS NULL\)$/);
  assert.deepEqual(tagSql('-tag:insurance').where, [], 'excluding a tag nobody has excludes nothing');
});

test('an id that is not a slug never becomes a JSON path', () => {
  const { where, vals } = operatorSql(parseSearchQuery('tag:x'), 'e.', { labels: [{ id: 'a"b', name: 'x' }] });
  assert.deepEqual(where, ['1 = 0']);
  assert.deepEqual(vals, []);
});

test('the tag predicate takes the caller\'s alias like every other operator', () => {
  const { where } = operatorSql(parseSearchQuery('tag:travel-01ab'), '', { labels: VOCAB });
  assert.match(where[0], /t\.account = account AND t\.email_uid = uid/);
});
