// Google sign-in links the server builds point back to the platform's public
// URL (Setup → Telegram "Public URL"), and the callback exchanges the code with
// the redirect URI the link carried (stored with the state), not with whatever
// the tunnel put in the request headers.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const telegram = require('../src/apps/telegram');
const googleApi = require('../src/apps/google-api');
const googleAuth = require('../src/apps/google-auth');
const { createHandler } = require('../src/apps/google-callback');

function withPublicUrl(url, fn) {
  const orig = telegram.getPublicUrl;
  telegram.getPublicUrl = () => url;
  try { return fn(); } finally { telegram.getPublicUrl = orig; }
}

function init() {
  let held = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 's', accounts: {} };
  googleAuth.init('/tmp/does-not-exist', { readSecretFile: () => held, writeSecretFile: (_p, d) => { held = d; } });
}

test('redirectUri: the public URL when set, localhost when not', () => {
  withPublicUrl('https://fun-lab-heroic.ngrok-free.app/', () => {
    assert.equal(googleApi.redirectUri(), 'https://fun-lab-heroic.ngrok-free.app/pro/auth/google/callback');
  });
  withPublicUrl('', () => {
    assert.match(googleApi.redirectUri(), /^http:\/\/localhost:\d+\/pro\/auth\/google\/callback$/);
  });
});

test('connectAuthUrl without an override carries the public-URL redirect', () => {
  init();
  withPublicUrl('https://fun-lab-heroic.ngrok-free.app', () => {
    const url = new URL(googleApi.connectAuthUrl());
    assert.equal(url.searchParams.get('redirect_uri'), 'https://fun-lab-heroic.ngrok-free.app/pro/auth/google/callback');
  });
});

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });
}

test('callback exchanges with the URI stored with the state, not the headers; states are single-use', async () => {
  init();
  const X = 'https://fun-lab-heroic.ngrok-free.app/pro/auth/google/callback';
  const uris = [];
  const fake = { consumeState: googleAuth.consumeState, exchangeCode: async (_code, uri) => { uris.push(uri); return { email: 'a@b.c', grantedScopes: ['s'] }; } };
  const app = express();
  app.get('/cb', createHandler(fake));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  try {
    const state = new URL(googleAuth.getAuthUrl(['openid'], X)).searchParams.get('state');
    const hdrs = { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example:9' };
    let r = await get(port, `/cb?code=c&state=${state}`, hdrs);
    assert.equal(r.status, 200);
    assert.deepEqual(uris, [X]);
    // reused, unknown and missing states are refused without an exchange
    r = await get(port, `/cb?code=c&state=${state}`, hdrs);
    assert.equal(r.status, 400);
    r = await get(port, '/cb?code=c&state=forged', hdrs);
    assert.equal(r.status, 400);
    r = await get(port, '/cb?code=c', hdrs);
    assert.equal(r.status, 400);
    assert.equal(uris.length, 1);
    // a state with no stored URI falls back to the header-derived value
    const bare = new URL(googleAuth.getAuthUrl(['openid'], '')).searchParams.get('state');
    r = await get(port, `/cb?code=c&state=${bare}`, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'h.example' });
    assert.equal(uris[1], 'https://h.example/pro/auth/google/callback');
  } finally { server.close(); }
});
