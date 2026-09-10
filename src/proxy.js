const express = require('express');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream');
const SSEPassthrough = require('./sse-passthrough');
const { generateId, filterRequestHeaders, filterResponseHeaders, sanitizeForDashboard, getInstanceContext, DATA_HOME } = require('./utils');
const { getProvider } = require('./providers/registry');
const caps = require('./capabilities');
const { getModelPricing } = caps;
const enhancedAskTool = require('./ask-schema');
const InteractionStore = require('./store');

const PROJECT_ROOT = DATA_HOME;

// Shared state: pending AskUserQuestion interceptions (used by /api/ask endpoint)
const pendingQuestions = new Map();

/**
 * Generic Transform that chains rule-provided transformSSE hooks over each SSE line.
 */
class RuleResponseTransform extends Transform {
  constructor(hooks) {
    super();
    this._hooks = hooks;
    this._remainder = '';
  }
  _transform(chunk, encoding, callback) {
    const text = this._remainder + chunk.toString('utf-8');
    const lines = text.split('\n');
    this._remainder = lines.pop();
    const out = [];
    for (let line of lines) {
      for (const hook of this._hooks) line = hook(line);
      out.push(line + '\n');
    }
    if (out.length) this.push(Buffer.from(out.join(''), 'utf-8'));
    callback();
  }
  _flush(callback) {
    if (this._remainder) {
      let line = this._remainder;
      for (const hook of this._hooks) line = hook(line);
      this.push(Buffer.from(line, 'utf-8'));
    }
    callback();
  }
}

const RETRYABLE_ERR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

