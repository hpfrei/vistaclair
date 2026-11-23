// Decodes agy's Cloud Code model calls into Anthropic-shaped Inspector
// interactions (docs/agy-inspector.md). Pure decoding (decodeAgyRequest,
// AgyResponseDecoder) plus AgyExchange, the tee sink that builds, stores and
// broadcasts one interaction per streamGenerateContent / generateContent call.
//
// Nothing here sees a header value other than content-type, content-encoding
// and user-agent (agy-h1-tee.js keeps only those).
const crypto = require('crypto');
const zlib = require('zlib');
const GeminiProvider = require('./providers/gemini');
const { generateId, sanitizeForDashboard } = require('./utils');
const InteractionStore = require('./store');

const gemini = new GeminiProvider();
const IMAGE_INLINE_MAX = 4096;          // inlineData above this becomes a placeholder
const BODY_CAP = 50 * 1024 * 1024;      // per message, decoded
const { agyPricing, defaultLookup, ZERO_PRICING } = require('./agy-pricing');

const TRACED_PATHS = new Set(['/v1internal:streamGenerateContent', '/v1internal:generateContent']);
const HOOK_PATHS = new Set(['/v1internal:loadCodeAssist', '/v1internal:retrieveUserQuotaSummary']);

function pathOnly(p) { return String(p || '').split('?')[0]; }

/** 'trace' | 'hook' | null for a request path on a Cloud Code host. */
function classifyPath(p) {
  const base = pathOnly(p);
  if (TRACED_PATHS.has(base)) return 'trace';
  if (HOOK_PATHS.has(base)) return 'hook';
  return null;
}

function _imagePlaceholder(inline) {
  const data = typeof inline?.data === 'string' ? inline.data : '';
  const bytes = Buffer.from(data, 'base64');
  const mt = inline?.mimeType || 'application/octet-stream';
  if (bytes.length <= IMAGE_INLINE_MAX) {
    return { type: 'image', source: { type: 'base64', media_type: mt, data } };
  }
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  return { type: 'image', placeholder: `${mt}, ${bytes.length} bytes, sha256:${sha}` };
}

function _toolResultContent(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  // agy wraps results as { output } / { result } / { error }; keep them as text.
  if (typeof resp.output === 'string' && Object.keys(resp).length === 1) return resp.output;
  return JSON.stringify(resp);
}

/**
 * The v1internal envelope → an Anthropic Messages body.
 * @returns {{ body: object, extras: object, conversationId: string|null, requestType: string|null }}
 */
