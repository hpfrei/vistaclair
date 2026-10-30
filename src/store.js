const fs = require('fs');
const path = require('path');
const { DATA_HOME } = require('./utils');
const { getModelPricing } = require('./capabilities');
const { TraceIndex } = require('./trace-index');
const { TurnAttributor } = require('./turn-attribution');
const { SessionTotals } = require('./session-totals');

const INTERACTIONS_DIR = path.join(DATA_HOME, 'interactions');

class InteractionStore {
  constructor(maxSize = 200) {
    this.interactions = new Map();
    this.order = [];
    this.maxSize = maxSize;
    this.seq = 0;

    // Per-CLI-session disk storage
    this.sessionMap = new Map();   // instanceId → sessId
    this.sessionSeqs = new Map();  // sessId → seq counter
    this.filePaths = new Map();    // interaction id → absolute file path
    this.requestIdIndex = new Map(); // request-id → filePath (survives eviction)
    this.diskIndex = new Map();    // interaction id → file path (any file ever parsed; survives memory eviction)

    // Authoritative subagent attribution from Claude's trace files.
    this.traceIndexes = new Map();   // sessId → TraceIndex
    this.pendingRequestEnrich = new Map(); // request-id → true (awaiting trace resolution)
    // Request-time attribution, provisional until the trace confirms it.
    this.attributors = new Map();    // instanceId → TurnAttributor
    this._broadcaster = null;

    // Whole-session figures for the inspector footer; memory holds only the
    // newest maxSize turns.
    this.totals = new SessionTotals(INTERACTIONS_DIR, {
      getPricing: (model) => getModelPricing(DATA_HOME, model),
      onChange: (sessId, totals) => this._broadcaster?.broadcast({
        type: 'inspector:sessionTotals', instanceId: `cli-${sessId}`, totals,
      }),
    });

    fs.mkdirSync(INTERACTIONS_DIR, { recursive: true });
    this._loadFromDisk();
  }

  /**
   * Attach a TraceIndex for a session (called when its SessionStart hook arrives
   * with a transcript_path). Idempotent. The index watches the transcript dir
   * and calls back into applyResolution as mappings appear.
   */
  attachTraceIndex(sessId, transcriptPath, broadcaster) {
    if (!sessId || !transcriptPath) return;
    if (broadcaster) this._broadcaster = broadcaster;
    if (this.traceIndexes.has(sessId)) return;
    try {
      const ti = new TraceIndex(transcriptPath, (kind, key, value) => {
        if (kind === 'promptImages') this.applyPromptImages(key, value);
        else this.applyResolution(sessId, kind, key, value);
      });
      this.traceIndexes.set(sessId, ti);
      // Resolve anything already buffered against the freshly-built index.
      this._drainPending(sessId);
    } catch {}
  }

  setBroadcaster(broadcaster) {
    this._broadcaster = broadcaster;
  }

  getTraceIndex(sessId) {
    return this.traceIndexes.get(sessId) || null;
  }

  /** Force-rescan a session's transcripts (e.g. on SubagentStop/Stop hooks). */
  rescanTrace(sessId) {
    const ti = this.traceIndexes.get(sessId);
    if (ti) ti.rescanNow();
  }

  _drainPending(sessId) {
    const ti = this.traceIndexes.get(sessId);
    if (!ti) return;
    for (const reqId of [...this.pendingRequestEnrich.keys()]) {
      const agentId = ti.resolveRequestId(reqId);
      if (agentId != null) {
        this.pendingRequestEnrich.delete(reqId);
        this.applyResolution(sessId, 'request', reqId, agentId);
      }
    }
  }

  /** Build a subagent descriptor for an agentId from trace meta, or null for main. */
  _subagentFor(sessId, agentId) {
    if (!agentId || agentId === 'main') return null;
    const ti = this.traceIndexes.get(sessId);
    const meta = ti ? ti.getAgentMeta(agentId) : null;
    return {
      agentId,
      agentType: meta?.agentType || 'agent',
      description: meta?.description || null,
      toolUseId: meta?.toolUseId || null,
    };
  }

