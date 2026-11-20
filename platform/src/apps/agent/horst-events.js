// Horst event bus — the senses, and the platform bus: apps subscribe to it
// too (docs/bus.md).
//
// One platform bus. Sources publish envelopes; Horst is the primary subscriber,
// app subscribers (in-process handlers and leased iframes) receive a fan-out,
// and every envelope is logged. The bus itself does no AI: it validates,
// rate-limits, de-storms, catalogs, fans out, and runs a rules-first triage
// ladder whose only non-free rung (the haiku tier) is invoked by an injected
// callback so this module stays dependency-light and fully sandbox-testable.
//
// This module owns:
//   • envelope normalization + guardrails (size, rate, storm, kind regex, caps,
//     hop cap for app-to-app chains)
//   • the three-tier catalog (platform / declared / discovered→agenda-only)
//   • per-app×kind policy (ignore | agenda | notify | run-action) — Horst's side
//   • the subscriber registry (in-process handlers + leased iframes), fan-out
//     and the propagation context (hop / correlationId / trust floor)
//   • the event log (JSONL + ring) and `history()`
//   • the audit ring (outcomes)
// It does NOT own the haiku triage call (→ injected triageModelFn); rule
// actions (agenda/notify/briefing) are injected too. No requires on
// platform-horst/app-manager/telegram → no cycles (app-guard is required
// lazily for subscriber failures; it has no requires of its own on those).
//
// Fire-and-forget only. There is no request/reply on the bus — that duty is
// `ctx.tools.call` on `expose:'apps'` tools (one duty, one implementation).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const SOURCES = ['timer', 'email', 'app', 'tools', 'telegram', 'chat', 'webhook', 'system'];
const TRUST = ['owner', 'platform', 'app', 'untrusted'];   // weaker = higher index
const POLICIES = ['ignore', 'agenda', 'notify', 'run-action'];
const KIND_RE = /^[a-z0-9][a-z0-9._:-]{0,80}$/i;
const PATTERN_RE = /^[a-z0-9*][a-z0-9._:*-]{0,80}$/i;      // a kind, or `*` per colon segment

const PAYLOAD_CAP = 16 * 1024;        // bytes; larger payloads truncated with a marker
const AUDIT_CAP = 2000;               // audit ring size
const RATE_WINDOW_MS = 60 * 1000;     // per app×kind
const RATE_MAX = 60;                  // events per window before dropping
const STORM_WINDOW_MS = 30 * 1000;    // N same-kind in this window → fold to one digest
const STORM_THRESHOLD = 8;
const PER_APP_KIND_CAP = 200;         // distinct discovered kinds per app

// App-to-app delivery.
const MAX_APP_HOP = 4;                // a re-publish from inside a handler at this hop is dropped
const LEASE_DEFAULT = 15 * 60 * 1000; // iframe lease (Bridge.bus) when no ttl is given
const LEASE_MIN = 5 * 1000;
const LEASE_MAX = 24 * 60 * 60 * 1000;
const MAX_PATTERNS = 50;              // per subscription
const RING_MAX = 1000;                // in-memory event log
const LOG_ROTATE_BYTES = 8 * 1024 * 1024;
const HISTORY_MAX = 500;              // per history() call
const RING_RELOAD_BYTES = 1024 * 1024; // file tail read at init to refill the ring

let deps = {};   // { dir, broadcaster, triageModelFn, ruleActions, onSubscriberError }
let ready = false;

// Runtime windows (in-memory; rebuilt from scratch on restart — rate/storm are
// short-lived by nature, so losing them across a restart is harmless).
const rateWin = new Map();   // `${app}|${kind}` → [timestamps]
const stormWin = new Map();  // `${app}|${kind}` → { times:[], folded:0, notified:false }

// Subscribers (in-memory: an in-process handler dies with its app's mount, a
// lease with its ttl — both re-subscribe on start / reload, so nothing persists).
const subs = new Map();      // app → Set<{ patterns, handler }>
const leases = new Map();    // app → { patterns, until }

// Propagation context: a handler that re-publishes inherits hop+1, the
// correlationId and a trust floor from the envelope it is reacting to.
const chain = new AsyncLocalStorage();

// Event log (every envelope that was not dropped/folded), newest last.
let ring = [];
let logBytes = 0;

