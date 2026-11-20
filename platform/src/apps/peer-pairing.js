// Master↔slave pairing + peer registry.
//
// Pairing is slave-initiated: the slave generates a peer access token (what the
// master will use to control it) and a poll secret, POSTs both to the master's
// public /api/peer/register endpoint, and polls for the owner's decision. On
// the master the request becomes a Horst governance proposal (kind 'peer.pair',
// always human-approved — dashboard Approvals + Telegram card). Approval moves
// the request into the master's encrypted peer registry; from then on all
// control flows master → slave authenticated by the token. The slave keeps no
// master credentials — only the token HASH survives on the slave, and the raw
// token exists only inside the master's encrypted registry.
//
// Storage (both files under the *.enc gitignore rule, encrypted via secret-store):
//   APPS_DIR/.peers.enc  (master) { peers: [{id,name,baseUrl,token,pairedAt}],
//                                   requests: [{id,name,publicUrl,token,secretHash,…}] }
//   APPS_DIR/.peer.enc   (slave)  { tokenHash, pending: {id,secret,masterUrl,tokenHash}|null }
//                                 (tokenHash is set only once the owner approved; until then
//                                 the new token's hash waits in pending.tokenHash, inert)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const hostConfig = require('./host-config');
const security = require('./peer-security');

let appsDir = null;
let secretStore = null;
let broadcaster = null;

const POLL_INTERVAL_MS = 15 * 1000;
const REQUEST_TTL_MS = 7 * 24 * 3600 * 1000;
const VALID_PEER_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_PENDING_REQUESTS = 10;

let pollTimer = null;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function hashEquals(presented, storedHash) {
  if (!presented || !storedHash) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sha256(presented), 'hex'), Buffer.from(storedHash, 'hex'));
  } catch {
    return false;
  }
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

// --- Encrypted stores ---

function peersPath() { return path.join(appsDir, '.peers.enc'); }
function peerPath() { return path.join(appsDir, '.peer.enc'); }

function loadPeers() {
  const data = secretStore.readSecretFile(peersPath(), appsDir, { fallback: {} });
  // A peer linked over plain http:// (before https became mandatory) is kept
  // but flagged: nothing sends its token anywhere until the owner re-pairs it.
  const peers = (data.peers || []).map((p) => {
    const insecure = !security.isSecureUrl(p.baseUrl);
    if (insecure) return { ...p, needsRepair: true, repairReason: 'linked over plain http:// — re-pair the slave over https://' };
    const { needsRepair, repairReason, ...rest } = p;
    return rest;
  });
  return { peers, requests: data.requests || [] };
}

// Core's secret store sets 0600 only when it creates a file; an older or
// copied file keeps whatever mode it had. Tighten the files that hold peer
// secrets (and the key file beside them) after every write. Format and
// location are untouched: the master needs the raw peer tokens.
function tightenModes(...files) {
  for (const f of files) {
    try { if (fs.existsSync(f)) fs.chmodSync(f, 0o600); } catch {}
  }
}
const keyFilePath = () => path.join(appsDir, '.secrets_key');

function savePeers(data) {
  secretStore.writeSecretFile(peersPath(), data, appsDir);
  tightenModes(peersPath(), keyFilePath());
}

function loadSlaveState() {
  return secretStore.readSecretFile(peerPath(), appsDir, { fallback: {} });
}

function saveSlaveState(state) {
  secretStore.writeSecretFile(peerPath(), state, appsDir);
  tightenModes(peerPath(), keyFilePath());
}

// ---------------------------------------------------------------------------
// Slave side
// ---------------------------------------------------------------------------

// Verify a presented peer token against the slave's stored hash. Used by
// peer-server's auth middleware on every control request.
function verifyPeerToken(presented) {
  return hashEquals(presented, loadSlaveState().tokenHash);
}

function hasPeerToken() {
  return !!loadSlaveState().tokenHash;
}

