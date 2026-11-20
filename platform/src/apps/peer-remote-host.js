// Remote workers, master side (docs/remote-sessions.md "Remote workers").
//
// Core's host provider (ctx.orchestration.registerHostProvider, feature-
// detected): an orchestrator's launch_cli({ title, task, host, app }) makes a
// member of its run that runs on a linked slave.
//
//   hosts()   the linked slaves, each available or with the reason it is not:
//             "may join runs" off (this master's per-slave switch), channel
//             down, remote sessions off on the slave, no Claude credential.
//   launch()  validates, files one `peer.session.launch` card (mode worker,
//             proposal origin peer-remote-agent ORIGIN; who asked is the run
//             and member core named, never agent text) and waits. Approved →
//             peer-remote-master.launchMember (`member.launch`, the external
//             tab) → resolve { tabId }. Denied, expired or withdrawn → reject
//             `declined`.
//   kill()    a pending card is withdrawn; a started member's tab is closed
//             (kill op, unregister).
//   inbound   the member's rs:msg (report / message, validated and rate-capped
//             by peer-remote-master) → core's deliver(), the text prefixed
//             "[remote · <peer> · untrusted] ".
//   outbound  core's SendMessage → the tab adapter's submit(text, { from })
//             → `member.submit` (peer-remote-master).
//
// Billing: the slave's Claude subscription; its API key only when the run
// bills the API key (the launch call's `auth`) and the slave has one and
// allows it, or when the owner edits the card's payload to `apikey`. The
// owner switches a started worker on its tab (setAuth).

const fs = require('fs');
const path = require('path');

const POLL_MS = 2000;
const TITLE_CAP = 120;
// The slave's rule for run ids and member addresses (docs/federation.md).
const ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const ADDRESS_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MODEL_RE = /^[A-Za-z0-9._-]{1,80}(\[1m\])?$/;
const UNTRUSTED = (peer) => `[remote · ${peer} · untrusted] `;

let deps = {};
let handle = null;                 // core's { deliver, unregister }
const pending = new Map();         // proposal id → { peer, runId, address, orchestrator, resolve, reject }
const starting = new Map();        // `${runId}\n${address}` → { cancelled }: approved, member.launch under way
const joinRunsOff = new Set();     // peers whose "may join runs" is off (persisted)
let pollTimer = null;
let unsubMsgs = null;
let unsubBroadcast = null;

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function err(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

const master = () => deps.master();
const agent = () => deps.agent();

function fleetPeers() {
  try { return deps.peerChannel().fleetState?.().peers || []; } catch { return []; }
}

// ---------------------------------------------------------------------------
// "Sessions on this slave may join runs" — on by default (a freshly paired
// slave is on); off is kept in <dataHome>/peer-remote/join-runs.json.
// ---------------------------------------------------------------------------
function switchFile() {
  return deps.dataHome ? path.join(deps.dataHome, 'peer-remote', 'join-runs.json') : null;
}

function loadSwitches() {
  joinRunsOff.clear();
  const file = switchFile();
  if (!file) return;
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')).off; } catch { return; }
  if (Array.isArray(rows)) for (const p of rows.slice(0, 200)) if (typeof p === 'string') joinRunsOff.add(p.slice(0, 200));
}

function saveSwitches() {
  const file = switchFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ off: [...joinRunsOff] }));
  } catch (e) { console.warn('[peer-remote-host] switches not saved:', e.message); }
}

function setJoinRuns(peer, on) {
  if (on) joinRunsOff.delete(peer); else joinRunsOff.add(peer);
  saveSwitches();
  try { master().scheduleState?.(); } catch {}
}

const mayJoinRuns = (peer) => !joinRunsOff.has(peer);

// A peer no longer linked forgets its switch: a new pairing starts on.
function pruneSwitches(peers) {
  const names = new Set(peers.map((p) => p?.name));
  let changed = false;
  for (const p of [...joinRunsOff]) if (!names.has(p)) { joinRunsOff.delete(p); changed = true; }
  if (changed) saveSwitches();
}