// ---------------------------------------------------------------------------
// JSON stores (atomic; same helpers as governance/horst)
// ---------------------------------------------------------------------------
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(data, null, 2)); fs.renameSync(t, file); }
function auditPath() { return path.join(deps.dir, 'events-audit.json'); }
function catalogPath() { return path.join(deps.dir, 'events-catalog.json'); }
function policyPath() { return path.join(deps.dir, 'events-policy.json'); }
function logPath() { return path.join(deps.dir, 'events-log.jsonl'); }
function newId() { return `ev-${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`; }

// ---------------------------------------------------------------------------
// Catalog: platform (static) + declared (by apps) + discovered (auto on first
// emit, default policy 'agenda' until the owner promotes it).
// ---------------------------------------------------------------------------
// Builtin platform kinds: the platform's own lifecycle, timers and rituals.
// Everything a CAPABILITY senses (cron failures, AI failures, DB state, …) is
// declared by its capability module (`horst.senses`) and injected at init —
// see src/apps/capabilities.js horstSenses(). The union is PLATFORM_KINDS.
const BUILTIN_KINDS = [
  { key: 'timer:heartbeat', description: 'Periodic self-check tick' },
  { key: 'timer:briefing', description: 'Scheduled briefing trigger' },
  { key: 'timer:model-review', description: 'Daily model review trigger (refresh model lists, check the defaults)' },
  { key: 'email:new', description: 'A new email arrived (untrusted content)' },
  { key: 'app:started', description: 'An app started' },
  { key: 'app:stopped', description: 'An app stopped' },
  { key: 'app:failed', description: 'An app failed to start or crashed' },
  { key: 'app:error', description: 'An app\'s code threw outside a request (Telegram/job/tool/route handler) — attributed by the app guard' },
  { key: 'app:crashloop', description: 'An app failed repeatedly within a minute — Horst triages (restart proposal)' },
  { key: 'tools:updated', description: 'An app\'s tool set changed (digest refresh)' },
  { key: 'webhook', description: 'Inbound webhook hit /pro/horst/api/hook/:name' },
  { key: 'todo:due', description: 'A todo/reminder came due' },
  { key: 'todo:closed', description: 'A todo auto-closed (reply arrived / resolved)' },
  { key: 'mcp:session:opened', description: 'Another AI mounted a scoped platform tool server (MCP broker session)' },
  { key: 'mcp:session:closed', description: 'An MCP broker session ended (expired or revoked)' },
];
const PLATFORM_KINDS = BUILTIN_KINDS.slice();

// Capability senses joining the platform catalog (init option `senses`).
function registerSenses(senses) {
  for (const s of senses || []) {
    if (!s || !KIND_RE.test(s.key || '')) continue;
    if (PLATFORM_KINDS.some((k) => k.key === s.key)) continue;
    PLATFORM_KINDS.push({ key: s.key, description: String(s.description || '').slice(0, 200), capability: s.capability || null });
    if (s.defaultPolicy && POLICIES.includes(s.defaultPolicy) && !(s.key in DEFAULT_POLICY)) DEFAULT_POLICY[s.key] = s.defaultPolicy;
  }
}

function loadCatalog() {
  const stored = readJson(catalogPath(), { declared: {}, discovered: {} });
  if (!stored.declared) stored.declared = {};
  if (!stored.discovered) stored.discovered = {};
  return stored;
}
function saveCatalog(c) { writeJson(catalogPath(), c); }

// app declares kinds it will emit (optional but advertised loudly in the UI).
// opts.horst === false marks the kinds as app-only (an independent app: on
// the bus, never routed to Horst); opts.via === 'manifest' records that the
// declaration came from manifest.events.emits rather than code.
function declare(appName, kinds, opts = {}) {
  if (!ready) return { ok: false, added: 0, dropped: 'not-ready' };
  const c = loadCatalog();
  if (!c.declared[appName]) c.declared[appName] = {};
  let added = 0;
  for (const k of kinds || []) {
    const kind = fullKind(appName, k?.kind);
    if (!KIND_RE.test(kind)) continue;
    const prev = c.declared[appName][kind];
    if (!prev) added++;
    const entry = {
      description: String(k.description || prev?.description || '').slice(0, 200),
      declaredAt: prev?.declaredAt || Date.now(),
      horst: opts.horst !== false,
    };
    if (opts.via === 'manifest' || prev?.manifest) entry.manifest = true;
    c.declared[appName][kind] = entry;
  }
  saveCatalog(c);
  return { ok: true, added };
}

