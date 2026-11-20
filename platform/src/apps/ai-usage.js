// Back-compat shim: the per-app AI spend ledger moved to spend-ledger.js
// (every metered platform call, not just LLM; stored under core's dataHome).
// `query` keeps the ai.usage / ctx.aiUsage result shape unchanged.
const ledger = require('./spend-ledger');
module.exports = {
  init: (options) => ledger.init(options || {}),
  query: (appDir, params) => ledger.query(appDir, params),
  flushAll: () => ledger.flushAll(),
  computeCost: ledger.computeCost,
};
