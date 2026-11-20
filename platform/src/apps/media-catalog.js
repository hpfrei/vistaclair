// The media model catalog — what ai.tts / ai.transcribe / ai.image can be
// asked for, joined from three sources:
//   1. core's native-model list (core.listNativeModels — entries with usedBy),
//   2. the adapters (src/apps/media) — which vendor/method pairs are wired,
//   3. the live state the daily refresh writes (<APPS_DIR>/.media-catalog.json):
//      per adapter the model ids the vendor lists, shutdown dates, and voices.
// Plus the platform defaults (platform-settings `mediaDefaults`), set in
// Apps → Setup → AI Config. ai-media's resolver, the Setup picker,
// <vc-model-picker kind=…> and Horst's model review all read this one module.

const fs = require('fs');
const path = require('path');
const media = require('./media');
const { core } = require('./core-services');

function statePath() {
  return path.join(require('./app-manager').APPS_DIR, '.media-catalog.json');
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
    return { refreshedAt: s.refreshedAt || null, adapters: s.adapters || {}, voices: s.voices || {}, lastRefresh: s.lastRefresh || null };
  } catch {
    return { refreshedAt: null, adapters: {}, voices: {}, lastRefresh: null };
  }
}

function saveState(state) {
  const p = statePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(p + '.tmp', p);
}

// Catalog rows { method, provider, modelId, label, kind, price, description, discovered? }.
function rows(state = loadState()) {
  let native = null;
  if (typeof core.listNativeModels === 'function') {
    try { native = core.listNativeModels(); } catch { native = null; }
  }
  const out = [];
  if (Array.isArray(native)) {
    for (const m of native) {
      if (!media.METHOD_KIND[m.usedBy] || !media.adapter(m.usedBy, m.providerKey)) continue;
      out.push({ method: m.usedBy, provider: m.providerKey, modelId: m.modelId, label: m.label || m.modelId, kind: m.kind, price: m.price || null, description: m.description || '' });
    }
  }
  // Older host (no catalog accessor), or a wired vendor core does not list yet.
  for (const a of media.ADAPTERS) {
    if (out.some((r) => r.method === a.method && r.provider === a.provider)) continue;
    for (const id of a.seedModels) {
      out.push({ method: a.method, provider: a.provider, modelId: id, label: id, kind: media.METHOD_KIND[a.method], price: null, description: '' });
    }
  }
  // Live ids an adapter recognises as its own but the catalog does not name.
  for (const a of media.ADAPTERS) {
    const s = state.adapters[media.adapterKey(a)];
    if (!s || !Array.isArray(s.modelIds)) continue;
    for (const id of s.modelIds) {
      if (!a.classify(id) || out.some((r) => r.modelId === id)) continue;
      out.push({ method: a.method, provider: a.provider, modelId: id, label: id, kind: media.METHOD_KIND[a.method], price: null, description: '', discovered: true });
    }
  }
  return out;
}

// One row by id (optionally pinned to a provider); null when unknown.
function find(modelId, { method, provider } = {}, state) {
  return rows(state).find((r) => r.modelId === modelId && (!method || r.method === method) && (!provider || r.provider === provider)) || null;
}

// true / false / null (never checked, or the vendor offers no listing).
function existsAt(row, state = loadState()) {
  const a = media.adapter(row.method, row.provider);
  if (!a || !a.listModels) return null;
  const s = state.adapters[media.adapterKey(a)];
  if (!s || !Array.isArray(s.modelIds)) return null;
  return s.modelIds.includes(row.modelId);
}

function shutdownOf(row, state = loadState()) {
  const a = media.adapter(row.method, row.provider);
  const s = a && state.adapters[media.adapterKey(a)];
  return (s && s.shutdown && s.shutdown[row.modelId]) || null;
}

function voicesFor(row, state = loadState()) {
  const a = media.adapter(row.method, row.provider);
  if (!a || !a.voices) return null;
  const live = state.voices[`${row.provider}:${row.modelId}`] || state.voices[`${row.provider}:*`];
  return (Array.isArray(live) && live.length ? live : a.voices(row.modelId)).map((v) => ({ ...v }));
}

function hasKey(a) {
  try { return !!core.resolveProviderKey(a.keyProvider); } catch { return false; }
}

