// Whole-session totals (turns, tool calls, tokens, cost, busy time) for the
// inspector footer. The store keeps only its newest maxSize interactions in
// memory and a long-running tab can hold a hundred thousand turns on disk, so
// the dashboard cannot add these up itself.
//
// One entry per turn file, keyed by its seq number: recording the same turn
// again (save() runs at start, complete and error) overwrites, never adds.
// Entries persist to <session dir>/totals.cache, one JSON array per line,
// last line per seq wins; the name keeps it out of every `*.json` scan. Turns
// the cache does not know yet are read by a worker thread, which parses only
// the tail of each file.
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const CACHE_FILE = 'totals.cache';
const WORKER = path.join(__dirname, 'session-totals-worker.js');

// What a turn file holds: a prompt the user sent (its UserPromptSubmit hook),
// any other hook, an MCP call, or a model API call.
const KIND_PROMPT = 'p', KIND_HOOK = 'h', KIND_MCP = 'm', KIND_API = 'a';

function kindOf(raw) {
  if (raw?.isHook) return raw.hookEvent === 'UserPromptSubmit' ? KIND_PROMPT : KIND_HOOK;
  return raw?.isMcp ? KIND_MCP : KIND_API;
}

// [seq, id, startedAt, duration, input, output, cacheRead, cacheCreate, cost, toolCalls, kind]
// cost is null when the turn has usage but no price.
function toEntry(seq, raw, getPricing) {
  const kind = kindOf(raw);
  const u = raw?.usage || null;
  const t = raw?.timing || null;
  let cost = null;
  if (u) {
    const p = raw.pricing || (raw.model && getPricing ? getPricing(raw.model) : null);
    if (p) {
      const ip = p.inputCostPerMTok || 0;
      cost = ((u.input_tokens || 0) * ip
        + (u.output_tokens || 0) * (p.outputCostPerMTok || 0)
        + (u.cache_read_input_tokens || 0) * (p.cacheReadCostPerMTok || ip)
        + (u.cache_creation_input_tokens || 0) * (p.cacheCreateCostPerMTok || ip)) / 1e6;
    }
  }
  return [
    seq, raw?.id || null, t?.startedAt || 0, t?.duration || 0,
    u?.input_tokens || 0, u?.output_tokens || 0,
    u?.cache_read_input_tokens || 0, u?.cache_creation_input_tokens || 0,
    // A hook's body is the tool's output, not a model's tool_use blocks.
    cost, kind === KIND_API ? raw?.tools || 0 : 0, kind,
  ];
}

function countToolUses(interaction) {
  const resp = interaction.response || {};
  let n = 0;
  if (Array.isArray(resp.body?.content)) {
    for (const b of resp.body.content) if (b?.type === 'tool_use') n++;
    return n;
  }
  for (const e of resp.sseEvents || []) {
    if (e?.eventType === 'content_block_start' && e.data?.content_block?.type === 'tool_use') n++;
  }
  return n;
}

class SessionTotals {
  /**
   * @param {string} interactionsDir  root holding one dir per session
   * @param {object} opts
   * @param {(model: string) => object|null} opts.getPricing  fallback for turns saved without a price
   * @param {(sessId: string, totals: object) => void} opts.onChange  fires (debounced) when a loaded session's totals move
   */
  constructor(interactionsDir, { getPricing, onChange, debounceMs = 1500 } = {}) {
    this.dir = interactionsDir;
    this.getPricing = getPricing || null;
    this.onChange = onChange || null;
    this.debounceMs = debounceMs;
    this.sessions = new Map(); // sessId → { entries: Map<seq, entry>, live: Set<seq>, scan, ready, timer }
  }

  _sessionDir(sessId) {
    return path.join(this.dir, sessId);
  }

  _cachePath(sessId) {
    return path.join(this.dir, sessId, CACHE_FILE);
  }

  /** Called from store.save() for every write of a turn file. */
  record(sessId, seq, interaction) {
    const s = this.sessions.get(sessId);
    // Not loaded yet: the scan will pick the file up when someone asks.
    if (!s || !Number.isFinite(seq)) return;
    const entry = toEntry(seq, {
      id: interaction.id,
      model: interaction.request?.model,
      usage: interaction.usage,
      pricing: interaction.pricing,
      timing: interaction.timing,
      tools: countToolUses(interaction),
      isHook: !!interaction.isHook,
      hookEvent: interaction.hookEvent || null,
      isMcp: !!interaction.isMcp,
    }, this.getPricing);
    // A scan batch read before this write must not overwrite it.
    s.live.add(seq);
    const line = JSON.stringify(entry);
    const prev = s.entries.get(seq);
    if (prev && JSON.stringify(prev) === line) return;
    s.entries.set(seq, entry);
    // Synchronous so a turn's lines land in the order they were recorded.
    try { fs.appendFileSync(this._cachePath(sessId), line + '\n'); s.lines++; } catch {}
    this._changed(sessId);
  }