function decodeAgyRequest(envelope) {
  const env = envelope && typeof envelope === 'object' ? envelope : {};
  const req = env.request && typeof env.request === 'object' ? env.request : {};
  const body = { model: env.model || req.model || 'agy' };

  const sysParts = req.systemInstruction?.parts || [];
  const system = sysParts.filter(p => typeof p?.text === 'string').map(p => ({ type: 'text', text: p.text }));
  if (system.length) body.system = system;

  const tools = [];
  for (const t of req.tools || []) {
    for (const fd of t?.functionDeclarations || []) {
      tools.push({ name: fd.name, description: fd.description || '', input_schema: fd.parameters || fd.parametersJsonSchema || { type: 'object' } });
    }
    for (const k of Object.keys(t || {})) {
      if (k !== 'functionDeclarations') tools.push({ name: k, type: k });
    }
  }
  if (tools.length) body.tools = tools;

  const messages = [];
  const openCalls = new Map();   // function name → [tool_use ids not answered yet]
  (req.contents || []).forEach((turn, ti) => {
    // agy sends the tool results under role 'model'; in the Anthropic shape they
    // are a user turn, so a turn of only functionResponse parts is 'user'.
    const parts0 = turn?.parts || [];
    const onlyResults = parts0.length > 0 && parts0.every(p => p && p.functionResponse);
    const role = turn?.role === 'model' && !onlyResults ? 'assistant' : 'user';
    const content = [];
    (turn?.parts || []).forEach((part, pi) => {
      if (!part || typeof part !== 'object') return;
      if (part.thought && typeof part.text === 'string') {
        content.push({ type: 'thinking', thinking: part.text });
      } else if (typeof part.text === 'string') {
        content.push({ type: 'text', text: part.text });
      } else if (part.functionCall) {
        const fc = part.functionCall;
        const id = fc.id || `${fc.name}-${ti}-${pi}`;
        if (!openCalls.has(fc.name)) openCalls.set(fc.name, []);
        openCalls.get(fc.name).push(id);
        content.push({ type: 'tool_use', id, name: fc.name, input: fc.args || {} });
      } else if (part.functionResponse) {
        const fr = part.functionResponse;
        let id = fr.id;
        const queue = openCalls.get(fr.name) || [];
        if (id) { const at = queue.indexOf(id); if (at !== -1) queue.splice(at, 1); }
        else id = queue.shift() || `${fr.name}-${ti}-${pi}`;
        const r = fr.response;
        const block = { type: 'tool_result', tool_use_id: id, content: _toolResultContent(r) };
        if (r && typeof r === 'object' && r.error != null) block.is_error = true;
        content.push(block);
      } else if (part.inlineData) {
        content.push(_imagePlaceholder(part.inlineData));
      } else if (part.fileData) {
        content.push({ type: 'text', text: `[file ${part.fileData.mimeType || ''} ${part.fileData.fileUri || ''}]` });
      } else if (part.executableCode || part.codeExecutionResult) {
        content.push({ type: 'text', text: JSON.stringify(part).slice(0, 10000) });
      }
      // thoughtSignature-only parts carry nothing readable.
    });
    if (content.length) messages.push({ role, content });
  });
  body.messages = messages;
  // generationConfig: the Anthropic-named fields the renderer knows, the
  // thinking config as `thinking`, anything else under `generationConfig`.
  const { maxOutputTokens, temperature, thinkingConfig, ...genRest } = req.generationConfig || {};
  if (maxOutputTokens) body.max_tokens = maxOutputTokens;
  if (temperature !== undefined) body.temperature = temperature;
  if (thinkingConfig && typeof thinkingConfig === 'object') body.thinking = thinkingConfig;
  if (Object.keys(genRest).length) body.generationConfig = genRest;
  // Cloud Code's own envelope fields, shown under "Other" (never the project).
  const agyInfo = {};
  if (env.requestType) agyInfo.requestType = env.requestType;
  if (env.requestId) agyInfo.requestId = env.requestId;
  if (req.sessionId) agyInfo.sessionId = req.sessionId;
  if (req.labels && Object.keys(req.labels).length) agyInfo.labels = req.labels;
  if (env.userAgent) agyInfo.userAgent = env.userAgent;
  if (Object.keys(agyInfo).length) body.agy = agyInfo;

  const { contents, systemInstruction, tools: _t, ...restReq } = req;
  const { request: _r, ...restEnv } = env;
  const extras = { ...restEnv, request: restReq };

  const m = /^[a-z_]+\/([0-9a-f-]{8,})\//i.exec(env.requestId || '');
  return { body, extras, conversationId: m ? m[1] : null, requestType: env.requestType || null };
}

/**
 * A Cloud Code call that is not an agent turn: a requestType other than
 * agent / image_gen, a non-streaming generateContent, or a request without
 * tools (every agent turn carries agy's tool set).
 */
function isSideCall(dec, isStreaming) {
  const t = dec.requestType;
  if (t === 'image_gen') return false;
  if (t && t !== 'agent') return true;
  if (!isStreaming) return true;
  return !(dec.body.tools && dec.body.tools.length);
}

function _parseSSEString(evt) {
  let eventType = null, dataStr = null;
  for (const line of evt.split('\n')) {
    if (line.startsWith('event: ')) eventType = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataStr = line.slice(6);
  }
  if (!eventType || dataStr == null) return null;
  try { return { eventType, data: JSON.parse(dataStr) }; } catch { return { eventType, data: dataStr }; }
}

/**
 * Cloud Code response bytes (decoded text) → Anthropic SSE events.
 * push(text) / end() return the new events ({eventType, data}).
 */
class AgyResponseDecoder {
  constructor({ sse = true } = {}) {
    this.sse = sse;
    this.ss = gemini.createStreamState({ keepThoughts: true, cacheTokens: true });
    this.pending = '';
    this.meta = {};
    this.lastToolUse = null;      // { name, input } of the last functionCall seen
    this.jsonText = '';
  }

