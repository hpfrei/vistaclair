// ============================================================
// OpenAI-compatible provider adapter
// Handles: OpenAI, DeepSeek, Kimi/Moonshot, Ollama
// ============================================================

const BaseProvider = require('./base');

class OpenAIProvider extends BaseProvider {

  // --- Request translation (Anthropic → OpenAI) ---

  translateRequest(body, modelDef) {
    const messages = [];

    // System prompt
    const systemPrompt = this._buildSystemPrompt(body.system, modelDef);
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Convert Anthropic messages to OpenAI format
    for (const msg of (body.messages || [])) {
      const converted = this._convertMessage(msg, modelDef);
      if (converted) messages.push(...(Array.isArray(converted) ? converted : [converted]));
    }

    // Separate Anthropic-only tools from regular function tools.
    // Anthropic server tools have a versioned type prefix (web_search_*, web_fetch_*)
    // or appear by their CLI names (WebSearch, WebFetch). These are never valid
    // OpenAI-compatible function tools — each provider handles search differently.
    const ANTHROPIC_TOOL_NAMES = new Set(['WebSearch', 'web_search', 'WebFetch', 'web_fetch']);
    let hasWebSearch = false;
    const regularTools = [];
    for (const t of (body.tools || [])) {
      if ((t.type && /^web_(search|fetch)_/.test(t.type)) || ANTHROPIC_TOOL_NAMES.has(t.name)) {
        // Detect web search specifically (not web fetch) for provider injection
        if (modelDef.webSearch !== false &&
            ((t.type && t.type.startsWith('web_search_')) || t.name === 'WebSearch' || t.name === 'web_search')) {
          hasWebSearch = true;
        }
        // All Anthropic-only tools are stripped from the function tools list
      } else {
        regularTools.push(t);
      }
    }

    // Convert regular tools to OpenAI function format
    const tools = regularTools.map(t => this._convertTool(t, modelDef));

    const openaiBody = {
      model: modelDef.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };

    // Inject provider-native web search as a built-in tool type
    // (each provider has its own format — not an OpenAI function tool)
    if (hasWebSearch) {
      this._injectWebSearch(openaiBody, tools, modelDef);
    }

    if (tools.length > 0) {
      openaiBody.tools = tools;
    }

    // Temperature passthrough
    if (body.temperature != null) openaiBody.temperature = body.temperature;

    // Token limit: some models require max_completion_tokens instead of max_tokens
    const tokenParam = modelDef.useMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens';
    if (modelDef.maxOutputTokens) {
      openaiBody[tokenParam] = body.max_tokens != null
        ? Math.min(body.max_tokens, modelDef.maxOutputTokens)
        : modelDef.maxOutputTokens;
    } else if (body.max_tokens != null) {
      openaiBody[tokenParam] = body.max_tokens;
    }

    // Thinking / reasoning effort translation
    this._injectThinking(openaiBody, body, modelDef);

    const url = `${modelDef.apiBaseUrl.replace(/\/$/, '')}/chat/completions`;

    const headers = {
      'Content-Type': 'application/json',
    };
    // No key, no header: the proxy blanks the stored key for a caller that did
    // not present the proxy secret (src/proxy.js), and a keyless local server
    // needs none.
    if (modelDef.apiKey) headers['Authorization'] = `Bearer ${modelDef.apiKey}`;

    return { url, headers, body: openaiBody };
  }

  _buildSystemPrompt(anthropicSystem, modelDef) {
    // anthropicSystem is an array of {type: 'text', text: '...'} blocks
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

  _convertMessage(msg, modelDef) {
    if (msg.role === 'user') {
      return this._convertUserMessage(msg);
    } else if (msg.role === 'assistant') {
      return this._convertAssistantMessage(msg, modelDef);
    }
    return null;
  }

  _convertUserMessage(msg) {
    // Anthropic user messages have content as string or array of content blocks
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content };
    }

    if (!Array.isArray(msg.content)) return null;

    const results = [];
    const contentParts = [];
    const toolResults = [];

    for (const block of msg.content) {
      if (block.type === 'text') {
        contentParts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        // Anthropic image → OpenAI image_url
        const src = block.source;
        if (src.type === 'base64') {
          contentParts.push({
            type: 'image_url',
            image_url: { url: `data:${src.media_type};base64,${src.data}` },
          });
        } else if (src.type === 'url') {
          contentParts.push({ type: 'image_url', image_url: { url: src.url } });
        }
      } else if (block.type === 'tool_result') {
        toolResults.push(block);
      }
    }