// First emission of an unknown kind auto-registers it as discovered.
function registerDiscovered(appName, kind, { horst = true } = {}) {
  const c = loadCatalog();
  const bucket = c.discovered[appName] || (c.discovered[appName] = {});
  const prev = bucket[kind];
  if (prev) {
    if ((prev.horst !== false) !== horst) { prev.horst = horst; saveCatalog(c); }
    return false;
  }
  if (Object.keys(bucket).length >= PER_APP_KIND_CAP) return false; // cap: refuse new kinds
  bucket[kind] = { firstSeen: Date.now(), count: 0, horst };
  saveCatalog(c);
  return true;
}

function bumpDiscovered(appName, kind) {
  const c = loadCatalog();
  if (c.discovered[appName]?.[kind]) { c.discovered[appName][kind].count++; saveCatalog(c); }
}

function catalog() {
  const c = loadCatalog();
  // Effective policy per kind so the UI reflects saved overrides, not defaults.
  // Discovered kinds are agenda-only until an explicit override exists.
  const stored = loadPolicy();
  const effective = {};
  const put = (app, kind, isDiscovered) => {
    const key = `${app || 'platform'}|${kind}`;
    effective[key] = stored[key] || (isDiscovered ? 'agenda' : (DEFAULT_POLICY[kind] || 'agenda'));
  };
  for (const k of PLATFORM_KINDS) put('platform', k.key, false);
  for (const [app, kinds] of Object.entries(c.declared)) for (const kind of Object.keys(kinds)) put(app, kind, false);
  for (const [app, kinds] of Object.entries(c.discovered)) for (const kind of Object.keys(kinds)) put(app, kind, true);
  return { platform: PLATFORM_KINDS, declared: c.declared, discovered: c.discovered, policies: effective, subscribers: subscribers() };
}

// App events are namespaced by app so kinds can never collide across apps.
function fullKind(appName, kind) {
  const k = String(kind || '').trim();
  if (!appName || appName === 'platform' || appName === 'horst') return k;
  return k.includes(':') && k.startsWith(appName + ':') ? k : `${appName}:${k}`;
}

// ---------------------------------------------------------------------------
// Policy: per app×kind action. Platform kinds have sensible defaults; anything
// discovered defaults to 'agenda' (visible, no action) per the spec.
// ---------------------------------------------------------------------------
const DEFAULT_POLICY = {
  'timer:heartbeat': 'run-action',
  'timer:briefing': 'run-action',
  'timer:model-review': 'run-action',
  'email:new': 'run-action',
  'app:failed': 'notify',
  'app:error': 'agenda',
  'app:crashloop': 'run-action',
  'app:started': 'agenda',
  'app:stopped': 'agenda',
  'tools:updated': 'run-action',
  'todo:due': 'run-action',
  'todo:closed': 'agenda',
  'mcp:session:opened': 'agenda',
  'mcp:session:closed': 'agenda',
};

function loadPolicy() { return readJson(policyPath(), {}); }
function savePolicy(p) { writeJson(policyPath(), p); }

function policyFor(appName, kind) {
  const stored = loadPolicy();
  const key = `${appName || 'platform'}|${kind}`;
  if (stored[key]) return stored[key];
  return DEFAULT_POLICY[kind] || 'agenda';
}

