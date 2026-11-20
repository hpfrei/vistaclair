// Editing and deleting ONE occurrence of a recurring event, versus the series.
//
// Google syncs expanded INSTANCES; the rule lives on the master. So "this and
// all following" and "the whole series" are not operations on the event the
// owner clicked — they mutate the master. Getting the target wrong here is the
// worst failure mode in the calendar: deleting the master when the owner asked
// to drop one occurrence destroys years of history, silently and irreversibly,
// and nothing throws.
//
// This is the first test in the repo that needs a database. It does not need a
// real one: every write on these paths is bookkeeping on the local mirror, and
// what is under test is which Google call is made against which id. So
// appDb.getPool() is stubbed with a recording double, in the same swap-and-
// restore style the rest of the suite uses for module exports.
const test = require('node:test');
const assert = require('node:assert/strict');

const appDb = require('../src/apps/app-db');
const gapi = require('../src/apps/google-api');
const calendarEngine = require('../src/apps/calendar-engine');

const ACCT = 'a@x';
const CAL = 'cal1';
const MASTER = 'master1';
const INSTANCE = 'master1_20260309T090000Z';

// The instance the owner clicked: the third Monday of a weekly series.
const instance = () => ({
  id: INSTANCE, recurringEventId: MASTER,
  start: { dateTime: '2026-03-09T09:00:00Z' }, end: { dateTime: '2026-03-09T10:00:00Z' },
});
const master = () => ({
  id: MASTER, summary: 'Standup',
  start: { dateTime: '2026-03-02T09:00:00Z' }, end: { dateTime: '2026-03-02T10:00:00Z' },
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
});

// Records every Google call and every SQL statement, and answers gets by id.
async function withCalendar(fn, { events } = {}) {
  const prevGapi = { ...gapi };
  const prevPool = appDb.getPool;
  const calls = [];
  const sql = [];
  const byId = events || { [MASTER]: master(), [INSTANCE]: instance() };

  gapi.getToken = async () => 'tok';
  gapi.get = async (url) => {
    calls.push({ method: 'GET', url });
    const id = decodeURIComponent(url.split('/events/')[1] || '');
    if (!byId[id]) { const e = new Error('Not Found'); e.statusCode = 404; throw e; }
    return byId[id];
  };
  gapi.del = async (url) => { calls.push({ method: 'DELETE', url }); return {}; };
  gapi.post = async (url, _t, body) => { calls.push({ method: 'POST', url, body }); return { id: 'new1', ...body }; };
  gapi.put = async (url, _t, body) => { calls.push({ method: 'PUT', url, body }); return { id: 'put1', ...body }; };
  gapi.request = async (method, url, { body } = {}) => { calls.push({ method, url, body }); return { id: MASTER, ...body }; };
  appDb.getPool = () => ({
    getConnection: async () => ({
      query: async (q, p) => { if (!/^USE /.test(q)) sql.push({ q, p }); return []; },
      // upsertEvents writes the local mirror transactionally.
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
      release() {},
    }),
  });

  try {
    // Exact endpoint match: the instance id is the master id plus a suffix, so
    // a substring test would report the master as touched whenever the
    // instance was — hiding the exact bug this file exists to catch.
    const on = (m, id) => calls.find((c) => c.method === m
      && c.url.split('?')[0].endsWith(`/events/${encodeURIComponent(id)}`));
    return await fn({ calls, sql, on });
  } finally {
    Object.assign(gapi, prevGapi);
    appDb.getPool = prevPool;
  }
}

const untilOf = (call) => (call.body.recurrence[0].match(/UNTIL=([^;]+)/) || [])[1];

// --- delete -----------------------------------------------------------------

test('deleting one occurrence touches that occurrence and nothing else', async () => {
  await withCalendar(async ({ calls, on }) => {
    await calendarEngine.deleteEvent({ account: ACCT, calendarId: CAL, eventId: INSTANCE });
    assert.equal(calls.length, 1);
    assert.ok(on('DELETE', INSTANCE), 'the instance is deleted');
    assert.equal(on('DELETE', MASTER), undefined, 'the master is not');
  });
});

test('deleting the whole series deletes the MASTER, found from the instance', async () => {
  await withCalendar(async ({ on }) => {
    await calendarEngine.deleteEvent({ account: ACCT, calendarId: CAL, eventId: INSTANCE, scope: 'all' });
    const del = on('DELETE', MASTER);
    assert.ok(del, 'the master is what carries the series');
    // The owner clicked an instance; deleting that id alone would leave the
    // series alive and re-materialise the occurrence on the next sync.
    assert.ok(del.url.endsWith(encodeURIComponent(MASTER)));
  });
});

