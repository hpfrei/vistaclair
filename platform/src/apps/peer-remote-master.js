// Remote sessions, master half (docs/remote-sessions.md).
//
// The master launches an Agent SDK session (simple or orchestrator) on a linked
// slave through the peer channel's command plane (peer-channel.js
// remoteCommand / onRemoteFrame; the slave half is peer-remote-slave.js) and
// shows it in its own dashboard as if it were local:
//
//   tabs       each remote tab is `peer-<peer>:<slaveTabId>` on the master
//              (core's tab id rule; hashed when it does not fit; a peer name
//              has no ':', so no peer can name another's tab) with a
//              master-chosen random sessId. Only tabs this master launched, or
//              members of a run it launched, are adopted; at most 50 per peer. With core's
//              ctx.registerExternalSession (feature-detected) it is a normal
//              SDK tab: core routes sdk:send / interrupt / history / auth / kill
//              / close to the adapter here (each awaited, a rejection answered
//              to its requester), and this module broadcasts its sdk:event.
//              The hook's unregister() runs on close, when the peer is
//              unlinked, and at shutdown.
//              Without it there is no tab; the session is still listed and
//              controlled through the module API and the app:peer:session:*
//              messages.
//   frames     everything a slave sends is untrusted: validated against an
//              allowlist of types and fields with size caps (validateFrame),
//              the rest dropped and counted. No slave string becomes a path,
//              HTML, a bus envelope or a Horst sense: every string of a relayed
//              `sdk` event is HTML-escaped (escSdk), ask fields are rebuilt
//              into safe shapes (cleanQuestion).
//   history    never stored here: sdk:history pages are fetched from the slave
//              on demand. Only TODO.md / NOTES.md text is mirrored (for core's
//              sdk:todo), under <dataHome>/peer-remote/<sessId>/, removed when
//              the tab closes.
//   asks       a slave's AskUserQuestion on one of its adopted tabs becomes a
//              master pendingQuestions entry `peer-<peer>:<askId>` with `host` /
//              `remote` and a "[<peer>] " title; the answer goes back to that
//              slave only. At most 5 open per tab and 20 per peer: the oldest
//              is cancelled.
//   billing    per-peer totals { apiKeyUsd, subscriptionUsd, limitHits } from
//              the relayed status events, and whether the slave runs on the
//              master's own Claude account (sameAccount).
//   members    a remote worker of a run on this master (launchMember, for
//              peer-remote-host.js): its tab carries the member { runId,
//              address }; core's SendMessage reaches submit(text, { from })
//              as `member.submit`, and its `rs:msg` (report / message) goes
//              to the onMemberMessage listeners — only for a member tab of
//              that peer, capped, invisible characters shown, rate-limited.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
const FRAME_CAP = 128 * 1024;          // the channel's own frame cap
const STR_CAP = 128 * 1024;
const NODE_CAP = 20000;                // values per cleaned frame
const DEPTH_CAP = 40;
const TEXT_CAP = 4000;                 // question text, notices, alerts
const TITLE_CAP = 120;
const IMAGE_CAP = 120 * 1024;          // one data: URI
const MIRROR_CAP = 256 * 1024;         // TODO.md / NOTES.md each
const PROMPT_CAP = 32 * 1024;
const RESULT_CAP = 4000;
const CMD_TIMEOUT_MS = 30 * 1000;
const RESYNC_GAP_MS = 5 * 1000;
const TABS_PER_PEER = 50;              // adopted from a slave's list
const ASKS_PER_TAB = 5;                // open relayed questions
const ASKS_PER_PEER = 20;
const LAUNCHED_CAP = 200;              // remembered launches per peer
const CLOSED_CAP = 200;                // remembered closed tabs per peer
const MSG_CAP = 32 * 1024;             // a member's report summary or message
const MSG_RATE = 30;                   // rs:msg per member per MSG_WINDOW_MS
const MSG_WINDOW_MS = 60 * 1000;

const FRAME_TYPES = new Set(['rs:event', 'rs:ask', 'rs:askDone', 'rs:state', 'rs:auth', 'rs:msg']);
const REPORT_STATUSES = new Set(['started', 'done', 'failed', 'blocked']);
const ADDRESS_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLATFORM_KINDS = new Set(['status', 'notice', 'files', 'usage-limit', 'message']);
const STATUS_STATES = new Set(['busy', 'idle', 'awaiting', 'paused', 'exited']);
const CREDENTIALS = new Set(['subscription', 'api-key']);
const QUESTION_TYPES = new Set(['select', 'multiselect', 'dropdown', 'text', 'textarea', 'number', 'toggle', 'confirm', 'file']);
const NOTICE_LEVELS = new Set(['info', 'warn', 'warning', 'error']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REMOTE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PEER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;   // peer-pairing.js VALID_PEER_NAME
const QID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const APP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9._-]{1,80}(\[1m\])?$/;
const MODES = new Set(['simple', 'orchestrator', 'worker']);
const AUTHS = new Set(['subscription', 'apikey']);
const ORIGINS = new Set(['owner', 'horst', 'orchestrator']);

let deps = {};
const tabs = new Map();       // master tab id → record
const closed = new Map();     // peer → Set<remoteTabId> the owner closed: never re-adopted (CLOSED_CAP)
const launched = new Map();   // peer → Map<remoteTabId, { runId, mode, origin }>: what may be adopted (persisted)
const asks = new Map();       // master ask id → { peer, remoteAskId, tabId, entryIds: Map<masterId, remoteId> }
const totals = new Map();     // peer → { apiKeyUsd, subscriptionUsd, limitHits }
const stateListeners = new Set();
const memberListeners = new Set();
let peerExtras = null;        // peer-remote-host's per-peer `runs` view (sessionsState)
const drops = { total: 0, byReason: {} };
const lastResync = new Map(); // peer → ms
const resyncTimers = new Map(); // peer → the trailing resync a gated one left
let unsubFrames = null;
let unsubEvents = null;
let unsubBroadcast = null;
let stateTimer = null;
const alerts = new Map();     // peer → { problem, text, at, sawLoggedOut }

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

