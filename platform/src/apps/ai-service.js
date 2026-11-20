// Headless AI for apps — aiPrompt (Claude sessions with app tools as an MCP
// sidecar, JSON repair, model fallback), the per-app spend ledger query, and
// the canonical provider/model shapes every picker reads. Backs the `ai`
// capability (ai.prompt / ai.models / ai.usage) and ctx.aiPrompt / ctx.aiUsage.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const appManager = require('./app-manager');
const platformSettings = require('./platform-settings');
const spendGate = require('./spend-gate');
const spendContext = require('./spend-context');
const spendLedger = require('./spend-ledger');
const spawnManager = require('./spawn-manager');
const appTools = require('./app-tools');
const { killWithTimeout } = require('../utils');
const { core } = require('./core-services');
const readScopeLib = require('./ai-read-scope');

const { getToolsForApp, getPlatformToolUnion, mintToolToken, revokeToolToken } = appTools;

const CLAUDE_AUTH_ERROR_RE = /not logged in|authentication failed|session has expired|please run.*claude login|invalid.*credentials|could not authenticate|oauth.*token.*expired|unauthorized|401.*auth|auth.*error|re-?authenticate/i;

// A model the CLI/API refuses: retired, renamed, never existed, or not available
// to this account. Two DIFFERENT shapes in the wild (both verified against the
// CLI, both exit 1):
//   unknown id      → stderr: [claude-code:unrecognized_model] {"model":…}
//   retired snapshot→ stdout: "There's an issue with the selected model (X)",
//                      stderr: deprecation prose, NO marker
// So callers must test stdout AND stderr — a stderr-only check silently misses
// the retired case, which is the one that happens on its own over time.
const MODEL_UNAVAILABLE_RE = /\[claude-code:unrecognized_model\]|there.s an issue with the selected model|unrecognized_model|not_found_error|model[^\n]{0,60}?(?:not found|does not exist|is deprecated|was retired|no longer available)/i;
function isModelUnavailable(text) { return MODEL_UNAVAILABLE_RE.test(text || ''); }

// De-dupe stale-model substitution notifications per (appName, deadModel).
const _staleModelNotified = new Set();

// Canonical provider identity — the single source of truth for how a provider is
// labelled and where it sorts. Every model-picking surface (the in-iframe
// <vc-model-picker>, the host modal picker in app-model-picker.js, and the AI
// Config tab in apps.js) reads `providerLabel`/`providerRank` off the `ai.models`
// payload instead of keeping its own copy of this map.
const PROVIDERS = [
  ['anthropic', 'Anthropic (Claude)'],
  ['openai', 'OpenAI'],
  ['google', 'Google (Gemini)'],
  ['deepseek', 'DeepSeek'],
  ['moonshot', 'Moonshot (Kimi)'],
  ['custom', 'Custom'],
];
const PROVIDER_LABELS = new Map(PROVIDERS);
const PROVIDER_RANK = new Map(PROVIDERS.map(([key], i) => [key, i]));

function providerLabel(key) {
  return PROVIDER_LABELS.get(key) || key;
}

// Unknown providers sort after every known one; ties there are broken by key so
// the order stays stable instead of following registry insertion order.
function providerRank(key) {
  const r = PROVIDER_RANK.get(key);
  return r == null ? PROVIDERS.length : r;
}

// Order a public-shape model list by provider, preserving the registry's curated
// order within each provider (Array#sort is stable).
function sortModelsByProvider(models) {
  return models.slice().sort((a, b) =>
    (a.providerRank - b.providerRank) || a.provider.localeCompare(b.provider));
}

// Project a resolved registry model into the secrets-free shape apps receive.
//
// `usable` is the capability: can this model be called right now. It comes from
// core's credential join (listModelsWithAvailability) and is the ONLY thing a
// picker or filter may gate on. `hasApiKey` stays because it is a true statement
// about the secrets store — the Models page needs it — but it is not a
// capability: every Anthropic model routes through the `claude` CLI and is
// callable on an OAuth login with no stored key at all.
//
// `unusableReason` ('retired' | 'disabled' | 'no-credential') lets a picker grey
// an entry out with a reason instead of silently omitting it.
function publicModelShape(m) {
  const provider = m.providerKey || 'custom';
  return {
    name: m.name,
    label: m.label || m.name,
    description: m.description || '',
    provider,
    providerLabel: providerLabel(provider),
    providerRank: providerRank(provider),
    modelId: m.modelId || '',
    reasoning: !!m.reasoning,
    disabled: !!m.disabled,
    lifecycle: m.lifecycle || 'current',
    contextWindow: m.contextWindow ?? null,
    maxOutputTokens: m.maxOutputTokens ?? null,
    inputCostPerMTok: m.inputCostPerMTok ?? null,
    outputCostPerMTok: m.outputCostPerMTok ?? null,
    hasApiKey: !!m.apiKey,
    usable: !!m.usable,
    unusableReason: m.unusableReason || null,
    credential: m.credential || null,
  };
}

