// Write ordering of interaction files: save() and the re-saves that follow it
// (applyPromptImages, enrichInteraction, _enrichRelatedHooks) all rewrite the
// same file. Each write used to be an un-awaited fs.writeFile with no ordering
// per path, so an older write that finished last won on disk and the record
// lost its prompt images or enrichment.
//
//   node --test test/store-write-order.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { waitFor } = require('./wait-for');

function freshStore(home, maxSize = 200) {
  process.env.VISTACLAIR_HOME = home;
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/utils')];
  delete require.cache[require.resolve('../src/capabilities')];
  const InteractionStore = require('../src/store');
  return new InteractionStore(maxSize);
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-test-'));
}

function hook(id, instanceId, promptId) {
  return {
    id,
    instanceId,
    endpoint: '/hook',
    timestamp: 1,
    isHook: true,
    hookEvent: 'UserPromptSubmit',
    request: { prompt_id: promptId, n: 0 },
    response: { status: 200, headers: {}, body: {} },
    status: 'complete',
  };
}

// Hold back the first fs.writeFile under `dir` until release() is called; every
// other write goes straight through and is tracked, so the test can wait for
// the writes already in flight without a fixed sleep.
function gateFirstWrite(dir) {
  const real = fs.writeFile;
  const inflight = new Set();
  let held = null;
  let gated = false;
  const pass = (file, data, rest) => {
    const cb = rest[rest.length - 1];
    let done;
    const p = new Promise(r => { done = r; });
    inflight.add(p);
    return real.call(fs, file, data, ...rest.slice(0, -1), (...args) => {
      inflight.delete(p);
      done();
      cb(...args);
    });
  };
  fs.writeFile = function (file, data, ...rest) {
    if (typeof file === 'string' && file.startsWith(dir) && !gated) {
      gated = true;
      held = () => pass(file, data, rest);
      return;
    }
    return pass(file, data, rest);
  };
  return {
    held: () => !!held,
    async settle() { while (inflight.size) await Promise.all([...inflight]); },
    release() { const h = held; held = null; if (h) h(); },
    restore() { fs.writeFile = real; },
  };
}

// Every write the store has started has reached disk.
async function drained(store, gate) {
  if (typeof store.flush === 'function') await store.flush();
  if (gate) await gate.settle();
  if (typeof store.flush === 'function') await store.flush();
}

function turnFiles(dir) {
  return fs.readdirSync(dir).filter(f => !f.startsWith('totals'));
}

test('a slow first write never overwrites a newer re-save of the same file', async () => {
  const home = tmpHome();
  const store = freshStore(home);
  const sessDir = path.join(home, 'interactions', 'sess-slow');
  store.registerSession('cli-sess-slow', 'sess-slow');

  const gate = gateFirstWrite(sessDir);
  try {
    const h = hook('hook-1', 'cli-sess-slow', 'p-1');
    store.add(h);
    store.save('hook-1');                       // first write: held back
    assert.ok(gate.held(), 'the first write is held');
    store.applyPromptImages('p-1', ['/img/a.png', '/img/b.png']); // re-save with images

    // Let every write that is not held finish, then let the old one land.
    await gate.settle();
    gate.release();
    await drained(store, gate);
  } finally {
    gate.restore();
  }

  const file = path.join(sessDir, '1.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(data.promptImages, ['/img/a.png', '/img/b.png'],
    'the newest content (with prompt images) is what is on disk');
  assert.deepStrictEqual(turnFiles(sessDir), ['1.json'], 'no temp files left behind');
});

test('many rapid saves and re-saves of one interaction leave the latest content', async () => {
  const home = tmpHome();
  const store = freshStore(home);
  const sessDir = path.join(home, 'interactions', 'sess-rapid');
  store.registerSession('cli-sess-rapid', 'sess-rapid');

  const gate = gateFirstWrite(sessDir);
  const N = 200;
  try {
    const h = hook('hook-r', 'cli-sess-rapid', 'p-r');
    // Big enough that a write takes a while and two in flight can interleave.
    h.request.padding = 'x'.repeat(256 * 1024);
    store.add(h);
    for (let i = 1; i <= N; i++) {
      h.request.n = i;
      if (i % 3 === 0) store.enrichInteraction('hook-r', { agentId: `a${i}`, agentType: 'agent' });
      else store.save('hook-r');
    }
    await gate.settle();
    gate.release();
    await drained(store, gate);
  } finally {
    gate.restore();
  }

  const data = JSON.parse(fs.readFileSync(path.join(sessDir, '1.json'), 'utf8'));
  assert.strictEqual(data.request.n, N, 'the last requested content wins');
  assert.strictEqual(data.subagent?.agentId, `a${N - (N % 3)}`);
  assert.deepStrictEqual(turnFiles(sessDir), ['1.json'], 'no temp files left behind');
});

test('flush() resolves once queued writes are on disk and the queue is empty', async (t) => {
  const home = tmpHome();
  const store = freshStore(home);
  if (typeof store.flush !== 'function') {
    assert.fail('store.flush() is missing');
  }
  const sessDir = path.join(home, 'interactions', 'sess-flush');
  store.registerSession('cli-sess-flush', 'sess-flush');
  const h = hook('hook-f', 'cli-sess-flush', 'p-f');
  store.add(h);
  for (let i = 1; i <= 20; i++) { h.request.n = i; store.save('hook-f'); }
  await store.flush();
  const data = JSON.parse(fs.readFileSync(path.join(sessDir, '1.json'), 'utf8'));
  assert.strictEqual(data.request.n, 20);
  assert.strictEqual(store._pendingWrites.size, 0, 'per-path entries are dropped once drained');
});

test('a write into a session dir deleted meanwhile recreates the dir', async () => {
  const home = tmpHome();
  const store = freshStore(home);
  const sessDir = path.join(home, 'interactions', 'sess-gone');
  store.registerSession('cli-sess-gone', 'sess-gone');
  const h = hook('hook-g', 'cli-sess-gone', 'p-g');
  store.add(h);
  store.save('hook-g');
  await drained(store);
  fs.rmSync(sessDir, { recursive: true, force: true });
  h.request.n = 7;
  store.save('hook-g');
  await drained(store);
  const data = await waitFor(() => JSON.parse(fs.readFileSync(path.join(sessDir, '1.json'), 'utf8')),
    { what: 'rewritten turn file' });
  assert.strictEqual(data.request.n, 7);
});
