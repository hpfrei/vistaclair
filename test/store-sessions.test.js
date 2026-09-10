// Session-dir lifecycle in the interaction store: turn numbering across a
// resume, and the idle-dir sweep. Both guard restart behaviour that is easy to
// break silently — a resumed tab used to renumber from 1 and overwrite its own
// history, which surfaced as "the tab came back with someone else's content".
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Each test gets its own DATA_HOME. store.js reads it at require time via
// utils.js, so the env var must be set before either is loaded and the module
// cache must be dropped between homes.
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

function turn(id, instanceId, ts) {
  return {
    id,
    instanceId,
    endpoint: '/v1/messages',
    timestamp: ts,
    request: { body: {} },
    response: { status: 200, headers: {}, body: {} },
    status: 'complete',
  };
}

// save() writes through fs.writeFile; let the callbacks run before reading back.
const flush = () => new Promise(r => setTimeout(r, 50));

function turnFiles(dir) {
  return fs.readdirSync(dir)
    .filter(f => /^\d+\.json$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));
}

function idsBySeq(dir) {
  const out = {};
  for (const f of turnFiles(dir)) {
    out[f] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).id;
  }
  return out;
}

test('a resumed session appends turns instead of overwriting its history', async () => {
  const home = tmpHome();
  const sessId = '11111111-2222-3333-4444-555555555555';
  const instanceId = `cli-${sessId}`;
  const dir = path.join(home, 'interactions', sessId);

  let store = freshStore(home);
  store.registerSession(instanceId, sessId);
  for (let i = 0; i < 3; i++) {
    const t = turn(`run1-turn${i}`, instanceId, 1000 + i);
    store.add(t);
    store.save(t.id);
  }
  await flush();
  assert.deepStrictEqual(turnFiles(dir), ['1.json', '2.json', '3.json']);

  // Restart: the constructor's _loadFromDisk pulls this session in (it has the
  // newest mtime), which is exactly the case where the old counter repair was
  // skipped.
  store = freshStore(home);
  assert.strictEqual(store.order.length, 3, 'boot should load the previous run');

  store.registerSession(instanceId, sessId);
  assert.strictEqual(store.sessionSeqs.get(sessId), 3, 'registerSession must not restart numbering');

  const historical = store.loadSessionIntoMemory(sessId);
  assert.strictEqual(historical.length, 3);
  assert.strictEqual(store.sessionSeqs.get(sessId), 3, 'the early return must still leave the counter anchored');

  for (let i = 0; i < 2; i++) {
    const t = turn(`run2-turn${i}`, instanceId, 2000 + i);
    store.add(t);
    store.save(t.id);
  }
  await flush();

  assert.deepStrictEqual(idsBySeq(dir), {
    '1.json': 'run1-turn0',
    '2.json': 'run1-turn1',
    '3.json': 'run1-turn2',
    '4.json': 'run2-turn0',
    '5.json': 'run2-turn1',
  });
});

test('a headless spawn sharing a tab session keeps appending', async () => {
  const home = tmpHome();
  const sessId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const dir = path.join(home, 'interactions', sessId);

  const store = freshStore(home);
  store.registerSession(`cli-${sessId}`, sessId);
  const first = turn('tab-turn', `cli-${sessId}`, 1000);
  store.add(first);
  store.save(first.id);
  await flush();

  // What addon-host's registerAiSession does when an ai.prompt is pointed at an
  // existing session id.
  store.registerSession('app-demo-ai-abc', sessId);
  const second = turn('headless-turn', 'app-demo-ai-abc', 2000);
  store.add(second);
  store.save(second.id);
  await flush();

  assert.deepStrictEqual(idsBySeq(dir), { '1.json': 'tab-turn', '2.json': 'headless-turn' });
});

test('sweepStaleSessions drops idle headless dirs and spares the rest', async () => {
  const home = tmpHome();
  const root = path.join(home, 'interactions');
  const store = freshStore(home);

  const ttlMs = 60 * 60 * 1000;
  const stale = Date.now() - 3 * 60 * 60 * 1000;

  const make = (name, { internal = false, old = true } = {}) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ id: `${name}-1` }));
    if (internal) fs.writeFileSync(path.join(dir, 'internal.json'), '[]');
    if (old) {
      const t = new Date(stale);
      for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), t, t);
      fs.utimesSync(dir, t, t);
    }
    return dir;
  };

  const idle = make('idle-headless');
  const recent = make('recent-headless', { old: false });
  const tab = make('interactive-tab', { internal: true });
  const pinnedDir = make('pinned-headless');
  const liveDir = make('live-headless');

  store.registerSession('app-demo-ai-live', 'live-headless');

  const { swept } = store.sweepStaleSessions({ ttlMs, pinned: new Set(['pinned-headless']) });

  assert.deepStrictEqual(swept, ['idle-headless']);
  assert.ok(!fs.existsSync(idle), 'idle headless dir should be gone');
  for (const [label, dir] of [['recent', recent], ['tab', tab], ['pinned', pinnedDir], ['live', liveDir]]) {
    assert.ok(fs.existsSync(dir), `${label} dir should survive`);
  }
});

test('sweeping evicts the dropped interactions from memory', async () => {
  const home = tmpHome();
  const sessId = 'ffffffff-0000-1111-2222-333333333333';
  const instanceId = 'app-demo-ai-xyz';

  let store = freshStore(home);
  store.registerSession(instanceId, sessId);
  const t = turn('headless-1', instanceId, 1000);
  store.add(t);
  store.save(t.id);
  await flush();

  // Reload so the interaction is in memory with a filePath, then age it out.
  store = freshStore(home);
  assert.ok(store.order.includes('headless-1'));
  const dir = path.join(home, 'interactions', sessId);
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), old, old);
  fs.utimesSync(dir, old, old);

  const { swept } = store.sweepStaleSessions({ ttlMs: 60 * 60 * 1000 });

  assert.deepStrictEqual(swept, [sessId]);
  assert.ok(!store.order.includes('headless-1'), 'order must not keep a swept id');
  assert.strictEqual(store.interactions.get('headless-1'), undefined);
  assert.strictEqual(store.filePaths.get('headless-1'), undefined);
  assert.strictEqual(store.diskIndex.get('headless-1'), undefined);
  assert.deepStrictEqual(store.getAll(), []);
});
