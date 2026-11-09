// Anthropic's own model sources (src/anthropic-catalog.js) and how the registry
// refresh uses them: the docs pages are parsed deterministically from saved
// copies (test/fixtures/anthropic-docs), the vendor wins over models.dev, a
// failed page falls back to models.dev without throwing or wiping anything,
// and the shipped catalog lands in the registry at boot with no refresh.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ac = require('../src/anthropic-catalog');
const caps = require('../src/capabilities');

const FIX = path.join(__dirname, 'fixtures', 'anthropic-docs');
const OVERVIEW = fs.readFileSync(path.join(FIX, 'models-overview.md'), 'utf-8');
const PRICING = fs.readFileSync(path.join(FIX, 'pricing.md'), 'utf-8');
const DEPRECATIONS = fs.readFileSync(path.join(FIX, 'model-deprecations.md'), 'utf-8');

// --- parsing ---

test('overview: current models from the comparison table, legacy ones from the links', () => {
  const { models, labels } = ac.parseOverview(OVERVIEW);
  const fable = models['claude-fable-5-2'];
  assert.ok(fable, 'Fable 5.2 listed');
  assert.strictEqual(fable.label, 'Claude Fable 5.2');
  assert.strictEqual(fable.contextWindow, 1000000);
  assert.strictEqual(fable.maxOutputTokens, 128000);
  assert.strictEqual(fable.reasoning, true);
  assert.match(fable.description, /long-horizon agentic/);
  assert.strictEqual(fable.inputCostPerMTok, 8);
  assert.strictEqual(fable.outputCostPerMTok, 40);
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) assert.ok(models[id], id);
  // Legacy models: id and label only.
  assert.deepStrictEqual(models['claude-opus-4-5'], { modelId: 'claude-opus-4-5', label: 'Claude Opus 4.5' });
  assert.ok(models['claude-fable-5-1'] && models['claude-haiku-4-5']);
  assert.strictEqual(labels['Claude Sonnet 4.6'], 'claude-sonnet-4-6');
  assert.strictEqual(Object.keys(models).length, 14);
});

test('pricing: per-label rates, annotations split off, tiers in page order', () => {
  const rows = ac.parsePricing(PRICING);
  const byLabel = (l) => rows.filter(r => r.label === l);
  assert.deepStrictEqual(byLabel('Claude Fable 5.2')[0].prices,
    { inputCostPerMTok: 8, outputCostPerMTok: 40, cacheCreateCostPerMTok: 10, cacheReadCostPerMTok: 0.2 });
  // "(retired, except on … (Google managed) and Bedrock)" — nested parens.
  const opus41 = byLabel('Claude Opus 4.1')[0];
  assert.match(opus41.note, /^retired/);
  assert.strictEqual(opus41.prices.inputCostPerMTok, 15);
  assert.match(byLabel('Claude Mythos 5.2')[0].note, /limited availability/);
  const haiku = byLabel('Claude Haiku 5.5');
  assert.strictEqual(haiku.length, 2);
  assert.strictEqual(haiku[0].prices.inputCostPerMTok, 0.1, 'base tier first');
});

test('deprecations: lifecycle by undated id, a retirement date only for deprecated', () => {
  const d = ac.parseDeprecations(DEPRECATIONS);
  assert.deepStrictEqual(d['claude-fable-5-2'], { lifecycle: 'current', retiresAt: null });
  assert.deepStrictEqual(d['claude-sonnet-4-5'], { lifecycle: 'deprecated', retiresAt: '2026-11-30T00:00:00.000Z' });
  assert.strictEqual(d['claude-opus-4-1'].lifecycle, 'retired');
  assert.strictEqual(d['claude-opus-4-1'].retiresAt, null);
  assert.ok(!d['claude-sonnet-4-5-20250929'], 'dated id collapsed');
});

