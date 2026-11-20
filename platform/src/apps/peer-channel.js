// Persistent master↔slave peer channel (docs/federation.md).
//
// One logical platform, many hosts: the MASTER opens an outbound WebSocket to
// each linked slave's /api/peer/channel (same direction and same token as every
// other control call — the slave holds only the token hash), the SLAVE accepts
// the upgrade and streams read-only, summary-level events back:
//
//   slave → master:  hello/status snapshots (versions, deployed commits, per-app
//                    health), app:error / app:crashloop (from app-guard's
//                    broadcasts), sysmon pressure transitions, terminal peer-job
//                    transitions (code deploy / install / data import /
//                    rollback), and a daily spend/storage summary.
//   master → slave:  pings, and remote-session commands (`rs:cmd`, answered
//                    by `rs:reply`; peer-remote-slave.js executes them behind
//                    the slave owner's opt-in and refuses them on a channel
//                    that is not TLS). Publish, keys and restart stay on the
//                    existing HTTP endpoints.
//   remote sessions: remoteCommand() / onRemoteFrame() are the master's half
//                    (docs/federation.md "Remote sessions").
//   fleet remote:    slave → master `fr:job` frames (a remote job's progress,
//                    fleet-remote-host.js) in a rate window of their own;
//                    sendFleetFrame() / onFleetFrame() (docs/fleet-remote.md).
//   fleet data up:   slave → master `fr:req` answered by `fr:reply`, master →
//                    slave `fr:fd` record pushes (askMaster / onSlaveRequest /
//                    sendToSlave / onMasterFrame, docs/fleet-data-up.md).
//
// The master keeps per-peer fleet state { connected, lastSeen, appHealth,
// deployed, versions } (fleetState(), broadcast as app:fleet:state) and hands
// every ingested event to onEvent listeners — capabilities/fleet.js wires those
// into the Horst bus as peer:* senses, tagged { host, hop } so a relayed
// envelope is always distinguishable from a local one. Bus guardrails (rate,
// storm, payload cap) apply at ingest via horst-events.publish; this module
// adds a per-connection message-rate cap and a frame-size cap on top, so a
// chatty or hostile slave cannot storm the master's bus.
//
// Degrades gracefully: no peers → no connections; channel down → today's HTTP
// publish/key-sync/ping flows are untouched.
const hostConfig = require('./host-config');
const security = require('./peer-security');
const hostSpecs = require('./host-specs');
const execFileAsync = require('util').promisify(require('child_process').execFile);

let deps = {};                 // { broadcaster }

// ---------------------------------------------------------------------------
// Shared: event listeners (master-side consumers; registered before init —
// capabilities/fleet.js wires during platform-horst.init, which precedes ours).
// ---------------------------------------------------------------------------
const listeners = new Set();

function onEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(ev) {
  for (const fn of listeners) {
    try { fn(ev); } catch (err) { console.warn('[peer-channel] listener error:', err.message); }
  }
}

// ---------------------------------------------------------------------------
// Ingest guardrails (master side): per-connection message rate + frame size.
// The bus applies its own per-kind rate/storm caps after this; these exist so
// a misbehaving peer is cut off before JSON.parse work piles up.
// ---------------------------------------------------------------------------
const FRAME_CAP = 128 * 1024;        // bytes per frame
const RATE_MAX = 240;                // messages per window per connection
const RS_RATE_MAX = 1200;            // remote-session frames (rs:*) per window, a window of their own
const FR_RATE_MAX = 1200;            // fleet remote job frames (fr:*) per window, a window of their own
const RATE_WINDOW_MS = 60 * 1000;

function makeRateWindow() {
  return { times: [], dropped: 0, warned: false };
}

// True when the message may pass; false drops it (one warning per window).
function allowMessage(win, now = Date.now(), max = RATE_MAX) {
  win.times = win.times.filter((t) => now - t < RATE_WINDOW_MS);
  if (win.times.length >= max) {
    win.dropped++;
    return false;
  }
  win.times.push(now);
  win.warned = false;
  return true;
}

// ---------------------------------------------------------------------------
// Master side: one outbound connection per registered peer, reconnect with
// backoff, heartbeat, fleet state.
// ---------------------------------------------------------------------------
const conns = new Map();  // peer name → conn
const RECONNECT_MIN_MS = 5 * 1000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const STALE_MS = 90 * 1000;          // no pong/message for this long → cut + reconnect

let resyncTimer = null;
let unsubBroadcast = null;
let fleetBroadcastTimer = null;

// The one channel pathname; index.js declares it in authExemptUpgradePaths.
const CHANNEL_PATH = '/api/peer/channel';

function wsUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws') + CHANNEL_PATH;
}

function conn(name) { return conns.get(name); }

