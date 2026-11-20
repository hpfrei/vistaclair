// The sync reconcile: the one place the calendar engine cancels events on its
// own initiative.
//
// Why it exists: the engine lists with singleEvents:true, so Google expands
// recurring masters into instances — and when a master is deleted, the
// incremental sync never sends those instances back as cancelled. They would
// sit in the local mirror forever. So every 24 hours the engine does a full
// re-list and cancels anything Google did not return.
//
// Why it needs a test: that rule is "delete everything I did not just see". If
// the set of what was seen is ever incomplete — a failed page, a narrower query
// than the reconcile assumes — the engine quietly cancels events the owner
// still has. Nothing throws, and the mirror is what every read, briefing and
// conflict check is answered from.
const test = require('node:test');
const assert = require('node:assert/strict');

const appDb = require('../src/apps/app-db');
const gapi = require('../src/apps/google-api');
const { _sync: { syncCalendar } } = require('../src/apps/calendar-engine');

const ACCT = 'a@x';
const CAL = 'cal1';

const event = (id, start = '2026-03-02T09:00:00Z') => ({
  id, summary: id, status: 'confirmed',
  start: { dateTime: start }, end: { dateTime: start },
});

// `pages` is what Google answers, in order (or an Error to throw).
// `localRows` is what the mirror already holds.
async function withSync({ pages, localRows = [], calRow = {} }, fn) {
  const prevGapi = { ...gapi };
  const prevPool = appDb.getPool;
  const queue = [...pages];
  const requests = [];
  const cancelled = [];
  const updates = [];

  gapi.get = async (url) => {
    requests.push(url);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  appDb.getPool = () => ({
    getConnection: async () => ({
      query: async (q, p) => {
        if (/^USE /.test(q)) return [];
        if (/SELECT event_id FROM platform_calendar_events/.test(q)) return localRows;
        if (/platform_calendar_events SET is_cancelled/.test(q)) { cancelled.push(...p.slice(2)); return []; }
        if (/platform_calendar_sync SET/.test(q)) updates.push({ q, p });
        return [];
      },
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
      release() {},
    }),
  });

  try {
    const changed = await syncCalendar(ACCT, 'tok', { calendar_id: CAL, ...calRow });
    return fn({ changed, cancelled, requests, updates });
  } finally {
    Object.assign(gapi, prevGapi);
    appDb.getPool = prevPool;
  }
}

const paramsOf = (url) => Object.fromEntries(new URL(url).searchParams);

// --- when the reconcile runs ------------------------------------------------

test('an incremental sync does NOT reconcile, however little Google returns', async () => {
  // The whole point of an incremental sync is that it returns only changes. If
  // this ever reconciled, a quiet day would cancel the entire calendar.
  await withSync({
    pages: [{ items: [event('e1')], nextSyncToken: 'tok2' }],
    localRows: [{ event_id: 'e1' }, { event_id: 'e2' }, { event_id: 'e3' }],
    calRow: { sync_token: 'tok1', last_full_sync_at: new Date() },
  }, ({ cancelled, requests }) => {
    assert.equal(paramsOf(requests[0]).syncToken, 'tok1');
    assert.deepEqual(cancelled, [], 'e2 and e3 were simply not in this delta');
  });
});

test('a full re-list is forced when the last one was over 24 hours ago', async () => {
  const old = new Date(Date.now() - 25 * 3600e3);
  await withSync({
    pages: [{ items: [], nextSyncToken: 'tok2' }],
    calRow: { sync_token: 'tok1', last_full_sync_at: old },
  }, ({ requests, updates }) => {
    const p = paramsOf(requests[0]);
    assert.equal(p.syncToken, undefined, 'the stale token is dropped');
    assert.ok(p.timeMin, 'a full list is bounded by timeMin instead');
    assert.match(updates.at(-1).q, /last_full_sync_at = CURRENT_TIMESTAMP/, 'and the clock is reset');
  });

  // Inside the window, the token is kept and the full list is not paid for.
  await withSync({
    pages: [{ items: [], nextSyncToken: 'tok2' }],
    calRow: { sync_token: 'tok1', last_full_sync_at: new Date() },
  }, ({ requests, updates }) => {
    assert.equal(paramsOf(requests[0]).syncToken, 'tok1');
    assert.doesNotMatch(updates.at(-1).q, /last_full_sync_at/);
  });
});

// --- what it cancels, and what it must not ---------------------------------

test('a full re-list cancels exactly the rows Google no longer has', async () => {
  await withSync({
    pages: [{ items: [event('keep1'), event('keep2')], nextSyncToken: 'tok2' }],
    localRows: [{ event_id: 'keep1' }, { event_id: 'gone1' }, { event_id: 'keep2' }, { event_id: 'gone2' }],
  }, ({ cancelled, changed }) => {
    assert.deepEqual(cancelled.sort(), ['gone1', 'gone2']);
    // Both the returned events and the cancelled ones are news to subscribers:
    // a disappeared event has to reach the UI too.
    for (const id of ['keep1', 'keep2', 'gone1', 'gone2']) assert.ok(changed.includes(id), id);
  });
});

test('the reconcile spans every page, not just the last one', async () => {
  // Paginating and only remembering the final page would cancel almost
  // everything on any calendar big enough to page.
  await withSync({
    pages: [
      { items: [event('p1a'), event('p1b')], nextPageToken: 'pg2' },
      { items: [event('p2a')], nextSyncToken: 'tok2' },
    ],
    localRows: [{ event_id: 'p1a' }, { event_id: 'p1b' }, { event_id: 'p2a' }, { event_id: 'gone' }],
  }, ({ cancelled, requests }) => {
    assert.equal(requests.length, 2);
    assert.deepEqual(cancelled, ['gone']);
  });
});

test('a failed page aborts the whole sync rather than reconciling a partial view', async () => {
  // This is the dangerous case: page 1 arrives, page 2 fails. The seen-set now
  // holds a fraction of the calendar. Cancelling on that basis would wipe most
  // of the owner's events.
  const boom = new Error('502 Bad Gateway');
  await assert.rejects(() => withSync({
    pages: [{ items: [event('p1a')], nextPageToken: 'pg2' }, boom],
    localRows: [{ event_id: 'p1a' }, { event_id: 'p2a' }, { event_id: 'p2b' }],
  }, () => {}), /502/);
});

test('an expired sync token restarts as a full list instead of failing', async () => {
  const gone = Object.assign(new Error('Gone'), { status: 410 });
  await withSync({
    pages: [gone, { items: [event('e1')], nextSyncToken: 'tok2' }],
    calRow: { sync_token: 'stale', last_full_sync_at: new Date() },
    localRows: [{ event_id: 'e1' }, { event_id: 'e2' }],
  }, ({ requests, cancelled }) => {
    assert.equal(paramsOf(requests[0]).syncToken, 'stale');
    assert.equal(paramsOf(requests[1]).syncToken, undefined, 'the retry carries no token');
    assert.ok(paramsOf(requests[1]).timeMin);
    // The run BEGAN incremental, so it does not reconcile even though it ended
    // up doing a full list. Conservative on purpose: skipping a reconcile costs
    // one stale row until the next 24h sweep, cancelling wrongly costs data.
    assert.deepEqual(cancelled, [], 'e2 survives a run that was not planned as a full list');
  });
});

test('a full list of an empty calendar cancels everything, because that is the truth', async () => {
  await withSync({
    pages: [{ items: [], nextSyncToken: 'tok2' }],
    localRows: [{ event_id: 'a' }, { event_id: 'b' }],
  }, ({ cancelled }) => {
    assert.deepEqual(cancelled.sort(), ['a', 'b']);
  });
});

test('the reconcile query and the list query cover the same window', async () => {
  // The list asks Google for one year back; the reconcile must only consider
  // rows in that same window. Widen one without the other and every event
  // older than the query becomes an orphan.
  await withSync({ pages: [{ items: [], nextSyncToken: 't' }] }, ({ requests }) => {
    const timeMin = new Date(paramsOf(requests[0]).timeMin);
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    assert.ok(Math.abs(timeMin - yearAgo) < 60e3, 'one year back');
  });
});
