// ============================================================
// Google Gemini native provider adapter
// Uses the Gemini REST API (not the OpenAI-compatible endpoint)
// ============================================================

const BaseProvider = require('./base');

// Anthropic server-side tool names (CLI + API formats)
const ANTHROPIC_TOOL_NAMES = new Set(['WebSearch', 'web_search', 'WebFetch', 'web_fetch']);

// Server-side cache for Gemini 3 thought signatures.
// Claude Code doesn't preserve unknown fields on content blocks, so we store
// them here keyed by tool_use ID and re-attach when building the next request.
const _thoughtSignatures = new Map();
const SIGNATURE_MAX_AGE = 24 * 60 * 60 * 1000; // 24h TTL

function _storeSignature(toolId, signature) {
  _thoughtSignatures.set(toolId, { sig: signature, ts: Date.now() });
  // Prune old entries if map grows large
  if (_thoughtSignatures.size > 500) {
    const now = Date.now();
    for (const [id, entry] of _thoughtSignatures) {
      if (now - entry.ts > SIGNATURE_MAX_AGE) _thoughtSignatures.delete(id);
    }
  }
}

function _getSignature(toolId) {
  const entry = _thoughtSignatures.get(toolId);
  if (!entry) return null;
  if (Date.now() - entry.ts > SIGNATURE_MAX_AGE) { _thoughtSignatures.delete(toolId); return null; }
  return entry.sig;
}

class GeminiProvider extends BaseProvider {

  // --- Request translation (Anthropic → Gemini) ---

  translateRequest(body, modelDef) {
    // Track tool_use id → name so tool_results can include the function name
    const toolNameMap = {};

    // Convert messages to Gemini contents
    const contents = [];
    for (const msg of (body.messages || [])) {
      const turn = this._convertMessage(msg, toolNameMap);
      if (turn) contents.push(turn);
    }

    // System instruction
    const systemInstruction = this._buildSystemInstruction(body.system, modelDef);

    // Tools: separate Anthropic server tools from regular function tools
    let hasWebSearch = false;
    const functionDeclarations = [];
    for (const t of (body.tools || [])) {
      if ((t.type && /^web_(search|fetch)_/.test(t.type)) || ANTHROPIC_TOOL_NAMES.has(t.name)) {
        if (modelDef.webSearch !== false &&
            ((t.type && t.type.startsWith('web_search_')) || t.name === 'WebSearch' || t.name === 'web_search')) {
          hasWebSearch = true;
        }
        // All Anthropic-only tools are stripped from the function declarations
      } else {
        functionDeclarations.push(this._convertTool(t, modelDef));
      }
    }

    const tools = [];
    if (functionDeclarations.length > 0) {
      tools.push({ functionDeclarations });
    }
    if (hasWebSearch) {
      tools.push({ google_search: {} });
    }

    // Generation config
    const generationConfig = {};
    if (body.temperature != null) generationConfig.temperature = body.temperature;
    if (modelDef.maxOutputTokens) {
      generationConfig.maxOutputTokens = body.max_tokens != null
        ? Math.min(body.max_tokens, modelDef.maxOutputTokens)
        : modelDef.maxOutputTokens;
    } else if (body.max_tokens != null) {
      generationConfig.maxOutputTokens = body.max_tokens;
    }

    // Thinking config
    const thinkingConfig = this._buildThinkingConfig(body, modelDef);
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

    // Build request body
    const geminiBody = { contents };
    if (systemInstruction) geminiBody.system_instruction = systemInstruction;
    if (tools.length > 0) geminiBody.tools = tools;
    if (hasWebSearch) {
      geminiBody.tool_config = { include_server_side_tool_invocations: true };
    }
    if (Object.keys(generationConfig).length > 0) geminiBody.generationConfig = generationConfig;

    const baseUrl = modelDef.apiBaseUrl.replace(/\/$/, '');
    const url = `${baseUrl}/models/${modelDef.modelId}:streamGenerateContent?alt=sse`;

    const headers = {
      'Content-Type': 'application/json',
    };
    // Withheld with the stored key (see the OpenAI adapter).
    if (modelDef.apiKey) headers['x-goog-api-key'] = modelDef.apiKey;

    return { url, headers, body: geminiBody };
  }

  _buildSystemInstruction(anthropicSystem, modelDef) {
    const original = Array.isArray(anthropicSystem)
      ? anthropicSystem.filter(b => b.type === 'text').map(b => b.text).join('\n\n')
      : (typeof anthropicSystem === 'string' ? anthropicSystem : '');

    let text;
    switch (modelDef.systemPromptMode) {
      case 'replace':
        text = modelDef.systemPrompt || '';
        break;
      case 'prepend':
        text = (modelDef.systemPrompt || '') + '\n\n' + original;
        break;
      case 'append':
        text = original + '\n\n' + (modelDef.systemPrompt || '');
        break;
      case 'passthrough':
      default:
        text = original;
    }

    if (!text) return null;
    return { parts: [{ text }] };
  }

