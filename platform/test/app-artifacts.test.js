// Artifact store (app-artifacts.js): content-addressed put with dedupe, path
// containment, mime guessing, principals and grants, import, pins and gc, the
// per-owner quota, extractRefs; the ctx.artifacts capability bound to its app;
// and the agent tools (artifact-tools.js) confined to the holder's cwd.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeAppsDir } = require('./helpers');
const appManager = require('../src/apps/app-manager');
const capabilities = require('../src/apps/capabilities');
const appTools = require('../src/apps/app-tools');
const art = require('../src/apps/app-artifacts');
const { builtinTools } = require('../src/apps/artifact-tools');

const appsDir = makeAppsDir({ 'maker': {}, 'viewer': {} });
appManager.setAppsDir(appsDir);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-artifacts-'));
const store = path.join(tmp, 'artifacts');
art.init({ dir: store });

const makerDir = path.join(appsDir, 'maker');
const viewerDir = path.join(appsDir, 'viewer');
fs.mkdirSync(path.join(makerDir, 'out'), { recursive: true });
fs.writeFileSync(path.join(makerDir, 'out', 'model.glb'), 'glTF-binary-bytes');
fs.writeFileSync(path.join(makerDir, 'out', 'copy.glb'), 'glTF-binary-bytes');
fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside');

const tool = (name) => builtinTools.find((t) => t.name === name);
const session = (holder) => ({ id: 's1', mode: 'grant', toolNames: [], holder });
const textOf = (r) => r.content[0].text;

test('put stores content-addressed, dedupes blobs, keeps the app file, and returns a resource_link', async () => {
  const a = await art.put('maker', 'out/model.glb', { labels: { scene: 'x' } });
  const b = await art.put('maker', path.join(makerDir, 'out', 'copy.glb'), { name: 'other.glb' });
  assert.match(a.id, /^art_[0-9a-f]{16}-[0-9a-f]{4}$/);
  assert.equal(a.uri, `vc-artifact://${a.id}`);
  assert.equal(a.sha256, b.sha256);
  assert.notEqual(a.id, b.id);
  assert.equal(a.id.slice(4, 20), a.sha256.slice(0, 16));
  assert.equal(art.blobPath(a.uri), path.join(store, 'blobs', a.sha256.slice(0, 2), a.sha256));
  assert.equal(fs.readdirSync(path.join(store, 'blobs', a.sha256.slice(0, 2))).length, 1);
  assert.ok(fs.existsSync(path.join(makerDir, 'out', 'model.glb')), 'never moves the app file');
  assert.ok(fs.existsSync(path.join(store, 'meta', `${a.id}.json`)));
  assert.deepEqual(a.link, { type: 'resource_link', uri: a.uri, name: 'model.glb', mimeType: 'model/gltf-binary', size: 17 });
  assert.deepEqual(a.producer, { app: 'maker', tool: null, callId: null, jobId: null });
  assert.equal(art.get(a.id).name, 'model.glb');
  assert.equal(art.get(a.uri).labels.scene, 'x');
  assert.equal(art.get('vc-artifact://art_0000000000000000-0000'), null);
  // The app rewriting its file in place does not change the stored blob.
  fs.writeFileSync(path.join(makerDir, 'out', 'model.glb'), 'changed');
  assert.equal(fs.readFileSync(art.blobPath(a.id), 'utf-8'), 'glTF-binary-bytes');
});

test('put refuses paths that escape the app directory, lexically or through a symlink', async () => {
  await assert.rejects(art.put('maker', '../viewer/manifest.json'), /outside/);
  await assert.rejects(art.put('maker', path.join(tmp, 'secret.txt')), /outside/);
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(makerDir, 'out', 'link.txt'));
  await assert.rejects(art.put('maker', 'out/link.txt'), /outside/);
  await assert.rejects(art.put('maker', 'out'), /not a file/);
});

test('mime is guessed from the extension unless given; buffers need a name for it', async () => {
  assert.equal(art.guessMime('a.mp4'), 'video/mp4');
  assert.equal(art.guessMime('A.PDF'), 'application/pdf');
  assert.equal(art.guessMime('scene.gltf'), 'model/gltf+json');
  assert.equal(art.guessMime('noext'), 'application/octet-stream');
  const pdf = await art.put('maker', Buffer.from('%PDF-1.7'), { name: 'doc.pdf' });
  assert.equal(pdf.mime, 'application/pdf');
  const forced = await art.put('maker', Buffer.from('x'), { name: 'a.bin', mime: 'text/plain' });
  assert.equal(forced.mime, 'text/plain');
});

