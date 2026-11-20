// Characterization tests for todo recurrence.
//
// These were written against the ORIGINAL tasks-engine implementation and run
// green before `src/apps/rrule.js` existed. That is the whole point: recurrence
// bugs do not throw, they just quietly move every repeating todo to the wrong
// day, and nobody notices until a deadline is missed. So the behaviour is
// pinned first and the implementation swapped underneath it second.
//
// Two properties below are LIMITATIONS, deliberately pinned rather than fixed.
// Changing either would silently reschedule todos that already exist, so they
// may only change in a wave that says so and migrates the data.
const test = require('node:test');
const assert = require('node:assert/strict');

const { validateRecurrence, nextDue } = require('../src/apps/tasks-engine')._recurrence;

// Local time throughout: the stepping is local-time Date arithmetic on purpose.
const at = (s) => new Date(s);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// --- validation -------------------------------------------------------------

test('a rule is accepted only in the shapes the engine can step', () => {
  assert.equal(validateRecurrence(null), null);
  assert.deepEqual(validateRecurrence({ every: 'day' }), { every: 'day', n: 1 });
  assert.deepEqual(validateRecurrence({ every: 'WEEK', n: 2 }), { every: 'week', n: 2 });
  assert.deepEqual(validateRecurrence({ every: 'week', byday: ['we', 'MO', 'MO'] }),
    { every: 'week', n: 1, byday: ['MO', 'WE'] }, 'deduped and Monday-first, not input order');
  assert.deepEqual(validateRecurrence({ every: 'week', byday: 'MO,FR' }).byday, ['MO', 'FR'],
    'a comma string is one rule, not one day');

  assert.throws(() => validateRecurrence({ every: 'fortnight' }), /every must be one of/);
  assert.throws(() => validateRecurrence({ every: 'day', n: 1.5 }), /integer 1-365/);
  assert.throws(() => validateRecurrence({ every: 'day', n: 0.5 }), /integer 1-365/);
  assert.throws(() => validateRecurrence({ every: 'day', n: 400 }), /integer 1-365/);
  assert.throws(() => validateRecurrence({ every: 'week', byday: ['XX'] }), /must be weekdays/);
  // byday without a weekly rule would be silently ignored by the stepper, so it
  // is refused at the door rather than accepted and dropped.
  assert.throws(() => validateRecurrence({ every: 'month', byday: ['MO'] }), /only valid with/);
});

// --- plain stepping ---------------------------------------------------------

test('each unit steps by its own interval from the old due date', () => {
  const now = at('2026-03-02T09:00:00');
  const from = at('2026-03-02T08:00:00');
  assert.equal(iso(nextDue({ every: 'day', n: 1 }, from, now)), '2026-03-03');
  assert.equal(iso(nextDue({ every: 'day', n: 10 }, from, now)), '2026-03-12');
  assert.equal(iso(nextDue({ every: 'week', n: 1 }, from, now)), '2026-03-09');
  assert.equal(iso(nextDue({ every: 'week', n: 2 }, from, now)), '2026-03-16');
  assert.equal(iso(nextDue({ every: 'month', n: 1 }, from, now)), '2026-04-02');
  assert.equal(iso(nextDue({ every: 'year', n: 1 }, from, now)), '2027-03-02');
});

test('the result is always in the future, and keeps the original time of day', () => {
  // A todo left uncompleted for months must not come due in the past: the
  // stepper keeps going until it passes `now`, rather than stepping once.
  const from = at('2026-01-05T07:30:00');
  const now = at('2026-03-02T09:00:00');
  const d = nextDue({ every: 'week', n: 1 }, from, now);
  assert.ok(d > now, 'stepped past now');
  assert.equal(iso(d), '2026-03-09');
  assert.equal(hhmm(d), '07:30', 'the time of day is the todo\'s, not now\'s');
  assert.equal(d.getDay(), from.getDay(), 'and the same weekday it always was');
});

test('a todo with no due date at all starts stepping from now', () => {
  const now = at('2026-03-02T09:00:00');
  assert.equal(iso(nextDue({ every: 'day', n: 1 }, null, now)), '2026-03-03');
  assert.equal(iso(nextDue({ every: 'day', n: 1 }, 'not-a-date', now)), '2026-03-03');
});

// --- pinned limitation 1: month-end clamping --------------------------------

