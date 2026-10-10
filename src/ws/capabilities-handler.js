// WebSocket handler for capability CRUD: skills, agents, hooks, models, providers.
// Registered on the dashboard broadcaster under those prefixes. Initial lists are
// sent by the broadcaster's connection bootstrap, so this handler is handleMessage-only.

const caps = require('../capabilities');
const { buildClaudeArgs, spawnClaude, describeClaudeError, killGracefully, DATA_HOME } = require('../utils');

const PROJECT_ROOT = DATA_HOME;

const PREFIXES = ['skill:', 'agent:', 'hook:', 'model:', 'provider:', 'prefs:'];

function handleMessage(ws, msg, bc) {
  const send = (data) => ws.send(JSON.stringify(data));

  switch (msg.type) {
    // --- Skills ---
    case 'skill:list':
      send({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) });
      break;
    case 'skill:save': {
      const ok = caps.saveSkill(PROJECT_ROOT, msg.name, msg.content, msg.extraFiles);
      if (ok) {
        bc.broadcast({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) });
      } else {
        send({ type: 'chat:error', text: `Invalid skill name: ${msg.name}` });
      }
      break;
    }
    case 'skill:delete': {
      const ok = caps.deleteSkill(PROJECT_ROOT, msg.name);
      if (ok) bc.broadcast({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) });
      break;
    }

    // --- Agents ---
    case 'agent:list':
      send({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) });
      break;
    case 'agent:save': {
      const ok = caps.saveAgent(PROJECT_ROOT, msg.name, msg.content);
      if (ok) {
        bc.broadcast({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) });
      } else {
        send({ type: 'chat:error', text: `Invalid agent name: ${msg.name}` });
      }
      break;
    }
    case 'agent:delete': {
      const ok = caps.deleteAgent(PROJECT_ROOT, msg.name);
      if (ok) bc.broadcast({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) });
      break;
    }

    // --- Hooks ---
    case 'hook:list':
      send({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) });
      break;
    case 'hook:save': {
      caps.saveHook(PROJECT_ROOT, msg.hook);
      bc.broadcast({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) });
      break;
    }
    case 'hook:delete': {
      const ok = caps.deleteHook(PROJECT_ROOT, msg.event, msg.entryIndex);
      if (ok) bc.broadcast({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) });
      break;
    }

    // --- Models ---
    case 'model:list':
      send({ type: 'model:list', models: caps.listModelsWithAvailability(PROJECT_ROOT) });
      break;
    case 'model:save': {
      const ok = caps.saveModel(PROJECT_ROOT, msg.model);
      if (ok) {
        bc.broadcast({ type: 'model:list', models: caps.listModelsWithAvailability(PROJECT_ROOT) });
      } else {
        send({ type: 'chat:error', text: `Cannot save model: ${msg.model?.name} (invalid)` });
      }
      break;
    }
    case 'model:delete': {
      const ok = caps.deleteModel(PROJECT_ROOT, msg.name);
      if (ok) {
        bc.broadcast({ type: 'model:list', models: caps.listModelsWithAvailability(PROJECT_ROOT) });
      } else {
        send({ type: 'chat:error', text: `Cannot delete model: ${msg.name}` });
      }
      break;
    }
    case 'model:toggle': {
      const model = caps.loadModel(PROJECT_ROOT, msg.name);
      if (model) {
        model.disabled = !!msg.disabled;
        model.isNew = false;
        caps.saveModel(PROJECT_ROOT, model);
        bc.broadcast({ type: 'model:list', models: caps.listModelsWithAvailability(PROJECT_ROOT) });
      }
      break;
    }
    case 'model:refresh':
      handleModelRefresh(ws, bc);
      break;

    // --- Providers ---
    case 'provider:list':
      send({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) });
      break;
    case 'provider:save': {
      const ok = caps.saveProvider(PROJECT_ROOT, msg.key, msg.provider);
      if (ok) {
        bc.broadcast({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) });
        // Resolved models include provider apiKey, so refresh models too
        bc.broadcast({ type: 'model:list', models: caps.listModelsWithAvailability(PROJECT_ROOT) });
      } else {
        send({ type: 'chat:error', text: `Cannot save provider: ${msg.key}` });
      }
      break;
    }
    case 'provider:delete': {
      const ok = caps.deleteProvider(PROJECT_ROOT, msg.key);
      if (ok) {
        bc.broadcast({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) });
      } else {
        send({ type: 'chat:error', text: `Cannot delete provider: ${msg.key} (in use or not found)` });
      }
      break;
    }

    // --- Preferences (Claude auth choice) ---
    case 'prefs:get':
      send({ type: 'prefs:claudeAuth', ...claudeAuthState() });
      send({ type: 'prefs:cliModel', ...cliModelState() });
      break;
    case 'prefs:cliModel:set': {
      const ok = caps.setCliModelPref(PROJECT_ROOT, msg.value);
      if (!ok) {
        send({ type: 'chat:error', text: `Invalid CLI model: ${msg.value}` });
        break;
      }
      bc.broadcast({ type: 'prefs:cliModel', ...cliModelState() });
      break;
    }
    case 'prefs:claudeAuth:set': {
      const ok = caps.setClaudeAuthPref(PROJECT_ROOT, msg.value);
      if (!ok) {
        send({ type: 'chat:error', text: `Invalid Claude auth preference: ${msg.value}` });
        break;
      }
      bc.broadcast({ type: 'prefs:claudeAuth', ...claudeAuthState() });
      break;
    }
  }
}