test('principalOf maps every typed caller', () => {
  assert.deepEqual(art.principalOf({ type: 'orchestrator', runId: 'r1', address: 'o' }), { type: 'run', runId: 'r1' });
  assert.deepEqual(art.principalOf({ type: 'worker', runId: 'r1', address: 'w', workerId: 'w1' }), { type: 'run', runId: 'r1' });
  assert.deepEqual(art.principalOf({ type: 'app', appName: 'viewer' }), { type: 'app', app: 'viewer' });
  assert.deepEqual(art.principalOf({ type: 'self', appName: 'maker' }), { type: 'app', app: 'maker' });
  assert.deepEqual(art.principalOf({ type: 'self' }, 'maker'), { type: 'app', app: 'maker' });
  for (const type of ['platform', 'cron', 'owner', 'gui-test']) assert.deepEqual(art.principalOf({ type }), { type: 'owner' });
  assert.equal(art.principalOf({ type: 'self' }), null);
  assert.equal(art.principalOf(null), null);
  assert.equal(art.principalOf({ type: 'stranger' }), null);
});

test('a put inside a tool call grants the caller and records the producer', async () => {
  const call = { caller: { type: 'worker', runId: 'run-7', address: 'w' }, app: 'maker', tool: 'export_model', callId: 'c1', jobId: 'j1' };
  const a = await art.put('maker', Buffer.from('from-call'), { name: 'r.glb' }, call);
  assert.deepEqual(a.producer, { app: 'maker', tool: 'export_model', callId: 'c1', jobId: 'j1' });
  assert.ok(art.canRead({ type: 'run', runId: 'run-7' }, a.uri));
  assert.ok(!art.canRead({ type: 'run', runId: 'run-8' }, a.uri));
  const b = await art.put('maker', Buffer.from('from-app'), { name: 'q.glb' }, { caller: { type: 'app', appName: 'viewer' }, app: 'maker', tool: 't' });
  assert.ok(art.canRead({ type: 'app', app: 'viewer' }, b.id));
  const c = await art.put('maker', Buffer.from('from-owner'), { name: 'o.glb' }, { caller: { type: 'platform' }, app: 'maker', tool: 't' });
  assert.deepEqual(art.get(c.id).grants, [], 'the owner reads everything; nothing to store');
});

test('canRead / grant / import refuse without access', async () => {
  const a = await art.put('maker', Buffer.from('private'), { name: 'p.txt' });
  const viewer = { type: 'app', app: 'viewer' };
  assert.ok(art.canRead({ type: 'app', app: 'maker' }, a.id), 'the producing app reads its own');
  assert.ok(art.canRead({ type: 'owner' }, a.id));
  assert.ok(!art.canRead(viewer, a.id));
  assert.ok(!art.canRead(null, a.id));
  assert.throws(() => art.import('viewer', a.uri, 'in/p.txt'), /No read access/);
  assert.ok(!fs.existsSync(path.join(viewerDir, 'in', 'p.txt')));
  assert.throws(() => art.grant(a.id, { type: 'nobody' }), /principal/);
  assert.throws(() => art.grant('art_0000000000000000-0000', viewer), /Unknown artifact/);
  art.grant(a.id, viewer);
  art.grant(a.id, viewer);
  assert.deepEqual(art.get(a.id).grants, ['app:viewer']);
  const out = art.import('viewer', a.uri, 'in/p.txt');
  assert.equal(out.path, path.join(viewerDir, 'in', 'p.txt'));
  assert.equal(fs.readFileSync(out.path, 'utf-8'), 'private');
  assert.throws(() => art.import('viewer', a.uri, '../maker/x.txt'), /outside/);
  fs.symlinkSync(tmp, path.join(viewerDir, 'escape'));
  assert.throws(() => art.import('viewer', a.uri, 'escape/x.txt'), /outside/);
  assert.ok(!fs.existsSync(path.join(tmp, 'x.txt')));
});

test('extractRefs finds every vc-artifact uri in nested strings, once each', () => {
  const u1 = 'vc-artifact://art_0123456789abcdef-a1b2';
  const u2 = 'vc-artifact://art_fedcba9876543210-0000';
  const value = { a: `use ${u1} please`, b: [{ c: u2 }, `${u1} again`], n: 3, z: null, bad: 'vc-artifact://art_short-1' };
  value.self = value;
  assert.deepEqual(art.extractRefs(value).sort(), [u1, u2].sort());
  assert.deepEqual(art.extractRefs('nothing'), []);
  assert.deepEqual(art.extractRefs(null), []);
});

