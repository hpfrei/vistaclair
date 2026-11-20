// Setup → Google "Connect Google account": the consent link for a NEW account
// (no email yet) must carry openid + email + the engines' Gmail and Calendar
// scopes, and a fresh state. An empty scope is rejected by Google.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const googleAuth = require('../src/apps/google-auth');
const googleApi = require('../src/apps/google-api');

function init() {
  let held = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 's', accounts: {} };
  googleAuth.init('/tmp/does-not-exist', { readSecretFile: () => held, writeSecretFile: (_p, d) => { held = d; } });
}

test('connectAuthUrl: scope has openid, email, gmail, calendar; state present', () => {
  init();
  const url = new URL(googleApi.connectAuthUrl('http://localhost:3457/pro/auth/google/callback'));
  const scope = (url.searchParams.get('scope') || '').split(' ');
  assert.ok(scope.length > 0 && scope[0] !== '');
  for (const s of ['openid', 'email']) assert.ok(scope.includes(s), s);
  assert.ok(scope.some(s => s.includes('/auth/gmail.')), 'gmail scope');
  assert.ok(scope.some(s => s.endsWith('/auth/calendar')), 'calendar scope');
  for (const list of Object.values(googleApi.SCOPES)) for (const s of list) assert.ok(scope.includes(s), s);
  assert.ok(url.searchParams.get('state'));
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3457/pro/auth/google/callback');
});

test('connectAuthUrl throws when credentials are not configured', () => {
  googleAuth.init('/tmp/does-not-exist', { readSecretFile: () => ({}), writeSecretFile() {} });
  assert.throws(() => googleApi.connectAuthUrl('http://x/cb'), /not configured/);
});

test('the WS handler and the button are wired to it', () => {
  const root = path.join(__dirname, '..');
  const idx = fs.readFileSync(path.join(root, 'src/apps/index.js'), 'utf8');
  assert.match(idx, /case 'app:setup:oauthConnect'[\s\S]{0,300}googleApi\.connectAuthUrl[\s\S]{0,200}app:setup:oauthReauthUrl/);
  const ui = fs.readFileSync(path.join(root, 'public/apps.js'), 'utf8');
  assert.match(ui, /type: 'app:setup:oauthConnect'/);
  assert.match(ui, /appsModule\.startGoogleConnect/);
});
