// agy API-equivalent pricing (docs/agy-inspector.md, "Pricing"): an agy call is
// billed $0 (the Google AI subscription) but carries Google's API list rates of
// its requested model, so every cost computed from `pricing` is the
// API-equivalent figure, flagged `apiEquivalent`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.VISTACLAIR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pricing-'));

const { AgyExchange } = require('../src/agy-trace');
const { agyPricing, baseNames } = require('../src/agy-pricing');
const { toEntry, SessionTotals } = require('../src/session-totals');
const { getModelPricing } = require('../src/capabilities');

const ROOT = path.join(__dirname, '..');
const REAL = path.join(__dirname, 'fixtures', 'agy', 'real');
const real = (n) => fs.readFileSync(path.join(REAL, n), 'utf8');
const realEnv = (n) => JSON.parse(real(n));
const lookup = (name) => getModelPricing(ROOT, name);   // the repo's capabilities/models.json

function sse(usage, model) {
  const chunk = { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: usage, modelVersion: model, responseId: 'r1' }, traceId: 't', metadata: {} };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function run(envelope, body) {
  const store = { added: [], add(i) { this.added.push(i); }, save() {} };
  const ctx = { store, broadcaster: { broadcast() {} }, instanceId: 'w1', host: 'cloudcode-pa.googleapis.com', getPricing: lookup, lanes: { main: null, pendingType: null, types: new Map() } };
  const ex = new AgyExchange(ctx, { path: '/v1internal:streamGenerateContent?alt=sse', headers: { 'content-type': 'application/json' } });
  ex.requestBody(Buffer.from(JSON.stringify(envelope)));
  ex.requestEnd();
  ex.responseHead(200, { 'content-type': 'text/event-stream' });
  ex.responseBody(Buffer.from(body));
  ex.responseEnd();
  return store.added[0];
}

const withModel = (env, model) => ({ ...env, model });
const apiUsd = (it) => toEntry(1, { usage: it.usage, pricing: it.pricing })[8];
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('the owner\'s neon call: 16387 in, 953 out (596 thinking), no cache → ≈ $0.0635 API-equivalent, billed $0', () => {
  // prompt 16387, total 16387 + 953; thoughts 596 are part of the 953 output.
  const it = run(withModel(realEnv('tool-1-request.json'), 'gemini-4-neon-medium'),
    sse({ promptTokenCount: 16387, totalTokenCount: 16387 + 953, thoughtsTokenCount: 596 }, 'gemini-4-neon'));
  assert.deepStrictEqual(it.usage, { input_tokens: 16387, output_tokens: 953, cache_read_input_tokens: 0, reasoning_tokens: 596 });
  assert.strictEqual(it.pricing.apiEquivalent, true);
  assert.strictEqual(it.pricing.billedUsd, 0);
  assert.strictEqual(it.pricing.credential, 'agy-subscription');
  near(apiUsd(it), 16387 * 3 / 1e6 + 953 * 15 / 1e6);
  assert.ok(Math.abs(apiUsd(it) - 0.0635) < 0.0001);
  // reasoning_tokens are inside output_tokens: not priced a second time.
  assert.ok(apiUsd(it) < 16387 * 3 / 1e6 + (953 + 596) * 15 / 1e6);
});

test('cached tokens are priced at the cache rate, not also at the input rate', () => {
  // The real call: prompt 8844 of which 6603 cached; candidates 2 + thoughts 10.
  const it = run(withModel(realEnv('tool-2-request.json'), 'gemini-4-neon-high'), real('tool-2-response.sse'));
  assert.strictEqual(it.usage.input_tokens, 8844 - 6603);
  assert.strictEqual(it.usage.cache_read_input_tokens, 6603);
  const want = (8844 - 6603) * 3 / 1e6 + 6603 * 0.15 / 1e6 + 12 * 15 / 1e6;
  near(apiUsd(it), want);
  const twice = 8844 * 3 / 1e6 + 6603 * 0.15 / 1e6 + 12 * 15 / 1e6;
  assert.ok(apiUsd(it) < twice - 1e-6, 'the cached part is not billed as input as well');
});

test('an unknown agy model id gets no API-equivalent figure (billed $0, no guess)', () => {
  for (const model of ['gemini-pro-orchestrator-neon', 'gemini-9-unobtainium-medium']) {
    const it = run(withModel(realEnv('tool-1-request.json'), model),
      sse({ promptTokenCount: 1000, totalTokenCount: 1500 }, model));
    assert.ok(!it.pricing.apiEquivalent, model);
    assert.strictEqual(it.pricing.inputCostPerMTok, 0);
    assert.strictEqual(it.pricing.credential, 'agy-subscription');
    assert.strictEqual(apiUsd(it), 0);
  }
});

