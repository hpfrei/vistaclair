// Google auth: consent scope, account selection, and what "revoke" means.
//
// Three findings from the 8D calendar-parity wave, all in the class where the
// code is quietly answering a different question than the caller asked:
// a consent screen showing another account's scopes, a token request answered
// by whichever account was added first, and a "revoke" that only forgot.
//
// google-auth takes its secret store through init(), so the store is injected
// rather than patched. The HTTPS calls are not injectable, so `https.request`
// is swapped on the module object and restored in a finally — the same
// technique test/ai-model-resolve.test.js uses for core.listModels.
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const { EventEmitter } = require('events');

const googleAuth = require('../src/apps/google-auth');

const SCOPE = {
  cal: 'https://www.googleapis.com/auth/calendar',
  gmail: 'https://www.googleapis.com/auth/gmail.modify',
};

// An in-memory stand-in for core's aes-256-gcm store: same two methods, no
// crypto and no disk.
function fakeStore(initial) {
  let held = initial;
  return {
    readSecretFile: () => held,
    writeSecretFile: (_p, data) => { held = data; },
    _read: () => held,
  };
}

function withConfig(accounts, fn) {
  const store = fakeStore({
    clientId: 'cid.apps.googleusercontent.com',
    clientSecret: 'secret',
    accounts,
  });
  googleAuth.init('/tmp/does-not-exist', store);
  return fn(store);
}

// Capture outbound POSTs without letting one reach the network.
function withHttps(handler, fn) {
  const prev = https.request;
  const calls = [];
  https.request = (parsed, opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (d) => { body += d; };
    req.end = () => {
      calls.push({ url: `${parsed.protocol}//${parsed.host}${parsed.pathname}`, body });
      // Observe the world at the moment the request goes out — used to pin the
      // order of a revoke against the local delete.
      if (handler && handler.onCall) handler.onCall();
      const res = new EventEmitter();
      res.statusCode = handler ? handler.status : 200;
      process.nextTick(() => {
        cb(res);
        res.emit('data', handler ? handler.body : '');
        res.emit('end');
      });
    };
    req.destroy = () => {};
    return req;
  };
  try {
    return fn(calls);
  } finally {
    https.request = prev;
  }
}

// --- E-5: the consent screen asks for this account's scopes, not everyone's --

test('a re-auth URL carries only the named account\'s scopes', () => {
  withConfig({
    'cal@example.com': { grantedScopes: [SCOPE.cal], tokens: {} },
    'mail@example.com': { grantedScopes: [SCOPE.gmail], tokens: {} },
  }, () => {
    const url = googleAuth.getAuthUrl([SCOPE.cal], 'http://localhost/cb', 'cal@example.com');
    const scope = new URL(url).searchParams.get('scope');
    assert.ok(scope.includes(SCOPE.cal), 'keeps the scope it is re-authorising');
    assert.ok(
      !scope.includes(SCOPE.gmail),
      'a calendar re-auth must not present the other account\'s Gmail scopes',
    );
  });
});

test('a re-auth does not silently drop a scope the account already had', () => {
  withConfig({
    'both@example.com': { grantedScopes: [SCOPE.cal, SCOPE.gmail], tokens: {} },
  }, () => {
    const url = googleAuth.getAuthUrl([SCOPE.cal], 'http://localhost/cb', 'both@example.com');
    const scope = new URL(url).searchParams.get('scope');
    assert.ok(scope.includes(SCOPE.cal) && scope.includes(SCOPE.gmail));
  });
});

test('a first-time consent asks for exactly what was requested', () => {
  withConfig({
    'mail@example.com': { grantedScopes: [SCOPE.gmail], tokens: {} },
  }, () => {
    const url = googleAuth.getAuthUrl([SCOPE.cal], 'http://localhost/cb');
    const scope = new URL(url).searchParams.get('scope');
    assert.equal(scope, SCOPE.cal, 'no account named → no scopes carried in from one');
  });
});

// --- Account selection: ambiguity is a question, not insertion order --------

test('two accounts that both satisfy the scopes is refused, not guessed', async () => {
  await withConfig({
    'first@example.com': { grantedScopes: [SCOPE.cal], tokens: { access_token: 'a', expiry_date: Date.now() + 3600e3 } },
    'second@example.com': { grantedScopes: [SCOPE.cal], tokens: { access_token: 'b', expiry_date: Date.now() + 3600e3 } },
  }, async () => {
    const res = await googleAuth.getAccessToken([SCOPE.cal], 'http://localhost/cb');
    assert.equal(res.accessToken, undefined, 'must not answer with an arbitrary account');
    assert.deepEqual(res.ambiguous, ['first@example.com', 'second@example.com']);
    assert.match(res.error, /name the account explicitly/);
  });
});

test('one matching account still resolves without being named', async () => {
  await withConfig({
    'only@example.com': { grantedScopes: [SCOPE.cal], tokens: { access_token: 'tok', expiry_date: Date.now() + 3600e3 } },
    'other@example.com': { grantedScopes: [SCOPE.gmail], tokens: { access_token: 'nope', expiry_date: Date.now() + 3600e3 } },
  }, async () => {
    const res = await googleAuth.getAccessToken([SCOPE.cal], 'http://localhost/cb');
    assert.equal(res.accessToken, 'tok');
    assert.equal(res.email, 'only@example.com');
  });
});

