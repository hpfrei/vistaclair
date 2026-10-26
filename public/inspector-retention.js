// What an inspector tab keeps in the browser, and for how long. Every turn of
// a long session carries the whole conversation so far, so a page that kept
// each one whole grew without bound. The server sends turns as summaries
// (src/dashboard-ws.js summarizeForInit); full detail is fetched for the turn
// on screen and trimmed back once it is not. These are the decisions, kept
// free of the DOM so test/inspector-retention.test.js can run them.
(function (root) {
  const LIMITS = {
    // Turns kept at full detail besides the one on screen and the split panes.
    FULL_DETAIL_BUDGET: 10,
    // Turns per session held in the timeline; older ones come back with
    // "Load earlier". Trimmed once the count passes CAP + SLACK, so a busy
    // session doesn't rebuild the timeline on every turn.
    TIMELINE_CAP: 500,
    TIMELINE_SLACK: 50,
    // A turn still pending or streaming after this long is taken as stuck
    // (a timeout, a dropped stream): its buffered events go too.
    STUCK_LIVE_MS: 10 * 60 * 1000,
    // The inspector hidden this long (another view, a background browser
    // tab) drops its detail panel and every full-detail turn.
    HIDDEN_DROP_MS: 15 * 1000,
    // Summaries per "Load earlier" page.
    EARLIER_PAGE: 200,
    // Message rows the Messages sheet renders before "show earlier".
    MESSAGE_ROWS: 300,
  };

  const isLive = i => i.status === 'pending' || i.status === 'streaming';

  function isStuckLive(i, now, stuckMs = LIMITS.STUCK_LIVE_MS) {
    if (!isLive(i)) return false;
    const started = i.timing?.startedAt || i.timestamp || now;
    return now - started > stuckMs;
  }

  /* Which turns to trim back to the summary shape. `recentFull` lists ids
     least recently used first; `keep` holds the selection and the split
     panes. A live turn's request is trimmed like any other — the streaming
     view needs only its events — but it keeps the events until it is stuck.
     Hidden, nothing is exempt. Returns [{ id, dropStream }]: dropStream says
     the buffered events may go even though the turn is still live. */
  function compactionPlan(items, opts = {}) {
    const {
      recentFull = [], keep = new Set(), activeInstance = null, hidden = false,
      now = Date.now(), budget = LIMITS.FULL_DETAIL_BUDGET, stuckMs = LIMITS.STUCK_LIVE_MS,
    } = opts;
    const recent = new Set(recentFull.slice(-budget));
    const out = [];
    for (const i of items) {
      const stuck = isStuckLive(i, now, stuckMs);
      const streamHeld = stuck && i.response?.sseEvents?.length > 0;
      if (i._summary && !streamHeld) continue;
      if (!hidden && keep.has(i.id)) continue;
      if (!hidden && recent.has(i.id) && i.instanceId === activeInstance && !stuck) continue;
      out.push({ id: i.id, dropStream: stuck });
    }
    return out;
  }

  /* The oldest turns of one session to drop from the page once it holds more
     than cap + slack, bringing it back to cap. The selection, split panes and
     turns still live stay. Returns their ids, oldest first. */
  function timelineTrim(items, instanceId, opts = {}) {
    const { cap = LIMITS.TIMELINE_CAP, slack = LIMITS.TIMELINE_SLACK, keep = new Set() } = opts;
    const mine = items.filter(i => i.instanceId === instanceId);
    if (mine.length <= cap + slack) return [];
    let excess = mine.length - cap;
    const out = [];
    for (const i of mine) {
      if (excess <= 0) break;
      if (keep.has(i.id) || isLive(i)) continue;
      out.push(i.id);
      excess--;
    }
    return out;
  }

  /* A live interaction:update / complete for a turn this page holds. The
     server sends a summary; what the page already had that the summary leaves
     out stays: the events it streamed, the response gauge, a subagent
     attribution, and — when this page fetched the turn's detail — the
     conversation, which is fixed once the request is sent. */
  function mergeLiveUpdate(local, incoming) {
    const merged = { ...incoming, response: { ...incoming.response, sseEvents: local.response?.sseEvents || [] } };
    if (local._respChars) merged._respChars = local._respChars;
    if (local.subagent && !merged.subagent) {
      merged.subagent = local.subagent;
      // A guess stays a guess — the next column pass may revise it.
      if (local._subagentInferred) merged._subagentInferred = true;
    }
    if (incoming._summary && !local._summary && local.request && incoming.request && !incoming.isHook) {
      const req = { ...incoming.request };
      for (const k of ['messages', 'tools', 'system']) {
        if (local.request[k] !== undefined) req[k] = local.request[k];
      }
      merged.request = req;
      if (local.translatedBody) merged.translatedBody = local.translatedBody;
      // Still a summary while the response body is cut.
      if (!incoming.response?._bodyTruncated) delete merged._summary;
    }
    return merged;
  }

  /* A turn's full detail (interaction:detail) replacing what the page held.
     Keeps the locally streamed events and gauges, and never moves a turn
     this page saw finish back to live: the reply may have been built just
     before the completion was broadcast. */
  function mergeDetail(local, detail) {
    const merged = { ...detail, response: { ...detail.response } };
    if (local.response?.sseEvents?.length) merged.response.sseEvents = local.response.sseEvents;
    if (local._respChars) merged._respChars = local._respChars;
    if (local.subagent && !merged.subagent) {
      merged.subagent = local.subagent;
      if (local._subagentInferred) merged._subagentInferred = true;
    }
    if (merged.request && local.request) {
      merged.request = { ...merged.request };
      for (const k of ['_messagesChars', '_toolsChars', '_systemChars']) {
        if (local.request[k] !== undefined) merged.request[k] = local.request[k];
      }
    }
    if (isLive(merged) && !isLive(local)) {
      merged.status = local.status;
      if (local.timing) merged.timing = local.timing;
      if (local.usage) merged.usage = local.usage;
      if (merged.response.body === undefined && local.response?.body !== undefined) merged.response.body = local.response.body;
    }
    return merged;
  }

  /* Turns of one conversation share its first message; one copy of each text
     per session, dropped with the session's tab. */
  function createInterner() {
    const scopes = new Map();
    return {
      intern(scope, s) {
        if (typeof s !== 'string') return s;
        let m = scopes.get(scope);
        if (!m) { m = new Map(); scopes.set(scope, m); }
        const hit = m.get(s);
        if (hit !== undefined) return hit;
        m.set(s, s);
        return s;
      },
      drop(scope) { scopes.delete(scope); },
      size(scope) { return scope === undefined ? scopes.size : (scopes.get(scope)?.size || 0); },
    };
  }

  const api = { LIMITS, isLive, isStuckLive, compactionPlan, timelineTrim, mergeLiveUpdate, mergeDetail, createInterner };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.inspectorRetention = api;
})(typeof window !== 'undefined' ? window : globalThis);