function newConn(peer) {
  return {
    peer,
    ws: null,
    connected: false,
    lastSeen: null,
    backoffMs: RECONNECT_MIN_MS,
    reconnectTimer: null,
    heartbeatTimer: null,
    rate: makeRateWindow(),
    rsRate: makeRateWindow(),
    frRate: makeRateWindow(),
    pending: new Map(),      // rs:cmd id → { resolve, reject, timer }
    snapshot: null,          // last hello/status from the slave
    appHealth: {},           // app → health (derived from snapshots)
    lastJobs: {},            // app → last terminal peer job { name, status, error, at }
    closing: false,
  };
}

function connect(c) {
  if (c.closing || c.ws) return;
  let WebSocket;
  try { WebSocket = require('ws'); } catch (err) {
    console.warn('[peer-channel] ws module unavailable — channel disabled:', err.message);
    return;
  }
  const peer = c.peer;
  let ws;
  try {
    ws = new WebSocket(wsUrl(peer.baseUrl), {
      headers: { 'X-Vistaclair-Peer-Token': peer.token },
      handshakeTimeout: 15000,
      maxPayload: FRAME_CAP,
    });
  } catch (err) {
    scheduleReconnect(c);
    return;
  }
  c.ws = ws;

  ws.on('open', () => {
    if (c.closing) { try { ws.terminate(); } catch {} return; }
    c.connected = true;
    c.lastSeen = Date.now();
    c.backoffMs = RECONNECT_MIN_MS;
    c.rate = makeRateWindow();
    c.rsRate = makeRateWindow();
    c.frRate = makeRateWindow();
    emit({ type: 'connected', peer: peer.name });
    broadcastFleetState();
    c.heartbeatTimer = setInterval(() => {
      if (Date.now() - (c.lastSeen || 0) > STALE_MS) {
        try { ws.terminate(); } catch {}
        return;
      }
      try { ws.ping(); } catch {}
    }, HEARTBEAT_MS);
    if (c.heartbeatTimer.unref) c.heartbeatTimer.unref();
  });

  ws.on('pong', () => { c.lastSeen = Date.now(); });

  ws.on('message', (data) => {
    c.lastSeen = Date.now();
    if (data.length > FRAME_CAP) return;
    // Remote-session frames (the slave writes `type` first) stream session
    // events, so they count in a window of their own.
    if (isRemoteFrame(data)) {
      if (!allowMessage(c.rsRate, Date.now(), RS_RATE_MAX)) return;
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      try { handleRemoteFrame(c, msg); } catch (err) {
        console.warn(`[peer-channel] bad remote-session frame from "${peer.name}":`, err.message);
      }
      return;
    }
    // Fleet remote job frames (progress of a job this master started there).
    if (isFleetFrame(data)) {
      if (!allowMessage(c.frRate, Date.now(), FR_RATE_MAX)) return;
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (msg.type === 'fr:req') { answerSlaveRequest(c, msg); return; }
      for (const fn of fleetListeners) {
        try { fn(peer.name, msg); } catch (err) { console.warn('[peer-channel] fleet frame listener error:', err.message); }
      }
      return;
    }
    if (!allowMessage(c.rate)) {
      if (!c.rate.warned) {
        c.rate.warned = true;
        console.warn(`[peer-channel] peer "${peer.name}" over message rate — dropping until the window clears`);
      }
      return;
    }
    let msg = null;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { handleSlaveMessage(c, msg); } catch (err) {
      console.warn(`[peer-channel] bad message from "${peer.name}":`, err.message);
    }
  });

  const onGone = () => {
    if (c.ws !== ws) return;
    c.ws = null;
    if (c.heartbeatTimer) { clearInterval(c.heartbeatTimer); c.heartbeatTimer = null; }
    rejectPending(c, 'disconnected');
    if (c.connected) {
      c.connected = false;
      emit({ type: 'disconnected', peer: peer.name });
      broadcastFleetState();
    }
    scheduleReconnect(c);
  };
  ws.on('close', onGone);
  ws.on('error', onGone);
}

function scheduleReconnect(c) {
  if (c.closing || c.reconnectTimer) return;
  const jitter = Math.floor(Math.random() * 1000);
  c.reconnectTimer = setTimeout(() => {
    c.reconnectTimer = null;
    connect(c);
  }, c.backoffMs + jitter);
  if (c.reconnectTimer.unref) c.reconnectTimer.unref();
  c.backoffMs = Math.min(c.backoffMs * 2, RECONNECT_MAX_MS);
}

function dropConn(c) {
  c.closing = true;
  if (c.reconnectTimer) { clearTimeout(c.reconnectTimer); c.reconnectTimer = null; }
  if (c.heartbeatTimer) { clearInterval(c.heartbeatTimer); c.heartbeatTimer = null; }
  try { c.ws?.terminate(); } catch {}
  c.ws = null;
  c.connected = false;
  rejectPending(c, 'disconnected');
}

