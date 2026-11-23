// What an agy call would have cost at Google's API list prices (docs/agy-inspector.md,
// "Pricing"). agy runs on the owner's Google AI subscription, so the billed
// amount is $0; the figure is only for comparison. Never read by the spend
// gate or the ledger.
//
// An agy model id is the catalog's model name plus an effort suffix
// (gemini-4-neon-medium → gemini-4-neon). An id with no catalog entry
// (gemini-pro-orchestrator-neon, a future tier) gets no figure: never a guess.
const path = require('path');

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const RATE_KEYS = ['inputCostPerMTok', 'outputCostPerMTok', 'cacheReadCostPerMTok', 'cacheCreateCostPerMTok'];

const ZERO_PRICING = Object.freeze({
  inputCostPerMTok: 0, outputCostPerMTok: 0, cacheReadCostPerMTok: 0, cacheCreateCostPerMTok: 0,
  credential: 'agy-subscription', provider: 'agy',
});

/** Catalog names to try for an agy model id: the id, then without its effort suffix. */
function baseNames(model) {
  const id = String(model || '').trim().toLowerCase();
  if (!id) return [];
  const out = [id];
  for (const e of EFFORTS) if (id.endsWith('-' + e)) out.push(id.slice(0, -e.length - 1));
  return out;
}

/**
 * The pricing object for an agy call. `lookup(name)` is the catalog's
 * getModelPricing. With a catalog entry: its list rates plus
 * `apiEquivalent: true` and `billedUsd: 0`, so every cost computed from
 * `pricing` is the API-equivalent figure. Without: the $0 pricing alone.
 */
function agyPricing(model, lookup) {
  for (const name of baseNames(model)) {
    let p = null;
    try { p = lookup ? lookup(name) : null; } catch { p = null; }
    if (p && typeof p.inputCostPerMTok === 'number' && typeof p.outputCostPerMTok === 'number') {
      const rates = {};
      for (const k of RATE_KEYS) if (typeof p[k] === 'number') rates[k] = p[k];
      // Gemini has no cache-write tokens; never fall back to a made-up rate for them.
      if (rates.cacheCreateCostPerMTok == null) rates.cacheCreateCostPerMTok = rates.inputCostPerMTok;
      return { ...rates, credential: 'agy-subscription', provider: 'agy', apiEquivalent: true, billedUsd: 0, pricedAs: name };
    }
  }
  return { ...ZERO_PRICING };
}

/** The catalog lookup agy-trace uses unless the context brings its own. */
function defaultLookup() {
  const { getModelPricing } = require('./capabilities');
  const { DATA_HOME } = require('./utils');
  return (name) => getModelPricing(DATA_HOME, name);
}

module.exports = { agyPricing, baseNames, defaultLookup, ZERO_PRICING, EFFORTS };