  /**
   * Totals for a session, loading its cache and starting a scan for uncached
   * turns on first use. Returns what is known right now; `complete` is false
   * while the scan runs, and onChange reports progress and the final figure.
   */
  get(sessId) {
    if (!sessId || sessId.includes('/') || sessId.includes('\\') || sessId.startsWith('.')) return null;
    let s = this.sessions.get(sessId);
    if (!s) {
      const dir = this._sessionDir(sessId);
      try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
      s = { entries: new Map(), live: new Set(), lines: 0, scan: null, ready: false, timer: null };
      this.sessions.set(sessId, s);
      this._loadCache(sessId, s);
      this._scan(sessId, s);
    }
    return this._summarize(sessId, s);
  }

  forget(sessId) {
    const s = this.sessions.get(sessId);
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    if (s.scan?.worker) s.scan.worker.terminate().catch(() => {});
    this.sessions.delete(sessId);
  }

  _loadCache(sessId, s) {
    let text;
    try { text = fs.readFileSync(this._cachePath(sessId), 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      s.lines++;
      try {
        const e = JSON.parse(line);
        if (Array.isArray(e) && Number.isFinite(e[0])) s.entries.set(e[0], e);
      } catch {}
    }
  }

  _scan(sessId, s) {
    const worker = new Worker(WORKER, {
      workerData: { dir: this._sessionDir(sessId), sessId, known: [...s.entries.keys()] },
    });
    s.scan = { worker, total: 0, done: 0, found: [] };
    worker.on('message', (msg) => {
      if (this.sessions.get(sessId) !== s) return;
      if (msg.type === 'start') {
        s.scan.total = msg.total;
      } else if (msg.type === 'batch') {
        for (const [seq, raw] of msg.entries) {
          s.scan.done++;
          if (!raw || s.live.has(seq)) continue;
          const entry = toEntry(seq, raw, this.getPricing);
          s.entries.set(seq, entry);
          s.scan.found.push(entry);
        }
        this._changed(sessId);
      } else if (msg.type === 'done') {
        this._finishScan(sessId, s);
      }
    });
    worker.on('error', (err) => {
      console.error(`session totals scan for ${sessId} failed:`, err.message);
    });
    // Whatever ended the worker, stop reporting a scan in progress.
    worker.on('exit', () => {
      if (this.sessions.get(sessId) === s && s.scan?.worker === worker) this._finishScan(sessId, s);
    });
  }

  _finishScan(sessId, s) {
    // A turn recorded live after its batch arrived already has a newer line.
    const found = (s.scan?.found || []).filter(e => !s.live.has(e[0]));
    s.scan = null;
    s.ready = true;
    const file = this._cachePath(sessId);
    try {
      // Every save of a turn appends a line (start, complete, …); rewrite
      // once the file is mostly superseded lines.
      if (s.lines + found.length > s.entries.size * 1.5) {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, [...s.entries.values()].map(e => JSON.stringify(e) + '\n').join(''));
        fs.renameSync(tmp, file);
        s.lines = s.entries.size;
      } else if (found.length) {
        fs.appendFileSync(file, found.map(e => JSON.stringify(e) + '\n').join(''));
        s.lines += found.length;
      }
    } catch {}
    this._changed(sessId, true);
  }

  _changed(sessId, now = false) {
    const s = this.sessions.get(sessId);
    if (!s || !this.onChange) return;
    if (s.timer) { if (!now) return; clearTimeout(s.timer); }
    const fire = () => {
      s.timer = null;
      if (this.sessions.get(sessId) === s) this.onChange(sessId, this._summarize(sessId, s));
    };
    if (now) fire();
    else s.timer = setTimeout(fire, this.debounceMs);
  }

  _summarize(sessId, s) {
    // Legacy dirs can hold one interaction in several files; count it once,
    // as its newest file has it.
    const byId = new Map();
    for (const e of s.entries.values()) {
      const key = e[1] || `#${e[0]}`;
      const prev = byId.get(key);
      if (!prev || prev[0] < e[0]) byId.set(key, e);
    }
    // turns: prompts the user sent. Every other file is a model API call (one
    // per agentic step, subagents included), a hook event or an MCP call.
    const t = {
      sessId, turns: 0, apiCalls: 0, hookEvents: 0, mcpCalls: 0, toolCalls: 0,
      inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0,
      cost: 0, hasCost: false, duration: 0, firstAt: null, lastAt: null,
      complete: s.ready,
      scanned: s.scan ? s.scan.done : 0, toScan: s.scan ? s.scan.total : 0,
    };
    for (const e of byId.values()) {
      if (e[10] === KIND_PROMPT) t.turns++;
      else if (e[10] === KIND_HOOK) t.hookEvents++;
      else if (e[10] === KIND_MCP) t.mcpCalls++;
      else t.apiCalls++;
      t.toolCalls += e[9];
      t.inputTokens += e[4]; t.outputTokens += e[5];
      t.cacheRead += e[6]; t.cacheCreate += e[7];
      if (e[8] != null) { t.cost += e[8]; t.hasCost = true; }
      t.duration += e[3];
      if (e[2]) {
        if (t.firstAt == null || e[2] < t.firstAt) t.firstAt = e[2];
        const end = e[2] + e[3];
        if (t.lastAt == null || end > t.lastAt) t.lastAt = end;
      }
    }
    return t;
  }
}

module.exports = { SessionTotals, CACHE_FILE, toEntry };