// ---------------------------------------------------------------------------
// Availability and billing
// ---------------------------------------------------------------------------
function claudeOf(p) {
  const c = isPlain(p?.claude) ? p.claude : null;
  if (!c) return null;
  const rs = isPlain(c.remoteSessions) ? c.remoteSessions : {};
  return { loggedIn: c.loggedIn === true, apiKey: c.apiKey === true, enabled: rs.enabled === true, allowApiKey: rs.allowApiKey === true };
}

// Why runs cannot use this peer now, or null.
function unavailable(p) {
  if (!handle) return 'needs the core update (no host provider hook)';
  if (!mayJoinRuns(p.name)) return '"Sessions on this slave may join runs" is off on this master';
  if (!p.connected) return 'the channel to the slave is down';
  const c = claudeOf(p);
  if (!c) return 'the slave has not reported its Claude status yet';
  if (!c.enabled) return 'remote sessions are disabled on the slave';
  if (!c.loggedIn && !(c.apiKey && c.allowApiKey)) return 'the slave has no Claude credential (not signed in, no API key it allows)';
  return null;
}

// The run's billing → what the card asks for, or null (no credential for it).
function billingFor(p, runAuth) {
  const c = claudeOf(p) || {};
  const apiOk = c.apiKey && c.allowApiKey;
  if (runAuth === 'apikey' && apiOk) return 'apikey';
  return c.loggedIn ? 'subscription' : null;
}

// core: hosts() → [{ name, label, available, reason? }]
function hosts() {
  if (deps.isSlave?.()) return [];
  return fleetPeers().map((p) => {
    const reason = unavailable(p);
    return { name: p.name, label: `${p.name} (slave)`, available: !reason, ...(reason ? { reason } : {}) };
  });
}

// The Remote pane's per-peer view (sessionsState `runs`).
function runsView(p) {
  const reason = unavailable(p);
  return { allowed: mayJoinRuns(p.name), available: !reason, reason, provider: !!handle };
}

// ---------------------------------------------------------------------------
// launch / approval / kill
// ---------------------------------------------------------------------------
function invisible(s) {
  return require('./text-safety').invisibleChars(s).length > 0;
}

// The call core makes, checked: a clean spec or a thrown `invalid`.
function checkCall(a) {
  if (!isPlain(a)) throw err('invalid', 'launch takes an object');
  const { runId, address, host, app, task, model } = a;
  if (typeof runId !== 'string' || !ID_RE.test(runId)) throw err('invalid', 'bad run id');
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) throw err('invalid', 'bad member address');
  if (typeof host !== 'string' || !host) throw err('invalid', 'host must name a linked slave');
  if (typeof app !== 'string' || !agent().APP_RE.test(app)) throw err('invalid', 'app must be an app name on the slave ([a-z0-9-])');
  if (typeof task !== 'string' || !task.trim()) throw err('invalid', 'task must be non-empty text');
  if (task.length > agent().PROMPT_CAP) throw err('invalid', `task is ${task.length} characters; the limit is ${agent().PROMPT_CAP}`);
  if (invisible(task)) throw err('invalid', 'task contains an invisible or control character: only text the owner can read is launched (newlines and tabs are fine)');
  if (model != null && model !== '' && (typeof model !== 'string' || !MODEL_RE.test(model))) throw err('invalid', 'bad model name');
  const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim().slice(0, TITLE_CAP) : null;
  if (title && invisible(title)) throw err('invalid', 'title contains an invisible or control character');
  // Descriptive only (the card's "Requested by"): shown, never refused.
  const o = isPlain(a.orchestrator) ? a.orchestrator : {};
  const show = require('./text-safety').showInvisible;
  const orchestrator = {
    address: typeof o.address === 'string' && ADDRESS_RE.test(o.address) ? o.address : null,
    title: typeof o.title === 'string' ? show(o.title.replace(/\s+/g, ' ').trim()).slice(0, 200) : '',
  };
  return { runId, address, host, app, task, model: model || null, title, orchestrator, auth: a.auth === 'apikey' ? 'apikey' : null };
}

