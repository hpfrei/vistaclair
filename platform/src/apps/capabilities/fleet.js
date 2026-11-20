// Capability: fleet — master ⇄ slave federation: the app data publish and remote call / job (ctx.fleet), live peer channel senses, the read-only fleet view, and the governed publish/rollback/key-sync/restart kinds
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and vistaclair-pro/docs/capabilities.md.
//
// App-facing: `ctx.fleet` — the linked slaves running this app, the DATA
// publish of declared blobs from the app's .data to its copy there, and the
// slave-side receiver (docs/fleet-data.md; the engine is fleet-data.js and
// fleet-data-receive.js) — on a slave the same API publishes UP to its master
// (docs/fleet-data-up.md, fleet-data-up.js) — and the remote call / job on the app's copy there
// (docs/fleet-remote.md; fleet-remote.js and fleet-remote-host.js) — this
// module only scopes them to the calling app.
// Everything else here is platform-side: the peer-channel senses join the
// Triggers catalog, fleet_status joins the platform tool pack, and the fleet
// operations are approval-pinned governance kinds (docs/federation.md).

const PEER_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const META_MAX = 16 * 1024;

function requirePeer(name) {
  const peer = require('../peer-pairing').getPeer(String(name || ''));
  if (!peer) throw new Error(`unknown peer "${name}" — link a slave first`);
  return peer;
}

function requireApp(name) {
  if (!require('../app-manager').readManifest(String(name || ''))) throw new Error(`unknown app "${name}"`);
}

const engine = () => require('../fleet-data');
const receiver = () => require('../fleet-data-receive');
const hostSpecs = () => require('../host-specs');
const remote = () => require('../fleet-remote');
const remoteHost = () => require('../fleet-remote-host');
const up = () => require('../fleet-data-up');
// On a slave the data publish goes up to its master; on a master down to a slave.
const onSlave = () => { try { return require('../host-config').isSlave(); } catch { return false; } };

