// Horst's missions — the GOAL brain: durable objectives Horst pursues across
// weeks, the keystone layer between directives (which CONSTRAIN, always-on)
// and the work stack (which EXECUTES, minutes-scale, amnesic above the item
// level). A mission owns the WHY across work items: it spawns work, collects
// progress, gets reviewed on a cadence, and can be blocked/paused/abandoned —
// all visible and auditable.
//
// Trust discipline (G7/G8): assigning Horst a goal is consequential —
//   • user-assigned via chat  → <horst-mission> marker → PENDING, confirmed
//     like a directive (one click);
//   • Horst-proposed          → governance kind 'mission.create', ceiling
//     'propose' PINNED — his most volitional act always needs a human.
// The kill switch pauses mission-spawned work and reviews.
//
// Store + lifecycle + taster + review sweep AND the review ritual all live
// here. The ritual is ONE bundled AI call — assess, log progress, propose
// follow-ups, raise questions — driven straight off the heartbeat's sweep.
//
// It used to be a P2 work item executed by horst-cognition's
// __mission_review__ step. Phase 8F deleted the work stack and the cognition
// pipeline, and the ritual needed neither: it is one call plus judgment, with
// no lanes, no step cursor and nothing to park on. What it DID need from the
// stack was somewhere to put its follow-ups, and the answer is better than a
// queue nothing drained — a follow-up is now a governance proposal
// (requestAction, so it lands at the owner's dial for that kind) or an agenda
// observation. Mission output goes in front of the owner instead of into a
// lane. Governance's own identity/prior-action path supplies the dedup the
// stack's useCase+dedupeKey used to give us.
//
// Mission STATUS is still never changed here — adopting, pausing or closing a
// goal stays the owner's one click, and the review only suggests. The design's
// genetic + curation use cases are the two seeded standing missions below.
//
// Storage: .horst/missions.json — Horst's OWN operational state (beside
// directives and the agenda), not the platform DB (todos are the user's life
// data; missions are Horst's). Atomic writes, reload-resilient.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const horstBrain = require('./horst-brain');

const STATUSES = ['proposed', 'pending', 'active', 'paused', 'blocked', 'done', 'abandoned'];
const ORIGINS = ['user', 'horst', 'directive', 'seed'];
const DEFAULT_CADENCE_DAYS = 7;
const MISSION_CAP = 100;
const PROGRESS_CAP = 50;
const REVIEW_PROPOSAL_CAP = 2;  // follow-ups one review may raise (G5: capped, never a firehose)

// { dir, broadcaster, addObservation?, appsDir?, fmtDirectives?, notify?,
//   governance?, aiPrompt? } — everything past the store is injected, so this
// module still requires nothing that requires it.
let deps = {};
let aiPromptFn = null;

function init(options) {
  deps = options;
  aiPromptFn = options.aiPrompt || ((app, dir, params) => require('../app-bridge').aiPrompt(app, dir, params));
  fs.mkdirSync(deps.dir, { recursive: true });
  seedStandingMissions();
}