// core: launch({ runId, address, title, task, host, app, model?, orchestrator }) → { tabId }
async function launch(args) {
  if (deps.isSlave?.()) throw err('unavailable', 'this host is a slave: runs launch remote workers from the federation master only');
  const c = checkCall(args);
  const peer = fleetPeers().find((p) => p.name === c.host);
  if (!peer) throw err('unavailable', `no linked slave "${c.host}"`);
  if (!mayJoinRuns(peer.name)) throw err('refused', `"Sessions on this slave may join runs" is off for "${peer.name}" on this master`);
  const why = unavailable(peer);
  if (why) throw err('unavailable', `"${peer.name}": ${why}`);
  const auth = billingFor(peer, c.auth);
  if (!auth) throw err('unavailable', `"${peer.name}" is not signed in to Claude; its API key is used only for a run billed to the API key`);
  for (const e of pending.values()) {
    if (e.runId === c.runId && e.address === c.address) throw err('invalid', `member "${c.address}" already waits for the owner's approval`);
  }
  const gov = deps.governance();
  if (!gov.kindDef?.(agent().KIND)) throw err('unavailable', 'the approval plane is not running');
  const payload = {
    peer: peer.name, mode: 'worker', app: c.app, prompt: c.task, auth,
    ...(c.model ? { model: c.model } : {}),
    ...(c.title ? { title: c.title } : {}),
    origin: {
      kind: 'orchestrator', ref: c.runId, member: c.address,
      ...(c.orchestrator.title ? { title: c.orchestrator.title } : {}),
      ...(c.orchestrator.address ? { address: c.orchestrator.address } : {}),
    },
  };
  let r;
  try {
    r = await gov.requestAction(agent().KIND, payload, { origin: agent().ORIGIN });
  } catch (e) {
    throw err('invalid', `not filed: ${e.message}`);
  }
  if (r.mode !== 'proposed' || !r.proposal?.id) {
    throw err('refused', r.mode === 'observed' ? `the owner's dial for ${agent().KIND} is at observe: no card was filed` : `not staged (${r.mode})`);
  }
  const id = r.proposal.id;
  return new Promise((resolve, reject) => {
    pending.set(id, { peer: peer.name, runId: c.runId, address: c.address, orchestrator: c.orchestrator, resolve, reject });
    startPolling();
  });
}

function settle(id, e) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  entry.reject(e);
}

// The card's state, for every launch still waiting: an answer other than
// approve ends it.
function check(id) {
  if (!pending.has(id)) return;
  let p = null;
  try { p = deps.governance().getProposal(id); } catch {}
  const status = p ? p.status : 'gone';
  if (status === 'pending' || status === 'approved') return;
  if (status === 'denied') return settle(id, err('declined', `the owner declined card ${id}: nothing was launched`));
  if (status === 'expired' || status === 'withdrawn' || status === 'gone') {
    return settle(id, err('declined', `card ${id} ${status === 'gone' ? 'is gone' : `was ${status}`} without the owner's approval: nothing was launched`));
  }
  // executed / failed without approved() settling it.
  settle(id, err('failed', `card ${id} ended ${status}${p?.error ? `: ${p.error}` : ''}`));
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    for (const id of [...pending.keys()]) check(id);
    if (!pending.size) { clearInterval(pollTimer); pollTimer = null; }
  }, deps.pollMs || POLL_MS);
  if (pollTimer.unref) pollTimer.unref();
}