function isRetryableFetchError(err) {
  if (!err) return false;
  const code = err.code || err.cause?.code;
  if (code && RETRYABLE_ERR_CODES.has(code)) return true;
  const msg = `${err.message || ''} ${err.cause?.message || ''}`.toLowerCase();
  return /fetch failed|terminated|socket hang up|network|econn|und_err/.test(msg);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Fetch with transparent retry. For streaming requests, also reads the first
 * body chunk so we know the stream is actually flowing before the caller
 * commits headers to the client — a stream error on the first read is still
 * retry-safe, but a stream error after the first chunk is forwarded is not.
 *
 * Returns { upstream, firstChunk, reader }.
 *   - Non-streaming / error / empty body: { upstream, firstChunk: null, reader: null }
 *   - Streaming success: { upstream, firstChunk: Uint8Array, reader: ReadableStreamDefaultReader }
 *     (caller must consume firstChunk first, then read the rest from reader)
 */
async function fetchUpstreamWithRetry(url, opts, {
  maxRetries = 2,
  baseDelay = 300,
  bufferFirstChunk = false,
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const upstream = await fetch(url, opts);

      // Retry on transient 5xx
      if (upstream.status >= 500 && upstream.status < 600 && attempt < maxRetries) {
        lastErr = new Error(`Upstream HTTP ${upstream.status}`);
        try { await upstream.body?.cancel(); } catch {}
        console.log(`[proxy] Upstream ${upstream.status}, retrying (${attempt + 1}/${maxRetries})`);
        await sleep(baseDelay * 2 ** attempt);
        continue;
      }

      // Non-streaming / error response: hand the body back untouched
      if (!bufferFirstChunk || !upstream.ok || !upstream.body) {
        return { upstream, firstChunk: null, reader: null };
      }

      // Streaming success: peek the first chunk so we know the stream is flowing
      const reader = upstream.body.getReader();
      try {
        const { value, done } = await reader.read();
        if (done) {
          try { reader.releaseLock(); } catch {}
          return { upstream, firstChunk: null, reader: null };
        }
        return { upstream, firstChunk: value, reader };
      } catch (readErr) {
        try { reader.releaseLock(); } catch {}
        try { await upstream.body.cancel(); } catch {}
        if (!isRetryableFetchError(readErr) || attempt === maxRetries) throw readErr;
        lastErr = readErr;
        console.log(`[proxy] First-chunk read failed, retrying (${attempt + 1}/${maxRetries}): ${readErr.message}`);
        await sleep(baseDelay * 2 ** attempt);
        continue;
      }
    } catch (err) {
      lastErr = err;
      if (!isRetryableFetchError(err) || attempt === maxRetries) throw err;
      console.log(`[proxy] Upstream fetch failed, retrying (${attempt + 1}/${maxRetries}): ${err.message}`);
      await sleep(baseDelay * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** Async generator that yields a pre-read first chunk, then drains the reader. */
async function* resumeWebStream(firstChunk, reader) {
  yield firstChunk;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// Resolve a CLI tab's per-session model override (modelMap, family-substring
// match fable/opus/sonnet/haiku). Anthropic targets are applied in-place to
// body.model; non-Anthropic targets are returned as tabModelDef for the
// translation path. Shared by /v1/messages and /v1/messages/count_tokens so a
// remapped model is honored consistently and never reaches Anthropic with an
// unknown model id.
function resolveTabModel(body, cliSettings) {
  if (!cliSettings || !body.model || !cliSettings.modelMap) return { tabModelDef: null };
  const lower = body.model.toLowerCase();
  const family = lower.includes('fable') ? 'fable'
    : lower.includes('opus') ? 'opus'
    : lower.includes('sonnet') ? 'sonnet'
    : lower.includes('haiku') ? 'haiku'
    : null;
  if (!family || !cliSettings.modelMap[family]) return { tabModelDef: null };
  const mapped = caps.loadModel(PROJECT_ROOT, cliSettings.modelMap[family]);
  // Skip retired/disabled targets — fall through to passthrough so a
  // decommissioned model can never be routed to.
  if (!mapped || mapped.lifecycle === 'retired' || mapped.disabled) return { tabModelDef: null };
  if (mapped.providerKey === 'anthropic') {
    body.model = mapped.modelId;
    return { tabModelDef: null };
  }
  return { tabModelDef: mapped };
}

// Rough local token estimate (~4 chars/token) for count_tokens when the tab
// model routes to a non-Anthropic provider. Approximate by design — used only
// to keep the CLI's context gauge sane, not for billing.
function estimateInputTokens(body) {
  let chars = 0;
  if (typeof body.system === 'string') chars += body.system.length;
  else if (Array.isArray(body.system)) for (const b of body.system) chars += (b?.text || '').length;
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (typeof block === 'string') chars += block.length;
        else if (block?.text) chars += block.text.length;
        else chars += JSON.stringify(block || '').length;
      }
    }
  }
  for (const t of body.tools || []) chars += JSON.stringify(t || '').length;
  return Math.max(1, Math.ceil(chars / 4));
}

// Resolve body.model against the model registry for callers that don't use a
// CLI tab modelMap — e.g. app ai.prompt spawns (`claude -p --model <name>`),
// which set body.model to a registry name/id but carry no tab override. Returns
// a non-Anthropic modelDef to route through the translation path, or null to
// fall through to the Anthropic passthrough. Anthropic (claude-*) models always
// passthrough, so they short-circuit before any disk read to keep the CLI hot
// path fast.
function resolveRegistryModel(modelRef) {
  if (!modelRef || /^claude-/i.test(modelRef)) return null;
  let model;
  try {
    const models = caps.listModels(PROJECT_ROOT);
    model = models.find(m => m.name === modelRef) || models.find(m => m.modelId === modelRef);
  } catch { return null; }
  if (!model) return null;
  if (model.lifecycle === 'retired' || model.disabled) return null;
  if (model.providerKey === 'anthropic' || model.provider === 'anthropic') return null;
  return model;
}

function sendProxyError(res, err) {
  if (res.headersSent) {
    try { res.end(); } catch {}
    return;
  }
  res.writeHead(502, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    type: 'error',
    error: { type: 'api_error', message: `Proxy error: ${err.message}` },
  }));
}

// Parse an Anthropic SSE event string ("event: ...\ndata: ...\n\n") into {eventType, data}
function parseSSEString(eventStr) {
  const lines = eventStr.split('\n');
  let eventType = null;
  let dataStr = null;
  for (const line of lines) {
    if (line.startsWith('event: ')) eventType = line.slice(7).trim();
    if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
  }
  if (!eventType || !dataStr) return null;
  try {
    return { eventType, data: JSON.parse(dataStr) };
  } catch {
    return { eventType, data: dataStr };
  }
}