test('"this and following" truncates the series and NEVER deletes anything', async () => {
  await withCalendar(async ({ calls }) => {
    await calendarEngine.deleteEvent({ account: ACCT, calendarId: CAL, eventId: INSTANCE, scope: 'following' });
    assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0,
      'a delete here would take the earlier occurrences with it');
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch.url.includes(encodeURIComponent(MASTER)), 'the rule lives on the master');
    // One second before the occurrence: UNTIL is inclusive, so the occurrence
    // the owner removed must fall outside it, and the one before it must not.
    assert.equal(untilOf(patch), '20260309T085959Z');
  });
});

test('a plain non-recurring event has no master to look for', async () => {
  const solo = { id: 'solo1', start: { dateTime: '2026-03-09T09:00:00Z' }, end: { dateTime: '2026-03-09T10:00:00Z' } };
  await withCalendar(async ({ on }) => {
    await calendarEngine.deleteEvent({ account: ACCT, calendarId: CAL, eventId: 'solo1', scope: 'all' });
    assert.ok(on('DELETE', 'solo1'), 'it is its own master');
  }, { events: { solo1: solo } });
});

// --- update -----------------------------------------------------------------

test('editing one occurrence edits that occurrence, leaving the series alone', async () => {
  await withCalendar(async ({ on }) => {
    await calendarEngine.updateEvent({
      account: ACCT, calendarId: CAL, eventId: INSTANCE,
      title: 'Standup (moved)', date: '2026-03-09', startTime: '10:00', endTime: '11:00',
    });
    assert.equal(on('PATCH', INSTANCE).body.summary, 'Standup (moved)');
    assert.equal(on('PATCH', MASTER), undefined, 'the master is untouched');
  });
});

test('an edit changes what it names and nothing else', async () => {
  // events.update REPLACES the resource: a PUT of {summary} clears the
  // description, the attendees, the reminders and — on a series master — the
  // recurrence rule, with no error and no way back. Horst's calendar.update
  // sends only the fields that changed, so this is that method's normal shape.
  await withCalendar(async ({ on }) => {
    await calendarEngine.updateEvent({ account: ACCT, calendarId: CAL, eventId: MASTER, title: 'Renamed' });
    const body = on('PATCH', MASTER).body;
    assert.deepEqual(Object.keys(body), ['summary'], 'only the field the caller named');
    for (const k of ['description', 'attendees', 'reminders', 'recurrence', 'start', 'end']) {
      assert.ok(!(k in body), `${k} must not be sent, or the write clears it`);
    }
  });
});

test('an empty value is a deliberate clear, and is sent as one', async () => {
  // The other half of the same distinction: if absent means "leave alone", then
  // removing every attendee has to be expressible, and the people being removed
  // are exactly the ones Google must notify.
  await withCalendar(async ({ on }) => {
    await calendarEngine.updateEvent({
      account: ACCT, calendarId: CAL, eventId: MASTER,
      attendees: [], location: '', reminderMinutes: null,
    });
    const call = on('PATCH', MASTER);
    assert.deepEqual(call.body.attendees, []);
    assert.equal(call.body.location, '');
    assert.deepEqual(call.body.reminders, { useDefault: true });
    assert.match(call.url, /sendUpdates=all/, 'a removed guest is told');
  });
});

