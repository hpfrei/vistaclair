// Plaintext, pro-wide settings store (non-secret). Mirrors platform-cron's
// JSON-on-disk pattern. Holds platform-level preferences such as the default
// model used for ai.prompt AI calls.
const fs = require('fs');
const path = require('path');

let appsDir = null;
let settings = {};

const DEFAULTS = {
  // Default model for ai.prompt calls when the caller omits a model.
  // Haiku out of the box (cheap, fast — suits memory operations).
  // UNDATED on purpose: the registry stores Anthropic ids without the date
  // suffix (core strips it — a dated snapshot is answered not_found), so a
  // dated default here would match no registry row. resolveModelForCall
  // repairs a stale dated value anyway, but the default should not need it.
  directModel: 'claude-haiku-4-5',

  // Platform defaults for the media calls, set in Setup → AI Config:
  // { 'ai.tts': { model, voice, format, speed, language, instructions },
  //   'ai.transcribe': { model, language }, 'ai.image': { model, aspectRatio, size },
  //   'ai.sfx': { model, format, durationSeconds, promptInfluence } }.
  // Empty = the built-in default per method (media/index.js BUILTIN_PROVIDER).
  // A call's own params always win; see ai-media.resolveMediaModel.
  mediaDefaults: {},

  // Model for memory AI passes (consolidation extract, recall distillation).
  // Deliberately DECOUPLED from directModel: the user may point directModel at
  // a heavyweight chat model, but memory work must stay cheap.
  memoryModel: 'haiku',

  // --- Memory system ---
  // Master kill switch for all memory maintenance jobs (consolidate/retention/compact/archive).
  memoryMaintenanceEnabled: true,
  // Consolidator: how many raw observations to fold per pass, and tick cadence.
  memoryConsolidateBatch: 200,
  memoryConsolidateSchedule: 'every 10 minutes',
  // Retention cadence + thresholds (expire / promote / prune; the long tier is never pruned).
  memoryDecaySchedule: '0 4 * * *',          // daily 04:00
  memoryShortTtlDays: 14,                     // a low-value 'short' fact never reinforced for this long is pruned
  memoryPromoteHitCount: 3,                   // reinforcements (re-observed / looked up) that promote short -> long
  memoryImportanceFloor: 0.3,                 // "low-value": extractor-assigned importance below this
  // Compaction cadence + thresholds.
  memoryCompactSchedule: '0 5 * * 0',         // weekly Sunday 05:00
  memoryCompactChurnThreshold: 50,            // skip unless >= this many facts changed since last compaction
  memoryDedupeCosine: 0.95,                   // facts at/above this cosine are merged (e5-calibrated: paraphrase ≈ 0.96, unrelated ≤ 0.80)
  // Ledger archival.
  memoryLedgerRetentionDays: 365,             // dead-lineage source rows older than this are cold-archived
  memoryArchiveSchedule: '0 6 1 * *',         // monthly, 1st at 06:00
  // Recall: result cap.
  memoryRecallLimit: 12,

  // --- Tasks engine (todos) ---
  // Snooze durations offered on nudge cards and todo UIs (Nm/Nh/Nd/Nw).
  // tasks-engine validates and falls back to this default on bad entries.
  todoSnoozePresets: ['1h', '1d', '1w'],
  // Reply-watch strict mode: match replies by References/In-Reply-To headers
  // ONLY — disables the thread-id fallback (flip on if watches misfire on
  // provider-grouped threads).
  todoWatchStrict: false,

  // --- App licensing (manifest auth.license; see app-license.js) ---
  // Backend is a provider slot (app-license.setProvider); the two settings
  // below only matter once a provider is installed.
  // Entitlement cache freshness (minutes). Also the worst-case latency for a
  // revocation/renewal to reach a running app (checked lazily per request).
  licenseCacheTtlMinutes: 30,
  // How long already-validated users keep access while the licence provider is
  // unreachable, measured from their last successful validation.
  licenseGraceHours: 72,

  // --- Cross-app change requests (app-change-requests.js) ---
  // How many hops a chain of change requests may take: 1 means a session opened
  // for a request may not request a third app. Clamped to 1..3 by the module.
  changeRequestMaxDepth: 1,

  // --- App→app dependency edges (app-deps.js) ---
  // 'warn': an app→app tool call without an approved edge is allowed, flagged
  // undeclared and recorded as observed. 'enforce': it is refused.
  appDepsEnforce: 'warn',

  // --- Artifact store (app-artifacts.js) ---
  // Unpinned artifacts older than this are collected by the daily gc.
  artifactRetentionDays: 30,
  // Per-producer cap on stored artifact bytes (distinct blobs); put refuses above it.
  artifactAppQuotaMB: 5120,
};

function configPath() {
  return path.join(appsDir, '.platform-settings.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8')) || {};
  } catch {
    return {};
  }
}

function save() {
  const dir = path.dirname(configPath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = configPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, configPath());
}

function init(dir) {
  appsDir = dir;
  settings = load();
}

function all() {
  return { ...DEFAULTS, ...settings };
}

function get(key) {
  return all()[key];
}

function set(key, value) {
  if (value === undefined || value === null || value === '') {
    delete settings[key];
  } else {
    settings[key] = value;
  }
  save();
  return all();
}

// User mandate: memory/email AI runs ONLY on haiku or deepseek — never
// opus/fable. Any other configured memoryModel clamps to haiku here, so no
// settings edit can put a heavyweight model on the memory path.
function memoryAiModel() {
  const m = String(get('memoryModel') || 'haiku');
  return /haiku|deepseek/i.test(m) ? m : 'haiku';
}

module.exports = { init, all, get, set, memoryAiModel, DEFAULTS };
