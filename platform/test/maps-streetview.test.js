// ai.streetview (Street View Static): the metadata probe is free and settles
// nothing, an image is resolved through that probe first (so no coverage costs
// nothing and every image carries its copyright), sizes/fov/pitch are clamped
// to the API's own limits, and `source: 'outdoor'` reaches Google.
// Hermetic: fetch is stubbed, no Google traffic.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const spendPolicy = require('../src/apps/spend-policy');
const spendLedger = require('../src/apps/spend-ledger');
const deploymentMode = require('../src/apps/deployment-mode');
const { core } = require('../src/apps/core-services');
const maps = require('../src/apps/maps-service');

const appsDir = makeAppsDir({ 'sv-app': { capabilities: { maps: true } } });
appManager.setAppsDir(appsDir);
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-sv-'));
spendPolicy.init({ dataHome });
spendLedger.init({ dataHome });
deploymentMode.init({ hostConfig: { isSlave: () => false }, appManager: { list: () => [] } });

const origKey = core.resolveProviderKey;
const origFetch = global.fetch;
core.resolveProviderKey = (p) => (p === 'google-maps' ? 'TESTKEY' : '');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const COPY = '© 2024 Google';

const calls = [];
function stubFetch(url) {
  const u = new URL(String(url));
  calls.push(u);
  if (u.pathname === '/maps/api/streetview/metadata') {
    assert.equal(u.searchParams.get('key'), 'TESTKEY');
    // the one coordinate with no coverage
    if (u.searchParams.get('location') === '0,0') {
      return Promise.resolve(new Response(JSON.stringify({ status: 'ZERO_RESULTS' }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    if (u.searchParams.get('pano') === 'DENIED') {
      return Promise.resolve(new Response(JSON.stringify({ status: 'REQUEST_DENIED', error_message: 'API not activated' }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    // metadata knows this pano, but its imagery is gone — the 404 path below
    if (u.searchParams.get('pano') === 'GONE') {
      return Promise.resolve(new Response(JSON.stringify({ status: 'OK', copyright: COPY, date: '2019-04', location: { lat: 1, lng: 2 }, pano_id: 'GONE' }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return Promise.resolve(new Response(JSON.stringify({
      status: 'OK', copyright: COPY, date: '2023-07', location: { lat: 46.4972, lng: 9.8409 }, pano_id: 'PANO1',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  if (u.pathname === '/maps/api/streetview') {
    assert.equal(u.searchParams.get('key'), 'TESTKEY');
    assert.equal(u.searchParams.get('return_error_code'), 'true');
    if (u.searchParams.get('pano') === 'GONE') {
      return Promise.resolve(new Response('no imagery', { status: 404 }));
    }
    return Promise.resolve(new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }));
  }
  return Promise.resolve(new Response('nope', { status: 404 }));
}
global.fetch = stubFetch;

const ledger = () => spendLedger.query(path.join(appsDir, 'sv-app'), { days: 1 });
const lastCall = () => calls[calls.length - 1];

test.after(() => {
  core.resolveProviderKey = origKey;
  global.fetch = origFetch;
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(dataHome, { recursive: true, force: true });
});

test('metadata is the default op, is free, and settles nothing', async () => {
  const m = await maps.aiStreetview('sv-app', { lat: 46.4972, lng: 9.8409, radius: 60, source: 'outdoor' });
  assert.equal(m.status, 'OK');
  assert.equal(m.pano_id, 'PANO1');
  assert.equal(m.date, '2023-07');
  assert.deepEqual(m.location, { lat: 46.4972, lng: 9.8409 });
  assert.equal(m.copyright, COPY);
  const u = lastCall();
  assert.equal(u.pathname, '/maps/api/streetview/metadata');
  assert.equal(u.searchParams.get('location'), '46.4972,9.8409');
  assert.equal(u.searchParams.get('radius'), '60');
  assert.equal(u.searchParams.get('source'), 'outdoor', "Google's own exterior filter reaches the API");
  assert.equal(ledger().calls, 0, 'the free metadata endpoint never settles');
});

test('radius defaults to 50 m and a pano_id selects the panorama directly', async () => {
  await maps.aiStreetview('sv-app', { lat: 1, lng: 2 });
  assert.equal(lastCall().searchParams.get('radius'), '50');
  await maps.aiStreetview('sv-app', { pano_id: 'PANO9' });
  assert.equal(lastCall().searchParams.get('pano'), 'PANO9');
  assert.equal(lastCall().searchParams.get('radius'), null, 'a named pano needs no search radius');
  assert.equal(ledger().calls, 0);
});

test('an image resolves through metadata, settles once, and carries its attribution', async () => {
  const before = ledger().calls;
  const img = await maps.aiStreetview('sv-app', {
    op: 'image', lat: 46.4972, lng: 9.8409, heading: 214, pitch: 8, fov: 80, width: 640, height: 480, source: 'outdoor',
  });
  assert.equal(img.status, 'OK');
  assert.equal(img.mimeType, 'image/jpeg');
  assert.equal(Buffer.from(img.data, 'base64').subarray(0, 2).toString('hex'), 'ffd8');
  assert.equal(img.dataUri, `data:image/jpeg;base64,${img.data}`);
  assert.equal(img.bytes, JPEG.length);
  assert.equal(img.copyright, COPY, 'the image endpoint returns none; the free probe supplies it');
  assert.equal(img.pano_id, 'PANO1');
  assert.equal(img.date, '2023-07');
  assert.equal(img.billed, true);

  const u = lastCall();
  assert.equal(u.pathname, '/maps/api/streetview');
  assert.equal(u.searchParams.get('pano'), 'PANO1', 'requested by pano id, so the framing is deterministic');
  assert.equal(u.searchParams.get('heading'), '214');
  assert.equal(u.searchParams.get('pitch'), '8');
  assert.equal(u.searchParams.get('fov'), '80');
  assert.equal(u.searchParams.get('size'), '640x480');
  assert.equal(ledger().calls - before, 1, 'one image, one ledgered call');
});

test('out-of-range framing is clamped to the API limits, not refused', async () => {
  await maps.aiStreetview('sv-app', { op: 'image', lat: 1, lng: 2, width: 4000, height: 4000, fov: 500, pitch: -400, heading: 730 });
  const u = lastCall();
  assert.equal(u.searchParams.get('size'), '640x640', 'the Street View Static ceiling');
  assert.equal(u.searchParams.get('fov'), '120');
  assert.equal(u.searchParams.get('pitch'), '-90');
  assert.equal(u.searchParams.get('heading'), '10', '730° normalises into 0–360');
});

test('no coverage is a status with data null — never billed, never an exception', async () => {
  const before = ledger().calls;
  const n = calls.length;
  const r = await maps.aiStreetview('sv-app', { op: 'image', lat: 0, lng: 0, heading: 90 });
  assert.equal(r.status, 'ZERO_RESULTS');
  assert.equal(r.data, null);
  assert.equal(r.dataUri, null);
  assert.equal(r.billed, false);
  assert.equal(calls.length - n, 1, 'the billed image endpoint is never reached');
  assert.equal(ledger().calls, before, 'an uncovered coordinate costs nothing');
});

test('a 404 from the image endpoint (return_error_code) is ZERO_RESULTS, not a grey placeholder', async () => {
  const before = ledger().calls;
  const r = await maps.aiStreetview('sv-app', { op: 'image', pano_id: 'GONE', heading: 0 });
  assert.equal(r.status, 'ZERO_RESULTS');
  assert.equal(r.data, null);
  assert.equal(r.billed, false);
  assert.equal(ledger().calls, before);
});

test('a denied key and a bad op throw; a missing selector is caught before the network', async () => {
  await assert.rejects(maps.aiStreetview('sv-app', { pano_id: 'DENIED' }), /REQUEST_DENIED|API not activated/);
  await assert.rejects(maps.aiStreetview('sv-app', { op: 'bogus', lat: 1, lng: 2 }), /Unknown streetview op/);
  const n = calls.length;
  await assert.rejects(maps.aiStreetview('sv-app', { op: 'image' }), /lat\/lng or pano_id is required/);
  assert.equal(calls.length, n);
});

test('no Maps key → the shared error, before any network call', async () => {
  core.resolveProviderKey = () => '';
  const n = calls.length;
  await assert.rejects(maps.aiStreetview('sv-app', { lat: 1, lng: 2 }), /Google Maps API key not configured/);
  assert.equal(calls.length, n);
  core.resolveProviderKey = (p) => (p === 'google-maps' ? 'TESTKEY' : '');
});
