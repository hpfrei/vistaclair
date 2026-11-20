// A multi-day event kept its range only in prose.
//
// The extracted-event shape carried ONE date, and CALENDAR_RULES told the model
// to flatten a range onto its first day and mention the rest in `notes`. A stay
// of 02.10.2026–19.12.2026 was therefore staged as a one-day all-day event on
// 2 October, with nothing on the card to say the end date had been discarded
// rather than never seen. Every consumer downstream already understood
// `endDate` (calendar-engine's buildEventBody, the approval cards); the
// producer was the only gap.
//
// `endDate` is the last day, INCLUSIVE, and absent for the single-day norm —
// so these tests pin both halves: the range survives, and an event that is
// really one day looks exactly like it did before the field existed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const triage = require('../src/apps/agent/horst-triage');

const SETTINGS = { spamThresholdSuspect: 40, spamThresholdSpam: 60 };
const event = (over) => ({
  title: 'Samedan apartment stay',
  date: '2026-10-02',
  allDay: true,
  location: 'Chesa Quadrellas, Samedan',
  ...over,
});
const first = (ev) => triage.deriveIntel({ calendarEvents: [ev] }, SETTINGS).calendarEvents[0];

// --- the range survives -------------------------------------------------------

test('a multi-day stay keeps its last day instead of collapsing to the first', () => {
  const ev = first(event({ endDate: '2026-12-19' }));
  assert.equal(ev.date, '2026-10-02');
  assert.equal(ev.endDate, '2026-12-19'); // the 11 weeks the card used to lose
});

// --- what is not a range ------------------------------------------------------

test('a single-day event reports endDate null, not its own date', () => {
  assert.equal(first(event()).endDate, null);
});

test('an endDate equal to date is a single-day event, so the field stays empty', () => {
  assert.equal(first(event({ endDate: '2026-10-02' })).endDate, null);
});

test('an endDate BEFORE date is nonsense and is dropped, not stored backwards', () => {
  assert.equal(first(event({ endDate: '2026-09-30' })).endDate, null);
});

test('a malformed endDate is dropped and never reaches the calendar engine', () => {
  // '2026-13-45' and '2026-02-31' are the reason this is stricter than the
  // shape test: both pass YYYY-MM-DD and neither is a day.
  for (const bad of ['19.12.2026', '2026-13-45', '2026-02-31', 'December 19', '', null, 42, {}]) {
    assert.equal(first(event({ endDate: bad })).endDate, null, `should have dropped ${JSON.stringify(bad)}`);
  }
});

test('an undated event is still unschedulable, endDate or not', () => {
  assert.deepEqual(
    triage.deriveIntel({ calendarEvents: [{ title: 'No date', endDate: '2026-12-19' }] }, SETTINGS).calendarEvents,
    [],
  );
});

// --- nothing that was there moved ---------------------------------------------

test('the extracted-event shape is a superset: every key a consumer reads today survives', () => {
  const ev = first(event({ startTime: '14:00', endTime: '16:00', allDay: false, description: 'd', notes: 'n' }));
  assert.deepEqual(Object.keys(ev).sort(), [
    'allDay', 'date', 'description', 'endDate', 'endTime', 'location', 'notes', 'startTime', 'title',
  ]);
  assert.equal(ev.startTime, '14:00');
  assert.equal(ev.endTime, '16:00');
  assert.equal(ev.allDay, false);
});

// --- the contract the model is actually held to -------------------------------
// The prompt IS the producer contract here: a normalizer that accepts `endDate`
// is dead code if neither pass is asked for it, and there is no other seam to
// assert that from.

test('both extraction passes ask for endDate, and the proposal payload carries it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'apps', 'agent', 'horst-triage.js'), 'utf8');
  const schemas = src.split('\n').filter((l) => l.includes('"calendarEvents"'));
  assert.equal(schemas.length, 2, 'expected the batch-classify and attachment schemas');
  for (const line of schemas) assert.match(line, /"endDate"/);
  assert.match(src, /endDate: ev\.endDate \|\| undefined/, 'stageCalendarProposals must stage it');
  assert.doesNotMatch(src, /note the full date range in notes/, 'the flatten-the-range rule must be gone');
});
