// Holds WebSocket messages that no handler consumed yet, so an add-on whose
// client module registers late (after the licence check) still gets what the
// server sent on connect. Pure: the clock is passed in, nothing touches the DOM.
(function (root) {
  const MAX = 1000;
  const TTL_MS = 60000;

  function createPendingQueue({ max = MAX, ttlMs = TTL_MS } = {}) {
    let items = [];

    function prune(now) {
      items = items.filter((it) => now - it.at <= ttlMs);
      if (items.length > max) items = items.slice(items.length - max);
    }

    return {
      push(msg, now) {
        prune(now);
        items.push({ msg, at: now });
        if (items.length > max) items.shift();
      },
      // Removes and returns, in arrival order, the live messages whose type
      // starts with `prefix`. The rest stay queued for other prefixes.
      take(prefix, now) {
        prune(now);
        const taken = [];
        const kept = [];
        for (const it of items) (it.msg.type.startsWith(prefix) ? taken : kept).push(it);
        items = kept;
        return taken.map((it) => it.msg);
      },
      size() { return items.length; },
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createPendingQueue, MAX, TTL_MS };
  else root.createPendingQueue = createPendingQueue;
})(typeof window !== 'undefined' ? window : globalThis);
