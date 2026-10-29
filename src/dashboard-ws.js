const WebSocket = require('ws');
const { sanitizeForDashboard, getActiveProcessCount, getInstances, killInstance, removeInstances, processUploadedFiles, DATA_HOME } = require('./utils');
const createProxyRouter = require('./proxy');
const { pendingQuestions } = createProxyRouter;
const caps = require('./capabilities');
const { InspectorSessions } = require('./inspector-sessions');

const PROJECT_ROOT = DATA_HOME;

// Large strings in what a summary keeps (tool results, the response body) are
// cut to this many characters; the full value comes with interaction:getDetail.
const SUMMARY_STRING_MAX = 2000;
// A response body under this size (serialized) is kept whole in a summary.
const SUMMARY_BODY_MAX = 64 * 1024;
// The first user message's text, kept for matching subagent turns to the
// Agent call that spawned them (wide-layout.js matches a 200-char probe).
const SUMMARY_FIRST_TEXT_MAX = 8000;
// What a freshly opened tab gets at most; older turns come page by page
// (inspector:getEarlier).
const SNAPSHOT_LIMIT = 500;
const EARLIER_PAGE_MAX = 500;

// A copy of `value` with every string longer than `max` cut, and whether
// anything was cut. Unchanged subtrees are shared, not copied.
function truncateStrings(value, max, depth = 0) {
  if (typeof value === 'string') {
    return value.length > max ? { value: value.slice(0, max), cut: true } : { value, cut: false };
  }
  if (!value || typeof value !== 'object' || depth > 32) return { value, cut: false };
  let cut = false;
  if (Array.isArray(value)) {
    const out = value.map(v => {
      const r = truncateStrings(v, max, depth + 1);
      if (r.cut) cut = true;
      return r.value;
    });
    return cut ? { value: out, cut } : { value, cut };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const r = truncateStrings(v, max, depth + 1);
    if (r.cut) cut = true;
    out[k] = r.value;
  }
  return cut ? { value: out, cut } : { value, cut };
}

function firstUserText(msgs) {
  const first = msgs.find(m => m.role === 'user');
  if (!first) return null;
  const text = typeof first.content === 'string' ? first.content
    : (Array.isArray(first.content) ? first.content.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n') : '');
  return text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_FIRST_TEXT_MAX);
}

