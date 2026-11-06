// The lines between an orchestrator's box and its workers' boxes in the SDK
// run panel: which lines a piece of traffic lights and which way it moves on
// each, when it flies on an arc between two workers instead and that arc's
// shape, which workers an [orchestration] delivery speaks for (none when it
// rides on the owner's own turn), and the guard
// that lets the two copies of one message light the lines once. Kept free of
// the DOM so test/sdk-links.test.js can run them. The view is in
// public/sdk-panel.js (drawLinks, flashLink, flashArc).
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

  // Where a piece of traffic is drawn. Between two workers whose boxes are
  // both in the row it flies straight from the sender's box to the
  // receiver's, on an arc of its own, and lights no line; otherwise it lights
  // the lines linkFlashes names. inRow(end): the end has a box in the row.
  // { arc: { from, to } | null, lines: [{ at, dir }] }.
  function messageRoute(from, to, inRow) {
    if (from?.role === 'worker' && to?.role === 'worker' && from !== to && inRow(from) && inRow(to)) {
      return { arc: { from, to }, lines: [] };
    }
    return { arc: null, lines: linkFlashes(from, to) };
  }

  const ARC_HEAD = 7;    // the arrowhead's length
  const ARC_SHIFT = 6;   // both ends move this far the way the arc goes

  // The arc between two workers' name tags: from the top of the sender's
  // (x1, y1) to the top of the receiver's (x2, y2), drawn in that order so a
  // flash's dashes and pulse run sender → receiver. It bows up by a height
  // that grows with the distance, its top never above ceiling (the head's
  // bottom edge: above it the boxes would hide it), and falls straight onto
  // the receiver's tag under an arrowhead. Both ends shift toward the
  // receiver, so A → B and B → A lie side by side. { d, head }: path data.
  function arcPath(x1, y1, x2, y2, ceiling) {
    const shift = x2 >= x1 ? ARC_SHIFT : -ARC_SHIFT;
    x1 += shift; x2 += shift;
    const base = Math.min(y1, y2);
    const rise = Math.min(Math.max(Math.abs(x2 - x1) * 0.35, 16), Math.max(base - ceiling, 6));
    // A cubic whose two handles sit level peaks 3/4 of the way up to them.
    const c = base - rise / 0.75;
    const tip = y2 - ARC_HEAD;
    const r = (n) => Math.round(n * 10) / 10;
    return {
      d: `M${r(x1)},${r(y1)} C${r(x1)},${r(c)} ${r(x2)},${r(c)} ${r(x2)},${r(tip)}`,
      head: `M${r(x2 - 4)},${r(tip)} L${r(x2)},${r(y2)} L${r(x2 + 4)},${r(tip)} Z`,
    };
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

  // The owner's own turn the CLI is taking in, after command_lifecycle
  // message m: from the 'started' of a turn the owner submitted
  // (isOwnerTurn(id): its chip still waits) until that command moves on; the
  // turn's echo ends it too (the panel clears it then). The orchestrator's
  // UserPromptSubmit hook runs in this window and attaches the worker events
  // still queued (the quiet ones, whose reports lit their lines when they
  // came in): that delivery rides on the owner's input. current: the id
  // before m, or null.
  function intakeAfter(current, m, isOwnerTurn) {
    if (m?.type !== 'command_lifecycle' || !m.command_uuid) return current;
    if (m.state === 'started') return isOwnerTurn(m.command_uuid) ? m.command_uuid : null;
    return m.command_uuid === current ? null : current;
  }

  // The workers whose lines an [orchestration] delivery lights: none while
  // the owner's turn is being taken in (ownerIntake: intakeAfter's id), as
  // that delivery is the owner's doing, not a worker's.
  function deliveryFlashes(text, ownerIntake) {
    return ownerIntake ? [] : deliveryWorkers(text);
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

  const api = { linkFlashes, messageRoute, arcPath, DELIVERY_KINDS, deliveryWorkers, intakeAfter, deliveryFlashes, onceWithin };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.sdkLinks = api;
})(typeof window !== 'undefined' ? window : globalThis);
