// Horst's settings file (`.horst/settings.json`) as a leaf module: defaults,
// the docTypes sanitiser and the read/write pair, with no requires into the
// rest of Horst. platform-horst.js hosts it; capabilities/config.js reads and
// writes the configuration-shaped keys through it — a capability may not
// require platform-horst (the registry loads every module at require time,
// which platform-horst itself triggers: a load cycle), so the settings had to
// stop living there.
'use strict';

const fs = require('fs');
const path = require('path');

const SETTINGS_DEFAULTS = {
  chatModel: '',            // '' → platform default model
  briefingModel: 'sonnet',
  triageModel: 'haiku',
  // Directive analysis is compounding judgment: a bad standing order silently
  // biases every future prompt, and it runs a handful of times a year. G4 says
  // start at the ceiling when the stakes justify it.
  directiveModel: 'opus',
  briefingEnabled: true,
  briefingSchedule: '0 7 * * *',
  heartbeatSchedule: 'every 15 minutes',
  // Daily model review (agent/horst-model-review.js): refresh the text and
  // media model lists, check every configured default, alert on a dead one.
  modelReviewSchedule: '30 6 * * *',
  memoryEnabled: true,      // write <horst-remember> facts to platform memory
  memoryMaintenance: true,  // memory self-tending (consolidate/decay/compact/archive) — always off while paused
  // --- Phase 2: governance + email autopilot ---
  paused: false,            // kill switch: Horst stops acting on his own (chat + approvals still work)
  triageEnabled: true,
  triageWindowHours: 48,    // only mail newer than this enters the work queue
  triageBatch: 10,          // emails classified per heartbeat sweep
  autoDraftReplies: true,   // stage reply drafts (always propose-tier) for important needs-reply mail
  draftsPerSweep: 2,
  // --- v2 email intelligence (the ONE platform classifier) ---
  // (triageLabels retired 2026-08: the label vocabulary is the platform label
  //  store — email-engine listLabels() / ctx.email.labels.* — so the classifier
  //  and every app work from ONE list instead of a setting nobody wrote.)
  scanAttachments: true,    // Read-tool pass over PDFs/images/.ics on relevant mail
  mineFacts: true,          // contact + durable-fact mining into shared platform memory
  calendarProposals: true,  // stage calendar.create proposals for detected events
  // --- Spam verdict thresholds (the ONE spam policy knob) ---
  // deriveIntel maps spamScore → spamVerdict with these: >= spam (or category
  // 'spam') → 'spam'; >= suspect → 'suspect'; else 'clean'. Consumers render
  // the verdict — nobody re-compares raw scores against private numbers.
  spamThresholdSuspect: 30, // gates outward-facing acts (reply drafts, contact mining)
  spamThresholdSpam: 60,    // gates everything else (briefing, mining, calendar, attachments)
  spamRuleSuggestions: true, // repeated spam verdicts → email.rule.add proposals (sender + domain level)
  autoFileSpam: true,       // a fresh INBOX arrival judged spam is moved to the Spam folder (horst-triage fileSpam)
  // Event reminders to the control chat (agent/horst-reminders.js) — the
  // owner's own calendar, so not gated by `paused`.
  eventReminders: true,
  eventLeadMinutes: 15,     // how far ahead a timed event gets its reminder
  voiceReplies: true,       // TG: voice-initiated chat turns get a spoken reply back (the platform TTS default)
  // Stop staging a kind the owner keeps rejecting (weighted <40% over >=8
  // decisions). Never silent: an audit row per suppression, an agenda note and
  // one chat line a week. Off = ask anyway, however often you say no.
  proposerHealth: true,
  todosEnabled: true,       // todo nudges (heartbeat sweep) + briefing sections
  // Artifact filing: seeded doc-type vocabulary — the `horst.docTypes`
  // configuration (capabilities/config.js). A document that fits none stages
  // a config.set proposal; the editor is Settings › Configurations.
  docTypes: ['receipt', 'bill', 'contract', 'warranty', 'ticket', 'tax', 'medical', 'id', 'other'],
  // Per-AI-session cap on brain pull-tool calls (memory_search, todo_list, …).
  // Pro-side stand-in for the deferred proxy-level cap — enforcement lives in
  // horst-brain.js (cappedHandler); generous by design: it stops retrieval
  // loops, never normal use.
  brainToolCallCap: 30,
};

// docTypes arrive from the settings UI as a free-form list; keep the
// vocabulary sane: lowercase slugs, deduped, capped, 'other' always present
// as the classifier's fallback bucket (horst-artifacts prompts against it).
function sanitizeDocTypes(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const clean = [];
  for (const t of list) {
    const v = String(t || '').toLowerCase().trim().replace(/[^a-z0-9 _-]/g, '').slice(0, 64);
    if (v && !clean.includes(v)) clean.push(v);
    if (clean.length >= 24) break;
  }
  if (!clean.includes('other')) clean.push('other');
  return clean;
}

let _dir = null; // the .horst directory; null until platform-horst's init

function init({ dir }) { _dir = dir; }
function isReady() { return !!_dir; }

function settingsPath() {
  if (!_dir) throw new Error('horst settings not initialised');
  return path.join(_dir, 'settings.json');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// Before init the defaults are the settings — a reader never throws.
function get() { return { ...SETTINGS_DEFAULTS, ...(_dir ? readJson(settingsPath(), {}) : {}) }; }

function set(values) {
  const merged = { ...get(), ...values };
  // Only persist known keys — the settings file is not a junk drawer.
  const clean = {};
  for (const k of Object.keys(SETTINGS_DEFAULTS)) clean[k] = merged[k];
  writeJson(settingsPath(), clean);
  return clean;
}

module.exports = { SETTINGS_DEFAULTS, sanitizeDocTypes, init, isReady, get, set };