test('catalog: overview lists, pricing and deprecations only describe listed or known ids', () => {
  const sources = { overview: ac.parseOverview(OVERVIEW), pricing: ac.parsePricing(PRICING), deprecations: ac.parseDeprecations(DEPRECATIONS) };
  const known = new Set(['claude-mythos-5-1', 'claude-opus-4-1', 'claude-sonnet-4-5']);
  const { catalog, listed, priced } = ac.buildAnthropicCatalog(sources, known);
  assert.ok(listed.includes('claude-fable-5-2'));
  assert.deepStrictEqual(catalog['claude-fable-5-2'], {
    modelId: 'claude-fable-5-2', label: 'Claude Fable 5.2', contextWindow: 1000000, maxOutputTokens: 128000,
    description: 'For demanding reasoning and long-horizon agentic work', reasoning: true,
    inputCostPerMTok: 8, outputCostPerMTok: 40, cacheCreateCostPerMTok: 10, cacheReadCostPerMTok: 0.2,
    lifecycle: 'current', deprecated: false,
  });
  assert.strictEqual(catalog['claude-haiku-5-5'].inputCostPerMTok, 0.1, 'first tier wins');
  assert.strictEqual(catalog['claude-mythos-5-1'].inputCostPerMTok, 10, 'a known id is priced');
  assert.ok(!catalog['claude-mythos-5-2'], 'priced but neither listed nor known: not invented');
  assert.strictEqual(catalog['claude-opus-4-1'].lifecycle, 'retired');
  assert.strictEqual(catalog['claude-sonnet-4-5'].lifecycle, 'deprecated');
  assert.strictEqual(catalog['claude-sonnet-4-5'].retiresAt, '2026-11-30T00:00:00.000Z');
  assert.ok(!catalog['claude-3-haiku'], 'retired, unknown: dropped');
  assert.ok(priced.includes('claude-fable-5-2') && !priced.includes('claude-mythos-5-2'));
});

test('untrusted pages: bad ids, implausible numbers and junk tables are dropped', () => {
  const md = [
    '| Feature | Claude X | Claude Y | Claude Z |',
    '| :-- | :-- | :-- | :-- |',
    '| Claude API ID | `__proto__` | `claude-<img src=x>` | `claude-ok-1` |',
    '| Context window | 1M tokens | 1M tokens | 999999999999 tokens |',
    '| Max output | lots | 5 tokens | 64K tokens |',
  ].join('\n');
  const { models } = ac.parseOverview(md);
  assert.deepStrictEqual(Object.keys(models), ['claude-ok-1']);
  assert.strictEqual(models['claude-ok-1'].contextWindow, undefined, 'implausible window dropped');
  assert.strictEqual(models['claude-ok-1'].maxOutputTokens, 64000);
  const rows = ac.parsePricing([
    '| Model | Base input tokens | Output tokens |', '| - | - | - |',
    '| Claude A 1 | $99999 / MTok | $1 / MTok |',
    '| Claude B 1 | free | $1 / MTok |',
    '| Claude C 1 | $1 / MTok | $2 / MTok |',
  ].join('\n'));
  assert.deepStrictEqual(rows.map(r => r.label), ['Claude C 1']);
  assert.deepStrictEqual(ac.parseOverview('<html>nope</html>').models, {});
  assert.deepStrictEqual(ac.parseDeprecations(''), {});
  const api = ac.normalizeApiModels([{ id: 'claude-x-1-20260101', display_name: 'X', max_input_tokens: 'big', max_tokens: 64000 }, { id: 'gpt-5' }, null]);
  assert.deepStrictEqual(api, { 'claude-x-1': { modelId: 'claude-x-1', label: 'X', maxOutputTokens: 64000 } });
});

// --- fetching ---

const PAGES = { overview: OVERVIEW, pricing: PRICING, deprecations: DEPRECATIONS };
const URLS = {
  overview: ['https://a/overview.md', 'https://b/overview.md'],
  pricing: ['https://a/pricing.md', 'https://b/pricing.md'],
  deprecations: ['https://a/deprecations.md', 'https://b/deprecations.md'],
};
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const pageFetch = (handler) => async (url, opts) => {
  const name = Object.keys(URLS).find(k => URLS[k].includes(url));
  return handler(url, name, opts);
};