// The summary shape every turn reaches a browser in (snapshots, live
// interaction:* messages, paged history): no messages, tools, system or
// translated copy — the conversation so far, which every turn of a long
// session carries again — but the counts and sizes the timeline and the
// detail chips show, and what the timeline needs to link tool calls to
// their results. public/inspector.js fetches the rest on select.
function summarizeForInit(interaction) {
  const s = { ...interaction };
  if (s.request) {
    s.request = { ...s.request };
    if (s.request.messages) {
      const msgs = s.request.messages;
      const last = msgs[msgs.length - 1];
      let hasText = false;
      if (last) {
        if (typeof last.content === 'string') hasText = true;
        else if (Array.isArray(last.content)) {
          hasText = last.content.length === 0 || last.content[last.content.length - 1]?.type === 'text';
        }
      }
      s.request._messageCount = msgs.length;
      s.request._messagesChars = JSON.stringify(msgs).length;
      s.request._lastMessage = last ? { role: last.role, hasText } : null;
      // Tool results only ever arrive in the newest user message; the tool
      // detail shows them (cut, until the turn's detail is fetched).
      if (last?.role === 'user' && Array.isArray(last.content)) {
        const results = last.content.filter(b => b?.type === 'tool_result');
        if (results.length) {
          const r = truncateStrings(results, SUMMARY_STRING_MAX);
          s.request._toolResults = r.cut ? r.value.map(b => ({ ...b, _truncated: true })) : r.value;
        }
      }
      const text = firstUserText(msgs);
      if (text) s.request._firstUserText = text;
      delete s.request.messages;
    }
    if (s.request.tools) {
      s.request._toolCount = s.request.tools.length;
      s.request._toolsChars = JSON.stringify(s.request.tools).length;
      delete s.request.tools;
    }
    if (s.request.system) {
      s.request._systemChars = typeof s.request.system === 'string'
        ? s.request.system.length
        : JSON.stringify(s.request.system).length;
      delete s.request.system;
    }
    if (interaction.isHook) {
      if (s.request.tool_response !== undefined) {
        // An Agent result names the agent it ran — the inspector keys lanes on it.
        const agentId = s.request.tool_response?.agentId;
        if (typeof agentId === 'string') s.request._agentId = agentId;
        s.request._toolResponseChars = JSON.stringify(s.request.tool_response).length;
        delete s.request.tool_response;
      }
      if (Array.isArray(s.request.tool_calls)) {
        s.request.tool_calls = s.request.tool_calls.map(tc => {
          if (!tc.tool_response) return tc;
          return { ...tc, tool_response: undefined, _toolResponseChars: JSON.stringify(tc.tool_response).length };
        });
      }
      if (s.response) s.response = { ...s.response, body: undefined };
    }
  }
  // A large response body (a long answer, a big tool input) keeps its shape
  // with its strings cut: the timeline reads tool names and summaries from it.
  if (s.response?.body && typeof s.response.body === 'object') {
    const chars = JSON.stringify(s.response.body).length;
    if (chars > SUMMARY_BODY_MAX) {
      const r = truncateStrings(s.response.body, SUMMARY_STRING_MAX);
      s.response = { ...s.response, body: r.value, _bodyChars: chars, _bodyTruncated: r.cut || undefined };
    }
  } else if (typeof s.response?.body === 'string' && s.response.body.length > SUMMARY_BODY_MAX) {
    s.response = { ...s.response, body: s.response.body.slice(0, SUMMARY_STRING_MAX),
                   _bodyChars: s.response.body.length, _bodyTruncated: true };
  }
  // A provider-translated turn carries its own copy of the whole request.
  delete s.translatedBody;
  s._summary = true;
  return s;
}

const LIVE_TYPES = new Set(['interaction:start', 'interaction:update', 'interaction:complete']);
const isLive = i => i.status === 'pending' || i.status === 'streaming';

// What browsers get of a live interaction:* message: the summary shape. The
// stream is left off updates and completions too — browsers get each event
// one by one as sse_event — but not off a start, whose events so far (a
// rule's dummy response, say) may have gone out before the turn did.
// In-process listeners still get the full message.
function forClients(message) {
  if (!LIVE_TYPES.has(message.type) || !message.interaction) return message;
  const s = summarizeForInit(message.interaction);
  if (s.response && message.type !== 'interaction:start') {
    s.response = { ...s.response, sseEvents: undefined };
  }
  return { ...message, interaction: s };
}

// Messages that belong to one session's content: a browser gets them only for
// the sessions it has open (inspector:subscribe).
const SESSION_SCOPED = new Set([
  'interaction:start', 'interaction:update', 'interaction:complete', 'interaction:error',
  'interaction:enriched', 'sse_event', 'inspector:turnsDeleted', 'inspector:sessionTotals',
]);

// A turn as a freshly opened tab gets it: the summary shape (public/inspector.js
// refetches detail on select), except a turn still streaming keeps the events
// so far, since the rest arrive one by one as sse_event.
function forSnapshot(interaction, instanceId) {
  const s = sanitizeForDashboard(interaction);
  if (!s) return null;
  s.instanceId = instanceId;
  if (s.response && !isLive(s)) s.response = { ...s.response, sseEvents: undefined };
  return summarizeForInit(s);
}

// One page of a session's history in summary form: the `limit` turns just
// before `beforeId` (or before the timestamp `before` when that turn is gone),
// oldest first, and whether still older ones exist.
function earlierPage(list, { beforeId, before, limit }) {
  let end = beforeId ? list.findIndex(i => i.id === beforeId) : -1;
  if (end < 0) {
    end = typeof before === 'number' ? list.findIndex(i => (i.timestamp || 0) >= before) : list.length;
    if (end < 0) end = list.length;
  }
  const n = Math.max(1, Math.min(EARLIER_PAGE_MAX, Number(limit) || 200));
  const start = Math.max(0, end - n);
  return { items: list.slice(start, end), hasMore: start > 0 };
}