// The registry with core's credential join applied. Older hosts have no
// listModelsWithAvailability on the ctx; fall back to the plain registry so Pro
// still loads, accepting that Anthropic-on-subscription looks keyless there.
function listModelsResolved() {
  try {
    if (typeof core.listModelsWithAvailability === 'function') {
      return core.listModelsWithAvailability() || [];
    }
    return (core.listModels() || []).map((m) => {
      const cred = m.apiKey ? 'api-key' : null;
      let reason = null;
      if ((m.lifecycle || 'current') === 'retired') reason = 'retired';
      else if (m.disabled) reason = 'disabled';
      else if (!cred) reason = 'no-credential';
      return { ...m, usable: reason === null, unusableReason: reason, credential: reason === null ? cred : null };
    });
  } catch { return []; }
}

// Claude family names the CLI accepts as a bare alias (core's
// CLI_MODEL_ALIASES) — a request for one of these means "the newest current
// model of that family", never "whatever the registry lists first".
const CLAUDE_TIERS = 'opus|sonnet|haiku|fable|mythos';

// The ref a spawned CLI should actually be given. Anthropic models route by
// their undated family name, and the registry's dated snapshot ids go stale
// (a wrong date is a hard not_found from the API), so prefer the name there;
// every other provider routes by its modelId.
function routableRef(m) {
  if (!m) return null;
  if (m.providerKey === 'anthropic' && m.name) return m.name;
  return m.modelId || m.name;
}

// The lookup / routability / same-family substitution that model resolution is
// made of. resolveModelForCall routes a call with it; textModelHealth (the
// daily model review) judges a configured default with the same rules rather
// than a copy of them.
function registryView() {
  const models = (() => { try { return core.listModels() || []; } catch { return []; } })();
  const lookup = (ref) => (ref ? models.find((m) => m.name === ref) || models.find((m) => m.modelId === ref) || null : null);
  // ROUTING validity only — is this a real, live model id worth spawning. It is
  // deliberately NOT the payload's `usable`, which additionally requires a
  // credential: an explicitly requested model with no key should reach the
  // provider and fail with a real error, not be silently swapped for a
  // different model (and a different price) behind the caller's back. The
  // credential question is answered once, at spawn time, by core's resolveAuth.
  const routable = (m) => !!m && (m.lifecycle || 'current') !== 'retired' && !m.disabled;
  const current = models.filter((m) => (m.lifecycle || 'current') === 'current' && !m.disabled);

  // Newest current model for a ref: by Claude tier first ("haiku",
  // "claude-haiku-4-5" and "claude-haiku-4-5-20251001" all pick the newest
  // haiku), else the newest model of the same provider.
  const substituteFor = (ref, found) => {
    const bareTier = new RegExp(`^(${CLAUDE_TIERS})$`, 'i').exec(ref || '');
    const claudeTier = bareTier || new RegExp(`claude-(${CLAUDE_TIERS})`, 'i').exec(ref || '');
    let sub = null;
    if (claudeTier) {
      const tier = claudeTier[1].toLowerCase();
      sub = current
        .filter((m) => m.providerKey === 'anthropic' && new RegExp(`claude-${tier}`, 'i').test(m.name))
        .sort((a, b) => b.name.localeCompare(a.name))[0];
    }
    if (!sub && found && found.providerKey) {
      sub = current
        .filter((m) => m.providerKey === found.providerKey)
        .sort((a, b) => b.name.localeCompare(a.name))[0];
    }
    return { sub, bare: !!bareTier };
  };
  return { models, lookup, routable, current, substituteFor };
}

// Resolve the model an ai.prompt call should actually run against. Returns the
// resolved registry model object (with apiKey etc.), the routable `ref` a CLI
// spawn should use, plus a substitution flag. Accepts bare tier aliases
// ("haiku", "sonnet", "opus", "fable") and silently resolves them. Genuinely
// retired/missing models substitute with an info-level toast.
function resolveModelForCall(appName, requested) {
  const { lookup, routable, current, substituteFor } = registryView();
  const defaultRef = platformSettings.get('directModel');
  const shape = (m, substituted) => ({ model: m, name: m.name, modelId: m.modelId || m.name, ref: routableRef(m), substituted });

  // Caller omitted a model → the platform default. The stored default is NOT
  // trusted verbatim: it may be a dated snapshot ("claude-haiku-4-5-20251001")
  // while the registry keeps Anthropic ids undated, so passing it through blind
  // spawns an id the API answers not_found to. Resolve it like any other ref,
  // and silently — the caller asked for nothing, so there is nothing to report.
  if (!requested) {
    const def = lookup(defaultRef);
    if (routable(def)) return shape(def, false);
    const { sub } = substituteFor(defaultRef, def);
    const pick = sub || current[0] || null;
    return pick
      ? shape(pick, false)
      : { model: null, name: defaultRef || null, modelId: defaultRef || null, ref: defaultRef || null, substituted: false };
  }

  const found = lookup(requested);
  if (routable(found)) return shape(found, false);

  const { sub: tierSub, bare } = substituteFor(requested, found);
  const sub = tierSub || lookup(defaultRef) || current[0] || null;
  if (sub) {
    // Bare alias → silent resolution (not a problem, just a shorthand)
    if (bare) return shape(sub, true);
    notifyStaleModel(appName, requested, sub.name);
    return shape(sub, true);
  }
  // No registry/substitute available — pass the requested value through untouched.
  return { model: null, name: requested, modelId: requested, ref: requested, substituted: false };
}