test('gc keeps pinned and fresh artifacts, collects old unpinned ones and orphan blobs', async () => {
  const keep = await art.put('maker', Buffer.from('pinned-old'), { name: 'k.bin' });
  const old = await art.put('maker', Buffer.from('unpinned-old'), { name: 'o.bin' });
  const fresh = await art.put('maker', Buffer.from('fresh'), { name: 'f.bin' });
  art.pin(keep.uri, 'run:run-7', 'final deliverable');
  assert.equal(art.get(keep.id).pinned, true);
  assert.equal(art.list({ pinned: true }).filter((r) => r.id === keep.id).length, 1);
  const orphan = path.join(store, 'blobs', 'ab', 'ab'.padEnd(64, '0'));
  fs.mkdirSync(path.dirname(orphan), { recursive: true });
  fs.writeFileSync(orphan, 'orphan');
  const later = Date.parse(fresh.createdAt) + 31 * 24 * 3600e3;
  // Make `fresh` young relative to `later` by rewriting its createdAt.
  const meta = path.join(store, 'meta', `${fresh.id}.json`);
  const rec = JSON.parse(fs.readFileSync(meta, 'utf-8'));
  rec.createdAt = new Date(later - 3600e3).toISOString();
  fs.writeFileSync(meta, JSON.stringify(rec));
  art.init({ dir: store }); // reload records from disk
  const res = art.gc({ now: later });
  assert.ok(res.removed >= 1);
  assert.ok(art.get(keep.id), 'pinned survives');
  assert.ok(fs.existsSync(art.blobPath(keep.id)));
  assert.equal(art.get(old.id), null, 'old unpinned is collected');
  assert.ok(!fs.existsSync(path.join(store, 'blobs', old.sha256.slice(0, 2), old.sha256)), 'its blob is gone');
  assert.ok(art.get(fresh.id), 'fresh survives');
  assert.ok(!fs.existsSync(orphan), 'orphan blob removed');
  art.unpin(keep.id, 'run:run-7');
  art.gc({ now: later });
  assert.equal(art.get(keep.id), null, 'unpinned, it goes too');
});

test('put throws a clear error above the per-app quota; dedupe does not count twice', async () => {
  const qStore = path.join(tmp, 'quota');
  art.init({ dir: qStore, quotaMB: 1 });
  try {
    const big = Buffer.alloc(700 * 1024, 1);
    await art.put('maker', big, { name: 'a.bin' });
    await art.put('maker', big, { name: 'same-bytes.bin' });
    await assert.rejects(art.put('maker', Buffer.alloc(700 * 1024, 2), { name: 'b.bin' }), /Artifact quota exceeded for app:maker.*artifactAppQuotaMB/);
    await art.put('viewer', Buffer.alloc(700 * 1024, 2), { name: 'b.bin' }); // another app has its own quota
    assert.equal(fs.readdirSync(path.join(qStore, 'tmp')).length, 0, 'the refused snapshot is cleaned up');
  } finally { art.init({ dir: store }); }
});

test('ctx.artifacts is bound to its app; the bridge reads with the app principal', async () => {
  const ctx = capabilities.buildCtx({ name: 'viewer', dir: viewerDir, manifest: {} }, { profile: 'dashboard' });
  assert.deepEqual(Object.keys(ctx.artifacts).sort(), ['get', 'import', 'list', 'pin', 'put', 'unpin']);
  const own = await ctx.artifacts.put(Buffer.from('viewer-owned'), { name: 'v.txt' });
  assert.equal(own.producer.app, 'viewer');
  assert.equal(art.get(own.id).app, 'viewer');
  const theirs = await art.put('maker', Buffer.from('maker-owned'), { name: 'm.txt' });
  assert.equal(ctx.artifacts.get(theirs.uri), null, 'cannot see another app\'s artifact');
  assert.throws(() => ctx.artifacts.import(theirs.uri, 'x.txt'), /No read access/);
  assert.throws(() => ctx.artifacts.pin(theirs.uri, 'why'), /No read access/);
  assert.ok(!ctx.artifacts.list().some((r) => r.id === theirs.id));
  assert.ok(ctx.artifacts.list().some((r) => r.id === own.id));
  assert.equal(ctx.artifacts.pin(own.id, 'keep').pins[0].holder, 'app:viewer');
  // currentCall (app-tools, AsyncLocalStorage) is feature-probed: when present, put grants the caller.
  const orig = appTools.currentCall;
  appTools.currentCall = () => ({ caller: { type: 'orchestrator', runId: 'run-9' }, app: 'viewer', tool: 'make', callId: 'k', jobId: null });
  try {
    const granted = await ctx.artifacts.put(Buffer.from('for-run'), { name: 'g.txt' });
    assert.ok(art.canRead({ type: 'run', runId: 'run-9' }, granted.uri));
    assert.equal(granted.producer.tool, 'make');
  } finally { if (orig) appTools.currentCall = orig; else delete appTools.currentCall; }
  // Bridge: same principal, never a path.
  const get = capabilities.dispatch('artifacts.get');
  const list = capabilities.dispatch('artifacts.list');
  const viewerApp = { name: 'viewer', dir: viewerDir };
  assert.equal(await get(viewerApp, { ref: theirs.uri }), null);
  assert.equal((await get(viewerApp, { ref: own.uri })).id, own.id);
  const rows = await list(viewerApp, { principal: { type: 'owner' } });
  assert.ok(!rows.some((r) => r.id === theirs.id), 'a principal in params is ignored');
  assert.ok(!JSON.stringify(rows).includes(store), 'no store paths reach the iframe');
  // Not on own-process apps (tool results are an in-process surface).
  const standalone = capabilities.buildCtx({ name: 'viewer', dir: viewerDir, manifest: {} }, { profile: 'standalone' });
  assert.equal(standalone.artifacts, undefined);
});