// ---------------------------------------------------------------------------
// Master side: remote-session commands to a slave and the frames it pushes
// (peer-remote-slave.js is the other end). A command is one `rs:cmd` frame,
// settled by the `rs:reply` with its id; a reply's error code is the slave's.
// ---------------------------------------------------------------------------
const remoteListeners = new Set();
const RS_PUSHES = new Set(['rs:event', 'rs:ask', 'rs:askDone', 'rs:state', 'rs:auth', 'rs:msg']);
const RS_TIMEOUT_MS = 30 * 1000;
const RS_PREFIX = Buffer.from('{"type":"rs:');
let rsSeq = 0;

// Fleet remote: fn(peerName, frame) for every `fr:*` frame a slave pushes
// (fleet-remote.js validates it against its records). Returns unsubscribe.
const fleetListeners = new Set();
const FR_PREFIX = Buffer.from('{"type":"fr:');
function onFleetFrame(fn) {
  fleetListeners.add(fn);
  return () => fleetListeners.delete(fn);
}
function isFleetFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  return buf.length > FR_PREFIX.length && buf.subarray(0, FR_PREFIX.length).equals(FR_PREFIX);
}

// Slave → master requests (`fr:req { id, op, args }`, the up direction of the
// fleet data publish, fleet-data-up.js): one handler answers them as
// `fr:reply { id, ok, result | error: { code, message } }` on the same socket.
let slaveRequestHandler = null;
function onSlaveRequest(fn) {
  slaveRequestHandler = fn;
  return () => { if (slaveRequestHandler === fn) slaveRequestHandler = null; };
}
function answerSlaveRequest(c, msg) {
  if (typeof msg.id !== 'string' || msg.id.length > 64 || typeof msg.op !== 'string' || msg.op.length > 64) return;
  const reply = (body) => {
    const raw = JSON.stringify({ type: 'fr:reply', id: msg.id, ...body });
    const out = Buffer.byteLength(raw) > FRAME_CAP
      ? JSON.stringify({ type: 'fr:reply', id: msg.id, ok: false, error: { code: 'too-large', message: 'reply too large for the channel' } })
      : raw;
    try { c.ws?.send(out); } catch {}
  };
  if (!slaveRequestHandler) return reply({ ok: false, error: { code: 'no-handler', message: 'the master does not serve this request (update vistaclair-pro there)' } });
  Promise.resolve()
    .then(() => slaveRequestHandler(c.peer.name, msg.op, msg.args && typeof msg.args === 'object' ? msg.args : {}))
    .then((result) => reply({ ok: true, result: result ?? null }))
    .catch((err) => reply({ ok: false, error: { code: typeof err?.code === 'string' ? err.code.slice(0, 40) : 'error', message: String(err?.message || err).slice(0, 2000) } }));
}

// A master → slave `fr:*` frame (fleet-data-up.js pushes its up records).
// False when that slave is not connected or the frame is over the cap.
function sendToSlave(peerName, frame) {
  const c = conns.get(peerName);
  if (!c?.connected || !c.ws) return false;
  if (typeof frame?.type !== 'string' || !frame.type.startsWith('fr:')) return false;
  const raw = JSON.stringify(frame);
  if (Buffer.byteLength(raw) > FRAME_CAP) return false;
  try { c.ws.send(raw); return true; } catch { return false; }
}

function isRemoteFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  return buf.length > RS_PREFIX.length && buf.subarray(0, RS_PREFIX.length).equals(RS_PREFIX);
}

function remoteError(code, message) {
  const err = new Error(String(message || code).slice(0, 300));
  err.code = typeof code === 'string' && code.length <= 40 ? code : 'bad-reply';
  return err;
}

function rejectPending(c, code) {
  for (const [id, p] of c.pending || []) {
    clearTimeout(p.timer);
    c.pending.delete(id);
    p.reject(remoteError(code, `slave "${c.peer.name}" ${code === 'disconnected' ? 'disconnected' : code}`));
  }
}

// fn(peerName, frame) for every rs:event / rs:ask / rs:askDone / rs:state /
// rs:auth / rs:msg (a remote worker's report or message) frame a slave
// pushes. Returns the unsubscribe function.
function onRemoteFrame(fn) {
  remoteListeners.add(fn);
  return () => remoteListeners.delete(fn);
}

function handleRemoteFrame(c, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'rs:reply') {
    const p = c.pending.get(msg.id);
    if (!p) return;
    c.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok === true) p.resolve(msg.result ?? null);
    else p.reject(remoteError(msg.error?.code, msg.error?.message));
    return;
  }
  if (!RS_PUSHES.has(msg.type)) return;
  for (const fn of remoteListeners) {
    try { fn(c.peer.name, msg); } catch (err) { console.warn('[peer-channel] remote listener error:', err.message); }
  }
}

