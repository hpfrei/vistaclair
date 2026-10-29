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
//                  after a reload or restart. Each page carries `totals`
//                  ({ costUsd, compactions }) over the whole file.
//   status         `{ platform: { kind: 'status', state, costUsd, baseUsd?,
//                  model, actualModel, mappedTo, context? } }`: the chosen model (setModel
//                  switches it live), the model the last main-agent reply came
//                  from (cleared by a switch), and the tab's modelMap target for its family. The
//                  cost is the session folder's running total: every earlier
//                  session id's in it (baseUsd, a fresh restart's or an
//                  orchestrator refresh's predecessors) plus this id's own:
//                  what its transcript recorded, plus what each spawn's query
//                  spent since it started (costStart). `context` ({ tokens,
//                  window, compactAt, windowEstimated }, once a main-agent
//                  reply has counted it): the main agent's context from each
//                  reply's usage, the window from the turn's modelUsage, both
//                  corrected at the end of a turn by getContextUsage (summary:
//                  no API call), which also names the auto-compact threshold.
//                  Until a turn's end (a first turn, a model switch) the
//                  window is the model catalogue's, windowEstimated true.
//   files          `{ platform: { kind: 'files', todo, notes } }` when a
//                  main-agent tool call that wrote the folder's TODO.md /
//                  NOTES.md has returned: the panel re-reads them (sdk:todo).
//   billing        setAuth switches settings.auth ('apikey' | 'subscription').
//                  The credential is in the CLI's environment, so the query
//                  is replaced by a resume of the same session id (context
//                  and cost carry on, as after a pause): at once when idle,
//                  after the turn's end when busy (authPending in the status
//                  meanwhile); a pausing or ended session only keeps it in
//                  its settings. The status carries the `credential` in use.
//   usage limit    a turn the Claude subscription's usage limit stopped
//                  (usageLimitOf: a rejected rate_limit_event, Claude Code's
//                  own limit texts; never a transient 429) ends with
//                  `{ platform: { kind: 'usage-limit', text, resetsAt,
//                  apiKey } }`; setAuth('apikey', { continueTurn }) then
//                  continues the stopped turn on API credits.
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
const { buildClaudeEnv, trackInstance, disallowedToolsFor, DATA_HOME } = require('./utils');
const { buildAppendSystemPrompt, buildMcpServers, writeInternalJson, DEFAULT_SETTINGS } = require('./cli-session');
const { toolPackContributions, releaseToolPacks } = require('./tool-packs');
const { modelFamily } = require('./proxy');
const { notifyAuthFailed } = require('./ws/claude-auth-handler');

const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

let sdk = null;
const ready = import(SDK_PACKAGE).then(
  (m) => { sdk = m; return m; },
  (e) => { throw new Error(`${SDK_PACKAGE} failed to load (${e.message}). It is a required dependency of core: run npm install.`); },
);
ready.catch(() => {});   // reported by whoever awaits it (server boot)

// Claude Code's own cross-session messaging is replaced by the orchestrator
// MCP server's tools of the same names (lib/orchestrator-mcp.js). A run
// member also loses its role's tools (utils.disallowedToolsFor).
const DISALLOWED_TOOLS = ['SendMessage', 'ListAgents'];
const SETTING_SOURCES = ['user', 'project', 'local'];

