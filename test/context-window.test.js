// The model catalogue's context window (caps.contextWindowFor), the estimate a
// session's context chip shows until a turn's end gives the exact one: `[1m]`
// suffixes, `claude-` prefixes and date suffixes, ids extending a catalogue
// entry, family aliases (newest non-retired), the pricing file and
// models.json's anthropic rows, and null for anything else.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const caps = require('../src/capabilities');

const tmpBase = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vc-ctxwin-'));
const writeCaps = (base, file, data) => {
  fs.mkdirSync(path.join(base, 'capabilities'), { recursive: true });
  fs.writeFileSync(path.join(base, 'capabilities', file), JSON.stringify(data));
};

test('built-in catalogue: ids with or without claude-, dated, [1m] and extended', () => {
  const base = tmpBase();
  try {
    assert.strictEqual(caps.contextWindowFor(base, 'claude-haiku-4-5'), 200000);
    assert.strictEqual(caps.contextWindowFor(base, 'haiku-4-5'), 200000);
    assert.strictEqual(caps.contextWindowFor(base, 'claude-haiku-4-5-20251001'), 200000);
    assert.strictEqual(caps.contextWindowFor(base, 'Claude-Sonnet-4-6'), 1000000);
    assert.strictEqual(caps.contextWindowFor(base, 'claude-haiku-4-5[1m]'), 1000000, '[1m] is a million whatever the entry');
    assert.strictEqual(caps.contextWindowFor(base, 'claude-opus-5-5'), 1000000, 'extends claude-opus-5');
    assert.strictEqual(caps.contextWindowFor(base, 'claude-haiku-4-55'), null, 'only at a segment boundary');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('aliases: the family\'s newest non-retired entry; unknowns are null', () => {
  const base = tmpBase();
  try {
    assert.strictEqual(caps.contextWindowFor(base, 'haiku'), 200000);
    assert.strictEqual(caps.contextWindowFor(base, 'opus'), 1000000);
    assert.strictEqual(caps.contextWindowFor(base, 'opusplan'), 1000000);
    assert.strictEqual(caps.contextWindowFor(base, 'sonnet[1m]'), 1000000);
    for (const m of ['default', 'best', 'gpt-4o', 'claude-unknown-9', '', null, undefined]) {
      assert.strictEqual(caps.contextWindowFor(base, m), null, String(m));
    }
    // A newer haiku in the pricing file wins the alias; a retired one never does.
    writeCaps(base, 'anthropic-pricing.json', {
      'claude-haiku-5': { lifecycle: 'current', contextWindow: 400000 },
      'claude-haiku-9': { lifecycle: 'retired', contextWindow: 50000 },
      'claude-3-haiku-20240307': { lifecycle: 'current', contextWindow: 100000 },
    });
    assert.strictEqual(caps.contextWindowFor(base, 'haiku'), 400000);
    assert.strictEqual(caps.contextWindowFor(base, 'claude-3-haiku'), 100000);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the pricing file overrides the built-ins; models.json\'s anthropic rows count, others do not', () => {
  const base = tmpBase();
  try {
    writeCaps(base, 'anthropic-pricing.json', { 'claude-haiku-4-5': { contextWindow: 300000 } });
    writeCaps(base, 'models.json', { providers: {}, models: [
      { name: 'my-claude', providerKey: 'anthropic', modelId: 'claude-custom-1', contextWindow: 123000 },
      { name: 'gpt-x', providerKey: 'openai', modelId: 'gpt-x', contextWindow: 128000 },
    ] });
    assert.strictEqual(caps.contextWindowFor(base, 'claude-haiku-4-5'), 300000);
    assert.strictEqual(caps.contextWindowFor(base, 'claude-custom-1-20260101'), 123000);
    assert.strictEqual(caps.contextWindowFor(base, 'gpt-x'), null);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