    // Emit tool_result as separate tool messages (OpenAI format)
    for (const tr of toolResults) {
      let content = '';
      if (typeof tr.content === 'string') {
        content = tr.content;
      } else if (Array.isArray(tr.content)) {
        content = tr.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      }
      if (tr.is_error) {
        content = `[Error] ${content}`;
      }
      results.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content,
      });
    }

    // Then emit user message if there's text/image content
    if (contentParts.length > 0) {
      if (contentParts.length === 1 && contentParts[0].type === 'text') {
        results.push({ role: 'user', content: contentParts[0].text });
      } else {
        results.push({ role: 'user', content: contentParts });
      }
    }

    return results.length > 0 ? results : null;
  }

  _convertAssistantMessage(msg, modelDef) {
    if (typeof msg.content === 'string') {
      return { role: 'assistant', content: msg.content };
    }

    if (!Array.isArray(msg.content)) return null;

    // DeepSeek and Kimi/Moonshot use reasoning_content for thinking
    const usesReasoningContent = modelDef && (
      modelDef.providerKey === 'deepseek' || modelDef.providerKey === 'moonshot'
    );

    const result = { role: 'assistant', content: '', tool_calls: [] };
    let reasoningContent = '';
    let toolCallIndex = 0;

    for (const block of msg.content) {
      if (block.type === 'text') {
        result.content += (result.content ? '\n' : '') + block.text;
      } else if (block.type === 'tool_use') {
        result.tool_calls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
          },
          index: toolCallIndex++,
        });
      } else if (block.type === 'thinking' && usesReasoningContent) {
        reasoningContent += block.thinking || '';
      }
    }

    if (result.tool_calls.length === 0) delete result.tool_calls;
    if (!result.content) result.content = '';
    if (reasoningContent) result.reasoning_content = reasoningContent;

    return result;
  }

  _injectWebSearch(openaiBody, tools, modelDef) {
    switch (modelDef.providerKey) {
      case 'moonshot':
        tools.push({ type: 'builtin_function', function: { name: '$web_search' } });
        break;
      // openai: the { type: 'web_search' } built-in tool is only valid on the
      // Responses API; this adapter uses /chat/completions, which rejects it
      // (400: supported types are 'function' and 'custom'). Drop it silently.
      // deepseek, ollama, custom: no native web search support — also dropped.
    }
  }

  _injectThinking(openaiBody, body, modelDef) {
    if (!body.thinking || body.thinking.type !== 'enabled') return;
    const budget = body.thinking.budget_tokens;
    if (!budget || budget <= 0) return;

    const modelId = modelDef.modelId.toLowerCase();

    switch (modelDef.providerKey) {
      case 'openai':
        // OpenAI reasoning models (o1, o3, gpt-5+) use reasoning_effort
        if (modelId.includes('o1') || modelId.includes('o3') || modelId.includes('gpt-5')) {
          openaiBody.reasoning_effort = this._budgetToEffort(budget);
        }
        break;
      // deepseek: reasoner model thinks automatically, no explicit control
      // moonshot: thinking models think automatically, no explicit control
    }
  }

  _budgetToEffort(budgetTokens) {
    if (budgetTokens <= 4096) return 'low';
    if (budgetTokens <= 16384) return 'medium';
    return 'high';
  }

  _convertTool(tool, modelDef) {
    const description = modelDef.toolOverrides?.[tool.name] || tool.description || '';
    const schema = tool.input_schema || {};
    // OpenAI-compatible APIs require type: "object" in function parameters
    if (!schema.type) schema.type = 'object';
    return {
      type: 'function',
      function: {
        name: tool.name,
        description,
        parameters: schema,
      },
    };
  }

  // --- Response translation (OpenAI SSE → Anthropic SSE) ---

  createStreamState() {
    return {
      messageId: `msg_${Date.now()}`,
      contentIndex: 0,
      hasStarted: false,
      thinkingBlockOpen: false,
      textBlockOpen: false,
      toolCalls: {},       // indexed by tool call index
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      reasoningTokens: 0,
    };
  }

  finalizeStream(ss) {
    if (ss.finalized) return [];
    return this._finalize(ss);
  }

  translateSSEChunk(data, ss) {
    if (data === '[DONE]') {
      return this._finalize(ss);
    }

    let parsed;
    try { parsed = JSON.parse(data); }
    catch { return []; }

    const events = [];

    // Message start
    if (!ss.hasStarted) {
      ss.hasStarted = true;
      events.push(this._sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: ss.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model: parsed.model || 'unknown',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }));
    }

    // Handle usage in the chunk (some providers send it)
    if (parsed.usage) {
      ss.inputTokens = parsed.usage.prompt_tokens || ss.inputTokens;
      ss.outputTokens = parsed.usage.completion_tokens || ss.outputTokens;
      // OpenAI: prompt_tokens_details.cached_tokens, completion_tokens_details.reasoning_tokens
      if (parsed.usage.prompt_tokens_details?.cached_tokens) {
        ss.cacheReadTokens = parsed.usage.prompt_tokens_details.cached_tokens;
      }
      if (parsed.usage.completion_tokens_details?.reasoning_tokens) {
        ss.reasoningTokens = parsed.usage.completion_tokens_details.reasoning_tokens;
      }
      // DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
      if (parsed.usage.prompt_cache_hit_tokens) {
        ss.cacheReadTokens = parsed.usage.prompt_cache_hit_tokens;
      }
    }

    const choice = parsed.choices?.[0];
    if (!choice) return events;

    const delta = choice.delta || {};

    // Reasoning content (DeepSeek, Kimi thinking models)
    if (delta.reasoning_content != null && delta.reasoning_content !== '') {
      if (!ss.thinkingBlockOpen) {
        ss.thinkingBlockOpen = true;
        events.push(this._sseEvent('content_block_start', {
          type: 'content_block_start',
          index: ss.contentIndex,
          content_block: { type: 'thinking', thinking: '' },
        }));
      }
      events.push(this._sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: ss.contentIndex,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      }));
    }

    // Text content
    if (delta.content != null && delta.content !== '') {
      // Close thinking block before starting text
      if (ss.thinkingBlockOpen) {
        events.push(this._sseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: ss.contentIndex,
        }));
        ss.contentIndex++;
        ss.thinkingBlockOpen = false;
      }
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
        delta: { type: 'text_delta', text: delta.content },
      }));
    }

    // Tool calls
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;

        if (tc.id || tc.function?.name) {
          // New tool call starting — close thinking/text blocks if open
          if (ss.thinkingBlockOpen) {
            events.push(this._sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: ss.contentIndex,
            }));
            ss.contentIndex++;
            ss.thinkingBlockOpen = false;
          }
          if (ss.textBlockOpen) {
            events.push(this._sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: ss.contentIndex,
            }));
            ss.contentIndex++;
            ss.textBlockOpen = false;
          }

          // Close previous tool call at same index if exists
          if (ss.toolCalls[idx] && ss.toolCalls[idx].started) {
            events.push(this._sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: ss.toolCalls[idx].contentIndex,
            }));
            ss.contentIndex++;
          }

          const toolId = tc.id || `toolu_${Date.now()}_${idx}`;
          const toolName = tc.function?.name || '';

          ss.toolCalls[idx] = {
            id: toolId,
            name: toolName,
            contentIndex: ss.contentIndex,
            started: true,
          };

          events.push(this._sseEvent('content_block_start', {
            type: 'content_block_start',
            index: ss.contentIndex,
            content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
          }));
        }

        // Argument deltas
        if (tc.function?.arguments) {
          const toolState = ss.toolCalls[idx];
          if (toolState) {
            events.push(this._sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: toolState.contentIndex,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            }));
          }
        }
      }
    }

    // Finish reason
    if (choice.finish_reason) {
      ss.finishReason = this._translateStopReason(choice.finish_reason);
    }

    return events;
  }

  _finalize(ss) {
    ss.finalized = true;
    const events = [];

    // Close any open thinking block
    if (ss.thinkingBlockOpen) {
      events.push(this._sseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: ss.contentIndex,
      }));
      ss.contentIndex++;
    }

    // Close any open text block
    if (ss.textBlockOpen) {
      events.push(this._sseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: ss.contentIndex,
      }));
      ss.contentIndex++;
    }

    // Close any open tool calls
    for (const tc of Object.values(ss.toolCalls)) {
      if (tc.started) {
        events.push(this._sseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: tc.contentIndex,
        }));
      }
    }

    // Message delta with stop reason and full usage
    const usage = { input_tokens: ss.inputTokens, output_tokens: ss.outputTokens };
    if (ss.cacheReadTokens) usage.cache_read_input_tokens = ss.cacheReadTokens;
    if (ss.cacheCreateTokens) usage.cache_creation_input_tokens = ss.cacheCreateTokens;
    if (ss.reasoningTokens) usage.reasoning_tokens = ss.reasoningTokens;
    events.push(this._sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: ss.finishReason || 'end_turn', stop_sequence: null },
      usage,
    }));

    // Message stop
    events.push(this._sseEvent('message_stop', { type: 'message_stop' }));

    return events;
  }

  _translateStopReason(openaiReason) {
    switch (openaiReason) {
      case 'stop': return 'end_turn';
      case 'tool_calls': return 'tool_use';
      case 'length': return 'max_tokens';
      case 'content_filter': return 'end_turn';
      default: return 'end_turn';
    }
  }

  _sseEvent(eventType, data) {
    return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

module.exports = OpenAIProvider;
