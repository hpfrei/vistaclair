const WebSocket = require('ws');
const { sanitizeForDashboard, getActiveProcessCount, getInstances, killInstance, removeInstances, processUploadedFiles, DATA_HOME } = require('./utils');
const createProxyRouter = require('./proxy');
const { pendingQuestions } = createProxyRouter;
const caps = require('./capabilities');

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
  s._summary = true;
  return s;
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

    // Built-in domain handlers (capability CRUD + CLI terminal) registered via
    // the same plugin registry MCP/rules/Pro-apps use.
    const capabilitiesHandler = require('./ws/capabilities-handler');
    const cliHandler = require('./ws/cli-handler');
    this.registerHandler(capabilitiesHandler.PREFIXES, capabilitiesHandler);
    this.registerHandler(cliHandler.PREFIXES, cliHandler);

    this.wss.on('connection', (ws) => {
      // At boot the store loads whichever session dirs were touched most
      // recently, which has nothing to do with the tabs that came back —
      // shipping all of it rebuilds inspector tabs for dead sessions, labelled
      // by cwd so they look like the real thing. Drop that carried-over history
      // unless its instance is still around; anything this process produced is
      // kept, so an exited ai.prompt run stays inspectable for the rest of the
      // run. Older sessions remain reachable through inspector:loadSession
      // (clicking a saved session) and inspector:loadAll.
      const live = this.liveInstanceIds();
      const interactions = this.store.getAll().map(i => {
        if (this.store.bootLoadedIds.has(i.id) && !live.has(i.instanceId)) return null;
        const s = sanitizeForDashboard(i);
        if (!s) return null;
        if (s.response) s.response = { ...s.response, sseEvents: undefined };
        return summarizeForInit(s);
      }).filter(Boolean);
      ws.send(JSON.stringify({ type: 'init', interactions }));

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

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          const tabId = msg.tabId || 'tab-1';
          if (msg.type === 'claude:killInstance') {
            if (msg.instanceId) killInstance(msg.instanceId);
          } else if (msg.type === 'inspector:clearInstances') {
            if (Array.isArray(msg.instanceIds) && msg.instanceIds.length > 0) {
              this.store.removeFromMemory(msg.instanceIds);
              removeInstances(msg.instanceIds);
              this.broadcast({ type: 'inspector:instancesCleared', instanceIds: msg.instanceIds });
            }
          } else if (msg.type === 'inspector:loadSession') {
            if (msg.sessId) {
              const loaded = this.store.loadSessionIntoMemory(msg.sessId);
              const interactions = loaded.map(i => {
                const s = sanitizeForDashboard(i);
                if (!s) return null;
                if (s.response) s.response = { ...s.response, sseEvents: undefined };
                return summarizeForInit(s);
              }).filter(Boolean);
              ws.send(JSON.stringify({
                type: 'inspector:sessionLoaded',
                sessId: msg.sessId,
                instanceId: `cli-${msg.sessId}`,
                interactions,
              }));
            }
          } else if (msg.type === 'inspector:loadAll') {
            const all = this.store.getAllFromDisk().map(i => {
              const s = sanitizeForDashboard(i);
              if (!s) return null;
              if (s.response) s.response = { ...s.response, sseEvents: undefined };
              return summarizeForInit(s);
            }).filter(Boolean);
            ws.send(JSON.stringify({ type: 'inspector:allLoaded', interactions: all }));
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

  // Instance ids that currently exist: registered inspector sessions (CLI tabs
  // and headless ai.prompt runs), live CLI tabs, and tracked child processes.
  // The three overlap; the union is what "not a dead session" means.
  liveInstanceIds() {
    const live = new Set(this.store.sessionMap.keys());
    for (const tab of this.cliSessionManager?.list() || []) {
      if (tab.instanceId) live.add(tab.instanceId);
    }
    for (const inst of getInstances()) {
      if (inst.instanceId) live.add(inst.instanceId);
    }
    return live;
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

  broadcast(message) {
    for (const fn of this._broadcastListeners) {
      try { fn(message); } catch (err) { console.error('broadcast listener error:', err); }
    }
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(data);
        } catch (err) { console.error('WS broadcast error:', err); }
      }
    }
  }
}

module.exports = DashboardBroadcaster;