  /**
   * Apply a trace resolution (request-id or tool_use-id → agentId|'main') to the
   * matching interaction/hook: stamp subagent, persist, and broadcast enriched.
   */
  applyResolution(sessId, kind, key, agentId) {
    const target = kind === 'request'
      ? this._findByResponseRequestId(key)
      : this._findHookByToolUseId(key);
    if (!target) return;

    let subagent = this._subagentFor(sessId, agentId);
    const provisional = !!target.subagentProvisional;
    if (kind === 'request') this._learnOwner(target, subagent);
    if (!subagent) {
      // 'main' resolution: leave subagent unset (interaction belongs on main),
      // unless the request-time guess put it on a subagent.
      if (!provisional) return;
      delete target.subagent;
      subagent = null;
    } else if (target.subagent?.agentId === subagent.agentId) {
      // Don't clobber an existing, equal stamp; a guess just becomes certain.
      if (!provisional) return;
      const meta = this.traceIndexes.get(sessId)?.getAgentMeta(subagent.agentId);
      subagent = {
        ...subagent,
        agentType: meta?.agentType || target.subagent.agentType || subagent.agentType,
        description: subagent.description || target.subagent.description || null,
        toolUseId: subagent.toolUseId || target.subagent.toolUseId || null,
      };
      target.subagent = subagent;
    } else {
      target.subagent = subagent;
    }
    delete target.subagentProvisional;

    this._persist(target);
    if (this._broadcaster && target.id) {
      this._broadcaster.broadcast({ type: 'interaction:enriched', interactionId: target.id, subagent });
    }
    // A tool_use resolution also pins any hooks sharing that tool_use_id.
    if (kind === 'request' && subagent) {
      const enrichedHooks = this._enrichRelatedHooks(target, subagent);
      if (this._broadcaster) {
        for (const hook of enrichedHooks) {
          this._broadcaster.broadcast({ type: 'interaction:enriched', interactionId: hook.id, subagent });
        }
      }
    }
  }

  _attributor(instanceId) {
    let att = this.attributors.get(instanceId);
    if (!att) { att = new TurnAttributor(); this.attributors.set(instanceId, att); }
    return att;
  }

  /**
   * Stamp an LLM turn with its owner the moment its request arrives
   * (src/turn-attribution.js), so its interaction:start already names the
   * lane. Marked subagentProvisional until applyResolution confirms or
   * corrects it from the transcript. A main-thread turn stays unstamped.
   */
  attributeTurn(interaction) {
    if (!interaction?.instanceId || interaction.isHook || interaction.isMcp || interaction.subagent) return;
    const sessId = this.sessionMap.get(interaction.instanceId);
    const ti = sessId ? this.traceIndexes.get(sessId) : null;
    const subagent = this._attributor(interaction.instanceId).attribute(interaction.request?.messages, {
      resolveToolUseId: id => ti?.resolveToolUseId(id) || null,
      // An agent's meta file lands as it starts; the watcher may not have run yet.
      agentForCall: tuid => (ti ? ti.agentForToolUse(tuid) || (ti.rescanNow(), ti.agentForToolUse(tuid)) : null),
      subagentFor: agentId => ti?.getAgentMeta(agentId) || null,
    });
    if (!subagent) return;
    interaction.subagent = subagent;
    interaction.subagentProvisional = true;
  }

  /**
   * A tool_use block of a streaming turn, the moment it is complete: Claude
   * Code runs the tool (an Agent call: its subagent) before the response ends.
   */
  noteToolUse(interaction, block) {
    if (!interaction?.instanceId || !block?.id) return;
    this._attributor(interaction.instanceId).noteResponse(interaction.subagent?.agentId, [block], interaction.subagent);
  }

  // A transcript resolution of a turn: its blocks belong to that owner, and a
  // guessed 'pending-<call>' agent now has its real id.
  _learnOwner(turn, subagent) {
    const att = turn.instanceId ? this.attributors.get(turn.instanceId) : null;
    if (!att) return;
    const guessed = turn.subagent?.agentId;
    if (subagent && guessed?.startsWith('pending-')) att.noteSpawn(guessed.slice('pending-'.length), subagent.agentId);
    if (subagent?.toolUseId) att.noteSpawn(subagent.toolUseId, subagent.agentId);
    att.noteResponse(subagent?.agentId, turn.response?.body?.content, subagent);
  }

  /**
   * Stamp the images pasted into a prompt (src/prompt-images.js) on its
   * UserPromptSubmit hook, persist, and broadcast. A hook not saved yet gets
   * them in save() instead.
   */
  applyPromptImages(promptId, paths) {
    let hook = null;
    for (const interaction of this.interactions.values()) {
      if (interaction.isHook && interaction.hookEvent === 'UserPromptSubmit'
          && interaction.request?.prompt_id === promptId) { hook = interaction; break; }
    }
    if (!hook || !this.filePaths.has(hook.id)) return;
    if (hook.promptImages?.length === paths.length) return;
    hook.promptImages = paths;
    this._persist(hook);
    if (this._broadcaster) {
      this._broadcaster.broadcast({ type: 'interaction:enriched', interactionId: hook.id, promptImages: paths });
    }
  }