test('naming the account is always unambiguous, however many could serve', async () => {
  await withConfig({
    'first@example.com': { grantedScopes: [SCOPE.cal], tokens: { access_token: 'a', expiry_date: Date.now() + 3600e3 } },
    'second@example.com': { grantedScopes: [SCOPE.cal], tokens: { access_token: 'b', expiry_date: Date.now() + 3600e3 } },
  }, async () => {
    const res = await googleAuth.getAccessToken([SCOPE.cal], 'http://localhost/cb', 'second@example.com');
    assert.equal(res.accessToken, 'b');
  });
});

// --- E-4: revoke tells Google ----------------------------------------------

test('revoking an account revokes the grant at Google, not just locally', async () => {
  await withConfig({
    'gone@example.com': { grantedScopes: [SCOPE.cal], tokens: { access_token: 'a', refresh_token: 'refresh-me' } },
  }, async (store) => {
    await withHttps({ status: 200, body: '' }, async (calls) => {
      const res = await googleAuth.revokeAccount('gone@example.com');
      assert.equal(res.revokedAtGoogle, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://oauth2.googleapis.com/revoke');
      assert.match(calls[0].body, /token=refresh-me/, 'the refresh token is what kills the whole grant');
      assert.equal(store._read().accounts['gone@example.com'], undefined, 'local record dropped too');
    });
  });
});

test('an empty 200 body is a successful revoke, not a parse failure', async () => {
  // Google answers the revoke endpoint with 200 and NO body; a JSON-only HTTP
  // helper reports every success as an error, which is why this path has its
  // own raw-body client.
  await withConfig({
    'gone@example.com': { grantedScopes: [], tokens: { refresh_token: 'r' } },
  }, async () => {
    await withHttps({ status: 200, body: '' }, async () => {
      const res = await googleAuth.revokeAccount('gone@example.com');
      assert.equal(res.ok, true);
      assert.equal(res.revokedAtGoogle, true);
    });
  });
});

test('a token Google already forgot is still a successful revoke', async () => {
  await withConfig({
    'gone@example.com': { grantedScopes: [], tokens: { refresh_token: 'r' } },
  }, async () => {
    await withHttps({ status: 400, body: '{"error":"invalid_token"}' }, async () => {
      const res = await googleAuth.revokeAccount('gone@example.com');
      assert.equal(res.revokedAtGoogle, true, 'already dead at Google is the desired end state');
    });
  });
});

test('the grant dies at Google BEFORE the local record is dropped', async () => {
  // Ordering is the whole safety property here. The stored token is the only
  // thing that can revoke the grant, so forgetting it first means a crash
  // between the two halves leaves the grant live at Google with nothing left
  // here to kill it with — and the owner believing they revoked it.
  await withConfig({
    'a@x': { grantedScopes: [SCOPE.cal], tokens: { refresh_token: 'rt-a' } },
  }, async () => {
    let listedDuringCall = null;
    await withHttps({
      status: 200,
      body: '',
      onCall: () => { listedDuringCall = googleAuth.listAccounts().map((a) => a.email); },
    }, async () => {
      await googleAuth.revokeAccount('a@x');
    });
    assert.deepEqual(listedDuringCall, ['a@x'], 'still held while the revoke is in flight');
    assert.deepEqual(googleAuth.listAccounts(), [], 'and gone once it returned');
  });
});

test('an unreachable Google still removes the account, and says it did not revoke', async () => {
  await withConfig({
    'gone@example.com': { grantedScopes: [], tokens: { refresh_token: 'r' } },
  }, async (store) => {
    await withHttps({ status: 503, body: 'upstream boom' }, async () => {
      const res = await googleAuth.revokeAccount('gone@example.com');
      assert.equal(res.ok, true);
      assert.equal(res.revokedAtGoogle, false, 'must not claim a revoke that did not happen');
      assert.match(res.reason, /503/);
      assert.equal(
        store._read().accounts['gone@example.com'], undefined,
        'an owner who asked to remove an account does not keep it because Google was down',
      );
    });
  });
});

// --- how the refusal reaches a caller ---------------------------------------

test('"name the account" reaches the caller as a caller error, not an expired grant', async () => {
  // google-api is the only door platform code uses, and it turns the result
  // object into a thrown Error. email-sync-gmail branches on err.authRequired
  // to decide whether to bounce the owner into re-consent — so labelling an
  // ambiguous request that way sends them off to re-authorise an account that
  // was working, and hides the one sentence saying what to fix.
  const googleApi = require('../src/apps/google-api');
  const googleAuth = require('../src/apps/google-auth');
  const prev = googleAuth.getAccessToken;
  try {
    googleAuth.getAccessToken = async () => ({
      authRequired: false, error: '2 Google accounts can serve this request (a@x, b@x) — name the account explicitly.',
      ambiguous: ['a@x', 'b@x'],
    });
    const err = await googleApi.getToken([SCOPE.cal]).then(() => null, (e) => e);
    assert.match(err.message, /name the account explicitly/);
    assert.deepEqual(err.ambiguous, ['a@x', 'b@x']);
    assert.ok(!err.authRequired, 'not an auth problem — both accounts are authorised');

    googleAuth.getAccessToken = async () => ({ authRequired: true, authUrl: 'https://consent' });
    const expired = await googleApi.getToken([SCOPE.cal]).then(() => null, (e) => e);
    assert.equal(expired.authRequired, true, 'a real expiry is still flagged');
    assert.equal(expired.authUrl, 'https://consent');
  } finally {
    googleAuth.getAccessToken = prev;
  }
});