function setPolicy(appName, kind, policy) {
  if (!POLICIES.includes(policy)) throw new Error(`unknown policy "${policy}"`);
  const stored = loadPolicy();
  stored[`${appName || 'platform'}|${kind}`] = policy;
  savePolicy(stored);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Subscribers — the receiving side of the bus.
//
// A pattern is a full kind (`minecraft-server:player:joined`) or has `*` per
// colon segment: `minecraft-server:*` (everything that app emits — a trailing
// `*` covers the rest of the kind), `*:crashloop`, `*:player:*`. Patterns are
// NOT namespaced to the subscriber: an app subscribes to other apps' kinds by
// their full name.
// ---------------------------------------------------------------------------
function matchKind(pattern, kind) {
  if (pattern === kind) return true;
  if (typeof pattern !== 'string' || typeof kind !== 'string' || !pattern.includes('*')) return false;
  const ps = pattern.split(':');
  const ks = kind.split(':');
  for (let i = 0; i < ps.length; i++) {
    if (ps[i] === '*' && i === ps.length - 1) return ks.length >= ps.length; // trailing * eats the rest
    if (i >= ks.length) return false;
    if (ps[i] !== '*' && ps[i] !== ks[i]) return false;
  }
  return ks.length === ps.length;
}

function normalizePatterns(patterns) {
  const list = (Array.isArray(patterns) ? patterns : [patterns])
    .map((p) => String(p || '').trim())
    .filter((p) => p && PATTERN_RE.test(p));
  return [...new Set(list)].slice(0, MAX_PATTERNS);
}

// In-process subscription (routes.js). Returns the unsubscribe function.
function subscribe(app, patterns, handler) {
  if (typeof handler !== 'function') throw new Error('events.subscribe: handler must be a function');
  const ps = normalizePatterns(patterns);
  if (!ps.length) throw new Error('events.subscribe: at least one kind or pattern is required (e.g. "other-app:*")');
  const entry = { patterns: ps, handler };
  if (!subs.has(app)) subs.set(app, new Set());
  subs.get(app).add(entry);
  return () => {
    const set = subs.get(app);
    if (!set) return;
    set.delete(entry);
    if (!set.size) subs.delete(app);
  };
}

// Leased subscription (an iframe through the Bridge): ONE pattern set per app,
// replaced on every call, expiring after ttl — a closed tab stops receiving
// without anyone unsubscribing. Clamped like platform-sysmon's lease.
function leaseSubscribe(app, patterns, ttlMs) {
  if (!app) throw new Error('events.subscribe: app required');
  const ps = normalizePatterns(patterns);
  if (!ps.length) throw new Error('events.subscribe: at least one kind or pattern is required (e.g. "other-app:*")');
  const ttl = Math.min(Math.max(Number(ttlMs) || LEASE_DEFAULT, LEASE_MIN), LEASE_MAX);
  const until = Date.now() + ttl;
  leases.set(app, { patterns: ps, until });
  return { ok: true, patterns: ps, until, ttlMs: ttl };
}

function unlease(app) { leases.delete(app); return { ok: true }; }

function removeApp(app) { subs.delete(app); leases.delete(app); }

function sweepLeases() {
  const now = Date.now();
  for (const [app, l] of leases) if (l.until <= now) leases.delete(app);
}

// { pattern: [apps] } — what the catalog and the Triggers view show.
function subscribers() {
  sweepLeases();
  const out = {};
  const add = (p, app) => { if (!out[p]) out[p] = []; if (!out[p].includes(app)) out[p].push(app); };
  for (const [app, set] of subs) for (const e of set) for (const p of e.patterns) add(p, app);
  for (const [app, l] of leases) for (const p of l.patterns) add(p, app);
  return out;
}

function weaker(a, b) {
  return TRUST[Math.max(TRUST.indexOf(a), TRUST.indexOf(b))];
}

function defaultGuard(app, err, env) {
  try {
    require('../app-guard').record(app, 'events.subscribe', err, { kind: env.kind, eventId: env.id });
  } catch {
    console.error(`[app:${app}] events.subscribe error on ${env.kind}: ${err && err.message}`);
  }
}

// Deliver an envelope to every matching subscriber. Independent of Horst's
// policy (an `ignore`d kind still reaches app subscribers) and after every
// guardrail (a rate-limited or storm-folded event never gets here). Handlers
// run off the publisher's stack, inside the propagation context, and a throw
// is attributed to the SUBSCRIBER through the app guard — never to the
// publisher, never to the bus.
function fanOut(env) {
  sweepLeases();
  const store = { hop: env.hop, correlationId: env.correlationId || env.id, trust: env.trust };
  const delivered = [];
  for (const [app, set] of subs) {
    for (const e of set) {
      if (!e.patterns.some((p) => matchKind(p, env.kind))) continue;
      delivered.push(app);
      setImmediate(() => chain.run(store, async () => {
        try { await e.handler(env); } catch (err) { (deps.onSubscriberError || defaultGuard)(app, err, env); }
      }));
    }
  }
  for (const [app, l] of leases) {
    if (!l.patterns.some((p) => matchKind(p, env.kind))) continue;
    delivered.push(app);
    try { deps.broadcaster?.broadcast({ type: 'app:bridge:event', appName: app, event: 'bus:event', data: env }); } catch {}
  }
  return delivered;
}

// ---------------------------------------------------------------------------
// Event log: one envelope per line (events-log.jsonl, rotated once to `.1`
// above LOG_ROTATE_BYTES) plus an in-memory ring for cheap reads. The audit
// ring stays what it was — outcomes; this is the payloads.
// ---------------------------------------------------------------------------
function appendLog(env) {
  ring.push(env);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  try {
    const line = JSON.stringify(env) + '\n';
    fs.appendFileSync(logPath(), line);
    logBytes += Buffer.byteLength(line);
    if (logBytes > LOG_ROTATE_BYTES) {
      fs.renameSync(logPath(), logPath() + '.1');
      logBytes = 0;
    }
  } catch (err) {
    console.warn('[horst-events] event log write failed:', err.message);
  }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return out;
}

// Tail of the current log file (the last RING_RELOAD_BYTES), oldest first.
function readLogTail() {
  let fd = null;
  try {
    const file = logPath();
    const size = fs.statSync(file).size;
    logBytes = size;
    const len = Math.min(size, RING_RELOAD_BYTES);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1); // drop the torn first line
    return parseLines(text);
  } catch {
    return [];
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
}

// The whole log (rotated file first), oldest first — the slow path for a
// history() that the ring cannot answer.
function readLogAll() {
  const out = [];
  for (const file of [logPath() + '.1', logPath()]) {
    try { out.push(...parseLines(fs.readFileSync(file, 'utf8'))); } catch {}
  }
  return out;
}

function ringCovers(since, sinceId) {
  if (!ring.length) return false;
  if (sinceId) return ring.some((e) => e.id === sinceId);
  if (since) return ring[0].at <= since;
  return true;
}

// history({ kinds, since, sinceId, limit }) → envelopes, OLDEST FIRST.
//   kinds    a pattern or an array of patterns (matchKind semantics)
//   since    epoch ms — envelopes strictly after it
//   sinceId  an envelope id — envelopes strictly after it (a subscriber's
//            catch-up cursor); unknown ids fall back to "everything"
// With a cursor (since/sinceId) the FIRST `limit` matches are returned so a
// reader can page forward; without one the LAST `limit` (the recent tail).
function history({ kinds, since, sinceId, limit } = {}) {
  if (!ready) return [];
  const n = Math.min(Math.max(Number(limit) || 100, 1), HISTORY_MAX);
  const sinceAt = Number(since) || 0;
  const cursorId = sinceId ? String(sinceId) : null;
  const patterns = kinds == null || kinds === '' ? null : normalizePatterns(kinds);
  const source = ringCovers(sinceAt, cursorId) ? ring : readLogAll();
  let start = 0;
  if (cursorId) {
    const idx = source.findIndex((e) => e.id === cursorId);
    if (idx >= 0) start = idx + 1;
  }
  const out = [];
  for (let i = start; i < source.length; i++) {
    const e = source[i];
    if (sinceAt && !(e.at > sinceAt)) continue;
    if (patterns && !patterns.some((p) => matchKind(p, e.kind))) continue;
    out.push(e);
  }
  return (cursorId || sinceAt) ? out.slice(0, n) : out.slice(-n);
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------
function capPayload(payload) {
  let s;
  try { s = typeof payload === 'string' ? payload : JSON.stringify(payload); } catch { s = String(payload); }
  if (s.length <= PAYLOAD_CAP) return { payload, truncated: false };
  return { payload: s.slice(0, PAYLOAD_CAP) + '\n…[truncated]', truncated: true };
}

function rateLimited(key) {
  const now = Date.now();
  const arr = (rateWin.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { rateWin.set(key, arr); return true; }
  arr.push(now); rateWin.set(key, arr);
  return false;
}

// Returns { fold: bool, digest: bool } — fold means "suppress this individual
// event"; digest means "this is the one event that stands in for the storm".
function stormCheck(key) {
  const now = Date.now();
  const w = stormWin.get(key) || { times: [], folded: 0, notified: false };
  w.times = w.times.filter((t) => now - t < STORM_WINDOW_MS);
  w.times.push(now);
  if (w.times.length > STORM_THRESHOLD) {
    w.folded++;
    stormWin.set(key, w);
    if (!w.notified) { w.notified = true; return { fold: false, digest: true, folded: w.folded }; }
    return { fold: true, digest: false, folded: w.folded };
  }
  w.notified = false;
  stormWin.set(key, w);
  return { fold: false, digest: false, folded: 0 };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
function audit(entry) {
  const data = readJson(auditPath(), { items: [] });
  data.items.unshift(entry);
  data.items = data.items.slice(0, AUDIT_CAP);
  writeJson(auditPath(), data);
  try { deps.broadcaster?.broadcast({ type: 'horst:event', entry }); } catch {}
}

function listAudit({ app, kind, source, limit = 200 } = {}) {
  let items = readJson(auditPath(), { items: [] }).items;
  if (app) items = items.filter((i) => i.app === app);
  if (kind) items = items.filter((i) => i.kind === kind);
  if (source) items = items.filter((i) => i.source === source);
  return items.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Publish — the single entry point every source funnels through.
// opts: { app, source, summary, trust, thirdParty, dedupeKey, correlationId,
//         host, hop, horst } — host/hop are set by peer-channel ingest for
// events that originated on another host of the fleet (hop counts forwards;
// nothing re-forwards today). `horst: false` keeps the event on the bus (log
// + app subscribers) but never routes it to Horst — how an independent app
// (platformContribution: false) publishes.
//
// Inside a subscriber handler, a publish inherits the propagation context:
// hop + 1 (dropped at MAX_APP_HOP), the correlationId of the event being
// reacted to, and a trust no stronger than that event's.
// ---------------------------------------------------------------------------
async function publish(kind, payload, opts = {}) {
  if (!ready) return { dropped: 'not-ready' };
  const parent = chain.getStore() || null;
  const app = opts.app || null;
  const source = SOURCES.includes(opts.source) ? opts.source : 'system';
  let trust = TRUST.includes(opts.trust) ? opts.trust : (source === 'email' ? 'untrusted' : 'platform');
  if (parent) trust = weaker(trust, parent.trust);
  const fk = fullKind(app, kind);

  if (!KIND_RE.test(fk)) {
    audit({ id: newId(), at: Date.now(), app, source, kind: String(kind).slice(0, 80), outcome: 'rejected: bad kind' });
    return { dropped: 'bad-kind' };
  }

  // Hop: inherited (+1) inside a handler chain, else the relayed value (≤8).
  const hop = parent
    ? parent.hop + 1
    : (Number.isInteger(opts.hop) && opts.hop > 0 ? Math.min(opts.hop, 8) : 0);
  if (parent && hop >= MAX_APP_HOP) {
    audit({ id: newId(), at: Date.now(), app, source, kind: fk, hop, correlationId: parent.correlationId, outcome: 'dropped: hop cap' });
    return { dropped: 'hop-cap' };
  }

  const winKey = `${app || 'platform'}|${fk}`;
  const toHorst = opts.horst !== false;

  // Rate limit (hard drop, but audited so it's visible).
  if (rateLimited(winKey)) {
    audit({ id: newId(), at: Date.now(), app, source, kind: fk, outcome: 'dropped: rate-limited' });
    return { dropped: 'rate-limited' };
  }

  // Catalog: register unknown kinds as discovered (agenda-only default).
  const known = PLATFORM_KINDS.some((k) => k.key === fk)
    || loadCatalog().declared[app]?.[fk];
  if (!known) {
    if (source === 'app' || (app && app !== 'platform')) {
      const created = registerDiscovered(app, fk, { horst: toHorst });
      if (!created && Object.keys(loadCatalog().discovered[app] || {}).length >= PER_APP_KIND_CAP) {
        audit({ id: newId(), at: Date.now(), app, source, kind: fk, outcome: 'dropped: kind cap' });
        return { dropped: 'kind-cap' };
      }
    }
  } else if (app && loadCatalog().discovered[app]?.[fk]) {
    bumpDiscovered(app, fk);
  }

  // Storm collapse.
  const storm = stormCheck(winKey);
  if (storm.fold) {
    audit({ id: newId(), at: Date.now(), app, source, kind: fk, outcome: `folded into storm (${storm.folded})` });
    return { folded: true };
  }

  const { payload: capped, truncated } = capPayload(payload);
  const envelope = {
    id: newId(), at: Date.now(), source, app, kind: fk,
    summary: opts.summary ? String(opts.summary).slice(0, 300) : null,
    payload: capped, truncated,
    dedupeKey: opts.dedupeKey || null,
    correlationId: opts.correlationId || parent?.correlationId || null,
    hop,
    host: opts.host ? String(opts.host).slice(0, 40) : null,
    trust, thirdParty: !!opts.thirdParty,
    storm: storm.digest ? { folded: storm.folded } : undefined,
  };

  // The bus half: log it, hand it to every app subscriber.
  appendLog(envelope);
  const delivered = fanOut(envelope);

  if (!toHorst) {
    audit({
      id: envelope.id, at: envelope.at, app, source, kind: fk,
      summary: envelope.summary, trust, correlationId: envelope.correlationId || undefined,
      hop: hop || undefined, dedupeKey: envelope.dedupeKey || undefined,
      policy: null, outcome: 'app-only', delivered: delivered.length || undefined,
      truncated: truncated || undefined, storm: envelope.storm,
    });
    return { id: envelope.id, policy: null, outcome: 'app-only', delivered: delivered.length };
  }

  // Discovered kinds are agenda-only until promoted, regardless of default map.
  const isDiscovered = !!loadCatalog().discovered[app]?.[fk];
  const policy = isDiscovered && !loadPolicy()[`${app}|${fk}`] ? 'agenda' : policyFor(app, fk);

  return route(envelope, policy, delivered.length);
}

// ---------------------------------------------------------------------------
// Routing ladder. Every rung is pure policy and free: the four policies ARE the
// decision, so routing acts on them directly and never calls a model. The haiku
// triage fn stays injected for the one caller that cannot decide from a rule.
// ---------------------------------------------------------------------------
async function route(env, policy, delivered = 0) {
  let outcome = policy;
  try {
    if (policy === 'ignore') {
      outcome = 'ignored (rule)';
    } else if (policy === 'agenda') {
      deps.ruleActions?.agenda?.(env);
      outcome = '→ agenda';
    } else if (policy === 'notify') {
      deps.ruleActions?.notify?.(env);
      outcome = '→ notify';
    } else if (policy === 'run-action') {
      // Rule action bound to this kind (agenda/notify/briefing/use-case), no AI.
      const acted = await deps.ruleActions?.run?.(env);
      outcome = acted ? `→ ran ${acted}` : '→ run-action (no handler)';
    }
  } catch (err) {
    outcome = `error: ${err.message}`;
    console.warn('[horst-events] route error:', err.message);
  }
  audit({
    id: env.id, at: env.at, app: env.app, source: env.source, kind: env.kind,
    summary: env.summary, trust: env.trust, correlationId: env.correlationId,
    host: env.host || undefined, hop: env.hop || undefined,
    // dedupeKey rides along so the Timeline can chain an event to the agenda
    // note and the proposal it produced (mail keys are `<account>:<uid>`).
    dedupeKey: env.dedupeKey || undefined,
    policy, outcome, delivered: delivered || undefined,
    truncated: env.truncated || undefined, storm: env.storm || undefined,
  });
  return { id: env.id, policy, outcome, delivered };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function init(options) {
  deps = options;
  fs.mkdirSync(deps.dir, { recursive: true });
  if (options.senses) registerSenses(options.senses);
  ring = readLogTail().slice(-RING_MAX);
  ready = true;
}

// Tests only: forget every subscriber, lease, window and the ring; the on-disk
// files are the caller's (temp dir) business.
function _resetForTests() {
  subs.clear(); leases.clear(); rateWin.clear(); stormWin.clear();
  ring = []; logBytes = 0; ready = false; deps = {};
}

module.exports = {
  init, publish, declare,
  catalog, setPolicy, policyFor, listAudit,
  subscribe, leaseSubscribe, unlease, removeApp, subscribers, history, matchKind,
  SOURCES, TRUST, POLICIES, PLATFORM_KINDS, BUILTIN_KINDS, MAX_APP_HOP,
  fullKind, // exported for tests
  _resetForTests,
};
