// Agent SDK sessions: the third session kind (`kind: 'sdk'`, settings.engine
// 'sdk'). The same Claude Code binary as a CLI tab, driven through
// @anthropic-ai/claude-agent-sdk's query() instead of a PTY, billed to the API
// key or the Claude subscription (settings.auth), shown in the dashboard's SDK
// panel instead of a terminal.
//
//   surface        what CliSessionManager, orchestration.js and
//                  session-control.js use on a CliSession (sessId, instanceId,
//                  settings, busy, running, spawn, kill, submit, interrupt, …).
//                  write / writeWhenReady keep the PTY contract for old
//                  callers: typed text is buffered, '\r' submits it, Esc
//                  interrupts.
//   options        one mapping from the tab's settings, built by the same
//                  helpers as the CLI flags (cli-session.js): the appended
//                  system prompt, --settings, the MCP servers, the env
//                  (buildClaudeEnv, auth forced to settings.auth's credential).
//   input          an async queue of SDKUserMessages: submit() pushes one
//                  (text + base64 images, optional priority now|next|later),
//                  stamped with a uuid the CLI echoes back (--replay-user-
//                  messages) when it takes the message into a turn.
//   events         every SDK message is broadcast as
//                  `sdk:event { sessId, runId?, ev: { sdk } }`; the platform adds
//                  `{ user }` (a submitted turn) and `{ platform }` (status,
//                  notice, inter-agent message, files). The owner's own turn
//                  is `{ user: { id, text, images, pending: true } }` when
//                  submitted, then `{ user: { id, text, images } }` when the
//                  CLI echoes it (or, from a CLI that never echoes, at the
//                  next turn's init or result), or `{ user: { id, cancelled:
//                  true, reason } }` when it will never run; the echo itself
//                  is not broadcast. A platform or peer turn (`from`) is one
//                  `{ user }` at submit, as before. Everything but
//                  stream_event deltas and `files` signals is appended to
//                  <sessionDir>/transcript.jsonl, which sdk:history replays
//                  after a reload or restart.
//   status         `{ platform: { kind: 'status', state, costUsd, model,
//                  actualModel, mappedTo, context? } }`: the chosen model (setModel
//                  switches it live), the model the last main-agent reply came
//                  from (cleared by a switch), and the tab's modelMap target for its family. The
//                  cost of a resume starts from the last one its transcript
//                  recorded and never goes below it. `context` ({ tokens,
//                  window, compactAt }, once a main-agent reply has counted
//                  it): the main agent's context from each reply's usage, the
//                  window from the turn's modelUsage, both corrected at the
//                  end of a turn by getContextUsage (summary: no API call),
//                  which also names the auto-compact threshold.
//   files          `{ platform: { kind: 'files', todo, notes } }` when a
//                  main-agent tool call that wrote the folder's TODO.md /
//                  NOTES.md has returned: the panel re-reads them (sdk:todo).
//   exit           the query ending (or kill) broadcasts the same `cli:exit`
//                  a PTY exit does, so the manager's exit callbacks and
//                  listeners (Pro's addExitHook, orchestration) fire alike.
//
// The SDK is a hard requirement of core: loaded once with import() when this
// module is required; server.js awaits `ready` before any session can spawn.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const caps = require('./capabilities');
const { buildClaudeEnv, trackInstance, DATA_HOME } = require('./utils');
const { buildAppendSystemPrompt, buildMcpServers, writeInternalJson, DEFAULT_SETTINGS } = require('./cli-session');
const { modelFamily } = require('./proxy');

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

let sdk = null;
const ready = import(SDK_PACKAGE).then(
  (m) => { sdk = m; return m; },
  (e) => { throw new Error(`${SDK_PACKAGE} failed to load (${e.message}). It is a required dependency of core: run npm install.`); },
);
ready.catch(() => {});   // reported by whoever awaits it (server boot)

// Claude Code's own cross-session messaging is replaced by the orchestrator
// MCP server's tools of the same names (lib/orchestrator-mcp.js).
const DISALLOWED_TOOLS = ['SendMessage', 'ListAgents'];
const SETTING_SOURCES = ['user', 'project', 'local'];

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_BYTES = 18 * 1024 * 1024;
const PRIORITIES = new Set(['now', 'next', 'later']);
const HISTORY_LIMIT = 5000;            // envelopes replayed by sdk:history
const STDERR_TAIL = 4096;
const TAIL_BYTES = 256 * 1024;         // transcript tail read for a resume's cost and stale input
const MODEL_RE = /^[A-Za-z0-9._-]+(\[1m\])?$/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function uploadUrl(sessId, name) {
  return `/api/sdk/upload?sessId=${encodeURIComponent(sessId)}&name=${encodeURIComponent(name)}`;
}

