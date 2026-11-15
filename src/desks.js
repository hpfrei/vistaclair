// Desks: the dashboard's window-manager views (public/desks.js). Each desk
// holds windows; a window is one second-level tab (a CLI, an Inspector
// instance, an app) moved off its home strip, named by { kind, key } — the
// key is the tab's stable name, never a per-boot tab id. This store is the
// one source of truth for which tab sits on which desk; every dashboard
// renders from it (desks:state, src/ws/desks-handler.js).
//
// What it guarantees (test/desks-store.test.js):
//   - a tab is on at most one desk: a move takes it off every other desk;
//   - an entry is never dropped silently: only an explicit return or a
//     desk's deletion removes one (and a deleted desk can be restored);
//   - the file is written atomically (temporary file, then rename); a corrupt
//     file is moved aside to desks.json.corrupt-<ts> and the store starts
//     empty instead of throwing.
//
// Geometry is fractions of the desk area: { x, y, w, h } in [0, 1].
const fs = require('fs');
const path = require('path');

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX = 80;
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const KEY_MAX = 300;
const TITLE_MAX = 200;
const MAX_DESKS = 50;
const MAX_WINDOWS = 200;

const clamp01 = (v, d) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);

function cleanName(name, fallback) {
  const s = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
  return s || fallback;
}

function cleanGeom(g) {
  if (!g || typeof g !== 'object') return null;
  const w = clamp01(g.w, 0.5), h = clamp01(g.h, 0.5);
  return { x: clamp01(g.x, 0), y: clamp01(g.y, 0), w: Math.max(0.05, w), h: Math.max(0.05, h) };
}

function validKind(kind) { return typeof kind === 'string' && KIND_RE.test(kind); }
function validKey(key) { return typeof key === 'string' && key.length > 0 && key.length <= KEY_MAX; }

// A window entry as stored: unknown fields go, bad values get defaults.
function cleanWindow(w, i = 0) {
  if (!w || !validKind(w.kind) || !validKey(w.key)) return null;
  const step = (i % 8) * 0.03;
  return {
    kind: w.kind,
    key: w.key,
    title: typeof w.title === 'string' ? w.title.slice(0, TITLE_MAX) : '',
    geom: cleanGeom(w.geom) || { x: 0.05 + step, y: 0.05 + step, w: 0.5, h: 0.6 },
    z: Number.isFinite(w.z) ? Math.floor(w.z) : i,
    minimized: w.minimized === true,
    maximized: w.maximized === true,
  };
}

const sameTab = (a, kind, key) => a.kind === kind && a.key === key;