test('fetch: every source parsed; a mirror answers when the first URL fails; no key → no API call', async () => {
  const seen = [];
  const r = await ac.fetchAnthropicSources({ urls: URLS, fetchImpl: pageFetch((url, name) => {
    seen.push(url);
    if (!name) throw new Error(`unexpected ${url}`);
    return url.startsWith('https://a/') && name === 'pricing' ? response(503, '') : response(200, PAGES[name]);
  }) });
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.overview.models['claude-fable-5-2'] && r.pricing.length && r.deprecations['claude-opus-4-1']);
  assert.ok(seen.includes('https://b/pricing.md'));
  assert.strictEqual(r.api, null);
});

test('fetch: failures and HTML shells are reported, never thrown', async () => {
  const r = await ac.fetchAnthropicSources({ urls: URLS, apiKey: 'k', fetchImpl: async (url) => {
    if (url.includes('overview')) return response(200, '<!DOCTYPE html><html></html>');
    if (url.includes('pricing')) throw new Error('ECONNRESET');
    if (url.includes('deprecations')) return response(200, '# nothing here');
    return response(401, '{}');
  } });
  assert.strictEqual(r.overview, null);
  assert.strictEqual(r.pricing, null);
  assert.strictEqual(r.deprecations, null);
  assert.strictEqual(r.api, null);
  assert.strictEqual(r.errors.length, 4);
  assert.ok(r.errors.some(e => /overview page: served HTML/.test(e)));
  assert.ok(r.errors.some(e => /pricing page: ECONNRESET/.test(e)));
  assert.ok(r.errors.some(e => /deprecations page: no model table/.test(e)));
  assert.ok(r.errors.some(e => /Models API: HTTP 401/.test(e)));
});

test('fetch: with a key, the Models API lists models (dated ids collapsed)', async () => {
  let headers = null;
  const r = await ac.fetchAnthropicSources({ urls: URLS, apiKey: 'sk-test', fetchImpl: async (url, opts) => {
    if (url.startsWith('https://api.anthropic.com/')) {
      headers = opts.headers;
      return response(200, JSON.stringify({ data: [
        { id: 'claude-fable-5-2', display_name: 'Claude Fable 5.2', max_input_tokens: 1000000, max_tokens: 128000 },
        { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', max_input_tokens: 200000, max_tokens: 64000 },
      ], has_more: false }));
    }
    return response(404, '');
  } });
  assert.strictEqual(headers['x-api-key'], 'sk-test');
  assert.deepStrictEqual(Object.keys(r.api), ['claude-fable-5-2', 'claude-opus-4-5']);
  assert.strictEqual(r.api['claude-opus-4-5'].contextWindow, 200000);
});

// --- the registry refresh ---

function withRegistry(models, fn, pricingFile) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-anthcat-'));
  fs.mkdirSync(path.join(base, 'capabilities'), { recursive: true });
  fs.writeFileSync(path.join(base, 'capabilities', 'models.json'), JSON.stringify({
    providers: { anthropic: { label: 'Anthropic' } }, models,
  }));
  if (pricingFile) fs.writeFileSync(path.join(base, 'capabilities', 'anthropic-pricing.json'), JSON.stringify(pricingFile));
  return Promise.resolve(fn(base)).finally(() => fs.rmSync(base, { recursive: true, force: true }));
}

const anthRow = (id, extra = {}) => ({
  name: id, label: id, providerKey: 'anthropic', provider: 'anthropic', modelId: id,
  disabled: false, lifecycle: 'current', ...extra,
});
const sourcesFromFixtures = async () => ({
  overview: ac.parseOverview(OVERVIEW), pricing: ac.parsePricing(PRICING), deprecations: ac.parseDeprecations(DEPRECATIONS), api: null, errors: [],
});
// models.dev as of the bug report: Anthropic up to Fable 5.1, no 5.2.
const devCatalog = async () => ({ anthropic: {
  'claude-fable-5-1': { modelId: 'claude-fable-5-1', label: 'Claude Fable 5.1 (models.dev)', inputCostPerMTok: 99, outputCostPerMTok: 99, contextWindow: 200000, maxOutputTokens: null, deprecated: false },
  'claude-dev-only-1': { modelId: 'claude-dev-only-1', label: 'Dev Only', inputCostPerMTok: 1, outputCostPerMTok: 2, contextWindow: 100000, deprecated: false },
} });

