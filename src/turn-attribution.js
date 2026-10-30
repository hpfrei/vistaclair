/**
 * TurnAttributor — which agent an LLM turn belongs to, decided the moment its
 * request arrives, so the inspector can put a subagent's turn in its own lane
 * while it streams. The authoritative answer (src/trace-index.js) only exists
 * once the response is done; store.applyResolution confirms or corrects this.
 *
 * One per CLI session. Two signals, both in the request itself:
 *  - A turn with history continues the conversation of whoever wrote its last
 *    assistant message: the owner of that message's tool_use ids (or, for a
 *    plain text reply, of its text). Only the last one — a fork-type subagent
 *    inherits its parent's whole history, so earlier messages are the parent's.
 *  - An agent's first turn has no assistant message: its user text carries the
 *    `prompt` an earlier Agent/Task call passed. That call's agent owns it —
 *    its real id when a SubagentStart hook or the agent's meta file named it,
 *    else the lane key 'pending-<tool_use_id>' the inspector already reconciles.
 * Anything else is the main thread.
 */

const MAIN = 'main';
const PROBE_CHARS = 200;
const MIN_PROBE = 30;
const TEXT_KEY_CHARS = 500;

const norm = s => (typeof s === 'string' ? s : '').replace(/\s+/g, ' ').trim();

// An assistant message's text as a lookup key, for a reply with no tool calls.
function textKey(content) {
  const text = norm(content.filter(b => b?.type === 'text').map(b => b.text).join('\n'));
  if (!text) return null;
  return text.length > TEXT_KEY_CHARS ? `${text.length}:${text.slice(0, TEXT_KEY_CHARS)}` : text;
}

const blocksOf = m => (typeof m?.content === 'string'
  ? [{ type: 'text', text: m.content }]
  : (Array.isArray(m?.content) ? m.content : []));

class TurnAttributor {
  constructor() {
    this.toolOwner = new Map();  // tool_use_id -> agentId | 'main' | 'pending-<id>'
    this.textOwner = new Map();  // assistant text key -> owner
    this.calls = [];             // Agent/Task calls: { toolUseId, probe, agentType, description }
    this.spawned = new Map();    // Agent call tool_use_id -> the real agentId it ran
    this.claimed = new Set();    // Agent calls whose first turn was seen
    this.labels = new Map();     // agentId -> subagent descriptor last stamped
  }

  /** A finished turn's response blocks, with the agent that owns the turn. */
  noteResponse(owner, content, subagent) {
    if (!Array.isArray(content)) return;
    owner = owner || MAIN;
    if (subagent?.agentId) this.labels.set(subagent.agentId, subagent);
    let tools = 0;
    for (const b of content) {
      if (b?.type !== 'tool_use' || !b.id) continue;
      tools++;
      this.toolOwner.set(b.id, owner);
      if ((b.name === 'Agent' || b.name === 'Task') && b.input && !this.calls.some(c => c.toolUseId === b.id)) {
        const probe = norm(b.input.prompt).slice(0, PROBE_CHARS);
        if (probe) {
          this.calls.push({
            toolUseId: b.id, probe,
            agentType: b.input.subagent_type || 'agent',
            description: b.input.description || null,
          });
        }
      }
    }
    if (!tools) {
      const key = textKey(content);
      if (key) this.textOwner.set(key, owner);
    }
  }

  /** The Agent call `toolUseId` ran the subagent `agentId`. */
  noteSpawn(toolUseId, agentId) {
    if (toolUseId && typeof agentId === 'string' && agentId && agentId !== MAIN && !agentId.startsWith('pending-')) {
      this.spawned.set(toolUseId, agentId);
    }
  }

  /**
   * The owner of a request: { agentId, toolUseId, agentType, description } for
   * a subagent, null for the main thread. `lookup` holds the trace-backed
   * fallbacks: resolveToolUseId(id) -> owner|null, agentForCall(toolUseId) ->
   * agentId|null, subagentFor(agentId) -> descriptor|null.
   */
  attribute(messages, lookup = {}) {
    if (!Array.isArray(messages)) return null;
    let last = -1;
    for (let k = messages.length - 1; k >= 0; k--) {
      if (messages[k]?.role === 'assistant') { last = k; break; }
    }
    const lastBlocks = last >= 0 ? blocksOf(messages[last]) : [];
    const toolIds = lastBlocks.filter(b => b?.type === 'tool_use' && b.id).map(b => b.id);

    // An agent's first turn: no assistant message yet, or (a fork) only the
    // parent's, ending in the very call that spawned it.
    const call = this._matchCall(messages.slice(last + 1));
    if (call && (last < 0 || toolIds.includes(call.toolUseId))) {
      this.claimed.add(call.toolUseId);
      return this._describe(`pending-${call.toolUseId}`, lookup, call);
    }
    if (last < 0) return null;

    let owner = null;
    for (const id of toolIds) {
      owner = this.toolOwner.get(id) || lookup.resolveToolUseId?.(id) || null;
      if (owner) break;
    }
    if (!owner && !toolIds.length) owner = this.textOwner.get(textKey(lastBlocks)) || null;
    return owner && owner !== MAIN ? this._describe(owner, lookup) : null;
  }

  // The Agent call whose prompt the user text after the last assistant message
  // carries; one whose first turn was not seen yet wins over a repeat.
  _matchCall(tail) {
    if (!this.calls.length) return null;
    const texts = [];
    for (const m of tail) {
      if (m?.role !== 'user') continue;
      for (const b of blocksOf(m)) if (b?.type === 'text' && b.text) texts.push(norm(b.text));
    }
    if (!texts.length) return null;
    const joined = texts.join(' ');
    const hits = this.calls.filter(c => (c.probe.length >= MIN_PROBE
      ? joined.includes(c.probe)
      : texts.includes(c.probe)));
    return hits.find(c => !this.claimed.has(c.toolUseId)) || hits[0] || null;
  }

  _describe(owner, lookup, call = null) {
    let agentId = owner;
    if (owner.startsWith('pending-')) {
      const tuid = owner.slice('pending-'.length);
      agentId = this.spawned.get(tuid) || lookup.agentForCall?.(tuid) || owner;
      call = call || this.calls.find(c => c.toolUseId === tuid) || null;
    }
    const known = this.labels.get(agentId) || lookup.subagentFor?.(agentId) || null;
    return {
      agentId,
      agentType: known?.agentType || call?.agentType || 'agent',
      description: known?.description || call?.description || null,
      toolUseId: known?.toolUseId || call?.toolUseId || null,
    };
  }
}

module.exports = { TurnAttributor };