function storePath() { return path.join(deps.dir, 'missions.json'); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) { const t = file + '.tmp'; fs.writeFileSync(t, JSON.stringify(data, null, 2)); fs.renameSync(t, file); }
function load() { const d = readJson(storePath(), { items: [] }); if (!d.items) d.items = []; return d; }
function save(d) { d.items = d.items.slice(0, MISSION_CAP); writeJson(storePath(), d); }
function newId() { return `mi-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`; }
function broadcast() { try { deps.broadcaster?.broadcast({ type: 'horst:missions' }); } catch {} }

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// create({title, goal, approach?, origin, status?, reviewCadenceDays?, links?})
function create(spec) {
  const title = String(spec.title || '').trim().slice(0, 200);
  if (!title) throw new Error('mission requires a title');
  const status = STATUSES.includes(spec.status) ? spec.status : 'pending';
  const cadence = Math.min(Math.max(Number(spec.reviewCadenceDays) || DEFAULT_CADENCE_DAYS, 1), 90);
  const d = load();
  const item = {
    id: newId(),
    title,
    goal: String(spec.goal || title).trim().slice(0, 1000),
    approach: spec.approach ? String(spec.approach).slice(0, 2000) : null,
    status,
    origin: ORIGINS.includes(spec.origin) ? spec.origin : 'user',
    reviewCadenceDays: cadence,
    nextReviewAt: status === 'active' ? Date.now() + cadence * 86400e3 : null,
    progress: [],
    doubts: [],
    links: spec.links && typeof spec.links === 'object' ? spec.links : {},
    correlationId: `mission:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [{ at: Date.now(), action: 'created', status }],
  };
  d.items.unshift(item);
  save(d);
  broadcast();
  return item;
}

function get(id) { return load().items.find((m) => m.id === id) || null; }
function list({ status } = {}) {
  let items = load().items;
  if (status) items = items.filter((m) => m.status === status);
  return items;
}
function active() { return list({ status: 'active' }); }

function setStatus(id, status, note) {
  if (!STATUSES.includes(status)) throw new Error(`invalid status ${status}`);
  const d = load();
  const m = d.items.find((x) => x.id === id);
  if (!m) return null;
  m.status = status;
  m.updatedAt = Date.now();
  // Activation (from pending confirm or unpause) arms the review clock.
  if (status === 'active' && !m.nextReviewAt) m.nextReviewAt = Date.now() + m.reviewCadenceDays * 86400e3;
  if (status !== 'active') m.nextReviewAt = null;
  m.history.push({ at: Date.now(), action: 'status', status, note: note || null });
  save(d);
  broadcast();
  return m;
}

function addProgress(id, note, refs = {}) {
  const d = load();
  const m = d.items.find((x) => x.id === id);
  if (!m) return null;
  m.progress.unshift({ at: Date.now(), note: String(note).slice(0, 500), ...refs });
  m.progress = m.progress.slice(0, PROGRESS_CAP);
  m.updatedAt = Date.now();
  save(d);
  broadcast();
  return m;
}

function update(id, fields) {
  const d = load();
  const m = d.items.find((x) => x.id === id);
  if (!m) return null;
  if (fields.title !== undefined) m.title = String(fields.title).trim().slice(0, 200) || m.title;
  if (fields.goal !== undefined) m.goal = String(fields.goal).trim().slice(0, 1000) || m.goal;
  if (fields.approach !== undefined) m.approach = fields.approach ? String(fields.approach).slice(0, 2000) : null;
  if (fields.reviewCadenceDays !== undefined) {
    m.reviewCadenceDays = Math.min(Math.max(Number(fields.reviewCadenceDays) || DEFAULT_CADENCE_DAYS, 1), 90);
  }
  m.updatedAt = Date.now();
  m.history.push({ at: Date.now(), action: 'edited' });
  save(d);
  broadcast();
  return m;
}

function remove(id) {
  const d = load();
  const i = d.items.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const [m] = d.items.splice(i, 1);
  save(d);
  broadcast();
  return m;
}

// ---------------------------------------------------------------------------
// Review sweep — the heartbeat is the ticker (same pattern as todo sweepDue).
// A due review surfaces (agenda + TG line) AND becomes the bundled AI review
// ritual: the heartbeat enqueues one 'mission-review' work item per returned
// row (platform-horst), executed by cognition's __mission_review__ step.
// Re-arm happens at sweep time so a silent week never double-fires, and an
// in-flight guard covers the rest: the sweep is the only caller, and a review
// already running for a mission is never started a second time.
// ---------------------------------------------------------------------------
function sweepReviews(now = Date.now()) {
  const d = load();
  const due = [];
  for (const m of d.items) {
    if (m.status !== 'active' || !m.nextReviewAt || m.nextReviewAt > now) continue;
    m.nextReviewAt = now + m.reviewCadenceDays * 86400e3;
    m.history.push({ at: now, action: 'review-due' });
    due.push(m);
  }
  if (due.length) { save(d); broadcast(); }
  return due;
}


// ---------------------------------------------------------------------------
// The review ritual — ONE call. Assess, log progress, propose follow-ups,
// raise questions. Pure judgment over gathered context: no tools (enforced by
// ai-tool-gate), and nothing here mutates mission status.
// ---------------------------------------------------------------------------
const inFlight = new Set();

function safeDirectives() {
  try { return deps.fmtDirectives?.() || 'None.'; } catch { return 'None.'; }
}

async function runReview(mission) {
  const id = typeof mission === 'string' ? mission : mission?.id;
  if (!id || inFlight.has(id)) return { skipped: 'already running' };
  const m = get(id);
  if (!m) return { skipped: 'mission gone' };
  if (m.status !== 'active') return { skipped: `mission is ${m.status}` };
  inFlight.add(id);
  try {
    return await reviewOnce(m);
  } finally {
    inFlight.delete(id);
  }
}

async function reviewOnce(m) {
  // Gathered deterministically (zero extra AI). The progress log already
  // carries what each earlier review found and raised, which is what the list
  // of spawned work items used to tell us.
  let brainText = '';
  try {
    brainText = (await horstBrain.assembleBrainContext({
      query: `${m.title} ${m.goal}`, parts: ['memory', 'todos', 'decisions'],
    })).text;
  } catch {}

  const result = await aiPromptFn('platform', deps.appsDir, {
    message: [
      'Mission under review (a standing goal the owner assigned or approved):',
      JSON.stringify({
        title: m.title, goal: m.goal, approach: m.approach,
        reviewCadenceDays: m.reviewCadenceDays, doubts: m.doubts,
        progress: (m.progress || []).slice(0, 10),
      }, null, 1),
      `Review it. Return ONLY JSON:
{"assessment": "2-3 plain sentences: where the mission stands and why",
 "progressNote": "one line for the mission's progress log",
 "health": "on-track"|"stalled"|"blocked"|"goal-reached",
 "tasks": [{"title": "one concrete next task", "why": "what it contributes"}],
 "questions": ["a question only the owner can answer — [] if none"],
 "doubts": []}
Rules: at most ${REVIEW_PROPOSAL_CAP} tasks, and only ones genuinely worth doing THIS review cycle — an empty list is a fine answer. Each becomes a todo the owner sees and decides on, so name the task, not the permission. "goal-reached" only when the goal as written is met.`,
    ].filter(Boolean).join('\n\n'),
    systemPrompt: `You are Horst, running the periodic review of one of your standing missions. Be honest about stagnation — a mission that spawned nothing and moved nothing is stalled, not on-track. Active user directives:\n${safeDirectives()}${brainText ? `\n\n${brainText}` : ''}`,
    // Mission judgment compounds across weeks — fable-tier per the model
    // policy, mapped to opus (G4: start at the ceiling when the stakes justify it).
    model: 'opus',
    expectJson: true,
    allowedTools: [],
    retries: 1,
  });
  const r = result?.json;
  if (!r || typeof r !== 'object') throw new Error('mission review returned no JSON');

  const health = ['on-track', 'stalled', 'blocked', 'goal-reached'].includes(r.health) ? r.health : 'on-track';
  const note = String(r.progressNote || r.assessment || 'reviewed').slice(0, 300);
  try { addProgress(m.id, `review (${health}): ${note}`); } catch {}

  // Follow-ups go to the owner, not to a queue: one todo.create request per
  // task, through requestAction so the owner's dial for that kind decides
  // whether it executes, stages as a card, or is merely observed. checkFirst
  // lets governance suppress one it has already answered — that is the dedup
  // the work stack used to do with useCase+dedupeKey.
  const proposed = [];
  for (const t of (Array.isArray(r.tasks) ? r.tasks : []).slice(0, REVIEW_PROPOSAL_CAP)) {
    if (!t || !t.title) continue;
    try {
      const res = await deps.governance?.requestAction('todo.create', {
        title: String(t.title).slice(0, 120),
        notes: `Mission "${m.title}": ${String(t.why || m.goal).slice(0, 300)}`,
      }, {
        origin: 'mission',
        dedupeKey: `mission:${m.id}:${String(t.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`,
        summary: `Todo from mission review: ${String(t.title).slice(0, 90)}`,
        checkFirst: true,
      });
      if (res && res.mode !== 'suppressed') proposed.push(String(t.title).slice(0, 120));
    } catch (err) { console.warn('[horst-missions] review follow-up failed:', err.message); }
  }

  // Surface: one digest line per review (G5), plus the owner's questions
  // (G3 — doubts are said out loud, never swallowed).
  const questions = [
    ...(Array.isArray(r.questions) ? r.questions : []),
    ...(Array.isArray(r.doubts) ? r.doubts : []),
  ].filter((q) => typeof q === 'string' && q.trim()).slice(0, 3);
  const lines = [`🎯 Mission review — ${m.title}: ${String(r.assessment || note).slice(0, 400)}`];
  if (proposed.length) lines.push(`Suggested ${proposed.length} follow-up(s) — they are waiting in Approvals.`);
  if (health === 'goal-reached') lines.push('Looks achieved — mark it Done in Horst > Directives if you agree.');
  for (const q of questions) lines.push(`❓ ${q.slice(0, 300)}`);
  try { deps.notify?.(lines.join('\n')); } catch {}
  try { deps.addObservation?.('mission-review', `${m.title}: ${health} — ${note.slice(0, 140)}`, { missionId: m.id, proposed }); } catch {}

  return { missionId: m.id, health, assessment: r.assessment || null, proposed, questions };
}

// ---------------------------------------------------------------------------
// Taster — one line for chat + briefing (fixed budget; the brain rule).
// ---------------------------------------------------------------------------
function taster() {
  const act = active();
  const blocked = list({ status: 'blocked' });
  if (!act.length && !blocked.length) return '';
  const fmt = (m) => `${m.title}${m.status === 'blocked' ? ' ⏸ blocked' : ''}`;
  const items = [...act, ...blocked].slice(0, 4).map(fmt).join(' | ');
  return `ACTIVE MISSIONS (your standing goals — keep them in mind, mission_list for detail): ${items}`;
}

// ---------------------------------------------------------------------------
// Seeds — the two standing missions (the former genetic +
// curation use cases). Seeded ACTIVE with the review clock armed: cognition
// is live, so the ritual can run them. Pausing/abandoning stays one click in
// the Directives view — visible, revocable autonomy (G6).
// ---------------------------------------------------------------------------
function seedStandingMissions() {
  const d = load();
  const now = Date.now();
  let dirty = false;
  if (!d.seeded) {
    const mk = (title, goal, approach) => {
      if (d.items.some((m) => m.title === title)) return;
      d.items.push({
        id: newId(), title, goal, approach, status: 'active', origin: 'seed',
        reviewCadenceDays: 7, nextReviewAt: now + 7 * 86400e3, progress: [], doubts: [], links: {},
        correlationId: `mission:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        createdAt: now, updatedAt: now,
        history: [{ at: now, action: 'created', status: 'active', note: 'seeded standing mission' }],
      });
      dirty = true;
    };
    mk('Memory curation',
       'Keep the memory store trustworthy: duplicates merged, contradictions resolved with the user, stale facts decayed.',
       'Weekly review of consolidation results, memory-conflict questions, and compaction stats.');
    mk('Self-review',
       'Notice repetition and friction: propose playbooks for repeated work, calibrations for repeated approvals, fixes for repeated doubts.',
       'Weekly pass over the journal, doubt ledger and decision ledger (the genetic use case).');
    d.seeded = true;
    dirty = true;
  }
  // One-time activation (2026-08): earlier installs seeded these 'paused until
  // cognition'; cognition shipped, so untouched seeds wake up. A seed the user
  // has since touched (any status change in its history) stays exactly as
  // they set it — activation is a migration, never an override.
  if (!d.cognitionActivated) {
    for (const m of d.items) {
      if (m.origin === 'seed' && m.status === 'paused' && !m.history.some((h) => h.action === 'status')) {
        m.status = 'active';
        m.nextReviewAt = now + m.reviewCadenceDays * 86400e3;
        m.updatedAt = now;
        m.history.push({ at: now, action: 'status', status: 'active', note: 'cognition shipped — standing mission activated' });
      }
    }
    d.cognitionActivated = true;
    dirty = true;
  }
  if (dirty) save(d);
}