  /** Resolve an LLM turn against the trace index now, or queue it for the watcher. */
  tryEnrichLlmTurn(interaction, broadcaster) {
    if (!interaction || interaction.isHook || interaction.isMcp) return;
    if (broadcaster) this._broadcaster = broadcaster;
    const reqId = interaction.response?.headers?.['request-id'];
    if (!reqId) return;
    const sessId = this.sessionMap.get(interaction.instanceId);
    const ti = sessId ? this.traceIndexes.get(sessId) : null;
    if (ti) {
      const agentId = ti.resolveRequestId(reqId);
      if (agentId != null) { this.applyResolution(sessId, 'request', reqId, agentId); return; }
    }
    // Not in the transcript yet (Claude writes the record after we finish the
    // response) — let the watcher enrich it when the line lands.
    this.pendingRequestEnrich.set(reqId, true);
  }

  /** Find a live or on-disk interaction by its response request-id header. */
  _findByResponseRequestId(reqId) {
    for (const interaction of this.interactions.values()) {
      if (interaction.response?.headers?.['request-id'] === reqId) return interaction;
    }
    const fp = this.requestIdIndex.get(reqId);
    if (fp) {
      try {
        const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
        data.__filePath = fp;
        return data;
      } catch {}
    }
    return null;
  }

  /** Find a live or on-disk hook by its tool_use_id. */
  _findHookByToolUseId(toolUseId) {
    for (const interaction of this.interactions.values()) {
      if (interaction.isHook && interaction.toolUseId === toolUseId) return interaction;
    }
    return null;
  }

  /**
   * Write an interaction file, recreating its session dir if it vanished
   * (deleteSessionData can remove it while the session is still live).
   */
  _writeInteractionFile(filePath, content, label) {
    const json = JSON.stringify(content, null, 2);
    fs.writeFile(filePath, json, (err) => {
      if (!err) return;
      if (err.code === 'ENOENT') {
        try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch {}
        fs.writeFile(filePath, json, (err2) => {
          if (err2 && label) console.error(`Failed to write interaction ${label}:`, err2.message);
        });
        return;
      }
      if (label) console.error(`Failed to write interaction ${label}:`, err.message);
    });
  }

  /** Persist an interaction's current state back to its file. */
  _persist(interaction) {
    const fp = interaction.__filePath || this.filePaths.get(interaction.id);
    if (!fp) return;
    try {
      const content = interaction.__filePath ? interaction : this._buildFileContent(interaction);
      if (interaction.__filePath) delete content.__filePath;
      this._writeInteractionFile(fp, content, null);
    } catch {}
  }

  _loadFromDisk() {
    let dirs;
    try { dirs = fs.readdirSync(INTERACTIONS_DIR); } catch { return; }

    const sessionDirs = dirs.filter(name => {
      try { return fs.statSync(path.join(INTERACTIONS_DIR, name)).isDirectory(); } catch { return false; }
    });

    // Collect files grouped by session
    const sessions = [];
    for (const sessId of sessionDirs) {
      const dir = path.join(INTERACTIONS_DIR, sessId);
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { continue; }
      if (files.length === 0) continue;

      let maxSeq = 0;
      let latestMtime = 0;
      const sessionFiles = [];
      for (const file of files) {
        const seqNum = parseInt(file);
        if (seqNum > maxSeq) maxSeq = seqNum;
        const filePath = path.join(dir, file);
        let mtime = 0;
        try { mtime = fs.statSync(filePath).mtimeMs; } catch {}
        if (mtime > latestMtime) latestMtime = mtime;
        sessionFiles.push({ sessId, seqNum, filePath, mtime });
      }
      this.sessionSeqs.set(sessId, maxSeq);
      sessions.push({ sessId, files: sessionFiles, latestMtime });
    }

    // Sort sessions by most recent activity, load complete sessions up to maxSize
    sessions.sort((a, b) => b.latestMtime - a.latestMtime);

    const toLoad = [];
    for (const sess of sessions) {
      if (toLoad.length + sess.files.length > this.maxSize && toLoad.length > 0) break;
      sess.files.sort((a, b) => a.mtime - b.mtime);
      // A session bigger than maxSize on its own (a long-running tab can hold
      // tens of thousands of turns) contributes only its newest turns; parsing
      // all of them at boot exhausts the heap.
      toLoad.push(...sess.files.slice(-this.maxSize));
    }
    // Final sort chronologically across all loaded sessions
    toLoad.sort((a, b) => a.mtime - b.mtime);

    for (const { sessId, seqNum, filePath } of toLoad) {
      const interaction = this._parseInteractionFile(sessId, seqNum, filePath);
      if (!interaction) continue;
      // Older data can hold the same id in several files (one per save). Keep the
      // newest copy but only one slot in `order` — a duplicated id there survives
      // eviction of its map entry and turns getAll() into a list with holes.
      const dup = this.interactions.has(interaction.id);
      this.interactions.set(interaction.id, interaction);
      if (!dup) this.order.push(interaction.id);
      this.filePaths.set(interaction.id, filePath);
      const reqId = interaction.response?.headers?.['request-id'];
      if (reqId) this.requestIdIndex.set(reqId, filePath);
    }

    this.seq = this.order.length;
  }

