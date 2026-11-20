// The daily model review (job horst:model-review → timer:model-review →
// run-action). Refreshes the text registry (core refreshModels) and the media
// catalog (model ids, shutdown dates, voices), then checks every configured
// default in model-defaults.js:
//
//   dead default   → ai:default-missing (notify → Telegram) + an ai.setDefault
//                    proposal when a candidate exists. Once per target+model:
//                    `.horst/model-review.json` remembers what was alerted, and
//                    forgets it when the target is healthy again.
//   shutdown ≤ 30d → one agenda observation per target+date (text: lifecycle
//                    'deprecated').
//   new models     → one agenda observation per run (registry scan `added` +
//                    newly discovered media ids).
//   every run      → a journal line.
//
// Calls keep working meanwhile: text defaults resolve through
// resolveModelForCall's substitution, media defaults fall back to the built-in
// default (ai-media.resolveMediaModel). A vendor listing that fails is reported
// and never read as "everything is gone". Skipped while Horst is paused.
// Observes and proposes only — the act is the owner-approved ai.setDefault.

const fs = require('fs');
const path = require('path');

const SOON_DAYS = 30;

let deps = {};
// { dir, getSettings(), addObservation(kind, summary, detail),
//   addJournal(kind, title, body), governance: { requestAction }, now?() }
function init(options) { deps = options || {}; }

const now = () => (deps.now ? deps.now() : Date.now());
const today = () => new Date(now()).toISOString().slice(0, 10);

function statePath() { return path.join(deps.dir, 'model-review.json'); }
function loadState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {}; } catch {}
  return { alerted: s.alerted || {}, soon: s.soon || {}, seenMedia: Array.isArray(s.seenMedia) ? s.seenMedia : null, lastRun: s.lastRun || null };
}
function saveState(s) {
  fs.mkdirSync(deps.dir, { recursive: true });
  fs.writeFileSync(statePath() + '.tmp', JSON.stringify(s, null, 2));
  fs.renameSync(statePath() + '.tmp', statePath());
}

// --- checks ------------------------------------------------------------------

function checkText() {
  const ai = require('../ai-service');
  const defaults = require('../model-defaults');
  const out = { dead: [], soon: [], ok: [], unchecked: [] };
  for (const t of defaults.TEXT_TARGETS) {
    const { model } = defaults.read(t.target);
    if (!model) continue; // '' = the platform default, reviewed as its own target
    const h = ai.textModelHealth(model, { accept: t.accept });
    if (h.ok === null) { out.unchecked.push(t.target); continue; }
    if (!h.ok) { out.dead.push({ target: t.target, label: t.label, model, reason: h.reason, candidate: h.candidate }); continue; }
    out.ok.push(t.target);
    if (h.lifecycle === 'deprecated') out.soon.push({ target: t.target, label: t.label, model, when: 'deprecated' });
  }
  return out;
}

function checkMedia() {
  const catalog = require('../media-catalog');
  const defaults = require('../model-defaults');
  const { models } = catalog.list();
  const day = today();
  const entryOf = (method, id) => models.find((m) => m.method === method && m.modelId === id) || null;
  // Why a model cannot serve as a default, or null. `explicit` (the owner set
  // it) also counts a missing credential; the built-in default without a key
  // is just an unconfigured vendor, not a dead model.
  const deadReason = (e, explicit) => {
    if (!e) return 'unknown';
    if (e.exists === false) return 'missing';
    if (e.shutdownDate && e.shutdownDate <= day) return 'retired';
    if (explicit && e.unusableReason === 'no-credential') return 'no-credential';
    return null;
  };
  // Candidate: the built-in default if alive, else that provider's adapter
  // default, else the newest usable listed model of the kind there, else any.
  const candidateFor = (method, provider) => {
    const live = models.filter((m) => m.method === method && m.usable && !deadReason(m, true));
    const b = live.find((m) => m.builtinDefault);
    const pd = live.find((m) => m.provider === provider && m.providerDefault);
    const same = live.filter((m) => m.provider === provider && !m.discovered);
    return (b || pd || same[same.length - 1] || live.find((m) => m.providerDefault) || live[0] || null);
  };
  const out = { dead: [], soon: [], ok: [], builtinGone: [] };
  for (const t of defaults.MEDIA_TARGETS) {
    const conf = defaults.read(t.target);
    const builtin = catalog.builtinDefault(t.method);
    const builtinEntry = entryOf(t.method, builtin.model);
    const builtinDead = deadReason(builtinEntry, false);
    if (builtinDead) out.builtinGone.push({ target: t.target, model: builtin.model, reason: builtinDead });
    const model = conf.model || builtin.model;
    const e = entryOf(t.method, model);
    const reason = conf.model ? deadReason(e, true) : builtinDead;
    if (reason) {
      const c = candidateFor(t.method, e ? e.provider : builtin.provider);
      out.dead.push({ target: t.target, label: t.label, model, reason, candidate: c && c.modelId !== model ? c.modelId : null });
      continue;
    }
    if (conf.voice && Array.isArray(e.voices) && !e.voices.some((v) => String(v.id).toLowerCase() === String(conf.voice).toLowerCase())) {
      out.dead.push({ target: t.target, label: t.label, model, voice: conf.voice, reason: 'voice-missing', candidate: model, candidateVoice: e.defaultVoice });
      continue;
    }
    out.ok.push(t.target);
    if (e.shutdownDate) {
      const days = (Date.parse(e.shutdownDate) - Date.parse(day)) / 864e5;
      if (days <= SOON_DAYS) out.soon.push({ target: t.target, label: t.label, model, when: e.shutdownDate });
    }
  }
  const discovered = models.filter((m) => m.discovered).map((m) => `${m.method}:${m.provider}:${m.modelId}`);
  return { ...out, discovered };
}

