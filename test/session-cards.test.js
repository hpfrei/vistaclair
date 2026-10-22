// Card names in the Sessions tab (public/session-cards.js projectNames): the
// project (cwd basename), numbered by start time when cards share it.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { projectNames } = require('../public/session-cards.js');

test('same project: numbered by start time, not input order', () => {
  const names = projectNames([
    { key: 'b', cwd: '/home/hp/p', startedAt: 200 },
    { key: 'c', cwd: '/home/hp/p', startedAt: 300 },
    { key: 'a', cwd: '/home/hp/p/', startedAt: 100 },
  ]);
  assert.strictEqual(names.get('a'), 'p');
  assert.strictEqual(names.get('b'), 'p 2');
  assert.strictEqual(names.get('c'), 'p 3');
});

test('different projects are not numbered', () => {
  const names = projectNames([
    { key: 'x', cwd: '/a/one', startedAt: 2 },
    { key: 'y', cwd: '/a/two', startedAt: 1 },
  ]);
  assert.strictEqual(names.get('x'), 'one');
  assert.strictEqual(names.get('y'), 'two');
});

test('runs and sessions share one numbering; ties keep input order', () => {
  const names = projectNames([
    { key: 'run:r1', cwd: '/home/hp/vistaclair', startedAt: 50 },
    { key: 'sess:s1', cwd: '/home/hp/vistaclair', startedAt: 10 },
    { key: 'sess:s2', cwd: '/home/hp/vistaclair', startedAt: 50 },
  ]);
  assert.strictEqual(names.get('sess:s1'), 'vistaclair');
  assert.strictEqual(names.get('run:r1'), 'vistaclair 2');
  assert.strictEqual(names.get('sess:s2'), 'vistaclair 3');
});

test('missing cwd or start time: no name without cwd, oldest otherwise', () => {
  const names = projectNames([
    { key: 'n', startedAt: 1 },
    { key: 'p1', cwd: '/x/p' },
    { key: 'p2', cwd: '/x/p', startedAt: 5 },
  ]);
  assert.strictEqual(names.has('n'), false);
  assert.strictEqual(names.get('p1'), 'p');
  assert.strictEqual(names.get('p2'), 'p 2');
});