  // Highest turn number already written to a session's dir, or 0 when it has
  // none. Read straight off disk so it is correct even for a session
  // _loadFromDisk skipped (it stops at maxSize interactions).
  _maxSeqOnDisk(sessId) {
    let files;
    try { files = fs.readdirSync(path.join(INTERACTIONS_DIR, sessId)); } catch { return 0; }
    let max = 0;
    for (const f of files) {
      if (!/^\d+\.json$/.test(f)) continue;
      const n = parseInt(f, 10);
      if (n > max) max = n;
    }
    return max;
  }

  registerSession(instanceId, sessId) {
    this.sessionMap.set(instanceId, sessId);
    const dir = path.join(INTERACTIONS_DIR, sessId);
    fs.mkdirSync(dir, { recursive: true });
    // Continue the session's existing numbering rather than restarting at 0.
    // A resumed CLI tab (and a headless spawn sharing a tab's sessId) registers
    // against a dir that already holds turns; starting from 0 would overwrite
    // them, and leave the in-memory ids pointing at files holding other turns'
    // bodies.
    this.sessionSeqs.set(sessId, this._maxSeqOnDisk(sessId));
  }

  unregisterSession(instanceId) {
    this.sessionMap.delete(instanceId);
  }

  hasSessionContent(sessId) {
    if (!sessId) return false;
    const dir = path.join(INTERACTIONS_DIR, sessId);
    try {
      const files = fs.readdirSync(dir);
      return files.some(f => f.endsWith('.json'));
    } catch {
      return false;
    }
  }

  deleteSessionData(sessId) {
    const dir = path.join(INTERACTIONS_DIR, sessId);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    this.sessionSeqs.delete(sessId);
    this.totals.forget(sessId);
  }

  // Drop headless (`claude -p` / ai.prompt) session dirs that have been idle
  // longer than ttlMs. Interactive CLI tabs are exempt by construction — they
  // write an internal.json at spawn, and their dirs are owned by the tab/saved-
  // session lifecycle instead. Returns { swept: [sessId], bytes }.
  //
  // Never sweeps a session that is live (registered in sessionMap) or pinned by
  // the caller (open-tab manifest, CLI history, add-ons), so a long-running
  // headless job whose last write predates the TTL keeps its dir.
  sweepStaleSessions({ ttlMs, pinned } = {}) {
    const ttl = Number.isFinite(ttlMs) ? ttlMs : 60 * 60 * 1000;
    const pins = pinned instanceof Set ? pinned : new Set(pinned || []);
    const live = new Set(this.sessionMap.values());
    const cutoff = Date.now() - ttl;

    let names;
    try { names = fs.readdirSync(INTERACTIONS_DIR); } catch { return { swept: [], bytes: 0 }; }

    const swept = [];
    let bytes = 0;
    for (const sessId of names) {
      if (sessId.startsWith('.')) continue;
      if (pins.has(sessId) || live.has(sessId)) continue;
      const dir = path.join(INTERACTIONS_DIR, sessId);

      let entries;
      let newest;
      try {
        const st = fs.statSync(dir);
        if (!st.isDirectory()) continue;
        newest = st.mtimeMs;
        entries = fs.readdirSync(dir);
      } catch { continue; }

      // An internal.json means a PTY tab spawned here — not a headless run.
      if (entries.includes('internal.json')) continue;

      let size = 0;
      for (const name of entries) {
        try {
          const st = fs.statSync(path.join(dir, name));
          if (st.mtimeMs > newest) newest = st.mtimeMs;
          size += st.size;
        } catch {}
      }
      if (newest > cutoff) continue;

      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { continue; }
      swept.push(sessId);
      bytes += size;
      this.sessionSeqs.delete(sessId);
      this.totals.forget(sessId);
    }

    if (swept.length) this._evictSweptFromMemory(swept);
    return { swept, bytes };
  }

