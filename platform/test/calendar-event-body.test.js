// The calendar write path: one domain shape in, a Google event body out.
//
// This used to be two implementations. The engine took either a domain-ish
// object OR a raw Google body it passed straight through, and my-dashboard used
// the second door — building conferenceData, reminders.overrides, sendUpdates,
// conferenceDataVersion and the RRULE itself. The app's was the only complete
// one, so "create an event" behaved differently depending on which surface
// asked. The passthrough is gone; these tests hold the engine to what the app
// used to do, plus the things the app got right that the engine never had.
//
// google-api is swapped on the module object and restored in a finally, so
// nothing here touches the network. `calendarId` is always explicit: resolving
// the default is the only DB read in this path.
const test = require('node:test');
const assert = require('node:assert/strict');

const gapi = require('../src/apps/google-api');
const calendarEngine = require('../src/apps/calendar-engine');

const ACCT = 'a@x';
const BASE = { account: ACCT, calendarId: 'cal1', title: 'Standup', date: '2026-03-02', startTime: '09:00', endTime: '09:30' };

// Captures what would have gone to Google, and answers with a plausible event.
async function captureCreate(params, fn) {
  const prev = { post: gapi.post, getToken: gapi.getToken, get: gapi.get, request: gapi.request, put: gapi.put };
  const calls = [];
  gapi.getToken = async () => 'tok';
  gapi.post = async (url, _t, body) => { calls.push({ url, body }); return { id: 'ev1', ...body }; };
  gapi.put = async (url, _t, body) => { calls.push({ url, body }); return { id: 'ev1', ...body }; };
  try {
    // upsertEvents and the memory miner both want a DB, and neither is under
    // test — but an error BEFORE the post means the body was never built, which
    // is exactly what these tests are looking for. So swallow only what happens
    // after Google was called.
    try {
      await calendarEngine.createEvent(params);
    } catch (err) {
      if (!calls.length) throw err;
    }
    return fn(calls[0]);
  } finally { Object.assign(gapi, prev); }
}

// For the paths that must throw before anything reaches Google.
async function refuses(params, expected) {
  const prev = { post: gapi.post, getToken: gapi.getToken };
  gapi.getToken = async () => 'tok';
  gapi.post = async () => { throw new Error('should never be called'); };
  try {
    await assert.rejects(() => calendarEngine.createEvent(params), expected);
  } finally { Object.assign(gapi, prev); }
}

const query = (url) => Object.fromEntries(new URL(url).searchParams);

// --- the shape itself -------------------------------------------------------

test('a timed event becomes start/end with the timezone resolved here', async () => {
  await captureCreate(BASE, ({ body }) => {
    assert.equal(body.summary, 'Standup');
    assert.equal(body.start.dateTime, '2026-03-02T09:00:00');
    assert.equal(body.end.dateTime, '2026-03-02T09:30:00');
    assert.ok(body.start.timeZone, 'timezone is engine-resolved, never sent by a caller');
    assert.equal(body.start.timeZone, body.end.timeZone);
  });
});

test('an all-day event ends the day AFTER, because Google\'s end is exclusive', async () => {
  // Off by one here and every single-day all-day event renders as zero-length.
  await captureCreate({ ...BASE, allDay: true, startTime: null }, ({ body }) => {
    assert.deepEqual(body.start, { date: '2026-03-02' });
    assert.deepEqual(body.end, { date: '2026-03-03' });
  });
  await captureCreate({ ...BASE, allDay: true, startTime: null, endDate: '2026-03-04' }, ({ body }) => {
    assert.deepEqual(body.end, { date: '2026-03-05' });
  });
});

test('a timed event can cross midnight via endDate', async () => {
  // The engine's old domain branch ignored endDate for timed events and always
  // ended on the start date, producing an end BEFORE the start.
  await captureCreate({ ...BASE, startTime: '23:00', endTime: '01:00', endDate: '2026-03-03' }, ({ body }) => {
    assert.equal(body.start.dateTime, '2026-03-02T23:00:00');
    assert.equal(body.end.dateTime, '2026-03-03T01:00:00');
    assert.ok(Date.parse(body.end.dateTime) > Date.parse(body.start.dateTime));
  });
});

