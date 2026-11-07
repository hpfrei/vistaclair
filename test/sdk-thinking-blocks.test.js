// The SDK panel's live blocks (public/sdk-panel.js, its pure part): which
// open block a complete message's text or thinking block finalizes, and the
// block a message drew before its stream started. Claude Code sends one
// message per content block; with thinking shown a turn can carry an empty,
// signature-only thinking block and then one with text, or two summaries.
//
//   node --test test/

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const test = require('node:test');
const assert = require('node:assert');

// sdk-panel.js in a sandbox with just what its top level touches.
function loadPanel() {
  const noop = () => {};
  const window = {
    dashboard: { sendWs: noop, state: {}, escHtml: String, renderMarkdown: noop, renderMarkdownDebounced: noop, cancelRenderDebounce: noop, registerModule: noop, _tabHooks: { onChange: noop } },
  };
  const ctx = vm.createContext({ window, document: { addEventListener: noop }, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'sdk-panel.js'), 'utf8'), ctx);
  return window.sdkPanel._blocks;
}
const { blockFor, overtaken } = loadPanel();

const blk = (type, raw, extra = {}) => ({ type, raw, final: false, ...extra });

test('blockFor: in order, each message finalizes the oldest open block of its type', () => {
  const empty = blk('thinking', '');
  const summary = blk('thinking', 'Looking at the proxy first.');
  const text = blk('text', 'Done.');
  const blocks = [empty, summary, text];
  assert.strictEqual(blockFor(blocks, 'thinking', ''), empty);
  empty.final = true;
  assert.strictEqual(blockFor(blocks, 'thinking', 'Looking at the proxy first.'), summary);
  summary.final = true;
  assert.strictEqual(blockFor(blocks, 'thinking', 'anything'), null, 'no open thinking block left');
  assert.strictEqual(blockFor(blocks, 'text', 'Done.'), text);
});

test('blockFor: the block whose streamed text is the message\'s wins, whatever the order', () => {
  const empty = blk('thinking', '');
  const summary = blk('thinking', 'Second thought.');
  // The message with text comes first: it takes the summary, not the empty block.
  assert.strictEqual(blockFor([empty, summary], 'thinking', 'Second thought.'), summary);
  // Two summaries in a row, the later one's message first.
  const a = blk('thinking', 'first'), b = blk('thinking', 'second');
  assert.strictEqual(blockFor([a, b], 'thinking', 'second'), b);
  assert.strictEqual(blockFor([a, b], 'thinking', 'first'), a);
});

test('blockFor: no exact match (still streaming, redacted) falls back to the oldest open one', () => {
  const a = blk('thinking', 'partial so f'), b = blk('thinking', '');
  assert.strictEqual(blockFor([a, b], 'thinking', 'partial so far, and the rest'), a);
  assert.strictEqual(blockFor([a, b], 'thinking', null), a, 'redacted: no text to match');
  assert.strictEqual(blockFor([blk('text', 'x')], 'thinking', 'x'), null, 'another type never matches');
});

test('overtaken: a block its message drew before the stream started is taken over once', () => {
  const streamed = blk('thinking', '', { final: true });
  const early = blk('thinking', '', { final: true, early: true });
  const blocks = [streamed, early];
  assert.strictEqual(overtaken(blocks, 'thinking'), early);
  assert.strictEqual(overtaken(blocks, 'text'), null);
  early.early = false;
  assert.strictEqual(overtaken(blocks, 'thinking'), null);
});