function drop(reason) {
  drops.total++;
  drops.byReason[reason] = (drops.byReason[reason] || 0) + 1;
  return null;
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------
// A master id for a peer's tab or question, within core's tab id rule
// (external-session.js: [A-Za-z0-9][A-Za-z0-9._:-]*, ≤ 100): `peer-<peer>:<id>`.
// A peer name has no ':', so the first one ends it and no peer can name
// another's id. An id that does not fit as it is (another first character, too
// long, a peer name off the pairing rule) is `peer-<peer>::<prefix>.<hash of
// both>`; the '::' keeps it apart from the plain form.
const TAB_ID_CAP = 100;
const NS_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
function nsId(peer, id) {
  const p = String(peer);
  const r = String(id);
  const okPeer = PEER_NAME_RE.test(p);
  if (okPeer && NS_ID_RE.test(r) && `peer-${p}:${r}`.length <= TAB_ID_CAP) return `peer-${p}:${r}`;
  const h = crypto.createHash('sha256').update(`${p}\n${r}`).digest('hex').slice(0, 24);
  return `peer-${okPeer ? p : 'x'}::${r.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 24)}.${h}`;
}
const masterTabIdOf = nsId;

function isPlain(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

// Plain one-line text: control characters out, capped.
function plain(s, cap = TEXT_CAP) {
  if (typeof s !== 'string') return null;
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, cap);
}

// A member's report or message: \r\n as \n, every character a reader cannot
// see written out as ⟨U+XXXX⟩ (text-safety.js; controls included), capped.
function msgText(s) {
  const t = s.replace(/\r\n?/g, '\n');
  const cut = t.length > MSG_CAP;
  return require('./text-safety').showInvisible(cut ? t.slice(0, MSG_CAP) : t) + (cut ? ' …[cut]' : '');
}

// A slave's error, for a log line and a launch result: one line, capped, and
// a code only of the shape the slave's own codes have.
function cleanErr(e) {
  const out = new Error(plain(String(e?.message ?? e), 300).replace(/[\t\n\u2028\u2029]+/g, ' ') || 'error');
  if (typeof e?.code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(e.code)) out.code = e.code;
  return out;
}

function finite(n) { return typeof n === 'number' && Number.isFinite(n) ? n : null; }

// Text core's ask form renders as markdown without sanitizing (inlineMd), and
// whose image/link syntax it resolves against the master's filesystem: HTML,
// links, images and code spans are escaped, so it reads as text.
function mdText(s, cap = TEXT_CAP) {
  const t = plain(s, cap);
  if (t == null) return null;
  return t.replace(/\\/g, '\\\\').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([[\]`])/g, '\\$1')
    // GFM autolinks: `://` and `www.` read the same, but no longer link.
    .replace(/:\/\//g, '&#58;//').replace(/(www)\./gi, '$1&#46;');
}

// Every string of a relayed `sdk` event, for core's SDK panel: assistant text
// and text deltas reach marked and innerHTML unsanitized (core public/core.js
// renderMarkdown). HTML-escaped — markdown reads an entity as its character —
// and a javascript: / vbscript: scheme is broken by a zero-width space.
// partial_json keeps its quotes, so it still parses.
const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escHtml(s, quotes = true) {
  return s.replace(quotes ? /[&<>"']/g : /[&<>']/g, (c) => HTML_ESC[c]).replace(/(javascript|vbscript)(\\?):/gi, '$1\u200b$2:');
}

function escSdk(v, key = null) {
  if (typeof v === 'string') return escHtml(v, key !== 'partial_json');
  if (Array.isArray(v)) return v.map((x) => escSdk(x));
  if (isPlain(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = escSdk(x, k);
    return out;
  }
  return v;
}

// An sdk:event `ev` as it leaves for the dashboards.
const outEv = (ev) => (ev?.sdk ? { sdk: escSdk(ev.sdk) } : ev);

// An image a form shows: an inline base64 raster only — a path would load
// from the master's disk, a URL from anywhere.
function dataImage(src) {
  return typeof src === 'string' && src.length <= IMAGE_CAP && DATA_IMAGE_RE.test(src) ? src : null;
}

// A JSON-shaped copy with caps on depth, size and node count, prototype keys
// dropped. undefined when the value is unusable.
function deepClean(v, budget = { n: NODE_CAP }, depth = 0) {
  if (--budget.n < 0 || depth > DEPTH_CAP) return undefined;
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v.length <= STR_CAP ? v : v.slice(0, STR_CAP);
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) {
      const c = deepClean(x, budget, depth + 1);
      if (budget.n < 0) return undefined;
      if (c !== undefined) out.push(c);
    }
    return out;
  }
  if (isPlain(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (BAD_KEYS.has(k) || k.length > 200) continue;
      const c = deepClean(x, budget, depth + 1);
      if (budget.n < 0) return undefined;
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

// One sdk:event `ev`: exactly one of sdk / user / platform.
function cleanEv(ev) {
  if (!isPlain(ev)) return null;
  const keys = ['sdk', 'user', 'platform'].filter((k) => ev[k] !== undefined);
  if (keys.length !== 1) return null;
  const k = keys[0];
  if (k === 'sdk') {
    const sdk = deepClean(ev.sdk);
    if (!isPlain(sdk) || typeof sdk.type !== 'string' || sdk.type.length > 64) return null;
    return { sdk };
  }
  if (k === 'user') {
    const u = ev.user;
    if (!isPlain(u)) return null;
    const out = {};
    if (u.id != null) { if (typeof u.id !== 'string' || u.id.length > 128) return null; out.id = u.id; }
    if (u.text != null) { if (typeof u.text !== 'string') return null; out.text = u.text.slice(0, STR_CAP); }
    // Image srcs are master URLs on the master: inline rasters only.
    if (Array.isArray(u.images)) out.images = u.images.map((im) => dataImage(typeof im === 'string' ? im : im?.src)).filter(Boolean).slice(0, 8);
    if (u.pending === true) out.pending = true;
    if (u.cancelled === true) out.cancelled = true;
    if (u.reason != null) out.reason = plain(u.reason, 500);
    if (u.from != null) out.from = plain(u.from, 128);
    if (finite(u.imagesOmitted) != null) out.imagesOmitted = u.imagesOmitted;
    return { user: out };
  }
  const p = ev.platform;
  if (!isPlain(p) || !PLATFORM_KINDS.has(p.kind)) return null;
  if (p.kind === 'status') {
    const out = { kind: 'status' };
    if (p.state != null) { if (!STATUS_STATES.has(p.state)) return null; out.state = p.state; }
    for (const f of ['costUsd', 'baseUsd']) if (finite(p[f]) != null && p[f] >= 0) out[f] = p[f];
    for (const f of ['model', 'actualModel', 'mappedTo']) if (typeof p[f] === 'string' && p[f].length <= 120) out[f] = p[f];
    if (typeof p.showThinking === 'boolean') out.showThinking = p.showThinking;
    if (CREDENTIALS.has(p.credential)) out.credential = p.credential;
    if (AUTHS.has(p.authPending)) out.authPending = p.authPending;
    if (p.limited === true) out.limited = true;
    if (isPlain(p.context)) {
      const c = {};
      for (const f of ['tokens', 'window', 'compactAt']) if (finite(p.context[f]) != null) c[f] = p.context[f];
      if (typeof p.context.windowEstimated === 'boolean') c.windowEstimated = p.context.windowEstimated;
      out.context = c;
    }
    return { platform: out };
  }
  if (p.kind === 'notice') {
    const text = plain(p.text);
    if (text == null) return null;
    return { platform: { kind: 'notice', level: NOTICE_LEVELS.has(p.level) ? p.level : 'info', text } };
  }
  if (p.kind === 'files') return { platform: { kind: 'files', todo: p.todo === true, notes: p.notes === true } };
  if (p.kind === 'usage-limit') {
    return { platform: { kind: 'usage-limit', text: plain(p.text) || '', resetsAt: finite(p.resetsAt), apiKey: p.apiKey === true } };
  }
  // message: an inter-agent message inside the slave's run.
  const m = deepClean(p);
  return isPlain(m) ? { platform: m } : null;
}

// One question of a relayed form, for core's ask renderer (public/core.js
// askFormBuildHTML): every field it interpolates is checked or escaped here.
function cleanQuestion(q, i) {
  if (!isPlain(q)) return null;
  let type = typeof q.type === 'string' ? q.type : null;
  if (type && !QUESTION_TYPES.has(type)) return null;
  const out = { id: typeof q.id === 'string' && QID_RE.test(q.id) ? q.id : `q${i}` };
  let question = mdText(q.question) ?? '';
  // An upload would land on the master's disk and answer with master paths.
  if (type === 'file') {
    type = 'textarea';
    question = `${question}\n\n(A file upload is not relayed to a remote session: answer in text.)`;
  }
  if (type) out.type = type;
  out.question = question;
  if (q.header != null) out.header = plain(q.header, 100);
  if (q.placeholder != null) out.placeholder = plain(q.placeholder, 200);
  if (typeof q.required === 'boolean') out.required = q.required;
  if (typeof q.multiSelect === 'boolean') out.multiSelect = q.multiSelect;
  if (Array.isArray(q.options)) {
    out.options = q.options.slice(0, 50).filter(isPlain).map((o) => {
      const opt = { label: plain(o.label, 200) ?? '' };
      if (o.description != null) opt.description = mdText(o.description, 1000);
      if (o.preview != null) opt.preview = mdText(o.preview, 8000);
      const img = dataImage(o.image);
      if (img) opt.image = img;
      return opt;
    });
  }
  if (Array.isArray(q.images)) {
    const imgs = q.images.slice(0, 8).map((im) => {
      const src = dataImage(typeof im === 'string' ? im : im?.src);
      if (!src) return null;
      const caption = isPlain(im) ? plain(im.caption, 200) : null;
      return caption ? { src, caption } : { src };
    }).filter(Boolean);
    if (imgs.length) out.images = imgs;
  }
  // number: min / max / step / default go into attributes unescaped.
  for (const f of ['min', 'max', 'step']) if (finite(q[f]) != null) out[f] = q[f];
  const d = q.defaultValue;
  if (type === 'number') { if (finite(d) != null) out.defaultValue = d; }
  else if (typeof d === 'boolean' || finite(d) != null) out.defaultValue = d;
  else if (typeof d === 'string') out.defaultValue = d.slice(0, 2000);
  else if (Array.isArray(d)) out.defaultValue = d.filter((x) => typeof x === 'string').slice(0, 50).map((x) => x.slice(0, 200));
  const showIf = cleanShowIf(q.showIf);
  if (showIf) out.showIf = showIf;
  return out;
}

// showIf lands in a single-quoted attribute (core askFormBuildHTML; its
// escHtml leaves ' alone): rebuilt from { questionId } and one condition,
// a boolean, a finite number or short plain text with no quote, markup or
// escape character. Anything else drops the condition.
const SHOWIF_OPS = ['equals', 'notEquals', 'includes', 'in'];
function cleanShowIf(s) {
  if (!isPlain(s) || typeof s.questionId !== 'string' || !QID_RE.test(s.questionId)) return null;
  const op = SHOWIF_OPS.find((k) => Object.prototype.hasOwnProperty.call(s, k));
  if (!op) return null;
  const v = s[op];
  const ok = typeof v === 'boolean' || finite(v) != null
    || (typeof v === 'string' && v.length <= 100 && !/[\u0000-\u001f\u007f"'<>&\\`]/.test(v));
  return ok ? { questionId: s.questionId, [op]: v } : null;
}

function cleanForm(f, askId) {
  if (!isPlain(f) || !isPlain(f.formData)) return null;
  const toolUseId = f.toolUseId == null ? askId : f.toolUseId;
  if (typeof toolUseId !== 'string' || !REMOTE_ID_RE.test(toolUseId)) return null;
  const fd = f.formData;
  const src = Array.isArray(fd.questions) ? fd.questions : (Array.isArray(f.questions) ? f.questions : []);
  const questions = src.slice(0, 30).map(cleanQuestion);
  if (!questions.length || questions.some((q) => !q)) return null;
  const formData = { questions };
  if (fd.title != null) formData.title = plain(fd.title, 200);
  if (fd.description != null) formData.description = mdText(fd.description);
  if (fd.submitLabel != null) formData.submitLabel = plain(fd.submitLabel, 60);
  if (fd.cancelLabel != null) formData.cancelLabel = plain(fd.cancelLabel, 60);
  return { toolUseId, formData, questions };
}

// A frame from a slave → a clean copy, or null (counted in drops).
function validateFrame(frame) {
  if (!isPlain(frame)) return drop('shape');
  const t = typeof frame.t === 'string' ? frame.t : frame.type;
  if (!FRAME_TYPES.has(t)) return drop('type');
  let size = 0;
  try { size = JSON.stringify(frame).length; } catch { return drop('shape'); }
  if (size > FRAME_CAP) return drop('size');
  const tabOk = typeof frame.tabId === 'string' && REMOTE_ID_RE.test(frame.tabId);
  switch (t) {
    case 'rs:event': {
      if (!tabOk) return drop('field');
      const ev = cleanEv(frame.ev);
      if (!ev) return drop('ev');
      const off = Number.isSafeInteger(frame.off) && frame.off >= 0 ? frame.off : null;
      return { t, tabId: frame.tabId, off, ts: finite(frame.ts), ev };
    }
    case 'rs:ask': {
      if (!tabOk || typeof frame.askId !== 'string' || !REMOTE_ID_RE.test(frame.askId)) return drop('field');
      if (!Array.isArray(frame.forms) || !frame.forms.length || frame.forms.length > 8) return drop('field');
      const forms = frame.forms.map((f) => cleanForm(f, frame.askId));
      if (forms.some((f) => !f)) return drop('form');
      return { t, tabId: frame.tabId, askId: frame.askId, title: plain(frame.title, 200) || '', forms };
    }
    case 'rs:askDone':
      if (typeof frame.askId !== 'string' || !REMOTE_ID_RE.test(frame.askId)) return drop('field');
      return { t, askId: frame.askId };
    case 'rs:state': {
      if (!tabOk || (frame.state !== 'started' && frame.state !== 'exited')) return drop('field');
      return {
        t, tabId: frame.tabId, state: frame.state,
        exitCode: Number.isSafeInteger(frame.exitCode) ? frame.exitCode : null,
        costUsd: finite(frame.costUsd) != null && frame.costUsd >= 0 ? frame.costUsd : null,
        credential: CREDENTIALS.has(frame.credential) ? frame.credential : null,
      };
    }
    case 'rs:auth': {
      const problem = typeof frame.problem === 'string' && /^[a-z0-9_-]{1,40}$/.test(frame.problem) ? frame.problem : null;
      if (!problem) return drop('field');
      return { t, problem, text: plain(frame.text, 500) || '' };
    }
    case 'rs:msg': {
      if (!tabOk) return drop('field');
      // How many earlier ones the slave's backlog for this member lost.
      const dropped = Number.isSafeInteger(frame.dropped) && frame.dropped > 0 ? frame.dropped : 0;
      if (frame.kind === 'report') {
        if (!REPORT_STATUSES.has(frame.status) || typeof frame.summary !== 'string') return drop('field');
        return { t, tabId: frame.tabId, kind: 'report', status: frame.status, summary: msgText(frame.summary), dropped };
      }
      if (frame.kind !== 'message' || typeof frame.text !== 'string' || !frame.text.trim()) return drop('field');
      return { t, tabId: frame.tabId, kind: 'message', text: msgText(frame.text), dropped };
    }
  }
  return drop('type');
}

// A row of the slave's `list`.
function cleanListRow(r) {
  if (!isPlain(r) || typeof r.tabId !== 'string' || !REMOTE_ID_RE.test(r.tabId)) return null;
  return {
    tabId: r.tabId,
    sessId: typeof r.sessId === 'string' && UUID_RE.test(r.sessId) ? r.sessId : null,
    runId: typeof r.runId === 'string' && REMOTE_ID_RE.test(r.runId) ? r.runId : null,
    role: r.role === 'orchestrator' || r.role === 'worker' ? r.role : null,
    state: typeof r.state === 'string' && /^[a-z]{1,20}$/.test(r.state) ? r.state : null,
    title: plain(r.title, TITLE_CAP) || '',
    app: typeof r.app === 'string' && APP_RE.test(r.app) ? r.app : null,
    credential: CREDENTIALS.has(r.credential) ? r.credential : null,
    costUsd: finite(r.costUsd) != null && r.costUsd >= 0 ? r.costUsd : 0,
  };
}

// An sdk:history page from the slave, rewritten to the master's sessId.
function cleanHistoryPage(rec, page) {
  if (!isPlain(page)) return { events: [], hasMore: false, before: null, totals: null };
  const events = [];
  for (const env of (Array.isArray(page.events) ? page.events : []).slice(0, 5000)) {
    if (!isPlain(env)) continue;
    const ev = cleanEv(env.ev);
    if (!ev) { drop('history'); continue; }
    const out = { sessId: rec.sessId, ts: finite(env.ts) || 0, ev: outEv(ev) };
    if (Number.isSafeInteger(env.off) && env.off >= 0) out.off = env.off;
    events.push(out);
  }
  const t = isPlain(page.totals) ? page.totals : null;
  return {
    events,
    hasMore: page.hasMore === true,
    before: Number.isSafeInteger(page.before) && page.before >= 0 ? page.before : null,
    totals: t ? { costUsd: finite(t.costUsd) || 0, compactions: finite(t.compactions) || 0 } : null,
  };
}

// ---------------------------------------------------------------------------
// Channel access
// ---------------------------------------------------------------------------
function channel() { return deps.peerChannel || {}; }

function command(peer, op, args = {}, timeoutMs = CMD_TIMEOUT_MS) {
  const ch = channel();
  if (typeof ch.remoteCommand !== 'function') return Promise.reject(err('unavailable', 'this platform has no remote-session channel'));
  return Promise.resolve().then(() => ch.remoteCommand(peer, op, args, { timeoutMs })).catch((e) => { throw cleanErr(e); });
}

function knownPeer(peer) {
  try { return (channel().fleetState?.().peers || []).find((p) => p.name === peer) || null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Records and the core tab
// ---------------------------------------------------------------------------
function recOf(peer, remoteTabId) {
  const rec = tabs.get(masterTabIdOf(peer, remoteTabId));
  return rec && rec.peer === peer && rec.remoteTabId === remoteTabId ? rec : null;
}

const tabsOf = (peer) => [...tabs.values()].filter((r) => r.peer === peer);

// The tabs the owner closed, per peer, the oldest forgotten past CLOSED_CAP.
const isClosed = (peer, remoteTabId) => !!closed.get(peer)?.has(remoteTabId);
function markClosed(peer, remoteTabId) {
  let set = closed.get(peer);
  if (!set) { set = new Set(); closed.set(peer, set); }
  set.delete(remoteTabId);
  set.add(remoteTabId);
  for (const id of set) { if (set.size <= CLOSED_CAP) break; set.delete(id); }
}

function peerTotals(peer) {
  let t = totals.get(peer);
  if (!t) { t = { apiKeyUsd: 0, subscriptionUsd: 0, limitHits: 0 }; totals.set(peer, t); }
  return t;
}

function mirrorDir(rec) {
  return deps.dataHome ? path.join(deps.dataHome, 'peer-remote', rec.sessId) : null;
}

function broadcast(msg) {
  try { deps.broadcaster?.broadcast?.(msg); } catch {}
}

function sdkEvent(rec, ev, off = null, ts = null) {
  if (!rec.unregister) return;
  broadcast({ type: 'sdk:event', sessId: rec.sessId, ts: ts || Date.now(), ev: outEv(ev), ...(off != null ? { off } : {}) });
}

function notice(rec, text, level = 'error') {
  sdkEvent(rec, { platform: { kind: 'notice', level, text } });
  broadcast({ type: 'app:peer:session:notice', peer: rec.peer, tabId: rec.tabId, level, text });
}

// A page cursor or limit from core: a non-negative safe integer, else null.
function count(v) {
  const n = typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : v;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// Core's adapter (src/external-session.js): every method is awaited, and a
// throw or rejection reaches only the requesting browser, as a notice or the
// reply's error.
function adapterOf(rec) {
  const remote = (op, args = {}) => command(rec.peer, op, { tabId: rec.remoteTabId, ...args });
  return {
    get sessId() { return rec.sessId; },
    kind: 'sdk',
    get title() { return `[${rec.peer}] ${rec.title || rec.app || rec.remoteTabId}`; },
    get settings() {
      // A run member is stamped with its run, so core's run-wide switches reach it.
      const m = rec.member;
      const orchestration = m ? { runId: m.runId, role: 'worker', name: m.address, ...(m.orchestrator ? { orchestrator: m.orchestrator } : {}) } : undefined;
      return { engine: 'sdk', auth: rec.auth, sessionDir: mirrorDir(rec), externalHost: rec.peer, title: rec.title, ...(orchestration ? { orchestration } : {}) };
    },
    get running() { return rec.running; },
    get busy() { return rec.statusState === 'busy' || rec.statusState === 'awaiting'; },
    get state() { return rec.running ? (rec.statusState || 'idle') : 'exited'; },
    // A run member's SendMessage arrives with `from` (the sender's address);
    // the owner typing into the tab without.
    submit(text, { images, from } = {}) {
      if (!rec.running) throw new Error('that remote session has exited');
      if (Array.isArray(images) && images.length) throw new Error('images are not sent to a remote session');
      const body = String(text || '').slice(0, PROMPT_CAP);
      if (rec.member && typeof from === 'string' && from) {
        return remote('member.submit', { text: body, from: plain(from, 200) }).then(() => {});
      }
      return remote('submit', { text: body }).then(() => {});
    },
    interrupt() { return remote('interrupt').then(() => {}); },
    setModel(model) {
      if (typeof model !== 'string' || !MODEL_RE.test(model)) return Promise.reject(new Error('bad model'));
      return remote('setModel', { model }).then(() => {});
    },
    setShowThinking() { throw new Error('not available on a remote session'); },
    setAuth(auth, { continueTurn } = {}) {
      if (!AUTHS.has(auth)) throw new Error('auth must be "apikey" or "subscription"');
      return remote('setAuth', { auth, continueTurn: continueTurn === true }).then(() => {
        rec.auth = auth;
        return { auth, applied: 'remote' };
      });
    },
    historyPage({ limit, before } = {}) {
      const args = {};
      const l = count(limit);
      const b = count(before);
      if (l) args.limit = Math.min(l, 5000);
      if (b != null) args.before = b;
      return remote('history', args).then((page) => cleanHistoryPage(rec, page));
    },
    kill() { return remote('kill').then(() => {}); },
    close() { closeTab(rec.tabId); },
  };
}

// Core's hook returns the tab's idempotent unregister(); closeTab, an unlinked
// peer and shutdown call it.
function registerTab(rec) {
  const reg = deps.registerExternalSession;
  if (typeof reg !== 'function' || rec.unregister) return;
  try {
    const r = reg(rec.tabId, adapterOf(rec));
    if (typeof r === 'function') rec.unregister = r;
  } catch (e) {
    console.warn(`[peer-remote] tab ${rec.tabId} not registered: ${e.message}`);
  }
}

// A record for one remote tab (from a launch or the slave's list).
function adopt(peer, row, extra = {}) {
  const tabId = masterTabIdOf(peer, row.tabId);
  let rec = tabs.get(tabId);
  if (rec) return rec.peer === peer ? rec : null;
  // A remote run's member found by `list` belongs to whoever asked for its run.
  const mine = launched.get(peer)?.get(row.tabId);
  const sibling = !extra.origin && row.runId ? [...tabs.values()].find((r) => r.peer === peer && r.runId === row.runId && r.origin) : null;
  rec = {
    tabId, peer, remoteTabId: row.tabId, sessId: crypto.randomUUID(), remoteSessId: row.sessId || null,
    runId: row.runId || null, role: row.role || null, title: row.title || '', app: row.app || null,
    mode: extra.mode || mine?.mode || null, origin: extra.origin || mine?.origin || sibling?.origin || null,
    member: extra.member || mine?.member || null, msgWindow: { start: 0, n: 0 },
    auth: extra.auth || (row.credential === 'api-key' ? 'apikey' : row.credential ? 'subscription' : null),
    running: row.state !== 'exited', statusState: row.state && STATUS_STATES.has(row.state) ? row.state : null,
    credential: row.credential || null, costUsd: row.costUsd || 0, lastOff: null, exitCode: null, resultText: null,
    createdAt: Date.now(), unregister: null,
  };
  tabs.set(tabId, rec);
  registerTab(rec);
  refreshMirror(rec);
  scheduleState();
  return rec;
}

function subscribe(rec, fromOff) {
  const args = Number.isSafeInteger(fromOff) ? { fromOff } : {};
  return command(rec.peer, 'subscribe', { tabId: rec.remoteTabId, ...args }).catch((e) => {
    console.warn(`[peer-remote] subscribe ${rec.tabId} failed: ${e.message}`);
  });
}

function closeTab(tabId) {
  const rec = tabs.get(tabId);
  if (!rec) return false;
  tabs.delete(tabId);
  markClosed(rec.peer, rec.remoteTabId);
  if (rec.running) command(rec.peer, 'kill', { tabId: rec.remoteTabId }).catch(() => {});
  command(rec.peer, 'unsubscribe', { tabId: rec.remoteTabId }).catch(() => {});
  if (rec.unregister) { try { rec.unregister(); } catch {} }
  rec.unregister = null;
  for (const [id, a] of asks) if (a.tabId === tabId) dropAsk(id);
  const dir = mirrorDir(rec);
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  scheduleState();
  return true;
}

// TODO.md / NOTES.md text for core's sdk:todo — the only slave text kept here.
function refreshMirror(rec) {
  const dir = mirrorDir(rec);
  if (!dir || !rec.unregister) return Promise.resolve();
  return command(rec.peer, 'todo', { tabId: rec.remoteTabId }).then((r) => {
    if (!tabs.has(rec.tabId) || !isPlain(r)) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, text] of [['TODO.md', r.todo], ['NOTES.md', r.notes]]) {
      if (typeof text === 'string') fs.writeFileSync(path.join(dir, file), text.slice(0, MIRROR_CAP));
    }
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------
function onFrame(peer, raw) {
  if (typeof peer !== 'string' || !knownPeer(peer)) { drop('peer'); return; }
  const f = validateFrame(raw);
  if (!f) return;
  try {
    switch (f.t) {
      case 'rs:event': return onEvent(peer, f);
      case 'rs:ask': return onAsk(peer, f);
      case 'rs:askDone': return onAskDone(peer, f.askId);
      case 'rs:state': return onState(peer, f);
      case 'rs:auth': return onAuthAlert(peer, f);
      case 'rs:msg': return onMsg(peer, f);
    }
  } catch (e) {
    console.warn(`[peer-remote] frame from "${peer}" failed: ${cleanErr(e).message}`);
  }
}

function onEvent(peer, f) {
  const rec = recOf(peer, f.tabId);
  if (!rec) { drop('unknown-tab'); resync(peer); return; }
  if (f.off != null) rec.lastOff = Math.max(rec.lastOff ?? 0, f.off);
  const p = f.ev.platform;
  if (p?.kind === 'status') {
    if (p.state) rec.statusState = p.state;
    if (p.credential) rec.credential = p.credential;
    if (p.costUsd != null) addCost(rec, p.costUsd, p.credential || rec.credential);
    scheduleState();
  } else if (p?.kind === 'usage-limit') {
    peerTotals(peer).limitHits++;
    scheduleState();
  } else if (p?.kind === 'files') {
    refreshMirror(rec).then(() => sdkEvent(rec, f.ev, f.off, f.ts));
    return;
  }
  const sdk = f.ev.sdk;
  if (sdk?.type === 'result' && typeof sdk.result === 'string') rec.resultText = sdk.result.slice(0, RESULT_CAP);
  sdkEvent(rec, f.ev, f.off, f.ts);
}

// The status cost is the session's running total: the growth since the last
// one is billed to the credential the status names.
function addCost(rec, costUsd, credential) {
  const prev = rec.costUsd || 0;
  rec.costUsd = costUsd;
  const delta = costUsd - prev;
  if (!(delta > 0)) return;
  const t = peerTotals(rec.peer);
  if (credential === 'api-key') t.apiKeyUsd += delta;
  else if (credential === 'subscription') t.subscriptionUsd += delta;
}

function onState(peer, f) {
  let rec = recOf(peer, f.tabId);
  if (!rec) {
    // A new member of a run: picked up by the next list, never sooner than RESYNC_GAP_MS.
    if (f.state === 'started' && !isClosed(peer, f.tabId)) resync(peer);
    else drop('unknown-tab');
    return;
  }
  if (f.credential) rec.credential = f.credential;
  if (f.costUsd != null) addCost(rec, f.costUsd, f.credential || rec.credential);
  if (f.state === 'started') {
    rec.running = true;
    emitState({ type: 'started', ...publicRec(rec) });
  } else if (rec.running) {
    rec.running = false;
    rec.statusState = 'exited';
    rec.exitCode = f.exitCode;
    for (const [id, a] of asks) if (a.tabId === rec.tabId) dropAsk(id);
    // As a local SDK session's exit: the tab stays listed (exited) until closed.
    if (rec.unregister) broadcast({ type: 'cli:exit', tabId: rec.tabId, exitCode: f.exitCode });
    emitState({ type: 'exited', ...publicRec(rec), resultText: rec.resultText });
  }
  scheduleState();
}

// A run member's report or message: only from a member tab this master
// launched on that peer, at most MSG_RATE per MSG_WINDOW_MS.
function onMsg(peer, f) {
  const rec = recOf(peer, f.tabId);
  if (!rec || !rec.member) { drop('not-member'); return; }
  const now = Date.now();
  const w = rec.msgWindow;
  if (now - w.start >= MSG_WINDOW_MS) { w.start = now; w.n = 0; }
  if (++w.n > MSG_RATE) { drop('rate'); return; }
  const ev = { peer, tabId: rec.tabId, runId: rec.member.runId, address: rec.member.address, kind: f.kind, dropped: f.dropped };
  if (f.kind === 'report') Object.assign(ev, { status: f.status, summary: f.summary });
  else ev.text = f.text;
  for (const fn of memberListeners) { try { fn(ev); } catch (e) { console.warn('[peer-remote] member listener:', e.message); } }
}

// ---------------------------------------------------------------------------
// Relayed questions
// ---------------------------------------------------------------------------
// A master id no pending question holds — a local one, another peer's, or
// another form of this ask — so a relayed ask never overwrites nor resolves
// any of them.
function freeId(pending, id, taken) {
  let out = id;
  for (let n = 2; pending.has(out) || taken.has(out); n++) out = `${id}-r${n}`;
  return out;
}

const CANCEL = [{ id: '_cancelled', question: '', answer: 'cancelled' }];

// The oldest open asks `match` selects, past `keep`: cancelled to their slave
// and dismissed on the dashboards.
function evictAsks(match, keep) {
  const ids = [...asks].filter(([, a]) => match(a)).map(([id]) => id);
  for (const id of ids.slice(0, Math.max(0, ids.length - keep))) {
    const a = asks.get(id);
    drop('ask-cap');
    for (const entryId of [...a.entryIds.keys()]) forwardAnswer(id, entryId, CANCEL, false);
    broadcast({ type: 'ask:answered', askId: id });
  }
}

function onAsk(peer, f) {
  const pending = deps.pendingQuestions;
  if (!pending || typeof pending.set !== 'function') return;
  // Only a tab this master adopted from that peer asks.
  const rec = recOf(peer, f.tabId);
  if (!rec) { drop('unknown-tab'); return; }
  for (const [id, a] of asks) if (a.peer === peer && a.remoteAskId === f.askId) dropAsk(id, false);
  const tabId = rec.tabId;
  evictAsks((a) => a.tabId === tabId, ASKS_PER_TAB - 1);
  evictAsks((a) => a.peer === peer, ASKS_PER_PEER - 1);
  const sessionTitle = rec.title || rec.app || rec.remoteTabId;
  const remote = { peer, tabId, sessionTitle };
  const taken = new Set();
  const askId = freeId(pending, nsId(peer, f.askId), taken);
  taken.add(askId);
  const entryIds = new Map();
  const forms = f.forms.map((form) => {
    const id = form.toolUseId === f.askId && !entryIds.has(askId) ? askId : freeId(pending, nsId(peer, form.toolUseId), taken);
    taken.add(id);
    entryIds.set(id, form.toolUseId);
    return { toolUseId: id, formData: form.formData, questions: form.questions };
  });
  const message = {
    type: 'ask:question', askId, toolUseIds: forms.map((x) => x.toolUseId), forms,
    title: `[${peer}] ${f.title || sessionTitle}`, ...(rec.unregister ? { tabId } : {}),
    host: peer, remote,
  };
  asks.set(askId, { peer, remoteAskId: f.askId, tabId, entryIds });
  forms.forEach((form, i) => {
    pending.set(form.toolUseId, {
      formData: form.formData, questions: form.questions, message: i === 0 ? message : null,
      ctx: { tabId }, host: peer, remote,
      resolve: (answer) => forwardAnswer(askId, form.toolUseId, answer),
      reject: () => forwardAnswer(askId, form.toolUseId, CANCEL),
    });
  });
  broadcast(message);
}

function cleanAnswer(answer) {
  if (!Array.isArray(answer)) return null;
  const out = deepClean(answer.slice(0, 50), { n: 2000 });
  return Array.isArray(out) && JSON.stringify(out).length <= 64 * 1024 ? out : null;
}

// notify: a failure is posted as a notice (not for an evicted ask's cancel).
function forwardAnswer(askId, entryId, answer, notify = true) {
  const a = asks.get(askId);
  if (!a || !a.entryIds.has(entryId)) return Promise.resolve(false);
  const remoteId = a.entryIds.get(entryId);
  a.entryIds.delete(entryId);
  deps.pendingQuestions?.delete?.(entryId);
  if (!a.entryIds.size) asks.delete(askId);
  const clean = cleanAnswer(answer) || CANCEL;
  return command(a.peer, 'answer', { askId: remoteId, answer: clean }).then(() => true, (e) => {
    if (!notify) return false;
    const rec = tabs.get(a.tabId);
    const text = `The answer did not reach ${a.peer}: ${e.message}`;
    if (rec) notice(rec, text);
    else broadcast({ type: 'app:peer:session:notice', peer: a.peer, tabId: a.tabId, level: 'error', text });
    return false;
  });
}

function dropAsk(askId, announce = true) {
  const a = asks.get(askId);
  if (!a) return;
  asks.delete(askId);
  for (const id of a.entryIds.keys()) deps.pendingQuestions?.delete?.(id);
  if (announce) broadcast({ type: 'ask:answered', askId });
}

function onAskDone(peer, remoteAskId) {
  for (const [id, a] of asks) {
    if (a.peer !== peer) continue;
    if (a.remoteAskId === remoteAskId || [...a.entryIds.values()].includes(remoteAskId)) dropAsk(id);
  }
}

// The owner's answer from the module API (a later agent path): master ask id.
function answer(askId, ans) {
  const a = asks.get(askId);
  if (!a) return Promise.reject(err('unknown-ask', 'no such remote question'));
  const entry = deps.pendingQuestions?.get?.(askId);
  if (entry?.resolve) { entry.resolve(ans); broadcast({ type: 'ask:answered', askId }); return Promise.resolve(true); }
  return forwardAnswer(askId, [...a.entryIds.keys()][0], ans);
}

// ---------------------------------------------------------------------------
// What may be adopted: the tabs this master launched on a peer, and the
// members of their runs. Persisted, so a restart picks them up again.
// ---------------------------------------------------------------------------
function launchedFile() {
  return deps.dataHome ? path.join(deps.dataHome, 'peer-remote', 'launched.json') : null;
}

function saveLaunched() {
  const file = launchedFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...launched].map(([peer, m]) => [peer, [...m]])));
  } catch (e) { console.warn('[peer-remote] launches not saved:', e.message); }
}

// Our own file, still read as untrusted.
function loadLaunched() {
  launched.clear();
  const file = launchedFile();
  if (!file) return;
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!Array.isArray(rows)) return;
  for (const row of rows.slice(0, 200)) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !Array.isArray(row[1])) continue;
    const m = new Map();
    for (const e of row[1].slice(-LAUNCHED_CAP)) {
      if (!Array.isArray(e) || typeof e[0] !== 'string' || !REMOTE_ID_RE.test(e[0]) || !isPlain(e[1])) continue;
      const o = e[1].origin;
      m.set(e[0], {
        runId: typeof e[1].runId === 'string' && REMOTE_ID_RE.test(e[1].runId) ? e[1].runId : null,
        mode: MODES.has(e[1].mode) ? e[1].mode : null,
        origin: isPlain(o) && ORIGINS.has(o.kind) ? { kind: o.kind, ...(typeof o.ref === 'string' ? { ref: o.ref.slice(0, 200) } : {}) } : null,
        member: cleanMember(e[1].member),
      });
    }
    if (m.size) launched.set(row[0].slice(0, 200), m);
  }
}

function rememberLaunch(peer, rec) {
  let m = launched.get(peer);
  if (!m) { m = new Map(); launched.set(peer, m); }
  m.set(rec.remoteTabId, { runId: rec.runId, mode: rec.mode, origin: rec.origin, ...(rec.member ? { member: rec.member } : {}) });
  for (const id of m.keys()) { if (m.size <= LAUNCHED_CAP) break; m.delete(id); }
  saveLaunched();
}

// A member { runId, address, orchestrator? } of a run on this master, or null.
function cleanMember(m) {
  if (!isPlain(m) || typeof m.runId !== 'string' || !REMOTE_ID_RE.test(m.runId)) return null;
  if (typeof m.address !== 'string' || !ADDRESS_RE.test(m.address)) return null;
  const orch = typeof m.orchestrator === 'string' && ADDRESS_RE.test(m.orchestrator) ? m.orchestrator : null;
  return { runId: m.runId, address: m.address, ...(orch ? { orchestrator: orch } : {}) };
}

function mayAdopt(peer, row) {
  const m = launched.get(peer);
  if (!m) return false;
  if (m.has(row.tabId)) return true;
  if (!row.runId) return false;
  for (const e of m.values()) if (e.runId === row.runId) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Reconnect: list, adopt, resubscribe from the last offset seen
// ---------------------------------------------------------------------------
// A forced resync (the channel connected) runs now; any other at most once per
// RESYNC_GAP_MS — one inside the gap is left for its end.
function resync(peer, force = false) {
  const now = Date.now();
  const wait = (lastResync.get(peer) || 0) + RESYNC_GAP_MS - now;
  if (!force && wait > 0) {
    if (!resyncTimers.has(peer)) {
      const t = setTimeout(() => { resyncTimers.delete(peer); resync(peer); }, wait);
      if (t.unref) t.unref();
      resyncTimers.set(peer, t);
    }
    return Promise.resolve();
  }
  clearTimeout(resyncTimers.get(peer));
  resyncTimers.delete(peer);
  lastResync.set(peer, now);
  return command(peer, 'list').then((rows) => {
    if (!Array.isArray(rows)) return;
    const seen = new Set();
    for (const raw of rows.slice(0, 200)) {
      const row = cleanListRow(raw);
      if (!row) { drop('list'); continue; }
      if (isClosed(peer, row.tabId)) continue;
      const known = recOf(peer, row.tabId);
      if (!known && !mayAdopt(peer, row)) { drop('not-launched'); continue; }
      if (!known && tabsOf(peer).length >= TABS_PER_PEER) { drop('tab-cap'); continue; }
      const rec = adopt(peer, row);
      if (!rec) continue;
      seen.add(rec.tabId);
      if (row.state !== 'exited') {
        rec.running = true;
        subscribe(rec, known ? (rec.lastOff ?? 0) : 0);
      }
    }
    for (const rec of tabs.values()) {
      if (rec.peer === peer && rec.running && !seen.has(rec.tabId)) onState(peer, { tabId: rec.remoteTabId, state: 'exited', exitCode: null, costUsd: null, credential: null });
    }
    scheduleState();
  }).catch((e) => { console.warn(`[peer-remote] list on "${peer}" failed: ${e.message}`); });
}

function onChannelEvent(ev) {
  if (!ev || typeof ev.peer !== 'string') return;
  if (ev.type === 'connected') resync(ev.peer, true);
  if (ev.type === 'connected' || ev.type === 'disconnected') scheduleState();
}

// ---------------------------------------------------------------------------
// Launch and the module API
// ---------------------------------------------------------------------------
function checkSpec(spec) {
  if (!isPlain(spec)) throw err('bad-args', 'spec must be an object');
  if (!MODES.has(spec.mode)) throw err('bad-args', 'mode must be "simple" or "orchestrator"');
  if (typeof spec.app !== 'string' || !APP_RE.test(spec.app)) throw err('bad-args', 'app must be an app name');
  if (typeof spec.prompt !== 'string' || !spec.prompt.trim() || spec.prompt.length > PROMPT_CAP) throw err('bad-args', 'prompt must be text');
  if (!AUTHS.has(spec.auth)) throw err('bad-args', 'auth must be "subscription" or "apikey"');
  if (spec.model != null && (typeof spec.model !== 'string' || !MODEL_RE.test(spec.model))) throw err('bad-args', 'bad model');
  const out = { mode: spec.mode, app: spec.app, prompt: spec.prompt, auth: spec.auth };
  if (spec.model) out.model = spec.model;
  if (spec.title != null) out.title = plain(spec.title, TITLE_CAP);
  return out;
}

// launch(peerName, spec, origin) → { tabId, remoteTabId, sessId, remoteSessId, runId }.
// Rejects with an Error whose .code is the slave's code or bad-args /
// unknown-peer / unavailable / offline / timeout.
async function launch(peerName, spec, origin) {
  if (deps.isSlave?.()) throw err('not-master', 'a slave launches no remote sessions');
  if (typeof peerName !== 'string' || !knownPeer(peerName)) throw err('unknown-peer', `no linked peer "${peerName}"`);
  const s = checkSpec(spec);
  if (!isPlain(origin) || !ORIGINS.has(origin.kind)) throw err('bad-args', 'origin.kind must be owner, horst or orchestrator');
  const o = { kind: origin.kind, ...(typeof origin.ref === 'string' ? { ref: origin.ref.slice(0, 200) } : {}) };
  const res = await command(peerName, 'launch', { ...s, origin: o }, 60 * 1000);
  const rec = adoptLaunched(peerName, { ...(isPlain(res) ? res : {}), title: s.title || s.app, app: s.app, state: 'busy' }, { mode: s.mode, origin: o, auth: s.auth });
  return { tabId: rec.tabId, remoteTabId: rec.remoteTabId, sessId: rec.sessId, remoteSessId: rec.remoteSessId, runId: rec.runId };
}

// The tab a launch answered: adopted, remembered, subscribed from 0.
function adoptLaunched(peerName, raw, extra) {
  const row = cleanListRow(raw);
  if (!row) throw err('bad-reply', 'the slave answered no tab');
  closed.get(peerName)?.delete(row.tabId);
  const rec = adopt(peerName, row, extra);
  if (!rec) throw err('bad-reply', 'the slave answered a tab id already in use');
  rememberLaunch(peerName, rec);
  rec.running = true;
  subscribe(rec, 0);
  emitState({ type: 'started', ...publicRec(rec) });
  return rec;
}

// launchMember(peerName, { app, task, auth, model?, title? }, { runId, address,
// orchestrator: { address, title } }) → { tabId, remoteTabId, sessId,
// remoteSessId, memberAddress }: a worker of a run on this master, started on
// the slave (`member.launch`) — only after the owner approved its card
// (peer-remote-host.js). Rejects like launch().
async function launchMember(peerName, spec, member) {
  if (deps.isSlave?.()) throw err('not-master', 'a slave launches no remote sessions');
  if (typeof peerName !== 'string' || !knownPeer(peerName)) throw err('unknown-peer', `no linked peer "${peerName}"`);
  const s = checkSpec({ mode: 'simple', app: spec?.app, prompt: spec?.task, auth: spec?.auth, model: spec?.model, title: spec?.title });
  const orch = isPlain(member?.orchestrator) ? member.orchestrator : {};
  const m = cleanMember({ runId: member?.runId, address: member?.address, orchestrator: orch.address });
  if (!m) throw err('bad-args', 'a member names its run and address');
  const res = await command(peerName, 'member.launch', {
    runId: m.runId, address: m.address,
    orchestrator: { address: m.orchestrator || null, title: plain(orch.title, 200) || '' },
    title: s.title || m.address, task: s.prompt, app: s.app, auth: s.auth, ...(s.model ? { model: s.model } : {}),
  }, 60 * 1000);
  const r = isPlain(res) ? res : {};
  const rec = adoptLaunched(peerName, { ...r, title: s.title || m.address, app: s.app, state: 'busy' }, {
    mode: 'worker', origin: { kind: 'orchestrator', ref: m.runId }, auth: s.auth, member: m,
  });
  rec.role = 'worker';
  const memberAddress = typeof r.memberAddress === 'string' && ADDRESS_RE.test(r.memberAddress) ? r.memberAddress : null;
  return { tabId: rec.tabId, remoteTabId: rec.remoteTabId, sessId: rec.sessId, remoteSessId: rec.remoteSessId, memberAddress };
}

// The master tab of a run member, or null.
function memberTab(runId, address) {
  for (const rec of tabs.values()) if (rec.member && rec.member.runId === runId && rec.member.address === address) return rec.tabId;
  return null;
}

// onMemberMessage(fn): fn({ peer, tabId, runId, address, kind: 'report' |
// 'message', status?, summary?, text?, dropped }) — slave text, capped,
// untrusted; `dropped`: earlier ones the slave's backlog lost.
function onMemberMessage(fn) {
  memberListeners.add(fn);
  return () => memberListeners.delete(fn);
}

function publicRec(rec) {
  return {
    tabId: rec.tabId, peer: rec.peer, remoteTabId: rec.remoteTabId, sessId: rec.sessId, runId: rec.runId,
    role: rec.role, mode: rec.mode, app: rec.app, title: rec.title, origin: rec.origin,
    running: rec.running, state: rec.running ? (rec.statusState || 'idle') : 'exited', exitCode: rec.exitCode,
    credential: rec.credential, auth: rec.auth, costUsd: rec.costUsd, tab: !!rec.unregister,
    member: rec.member ? { runId: rec.member.runId, address: rec.member.address } : null,
  };
}

function status(tabId) {
  const rec = tabs.get(tabId);
  return rec ? publicRec(rec) : null;
}

function kill(tabId) {
  const rec = tabs.get(tabId);
  if (!rec) return Promise.reject(err('unknown-tab', 'no such remote session'));
  return command(rec.peer, 'kill', { tabId: rec.remoteTabId }).then(() => true);
}

// onState(fn): fn({ type: 'started' | 'exited', tabId, peer, costUsd, exitCode,
// resultText (exited; the slave's last result text — untrusted, never for the
// bus or Horst), … }). Returns the unsubscribe function.
function onStateChange(fn) {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

function emitState(ev) {
  for (const fn of stateListeners) { try { fn(ev); } catch (e) { console.warn('[peer-remote] state listener:', e.message); } }
}

// ---------------------------------------------------------------------------
// The account check and the dashboard view
// ---------------------------------------------------------------------------
// The master's own account: the first source that names an email — core's
// claudeAuthInfo() (email / orgName), else, on an older core, the cached
// `claude auth status` (none until core broadcasts a change).
function ownClaude() {
  const sources = [deps.claudeAuthInfo, deps.claudeStatus];
  let first = null;
  for (const fn of sources) {
    let s = null;
    try { s = typeof fn === 'function' ? fn() : null; } catch {}
    if (!s) continue;
    if (typeof s.email === 'string' && s.email) return s;
    first = first || s;
  }
  return first;
}

function defaultClaudeStatus() {
  try { return require('./peer-remote-slave').claudeStatus?.() || null; } catch { return null; }
}

// true / false when both sides name their account, null when either does not.
function sameAccount(slaveClaude, own = ownClaude()) {
  const a = isPlain(slaveClaude) ? slaveClaude : null;
  if (!a || !own || typeof a.email !== 'string' || typeof own.email !== 'string' || !a.email || !own.email) return null;
  return a.email.toLowerCase() === own.email.toLowerCase() && (a.orgName || null) === (own.orgName || null);
}

function cleanClaude(c) {
  if (!isPlain(c)) return null;
  const rs = isPlain(c.remoteSessions) ? c.remoteSessions : {};
  return {
    loggedIn: c.loggedIn === true,
    authMethod: plain(c.authMethod, 40), subscriptionType: plain(c.subscriptionType, 40),
    email: plain(c.email, 200), orgName: plain(c.orgName, 200),
    apiKey: c.apiKey === true, pref: plain(c.pref, 40),
    remoteSessions: { enabled: rs.enabled === true, allowApiKey: rs.allowApiKey === true },
  };
}

// ---------------------------------------------------------------------------
// The last auth alert per peer: kept (and persisted) until the owner dismisses
// it or the slave's snapshot shows a fresh sign-in, so a reload or a restart
// still shows it.
// ---------------------------------------------------------------------------
function alertsFile() {
  return deps.dataHome ? path.join(deps.dataHome, 'peer-remote', 'alerts.json') : null;
}

function saveAlerts() {
  const file = alertsFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...alerts.entries()]));
  } catch (e) { console.warn('[peer-remote] alerts not saved:', e.message); }
}

// Our own file, still read as untrusted: the same caps as the frame.
function loadAlerts() {
  alerts.clear();
  const file = alertsFile();
  if (!file) return;
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (!Array.isArray(rows)) return;
  for (const row of rows.slice(0, 200)) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !isPlain(row[1])) continue;
    const a = row[1];
    if (typeof a.problem !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(a.problem)) continue;
    alerts.set(row[0].slice(0, 200), {
      problem: a.problem, text: plain(a.text, 500) || '', at: finite(a.at) || 0, sawLoggedOut: a.sawLoggedOut === true,
    });
  }
}

function onAuthAlert(peer, f) {
  const loggedIn = knownPeer(peer)?.claude?.loggedIn;
  alerts.set(peer, { problem: f.problem, text: f.text, at: Date.now(), sawLoggedOut: loggedIn === false });
  saveAlerts();
  broadcast({ type: 'app:peer:remoteAlert', peer, problem: f.problem, text: f.text });
  scheduleState();
}

// Against the fleet's current snapshots: a peer that signed out and in again
// since the alert has it cleared; a peer no longer linked loses it. True when
// anything changed.
function reconcileAlerts(peers) {
  if (!alerts.size) return false;
  const byName = new Map(peers.map((p) => [p.name, p]));
  let changed = false;
  for (const [peer, a] of alerts) {
    const p = byName.get(peer);
    if (!p) { alerts.delete(peer); changed = true; continue; }
    const loggedIn = isPlain(p.claude) ? p.claude.loggedIn : undefined;
    if (loggedIn === false && !a.sawLoggedOut) { a.sawLoggedOut = true; changed = true; }
    else if (loggedIn === true && a.sawLoggedOut) { alerts.delete(peer); changed = true; }
  }
  if (changed) saveAlerts();
  return changed;
}

// A peer no longer linked takes its tabs with it: closed and unregistered,
// and what it launched or closed is forgotten.
function dropUnlinked(peers) {
  const names = new Set(peers.map((p) => p?.name));
  let n = 0;
  for (const rec of [...tabs.values()]) if (!names.has(rec.peer)) { closeTab(rec.tabId); n++; }
  for (const peer of [...closed.keys()]) if (!names.has(peer)) closed.delete(peer);
  let forgot = false;
  for (const peer of [...launched.keys()]) if (!names.has(peer)) { launched.delete(peer); forgot = true; }
  if (forgot) saveLaunched();
  return n > 0;
}

function dismissAlert(peer) {
  if (!alerts.delete(peer)) return false;
  saveAlerts();
  scheduleState();
  return true;
}

function alertOf(peer) {
  const a = alerts.get(peer);
  return a ? { problem: a.problem, text: a.text, at: a.at } : null;
}

function sessionsState() {
  let peers = [];
  try { peers = channel().fleetState?.().peers || []; } catch {}
  reconcileAlerts(peers);
  const own = ownClaude();
  return {
    peers: peers.map((p) => {
      const claude = cleanClaude(p.claude);
      return {
        peer: p.name,
        connected: !!p.connected,
        claude,
        sameAccount: sameAccount(claude, own),
        totals: { ...peerTotals(p.name) },
        alert: alertOf(p.name),
        ...(peerExtras ? { runs: extrasOf(p) } : {}),
        sessions: [...tabs.values()].filter((r) => r.peer === p.name).map(publicRec),
      };
    }),
    drops: { total: drops.total, byReason: { ...drops.byReason } },
  };
}

function extrasOf(p) {
  try { return peerExtras(p); } catch { return null; }
}

// setPeerExtras(fn): fn(fleet peer) → the peer's `runs` entry of sessionsState.
function setPeerExtras(fn) {
  peerExtras = typeof fn === 'function' ? fn : null;
  scheduleState();
}

function scheduleState() {
  if (stateTimer || !deps.broadcaster) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    broadcast({ type: 'app:peer:sessions:state', ...sessionsState() });
  }, 300);
  if (stateTimer.unref) stateTimer.unref();
}

// Owner-level: core's ctx.isOwnerConnection(ws) — true only for an open
// dashboard socket that passed the owner check at its upgrade; anything else is
// refused. An older core without it authenticates every dashboard WebSocket as
// the owner at upgrade (auth.isOwnerUpgrade), so any socket counts there.
function ownerConnection(ws) {
  if (!ws) return false;
  if (typeof deps.isOwnerConnection === 'function') {
    try { return deps.isOwnerConnection(ws) === true; } catch { return false; }
  }
  return true;
}

// app:peer:session:* and app:peer:remoteAlert:dismiss from the dashboard. True when handled.
async function handleWs(ws, msg, send) {
  const t = msg?.type;
  if (t === 'app:peer:remoteAlert:dismiss') {
    if (!ownerConnection(ws)) send({ type: 'app:peer:remoteAlert:dismissResult', ok: false, code: 'not-owner', error: 'only the owner may do this' });
    else send({ type: 'app:peer:remoteAlert:dismissResult', ok: true, peer: msg.peer, dismissed: typeof msg.peer === 'string' && dismissAlert(msg.peer) });
    return true;
  }
  if (t !== 'app:peer:session:launch' && t !== 'app:peer:session:list' && t !== 'app:peer:session:kill') return false;
  if (t === 'app:peer:session:list') {
    send({ type: 'app:peer:sessions:state', ...sessionsState() });
    return true;
  }
  const reqId = typeof msg.reqId === 'string' ? msg.reqId.slice(0, 64) : null;
  const reply = t === 'app:peer:session:launch' ? 'app:peer:session:launchResult' : 'app:peer:session:killResult';
  if (!ownerConnection(ws)) {
    send({ type: reply, reqId, ok: false, code: 'not-owner', error: 'only the owner may do this' });
    return true;
  }
  try {
    if (t === 'app:peer:session:launch') {
      const { peer, mode, app, prompt, auth, model, title } = msg;
      const r = await launch(peer, { mode, app, prompt, auth, model, title }, { kind: 'owner' });
      send({ type: reply, reqId, ok: true, ...r });
    } else {
      await kill(String(msg.tabId || ''));
      send({ type: reply, reqId, ok: true, tabId: msg.tabId });
    }
  } catch (e) {
    send({ type: reply, reqId, ok: false, code: e.code || 'error', error: e.message });
  }
  return true;
}

function onConnect(send) {
  try { send({ type: 'app:peer:sessions:state', ...sessionsState() }); } catch {}
}

// ---------------------------------------------------------------------------

// deps: { broadcaster, pendingQuestions, registerExternalSession?,
// isOwnerConnection?, claudeAuthInfo?, claudeStatus?, dataHome, isSlave?,
// peerChannel? } — claudeStatus defaults to peer-remote-slave's.
function init(options = {}) {
  shutdown();
  deps = {
    broadcaster: options.broadcaster || null,
    pendingQuestions: options.pendingQuestions || null,
    registerExternalSession: typeof options.registerExternalSession === 'function' ? options.registerExternalSession : null,
    isOwnerConnection: typeof options.isOwnerConnection === 'function' ? options.isOwnerConnection : null,
    claudeAuthInfo: typeof options.claudeAuthInfo === 'function' ? options.claudeAuthInfo : null,
    claudeStatus: typeof options.claudeStatus === 'function' ? options.claudeStatus : defaultClaudeStatus,
    dataHome: options.dataHome || null,
    isSlave: typeof options.isSlave === 'function' ? options.isSlave : null,
    peerChannel: options.peerChannel || require('./peer-channel'),
  };
  if (deps.isSlave?.()) return;
  loadAlerts();
  loadLaunched();
  purgeMirrors();
  // Every snapshot ends in an app:fleet:state broadcast: a sign-in clears the alert.
  try {
    unsubBroadcast = deps.broadcaster?.onBroadcast?.((m) => {
      if (m?.type !== 'app:fleet:state' || !Array.isArray(m.peers)) return;
      const unlinked = dropUnlinked(m.peers);
      if (reconcileAlerts(m.peers) || unlinked) scheduleState();
    }) || null;
  } catch {}
  const ch = channel();
  if (typeof ch.onRemoteFrame === 'function') unsubFrames = ch.onRemoteFrame(onFrame);
  if (typeof ch.onEvent === 'function') unsubEvents = ch.onEvent(onChannelEvent);
  // Peers already connected (an add-on reload): pick their sessions up.
  try { for (const p of ch.fleetState?.().peers || []) if (p.connected) resync(p.name, true); } catch {}
}

// Mirror folders a previous run left: no tab holds them now.
function purgeMirrors() {
  const root = deps.dataHome ? path.join(deps.dataHome, 'peer-remote') : null;
  let names = [];
  try { names = root ? fs.readdirSync(root) : []; } catch { return; }
  for (const name of names) {
    if (UUID_RE.test(name)) { try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch {} }
  }
}

function shutdown() {
  if (unsubFrames) { try { unsubFrames(); } catch {} unsubFrames = null; }
  if (unsubEvents) { try { unsubEvents(); } catch {} unsubEvents = null; }
  if (unsubBroadcast) { try { unsubBroadcast(); } catch {} unsubBroadcast = null; }
  alerts.clear();
  if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
  for (const id of [...asks.keys()]) dropAsk(id, false);
  for (const rec of tabs.values()) if (rec.unregister) { try { rec.unregister(); } catch {} }
  tabs.clear();
  closed.clear();
  launched.clear();
  totals.clear();
  lastResync.clear();
  for (const t of resyncTimers.values()) clearTimeout(t);
  resyncTimers.clear();
  drops.total = 0;
  drops.byReason = {};
}

module.exports = {
  init, shutdown, handleWs, onConnect,
  // module API (docs/remote-sessions.md)
  launch, onState: onStateChange, status, answer, kill, sessionsState,
  // run members (peer-remote-host.js)
  launchMember, memberTab, onMemberMessage, close: closeTab, setPeerExtras, scheduleState,
  // exported for tests
  validateFrame, cleanEv, cleanQuestion, mdText, escSdk, sameAccount, masterTabIdOf, _onFrame: onFrame, _drops: drops,
  _sizes: (peer) => ({ closed: closed.get(peer)?.size || 0, launched: launched.get(peer)?.size || 0, asks: [...asks.values()].filter((a) => a.peer === peer).length }),
};