// Snapshot of the default-model-for-new-CLI-tabs choice, plus the alias list the
// picker offers alongside the resolved model catalog.
function cliModelState() {
  return {
    model: caps.getCliModelPref(PROJECT_ROOT),
    aliases: caps.CLI_MODEL_ALIASES,
  };
}

// Snapshot of the Claude auth decision for the frontend.
function claudeAuthState() {
  return {
    pref: caps.getClaudeAuthPref(PROJECT_ROOT) || null,
    hasSubscription: caps.hasClaudeSubscription(),
  };
}

// --- Model refresh ---------------------------------------------------------
//
// Phase 1 scans every provider's /models API. Phase 2 reads the models.dev
// catalog (one JSON, every provider's prices and limits) and merges it. Neither
// has a model in the loop. Phase 3 looks at what is still unpriced among the
// enabled models: nothing, in the normal case, and the refresh ends without a
// spawn; otherwise ONE short-lived headless Claude looks those few up on the
// web and returns JSON — the server does every write.

// The task is fetch-a-page-and-emit-JSON work, so pin a fast model and low
// effort instead of inheriting whatever the account default is.
const REFRESH_TASK_MODEL = 'sonnet';
const REFRESH_TASK_EFFORT = 'low';
const REFRESH_TASK_TIMEOUT_MS = 240000;

// Pull the first JSON object out of a blob of model output (bare or fenced).
function parseJsonBlock(text) {
  if (typeof text !== 'string') return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object') return v;
    } catch {}
  }
  return null;
}