// Turn this host into a slave and register with the master. Generates fresh
// secrets on every call, so re-running replaces any previous pairing attempt.
async function startPairing({ name, masterUrl, publicUrl }) {
  const slaveName = String(name || '').trim().toLowerCase();
  if (!VALID_PEER_NAME.test(slaveName)) throw new Error('Slave name must be a short lowercase slug (a-z, 0-9, -)');
  const master = String(masterUrl || '').trim().replace(/\/+$/, '');
  const pub = String(publicUrl || '').trim().replace(/\/+$/, '');
  security.assertSecureUrl(master, 'Master URL');
  const pubClean = security.cleanPublicUrl(pub);
  if (!pubClean) throw new Error('This server\'s public URL must be a plain https:// URL (http:// is accepted only for localhost)');

  const token = newToken();
  const secret = newToken();

  const res = await fetch(master + '/api/peer/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: slaveName, publicUrl: pubClean, token, pollSecret: secret }),
    signal: AbortSignal.timeout(15000),
    redirect: 'manual',
  }).catch((err) => { throw new Error(`Cannot reach master: ${err.message}`); });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok || !body?.id) {
    throw new Error(`Master rejected registration: ${body?.error || `HTTP ${res.status}`}`);
  }

  // The token is inert until the owner approves: only pending.tokenHash holds
  // it, so verifyPeerToken/hasPeerToken refuse it (a previous link is dropped
  // too — re-pairing replaces it, as before).
  saveSlaveState({ tokenHash: null, pending: { id: body.id, secret, masterUrl: master, tokenHash: sha256(token) } });
  hostConfig.setRole('slave');
  hostConfig.setSlave({ name: slaveName, masterUrl: master, publicUrl: pubClean, linkStatus: 'pending', registrationId: body.id, linkedAt: null });
  startPollLoop();
  broadcastSlaveStatus();
  return { id: body.id };
}

function stopPollLoop() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function startPollLoop() {
  stopPollLoop();
  const tick = async () => {
    pollTimer = null;
    const state = loadSlaveState();
    const pending = state.pending;
    if (!pending) return;
    if (!security.isSecureUrl(pending.masterUrl)) {
      // Started over plain http:// before the https rule: drop it.
      saveSlaveState({});
      hostConfig.setSlave({ linkStatus: 'needs-repair' });
      broadcastSlaveStatus();
      console.warn('  Peer: pending pairing used a plain-http master URL — cancelled, pair again over https://');
      return;
    }
    try {
      const res = await fetch(`${pending.masterUrl}/api/peer/register/${encodeURIComponent(pending.id)}/status`, {
        headers: { 'X-Vistaclair-Poll-Secret': pending.secret },
        signal: AbortSignal.timeout(15000),
        redirect: 'manual',
      });
      const body = await res.json().catch(() => null);
      const status = body?.status;
      if (status === 'approved') {
        // Linked. Drop the raw poll secret; only the token hash stays.
        saveSlaveState({ tokenHash: pending.tokenHash || state.tokenHash, pending: null });
        hostConfig.setSlave({ linkStatus: 'linked', linkedAt: Date.now() });
        broadcastSlaveStatus();
        console.log('  Peer: linked to master');
        return;
      }
      if (status === 'denied' || status === 'expired' || res.status === 404) {
        saveSlaveState({});
        hostConfig.setSlave({ linkStatus: status === 'denied' ? 'denied' : 'expired' });
        broadcastSlaveStatus();
        console.log(`  Peer: pairing ${status || 'rejected'} by master`);
        return;
      }
    } catch (err) {
      // Master unreachable — keep polling; the pending request expires on the
      // master after 7 days and the loop ends via the 'expired' branch above.
    }
    pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    if (pollTimer.unref) pollTimer.unref();
  };
  pollTimer = setTimeout(tick, 2000);
  if (pollTimer.unref) pollTimer.unref();
}

// Clear the slave link (does NOT change enabledApps or stop apps — it only
// severs the control channel and reverts the role).
function resetPairing() {
  stopPollLoop();
  saveSlaveState({});
  hostConfig.setSlave(null);
  hostConfig.setRole('master');
  broadcastSlaveStatus();
}

function slaveStatus() {
  return {
    role: hostConfig.role(),
    enabledApps: hostConfig.enabledApps(),
    slave: hostConfig.slaveInfo(),
    hasToken: hasPeerToken(),
    remoteSessions: hostConfig.remoteSessions(),
  };
}

function broadcastSlaveStatus() {
  try { broadcaster?.broadcast({ type: 'app:peer:slaveStatus', ...slaveStatus() }); } catch {}
}

// ---------------------------------------------------------------------------
// Master side
// ---------------------------------------------------------------------------

function pruneRequests(data) {
  const cutoff = Date.now() - REQUEST_TTL_MS;
  let changed = false;
  for (const r of data.requests) {
    if (r.status === 'pending' && r.createdAt < cutoff) { r.status = 'expired'; changed = true; }
  }
  const before = data.requests.length;
  data.requests = data.requests.filter((r) => r.status === 'pending' || (r.decidedAt || r.createdAt) > cutoff);
  return changed || data.requests.length !== before;
}