  _convertMessage(msg, toolNameMap) {
    if (msg.role === 'user') {
      return this._convertUserMessage(msg, toolNameMap);
    } else if (msg.role === 'assistant') {
      return this._convertAssistantMessage(msg, toolNameMap);
    }
    return null;
  }

  _convertUserMessage(msg, toolNameMap) {
    if (typeof msg.content === 'string') {
      return { role: 'user', parts: [{ text: msg.content }] };
    }
    if (!Array.isArray(msg.content)) return null;

    const parts = [];
    for (const block of msg.content) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'image') {
        const src = block.source;
        if (src.type === 'base64') {
          parts.push({ inline_data: { mime_type: src.media_type, data: src.data } });
        }
        // URL images would need to be fetched — skip for now (Gemini requires inline_data or file_data)
      } else if (block.type === 'tool_result') {
        // Gemini functionResponse: response must be an object
        let content = '';
        if (typeof block.content === 'string') {
          content = block.content;
        } else if (Array.isArray(block.content)) {
          content = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        }
        if (block.is_error) {
          content = `[Error] ${content}`;
        }
        const name = toolNameMap[block.tool_use_id] || 'unknown';
        const functionResponse = { name, response: { result: content } };
        if (block.tool_use_id) functionResponse.id = block.tool_use_id;
        parts.push({ functionResponse });
      }
    }

    return parts.length > 0 ? { role: 'user', parts } : null;
  }

  _convertAssistantMessage(msg, toolNameMap) {
    if (typeof msg.content === 'string') {
      return { role: 'model', parts: [{ text: msg.content }] };
    }
    if (!Array.isArray(msg.content)) return null;

    const parts = [];
    for (const block of msg.content) {
      if (block.type === 'text') {
        parts.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        // Track id → name for subsequent tool_result conversion
        if (block.id) toolNameMap[block.id] = block.name;
        const functionCall = {
          name: block.name,
          args: typeof block.input === 'string' ? JSON.parse(block.input) : (block.input || {}),
        };
        if (block.id) functionCall.id = block.id;
        // Re-attach thoughtSignature from server-side cache (Claude Code doesn't preserve it).
        // It's a SIBLING of functionCall in the part, required by Gemini 3 for integrity.
        const part = { functionCall };
        const sig = block.id ? _getSignature(block.id) : null;
        if (sig) part.thoughtSignature = sig;
        parts.push(part);
      }
      // Skip 'thinking' blocks
    }

    return parts.length > 0 ? { role: 'model', parts } : null;
  }

  _convertTool(tool, modelDef) {
    const description = modelDef.toolOverrides?.[tool.name] || tool.description || '';
    const parameters = this._cleanSchema(tool.input_schema || {});
    if (!parameters.type) parameters.type = 'object';
    return { name: tool.name, description, parameters };
  }

  // Strip JSON Schema fields unsupported by Gemini (recursively).
  // Only these are allowed: type, description, properties, required, items,
  // enum, format, nullable, minimum, maximum, minItems, maxItems.
  _cleanSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
    const ALLOWED = new Set([
      'type', 'description', 'properties', 'required', 'items',
      'enum', 'format', 'nullable', 'minimum', 'maximum', 'minItems', 'maxItems',
    ]);
    const clean = {};
    for (const [key, value] of Object.entries(schema)) {
      if (!ALLOWED.has(key)) continue;
      if (key === 'properties' && typeof value === 'object') {
        clean.properties = {};
        for (const [prop, propSchema] of Object.entries(value)) {
          clean.properties[prop] = this._cleanSchema(propSchema);
        }
      } else if (key === 'items' && typeof value === 'object') {
        clean.items = this._cleanSchema(value);
      } else {
        clean[key] = value;
      }
    }
    return clean;
  }

  _buildThinkingConfig(body, modelDef) {
    if (!body.thinking || body.thinking.type !== 'enabled') return null;
    const budget = body.thinking.budget_tokens;
    if (!budget || budget <= 0) return null;

    const modelId = modelDef.modelId.toLowerCase();

    // Gemini 2.5: token-level thinkingBudget (range 0-24576 for Flash)
    if (modelId.includes('gemini-2.5')) {
      const maxBudget = 24576;
      const minBudget = 2048;
      const scaled = Math.round(minBudget + (Math.min(budget, 128000) / 128000) * (maxBudget - minBudget));
      return { thinkingBudget: scaled };
    }

    // Gemini 3+: string thinkingLevel (mutually exclusive with thinkingBudget)
    if (modelId.includes('gemini-3')) {
      let level;
      if (budget <= 4096) level = 'low';
      else if (budget <= 16384) level = 'medium';
      else level = 'high';
      return { thinkingLevel: level };
    }

    return null;
  }

  // --- Response translation (Gemini SSE → Anthropic SSE) ---

  createStreamState() {
    return {
      messageId: `msg_${Date.now()}`,
      contentIndex: 0,
      hasStarted: false,
      textBlockOpen: false,
      toolCalls: [],
      inputTokens: 0,
      outputTokens: 0,
      finishReason: null,
      finalized: false,
    };
  }

  finalizeStream(ss) {
    if (ss.finalized) return [];
    return this._finalize(ss);
  }

  translateSSEChunk(data, ss) {
    let parsed;
    try { parsed = JSON.parse(data); }
    catch { return []; }

    const events = [];

    // Message start on first chunk
    if (!ss.hasStarted) {
      ss.hasStarted = true;
      events.push(this._sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: ss.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: parsed.modelVersion || 'gemini',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
    }

    // Usage metadata
    if (parsed.usageMetadata) {
      ss.inputTokens = parsed.usageMetadata.promptTokenCount || ss.inputTokens;
      ss.outputTokens = parsed.usageMetadata.candidatesTokenCount || ss.outputTokens;
    }

    const candidate = parsed.candidates?.[0];
    if (!candidate) return events;

    // Process parts
    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      // Skip thinking parts
      if (part.thought) continue;

      // Text content
      if (part.text != null) {
        if (!ss.textBlockOpen) {
          ss.textBlockOpen = true;
          events.push(this._sseEvent('content_block_start', {
            type: 'content_block_start',
            index: ss.contentIndex,
            content_block: { type: 'text', text: '' },
          }));
        }
        events.push(this._sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: ss.contentIndex,
          delta: { type: 'text_delta', text: part.text },
        }));
      }

      // Function call
      if (part.functionCall) {
        // Close text block if open
        if (ss.textBlockOpen) {
          events.push(this._sseEvent('content_block_stop', {
            type: 'content_block_stop',
            index: ss.contentIndex,
          }));
          ss.contentIndex++;
          ss.textBlockOpen = false;
        }

        const toolId = part.functionCall.id || `toolu_${Date.now()}_${ss.toolCalls.length}`;
        const toolName = part.functionCall.name || '';
        const argsJson = JSON.stringify(part.functionCall.args || {});

        ss.toolCalls.push({ id: toolId, contentIndex: ss.contentIndex });

        // Store thoughtSignature server-side — Claude Code won't preserve unknown fields
        // on content blocks, so we cache it by tool ID and re-attach on the next request.
        if (part.thoughtSignature) {
          _storeSignature(toolId, part.thoughtSignature);
        }

        const contentBlock = { type: 'tool_use', id: toolId, name: toolName, input: {} };
        events.push(this._sseEvent('content_block_start', {
          type: 'content_block_start',
          index: ss.contentIndex,
          content_block: contentBlock,
        }));
        events.push(this._sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: ss.contentIndex,
          delta: { type: 'input_json_delta', partial_json: argsJson },
        }));
        events.push(this._sseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: ss.contentIndex,
        }));
        ss.contentIndex++;
      }
    }

    // Finish reason — triggers finalization
    if (candidate.finishReason) {
      ss.finishReason = this._translateFinishReason(candidate.finishReason);
      events.push(...this._finalize(ss));
    }

    return events;
  }

  _finalize(ss) {
    if (ss.finalized) return [];
    ss.finalized = true;
    const events = [];

    // Close open text block
    if (ss.textBlockOpen) {
      events.push(this._sseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: ss.contentIndex,
      }));
      ss.contentIndex++;
      ss.textBlockOpen = false;
    }

    // Message delta with stop reason and usage
    events.push(this._sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: ss.finishReason || 'end_turn', stop_sequence: null },
      usage: { input_tokens: ss.inputTokens, output_tokens: ss.outputTokens },
    }));

    // Message stop
    events.push(this._sseEvent('message_stop', { type: 'message_stop' }));

    return events;
  }

  _translateFinishReason(reason) {
    switch (reason) {
      case 'STOP': return 'end_turn';
      case 'MAX_TOKENS': return 'max_tokens';
      case 'SAFETY': return 'end_turn';
      case 'RECITATION': return 'end_turn';
      default: return 'end_turn';
    }
  }

  _sseEvent(eventType, data) {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

module.exports = GeminiProvider;