test('LIMITATION: monthly from the 31st clamps forward, and does not come back', () => {
  // setMonth semantics: 31 Jan + 1 month is 3 March (2026 is not a leap year),
  // because 31 February overflows. This is the documented RRULE-lite quirk.
  const now = at('2026-02-01T09:00:00');
  const d = nextDue({ every: 'month', n: 1 }, at('2026-01-31T08:00:00'), now);
  assert.equal(iso(d), '2026-03-03');

  // And it is not self-correcting — the next step goes from the 3rd, so a
  // "monthly on the 31st" todo permanently becomes a 3rd-of-the-month todo.
  const d2 = nextDue({ every: 'month', n: 1 }, d, at('2026-03-04T09:00:00'));
  assert.equal(iso(d2), '2026-04-03');

  // A day-of-month that exists everywhere is unaffected.
  assert.equal(iso(nextDue({ every: 'month', n: 1 }, at('2026-01-15T08:00:00'), at('2026-01-20T09:00:00'))), '2026-02-15');
});

test('LIMITATION: yearly on 29 Feb lands on 1 March in a common year', () => {
  const d = nextDue({ every: 'year', n: 1 }, at('2024-02-29T08:00:00'), at('2024-03-01T09:00:00'));
  assert.equal(iso(d), '2025-03-01');
});

// --- weekly byday -----------------------------------------------------------

test('byday walks the named weekdays in order, then moves to the next week', () => {
  const rule = validateRecurrence({ every: 'week', byday: ['MO', 'WE', 'FR'] });
  const mon = at('2026-03-02T08:00:00'); // a Monday
  assert.equal(mon.getDay(), 1);

  const wed = nextDue(rule, mon, mon);
  assert.equal(iso(wed), '2026-03-04');
  const fri = nextDue(rule, wed, wed);
  assert.equal(iso(fri), '2026-03-06');
  const nextMon = nextDue(rule, fri, fri);
  assert.equal(iso(nextMon), '2026-03-09', 'wraps into the following week');
  assert.equal(hhmm(nextMon), '08:00');
});

test('byday with an interval skips whole weeks, counted from the base week', () => {
  const rule = validateRecurrence({ every: 'week', n: 2, byday: ['MO', 'TH'] });
  const mon = at('2026-03-02T08:00:00');
  const thu = nextDue(rule, mon, mon);
  assert.equal(iso(thu), '2026-03-05', 'the second day of the same week still fires');
  // ...but the following Monday is skipped: the next week in the cycle is the
  // week of the 16th, not the 9th.
  assert.equal(iso(nextDue(rule, thu, thu)), '2026-03-16');
});

test('byday respects now, not just the old due date', () => {
  // Overdue since a Monday, swept on the Thursday: the answer is the next
  // occurrence after NOW (Friday), not the next one after the old date.
  const rule = validateRecurrence({ every: 'week', byday: ['MO', 'WE', 'FR'] });
  const d = nextDue(rule, at('2026-03-02T08:00:00'), at('2026-03-05T12:00:00'));
  assert.equal(iso(d), '2026-03-06');
});

test('a Sunday rule is the end of a Monday-first week, not the start', () => {
  // BYDAY_CODES is in getDay() order (SU first) but weeks are walked WKST=MO,
  // so SU must come out last. An off-by-one here shifts the todo a full week.
  const rule = validateRecurrence({ every: 'week', byday: ['SU', 'MO'] });
  assert.deepEqual(rule.byday, ['MO', 'SU']);
  const mon = at('2026-03-02T08:00:00');
  const sun = nextDue(rule, mon, mon);
  assert.equal(iso(sun), '2026-03-08', 'the Sunday that ENDS this week');
  assert.equal(sun.getDay(), 0);
  assert.equal(iso(nextDue(rule, sun, sun)), '2026-03-09', 'then straight into Monday');
});

// --- pinned limitation 2: DST -----------------------------------------------

test('LIMITATION: stepping is local-time, so a DST crossing keeps the clock time', () => {
  // Only meaningful in a DST zone; skipped elsewhere so CI in UTC stays green.
  const jan = new Date(2026, 0, 15).getTimezoneOffset();
  const jul = new Date(2026, 6, 15).getTimezoneOffset();
  if (jan === jul) return;

  // Step daily across the spring transition. The wall-clock time must not move,
  // even though the absolute elapsed time is 23 or 25 hours.
  let d = new Date(2026, 2, 1, 9, 0, 0);
  const startHour = d.getHours();
  for (let i = 0; i < 120; i++) d = nextDue({ every: 'day', n: 1 }, d, d);
  assert.equal(d.getHours(), startHour, 'a daily todo stays at 09:00 all year');
});