  _translate(obj) {
    if (!obj || typeof obj !== 'object') return [];
    if (obj.traceId) this.meta.traceId = obj.traceId;
    const inner = obj.response && typeof obj.response === 'object' ? obj.response : obj;
    if (inner.responseId) this.meta.responseId = inner.responseId;
    if (inner.modelVersion) this.meta.modelVersion = inner.modelVersion;
    // Google's own counts, as sent (the last chunk is the running total).
    if (inner.usageMetadata && typeof inner.usageMetadata === 'object') this.meta.usageMetadata = inner.usageMetadata;
    // The closing chunk carries an empty text part (often with the thought
    // signature): it would render as an empty text block.
    const cparts = inner.candidates?.[0]?.content?.parts;
    if (Array.isArray(cparts)) inner.candidates[0].content.parts = cparts.filter(p => !(p && p.text === '' && !p.thought && !p.functionCall));
    for (const p of inner.candidates?.[0]?.content?.parts || []) {
      if (p?.functionCall) this.lastToolUse = { name: p.functionCall.name, input: p.functionCall.args || {} };
      if (p?.inlineData && typeof p.inlineData.data === 'string' && Buffer.byteLength(p.inlineData.data) > IMAGE_INLINE_MAX) {
        p.inlineData = { mimeType: p.inlineData.mimeType, data: '' };
      }
    }
    return gemini.translateSSEChunk(inner, this.ss).map(_parseSSEString).filter(Boolean);
  }

  push(text) {
    if (!this.sse) { this.jsonText += text; return []; }
    this.pending += text;
    const out = [];
    let nl;
    while ((nl = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, nl).replace(/\r$/, '');
      this.pending = this.pending.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trimStart();
      let obj;
      try { obj = JSON.parse(data); } catch { continue; }
      out.push(...this._translate(obj));
    }
    return out;
  }

  end() {
    const out = [];
    if (!this.sse) {
      let obj = null;
      try { obj = JSON.parse(this.jsonText); } catch {}
      if (Array.isArray(obj)) for (const o of obj) out.push(...this._translate(o));
      else if (obj) out.push(...this._translate(obj));
    } else if (this.pending.trim()) {
      out.push(...this.push('\n'));
    }
    out.push(...gemini.finalizeStream(this.ss).map(_parseSSEString).filter(Boolean));
    return out;
  }

  usage() {
    return {
      input_tokens: this.ss.inputTokens || 0,
      output_tokens: this.ss.outputTokens || 0,
      cache_read_input_tokens: this.ss.cacheReadTokens || 0,
      ...(this.ss.reasoningTokens ? { reasoning_tokens: this.ss.reasoningTokens } : {}),
    };
  }
}

/** A streaming decompressor for a content-encoding, or null for identity. */
function _decoderFor(encoding) {
  const e = String(encoding || '').toLowerCase().trim();
  if (!e || e === 'identity') return null;
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  return 'unsupported';
}

/** Collects a (possibly content-encoded) body up to BODY_CAP, off the data path. */
class BodyReader {
  constructor(encoding, { onText, onDone, cap = BODY_CAP }) {
    this.onText = onText || null;
    this.onDone = onDone;
    this.cap = cap;
    this.size = 0;
    this.truncated = false;
    this.error = null;
    this.chunks = [];
    this.done = false;
    this.decoder = _decoderFor(encoding);
    if (this.decoder === 'unsupported') { this.error = `content-encoding ${encoding} not decoded`; this.decoder = null; this.skip = true; }
    if (this.decoder) {
      this.textDecoder = new TextDecoder('utf-8');
      this.decoder.on('data', d => this._plain(d));
      this.decoder.on('error', err => { this.error = `decompress: ${err.code || 'error'}`; this._finish(); });
      this.decoder.on('end', () => this._finish());
    } else {
      this.textDecoder = new TextDecoder('utf-8');
    }
  }

  _plain(d) {
    if (this.truncated || this.done) return;
    if (this.size + d.length > this.cap) {
      d = d.subarray(0, this.cap - this.size);
      this.truncated = true;
    }
    this.size += d.length;
    if (this.onText) this.onText(this.textDecoder.decode(d, { stream: true }));
    else this.chunks.push(Buffer.from(d));
  }

  write(buf) {
    if (this.done || this.skip) return;
    // Copies: the relay may still hold `buf`; decoding never touches it.
    if (this.decoder) { if (!this.truncated) this.decoder.write(Buffer.from(buf)); }
    else this._plain(buf);
  }

