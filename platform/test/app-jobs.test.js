// Who survives a stop. The regression is real: work being done TO an app from
// outside — a publish uploading a bundle — was cancelled when the app was
// restarted, because restarting an in-process app unmounts it and the unmount
// aborted every job of that app, the publish included. The job went
// `interrupted` mid-upload and the GUI lost the record it was rendering.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { makeAppsDir } = require('./helpers');
const appJobs = require('../src/apps/app-jobs');

const appsDir = makeAppsDir({ 'j-app': {} });
appJobs.init({ appsDir, broadcaster: { broadcast() {} } });
test.after(() => fs.rmSync(appsDir, { recursive: true, force: true }));

// A job that parks until its signal aborts — the shape of a long upload.
function parked() {
  const j = { aborted: false };
  j.run = (h) => new Promise((resolve) => {
    const done = () => { j.aborted = true; resolve('aborted'); };
    if (h.signal.aborted) return done();
    h.signal.addEventListener('abort', done, { once: true });
  });
  return j;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test('restarting an app stops its own jobs but never the platform work being done TO it', async () => {
  const mine = parked();
  const platform = parked();
  const a = appJobs.startJob('j-app', { name: 'app-side', run: mine.run });
  const p = appJobs.startJob('j-app', { name: 'publish:peer-a', owner: 'platform', run: platform.run });

  appJobs.cleanupApp('j-app', { reason: 'restart' });
  await settle();

  assert.equal(mine.aborted, true, "an app's own job holds the module instance being re-required");
  assert.equal(platform.aborted, false, 'the publish survives a restart of the app it is publishing');
  assert.equal(appJobs.getJob('j-app', a.id).status, 'interrupted');

  const survivor = appJobs.getJob('j-app', p.id);
  assert.equal(survivor.status, 'running', 'and its record stays addressable for the GUI');
  assert.equal(survivor.owner, 'platform');
});

test('unmounting or deleting an app still stops everything, platform work included', async () => {
  const platform = parked();
  const p = appJobs.startJob('j-app', { name: 'publish:peer-a', owner: 'platform', run: platform.run });

  appJobs.cleanupApp('j-app');   // the default reason: a real teardown
  await settle();

  assert.equal(platform.aborted, true, 'nothing outlives the app itself going away');
  assert.equal(appJobs.getJob('j-app', p.id).status, 'interrupted');
});

test('owner defaults to app, so anything started through ctx.jobs dies with its app', async () => {
  const mine = parked();
  const a = appJobs.startJob('j-app', { name: 'ctx-jobs-start', run: mine.run });
  assert.equal(appJobs.getJob('j-app', a.id).owner, 'app');

  appJobs.cleanupApp('j-app', { reason: 'restart' });
  await settle();
  assert.equal(mine.aborted, true);
});
