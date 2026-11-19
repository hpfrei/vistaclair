// The input lines' shared file logic (public/attach-files.js): an image
// becomes a base64 block, any other file is uploaded and named by path in the
// message; size guards say why they refuse; the mic's text goes in at the cursor.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const A = require('../public/attach-files');

const MB = 1024 * 1024;

test('classifyFile: png/jpeg/gif/webp → image (base64 block)', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    assert.deepStrictEqual(A.classifyFile({ name: 'a', type, size: 1000 }), { kind: 'image' });
  }
});

test('classifyFile: pdf, txt, csv, zip, audio, svg → file (upload + path line)', () => {
  for (const [name, type] of [['a.pdf', 'application/pdf'], ['a.txt', 'text/plain'], ['a.csv', 'text/csv'],
    ['a.zip', 'application/zip'], ['a.mp3', 'audio/mpeg'], ['a.webm', 'audio/webm'], ['a.svg', 'image/svg+xml'], ['a.heic', 'image/heic'], ['Makefile', '']]) {
    assert.deepStrictEqual(A.classifyFile({ name, type, size: 2000 }), { kind: 'file' }, name);
  }
});

test('classifyFile: size guards and folders give a reason', () => {
  const big = A.classifyFile({ name: 'p.png', type: 'image/png', size: 9 * MB });
  assert.strictEqual(big.kind, 'reject');
  assert.match(big.reason, /"p.png" is too large \(max 8 MB/);
  const bigFile = A.classifyFile({ name: 'v.zip', type: 'application/zip', size: 26 * MB });
  assert.strictEqual(bigFile.kind, 'reject');
  assert.match(bigFile.reason, /too large \(max 25 MB\)/);
  assert.strictEqual(A.classifyFile({ name: 'a.zip', type: 'application/zip', size: 20 * MB }).kind, 'file');
  assert.match(A.classifyFile({ name: 'dir', type: '', size: 0 }).reason, /folder/);
  assert.match(A.classifyFile({ name: 'e.txt', type: 'text/plain', size: 0 }).reason, /empty/);
});

test('withAttached appends one "Attached:" line per path', () => {
  assert.strictEqual(A.withAttached('look at this', ['/s/uploads/a.pdf', '/s/uploads/b.csv']),
    'look at this\n\nAttached: /s/uploads/a.pdf\nAttached: /s/uploads/b.csv');
  assert.strictEqual(A.withAttached('', ['/x/a.txt']), 'Attached: /x/a.txt');
  assert.strictEqual(A.withAttached('plain', []), 'plain');
  assert.strictEqual(A.withAttached('plain', [null]), 'plain');
});

test('quotePath: bare when plain, single-quoted otherwise', () => {
  assert.strictEqual(A.quotePath('/a/b/c.txt'), '/a/b/c.txt');
  assert.strictEqual(A.quotePath('/a/my file.txt'), `'/a/my file.txt'`);
  assert.strictEqual(A.quotePath(`/a/it's.txt`), `'/a/it'\\''s.txt'`);
});

test('insertAtCursor puts the transcript at the cursor with sensible spacing', () => {
  assert.deepStrictEqual(A.insertAtCursor('', 0, 0, 'hello'), { value: 'hello', caret: 5 });
  assert.deepStrictEqual(A.insertAtCursor('fix the bug', 11, 11, 'in main'), { value: 'fix the bug in main', caret: 19 });
  assert.deepStrictEqual(A.insertAtCursor('ab cd', 2, 3, 'X'), { value: 'ab X cd', caret: 4 });
  assert.deepStrictEqual(A.insertAtCursor('abc', 1, 1, 'X'), { value: 'a X bc', caret: 3 });
  assert.strictEqual(A.insertAtCursor('abc', undefined, undefined, 'x').value, 'abc x');
});

test('formatElapsed and pickRecorderMime', () => {
  assert.strictEqual(A.formatElapsed(0), '0:00');
  assert.strictEqual(A.formatElapsed(7400), '0:07');
  assert.strictEqual(A.formatElapsed(125000), '2:05');
  assert.strictEqual(A.pickRecorderMime(m => m === 'audio/mp4'), 'audio/mp4');
  assert.strictEqual(A.pickRecorderMime(() => true), 'audio/webm;codecs=opus');
  assert.strictEqual(A.pickRecorderMime(() => false), '');
});