// Run one remote-session op on a linked slave. Rejects with the slave's error
// code (err.code), or 'not-https' (the slave's URL is not https://: no command
// goes over a plain ws:// channel), 'offline' (no live channel), 'timeout',
// 'disconnected' (the channel dropped while waiting), 'bad-args' (a frame over
// the cap).
function remoteCommand(peerName, op, args, { timeoutMs = RS_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const c = conns.get(peerName);
    if (c && !/^https:\/\//i.test(String(c.peer?.baseUrl || ''))) {
      return reject(remoteError('not-https', `slave "${peerName}" is not linked over https://`));
    }
    if (!c?.connected || !c.ws) return reject(remoteError('offline', `slave "${peerName}" is not connected`));
    const id = `rs-${++rsSeq}`;
    const frame = JSON.stringify({ type: 'rs:cmd', id, op, args: args ?? {} });
    if (Buffer.byteLength(frame) > FRAME_CAP) return reject(remoteError('bad-args', 'command too large for the channel'));
    const timer = setTimeout(() => {
      if (c.pending.delete(id)) reject(remoteError('timeout', `slave "${peerName}" did not answer ${op}`));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    c.pending.set(id, { resolve, reject, timer });
    try { c.ws.send(frame); } catch (err) {
      c.pending.delete(id);
      clearTimeout(timer);
      reject(remoteError('offline', err.message));
    }
  });
}

// Apply a hello/status snapshot; health transitions become events.
// A slave's reported { app: domain } — shape-checked and capped like the rest;
// null when the slave predates the field (the master then says "not reported").
function cleanDomains(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const out = {};
  for (const [app, domain] of Object.entries(d).slice(0, 100)) {
    if (security.isAppName(app) && security.isHostname(domain)) out[app] = domain;
  }
  return out;
}

// Slave-supplied `deployed`: { app: commit }. Both ends are peer input — the
// key later names a path inside the master's apps repo, so it must be a plain
// app name; the value is a short token (the hex test happens at use).
function cleanDeployed(d) {
  const out = {};
  if (!d || typeof d !== 'object' || Array.isArray(d)) return out;
  for (const [app, commit] of Object.entries(d).slice(0, 200)) {
    if (security.isAppName(app) && typeof commit === 'string' && /^[0-9A-Za-z._-]{1,64}$/.test(commit)) out[app] = commit;
  }
  return out;
}

// The slave's Claude account summary — only the status fields core's
// `claude auth status` exposes, flags, and the remote-session opt-in.
function cleanClaude(cl) {
  if (!cl || typeof cl !== 'object' || Array.isArray(cl)) return null;
  const str = (v) => (typeof v === 'string' && v ? v.slice(0, 200) : null);
  const rs = cl.remoteSessions && typeof cl.remoteSessions === 'object' ? cl.remoteSessions : {};
  return {
    loggedIn: cl.loggedIn === true,
    authMethod: str(cl.authMethod),
    subscriptionType: str(cl.subscriptionType),
    email: str(cl.email),
    orgName: str(cl.orgName),
    apiKey: cl.apiKey === true,
    pref: str(cl.pref),
    remoteSessions: { enabled: rs.enabled === true, allowApiKey: rs.allowApiKey === true },
  };
}

function applySnapshot(c, snap) {
  const prev = c.appHealth || {};
  const next = {};
  const apps = (Array.isArray(snap.apps) ? snap.apps : []).filter((a) => a && security.isAppName(a.name));
  for (const a of apps) {
    next[a.name] = a.health || 'unknown';
    if (prev[a.name] && prev[a.name] !== next[a.name]) {
      emit({ type: 'health', peer: c.peer.name, app: a.name, from: prev[a.name], to: next[a.name] });
    }
  }
  c.appHealth = next;
  c.snapshot = {
    at: Date.now(),
    versions: snap.versions || null,
    deployed: cleanDeployed(snap.deployed),
    apps: apps.slice(0, 100),
    disabled: Array.isArray(snap.disabled) ? snap.disabled.filter((n) => security.isAppName(n)).slice(0, 100) : [],
    domains: cleanDomains(snap.domains),
    claude: cleanClaude(snap.claude),
    // Hardware specs (host-specs.js). A snapshot without them (older slave, a
    // failed measure) keeps the last ones; an offline slave keeps them too.
    specs: hostSpecs.clean(snap.specs) || c.snapshot?.specs || null,
  };
  broadcastFleetState();
}

function handleSlaveMessage(c, msg) {
  const peer = c.peer.name;
  switch (msg.t) {
    case 'hello':
    case 'status':
      applySnapshot(c, msg);
      break;
    case 'event': {
      const k = msg.k;
      if (k === 'app:error') {
        emit({ type: 'app:error', peer, app: msg.app, surface: msg.surface, error: msg.error, count: msg.count });
      } else if (k === 'app:crashloop') {
        emit({ type: 'app:crashloop', peer, app: msg.app, count: msg.count, lastError: msg.lastError });
      } else if (k === 'pressure') {
        emit({ type: 'pressure', peer, state: msg.state, reasons: msg.reasons });
      } else if (k === 'summary') {
        emit({ type: 'summary', peer, apps: msg.apps });
      } else if (k === 'job') {
        c.lastJobs[msg.app] = { name: msg.name, status: msg.status, error: msg.error || null, at: Date.now() };
        emit({ type: 'job', peer, app: msg.app, name: msg.name, status: msg.status, error: msg.error || null });
        broadcastFleetState();
      }
      break;
    }
    default:
      break;
  }
}

// Reconcile connections with the current peer registry (called at init, when
// the registry broadcasts a change, and on a slow periodic sweep).
function syncPeers() {
  if (hostConfig.isSlave()) return;
  let peers = [];
  try { peers = require('./peer-pairing').listPeersRaw(); } catch { return; }
  // A peer linked over plain http:// (needsRepair) never gets the token sent.
  const wanted = new Map(peers.filter((p) => !p.needsRepair).map((p) => [p.name, p]));
  for (const [name, c] of conns) {
    if (!wanted.has(name)) {
      dropConn(c);
      conns.delete(name);
      broadcastFleetState();
    }
  }
  for (const [name, peer] of wanted) {
    const existing = conns.get(name);
    if (existing) {
      // URL or token changed (re-pair): rebuild the connection.
      if (existing.peer.baseUrl !== peer.baseUrl || existing.peer.token !== peer.token) {
        dropConn(existing);
        conns.delete(name);
      } else {
        continue;
      }
    }
    const c = newConn(peer);
    conns.set(name, c);
    connect(c);
  }
}

// Read-only fleet view for the dashboard + the fleet_status tool.
function fleetState() {
  let peers = [];
  try { peers = require('./peer-pairing').listPeersPublic().peers; } catch {}
  return {
    peers: peers.map((p) => {
      const c = conns.get(p.name);
      return {
        name: p.name,
        baseUrl: p.baseUrl,
        needsRepair: !!p.needsRepair,
        pairedAt: p.pairedAt || null,
        connected: !!c?.connected,
        lastSeen: c?.lastSeen || null,
        versions: c?.snapshot?.versions || null,
        deployed: c?.snapshot?.deployed || {},
        disabled: c?.snapshot?.disabled || [],
        domains: c?.snapshot?.domains || null,
        claude: c?.snapshot?.claude || null,
        specs: c?.snapshot?.specs || null,
        appHealth: c?.appHealth || {},
        lastJobs: c?.lastJobs || {},
      };
    }),
  };
}

// fleetState plus, per deployed app, how many commits touching that app the
// slave is behind (rev-list against the master's apps repo — repo HEAD alone
// would flag every unrelated commit). Git work → async, memoised per
// (app, deployed commit, master HEAD): the app cards read `behind` from every
// broadcast, so a snapshot must not cost a rev-list per peer × app each time.
const behindCache = new Map();   // `${app}@${commit}..${head}` → count
async function fleetStateDetailed() {
  const state = fleetState();
  if (hostConfig.isSlave()) return state;
  // execFile, never a shell: the app name and commit come from a peer.
  const execGit = async (args) => (await execFileAsync('git', args, { cwd: APPS_DIR, timeout: 5000 })).stdout.trim();
  const APPS_DIR = require('./app-manager').APPS_DIR;
  let head = null;
  try { head = await execGit(['rev-parse', 'HEAD']); } catch {}
  for (const peer of state.peers) {
    const deployed = {};
    for (const [app, commit] of Object.entries(peer.deployed || {})) {
      let behind = null;
      if (head && security.isAppName(app) && /^[0-9a-f]{7,40}$/i.test(String(commit))) {
        const key = `${app}@${commit}..${head}`;
        if (behindCache.has(key)) {
          behind = behindCache.get(key);
        } else {
          try {
            const n = Number(await execGit(['rev-list', '--count', `${commit}..HEAD`, '--', `${app}/`]));
            if (Number.isFinite(n)) behind = n;
          } catch {}
          if (behind != null) {
            if (behindCache.size > 500) behindCache.clear();
            behindCache.set(key, behind);
          }
        }
      }
      deployed[app] = { commit, behind, disabled: (peer.disabled || []).includes(app) };
    }
    peer.deployed = deployed;
    peer.masterHead = head;
  }
  return state;
}

// Fleet-state broadcasts are coalesced — snapshots and job ticks may cluster.
function broadcastFleetState() {
  if (!deps.broadcaster || fleetBroadcastTimer) return;
  fleetBroadcastTimer = setTimeout(() => {
    fleetBroadcastTimer = null;
    fleetStateDetailed()
      .then((state) => { try { deps.broadcaster.broadcast({ type: 'app:fleet:state', ...state }); } catch {} })
      .catch(() => {});
  }, 500);
  if (fleetBroadcastTimer.unref) fleetBroadcastTimer.unref();
}

// ---------------------------------------------------------------------------
// Slave side: accept the master's upgrade at /api/peer/channel, stream events.
// ---------------------------------------------------------------------------
let wss = null;               // lazy WebSocketServer({ noServer: true })
let slaveWs = null;           // the one live master connection
let slaveTapDispose = null;

const SLAVE_STATUS_EVERY_MS = 5 * 60 * 1000;
const SLAVE_HEALTH_POLL_MS = 30 * 1000;
const SLAVE_SUMMARY_EVERY_MS = 24 * 3600 * 1000;

function slaveSend(msg) {
  if (!slaveWs || slaveWs.readyState !== 1) return;
  try { slaveWs.send(JSON.stringify(msg)); } catch {}
}

// A fleet remote job frame to the master (`type` first, so the master routes
// it to its own window). False when no master is connected or it is too big.
function sendFleetFrame(frame) {
  if (!slaveWs || slaveWs.readyState !== 1) return false;
  const { type, ...rest } = frame || {};
  if (typeof type !== 'string' || !type.startsWith('fr:')) return false;
  const raw = JSON.stringify({ type, ...rest });
  if (Buffer.byteLength(raw) > FRAME_CAP) return false;
  try { slaveWs.send(raw); return true; } catch { return false; }
}

// Slave → master requests and the master's `fr:*` pushes (fleet-data-up.js).
// askMaster(op, args) resolves with the master's result or rejects with its
// error code (err.code): 'offline' (no master connected), 'timeout',
// 'disconnected' (the channel dropped while waiting), 'too-large'.
const masterPending = new Map();   // id → { resolve, reject, timer }
const masterFrameListeners = new Set();
const masterConnectListeners = new Set();
let frSeq = 0;
function askMaster(op, args, { timeoutMs = 30 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!slaveWs || slaveWs.readyState !== 1) return reject(remoteError('offline', 'the master is not connected'));
    const id = `fq-${++frSeq}`;
    const raw = JSON.stringify({ type: 'fr:req', id, op, args: args ?? {} });
    if (Buffer.byteLength(raw) > FRAME_CAP) return reject(remoteError('too-large', 'request too large for the channel'));
    const timer = setTimeout(() => {
      if (masterPending.delete(id)) reject(remoteError('timeout', `the master did not answer ${op}`));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    masterPending.set(id, { resolve, reject, timer });
    try { slaveWs.send(raw); } catch (err) {
      masterPending.delete(id);
      clearTimeout(timer);
      reject(remoteError('offline', err.message));
    }
  });
}
function rejectMasterPending(code) {
  for (const [id, p] of masterPending) {
    clearTimeout(p.timer);
    masterPending.delete(id);
    p.reject(remoteError(code, `the master ${code}`));
  }
}
function handleMasterFrame(msg) {
  if (msg.type === 'fr:reply') {
    const p = masterPending.get(msg.id);
    if (!p) return;
    masterPending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok === true) p.resolve(msg.result ?? null);
    else p.reject(remoteError(msg.error?.code, msg.error?.message));
    return;
  }
  for (const fn of masterFrameListeners) {
    try { fn(msg); } catch (err) { console.warn('[peer-channel] master frame listener error:', err.message); }
  }
}
function onMasterFrame(fn) { masterFrameListeners.add(fn); return () => masterFrameListeners.delete(fn); }
function onMasterConnect(fn) { masterConnectListeners.add(fn); return () => masterConnectListeners.delete(fn); }
function masterConnected() { return !!slaveWs && slaveWs.readyState === 1; }