// The slave's (or the channel's) refusal of an approved launch, as core's
// reject: `unavailable` when the slave cannot take a worker now, else `failed`;
// the slave's own code kept as slaveCode.
const BUSY = {
  limit: 'is at its cap of live remote sessions (remote workers count each) or of launches per hour: wait for one to end, or stop one',
  disabled: 'has remote sessions turned off',
  'no-credential': 'has no Claude credential for this billing',
  'apikey-not-allowed': 'does not allow its API key for remote sessions',
  unavailable: 'cannot open a run member (its core lacks the mirror-run hook)',
  offline: 'is offline', timeout: 'did not answer in time', disconnected: 'dropped the channel before it answered',
};
function launchFailure(peer, e) {
  const code = e && typeof e.code === 'string' ? e.code : null;
  const why = code && BUSY[code];
  const out = why
    ? err('unavailable', `the owner approved, but "${peer}" ${why} (${e.message})`)
    : err('failed', `the owner approved, but the launch on "${peer}" failed${code ? ` (${code})` : ''}: ${e && e.message}`);
  if (code) out.slaveCode = code;
  return out;
}

// The kind's executor for an approved worker card (peer-remote-agent.execute):
// the approved payload (an owner's edit included) launches; run and member
// come from the waiting call, never from the payload alone.
async function approved(p, proposal) {
  const entry = pending.get(proposal?.id);
  if (!entry) throw new Error('no run waits for this launch any more (the master restarted, or the run stopped it): nothing was launched');
  if (p.origin?.ref !== entry.runId || p.origin?.member !== entry.address) {
    settle(proposal.id, err('failed', 'the card no longer names this member'));
    throw new Error('the card no longer names the member that asked: nothing was launched');
  }
  pending.delete(proposal.id);
  const peer = fleetPeers().find((x) => x.name === p.peer);
  const why = !peer ? `no linked slave "${p.peer}"` : (!mayJoinRuns(p.peer) ? '"Sessions on this slave may join runs" is off' : null);
  if (why) {
    entry.reject(err('refused', why));
    throw new Error(`${why}: nothing was launched`);
  }
  const key = `${entry.runId}\n${entry.address}`;
  const run = { cancelled: false };
  starting.set(key, run);
  let r;
  try {
    r = await master().launchMember(p.peer, { app: p.app, task: p.prompt, auth: p.auth, model: p.model, title: p.title }, {
      runId: entry.runId, address: entry.address, orchestrator: entry.orchestrator,
    });
  } catch (e) {
    const out = launchFailure(p.peer, e);
    entry.reject(out);
    throw new Error(out.message);
  } finally {
    starting.delete(key);
  }
  // The run stopped it while the slave was starting it.
  if (run.cancelled) {
    master().close(r.tabId);
    entry.reject(err('cancelled', 'the run stopped this worker while it was starting'));
    return { ok: true, summary: `Remote worker "${entry.address}" of run ${entry.runId} was stopped by its run as it started on "${p.peer}"` };
  }
  entry.resolve({ tabId: r.tabId });
  return { ok: true, summary: `Remote worker "${entry.address}" of run ${entry.runId} started on "${p.peer}" (tab ${r.tabId})` };
}

// core: kill({ runId, address })
async function kill(args) {
  const runId = String(args?.runId || '');
  const address = String(args?.address || '');
  for (const [id, e] of pending) {
    if (e.runId !== runId || e.address !== address) continue;
    try { deps.governance().withdrawProposal(id, 'run'); } catch {}
    settle(id, err('cancelled', 'the run stopped this launch before the owner approved it'));
  }
  const run = starting.get(`${runId}\n${address}`);
  if (run) run.cancelled = true;
  const tabId = master().memberTab(runId, address);
  if (tabId) master().close(tabId);
}

// A slave member's report or message → core, marked as untrusted slave text.
function onMemberMessage(ev) {
  if (!handle || typeof handle.deliver !== 'function') return;
  const lost = ev.dropped > 0 ? `(${ev.dropped} earlier message${ev.dropped === 1 ? ' was' : 's were'} dropped on the slave) ` : '';
  const head = UNTRUSTED(ev.peer) + lost;
  const msg = { runId: ev.runId, address: ev.address, kind: ev.kind };
  if (ev.kind === 'report') Object.assign(msg, { status: ev.status, summary: head + ev.summary });
  else msg.text = head + ev.text;
  try { handle.deliver(msg); } catch (e) { console.warn('[peer-remote-host] deliver failed:', e.message); }
}