// The state from a parsed file: anything malformed is dropped, a tab listed
// on two desks stays on the first. Returns null when the shape is not a
// desks file at all (the caller treats that as corrupt).
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.desks)) return null;
  const seen = new Set();
  const ids = new Set();
  const desks = [];
  for (const d of raw.desks.slice(0, MAX_DESKS)) {
    if (!d || typeof d.id !== 'string' || !ID_RE.test(d.id) || ids.has(d.id)) continue;
    ids.add(d.id);
    const windows = [];
    for (const [i, w] of (Array.isArray(d.windows) ? d.windows : []).entries()) {
      const cw = cleanWindow(w, i);
      if (!cw) continue;
      const id = `${cw.kind}\u0000${cw.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      windows.push(cw);
    }
    desks.push({ id: d.id, name: cleanName(d.name, 'Desk'), windows: windows.slice(0, MAX_WINDOWS) });
  }
  return { version: 1, desks };
}

function createDesksStore({ file, onChange, now = Date.now, log = console } = {}) {
  if (!file) throw new Error('createDesksStore: file is required');
  let state = { version: 1, desks: [] };
  const listeners = new Set();
  if (onChange) listeners.add(onChange);

  function load() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') log.error?.(`[desks] cannot read ${file}: ${e.message}`);
      return;
    }
    let parsed = null;
    try { parsed = normalize(JSON.parse(text)); } catch { parsed = null; }
    if (parsed) { state = parsed; return; }
    // Corrupt: keep the bytes for the owner, start empty, never throw.
    const backup = `${file}.corrupt-${now()}`;
    try { fs.renameSync(file, backup); } catch (e) { log.error?.(`[desks] cannot back up ${file}: ${e.message}`); }
    log.warn?.(`[desks] ${file} was not a valid desks file; moved to ${backup}, starting empty`);
    state = { version: 1, desks: [] };
    try { save(); } catch {}
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  function changed(op) {
    try { save(); } catch (e) { log.error?.(`[desks] save failed: ${e.message}`); }
    for (const fn of listeners) {
      try { fn(get(), op); } catch (e) { log.error?.('[desks] listener failed:', e); }
    }
    return true;
  }

  // A deep copy: callers never hold the live state.
  function get() { return JSON.parse(JSON.stringify(state)); }

  const deskById = (id) => state.desks.find(d => d.id === id) || null;

  // Where a tab is: { deskId, window } or null.
  function locate(kind, key) {
    for (const d of state.desks) {
      const w = d.windows.find(x => sameTab(x, kind, key));
      if (w) return { deskId: d.id, window: w };
    }
    return null;
  }

  function createDesk({ id, name } = {}) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'bad desk id' };
    if (deskById(id)) return { ok: false, error: 'desk exists' };
    if (state.desks.length >= MAX_DESKS) return { ok: false, error: 'too many desks' };
    const desk = { id, name: cleanName(name, `Desk ${state.desks.length + 1}`), windows: [] };
    state.desks.push(desk);
    changed({ op: 'create', deskId: id });
    return { ok: true, desk: JSON.parse(JSON.stringify(desk)) };
  }

  function renameDesk({ id, name } = {}) {
    const d = deskById(id);
    if (!d) return { ok: false, error: 'no such desk' };
    const n = cleanName(name, d.name);
    if (n === d.name) return { ok: true };
    d.name = n;
    changed({ op: 'rename', deskId: id });
    return { ok: true };
  }

  // Removes the desk; its tabs go home (their entries go with it). The
  // removed desk is returned so the client can offer Undo (restoreDesk).
  function deleteDesk({ id } = {}) {
    const i = state.desks.findIndex(d => d.id === id);
    if (i < 0) return { ok: false, error: 'no such desk' };
    const [desk] = state.desks.splice(i, 1);
    changed({ op: 'delete', deskId: id, desk });
    return { ok: true, desk: JSON.parse(JSON.stringify(desk)), index: i };
  }

  // Undo of a delete: the desk comes back at its place, with every window
  // whose tab has not since been put on another desk.
  function restoreDesk({ desk, index } = {}) {
    const n = normalize({ desks: [desk] });
    const d = n?.desks[0];
    if (!d) return { ok: false, error: 'bad desk' };
    if (deskById(d.id)) return { ok: false, error: 'desk exists' };
    if (state.desks.length >= MAX_DESKS) return { ok: false, error: 'too many desks' };
    d.windows = d.windows.filter(w => !locate(w.kind, w.key));
    const at = Number.isInteger(index) ? Math.min(Math.max(0, index), state.desks.length) : state.desks.length;
    state.desks.splice(at, 0, d);
    changed({ op: 'restore', deskId: d.id });
    return { ok: true };
  }

  // Puts a tab on a desk. It leaves whatever desk it was on (the one-desk
  // invariant); on the same desk only its title and geometry change.
  function moveTab({ deskId, kind, key, title, geom } = {}) {
    if (!validKind(kind) || !validKey(key)) return { ok: false, error: 'bad tab' };
    const d = deskById(deskId);
    if (!d) return { ok: false, error: 'no such desk' };
    const at = locate(kind, key);
    if (at && at.deskId === deskId) {
      if (typeof title === 'string') at.window.title = title.slice(0, TITLE_MAX);
      if (geom) at.window.geom = cleanGeom(geom);
      changed({ op: 'move', deskId, kind, key });
      return { ok: true };
    }
    if (d.windows.length >= MAX_WINDOWS) return { ok: false, error: 'desk full' };
    for (const other of state.desks) other.windows = other.windows.filter(w => !sameTab(w, kind, key));
    const z = d.windows.reduce((m, w) => Math.max(m, w.z), 0) + 1;
    const w = cleanWindow({ kind, key, title, geom, z }, d.windows.length);
    d.windows.push(w);
    changed({ op: 'move', deskId, kind, key, from: at?.deskId || null });
    return { ok: true };
  }

  // The tab goes home: its entry leaves every desk.
  function returnTab({ kind, key } = {}) {
    if (!locate(kind, key)) return { ok: false, error: 'not on a desk' };
    for (const d of state.desks) d.windows = d.windows.filter(w => !sameTab(w, kind, key));
    changed({ op: 'return', kind, key });
    return { ok: true };
  }

  // Geometry, stacking and window state of one window.
  function setWindow({ deskId, kind, key, patch } = {}) {
    const d = deskById(deskId);
    const w = d?.windows.find(x => sameTab(x, kind, key));
    if (!w) return { ok: false, error: 'no such window' };
    const p = patch && typeof patch === 'object' ? patch : {};
    if (p.geom) w.geom = cleanGeom(p.geom);
    if (Number.isFinite(p.z)) w.z = Math.floor(p.z);
    if (typeof p.minimized === 'boolean') w.minimized = p.minimized;
    if (typeof p.maximized === 'boolean') w.maximized = p.maximized;
    if (typeof p.title === 'string') w.title = p.title.slice(0, TITLE_MAX);
    changed({ op: 'window', deskId, kind, key });
    return { ok: true };
  }

  // Many windows at once (Tile all): [{ kind, key, patch }].
  function setWindows({ deskId, windows } = {}) {
    const d = deskById(deskId);
    if (!d || !Array.isArray(windows)) return { ok: false, error: 'no such desk' };
    for (const x of windows) {
      const w = d.windows.find(y => sameTab(y, x?.kind, x?.key));
      const p = x?.patch;
      if (!w || !p || typeof p !== 'object') continue;
      if (p.geom) w.geom = cleanGeom(p.geom);
      if (Number.isFinite(p.z)) w.z = Math.floor(p.z);
      if (typeof p.minimized === 'boolean') w.minimized = p.minimized;
      if (typeof p.maximized === 'boolean') w.maximized = p.maximized;
    }
    changed({ op: 'windows', deskId });
    return { ok: true };
  }

  // A tab's key changed (a CLI whose settings.name arrived): its entry
  // follows. A tab already on a desk under the new key keeps that one.
  function rekey({ kind, from, to } = {}) {
    if (!validKind(kind) || !validKey(from) || !validKey(to) || from === to) return { ok: false, error: 'bad rekey' };
    const at = locate(kind, from);
    if (!at) return { ok: true };
    if (locate(kind, to)) {
      for (const d of state.desks) d.windows = d.windows.filter(w => !sameTab(w, kind, from));
    } else {
      at.window.key = to;
    }
    changed({ op: 'rekey', kind, from, to });
    return { ok: true };
  }

  function onChangeListener(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  load();
  return { get, locate, createDesk, renameDesk, deleteDesk, restoreDesk, moveTab, returnTab, setWindow, setWindows, rekey, onChange: onChangeListener, file };
}

module.exports = { createDesksStore, normalize };
