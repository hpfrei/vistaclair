const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { core, configure } = require('../src/apps/core-services');
const spawnManager = require('../src/apps/spawn-manager');
const platformCron = require('../src/apps/platform-cron');

const HEADER = 'x-vistaclair-proxy-secret';
const SECRET = 'test-secret-0123456789abcdef';

function withCore(members, fn) {
  const saved = { proxyPort: core.proxyPort, getProxySecret: core.getProxySecret, proxySecretHeader: core.proxySecretHeader };
  core.proxyPort = 3456;
  delete core.getProxySecret; delete core.proxySecretHeader;
  Object.assign(core, members);
  const restore = () => { for (const k of ['proxyPort', 'getProxySecret', 'proxySecretHeader']) { if (saved[k] === undefined) delete core[k]; else core[k] = saved[k]; } };
  const r = fn();
  if (r && typeof r.then === 'function') return r.finally(restore);
  restore();
  return r;
}

const both = { getProxySecret: () => SECRET, proxySecretHeader: HEADER };
const nodeEnv = (name) => `node -e "process.stdout.write(process.env.${name} || '')"`;

test('exec: a pro-started shell carries the proxy URL and the secret header', () => withCore(both, async () => {
  const r = await spawnManager.exec({ dir: os.tmpdir() }, { command: nodeEnv('ANTHROPIC_CUSTOM_HEADERS') });
  assert.equal(r.stdout, `${HEADER}: ${SECRET}`);
  const u = await spawnManager.exec({ dir: os.tmpdir() }, { command: nodeEnv('ANTHROPIC_BASE_URL') });
  assert.equal(u.stdout, 'http://localhost:3456');
}));

test('exec: a pre-existing custom header is kept, an old secret line is replaced', () => withCore(both, async () => {
  const prev = process.env.ANTHROPIC_CUSTOM_HEADERS;
  process.env.ANTHROPIC_CUSTOM_HEADERS = `x-other: 1\n${HEADER}: stale`;
  try {
    const r = await spawnManager.exec({ dir: os.tmpdir() }, { command: nodeEnv('ANTHROPIC_CUSTOM_HEADERS') });
    assert.equal(r.stdout, `x-other: 1\n${HEADER}: ${SECRET}`);
  } finally { if (prev === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS; else process.env.ANTHROPIC_CUSTOM_HEADERS = prev; }
}));

test('exec: members missing → today\'s environment, no header, no throw', () => withCore({}, async () => {
  const prev = process.env.ANTHROPIC_CUSTOM_HEADERS;
  delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  try {
    const r = await spawnManager.exec({ dir: os.tmpdir() }, { command: nodeEnv('ANTHROPIC_CUSTOM_HEADERS') });
    assert.equal(r.stdout, '');
    const u = await spawnManager.exec({ dir: os.tmpdir() }, { command: nodeEnv('ANTHROPIC_BASE_URL') });
    assert.equal(u.stdout, 'http://localhost:3456');
  } finally { if (prev !== undefined) process.env.ANTHROPIC_CUSTOM_HEADERS = prev; }
}));

function runSpawn(env, name) {
  return new Promise((resolve) => {
    let out = '';
    const { spawnId } = spawnManager.spawn({ name: 'a', dir: os.tmpdir() }, { command: nodeEnv(name), env }, (ev, data) => {
      if (ev === 'spawn:stdout') out += data.data;
      if (ev === 'spawn:exit') resolve(out);
    });
    assert.ok(spawnId);
  });
}

test('spawn: carries the secret header; params.env still wins', () => withCore(both, async () => {
  assert.equal(await runSpawn(undefined, 'ANTHROPIC_CUSTOM_HEADERS'), `${HEADER}: ${SECRET}`);
  assert.equal(await runSpawn({ ANTHROPIC_CUSTOM_HEADERS: 'x-mine: 2' }, 'ANTHROPIC_CUSTOM_HEADERS'), 'x-mine: 2');
  assert.equal(await runSpawn({ ANTHROPIC_BASE_URL: 'http://example.test' }, 'ANTHROPIC_BASE_URL'), 'http://example.test');
}));

test('spawn: members missing → no header', () => withCore({}, async () => {
  const prev = process.env.ANTHROPIC_CUSTOM_HEADERS;
  delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  try { assert.equal(await runSpawn(undefined, 'ANTHROPIC_CUSTOM_HEADERS'), ''); }
  finally { if (prev !== undefined) process.env.ANTHROPIC_CUSTOM_HEADERS = prev; }
}));

test('platform-cron shell job: app-scoped job carries the secret header, a platform job is untouched', () => withCore(both, async (t) => {
  const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-psec-'));
  platformCron.init({ appsDir, proxyPort: 3456 });
  try {
    const run = async (name, appName, n) => {
      const j = platformCron.addJob({ name, schedule: '0 0 1 1 *', appName, target: { type: 'shell', command: nodeEnv(n) } });
      assert.equal(j.ok, true);
      await platformCron.runNow(j.jobId);
      return platformCron.getHistory(j.jobId, 1)[0];
    };
    const a = await run('a-job', 'a', 'ANTHROPIC_CUSTOM_HEADERS');
    assert.equal(a.ok, true);
    assert.equal(a.output, `${HEADER}: ${SECRET}`);
    const b = await run('b-job', null, 'ANTHROPIC_CUSTOM_HEADERS');
    assert.equal(b.output, process.env.ANTHROPIC_CUSTOM_HEADERS || '');
  } finally { platformCron.shutdown(); fs.rmSync(appsDir, { recursive: true, force: true }); }
}));

test('configure forwards getProxySecret and proxySecretHeader from the host options', () => withCore({}, () => {
  configure({ getProxySecret: () => SECRET, proxySecretHeader: HEADER });
  assert.equal(core.getProxySecret(), SECRET);
  assert.equal(core.proxySecretHeader, HEADER);
}));