function safeName(name) {
  const s = path.basename(String(name || 'image').replace(/\\/g, '/')).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^[._]+/, '');
  return s.slice(0, 80) || 'image';
}

// The `claude` a CLI tab runs is whatever PATH resolves; the SDK gets the same
// file, so both engines run the same Claude Code version.
function resolveClaudeBinary(envPath) {
  for (const dir of String(envPath || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'claude');
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch {}
  }
  throw new Error('the `claude` CLI is not on PATH');
}

// A request's cost from its usage and the proxy's pricing (the Inspector's
// computeCost).
function requestCost(usage, pricing) {
  const per = (tokens, rate) => (tokens || 0) * (rate || 0) / 1e6;
  return per(usage.input_tokens, pricing.inputCostPerMTok)
    + per(usage.output_tokens, pricing.outputCostPerMTok)
    + per(usage.cache_read_input_tokens, pricing.cacheReadCostPerMTok || pricing.inputCostPerMTok)
    + per(usage.cache_creation_input_tokens, pricing.cacheCreateCostPerMTok || pricing.inputCostPerMTok);
}

// The context a request sent: everything on its input side.
function contextTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  return n > 0 ? n : null;
}

// The main agent's context window from a result's modelUsage (keyed by model,
// subagents' models included): the entry of the model that answered, else
// the only one. Without either, a chosen `[1m]` model is a million tokens
// (the answering model's id never carries the suffix).
function contextWindowOf(modelUsage, answered, chosen) {
  const bare = (m) => String(m || '').replace(/\[1m\]$/i, '').replace(/^claude-/, '');
  const entries = Object.entries(modelUsage || {}).filter(([, u]) => u?.contextWindow > 0);
  const hit = answered && entries.find(([k, u]) => bare(k) === bare(answered) || bare(u.canonicalModel) === bare(answered));
  if (hit) return hit[1].contextWindow;
  if (entries.length === 1) return entries[0][1].contextWindow;
  return /\[1m\]$/i.test(String(chosen || '')) ? 1000000 : null;
}

// The session's transcript file (envelopes, one per line).
function transcriptFile(dir) {
  return path.join(dir, 'transcript.jsonl');
}

// Read a transcript for replay: the last `limit` envelopes. A folder outlives a
// session id (a fresh restart keeps the folder), so image URLs are re-keyed to
// the session asking.
function readTranscript(dir, { sessId, limit = HISTORY_LIMIT } = {}) {
  let raw;
  try { raw = fs.readFileSync(transcriptFile(dir), 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  for (const line of lines.slice(-limit)) {
    let env;
    try { env = JSON.parse(line); } catch { continue; }
    if (sessId && env.ev?.user?.images?.length) {
      env.ev.user.images = env.ev.user.images.map(i => ({ ...i, url: uploadUrl(sessId, i.name) }));
    }
    out.push(env);
  }
  return out;
}

// The transcript's last bytes, whole lines only ('' when there is none).
function transcriptTail(dir) {
  let fd;
  let text = '';
  try {
    fd = fs.openSync(transcriptFile(dir), 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1);   // a cut first line
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
  return text;
}

// The cost a transcript recorded for one session id (status envelopes and
// results), from its tail only; 0 when there is none. Costs are cumulative, so
// the highest wins: a resume made before the floor existed logged a 0 status.
function recordedCost(dir, sessId) {
  const text = transcriptTail(dir);
  let best = 0;
  for (const line of text.split('\n')) {
    if (!line.includes(sessId)) continue;
    let env;
    try { env = JSON.parse(line); } catch { continue; }
    if (env.sessId !== sessId) continue;
    const ev = env.ev || {};
    const cost = ev.platform?.kind === 'status' ? ev.platform.costUsd
      : ev.sdk?.type === 'result' ? ev.sdk.total_cost_usd : undefined;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > best) best = cost;
  }
  return best;
}

// The owner's turns a transcript left waiting (pending, never delivered nor
// cancelled), from its tail: the spawn that took them is gone.
function stalePending(dir) {
  const open = new Set();
  for (const line of transcriptTail(dir).split('\n')) {
    if (!line.includes('"user"')) continue;
    let u;
    try { u = JSON.parse(line).ev?.user; } catch { continue; }
    if (!u?.id) continue;
    if (u.pending) open.add(u.id);
    else open.delete(u.id);
  }
  return [...open];
}

// A user turn's text, when the message is a prompt rather than tool results.
function promptText(message) {
  const c = message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c) || c.some(b => b?.type === 'tool_result')) return null;
  return c.filter(b => b?.type === 'text').map(b => b.text).join('\n');
}

// An async iterable the query reads its input from: push() hands a message to
// a waiting reader or queues it; close() ends the iteration.
class InputQueue {
  constructor() {
    this._items = [];
    this._waiters = [];
    this.closed = false;
  }

