// The proxy's tab-level "show thinking" (src/proxy.js applyShowThinking):
// display: 'summarized' only on a thinking config that takes it.
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-proxy-thinking-')));
process.env.VISTACLAIR_HOME = HOME;

const test = require('node:test');
const assert = require('node:assert');
const { applyShowThinking } = require('../src/proxy');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const ON = { showThinking: true };
const run = (thinking, settings = ON) => {
  const body = thinking === undefined ? { model: 'claude-opus-5-5' } : { model: 'claude-opus-5-5', thinking };
  applyShowThinking(body, settings);
  return body;
};

test('adaptive and enabled get display: summarized', () => {
  assert.deepStrictEqual(run({ type: 'adaptive' }).thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepStrictEqual(run({ type: 'enabled', budget_tokens: 4000 }).thinking, { type: 'enabled', budget_tokens: 4000, display: 'summarized' });
});

test('between_tools, disabled and no thinking at all stay as they are', () => {
  assert.deepStrictEqual(run({ type: 'between_tools' }).thinking, { type: 'between_tools' });
  assert.deepStrictEqual(run({ type: 'disabled' }).thinking, { type: 'disabled' });
  assert.ok(!('thinking' in run(undefined)), 'no thinking object is added');
  assert.strictEqual(run(null).thinking, null);
});

test('a display already chosen is kept', () => {
  assert.deepStrictEqual(run({ type: 'adaptive', display: 'updates' }).thinking, { type: 'adaptive', display: 'updates' });
  assert.deepStrictEqual(run({ type: 'enabled', budget_tokens: 1024, display: 'omitted' }).thinking, { type: 'enabled', budget_tokens: 1024, display: 'omitted' });
});

test('off, or no tab settings: untouched', () => {
  assert.deepStrictEqual(run({ type: 'adaptive' }, { showThinking: false }).thinking, { type: 'adaptive' });
  assert.deepStrictEqual(run({ type: 'adaptive' }, null).thinking, { type: 'adaptive' });
});
