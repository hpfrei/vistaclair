// The shared recurrence model (src/apps/rrule.js).
//
// The stepping half is pinned separately, against the engine that owns it, in
// test/tasks-recurrence.test.js. This file covers the half that had NO tests at
// all before: building and parsing Google's RRULE strings, and capping a series.
//
// Why capping matters enough to test: it is what "delete this and all following"
// does to a recurring event. Off by one second in the wrong direction and the
// occurrence the owner asked to delete survives — or the one before it vanishes.
const test = require('node:test');
const assert = require('node:assert/strict');

const rrule = require('../src/apps/rrule');

// --- build ------------------------------------------------------------------

test('a rule becomes the RRULE line Google expects', () => {
  assert.deepEqual(rrule.toRRule({ freq: 'DAILY' }), ['RRULE:FREQ=DAILY']);
  assert.deepEqual(rrule.toRRule({ every: 'week', n: 2 }), ['RRULE:FREQ=WEEKLY;INTERVAL=2']);
  assert.deepEqual(rrule.toRRule({ every: 'week', byday: ['we', 'mo'] }),
    ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE']);
  assert.deepEqual(rrule.toRRule({ freq: 'MONTHLY', count: 5 }), ['RRULE:FREQ=MONTHLY;COUNT=5']);
  assert.deepEqual(rrule.toRRule(null), [], 'no rule is no recurrence, not an empty one');
  // INTERVAL=1 is the default and saying so is noise.
  assert.equal(rrule.toRRule({ freq: 'DAILY', interval: 1 })[0].includes('INTERVAL'), false);
});

test('UNTIL is serialised in the form the event type requires', () => {
  const until = new Date('2026-06-30T17:00:00Z');
  assert.deepEqual(rrule.toRRule({ freq: 'WEEKLY', until }),
    ['RRULE:FREQ=WEEKLY;UNTIL=20260630T170000Z']);
  assert.deepEqual(rrule.toRRule({ freq: 'WEEKLY', until }, { allDay: true }),
    ['RRULE:FREQ=WEEKLY;UNTIL=20260630'], 'an all-day series takes a bare date');
});

test('a rule Google could not honour is refused rather than sent', () => {
  assert.throws(() => rrule.toRRule({ freq: 'HOURLY' }), /every must be one of/);
  assert.throws(() => rrule.toRRule({ freq: 'MONTHLY', byday: ['MO'] }), /only valid with/);
  assert.throws(() => rrule.toRRule({ freq: 'DAILY', count: 3, until: new Date() }), /not both/);
  assert.throws(() => rrule.toRRule({ freq: 'DAILY', until: 'whenever' }), /invalid recurrence until/);
});

// --- parse ------------------------------------------------------------------

test('parsing is the inverse of building', () => {
  for (const rule of [
    { freq: 'DAILY', interval: 1 },
    { freq: 'WEEKLY', interval: 3 },
    { freq: 'WEEKLY', interval: 1, byday: ['MO', 'TH'] },
    { freq: 'MONTHLY', interval: 2, count: 12 },
  ]) {
    assert.deepEqual(rrule.fromRRule(rrule.toRRule(rule)), rule, JSON.stringify(rule));
  }
  const withUntil = { freq: 'WEEKLY', interval: 1, until: new Date('2026-06-30T17:00:00Z') };
  assert.deepEqual(rrule.fromRRule(rrule.toRRule(withUntil)), withUntil);
});

test('a rule the model cannot hold exactly is refused, not approximated', () => {
  // This parse feeds an EDITOR, and whatever the editor shows is written back on
  // save. So half-reading a rule is worse than not reading it: the caller reads
  // null as "leave the series alone", but an approximation comes back as a whole
  // rule and silently replaces the real one on an edit that only changed a title.
  assert.equal(rrule.fromRRule([]), null);
  assert.equal(rrule.fromRRule(['EXDATE;TZID=UTC:20260302T090000Z']), null, 'exceptions alone are not a rule');
  assert.equal(rrule.fromRRule(['RRULE:FREQ=SECONDLY']), null, 'a freq we cannot step is no rule');
  assert.equal(rrule.fromRRule(['RRULE:FREQ=WEEKLY;BYDAY=2MO,-1FR']), null, 'the second Monday is not "every Monday"');
  assert.equal(rrule.fromRRule(['RRULE:FREQ=MONTHLY;BYMONTHDAY=1']), null, 'the 1st is not "monthly from the start date"');
  assert.equal(rrule.fromRRule(['RRULE:FREQ=WEEKLY;WKST=SU;BYSETPOS=1']), null);
  assert.equal(rrule.fromRRule(['RRULE:FREQ=MONTHLY;BYDAY=MO']), null, 'BYDAY outside WEEKLY is a different rule');
  assert.equal(rrule.fromRRule(['RRULE:FREQ=DAILY', 'RRULE:FREQ=WEEKLY']), null, 'two series are not one rule');
  assert.equal(rrule.fromRRule(['RRULE:FREQ=WEEKLY', 'RDATE;VALUE=DATE:20260316']), null, 'an added date is part of the series');
  assert.equal(rrule.fromRRule(['RRULE:FREQ=WEEKLY;UNTIL=next-june']), null, 'an unreadable bound is not an unbounded series');
  // WKST=MO is the default this module already counts by, so it costs nothing.
  assert.equal(rrule.fromRRule(['RRULE:FREQ=WEEKLY;WKST=MO;INTERVAL=2']).interval, 2);
});

test('an all-day UNTIL parses as the end of that day, not its start', () => {
  // UNTIL is inclusive. Reading 20260630 as midnight would silently drop the
  // last occurrence of every all-day series.
  const r = rrule.fromRRule(['RRULE:FREQ=WEEKLY;UNTIL=20260630']);
  assert.equal(r.until.toISOString(), '2026-06-30T23:59:59.000Z');
});

// --- cap ("this and all following") -----------------------------------------

test('capping ends the series strictly before the occurrence being removed', () => {
  // A timed occurrence: one second earlier, because UNTIL is inclusive.
  assert.equal(rrule.untilBefore({ dateTime: '2026-03-09T09:00:00Z' }), '20260309T085959Z');
  // An all-day occurrence: the previous day.
  assert.equal(rrule.untilBefore({ date: '2026-03-09' }), '20260308');
  // Across a month boundary, where naive arithmetic produces day 0.
  assert.equal(rrule.untilBefore({ date: '2026-03-01' }), '20260228');
});

test('capping replaces any existing bound and leaves exceptions alone', () => {
  assert.deepEqual(
    rrule.capUntil(['RRULE:FREQ=WEEKLY;COUNT=10'], '20260308'),
    ['RRULE:FREQ=WEEKLY;UNTIL=20260308'],
    'COUNT must go: a series cannot carry both',
  );
  assert.deepEqual(
    rrule.capUntil(['RRULE:FREQ=WEEKLY;UNTIL=20261231'], '20260308'),
    ['RRULE:FREQ=WEEKLY;UNTIL=20260308'],
    'an existing UNTIL is replaced, not appended to',
  );
  assert.deepEqual(
    rrule.capUntil(['RRULE:FREQ=WEEKLY', 'EXDATE;TZID=UTC:20260316T090000Z'], '20260308'),
    ['RRULE:FREQ=WEEKLY;UNTIL=20260308', 'EXDATE;TZID=UTC:20260316T090000Z'],
    'EXDATE is not an RRULE and must survive untouched',
  );
  assert.deepEqual(rrule.capUntil(null, '20260308'), []);
});

test('a capped series still parses, and ends where it was capped', () => {
  const capped = rrule.capUntil(rrule.toRRule({ every: 'week', byday: ['MO'] }),
    rrule.untilBefore({ date: '2026-03-09' }));
  const back = rrule.fromRRule(capped);
  assert.deepEqual(back.byday, ['MO'], 'capping did not eat the rest of the rule');
  assert.equal(back.until.toISOString().slice(0, 10), '2026-03-08');
});

// --- the todo spelling ------------------------------------------------------

test('the same model round-trips through the todo shape', () => {
  assert.deepEqual(rrule.toTaskRule({ freq: 'WEEKLY', interval: 2, byday: ['FR'] }),
    { every: 'week', n: 2, byday: ['FR'] });
  assert.deepEqual(rrule.toTaskRule(null), null);
  // A todo rule and a calendar rule are the same series, so they must produce
  // the same RRULE line — that equivalence is the reason for one module.
  assert.deepEqual(rrule.toRRule({ every: 'week', n: 2, byday: ['FR'] }),
    rrule.toRRule({ freq: 'WEEKLY', interval: 2, byday: ['FR'] }));
});
