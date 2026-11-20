// Shared helpers for the Horst facet of capability modules (`horst.tools`
// handlers and `horst.kinds` validators). Dependency-free at load on purpose:
// a capability module may require this at top level (the artifact and spend
// modules are required lazily, inside the helpers that need them).

// Payload field check for kind validators — throws the same message the
// built-in governance kinds always threw.
function req(payload, field, type = 'string') {
  const v = payload[field];
  if (v == null || (type === 'string' && !String(v).trim())) throw new Error(`payload requires ${field}`);
  return v;
}

// MCP-shaped tool result. Objects are rendered as compact JSON (indent 1, the
// pack's existing convention); strings pass through.
function textResult(x) {
  const text = typeof x === 'string' ? x : JSON.stringify(x, null, 1);
  return { content: [{ type: 'text', text }] };
}

function emptyResult(message) {
  return textResult(message || 'Nothing found.');
}

// Clamp a caller-supplied limit into [1, max] with a default.
function limitOf(v, def, max) {
  return Math.min(Math.max(Number(v) || def, 1), max);
}

// ---- direct-lane tools: artifacts in and out ---------------------------------

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/opus': 'opus', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/wav': 'wav' };

// The bytes behind a `vc-artifact://` uri a tool was handed, read as the
// caller's principal (a Horst turn → owner; a run's session → its run). An
// unknown uri, one the caller may not read, or the wrong media type throws.
// → { buffer, mime, name, uri }
function readArtifact(uri, caller, { mime = null, what = 'file' } = {}) {
  const art = require('./app-artifacts');
  const view = art.get(uri);
  if (!view) throw new Error(`Unknown artifact "${uri}" — pass a vc-artifact:// uri from this conversation`);
  const who = art.principalOf(caller);
  if (!who || !art.canRead(who, uri)) throw new Error(`No read access to artifact ${view.uri}`);
  if (mime && !mime.test(String(view.mime || ''))) throw new Error(`${view.uri} is ${view.mime || 'of unknown type'}, not ${what}`);
  return { buffer: require('fs').readFileSync(art.blobPath(uri)), mime: view.mime, name: view.name, uri: view.uri };
}

// Bytes a direct tool produced → an owner artifact (producer { platform:
// 'horst', tool }), also granted to a caller that is not the owner (a run's
// session calling the platform pack). → its resource_link.
async function storeArtifact(buffer, { mime, name, tool, caller }) {
  const art = require('./app-artifacts');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const view = await art.putPlatform(buffer, { mime, name: name || `${tool}-${stamp}.${EXT[mime] || 'bin'}` }, { producer: { platform: 'horst', tool } });
  const who = art.principalOf(caller);
  if (who && who.type !== 'owner') art.grant(view.uri, who);
  return view.link;
}

// A refusal the model should read and relay, not a tool crash: the spend
// gate's codes (cap reached, revoked, paused, rate) come back as an isError
// result naming the code. Anything else still throws.
async function spendSafe(fn) {
  try { return await fn(); } catch (err) {
    if (!err || err.name !== 'SpendError') throw err;
    return { isError: true, content: [{ type: 'text', text: `Refused by the spend policy (${err.code}): ${err.message}` }] };
  }
}

module.exports = { req, textResult, emptyResult, limitOf, readArtifact, storeArtifact, spendSafe };