// ---------------------------------------------------------------------------
// Brain registration — the goal brain: one taster line, pull tools for depth.
// ---------------------------------------------------------------------------
horstBrain.registerBrain({
  name: 'missions',
  order: 5, // goals lead the brain block — they frame everything below
  async taster() { return deps.dir ? taster() : ''; },
  tools: [
    {
      def: {
        name: 'mission_list', expose: 'platform',
        description: 'List Horst\'s missions (standing goals the user assigned or approved): status, goal, cadence, latest progress. Read-only — missions are created via the <horst-mission> marker (user assigns) or a mission.create proposal (Horst suggests).',
        inputSchema: { type: 'object', properties: {
          status: { type: 'string', description: 'Filter: active, pending, paused, blocked, done, abandoned. Default: all.' },
        } },
      },
      handler: async (args) => {
        if (!deps.dir) return { content: [{ type: 'text', text: 'Missions store not initialized.' }] };
        const rows = list({ status: args.status || undefined }).map((m) => ({
          id: m.id, title: m.title, goal: m.goal, status: m.status, origin: m.origin,
          reviewCadenceDays: m.reviewCadenceDays, latestProgress: m.progress[0] || null,
        }));
        return { content: [{ type: 'text', text: rows.length ? JSON.stringify(rows, null, 1) : 'No missions yet.' }] };
      },
    },
    {
      def: {
        name: 'mission_get', expose: 'platform',
        description: 'Full detail of one mission by id: goal, approach, progress log, doubts, links, history. Read-only.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      handler: async (args) => {
        const m = deps.dir ? get(args.id) : null;
        return { content: [{ type: 'text', text: m ? JSON.stringify(m, null, 1) : 'No such mission.' }] };
      },
    },
  ],
});

module.exports = {
  init, create, get, list, active, setStatus, addProgress, update, remove,
  sweepReviews, runReview, taster, STATUSES,
};