// Incoming registration from a slave (auth-exempt route; grants nothing by
// itself). Every call creates its OWN pending request: a registration never
// touches the token or poll secret of an existing one, so nobody can hijack a
// pending pairing by repeating its name and URL. Pending requests are capped
// (MAX_PENDING_REQUESTS); peer-server rate-limits successful calls per IP.
function handleRegister(body) {
  const name = String(body?.name || '').trim().toLowerCase();
  const publicUrl = security.cleanPublicUrl(body?.publicUrl);
  const token = String(body?.token || '');
  const pollSecret = String(body?.pollSecret || '');
  if (!VALID_PEER_NAME.test(name)) return { status: 400, error: 'bad name' };
  if (!publicUrl) return { status: 400, error: 'bad publicUrl (https:// only, max 200 characters)' };
  if (token.length < 32 || token.length > 200 || pollSecret.length < 32 || pollSecret.length > 200) return { status: 400, error: 'bad credentials' };

  const data = loadPeers();
  pruneRequests(data);
  if (data.requests.filter((r) => r.status === 'pending').length >= MAX_PENDING_REQUESTS) {
    return { status: 429, error: 'too many pending pairing requests' };
  }
  const req = {
    id: newId('pr'), name, publicUrl, token, secretHash: sha256(pollSecret),
    status: 'pending', createdAt: Date.now(), decidedAt: null, proposalId: null,
  };
  data.requests.unshift(req);
  data.requests = data.requests.slice(0, 40);

  // Stage the approval. Proposal payload carries only public facts (the token
  // stays in the encrypted store). The text is built from the validated name,
  // URL and our own request id only.
  // A name that is already linked: approving replaces that slave's address and
  // token. The card says so in capitals and the payload names the peer on file;
  // approveRequest refuses a replacement that was not confirmed this way.
  const existing = data.peers.find((p) => p.name === name);
  let proposal;
  try {
    proposal = require('./governance/horst-governance').createProposal('peer.pair', { requestId: req.id, name, publicUrl, ...(existing ? { replaces: existing.id } : {}) }, {
      origin: 'peer',
      dedupeKey: `peer.pair:${req.id}`,
      summary: existing
        ? `REPLACE the already-linked slave "${name}" (now ${existing.baseUrl}) with a new server at ${publicUrl} (request ${req.id})`
        : `Link slave server "${name}" at ${publicUrl} (request ${req.id})`,
      detail: existing
        ? `A slave named "${name}" is already linked at ${existing.baseUrl}. Approving drops its token and link and trusts the server at ${publicUrl} under that name instead. Approve only if you re-installed that slave yourself; otherwise deny.`
        : 'Approving stores this slave in the peer registry and lets this master publish apps to it. Approve only a server you set up yourself.',
    });
  } catch (err) {
    return { status: 503, error: `approval plane unavailable: ${err.message}` };
  }
  req.proposalId = proposal.id;
  savePeers(data);
  try { broadcaster?.broadcast({ type: 'app:peer:list', ...listPeersPublic() }); } catch {}
  return { status: 200, id: req.id };
}

// Poll endpoint for the registering slave. Reports the request's fate; a still-
// pending request lazily absorbs the proposal's decision (deny/expiry happen in
// governance, which doesn't know about this store).
function handleRegisterStatus(id, pollSecret) {
  const data = loadPeers();
  const req = data.requests.find((r) => r.id === id);
  if (!req) return { status: 404, error: 'unknown request' };
  if (!hashEquals(pollSecret, req.secretHash)) return { status: 403, error: 'forbidden' };
  if (req.status === 'pending' && req.proposalId) {
    try {
      const p = require('./governance/horst-governance').getProposal(req.proposalId);
      if (p && (p.status === 'denied' || p.status === 'expired')) {
        req.status = p.status;
        req.decidedAt = Date.now();
        delete req.token;
        savePeers(data);
      }
    } catch {}
  }
  if (pruneRequests(data)) savePeers(data);
  const fresh = data.requests.find((r) => r.id === id);
  return { status: 200, requestStatus: fresh ? fresh.status : 'expired' };
}

