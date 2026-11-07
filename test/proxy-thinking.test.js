// The proxy's tab-level "show thinking" (src/proxy.js applyShowThinking):
// on, display: 'summarized' on a thinking config that takes it, over Claude
// Code's own display ('updates', which it sends on every request, its
// subagents' too); off, 'omitted' for an Agent SDK session, a terminal tab's
// request untouched.
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

test('on: the display Claude Code chose is replaced (it always sends one)', () => {
  // What Claude Code 2.1.x sends for every main-agent and subagent request.
  assert.deepStrictEqual(run({ type: 'adaptive', display: 'updates' }).thinking, { type: 'adaptive', display: 'summarized' });
  assert.deepStrictEqual(run({ type: 'enabled', budget_tokens: 1024, display: 'omitted' }).thinking, { type: 'enabled', budget_tokens: 1024, display: 'summarized' });
  assert.deepStrictEqual(run({ type: 'adaptive', display: 'summarized' }, { showThinking: true, engine: 'sdk' }).thinking, { type: 'adaptive', display: 'summarized' });
});

test('off, an Agent SDK session: no thinking text (omitted, not Claude Code\'s "updates" notes)', () => {
  const SDK_OFF = { showThinking: false, engine: 'sdk' };
  assert.deepStrictEqual(run({ type: 'adaptive', display: 'updates' }, SDK_OFF).thinking, { type: 'adaptive', display: 'omitted' });
  assert.deepStrictEqual(run({ type: 'adaptive', display: 'summarized' }, SDK_OFF).thinking, { type: 'adaptive', display: 'omitted' });
  assert.deepStrictEqual(run({ type: 'enabled', budget_tokens: 2048 }, SDK_OFF).thinking, { type: 'enabled', budget_tokens: 2048, display: 'omitted' });
  assert.deepStrictEqual(run({ type: 'disabled' }, SDK_OFF).thinking, { type: 'disabled' });
  assert.ok(!('thinking' in run(undefined, SDK_OFF)), 'no thinking object is added');
});

test('off, a terminal tab, or no tab settings: untouched', () => {
  assert.deepStrictEqual(run({ type: 'adaptive' }, { showThinking: false }).thinking, { type: 'adaptive' });
  assert.deepStrictEqual(run({ type: 'adaptive', display: 'updates' }, { showThinking: false, engine: 'cli' }).thinking, { type: 'adaptive', display: 'updates' });
  assert.deepStrictEqual(run({ type: 'adaptive' }, null).thinking, { type: 'adaptive' });
  assert.deepStrictEqual(run({ type: 'adaptive', display: 'updates' }, null).thinking, { type: 'adaptive', display: 'updates' });
});
