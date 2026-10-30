// The lines between an orchestrator's box and its workers' boxes in the SDK
// run panel: which lines a piece of traffic lights and which way it moves on
// each, which workers an [orchestration] delivery speaks for, and the guard
// that lets the two copies of one message light the lines once. Kept free of
// the DOM so test/sdk-links.test.js can run them. The view is in
// public/sdk-panel.js (drawLinks, flashLink).
(function (root) {
  // Every line runs from the orchestrator's box (its start) down to a
  // worker's box (its end). Data leaving a worker moves up its line, data
  // reaching a worker moves down its line; the orchestrator has no line of
  // its own. from / to: the two ends as the panel knows them ({ role, … }),
  // or null when not shown. [{ at, dir: 'up' | 'down' }].
  function linkFlashes(from, to) {
    if (from && from === to) return [];
    const out = [];
    if (from?.role === 'worker') out.push({ at: from, dir: 'up' });
    if (to?.role === 'worker') out.push({ at: to, dir: 'down' });
    return out;
  }

  // Event kinds of an [orchestration] delivery that carry a worker's own
  // output to the orchestrator: its report, its last words going idle, its
  // exit. The landing's events (landed, not landed, undone, overlap) come
  // from the platform, not from the worker.
  const DELIVERY_KINDS = new Set(['report', 'idle', 'exited']);

  // The workers an "[orchestration] N worker event(s) …" notice speaks for,
  // in order, once each. Its event lines read `- [kind] <worker> …`
  // (src/orchestration.js takeEvents).
  function deliveryWorkers(text) {
    const s = String(text || '');
    if (!/^\[orchestration\] \d+ worker event/.test(s)) return [];
    const out = [];
    for (const m of s.matchAll(/^- \[([^\]]+)\] (\S+)/gm)) {
      if (DELIVERY_KINDS.has(m[1]) && !out.includes(m[2])) out.push(m[2]);
    }
    return out;
  }

  // A SendMessage reaches the panel twice, on the sender's session and on
  // the receiver's; either may be the only one seen live (a released box
  // gets no feed). once(key, now) is true for the first sighting of a key
  // within ms.
  function onceWithin(ms) {
    const seen = new Map();
    return (key, now = Date.now()) => {
      for (const [k, t] of seen) if (now - t >= ms) seen.delete(k);
      if (seen.has(key)) return false;
      seen.set(key, now);
      return true;
    };
  }

  const api = { linkFlashes, DELIVERY_KINDS, deliveryWorkers, onceWithin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.sdkLinks = api;
})(typeof window !== 'undefined' ? window : globalThis);