// Shared SSE event tracking for inspector/dashboard (used by both paths)
function trackSSEEvent(event, interaction, activeToolBlocks, broadcaster, instanceId) {
  if (event.eventType === 'message_start') {
    interaction.timing.ttfb = Date.now() - interaction.timing.startedAt;
    if (event.data?.message?.usage) {
      interaction.usage = { ...event.data.message.usage };
    }
  }
  if (event.eventType === 'message_delta' && event.data?.usage) {
    interaction.usage = { ...interaction.usage, ...event.data.usage };
  }
  if (event.eventType === 'message_stop') {
    interaction.timing.duration = Date.now() - interaction.timing.startedAt;
    interaction.status = 'complete';
  }

  // Track tool_use blocks (for inspector timeline)
  if (event.eventType === 'content_block_start' && event.data?.content_block?.type === 'tool_use') {
    const cb = event.data.content_block;
    activeToolBlocks.set(event.data.index, { id: cb.id, name: cb.name, inputJson: '' });
  }
  if (event.eventType === 'content_block_delta' && event.data?.delta?.type === 'input_json_delta') {
    const tb = activeToolBlocks.get(event.data.index);
    if (tb) tb.inputJson += event.data.delta.partial_json || '';
  }
  if (event.eventType === 'content_block_stop') {
    activeToolBlocks.delete(event.data?.index);
  }

  broadcaster.broadcast({
    type: 'sse_event',
    interactionId: interaction.id,
    event,
  });
}

function sendDummyResponse(ctx, { text, model, usage }) {
  const dummyId = `msg_dummy_${generateId()}`;
  const finalModel = model || ctx.body.model;
  const finalUsage = usage || { input_tokens: 0, output_tokens: 0 };

  ctx.interaction.response.status = 200;
  ctx.interaction.timing.ttfb = Date.now() - ctx.interaction.timing.startedAt;
  ctx.interaction.status = 'complete';
  ctx.interaction.usage = finalUsage;

  if (ctx.isStreaming) {
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const sseEvents = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: dummyId, type: 'message', role: 'assistant', content: [], model: finalModel, stop_reason: null, stop_sequence: null, usage: finalUsage } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];
    for (const evt of sseEvents) {
      ctx.res.write(evt);
      const parsed = parseSSEString(evt);
      if (parsed) {
        ctx.interaction.response.sseEvents.push(parsed);
        trackSSEEvent(parsed, ctx.interaction, new Map(), ctx.broadcaster, ctx.interaction.instanceId);
      }
    }
    ctx.res.end();
  } else {
    const responseBody = {
      id: dummyId, type: 'message', role: 'assistant',
      content: [{ type: 'text', text }],
      model: finalModel, stop_reason: 'end_turn', stop_sequence: null,
      usage: finalUsage,
    };
    ctx.interaction.response.body = responseBody;
    ctx.res.writeHead(200, { 'content-type': 'application/json' });
    ctx.res.end(JSON.stringify(responseBody));
  }
}