// A release this build does not ship: the pages as saved, with Fable 5.2
// renamed to a "Fable 5.3" that only the vendor pages know.
const NEXT = (md) => md.replace(/fable-5-2/g, 'fable-5-3').replace(/Fable 5\.2/g, 'Fable 5.3');
const nextRelease = async () => ({
  overview: ac.parseOverview(NEXT(OVERVIEW)), pricing: ac.parsePricing(NEXT(PRICING)), deprecations: ac.parseDeprecations(NEXT(DEPRECATIONS)), api: null, errors: [],
});

test('refresh: a model only the vendor pages list is added, priced, and the vendor wins over models.dev', () =>
  withRegistry([anthRow('claude-fable-5-1', { inputCostPerMTok: 10, outputCostPerMTok: 50 }), anthRow('claude-sonnet-4-5')], async (base) => {
    const res = await caps.refreshModelRegistry(base, { fetchModelsDev: devCatalog, fetchAnthropic: nextRelease });
    assert.strictEqual(res.catalogError, null);
    const after = Object.fromEntries(caps.listModels(base).map(m => [m.modelId, m]));
    const fable = after['claude-fable-5-3'];
    assert.ok(fable, 'added');
    assert.strictEqual(fable.disabled, false);
    assert.strictEqual(fable.isNew, true);
    assert.strictEqual(fable.lifecycle, 'current');
    assert.strictEqual(fable.label, 'Claude Fable 5.3');
    assert.strictEqual(fable.contextWindow, 1000000);
    assert.strictEqual(fable.maxOutputTokens, 128000);
    assert.deepStrictEqual([fable.inputCostPerMTok, fable.outputCostPerMTok, fable.cacheReadCostPerMTok, fable.cacheCreateCostPerMTok], [8, 40, 0.2, 10]);
    assert.ok(res.anthropic.added.includes('Claude Fable 5.3'));
    assert.ok(!res.anthropic.added.includes('Dev Only'), 'models.dev additions are not credited to the docs');
    assert.ok(after['claude-dev-only-1'], 'a models.dev-only model still lands');
    assert.strictEqual(after['claude-fable-5-1'].inputCostPerMTok, 10, 'vendor price beats models.dev');
    assert.strictEqual(after['claude-fable-5-1'].contextWindow, 200000, 'a field the vendor pages lack (legacy row: no window) keeps models.dev\'s');
    assert.strictEqual(after['claude-sonnet-4-5'].lifecycle, 'deprecated');
    assert.strictEqual(after['claude-sonnet-4-5'].retiresAt, '2026-11-30T00:00:00.000Z');
    assert.ok(res.anthropic.listed >= 14 && res.anthropic.priced >= 14);
    assert.ok(typeof res.timings.totalMs === 'number' && typeof res.timings.anthropicMs === 'number');
    assert.ok(!caps.listUnpricedModels(base).some(m => m.modelId === 'claude-fable-5-3'), 'no pricing gap → no lookup spawn');
  }));

test('refresh: Fable 5.2 from the saved pages lands priced with its window', () =>
  withRegistry([], async (base) => {
    await caps.refreshModelRegistry(base, { fetchModelsDev: devCatalog, fetchAnthropic: sourcesFromFixtures });
    const fable = caps.listModels(base).find(m => m.modelId === 'claude-fable-5-2');
    assert.deepStrictEqual([fable.disabled, fable.contextWindow, fable.inputCostPerMTok, fable.outputCostPerMTok], [false, 1000000, 8, 40]);
  }));