// Snapshot of this slave for hello/status: versions, deployed commits and
// health of the master-deployed (enabled) apps.
async function slaveSnapshot(t) {
  const appManager = require('./app-manager');
  const peerData = require('./peer-data');
  const enabled = hostConfig.enabledApps() || [];
  const deployed = {};
  const apps = [];
  // Deployed-but-disabled apps: the master should be able to tell "not
  // published here" from "published, switched off". They carry their commit
  // in `deployed` and are listed in `disabled`; they stay out of `apps`, so
  // health tracking is untouched.
  const disabled = [];
  try {
    for (const a of appManager.list()) {
      if (!a.deployed || enabled.includes(a.name)) continue;
      const commit = peerData.deployedCommit(a.name);
      if (!commit) continue;
      deployed[a.name] = commit;
      disabled.push(a.name);
    }
  } catch {}
  for (const name of enabled) {
    try {
      const commit = peerData.deployedCommit(name);
      if (commit) deployed[name] = commit;
      const status = appManager.getAppStatus(name);
      apps.push({ name, health: status.health || 'unknown', running: status.health === 'ok' || undefined });
    } catch {
      apps.push({ name, health: 'unknown' });
    }
  }
  // The website domain each deployed app has on THIS host (per-host config),
  // so the master's Configure modal can show where it is set.
  const domains = {};
  for (const name of Object.keys(deployed)) {
    try { const d = appManager.readManifest(name)?.domain; if (typeof d === 'string' && d) domains[name] = d; } catch {}
  }
  let versions = null;
  try { versions = await require('./host-versions').getVersions(); } catch {}
  // Claude account summary + remote-session opt-in, no secrets.
  let claude = null;
  try { claude = require('./peer-remote-slave').claudeStatus(); } catch {}
  // Hardware specs: cached, re-measured every 5 minutes; load and free RAM
  // are read fresh with each snapshot.
  let specs = null;
  try { specs = await hostSpecs.get(); } catch {}
  return { t, versions, deployed, apps, disabled, domains, claude, specs };
}

