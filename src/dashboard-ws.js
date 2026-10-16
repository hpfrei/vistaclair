const WebSocket = require('ws');
const { sanitizeForDashboard, getActiveProcessCount, getInstances, killInstance, removeInstances, processUploadedFiles, DATA_HOME } = require('./utils');
const createProxyRouter = require('./proxy');
const { pendingQuestions } = createProxyRouter;
const caps = require('./capabilities');
const { InspectorSessions } = require('./inspector-sessions');

const PROJECT_ROOT = DATA_HOME;

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
      s.request._lastMessage = last ? { role: last.role, hasText } : null;
      delete s.request.messages;
    }
    if (s.request.tools) {
      s.request._toolCount = s.request.tools.length;
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
  // A provider-translated turn carries its own copy of the whole request.
  delete s.translatedBody;
  s._summary = true;
  return s;
}

// Browsers already hold each stream event (sent one by one as sse_event) and
// keep their own copy when an interaction updates, so the finished list is
// dead weight on the wire. In-process listeners still get the full message.
function forClients(message) {
  if ((message.type !== 'interaction:complete' && message.type !== 'interaction:update')
      || !message.interaction?.response?.sseEvents) return message;
  const { interaction } = message;
  return { ...message, interaction: { ...interaction, response: { ...interaction.response, sseEvents: undefined } } };
}

// Messages that belong to one session's content: a browser gets them only for
// the sessions it has open (inspector:subscribe).
const SESSION_SCOPED = new Set([
  'interaction:start', 'interaction:update', 'interaction:complete', 'interaction:error',
  'interaction:enriched', 'sse_event', 'inspector:turnsDeleted', 'inspector:sessionTotals',
]);

// A turn as a freshly opened tab gets it: the summary shape (src/inspector.js
// refetches detail on select), except a turn still streaming keeps the events
// so far, since the rest arrive one by one as sse_event.
function forSnapshot(interaction, instanceId) {
  const s = sanitizeForDashboard(interaction);
  if (!s) return null;
  s.instanceId = instanceId;
  const live = s.status === 'pending' || s.status === 'streaming';
  if (s.response && !live) s.response = { ...s.response, sseEvents: undefined };
  return live ? s : summarizeForInit(s);
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
    const sessId = this.store.sessionMap.get(instanceId)
      || this.sessions.sessions.get(instanceId)?.sessId
      || (/^cli-([0-9a-f-]{36})$/i.exec(instanceId) || [])[1];
    const interactions = this.store.sessionInteractions(instanceId, sessId)
      .map(i => forSnapshot(i, instanceId)).filter(Boolean);
    ws.send(JSON.stringify({ type: 'inspector:snapshot', instanceId, interactions }));
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
