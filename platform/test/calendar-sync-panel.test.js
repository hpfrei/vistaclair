// Setup → Google → Calendar Sync: an account connected through
// googleAuth.exchangeCode (the Connect / re-authorize popup, or any in-process
// connect) with the calendar scope used to be listed with "0 calendars synced"
// forever. calendarAccounts() named it, but platform_calendar_sync had no rows
// for it — rows only appear once the owner opens Manage — so the panel showed
// no calendar and the poll synced nothing, while calendar writes (which fall
// back to Google's `primary`) kept working and made it look connected.
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { EventEmitter } = require('events');

const appDb = require('../src/apps/app-db');
const gapi = require('../src/apps/google-api');
const googleAuth = require('../src/apps/google-auth');
const calendarEngine = require('../src/apps/calendar-engine');

const EMAIL = 'owner@example.com';
const SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email '
  + 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send '
  + 'https://www.googleapis.com/auth/calendar';

// Connect an account the way the callback does: googleAuth.exchangeCode, with
// the token and userinfo endpoints answered locally.
async function connect(email, scope) {
  let held = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 's', accounts: {} };
  googleAuth.init('/tmp/does-not-exist', { readSecretFile: () => held, writeSecretFile: (_p, d) => { held = d; } });
  const prev = https.request;
  https.request = (parsed, _opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {}; req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      process.nextTick(() => {
        cb(res);
        res.emit('data', JSON.stringify(parsed.pathname.includes('token')
          ? { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope }
          : { email }));
        res.emit('end');
      });
    };
    return req;
  };
  try { await googleAuth.exchangeCode('code', 'http://x/cb'); } finally { https.request = prev; }
}

// An in-memory platform_calendar_sync behind the pool, and a Google that lists
// two calendars. Only the statements the engine issues for this path.
async function withEngine(fn) {
  const rows = [];
  const prevPool = appDb.getPool;
  const prevGet = gapi.get;
  const prevGetToken = gapi.getToken;
  const calls = [];
  gapi.getToken = async () => 'tok';
  gapi.get = async (url) => {
    calls.push(url);
    if (/calendarList/.test(url)) {
      return { items: [
        { id: 'work@group', summary: 'Work', backgroundColor: '#111' },
        { id: EMAIL, summary: 'Owner', backgroundColor: '#222', primary: true },
      ] };
    }
    return { items: [], nextSyncToken: 't' };
  };
  appDb.getPool = () => ({
    getConnection: async () => ({
      query: async (q, p) => {
        if (/^USE /.test(q)) return [];
        if (/^SELECT .* FROM platform_calendar_sync WHERE account = \? AND selected = 1/.test(q)) {
          return rows.filter((r) => r.account === p[0] && r.selected);
        }
        if (/^SELECT .* FROM platform_calendar_sync WHERE account = \?/.test(q)) {
          return rows.filter((r) => r.account === p[0]);
        }
        if (/^SELECT \* FROM platform_calendar_sync/.test(q)) return rows.slice();
        if (/^INSERT INTO platform_calendar_sync/.test(q)) {
          const [account, calendar_id, name, background_color] = p;
          const hit = rows.find((r) => r.account === account && r.calendar_id === calendar_id);
          if (hit) Object.assign(hit, { name, background_color });
          else rows.push({ account, calendar_id, name, background_color, selected: 0 });
          return { affectedRows: 1 };
        }
        if (/^UPDATE platform_calendar_sync SET selected = 1 WHERE account = \? AND calendar_id = \?/.test(q)) {
          rows.filter((r) => r.account === p[0] && r.calendar_id === p[1]).forEach((r) => { r.selected = 1; });
          return { affectedRows: 1 };
        }
        return [];
      },
      beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
      release() {},
    }),
  });
  try {
    return await fn({ rows, calls });
  } finally {
    appDb.getPool = prevPool;
    gapi.get = prevGet;
    gapi.getToken = prevGetToken;
  }
}

test('an account connected with the calendar scope has no calendar rows until discovery', async () => {
  await connect(EMAIL, SCOPES);
  assert.deepEqual(calendarEngine.calendarAccounts(), [EMAIL]);
  await withEngine(async () => {
    // What the panel received before the fix: the account, and nothing under it.
    assert.deepEqual(await calendarEngine.syncStatus(), []);
  });
});

test('panelStatus reads the calendar list of a fresh account and selects its primary', async () => {
  await connect(EMAIL, SCOPES);
  await withEngine(async ({ rows }) => {
    const p = await calendarEngine.panelStatus();
    assert.deepEqual(p.accounts, [EMAIL]);
    assert.deepEqual(p.errors, {});
    assert.deepEqual(p.status.map((s) => [s.calendarId, s.selected]).sort(),
      [[EMAIL, true], ['work@group', false]]);
    assert.equal(rows.length, 2);
  });
});

test('once rows exist the owner\'s selection is never touched, even an empty one', async () => {
  await connect(EMAIL, SCOPES);
  await withEngine(async ({ rows, calls }) => {
    await calendarEngine.panelStatus();
    rows.forEach((r) => { r.selected = 0; });            // owner deselects everything
    const before = calls.length;
    const p = await calendarEngine.panelStatus();
    assert.equal(p.status.filter((s) => s.selected).length, 0);
    assert.equal(calls.length, before, 'no second calendarList call');
  });
});

test('a discovery failure is reported per account, not swallowed into an empty list', async () => {
  await connect(EMAIL, SCOPES);
  await withEngine(async () => {
    gapi.get = async () => { throw new Error('boom'); };
    const p = await calendarEngine.panelStatus();
    assert.deepEqual(p.accounts, [EMAIL]);
    assert.equal(p.errors[EMAIL], 'boom');
  });
});

test('an account without a calendar scope is not offered', async () => {
  await connect(EMAIL, 'openid https://www.googleapis.com/auth/gmail.modify');
  await withEngine(async () => {
    const p = await calendarEngine.panelStatus();
    assert.deepEqual(p.accounts, []);
  });
});