// Daily spend/storage summary, per enabled app (summary-level only — the
// numbers the master's Spend overview would show, never ledger rows).
function slaveSummary() {
  const spendLedger = require('./spend-ledger');
  const apps = {};
  for (const name of hostConfig.enabledApps() || []) {
    try {
      const s = spendLedger.summary(name, { days: 1 });
      const st = spendLedger.storageStatus(name);
      apps[name] = {
        costUsd: s.today?.costUsd || 0,
        calls: s.today?.calls || 0,
        storageBytes: st.bytes ?? null,
      };
    } catch {}
  }
  return { t: 'event', k: 'summary', apps };
}

// Wire this slave's local signals into the channel. Returns a dispose fn.
function startSlaveTaps() {
  const disposers = [];

  // app-guard's coalesced broadcasts carry exactly the summary the master
  // needs — appName, surface, error, count — so tap those rather than the
  // guard's internals.
  try {
    const un = deps.broadcaster.onBroadcast((msg) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'app:runtimeError') {
        slaveSend({ t: 'event', k: 'app:error', app: msg.appName, surface: msg.surface, error: String(msg.error || '').slice(0, 500), count: msg.count });
      } else if (msg.type === 'app:crashloop') {
        slaveSend({ t: 'event', k: 'app:crashloop', app: msg.appName, count: msg.count, lastError: String(msg.lastError || '').slice(0, 500) });
      } else if (msg.type === 'app:bridge:event' && msg.event === 'job:update') {
        // Peer jobs only (code deploy / install / data import / rollback), and
        // only their terminal transition — progress ticks stay local.
        const job = msg.data;
        if (job?.meta?.peer && job.status && job.status !== 'running' && job.status !== 'pending') {
          slaveSend({ t: 'event', k: 'job', app: msg.appName, name: job.name, status: job.status, error: job.error ? String(job.error).slice(0, 300) : null });
        }
      }
    });
    disposers.push(un);
  } catch {}

  // Host pressure transitions (same tracker the local sysmon sense uses).
  try {
    const stop = require('./platform-sysmon').watchPressure({
      onChange: (c) => slaveSend({ t: 'event', k: 'pressure', state: c.state, reasons: (c.reasons || []).map((r) => `${r.kind} (${r.detail})`) }),
    });
    disposers.push(stop);
  } catch {}

  // Health poll: a changed per-app health pushes a fresh status snapshot;
  // otherwise one keepalive snapshot every 5 minutes.
  let lastHealth = '';
  let lastStatusAt = 0;
  const healthTimer = setInterval(async () => {
    try {
      const snap = await slaveSnapshot('status');
      const key = snap.apps.map((a) => `${a.name}=${a.health}`).join(',');
      if (key !== lastHealth || Date.now() - lastStatusAt > SLAVE_STATUS_EVERY_MS) {
        lastHealth = key;
        lastStatusAt = Date.now();
        slaveSend(snap);
      }
    } catch {}
  }, SLAVE_HEALTH_POLL_MS);
  if (healthTimer.unref) healthTimer.unref();
  disposers.push(() => clearInterval(healthTimer));

  // Daily spend/storage summary (and one shortly after connect, so a freshly
  // linked master isn't blind for a day).
  const firstSummary = setTimeout(() => slaveSend(slaveSummary()), 60 * 1000);
  if (firstSummary.unref) firstSummary.unref();
  const summaryTimer = setInterval(() => slaveSend(slaveSummary()), SLAVE_SUMMARY_EVERY_MS);
  if (summaryTimer.unref) summaryTimer.unref();
  disposers.push(() => { clearTimeout(firstSummary); clearInterval(summaryTimer); });

  return () => { for (const d of disposers) { try { d(); } catch {} } };
}