class DashboardBroadcaster {
  constructor(wss, store, opts = {}) {
    this.wss = wss;
    this.store = store;
    this.authToken = opts.authToken || null;
    this._proxyPort = opts.proxyPort || 3456;
    this.cliSessionManager = opts.cliSessionManager || null;
    this.mcpHandler = null; // Set externally by src/mcp/index.js
    this._pluginHandlers = [];
    this._broadcastListeners = new Set();

    // Built-in domain handlers (capability CRUD, CLI terminal, Claude sign-in)
    // registered via the same plugin registry MCP/rules/Pro-apps use.
    const capabilitiesHandler = require('./ws/capabilities-handler');
    const cliHandler = require('./ws/cli-handler');
    this.registerHandler(capabilitiesHandler.PREFIXES, capabilitiesHandler);
    this.registerHandler(cliHandler.PREFIXES, cliHandler);
    const claudeAuthHandler = require('./ws/claude-auth-handler');
    this.registerHandler(claudeAuthHandler.PREFIXES, claudeAuthHandler.create(this));

    this.sessions = new InspectorSessions({
      store, broadcaster: this, getInstances, removeInstances,
      cliSessionManager: this.cliSessionManager,
      getPricing: (model) => caps.getModelPricing(DATA_HOME, model),
      ...opts.sessions,
    });

    this.wss.on('connection', (ws) => {
      // Instances whose content this browser has open (inspector tabs).
      ws.inspectorSubs = new Set();
      // The session cards only; a session's interactions follow when its tab
      // opens (inspector:subscribe).
      ws.send(JSON.stringify({ ...this.sessions.summaryMessage(), type: 'init' }));

      // Send settings
      let mcpServers = [];
      try { mcpServers = require('./mcp/servers').listTools(); } catch {}
      ws.send(JSON.stringify({
        type: 'chat:settings',
        tabId: 'tab-1',
        cwd: process.cwd(),
        knownSkills: caps.KNOWN_SKILLS,
        hookEvents: caps.HOOK_EVENTS,
        matcherEvents: caps.MATCHER_EVENTS,
        mcpServers,
      }));
      // Send skills, agents, hooks for capabilities tab
      ws.send(JSON.stringify({ type: 'skill:list', skills: caps.listSkills(PROJECT_ROOT) }));
      ws.send(JSON.stringify({ type: 'agent:list', agents: caps.listAgents(PROJECT_ROOT) }));
      ws.send(JSON.stringify({ type: 'hook:list', hooks: caps.listHooks(PROJECT_ROOT) }));
      ws.send(JSON.stringify({ type: 'model:list', models: caps.listModels(PROJECT_ROOT) }));
      ws.send(JSON.stringify({ type: 'provider:list', providers: caps.listProviders(PROJECT_ROOT) }));
      ws.send(JSON.stringify({
        type: 'prefs:claudeAuth',
        pref: caps.getClaudeAuthPref(PROJECT_ROOT) || null,
        hasSubscription: caps.hasClaudeSubscription(),
        hasApiKey: !!caps.getAnthropicApiKey(PROJECT_ROOT),
      }));
      ws.send(JSON.stringify({
        type: 'prefs:cliModel',
        model: caps.getCliModelPref(PROJECT_ROOT),
        aliases: caps.CLI_MODEL_ALIASES,
        fallbackEngine: caps.getFallbackEnginePref(PROJECT_ROOT),
      }));

      // Send running Claude process count and instance list
      ws.send(JSON.stringify({ type: 'claude:count', count: getActiveProcessCount() }));
      ws.send(JSON.stringify({ type: 'claude:instances', instances: getInstances(), count: getActiveProcessCount() }));

      // MCP Server Manager init
      if (this.mcpHandler) this.mcpHandler.onConnect(ws);
      // Rule handler init
      if (this.ruleHandler) this.ruleHandler.onConnect(ws);
      // Plugin handlers init
      for (const { handler } of this._pluginHandlers) {
        if (handler.onConnect) handler.onConnect(ws);
      }

      // CLI tabs init — send tab metadata only; scrollback is loaded on demand
      if (this.cliSessionManager) {
        ws.send(JSON.stringify({
          type: 'cli:tabs',
          bootId: this.cliSessionManager.bootId,
          tabs: this.cliSessionManager.list(),
          // Only on the initial send: tabs the startup restore could not bring
          // back, so the client can say what went missing rather than letting
          // them disappear silently.
          droppedTabs: this.cliSessionManager.droppedTabs || [],
        }));
      }

      // Questions still waiting for an answer (a new-CLI mode choice, an MCP
      // AskUserQuestion): a reloaded or newly opened dashboard shows them again
      // instead of leaving the asker waiting on a form nobody can see.
      for (const pending of pendingQuestions.values()) {
        if (pending.message) ws.send(JSON.stringify(pending.message));
      }

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          const tabId = msg.tabId || 'tab-1';
          if (msg.type === 'claude:killInstance') {
            if (msg.instanceId) killInstance(msg.instanceId);
          } else if (msg.type === 'inspector:subscribe') {
            if (typeof msg.instanceId === 'string' && msg.instanceId) this.subscribe(ws, msg.instanceId);
          } else if (msg.type === 'inspector:getEarlier') {
            if (typeof msg.instanceId === 'string' && msg.instanceId) this.sendEarlier(ws, msg);
          } else if (msg.type === 'inspector:unsubscribe') {
            ws.inspectorSubs.delete(msg.instanceId);
          } else if (msg.type === 'inspector:clearKind') {
            if (['cli', 'app', 'ext'].includes(msg.kind)) this.sessions.clearKind(msg.kind);
          } else if (msg.type === 'inspector:setAutoClear') {
            this.sessions.setAutoClear(!!msg.value);
          } else if (msg.type === 'inspector:getSessionTotals') {
            // CLI tab ids are cli-<session dir>. Later progress and every new
            // turn arrive as inspector:sessionTotals while the tab is open.
            const m = /^cli-([0-9a-f-]{36})$/i.exec(msg.instanceId || '');
            const totals = m ? this.store.totals.get(m[1]) : null;
            ws.send(JSON.stringify({ type: 'inspector:sessionTotals', instanceId: msg.instanceId, totals }));
          } else if (msg.type === 'inspector:setSensitiveHeaders') {
            createProxyRouter._showSensitiveHeaders = !!msg.value;
            this.broadcast({ type: 'inspector:sensitiveHeaders', value: !!msg.value });
          } else if (msg.type === 'interaction:getDetail') {
            const interaction = this.store.get(msg.id);
            if (interaction) {
              const s = sanitizeForDashboard(interaction);
              if (s.response) s.response = { ...s.response, sseEvents: undefined };
              ws.send(JSON.stringify({ type: 'interaction:detail', id: msg.id, interaction: s }));
            } else {
              ws.send(JSON.stringify({ type: 'interaction:detail', id: msg.id, interaction: null }));
            }
          } else if (msg.type === 'interaction:getSseEvents') {
            const interaction = this.store.get(msg.id);
            if (interaction) {
              ws.send(JSON.stringify({
                type: 'interaction:sseEvents',
                id: msg.id,
                sseEvents: interaction.response?.sseEvents || [],
              }));
            }
          } else if (msg.type === 'ask:answer') {
            // Resolve a pending AskUserQuestion
            const pending = pendingQuestions.get(msg.toolUseId);
            if (pending?.resolve) {
              let answer = msg.answer;
              // Process file uploads if present
              if (msg.files?.length && Array.isArray(answer)) {
                answer = processUploadedFiles(msg.toolUseId, msg.files, answer);
              }
              pending.resolve(answer);
              this.broadcast({ type: 'ask:answered', askId: msg.toolUseId });
            }
          // --- MCP Tools ---
          } else if (msg.type === 'mcp:bridge:call') {
            // Bridge reporting a tool call for inspector logging
            if (this.mcpHandler?.handleBridgeReport) this.mcpHandler.handleBridgeReport(msg);
          } else if (msg.type.startsWith('rule:')) {
            if (this.ruleHandler) this.ruleHandler.handleMessage(ws, msg, this);
          } else if (this._dispatchPlugin(ws, msg)) {
            // Handled by plugin
          } else if (msg.type.startsWith('mcp:')) {
            if (this.mcpHandler) this.mcpHandler.handleMessage(ws, msg, this);
          }
        } catch (err) { console.error('WS message handling error:', err); }
      });
    });
  }

  registerHandler(prefix, handler) {
    const prefixes = Array.isArray(prefix) ? prefix : [prefix];
    for (const p of prefixes) this._pluginHandlers.push({ prefix: p, handler });
  }

  _dispatchPlugin(ws, msg) {
    let best = null;
    for (const p of this._pluginHandlers) {
      if (msg.type.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) {
        best = p;
      }
    }
    if (!best) return false;
    best.handler.handleMessage(ws, msg, this);
    return true;
  }

  // Observe every outbound broadcast in-process (add-ons use this to react to
  // events like ask:question without a WS client). Returns an unsubscribe fn.
  onBroadcast(fn) {
    this._broadcastListeners.add(fn);
    return () => this._broadcastListeners.delete(fn);
  }

  // Open a session for one browser: subscribe first, then send the snapshot,
  // in the same tick. Every live event broadcast after this point reaches the
  // browser after the snapshot, none before it, so a turn opened mid-stream is
  // neither lost nor doubled (the browser also dedupes by id).
  subscribe(ws, instanceId) {
    ws.inspectorSubs.add(instanceId);
    const all = this._sessionInteractions(instanceId);
    const interactions = all.slice(-SNAPSHOT_LIMIT)
      .map(i => forSnapshot(i, instanceId)).filter(Boolean);
    ws.send(JSON.stringify({
      type: 'inspector:snapshot', instanceId, interactions, hasMore: all.length > SNAPSHOT_LIMIT,
    }));
  }

  _sessionInteractions(instanceId) {
    const sessId = this.store.sessionMap.get(instanceId)
      || this.sessions.sessions.get(instanceId)?.sessId
      || (/^cli-([0-9a-f-]{36})$/i.exec(instanceId) || [])[1];
    return this.store.sessionInteractions(instanceId, sessId);
  }

  // "Load earlier" in an inspector tab: the page of summaries before the
  // oldest turn the browser holds.
  sendEarlier(ws, msg) {
    const instanceId = msg.instanceId;
    const { items, hasMore } = earlierPage(this._sessionInteractions(instanceId), msg);
    ws.send(JSON.stringify({
      type: 'inspector:earlier', instanceId, beforeId: msg.beforeId || null,
      interactions: items.map(i => forSnapshot(i, instanceId)).filter(Boolean), hasMore,
    }));
  }

  // The instance a session-scoped message belongs to. External clients carry
  // no instance of their own; their turns go under 'ext' (proxy.js names a
  // Claude Code session ext-<id> where its requests say which).
  _instanceOf(message) {
    if (message.instanceId !== undefined) return message.instanceId || 'ext';
    if (message.interaction) return message.interaction.instanceId || 'ext';
    return this.store.interactions.get(message.interactionId)?.instanceId || 'ext';
  }

  broadcast(message) {
    for (const fn of this._broadcastListeners) {
      try { fn(message); } catch (err) { console.error('broadcast listener error:', err); }
    }
    const scoped = SESSION_SCOPED.has(message.type) ? this._instanceOf(message) : null;
    if (message.type === 'inspector:sessionsRemoved') {
      for (const client of this.wss.clients) {
        for (const id of message.instanceIds || []) client.inspectorSubs?.delete(id);
      }
    }
    let out = forClients(message);
    if (scoped && message.interaction && !message.interaction.instanceId) {
      out = { ...out, interaction: { ...out.interaction, instanceId: scoped } };
    }
    const data = JSON.stringify(out);
    for (const client of this.wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (scoped && !client.inspectorSubs?.has(scoped)) continue;
      try {
        client.send(data);
      } catch (err) { console.error('WS broadcast error:', err); }
    }
  }
}

module.exports = DashboardBroadcaster;
module.exports.summarizeForInit = summarizeForInit;
module.exports.earlierPage = earlierPage;
module.exports.SNAPSHOT_LIMIT = SNAPSHOT_LIMIT;