  push(item) {
    if (this.closed) return false;
    const w = this._waiters.shift();
    if (w) w({ value: item, done: false });
    else this._items.push(item);
    return true;
  }

  close() {
    this.closed = true;
    for (const w of this._waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this._items.length) return Promise.resolve({ value: this._items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(r => this._waiters.push(r));
      },
      return: () => { this.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

class SdkSession {
  // opts: authToken, dashboardPort (as CliSession); sdk ({ query,
  // getSessionMessages }) and claudeBin replace the real SDK and binary in tests.
  constructor(proxyPort, broadcaster, store, opts = {}) {
    this.proxyPort = proxyPort;
    this.broadcaster = broadcaster;
    this.store = store;
    this.cwd = null;
    this.tabId = null;
    this.kind = 'sdk';
    this.sessId = null;
    this._instanceId = null;
    this.title = null;
    this.settings = { ...DEFAULT_SETTINGS };
    this.status = 'idle';
    this.hidden = false;
    this.owner = null;
    this.busy = false;
    // busy | idle | awaiting (an AskUserQuestion is open) | paused | exited
    this.state = 'idle';
    this.costUsd = 0;
    this._costFloor = 0;      // a resume's carried-over cost: no result lowers it
    this._initModel = null;   // the model system/init reported
    this.actualModel = null;  // the model of the last main-agent reply
    this.context = { tokens: null, window: null, compactAt: null };   // the main agent's
    this._fileTools = new Map();   // tool_use id -> { todo, notes } it writes
    this._pending = new Map();     // the owner's turns not yet taken in: uuid -> { text, images }
    this._echoes = false;          // this spawn's CLI echoes taken-in turns
    this.autoMemory = false;
    this._authToken = opts.authToken || '';
    this._dashboardPort = opts.dashboardPort || 3457;
    this._sdk = opts.sdk || null;
    this._claudeBin = opts.claudeBin || null;
    this._spawnGen = 0;
    this._query = null;
    this._input = null;
    this._abort = null;
    this._typed = '';
    this._seeding = null;     // envelopes held back while a resume seeds the transcript
    this._exitState = null;
    this._awaiting = false;
    this._stderr = '';
    // Set by the manager: persists the busy flag in the open-tab manifest, and
    // settings changed in place (setModel) in the manifest and history.
    this.onStateChange = null;
    this.onSettingsChange = null;
  }

  get instanceId() {
    return this._instanceId;
  }

  get running() {
    return this.status === 'running' && this._query !== null;
  }

  get runId() {
    return this.settings.orchestration?.runId || null;
  }

  sessionDir() {
    return this.settings.sessionDir || (this.sessId ? path.join(DATA_HOME, 'interactions', this.sessId) : null);
  }

  uploadsDir() {
    const dir = this.sessionDir();
    return dir ? path.join(dir, 'uploads') : null;
  }

  spawn(cwd, cols, rows, { resumeSessionId, autoMemory } = {}) {
    const mod = this._sdk || sdk;
    if (!mod || typeof mod.query !== 'function') throw new Error(`${SDK_PACKAGE} is not loaded`);
    this._spawnGen++;
    if (this.running) this.kill();

    this.cwd = cwd;
    this.autoMemory = autoMemory === true;
    this.sessId = resumeSessionId || crypto.randomUUID();
    this._instanceId = `cli-${this.sessId}`;
    // Built before anything is registered: a missing API key or binary fails
    // the launch instead of leaving a dead session behind.
    const options = this._buildOptions({ resumeSessionId });

    this.status = 'running';
    this._exitState = null;
    this._awaiting = false;
    this._stderr = '';
    this._initModel = null;
    this.actualModel = null;
    this._fileTools.clear();
    this._echoes = false;
    // A resume carries its cost on (the forced idle status below shows it).
    this._costFloor = resumeSessionId && this.sessionDir() ? recordedCost(this.sessionDir(), this.sessId) : 0;
    this.costUsd = this._costFloor;
    this.store.registerSession(this.instanceId, this.sessId);
    // A live instance like a CLI tab's pty: the proxy applies its
    // instance-scoped rules (the AskUserQuestion rewrite, the tab's modelMap)
    // only to requests from a registered instance.
    this._instanceExit = trackInstance(this.instanceId, { kill: () => this.kill() }, { tabId: this.tabId }, cwd, this.autoMemory);

    if (resumeSessionId) {
      this._seedTranscript(mod, resumeSessionId);
    }
    // Turns a previous spawn left waiting (the server stopped under it) never
    // reach this one.
    if (this.sessionDir()) for (const id of stalePending(this.sessionDir())) this._cancelInput(id, 'ended');

    this._input = new InputQueue();
    this._query = mod.query({ prompt: this._input, options });
    this._setState('idle', { force: true });
    this._consume(this._spawnGen, this._query);

    this.broadcaster.broadcast({
      type: 'cli:spawned',
      tabId: this.tabId,
      instanceId: this.instanceId,
      cwd: this.cwd,
      title: this.title,
      settings: this.settings,
      autoMemory: this.autoMemory,
      hidden: this.hidden,
      kind: 'sdk',
    });

    writeInternalJson(this, {
      mode: 'sdk',
      resumed: !!resumeSessionId,
      resumedFrom: resumeSessionId || null,
      autoMemory: this.autoMemory,
    });
  }

  spawnShell() {
    throw new Error('an Agent SDK session has no shell');
  }

  // The query() options for this session's settings: the CLI flags of a tab
  // with the same settings, in the SDK's terms.
  _buildOptions({ resumeSessionId } = {}) {
    const s = this.settings;
    // The session's billing choice (settings.auth, from the New CLI form);
    // unset follows the global default: the subscription when one is active,
    // else the API key (the claudeAuth pref may say API key first).
    const { credential, key } = caps.resolveAuth(DATA_HOME, { authMode: s.auth || undefined });
    if (!credential) throw new Error('An Agent SDK session needs a Claude credential: add an Anthropic API key on the Models page, or log in to a Claude subscription with `claude /login`.');
    this._credential = credential;
    const env = buildClaudeEnv({
      proxyPort: this.proxyPort,
      dashboardPort: this._dashboardPort,
      authToken: this._authToken,
      instanceId: this.instanceId,
      extraEnv: { GIT_CEILING_DIRECTORIES: this.cwd, CLAUDE_AGENT_SDK_CLIENT_APP: 'vistaclair' },
      autoMemory: this.autoMemory,
      anthropicApiKey: key,
      subscriptionOnly: credential === 'subscription',
    });
    // No other credential may win over the chosen one: the key alone, or the
    // CLI's OAuth login alone.
    delete env.ANTHROPIC_AUTH_TOKEN;
    if (credential === 'api-key') delete env.CLAUDE_CODE_OAUTH_TOKEN;

    const append = buildAppendSystemPrompt(s);
    const options = {
      cwd: this.cwd,
      systemPrompt: s.systemPrompt
        ? { type: 'custom', prompt: `${s.systemPrompt}\n\n${append}` }
        : { type: 'preset', preset: 'claude_code', append },
      settingSources: [...SETTING_SOURCES],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      disallowedTools: [...DISALLOWED_TOOLS],
      includePartialMessages: true,
      // Subagents' text and thinking too, not only their tool calls.
      forwardSubagentText: true,
      // Claude Code offers AskUserQuestion only to a host with a permission
      // prompt surface. The proxy rewrites the model's call to the integrated
      // vista-AskUserQuestion (the dashboard modal), so this callback is only
      // reached by a call the proxy did not rewrite: refuse it.
      canUseTool: async (toolName) => ({ behavior: 'deny', message: `${toolName} is not available in this session.` }),
      env,
      pathToClaudeCodeExecutable: this._claudeBin || resolveClaudeBinary(env.PATH),
      abortController: (this._abort = new AbortController()),
      stderr: (d) => { this._stderr = (this._stderr + d).slice(-STDERR_TAIL); },
      // Echo each input message (isReplay, same uuid) as the CLI takes it
      // into a turn: the panel's "waiting" chip becomes the user's bubble.
      extraArgs: { 'replay-user-messages': null },
    };
    if (s.settingsFile) options.settings = s.settingsFile;
    const mcpServers = buildMcpServers({ settings: s, instanceId: this.instanceId, dashboardPort: this._dashboardPort, authToken: this._authToken });
    if (Object.keys(mcpServers).length) options.mcpServers = mcpServers;
    if (s.agents && typeof s.agents === 'object') options.agents = s.agents;
    if (s.model) options.model = s.model;
    if (s.effort) options.effort = s.effort;
    if (s.maxBudgetUsd) options.maxBudgetUsd = Number(s.maxBudgetUsd);
    if (s.maxTurns) options.maxTurns = Number(s.maxTurns);
    if (resumeSessionId) {
      options.resume = resumeSessionId;
    } else {
      options.sessionId = this.sessId;
      // The SDK's display title; --name's messaging address has no equivalent
      // (run members are addressed through orchestration's own registry).
      if (s.name) options.title = String(s.name);
    }
    return options;
  }

  // Read the query to its end. Only the current spawn reports its exit: a
  // respawn has already replaced it.
  async _consume(gen, q) {
    let exitCode = 0;
    try {
      for await (const msg of q) {
        if (gen !== this._spawnGen) break;
        this._onMessage(msg);
      }
    } catch (e) {
      if (gen === this._spawnGen && !this._abort?.signal.aborted) {
        exitCode = 1;
        const tail = this._stderr.trim().split('\n').slice(-5).join('\n');
        this.emitEvent({ platform: { kind: 'notice', level: 'error', text: `The Agent SDK session stopped: ${e.message}${tail ? `\n${tail}` : ''}` } });
      }
    }
    if (gen !== this._spawnGen) return;
    this._dropPending('ended');
    this._input?.close();
    this._query = null;
    this.store.unregisterSession(this.instanceId);
    this._instanceExit?.();
    this.status = 'exited';
    this._setState(this._exitState || 'exited', { force: true });
    this.broadcaster.broadcast({ type: 'cli:exit', tabId: this.tabId, exitCode });
  }

  _onMessage(msg) {
    // The echo of a message submit() pushed: it is in a turn now. Not
    // broadcast (it repeats the images' base64); the `{ user }` stands for it.
    if (msg?.type === 'user' && msg.isReplay) {
      this._echoes = true;
      this._deliver(msg.uuid);
      return;
    }
    this.emitEvent({ sdk: msg });
    if (!msg || typeof msg !== 'object') return;
    const main = !msg.parent_tool_use_id;
    // A CLI that does not echo: what was waiting is in the turn starting or
    // the one about to.
    if (main && !this._echoes && msg.type === 'result') this._deliverAll();
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (!this._echoes) this._deliverAll();
      const onKey = msg.apiKeySource === 'ANTHROPIC_API_KEY';
      if (msg.apiKeySource && onKey !== (this._credential === 'api-key')) {
        const want = this._credential === 'api-key' ? 'the API key' : 'the Claude subscription';
        this.emitEvent({ platform: { kind: 'notice', level: 'warning', text: `Claude Code reports its credential as "${msg.apiKeySource}", not ${want}.` } });
      }
      if (typeof msg.model === 'string' && msg.model !== this._initModel) {
        this._initModel = msg.model;
        if (!this.settings.model) this._emitStatus();
      }
    } else if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
      if (msg.state === 'idle') this._setState('idle');
      else if (msg.state === 'running') this._setState(this._awaiting ? 'awaiting' : 'busy');
      else if (msg.state === 'requires_action') this._setState('awaiting');
    } else if (msg.type === 'result') {
      const cost = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd
        : Object.values(msg.modelUsage || {}).reduce((n, u) => n + (u?.costUSD || 0), 0);
      // Cumulative for the query: the latest wins, but never below the cost a
      // resume carried over.
      if (Number.isFinite(cost)) this.costUsd = Math.max(cost, this._costFloor);
      const window = main ? contextWindowOf(msg.modelUsage, this.actualModel, this.settings.model || this._initModel) : null;
      if (window) this.context.window = window;
      this._setState(msg.queued_turn_count > 0 ? 'busy' : 'idle', { force: true });
      if (main) this._refreshContext();
    } else if (msg.type === 'assistant') {
      const model = main ? msg.message?.model : null;
      const modelChanged = typeof model === 'string' && model !== '<synthetic>' && model !== this.actualModel;
      if (modelChanged) this.actualModel = model;
      if (main) this._noteFileTools(msg.message?.content);
      // One API reply arrives as one message per content block, each with the
      // same usage: only a new count is news.
      const tokens = main ? contextTokens(msg.message?.usage) : null;
      const contextChanged = tokens != null && tokens !== this.context.tokens;
      if (contextChanged) this.context.tokens = tokens;
      if (contextChanged && !this.context.window) this.context.window = contextWindowOf(null, null, this.settings.model || this._initModel);
      if (this.state === 'idle') this._setState('busy');
      else if (modelChanged || contextChanged) this._emitStatus();
    } else if (msg.type === 'system' && msg.subtype === 'compact_boundary' && main) {
      const post = msg.compact_metadata?.post_tokens;
      if (post > 0) { this.context.tokens = post; this._emitStatus(); }
    } else if (msg.type === 'user' && main) {
      this._fileToolsDone(msg.message?.content);
    }
  }

  // Remember the main agent's tool calls that write the folder's TODO.md or
  // NOTES.md: an edit tool on either file, or a Bash command naming it (by
  // its absolute path, or bare when the session runs in its folder).
  _noteFileTools(content) {
    const dir = this.sessionDir();
    if (!dir || !Array.isArray(content)) return;
    const todo = path.join(path.resolve(dir), 'TODO.md');
    const notes = path.join(path.resolve(dir), 'NOTES.md');
    const inDir = !!this.cwd && path.resolve(this.cwd) === path.resolve(dir);
    for (const b of content) {
      if (b?.type !== 'tool_use' || !b.id) continue;
      let hit = null;
      if (EDIT_TOOLS.has(b.name)) {
        const p = b.input?.file_path || b.input?.notebook_path;
        const file = typeof p === 'string' ? path.resolve(this.cwd || dir, p) : null;
        if (file === todo || file === notes) hit = { todo: file === todo, notes: file === notes };
      } else if (b.name === 'Bash' && typeof b.input?.command === 'string') {
        const cmd = b.input.command;
        const t = cmd.includes(todo) || (inDir && cmd.includes('TODO.md'));
        const n = cmd.includes(notes) || (inDir && cmd.includes('NOTES.md'));
        if (t || n) hit = { todo: t, notes: n };
      }
      if (hit) this._fileTools.set(b.id, hit);
    }
  }

  // The owner's turn `id` has been taken in (or is cancelled): its bubble, in
  // place of the waiting chip.
  _deliver(id) {
    const u = this._pending.get(id);
    if (!u) return;
    this._pending.delete(id);
    this.emitEvent({ user: { id, text: u.text, images: u.images } });
  }

  _deliverAll() {
    for (const id of [...this._pending.keys()]) this._deliver(id);
  }

  // reason: 'interrupted' (the interrupt cancelled it) | 'ended' (the
  // session stopped before taking it in).
  _cancelInput(id, reason) {
    this._pending.delete(id);
    this.emitEvent({ user: { id, cancelled: true, reason } });
  }

  _dropPending(reason) {
    for (const id of [...this._pending.keys()]) this._cancelInput(id, reason);
  }

  // Their results are in: tell the panel which file to re-read.
  _fileToolsDone(content) {
    if (!this._fileTools.size || !Array.isArray(content)) return;
    let todo = false;
    let notes = false;
    for (const b of content) {
      const hit = b?.type === 'tool_result' ? this._fileTools.get(b.tool_use_id) : null;
      if (!hit) continue;
      this._fileTools.delete(b.tool_use_id);
      todo = todo || hit.todo;
      notes = notes || hit.notes;
    }
    if (todo || notes) this.emitEvent({ platform: { kind: 'files', todo, notes } });
  }

  // Broadcast one envelope and keep it in the transcript (deltas and the
  // live-only `files` signal excepted).
  emitEvent(ev) {
    if (!this.sessId) return;
    const env = { sessId: this.sessId, ...(this.runId ? { runId: this.runId } : {}), ts: Date.now(), ev };
    this.broadcaster.broadcast({ type: 'sdk:event', ...env });
    if (ev.sdk?.type === 'stream_event' || ev.platform?.kind === 'files') return;
    if (this._seeding) { this._seeding.push(env); return; }
    this._append([env]);
  }

  _append(envs) {
    const dir = this.sessionDir();
    if (!dir || !envs.length) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(transcriptFile(dir), envs.map(e => JSON.stringify(e)).join('\n') + '\n');
    } catch (e) {
      console.error(`[sdk-session] transcript ${dir}: ${e.message}`);
    }
  }

  // A resume of a conversation the panel has never seen (it was a CLI tab):
  // seed the transcript from Claude Code's own, so the panel shows it.
  _seedTranscript(mod, resumeSessionId) {
    const dir = this.sessionDir();
    if (!dir || fs.existsSync(transcriptFile(dir)) || typeof mod.getSessionMessages !== 'function') return;
    const held = (this._seeding = []);
    const sessId = this.sessId;
    const done = (seed) => {
      if (this._seeding === held) this._seeding = null;
      this._append([...seed, ...held]);
    };
    Promise.resolve()
      .then(() => mod.getSessionMessages(resumeSessionId, { dir: this.cwd }))
      .then((msgs) => {
        const seed = [{ sessId, ts: Date.now(), ev: { platform: { kind: 'notice', text: 'Continued from an earlier session.' } } }];
        for (const m of Array.isArray(msgs) ? msgs : []) {
          const text = m.type === 'user' && !m.parent_tool_use_id ? promptText(m.message) : null;
          const ev = text != null
            ? { user: { text, images: [] } }
            : { sdk: { type: m.type, message: m.message, parent_tool_use_id: m.parent_tool_use_id ?? null, uuid: m.uuid, session_id: m.session_id } };
          seed.push({ sessId, ts: null, seeded: true, ev });
        }
        done(seed);
      }, (e) => {
        console.error(`[sdk-session] seeding ${resumeSessionId}: ${e.message}`);
        done([]);
      });
  }

  // State for the panel (and `busy` for the manifest and the pause flow).
  _setState(state, { force = false } = {}) {
    if (this.state === state && !force) return;
    const changed = this.state !== state;
    this.state = state;
    const busy = state === 'busy' || state === 'awaiting';
    const busyChanged = this.busy !== busy;
    this.busy = busy;
    if (changed || force) this._emitStatus();
    if (busyChanged) this.onStateChange?.(this);
  }

  // The status envelope: state, cost and the model picture.
  // One proxied request of a turn in progress (the main loop or a subagent):
  // its priced usage raises the cost shown until the turn's result replaces
  // it with the SDK's own total. A request landing while idle (after the
  // result) is already in that total.
  addRequestCost(usage, pricing) {
    if (!usage || !pricing || !this.running || this.state === 'idle') return;
    const usd = requestCost(usage, pricing);
    if (!(usd > 0)) return;
    this.costUsd += usd;
    this._emitStatus();
  }

  _emitStatus() {
    const model = this.settings.model || this._initModel || null;
    const family = model ? modelFamily(model) : null;
    const mappedTo = (family && this.settings.modelMap?.[family]) || null;
    const context = this.context.tokens != null ? { ...this.context } : undefined;
    this.emitEvent({ platform: { kind: 'status', state: this.state, costUsd: this.costUsd, model, actualModel: this.actualModel, mappedTo, ...(context ? { context } : {}) } });
  }

  // The end of a turn: the SDK's own count (its summary answers from the
  // last reply's usage and local estimates, without a token-count call),
  // with the effective window and the auto-compact threshold.
  _refreshContext() {
    const q = this._query;
    if (!q || typeof q.getContextUsage !== 'function') return;
    const gen = this._spawnGen;
    Promise.resolve().then(() => q.getContextUsage({ detail: 'summary' })).then((u) => {
      if (gen !== this._spawnGen || !u) return;
      const tokens = u.totalTokens > 0 ? u.totalTokens : this.context.tokens;
      const window = u.rawMaxTokens > 0 ? u.rawMaxTokens : u.maxTokens > 0 ? u.maxTokens : this.context.window;
      const compactAt = u.isAutoCompactEnabled && u.autoCompactThreshold > 0 ? u.autoCompactThreshold : null;
      const c = this.context;
      if (tokens === c.tokens && window === c.window && compactAt === c.compactAt) return;
      this.context = { tokens, window, compactAt };
      this._emitStatus();
    }, () => {});
  }

  // Switch the model: live on a running query (the next turn uses it), and in
  // the settings in any case, so a respawn or resume keeps it. Refused once
  // the session has exited (its saved entry is resumed instead).
  async setModel(model) {
    if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new Error(`invalid model ${JSON.stringify(model)}`);
    if (this.status === 'exited' || this.state === 'exited') throw new Error('this session has exited');
    if (this._query) await this._query.setModel(model);
    this.settings = { ...this.settings, model };
    this.actualModel = null; // unknown until the next reply
    // Another model may have another window; the end of its first turn tells.
    this.context = { ...this.context, window: contextWindowOf(null, null, model), compactAt: null };
    this.onSettingsChange?.(this);
    this._emitStatus();
    return { ok: true, model };
  }

  // Raise the carried-over cost (orchestration's run.json total for a
  // resumed member, when the transcript recorded less).
  seedCost(usd) {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= this._costFloor) return;
    this._costFloor = usd;
    if (this.costUsd < usd) {
      this.costUsd = usd;
      this._emitStatus();
    }
  }