// Is a configured text-model ref still callable? → { ok, model?, reason?,
// candidate?, lifecycle? }. A bare tier ("haiku") is ok while a usable model of
// its family exists. Dead = 'unknown' | 'retired' | 'disabled' | 'no-credential';
// `candidate` is what resolution would substitute, if that one is usable.
// `accept(model)` narrows candidates (memoryModel: haiku/deepseek only). An
// empty registry (core unreachable) answers { ok: null } — never "all dead".
// The credential join is only trusted when the host has it: the plain-registry
// fallback makes Anthropic-on-subscription look keyless.
function textModelHealth(ref, { accept = () => true } = {}) {
  const v = registryView();
  if (!v.models.length) return { ok: null, reason: 'no-registry' };
  const joined = typeof core.listModelsWithAvailability === 'function';
  const resolved = new Map(listModelsResolved().map((m) => [m.name, m]));
  const usable = (m) => !!m && v.routable(m) && (!joined || resolved.get(m.name)?.usable !== false);
  const found = v.lookup(ref);
  const { sub, bare } = v.substituteFor(ref, found);
  if (usable(found)) return { ok: true, model: found.name, lifecycle: found.lifecycle || 'current' };
  if (!found && bare && usable(sub)) return { ok: true, model: sub.name, alias: true, lifecycle: 'current' };
  let reason = 'unknown';
  if (found) {
    if ((found.lifecycle || 'current') === 'retired') reason = 'retired';
    else if (found.disabled) reason = 'disabled';
    else reason = resolved.get(found.name)?.unusableReason || 'no-credential';
  }
  const fallback = v.current.filter((m) => usable(m) && accept(m) && (!found || m.providerKey === found.providerKey))
    .sort((a, b) => b.name.localeCompare(a.name))[0];
  const candidate = (usable(sub) && accept(sub) ? sub : fallback) || null;
  return { ok: false, reason, candidate: candidate ? candidate.name : null };
}

// The `--model` value a spawn should actually be given, and the ONE place any
// caller resolves a model — so an omitted model and a named one follow the same
// rules everywhere. Never returns the caller's raw string: a dated Anthropic
// snapshot id is not routable (routableRef normalises it). undefined when
// nothing resolves at all, which makes buildClaudeArgs omit --model and leaves
// the CLI its own default rather than spawning a known-dead id.
function cliModelFor(appName, requested) {
  return resolveModelForCall(appName, requested).ref || undefined;
}

// observe(fn(event)) — AI call outcomes for the platform's senses:
//   { type: 'failed', app, model, code, auth, error }   a call's process exited non-zero
//   { type: 'substituted', app, deadModel, replacement } a stale model was mapped
//   { type: 'unavailable', app, method, model, reason } a call named a model that
//       is unknown, of the wrong kind, or gone at the vendor — no substitute ran
//   { type: 'default-missing', target, model, candidate } the daily model review
//       found a configured default dead (agent/horst-model-review.js)
// Returns an unsubscribe function.
const observers = [];
function observe(fn) {
  observers.push(fn);
  return () => { const i = observers.indexOf(fn); if (i >= 0) observers.splice(i, 1); };
}
function notifyObservers(event) {
  for (const fn of observers) { try { fn(event); } catch (err) { console.warn('[ai] observer failed:', err.message); } }
}

function notifyStaleModel(appName, deadModel, replacement) {
  const key = `${appName}::${deadModel}`;
  if (_staleModelNotified.has(key)) return;
  _staleModelNotified.add(key);
  notifyObservers({ type: 'substituted', app: appName, deadModel, replacement });
  if (!core.broadcaster) return;
  core.broadcaster.broadcast({
    type: 'toast:push',
    sender: 'Vistaclair',
    level: 'info',
    title: 'Model substituted',
    message: `App "${appName}" requested "${deadModel}" → using "${replacement}". `
      + `Update the app's ai.prompt() call or use pickModel() for automatic resolution.`,
    ts: Date.now(),
  });
}

// One alert per (app, method, model) per process: a text or media call named a
// model that cannot run and nothing was substituted. Keeping it current is the
// app's job; this tells the owner (ai:model-unavailable → Telegram).
const _unavailableNotified = new Set();
function notifyModelUnavailable(appName, method, model, reason) {
  const key = `${appName}::${method}::${model}`;
  if (_unavailableNotified.has(key)) return;
  _unavailableNotified.add(key);
  notifyObservers({ type: 'unavailable', app: appName, method, model: model || null, reason: reason || 'gone' });
}

