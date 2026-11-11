// Source line numbers of the rendered markdown preview (public/md-lines.js).
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const { marked } = require('../public/vendor/marked-18.1.2/marked.umd.js');
const { mdBlockLines, mdBlocks } = require('../public/md-lines.js');

const lines = (text) => mdBlockLines(text, marked);

test('headings and paragraphs start on their own line', () => {
  assert.deepStrictEqual(lines('# Title\n\nfirst\nstill first\n\n## Next\ntext'), [1, 3, 6, 7]);
});

test('several blank lines between paragraphs are counted', () => {
  assert.deepStrictEqual(lines('one\n\n\n\n\ntwo\n\nthree'), [1, 6, 8]);
});

test('a fenced code block with blank lines inside is one block', () => {
  const text = 'intro\n\n```js\nconst a = 1;\n\n\nconst b = 2;\n```\n\nafter';
  assert.deepStrictEqual(lines(text), [1, 3, 10]);
});

test('a nested list is one block and the next block follows its last line', () => {
  const text = '- a\n  - b\n    - c\n- d\n\npara';
  assert.deepStrictEqual(lines(text), [1, 6]);
});

test('a table is one block', () => {
  const text = 'before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nafter';
  assert.deepStrictEqual(lines(text), [1, 3, 8]);
});

test('front-matter-like --- lines keep counting', () => {
  const text = '---\ntitle: x\n---\n\nbody';
  const l = lines(text);
  assert.strictEqual(l[0], 1);
  assert.strictEqual(l[l.length - 1], 5);
  assert.ok(l.every((n, i) => i === 0 || n > l[i - 1]), 'increasing');
});

test('CRLF line endings count the same as LF', () => {
  const lf = '# T\n\npara one\n\n\n- a\n- b\n\n```\nx\n\ny\n```\n\nend';
  assert.deepStrictEqual(lines(lf.replace(/\n/g, '\r\n')), lines(lf));
  assert.deepStrictEqual(lines(lf), [1, 3, 6, 9, 15]);
});

test('a leading blank line pushes everything down', () => {
  assert.deepStrictEqual(lines('\n# T\n\npara'), [2, 4]);
  assert.deepStrictEqual(lines('\n\n\npara'), [4]);
});

test('empty text has no blocks', () => {
  assert.deepStrictEqual(lines(''), []);
  assert.deepStrictEqual(lines('\n\n'), []);
});

test('mdBlocks pairs each line with its token', () => {
  const b = mdBlocks('# T\n\npara', marked);
  assert.deepStrictEqual(b.map(x => [x.token.type, x.line]), [['heading', 1], ['paragraph', 3]]);
});