// The platform default per method: the configured values over the built-in
// default model (and that model's default voice).
function builtinDefault(method) {
  const a = media.builtinAdapter(method);
  const d = { model: a.defaultModel, provider: a.provider };
  if (a.defaultVoice) d.voice = a.defaultVoice(a.defaultModel);
  return d;
}
function configuredDefaults(method) {
  let all = {};
  try { all = require('./platform-settings').get('mediaDefaults') || {}; } catch {}
  const d = all[method];
  return d && typeof d === 'object' ? { ...d } : {};
}

// The public shape apps, the Setup card and Horst read.
function entryShape(row, state, defaultsByMethod) {
  const a = media.adapter(row.method, row.provider);
  const exists = existsAt(row, state);
  const key = hasKey(a);
  const unusableReason = !key ? 'no-credential' : exists === false ? 'missing' : null;
  const d = defaultsByMethod[row.method];
  const out = {
    name: row.modelId,
    modelId: row.modelId,
    label: row.label,
    description: row.description,
    method: row.method,
    kind: row.kind,
    provider: row.provider,
    providerLabel: a.label,
    price: row.price,
    discovered: !!row.discovered,
    exists,
    shutdownDate: shutdownOf(row, state),
    usable: !unusableReason,
    unusableReason,
    hasApiKey: key,
    builtinDefault: a.provider === media.BUILTIN_PROVIDER[row.method] && a.defaultModel === row.modelId,
    providerDefault: a.defaultModel === row.modelId,
    isDefault: !!d && d.model === row.modelId,
    params: a.describe(row.modelId),
  };
  if (row.method === 'ai.tts') {
    out.voices = voicesFor(row, state);
    out.defaultVoice = a.defaultVoice(row.modelId);
  }
  return out;
}

// { models, defaults } — `defaults` is the effective platform default per
// method ({ model, voice?, … }), `configured` what the owner set.
function list({ method, kind } = {}) {
  const state = loadState();
  const methods = Object.keys(media.METHOD_KIND).filter((m) => (!method || m === method) && (!kind || media.METHOD_KIND[m] === kind));
  const defaults = {};
  const configured = {};
  for (const m of methods) {
    configured[m] = configuredDefaults(m);
    defaults[m] = { ...builtinDefault(m), ...configured[m] };
  }
  const models = rows(state).filter((r) => methods.includes(r.method)).map((r) => entryShape(r, state, defaults));
  return { models, defaults, configured, refreshedAt: state.refreshedAt, lastRefresh: state.lastRefresh || null, refreshing: refreshing() };
}

// The daily refresh: each wired vendor's model listing and voice listing.
// A failed listing keeps that adapter's last known ids (never "all gone") and
// records the error. Returns { refreshedAt, adapters: { key: { ok, error, count } } },
// also kept as state.lastRefresh. Concurrent callers (the review, Setup's
// Refresh now) share one run; refreshing() tells a reloaded GUI one is going.
let inflight = null;
function refresh() {
  if (!inflight) inflight = runRefresh().finally(() => { inflight = null; });
  return inflight;
}
function refreshing() { return !!inflight; }

async function runRefresh() {
  const state = loadState();
  const memo = new Map();
  const summary = {};
  for (const a of media.ADAPTERS) {
    const k = media.adapterKey(a);
    if (!hasKey(a)) { summary[k] = { ok: false, skipped: 'no-credential' }; continue; }
    const key = core.resolveProviderKey(a.keyProvider);
    const prev = state.adapters[k] || {};
    if (a.listModels) {
      try {
        const { ids, shutdown } = await a.listModels(key, memo);
        state.adapters[k] = { ok: true, modelIds: ids, shutdown: shutdown || {}, checkedAt: new Date().toISOString() };
        summary[k] = { ok: true, count: ids.length };
      } catch (err) {
        state.adapters[k] = { ...prev, lastError: err.message, lastErrorAt: new Date().toISOString() };
        summary[k] = { ok: false, error: err.message };
      }
    } else {
      summary[k] = { ok: true, unchecked: true };
    }
    if (a.listVoices) {
      try {
        const voices = await a.listVoices(key, memo);
        if (voices.length) state.voices[`${a.provider}:*`] = voices;
      } catch (err) {
        summary[k] = { ...summary[k], voiceError: err.message };
      }
    }
  }
  state.refreshedAt = new Date().toISOString();
  state.lastRefresh = { refreshedAt: state.refreshedAt, adapters: summary };
  saveState(state);
  return state.lastRefresh;
}

module.exports = { rows, find, existsAt, shutdownOf, voicesFor, list, refresh, refreshing, builtinDefault, configuredDefaults, loadState, statePath };