test('agent tools: only for run holders, confined to cwd, and respecting run access', async () => {
  const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
  const worker = session({ type: 'worker', runId: 'run-a', address: 'w1', instanceId: 'i1', cwd });
  const other = session({ type: 'orchestrator', runId: 'run-b', address: 'o', instanceId: 'i2', cwd });
  for (const t of builtinTools) {
    assert.ok(t.when(worker) && t.when(other));
    assert.ok(!t.when({ id: 'x' }) && !t.when(session({ type: 'platform' })));
    assert.match(t.description, /vc-artifact:\/\/ uri passed in another tool's arguments grants that tool's app read access/);
  }
  const forRun = await art.put('maker', Buffer.from('render'), { name: 'render.mp4' },
    { caller: { type: 'worker', runId: 'run-a' }, app: 'maker', tool: 'render' });

  const info = await tool('artifact_info').handler({ uri: forRun.uri }, worker);
  assert.equal(JSON.parse(textOf(info)).mime, 'video/mp4');
  assert.equal((await tool('artifact_info').handler({ uri: forRun.uri }, other)).isError, true);

  const fetched = await tool('artifact_fetch').handler({ uri: forRun.uri, dest: 'media/render.mp4' }, worker);
  assert.ok(!fetched.isError, textOf(fetched));
  assert.equal(fs.readFileSync(path.join(cwd, 'media', 'render.mp4'), 'utf-8'), 'render');
  const denied = await tool('artifact_fetch').handler({ uri: forRun.uri, dest: 'x.mp4' }, other);
  assert.equal(denied.isError, true);
  assert.ok(!fs.existsSync(path.join(cwd, 'x.mp4')));
  assert.equal((await tool('artifact_fetch').handler({ uri: forRun.uri, dest: '../escape.mp4' }, worker)).isError, true);
  assert.ok(!fs.existsSync(path.join(tmp, 'escape.mp4')));
  const noCwd = session({ type: 'worker', runId: 'run-a', address: 'w1', instanceId: 'i1' });
  assert.match(textOf(await tool('artifact_fetch').handler({ uri: forRun.uri, dest: 'y' }, noCwd)), /working directory is unknown/);

  fs.writeFileSync(path.join(cwd, 'input.png'), 'png-bytes');
  const put = await tool('artifact_put').handler({ path: 'input.png' }, worker);
  assert.ok(!put.isError, textOf(put));
  const link = put.content[1];
  assert.equal(link.type, 'resource_link');
  assert.equal(link.mimeType, 'image/png');
  assert.ok(art.canRead({ type: 'run', runId: 'run-a' }, link.uri));
  assert.ok(!art.canRead({ type: 'run', runId: 'run-b' }, link.uri));
  assert.ok(!art.canRead({ type: 'app', app: 'maker' }, link.uri), 'an app reads it only once granted (by passing the uri)');
  assert.equal(JSON.parse(textOf(put)).producer.run, 'run-a');
  assert.equal((await tool('artifact_put').handler({ path: '../secret.txt' }, worker)).isError, true);
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(cwd, 'sneaky.txt'));
  assert.equal((await tool('artifact_put').handler({ path: 'sneaky.txt' }, worker)).isError, true);
  assert.match(textOf(await tool('artifact_put').handler({ path: 'input.png' }, noCwd)), /working directory is unknown/);
});