// ai.models payload: the model registry in the shape every picker consumes,
// provider-grouped so no surface has to re-sort.
// The bare Anthropic tier names ("opus", "sonnet", …) that are worth offering as
// selectable values, derived from the registry rather than hardcoded: a tier is
// listed only when a usable model of that family exists, so an offered alias can
// never fail to resolve. Deliberately NOT core's full CLI_MODEL_ALIASES —
// 'default', 'best' and 'opusplan' are `claude --model` concepts that
// resolveModelForCall cannot map to a registry entry.
//
// These matter because the platform recommends bare tiers (they auto-update as
// new versions ship) while the picker could previously only offer dated registry
// names — so opening a picker on an app whose value was 'sonnet' and choosing
// anything silently converted an auto-updating alias into a pinned snapshot.
function tierAliases(models) {
  const out = [];
  for (const tier of CLAUDE_TIERS.split('|')) {
    const newest = models
      .filter((m) => m.provider === 'anthropic' && m.usable && new RegExp(`claude-${tier}`, 'i').test(m.name))
      .sort((a, b) => b.name.localeCompare(a.name))[0];
    if (!newest) continue;
    out.push({
      value: tier,
      label: `${tier.charAt(0).toUpperCase()}${tier.slice(1)} (latest)`,
      description: `Always the newest current ${tier} — resolves to ${newest.name} today`,
      resolvesTo: newest.name,
    });
  }
  return out;
}

function modelsPayload(params) {
  const p = params || {};
  let models = listModelsResolved().map(publicModelShape);
  if (p.provider) models = models.filter((m) => m.provider === p.provider);
  // `usable`, never `hasApiKey`: key presence is a storage fact, not a
  // capability. Gating on it deleted every Anthropic model from every picker on
  // any install authenticated by a CLI login rather than a pasted key.
  if (p.configuredOnly) models = models.filter((m) => m.usable);
  // The owner's choice alone: every model the Models page has enabled and that
  // is not retired, whatever the credential state — between `configuredOnly`
  // and the full catalog. Retired models are forced `disabled` by core, so the
  // lifecycle test is belt and braces.
  if (p.enabledOnly) models = models.filter((m) => !m.disabled && m.lifecycle !== 'retired');
  return {
    models: sortModelsByProvider(models),
    aliases: tierAliases(models),
    default: platformSettings.get('directModel'),
  };
}

// --- JSON extraction & repair for aiPrompt expectJson ---

function extractJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.substring(start, i + 1); }
  }
  return text.substring(start);
}

function repairTruncatedJson(text) {
  let inString = false, escaped = false;
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('{');
    else if (ch === '[') stack.push('[');
    else if (ch === '}') { if (stack.length && stack[stack.length - 1] === '{') stack.pop(); }
    else if (ch === ']') { if (stack.length && stack[stack.length - 1] === '[') stack.pop(); }
  }
  if (stack.length === 0) return null;
  let repaired = text;
  if (inString) { repaired = repaired.replace(/\\$/, '') + '"'; }
  repaired = repaired.replace(/,\s*$/, '');
  repaired = repaired.replace(/:\s*$/, ': null');
  while (stack.length) { const open = stack.pop(); repaired += open === '{' ? '}' : ']'; }
  return repaired;
}

function parseAIJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?\s*/gi, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const jsonStr = extractJsonObject(cleaned);
  if (jsonStr) {
    try { return JSON.parse(jsonStr); } catch {}
    const repaired = repairTruncatedJson(jsonStr);
    if (repaired) try { return JSON.parse(repaired); } catch {}
  }
  const jsonFromOriginal = extractJsonObject(text);
  if (jsonFromOriginal && jsonFromOriginal !== jsonStr) {
    try { return JSON.parse(jsonFromOriginal); } catch {}
    const repaired2 = repairTruncatedJson(jsonFromOriginal);
    if (repaired2) try { return JSON.parse(repaired2); } catch {}
  }
  return null;
}

const JSON_REPAIR_SYSTEM_PROMPT = `You are a JSON repair tool. The user will give you text that contains a JSON object that may be malformed, truncated, or wrapped in extra text. Extract and repair it into valid JSON. Rules:
- If the JSON is truncated (unclosed braces/brackets/strings), close them logically based on context
- If there is text before or after the JSON, strip it
- If strings are cut off mid-sentence, complete the sentence briefly then close
- For truncated arrays, close with what exists
- Preserve all existing data faithfully
- Return ONLY the repaired valid JSON, nothing else`;

// The AI CLI child must not inherit the platform's auth tokens: spawnClaude
// builds its env as { ...process.env, ...extraEnv } and child_process drops
// undefined values, so these two are removed and everything else (the CLI's
// own login, PATH, HOME) is kept.
const CHILD_ENV_STRIP = Object.freeze({ AUTH_TOKEN: undefined, VISTACLAIR_AUTH_TOKEN: undefined });

