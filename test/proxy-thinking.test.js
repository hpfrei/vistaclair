// The proxy's always-on thinking display (src/proxy.js applyThinkingDisplay):
// display: 'summarized' on a thinking config that takes it, over Claude Code's
// own display ('updates', which it sends on every request, its subagents'
// too), with no setting involved; a stored showThinking value is ignored.
//
//   node --test test/

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vc-proxy-thinking-')));
process.env.VISTACLAIR_HOME = HOME;

const test = require('node:test');
const assert = require('node:assert');
const { applyThinkingDisplay } = require('../src/proxy');

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// A tab's settings with no thinking setting at all.
const run = (thinking, settings = {}) => {
  const body = thinking === undefined ? { model: 'claude-opus-5-5' } : { model: 'claude-opus-5-5', thinking };
  applyThinkingDisplay(body, settings);
  return body;
};

test('adaptive and enabled get display: summarized, with no setting present', () => {
  assert.deepStrictEqual(run({ type: 'adaptive' }).thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepStrictEqual(run({ type: 'enabled', budget_tokens: 4000 }).thinking, { type: 'enabled', budget_tokens: 4000, display: 'summarized' });
  assert.deepStrictEqual(run({ type: 'adaptive' }, { engine: 'sdk' }).thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepStrictEqual(run({ type: 'adaptive' }, { engine: 'cli' }).thinking, { type: 'adaptive', display: 'summarized' });
});

test('between_tools, disabled and no thinking at all stay as they are', () => {
  assert.deepStrictEqual(run({ type: 'between_tools' }).thinking, { type: 'between_tools' });
  assert.deepStrictEqual(run({ type: 'disabled' }).thinking, { type: 'disabled' });
  assert.ok(!('thinking' in run(undefined)), 'no thinking object is added');
  assert.strictEqual(run(null).thinking, null);
});

test('the display Claude Code chose is replaced (it always sends one)', () => {
  // What Claude Code 2.1.x sends for every main-agent and subagent request.
  assert.deepStrictEqual(run({ type: 'adaptive', display: 'updates' }).thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepStrictEqual(run({ type: 'enabled', budget_tokens: 1024, display: 'omitted' }).thinking, { type: 'enabled', budget_tokens: 1024, display: 'summarized' });
  assert.deepStrictEqual(run({ type: 'adaptive', display: 'summarized' }, { engine: 'sdk' }).thinking, { type: 'adaptive', display: 'summarized' });
});

test('an old stored showThinking value, either way, changes nothing', () => {
  assert.deepStrictEqual(run({ type: 'adaptive', display: 'updates' }, { showThinking: false, engine: 'sdk' }).thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepStrictEqual(run({ type: 'adaptive' }, { showThinking: true }).thinking, { type: 'adaptive', display: 'summarized' });
});

test('not a tab\'s request (no tab settings): untouched', () => {
  assert.deepStrictEqual(run({ type: 'adaptive' }, null).thinking, { type: 'adaptive' });
  assert.deepStrictEqual(run({ type: 'adaptive', display: 'updates' }, null).thinking, { type: 'adaptive', display: 'updates' });
});