test('a side call (the flash-lite safety monitor) is priced at its own model\'s rate', () => {
  const it = run(realEnv('monitor-request.json'), real('monitor-response.sse'));
  assert.ok(it.agy.side);
  assert.strictEqual(it.pricing.apiEquivalent, true);
  assert.strictEqual(it.pricing.inputCostPerMTok, 0.3);
  assert.strictEqual(it.pricing.outputCostPerMTok, 2.5);
  assert.strictEqual(it.pricing.cacheReadCostPerMTok, 0.03);
  near(apiUsd(it), it.usage.input_tokens * 0.3 / 1e6 + it.usage.output_tokens * 2.5 / 1e6 + it.usage.cache_read_input_tokens * 0.03 / 1e6);
});

test('agyPricing: effort suffixes map to the catalog name; no entry → $0 without the flag', () => {
  assert.deepStrictEqual(baseNames('Gemini-4-Neon-XHigh'), ['gemini-4-neon-xhigh', 'gemini-4-neon']);
  for (const [id, rate] of [['gemini-4-neon-medium', 3], ['gemini-4-argon-low', 2], ['gemini-4-hydrogen-high', 1.5], ['gemini-3.8-flash-low', 0.75], ['gemini-3.5-flash-lite', 0.3]]) {
    const p = agyPricing(id, lookup);
    assert.strictEqual(p.apiEquivalent, true, id);
    assert.strictEqual(p.inputCostPerMTok, rate, id);
  }
  assert.strictEqual(agyPricing('', lookup).apiEquivalent, undefined);
  assert.strictEqual(agyPricing('gemini-4-neon', () => { throw new Error('x'); }).inputCostPerMTok, 0);
});

test('session totals flag an API-equivalent cost; a Claude turn is unflagged', () => {
  const it = run(withModel(realEnv('tool-1-request.json'), 'gemini-4-neon-medium'),
    sse({ promptTokenCount: 16387, totalTokenCount: 17340, thoughtsTokenCount: 596 }, 'gemini-4-neon'));
  const e = toEntry(1, { id: it.id, usage: it.usage, pricing: it.pricing, timing: it.timing });
  assert.strictEqual(e[11], 1);
  assert.strictEqual(toEntry(1, { usage: { input_tokens: 5 }, pricing: { inputCostPerMTok: 3, outputCostPerMTok: 15 } })[11], undefined);
  assert.strictEqual(toEntry(1, { usage: { input_tokens: 5 }, pricing: agyPricing('gemini-pro-orchestrator-neon', lookup) })[11], undefined);
});

test('the spend gate never settles an agy interaction (its endpoint is not /v1/messages)', () => {
  const it = run(withModel(realEnv('tool-1-request.json'), 'gemini-4-neon-medium'),
    sse({ promptTokenCount: 16387, totalTokenCount: 17340 }, 'gemini-4-neon'));
  assert.notStrictEqual(it.endpoint, '/v1/messages');
  const gate = fs.readFileSync(path.join(ROOT, 'platform', 'src', 'apps', 'spend-gate.js'), 'utf8');
  assert.match(gate, /interaction\.endpoint !== '\/v1\/messages'\) return false/);
});

test('an agy session adds API-equivalent prices to apiUsd and never to the billed costUsd', () => {
  const AgySession = require('../src/agy-session');
  const me = { costUsd: 0, apiUsd: 0, emitted: 0, _emitStatus() { this.emitted++; } };
  const usage = { input_tokens: 16387, output_tokens: 953, cache_read_input_tokens: 0 };
  AgySession.prototype.addRequestCost.call(me, usage, agyPricing('gemini-4-neon-medium', lookup));
  AgySession.prototype.addRequestCost.call(me, usage, agyPricing('gemini-pro-orchestrator-neon', lookup));   // no figure: ignored
  AgySession.prototype.addRequestCost.call(me, null, agyPricing('gemini-4-neon-medium', lookup));
  near(me.apiUsd, 16387 * 3 / 1e6 + 953 * 15 / 1e6);
  assert.strictEqual(me.costUsd, 0);
  assert.strictEqual(me.emitted, 1);
});