// Descriptor hook: claim /api/peer/channel upgrades on a paired slave. Returns
// true when the request was handled (including auth rejections — the socket is
// ours to destroy), false to let other handlers see it. The token is the
// header's only (never the query string); a correct one always passes, and
// failures count into peer-server's per-client auth-failure window.
function handleUpgrade(req, socket, head) {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://x').pathname; } catch {}
  if (pathname !== CHANNEL_PATH) return false;

  const pairing = require('./peer-pairing');
  const limiter = require('./peer-server');
  const refuse = (status) => {
    try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); } catch {}
    try { socket.destroy(); } catch {}
    return true;
  };
  // Same posture as peer-server's control-plane middleware: an unpaired host
  // doesn't advertise that the channel exists.
  if (!hostConfig.isSlave() || !pairing.hasPeerToken()
    || !pairing.verifyPeerToken(req.headers['x-vistaclair-peer-token'] || '')) {
    const ip = limiter.clientIp(req);
    if (limiter.rateLimited(ip)) return refuse('429 Too Many Requests');
    limiter.recordFail(ip);
    return refuse('404 Not Found');
  }

  let WebSocket;
  try { WebSocket = require('ws'); } catch (err) {
    try { socket.destroy(); } catch {}
    return true;
  }
  if (!wss) wss = new WebSocket.Server({ noServer: true, maxPayload: FRAME_CAP });

  const remote = require('./peer-remote-slave');
  const secure = remote.channelSecure(req);
  wss.handleUpgrade(req, socket, head, (ws) => {
    // One master connection at a time — a reconnect replaces the old socket.
    if (slaveWs) { try { slaveWs.terminate(); } catch {} }
    if (slaveTapDispose) { try { slaveTapDispose(); } catch {} slaveTapDispose = null; }
    slaveWs = ws;
    slaveTapDispose = startSlaveTaps();
    remote.attach({ send: (frame) => { if (slaveWs === ws) slaveSend(frame); }, secure, frameCap: FRAME_CAP });
    console.log('  Peer: master connected to the live channel');

    // The master sends pings, remote-session commands (rs:cmd) and fleet
    // frames (fr:reply / fr:fd, fleet-data-up.js), nothing else.
    const rate = makeRateWindow();
    const frRate = makeRateWindow();   // fr:* pushes (data publish progress) count apart
    ws.on('message', (data) => {
      if (slaveWs !== ws || data.length > FRAME_CAP) return;
      if (!(isFleetFrame(data) ? allowMessage(frRate, Date.now(), FR_RATE_MAX) : allowMessage(rate))) return;
      let msg = null;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg && typeof msg.type === 'string' && msg.type.startsWith('fr:')) { handleMasterFrame(msg); return; }
      if (!msg || msg.type !== 'rs:cmd') return;
      remote.handleFrame(msg)
        .then((reply) => { if (reply && slaveWs === ws) slaveSend(reply); })
        .catch((err) => console.warn('[peer-channel] remote command failed:', err.message));
    });
    ws.on('close', () => {
      if (slaveWs !== ws) return;
      slaveWs = null;
      rejectMasterPending('disconnected');
      remote.detach();
      if (slaveTapDispose) { try { slaveTapDispose(); } catch {} slaveTapDispose = null; }
    });
    ws.on('error', () => { try { ws.terminate(); } catch {} });

    slaveSnapshot('hello').then((snap) => { if (slaveWs === ws) slaveSend(snap); }).catch(() => {});
    for (const fn of masterConnectListeners) {
      try { fn(); } catch (err) { console.warn('[peer-channel] master connect listener error:', err.message); }
    }
  });
  return true;
}