function createProxyRouter(store, broadcaster, targetUrl) {
  // Rule cache: re-reads manifest on every request (cheap), re-requires JS only when files change
  const _ruleCache = new Map(); // id -> { mtime, fn }

  function getEnabledRules() {
    const manifest = caps.listProxyRules(PROJECT_ROOT);
    const rules = [];
    for (const entry of manifest) {
      if (!entry.enabled) continue;
      const filePath = path.join(PROJECT_ROOT, 'capabilities', 'proxy-rules', `${entry.id}.js`);
      try {
        let cached = _ruleCache.get(entry.id);
        let mtime;
        try { mtime = require('fs').statSync(filePath).mtimeMs; } catch { continue; }
        if (!cached || cached.mtime !== mtime) {
          delete require.cache[require.resolve(filePath)];
          const mod = require(filePath);
          cached = { mtime, fn: mod };
          _ruleCache.set(entry.id, cached);
        }
        rules.push({ ...entry, fn: cached.fn });
      } catch (err) {
        console.error(`[proxy] Failed to load rule ${entry.id}: ${err.message}`);
      }
    }
    return rules;
  }

  // Warm the cache at startup
  const initialRules = getEnabledRules();
  for (const r of initialRules) console.log(`[proxy] Loaded rule: ${r.name} (${r.id})`);

  const router = express.Router();

  router.use(express.json({ limit: '50mb' }));
  router.use(express.raw({ limit: '50mb', type: () => false }));

  // /i/:instanceId prefix: instance-scoped routing
  router.use('/i/:instanceId', (req, res, next) => {
    req.instanceId = decodeURIComponent(req.params.instanceId);
    next();
  });

  // POST /v1/messages - main endpoint
  router.post(['/v1/messages', '/i/:instanceId/v1/messages'], async (req, res) => {
    const body = req.body;
    const isStreaming = !!body.stream;

    const isCliInstance = req.instanceId && req.instanceId.startsWith('cli-');

    // CLI instance settings (for tool filtering etc.)
    let cliSettings = null;
    if (isCliInstance && createProxyRouter._cliSettingsGetter) {
      cliSettings = createProxyRouter._cliSettingsGetter(req.instanceId);
    }

    // --- Tab-level model override (applies before global proxy rules) ---
    const { tabModelDef } = resolveTabModel(body, cliSettings);

    // --- Tab-level "show thinking" (Opus 4.7/4.8 omit thinking text by
    // default; opt in to summarized reasoning so the CLI can render it) ---
    if (cliSettings && cliSettings.showThinking && body.thinking && typeof body.thinking === 'object'
        && body.thinking.type !== 'disabled' && !body.thinking.display) {
      body.thinking.display = 'summarized';
    }

    const instCtx = getInstanceContext(req.instanceId);
    const interaction = {
      id: generateId(),
      timestamp: Date.now(),
      endpoint: '/v1/messages',
      disableAutoMemory: !instCtx?.autoMemory,
      instanceId: req.instanceId || null,
      stepId: instCtx?.stepId || null,
      runId: instCtx?.runId || null,
      request: { ...body },
      response: {
        status: null,
        headers: {},
        body: null,
        sseEvents: [],
      },
      timing: {
        startedAt: Date.now(),
        ttfb: null,
        duration: null,
      },
      usage: null,
      isStreaming,
      status: 'pending',
    };

    // --- Run proxy rules (may return response hooks) ---
    const responseHooks = [];
    for (const rule of getEnabledRules()) {
      try {
        const ctx = {
          body,
          isStreaming,
          instanceId: req.instanceId || null,
          isInternalInstance: !!instCtx,
          req,
          res,
          interaction,
          store,
          broadcaster,
          helpers: { generateId, sendDummyResponse, parseSSEString, trackSSEEvent, enhancedAskTool },
        };
        const result = await rule.fn(ctx);
        if (result === true) {
          interaction.request = { ...body };
          interaction.requestHeaders = filterRequestHeaders(req.headers);
          interaction._showSensitive = createProxyRouter._showSensitiveHeaders || false;
          interaction.timing.duration = Date.now() - interaction.timing.startedAt;
          if (interaction.status === 'pending') interaction.status = 'complete';
          interaction.ruleApplied = rule.id;
          store.add(interaction);
          broadcaster.broadcast({ type: 'interaction:start', interaction: sanitizeForDashboard(interaction) });
          store.save(interaction.id);
          broadcaster.broadcast({ type: 'interaction:complete', interaction: sanitizeForDashboard(interaction) });
          return;
        }
        if (result && typeof result === 'object' && (result.transformSSE || result.transformBody)) {
          responseHooks.push(result);
        }
      } catch (err) {
        console.error(`[proxy] Rule "${rule.name}" (${rule.id}) threw:`, err.message);
      }
    }

    const sseHooks = responseHooks.filter(h => h.transformSSE).map(h => h.transformSSE);
    const bodyHooks = responseHooks.filter(h => h.transformBody).map(h => h.transformBody);

    // Snapshot request after all filtering, then broadcast to dashboard
    interaction.request = { ...body };
    interaction.requestHeaders = filterRequestHeaders(req.headers);
    interaction._showSensitive = createProxyRouter._showSensitiveHeaders || false;
    store.add(interaction);
    broadcaster.broadcast({
      type: 'interaction:start',
      interaction: sanitizeForDashboard(interaction),
    });

    // --- Check for model translation ---
    // Tab-level modelMap override wins; otherwise resolve body.model against the
    // registry so non-CLI callers (app ai.prompt) reach the right provider too.
    const modelDef = tabModelDef || resolveRegistryModel(body.model);
    const provider = modelDef ? getProvider(modelDef.provider) : null;

    if (modelDef && !provider && modelDef.provider !== 'anthropic') {
      console.warn(`[proxy] Unknown provider "${modelDef.provider}" for model "${modelDef.name}" — falling through to Anthropic`);
    }

    // Attach pricing for cost calculation
    const pricingKey = modelDef ? (modelDef.name || modelDef.modelId) : body.model;
    interaction.pricing = getModelPricing(PROJECT_ROOT, pricingKey);

    if (provider && modelDef) {
      // --- Translation path: route through non-Anthropic provider ---
      try {

        const translated = provider.translateRequest(body, modelDef);
        console.log(`[proxy] Translating to ${modelDef.name} (${modelDef.provider}) → ${translated.url}`);

        // Update interaction to reflect what was actually sent
        interaction.request.model = modelDef.label || modelDef.name;
        interaction.request.max_tokens = translated.body.max_tokens ?? translated.body.max_completion_tokens;
        interaction.endpoint = translated.url;
        interaction.translatedFrom = body.model; // preserve original for reference
        // Store translated request for curl export (mask API key)
        interaction.translatedBody = translated.body;
        interaction.translatedHeaders = Object.fromEntries(
          Object.entries(translated.headers).map(([k, v]) =>
            k.toLowerCase() === 'authorization' ? [k, 'Bearer $API_KEY'] : [k, v]
          )
        );
        broadcaster.broadcast({
          type: 'interaction:update',
          interaction: sanitizeForDashboard(interaction),
        });

        const { upstream } = await fetchUpstreamWithRetry(translated.url, {
          method: 'POST',
          headers: translated.headers,
          body: JSON.stringify(translated.body),
        });

        interaction.response.status = upstream.status;
        const upstreamHeaders = filterResponseHeaders(upstream.headers);
        const translatedRequestId = upstreamHeaders['request-id'] || upstreamHeaders['x-request-id'] || interaction.id;
        interaction.response.headers = { ...upstreamHeaders, 'request-id': translatedRequestId };

        // Translation always uses streaming (translateRequest forces stream:true)
        if (upstream.ok) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            'x-accel-buffering': 'no',
            'request-id': translatedRequestId,
          });

          const streamState = provider.createStreamState();
          const activeToolBlocks = new Map();

          // Process OpenAI SSE and translate to Anthropic SSE
          const nodeStream = Readable.fromWeb(upstream.body);
          let buffer = '';

          nodeStream.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete line

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (!data) continue;

                const anthropicEvents = provider.translateSSEChunk(data, streamState);
                for (let eventStr of anthropicEvents) {
                  for (const hook of sseHooks) eventStr = hook(eventStr);
                  res.write(eventStr);
                  const parsed = parseSSEString(eventStr);
                  if (parsed) {
                    interaction.response.sseEvents.push(parsed);
                    trackSSEEvent(parsed, interaction, activeToolBlocks, broadcaster, interaction.instanceId);
                  }
                }
              }
            }
          });

          nodeStream.on('end', () => {
            // Process any remaining buffer
            if (buffer.trim()) {
              const remaining = buffer.trim();
              if (remaining.startsWith('data: ')) {
                const data = remaining.slice(6).trim();
                if (data) {
                  const anthropicEvents = provider.translateSSEChunk(data, streamState);
                  for (let eventStr of anthropicEvents) {
                    for (const hook of sseHooks) eventStr = hook(eventStr);
                    res.write(eventStr);
                    const parsed = parseSSEString(eventStr);
                    if (parsed) {
                      interaction.response.sseEvents.push(parsed);
                      trackSSEEvent(parsed, interaction, activeToolBlocks, broadcaster, interaction.instanceId);
                    }
                  }
                }
              }
            }

            // Safety-net finalization — ensures proper Anthropic SSE termination
            // even if the provider stream ends without explicit signal (e.g. Gemini has no [DONE])
            const finalEvents = provider.finalizeStream(streamState);
            for (let eventStr of finalEvents) {
              for (const hook of sseHooks) eventStr = hook(eventStr);
              res.write(eventStr);
              const parsed = parseSSEString(eventStr);
              if (parsed) {
                interaction.response.sseEvents.push(parsed);
                trackSSEEvent(parsed, interaction, activeToolBlocks, broadcaster, interaction.instanceId);
              }
            }

            if (!interaction.timing.duration) {
              interaction.timing.duration = Date.now() - interaction.timing.startedAt;
            }
            if (interaction.status === 'pending' || interaction.status === 'intercepted') {
              interaction.status = 'complete';
            }
            if (!interaction.response.body && interaction.response.sseEvents?.length) {
              interaction.response.body = InteractionStore._reconstructBodyFromSSE(interaction.response.sseEvents);
            }
            store.save(interaction.id);
            broadcaster.broadcast({
              type: 'interaction:complete',
              interaction: sanitizeForDashboard(interaction),
            });
            res.end();
          });

          nodeStream.on('error', (err) => {
            console.error('Translation stream error:', err.message);
            interaction.status = 'error';
            interaction.response.error = err.message;
            interaction.timing.duration = Date.now() - interaction.timing.startedAt;
            store.save(interaction.id);
            broadcaster.broadcast({
              type: 'interaction:error',
              interactionId: interaction.id,
              error: err.message,
            });
            if (!res.writableEnded) res.end();
          });
        } else {
          // Non-streaming or error from translated provider
          const responseBody = await upstream.text();
          interaction.timing.ttfb = Date.now() - interaction.timing.startedAt;
          interaction.timing.duration = Date.now() - interaction.timing.startedAt;
          interaction.status = upstream.ok ? 'complete' : 'error';

          // For errors from translated provider, wrap in Anthropic error format
          if (!upstream.ok) {
            const errorBody = {
              type: 'error',
              error: { type: 'api_error', message: `Provider ${modelDef.name} error (${upstream.status}): ${responseBody.slice(0, 500)}` },
            };
            interaction.response.body = errorBody;
            res.writeHead(upstream.status, { 'content-type': 'application/json', 'request-id': translatedRequestId });
            res.end(JSON.stringify(errorBody));
          } else {
            // Non-streaming success — translate response body
            try { interaction.response.body = JSON.parse(responseBody); }
            catch { interaction.response.body = responseBody; }
            res.writeHead(200, { 'content-type': 'application/json', 'request-id': translatedRequestId });
            res.end(responseBody);
          }

          store.save(interaction.id);
          broadcaster.broadcast({
            type: 'interaction:complete',
            interaction: sanitizeForDashboard(interaction),
          });
        }
      } catch (err) {
        console.error('Translation proxy error:', err.message);
        interaction.timing.duration = Date.now() - interaction.timing.startedAt;
        interaction.status = 'error';
        interaction.response.error = err.message;
        sendProxyError(res, err);
        store.save(interaction.id);
        broadcaster.broadcast({
          type: 'interaction:error',
          interactionId: interaction.id,
          error: err.message,
        });
      }
    } else {
    // --- Standard Anthropic passthrough ---
    try {
      const { upstream, firstChunk, reader } = await fetchUpstreamWithRetry(
        `${targetUrl}/v1/messages`,
        {
          method: 'POST',
          headers: filterRequestHeaders(req.headers),
          body: JSON.stringify(body),
        },
        { bufferFirstChunk: isStreaming }
      );

      interaction.response.status = upstream.status;
      interaction.response.headers = filterResponseHeaders(upstream.headers);

      if (isStreaming && upstream.ok) {
        const responseHeaders = {
          ...filterResponseHeaders(upstream.headers),
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
        };
        if (!responseHeaders['content-type']) {
          responseHeaders['content-type'] = 'text/event-stream';
        }

        res.writeHead(upstream.status, responseHeaders);

        const activeToolBlocks = new Map();

        const passthrough = new SSEPassthrough((event) => {
          interaction.response.sseEvents.push(event);
          trackSSEEvent(event, interaction, activeToolBlocks, broadcaster, interaction.instanceId);
        });

        const nodeStream = reader
          ? Readable.from(resumeWebStream(firstChunk, reader))
          : Readable.fromWeb(upstream.body);

        const ruleTransform = sseHooks.length > 0 ? new RuleResponseTransform(sseHooks) : null;
        const pipelineArgs = ruleTransform
          ? [nodeStream, ruleTransform, passthrough, res]
          : [nodeStream, passthrough, res];

        pipeline(...pipelineArgs, (err) => {
          if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error('Stream pipeline error:', err.message);
            interaction.status = 'error';
            interaction.response.error = err.message;
            broadcaster.broadcast({
              type: 'interaction:error',
              interactionId: interaction.id,
              error: err.message,
            });
          }
          if (!interaction.timing.duration) {
            interaction.timing.duration = Date.now() - interaction.timing.startedAt;
          }
          if (interaction.status === 'pending' || interaction.status === 'intercepted') {
            interaction.status = 'complete';
          }
          if (!interaction.response.body && interaction.response.sseEvents?.length) {
            interaction.response.body = InteractionStore._reconstructBodyFromSSE(interaction.response.sseEvents);
          }
          store.save(interaction.id);
          broadcaster.broadcast({
            type: 'interaction:complete',
            interaction: sanitizeForDashboard(interaction),
          });
        });
      } else {
        // Non-streaming response (or error response)
        const responseBody = await upstream.text();
        interaction.timing.ttfb = Date.now() - interaction.timing.startedAt;
        interaction.timing.duration = Date.now() - interaction.timing.startedAt;

        try {
          interaction.response.body = JSON.parse(responseBody);
          if (interaction.response.body.usage) {
            interaction.usage = interaction.response.body.usage;
          }
          for (const hook of bodyHooks) {
            interaction.response.body = hook(interaction.response.body);
          }
        } catch {
          interaction.response.body = responseBody;
        }

        interaction.status = upstream.ok ? 'complete' : 'error';

        // Send rule-transformed body if parsed, otherwise original
        const finalBody = interaction.response.body && typeof interaction.response.body === 'object'
          ? JSON.stringify(interaction.response.body)
          : responseBody;

        const responseHeaders = filterResponseHeaders(upstream.headers);
        if (!responseHeaders['content-type']) {
          responseHeaders['content-type'] = 'application/json';
        }
        res.writeHead(upstream.status, responseHeaders);
        res.end(finalBody);

        store.save(interaction.id);
        broadcaster.broadcast({
          type: 'interaction:complete',
          interaction: sanitizeForDashboard(interaction),
        });
      }
    } catch (err) {
      console.error('Upstream fetch error:', err.message);
      interaction.timing.duration = Date.now() - interaction.timing.startedAt;
      interaction.status = 'error';
      interaction.response.error = err.message;

      sendProxyError(res, err);

      store.save(interaction.id);
      broadcaster.broadcast({
        type: 'interaction:error',
        interactionId: interaction.id,
        error: err.message,
      });
    }
    } // end standard Anthropic passthrough
  });

  // POST /v1/messages/count_tokens
  router.post(['/v1/messages/count_tokens', '/i/:instanceId/v1/messages/count_tokens'], async (req, res) => {
    const body = req.body;

    // Honor the same tab-level model override as /v1/messages so a remapped
    // model is never sent to Anthropic's count_tokens with an unknown id.
    const isCliInstance = req.instanceId && req.instanceId.startsWith('cli-');
    let cliSettings = null;
    if (isCliInstance && createProxyRouter._cliSettingsGetter) {
      cliSettings = createProxyRouter._cliSettingsGetter(req.instanceId);
    }
    const tabModelDef = resolveTabModel(body, cliSettings).tabModelDef || resolveRegistryModel(body.model);

    // Apply proxy rules (tool filtering, etc.)
    for (const rule of getEnabledRules()) {
      try {
        const ctx = {
          body, isStreaming: false,
          instanceId: req.instanceId || null,
          isInternalInstance: !!getInstanceContext(req.instanceId),
          req, res,
          interaction: null, store, broadcaster,
          helpers: { generateId, sendDummyResponse, parseSSEString, trackSSEEvent, enhancedAskTool },
        };
        if (await rule.fn(ctx) === true) {
          res.json({ input_tokens: 0 });
          return;
        }
      } catch (err) {
        console.error(`[proxy] Rule "${rule.name}" (${rule.id}) threw on count_tokens:`, err.message);
      }
    }

    const interaction = {
      id: generateId(),
      timestamp: Date.now(),
      endpoint: '/v1/messages/count_tokens',
      instanceId: req.instanceId || null,
      request: { ...body },
      response: { status: null, headers: {}, body: null, sseEvents: [] },
      timing: { startedAt: Date.now(), ttfb: null, duration: null },
      usage: null,
      isStreaming: false,
      status: 'pending',
    };

    store.add(interaction);
    broadcaster.broadcast({
      type: 'interaction:start',
      interaction: sanitizeForDashboard(interaction),
    });

    // Non-Anthropic tab model: Anthropic's count_tokens can't price it and the
    // providers expose no token-count endpoint, so return a local estimate
    // instead of querying upstream with a foreign model id.
    if (tabModelDef && getProvider(tabModelDef.provider) && tabModelDef.provider !== 'anthropic') {
      const input_tokens = estimateInputTokens(body);
      interaction.timing.duration = Date.now() - interaction.timing.startedAt;
      interaction.response.status = 200;
      interaction.response.body = { input_tokens };
      interaction.status = 'complete';
      res.json({ input_tokens });
      store.save(interaction.id);
      broadcaster.broadcast({
        type: 'interaction:complete',
        interaction: sanitizeForDashboard(interaction),
      });
      return;
    }

    try {
      const { upstream } = await fetchUpstreamWithRetry(`${targetUrl}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: filterRequestHeaders(req.headers),
        body: JSON.stringify(body),
      });

      const responseBody = await upstream.text();
      interaction.timing.ttfb = Date.now() - interaction.timing.startedAt;
      interaction.timing.duration = Date.now() - interaction.timing.startedAt;
      const responseHeaders = filterResponseHeaders(upstream.headers);
      interaction.response.status = upstream.status;
      interaction.response.headers = responseHeaders;

      try {
        interaction.response.body = JSON.parse(responseBody);
      } catch {
        interaction.response.body = responseBody;
      }

      interaction.status = upstream.ok ? 'complete' : 'error';

      res.writeHead(upstream.status, responseHeaders);
      res.end(responseBody);

      store.save(interaction.id);
      broadcaster.broadcast({
        type: 'interaction:complete',
        interaction: sanitizeForDashboard(interaction),
      });
    } catch (err) {
      interaction.timing.duration = Date.now() - interaction.timing.startedAt;
      interaction.status = 'error';
      interaction.response.error = err.message;

      sendProxyError(res, err);

      store.save(interaction.id);
    }
  });

  // Catch-all: forward unknown paths transparently
  router.all('*', async (req, res) => {
    try {
      const headers = filterRequestHeaders(req.headers);
      const fetchOpts = {
        method: req.method,
        headers,
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        fetchOpts.body = JSON.stringify(req.body);
      }
      const upstream = await fetch(`${targetUrl}${req.path}`, fetchOpts);
      const body = await upstream.arrayBuffer();
      const responseHeaders = filterResponseHeaders(upstream.headers);
      res.writeHead(upstream.status, responseHeaders);
      res.end(Buffer.from(body));
    } catch (err) {
      sendProxyError(res, err);
    }
  });

  return router;
}

/** Reject and remove all pending questions associated with a given tabId */
function clearPendingQuestionsForTab(tabId) {
  for (const [toolUseId, pending] of pendingQuestions) {
    if (pending.ctx?.tabId === tabId) {
      if (pending.reject) pending.reject(new Error('Chat stopped'));
      pendingQuestions.delete(toolUseId);
    }
  }
}

createProxyRouter._cliSettingsGetter = null;
createProxyRouter._showSensitiveHeaders = false;

module.exports = createProxyRouter;
module.exports.pendingQuestions = pendingQuestions;
module.exports.clearPendingQuestionsForTab = clearPendingQuestionsForTab;