function fmtBytes(n) {
  if (n == null) return 'unknown';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

// One app's transfer, or null — an app never sees another app's record.
function ownTransfer(app, id) {
  const rec = (onSlave() ? up() : engine()).status(String(id || ''));
  return rec && rec.app === app ? rec : null;
}

async function cancelOwn(app, id) {
  if (!ownTransfer(app, id)) throw new Error(`unknown transfer "${id}"`);
  return (onSlave() ? up() : engine()).cancel(String(id));
}

function listOwn(app, { peer, name } = {}) {
  return (onSlave() ? up() : engine()).list({ app, peer: peer || undefined, name: name || undefined });
}

function planOwn(app, peer, { name, manifest } = {}) {
  return (onSlave() ? up() : engine()).plan(app, peer, { name, manifest });
}

// Who asked, on the slave: inside a remote job the master started, its id
// (the master checks that record's origin itself); else the local origin.
function slaveOrigin() {
  const base = remote().classifyOrigin();
  const rc = remoteHost().remoteContext();
  return rc?.via === 'job' && rc.id ? { ...base, remoteJob: rc.id } : base;
}

// One app's remote job record, or null.
function ownJob(app, id) {
  const rec = remote().status(String(id || ''));
  return rec && rec.app === app ? rec : null;
}

async function cancelOwnJob(app, id) {
  if (!ownJob(app, id)) throw new Error(`unknown remote job "${id}"`);
  return remote().cancel(String(id));
}

function remoteJobsList(app, { peer, kind, status } = {}) {
  return remote().list({ app, peer: peer || undefined, kind: kind || undefined, status: status || undefined });
}

// The owner's click runs at once (the click is the approval); everything else
// — an AI's tool call (Horst, an app session, a run's worker: a tool `caller`
// is in the context), cron, a bot update, an app user — is staged as an
// `app.data_publish` proposal the owner decides. The proposal is the
// platform's (no meta.app): the kind stays platform-owned.
async function dataPublish(app, peer, { name, manifest, meta } = {}) {
  // Up: the master decides (docs/fleet-data-up.md "Governance").
  if (onSlave()) return up().publish(app, peer, { name, manifest, meta, origin: slaveOrigin() });
  const sc = require('../spend-context');
  if (sc.principal() === 'owner' && !sc.caller()) {
    const r = await engine().start(app, peer, { name, manifest, meta, origin: { via: 'owner', app } });
    if (!r.attached) {
      const rec = engine().status(r.id);
      try {
        require('../governance/horst-governance').audit({
          action: 'executed', kind: 'app.data_publish', ok: true, via: `app:${app}`, proposalId: null,
          summary: `Data publish "${name}" of app "${app}" to slave "${rec?.peer || peer}" (${rec?.blobs ?? '?'} blobs, ${fmtBytes(rec?.totalBytes)}) — owner's click, transfer ${r.id}`,
        });
      } catch (err) { console.warn(`[fleet] ledger row for data publish ${r.id} failed: ${err.message}`); }
    }
    return { id: r.id, ...(r.attached ? { attached: true } : {}) };
  }
  if (meta !== undefined && meta !== null) {
    let raw;
    try { raw = JSON.stringify(meta); } catch { throw new Error('meta must be JSON'); }
    if (Buffer.byteLength(raw) > META_MAX) throw new Error(`meta is over ${META_MAX / 1024} KB`);
  }
  const st = await engine().stage(app, peer, { name, manifest });
  let needBytes = null;
  let fits = null;
  try { const p = await engine().plan(app, peer, { name, manifest }); needBytes = p.needBytes; fits = p.fits; } catch {}
  const payload = {
    app, peer: st.peer, name, manifestSha: st.manifestSha, blobs: st.blobs, totalBytes: st.totalBytes,
    needBytes, fits, meta: meta == null ? null : JSON.parse(JSON.stringify(meta)),
  };
  const r = await require('../governance/horst-governance').requestAction('app.data_publish', payload, {
    origin: sc.caller()?.type || sc.origin() || 'app',
  });
  return { id: st.id, proposed: true, proposalId: r.proposal?.id || null };
}

// The card of app.remote_call / app.remote_job: app, slave, name, the args
// summary and their sha (what an approval binds to), who asked.
function remoteCard(p, { icon, title, nameLabel, name, footer }) {
  const o = p.origin || {};
  const who = [o.kind, o.tool, o.route].filter(Boolean).join(' · ');
  return {
    render: 'generic',
    icon,
    title,
    subtitle: `app ${p.app}`,
    accent: null,
    fields: [
      { label: 'App', kind: 'text', value: String(p.app) },
      { label: 'Slave', kind: 'text', value: String(p.peer) },
      { label: nameLabel, kind: 'text', value: String(name) },
      { label: 'Args', kind: 'code', value: String(p.argsSummary ?? '') },
      { label: 'Args sha256', kind: 'text', value: String(p.argsSha) },
      { label: 'Args size', kind: 'text', value: `${p.argsBytes ?? '?'} bytes` },
      { label: 'Asked by', kind: 'text', value: who || 'unknown' },
    ],
    footer,
  };
}

// ---- App events: the engine's progress → the app's iframe (Bridge.subscribe),
// on the same app:bridge:event path as job:update. `side` is the host end
// (master | slave), `dir` the direction (down = master → slave, up = slave →
// master), `role` sender | receiver. Records carry the transfer id (both ends
// of an up publish); a down publish's receiving slave has "<name>.<manifestSha>".
function masterHost() {
  try { return new URL(require('../host-config').slaveInfo()?.masterUrl).hostname; } catch { return null; }
}

// The app-facing payload of a data publish event, one shape for the Bridge
// (fleet:data:*) and routes.js (ctx.fleet.dataPublish.on).
//   source 'record' — fleet-data.js (the master's records, both directions) or
//                     fleet-data-up.js (the slave's view of its up publishes)
//   source 'inbox'  — fleet-data-receive.js on a slave receiving a down publish
function dataEventPayload(source, event, d) {
  const dir = d.dir === 'up' ? 'up' : 'down';
  if (source === 'record') {
    const side = d.side === 'slave' ? 'slave' : 'master';
    const role = (side === 'master') === (dir === 'down') ? 'sender' : 'receiver';
    return event === 'fleet:data:progress'
      ? { side, dir, role, id: d.id, peer: d.peer, name: d.name, sentBytes: d.sentBytes, needBytes: d.needBytes, blobs: d.blobs, phase: d.phase, label: d.label ?? null }
      : { side, dir, role, id: d.id, peer: d.peer, name: d.name, ok: d.ok, summary: d.summary ?? null };
  }
  const id = `${d.name}.${d.manifestSha}`;
  return event === 'fleet:data:progress'
    ? { side: 'slave', dir, role: 'receiver', id, peer: masterHost(), name: d.name, manifestSha: d.manifestSha, sentBytes: d.receivedBytes, needBytes: d.needBytes, blobs: d.blobs, phase: d.phase, label: d.label ?? null }
    : { side: 'slave', dir, role: 'receiver', id, peer: masterHost(), name: d.name, manifestSha: d.manifestSha, ok: d.ok, summary: d.summary ?? null };
}

// The three event sources of an app's data publishes, one subscription: the
// master's records, the slave's up records, a down publish's inbox here. An
// up publish's inbox on the master is covered by its record (same id both ends).
function subscribeData(fn) {
  const offs = [
    engine().subscribe((ev, d) => fn(ev, d, dataEventPayload('record', ev, { ...d, side: 'master' }))),
    up().subscribe((ev, d) => fn(ev, d, dataEventPayload('record', ev, { ...d, side: 'slave' }))),
    receiver().subscribe((ev, d) => { if (d.dir !== 'up') fn(ev, d, dataEventPayload('inbox', ev, d)); }),
  ];
  return () => { for (const off of offs) off(); };
}

// The remote job events without `app` (the iframe and routes.js are the app).
function jobEventPayload(d) {
  const { app, ...rest } = d;
  return rest;
}

// routes.js: ctx.fleet.dataPublish.on('progress' | 'done', fn) → off, both
// ends of this app's publishes; dropped when the app stops.
function onDataEvent(app, event, fn) {
  if (event !== 'progress' && event !== 'done') throw new Error("event must be 'progress' or 'done'");
  if (typeof fn !== 'function') throw new Error('listener must be a function');
  const want = event === 'progress' ? 'fleet:data:progress' : 'fleet:data:done';
  const call = (payload) => {
    try {
      const r = fn(payload);
      if (r && typeof r.catch === 'function') r.catch((err) => { try { require('../app-guard').record(app, 'fleet.dataPublish.on', err); } catch {} });
    } catch (err) { try { require('../app-guard').record(app, 'fleet.dataPublish.on', err); } catch {} }
  };
  const off = subscribeData((ev, d, payload) => { if (ev === want && d.app === app) call(payload); });
  return remote().trackAppListener(app, off);
}

function wireAppEvents(broadcaster) {
  if (!broadcaster) return () => {};
  const send = (appName, event, data) => {
    try { broadcaster.broadcast({ type: 'app:bridge:event', appName, event, data }); } catch {}
  };
  const offData = subscribeData((event, d, payload) => send(d.app, event, payload));
  // Remote jobs (fleet-remote.js): fleet:job:progress / fleet:job:done.
  const offJobs = remote().subscribe((event, d) => send(d.app, event, jobEventPayload(d)));
  return () => { offData(); offJobs(); };
}

module.exports = {
  key: 'fleet',
  title: 'Fleet (Master / Slave Federation)',
  core: false,
  gated: false,
  methods: ['fleet.peers', 'fleet.self', 'fleet.dataPublish.plan', 'fleet.dataPublish.status', 'fleet.dataPublish.cancel', 'fleet.jobs.status', 'fleet.jobs.cancel'],
  prefixes: ['fleet.'],
  ctx: ['fleet'],
  // The engine lives in the dashboard process; an own-process runner would
  // drive a second copy of it on the same records — no ctx.fleet there (its
  // iframe still has the Bridge methods, which run in the dashboard).
  visibility: { standalone: false },
  flags: {
    'fleet.sync': () => {
      try { return typeof engine().start === 'function' && typeof receiver().registerReceiver === 'function'; } catch { return false; }
    },
    // The up direction: a slave's publish to its master (docs/fleet-data-up.md).
    'fleet.sync.up': () => {
      try { return typeof up().publish === 'function' && typeof up().handleRequest === 'function' && typeof require('../peer-channel').askMaster === 'function'; } catch { return false; }
    },
    // Peer hardware specs: peers()[].specs and self() (docs/fleet-specs.md).
    'fleet.specs': () => {
      try { const h = require('../host-specs'); return typeof h.get === 'function' && typeof h.clean === 'function'; } catch { return false; }
    },
    // Remote call on the app's copy on a slave (docs/fleet-remote.md).
    'fleet.call': () => {
      try { return typeof remote().call === 'function' && typeof remoteHost().registerCall === 'function'; } catch { return false; }
    },
    // Remote jobs there, their progress pushed back.
    'fleet.jobs': () => {
      try { return typeof remote().start === 'function' && typeof remoteHost().registerJob === 'function'; } catch { return false; }
    },
  },
  summary: '`ctx.fleet` — slaves, specs; data publish; remote call / job',
  keywords: /\b(federation|fleet|slaves?|peer host|publish to (a )?(peer|slave|master)|data ?publish|dataPublish|onDataReceive|fleet\.master|fleet\.sync|fleet\.call|fleet\.jobs|onCall|onJob|remote (call|job|build))\b/i,

  buildCtx(app) {
    const name = app.name;
    const publish = (peer, opts) => dataPublish(name, peer, opts);
    publish.plan = (peer, { name: n, manifest } = {}) => planOwn(name, peer, { name: n, manifest });
    publish.status = (id) => ownTransfer(name, id);
    publish.cancel = (id) => cancelOwn(name, id);
    publish.list = ({ peer, name: n } = {}) => listOwn(name, { peer, name: n });
    publish.on = (event, fn) => onDataEvent(name, event, fn);
    return {
      fleet: {
        peers: () => engine().peers(name),
        master: () => up().master(name),
        self: () => hostSpecs().get(),
        dataPublish: publish,
        onDataReceive: (pattern, hooks) => receiver().registerReceiver(name, pattern, hooks),
        call: (peer, n, args, opts = {}) => remote().call(name, peer, n, args, opts || {}),
        jobs: {
          start: (peer, kind, args, opts = {}) => remote().start(name, peer, kind, args, opts || {}),
          status: (id) => ownJob(name, id),
          cancel: (id) => cancelOwnJob(name, id),
          list: (filter = {}) => remoteJobsList(name, filter || {}),
          on: (event, fn) => remote().on(name, event, fn),
        },
        onCall: (n, fn, opts = {}) => remoteHost().registerCall(name, n, fn, opts || {}),
        onJob: (kind, fn) => remoteHost().registerJob(name, kind, fn),
      },
    };
  },

  bridge: {
    'fleet.peers': async (app) => engine().peers(app.name),
    'fleet.self': async () => hostSpecs().get(),
    'fleet.dataPublish.plan': async (app, params) => {
      const { peer, name, manifest } = params || {};
      return planOwn(app.name, peer, { name, manifest });
    },
    'fleet.dataPublish.status': async (app, params) => {
      if (params?.id) return ownTransfer(app.name, params.id);
      return listOwn(app.name, { peer: params?.peer, name: params?.name });
    },
    'fleet.dataPublish.cancel': async (app, params) => {
      if (!params?.id) throw new Error('id required');
      return cancelOwn(app.name, params.id);
    },
    'fleet.jobs.status': async (app, params) => {
      if (params?.id) return ownJob(app.name, params.id);
      return remoteJobsList(app.name, { peer: params?.peer, kind: params?.kind });
    },
    'fleet.jobs.cancel': async (app, params) => {
      if (!params?.id) throw new Error('id required');
      return cancelOwnJob(app.name, params.id);
    },
  },

  wireAppEvents,

  // ---- Horst facet: fleet senses, read-only fleet view, governed fleet ops ---
  horst: {
    lane: {
      direct: { 'fleet.peers': 'fleet_status', 'fleet.self': 'fleet_status', 'fleet.dataPublish.status': 'fleet_data_transfers', 'fleet.jobs.status': 'fleet_remote_jobs' },
      never: ['fleet.dataPublish.plan', 'fleet.dataPublish.cancel', 'fleet.jobs.cancel'],
      why: 'a data publish needs a manifest and a remote call / job its args, both only the app builds: Horst asks through the app\'s own tool, whose ctx.fleet.dataPublish / call / jobs.start stage app.data_publish / app.remote_call / app.remote_job (call and start are ctx-only, card through those kinds); plan and cancel are the app\'s own controls',
    },
    brief: 'fleet: linked slaves — publish + rollback, key sync, slave restart, peer.session.launch; app data publish and remote call / job on the app\'s copy (app.data_publish / remote_call / remote_job, staged by the app\'s tool) — all approval-pinned',
    senses: [
      { kind: 'peer:connected', description: 'The live channel to a linked slave server came up', defaultPolicy: 'agenda' },
      { kind: 'peer:disconnected', description: 'The live channel to a linked slave server went down', defaultPolicy: 'notify' },
      { kind: 'peer:app:error', description: 'An app on a slave threw outside a request (attributed by that host\'s app guard)', defaultPolicy: 'agenda' },
      { kind: 'peer:app:crashloop', description: 'An app on a slave failed repeatedly within a minute', defaultPolicy: 'notify' },
      { kind: 'peer:app:health', description: 'An app on a slave changed health state', defaultPolicy: 'agenda' },
      { kind: 'peer:pressure', description: 'A slave host entered or left resource pressure (low memory/disk, high load)', defaultPolicy: 'notify' },
      { kind: 'peer:summary', description: 'A slave\'s daily spend/storage summary arrived', defaultPolicy: 'agenda' },
      { kind: 'fleet:data:done', description: 'An app\'s data publish to or from a slave finished (ok, or failed with the reason)', defaultPolicy: 'agenda' },
      { kind: 'fleet:job:done', description: 'An app\'s remote job on a slave ended (done, failed or cancelled)', defaultPolicy: 'agenda' },
    ],
    wire({ publish }) {
      // The master's data publishes: one event at the end of each transfer.
      const offData = engine().subscribe((event, d) => {
        if (event !== 'fleet:data:done') return;
        const dir = d.dir === 'up' ? 'up' : 'down';
        publish('fleet:data:done', { id: d.id, app: d.app, peer: d.peer, name: d.name, dir, ok: d.ok, summary: d.summary ?? null },
          // No dedupeKey: a re-run of the same transfer id ends again, and a
          // route waiting on ctx.events.subscribe must see that end too.
          { summary: `Data publish "${d.name}" of "${d.app}" ${dir === 'up' ? 'from' : 'to'} "${d.peer}" ${d.ok ? 'done' : 'failed'}${d.ok ? '' : `: ${String(typeof d.summary === 'string' ? d.summary : '').slice(0, 80)}`}`.slice(0, 160) });
      });
      // The master's remote jobs: one event at the end of each.
      const offJobs = remote().subscribe((event, d) => {
        if (event !== 'fleet:job:done') return;
        publish('fleet:job:done', { id: d.id, app: d.app, peer: d.peer, kind: d.kind, ok: d.ok },
          { summary: `Remote job "${d.kind}" of "${d.app}" on "${d.peer}" ${d.status}${d.ok || !d.error ? '' : `: ${String(d.error).slice(0, 80)}`}`.slice(0, 160) });
      });
      // Everything below arrives over the peer channel, already guarded at
      // ingest (frame/rate caps there, per-kind rate/storm caps in the bus).
      // host + hop tag the envelope as relayed from another host of the fleet.
      const offPeer = require('../peer-channel').onEvent((ev) => {
        const tag = (extra) => ({ host: ev.peer, hop: 1, ...extra });
        if (ev.type === 'connected') {
          publish('peer:connected', { host: ev.peer }, tag({ dedupeKey: `peer:${ev.peer}`, summary: `Slave "${ev.peer}" connected` }));
        } else if (ev.type === 'disconnected') {
          publish('peer:disconnected', { host: ev.peer }, tag({ dedupeKey: `peer:${ev.peer}`, summary: `Slave "${ev.peer}" disconnected` }));
        } else if (ev.type === 'app:error') {
          publish('peer:app:error', { host: ev.peer, app: ev.app, surface: ev.surface, error: ev.error, count: ev.count },
            tag({ dedupeKey: `peer:${ev.peer}:${ev.app}`, summary: `[${ev.peer}] app "${ev.app}" error (${ev.surface}): ${String(ev.error || '').slice(0, 120)}` }));
        } else if (ev.type === 'app:crashloop') {
          publish('peer:app:crashloop', { host: ev.peer, app: ev.app, count: ev.count, lastError: ev.lastError },
            tag({ dedupeKey: `peer:${ev.peer}:${ev.app}`, summary: `[${ev.peer}] app "${ev.app}" is crash-looping (${ev.count} failures)` }));
        } else if (ev.type === 'health') {
          publish('peer:app:health', { host: ev.peer, app: ev.app, from: ev.from, to: ev.to },
            tag({ dedupeKey: `peer:${ev.peer}:${ev.app}`, summary: `[${ev.peer}] app "${ev.app}" health: ${ev.from} → ${ev.to}` }));
        } else if (ev.type === 'pressure') {
          publish('peer:pressure', { host: ev.peer, state: ev.state, reasons: ev.reasons },
            tag({ dedupeKey: `peer:${ev.peer}`, summary: ev.state === 'pressure' ? `[${ev.peer}] host under pressure: ${(ev.reasons || []).join(', ')}`.slice(0, 120) : `[${ev.peer}] host pressure cleared` }));
        } else if (ev.type === 'summary') {
          const total = Object.values(ev.apps || {}).reduce((n, a) => n + (a.costUsd || 0), 0);
          publish('peer:summary', { host: ev.peer, apps: ev.apps },
            tag({ dedupeKey: `peer:${ev.peer}`, summary: `[${ev.peer}] daily summary: $${total.toFixed(2)} across ${Object.keys(ev.apps || {}).length} app(s)` }));
        }
        // ev.type === 'job' feeds the dashboard fleet panel only — the
        // master-side publish/rollback job already senses failures locally.
      });
      return () => { offData(); offJobs(); if (typeof offPeer === 'function') offPeer(); };
    },
    tools: [
      {
        def: {
          name: 'fleet_status',
          description: 'The fleet: every linked slave server with live channel state (connected, last seen), software versions, per-app health, deployed commit per app and how many commits touching that app it is behind the master\'s HEAD, plus the last publish/rollback job seen per app, and each slave\'s hardware specs (OS, CPU, RAM, GPUs, display, load, installed extras; `self` is this host). Read-only.',
          inputSchema: { type: 'object', properties: {} },
        },
        handler: async () => {
          const { textResult } = require('../horst-facet');
          const state = await require('../peer-channel').fleetStateDetailed();
          if (!state.peers.length) return textResult('No slave servers are linked.');
          // `specs` per slave are in the state; this host's own join them.
          return textResult({ ...state, self: await require('../host-specs').get().catch(() => null) });
        },
      },
      {
        def: {
          name: 'fleet_data_transfers',
          description: 'App data publishes between this master and its slaves (an app\'s .data blobs to its copy on a slave, dir "down", or from a slave\'s copy to this master, dir "up"): the recent transfers with app, slave, direction, name, status, phase, bytes sent of needed, blob counts, the receiver\'s summary or the error. Read-only.',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string', description: 'One app (default: every app).' },
            peer: { type: 'string', description: 'One slave.' },
            limit: { type: 'number', description: 'Max rows (default 20, max 200).' },
          } },
        },
        handler: async (args) => {
          const { textResult, limitOf } = require('../horst-facet');
          const rows = engine().list({ app: args.app || undefined, peer: args.peer || undefined })
            .slice(0, limitOf(args.limit, 20, 200))
            .map((r) => ({ id: r.id, app: r.app, peer: r.peer, dir: r.dir || 'down', name: r.name, status: r.status, phase: r.phase, sentBytes: r.sentBytes, needBytes: r.needBytes, blobs: r.blobs, blobsNeed: r.blobsNeed, blobsDone: r.blobsDone, summary: r.summary, error: r.error, origin: r.origin, startedAt: r.startedAt, finishedAt: r.finishedAt }));
          return textResult(rows.length ? rows : 'No data publishes.');
        },
      },
      {
        def: {
          name: 'fleet_remote_jobs',
          description: 'Remote jobs apps started on their own copy on a slave (e.g. a build on a stronger host): app, slave, kind, status, link, progress, the error, the origin and the proposal that approved it. Read-only.',
          inputSchema: { type: 'object', properties: {
            app: { type: 'string', description: 'One app (default: every app).' },
            peer: { type: 'string', description: 'One slave.' },
            status: { type: 'string', description: 'starting | running | done | failed | cancelled.' },
            limit: { type: 'number', description: 'Max rows (default 20, max 200).' },
          } },
        },
        handler: async (args) => {
          const { textResult, limitOf } = require('../horst-facet');
          const rows = remote().list({ app: args.app || undefined, peer: args.peer || undefined, status: args.status || undefined })
            .slice(0, limitOf(args.limit, 20, 200))
            .map((r) => ({ id: r.id, app: r.app, peer: r.peer, kind: r.kind, status: r.status, link: r.link, progress: r.progress, error: r.error, code: r.code, origin: r.origin, proposalId: r.proposalId, startedAt: r.startedAt, endedAt: r.endedAt }));
          return textResult(rows.length ? rows : 'No remote jobs.');
        },
      },
    ],
    kinds: {
      // All of them are ceiling-PINNED to propose: fleet operations touch another
      // host and always pass a human (05-federation.md 5D). peer.kill has no
      // kind at all — the kill-switch stays owner-click-only.
      'app.publish': {
        approveFrom: (proposal, via) => require('../peer-security').ownerOnlyApproveFrom(proposal, via),
        identity: null, // each request is its own act, not a re-derivation
        label: 'Publish app to slave',
        about: 'Runs the standard publish job: commits/pushes if needed, ships the app\'s code bundle to the slave, installs dependencies and the toolchain extras its manifest.toolchains names that the slave lacks (Unity: ~20 GB), restarts and health-checks it there. No app data travels (that is app.data_publish).',
        pinNote: 'Publishing replaces the app\'s code on another server — always human-approved.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app'); req(p, 'peer');
          requireApp(p.app);
          requirePeer(p.peer);
        },
        describe: (p) => {
          const tc = require('../app-manager').readManifest(p.app)?.toolchains;
          const tcNote = Array.isArray(tc) && tc.length ? ` (installs its toolchains there if missing: ${tc.join(', ')})` : '';
          return `Publish app "${p.app}" to slave "${p.peer}"${tcNote}`;
        },
        execute(p) {
          const { jobId } = require('../publish').startPublish({ appName: p.app, peer: p.peer });
          return { ok: true, jobId, summary: `Publish of "${p.app}" to "${p.peer}" started (job ${jobId}) — progress in the publish wizard / fleet panel` };
        },
      },

      'app.data_publish': {
        approveFrom: (proposal, via) => require('../peer-security').ownerOnlyApproveFrom(proposal, via),
        // Same direction + app + slave + name + manifest = the same transfer
        // (resumed), so a second request for it collapses into the pending card.
        identity: (p) => `data_publish:${p.dir === 'up' ? 'up:' : ''}${p.app}:${p.peer}:${p.name}:${p.manifestSha}`,
        label: 'Publish app data between master and slave',
        about: 'Streams the blobs an app declared (files from its .data) to the same app on the other host — down: from this master to a linked slave; up: from a slave to this master (docs/fleet-data-up.md) — where each sha256 is verified and the app\'s receive hook imports them. Resumable; blobs the receiver already holds are not sent. No code changes.',
        pinNote: 'Copies data to another server (or onto this one, from a slave) and has its app import it — always human-approved. An owner\'s click in the app itself, or a remote job the owner started or approved, runs directly and is recorded here.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          const M = require('../fleet-data-manifest');
          req(p, 'app'); req(p, 'peer'); req(p, 'name'); req(p, 'manifestSha');
          if (p.dir != null && p.dir !== 'up' && p.dir !== 'down') throw new Error("dir must be 'down' or 'up'");
          requireApp(p.app);
          requirePeer(p.peer);
          if (!M.isName(p.name)) throw new Error('name must match [a-z0-9._-]{1,64}');
          if (!M.isSha(p.manifestSha)) throw new Error('manifestSha must be 64 lowercase hex chars');
          if (!engine().stagedManifest(p.manifestSha)) throw new Error(`no staged manifest ${p.manifestSha.slice(0, 12)}… — the app stages it through ctx.fleet.dataPublish`);
        },
        describe: (p) => (p.dir === 'up'
          ? `Receive data "${p.name}" of app "${p.app}" from slave "${p.peer}" onto this master (${p.blobs ?? '?'} blobs, ${p.needBytes == null ? `up to ${fmtBytes(p.totalBytes)}` : `${fmtBytes(p.needBytes)} to receive`})`
          : `Publish data "${p.name}" of app "${p.app}" to slave "${p.peer}" (${p.blobs ?? '?'} blobs, ${p.needBytes == null ? `up to ${fmtBytes(p.totalBytes)}` : `${fmtBytes(p.needBytes)} to send`})`),
        card: (p) => {
          const isUp = p.dir === 'up';
          const o = p.origin || {};
          const who = [o.kind, o.tool, o.route].filter(Boolean).join(' · ');
          return {
            render: 'generic',
            icon: '📦',
            title: isUp ? `Receive app data from "${p.peer}"` : `Publish app data to "${p.peer}"`,
            subtitle: `app ${p.app}`,
            accent: p.fits === false ? 'warn' : null,
            fields: [
              { label: 'Direction', kind: 'text', value: isUp ? `up: slave "${p.peer}" → this master` : `down: this master → slave "${p.peer}"` },
              { label: 'App', kind: 'text', value: String(p.app) },
              { label: 'Slave', kind: 'text', value: String(p.peer) },
              { label: 'Name', kind: 'text', value: String(p.name) },
              { label: 'Blobs', kind: 'text', value: String(p.blobs ?? '?') },
              { label: isUp ? 'To receive' : 'To send', kind: 'text', value: p.needBytes == null ? `unknown (${isUp ? "this master's receiver did not answer" : 'slave not reachable'} at staging) — up to ${fmtBytes(p.totalBytes)}` : fmtBytes(p.needBytes) },
              { label: 'Total', kind: 'text', value: fmtBytes(p.totalBytes) },
              ...(isUp ? [{ label: 'Asked by', kind: 'text', value: `${who || 'unknown'} on "${p.peer}"` }] : []),
            ],
            warn: p.fits === false ? (isUp ? 'This master has too little free space for this delta: the transfer will fail before receiving.' : 'The slave reported too little free space for this delta: the transfer will fail before sending.') : null,
            footer: isUp
              ? 'Approving pulls these blobs from the slave into this master; the app here imports them when all have arrived. Nothing is rolled back.'
              : 'Approving streams these blobs to the app on the slave; it imports them when all have arrived. Nothing is rolled back.',
          };
        },
        async execute(p, proposal) {
          const dir = p.dir === 'up' ? 'up' : 'down';
          const r = await engine().startStaged(p.app, p.peer, { name: p.name, manifestSha: p.manifestSha, meta: p.meta ?? null, dir, origin: { ...(dir === 'up' && p.origin ? p.origin : {}), via: 'governance', proposalId: proposal?.id || null } });
          return { ok: true, id: r.id, summary: `Data publish "${p.name}" of "${p.app}" ${dir === 'up' ? 'from' : 'to'} "${p.peer}" ${r.attached ? 'is already running' : 'started'} (transfer ${r.id})` };
        },
      },

      // Remote call / job on an app's own copy on a slave (fleet-remote.js).
      // The owner's click runs at once (ledgered there); these cards are for
      // every other origin. A readOnly handler never reaches them.
      'app.remote_call': {
        approveFrom: (proposal, via) => require('../peer-security').ownerOnlyApproveFrom(proposal, via),
        // The same call with the same args collapses into the pending card.
        identity: (p) => `remote_call:${p.app}:${p.peer}:${p.name}:${p.argsSha}`,
        label: 'Remote call on slave',
        about: 'Lets an app call a named handler of its own copy on a linked slave with exactly these args. A call is synchronous: approving grants ONE identical retry (same app, slave, name and args sha) within 10 minutes; the app makes it.',
        pinNote: 'Runs app code on another server for a caller that is not the owner\'s click — always human-approved. The owner\'s click in the app runs directly and is recorded here.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          const W = require('../fleet-remote-wire');
          req(p, 'app'); req(p, 'peer'); req(p, 'name'); req(p, 'argsSha');
          requireApp(p.app);
          requirePeer(p.peer);
          if (!W.isName(p.name)) throw new Error('name must match [a-z0-9._:-]{1,64}');
          if (!/^[0-9a-f]{64}$/.test(String(p.argsSha))) throw new Error('argsSha must be 64 lowercase hex chars');
        },
        describe: (p) => `Remote call "${p.name}" of app "${p.app}" on slave "${p.peer}" (args ${String(p.argsSha).slice(0, 12)}…)`,
        card: (p) => remoteCard(p, { icon: '📡', title: `Remote call on "${p.peer}"`, nameLabel: 'Call', name: p.name,
          footer: 'Approving lets the app make this exact call once within 10 minutes (it retries on its own). Nothing runs until then.' }),
        execute(p, proposal) {
          const g = remote().addGrant(p, proposal);
          return { ok: true, summary: `Remote call "${p.name}" of "${p.app}" on "${p.peer}" approved: one identical retry until ${new Date(g.expiresAt).toISOString()}` };
        },
      },

      'app.remote_job': {
        approveFrom: (proposal, via) => require('../peer-security').ownerOnlyApproveFrom(proposal, via),
        identity: (p) => `remote_job:${p.app}:${p.peer}:${p.kind}:${p.argsSha}`,
        label: 'Remote job on slave',
        about: 'Starts a job of an app on its own copy on a linked slave (its onJob handler) with exactly these args; progress comes back live to the app here. Cancel stays the app\'s.',
        pinNote: 'Starts work on another server for a caller that is not the owner\'s click — always human-approved. The owner\'s click in the app runs directly and is recorded here.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          const W = require('../fleet-remote-wire');
          req(p, 'app'); req(p, 'peer'); req(p, 'kind'); req(p, 'id'); req(p, 'argsSha');
          requireApp(p.app);
          requirePeer(p.peer);
          if (!W.isName(p.kind)) throw new Error('kind must match [a-z0-9._:-]{1,64}');
          if (!W.isId(p.id)) throw new Error('bad remote job id');
          if (!/^[0-9a-f]{64}$/.test(String(p.argsSha))) throw new Error('argsSha must be 64 lowercase hex chars');
        },
        describe: (p) => `Remote job "${p.kind}" of app "${p.app}" on slave "${p.peer}" (args ${String(p.argsSha).slice(0, 12)}…)`,
        card: (p) => remoteCard(p, { icon: '🛠️', title: `Remote job on "${p.peer}"`, nameLabel: 'Job', name: p.kind,
          footer: 'Approving starts this job on the slave under the app\'s record; denying ends that record.' }),
        execute: (p, proposal) => remote().startApproved(p, proposal),
      },

      'app.rollback': {
        approveFrom: (proposal, via) => require('../peer-security').ownerOnlyApproveFrom(proposal, via),
        identity: null, // each request is its own act, not a re-derivation
        label: 'Roll back app on slave',
        about: 'Re-installs a previously published code bundle the slave kept (.peer-bundles), restarts and health-checks the app there. Data is not rolled back.',
        pinNote: 'Rolling back replaces the app\'s code on another server — always human-approved.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'app'); req(p, 'peer'); req(p, 'commit');
          requireApp(p.app);
          requirePeer(p.peer);
          if (!/^[0-9a-f]{7,40}$/i.test(String(p.commit))) throw new Error('commit must be a git sha');
        },
        describe: (p) => `Roll back app "${p.app}" on slave "${p.peer}" to ${String(p.commit).slice(0, 10)}`,
        execute(p) {
          const { jobId } = require('../publish').startRollback({ appName: p.app, peer: p.peer, commit: p.commit });
          return { ok: true, jobId, summary: `Rollback of "${p.app}" on "${p.peer}" to ${String(p.commit).slice(0, 10)} started (job ${jobId})` };
        },
      },

      'peer.keys.sync': {
        approveFrom: (proposal, via) => require('../peer-security').ownerOnlyApproveFrom(proposal, via),
        identity: null, // each request is its own act, not a re-derivation
        label: 'Sync API keys to slave',
        about: 'Pushes this master\'s provider API keys, per-model key overrides and model registry to the slave\'s encrypted key store (merge mode — nothing is deleted there).',
        pinNote: 'Real credentials cross the wire to another server — always human-approved.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'peer');
          if (!PEER_RE.test(String(p.peer))) throw new Error('bad peer name');
          requirePeer(p.peer);
        },
        describe: (p) => `Sync this master's API keys and model registry to slave "${p.peer}" (merge)`,
        async execute(p) {
          const r = await require('../peer-keys').syncToPeer(p.peer, { replace: false });
          return { ok: true, ...r, summary: `Keys synced to "${p.peer}"` };
        },
      },

      'peer.restart': {
        approveFrom: (proposal, via) => require('../peer-security').ownerOnlyApproveFrom(proposal, via),
        identity: null, // a repeat run is a legitimate retry, never a duplicate
        label: 'Restart slave server',
        about: 'Restarts the whole vistaclair instance on the slave (the same restart path the slave\'s own dashboard uses). Its apps are briefly unavailable while it comes back.',
        pinNote: 'Restarting another server is disruptive — always human-approved. The kill-switch has no kind at all (owner-click only).',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'peer');
          requirePeer(p.peer);
        },
        describe: (p) => `Restart vistaclair on slave "${p.peer}"`,
        async execute(p) {
          const peer = requirePeer(p.peer);
          await require('../peer-client').call(peer, '/restart', { method: 'POST', timeoutMs: 15000 });
          return { ok: true, summary: `Restart sent to "${p.peer}"` };
        },
      },

      // Requested by Horst (propose markers) or a run's launch_cli({ host })
      // (peer-remote-host.js); the owner launches (peer-remote-agent.js).
      'peer.session.launch': {
        identity: null, // every request is its own launch, never a duplicate
        label: 'Launch remote session on slave',
        about: 'Launches an Agent SDK session (simple, orchestrator, or a worker of a run on this master) for an app on the slave with exactly the prompt shown; it appears as a tab here, its questions come to the owner.',
        pinNote: 'A session on another server runs a prompt an agent wrote, on that server\'s Claude login or API key — always human-approved, one card per launch.',
        ceiling: 'propose',
        defaultLevel: 'propose',
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'peer');
          requirePeer(p.peer);
          require('../peer-remote-agent').checkPayload(p);
        },
        describe: (p) => require('../peer-remote-agent').describe(p),
        card: (p, proposal) => require('../peer-remote-agent').card(p, proposal),
        approveFrom: (proposal, via) => require('../peer-remote-agent').approveFrom(proposal, via),
        execute: (p, proposal) => require('../peer-remote-agent').execute(p, proposal),
      },
    },
  },
};
