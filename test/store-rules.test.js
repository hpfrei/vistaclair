// The per-rule request deltas the proxy records (`interaction.rules`) must
// survive the disk round trip: the captured request is the post-rule body, so
// this list is the only record of what each proxy rule did to a request.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function freshStore(home) {
  process.env.VISTACLAIR_HOME = home;
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/utils')];
  delete require.cache[require.resolve('../src/capabilities')];
  const InteractionStore = require('../src/store');
  return new InteractionStore(200);
}

const flush = () => new Promise(r => setTimeout(r, 50));

test('rule deltas are written with the interaction and read back', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-test-'));
  const sessId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const instanceId = `cli-${sessId}`;
  const rules = [{ id: 'unsafe-tool-filter', delta: -18204 }, { id: 'auq-mcp-rewrite', delta: 0 }];

  let store = freshStore(home);
  store.registerSession(instanceId, sessId);
  const t = {
    id: 'turn-with-rules', instanceId, endpoint: '/v1/messages', timestamp: 1000,
    request: { model: 'x', messages: [] }, response: { status: 200, headers: {}, body: {} },
    status: 'complete', rules,
  };
  store.add(t);
  store.save(t.id);
  const bare = { ...t, id: 'turn-without-rules', rules: [] };
  store.add(bare);
  store.save(bare.id);
  await flush();

  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'interactions', sessId, '1.json'), 'utf8'));
  assert.deepStrictEqual(onDisk.rules, rules);
  assert.strictEqual('rules' in JSON.parse(fs.readFileSync(path.join(home, 'interactions', sessId, '2.json'), 'utf8')), false,
    'an empty list is not written');

  store = freshStore(home);
  const back = store.loadSessionIntoMemory(sessId);
  assert.deepStrictEqual(back.find(i => i.id === 'turn-with-rules').rules, rules);
  assert.strictEqual(back.find(i => i.id === 'turn-without-rules').rules, undefined);
});