test('attendees are accepted as strings or objects, and blanks dropped', async () => {
  await captureCreate({ ...BASE, attendees: ['x@y', { email: 'z@w' }, { name: 'no address' }, null] }, ({ body }) => {
    assert.deepEqual(body.attendees, [{ email: 'x@y' }, { email: 'z@w' }]);
  });
});

// --- what only the app could express before ---------------------------------

test('addMeet builds the conference request AND the version param', async () => {
  // conferenceDataVersion=1 is not optional: without it Google accepts the
  // event and silently creates no Meet link at all.
  await captureCreate({ ...BASE, addMeet: true }, ({ url, body }) => {
    assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
    assert.ok(body.conferenceData.createRequest.requestId, 'a request id is what mints a new link');
    assert.equal(query(url).conferenceDataVersion, '1');
  });
  await captureCreate(BASE, ({ url, body }) => {
    assert.equal(body.conferenceData, undefined);
    assert.equal(query(url).conferenceDataVersion, undefined);
  });
});

test('two Meet requests do not share a request id', async () => {
  // A reused requestId makes Google return the SAME conference, so two meetings
  // would share one link.
  const ids = [];
  for (let i = 0; i < 2; i++) {
    await captureCreate({ ...BASE, addMeet: true }, ({ body }) => ids.push(body.conferenceData.createRequest.requestId));
  }
  assert.notEqual(ids[0], ids[1]);
});

test('reminderMinutes becomes an override, and attachments opt in', async () => {
  await captureCreate({ ...BASE, reminderMinutes: 10 }, ({ body }) => {
    assert.deepEqual(body.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] });
  });
  await captureCreate({ ...BASE, reminderMinutes: 0 }, ({ body }) => {
    assert.equal(body.reminders.overrides[0].minutes, 0, '"at the time of the event" is a real choice, not absent');
  });
  await captureCreate({ ...BASE, attachments: [{ fileUrl: 'https://d/1', title: 'Agenda' }, { title: 'no url' }] }, ({ url, body }) => {
    assert.deepEqual(body.attachments, [{ fileUrl: 'https://d/1', title: 'Agenda' }]);
    assert.equal(query(url).supportsAttachments, 'true', 'Google drops attachments without it');
  });
});

test('recurrence is a rule, and the engine writes the RRULE', async () => {
  await captureCreate({ ...BASE, recurrence: { freq: 'WEEKLY', byday: ['MO', 'WE'] } }, ({ body }) => {
    assert.deepEqual(body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE']);
  });
  // Absent means "leave the series alone"; explicitly empty means "make it single".
  await captureCreate(BASE, ({ body }) => assert.equal(body.recurrence, undefined));
  await captureCreate({ ...BASE, recurrence: [] }, ({ body }) => assert.deepEqual(body.recurrence, []));
});

// --- notification, which nobody should have to remember ---------------------

test('inviting someone notifies them unless the caller says otherwise', async () => {
  await captureCreate({ ...BASE, attendees: ['x@y'] }, ({ url }) => {
    assert.equal(query(url).sendUpdates, 'all');
  });
  await captureCreate({ ...BASE, attendees: ['x@y'], sendUpdates: 'none' }, ({ url }) => {
    assert.equal(query(url).sendUpdates, 'none', 'a deliberate silence is still available');
  });
  await captureCreate(BASE, ({ url }) => {
    assert.equal(query(url).sendUpdates, undefined, 'an event with nobody to tell says nothing');
  });
});

// --- the door that closed ---------------------------------------------------

test('a raw Google event body is refused, loudly and by name', async () => {
  // Silently ignoring it would create an event with no title and no time.
  await refuses(
    { account: ACCT, calendarId: 'cal1', event: { summary: 'X', start: { dateTime: '2026-03-02T09:00:00Z' } } },
    /not a raw Google event body/,
  );
});

test('RRULE strings are refused where a rule object belongs', async () => {
  await refuses({ ...BASE, recurrence: ['RRULE:FREQ=WEEKLY'] }, /recurrence is a rule object/);
});