  // Drop in-memory interactions whose backing file lived in a swept dir, so
  // `order`/`filePaths`/`diskIndex` never hand out a path that no longer exists.
  _evictSweptFromMemory(sessIds) {
    const prefixes = sessIds.map(s => path.join(INTERACTIONS_DIR, s) + path.sep);
    const under = fp => typeof fp === 'string' && prefixes.some(p => fp.startsWith(p));

    const toRemove = new Set();
    for (const [id, fp] of this.filePaths) {
      if (under(fp)) toRemove.add(id);
    }
    for (const id of toRemove) {
      this.interactions.delete(id);
      this.filePaths.delete(id);
    }
    this.order = this.order.filter(id => !toRemove.has(id));
    for (const [id, fp] of this.diskIndex) {
      if (under(fp)) this.diskIndex.delete(id);
    }
    for (const [reqId, fp] of this.requestIdIndex) {
      if (under(fp)) this.requestIdIndex.delete(reqId);
    }
  }

  add(interaction) {
    // Re-adding a known id must not leave a second entry in `order`: eviction
    // would then delete the map entry while a dangling id remained, and
    // getAll() would hand out undefined.
    if (this.interactions.has(interaction.id)) {
      const at = this.order.indexOf(interaction.id);
      if (at !== -1) this.order.splice(at, 1);
    }
    if (this.order.length >= this.maxSize) {
      const oldestId = this.order.shift();
      this.interactions.delete(oldestId);
      this.filePaths.delete(oldestId);
    }
    this.interactions.set(interaction.id, interaction);
    this.order.push(interaction.id);
    this.seq++;
  }

  get(id) {
    return this.interactions.get(id) || this._getFromDisk(id);
  }

  _getFromDisk(id) {
    // Interaction ids don't embed their session dir (e.g. "req_..._..", "hook-..."),
    // so we can't derive the path from the id. Consult the disk index first; if it's
    // not yet populated (no loadAll this session), fall back to scanning all sessions.
    const indexed = this.diskIndex.get(id);
    if (indexed) {
      const sessId = path.basename(path.dirname(indexed));
      const seqNum = parseInt(path.basename(indexed));
      const interaction = this._parseInteractionFile(sessId, seqNum, indexed);
      if (interaction && interaction.id === id) return interaction;
    }
    return this._scanDiskForId(id);
  }

