// ============================================================
// OpenAI Responses API provider adapter
// Targets POST /v1/responses (NOT /chat/completions).
// Used by OpenAI-native models and xAI (Grok, which deprecated Chat
// Completions); supports the built-in web_search tool and richer
// reasoning-model tool calling. DeepSeek/Kimi/Ollama stay on the
// Chat Completions adapter (openai.js).
// ============================================================

const BaseProvider = require('./base');

// Anthropic server tools that are never valid function tools — handled
// natively per provider or dropped. Same set the Chat adapter strips.
const ANTHROPIC_TOOL_NAMES = new Set(['WebSearch', 'web_search', 'WebFetch', 'web_fetch']);

class OpenAIResponsesProvider extends BaseProvider {

  // --- Request translation (Anthropic → OpenAI Responses) ---

  translateRequest(body, modelDef) {
    const instructions = this._buildSystemPrompt(body.system, modelDef);

    const input = [];
    for (const msg of (body.messages || [])) {
      const items = this._convertMessage(msg);
      if (items) input.push(...items);
    }

    // Separate Anthropic-only server tools (web_search/web_fetch) from
    // regular function tools, detecting whether web search was requested.
    let hasWebSearch = false;
    const regularTools = [];
    for (const t of (body.tools || [])) {
      if ((t.type && /^web_(search|fetch)_/.test(t.type)) || ANTHROPIC_TOOL_NAMES.has(t.name)) {
        if (modelDef.webSearch !== false &&
            ((t.type && t.type.startsWith('web_search_')) || t.name === 'WebSearch' || t.name === 'web_search')) {
          hasWebSearch = true;
        }
      } else {
        regularTools.push(t);
      }
    }

    // Responses function tools are internally tagged: name/description/parameters
    // live at the top level, not nested under a `function` key.
    const tools = regularTools.map(t => this._convertTool(t, modelDef));
    if (hasWebSearch) tools.push({ type: 'web_search' });

    const reqBody = {
      model: modelDef.modelId,
      input,
      stream: true,
      store: false,
    };
    if (instructions) reqBody.instructions = instructions;
    if (tools.length > 0) reqBody.tools = tools;

    // Reasoning models (gpt-5 / o-series) reject a non-default temperature.
    if (body.temperature != null && !this._isReasoningModel(modelDef)) {
      reqBody.temperature = body.temperature;
    }

    if (modelDef.maxOutputTokens) {
      reqBody.max_output_tokens = body.max_tokens != null
        ? Math.min(body.max_tokens, modelDef.maxOutputTokens)
        : modelDef.maxOutputTokens;
    } else if (body.max_tokens != null) {
      reqBody.max_output_tokens = body.max_tokens;
    }

    // xAI: only some Grok models accept reasoning.effort (others reject it, and
    // on multi-agent it sets the agent count); Grok reasoning models always
    // think at their own default, so the effort is never sent.
    if (modelDef.providerKey !== 'xai' &&
        body.thinking && body.thinking.type === 'enabled' && body.thinking.budget_tokens > 0) {
      reqBody.reasoning = { effort: this._budgetToEffort(body.thinking.budget_tokens) };
    }

    const url = `${modelDef.apiBaseUrl.replace(/\/$/, '')}/responses`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${modelDef.apiKey}`,
    };

    return { url, headers, body: reqBody };
  }

  _isReasoningModel(modelDef) {
    if (modelDef.reasoning) return true;
    const id = (modelDef.modelId || '').toLowerCase();
    return id.includes('gpt-5') || /\bo[134]\b/.test(id) || id.startsWith('o1') || id.startsWith('o3') || id.startsWith('o4');
  }

  _buildSystemPrompt(anthropicSystem, modelDef) {
    const original = Array.isArray(anthropicSystem)
      ? anthropicSystem.filter(b => b.type === 'text').map(b => b.text).join('\n\n')
      : (typeof anthropicSystem === 'string' ? anthropicSystem : '');

    switch (modelDef.systemPromptMode) {
      case 'replace':
        return modelDef.systemPrompt || '';
      case 'prepend':
        return (modelDef.systemPrompt || '') + '\n\n' + original;
      case 'append':
        return original + '\n\n' + (modelDef.systemPrompt || '');
      case 'passthrough':
      default:
        return original;
    }
  }

  _convertMessage(msg) {
    if (msg.role === 'user') return this._convertUserMessage(msg);
    if (msg.role === 'assistant') return this._convertAssistantMessage(msg);
    return null;
  }

  _convertUserMessage(msg) {
    if (typeof msg.content === 'string') {
      return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: msg.content }] }];
    }
    if (!Array.isArray(msg.content)) return null;

    const results = [];
    const contentParts = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        contentParts.push({ type: 'input_text', text: block.text });
      } else if (block.type === 'image') {
        const src = block.source;
        if (src.type === 'base64') {
          contentParts.push({ type: 'input_image', detail: 'auto', image_url: `data:${src.media_type};base64,${src.data}` });
        } else if (src.type === 'url') {
          contentParts.push({ type: 'input_image', detail: 'auto', image_url: src.url });
        }
      } else if (block.type === 'tool_result') {
        // Tool results are top-level input items, not nested in a message.
        let content = '';
        if (typeof block.content === 'string') {
          content = block.content;
        } else if (Array.isArray(block.content)) {
          content = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        }
        if (block.is_error) content = `[Error] ${content}`;
        results.push({ type: 'function_call_output', call_id: block.tool_use_id, output: content });
      }
    }

    if (contentParts.length > 0) {
      results.push({ type: 'message', role: 'user', content: contentParts });
    }

    return results.length > 0 ? results : null;
  }

  _convertAssistantMessage(msg) {
    if (typeof msg.content === 'string') {
      return [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: msg.content }] }];
    }
    if (!Array.isArray(msg.content)) return null;

    const results = [];
    let text = '';

    for (const block of msg.content) {
      if (block.type === 'text') {
        text += (text ? '\n' : '') + block.text;
      } else if (block.type === 'tool_use') {
        results.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
        });
      }
      // thinking blocks dropped — reasoning can't be replayed statelessly.
    }

    if (text) {
      results.unshift({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    }

    return results.length > 0 ? results : null;
  }

  _convertTool(tool, modelDef) {
    const description = modelDef.toolOverrides?.[tool.name] || tool.description || '';
    const schema = tool.input_schema || {};
    if (!schema.type) schema.type = 'object';
    return {
      type: 'function',
      name: tool.name,
      description,
      parameters: schema,
    };
  }

  _budgetToEffort(budgetTokens) {
    if (budgetTokens <= 4096) return 'low';
    if (budgetTokens <= 16384) return 'medium';
    return 'high';
  }

  // --- Response translation (Responses SSE → Anthropic SSE) ---

  createStreamState() {
    return {
      messageId: `msg_${Date.now()}`,
      contentIndex: 0,
      hasStarted: false,
      thinkingBlockOpen: false,
      textBlockOpen: false,
      toolCalls: {},       // keyed by output_index
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      finishReason: null,
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

    const type = parsed.type;
    const events = [];

    if (!ss.hasStarted && type === 'response.created') {
      ss.hasStarted = true;
      events.push(this._sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: ss.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: parsed.response?.model || 'unknown',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
      return events;
    }

    // Lazily emit message_start if the first event we see isn't response.created.
    if (!ss.hasStarted) {
      ss.hasStarted = true;
      events.push(this._sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: ss.messageId, type: 'message', role: 'assistant', content: [],
          model: parsed.response?.model || 'unknown',
          stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
    }

    switch (type) {
      case 'response.reasoning_summary_text.delta': {
        if (parsed.delta) {
          this._closeText(ss, events);
          if (!ss.thinkingBlockOpen) {
            ss.thinkingBlockOpen = true;
            events.push(this._sseEvent('content_block_start', {
              type: 'content_block_start', index: ss.contentIndex,
              content_block: { type: 'thinking', thinking: '' },
            }));
          }
          events.push(this._sseEvent('content_block_delta', {
            type: 'content_block_delta', index: ss.contentIndex,
            delta: { type: 'thinking_delta', thinking: parsed.delta },
          }));
        }
        break;
      }

      case 'response.output_text.delta': {
        if (parsed.delta) {
          this._closeThinking(ss, events);
          if (!ss.textBlockOpen) {
            ss.textBlockOpen = true;
            events.push(this._sseEvent('content_block_start', {
              type: 'content_block_start', index: ss.contentIndex,
              content_block: { type: 'text', text: '' },
            }));
          }
          events.push(this._sseEvent('content_block_delta', {
            type: 'content_block_delta', index: ss.contentIndex,
            delta: { type: 'text_delta', text: parsed.delta },
          }));
        }
        break;
      }

      case 'response.output_item.added': {
        const item = parsed.item;
        if (item && item.type === 'function_call') {
          this._closeThinking(ss, events);
          this._closeText(ss, events);
          const outIdx = parsed.output_index ?? 0;
          const toolId = item.call_id || item.id || `toolu_${outIdx}`;
          ss.toolCalls[outIdx] = { id: toolId, name: item.name || '', contentIndex: ss.contentIndex, started: true };
          events.push(this._sseEvent('content_block_start', {
            type: 'content_block_start', index: ss.contentIndex,
            content_block: { type: 'tool_use', id: toolId, name: item.name || '', input: {} },
          }));
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const outIdx = parsed.output_index ?? 0;
        const toolState = ss.toolCalls[outIdx];
        if (toolState && parsed.delta) {
          events.push(this._sseEvent('content_block_delta', {
            type: 'content_block_delta', index: toolState.contentIndex,
            delta: { type: 'input_json_delta', partial_json: parsed.delta },
          }));
        }
        break;
      }

      case 'response.output_item.done': {
        const item = parsed.item;
        if (item && item.type === 'function_call') {
          const outIdx = parsed.output_index ?? 0;
          const toolState = ss.toolCalls[outIdx];
          if (toolState && toolState.started) {
            events.push(this._sseEvent('content_block_stop', {
              type: 'content_block_stop', index: toolState.contentIndex,
            }));
            toolState.started = false;
            ss.contentIndex++;
            ss.finishReason = 'tool_use';
          }
        }
        break;
      }

      case 'response.completed': {
        const usage = parsed.response?.usage;
        if (usage) {
          ss.inputTokens = usage.input_tokens ?? ss.inputTokens;
          ss.outputTokens = usage.output_tokens ?? ss.outputTokens;
          ss.cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? ss.cacheReadTokens;
          ss.reasoningTokens = usage.output_tokens_details?.reasoning_tokens ?? ss.reasoningTokens;
        }
        return this._finalize(ss);
      }

      case 'response.failed':
      case 'error': {
        return this._finalize(ss);
      }
    }

    return events;
  }

  _closeThinking(ss, events) {
    if (ss.thinkingBlockOpen) {
      events.push(this._sseEvent('content_block_stop', { type: 'content_block_stop', index: ss.contentIndex }));
      ss.contentIndex++;
      ss.thinkingBlockOpen = false;
    }
  }

  _closeText(ss, events) {
    if (ss.textBlockOpen) {
      events.push(this._sseEvent('content_block_stop', { type: 'content_block_stop', index: ss.contentIndex }));
      ss.contentIndex++;
      ss.textBlockOpen = false;
    }
  }

  _finalize(ss) {
    if (ss.finalized) return [];
    ss.finalized = true;
    const events = [];

    this._closeThinking(ss, events);
    this._closeText(ss, events);
    for (const tc of Object.values(ss.toolCalls)) {
      if (tc.started) {
        events.push(this._sseEvent('content_block_stop', { type: 'content_block_stop', index: tc.contentIndex }));
        tc.started = false;
      }
    }

    const usage = { input_tokens: ss.inputTokens, output_tokens: ss.outputTokens };
    if (ss.cacheReadTokens) usage.cache_read_input_tokens = ss.cacheReadTokens;
    if (ss.reasoningTokens) usage.reasoning_tokens = ss.reasoningTokens;

    events.push(this._sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: ss.finishReason || 'end_turn', stop_sequence: null },
      usage,
    }));
    events.push(this._sseEvent('message_stop', { type: 'message_stop' }));

    return events;
  }

  _sseEvent(eventType, data) {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

module.exports = OpenAIResponsesProvider;
