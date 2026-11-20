// Master→slave sync of the host's API keys and model registry.
//
// Code, dependencies and per-app data already travel to a slave via publish;
// credentials did not. A published app calling ai.prompt / ai.transcribe /
// ai.image on a slave found no provider key and no model definitions, so the
// owner had to retype everything into every slave's Models page.
//
// The payload is the CORE's key bundle — the encrypted secrets store
// (providerKeys + modelKeys) PLUS models.json (providers + model definitions).
// Keys and their model definitions travel together because either alone is
// useless on the far side. Pro has no access to those files: the host injects
// `exportKeyBundle` / `importKeyBundle` through the add-on context (server.js,
// addon-host.js), same seam as `resolveProviderKey`.
//
//   master:  syncToPeer() → POST <slave>/api/peer/keys  (peer-token authed)
//   slave:   applyKeys()  → core importKeyBundle()
//
// Two rules the rest of this file exists to keep:
//   • Key VALUES never leave this module except inside the request body — no
//     logs, no broadcasts, no WS results, no persisted job records. Everything
//     the GUI sees is a redacted summary (provider names + counts).
//   • The bundle is cleartext JSON on the wire, so a plain-http:// slave is
//     refused outright (loopback excepted).
//
// GUI-reload resilience: in-flight syncs live in `syncing` and are broadcast as
// `app:peer:keysStatus` on every transition; the terminal outcome is persisted
// on the peer record in .peers.enc, so a reload mid-sync still shows the state.
const hostConfig = require('./host-config');
const pairing = require('./peer-pairing');
const peerClient = require('./peer-client');

let exportBundle = null;
let importBundle = null;
let broadcaster = null;

// peer name → { status: 'running'|'ok'|'error', replace, startedAt, finishedAt, summary, applied, error }
const syncing = new Map();

function init(options = {}) {
  exportBundle = typeof options.exportKeyBundle === 'function' ? options.exportKeyBundle : null;
  importBundle = typeof options.importKeyBundle === 'function' ? options.importKeyBundle : null;
  broadcaster = options.broadcaster || null;
}

// Redacted view of a bundle — the ONLY shape that reaches the GUI or a log.
function summarize(bundle) {
  return {
    providers: Object.keys(bundle.providerKeys || {}).sort(),
    modelKeys: Object.keys(bundle.modelKeys || {}).length,
    providerDefs: Object.keys(bundle.providers || {}).length,
    models: Array.isArray(bundle.models) ? bundle.models.length : 0,
  };
}

// What a sync would send from this master (confirm-dialog copy).
function preview() {
  if (hostConfig.isSlave()) throw new Error('This instance is a slave — sync keys from its master.');
  if (!exportBundle) throw new Error('this host build cannot read the key store');
  return summarize(exportBundle());
}

// The bundle is cleartext JSON on the wire. https:// or loopback only.
function assertSecureUrl(peer) {
  let url;
  try { url = new URL(peer.baseUrl); } catch { throw new Error(`slave "${peer.name}" has a malformed URL`); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error(`refusing to send API keys to "${peer.name}" over plain HTTP (${peer.baseUrl}) — put the slave behind HTTPS first`);
  }
}

function setState(name, patch) {
  const next = { ...(syncing.get(name) || {}), ...patch };
  syncing.set(name, next);
  try { broadcaster?.broadcast({ type: 'app:peer:keysStatus', peers: syncState() }); } catch {}
  return next;
}

function syncState() {
  return Object.fromEntries(syncing);
}

// ---------------------------------------------------------------------------
// Master side
// ---------------------------------------------------------------------------

// Push this master's keys + model registry to one linked slave. `replace: true`
// mirrors exactly (slave-only keys and models are dropped there); the default
// merge leaves slave-only entries alone.
async function syncToPeer(peerRef, { replace = false } = {}) {
  if (hostConfig.isSlave()) throw new Error('This instance is a slave — sync keys from its master.');
  if (!exportBundle) throw new Error('this host build cannot read the key store');
  const peer = pairing.getPeer(peerRef);
  if (!peer) throw new Error('unknown slave — link one first');
  if (syncing.get(peer.name)?.status === 'running') throw new Error('a key sync for this slave is already running');
  assertSecureUrl(peer);

  const bundle = exportBundle();
  const summary = summarize(bundle);
  if (!summary.providers.length && !summary.models && !summary.modelKeys) {
    throw new Error('nothing to sync — this master has no API keys or models configured');
  }

  setState(peer.name, { status: 'running', replace: !!replace, startedAt: Date.now(), finishedAt: null, summary, applied: null, error: null });
  try {
    const res = await peerClient.call(peer, '/keys', {
      method: 'POST',
      body: { ...bundle, replace: !!replace },
      timeoutMs: 60000,
    });
    const applied = {
      providerKeys: res?.providerKeys ?? 0,
      modelKeys: res?.modelKeys ?? 0,
      providers: res?.providers ?? 0,
      models: res?.models ?? 0,
      replaced: !!res?.replaced,
    };
    setState(peer.name, { status: 'ok', finishedAt: Date.now(), applied, error: null });
    pairing.updatePeer(peer.name, { keysSyncedAt: Date.now(), keysSyncedSummary: applied, keysSyncError: null });
    console.log(`  Peer: keys synced to "${peer.name}" (${applied.providerKeys} provider keys, ${applied.models} models${applied.replaced ? ', mirrored' : ''})`);
    return { ok: true, summary, applied, replace: !!replace };
  } catch (err) {
    setState(peer.name, { status: 'error', finishedAt: Date.now(), error: err.message });
    pairing.updatePeer(peer.name, { keysSyncError: err.message });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Slave side
// ---------------------------------------------------------------------------

// Apply a bundle pushed by the master. The caller (peer-server) has already
// authenticated the peer token. No restart is needed: the core re-reads
// secrets.enc / models.json per call, so the next ai.* call sees the new keys.
function canApply() {
  return !!importBundle;
}

function applyKeys(body) {
  if (!importBundle) throw new Error('this host build cannot write the key store');
  if (!body || typeof body !== 'object') throw new Error('bad bundle');
  const counts = importBundle({
    providerKeys: body.providerKeys,
    modelKeys: body.modelKeys,
    providers: body.providers,
    models: body.models,
  }, { replace: !!body.replace });
  console.log(`  Peer: key sync from master applied (${counts.providerKeys} provider keys, ${counts.modelKeys} model keys, ${counts.models} models${counts.replaced ? ', mirrored' : ''})`);
  return counts;
}

module.exports = { init, preview, syncToPeer, canApply, applyKeys, syncState };