function aiRepairJson(appName, appDir, rawText, authMode, instanceId) {
  return new Promise((resolve) => {
    const repairArgs = core.buildClaudeArgs(
      { systemPrompt: JSON_REPAIR_SYSTEM_PROMPT },
      { skipTools: true, outputFormat: 'text' }
    );
    repairArgs.push('--dangerously-skip-permissions');
    // A headless run in the app directory must not inherit the app sessions'
    // standing rules (`<appsDir>/CLAUDE.md`, meant for the interactive tabs):
    // `user` keeps the owner's settings and drops every project-level file.
    repairArgs.push('--setting-sources', 'user');

    const proc = core.spawnClaude(repairArgs, {
      cwd: appDir,
      proxyPort: core.proxyPort,
      // Reuse the parent ai.prompt call's instanceId so the repair turn lands
      // in the same inspector timeline instead of spawning a phantom tab.
      instanceId: instanceId || `${appName}-json-repair-${Date.now()}`,
      sourceContext: { appName, type: 'json-repair' },
      anthropicApiKey: core.resolveHeadlessAuth(authMode),
      extraEnv: CHILD_ENV_STRIP,
    });

    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    const timeout = setTimeout(() => killWithTimeout(proc), 120000);

    proc.on('exit', () => {
      clearTimeout(timeout);
      const json = parseAIJson(stdout.trim());
      resolve(json);
    });

    proc.stdin.write(rawText);
    proc.stdin.end();
  });
}

// Transient failures of the headless claude spawn: killed by signal, dropped
// connection, or exit codes 140-149 (proxy/network hiccups observed in the wild).
function isTransientAiError(err) {
  return /SIGTERM|SIGKILL|ECONNRESET|ECONNREFUSED|socket hang up|exit(?:ed with)? code 14\d\b/i.test(err?.message || '');
}

// aiPrompt with opt-in retry: params.retries (0-5, default 0) re-attempts on
// transient errors with a short linear backoff.
//
// Each call gets ONE instanceId (random suffix — concurrent calls from the same
// app must land in separate inspector tabs) registered as an inspector session
// for the whole call, so retries and JSON repair share a single timeline.
async function aiPrompt(appName, appDir, params) {
  // Validate identity params before any side effect (session registration,
  // token mint) so a bad call throws clean.
  const sessionTag = params?.sessionTag;
  if (sessionTag !== undefined && (typeof sessionTag !== 'string' || !sessionTag || sessionTag.length > 200)) {
    throw new Error('sessionTag must be a non-empty string of at most 200 chars');
  }
  const meterKey = params?.meterKey;
  if (meterKey !== undefined && (typeof meterKey !== 'string' || !meterKey || meterKey.length > 128 || meterKey.startsWith('_'))) {
    throw new Error('meterKey must be a non-empty string of at most 128 chars, not starting with "_"');
  }
  // Read scope: a grant with a file tool is bounded to readRoots (see
  // ai-read-scope.js); the effective grant may be narrower than the asked one.
  const readScope = readScopeLib.planReadScope({
    appName, appDir, appsDir: appManager.APPS_DIR,
    allowedTools: normalizeAllowedTools(params?.allowedTools), readRoots: params?.readRoots,
  });
  if (readScope.scoped && readScope.reason) console.warn(`[ai-read-scope] ${appName}: ${readScope.reason}`);
  const allowedTools = readScope.allowedTools;
  params = { ...params, allowedTools };
  const retries = Math.min(5, Math.max(0, Number(params?.retries) || 0));
  const instanceId = mintInstanceId(appName);
  openAiCall(appName, instanceId, { meterKey });
  const { sidecarTools, toolToken, gateFile } = prepareToolGate(appName, instanceId, allowedTools, sessionTag);
  let scopeFile = null;
  if (readScope.active) {
    try { scopeFile = readScopeLib.writeScopeFile(instanceId, readScope); } catch (err) {
      // No scope file, no file tools: never run a file tool unbounded.
      closeAiCall(appName, appDir, instanceId, { toolToken, gateFile });
      throw new Error(`could not write the read scope: ${err.message}`);
    }
  }
  readScope.file = scopeFile;

  try {
    let lastErr;
    let fellBack = false;
    let call = params;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await aiPromptOnce(appName, appDir, call, instanceId, sidecarTools, toolToken, readScope);
      } catch (err) {
        lastErr = err;
        // A dead model is not a transient failure — replaying the same id just
        // fails again — and it is not always knowable before the call (the
        // registry can lag a retirement). Fall back ONCE to the platform
        // default, announced through the same channel a stale-model
        // substitution uses. This is not one of the caller's `retries`.
        if (err?.code === 'model_unavailable' && !fellBack) {
          const fallback = cliModelFor(appName, undefined);
          if (fallback && fallback !== err.model) {
            fellBack = true;
            notifyStaleModel(appName, err.model || String(call?.model || 'default'), fallback);
            call = { ...call, model: fallback };
            attempt--;
            continue;
          }
        }
        // Dead and nothing (else) to fall back to: the app's model needs fixing.
        if (err?.code === 'model_unavailable') notifyModelUnavailable(appName, 'ai.prompt', err.model || call?.model || null, 'gone');
        if (attempt === retries || !isTransientAiError(err)) throw err;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastErr;
  } finally {
    closeAiCall(appName, appDir, instanceId, { toolToken, gateFile, scopeFile });
  }
}