// ---------------------------------------------------------------------------

function init(options) {
  deps = { broadcaster: options.broadcaster || null };
  if (hostConfig.isSlave()) return;   // the slave side is driven by upgrades
  syncPeers();
  // The registry broadcasts app:peer:list on every change (pairing approved,
  // peer removed) — resync then, plus a slow sweep as a belt.
  try {
    unsubBroadcast = deps.broadcaster?.onBroadcast?.((msg) => {
      if (msg?.type === 'app:peer:list') syncPeers();
    }) || null;
  } catch {}
  resyncTimer = setInterval(syncPeers, 5 * 60 * 1000);
  if (resyncTimer.unref) resyncTimer.unref();
}

function shutdown() {
  if (resyncTimer) { clearInterval(resyncTimer); resyncTimer = null; }
  if (unsubBroadcast) { try { unsubBroadcast(); } catch {} unsubBroadcast = null; }
  if (fleetBroadcastTimer) { clearTimeout(fleetBroadcastTimer); fleetBroadcastTimer = null; }
  for (const c of conns.values()) dropConn(c);
  conns.clear();
  if (slaveTapDispose) { try { slaveTapDispose(); } catch {} slaveTapDispose = null; }
  if (slaveWs) { try { slaveWs.terminate(); } catch {} slaveWs = null; }
  try { require('./peer-remote-slave').shutdown(); } catch {}
  if (wss) { try { wss.close(); } catch {} wss = null; }
}

module.exports = {
  init, shutdown,
  onEvent, fleetState, fleetStateDetailed, syncPeers, handleUpgrade,
  remoteCommand, onRemoteFrame,
  onFleetFrame, sendFleetFrame, isConnected: (name) => !!conns.get(name)?.connected,
  onSlaveRequest, sendToSlave, askMaster, onMasterFrame, onMasterConnect, masterConnected,
  CHANNEL_PATH,
  // exported for tests
  allowMessage, makeRateWindow, cleanDomains, cleanClaude, FRAME_CAP, RATE_MAX, RS_RATE_MAX,
  _emitTestEvent: emit,
  _handleSlaveMessage: handleSlaveMessage,
  _conns: conns, _newConn: newConn, _handleRemoteFrame: handleRemoteFrame, _dropConn: dropConn,
};
