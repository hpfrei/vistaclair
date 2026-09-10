(function () {
  'use strict';

  const D3_CONST = {
    RULER_WIDTH: 52,
    COLUMN_WIDTH: 240,
    COLUMN_GAP: 16,
    // Height of a turn node's header, exactly. Tool rows are placed at
    // y + MIN_ENTRY_HEIGHT + i * TOOL_HEIGHT (both for stacking and for the
    // fork/merge anchors), so this must equal the rendered height of
    // .turn-entry in style.css — 44px — or rows drift under the next node.
    MIN_ENTRY_HEIGHT: 44,
    NODE_BORDER: 2,
    TOOL_HEIGHT: 24,
    MIN_GAP: 6,
    HEADER_HEIGHT: 30,
    ZIGZAG_MIN_CUT: 10000,
    COHORT_EPSILON_MS: 300,
  };

  const GAP_COLLAPSE_HEIGHT = 28;

  let _extractToolCalls = null;
  let _isStandardLlm = null;

  let _foldedHookIds = new Set();
  let _foldedHookParentInfo = new Map();

  let _clampedHookIds = new Set();
  let _clampedHookParentInfo = new Map();

  function init(deps) {
    _extractToolCalls = deps.extractToolCalls;
    _isStandardLlm = deps.isStandardLlm;
  }

  function extractToolCalls(interaction) {
    return _extractToolCalls(interaction);
  }

  function isStandardLlm(interaction) {
    return _isStandardLlm(interaction);
  }

  // --- Hook agent resolution ---

  function resolveHookAgentId(hookInteraction, interactions) {
    if (!hookInteraction.toolUseId) return null;
    for (let i = interactions.length - 1; i >= 0; i--) {
      const turn = interactions[i];
      if (turn.isHook || turn.isMcp) continue;
      if (turn.instanceId !== hookInteraction.instanceId) continue;
      const tools = extractToolCalls(turn);
      if (tools.some(tc => tc.id === hookInteraction.toolUseId)) {
        return turn.subagent?.agentId || null;
      }
    }
    return null;
  }


  // --- Column allocation ---

  function allocateColumn(freeColumns, activeColumns, nextColumnRef) {
    const activeCols = new Set(activeColumns.values());
    freeColumns.sort((a, b) => b - a);
    while (freeColumns.length > 0) {
      const col = freeColumns.pop();
      if (!activeCols.has(col)) return { col, nextColumn: nextColumnRef };
    }
    return { col: nextColumnRef, nextColumn: nextColumnRef + 1 };
  }

  // --- Folded hooks ---

  function buildFoldedHooksMap(interactions) {
    // Clear stale annotations from previous render
    for (const interaction of interactions) {
      if (interaction._foldedPreHooks) delete interaction._foldedPreHooks;
    }

    const toolUseToParent = new Map();
    for (const interaction of interactions) {
      if (interaction.isHook || interaction.isMcp) continue;
      for (const tc of extractToolCalls(interaction)) {
        if (tc.id) toolUseToParent.set(tc.id, interaction);
      }
    }
    const foldedIds = new Set();
    const parentHooks = new Map();
    const hookParentInfo = new Map();
    for (const interaction of interactions) {
      if (!interaction.isHook || !/PreToolUse/i.test(interaction.hookEvent) || interaction.toolName !== 'Agent') continue;
      const parent = interaction.toolUseId ? toolUseToParent.get(interaction.toolUseId) : null;
      if (!parent) continue;
      foldedIds.add(interaction.id);
      if (!parentHooks.has(parent.id)) parentHooks.set(parent.id, []);
      const hooks = parentHooks.get(parent.id);
      hookParentInfo.set(interaction.id, { parentId: parent.id, hookIndex: hooks.length });
      hooks.push(interaction);
    }
    for (const [pid, hooks] of parentHooks) {
      const p = interactions.find(i => i.id === pid);
      if (p) p._foldedPreHooks = hooks;
    }
    _foldedHookIds = foldedIds;
    _foldedHookParentInfo = hookParentInfo;
    return { foldedIds, hookParentInfo };
  }

  // --- Clamped hooks: collapse a turn's tool-lifecycle hooks into its node ---

  // Tool lifecycle plus the ambient environment events a turn's tools cause
  // (a Bash cd emits CwdChanged, an Edit emits FileChanged). These are
  // side effects of the anchor turn, not events in their own right, so they
  // belong inside its node rather than as full-width rows below it.
  const CLAMP_EVENTS = /^(PreToolUse|PostToolUse|PostToolBatch|PostToolUseFailure|TaskCreated|TaskCompleted|CwdChanged|FileChanged|ConfigChange|InstructionsLoaded|Notification)$/i;

  // Could this entry end up inside some turn's node? The live append path asks
  // before deciding whether it may place the entry itself: which turn owns it
  // is only knowable from the full interaction list, so a candidate always has
  // to hand off to a rebuild.
  function isClampCandidate(interaction) {
    if (interaction.isHook) {
      return CLAMP_EVENTS.test(interaction.hookEvent || '') && interaction.toolName !== 'Agent';
    }
    return !interaction.isMcp && !isStandardLlm(interaction);
  }

  // Assignment is by OWNERSHIP, not by scanning outward from the anchor. A
  // PreToolUse/PostToolUse hook carries the tool_use_id of the call that fired
  // it, so the turn whose response emitted that tool_use block owns it — no
  // matter what else landed in between. The old forward scan stopped dead at
  // the first boundary hook (SubagentStop, UserPromptSubmit), interleaved turn,
  // or zero-tool narration turn in the column and orphaned the entire tail
  // behind it into full-height rows; that is why identical hook runs collapsed
  // in one place and not in another.
  //
  // Ambient events (PostToolBatch, CwdChanged, FileChanged, ...) carry no
  // tool_use_id. They fall back to proximity: they join whichever anchor their
  // column is currently filling — the owner of the last hook clamped there,
  // else the last turn seen in that column.
  function buildClampGroups(interactions, columnFor) {
    // A hook landing more than a minute after its anchor finished is far enough
    // down the timeline that burying it in that node would misplace it in time,
    // so ownership yields and it keeps its own row.
    const PROXIMITY_WINDOW = 60000;

    for (const interaction of interactions) {
      if (interaction._clampedHooks) delete interaction._clampedHooks;
    }

    // tool_use_id -> the turn that emitted it. Anchors are always real LLM
    // turns; count_tokens sidecars and MCP calls are clampable, never anchors.
    const ownerByToolUseId = new Map();
    for (const interaction of interactions) {
      if (interaction.isHook || interaction.isMcp || !isStandardLlm(interaction)) continue;
      for (const tc of extractToolCalls(interaction)) {
        if (tc.id && !ownerByToolUseId.has(tc.id)) ownerByToolUseId.set(tc.id, interaction);
      }
    }

    const clampedIds = new Set();
    const clampParentInfo = new Map();
    const groups = new Map();
    // Per column: the anchor that column is currently filling, for ambient events.
    const fillingAnchor = new Map();

    for (const candidate of interactions) {
      const col = columnFor.get(candidate.id) || 0;

      if (!candidate.isHook && !candidate.isMcp && isStandardLlm(candidate)) {
        // A real turn: from here on this column's ambient events belong to it.
        fillingAnchor.set(col, candidate);
        continue;
      }

      let owned = false;
      if (candidate.isHook) {
        if (_foldedHookIds.has(candidate.id)) continue;
        if (!CLAMP_EVENTS.test(candidate.hookEvent || '')) continue;
        if (candidate.toolName === 'Agent') continue;
      } else if (candidate.isMcp) {
        continue;
      }
      // else: a non-standard LLM entry (count_tokens) — proximity only.

      let anchor = null;
      if (candidate.isHook && candidate.toolUseId) {
        anchor = ownerByToolUseId.get(candidate.toolUseId) || null;
        owned = !!anchor;
      }
      // The owning turn may not be rendered yet (still streaming, so absent from
      // this pass) — fall back to proximity rather than orphaning the hook.
      if (!anchor) anchor = fillingAnchor.get(col) || null;
      if (!anchor || anchor === candidate) continue;

      const anchorEndTs = anchor.timestamp + (anchor.timing?.duration || 0);
      if (candidate.timestamp - anchorEndTs > PROXIMITY_WINDOW) continue;

      if (!groups.has(anchor.id)) groups.set(anchor.id, { anchor, entries: [] });
      groups.get(anchor.id).entries.push(candidate);
      clampedIds.add(candidate.id);
      // An owned hook re-points its column at that owner, so the PostToolBatch
      // closing the run joins the same group even when a narration turn or a
      // sibling lane's turn was the last thing seen in this column.
      if (owned) fillingAnchor.set(col, anchor);
    }

    for (const { anchor, entries } of groups.values()) {
      entries.sort((a, b) => a.timestamp - b.timestamp);
      anchor._clampedHooks = entries;
      for (let k = 0; k < entries.length; k++) {
        clampParentInfo.set(entries[k].id, { parentId: anchor.id, hookIndex: k });
      }
    }

    _clampedHookIds = clampedIds;
    _clampedHookParentInfo = clampParentInfo;
    return { clampedIds, clampParentInfo };
  }

  // --- Subagent attribution by spawning-prompt match ---

  // The prompt a parent passes to an Agent tool call appears verbatim in that
  // subagent's own request messages. This uniquely identifies a subagent turn —
  // even among identical concurrent agents — when server-side enrichment hasn't
  // (yet) stamped subagent.agentId.

  function normWhitespace(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function turnUserText(interaction) {
    const msgs = interaction.request?.messages;
    if (!Array.isArray(msgs)) return '';
    const parts = [];
    for (const m of msgs) {
      if (m.role !== 'user') continue;
      if (typeof m.content === 'string') parts.push(m.content);
      else if (Array.isArray(m.content)) {
        for (const b of m.content) if (b.type === 'text' && b.text) parts.push(b.text);
      }
    }
    return normWhitespace(parts.join('\n'));
  }

  // --- Column assignment ---

  function buildColumnAssignment(interactions, registerSubagentFn) {
    // Clear inferred subagent assignments from previous renders so they don't
    // pollute the agentLastIdx pre-scan or hook resolution on re-render.
    for (const interaction of interactions) {
      if (interaction._subagentInferred) {
        delete interaction.subagent;
        delete interaction._subagentInferred;
      }
    }

    const columnFor = new Map();
    const activeColumns = new Map();
    const historicalColumns = new Map();
    const columnAgents = new Map();
    const freeColumns = [];
    const parallelRegions = [];
    const postHookClosedCol = new Map();
    const columnSegments = [];
    const activeSegments = new Map();
    const startToolUseToSeg = new Map();
    const pendingPreHooks = [];
    const depthAt = new Array(interactions.length);
    let nextColumn = 1;
    let currentRegion = null;

    // Pre-scan: find the last interaction index for each agentId.
    // Checks subagent.agentId on enriched interactions AND hookAgentId on
    // SubagentStart/SubagentStop hooks (which carry agent_id directly).
    const agentLastIdx = new Map();
    for (let i = 0; i < interactions.length; i++) {
      const aid = interactions[i].subagent?.agentId
        || (interactions[i].isHook && interactions[i].hookAgentId) || null;
      if (aid) agentLastIdx.set(aid, i);
    }

    // Pre-scan: collect PostToolUse/Agent hooks for segment matching after the main loop.
    const postAgentHooks = [];
    // Pre-scan: collect SubagentStop hooks for segment matching (merge arrows).
    const subagentStopHooks = [];
    for (let i = 0; i < interactions.length; i++) {
      const int = interactions[i];
      if (int.isHook && /PostToolUse/i.test(int.hookEvent) && int.toolName === 'Agent') {
        postAgentHooks.push({ id: int.id, idx: i, toolUseId: int.toolUseId, description: int.request?.tool_input?.description });
      }
      if (int.isHook && int.hookEvent === 'SubagentStop' && int.subagent?.agentId) {
        subagentStopHooks.push({ id: int.id, idx: i, agentId: int.subagent.agentId });
      }
    }

    const agentToolCalls = [];
    for (let i = 0; i < interactions.length; i++) {
      const int = interactions[i];
      if (int.isHook || int.isMcp) continue;
      const tools = extractToolCalls(int);
      for (const tc of tools) {
        if (tc.name !== 'Agent' || !tc.id) continue;
        const desc = tc.input?.description || null;
        const agentId = 'pending-' + tc.id;
        if (!agentLastIdx.has(agentId) && desc) {
          agentLastIdx.set(agentId, i);
        }
        const probe = normWhitespace(tc.input?.prompt).slice(0, 200);
        agentToolCalls.push({ toolUseId: tc.id, description: desc, agentId, parentIdx: i, subagentType: tc.input?.subagent_type || null, promptProbe: probe.length >= 30 ? probe : null });
      }
    }
    const toolUseToEagerAgent = new Map();
    for (const atc of agentToolCalls) {
      toolUseToEagerAgent.set(atc.toolUseId, atc);
    }

    // --- Attribution precompute ---
    // Resolve every Agent tool call's toolUseId to a real agentId, and use the
    // spawning-prompt probe to attribute unenriched subagent turns to a column.

    // toolUseId -> real agentId. Two sources, both reliable:
    //  1. FIFO pairing of PreToolUse/Agent hooks with the next SubagentStart.
    //  2. An enriched turn whose user text contains a tool call's prompt probe.
    const realAgentForToolUse = new Map();
    {
      const preQueue = [];
      for (const int of interactions) {
        if (!int.isHook) continue;
        if (/PreToolUse/i.test(int.hookEvent) && int.toolName === 'Agent' && int.toolUseId) {
          preQueue.push(int.toolUseId);
        } else if (int.hookEvent === 'SubagentStart' && int.hookAgentId) {
          const tuid = preQueue.shift();
          if (tuid) realAgentForToolUse.set(tuid, int.hookAgentId);
        }
      }
    }
    const probeToolCalls = agentToolCalls.filter(atc => atc.promptProbe);
    function matchTurnToToolUse(interaction) {
      if (probeToolCalls.length === 0) return null;
      const text = turnUserText(interaction);
      if (!text) return null;
      for (const atc of probeToolCalls) {
        if (text.includes(atc.promptProbe)) return atc.toolUseId;
      }
      return null;
    }
    for (const int of interactions) {
      if (int.isHook || int.isMcp) continue;
      const aid = int.subagent?.agentId;
      if (!aid) continue;
      const tuid = matchTurnToToolUse(int);
      if (tuid && !realAgentForToolUse.has(tuid)) realAgentForToolUse.set(tuid, aid);
    }

    // Unenriched standard-LLM turn -> agentId, via its spawning-prompt probe.
    const inferredAgentForTurn = new Map();
    for (const int of interactions) {
      if (int.isHook || int.isMcp || int.subagent?.agentId || !isStandardLlm(int)) continue;
      const tuid = matchTurnToToolUse(int);
      if (!tuid) continue;
      const realAid = realAgentForToolUse.get(tuid);
      const aid = realAid || ('pending-' + tuid);
      inferredAgentForTurn.set(int.id, { agentId: aid, toolUseId: tuid });
    }

    // Extend agentLastIdx using PostToolUse/Agent hooks so columns stay
    // open until the agent actually returns (not just until the last
    // enriched turn, which can be too early with partial enrichment).
    for (const ph of postAgentHooks) {
      if (!ph.toolUseId) continue;
      const eager = toolUseToEagerAgent.get(ph.toolUseId);
      if (!eager) continue;
      const current = agentLastIdx.get(eager.agentId);
      if (current !== undefined && ph.idx > current) {
        agentLastIdx.set(eager.agentId, ph.idx);
      }
    }

    for (let idx = 0; idx < interactions.length; idx++) {
      const interaction = interactions[idx];
      let agentId = null;
      if (interaction.isHook) {
        agentId = interaction.subagent?.agentId || interaction.hookAgentId
          || resolveHookAgentId(interaction, interactions.slice(0, idx));
      } else {
        agentId = interaction.subagent?.agentId || null;
        // Fallback for trace-less sessions: the server stamps subagent.agentId
        // authoritatively from Claude's transcripts when available, so this only
        // runs when enrichment is absent. Attributes an unenriched subagent turn
        // via the spawning prompt the parent passed to the Agent tool call —
        // works even with identical concurrent agents; main-thread turns (incl.
        // server-side web searches) match nothing and stay on main.
        if (!agentId) {
          const inferred = inferredAgentForTurn.get(interaction.id);
          if (inferred) {
            // Bind to whichever key the column currently lives under: the real
            // agentId once SubagentStart has reconciled it, otherwise the eager
            // pending key. Avoids allocating a duplicate column.
            const pendingKey = 'pending-' + inferred.toolUseId;
            if (activeColumns.has(inferred.agentId) || historicalColumns.has(inferred.agentId)) {
              agentId = inferred.agentId;
            } else if (activeColumns.has(pendingKey) || historicalColumns.has(pendingKey)) {
              agentId = pendingKey;
            } else {
              agentId = inferred.agentId;
            }
            const col = activeColumns.get(agentId) ?? historicalColumns.get(agentId);
            const agentSub = col != null ? columnAgents.get(col) : null;
            if (agentSub) {
              interaction.subagent = { ...agentSub };
              interaction._subagentInferred = true;
            }
          }
        }
      }

      if (interaction.isHook && interaction.hookEvent && /PreToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent') {
        pendingPreHooks.push({ id: interaction.id, toolUseId: interaction.toolUseId, description: interaction.request?.tool_input?.description });
      }

      // Eager column creation: when this LLM turn contains Agent tool calls
      // but no enrichment has arrived yet, create columns from the pre-scanned
      // agentToolCalls mapping so subagent lanes appear immediately.
      if (!interaction.isHook && !interaction.isMcp && !agentId) {
        const tools = extractToolCalls(interaction);
        for (const tc of tools) {
          if (tc.name !== 'Agent' || !tc.id) continue;
          const eager = toolUseToEagerAgent.get(tc.id);
          if (!eager) continue;
          // Key the lane by the real agentId when known (FIFO-resolved from
          // SubagentStart), so the eager column and the announced agent are the
          // same column — no duplicate lane, no reconciliation needed.
          const eagerAid = realAgentForToolUse.get(tc.id) || eager.agentId;
          if (activeColumns.has(eagerAid) || historicalColumns.has(eagerAid)) continue;
          const alloc = allocateColumn(freeColumns, activeColumns, nextColumn);
          nextColumn = alloc.nextColumn;
          activeColumns.set(eagerAid, alloc.col);
          historicalColumns.set(eagerAid, alloc.col);
          const synSub = { agentId: eagerAid, agentType: eager.subagentType || 'agent', description: eager.description };
          if (registerSubagentFn) registerSubagentFn(synSub);
          columnAgents.set(alloc.col, synSub);
          let startHookId = null;
          let startToolUseId = null;
          if (eager.description && pendingPreHooks.length > 0) {
            const mi = pendingPreHooks.findIndex(ph => ph.description === eager.description);
            if (mi >= 0) {
              startHookId = pendingPreHooks[mi].id;
              startToolUseId = pendingPreHooks[mi].toolUseId;
              pendingPreHooks.splice(mi, 1);
            }
          }
          const seg_ = { col: alloc.col, agentId: eagerAid, subagent: synSub, startIdx: idx, endHookId: null, startHookId };
          columnSegments.push(seg_);
          activeSegments.set(eagerAid, seg_);
          if (startToolUseId) startToolUseToSeg.set(startToolUseId, seg_);
        }
      }

      // SubagentStop must never open a new column — only close existing ones
      if (interaction.isHook && interaction.hookEvent === 'SubagentStop'
          && agentId && !activeColumns.has(agentId) && !historicalColumns.has(agentId)) {
        agentId = null;
      }

      // SubagentStart: reconcile with a pending eager column so we don't
      // create a second column before JSONL enrichment links the two IDs.
      if (interaction.isHook && interaction.hookEvent === 'SubagentStart'
          && agentId && !activeColumns.has(agentId) && !historicalColumns.has(agentId)) {
        let pendingKey = null, pendingCount = 0;
        const startToolUseId = interaction.subagent?.toolUseId;
        if (startToolUseId) {
          const exactKey = 'pending-' + startToolUseId;
          if (activeColumns.has(exactKey)) { pendingKey = exactKey; pendingCount = 1; }
        }
        if (!pendingKey) {
          for (const [aid] of activeColumns) {
            if (typeof aid === 'string' && aid.startsWith('pending-')) { pendingKey = aid; pendingCount++; }
          }
        }
        if (pendingCount === 1 && pendingKey) {
          const col = activeColumns.get(pendingKey);
          activeColumns.delete(pendingKey);
          activeColumns.set(agentId, col);
          historicalColumns.delete(pendingKey);
          historicalColumns.set(agentId, col);
          if (interaction.subagent) {
            if (registerSubagentFn) registerSubagentFn(interaction.subagent);
            columnAgents.set(col, interaction.subagent);
          }
          const seg = activeSegments.get(pendingKey);
          if (seg) {
            activeSegments.delete(pendingKey);
            seg.agentId = agentId;
            if (interaction.subagent) seg.subagent = interaction.subagent;
            activeSegments.set(agentId, seg);
          }
          agentLastIdx.delete(pendingKey);
        }
      }

      if (agentId && !activeColumns.has(agentId) && !historicalColumns.has(agentId)) {
        const alloc = allocateColumn(freeColumns, activeColumns, nextColumn);
        const col = alloc.col;
        nextColumn = alloc.nextColumn;
        activeColumns.set(agentId, col);
        historicalColumns.set(agentId, col);
        if (interaction.subagent) {
          if (registerSubagentFn) registerSubagentFn(interaction.subagent);
          columnAgents.set(col, interaction.subagent);
        }
        let startHookId = null;
        let startToolUseId2 = null;
        const subToolUseId = interaction.subagent?.toolUseId;
        if (subToolUseId && pendingPreHooks.length > 0) {
          const matchIdx = pendingPreHooks.findIndex(ph => ph.toolUseId === subToolUseId);
          if (matchIdx >= 0) {
            startHookId = pendingPreHooks[matchIdx].id;
            startToolUseId2 = pendingPreHooks[matchIdx].toolUseId;
            pendingPreHooks.splice(matchIdx, 1);
          }
        }
        if (!startHookId && pendingPreHooks.length === 1) {
          startHookId = pendingPreHooks[0].id;
          startToolUseId2 = pendingPreHooks[0].toolUseId;
          pendingPreHooks.splice(0, 1);
        }
        const seg = { col, agentId, subagent: interaction.subagent, startIdx: idx, endHookId: null, startHookId };
        columnSegments.push(seg);
        if (startToolUseId2) startToolUseToSeg.set(startToolUseId2, seg);
        activeSegments.set(agentId, seg);
      }

      const resolvedCol = agentId
        ? (activeColumns.get(agentId) || historicalColumns.get(agentId) || 0)
        : 0;
      if (resolvedCol > 0 && interaction.subagent) {
        const existing = columnAgents.get(resolvedCol);
        if (!existing || (existing.agentType === 'agent' && interaction.subagent.agentType && interaction.subagent.agentType !== 'agent')) {
          if (registerSubagentFn) registerSubagentFn(interaction.subagent);
          columnAgents.set(resolvedCol, interaction.subagent);
          const seg = activeSegments.get(agentId);
          if (seg) seg.subagent = interaction.subagent;
        }
      }
      // PostToolUse/Agent hooks always go to column 0 (main thread)
      const assignedCol = (interaction.isHook && /PostToolUse/i.test(interaction.hookEvent) && interaction.toolName === 'Agent')
        ? 0 : resolvedCol;
      columnFor.set(interaction.id, assignedCol);

      // Free columns when we pass the agent's last interaction
      if (agentId && activeColumns.has(agentId) && agentLastIdx.get(agentId) === idx) {
        const closedCol = activeColumns.get(agentId);
        const seg = activeSegments.get(agentId);
        if (seg) activeSegments.delete(agentId);
        freeColumns.push(closedCol);
        activeColumns.delete(agentId);
      }

      // Explicit close: PostToolUse/Agent hooks signal the agent returned
      if (interaction.isHook && /PostToolUse/i.test(interaction.hookEvent)
          && interaction.toolName === 'Agent' && interaction.toolUseId) {
        let closed = false;
        const eager = toolUseToEagerAgent.get(interaction.toolUseId);
        if (eager && activeColumns.has(eager.agentId)) {
          const closingId = eager.agentId;
          const closedCol = activeColumns.get(closingId);
          const seg = activeSegments.get(closingId);
          if (seg) activeSegments.delete(closingId);
          freeColumns.push(closedCol);
          activeColumns.delete(closingId);
          closed = true;
        }
        if (!closed) {
          const respAgentId = interaction.response?.body?.agentId;
          if (respAgentId && activeColumns.has(respAgentId)) {
            const closedCol = activeColumns.get(respAgentId);
            const seg = activeSegments.get(respAgentId);
            if (seg) activeSegments.delete(respAgentId);
            freeColumns.push(closedCol);
            activeColumns.delete(respAgentId);
          }
        }
      }

      depthAt[idx] = activeColumns.size;

      const inParallel = activeColumns.size > 0;
      if (inParallel && !currentRegion) {
        currentRegion = { startIdx: idx, endIdx: idx, startTime: interaction.timestamp, endTime: interaction.timestamp };
      } else if (inParallel && currentRegion) {
        currentRegion.endIdx = idx;
        currentRegion.endTime = interaction.timestamp;
      } else if (!inParallel && currentRegion) {
        currentRegion.endIdx = idx;
        currentRegion.endTime = interaction.timestamp;
        parallelRegions.push(currentRegion);
        currentRegion = null;
      }
    }
    if (currentRegion) parallelRegions.push(currentRegion);

    // Match remaining PreToolUse/Agent hooks to segments that missed them during
    // eager column creation (PreToolUse hooks arrive after the LLM turn that spawned them).
    for (const ph of pendingPreHooks) {
      const eager = toolUseToEagerAgent.get(ph.toolUseId);
      if (eager) {
        const seg = columnSegments.find(s => s.agentId === eager.agentId && !s.startHookId);
        if (seg) { seg.startHookId = ph.id; startToolUseToSeg.set(ph.toolUseId, seg); continue; }
      }
      if (ph.description) {
        const seg = columnSegments.find(s => !s.startHookId && s.subagent?.description === ph.description);
        if (seg) { seg.startHookId = ph.id; startToolUseToSeg.set(ph.toolUseId, seg); }
      }
    }

    // Match PostToolUse/Agent hooks to segments for merge arrows.
    // Best signal: toolUseId links the Post hook to the same segment as its Pre hook.
    // Fallback: description matching (fragile with duplicate descriptions).
    for (const ph of postAgentHooks) {
      let matched = false;
      if (ph.toolUseId && startToolUseToSeg.has(ph.toolUseId)) {
        const seg = startToolUseToSeg.get(ph.toolUseId);
        if (seg && !seg.endHookId) {
          seg.endHookId = ph.id;
          postHookClosedCol.set(ph.id, seg.col);
          matched = true;
        }
      }
      if (!matched) {
        const unclosed = columnSegments.filter(s => !s.endHookId);
        if (unclosed.length === 1) {
          unclosed[0].endHookId = ph.id;
          postHookClosedCol.set(ph.id, unclosed[0].col);
        }
      }
    }

    // Match SubagentStop hooks to segments by agentId for merge arrows.
    for (const sh of subagentStopHooks) {
      for (const seg of columnSegments) {
        if (seg.endHookId) continue;
        if (seg.agentId === sh.agentId) {
          seg.endHookId = sh.id;
          postHookClosedCol.set(sh.id, seg.col);
          break;
        }
      }
    }

    // Compact columns: remove columns that have no events assigned to them.
    // Column 0 (main thread) is always kept.
    const usedCols = new Set([0]);
    for (const col of columnFor.values()) usedCols.add(col);
    const sortedUsed = [...usedCols].sort((a, b) => a - b);

    if (sortedUsed.length < nextColumn) {
      const colRemap = new Map();
      for (let i = 0; i < sortedUsed.length; i++) colRemap.set(sortedUsed[i], i);

      for (const [id, col] of columnFor) columnFor.set(id, colRemap.get(col) ?? col);

      const remappedAgents = new Map();
      for (const [col, agent] of columnAgents) {
        const nc = colRemap.get(col);
        if (nc !== undefined) remappedAgents.set(nc, agent);
      }
      columnAgents.clear();
      for (const [k, v] of remappedAgents) columnAgents.set(k, v);

      const keptSegs = [];
      for (const seg of columnSegments) {
        const nc = colRemap.get(seg.col);
        if (nc !== undefined) { seg.col = nc; keptSegs.push(seg); }
      }
      columnSegments.length = 0;
      columnSegments.push(...keptSegs);

      const remappedPost = new Map();
      for (const [id, col] of postHookClosedCol) remappedPost.set(id, colRemap.get(col) ?? col);
      postHookClosedCol.clear();
      for (const [k, v] of remappedPost) postHookClosedCol.set(k, v);

      const remappedActive = new Map();
      for (const [aid, col] of activeColumns) {
        const nc = colRemap.get(col);
        if (nc !== undefined) remappedActive.set(aid, nc);
      }
      activeColumns.clear();
      for (const [k, v] of remappedActive) activeColumns.set(k, v);

      const remappedHist = new Map();
      for (const [aid, col] of historicalColumns) {
        const nc = colRemap.get(col);
        if (nc !== undefined) remappedHist.set(aid, nc);
      }
      historicalColumns.clear();
      for (const [k, v] of remappedHist) historicalColumns.set(k, v);

      freeColumns.length = 0;

      nextColumn = sortedUsed.length;
    }

    return { columnFor, totalColumns: nextColumn, columnAgents, activeColumns, historicalColumns, freeColumns, nextColumn, parallelRegions, postHookClosedCol, columnSegments, depthAt };
  }

  // --- Node height ---

  function computeNodeHeight(interaction) {
    if (interaction.isHook) return 28;
    if (!isStandardLlm(interaction)) return 28;
    if (interaction.isMcp) return 42;
    const tools = extractToolCalls(interaction);
    const foldedCount = interaction._foldedPreHooks?.length || 0;
    const clampedCount = interaction._clampedHooks?.length || 0;
    // more than one clamped item collapses to a single summary row
    const clampedRows = clampedCount > 1 ? 1 : clampedCount;
    const clampedPad = clampedCount > 0 ? 4 : 0;
    // + NODE_BORDER: the node box is border-box, so its 1px top/bottom border
    // eats into the content area the header and tool rows have to fit in.
    return D3_CONST.MIN_ENTRY_HEIGHT + D3_CONST.NODE_BORDER
      + (tools.length + foldedCount + clampedRows) * D3_CONST.TOOL_HEIGHT + clampedPad;
  }

  // --- Column width ---

  function computeColumnWidth(_totalColumns) {
    return D3_CONST.COLUMN_WIDTH;
  }

  // --- Parallel cohort detection ---
  // A cohort = >=2 lanes (columnSegments) whose first rendered entry starts
  // within COHORT_EPSILON_MS of each other. These were dispatched in parallel
  // (same fork batch) and should share a start rail / merge join bus rather
  // than cascading diagonally.
  function buildCohorts(layout, columnSegments) {
    if (!columnSegments || columnSegments.length === 0) return [];
    const byId = new Map();
    for (const item of layout) {
      if (item.height > 0) byId.set(item.id, item);
    }
    // First and last visible entry per segment.
    const segInfos = [];
    for (const seg of columnSegments) {
      let first = null, last = null;
      for (const item of layout) {
        if (item.height <= 0) continue;
        if (item.col !== seg.col) continue;
        if (item.interaction.subagent?.agentId !== seg.agentId) continue;
        if (first === null || item.idx < first.idx) first = item;
        if (last === null || item.idx > last.idx) last = item;
      }
      if (first) segInfos.push({ seg, first, last, startElapsed: first.elapsed });
    }
    if (segInfos.length < 2) return [];
    segInfos.sort((a, b) => a.startElapsed - b.startElapsed);

    const cohorts = [];
    let group = [segInfos[0]];
    for (let i = 1; i < segInfos.length; i++) {
      if (segInfos[i].startElapsed - group[0].startElapsed <= D3_CONST.COHORT_EPSILON_MS) {
        group.push(segInfos[i]);
      } else {
        if (group.length >= 2) cohorts.push(group);
        group = [segInfos[i]];
      }
    }
    if (group.length >= 2) cohorts.push(group);
    return cohorts;
  }

  // --- Main layout pass ---

  // Time-aligned layout via longest-path on a forward-in-time constraint graph.
  //
  // The vertical axis is a SHARED time axis across every column. Two rules:
  //   • a box's TOP sits at y(startTime)  → boxes that start together align.
  //   • a box's BOTTOM sits at y(endTime) → boxes that end together align;
  //     a box stretches taller than its content when a denser parallel lane
  //     forces that wall-clock interval to need more pixels.
  //
  // We model this as lower-bound constraints  y(v) - y(u) >= w  on a graph whose
  // nodes are the distinct start/end times. Every edge points forward in time, so
  // the graph is a DAG and the minimal satisfying assignment is the LONGEST PATH —
  // computed in one linear relaxation pass over nodes in time order. The "densest
  // thread sets the pace" property falls out for free: in any interval the longest
  // path picks the max height required across all columns.
  //
  // endTime reflects the end of all of a box's SYNCHRONOUS tool calls: clamped
  // hooks are folded into the box and extend its end. Async children (Workflow /
  // subagent lanes) live in their own columns, so they never inflate the parent.
  function computeD3Layout(interactions, columnFor, totalColumns, parallelRegions, postHookClosedCol, _depthAt, columnSegments) {
    const C = D3_CONST;
    const TOP = C.HEADER_HEIGHT + 8;
    const availWidth = computeColumnWidth(totalColumns);
    const sessionStart = interactions.length > 0 ? interactions[0].timestamp : 0;
    const breaks = [];

    // --- Phase 1: gather renderable boxes (folded/clamped hooks render 0-height) ---
    const boxes = [];
    const boxByIdx = new Map();
    for (let idx = 0; idx < interactions.length; idx++) {
      const interaction = interactions[idx];
      if (_foldedHookIds.has(interaction.id) || _clampedHookIds.has(interaction.id)) continue;
      const col = columnFor.get(interaction.id) || 0;
      const height = computeNodeHeight(interaction);
      const start = interaction.timestamp - sessionStart;
      // Hooks render as fixed-height chips; ignore their recorded duration so a
      // PostToolUse waiting on parallel agents never stretches or spans idle gaps.
      let end = interaction.isHook ? start : start + (interaction.timing?.duration || 0);
      const clamped = interaction._clampedHooks;
      if (clamped) {
        for (const h of clamped) {
          const he = (h.timestamp - sessionStart) + (h.timing?.duration || 0);
          if (he > end) end = he;
        }
      }
      if (end < start) end = start;
      const box = { idx, interaction, col, height, start, end };
      boxes.push(box);
      boxByIdx.set(idx, box);
    }

    // Per-column box lists (sorted by start) for stacking + merge constraints.
    const colBoxes = new Map();
    for (const b of boxes) {
      if (!colBoxes.has(b.col)) colBoxes.set(b.col, []);
      colBoxes.get(b.col).push(b);
    }
    for (const arr of colBoxes.values()) {
      arr.sort((a, b) => a.start - b.start || a.end - b.end || a.idx - b.idx);
    }

    // Within a single column the timeline is strictly sequential, so cap each
    // box's stretch-end at the next box's start. This is what keeps the layout
    // bullet-proof: same-column intervals become non-overlapping, so every
    // constraint edge points forward in time and no box can overlap another in
    // its lane. A lane's terminal box has no successor, so it still stretches to
    // its true end and aligns with its merge point. Per-column sequence index
    // (seqInCol) gives a stable tie-break for equal-time anchors.
    for (const arr of colBoxes.values()) {
      for (let i = 0; i < arr.length; i++) {
        arr[i]._seq = i;
        const next = arr[i + 1];
        if (next && arr[i].end > next.start) arr[i].end = next.start;
        if (arr[i].end < arr[i].start) arr[i].end = arr[i].start;
      }
    }

    // --- Phase 2: anchor clustering → time nodes ---
    // Each box contributes a START anchor and an END anchor. Anchors within
    // ALIGN_EPSILON across DIFFERENT columns share one node, so cross-column
    // simultaneous events line up on a single row. Two rules keep every later
    // constraint edge pointing forward (src node < dst node), which is what makes
    // the longest-path pass valid and overlap-free:
    //   • column guard — a cluster never holds two anchors from the same column;
    //   • forward guard — an anchor only joins a cluster whose index is greater
    //     than the previous anchor's index in the same column. Clusters are
    //     created in ascending time order, so node index ↑ with time. The guard
    //     therefore guarantees, per lane, start₀ < end₀ < start₁ < end₁ < …
    // Among eligible clusters we pick the EARLIEST so a true simultaneous-start
    // row absorbs every lane, rather than each lane peeling into the next row.
    const ALIGN_EPSILON = 60; // ms; above batch-dispatch jitter, well under a deliberate stagger
    const anchors = [];
    for (const b of boxes) {
      b._startAnchor = { time: b.start, col: b.col, seq: b._seq, kind: 0 };
      b._endAnchor = { time: b.end, col: b.col, seq: b._seq, kind: 1 };
      anchors.push(b._startAnchor, b._endAnchor);
    }
    anchors.sort((a, b) => a.time - b.time || a.col - b.col || a.seq - b.seq || a.kind - b.kind);

    const clusters = []; // { time (rep = min), cols:Set }
    const lastNodeForCol = new Map();
    for (const a of anchors) {
      const floor = lastNodeForCol.has(a.col) ? lastNodeForCol.get(a.col) : -1;
      let chosen = -1;
      // Scan recent clusters (descending index) while still within the time
      // window; remember the earliest eligible one.
      for (let c = clusters.length - 1; c > floor && c >= 0; c--) {
        const cl = clusters[c];
        if (a.time - cl.time > ALIGN_EPSILON) break;
        if (!cl.cols.has(a.col)) chosen = c;
      }
      if (chosen >= 0) {
        clusters[chosen].cols.add(a.col);
        a.node = chosen;
      } else {
        a.node = clusters.length;
        clusters.push({ time: a.time, cols: new Set([a.col]) });
      }
      lastNodeForCol.set(a.col, a.node);
    }
    const N = clusters.length;
    const times = clusters.map(c => c.time);

    // adjacency: adj[u] = [{to, w}], every edge forward (to > u by construction)
    const adj = Array.from({ length: N }, () => []);
    function addEdge(s, d, w) {
      if (s == null || d == null || s >= d || w <= 0) return;
      adj[s].push({ to: d, w });
    }

    // Edge 1: monotonic spine between consecutive nodes. Idle gaps (long real time
    // with no box spanning them) collapse to a zigzag break.
    const breakSpine = [];
    for (let i = 0; i < N - 1; i++) {
      let w = 0;
      const gap = times[i + 1] - times[i];
      if (gap > C.ZIGZAG_MIN_CUT) {
        const spanned = boxes.some(b => b.start <= times[i] && b.end >= times[i + 1]);
        if (!spanned) { w = GAP_COLLAPSE_HEIGHT; breakSpine.push(i); }
      }
      adj[i].push({ to: i + 1, w });
    }

    // Edge 2: end-alignment / stretch — bottom is at least `height` below the top.
    for (const b of boxes) {
      addEdge(b._startAnchor.node, b._endAnchor.node, b.height);
    }

    // Edge 3: same-column stacking — each box clears the previous one in its lane.
    for (const arr of colBoxes.values()) {
      for (let i = 0; i < arr.length - 1; i++) {
        const a = arr[i], n = arr[i + 1];
        addEdge(a._startAnchor.node, n._startAnchor.node, a.height + C.MIN_GAP);
        addEdge(a._endAnchor.node, n._startAnchor.node, C.MIN_GAP);
      }
    }

    // Edge 4: merge-point hooks (PostToolUse/Agent on main) sit below the column
    // they close — the parallel barrier resumes main only after the lane finished.
    if (postHookClosedCol) {
      for (const b of boxes) {
        const closedCol = postHookClosedCol.get(b.interaction.id);
        if (closedCol == null) continue;
        const arr = colBoxes.get(closedCol);
        if (!arr) continue;
        let latest = null;
        for (const cb of arr) {
          if (cb.start < b.start && (latest == null || cb.end > latest.end)) latest = cb;
        }
        if (latest) addEdge(latest._endAnchor.node, b._startAnchor.node, C.MIN_GAP);
      }
    }

    // --- Phase 3: longest-path relaxation (node order is topological order) ---
    const yAt = new Array(N).fill(TOP);
    for (let i = 0; i < N; i++) {
      const yi = yAt[i];
      for (const e of adj[i]) {
        if (yi + e.w > yAt[e.to]) yAt[e.to] = yi + e.w;
      }
    }

    // Record break markers now that node Ys are known.
    for (const i of breakSpine) {
      breaks.push({
        y: (yAt[i] + yAt[i + 1]) / 2,
        elapsedBefore: times[i],
        elapsedAfter: times[i + 1],
      });
    }

    // --- Phase 4: place boxes; build layout in original interaction order ---
    const layout = [];
    let finalBottom = TOP;
    for (let idx = 0; idx < interactions.length; idx++) {
      const interaction = interactions[idx];
      const elapsed = interaction.timestamp - sessionStart;
      const b = boxByIdx.get(idx);
      if (!b) {
        layout.push({ id: interaction.id, x: 0, y: 0, width: 0, height: 0, col: 0, interaction, elapsed, idx });
        continue;
      }
      const top = yAt[b._startAnchor.node];
      const bottom = yAt[b._endAnchor.node];
      const height = interaction.isHook ? b.height : Math.max(b.height, bottom - top);
      const x = C.RULER_WIDTH + b.col * (availWidth + C.COLUMN_GAP);
      const timeBottom = top + height;
      layout.push({ id: interaction.id, x, y: top, width: availWidth, height, col: b.col, interaction, elapsed, idx, timeBottom });
      if (timeBottom > finalBottom) finalBottom = timeBottom;
    }

    // Cohorts (for merge-bus routing). Starts are already time-aligned.
    const cohorts = buildCohorts(layout, columnSegments);

    // Exact monotonic elapsed→Y interpolation over the node map (ruler + connectors).
    function elapsedToY(t) {
      if (N === 0) return TOP;
      if (t <= times[0]) return yAt[0];
      if (t >= times[N - 1]) return yAt[N - 1];
      for (let i = 0; i < N - 1; i++) {
        if (times[i] <= t && t <= times[i + 1]) {
          const dt = times[i + 1] - times[i];
          if (dt === 0) return yAt[i];
          return yAt[i] + ((t - times[i]) / dt) * (yAt[i + 1] - yAt[i]);
        }
      }
      return yAt[N - 1];
    }

    const cohortAgentGroups = cohorts.map(group => group.map(ci => ci.seg.agentId));
    return { layout, totalHeight: finalBottom + 40, sessionStart, breaks, compressedY: elapsedToY, cohorts: cohortAgentGroups };
  }

  // --- Connector data (fork/merge arrows, bgRects) ---

  function computeConnectorData(layout, columnFor, columnAgents, totalColumns, elapsedToY, sessionStart, postHookClosedCol, columnSegments, opts) {
    const SUBAGENT_COLORS = opts?.subagentColors || ['#6366f1'];
    const getSubagentColor = opts?.getSubagentColor || (() => SUBAGENT_COLORS[0]);
    const connectors = [];
    const colWidth = computeColumnWidth(totalColumns);

    // Parallel-cohort merge routing: members of the same cohort merge through a
    // shared horizontal join bus instead of each drawing its own arrow to main.
    const cohortGroups = opts?.cohorts || [];
    const cohortIdxForAgent = new Map();
    for (let ci = 0; ci < cohortGroups.length; ci++) {
      for (const aid of cohortGroups[ci]) cohortIdxForAgent.set(aid, ci);
    }
    // Per-cohort accumulators. Members of a cohort (agents that started together)
    // fork/merge through a shared hub circle instead of each drawing its own arc.
    const cohortMerge = new Map();
    const cohortFork = new Map();
    const HUB_R = 8;       // hub circle radius
    const HUB_GAP = 16;    // gap between the hub and the nearest lane edge

    // Smooth S-curve whose END tangent matches the dominant travel direction, so
    // an `orient:auto` arrowhead always points ALONG the visible line at the tip.
    // Horizontally-dominant connectors get horizontal control handles (tangent
    // horizontal at the ends); vertically-dominant ones get vertical handles.
    function sCurve(x0, y0, x1, y1) {
      if (Math.abs(x1 - x0) >= Math.abs(y1 - y0)) {
        const mx = (x0 + x1) / 2;
        return `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
      }
      const my = (y0 + y1) / 2;
      return `M${x0},${y0} C${x0},${my} ${x1},${my} ${x1},${y1}`;
    }

    const layoutById = new Map();
    const colEntries = new Map();
    for (const item of layout) {
      layoutById.set(item.id, item);
      if (!colEntries.has(item.col)) colEntries.set(item.col, []);
      colEntries.get(item.col).push(item);
    }
    const mainEntries = (colEntries.get(0) || []).filter(item => !_foldedHookIds.has(item.id) && !_clampedHookIds.has(item.id));

    const hookEntryById = new Map();
    for (const me of mainEntries) hookEntryById.set(me.id, me);

    // toolUseId → the exact tool-call ROW (center point) that issued it, across
    // every LLM turn in any column. A subagent forks from the row of the Agent/
    // Workflow tool call that spawned it, keyed precisely by id, not by proximity.
    const toolCallRowById = new Map();
    for (const item of layout) {
      const it = item.interaction;
      if (it.isHook || it.isMcp || item.height <= 0) continue;
      const tools = extractToolCalls(it);
      for (let ti = 0; ti < tools.length; ti++) {
        if (!tools[ti].id) continue;
        toolCallRowById.set(tools[ti].id, {
          x: item.x + item.width / 2,
          y: item.y + D3_CONST.MIN_ENTRY_HEIGHT + ti * D3_CONST.TOOL_HEIGHT + D3_CONST.TOOL_HEIGHT / 2,
        });
      }
    }
    // toolUseId → its PostToolUse/Agent (or /Workflow) hook entry on main. A
    // subagent merges back into the exact PostToolUse row for the same toolUseId.
    const postRowById = new Map();
    for (const me of mainEntries) {
      const it = me.interaction;
      if (it.isHook && /PostToolUse/i.test(it.hookEvent || '') && it.toolUseId) {
        postRowById.set(it.toolUseId, { x: me.x + me.width / 2, y: me.y + me.height / 2 });
      }
    }
    // The toolUseId of the tool call that spawned this segment. The PreToolUse
    // start hook carries it directly; the SubagentStop end hook carries it on
    // subagent.toolUseId. Either resolves to the same Agent/Workflow tool call.
    function segToolUseId(seg) {
      if (seg.startHookId) {
        const tuid = layoutById.get(seg.startHookId)?.interaction?.toolUseId;
        if (tuid) return tuid;
      }
      if (seg.endHookId) {
        const endInt = layoutById.get(seg.endHookId)?.interaction;
        if (endInt?.toolUseId) return endInt.toolUseId;
        if (endInt?.subagent?.toolUseId) return endInt.subagent.toolUseId;
      }
      return null;
    }
    const segSpawnRow = (seg) => { const t = segToolUseId(seg); return t ? toolCallRowById.get(t) || null : null; };
    const segMergeRow = (seg) => { const t = segToolUseId(seg); return t ? postRowById.get(t) || null : null; };

    // Workflow cohort → spawning Workflow tool call.
    // A Workflow() tool call fans out a batch of workflow-subagents that all start
    // together (one cohort). Anchor that cohort's fork to the exact Workflow tool
    // row in its parent turn, instead of the generic "nearest main entry above".
    // The SubagentStart hooks carry no toolUseId, so we pair by order: the k-th
    // workflow cohort (in start-time order) ↔ the k-th Workflow tool call.
    const subagentByAgentId = new Map();
    for (const seg of columnSegments || []) {
      if (seg.agentId && seg.subagent) subagentByAgentId.set(seg.agentId, seg.subagent);
    }
    const isWorkflowCohort = (ci) => {
      const aids = cohortGroups[ci] || [];
      return aids.length > 0 && aids.every(aid => subagentByAgentId.get(aid)?.agentType === 'workflow-subagent');
    };
    const workflowCallOrigins = [];
    for (const me of mainEntries) {
      if (me.interaction.isHook || me.interaction.isMcp) continue;
      const tools = extractToolCalls(me.interaction);
      for (let ti = 0; ti < tools.length; ti++) {
        if (tools[ti].name !== 'Workflow') continue;
        workflowCallOrigins.push({
          x: me.x + me.width / 2,
          y: me.y + D3_CONST.MIN_ENTRY_HEIGHT + ti * D3_CONST.TOOL_HEIGHT + D3_CONST.TOOL_HEIGHT / 2,
        });
      }
    }
    const workflowCohortSet = new Set();
    const cohortOriginOverride = new Map();
    {
      let k = 0;
      for (let ci = 0; ci < cohortGroups.length; ci++) {
        if (!isWorkflowCohort(ci)) continue;
        workflowCohortSet.add(ci);
        if (k < workflowCallOrigins.length) cohortOriginOverride.set(ci, workflowCallOrigins[k]);
        k++;
      }
    }

    for (const seg of columnSegments || []) {
        const entries = (colEntries.get(seg.col) || []).filter(item => {
          const aid = item.interaction.subagent?.agentId;
          return aid === seg.agentId;
        });
        if (entries.length === 0) continue;

        const color = seg.subagent ? getSubagentColor(seg.subagent) : SUBAGENT_COLORS[0];
        const bgLeft = D3_CONST.RULER_WIDTH + seg.col * (colWidth + D3_CONST.COLUMN_GAP) - 4;
        const bgTop = entries[0].y - 4;
        const lastEntry = entries[entries.length - 1];

        const bgBottom = (lastEntry.timeBottom || (lastEntry.y + computeNodeHeight(lastEntry.interaction))) + 4;
        const hookEntry = seg.endHookId ? hookEntryById.get(seg.endHookId) : null;

        // Fork arrow
        let forkOriginY = bgTop;
        let forkOriginX = D3_CONST.RULER_WIDTH + colWidth / 2;
        const spawnRow = segSpawnRow(seg);
        const startHookEntry = seg.startHookId ? hookEntryById.get(seg.startHookId) : null;
        if (spawnRow) {
          // Best signal: the exact Agent/Workflow tool-call row that spawned this
          // subagent, resolved by toolUseId.
          forkOriginX = spawnRow.x;
          forkOriginY = spawnRow.y;
        } else if (startHookEntry) {
          forkOriginY = startHookEntry.y + startHookEntry.height / 2;
          forkOriginX = startHookEntry.x + startHookEntry.width / 2;
        } else if (seg.startHookId && _foldedHookIds.has(seg.startHookId)) {
          const info = _foldedHookParentInfo.get(seg.startHookId);
          if (info) {
            const parentItem = layoutById.get(info.parentId);
            if (parentItem) {
              const tools = extractToolCalls(parentItem.interaction);
              forkOriginY = parentItem.y + D3_CONST.MIN_ENTRY_HEIGHT
                + tools.length * D3_CONST.TOOL_HEIGHT
                + info.hookIndex * D3_CONST.TOOL_HEIGHT
                + D3_CONST.TOOL_HEIGHT / 2;
              forkOriginX = parentItem.x + parentItem.width / 2;
            }
          }
        } else {
          for (let i = mainEntries.length - 1; i >= 0; i--) {
            if (mainEntries[i].y <= entries[0].y) {
              forkOriginY = mainEntries[i].y + mainEntries[i].height / 2;
              forkOriginX = mainEntries[i].x + mainEntries[i].width / 2;
              break;
            }
          }
        }

        // Fork: arc upward, ending at center of subagent top border
        const forkTargetX = bgLeft + (colWidth + 8) / 2;
        const forkCohortIdx = cohortIdxForAgent.get(seg.agentId);
        if (forkCohortIdx != null) {
          // Cohort member: stash this lane's entry point and the common origin
          // (where the fork leaves main). The hub + spokes are emitted after the
          // loop so all lanes share one bent arrow into a single circle.
          // Prefer the exact spawning tool-call row (resolved by toolUseId);
          // fall back to the order-paired Workflow row, then the generic origin.
          const override = spawnRow || cohortOriginOverride.get(forkCohortIdx);
          const isWf = workflowCohortSet.has(forkCohortIdx);
          if (!cohortFork.has(forkCohortIdx)) {
            cohortFork.set(forkCohortIdx, {
              spokes: [],
              originX: override ? override.x : forkOriginX,
              originY: override ? override.y : forkOriginY,
              originFixed: !!override,
              workflow: isWf,
              color,
            });
          }
          const cf = cohortFork.get(forkCohortIdx);
          // Use the earliest (highest) origin so the bent arrow starts from the
          // spawning point above every lane — unless we have an exact spawning
          // tool-call origin (Workflow row), which is authoritative.
          if (!cf.originFixed && forkOriginY < cf.originY) { cf.originY = forkOriginY; cf.originX = forkOriginX; }
          cf.spokes.push({ x: forkTargetX, top: bgTop, color });
        } else {
          connectors.push({
            type: 'fork', col: seg.col,
            path: sCurve(forkOriginX, forkOriginY, forkTargetX, bgTop),
            color, opacity: 0.6, strokeWidth: 2.5, agentId: seg.agentId,
          });
        }

        // Merge arrow: only when the segment actually ended (has endHookId)
        if (seg.endHookId) {
          let mergeTargetY = null;
          let mergeTargetX = D3_CONST.RULER_WIDTH + colWidth / 2;
          const mergeRow = segMergeRow(seg);
          if (mergeRow) {
            // Best signal: the PostToolUse row for this segment's spawning tool
            // call, keyed by toolUseId.
            mergeTargetX = mergeRow.x;
            mergeTargetY = mergeRow.y;
          } else if (hookEntry) {
            mergeTargetY = hookEntry.y + hookEntry.height / 2;
            mergeTargetX = hookEntry.x + hookEntry.width / 2;
          } else if (_foldedHookIds.has(seg.endHookId)) {
            const info = _foldedHookParentInfo.get(seg.endHookId);
            if (info) {
              const parentItem = layoutById.get(info.parentId);
              if (parentItem) {
                const tools = extractToolCalls(parentItem.interaction);
                mergeTargetY = parentItem.y + D3_CONST.MIN_ENTRY_HEIGHT
                  + tools.length * D3_CONST.TOOL_HEIGHT
                  + info.hookIndex * D3_CONST.TOOL_HEIGHT
                  + D3_CONST.TOOL_HEIGHT / 2;
                mergeTargetX = parentItem.x + parentItem.width / 2;
              }
            }
          } else {
            for (const me of mainEntries) {
              if (me.y >= bgBottom - 4) {
                mergeTargetY = me.y + me.height / 2;
                mergeTargetX = me.x + me.width / 2;
                break;
              }
            }
          }
          if (mergeTargetY != null) {
            const bgCenterX = bgLeft + (colWidth + 8) / 2;
            const cohortIdx = cohortIdxForAgent.get(seg.agentId);
            if (cohortIdx != null) {
              // Cohort member: stash this lane's exit point; the join bus and the
              // single shared arrow to main are emitted after the loop.
              if (!cohortMerge.has(cohortIdx)) {
                cohortMerge.set(cohortIdx, { tribs: [], targetY: mergeTargetY, targetX: mergeTargetX, workflow: workflowCohortSet.has(cohortIdx) });
              }
              const cm = cohortMerge.get(cohortIdx);
              // Use the lowest (latest-finishing) lane's target — a parallel
              // barrier resumes main only after the last lane completes.
              if (mergeTargetY > cm.targetY) { cm.targetY = mergeTargetY; cm.targetX = mergeTargetX; }
              cm.tribs.push({ x: bgCenterX, bottom: bgBottom, color });
            } else {
              connectors.push({
                type: 'merge', col: seg.col,
                path: sCurve(bgCenterX, bgBottom, mergeTargetX, mergeTargetY),
                color, opacity: 0.6, strokeWidth: 2.5, agentId: seg.agentId,
              });
            }
          }
        }

        connectors.push({
          type: 'bgRect', col: seg.col,
          x: bgLeft, y: bgTop, width: colWidth + 8, height: bgBottom - bgTop,
          color, agentId: seg.agentId,
          isStreaming: entries.some(e => e.interaction.status === 'streaming'),
        });
    }

    // Emit cohort FORK hubs. A single bent arrow leaves main and ends at a
    // bold-bordered hub circle centered above the lane entry points; straight
    // spokes then run from the hub down into each lane's top.
    for (const cf of cohortFork.values()) {
      if (cf.spokes.length === 0) continue;
      const xs = cf.spokes.map(s => s.x);
      const hubX = (Math.min(...xs) + Math.max(...xs)) / 2;
      const spokeTop = Math.min(...cf.spokes.map(s => s.top));
      const hubY = spokeTop - HUB_GAP - HUB_R;
      const color = cf.color;
      const wf = cf.workflow;
      // Bent arrow from main's origin into the hub circle. Workflow arrows connect
      // to the circle CENTER (covered by the filled circle drawn on top); others
      // stop at the circle's top edge.
      const hubTopY = hubY - HUB_R;
      const arrowEndY = wf ? hubY : hubTopY;
      connectors.push({
        type: 'fork', col: 0,
        path: sCurve(cf.originX, cf.originY, hubX, arrowEndY),
        color, opacity: wf ? 0.95 : 0.6, strokeWidth: wf ? 3.5 : 2.5, dashed: wf,
      });
      // Straight spokes from the hub to each lane entry point. Workflow spokes
      // start at the circle CENTER (covered by the filled circle); others at its
      // bottom edge.
      const forkSpokeY = wf ? hubY : hubY + HUB_R;
      for (const s of cf.spokes) {
        connectors.push({
          type: 'hub-spoke', col: 0,
          path: `M${hubX},${forkSpokeY} L${s.x},${s.top}`,
          color: s.color, opacity: wf ? 0.75 : 0.5, strokeWidth: wf ? 3 : 2, dashed: wf,
        });
      }
      connectors.push({ type: 'hub', col: 0, cx: hubX, cy: hubY, r: HUB_R, color, filled: wf });
    }

    // Emit cohort MERGE hubs. Straight spokes run from each lane's bottom up to a
    // bold-bordered hub circle centered below the lanes; a single bent arrow then
    // drops from the hub into main.
    for (const cm of cohortMerge.values()) {
      if (cm.tribs.length === 0) continue;
      const xs = cm.tribs.map(t => t.x);
      const hubX = (Math.min(...xs) + Math.max(...xs)) / 2;
      const spokeBottom = Math.max(...cm.tribs.map(t => t.bottom));
      const hubY = spokeBottom + HUB_GAP + HUB_R;
      const color = cm.tribs[0].color;
      const wf = cm.workflow;
      // Straight spokes from each lane bottom to the hub circle. Workflow spokes
      // end at the circle CENTER (covered by the filled circle); others at its
      // top edge.
      const mergeSpokeY = wf ? hubY : hubY - HUB_R;
      for (const t of cm.tribs) {
        connectors.push({
          type: 'hub-spoke', col: 0,
          path: `M${t.x},${t.bottom} L${hubX},${mergeSpokeY}`,
          color: t.color, opacity: wf ? 0.75 : 0.5, strokeWidth: wf ? 3 : 2, dashed: wf,
        });
      }
      // Single bent arrow from the hub down into main. Workflow arrows start from
      // the circle CENTER (covered by the filled circle); others from its bottom edge.
      const arrowStartY = wf ? hubY : hubY + HUB_R;
      connectors.push({
        type: 'merge', col: 0,
        path: sCurve(hubX, arrowStartY, cm.targetX, cm.targetY),
        color, opacity: wf ? 0.95 : 0.6, strokeWidth: wf ? 3.5 : 2.5, dashed: wf,
      });
      connectors.push({ type: 'hub', col: 0, cx: hubX, cy: hubY, r: HUB_R, color, filled: wf });
    }

    return connectors;
  }

  // --- Public API ---

  function isFoldedHook(id) {
    return _foldedHookIds.has(id);
  }

  function getFoldedHookParentInfo(id) {
    return _foldedHookParentInfo.get(id);
  }

  function isClampedHook(id) {
    return _clampedHookIds.has(id);
  }

  function getClampedHookParentInfo(id) {
    return _clampedHookParentInfo.get(id);
  }

  window.wideLayout = {
    init,
    D3_CONST,
    resolveHookAgentId,
    allocateColumn,
    buildFoldedHooksMap,
    buildClampGroups,
    isClampCandidate,
    buildColumnAssignment,
    computeNodeHeight,
    computeColumnWidth,
    computeD3Layout,
    computeConnectorData,
    isFoldedHook,
    getFoldedHookParentInfo,
    isClampedHook,
    getClampedHookParentInfo,
  };
})();
