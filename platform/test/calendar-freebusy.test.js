// Free/busy: the question "when is the user free?" answered from Google
// rather than from a window of events someone already fetched.
//
// The app this replaces compared every pair of events in a cached 7-day window
// in the browser, so it could only ever see calendars it had already pulled and
// never a calendar the owner had not selected. What it could produce, and what
// these tests exist to prevent, is a confident "free" for a slot that is not.
//
// google-api is required as a module object by calendar-engine, so its two
// methods are swapped and restored in a finally — no DB and no network. Passing
// `calendarIds` explicitly keeps the default-calendar lookup (the only DB read
// in this path) out of the way.
const test = require('node:test');
const assert = require('node:assert/strict');

const gapi = require('../src/apps/google-api');
const calendarEngine = require('../src/apps/calendar-engine');

const ACCT = 'a@x';
const IDS = ['primary'];

// `calendars` is the freeBusy response body Google would return.
async function withGoogle(calendars, fn) {
  const prevPost = gapi.post;
  const prevToken = gapi.getToken;
  const posts = [];
  gapi.getToken = async () => 'tok';
  gapi.post = async (url, _token, body) => {
    posts.push({ url, body });
    return { calendars };
  };
  try {
    return await fn(posts);
  } finally {
    gapi.post = prevPost;
    gapi.getToken = prevToken;
  }
}

const busy = (...pairs) => ({ busy: pairs.map(([start, end]) => ({ start, end })) });

test('overlapping busy intervals from different calendars merge into one', async () => {
  await withGoogle({
    work: busy(['2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z']),
    personal: busy(['2026-03-02T09:30:00Z', '2026-03-02T11:00:00Z']),
  }, async () => {
    const res = await calendarEngine.freeBusy({
      account: ACCT, calendarIds: ['work', 'personal'],
      timeMin: '2026-03-02T08:00:00Z', timeMax: '2026-03-02T18:00:00Z',
    });
    assert.deepEqual(res.busy, [
      { start: '2026-03-02T09:00:00.000Z', end: '2026-03-02T11:00:00.000Z' },
    ]);
    // The per-calendar view survives the merge — a caller may need to know
    // WHICH calendar is busy.
    assert.equal(Object.keys(res.calendars).length, 2);
  });
});

test('touching intervals merge; a real gap between them does not', async () => {
  await withGoogle({
    primary: busy(
      ['2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'],
      ['2026-03-02T10:00:00Z', '2026-03-02T11:00:00Z'], // abuts exactly
      ['2026-03-02T12:00:00Z', '2026-03-02T13:00:00Z'], // an hour later
    ),
  }, async () => {
    const res = await calendarEngine.freeBusy({
      account: ACCT, calendarIds: IDS,
      timeMin: '2026-03-02T08:00:00Z', timeMax: '2026-03-02T18:00:00Z',
    });
    assert.deepEqual(res.busy.map((b) => [b.start, b.end]), [
      ['2026-03-02T09:00:00.000Z', '2026-03-02T11:00:00.000Z'],
      ['2026-03-02T12:00:00.000Z', '2026-03-02T13:00:00.000Z'],
    ]);
  });
});

test('an interval fully inside another does not reopen the merged one', async () => {
  // The classic fold bug: a short meeting nested inside a long one moves the
  // cursor BACKWARDS and splits a busy block into fake free time.
  await withGoogle({
    primary: busy(
      ['2026-03-02T09:00:00Z', '2026-03-02T17:00:00Z'],
      ['2026-03-02T10:00:00Z', '2026-03-02T10:30:00Z'],
    ),
  }, async () => {
    const res = await calendarEngine.freeBusy({
      account: ACCT, calendarIds: IDS,
      timeMin: '2026-03-02T08:00:00Z', timeMax: '2026-03-02T18:00:00Z',
    });
    assert.deepEqual(res.busy, [
      { start: '2026-03-02T09:00:00.000Z', end: '2026-03-02T17:00:00.000Z' },
    ]);
  });
});

test('a calendar Google could not read is reported, never counted as free', async () => {
  await withGoogle({
    primary: busy(['2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z']),
    shared: { errors: [{ domain: 'global', reason: 'notFound' }] },
  }, async () => {
    const res = await calendarEngine.freeBusy({
      account: ACCT, calendarIds: ['primary', 'shared'],
      timeMin: '2026-03-02T08:00:00Z', timeMax: '2026-03-02T18:00:00Z',
    });
    assert.deepEqual(res.errors, [{ calendarId: 'shared', reason: 'notFound' }]);
    assert.equal(res.calendars.shared, undefined, 'an unreadable calendar is absent, not empty');
  });
});

// --- availability: the free slots between the busy ones ---------------------

test('free slots are the gaps, bounded by the window and filtered by length', async () => {
  await withGoogle({
    primary: busy(
      ['2026-03-02T09:00:00Z', '2026-03-02T10:00:00Z'],
      ['2026-03-02T10:15:00Z', '2026-03-02T11:00:00Z'], // only a 15-min gap
      ['2026-03-02T13:00:00Z', '2026-03-02T14:00:00Z'],
    ),
  }, async () => {
    const res = await calendarEngine.availability({
      account: ACCT, calendarIds: IDS,
      timeMin: '2026-03-02T08:00:00Z', timeMax: '2026-03-02T18:00:00Z',
      minMinutes: 30,
    });
    assert.deepEqual(res.free.map((f) => [f.start, f.end]), [
      ['2026-03-02T08:00:00.000Z', '2026-03-02T09:00:00.000Z'], // before the first
      ['2026-03-02T11:00:00.000Z', '2026-03-02T13:00:00.000Z'], // between
      ['2026-03-02T14:00:00.000Z', '2026-03-02T18:00:00.000Z'], // after the last
    ]);
  });
});

test('a wholly free window is one slot; a wholly busy one is none', async () => {
  await withGoogle({ primary: busy() }, async () => {
    const res = await calendarEngine.availability({
      account: ACCT, calendarIds: IDS,
      timeMin: '2026-03-02T08:00:00Z', timeMax: '2026-03-02T09:00:00Z', minMinutes: 30,
    });
    assert.deepEqual(res.free, [{ start: '2026-03-02T08:00:00.000Z', end: '2026-03-02T09:00:00.000Z' }]);
  });

  await withGoogle({
    primary: busy(['2026-03-02T07:00:00Z', '2026-03-02T19:00:00Z']),
  }, async () => {
    const res = await calendarEngine.availability({
      account: ACCT, calendarIds: IDS,
      timeMin: '2026-03-02T08:00:00Z', timeMax: '2026-03-02T18:00:00Z', minMinutes: 30,
    });
    assert.deepEqual(res.free, [], 'busy beyond both edges leaves nothing');
  });
});

// --- the window itself ------------------------------------------------------

test('a nonsense window is refused here rather than relayed as a Google 400', async () => {
  const cases = [
    [{ account: ACCT }, /timeMin and timeMax required/],
    [{ account: ACCT, timeMin: 'not-a-date', timeMax: '2026-03-02T18:00:00Z' }, /must be dates/],
    [{ account: ACCT, timeMin: '2026-03-02T18:00:00Z', timeMax: '2026-03-02T08:00:00Z' }, /must be after/],
    [{ account: ACCT, timeMin: '2026-01-01T00:00:00Z', timeMax: '2026-12-31T00:00:00Z' }, /90 days/],
    [{ timeMin: '2026-03-02T08:00:00Z', timeMax: '2026-03-02T18:00:00Z' }, /account required/],
  ];
  for (const [params, expected] of cases) {
    await assert.rejects(() => calendarEngine.freeBusy(params), expected);
  }
});
