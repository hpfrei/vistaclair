const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const platformCron = require('../src/apps/platform-cron');
const capabilities = require('../src/apps/capabilities');

// ctx.platform.cron: caller-scoped app-api jobs, idempotent by name, on the one
// scheduler. Runs against a temp appsDir, never the live job file.
test('ctx.platform.cron schedules, lists and cancels only the caller\'s jobs', async (t) => {
  const appsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-pcron-'));
  platformCron.init({ appsDir });
  t.after(() => { platformCron.shutdown(); fs.rmSync(appsDir, { recursive: true, force: true }); });

  const ctx = capabilities.buildCtx({ name: 'a', dir: path.join(appsDir, 'a'), manifest: {} }, { profile: 'dashboard' });
  const standalone = capabilities.buildCtx({ name: 'a', dir: path.join(appsDir, 'a'), manifest: {} }, { profile: 'standalone' });
  assert.equal(standalone.platform, undefined);
  const cron = ctx.platform.cron;

  // An unowned job the iframe registered via the Bridge is the same job by name.
  platformCron.addJob({ name: 'refresh', schedule: '0 6 * * *', target: { type: 'app-api', app: 'a', method: 'POST', path: '/api/x' } });
  platformCron.addJob({ name: 'other', schedule: '0 6 * * *', target: { type: 'app-api', app: 'b', path: '/api/y' } });
  assert.equal((await cron.list()).length, 1);

  const r1 = await cron.schedule({ name: 'refresh', schedule: '20 5 * * *', target: { type: 'app-api', app: 'a', path: '/api/x' } });
  assert.deepEqual([r1.created, r1.updated], [false, true]);
  const r2 = await cron.schedule({ name: 'refresh', schedule: '20 5 * * *', target: { path: '/api/x' } });
  assert.deepEqual(r2, { jobId: r1.jobId, created: false, updated: false });

  const r3 = await cron.schedule({ name: 'tick', schedule: 'every 5 minutes', target: { path: '/api/z' } });
  assert.equal(r3.created, true);
  assert.equal(platformCron.list().find((j) => j.id === r3.jobId).appName, 'a');
  platformCron.disableJob(r3.jobId); // the owner's disable survives re-registration
  assert.equal((await cron.schedule({ name: 'tick', schedule: 'every 5 minutes', target: { path: '/api/z' } })).jobId, r3.jobId);
  assert.equal(platformCron.list().find((j) => j.id === r3.jobId).enabled, false);

  await assert.rejects(cron.schedule({ name: 'x', schedule: '* * * * *', target: { app: 'b', path: '/p' } }), /calling app only/);
  await assert.rejects(cron.schedule({ name: 'x', schedule: '* * * * *', target: { type: 'shell', command: 'ls' } }), /app-api/);
  await assert.rejects(cron.schedule({ name: 'x', schedule: 'bogus', target: { path: '/p' } }), /Invalid schedule/);
  const other = platformCron.list().find((j) => j.name === 'other');
  await assert.rejects(cron.cancel({ jobId: other.id }), /not found/);

  assert.deepEqual(await cron.cancel({ name: 'tick' }), { ok: true });
  assert.deepEqual(await cron.cancel({ jobId: r1.jobId }), { ok: true });
  assert.deepEqual(await cron.list(), []);
  assert.deepEqual(platformCron.list().map((j) => j.name), ['other']);
});