  _scanDiskForId(id) {
    let sessionDirs;
    try { sessionDirs = fs.readdirSync(INTERACTIONS_DIR); } catch { return null; }
    for (const sessId of sessionDirs) {
      const dir = path.join(INTERACTIONS_DIR, sessId);
      let files;
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      } catch { continue; }
      for (const file of files) {
        const filePath = path.join(dir, file);
        const interaction = this._parseInteractionFile(sessId, parseInt(file), filePath);
        if (interaction && interaction.id === id) return interaction;
      }
    }
    return null;
  }

  getAll() {
    const out = [];
    for (const id of this.order) {
      const interaction = this.interactions.get(id);
      if (interaction) out.push(interaction);
    }
    return out;
  }

  save(id) {
    const interaction = this.interactions.get(id);
    if (!interaction) return;

    const sessId = this.sessionMap.get(interaction.instanceId);
    if (!sessId) return;

    // save() is called several times per interaction (start, complete, error).
    // Reuse the file already allocated for this id — allocating a fresh seq each
    // time scatters one interaction across several files, which then load back
    // as duplicate ids.
    let filePath = this.filePaths.get(id);
    let label = filePath ? `${sessId}/${path.basename(filePath)}` : null;
    if (!filePath) {
      const seqNum = (this.sessionSeqs.get(sessId) || 0) + 1;
      this.sessionSeqs.set(sessId, seqNum);
      filePath = path.join(INTERACTIONS_DIR, sessId, `${seqNum}.json`);
      label = `${sessId}/${seqNum}`;
    }

    // When saving a tool-call hook without an explicit agent_id, resolve its
    // owner authoritatively via the trace index (tool_use_id → agentId). Falls
    // back to inheriting from the parent turn that emitted the tool_use.
    if (interaction.isHook && interaction.toolUseId && !interaction.subagent && interaction.instanceId) {
      const ti = this.traceIndexes.get(sessId);
      const agentId = ti ? ti.resolveToolUseId(interaction.toolUseId) : null;
      if (agentId && agentId !== 'main') {
        interaction.subagent = this._subagentFor(sessId, agentId);
      } else if (agentId == null) {
        const parent = this._findTurnByToolUseId(interaction.toolUseId, interaction.instanceId);
        if (parent?.subagent) interaction.subagent = parent.subagent;
      }
    }

    // A prompt's pasted images: its transcript records are written before the
    // hook fires, so a rescan has them now; ones landing later come through
    // applyPromptImages.
    if (interaction.isHook && interaction.hookEvent === 'UserPromptSubmit' && !interaction.promptImages) {
      const ti = this.traceIndexes.get(sessId);
      if (ti) {
        ti.rescanNow();
        const images = ti.getPromptImages(interaction.request?.prompt_id);
        if (images) interaction.promptImages = images;
      }
    }

    const fileContent = this._buildFileContent(interaction);

    this.filePaths.set(id, filePath);
    this.diskIndex.set(id, filePath);
    const reqId = interaction.response?.headers?.['request-id'];
    if (reqId) this.requestIdIndex.set(reqId, filePath);
    this._writeInteractionFile(filePath, fileContent, label);
    this.totals.record(sessId, parseInt(path.basename(filePath), 10), interaction);

    // Resolve LLM turns to their owning thread the moment they complete. If the
    // transcript line isn't written yet, this queues the request-id for the
    // watcher. Idempotent across the multiple save() calls per interaction.
    if (!interaction.isHook && !interaction.isMcp && interaction.status === 'complete') {
      if (interaction.instanceId) {
        this._attributor(interaction.instanceId).noteResponse(interaction.subagent?.agentId, interaction.response?.body?.content, interaction.subagent);
      }
      this.tryEnrichLlmTurn(interaction);
    }
    // The hooks that name the agent an Agent call ran, for its turns' lane.
    if (interaction.isHook && interaction.instanceId) {
      if (interaction.hookEvent === 'SubagentStart' && interaction.hookAgentId) {
        this._attributor(interaction.instanceId).noteSpawn(interaction.subagent?.toolUseId, interaction.hookAgentId);
      } else if (/PostToolUse/.test(interaction.hookEvent || '') && interaction.toolName === 'Agent') {
        this._attributor(interaction.instanceId).noteSpawn(interaction.toolUseId, interaction.request?.tool_response?.agentId);
      }
    }
  }

  enrichInteraction(id, subagent) {
    const interaction = this.interactions.get(id);
    if (!interaction) return null;

    interaction.subagent = subagent;

    const filePath = this.filePaths.get(id);
    if (filePath) {
      this._writeInteractionFile(filePath, this._buildFileContent(interaction), 'resave');
    }

    // Also enrich hooks whose toolUseId matches a tool call in this turn
    const enrichedHooks = this._enrichRelatedHooks(interaction, subagent);

    return { interaction, enrichedHooks };
  }

  /** Find hooks in the same instance whose toolUseId matches a tool call in the
   *  given turn's response, stamp them with the same subagent, and persist. */
  _enrichRelatedHooks(turn, subagent) {
    if (!turn.instanceId || turn.isHook || turn.isMcp) return [];

    // Extract tool_use IDs from the turn's response
    const toolIds = new Set();
    const body = turn.response?.body;
    if (body?.content) {
      for (const block of body.content) {
        if (block.type === 'tool_use' && block.id) toolIds.add(block.id);
      }
    }
    // Also check SSE events if body wasn't available
    if (toolIds.size === 0 && turn.response?.sseEvents?.length) {
      for (const evt of turn.response.sseEvents) {
        if (evt.eventType === 'content_block_start' && evt.data?.content_block?.type === 'tool_use') {
          const cbId = evt.data.content_block.id;
          if (cbId) toolIds.add(cbId);
        }
      }
    }
    if (toolIds.size === 0) return [];

    const enriched = [];
    for (const hookId of this.order) {
      const hook = this.interactions.get(hookId);
      if (!hook?.isHook || hook.subagent) continue;
      if (hook.instanceId !== turn.instanceId) continue;
      if (!hook.toolUseId || !toolIds.has(hook.toolUseId)) continue;

      hook.subagent = subagent;
      enriched.push(hook);

      const fp = this.filePaths.get(hookId);
      if (fp) {
        this._writeInteractionFile(fp, this._buildFileContent(hook), 'resave hook');
      }
    }
    return enriched;
  }

  /** Find the LLM turn that contains a tool_use block with the given ID. */
  _findTurnByToolUseId(toolUseId, instanceId) {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const turn = this.interactions.get(this.order[i]);
      if (!turn || turn.isHook || turn.isMcp) continue;
      if (turn.instanceId !== instanceId) continue;
      const content = turn.response?.body?.content;
      if (content) {
        for (const block of content) {
          if (block.type === 'tool_use' && block.id === toolUseId) return turn;
        }
      }
      if (turn.response?.sseEvents?.length) {
        for (const evt of turn.response.sseEvents) {
          if (evt.eventType === 'content_block_start' && evt.data?.content_block?.type === 'tool_use' && evt.data.content_block.id === toolUseId) return turn;
        }
      }
    }
    return null;
  }

  _parseInteractionFile(sessId, seqNum, filePath) {
    let data;
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }

    const req = data.request || {};
    const resp = data.response || {};

    let subagent = data.subagent || null;
    if (subagent && !subagent.agentType && !subagent.agentId && !subagent.description) {
      subagent = null;
    }

    let body = resp.body ?? null;
    if (!body && resp.sseEvents?.length) {
      body = InteractionStore._reconstructBodyFromSSE(resp.sseEvents);
    }

    const interaction = {
      id: data.id || `${sessId}-${seqNum}`,
      timestamp: req.timestamp || 0,
      endpoint: req.endpoint || '/v1/messages',
      originalEndpoint: req.endpoint || undefined,
      instanceId: data.instanceId || `cli-${sessId}`,
      stepId: req.stepId || null,
      runId: req.runId || null,
      request: req,
      response: {
        status: resp.status ?? null,
        headers: resp.headers || {},
        body,
        sseEvents: resp.sseEvents || [],
        error: resp.error || undefined,
      },
      timing: resp.timing || { startedAt: req.timestamp || 0, ttfb: null, duration: null },
      usage: resp.usage || null,
      isStreaming: req.isStreaming || false,
      status: resp.result || 'complete',
      bare: req.bare || false,
      disableAutoMemory: req.disableAutoMemory !== false,
      subagent: subagent || undefined,
      subagentProvisional: (subagent && data.subagentProvisional) || undefined,
      pricing: data.pricing || (req.model ? getModelPricing(DATA_HOME, req.model) : undefined),
      rules: Array.isArray(data.rules) ? data.rules : undefined,
    };
    if (data.isHook) {
      interaction.isHook = true;
      interaction.hookEvent = data.hookEvent || 'unknown';
      interaction.toolName = data.toolName || null;
      interaction.toolUseId = data.toolUseId || null;
      interaction.hookAgentId = data.hookAgentId || null;
      if (Array.isArray(data.promptImages) && data.promptImages.length) interaction.promptImages = data.promptImages;
    }
    if (data.isMcp) {
      interaction.isMcp = true;
      interaction.mcpSource = data.mcpSource || undefined;
    }
    this.diskIndex.set(interaction.id, filePath);
    return interaction;
  }

  removeFromMemory(instanceIds) {
    const idSet = new Set(instanceIds);
    const toRemove = new Set();
    for (const id of this.order) {
      const interaction = this.interactions.get(id);
      if (interaction && idSet.has(interaction.instanceId)) {
        toRemove.add(id);
      }
    }
    for (const id of toRemove) {
      this.interactions.delete(id);
      this.filePaths.delete(id);
    }
    this.order = this.order.filter(id => !toRemove.has(id));
    return toRemove.size;
  }

  // Everything memory holds for a session that is being removed: its turns
  // (by instance, and by file under its dir), turn counter, whole-session
  // totals and transcript watcher. The dir itself is the caller's to delete
  // (src/inspector-sessions.js, confined to the interactions root).
  forgetSession(instanceId, sessId) {
    this.removeFromMemory([instanceId]);
    this.attributors.delete(instanceId);
    if (!sessId) return;
    this._evictSweptFromMemory([sessId]);
    this.sessionSeqs.delete(sessId);
    this.totals.forget(sessId);
    const ti = this.traceIndexes.get(sessId);
    if (ti) { ti.close(); this.traceIndexes.delete(sessId); }
  }

  // What an inspector tab shows when it opens: the newest maxSize turns this
  // instance wrote to its session dir, overlaid with memory (turns still in
  // flight, ones never written). Read only: nothing is pulled into memory, so
  // opening an old session never evicts a live one. A dir can be shared (a
  // headless ai.prompt run and the tab that resumes its Claude session), hence
  // the filter on instanceId.
  sessionInteractions(instanceId, sessId) {
    const byId = new Map();
    if (sessId && !sessId.includes('/') && !sessId.includes('\\') && !sessId.startsWith('.')) {
      const dir = path.join(INTERACTIONS_DIR, sessId);
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)); } catch {}
      const newest = files
        .map(file => ({ file, seqNum: parseInt(file, 10) }))
        .sort((a, b) => a.seqNum - b.seqNum)
        .slice(-this.maxSize);
      for (const { file, seqNum } of newest) {
        const interaction = this._parseInteractionFile(sessId, seqNum, path.join(dir, file));
        if (interaction && interaction.instanceId === instanceId) byId.set(interaction.id, interaction);
      }
    }
    for (const id of this.order) {
      const interaction = this.interactions.get(id);
      if (interaction && (interaction.instanceId || 'ext') === instanceId) byId.set(id, interaction);
    }
    return [...byId.values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  }

  loadSessionIntoMemory(sessId) {
    // Anchor the turn counter to the session's dir before anything can return
    // early — every path out of here must leave the next save numbered after
    // the turns already on disk, never on top of them.
    const onDisk = this._maxSeqOnDisk(sessId);
    if (onDisk > (this.sessionSeqs.get(sessId) || 0)) this.sessionSeqs.set(sessId, onDisk);

    const instanceId = `cli-${sessId}`;
    const existing = this.order.filter(id => {
      const i = this.interactions.get(id);
      return i && i.instanceId === instanceId;
    });
    if (existing.length > 0) return existing.map(id => this.interactions.get(id));

    const dir = path.join(INTERACTIONS_DIR, sessId);
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }

    // Memory holds maxSize turns, so only the newest maxSize files can stay
    // loaded anyway. Parsing the rest just to evict them — and returning them
    // all — exhausts the heap on a long-running tab (30k turns, 6 GB), the
    // same way an uncapped boot load did (see _loadFromDisk).
    const newest = files
      .map(file => ({ file, seqNum: parseInt(file) }))
      .sort((a, b) => a.seqNum - b.seqNum)
      .slice(-this.maxSize);

    const loaded = [];
    for (const { file, seqNum } of newest) {
      const filePath = path.join(dir, file);
      const interaction = this._parseInteractionFile(sessId, seqNum, filePath);
      if (!interaction) continue;
      // Already live in memory (or duplicated on disk): keep the in-memory copy,
      // never a second `order` entry for the same id.
      const live = this.interactions.get(interaction.id);
      if (live) { loaded.push(live); continue; }

      if (this.order.length >= this.maxSize) {
        const oldestId = this.order.shift();
        this.interactions.delete(oldestId);
        this.filePaths.delete(oldestId);
      }
      this.interactions.set(interaction.id, interaction);
      this.order.push(interaction.id);
      this.filePaths.set(interaction.id, filePath);
      loaded.push(interaction);
    }

    return loaded;
  }

  _buildFileContent(interaction) {
    const out = {
      id: interaction.id,
      instanceId: interaction.instanceId || undefined,
      request: {
        ...interaction.request,
        endpoint: interaction.endpoint,
        timestamp: interaction.timestamp,
        isStreaming: interaction.isStreaming,
        stepId: interaction.stepId || undefined,
        runId: interaction.runId || undefined,
      },
      response: {
        status: interaction.response?.status ?? null,
        headers: interaction.response?.headers ?? {},
        body: interaction.response?.body ?? null,
        sseEvents: interaction.response?.sseEvents ?? [],
        error: interaction.response?.error ?? undefined,
        timing: interaction.timing,
        usage: interaction.usage,
        result: interaction.status,
      },
      subagent: interaction.subagent || undefined,
      subagentProvisional: (interaction.subagent && interaction.subagentProvisional) || undefined,
      pricing: interaction.pricing || undefined,
      rules: interaction.rules?.length ? interaction.rules : undefined,
    };
    if (interaction.isHook) {
      out.isHook = true;
      out.hookEvent = interaction.hookEvent;
      out.toolName = interaction.toolName || undefined;
      out.toolUseId = interaction.toolUseId || undefined;
      out.hookAgentId = interaction.hookAgentId || undefined;
      out.promptImages = interaction.promptImages?.length ? interaction.promptImages : undefined;
    }
    if (interaction.isMcp) {
      out.isMcp = true;
      out.mcpSource = interaction.mcpSource || undefined;
    }
    return out;
  }

  static _reconstructBodyFromSSE(sseEvents) {
    const content = [];
    const jsonParts = new Map();
    for (const e of sseEvents) {
      if (e.eventType === 'content_block_start' && e.data?.content_block) {
        content[e.data.index] = { ...e.data.content_block };
        if (e.data.content_block.type === 'tool_use') jsonParts.set(e.data.index, '');
      } else if (e.eventType === 'content_block_delta') {
        const idx = e.data?.index;
        const delta = e.data?.delta;
        if (delta?.type === 'text_delta' && content[idx]) {
          content[idx].text = (content[idx].text || '') + (delta.text || '');
        } else if (delta?.type === 'thinking_delta' && content[idx]) {
          content[idx].thinking = (content[idx].thinking || '') + (delta.thinking || '');
          if (delta.estimated_tokens) content[idx].estimated_tokens = (content[idx].estimated_tokens || 0) + delta.estimated_tokens;
        } else if (delta?.type === 'input_json_delta' && jsonParts.has(idx)) {
          jsonParts.set(idx, jsonParts.get(idx) + (delta.partial_json || ''));
        }
      } else if (e.eventType === 'content_block_stop') {
        const idx = e.data?.index;
        if (jsonParts.has(idx) && content[idx]) {
          try { content[idx].input = JSON.parse(jsonParts.get(idx)); } catch {}
        }
      }
    }
    return content.length > 0 ? { content: content.filter(Boolean) } : null;
  }
}

module.exports = InteractionStore;