// ---- Shared call plumbing ----

// One instanceId per call. The `app-<name>-ai-<hex>` shape is load-bearing:
// the ai-tool-gate and spend-guard proxy rules key on it.
function mintInstanceId(appName) {
  return `app-${appName}-ai-${crypto.randomBytes(4).toString('hex')}`;
}

// Spend gate: refuse before any side effect when the admin's policy says so
// (an `unlimited` policy returns immediately). The session is registered so
// the LLM cost the proxy reports lands on the calling principal. `sessionId`
// (optional UUID) pins the inspector timeline to a caller-chosen Claude session.
function openAiCall(appName, instanceId, { meterKey, sessionId } = {}) {
  spendGate.authorize(appName, 'ai.prompt', { via: 'ctx', meterKey });
  spendContext.registerInstance(instanceId, {
    app: appName,
    principal: spendContext.principal() || (meterKey ? `meter:${meterKey}` : null),
    subscribed: spendContext.subscribed(),
    origin: spendContext.origin() || 'unknown',
    meterKey: meterKey || null,
  });
  core.registerAiSession(instanceId, sessionId);
}

// allowedTools semantics (enforced, not advisory):
//   undefined/null → same as [] — a call gets no tools unless it asks for them.
//   []             → NO tools at all: no sidecar, and the ai-tool-gate proxy
//                    rule strips every tool from the API request (the CLI
//                    flags alone can't do this — the session runs with
//                    --dangerously-skip-permissions, which auto-approves all
//                    built-ins regardless of --allowedTools).
//   ['A', 'mcp…']  → exactly these, plus ToolSearch (withToolSearch): sidecar
//                    filtered to the granted app tools, token minted for those
//                    only, proxy strips the rest.
// Snapshots the tool set once per call (platform sessions get the union of all
// apps' platform-exposed tools) and mints one ephemeral sidecar token shared
// across retries. Caller must closeAiCall() on every exit path.
// The CLI defers tool schemas (the model sees names only and loads a schema
// through ToolSearch), so any non-empty grant also holds ToolSearch. It widens
// nothing: the gate strips every ungranted tool from the request, and
// ToolSearch can only load a schema the request still carries.
function withToolSearch(allowedTools) {
  return allowedTools.includes('ToolSearch') ? allowedTools : [...allowedTools, 'ToolSearch'];
}

// A missing allowedTools is an empty grant, never "ungated". Anything that is
// not an array (or undefined/null) is a caller bug: refuse rather than guess.
function normalizeAllowedTools(allowedTools) {
  if (allowedTools === undefined || allowedTools === null) return [];
  if (!Array.isArray(allowedTools)) throw new Error('allowedTools must be an array of tool names (omit it or pass [] for no tools)');
  return allowedTools;
}

function prepareToolGate(appName, instanceId, rawAllowedTools, sessionTag) {
  const allowedTools = normalizeAllowedTools(rawAllowedTools);
  const gated = true;
  const allowSet = new Set(allowedTools);
  // An owner chat turn (a bound Horst sessionTag) sees job tools' Horst view.
  const appToolDefs = appName === 'platform'
    ? getPlatformToolUnion({ horst: appTools.isHorstTurn(sessionTag) })
    : getToolsForApp(appName);
  let sidecarTools = appToolDefs.map((t) => ({
    name: `${t._ownerApp || appName}__${t.name}`,
    description: t.description,
    inputSchema: t.inputSchema,
    timeout: t.timeout,
    // Routing metadata for the tool token (stripped from the sidecar file):
    // the token, not name parsing, decides which app serves each call.
    ownerApp: t._ownerApp || appName,
    shortName: t.name,
  }));
  if (gated) {
    // The CLI-visible name of a sidecar tool is mcp__app-tools__<owner>__<tool>.
    // Wildcard suffix '*' matches by prefix (e.g. 'mcp__app-tools__*' = every
    // app tool) — mirrored by the ai-tool-gate proxy rule.
    const prefixes = allowedTools
      .filter((s) => typeof s === 'string' && s.endsWith('*'))
      .map((s) => s.slice(0, -1));
    sidecarTools = sidecarTools.filter((t) => {
      const full = `mcp__app-tools__${t.name}`;
      return allowSet.has(full) || prefixes.some((p) => full.startsWith(p));
    });
  }
  const toolToken = sidecarTools.length > 0
    ? mintToolToken(appName, instanceId, sidecarTools, sessionTag)
    : null;

  // Marker for the ai-tool-gate proxy rule (same channel as the sidecar file:
  // tmpdir keyed by instanceId, which is process-generated and path-safe).
  let gateFile = null;
  if (gated) {
    gateFile = path.join(require('os').tmpdir(), `vistaclair-ai-allowed-${instanceId}.json`);
    try {
      fs.writeFileSync(gateFile, JSON.stringify(
        allowedTools.length === 0 ? { none: true } : { tools: withToolSearch(allowedTools) },
      ));
    } catch (err) {
      // If the gate can't be written, fail closed rather than run ungated.
      core.unregisterAiSession(instanceId);
      if (toolToken) revokeToolToken(toolToken);
      throw new Error(`could not write tool gate: ${err.message}`);
    }
  }
  return { gated, sidecarTools, toolToken, gateFile };
}

