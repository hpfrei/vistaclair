// Pure layout helpers for the Desks window manager (public/desks.js) and the
// restore planner. No DOM: test/desks-layout.test.js runs them in node.
//
// Geometry on the server is fractions of the desk area { x, y, w, h } (0..1),
// so a window keeps its place when the browser window changes size. On
// screen it is pixels { left, top, width, height } relative to the area.
(function (root) {
  const MIN_W = 220;      // px: a window is never smaller than this
  const MIN_H = 120;
  const SNAP_EDGE = 16;   // px from an edge that starts a snap
  const SNAP_CORNER = 80; // px from a corner along the edge that makes a quarter

  const round = (v) => Math.round(v * 10000) / 10000;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // fractions → pixels in an area { width, height }
  function toPx(g, area) {
    return {
      left: Math.round(g.x * area.width),
      top: Math.round(g.y * area.height),
      width: Math.round(g.w * area.width),
      height: Math.round(g.h * area.height),
    };
  }

  // pixels → fractions (rounded to 4 places, so a round trip is stable)
  function toFrac(r, area) {
    const W = area.width || 1, H = area.height || 1;
    return { x: round(r.left / W), y: round(r.top / H), w: round(r.width / W), h: round(r.height / H) };
  }

  // A pixel rect put back into the area: no larger than the area, no smaller
  // than the minimum (unless the area is), wholly inside it.
  function clampPx(r, area, min = { width: MIN_W, height: MIN_H }) {
    const W = Math.max(0, area.width), H = Math.max(0, area.height);
    const width = clamp(r.width, Math.min(min.width, W), W);
    const height = clamp(r.height, Math.min(min.height, H), H);
    const left = clamp(r.left, 0, Math.max(0, W - width));
    const top = clamp(r.top, 0, Math.max(0, H - height));
    return { left, top, width, height };
  }

  // Fractions kept in view for this area size: through pixels and back.
  function clampFrac(g, area, min) {
    return toFrac(clampPx(toPx(g, area), area, min), area);
  }

  // The snap zone a drag pointer { x, y } (relative to the area) is in, or
  // null: 'left' | 'right' | 'top' (maximize) | 'tl' | 'tr' | 'bl' | 'br'.
  function snapZone(p, area, edge = SNAP_EDGE, corner = SNAP_CORNER) {
    const W = area.width, H = area.height;
    const nearL = p.x <= edge, nearR = p.x >= W - edge;
    const nearT = p.y <= edge, nearB = p.y >= H - edge;
    const inTop = p.y <= corner, inBottom = p.y >= H - corner;
    const inLeft = p.x <= corner, inRight = p.x >= W - corner;
    if (nearL || nearR) {
      const side = nearL ? 'l' : 'r';
      if (inTop) return 't' + side;
      if (inBottom) return 'b' + side;
      return nearL ? 'left' : 'right';
    }
    if (nearT) {
      if (inLeft) return 'tl';
      if (inRight) return 'tr';
      return 'top';
    }
    if (nearB && (inLeft || inRight)) return 'b' + (inLeft ? 'l' : 'r');
    return null;
  }

  // The fraction rect of a snap zone.
  function snapRect(zone) {
    switch (zone) {
      case 'left': return { x: 0, y: 0, w: 0.5, h: 1 };
      case 'right': return { x: 0.5, y: 0, w: 0.5, h: 1 };
      case 'top': return { x: 0, y: 0, w: 1, h: 1 };
      case 'tl': return { x: 0, y: 0, w: 0.5, h: 0.5 };
      case 'tr': return { x: 0.5, y: 0, w: 0.5, h: 0.5 };
      case 'bl': return { x: 0, y: 0.5, w: 0.5, h: 0.5 };
      case 'br': return { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
      default: return null;
    }
  }

  // n windows in a grid: columns = ceil(sqrt(n)); the last row's windows
  // share its whole width. Fractions, in order.
  function tile(n) {
    if (!(n > 0)) return [];
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const out = [];
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / cols);
      const inRow = row === rows - 1 ? n - cols * (rows - 1) : cols;
      const col = i - row * cols;
      out.push({ x: round(col / inRow), y: round(row / rows), w: round(1 / inRow), h: round(1 / rows) });
    }
    return out;
  }

  // Where a new window goes: cascaded from the top left.
  function cascade(i) {
    const step = (i % 8) * 0.03;
    return { x: round(0.05 + step), y: round(0.05 + step), w: 0.5, h: 0.6 };
  }

  // Resize a pixel rect by dragging an edge or corner (dir: n s e w ne nw se
  // sw) by dx, dy; the opposite edge stays put and the minimum holds.
  function resizePx(r, dir, dx, dy, min = { width: MIN_W, height: MIN_H }) {
    let { left, top, width, height } = r;
    if (dir.includes('e')) width = Math.max(min.width, r.width + dx);
    if (dir.includes('s')) height = Math.max(min.height, r.height + dy);
    if (dir.includes('w')) { width = Math.max(min.width, r.width - dx); left = r.left + r.width - width; }
    if (dir.includes('n')) { height = Math.max(min.height, r.height - dy); top = r.top + r.height - height; }
    return { left, top, width, height };
  }

  // What to do with each window of a desk when it is drawn: 'mount' (its tab
  // is open: move it in), 'missing' (its kind is known but the tab is not
  // open: a placeholder with Reopen and Remove from desk) or 'unregistered'
  // (no host for its kind, e.g. an add-on not installed: a placeholder, the
  // entry kept). Every entry gets a plan; none is dropped.
  function planRestore(windows, { hasKind, hasTab }) {
    return (windows || []).map((w) => {
      let status;
      if (!hasKind(w.kind)) status = 'unregistered';
      else status = hasTab(w.kind, w.key) ? 'mount' : 'missing';
      return { kind: w.kind, key: w.key, status };
    });
  }

  const api = { MIN_W, MIN_H, toPx, toFrac, clampPx, clampFrac, snapZone, snapRect, tile, cascade, resizePx, planRestore };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.deskLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