// Governance executor for 'peer.pair' — runs exactly once on approval.
// `replaces` is the id of the already-linked peer the owner was shown on the
// card; a name that is linked and not confirmed by it is refused.
function approveRequest(requestId, { replaces } = {}) {
  const data = loadPeers();
  const req = data.requests.find((r) => r.id === requestId);
  if (!req) throw new Error('pairing request not found (expired?)');
  if (req.status !== 'pending') throw new Error(`pairing request already ${req.status}`);
  if (!req.token) throw new Error('pairing request has no token');
  if (!security.isSecureUrl(req.publicUrl)) throw new Error('slave URL must be https://');

  const existing = data.peers.find((p) => p.name === req.name);
  if (existing && replaces !== existing.id) {
    throw new Error(`a slave named "${req.name}" is already linked (${existing.baseUrl}) — unlink it first, or have the slave register again so the card asks to replace it`);
  }
  data.peers = data.peers.filter((p) => p.name !== req.name);
  data.peers.push({ id: newId('peer'), name: req.name, baseUrl: req.publicUrl, token: req.token, pairedAt: Date.now() });
  req.status = 'approved';
  req.decidedAt = Date.now();
  delete req.token;
  // Other pending requests for the same name are superseded: no second token
  // can replace this one by being approved later.
  for (const other of data.requests) {
    if (other !== req && other.status === 'pending' && other.name === req.name) {
      other.status = 'denied'; other.decidedAt = Date.now(); delete other.token;
    }
  }
  savePeers(data);
  try { broadcaster?.broadcast({ type: 'app:peer:list', ...listPeersPublic() }); } catch {}
  return { ok: true, summary: `Slave "${req.name}" linked (${data.peers[data.peers.length - 1].baseUrl})` };
}

// Registry accessors. getPeer returns the token — server-side callers only;
// listPeersPublic is the redacted shape for the dashboard.
function getPeer(idOrName) {
  const data = loadPeers();
  return data.peers.find((p) => p.id === idOrName || p.name === idOrName) || null;
}

// Every peer record including the token — server-side callers only (the
// peer-channel needs the token to open its outbound WebSocket per peer).
function listPeersRaw() {
  return loadPeers().peers.slice();
}

function listPeersPublic() {
  const data = loadPeers();
  return {
    peers: data.peers.map(({ token, ...rest }) => rest),
    requests: data.requests.filter((r) => r.status === 'pending').map(({ token, secretHash, ...rest }) => rest),
  };
}

// Merge non-secret bookkeeping onto a peer record (e.g. the key-sync outcome
// written by peer-keys). Refuses to touch identity/credential fields, so a
// caller can never rewrite a peer's token or URL through this path.
const PEER_PATCHABLE = new Set(['keysSyncedAt', 'keysSyncedSummary', 'keysSyncError', 'trustOwnerClicks']);

function updatePeer(idOrName, patch) {
  const data = loadPeers();
  const peer = data.peers.find((p) => p.id === idOrName || p.name === idOrName);
  if (!peer) return null;
  for (const [key, value] of Object.entries(patch || {})) {
    if (!PEER_PATCHABLE.has(key)) continue;
    if (value === null || value === undefined) delete peer[key];
    else peer[key] = value;
  }
  savePeers(data);
  try { broadcaster?.broadcast({ type: 'app:peer:list', ...listPeersPublic() }); } catch {}
  return peer;
}

function removePeer(idOrName) {
  const data = loadPeers();
  const before = data.peers.length;
  data.peers = data.peers.filter((p) => p.id !== idOrName && p.name !== idOrName);
  savePeers(data);
  try { broadcaster?.broadcast({ type: 'app:peer:list', ...listPeersPublic() }); } catch {}
  return { ok: data.peers.length < before };
}

// ---------------------------------------------------------------------------

function init(options) {
  appsDir = options.appsDir;
  secretStore = options.secretStore;
  broadcaster = options.broadcaster || null;
  tightenModes(peersPath(), peerPath(), keyFilePath());

  // Approval kind for incoming pairings. registerKind is store-free, so this is
  // safe even when Horst/governance failed to initialize — createProposal is
  // the guarded call (handleRegister returns 503 then).
  try {
    require('./governance/horst-governance').registerKind('peer.pair', {
      label: 'Link slave server',
      ceiling: 'propose',
      approveFrom: security.ownerOnlyApproveFrom,
      validate(p) {
        if (!p.requestId || !p.name || !p.publicUrl) throw new Error('payload requires requestId, name, publicUrl');
      },
      describe: (p) => (p.replaces ? `REPLACE the linked slave "${p.name}" with the server at ${p.publicUrl}` : `Link slave server "${p.name}" at ${p.publicUrl}`),
      execute: (p) => approveRequest(p.requestId, { replaces: p.replaces }),
    });
  } catch (err) {
    console.warn('  Peer: governance kind registration failed:', err.message);
  }

  // A pairing left pending by a restart resumes polling.
  if (hostConfig.isSlave() && loadSlaveState().pending) startPollLoop();
}

function shutdown() {
  stopPollLoop();
}

module.exports = {
  init, shutdown,
  // slave
  startPairing, resetPairing, slaveStatus, verifyPeerToken, hasPeerToken,
  // master
  handleRegister, handleRegisterStatus, approveRequest, getPeer, listPeersRaw, listPeersPublic, updatePeer, removePeer,
};