test('editing the whole series shifts it by the edit, and keeps the duration', async () => {
  // The owner edited the 9 March instance from 09:00 to 10:00. The series
  // starts 2 March. Writing the edited start onto the master would move the
  // whole series to 9 March — losing the first week entirely.
  await withCalendar(async ({ calls }) => {
    await calendarEngine.updateEvent({
      account: ACCT, calendarId: CAL, eventId: INSTANCE, scope: 'all',
      title: 'Standup', date: '2026-03-09', startTime: '10:00', endTime: '11:00', timezone: 'UTC',
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch.url.includes(encodeURIComponent(MASTER)));
    assert.equal(patch.body.start.dateTime, '2026-03-02T10:00:00.000Z',
      'the series still starts 2 March, one hour later');
    assert.equal(patch.body.end.dateTime, '2026-03-02T11:00:00.000Z', 'and still lasts an hour');
  });
});

test('editing the whole series with no time change leaves the start exactly as it was', async () => {
  await withCalendar(async ({ calls }) => {
    await calendarEngine.updateEvent({
      account: ACCT, calendarId: CAL, eventId: INSTANCE, scope: 'all', title: 'Renamed',
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.equal(patch.body.summary, 'Renamed');
    assert.equal(patch.body.start, undefined, 'a rename must not rewrite the schedule');
  });
});

test('"this and following" caps the old series and starts a new one from here', async () => {
  await withCalendar(async ({ calls }) => {
    await calendarEngine.updateEvent({
      account: ACCT, calendarId: CAL, eventId: INSTANCE, scope: 'following',
      title: 'Standup (new time)', date: '2026-03-09', startTime: '10:00', endTime: '11:00', timezone: 'UTC',
    });
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.equal(untilOf(patch), '20260309T085959Z', 'the old series ends before this occurrence');

    const post = calls.find((c) => c.method === 'POST');
    assert.equal(post.body.summary, 'Standup (new time)');
    assert.equal(post.body.start.dateTime, '2026-03-09T10:00:00');
    assert.deepEqual(post.body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      'the new series inherits the old rule when the edit did not change it');
    assert.equal(post.body.id, undefined, 'a new event, not a copy of the old id');
  });
});

test('"this and following" with no time edit keeps the occurrence where it was', async () => {
  await withCalendar(async ({ calls }) => {
    await calendarEngine.updateEvent({
      account: ACCT, calendarId: CAL, eventId: INSTANCE, scope: 'following', title: 'Renamed',
    });
    const post = calls.find((c) => c.method === 'POST');
    assert.deepEqual(post.body.start, instance().start, 'the split point, not the master start');
    assert.deepEqual(post.body.end, instance().end);
  });
});

test('the local mirror is cancelled in step with Google, per scope', async () => {
  // Bookkeeping, but the wrong WHERE leaves deleted occurrences on screen until
  // the next full sync, or blanks ones that still exist.
  await withCalendar(async ({ sql }) => {
    await calendarEngine.deleteEvent({ account: ACCT, calendarId: CAL, eventId: INSTANCE, scope: 'all' });
    assert.match(sql[0].q, /is_cancelled = TRUE/);
    assert.match(sql[0].q, /recurring_event_id = \?/, 'the instances go with the master');
  });
  await withCalendar(async ({ sql }) => {
    await calendarEngine.deleteEvent({ account: ACCT, calendarId: CAL, eventId: INSTANCE, scope: 'following' });
    assert.match(sql[0].q, /start_datetime >= \?/, 'only from the cutoff forward');
    assert.ok(sql[0].p.includes(MASTER));
  });
});

// --- the clock the wall time is read against --------------------------------

test('a series edit shifts by the same amount whatever timezone the box is in', async () => {
  // The bug this pins: buildEventBody emits a naive dateTime plus a separate
  // timeZone field, and the shift was computed with Date.parse, which reads a
  // naive string as the SERVER's local time. On a box in Berlin, editing a
  // UTC calendar's series from 09:00 to 10:00 computed a delta of zero — the
  // series silently did not move, and nothing failed.
  const seen = [];
  for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
    const prevTZ = process.env.TZ;
    process.env.TZ = tz;
    try {
      await withCalendar(async ({ calls }) => {
        await calendarEngine.updateEvent({
          account: ACCT, calendarId: CAL, eventId: INSTANCE, scope: 'all',
          title: 'Standup', date: '2026-03-09', startTime: '10:00', endTime: '11:00', timezone: 'UTC',
        });
        seen.push(calls.find((c) => c.method === 'PATCH').body.start.dateTime);
      });
    } finally { process.env.TZ = prevTZ; }
  }
  assert.deepEqual(seen, Array(3).fill('2026-03-02T10:00:00.000Z'),
    'the answer is a property of the calendar, not of the server');
});

test('an explicit offset is honoured over the timeZone field', async () => {
  await withCalendar(async ({ calls }) => {
    await calendarEngine.updateEvent({
      account: ACCT, calendarId: CAL, eventId: INSTANCE, scope: 'all',
      title: 'Standup', start: { dateTime: '2026-03-09T10:00:00+02:00' }, end: { dateTime: '2026-03-09T11:00:00+02:00' },
    });
    // 10:00+02:00 is 08:00Z — an hour EARLIER than the 09:00Z instance, so the
    // series moves back, not forward.
    assert.equal(calls.find((c) => c.method === 'PATCH').body.start.dateTime, '2026-03-02T08:00:00.000Z');
  });
});