// ---------------------------------------------------------------------------
// Dashboard: app:peer:session:joinRuns { reqId?, peer, on } (owner only)
// ---------------------------------------------------------------------------
function ownerConnection(ws) {
  if (!ws) return false;
  if (typeof deps.isOwnerConnection === 'function') {
    try { return deps.isOwnerConnection(ws) === true; } catch { return false; }
  }
  return true;
}

async function handleWs(ws, msg, send) {
  if (msg?.type !== 'app:peer:session:joinRuns') return false;
  const reqId = typeof msg.reqId === 'string' ? msg.reqId.slice(0, 64) : null;
  const peer = typeof msg.peer === 'string' ? msg.peer.slice(0, 200) : '';
  const reply = (m) => send({ type: 'app:peer:session:joinRunsResult', reqId, peer, ...m });
  if (!ownerConnection(ws)) { reply({ ok: false, code: 'not-owner', error: 'only the owner may do this' }); return true; }
  if (!fleetPeers().some((p) => p.name === peer)) { reply({ ok: false, code: 'unknown-peer', error: `no linked peer "${peer}"` }); return true; }
  setJoinRuns(peer, msg.on === true);
  reply({ ok: true, on: msg.on === true });
  return true;
}

// ---------------------------------------------------------------------------

// A card filed before a restart has nobody waiting for it: withdrawn.
function withdrawOrphans() {
  try {
    const gov = deps.governance();
    for (const p of gov.listProposals({ status: 'pending', kind: agent().KIND }) || []) {
      if (p.origin === agent().ORIGIN && !pending.has(p.id)) gov.withdrawProposal(p.id, 'restart');
    }
  } catch {}
}

// options: { orchestration (core's ctx.orchestration), broadcaster,
// isOwnerConnection?, dataHome, isSlave?, governance?, master?, peerChannel?, pollMs? }
function init(options = {}) {
  shutdown();
  deps = {
    master: options.master ? () => options.master : () => require('./peer-remote-master'),
    agent: () => require('./peer-remote-agent'),
    governance: options.governance ? () => options.governance : () => require('./governance/horst-governance'),
    peerChannel: options.peerChannel ? () => options.peerChannel : () => require('./peer-channel'),
    isSlave: typeof options.isSlave === 'function' ? options.isSlave : null,
    isOwnerConnection: typeof options.isOwnerConnection === 'function' ? options.isOwnerConnection : null,
    dataHome: options.dataHome || null,
    pollMs: options.pollMs || POLL_MS,
  };
  if (deps.isSlave?.()) return;
  loadSwitches();
  withdrawOrphans();
  const reg = options.orchestration?.registerHostProvider;
  if (typeof reg === 'function') {
    try {
      const h = reg({ hosts, launch, kill });
      if (h && typeof h.deliver === 'function') handle = h;
    } catch (e) { console.warn('[peer-remote-host] host provider not registered:', e.message); }
  }
  unsubMsgs = master().onMemberMessage(onMemberMessage);
  master().setPeerExtras(runsView);
  try {
    unsubBroadcast = options.broadcaster?.onBroadcast?.((m) => {
      if (m?.type === 'horst:proposal' && pending.has(m.proposal?.id)) setImmediate(() => check(m.proposal.id));
      if (m?.type === 'app:fleet:state' && Array.isArray(m.peers)) pruneSwitches(m.peers);
    }) || null;
  } catch {}
}

function shutdown() {
  if (unsubMsgs) { try { unsubMsgs(); } catch {} unsubMsgs = null; }
  if (unsubBroadcast) { try { unsubBroadcast(); } catch {} unsubBroadcast = null; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  for (const id of [...pending.keys()]) settle(id, err('unavailable', 'the master is shutting down'));
  if (handle) { try { handle.unregister?.(); } catch {} handle = null; }
  try { if (deps.master) deps.master().setPeerExtras(null); } catch {}
}

module.exports = {
  init, shutdown, handleWs,
  // core's provider
  hosts, launch, kill,
  // peer-remote-agent's executor for an approved worker card
  approved,
  mayJoinRuns, setJoinRuns,
};