// Meter on success AND failure — tokens were burned either way. Usage is in
// the InteractionStore synchronously during streaming, so the fold is reliable
// here; must run before core.unregisterAiSession. LLM cost is settled per
// request from the proxy's interaction:complete broadcast (spend-gate
// .settleInteraction, wired in src/apps/index.js). Hosts without that tap
// (headless runners) fold the session here.
function closeAiCall(appName, appDir, instanceId, { toolToken, gateFile, scopeFile } = {}) {
  if (!spendGate.tapActive()) {
    try { spendLedger.recordSession(appName, appDir, instanceId, spendContext.instanceInfo(instanceId) || {}); } catch {}
  }
  spendGate.clearMarker(instanceId);
  spendContext.unregisterInstance(instanceId);
  if (toolToken) revokeToolToken(toolToken);
  if (gateFile) { try { fs.unlinkSync(gateFile); } catch {} }
  if (scopeFile) { try { fs.unlinkSync(scopeFile); } catch {} }
  core.unregisterAiSession(instanceId);
}

// Write the app-tools MCP sidecar config for one call. The sidecar
// authenticates with the per-session ephemeral token — never the platform
// AUTH_TOKEN — so a session reading its own tmp files gains nothing.
// Returns { mcpConfigFile, cleanup } (both null/no-op when no tools).
function writeAppToolsMcp(appName, instanceId, sidecarTools, toolToken) {
  if (!sidecarTools || sidecarTools.length === 0) return { mcpConfigFile: null, cleanup: () => {} };
  const packageRoot = path.resolve(__dirname, '..', '..', '..');
  const dashboardPort = String(core.dashboardPort || process.env.DASHBOARD_PORT || '3457');
  const tmp = require('os').tmpdir();
  const toolsSidecarFile = path.join(tmp, `vistaclair-app-tools-${instanceId}.json`);
  // Strip routing metadata — the sidecar only needs name/description/schema/timeout.
  fs.writeFileSync(toolsSidecarFile, JSON.stringify(
    sidecarTools.map(({ ownerApp, shortName, ...t }) => t)
  ));
  const mcpConfig = {
    mcpServers: {
      'app-tools': {
        command: 'node',
        args: [path.join(packageRoot, 'lib', 'app-tools-server.js')],
        env: {
          VISTACLAIR_APP_TOOLS_FILE: toolsSidecarFile,
          VISTACLAIR_DASHBOARD_PORT: dashboardPort,
          VISTACLAIR_AUTH_TOKEN: toolToken,
          VISTACLAIR_INSTANCE_ID: instanceId,
          VISTACLAIR_APP_NAME: appName,
        },
      },
    },
  };
  const mcpConfigFile = path.join(tmp, `vistaclair-app-mcp-${instanceId}.json`);
  fs.writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig));
  const cleanup = () => {
    try { fs.unlinkSync(mcpConfigFile); } catch {}
    try { fs.unlinkSync(toolsSidecarFile); } catch {}
  };
  return { mcpConfigFile, cleanup };
}

// ctx.aiUsage — read the per-app spend ledger (see spend-ledger.js).
function aiUsageQuery(appName, appDir, params) {
  return spendLedger.query(appDir, params || {});
}