test('refresh: Anthropic pages down → models.dev still applies, nothing is wiped, nothing throws', () =>
  withRegistry([anthRow('claude-fable-5-1', { inputCostPerMTok: 10, outputCostPerMTok: 50, contextWindow: 1000000 })], async (base) => {
    const res = await caps.refreshModelRegistry(base, {
      fetchModelsDev: devCatalog,
      fetchAnthropic: async () => ({ overview: null, pricing: null, deprecations: null, api: null, errors: ['overview page: HTTP 503', 'pricing page: timed out after 10s'] }),
    });
    assert.deepStrictEqual(res.anthropic.errors, ['overview page: HTTP 503', 'pricing page: timed out after 10s']);
    assert.strictEqual(res.anthropic.listed, 0);
    const after = Object.fromEntries(caps.listModels(base).map(m => [m.modelId, m]));
    assert.strictEqual(after['claude-fable-5-1'].inputCostPerMTok, 99, 'models.dev applied as before');
    assert.ok(after['claude-dev-only-1']);
  }));

test('refresh: both sources down, or a fetcher that throws — reported, existing rows untouched', () =>
  withRegistry([anthRow('claude-fable-5-1', { inputCostPerMTok: 10, outputCostPerMTok: 50 })], async (base) => {
    const res = await caps.refreshModelRegistry(base, {
      fetchModelsDev: async () => { throw new Error('HTTP 500'); },
      fetchAnthropic: async () => { throw new Error('boom'); },
    });
    assert.strictEqual(res.catalogError, 'HTTP 500');
    assert.deepStrictEqual(res.anthropic.errors, ['boom']);
    const after = Object.fromEntries(caps.listModels(base).map(m => [m.modelId, m]));
    assert.strictEqual(after['claude-fable-5-1'].inputCostPerMTok, 10);
  }));

test('refresh: the fetches run concurrently with the provider scan', () =>
  withRegistry([], async (base) => {
    const delay = (ms, v) => new Promise(r => setTimeout(() => r(v), ms));
    const t0 = Date.now();
    await caps.refreshModelRegistry(base, {
      fetchModelsDev: () => delay(300, { anthropic: {} }),
      fetchAnthropic: () => delay(300, { errors: [] }),
    });
    assert.ok(Date.now() - t0 < 550, `took ${Date.now() - t0} ms`);
  }));

// --- shipped catalog at boot ---

test('boot: a fresh data dir gets the Anthropic provider and Fable 5.2, enabled and priced', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-anthboot-'));
  try {
    const r = caps.ensureAnthropicModels(base);
    assert.ok(r.added.includes('Claude Fable 5.2'));
    const models = caps.listModelsWithAvailability(base);
    const fable = models.find(m => m.modelId === 'claude-fable-5-2');
    assert.ok(fable);
    assert.strictEqual(fable.disabled, false);
    assert.strictEqual(fable.lifecycle, 'current');
    assert.strictEqual(fable.inputCostPerMTok, 8);
    assert.strictEqual(fable.outputCostPerMTok, 40);
    assert.strictEqual(fable.contextWindow, 1000000);
    assert.ok(caps.listProviders(base).some(p => p.key === 'anthropic'));
    assert.deepStrictEqual(caps.listUnpricedModels(base).filter(m => m.providerKey === 'anthropic'), [], 'every shipped model priced');
    assert.deepStrictEqual(caps.ensureAnthropicModels(base).added, [], 'idempotent');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('boot: an existing install gains Fable 5.2; its own rows, prices and disabled flags stay', () =>
  withRegistry([
    anthRow('claude-opus-4-8', { disabled: true, inputCostPerMTok: 5, outputCostPerMTok: 25 }),
    anthRow('claude-fable-5-1', { inputCostPerMTok: 10, outputCostPerMTok: 50 }),
  ], (base) => {
    caps.ensureAnthropicModels(base);
    const after = Object.fromEntries(caps.listModels(base).map(m => [m.modelId, m]));
    assert.strictEqual(after['claude-opus-4-8'].disabled, true);
    assert.strictEqual(after['claude-fable-5-1'].inputCostPerMTok, 10);
    assert.strictEqual(after['claude-fable-5-2'].disabled, false);
    assert.strictEqual(after['claude-fable-5-2'].inputCostPerMTok, 8);
  }, { 'claude-fable-5-1': { inputCostPerMTok: 10, outputCostPerMTok: 50 } }));