const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_BYTES = 18 * 1024 * 1024;
const PRIORITIES = new Set(['now', 'next', 'later']);
const HISTORY_PAGE = 500;              // envelopes per sdk:history page, by default
const HISTORY_MAX = 5000;              // the most one page may ask for
const PAGE_CHUNK = 64 * 1024;          // a page is read backwards in chunks of this size
const STDERR_TAIL = 4096;
const TAIL_BYTES = 256 * 1024;         // transcript tail read for stale input
const MODEL_RE = /^[A-Za-z0-9._-]+(\[1m\])?$/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AUTHS = { apikey: 'api-key', subscription: 'subscription' };   // settings.auth -> credential
// Claude Code's texts for a usage limit genuinely reached: the SDK's
// USAGE_LIMIT_ERROR_PREFIXES when it exports them, else this copy (0.3.299).
const USAGE_LIMIT_PREFIXES = ["You've hit your", "You've reached your", "You're out of usage credits", 'Your org is out of usage · add funds to continue', 'Your org is out of usage · contact your admin', "Your seat type doesn't include usage credits", "Your seat type doesn't include usage", 'Your usage allocation has been disabled by your admin', "Your group's usage limit is set to $0", 'Fable 5 requires usage credits', "You're out of extra usage", "Your seat type doesn't include extra usage"];
const CONTINUE_TEXT = "[vistaclair] The Claude subscription's usage limit stopped your last turn before it was done. This session now runs on API credits: continue where you left off.";

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
// the only one; null without either.
function contextWindowOf(modelUsage, answered) {
  const bare = (m) => String(m || '').replace(/\[1m\]$/i, '').replace(/^claude-/, '');
  const entries = Object.entries(modelUsage || {}).filter(([, u]) => u?.contextWindow > 0);
  const hit = answered && entries.find(([k, u]) => bare(k) === bare(answered) || bare(u.canonicalModel) === bare(answered));
  if (hit) return hit[1].contextWindow;
  if (entries.length === 1) return entries[0][1].contextWindow;
  return null;
}

// Until a turn's end tells, the window the model catalogue gives: a chosen
// `[1m]` model is a million tokens (the answering model's id never carries
// the suffix), else the answering model's entry, else the chosen one's.
function estimatedWindow(answered, chosen) {
  if (/\[1m\]$/i.test(String(chosen || ''))) return 1000000;
  return caps.contextWindowFor(DATA_HOME, answered) || caps.contextWindowFor(DATA_HOME, chosen) || null;
}

// Whether a message says the Claude subscription's usage limit was reached:
// { text, resetsAt } (resetsAt in epoch seconds, or null), else null. Three
// forms: a rate_limit_event whose status is rejected with no extra usage to
// go on; an API error reply (assistant `error`) or an error result whose text
// is one of Claude Code's limit texts. A transient 429 or an overload (an
// api_retry, an error reply with another text) is not one.
function usageLimitOf(msg, prefixes = USAGE_LIMIT_PREFIXES) {
  if (!msg || typeof msg !== 'object') return null;
  const isLimit = (t) => typeof t === 'string' && prefixes.some(p => t.trimStart().startsWith(p));
  if (msg.type === 'rate_limit_event') {
    const i = msg.rate_limit_info || {};
    if (i.status !== 'rejected' || i.overageStatus === 'allowed' || i.overageStatus === 'allowed_warning') return null;
    return { text: null, resetsAt: Number.isFinite(i.resetsAt) ? i.resetsAt : null };
  }
  if (msg.type === 'assistant' && msg.error) {
    const c = msg.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
    return isLimit(text) ? { text: text.trim(), resetsAt: null } : null;
  }
  if (msg.type === 'result' && msg.is_error) {
    const text = [msg.result, ...(Array.isArray(msg.errors) ? msg.errors : [])].find(isLimit);
    return text ? { text: text.trim(), resetsAt: null } : null;
  }
  return null;
}

// The session's transcript file (envelopes, one per line).
function transcriptFile(dir) {
  return path.join(dir, 'transcript.jsonl');
}