function aiPromptOnce(appName, appDir, params, instanceId, sidecarTools = [], toolToken = null, readScope = null) {
  return new Promise((resolve, reject) => {
    const message = params.message;
    if (!message) return reject(new Error('No message provided'));
    if (!core.spawnClaude || !core.buildClaudeArgs) {
      return reject(new Error('aiPrompt requires spawnClaude and buildClaudeArgs'));
    }

    const safetyPrompt = `You are an AI assistant for the "${appName}" app in vistaclair. You may ONLY modify files within this app's directory or return data for the app to use. Do NOT modify, read, or access any files outside this app's directory. Do NOT execute destructive system commands, access other apps, or alter system configuration.`;
    const fullSystemPrompt = params.systemPrompt
      ? `${safetyPrompt}\n\n${params.systemPrompt}`
      : safetyPrompt;

    // One resolution for named AND omitted models: omitted → the platform
    // default, named → its routable ref (never the caller's raw string).
    const cliModel = cliModelFor(appName, params.model);

    // Missing/null allowedTools = no tools (aiPrompt normalizes; direct callers too).
    const allowedTools = normalizeAllowedTools(params.allowedTools);

    const aiArgs = core.buildClaudeArgs(
      {
        systemPrompt: fullSystemPrompt,
        model: cliModel,
        // An empty array must NOT reach buildClaudeArgs as truthy — it means
        // "no tools", which is skipTools plus the ai-tool-gate proxy strip.
        allowedTools: allowedTools.length ? withToolSearch(allowedTools) : undefined,
      },
      { skipTools: !allowedTools.length, outputFormat: 'text' }
    );

    aiArgs.push('--dangerously-skip-permissions');
    // A headless run in the app directory must not inherit the app sessions'
    // standing rules (`<appsDir>/CLAUDE.md`, meant for the interactive tabs):
    // `user` keeps the owner's settings and drops every project-level file.
    aiArgs.push('--setting-sources', 'user');
    // Read scope: register only the granted built-ins and run the path hook
    // before every tool call. (`--tools ""` = none.)
    if (readScope?.scoped) {
      aiArgs.push('--tools', readScope.builtinTools.join(','));
      if (readScope.active && readScope.file) aiArgs.push('--settings', readScopeLib.hookSettingsJson(readScope.file));
    }

    const mcp = writeAppToolsMcp(appName, instanceId, sidecarTools, toolToken);
    if (mcp.mcpConfigFile) aiArgs.push('--mcp-config', mcp.mcpConfigFile);

    const aiProc = core.spawnClaude(aiArgs, {
      cwd: appDir,
      proxyPort: core.proxyPort,
      instanceId,
      sourceContext: { appName, type: 'ai-prompt' },
      anthropicApiKey: core.resolveHeadlessAuth(params.authMode),
      extraEnv: CHILD_ENV_STRIP,
    });

    const sid = spawnManager.nextId();
    spawnManager.track(sid, { proc: aiProc, appName });

    let stdout = '';
    let stderr = '';
    aiProc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    aiProc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const aiTimeout = setTimeout(() => killWithTimeout(aiProc), params.timeout || 600000);

    aiProc.on('exit', async (code) => {
      clearTimeout(aiTimeout);
      spawnManager.untrack(sid);
      mcp.cleanup();
      if (code !== 0) {
        const auth = CLAUDE_AUTH_ERROR_RE.test(stderr);
        // Both streams: the unrecognized-model marker lands on stderr, the
        // retired-model prose on stdout.
        const badModel = !auth && isModelUnavailable(`${stderr}\n${stdout}`);
        const err = auth
          ? new Error('Claude is not authenticated. Run "claude login" in a terminal to re-authenticate.')
          : badModel
            ? new Error(`Model "${cliModel || 'default'}" is unavailable (retired, renamed, or not available to this account).`)
            : new Error(`AI failed (code ${code}): ${stderr || 'unknown error'}`);
        if (badModel) { err.code = 'model_unavailable'; err.model = cliModel || null; }
        // Report the model that actually ran, not the one the caller asked for:
        // with an omitted model those differ.
        notifyObservers({ type: 'failed', app: appName, model: cliModel || params.model || null, code, auth, error: err.message });
        reject(err);
        return;
      }
      const text = stdout.trim();
      // A scoped run reports what it was held to (and why tools were removed).
      const scope = readScope?.scoped ? { readScope: readScopeLib.publicScope(readScope) } : {};
      if (!params.expectJson) {
        resolve({ text, instanceId, ...scope });
        return;
      }
      const json = parseAIJson(text);
      if (json !== null) {
        resolve({ text, json, instanceId, ...scope });
        return;
      }
      try {
        const repaired = await aiRepairJson(appName, appDir, text, params.authMode, instanceId);
        if (repaired !== null) {
          resolve({ text, json: repaired, instanceId, repaired: true, ...scope });
        } else {
          resolve({ text, json: null, instanceId, ...scope });
        }
      } catch {
        resolve({ text, json: null, instanceId, ...scope });
      }
    });

    aiProc.stdin.write(message);
    aiProc.stdin.end();
  });
}

module.exports = {
  aiPrompt, aiPromptOnce, normalizeAllowedTools, CHILD_ENV_STRIP, aiUsageQuery, parseAIJson, aiRepairJson, resolveModelForCall, textModelHealth, cliModelFor, notifyStaleModel, notifyModelUnavailable,
  isModelUnavailable, MODEL_UNAVAILABLE_RE,
  mintInstanceId, openAiCall, closeAiCall, prepareToolGate, writeAppToolsMcp,
  publicModelShape, sortModelsByProvider, providerLabel, providerRank, modelsPayload, listModelsResolved, CLAUDE_AUTH_ERROR_RE,
  observe, notifyObservers,
};