// Run one lookup task. Web tools only — no filesystem or subagent access, since
// everything it needs is inlined in the prompt and the server owns the writes.
// Never rejects: failures come back as { ok: false, error }.
function runRefreshTask({ prompt, instanceId, proxyPort, timeoutMs = REFRESH_TASK_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const args = buildClaudeArgs({
      allowedTools: ['WebSearch', 'WebFetch'],
      model: REFRESH_TASK_MODEL,
      effort: REFRESH_TASK_EFFORT,
    }, { outputFormat: 'json' });

    let proc;
    try {
      proc = spawnClaude(args, {
        cwd: PROJECT_ROOT,
        proxyPort,
        instanceId,
        anthropicApiKey: caps.resolveHeadlessAuth(PROJECT_ROOT),
      });
    } catch (err) {
      resolve({ ok: false, error: err.message || String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGracefully(proc); }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf-8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf-8'); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message || String(err) });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
        return;
      }
      const claudeErr = describeClaudeError(code, stderr);
      if (claudeErr) {
        resolve({ ok: false, error: claudeErr });
        return;
      }
      // --output-format json wraps the final text in a result envelope.
      const envelope = parseJsonBlock(stdout);
      if (envelope?.is_error) {
        resolve({ ok: false, error: String(envelope.result || 'task reported an error').slice(0, 300) });
        return;
      }
      const data = typeof envelope?.result === 'string' ? parseJsonBlock(envelope.result) : envelope;
      if (!data || typeof data.models !== 'object' || !data.models) {
        resolve({ ok: false, error: 'no usable JSON in response' });
        return;
      }
      resolve({ ok: true, data });
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// One prompt for every model still unpriced after the catalog merge, whatever
// the provider. The reply is keyed providerKey → modelId so the server can
// route each price to the right row.
function gapPricingPrompt(gaps, labelOf) {
  const byProvider = new Map();
  for (const g of gaps) {
    if (!byProvider.has(g.providerKey)) byProvider.set(g.providerKey, []);
    byProvider.get(g.providerKey).push(g);
  }
  const sections = [...byProvider].map(([key, list]) => {
    const rows = list.map(m => `  - ${m.modelId}${m.label && m.label !== m.modelId ? ` (${m.label})` : ''}`).join('\n');
    return `${labelOf(key)} (providerKey "${key}"):\n${rows}`;
  }).join('\n\n');

  return `Look up the current public API pricing for the models below and return it as JSON.

Use WebSearch and WebFetch to find each vendor's own official pricing page or API docs (the vendor's site, not a third-party aggregator or blog), then read the per-model rates.

Models (exact API model ids, grouped by provider):
${sections}

Return ONE JSON object and nothing else — no prose, no markdown fence:
{"models":{"<providerKey>":{"<model id exactly as listed>":{"inputCostPerMTok":<number>,"outputCostPerMTok":<number>,"cacheReadCostPerMTok":<number|null>,"cacheCreateCostPerMTok":<number|null>}}}}

Rules:
- Every figure is USD per MILLION tokens on the standard tier: not batch, not priority, not a discounted off-peak or promotional rate. Convert if the page quotes per 1K tokens.
- A pricing table often labels a model with a marketing or version name rather than its API id. Match on the API model name the docs give for each row.
- If the table separates cache-hit and cache-miss input prices, inputCostPerMTok is the cache-MISS price and cacheReadCostPerMTok is the cache-HIT price.
- Use null for a rate the provider does not publish — most providers publish no cache-write price.
- Price every model you can find. Omit one only if the vendor genuinely does not list it, and never invent or extrapolate a number.`;
}

function handleModelRefresh(ws, bc) {
  // A refresh outlives a page navigation, so tolerate the socket closing under us.
  const send = (data) => { try { ws.send(JSON.stringify(data)); } catch {} };
  const lines = [];
  const pushStatus = (line) => {
    lines.push(line);
    send({ type: 'model:refresh:status', text: line, lines: [...lines] });
  };
  const broadcastModels = () => bc.broadcast({ type: 'model:list', models: caps.listModelsWithAvailability(PROJECT_ROOT) });
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  send({ type: 'model:refresh:status', text: 'Scanning providers for new models...' });
  // Phases 1+2 (provider scan, models.dev catalog) are the shared registry
  // refresh — Pro's daily model review runs the same function.
  caps.refreshModelRegistry(PROJECT_ROOT).then(async ({ scan: scanResults, catalog: applied, catalogError }) => {
    send({ type: 'model:refresh:scanned', results: scanResults });
    broadcastModels();

    const providers = caps.listProviders(PROJECT_ROOT);
    const labelOf = (key) => providers.find(p => p.key === key)?.label || key;

    if (catalogError) pushStatus(`models.dev: catalog lookup failed — ${catalogError}`);
    if (applied) {
      const parts = [];
      for (const [key, r] of Object.entries(applied)) {
        const bits = [];
        if (r.added.length) bits.push(`+${r.added.length} new`);
        if (r.repriced.length) bits.push(`${r.repriced.length} repriced`);
        if (r.deprecated.length) bits.push(`${r.deprecated.length} deprecated`);
        const otherOnly = r.updated.length - new Set([...r.repriced, ...r.deprecated]).size;
        if (otherOnly > 0) bits.push(`${otherOnly} detail${otherOnly === 1 ? '' : 's'}`);
        parts.push(`${labelOf(key)} ${bits.length ? bits.join(', ') : 'current'}`);
      }
      pushStatus(`models.dev: ${parts.join('; ') || 'no supported provider configured'}`);
      broadcastModels();
    }

    // Phase 3: decide whether a lookup is needed at all. Only an enabled model
    // the catalog could not price justifies spawning anything, and then it is
    // one process for all of them.
    const gaps = caps.listUnpricedModels(PROJECT_ROOT);
    if (!gaps.length) {
      pushStatus('Every enabled model is priced — no lookup needed.');
    } else {
      pushStatus(`Looking up pricing for ${plural(gaps.length, 'model')} the catalog does not list...`);
      const res = await runRefreshTask({
        prompt: gapPricingPrompt(gaps, labelOf),
        instanceId: `pricing-gaps-${Date.now()}`,
        proxyPort: bc._proxyPort,
      });
      if (!res.ok) {
        pushStatus(`Pricing lookup failed — ${res.error}`);
      } else {
        for (const [key, models] of Object.entries(res.data.models)) {
          if (!models || typeof models !== 'object') continue;
          try {
            const applied = caps.applyProviderPricing(PROJECT_ROOT, key, models);
            if (key === 'anthropic') caps.applyAnthropicCatalog(PROJECT_ROOT, models);
            pushStatus(applied.updated.length
              ? `${labelOf(key)}: repriced ${plural(applied.updated.length, 'model')}`
              : `${labelOf(key)}: nothing usable came back`);
          } catch (err) {
            pushStatus(`${labelOf(key)}: could not apply pricing — ${err.message || err}`);
          }
        }
        const still = caps.listUnpricedModels(PROJECT_ROOT);
        if (still.length) pushStatus(`Still unpriced: ${still.map(m => m.modelId).join(', ')}`);
      }
    }

    send({ type: 'model:refresh:done', text: 'Refresh complete.', lines: [...lines] });
    broadcastModels();
  }).catch(err => {
    send({ type: 'model:refresh:error', error: err.message });
  });
}

module.exports = { PREFIXES, handleMessage };