  // An AskUserQuestion is waiting for the owner (/api/ask).
  setAwaiting(on) {
    this._awaiting = !!on;
    if (!this.running) return;
    if (on) this._setState('awaiting');
    else if (this.state === 'awaiting') this._setState('busy');
  }

  // Closed by a completed pause (session-control finalize): its exit reads
  // "paused", not "exited".
  notePaused() {
    this._exitState = 'paused';
  }

  // One user turn. opts: priority 'now' | 'next' | 'later' (unset: the SDK's
  // default), images [{ mediaType, base64, name? }] (saved under the session
  // folder's uploads/ and sent as image blocks), from (the sender, for a
  // platform or peer message). Throws when the session is not running or an
  // image is refused.
  submit(text, { priority, images, from } = {}) {
    if (!this.running || !this._input || this._input.closed) throw new Error('this session is not running');
    const body = String(text ?? '');
    const list = Array.isArray(images) ? images : [];
    if (!body.trim() && !list.length) throw new Error('nothing to send');
    if (priority != null && !PRIORITIES.has(priority)) throw new Error(`unknown priority ${priority}`);

    const decoded = list.map((img, i) => {
      const ext = IMAGE_TYPES[img?.mediaType];
      if (!ext) throw new Error(`image ${i + 1}: unsupported type ${img?.mediaType || '(none)'}`);
      const buf = Buffer.from(String(img.base64 || ''), 'base64');
      if (!buf.length) throw new Error(`image ${i + 1} is empty`);
      if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image ${i + 1} is over 8 MB`);
      return { img, ext, buf };
    });
    if (decoded.reduce((n, d) => n + d.buf.length, 0) > MAX_IMAGES_BYTES) throw new Error('the images are over 18 MB together');

    const saved = [];
    if (decoded.length) {
      const dir = this.uploadsDir();
      fs.mkdirSync(dir, { recursive: true });
      const stamp = Date.now();
      decoded.forEach((d, i) => {
        const base = safeName(d.img.name).replace(/\.[a-zA-Z0-9]+$/, '');
        const name = `${stamp}-${i + 1}-${base}.${d.ext}`;
        fs.writeFileSync(path.join(dir, name), d.buf);
        saved.push({ name, url: uploadUrl(this.sessId, name) });
      });
    }

    const content = [
      ...decoded.map(d => ({ type: 'image', source: { type: 'base64', media_type: d.img.mediaType, data: d.buf.toString('base64') } })),
      ...(body ? [{ type: 'text', text: body }] : []),
    ];
    const id = crypto.randomUUID();
    const message = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid: id,
      ...(priority ? { priority } : {}),
    };
    // The owner's turn waits as a chip until the CLI takes it in; a platform
    // or peer turn is drawn (or skipped) at once, as it always was.
    if (from) {
      this.emitEvent({ user: { text: body, images: saved, from } });
    } else {
      this._pending.set(id, { text: body, images: saved });
      this.emitEvent({ user: { id, text: body, images: saved, pending: true } });
    }
    this._input.push(message);
    if (this.state === 'idle') this._setState('busy');
    return { ok: true, id, images: saved };
  }

  // A CLI that lists the queued turns its interrupt cancelled (the receipt's
  // `cancelled`): their chips say so instead of waiting on.
  async interrupt() {
    if (!this._query) return;
    try {
      const receipt = await this._query.interrupt();
      for (const id of Array.isArray(receipt?.cancelled) ? receipt.cancelled : []) {
        if (this._pending.has(id)) this._cancelInput(id, 'interrupted');
      }
    } catch (e) {
      this.emitEvent({ platform: { kind: 'notice', level: 'error', text: `Interrupt failed: ${e.message}` } });
    }
  }

  // The PTY contract, for callers that type: text is buffered until '\r'
  // submits it; Esc interrupts.
  write(data) {
    const s = String(data ?? '');
    if (s === '\x1b') { this.interrupt(); return; }
    for (const ch of s.split(/(\r)/)) {
      if (ch === '\r') {
        const text = this._typed;
        this._typed = '';
        if (text.trim()) { try { this.submit(text); } catch (e) { console.error(`[sdk-session] ${e.message}`); } }
      } else if (ch) {
        this._typed += ch;
      }
    }
  }

  writeWhenReady(data, timeoutMs, delayMs = 0) {
    if (delayMs > 0) setTimeout(() => this.write(data), delayMs);
    else this.write(data);
  }

  // No terminal: nothing to size.
  resize() {}
  resizeFrom() {}
  claim(ws) { this.owner = ws; }

  getScrollback() {
    return '';
  }

  kill() {
    const q = this._query;
    this._query = null;
    this._dropPending('ended');
    if (q || this._input) {
      this._input?.close();
      try { this._abort?.abort(); } catch {}
      try { q?.close?.(); } catch {}
    }
    this.status = 'idle';
  }

  // Replay for the panel (sdk:history).
  history({ limit } = {}) {
    const dir = this.sessionDir();
    return dir ? readTranscript(dir, { sessId: this.sessId, limit }) : [];
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
  }

  getSettings() {
    return { ...this.settings };
  }
}

// GET /api/sdk/upload?sessId=&name= — an image pasted into an SDK session,
// from its folder's uploads/. Mounted behind the dashboard's auth. Only names
// submit() could have written are served: no path parts, image types only.
function uploadRoute(mgr) {
  const types = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([mime, ext]) => [ext, mime]));
  return (req, res) => {
    const sessId = String(req.query.sessId || '');
    const name = String(req.query.name || '');
    const ext = (name.match(/\.([a-z]+)$/) || [])[1];
    if (!/^[0-9a-f-]{36}$/i.test(sessId) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(name) || !types[ext]) {
      return res.status(400).json({ error: 'bad request' });
    }
    const dir = mgr.sessionDirOf(sessId);
    if (!dir) return res.status(404).json({ error: 'not found' });
    const base = path.resolve(dir, 'uploads');
    const file = path.resolve(base, name);
    if (path.dirname(file) !== base) return res.status(400).json({ error: 'bad request' });
    fs.readFile(file, (err, buf) => {
      if (err) return res.status(404).json({ error: 'not found' });
      res.set({ 'Content-Type': types[ext], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=86400' });
      res.send(buf);
    });
  };
}

module.exports = SdkSession;
module.exports.uploadRoute = uploadRoute;
module.exports.ready = ready;
module.exports.readTranscript = readTranscript;
module.exports.transcriptFile = transcriptFile;
module.exports.recordedCost = recordedCost;
module.exports.resolveClaudeBinary = resolveClaudeBinary;
module.exports.DISALLOWED_TOOLS = DISALLOWED_TOOLS;
module.exports.SETTING_SOURCES = SETTING_SOURCES;
module.exports.IMAGE_TYPES = IMAGE_TYPES;
