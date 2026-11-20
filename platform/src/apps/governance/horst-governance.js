// Horst governance — the platform approval plane (docs/governance.md).
//
// Every gated action becomes a PROPOSAL with a frozen payload: the exact
// executor arguments are validated and stored at creation, and approval
// executes precisely that payload — the model cannot move the goalposts
// between approval and execution.
//
// Autonomy dials decide, per action kind, what may run without asking:
//   observe < propose < auto+notify < auto
// Each kind also has a hard CEILING the dial cannot exceed (e.g. email.send is
// pinned to 'propose': email/web content is untrusted input, so outward-facing
// sends always require a human).
//
// Kinds come in three tiers:
//   • the governance-internal KIND (this file) — `mission.create`, the one act
//     Horst raises that belongs to no capability;
//   • platform kinds — declared by capability modules (`horst.kinds` in
//     src/apps/capabilities/<key>.js: email.send, calendar.create, app.restart,
//     cron.set, …) and registered once at init via registerPlatformKinds. Their
//     ceilings are honoured as declared;
//   • registered kinds — apps register namespaced kinds ('<app>:<kind>') at
//     mount via ctx.governance.registerKind; their executors are in-app
//     callbacks, cleared on app stop. App kinds are ceiling-clamped to
//     'propose' — an app can never grant itself autonomy.
// An app stages or edits only its own kinds and the platform kinds that
// declare `appProposable: true` (appMayStage); every other kind is
// platform-owned.
//
// Concurrency: proposals live in a JSON file. All mutations between a load and
// its save are synchronous EXCEPT after executor awaits — those re-load and
// patch by id (patchProposal) so a decision landing during a slow executor is
// never clobbered by a stale snapshot.
//
// Storage: JSON in APPS_DIR/.horst/ (same convention as platform-horst.js).
// This module never requires platform-horst or platform-telegram — callbacks
// (notify/broadcast/isPaused) are injected at init, and higher-level executors
// (telegram.send) register via registerLauncher,
// so there are no cycles.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const priorAction = require('./horst-prior-action');
const decisions = require('./horst-decisions');

const LEVELS = ['observe', 'propose', 'auto+notify', 'auto'];

// Human-readable semantics for each dial position — served to the UI (and any
// other consumer) so the explanation lives next to the code that enforces it.
const LEVEL_INFO = {
  observe: {
    title: 'Observe',
    short: 'Notices it, does nothing.',
    detail: 'Horst records that he would have acted and moves on. Nothing is executed, '
      + 'nothing is staged, nothing reaches you. The intent is written to the activity log '
      + '(as an "observed" entry) so you can see what he would have done — this is the setting '
      + 'to use when you want to watch his judgement for a while before trusting it.',
  },
  propose: {
    title: 'Propose',
    short: 'Asks first, every time.',
    detail: 'Horst stages the action as a pending approval with its exact arguments frozen at '
      + 'that moment: approving runs precisely what you reviewed — he cannot change the details '
      + 'between your approval and execution. It appears in Approvals (and, for most kinds, as a '
      + 'Telegram card) and waits for you. Nothing happens until you approve; a pending approval '
      + 'expires by itself after 7 days.',
  },
  'auto+notify': {
    title: 'Auto + notify',
    short: 'Does it, then tells you.',
    detail: 'Horst executes immediately without asking, then sends you the result. The action is '
      + 'still recorded in full — a pre-approved entry in the ledger with its payload and outcome — '
      + 'so Approvals and Activity show exactly what ran. Use it for actions you would almost always '
      + 'say yes to but still want to hear about.',
  },
  auto: {
    title: 'Auto',
    short: 'Does it silently.',
    detail: 'Same as auto + notify, minus the notification: Horst acts and only the ledger and the '
      + 'activity log record it. Reserve this for routine, easily reversible actions — you are giving '
      + 'up the moment where you could have said no.',
  },
};

// Rules that apply on top of whatever the dial says, wherever the dials are shown.
const DIAL_RULES = [
  'Pausing Horst (the kill switch at the top of this page) forces every "auto" kind down to '
    + 'Propose — autonomous execution stops, your own approvals keep working.',
  'Before acting on its own, Horst checks the world first. If the calendar or your sent mail says '
    + 'the action already happened, it is downgraded to a pending approval carrying that evidence — '
    + 'autonomy is permission to act, not permission to duplicate.',
  'Asking Horst for something in chat always creates an approval card, whatever the dial says. '
    + 'The dials govern what he starts by himself (triage, briefings, timers), not what you ask for.',
  'Greyed-out positions are hard ceilings, pinned in code and not configurable from here. Actions '
    + 'that reach outside (sending mail or Telegram), destroy visibility, or change the platform '
    + 'itself can never be made automatic.',
  'Kinds registered by an installed app are always capped at Propose — an app can never grant '
    + 'itself autonomy.',
];
const PROPOSAL_CAP = 300;
const AUDIT_CAP = 500;
const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // the default, when a kind names no lifetime of its own

// Kind-scoped lifetimes. How long a question is worth asking is a property of
// the ACT, not a constant: a todo mined from this morning's mail is stale in
// days, while a mail rule is still worth answering a fortnight later. Seven days
// for everything is why 22 proposals expired unread.
const KIND_TTL_MS = {
  'todo.create': 72 * 60 * 60 * 1000,
  'email.send': 72 * 60 * 60 * 1000,
  'email.rule.add': 14 * 24 * 60 * 60 * 1000,
};

// Set once at init (gov-meta.json). Proposals staged BEFORE the policy shipped
// keep the old 7-day lifetime, so tightening a TTL never mass-expires a queue
// that was staged under the old rule — the new lifetimes apply to new cards.
let ttlPolicyFrom = null;