// One page of a transcript for replay, read backwards from its end in chunks
// (never the whole file): the newest `limit` envelopes whose line starts
// before the byte offset `before` (none: the end), oldest first. The file is
// only ever appended to, so an offset names the same line for good: the
// page's `before` (the start of its oldest line) asks for the next older one,
// and `hasMore` says whether there is one. Bytes after the last newline are a
// line still being written and wait for the next read. Each envelope carries
// its line's offset as `off` (not on disk). A folder outlives a session id (a
// fresh restart keeps the folder), so image URLs are re-keyed to the session
// asking.
function readTranscriptPage(dir, { sessId, limit = HISTORY_PAGE, before = null } = {}) {
  limit = Math.min(HISTORY_MAX, Math.max(1, Math.floor(Number(limit)) || HISTORY_PAGE));
  const out = [];   // newest first
  let fd;
  let oldest = null;
  try {
    fd = fs.openSync(transcriptFile(dir), 'r');
    const size = fs.fstatSync(fd).size;
    let pos = before == null ? size : Math.min(size, Math.max(0, Math.floor(Number(before)) || 0));
    let pieces = [];        // the current line's bytes, from later reads
    let unfinished = true;  // the bytes after the last newline below the bound
    const take = (start, bufs) => {
      if (unfinished) { unfinished = false; return; }
      const line = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs);
      if (!line.length) return;
      let env;
      try { env = JSON.parse(line.toString('utf8')); } catch { return; }
      if (!env || typeof env !== 'object') return;
      env.off = start;
      out.push(env);
      oldest = start;
    };
    while (pos > 0 && out.length < limit) {
      const lo = Math.max(0, pos - PAGE_CHUNK);
      const buf = Buffer.alloc(pos - lo);
      fs.readSync(fd, buf, 0, buf.length, lo);
      let end = buf.length;
      for (let i = buf.length - 1; i >= 0 && out.length < limit; i--) {
        if (buf[i] !== 0x0a) continue;
        take(lo + i + 1, [buf.subarray(i + 1, end), ...pieces]);
        pieces = [];
        end = i;
      }
      if (out.length >= limit) break;
      pieces.unshift(buf.subarray(0, end));
      pos = lo;
    }
    if (pos === 0 && out.length < limit) take(0, pieces);
  } catch {
    // no transcript (yet): an empty page
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  out.reverse();
  if (sessId) {
    for (const env of out) {
      if (env.ev?.user?.images?.length) env.ev.user.images = env.ev.user.images.map(i => ({ ...i, url: uploadUrl(sessId, i.name) }));
    }
  }
  return { events: out, hasMore: oldest != null && oldest > 0, before: oldest };
}

// What an sdk:history reply carries for the caption, over the folder's whole
// transcript: { costUsd, compactions }. A live session's own running total
// may be ahead of its last status line.
function historyTotals(dir, live = null) {
  const t = transcriptTotals(dir);
  const costUsd = live && Number.isFinite(live.costUsd) ? Math.max(t.costUsd, live.costUsd) : t.costUsd;
  return { costUsd, compactions: t.compactions };
}