  end() {
    if (this.done) return;
    if (this.decoder) this.decoder.end();
    else this._finish();
  }

  _finish() {
    if (this.done) return;
    this.done = true;
    if (this.onText) { const tail = this.textDecoder.decode(); if (tail) this.onText(tail); }
    this.onDone(this.onText ? null : Buffer.concat(this.chunks));
  }
}

const SCRUB_KEYS = /privacy|uri$|url$|project|email|token|notice|credential|secret/i;
/** A Cloud Code control response, safe to store: account and privacy fields dropped, long strings clipped. */
function scrubControl(v, depth = 0) {
  if (depth > 8) return null;
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => scrubControl(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!SCRUB_KEYS.test(k)) o[k] = scrubControl(x, depth + 1);
    return o;
  }
  return v;
}

function _json(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

/**
 * The tee sink for one Cloud Code request on a tagged connection.
 * ctx: { store, broadcaster, instanceId, host, lanes, hook(path, json, status) }
 * lanes: { main: convId|null, pendingType: string|null } shared per tag.
 */
class AgyExchange {
  constructor(ctx, req) {
    this.ctx = ctx;
    this.path = pathOnly(req.path);
    this.kind = classifyPath(req.path);
    this.reqHeaders = {};
    for (const k of ['content-type', 'user-agent']) if (req.headers[k]) this.reqHeaders[k] = req.headers[k];
    this.reqEncoding = req.headers['content-encoding'];
    this.startedAt = Date.now();
    this.interaction = null;
    this.ended = false;
    this.reqBody = null;
    this.resStatus = null;
    this.reqReader = this.kind === 'trace'
      ? new BodyReader(this.reqEncoding, { onDone: b => { this.reqBody = b; this._requestReady(); } })
      : null;
  }

  requestBody(buf) { if (this.reqReader) this.reqReader.write(buf); }
  requestEnd() { if (this.reqReader) this.reqReader.end(); }

  _requestReady() {
    const env = _json(this.reqBody || Buffer.alloc(0));
    this.reqBody = null;
    if (!env) { this.badRequest = true; return; }
    const dec = decodeAgyRequest(env);
    const { store, broadcaster, instanceId, lanes } = this.ctx;
    const it = {
      id: generateId(),
      timestamp: this.startedAt,
      endpoint: `https://${this.ctx.host}${this.path}`,
      instanceId,
      request: dec.body,
      requestHeaders: this.reqHeaders,
      translatedFrom: 'agy',
      translatedBody: dec.extras,
      provider: 'agy',
      credential: 'agy-subscription',
      response: { status: null, headers: {}, body: null, sseEvents: [] },
      timing: { startedAt: this.startedAt, ttfb: null, duration: null },
      usage: null,
      isStreaming: this.path.endsWith('streamGenerateContent'),
      status: 'pending',
      // The API-equivalent list price of the requested model (agy-pricing.js);
      // the billed amount is $0. A model with no catalog entry stays at $0.
      pricing: agyPricing(dec.body.model, this.ctx.getPricing || (this.ctx.getPricing = defaultLookup())),
    };
    if (env.requestId) it.agyRequestId = env.requestId;
    // Side calls: agy's own helper requests (the per-tool safety monitor on a
    // flash-lite tier, summaries…) ride the same connection but are not the
    // agent's turns: they get their own lane and never name the main one.
    const side = isSideCall(dec, it.isStreaming);
    it.agy = { requestType: dec.requestType, ...(side ? { side: true } : {}) };
    if (side) {
      it.subagent = { agentId: 'agy-side', agentType: 'agy-side-call', description: `side call (${dec.requestType || 'no requestType'}) · ${dec.body.model}` };
    }
    // Lanes: the first conversation of a tag is its main lane unless B2 named it.
    const conv = dec.conversationId;
    if (lanes && conv && !side) {
      if (!lanes.main) lanes.main = conv;
      if (conv !== lanes.main) {
        if (!lanes.types.has(conv)) lanes.types.set(conv, lanes.pendingType || 'agy-subagent');
        it.subagent = { agentId: 'agy-' + conv.slice(0, 8), agentType: lanes.types.get(conv) };
        if (dec.requestType === 'image_gen') it.subagent.description = 'image';
      }
    }
    this.interaction = it;
    this._activeTools = new Map();
    if (this._queued) { const q = this._queued; this._queued = null; this._applyHead(q); }
    store.add(it);
    store.save(it.id);
    broadcaster.broadcast({ type: 'interaction:start', interaction: sanitizeForDashboard(it) });
    if (this._bufferedText) { const t = this._bufferedText; this._bufferedText = ''; this._text(t); }
    if (this._endPending) this._finish();
  }

  responseHead(status, headers) {
    this.resStatus = status;
    this.resHeaders = {};
    for (const k of ['content-type', 'content-encoding']) if (headers[k]) this.resHeaders[k] = headers[k];
    const isSSE = /event-stream/i.test(headers['content-type'] || '');
    this.decoder = new AgyResponseDecoder({ sse: isSSE && status >= 200 && status < 300 });
    const wantBody = this.kind === 'trace' || (this.kind === 'hook') || status >= 300;
    this.errorText = [];
    this.resReader = wantBody ? new BodyReader(headers['content-encoding'], {
      onText: (this.kind === 'trace' && status >= 200 && status < 300) ? (t => this._text(t)) : null,
      onDone: buf => this._resDone(buf),
      cap: this.kind === 'trace' ? BODY_CAP : 4 * 1024 * 1024,
    }) : null;
    const head = { status, at: Date.now() };
    if (this.interaction) this._applyHead(head); else this._queued = head;
  }

  _applyHead({ status, at }) {
    const it = this.interaction;
    it.response.status = status;
    it.response.headers = { ...this.resHeaders };
    it.timing.ttfb = at - it.timing.startedAt;
  }

  responseBody(buf) { if (this.resReader) this.resReader.write(buf); }
  responseEnd() { if (this.resReader) this.resReader.end(); else this._resDone(null); }

  _text(t) {
    if (!this.interaction) { this._bufferedText = (this._bufferedText || '') + t; return; }
    this._events(this.decoder.push(t));
  }

  _events(events) {
    const it = this.interaction;
    const { broadcaster } = this.ctx;
    for (const ev of events) {
      it.response.sseEvents.push(ev);
      if (ev.eventType === 'message_delta' && ev.data?.usage) it.usage = { ...it.usage, ...ev.data.usage };
      broadcaster.broadcast({ type: 'sse_event', interactionId: it.id, instanceId: it.instanceId, event: ev });
    }
  }

  _resDone(buf) {
    this.resBuf = buf;
    this.resError = this.resReader?.error || null;
    this.truncated = !!this.resReader?.truncated;
    this.ended = true;
    if (this.kind === 'hook' || (this.kind === 'trace' && this.resStatus >= 300)) {
      const json = buf ? _json(buf) : null;
      if (json && this.ctx.hook) { try { this.ctx.hook(this.path, json, this.resStatus); } catch {} }
    }
    if (this.kind === 'hook') { try { this._recordControl(buf); } catch {} return; }
    if (this.kind !== 'trace') return;
    if (!this.interaction) { if (this.badRequest) return; this._endPending = true; return; }
    this._finish();
  }

  /**
   * loadCodeAssist / retrieveUserQuotaSummary: not model calls, but kept
   * visible in their own lane (`agy.control`). Only the scrubbed response is
   * stored; an answer identical to the tag's last one for that call is not
   * stored again (agy repeats them on every start).
   */
  _recordControl(buf) {
    const { store, broadcaster, instanceId, lanes } = this.ctx;
    const ok = this.resStatus >= 200 && this.resStatus < 300;
    const json = buf ? _json(buf) : null;
    const name = this.path.split(':').pop();
    const shown = json ? scrubControl(json) : (buf ? buf.toString('utf8').slice(0, 2000) : null);
    const text = typeof shown === 'string' ? shown : JSON.stringify(shown, null, 2);
    if (lanes) {
      lanes.control = lanes.control || new Map();
      const sig = `${this.resStatus}:${text}`;
      if (lanes.control.get(name) === sig) return;
      lanes.control.set(name, sig);
    }
    const now = Date.now();
    const it = {
      id: generateId(),
      timestamp: this.startedAt,
      endpoint: `https://${this.ctx.host}${this.path}`,
      instanceId,
      request: { model: name, messages: [] },
      requestHeaders: this.reqHeaders,
      translatedFrom: 'agy',
      provider: 'agy',
      credential: 'agy-subscription',
      response: {
        status: this.resStatus, headers: { ...this.resHeaders },
        body: { type: 'message', role: 'assistant', model: name, content: [{ type: 'text', text: text || '' }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } },
        sseEvents: [],
        ...(ok ? {} : { error: (json && json.error && json.error.message) || `HTTP ${this.resStatus}` }),
      },
      timing: { startedAt: this.startedAt, ttfb: null, duration: now - this.startedAt },
      usage: null,
      isStreaming: false,
      status: ok ? 'complete' : 'error',
      pricing: { ...ZERO_PRICING },
      agy: { requestType: name, control: true },
      subagent: { agentId: 'agy-cloudcode', agentType: 'agy-cloudcode', description: `Cloud Code ${name} (not a model call)` },
    };
    store.add(it);
    store.save(it.id);
    broadcaster.broadcast({ type: ok ? 'interaction:complete' : 'interaction:error', interaction: sanitizeForDashboard(it), interactionId: it.id, instanceId, error: it.response.error });
  }

  _finish() {
    const it = this.interaction;
    if (!it || this._finished) return;
    if (!this.ended) { this._endPending = true; return; }
    this._finished = true;
    const { store, broadcaster } = this.ctx;
    const ok = this.resStatus >= 200 && this.resStatus < 300;
    if (ok) {
      if (!this.decoder.sse && this.resBuf) this.decoder.push(this.resBuf.toString('utf8'));
      this._events(this.decoder.end());
      it.usage = this.decoder.usage();
      it.response.meta = { ...this.decoder.meta };
      if (it.response.sseEvents.length) {
        it.response.body = InteractionStore._reconstructBodyFromSSE(it.response.sseEvents);
        if (it.response.body) {
          it.response.body.usage = it.usage;
          const md = it.response.sseEvents.filter(e => e.eventType === 'message_delta').pop();
          if (md?.data?.delta?.stop_reason) it.response.body.stop_reason = md.data.delta.stop_reason;
          // The requested model stays the call's model; Google's modelVersion
          // (what served it) is a separate detail, never a replacement.
          it.response.body.model = it.request.model;
          const served = this.decoder.meta.modelVersion;
          if (served && served !== it.request.model && it.agy) it.agy.servedAs = served;
        }
      }
      if (this.ctx.lanes && this.decoder.lastToolUse?.name === 'invoke_subagent') {
        this.ctx.lanes.pendingType = this.decoder.lastToolUse.input?.TypeName || 'agy-subagent';
      }
    } else {
      const json = this.resBuf ? _json(this.resBuf) : null;
      it.response.body = json ?? (this.resBuf ? this.resBuf.toString('utf8').slice(0, 20000) : null);
      it.response.error = json?.error?.message || `HTTP ${this.resStatus}`;
    }
    if (this.truncated) it.response.error = 'body over 50 MB: the trace is truncated';
    if (this.resError) it.response.error = this.resError;
    it.timing.duration = Date.now() - it.timing.startedAt;
    it.status = ok && !this.resError ? 'complete' : 'error';
    store.save(it.id);
    if (it.status === 'complete') broadcaster.broadcast({ type: 'interaction:complete', interaction: sanitizeForDashboard(it) });
    else broadcaster.broadcast({ type: 'interaction:error', interactionId: it.id, instanceId: it.instanceId, error: it.response.error, interaction: sanitizeForDashboard(it) });
  }

  aborted(reason) {
    if (this._finished) return;
    const it = this.interaction;
    if (!it) return;
    this._finished = true;
    it.status = 'error';
    it.response.error = reason;
    it.timing.duration = Date.now() - it.timing.startedAt;
    if (it.response.sseEvents.length && !it.response.body) {
      it.response.body = InteractionStore._reconstructBodyFromSSE(it.response.sseEvents);
    }
    if (this.decoder) it.usage = this.decoder.usage();
    this.ctx.store.save(it.id);
    this.ctx.broadcaster.broadcast({ type: 'interaction:error', interactionId: it.id, instanceId: it.instanceId, error: reason, interaction: sanitizeForDashboard(it) });
  }
}

module.exports = {
  decodeAgyRequest, isSideCall, scrubControl, AgyResponseDecoder, AgyExchange, BodyReader, classifyPath,
  ZERO_PRICING, TRACED_PATHS, HOOK_PATHS, IMAGE_INLINE_MAX,
};
