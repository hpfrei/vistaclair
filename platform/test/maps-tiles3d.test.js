// ai.tiles3d (Photorealistic 3D Tiles): the root is the only billed request
// and is cached for the session window; child fetches are validated to the
// 3D Tiles path, carry the session + key server-side, and surface the glb's
// asset.copyright plus the cache headers the Map Tiles policy makes the
// caller honour. Hermetic: fetch is stubbed, no Google traffic.
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

const appsDir = makeAppsDir({ 'tiles-app': { capabilities: { maps: true } } });
appManager.setAppsDir(appsDir);
const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-tiles-'));
spendPolicy.init({ dataHome });
spendLedger.init({ dataHome });
deploymentMode.init({ hostConfig: { isSlave: () => false }, appManager: { list: () => [] } });

const origKey = core.resolveProviderKey;
const origFetch = global.fetch;
core.resolveProviderKey = (p) => (p === 'google-maps' ? 'TESTKEY' : '');

function glb(assetJson) {
  const json = Buffer.from(JSON.stringify({ asset: assetJson }), 'utf8');
  const pad = (4 - (json.length % 4)) % 4;
  const chunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'ascii');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + chunk.length, 8);
  head.writeUInt32LE(chunk.length, 12);
  head.write('JSON', 16, 'ascii');
  return Buffer.concat([head, chunk]);
}

const calls = [];
function stubFetch(url) {
  const u = new URL(String(url));
  calls.push(u);
  const H = (extra) => new Headers({ 'cache-control': 'private, max-age=3600', etag: '"e1"', ...extra });
  if (u.pathname === '/v1/3dtiles/root.json') {
    assert.equal(u.searchParams.get('key'), 'TESTKEY');
    const body = JSON.stringify({ asset: { version: '1.1' }, root: { geometricError: 1e6, boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
      children: [{ boundingVolume: { box: [] }, geometricError: 1e5, content: { uri: '/v1/3dtiles/datasets/CgA/files/child.json?session=SESS1' } }] } });
    return Promise.resolve(new Response(body, { status: 200, headers: H({ 'content-type': 'application/json' }) }));
  }
  if (u.pathname.endsWith('/child.json')) {
    assert.equal(u.searchParams.get('session'), 'SESS1');
    assert.equal(u.searchParams.get('key'), 'TESTKEY');
    return Promise.resolve(new Response(JSON.stringify({ root: { content: { uri: '/v1/3dtiles/datasets/CgA/files/tile.glb?session=SESS1' } } }),
      { status: 200, headers: H({ 'content-type': 'application/json' }) }));
  }
  if (u.pathname.endsWith('/tile.glb')) {
    if (u.searchParams.get('session') === 'STALE') {
      return Promise.resolve(new Response(JSON.stringify({ error: { message: 'session expired' } }), { status: 400 }));
    }
    return Promise.resolve(new Response(glb({ copyright: 'Data SIO;Landsat / Copernicus', generator: 'draco_decoder' }),
      { status: 200, headers: H({ 'content-type': 'model/gltf-binary' }) }));
  }
  return Promise.resolve(new Response('nope', { status: 404 }));
}
global.fetch = stubFetch;

test.after(() => {
  core.resolveProviderKey = origKey;
  global.fetch = origFetch;
  fs.rmSync(appsDir, { recursive: true, force: true });
  fs.rmSync(dataHome, { recursive: true, force: true });
});

test('root is fetched once per session window, billed once, then served from cache', async () => {
  const a = await maps.aiTiles3d('tiles-app', { op: 'root', fresh: true });
  assert.equal(a.session, 'SESS1');
  assert.equal(a.billed, true);
  assert.equal(a.cached, false);
  assert.ok(a.tileset.root.children[0].content.uri.includes('session=SESS1'));
  const b = await maps.aiTiles3d('tiles-app', {});
  assert.equal(b.billed, false);
  assert.equal(b.cached, true);
  assert.equal(calls.filter((u) => u.pathname === '/v1/3dtiles/root.json').length, 1);
  // two root calls, one hit Google: exactly one ledgered call, priced as one root request
  const q = spendLedger.query(path.join(appsDir, 'tiles-app'), { days: 1 });
  assert.equal(q.calls, 1, 'only the billed root settles');
  assert.ok(q.costUsd > 0);
});

test('fetch resolves a child tileset and a glb with copyright + cache metadata', async () => {
  const t = await maps.aiTiles3d('tiles-app', { op: 'fetch', uri: '/v1/3dtiles/datasets/CgA/files/child.json?session=SESS1' });
  assert.equal(t.kind, 'tileset');
  assert.equal(t.maxAge, 3600);
  assert.equal(t.etag, '"e1"');
  const g = await maps.aiTiles3d('tiles-app', { op: 'fetch', uri: t.json.root.content.uri });
  assert.equal(g.kind, 'glb');
  assert.equal(g.copyright, 'Data SIO;Landsat / Copernicus');
  assert.equal(g.generator, 'draco_decoder');
  assert.equal(Buffer.from(g.data, 'base64').subarray(0, 4).toString('ascii'), 'glTF');
  assert.equal(g.bytes, Buffer.from(g.data, 'base64').length);
});

test('fetch fills in the cached session when the uri lacks one, and never leaks an app-supplied key', async () => {
  const g = await maps.aiTiles3d('tiles-app', { op: 'fetch', uri: '/v1/3dtiles/datasets/CgA/files/tile.glb?key=EVIL' });
  assert.equal(g.kind, 'glb');
  const last = calls[calls.length - 1];
  assert.equal(last.searchParams.get('session'), 'SESS1');
  assert.equal(last.searchParams.get('key'), 'TESTKEY');
});

test('fetch refuses anything outside the 3D Tiles path and the root itself', async () => {
  for (const uri of ['https://evil.example/v1/3dtiles/x.glb', '/v1/2dtiles/x', '/v1/3dtiles/root.json', 'not a url at all /']) {
    await assert.rejects(maps.aiTiles3d('tiles-app', { op: 'fetch', uri }), /must be a relative 3D Tiles path|not a valid/);
  }
  await assert.rejects(maps.aiTiles3d('tiles-app', { op: 'fetch' }), /uri is required/);
  await assert.rejects(maps.aiTiles3d('tiles-app', { op: 'bogus' }), /Unknown tiles3d op/);
});

test('a rejected session drops the cached root so the next root call re-roots', async () => {
  await assert.rejects(maps.aiTiles3d('tiles-app', { op: 'fetch', uri: '/v1/3dtiles/datasets/CgA/files/tile.glb?session=STALE' }),
    /session expired|call op "root" again/);
  const r = await maps.aiTiles3d('tiles-app', { op: 'root' });
  assert.equal(r.billed, true, 'the invalidated cache forces a fresh, billed root');
});

test('no Maps key → the shared error, before any network call', async () => {
  core.resolveProviderKey = () => '';
  const before = calls.length;
  await assert.rejects(maps.aiTiles3d('tiles-app', {}), /Google Maps API key not configured/);
  assert.equal(calls.length, before);
  core.resolveProviderKey = (p) => (p === 'google-maps' ? 'TESTKEY' : '');
});