// --- the run -----------------------------------------------------------------

async function run() {
  if (deps.getSettings && deps.getSettings().paused) return { skipped: 'paused' };
  const { core } = require('../core-services');
  const mediaCatalog = require('../media-catalog');
  const aiService = require('../ai-service');
  const errors = [];

  // 1. Refresh. A provider that fails keeps its last known state.
  let text = null;
  if (typeof core.refreshModels === 'function') {
    try { text = await core.refreshModels(); } catch (err) { errors.push(`text registry: ${err.message}`); }
  }
  for (const [p, r] of Object.entries((text && text.scan) || {})) if (r && r.status === 'error') errors.push(`${p}: ${r.error}`);
  if (text && text.catalogError) errors.push(`models.dev: ${text.catalogError}`);
  let media = null;
  try { media = await mediaCatalog.refresh(); } catch (err) { errors.push(`media catalog: ${err.message}`); }
  for (const [k, r] of Object.entries((media && media.adapters) || {})) if (r.error) errors.push(`${k}: ${r.error}`);

  // 2. Check every default.
  const tx = checkText();
  const mx = checkMedia();
  const state = loadState();
  const dead = [...tx.dead, ...mx.dead];
  const alertKey = (d) => (d.voice ? `${d.model}#${d.voice}` : d.model);
  const alerted = [];

  // 3. Dead defaults: alert + propose, once per target and model.
  for (const d of dead) {
    if (state.alerted[d.target] === alertKey(d)) continue;
    aiService.notifyObservers({ type: 'default-missing', target: d.target, label: d.label, model: d.model, voice: d.voice, reason: d.reason, candidate: d.candidateVoice ? `${d.candidate} (voice ${d.candidateVoice})` : d.candidate });
    if (d.candidate && deps.governance) {
      const payload = { target: d.target, model: d.candidate, ...(d.candidateVoice ? { voice: d.candidateVoice } : {}) };
      try {
        await deps.governance.requestAction('ai.setDefault', payload, {
          origin: 'horst', source: `model-review:${d.target}`, dedupeKey: `ai-default:${d.target}:${alertKey(d)}`,
          summary: `${d.label}: ${d.voice ? `voice "${d.voice}" of ${d.model}` : `"${d.model}"`} is ${d.reason} — switch to ${d.candidate}${d.candidateVoice ? ` (voice ${d.candidateVoice})` : ''}`.slice(0, 200),
        });
      } catch (err) { errors.push(`proposal for ${d.target}: ${err.message}`); }
    }
    state.alerted[d.target] = alertKey(d);
    alerted.push(d.target);
  }
  for (const t of [...tx.ok, ...mx.ok]) delete state.alerted[t];

  // 4. Shutdowns ahead.
  const soon = [...tx.soon, ...mx.soon];
  for (const s of soon) {
    const key = `${s.model}@${s.when}`;
    if (state.soon[s.target] === key) continue;
    state.soon[s.target] = key;
    deps.addObservation?.('model-shutdown', s.when === 'deprecated'
      ? `${s.label}: ${s.model} is deprecated — pick its successor before it is retired`
      : `${s.label}: ${s.model} shuts down on ${s.when}`, { target: s.target, model: s.model, when: s.when });
  }
  for (const g of mx.builtinGone) {
    const key = `builtin:${g.model}`;
    if (state.soon[`${g.target}#builtin`] === key) continue;
    state.soon[`${g.target}#builtin`] = key;
    deps.addObservation?.('model-builtin-gone', `Built-in fallback ${g.model} (${g.target.slice(6)}) is ${g.reason} — media/adapters needs a new defaultModel`, { target: g.target, model: g.model });
  }

  // 5. New models. The first run only records what is there.
  const newText = Object.values((text && text.scan) || {}).flatMap((r) => (r && r.status === 'ok' && r.added) || []).map((a) => a.label || a.name);
  const newMedia = state.seenMedia ? mx.discovered.filter((k) => !state.seenMedia.includes(k)).map((k) => k.split(':').slice(2).join(':')) : [];
  state.seenMedia = mx.discovered;
  if (newText.length || newMedia.length) {
    deps.addObservation?.('models-new', `New models listed: ${[...newText, ...newMedia].slice(0, 12).join(', ')}`, { text: newText, media: newMedia });
  }

  // 6. Journal.
  state.lastRun = new Date(now()).toISOString();
  saveState(state);
  const lines = [
    `${tx.ok.length + mx.ok.length} default(s) fine, ${dead.length} gone${alerted.length ? ` (${alerted.length} newly alerted)` : ''}, ${soon.length} ending soon.`,
    ...dead.map((d) => `• ${d.label}: ${d.voice ? `voice ${d.voice} of ` : ''}${d.model} is ${d.reason}${d.candidate ? ` → proposed ${d.candidate}` : ''}`),
    ...(newText.length || newMedia.length ? [`New: ${[...newText, ...newMedia].join(', ')}`] : []),
    ...(tx.unchecked.length ? [`Text registry unavailable — ${tx.unchecked.length} text default(s) not checked.`] : []),
    ...(errors.length ? [`Listing errors (last known state kept): ${errors.join('; ')}`] : []),
  ];
  deps.addJournal?.('model-review', 'Model review', lines.join('\n'));
  return { ok: true, dead, soon, newModels: [...newText, ...newMedia], errors, alerted };
}

module.exports = { init, run, checkText, checkMedia, statePath, SOON_DAYS };