// A calendar proposal is pointless once its own event has begun: approving
// "add Thursday's dentist appointment" on Friday creates a lie. Date-only
// values are deliberately parsed as LOCAL midnight here (not UTC): this is a
// comparison against the local clock, not a label being formatted for display,
// which is the opposite of the all-day rendering rule.
function eventStartMs(payload) {
  const date = String(payload?.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const time = /^\d{2}:\d{2}/.test(String(payload?.startTime || '')) ? String(payload.startTime).slice(0, 5) : '00:00';
  const ms = Date.parse(`${date}T${time}:00`);
  return Number.isFinite(ms) ? ms : null;
}

// When a pending proposal is due to expire. An explicit expiresAt — the owner
// asked to keep this one longer (extendProposal) — always wins.
function dueAtFor(p) {
  if (p.expiresAt != null) return p.expiresAt;
  const created = p.createdAt || 0;
  const grandfathered = ttlPolicyFrom != null && created < ttlPolicyFrom;
  const ttl = grandfathered ? PROPOSAL_TTL_MS : (KIND_TTL_MS[p.kind] ?? PROPOSAL_TTL_MS);
  let due = created + ttl;
  if (!grandfathered && (p.kind === 'calendar.create' || p.kind === 'calendar.update' || p.kind === 'calendar.invite')) {
    const starts = eventStartMs(p.payload);
    if (starts && starts < due) due = starts;
  }
  return due;
}
const PRIOR_TTL_MS = 60 * 1000;   // how long a prior-action verdict is trusted
const PRIOR_REFRESH_CAP = 25;     // pending proposals re-checked per refresh pass
const RESULT_SUMMARY_MAX = 500;
const KIND_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;

let deps = {}; // { dir, broadcaster, notifyProposal(p), notifyDecision(p), notifyUpdate(p), notifyExpired(p), notifyWithdrawn(p), isPaused() }

// Statuses a proposal can hold:
//   pending → approved (transient, persisted pre-await) → executed | failed
//   pending → denied | expired
//   pending → withdrawn   — collapsed into a sibling that represents the same
//                           act. NOT an answer: preStageCheck must never read a
//                           withdrawn row as "already decided", and the decision
//                           ledger never gets a row for it, so a collapse can
//                           never be mistaken for a rejection in the stats.

// Executors that live in higher-level modules (e.g. platform-horst's telegram
// sender) register here at their init — avoids a require cycle.
const launchers = {};
function registerLauncher(kind, fn) { launchers[kind] = fn; }

// ---------------------------------------------------------------------------
// Action kinds — validate() throws on bad payloads; execute(payload, proposal,
// helpers) performs the frozen payload (helpers.launcher(kind) reaches the
// executors higher-level modules registered). ceiling = max autonomy the dial
// can grant. defaultLevel is the out-of-the-box dial position. Optional
// per-kind fields:
//   notify: 'tg' | 'none'  — default TG approval-card behavior ('tg' if absent)
//   card(payload, p)       — the ONE card descriptor, projected to every
//                            surface by horst-cards.js (supersedes tgCard,
//                            which no kind ever defined)
//   approveFrom(proposal, via) — null when an approval from surface `via` may
//                            stand, else the reason it may not (a surface that
//                            could not show the whole payload). Checked by
//                            decide() before the decision is consumed; a
//                            throwing check refuses. When it refuses 'ui', the
//                            egress marks the proposal fullViewApprove.
//   appProposable: true    — an app may propose and edit this platform kind
//                            (appMayStage); absent = platform-owned
//   identity(payload,meta) — a stable key for the ACT this payload performs, or
//                            null when the kind cannot be identified from it.
//                            See horst-identity.js: this is what makes duplicate
//                            staging structurally impossible, and it survives a
//                            conversion to another kind.
// The same shape is what capability modules declare under `horst.kinds`.
// ---------------------------------------------------------------------------

const { req } = require('../horst-facet');

const KINDS = {
  'mission.create': {
    label: 'Adopt mission',
    about: 'Adopts a standing goal Horst will pursue over time (spawning work, reviewed on a cadence).',
    pinNote: 'A mission is Horst\'s most volitional act — persistent self-directed goals always need a human, whatever the dials say.',
    ceiling: 'propose', // hard-pinned (G7/G8)
    defaultLevel: 'propose',
    validate(p) { req(p, 'title'); req(p, 'goal'); },
    describe: (p) => `Adopt mission "${p.title}" — ${String(p.goal).slice(0, 100)}`,
    // Missions are deliberate one-offs the user asks for in chat; two with the
    // same title are two decisions, not a duplicate.
    identity: null,
    // Reached through a launcher, not a require. horst-missions is agent-side;
    // governance requiring it would be the boundary crossing this file's own
    // rule forbids, and it is the one place the rule was broken.
    execute: (p, proposal, helpers) => {
      const create = helpers?.launcher ? helpers.launcher('mission.create') : null;
      if (!create) throw new Error('mission launcher not registered');
      const m = create({
        title: p.title, goal: p.goal, approach: p.approach || null,
        reviewCadenceDays: p.reviewCadenceDays || undefined,
        origin: proposal?.origin === 'chat' ? 'user' : 'horst', status: 'active',
      });
      return { ok: true, summary: `Mission adopted: ${m.title}` };
    },
  },

};

// ---------------------------------------------------------------------------
// Registered kinds — the app-facing extension point (ctx.governance.registerKind).
// Executors are in-process callbacks that only exist while the owning app is
// mounted; a proposal whose kind has no live def stays PENDING on approval
// attempts (the decision is not consumed — see decide()).
// ---------------------------------------------------------------------------

const registeredKinds = {}; // fullKind → { ...def, app }

// Platform kinds from the capability registry (capabilities.horstKinds()),
// registered once by platform-horst.init BEFORE governance.init so pending
// proposals resolve their kind on the first sweep. Ceilings are honoured as
// declared — the registry validated them at boot.
const platformKinds = {}; // kind → { ...def, capability }
function registerPlatformKinds(map) {
  for (const [kind, def] of Object.entries(map || {})) {
    if (!KIND_RE.test(kind)) throw new Error(`bad platform kind name "${kind}"`);
    if (KINDS[kind]) throw new Error(`platform kind "${kind}" collides with a governance-internal kind`);
    if (platformKinds[kind]) throw new Error(`platform kind "${kind}" registered twice`);
    if (registeredKinds[kind]) throw new Error(`platform kind "${kind}" collides with an app-registered kind`);
    if (typeof def?.execute !== 'function') throw new Error(`platform kind "${kind}" requires an execute function`);
    if (!LEVELS.includes(def.ceiling) || !LEVELS.includes(def.defaultLevel)) throw new Error(`platform kind "${kind}" has an invalid ceiling/defaultLevel`);
    platformKinds[kind] = {
      label: String(def.label || kind).slice(0, 80),
      about: def.about ? String(def.about).slice(0, 300) : null,
      pinNote: def.pinNote || null,
      ceiling: def.ceiling,
      defaultLevel: def.defaultLevel,
      validate: typeof def.validate === 'function' ? def.validate : () => {},
      describe: typeof def.describe === 'function' ? def.describe : () => String(def.label || kind),
      execute: def.execute,
      // Copied EXPLICITLY, like every field here. Dropping either would
      // degrade every platform kind silently, with no error anywhere:
      // identity disables dedupe, card sends the kind back to raw JSON.
      identity: typeof def.identity === 'function' ? def.identity : null,
      card: typeof def.card === 'function' ? def.card : null,
      // Dropping this would let an approval through from a surface the kind
      // refuses (a truncated Telegram card) — fail open, silently.
      approveFrom: typeof def.approveFrom === 'function' ? def.approveFrom : null,
      // compose recomputes derived payload fields at every freeze point.
      // Dropping it would let an edited payload keep a stale rendered body —
      // exactly the silent disagreement it exists to prevent.
      compose: typeof def.compose === 'function' ? def.compose : null,
      // Reversibility claims. Dropping these would silently strip the only
      // justification an autonomous default has (capabilities-check #21).
      undo: def.undo === true,
      idempotent: def.idempotent === true,
      notify: def.notify === 'none' ? 'none' : 'tg',
      // Dropping this would only ever refuse more (appMayStage reads absent as
      // platform-owned) — copied so a kind's opt-in survives.
      appProposable: def.appProposable === true,
      capability: def.capability || null,
      app: null,
    };
  }
  return Object.keys(platformKinds).length;
}
function platformKindNames() { return Object.keys(platformKinds); }

// `app` present = registered through the app bridge: kind is namespaced and the
// ceiling is clamped to 'propose' so app code can never grant itself autonomy.
function registerKind(kind, def, { app } = {}) {
  if (!KIND_RE.test(kind)) throw new Error(`bad kind name "${kind}"`);
  if (typeof def?.execute !== 'function') throw new Error('kind def requires an execute function');
  let fullKind = kind;
  let ceiling = LEVELS.includes(def.ceiling) ? def.ceiling : 'propose';
  if (app) {
    fullKind = kind.startsWith(`${app}:`) ? kind : `${app}:${kind}`;
    ceiling = 'propose';
  }
  if (KINDS[fullKind] || platformKinds[fullKind]) throw new Error(`kind "${fullKind}" is a built-in platform kind`);
  registeredKinds[fullKind] = {
    label: String(def.label || fullKind).slice(0, 80),
    about: def.about ? String(def.about).slice(0, 300) : null,
    pinNote: app ? `Registered by the "${app}" app — app kinds are capped at Propose so an app can never grant itself autonomy.` : null,
    ceiling,
    defaultLevel: 'propose',
    validate: typeof def.validate === 'function' ? def.validate : () => {},
    describe: typeof def.describe === 'function' ? def.describe : () => String(def.label || fullKind),
    execute: def.execute,
    // Optional for app kinds (registerKind only ever required `execute`), so an
    // app that declares neither simply keeps today's behaviour: no dedupe, and
    // the generic card horst-cards builds from the payload.
    identity: typeof def.identity === 'function' ? def.identity : null,
    card: typeof def.card === 'function' ? def.card : null,
    compose: typeof def.compose === 'function' ? def.compose : null,
    // Carried for parity, but an app kind is ceiling-clamped to 'propose' and
    // its defaultLevel is hardcoded above, so it can never reach the autonomous
    // default these claims would justify.
    undo: def.undo === true,
    idempotent: def.idempotent === true,
    notify: def.notify === 'none' ? 'none' : 'tg',
    app: app || null,
  };
  return { kind: fullKind };
}

// Called by app-manager when an app stops/unmounts — its executors are gone.
function unregisterKinds(appName) {
  for (const [kind, def] of Object.entries(registeredKinds)) {
    if (def.app === appName) delete registeredKinds[kind];
  }
}

function kindDef(kind) {
  return KINDS[kind] || platformKinds[kind] || registeredKinds[kind] || null;
}

// Whether an app may stage or edit proposals of this kind: an app-registered
// kind, or a platform kind that opts in with `appProposable: true`. Every other
// kind is platform-owned (fleet, apps, config, governance-internal…): only the
// platform files and edits it, so an app can neither forge a card the owner
// reads as Horst's or an orchestrator's nor rewrite one after it was read.
function appMayStage(def) {
  return !!def && (!!def.app || def.appProposable === true);
}

function refuseAppKind(kind, app) {
  return new Error(`kind "${kind}" is platform-owned: app "${app}" cannot propose or edit it (apps stage their own kinds and the platform kinds marked appProposable)`);
}

// The version of the payload a surface rendered: decide() refuses an approve
// whose version is not the current one, so an edit landing between render and
// click is never approved unseen. Kind is part of it — a conversion rewrites
// both.
function payloadVersion(p) {
  return crypto.createHash('sha256').update(JSON.stringify([p.kind, p.payload ?? null])).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Stores (JSON, atomic writes — same helpers as platform-horst, kept local so
// this module stays dependency-free of it)
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function proposalsPath() { return path.join(deps.dir, 'proposals.json'); }
function metaPath() { return path.join(deps.dir, 'gov-meta.json'); }

// Provenance now carries mail-derived strings (subject, from) so a card can name
// its source after the mail is gone — which means untrusted content is stored on
// the proposal. Whitelist the keys and clip the values on the way in: nothing
// here is ever executed, but it is rendered on three surfaces.
const SOURCE_KEYS = [
  'type', 'app', 'account', 'uid', 'eventIdx', 'attachmentId', 'filename',
  'threadId', 'messageId', 'subject', 'from', 'date', 'proposalId',
];
function normalizeSource(src) {
  if (!src || typeof src !== 'object') return null;
  const out = {};
  for (const k of SOURCE_KEYS) {
    const v = src[k];
    if (v == null) continue;
    out[k] = typeof v === 'number' ? v : String(v).slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}
function auditPath() { return path.join(deps.dir, 'audit.json'); }
function dialsPath() { return path.join(deps.dir, 'dials.json'); }

function newId() { return `p-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`; }

// Lazy expiry on every load: pending past TTL → expired. Expired proposals get
// one notifyExpired call so surfaces can retire their stale cards (Telegram).
function loadProposals() {
  const data = readJson(proposalsPath(), { items: [] });
  const expired = [];
  const now = Date.now();
  for (const p of data.items) {
    if (p.status !== 'pending') continue;
    // dueAtFor folds the three rules that decide a lifetime: an explicit
    // expiresAt the owner asked for, the kind's own TTL, and a calendar
    // proposal's own event date. Grandfathering lives in there too, so nothing
    // staged under the old 7-day rule expires early because this shipped.
    if (dueAtFor(p) <= now) { p.status = 'expired'; expired.push(p); }
  }
  // Writes around saveProposals deliberately: this transition only ever moves
  // pending → expired, so it can never create a duplicate-pending violation,
  // and the invariant check has nothing to say about it.
  if (expired.length) writeJson(proposalsPath(), data);
  for (const p of expired) {
    try { deps.notifyExpired?.(p); } catch {}
    // Expiry is a weak deny signal; the transition happens exactly once.
    decisions.record(ledgerRow(p, 'expire', 'system'));
  }
  return data;
}

// INVARIANT: at most one PENDING proposal per intentKey.
//
// Enforced in the single whole-file write path so no future caller can forget
// it — every staging path, conversion and edit funnels through here. A
// violation is a bug in the staging logic, never a state the user should see;
// tests must fail loudly, but a live dashboard must not be bricked by a store
// it refuses to write, so production logs it and lets the write through.
let strictInvariants = false;
function assertNoDuplicatePending(items) {
  const seen = new Map();
  for (const p of items || []) {
    if (p.status !== 'pending' || !p.intentKey) continue;
    const first = seen.get(p.intentKey);
    if (first) {
      const msg = `two pending proposals share intentKey "${p.intentKey}" (${first} and ${p.id})`;
      if (strictInvariants) throw new Error(`[horst-gov] invariant violated: ${msg}`);
      console.warn(`[horst-gov] INVARIANT: ${msg}`);
      return;
    }
    seen.set(p.intentKey, p.id);
  }
}

function saveProposals(data) {
  assertNoDuplicatePending(data.items);
  writeJson(proposalsPath(), data);
}

// Re-load and mutate ONE proposal by id, then save. This is the only safe way
// to persist state set after an await (executor runs): a whole-file save of a
// pre-await snapshot would clobber proposals created/decided meanwhile.
function patchProposal(id, fields) {
  const data = loadProposals();
  const p = data.items.find((x) => x.id === id);
  if (!p) return null;
  Object.assign(p, fields);
  saveProposals(data);
  return p;
}

function getProposal(id) {
  return loadProposals().items.find((p) => p.id === id) || null;
}

// Telegram approval cards sent for a proposal (initial notify + Approvals-menu
// re-sends). Recording {chatId, messageId, text} lets a decision made on ANY
// surface edit the cards in place instead of leaving stale actionable buttons.
// Returns the proposal; if it is no longer pending, the send raced the decision
// and the caller should close the just-sent card immediately.
function recordCard(id, card) {
  const data = loadProposals();
  const p = data.items.find((x) => x.id === id);
  if (!p) return null;
  if (p.status !== 'pending') return p;
  p.tgCards = [...(p.tgCards || []), {
    chatId: card.chatId, messageId: card.messageId,
    text: String(card.text || '').slice(0, 4000),
  }].slice(-10);
  saveProposals(data);
  return p;
}

// Keep stored card text in step with a refreshed payload, so a later closing
// edit doesn't revert the card body to the pre-refresh content.
function updateCardTexts(id, text) {
  const data = loadProposals();
  const p = data.items.find((x) => x.id === id);
  if (!p || !(p.tgCards || []).length) return;
  for (const c of p.tgCards) c.text = String(text || '').slice(0, 4000);
  saveProposals(data);
}

// ---------------------------------------------------------------------------
// Prior-action verdicts — "has this already been done?"
//
// Two sources, cheapest first: our own ledger (an executed twin proposal), then
// the world (horst-prior-action: calendar store, sent-mail log, Sent folder).
// The verdict is PERSISTED on the proposal as `prior`, so a GUI reload never
// loses it, and re-checked while the proposal is pending, so an action taken by
// hand after staging still reaches the card.
// ---------------------------------------------------------------------------

function sameSource(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  return a.account === b.account
    && String(a.uid) === String(b.uid)
    && (a.eventIdx ?? null) === (b.eventIdx ?? null);
}

// An identical proposal that already ran. Catches the case the world-check
// cannot see — a send whose Sent copy has not synced, an app kind with no
// checker — because we have first-hand knowledge that we did it.
function ledgerVerdict(proposal, items) {
  const key = proposal.dedupeKey;
  const src = proposal.source;
  if (!key && !src?.type) return null;
  const twin = items.find((x) => x.id !== proposal.id
    && x.kind === proposal.kind
    && x.status === 'executed'
    && (key ? x.dedupeKey === key : sameSource(x.source, src)));
  if (!twin) return null;
  const at = twin.executedAt || twin.decidedAt;
  return {
    state: 'done',
    at: Date.now(),
    label: 'Already done',
    detail: `Approved${at ? ` ${new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : ''} — ${twin.summary}`,
    evidence: { type: 'proposal', id: twin.id, status: twin.status, executedAt: twin.executedAt || null, summary: twin.summary },
  };
}

// ---------------------------------------------------------------------------
// Pre-stage suppression — "don't ask me this again"
//
// A verdict on an existing card is a warning; the user still has to dismiss it.
// For AUTOMATED proposers (triage sweeps) that is the wrong shape: a card the
// world already answered is not a decision, it is noise. So callers pass
// `checkFirst` and the check runs BEFORE the proposal exists — a pure duplicate
// is never staged at all, leaving an audit row instead of a queue entry.
//
// Three sources of "already answered", cheapest first:
//   1. a twin the user has already DECIDED (executed OR denied) for this exact
//      derivation — re-staging it would overrule a decision they made;
//   2. the durable decision ledger, for a calendar event denied so long ago that
//      proposals.json has rolled it off (cap 300 / 7-day pending TTL);
//   3. the world itself, via the prior-action check.
// ---------------------------------------------------------------------------

// Same derivation, already through the human once. Unlike ledgerVerdict this
// counts a DENIAL too: "no" is an answer, and a later email re-deriving the same
// event must not quietly ask again.
function decidedTwin(kind, { dedupeKey, source }, items) {
  if (!dedupeKey && !source?.type) return null;
  return items.find((x) => x.kind === kind
    && (x.status === 'executed' || x.status === 'denied')
    && (dedupeKey ? x.dedupeKey === dedupeKey : sameSource(x.source, source))) || null;
}

// Reading decisions.jsonl is a synchronous whole-file parse, and one triage
// sweep asks this question once per detected event — so one burst shares one
// read. Deliberately short: long enough to collapse a sweep, far too short to
// answer with a ledger that predates a decision made meanwhile. Mirrors the
// day-cache in horst-prior-action.js.
const DENIED_CACHE_MS = 5000;
let deniedCache = null; // { at, rows }

function deniedCalendarRows() {
  if (deniedCache && Date.now() - deniedCache.at < DENIED_CACHE_MS) return deniedCache.rows;
  const rows = decisions.list({ kind: 'calendar.create', decision: 'deny', limit: 300 });
  deniedCache = { at: Date.now(), rows };
  return rows;
}

// A calendar event the user denied at some point in the past, matched on the
// EVENT (day + clock + title anchors) rather than on the email it came from —
// the whole point, since the re-staging that prompted this arrived from a
// different message. decisions.jsonl is append-only and keeps title/date/times
// for calendar kinds, so it outlives proposals.json. Dates are absolute, so an
// old denial can never shadow a genuinely new appointment.
function deniedEventInLedger(kind, payload) {
  if (kind !== 'calendar.create') return null;
  try {
    return deniedCalendarRows().find((r) => r.payload && priorAction.sameEventPayloads(payload, {
      title: r.payload.title,
      date: r.payload.date,
      startTime: r.payload.startTime,
      // The ledger's generic projection stringifies booleans; the calendar
      // projection does not. Accept both.
      allDay: r.payload.allDay === true || r.payload.allDay === 'true',
    })) || null;
  } catch { return null; }
}

// Decide, before a proposal exists, whether it should exist at all.
//   → { suppress: true, reason, prior? }  never stage it; an audit row is written
//   → { suppress: false, prior }          stage it, carrying this verdict
// `prior` may be null, which createProposal reads as "checked, nothing found".
// Proposer health. A kind the owner answers "no" to, over and over, is a kind
// that should stop asking: on today's ledger todo.create is 0 approvals across
// 12 decisions, calendar.create ~4%. An approval queue whose answer is always no
// is not a safety feature, it is why the queue stops being read at all.
//
// Weighted (30-day half-life) rather than lifetime, so a kind recovers as soon
// as the owner starts approving it again — this suppresses a PROPOSER, it never
// disables a capability, and it never touches a proposal the owner asked for
// (preStageCheck runs only for automated proposers that opted into checkFirst).
const HEALTH_MIN_DECISIONS = 8;
const HEALTH_MIN_RATE = 0.4;

function unhealthyProposer(kind) {
  if (deps.proposerHealthOn?.() === false) return null; // Settings toggle
  let s = null;
  try { s = decisions.stats()[kind]; } catch { return null; }
  if (!s) return null;
  const humans = s.approved + s.denied + s.expired;
  if (humans < HEALTH_MIN_DECISIONS) return null;
  const rate = s.weightedApprovalRate;
  if (rate == null || rate >= HEALTH_MIN_RATE) return null;
  return { humans, approved: s.approved, rate };
}

async function preStageCheck(kind, payload, meta, def) {
  const describe = () => meta.summary || def.describe(payload);
  const drop = (reason, detail, prior) => {
    audit({ action: 'suppressed', kind, summary: `${describe()} — ${detail}`, ok: true, via: meta.origin || 'auto' });
    return { suppress: true, reason, prior: prior || null };
  };

  // Checked first: it is the cheapest test here, and a kind that should not be
  // asking has no business consulting the world about a card nobody will read.
  const health = unhealthyProposer(kind);
  if (health) {
    // Loud by construction (plan risk #4). The audit row is written by drop();
    // the agenda observation and the once-a-week chat line are the host's job,
    // since governance must never reach into platform-horst.
    try { deps.notifyProposerHealth?.(kind, health); } catch {}
    return drop('proposer-unhealthy',
      `you have approved ${health.approved} of the last ${health.humans} "${kind}" cards `
      + `(${Math.round(health.rate * 100)}% recently); I have stopped staging this kind`);
  }

  const twin = decidedTwin(kind, { dedupeKey: meta.dedupeKey || null, source: meta.source || null }, loadProposals().items);
  if (twin) {
    return drop(`already-${twin.status}`,
      `this was already ${twin.status === 'denied' ? 'denied' : 'approved'} (${twin.id}); not asking again`);
  }

  const denied = deniedEventInLedger(kind, payload);
  if (denied) {
    const when = denied.at ? new Date(denied.at).toLocaleString('en-GB', { dateStyle: 'medium' }) : 'earlier';
    return drop('denied-before', `you denied this event on ${when}; not asking again`);
  }

  const prior = await runPriorCheck({
    id: null, kind, payload, source: meta.source || null, app: meta.app || null,
    dedupeKey: meta.dedupeKey || null, createdAt: Date.now(),
  }).catch(() => null);

  // 'done' WITH adds is deliberately kept: it means the event exists but this
  // extraction knows more, and the only reason it was not converted to an update
  // is that the target is a recurring occurrence — instance-vs-series is a
  // question only the user can answer. A match PROMOTED on semantic evidence
  // alone (prior.semantic.promoted — horst-prior-action's 0.45-band promotion)
  // is also kept: matched by meaning rather than wording, it stages the card
  // carrying that evidence instead of silently answering for the user.
  if (prior?.state === 'done' && !prior.adds?.length && !prior.semantic?.promoted) {
    return drop('already-done', prior.detail ? `${prior.label} (${prior.detail})` : prior.label, prior);
  }
  return { suppress: false, prior };
}

// `fresh` bypasses the checker's short-lived read caches — used by the forced
// refresh, which fires because the calendar or mailbox just changed.
async function runPriorCheck(proposal, { fresh = false } = {}) {
  const led = ledgerVerdict(proposal, loadProposals().items);
  if (led) return led;
  return priorAction.check(proposal.kind, proposal.payload, {
    source: proposal.source || null,
    app: proposal.app || null,
    createdAt: proposal.createdAt || Date.now(),
    fresh,
  });
}

// Persist a verdict on a pending proposal. When the verdict is 'partial' the
// proposal is CONVERTED in place — a calendar.create whose event already exists
// becomes a calendar.update carrying the merged event — with both forms kept
// under `prior` so the user can switch back (convertProposal).
//
// A `userChoice` recorded by convertProposal is final: a later re-check must
// never silently undo what the user picked.
function applyPriorVerdict(id, verdict) {
  const data = loadProposals();
  const p = data.items.find((x) => x.id === id);
  if (!p || p.status !== 'pending') return null;
  if (p.prior?.userChoice) return p;

  // Record the negative too: it carries the `at` stamp the TTL needs, so a
  // clean proposal is not re-checked on every poll.
  if (!verdict) {
    p.prior = { state: 'none', at: Date.now() };
    saveProposals(data);
    return p;
  }

  const prior = { ...verdict };
  delete prior.suggest;

  if (verdict.state === 'partial' && verdict.suggest && verdict.suggest.kind !== p.kind) {
    const def = kindDef(verdict.suggest.kind);
    try {
      if (!def) throw new Error(`unknown kind "${verdict.suggest.kind}"`);
      verdict.suggest.payload = freeze(def, verdict.suggest.payload);
      def.validate(verdict.suggest.payload);
      prior.original = { kind: p.kind, payload: p.payload };
      prior.suggested = { kind: verdict.suggest.kind, payload: verdict.suggest.payload };
      prior.converted = true;
      p.kind = verdict.suggest.kind;
      p.payload = JSON.parse(JSON.stringify(verdict.suggest.payload)); // re-frozen
      p.summary = def.describe(p.payload);
      p.convertedAt = Date.now();
      p.prior = prior;
      saveProposals(data);
      audit({
        action: 'converted', kind: p.kind, proposalId: p.id,
        summary: `${p.summary} (was ${prior.original.kind} — the event already exists)`,
        ok: true, via: 'prior-check',
      });
      return p;
    } catch (err) {
      // The merged update didn't validate — keep the create, but still warn.
      console.warn('[horst-gov] prior conversion rejected:', err.message);
      prior.state = 'done';
    }
  }

  p.prior = prior;
  saveProposals(data);
  return p;
}

function announcePrior(p) {
  try { deps.broadcaster?.broadcast({ type: 'horst:proposal', proposal: withCard(p) }); } catch {}
  try { deps.notifyUpdate?.(p); } catch {}
}

// Fire-and-forget: the check hits the DB, and making createProposal async would
// ripple through every synchronous call site (chat, app-change requests, peer
// pairing). The card renders immediately and gains its banner over the same
// live channel the Approvals view already listens to.
// Brain check — the sibling of the prior-action check. Prior-action asks the
// WORLD ("already done?"); this asks the BRAIN ("does memory know something?").
// Deterministic recall (local embeddings + SQL, zero AI), persisted on the
// proposal like `prior` so it survives reloads; purely informational — never
// blocks, never decides.
function scheduleBrainCheck(proposal) {
  setImmediate(async () => {
    try {
      const memoryService = require('../memory-service');
      if (!memoryService.isReady()) return;
      const q = [proposal.summary, proposal.payload?.title, proposal.payload?.to, proposal.payload?.subject]
        .filter(Boolean).join(' ').slice(0, 300);
      if (!q) return;
      const res = await memoryService.recall({ query: q, limit: 3, app_origin: 'horst', scope_caller: 'horst' });
      const rows = [...(res?.hits || []), ...(res?.recent || [])].slice(0, 3);
      if (!rows.length) return;
      const notes = rows.map((r) => (r.content || [r.subject, r.predicate, r.value].filter(Boolean).join(' ')).slice(0, 160));
      const data = loadProposals();
      const p = data.items.find((x) => x.id === proposal.id);
      if (!p || p.status !== 'pending') return;
      p.brainNotes = { at: Date.now(), notes };
      saveProposals(data);
      try { deps.broadcaster?.broadcast({ type: 'horst:proposal', proposal: withCard(p) }); } catch {}
    } catch (err) { console.warn('[horst-gov] brain check failed:', err.message); }
  });
}

function schedulePriorCheck(proposal) {
  if (!priorAction.hasChecker(proposal.kind) && !proposal.dedupeKey && !proposal.source?.type) return;
  setImmediate(() => {
    runPriorCheck(proposal)
      .then((verdict) => {
        const updated = applyPriorVerdict(proposal.id, verdict);
        if (updated && verdict) announcePrior(updated);
      })
      .catch((err) => console.warn('[horst-gov] prior check failed:', err.message));
  });
}

// Re-check pending proposals whose verdict has aged past the TTL. Awaited by the
// Approvals route and triggered by email:sent / calendar:changed, so a card
// flips to "already done" without a reload. Single-flighted: concurrent GETs
// share one pass.
let _refreshing = null;
function refreshPending({ force = false } = {}) {
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    const now = Date.now();
    const due = loadProposals().items.filter((p) => p.status === 'pending'
      && !p.prior?.userChoice
      && !p.prior?.converted
      && (priorAction.hasChecker(p.kind) || p.dedupeKey || p.source?.type)
      && (force || !p.prior?.at || now - p.prior.at > PRIOR_TTL_MS))
      .slice(0, PRIOR_REFRESH_CAP);
    let changed = 0;
    for (const p of due) {
      try {
        const verdict = await runPriorCheck(p, { fresh: force });
        const before = p.prior?.state || null;
        const updated = applyPriorVerdict(p.id, verdict);
        if (updated && (verdict?.state || 'none') !== before) { changed++; announcePrior(updated); }
      } catch (err) {
        console.warn('[horst-gov] prior refresh failed:', err.message);
      }
    }
    return changed;
  })().finally(() => { _refreshing = null; });
  return _refreshing;
}

// Switch a converted proposal between its two forms ('update' = patch the
// existing event, 'create' = make a separate one). Only the pair recorded on
// `prior` is reachable, so this can never turn a proposal into an arbitrary
// kind, and the payload is re-validated and re-frozen either way.
function convertProposal(id, to, via = 'ui') {
  if (!['update', 'create'].includes(to)) throw new Error("convert target must be 'update' or 'create'");
  const data = loadProposals();
  const p = data.items.find((x) => x.id === id);
  if (!p) throw new Error('proposal not found');
  if (p.status !== 'pending') throw new Error(`proposal is already ${p.status}`);
  const target = to === 'update' ? p.prior?.suggested : p.prior?.original;
  if (!target) throw new Error('this proposal has no alternative form to switch to');
  const def = kindDef(target.kind);
  if (!def) throw new Error(`action kind "${target.kind}" is unavailable — its app may be stopped.`);
  const composed = freeze(def, target.payload);
  def.validate(composed);
  p.kind = target.kind;
  p.payload = JSON.parse(JSON.stringify(composed)); // re-frozen
  p.summary = def.describe(p.payload);
  p.prior = { ...p.prior, converted: to === 'update', userChoice: to };
  p.convertedAt = Date.now();
  saveProposals(data);
  audit({ action: 'converted', kind: p.kind, proposalId: p.id, summary: p.summary, ok: true, via });
  announcePrior(p);
  return p;
}

// The owner folding a card away without answering it.
//
// Deliberately NOT a denial. No ledger row is written, so a withdrawal can
// never be read as a rejection by the proposer-health statistics (step 9) —
// clearing a stale queue must not teach Horst that the kind is unwanted. And
// preStageCheck never treats a withdrawn row as "already decided", so the same
// act can legitimately be proposed again later.
function withdrawProposal(id, via = 'ui') {
  const data = loadProposals();
  const p = data.items.find((x) => x.id === id);
  if (!p) throw new Error('proposal not found');
  if (p.status !== 'pending') throw new Error(`proposal is already ${p.status}`);
  p.status = 'withdrawn';
  p.withdrawnAt = Date.now();
  saveProposals(data);
  audit({ action: 'withdrawn', kind: p.kind, proposalId: p.id, summary: p.summary, ok: true, via });
  try { deps.broadcaster?.broadcast({ type: 'horst:proposal', proposal: withCard(p) }); } catch {}
  try { deps.notifyWithdrawn?.(p); } catch {}
  return p;
}

// Ceiling on how far past now a proposal may be pushed, so "keep it" can never
// turn a pending card into a permanent one.
const MAX_EXPIRY_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

// "Keep this one a while longer." Sets the explicit expiry honoured by
// loadProposals; the age chips keep reading from createdAt, so the card still
// tells the truth about how long it has been waiting.
function extendProposal(id, ms, via = 'ui') {
  const add = Number(ms);
  if (!Number.isFinite(add) || add <= 0) throw new Error('extension must be a positive number of milliseconds');
  const data = loadProposals();
  const p = data.items.find((x) => x.id === id);
  if (!p) throw new Error('proposal not found');
  // loadProposals has already expired anything past due, so this also rejects
  // extending a proposal that ran out while the queue was being read.
  if (p.status !== 'pending') throw new Error(`proposal is already ${p.status}`);
  const from = p.expiresAt != null ? p.expiresAt : (p.createdAt || Date.now()) + PROPOSAL_TTL_MS;
  p.expiresAt = Math.min(from + add, Date.now() + MAX_EXPIRY_HORIZON_MS);
  saveProposals(data);
  audit({
    action: 'extended', kind: p.kind, proposalId: p.id,
    summary: `${p.summary} — kept until ${new Date(p.expiresAt).toISOString().slice(0, 10)}`,
    ok: true, via,
  });
  try { deps.broadcaster?.broadcast({ type: 'horst:proposal', proposal: withCard(p) }); } catch {}
  return p;
}

function audit(entry) {
  const data = readJson(auditPath(), { items: [] });
  data.items.unshift({ at: Date.now(), ...entry });
  data.items = data.items.slice(0, AUDIT_CAP);
  writeJson(auditPath(), data);
}

function listAudit() { return readJson(auditPath(), { items: [] }).items; }

// ---------------------------------------------------------------------------
// Autonomy dials
// ---------------------------------------------------------------------------

function clampLevel(kind, level) {
  const def = kindDef(kind);
  if (!def) return 'propose';
  const iCeil = LEVELS.indexOf(def.ceiling);
  const iLvl = LEVELS.indexOf(level);
  if (iLvl < 0) return def.defaultLevel;
  return LEVELS[Math.min(iLvl, iCeil)];
}

function getDials() {
  const stored = readJson(dialsPath(), {});
  const out = {};
  for (const [kind, def] of [...Object.entries(KINDS), ...Object.entries(platformKinds), ...Object.entries(registeredKinds)]) {
    out[kind] = {
      level: clampLevel(kind, stored[kind] || def.defaultLevel),
      ceiling: def.ceiling,
      label: def.label,
      default: def.defaultLevel,
      ...(def.about ? { about: def.about } : {}),
      ...(def.pinNote ? { pinNote: def.pinNote } : {}),
      ...(def.notify === 'none' ? { notify: 'none' } : {}),
      ...(def.app ? { app: def.app } : {}),
    };
  }
  return out;
}

function setDial(kind, level, via = 'ui') {
  if (!kindDef(kind)) throw new Error(`unknown action kind "${kind}"`);
  if (!LEVELS.includes(level)) throw new Error(`unknown level "${level}"`);
  const clamped = clampLevel(kind, level);
  const stored = readJson(dialsPath(), {});
  stored[kind] = clamped;
  writeJson(dialsPath(), stored);
  audit({ action: 'dial', kind, summary: `Autonomy for ${kind} set to ${clamped}`, ok: true, via });
  return { kind, level: clamped, clamped: clamped !== level };
}

// ---------------------------------------------------------------------------
// Core: request an action / decide a proposal
// ---------------------------------------------------------------------------

// A kind's identity(), defensively. An identity that throws or returns a
// non-string degrades the proposal to "unidentifiable" (i.e. today's
// dedupeKey-only behaviour) — a bad key must never block staging.
// The card is DERIVED, never stored — a proposal is its frozen payload, and a
// rendering of it is not part of that record. It is attached on the way out
// instead, here (every horst:proposal broadcast) and at the REST egress in
// platform-horst, so no surface has to know how to render a kind it has never
// heard of.
function withCard(p) {
  if (!p) return p;
  try {
    const def = kindDef(p.kind);
    const out = { ...p, version: payloadVersion(p), card: require('./horst-cards').cardFor(def, p) };
    // The Horst tab approves such a proposal only from its full card ('ui-full').
    if (def && p.status === 'pending' && approvalRefusal(def, p, 'ui')) out.fullViewApprove = true;
    return out;
  } catch {
    return p;
  }
}

function identityOf(def, payload, meta) {
  if (typeof def?.identity !== 'function') return null;
  try {
    const key = def.identity(payload, meta || {});
    return typeof key === 'string' && key.trim() ? key.trim().slice(0, 200) : null;
  } catch (err) {
    console.warn('[horst-gov] identity() failed:', err.message);
    return null;
  }
}

function resolveNotify(def, meta) {
  if (meta.notify === 'none' || meta.notify === 'tg') return meta.notify;
  return def.notify === 'none' ? 'none' : 'tg';
}

// Derived fields recomputed from their sources at EVERY freeze point, so no
// caller — on any surface — can freeze a payload whose rendered form disagrees
// with the inputs it claims to come from. A browser posts a flag; the server
// decides what that flag means. A kind that declares no `compose` passes
// through untouched, which is every kind but email.send today.
//
// This runs BEFORE validate on purpose: validate then checks the composed
// result, so the assertion and the thing that gets frozen are the same object.
function freeze(def, payload) {
  return typeof def?.compose === 'function' ? def.compose(payload) : payload;
}

function createProposal(kind, payload, meta = {}) {
  const def = kindDef(kind);
  if (!def) throw new Error(`unknown action kind "${kind}"`);
  payload = freeze(def, payload);
  def.validate(payload);

  const data = loadProposals();

  // Identity of the ACT (horst-identity.js) — computed once, HERE. It is
  // deliberately never recomputed: applyPriorVerdict and convertProposal
  // rewrite `kind` and `payload` in place, and leaving intentKey untouched is
  // precisely what keeps a converted proposal recognisable as the twin of the
  // derivation that produced it.
  const intentKey = identityOf(def, payload, meta);

  // Same act, already ANSWERED. This is what stops the "executed three times"
  // case: the world-check is asynchronous and trusted for only 60s, but an
  // executed twin is first-hand knowledge and costs nothing to see.
  // An explicit chat request is never suppressed — the user asked for it, so
  // they get a card. Same rule the dials state: asking Horst for something in
  // chat always creates an approval card, whatever else the system thinks.
  if (intentKey && (meta.origin || 'chat') !== 'chat') {
    const decided = data.items.find((p) => p.intentKey === intentKey
      && (p.status === 'executed' || p.status === 'denied'));
    if (decided) {
      audit({
        action: 'suppressed', kind, proposalId: decided.id,
        summary: `${meta.summary || def.describe(payload)} — already ${decided.status} (${decided.id}); not staging a duplicate`,
        ok: true, via: meta.origin || 'auto',
      });
      return decided;
    }
  }

  // A PENDING twin is refreshed in place (payload re-frozen, summary updated)
  // instead of duplicated — this is how a later, better extraction (e.g. an
  // attachment scan adding a start time) upgrades an already-staged card without
  // re-notifying the owner. Three notions of twin, widest first:
  //   • same ACT (intentKey) — kind-AGNOSTIC, so a calendar.create that has
  //     since been converted to a calendar.update is still recognised as the
  //     same appointment. The kind-locked scan below could not see it, which is
  //     why one event staged, converted, and staged again on every pass;
  //   • dedupeKey — the same derivation, re-run;
  //   • same EVENT — a calendar create staged from a different email, under a
  //     different key. Two cards for one appointment are two decisions the user
  //     has to make about the same thing.
  {
    const existing = (intentKey
      ? data.items.find((p) => p.status === 'pending' && p.intentKey === intentKey)
      : null)
      || data.items.find((p) => p.status === 'pending' && p.kind === kind && (
        (meta.dedupeKey && p.dedupeKey === meta.dedupeKey)
        || (kind === 'calendar.create' && priorAction.sameEventPayloads(payload, p.payload))
      ));
    if (existing) {
      // Same act staged under a DIFFERENT kind: the pending row is a converted
      // form that knows more than this derivation does (a calendar.update
      // carrying the id of the event that turned out to exist). `kind` and
      // `payload` must stay in step, so overwriting the payload with a bare
      // create payload would leave a row that fails validation on approval.
      // Keep the better form — the re-derivation is noise.
      if (existing.kind !== kind) {
        audit({
          action: 'suppressed', kind, proposalId: existing.id,
          summary: `${meta.summary || def.describe(payload)} — already staged as ${existing.kind} (${existing.id})`,
          ok: true, via: meta.origin || existing.origin,
        });
        return existing;
      }
      // Rows staged before this kind had an identity adopt one now, so they
      // dedupe from here on instead of staying invisible forever.
      if (intentKey && !existing.intentKey) existing.intentKey = intentKey;
      existing.payload = JSON.parse(JSON.stringify(payload));
      existing.summary = meta.summary || def.describe(payload);
      existing.detail = meta.detail ?? existing.detail;
      existing.source = meta.source ?? existing.source ?? null;
      existing.updatedAt = Date.now();
      saveProposals(data);
      audit({ action: 'updated', kind, proposalId: existing.id, summary: existing.summary, ok: true, via: meta.origin || existing.origin });
      try { deps.broadcaster?.broadcast({ type: 'horst:proposal', proposal: withCard(existing) }); } catch {}
      try { deps.notifyUpdate?.(existing); } catch {}
      // The payload changed, so the old verdict no longer describes it — unless
      // the user has already chosen a form, which stays theirs. A caller that
      // already ran the check (requestAction's checkFirst) hands its verdict in
      // rather than paying for a second one.
      if (existing.prior?.userChoice) return existing;
      if (meta.prior !== undefined) return applyPriorVerdict(existing.id, meta.prior) || existing;
      schedulePriorCheck(existing);
      return existing;
    }
  }

  const proposal = {
    id: newId(),
    kind,
    summary: meta.summary || def.describe(payload),
    detail: meta.detail || null,
    payload: JSON.parse(JSON.stringify(payload)), // frozen
    origin: meta.origin || 'chat',
    app: meta.app || null,
    dedupeKey: meta.dedupeKey || null,
    // The ACT this proposal performs (horst-identity.js). Survives conversion
    // to another kind — see the comment where it is computed.
    intentKey,
    // Provenance: the artifact this proposal was derived from, e.g.
    // { type:'email', account, uid, eventIdx? }. Deliberately NOT in the
    // payload — payloads are frozen and handed to executors verbatim, and
    // calendar.create spreads its payload straight into createEvent. This is
    // what lets a surface link a card back to the mail that caused it.
    source: normalizeSource(meta.source),
    status: 'pending',
    // Verdict of the prior-action check. Set here only when the caller already
    // ran it (requestAction's pre-execution check); otherwise it lands
    // asynchronously via schedulePriorCheck below.
    prior: null,
    createdAt: Date.now(),
    decidedAt: null,
    executedAt: null,
    result: null,
    error: null,
  };
  data.items.unshift(proposal);
  data.items = data.items.slice(0, PROPOSAL_CAP);
  saveProposals(data);
  audit({ action: 'proposed', kind, proposalId: proposal.id, summary: proposal.summary, ok: true, via: proposal.origin });
  // A known verdict is applied before anyone is notified, so the card is never
  // pushed to Telegram without its "already done" warning.
  const staged = meta.prior !== undefined ? applyPriorVerdict(proposal.id, meta.prior) : null;
  const out = staged || proposal;
  try { deps.broadcaster?.broadcast({ type: 'horst:proposal', proposal: withCard(out) }); } catch {}
  if (resolveNotify(def, meta) !== 'none') {
    try { deps.notifyProposal?.(out); } catch (err) { console.warn('[horst-gov] notifyProposal failed:', err.message); }
  }
  if (meta.prior === undefined) schedulePriorCheck(out);
  scheduleBrainCheck(out);
  return out;
}

// User-edited payload for a PENDING proposal: re-validate and re-freeze, so
// the "what you approve is exactly what runs" guarantee holds for the edit.
// Only the human-facing surfaces call this (via 'ui'/'telegram'/'app:<name>')
// — model code paths go through createProposal/dedupeKey instead.
function updateProposal(id, payload, via = 'ui') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be an object');
  }
  const data = loadProposals();
  const p = data.items.find((x) => x.id === id);
  if (!p) throw new Error('proposal not found');
  if (p.status !== 'pending') throw new Error(`proposal is already ${p.status}`);
  const def = kindDef(p.kind);
  if (!def) throw new Error(`action kind "${p.kind}" is unavailable — its app may be stopped. Start the app and edit again.`);
  if (String(via).startsWith('app:') && !appMayStage(def)) throw refuseAppKind(p.kind, String(via).slice(4));
  payload = freeze(def, payload);
  def.validate(payload);
  // First edit only: keep the model's original draft so the decision ledger
  // can diff draft → final-approved (the net preference signal). Never
  // executed; the frozen-payload contract below is untouched.
  if (!p.originalPayload) p.originalPayload = JSON.parse(JSON.stringify(p.payload));
  p.payload = JSON.parse(JSON.stringify(payload)); // re-frozen
  p.summary = def.describe(p.payload);
  p.editedAt = Date.now();
  saveProposals(data);
  audit({ action: 'edited', kind: p.kind, proposalId: p.id, summary: p.summary, ok: true, via });
  try { deps.broadcaster?.broadcast({ type: 'horst:proposal', proposal: withCard(p) }); } catch {}
  try { deps.notifyUpdate?.(p); } catch {}
  // An edited payload may now match (or stop matching) something in the world.
  if (!p.prior?.userChoice) schedulePriorCheck(p);
  // The version the editor now shows: an approve right after the edit sends it.
  return { ...p, version: payloadVersion(p) };
}

// { kind, payload, summary? } naming a registered kind — anything else is dropped.
function validInverse(inv) {
  return !!(inv && typeof inv === 'object' && typeof inv.kind === 'string' && kindDef(inv.kind)
    && inv.payload && typeof inv.payload === 'object' && !Array.isArray(inv.payload));
}

// Run the executor and return the outcome fields (never touches the store —
// the caller patches by id after the await).
async function runExecutor(def, proposal, via = 'approval') {
  try {
    const result = await def.execute(proposal.payload, proposal, { launcher: (kind) => launchers[kind] || null });
    const summary = result && typeof result.summary === 'string'
      ? result.summary.slice(0, RESULT_SUMMARY_MAX) : undefined;
    audit({ action: 'executed', kind: proposal.kind, proposalId: proposal.id, summary: summary || proposal.summary, ok: true, via });
    return {
      status: 'executed',
      executedAt: Date.now(),
      result: {
        ok: !(result && typeof result === 'object' && result.ok === false),
        ...(summary ? { summary } : {}),
        ...(result && result.eventId ? { eventId: result.eventId } : {}),
        // The exact inverse, when the executor knew the state it replaced
        // (tags it added, the rule it removed, a todo's previous fields). The
        // undo route stages it as a fresh proposal (stageUndo, platform-horst).
        ...(validInverse(result && result.inverse) ? { inverse: result.inverse } : {}),
      },
    };
  } catch (err) {
    audit({ action: 'failed', kind: proposal.kind, proposalId: proposal.id, summary: `${proposal.summary} — ${err.message}`, ok: false, via });
    // An app-registered executor that throws is that app's failure.
    if (def.app) require('../app-guard').record(def.app, `governance.${proposal.kind}`, err, { proposalId: proposal.id });
    return { status: 'failed', executedAt: Date.now(), error: err.message };
  }
}

// Approve or deny a pending proposal, executing on approval.
// via: 'ui' | 'ui-full' (the Horst tab's full card) | 'miniapp' | 'telegram' | 'app:<name>'.
// Assemble a decision-ledger row from a proposal. Kept here (not in the
// ledger module) because it reads proposal internals; the ledger stays
// proposal-store-free (the expiry hook lives inside loadProposals — a ledger
// that read proposals back would recurse).
function ledgerRow(p, decision, via) {
  const diff = p.editedAt && p.originalPayload ? decisions.diffPayloads(p.originalPayload, p.payload) : {};
  // "Edited" has to mean the human changed CONTENT. A signature toggle stamps
  // editedAt but touches only fields the server recomputes, which diffPayloads
  // already excludes — so without this, flipping a checkbox would register as
  // a draft-quality complaint. Unknown provenance (no originalPayload) still
  // counts as edited: that is the conservative reading.
  const edited = !!p.editedAt && (!p.originalPayload || !!diff.editedFields);
  return {
    proposalId: p.id, kind: p.kind, app: p.app || null, origin: p.origin || null,
    decision, via,
    edited, editedFields: diff.editedFields || null, editDiff: diff.editDiff || null,
    // The signature preference, carried on its own so it survives the carve-out
    // above: a real choice the owner made, kept out of the quality signal.
    signature: typeof p.payload?.includeSignature === 'boolean' ? (p.payload.includeSignature ? 'on' : 'off') : null,
    summary: p.summary || null,
    // The message the decision was ABOUT, so "what happened to this email?" is
    // answerable from the ledger itself. An app that wants the approved/denied
    // chip next to a message otherwise has to keep its own mirror of every
    // decision — which is the duplication this phase exists to end. Trimmed to
    // the addressing fields: the row has a 4KB budget, and the subject/sender
    // are already on the message being rendered.
    // eventIdx rides along when it is there: one mail can carry two extracted
    // events, and a surface showing an approved/denied chip per event needs to
    // tell them apart.
    source: p.source && p.source.type === 'email' && p.source.account && p.source.uid
      ? {
        type: 'email', account: p.source.account, uid: String(p.source.uid),
        ...(p.source.eventIdx == null ? {} : { eventIdx: p.source.eventIdx }),
      }
      : (p.source && p.source.type ? { type: p.source.type } : null),
    payload: decisions.compactPayload(p.kind, p.payload),
    latencyMs: p.decidedAt && p.createdAt ? p.decidedAt - p.createdAt : (p.createdAt ? Date.now() - p.createdAt : null),
    prior: p.prior?.state || null,
    converted: p.prior?.converted ? { from: p.prior.original?.kind || null } : null,
    outcome: p.status === 'executed' ? 'executed' : p.status === 'failed' ? 'failed' : null,
    error: p.error ? String(p.error).slice(0, 300) : null,
  };
}

function approvalRefusal(def, proposal, via) {
  if (typeof def.approveFrom !== 'function') return null;
  try {
    const why = def.approveFrom(proposal, via);
    return why ? String(why) : null;
  } catch (err) {
    return `approval refused: ${err.message}`;
  }
}

// `opts.version`: the payloadVersion the surface rendered. A caller that passes
// the key gets it checked on approve (every platform surface passes it, null
// when its client sent none); an in-process caller that omits it approves the
// current payload.
async function decide(id, decision, via = 'ui', opts = {}) {
  if (!['approve', 'deny'].includes(decision)) throw new Error('decision must be approve or deny');
  const data = loadProposals();
  let proposal = data.items.find((p) => p.id === id);
  if (!proposal) throw new Error('proposal not found');
  if (proposal.status !== 'pending') throw new Error(`proposal is already ${proposal.status}`);

  if (decision === 'deny') {
    proposal.status = 'denied';
    proposal.decidedAt = Date.now();
    saveProposals(data);
    audit({ action: 'denied', kind: proposal.kind, proposalId: proposal.id, summary: proposal.summary, ok: true, via });
    decisions.record(ledgerRow(proposal, 'deny', via));
    deniedCache = null; // a fresh "no" must be visible to the next stage attempt
  } else {
    // Guard BEFORE consuming the decision: a kind with no live def (its app is
    // stopped) must leave the proposal pending so it can be approved later.
    const def = kindDef(proposal.kind);
    if (!def) {
      throw new Error(`action kind "${proposal.kind}" is unavailable — its app may be stopped. Start the app and approve again.`);
    }
    // A surface the kind does not trust with this approval: refused, and the
    // proposal stays pending for a surface that showed all of it.
    const refused = approvalRefusal(def, proposal, via);
    if (refused) throw new Error(refused);
    // The payload changed after this surface rendered it: refused, still
    // pending, so the surface re-renders the current version.
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'version') && opts.version !== payloadVersion(proposal)) {
      const err = new Error('This proposal changed after it was shown to you: look at the current version and approve that.');
      err.code = 'STALE_VERSION';
      throw err;
    }
    proposal.status = 'approved';
    proposal.decidedAt = Date.now();
    saveProposals(data); // status persisted pre-await: a concurrent decide sees 'approved' and rejects
    // `via` reaches the audit rows too — without it every execution claimed to
    // come from 'approval' and audit.json could not tell Telegram from the GUI
    // (nor a human approval from an autonomous run).
    const outcome = await runExecutor(def, proposal, via);
    proposal = patchProposal(proposal.id, outcome) || Object.assign(proposal, outcome);
    decisions.record(ledgerRow(proposal, 'approve', via));
  }
  try { deps.broadcaster?.broadcast({ type: 'horst:proposal', proposal: withCard(proposal) }); } catch {}
  try { deps.notifyDecision?.(proposal, via); } catch {}
  return proposal;
}

// Triage/automation entry point: consult the dial and either act, stage, or
// just observe. Chat-originated actions should call createProposal directly
// (an explicit user conversation always yields an explicit proposal).
async function requestAction(kind, payload, meta = {}) {
  const def = kindDef(kind);
  if (!def) throw new Error(`unknown action kind "${kind}"`);
  if (meta.app && !appMayStage(def)) throw refuseAppKind(kind, meta.app);
  payload = freeze(def, payload);
  def.validate(payload);
  const level = getDials()[kind].level;

  if (level === 'observe') {
    audit({ action: 'observed', kind, summary: meta.summary || def.describe(payload), ok: true, via: meta.origin || 'auto' });
    return { mode: 'observed' };
  }
  // Paused (kill switch) or propose-level: stage for approval. Pause never
  // blocks the user's own approvals — only autonomous execution.
  if (level === 'propose' || deps.isPaused?.()) {
    // Automated proposers opt into being checked BEFORE they take up space in
    // the approval queue. A user-initiated proposal never does — they asked for
    // it, so it is staged with its warning and they decide.
    if (meta.checkFirst) {
      const pre = await preStageCheck(kind, payload, meta, def);
      if (pre.suppress) return { mode: 'suppressed', reason: pre.reason, prior: pre.prior || null };
      // `prior` is passed through even when it is null: createProposal reads
      // `meta.prior !== undefined` as "already checked" and skips the async
      // re-check, and a non-null 'partial' verdict converts the create into an
      // update carrying the merged event.
      return { mode: 'proposed', proposal: createProposal(kind, payload, { ...meta, prior: pre.prior }) };
    }
    const proposal = createProposal(kind, payload, meta);
    return { mode: 'proposed', proposal };
  }

  // auto / auto+notify: check FIRST. Autonomy is permission to act, not
  // permission to duplicate — an action the world says is already done gets
  // downgraded to a pending approval carrying the evidence, so the human
  // decides whether to repeat it. This is the only place the check gates
  // execution rather than merely annotating it.
  const prior = await runPriorCheck({
    id: null, kind, payload, source: meta.source || null, app: meta.app || null,
    dedupeKey: meta.dedupeKey || null, createdAt: Date.now(),
  }).catch(() => null);
  if (prior && prior.state !== 'none') {
    audit({
      action: 'downgraded', kind,
      summary: `${meta.summary || def.describe(payload)} — ${prior.label}; staged for approval instead of running at ${level}`,
      ok: true, via: meta.origin || 'auto',
    });
    const proposal = createProposal(kind, payload, { ...meta, prior });
    return { mode: 'proposed', proposal, downgraded: true };
  }

  // Execute immediately, recorded as a pre-approved proposal so the audit trail
  // and UI show exactly what ran.
  const data = loadProposals();
  let proposal = {
    id: newId(), kind, summary: meta.summary || def.describe(payload), detail: meta.detail || null,
    payload: JSON.parse(JSON.stringify(payload)), origin: meta.origin || 'auto', app: meta.app || null,
    dedupeKey: meta.dedupeKey || null, source: normalizeSource(meta.source),
    // Carried on the auto path too: an autonomously executed act must suppress
    // a later duplicate exactly as an approved one does.
    intentKey: identityOf(def, payload, meta),
    status: 'approved', createdAt: Date.now(), decidedAt: Date.now(), executedAt: null, result: null, error: null,
    auto: true,
  };
  data.items.unshift(proposal);
  data.items = data.items.slice(0, PROPOSAL_CAP);
  saveProposals(data);
  const outcome = await runExecutor(def, proposal, 'auto');
  proposal = patchProposal(proposal.id, outcome) || Object.assign(proposal, outcome);
  decisions.record(ledgerRow(proposal, 'auto', 'auto'));
  try { deps.broadcaster?.broadcast({ type: 'horst:proposal', proposal: withCard(proposal) }); } catch {}
  if (level === 'auto+notify') { try { deps.notifyDecision?.(proposal, 'auto'); } catch {} }
  return { mode: 'executed', proposal };
}

function listProposals({ status, kind, app, limit = 100 } = {}) {
  let items = loadProposals().items;
  if (status) items = items.filter((p) => p.status === status);
  if (kind) items = items.filter((p) => p.kind === kind);
  if (app) items = items.filter((p) => p.app === app);
  return items.slice(0, limit).map((p) => ({ ...p, version: payloadVersion(p) }));
}

function pendingCount() {
  return loadProposals().items.filter((p) => p.status === 'pending').length;
}

// One-time migration: give stored proposals an intentKey, then collapse the
// duplicates the old kind-locked scan let through.
//
// Runs from init(), which platform-horst calls immediately AFTER
// registerPlatformKinds — so platform kind defs, and therefore identity(), are
// available. App kinds are not (they register when their app starts), so their
// rows stay unkeyed and pick a key up the next time they are staged.
//
// Deliberately logged and never silent: a collapse hides a card the owner may
// have been waiting for, so each one leaves an audit row naming its survivor.
function backfillIdentity() {
  const meta = readJson(metaPath(), {});
  if (meta.identityBackfillAt) return null;

  // Raw read/write, NOT loadProposals/saveProposals: the store being migrated is
  // precisely the one that may still violate the uniqueness invariant, and the
  // lazy-expiry side effects of a load have no business firing inside a boot
  // migration.
  const data = readJson(proposalsPath(), { items: [] });
  let keyed = 0;
  for (const p of data.items) {
    if (p.intentKey) continue;
    const def = kindDef(p.kind);
    p.intentKey = def
      ? identityOf(def, p.payload, { source: p.source, app: p.app, origin: p.origin })
      : null;
    if (p.intentKey) keyed++;
  }

  // Among PENDING rows only: one act, one card. The newest wins — it carries
  // the best extraction (a later pass may have added a start time or converted
  // the kind); the others become `withdrawn`, pointing at their survivor.
  const winner = new Map();
  const collapsed = [];
  for (const p of data.items) {
    if (p.status !== 'pending' || !p.intentKey) continue;
    const held = winner.get(p.intentKey);
    if (!held) { winner.set(p.intentKey, p); continue; }
    const [keep, drop] = (p.createdAt || 0) > (held.createdAt || 0) ? [p, held] : [held, p];
    winner.set(p.intentKey, keep);
    drop.status = 'withdrawn';
    drop.withdrawnAt = Date.now();
    drop.supersededBy = keep.id;
    collapsed.push(drop);
  }

  writeJson(proposalsPath(), data);
  writeJson(metaPath(), { ...meta, identityBackfillAt: Date.now() });

  for (const p of collapsed) {
    audit({
      action: 'collapsed', kind: p.kind, proposalId: p.id,
      summary: `${p.summary} — superseded by ${p.supersededBy} (same act)`,
      ok: true, via: 'migration',
    });
    try { deps.notifyWithdrawn?.(p); } catch {}
  }
  console.log(`[horst-gov] identity backfill: ${keyed}/${data.items.length} proposal(s) keyed, ${collapsed.length} duplicate pending collapsed`);
  return { keyed, collapsed: collapsed.length };
}

function init(options) {
  deps = options;
  fs.mkdirSync(deps.dir, { recursive: true });
  decisions.init({ dir: deps.dir });
  // Never let a migration stop the platform from booting.
  // The kind-scoped TTLs apply from the moment the policy shipped, never
  // retroactively. Stamped once and read on every boot after that, so a queue
  // staged under the old 7-day rule is never mass-expired by a deploy.
  try {
    const meta = readJson(metaPath(), {});
    const from = meta.ttlPolicyFrom || Date.now();
    if (!meta.ttlPolicyFrom) writeJson(metaPath(), { ...meta, ttlPolicyFrom: from });
    ttlPolicyFrom = from;
  } catch { ttlPolicyFrom = Date.now(); }

  try { backfillIdentity(); } catch (err) { console.warn('[horst-gov] identity backfill failed:', err.message); }
}

module.exports = {
  init, KINDS, LEVELS, LEVEL_INFO, DIAL_RULES,
  createProposal, requestAction, decide, updateProposal, convertProposal,
  withdrawProposal, extendProposal,
  refreshPending,
  listProposals, getProposal, pendingCount,
  // The ledger's per-message view, re-exported here so a surface that already
  // holds the approval plane does not have to reach past it into the store.
  decisionsFor: (params) => decisions.bySource(params),
  recordCard, updateCardTexts,
  getDials, setDial,
  audit, listAudit,
  registerLauncher,
  registerKind, unregisterKinds, kindDef, approvalRefusal, appMayStage, payloadVersion,
  registerPlatformKinds, platformKindNames,
  // Tests assert the uniqueness invariant is unreachable rather than merely
  // unlikely; production stays log-and-continue (see assertNoDuplicatePending).
  __setStrictInvariants: (on) => { strictInvariants = !!on; },
};