// The last `limit` envelopes of a transcript (readTranscriptPage's events).
function readTranscript(dir, opts = {}) {
  return readTranscriptPage(dir, opts).events;
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

// Whole-transcript totals for a session folder: what the panel's caption shows
// however little of the feed it loads. A folder outlives a session id (a
// resume keeps it, a fresh restart or an orchestrator refresh starts a new id
// in it), so its cost is every id's own cost added up: a status envelope's
// costUsd is the folder's running total and its baseUsd (absent before it
// existed: 0) what the other ids had cost when it spawned; a result's
// total_cost_usd is its query's own. Per id the highest wins: costs only
// grow, and a resume made before the floor existed logged a 0 status.
// compactions counts the main agent's compact_boundary envelopes, every id's.
// Cached per file and advanced over the bytes appended since (only lines that
// can matter are parsed); the file is only ever appended to.
const TOTALS_CHUNK = 1024 * 1024;
const TOTALS_KEEP = 200;               // folders whose totals stay cached
const totalsCache = new Map();         // transcript path -> { ino, pos, own: Map<sessId, usd>, compactions }

function noteTotals(t, env) {
  if (!env || typeof env !== 'object' || typeof env.sessId !== 'string') return;
  const ev = env.ev || {};
  let own;
  if (ev.platform?.kind === 'status') {
    const base = Number.isFinite(ev.platform.baseUsd) ? ev.platform.baseUsd : 0;
    own = Number.isFinite(ev.platform.costUsd) ? ev.platform.costUsd - base : undefined;
  } else if (ev.sdk?.type === 'result') {
    own = ev.sdk.total_cost_usd;
    if (typeof own === 'number' && Number.isFinite(own)) t.last.set(env.sessId, own);
  } else if (ev.sdk?.type === 'system' && ev.sdk.subtype === 'compact_boundary' && !ev.sdk.parent_tool_use_id) {
    t.compactions++;
  }
  if (typeof own === 'number' && Number.isFinite(own) && own > (t.own.get(env.sessId) || 0)) t.own.set(env.sessId, own);
}

// Whether a raw line can move the totals: the cheap test before JSON.parse.
const TOTALS_MARKS = ['"status"', '"result"', '"compact_boundary"'].map(s => Buffer.from(s));
function mayCount(buf) {
  return TOTALS_MARKS.some(m => buf.indexOf(m) !== -1);
}

// { costUsd, compactions, own(sessId) } for a folder's transcript; zeros when
// there is none.
function transcriptTotals(dir) {
  const file = transcriptFile(dir);
  let t = totalsCache.get(file);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const st = fs.fstatSync(fd);
    if (!t || t.ino !== st.ino || st.size < t.pos) t = { ino: st.ino, pos: 0, own: new Map(), last: new Map(), compactions: 0 };
    let rest = null;   // a line cut by the chunk's end
    while (t.pos + (rest ? rest.length : 0) < st.size) {
      const at = t.pos + (rest ? rest.length : 0);
      const buf = Buffer.alloc(Math.min(TOTALS_CHUNK, st.size - at));
      fs.readSync(fd, buf, 0, buf.length, at);
      const data = rest ? Buffer.concat([rest, buf]) : buf;
      let start = 0;
      for (let nl = data.indexOf(0x0a); nl !== -1; nl = data.indexOf(0x0a, start)) {
        const line = data.subarray(start, nl);
        if (mayCount(line)) { try { noteTotals(t, JSON.parse(line.toString('utf8'))); } catch {} }
        start = nl + 1;
      }
      t.pos += start;
      rest = start < data.length ? data.subarray(start) : null;
    }
  } catch (e) {
    if (!t || e.code === 'ENOENT') t = { ino: null, pos: 0, own: new Map(), last: new Map(), compactions: 0 };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  totalsCache.delete(file);
  totalsCache.set(file, t);
  if (totalsCache.size > TOTALS_KEEP) totalsCache.delete(totalsCache.keys().next().value);
  return summarizeTotals(t);
}

function summarizeTotals(t) {
  let costUsd = 0;
  for (const usd of t.own.values()) costUsd += usd;
  return { costUsd, compactions: t.compactions, own: (sessId) => t.own.get(sessId) || 0, lastResult: (sessId) => t.last.get(sessId) || 0 };
}

// Where a resumed spawn's query cost starts counting, from its first result
// (`first`, total_cost_usd), the priced usage of the spawn's requests until
// then (`priced`, 0 when none was priced) and the id's last recorded result
// (`prev`). A resumed Claude Code carries its session's earlier total on
// (2.1.308 does: same project or not, after a graceful end or an abort), so
// the spawn adds what is above `prev`; one that started again from 0 adds
// all of it. Carried on: the first result less what the spawn has spent is
// still most of `prev`, or (nothing priced) the first result is not below it.
function costStart(first, priced, prev) {
  if (!(prev > 0)) return 0;
  const carried = priced > 0 ? first - priced >= prev / 2 : first >= prev - 1e-9;
  return carried ? prev : 0;
}

// Envelopes just appended as bytes [from, to): a cache that had read up to
// `from` takes them in without reading them back.
function totalsAppended(dir, envs, from, to) {
  const t = totalsCache.get(transcriptFile(dir));
  if (!t || t.pos !== from) return;
  for (const env of envs) noteTotals(t, env);
  t.pos = to;
}

// The own cost a transcript recorded for one session id (its whole file); 0
// when there is none.
function recordedCost(dir, sessId) {
  return transcriptTotals(dir).own(sessId);
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
    this.costUsd = 0;         // the folder's running total: _costBase + this id's own
    this._costBase = 0;       // the folder's other session ids' cost, at spawn
    this._costFloor = 0;      // this id's own cost a resume carried over: no result lowers it
    this._costStart = 0;      // the spawn's query cost counts from here (null: its first result tells)
    this._costPrev = 0;       // the id's last recorded result, before this spawn
    this._spawnPriced = 0;    // the spawn's priced requests (addRequestCost)
    this._initModel = null;   // the model system/init reported
    this.actualModel = null;  // the model of the last main-agent reply
    this.context = { tokens: null, window: null, compactAt: null, windowEstimated: false };   // the main agent's
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
    this._credential = null;      // the spawn's: 'api-key' | 'subscription'
    this._authPending = null;     // a switch waiting for the turn's end: 'apikey' | 'subscription'
    this._continuePending = false; // ... and then continues a turn the usage limit stopped
    this._turnLimit = null;       // a usage-limit signal in the turn in progress
    this._limit = null;           // the last turn was stopped by it: { text, resetsAt }
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
    if (this.running) this.kill('respawn');
    this._releasePacks('respawn');

    this.cwd = cwd;
    this.autoMemory = autoMemory === true;
    this.sessId = resumeSessionId || crypto.randomUUID();
    this._instanceId = `cli-${this.sessId}`;
    // Built before anything is registered: a missing API key or binary fails
    // the launch instead of leaving a dead session behind.
    let options;
    try {
      options = this._buildOptions({ resumeSessionId });
    } finally {
      // The spawn's tool packs: released by its end (kill, exit), or now if refused.
      this._packs = this._builtPacks || null;
      this._builtPacks = null;
      if (!options) this._releasePacks('refused');
    }

    this.status = 'running';
    this._exitState = null;
    this._awaiting = false;
    this._stderr = '';
    this._initModel = null;
    this.actualModel = null;
    this._fileTools.clear();
    this._echoes = false;
    this._turnLimit = null;
    // The folder's cost so far carries on: a resume's own (the forced idle
    // status below shows it) on top of every other id's, a fresh restart's
    // every earlier id's.
    const totals = this.sessionDir() ? transcriptTotals(this.sessionDir()) : null;
    this._costFloor = resumeSessionId && totals ? totals.own(this.sessId) : 0;
    this._costBase = totals ? Math.max(0, totals.costUsd - totals.own(this.sessId)) : 0;
    this._costPrev = resumeSessionId && totals ? totals.lastResult(this.sessId) : 0;
    this._costStart = resumeSessionId ? null : 0;
    this._spawnPriced = 0;
    this.costUsd = this._costBase + this._costFloor;
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
    if (!credential) throw new Error('An Agent SDK session needs a Claude credential: add an Anthropic API key on the Models page, or sign in to a Claude subscription (Sign in to Claude, in the dashboard header).');
    this._credential = credential;
    this._authFailNotified = false;
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

    // Add-on tool packs (src/tool-packs.js), built once for this spawn.
    const mcpOpts = { settings: s, instanceId: this.instanceId, dashboardPort: this._dashboardPort, authToken: this._authToken, cwd: this.cwd, sessId: this.sessId };
    const packs = toolPackContributions(mcpOpts);
    this._builtPacks = packs;   // spawn takes it over
    const append = buildAppendSystemPrompt(s, packs);
    const options = {
      cwd: this.cwd,
      systemPrompt: s.systemPrompt
        ? { type: 'custom', prompt: `${s.systemPrompt}\n\n${append}` }
        : { type: 'preset', preset: 'claude_code', append },
      settingSources: [...SETTING_SOURCES],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      disallowedTools: disallowedToolsFor(s, DISALLOWED_TOOLS, packs.disallowedTools),
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
    const mcpServers = buildMcpServers(mcpOpts, packs);
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
    this._ended(exitCode);
  }

  // The current spawn is over: what a PTY exit reports.
  _ended(exitCode) {
    this._releasePacks('exit');
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
    const limit = usageLimitOf(msg, (this._sdk || sdk)?.USAGE_LIMIT_ERROR_PREFIXES || USAGE_LIMIT_PREFIXES);
    if (limit) this._turnLimit = { text: limit.text || this._turnLimit?.text || null, resetsAt: limit.resetsAt ?? this._turnLimit?.resetsAt ?? null };
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
      // Cumulative for the query: what it has spent since this spawn's start
      // (costStart) adds to the cost a resume carried over, so a carried-on
      // total is not counted twice and one restarted from 0 is not lost.
      if (Number.isFinite(cost)) {
        if (this._costStart == null) this._costStart = costStart(cost, this._spawnPriced, this._costPrev);
        this.costUsd = this._costBase + this._costFloor + Math.max(0, cost - this._costStart);
      }
      const window = main ? contextWindowOf(msg.modelUsage, this.actualModel) : null;
      if (window) this.context = { ...this.context, window, windowEstimated: false };
      if (main) this._noteTurnLimit();
      this._setState(msg.queued_turn_count > 0 ? 'busy' : 'idle', { force: true });
      if (main) this._refreshContext();
    } else if (msg.type === 'assistant') {
      // The CLI's login was refused (lapsed, signed out elsewhere): offer the
      // dashboard's sign-in rather than a terminal /login.
      if (msg.error === 'authentication_failed' && this._credential === 'subscription' && !this._authFailNotified) {
        this._authFailNotified = true;
        notifyAuthFailed(this.broadcaster, { sessId: this.sessId });
      }
      const model = main ? msg.message?.model : null;
      const modelChanged = typeof model === 'string' && model !== '<synthetic>' && model !== this.actualModel;
      if (modelChanged) this.actualModel = model;
      if (main) this._noteFileTools(msg.message?.content);
      // One API reply arrives as one message per content block, each with the
      // same usage: only a new count is news.
      const tokens = main ? contextTokens(msg.message?.usage) : null;
      const contextChanged = tokens != null && tokens !== this.context.tokens;
      if (contextChanged) this.context.tokens = tokens;
      // No exact window yet: the catalogue's, again once the answering model is known.
      if ((contextChanged && !this.context.window) || (modelChanged && this.context.windowEstimated)) {
        const window = estimatedWindow(this.actualModel, this.settings.model || this._initModel);
        if (window) this.context = { ...this.context, window, windowEstimated: true };
      }
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
  // live-only `files` signal excepted). The broadcast names the byte offset
  // its line will start at (`off`, as sdk:history pages do), so the panel can
  // ask for what came before it.
  emitEvent(ev) {
    if (!this.sessId) return;
    const env = { sessId: this.sessId, ...(this.runId ? { runId: this.runId } : {}), ts: Date.now(), ev };
    const kept = ev.sdk?.type !== 'stream_event' && ev.platform?.kind !== 'files';
    const off = kept && !this._seeding ? this._transcriptSize() : null;
    this.broadcaster.broadcast({ type: 'sdk:event', ...env, ...(off != null ? { off } : {}) });
    if (!kept) return;
    if (this._seeding) { this._seeding.push(env); return; }
    this._append([env]);
  }

  _transcriptSize() {
    const dir = this.sessionDir();
    if (!dir) return null;
    try { return fs.statSync(transcriptFile(dir)).size; } catch { return 0; }
  }

  _append(envs) {
    const dir = this.sessionDir();
    if (!dir || !envs.length) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const text = envs.map(e => JSON.stringify(e)).join('\n') + '\n';
      fs.appendFileSync(transcriptFile(dir), text);
      const to = fs.statSync(transcriptFile(dir)).size;
      totalsAppended(dir, envs, to - Buffer.byteLength(text), to);
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
    if (state === 'idle' && this._authPending) this._switchSoon();
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
    this._spawnPriced += usd;
    this.costUsd += usd;
    this._emitStatus();
  }

  _emitStatus() {
    const model = this.settings.model || this._initModel || null;
    const family = model ? modelFamily(model) : null;
    const mappedTo = (family && this.settings.modelMap?.[family]) || null;
    const context = this.context.tokens != null ? { ...this.context } : undefined;
    const base = this._costBase > 0 ? { baseUsd: this._costBase } : {};
    const billing = { credential: this._credential, ...(this._authPending ? { authPending: this._authPending } : {}), ...(this._limit ? { limited: true } : {}) };
    this.emitEvent({ platform: { kind: 'status', state: this.state, costUsd: this.costUsd, ...base, model, actualModel: this.actualModel, mappedTo, ...(context ? { context } : {}), ...billing } });
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
      const c = this.context;
      const exact = u.rawMaxTokens > 0 ? u.rawMaxTokens : u.maxTokens > 0 ? u.maxTokens : null;
      const window = exact || c.window;
      const windowEstimated = exact ? false : c.windowEstimated;
      const compactAt = u.isAutoCompactEnabled && u.autoCompactThreshold > 0 ? u.autoCompactThreshold : null;
      if (tokens === c.tokens && window === c.window && compactAt === c.compactAt && windowEstimated === c.windowEstimated) return;
      this.context = { tokens, window, compactAt, windowEstimated };
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
    // Another model may have another window: the catalogue's until the end
    // of its first turn tells.
    const window = estimatedWindow(null, model);
    this.context = { ...this.context, window, windowEstimated: !!window, compactAt: null };
    this.onSettingsChange?.(this);
    this._emitStatus();
    return { ok: true, model };
  }

  // Switch the billing (settings.auth: 'apikey' | 'subscription'), see the
  // header. Kept in the settings in any case, so a resume uses it; a running
  // session on another credential is resumed on this one, at once when idle
  // (and nothing waits to be taken in), else after its turn. continueTurn:
  // a turn the usage limit stopped goes on after the switch. Throws when the
  // credential is missing. Resolves { auth, applied: 'now' | 'pending' |
  // 'already' | 'saved' }.
  setAuth(auth, { continueTurn = false } = {}) {
    const want = AUTHS[auth];
    if (!want) throw new Error(`unknown billing ${JSON.stringify(auth)}`);
    const creds = caps.claudeCredentials(DATA_HOME);
    if (want === 'api-key' && !creds.apiKey) throw new Error('No Anthropic API key is stored: add one on the Models page.');
    if (want === 'subscription' && !creds.subscription) throw new Error('No Claude subscription is signed in: Sign in to Claude, in the dashboard header.');
    if (this.settings.auth !== auth) {
      this.settings = { ...this.settings, auth };
      this.onSettingsChange?.(this);
    }
    if (!this.running || this.pausing) {
      this._authPending = null;
      this._continuePending = false;
      return { auth, applied: 'saved' };
    }
    if (continueTurn) this._continuePending = true;
    if (this._credential === want) {
      const had = this._authPending;
      this._authPending = null;
      if (this._continuePending && !this.busy) this._continueLimited();
      else if (had) this._emitStatus();
      return { auth, applied: 'already' };
    }
    this._authPending = auth;
    if (this.state === 'idle' && !this._pending.size) {
      this._switchAuth();
      return { auth, applied: 'now' };
    }
    this._emitStatus();
    return { auth, applied: 'pending' };
  }

  // A pending switch: once the turn has ended (a result's state change runs
  // inside the query's loop, so the respawn waits for it to return).
  _switchSoon() {
    if (this._switchTimer) return;
    const gen = this._spawnGen;
    this._switchTimer = setImmediate(() => {
      this._switchTimer = null;
      if (gen !== this._spawnGen || !this._authPending) return;
      if (!this.running || this.pausing) { this._authPending = null; this._continuePending = false; return; }
      if (this.state !== 'idle' || this._pending.size) return;   // a next turn came first: its end
      this._switchAuth();
    });
  }

  // Replace the query with a resume of the same session id on the pending
  // billing: the pause/resume path, without the exit in between.
  _switchAuth() {
    const auth = this._authPending;
    this._authPending = null;
    try {
      this.spawn(this.cwd, 0, 0, { resumeSessionId: this.sessId, autoMemory: this.autoMemory });
    } catch (e) {
      // The old query is gone already: end as an exit would.
      this.emitEvent({ platform: { kind: 'notice', level: 'error', text: `The billing switch failed: ${e.message}` } });
      this._ended(1);
      return;
    }
    this.emitEvent({ platform: { kind: 'notice', text: `Billing switched to ${auth === 'apikey' ? 'API credits' : 'the Claude subscription'}: the conversation continues.` } });
    this.onSettingsChange?.(this);
    if (this._continuePending) this._continueLimited();
  }

  // A turn the usage limit stopped goes on (on the new credential).
  _continueLimited() {
    const stopped = this._limit;
    this._continuePending = false;
    this._limit = null;
    if (!stopped) { this._emitStatus(); return; }
    try { this.submit(CONTINUE_TEXT, { from: 'vistaclair' }); } catch (e) { console.error(`[sdk-session] ${e.message}`); }
  }

  // The end of a main turn: one the usage limit stopped (on the subscription)
  // says so in the feed, with what the owner can do about it.
  _noteTurnLimit() {
    const hit = this._turnLimit;
    this._turnLimit = null;
    if (!hit || this._credential !== 'subscription') { this._limit = null; return; }
    this._limit = hit;
    const apiKey = !!caps.claudeCredentials(DATA_HOME).apiKey;
    this.emitEvent({ platform: { kind: 'usage-limit', text: hit.text, resetsAt: hit.resetsAt, apiKey } });
  }

  // Raise the carried-over cost (orchestration's run.json total for a
  // resumed member, when the transcript recorded less). `usd` is a running
  // total like costUsd: what is above the base is this id's own.
  seedCost(usd) {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd - this._costBase <= this._costFloor) return;
    this._costFloor = usd - this._costBase;
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

  // `reason` reaches the tool packs' release (src/tool-packs.js).
  kill(reason = 'kill') {
    const q = this._query;
    this._query = null;
    this._dropPending('ended');
    if (q || this._input) {
      this._input?.close();
      try { this._abort?.abort(); } catch {}
      try { q?.close?.(); } catch {}
    }
    this.status = 'idle';
    this._releasePacks(reason);
  }

  // The current spawn's tool packs end (once; a later call is a no-op).
  _releasePacks(reason) {
    const packs = this._packs;
    this._packs = null;
    if (packs) releaseToolPacks(packs, reason);
  }

  // Replay for the panel (sdk:history): one page, see readTranscriptPage,
  // with the folder's totals (historyTotals).
  historyPage({ limit, before } = {}) {
    const dir = this.sessionDir();
    if (!dir) return { events: [], hasMore: false, before: null, totals: { costUsd: this.costUsd, compactions: 0 } };
    return { ...readTranscriptPage(dir, { sessId: this.sessId, limit, before }), totals: historyTotals(dir, this) };
  }

  history(opts) {
    return this.historyPage(opts).events;
  }

  updateSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    // A new model map rewrites the next request already (the proxy reads the
    // settings per request); the caption's "→ target" follows now.
    if (newSettings && 'modelMap' in newSettings && this.running) this._emitStatus();
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
module.exports.readTranscriptPage = readTranscriptPage;
module.exports.HISTORY_PAGE = HISTORY_PAGE;
module.exports.transcriptFile = transcriptFile;
module.exports.recordedCost = recordedCost;
module.exports.transcriptTotals = transcriptTotals;
module.exports.costStart = costStart;
module.exports.usageLimitOf = usageLimitOf;
module.exports.CONTINUE_TEXT = CONTINUE_TEXT;
module.exports.historyTotals = historyTotals;
module.exports.resolveClaudeBinary = resolveClaudeBinary;
module.exports.DISALLOWED_TOOLS = DISALLOWED_TOOLS;
module.exports.SETTING_SOURCES = SETTING_SOURCES;
module.exports.IMAGE_TYPES = IMAGE_TYPES;
