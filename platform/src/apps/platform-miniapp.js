// The Vista Mini App — the surface where approvals are actually decided.
//
// /pro/horst/* is deliberately owner-cookie-authed and therefore unreachable
// from a Telegram webview, so the Mini App gets its own API under
// /pro/vista/api/*, self-authenticating through the shared initData exchange
// (tg-miniapp-auth.js) with a header of its own.
//
// These routes MIRROR the Horst ones — they do not reimplement them. Every one
// delegates to the same platform-horst/governance function the dashboard calls,
// so the ledger, the audit rows and the Telegram card-closing behave
// identically wherever the decision was made. The Mini App is a new surface,
// never a second decision funnel.
const crypto = require('crypto');
const express = require('express');
const miniAppAuth = require('./tg-miniapp-auth');

const KEY = '__platform__'; // platform-telegram.js bot key
const APP_PATH = '/pro/vista/';
// Distinct from tg-session's X-TG-Session: headers are global to the origin.
const SESSION_HEADER = 'X-Vista-Session';

// The statuses a proposal can actually hold. listProposals filters by EXACT
// status, so anything else silently returns an empty list rather than erroring
// — validate here instead of passing an invented value through.
const STATUSES = new Set(['pending', 'approved', 'executed', 'failed', 'denied', 'expired', 'withdrawn']);

function miniAppUrl() {
  return miniAppAuth.miniAppUrl(APP_PATH);
}

// Byte tickets for Files: <img>, <audio>, <video> and Telegram's downloadFile
// fetch a URL and cannot carry the bearer header, so the list hands out one
// URL per artifact signed with a per-process key — it opens that artifact's
// bytes and nothing else, until it expires (the next poll hands out fresh ones).
const TICKET_KEY = crypto.randomBytes(32);
const TICKET_TTL_MS = 6 * 60 * 60 * 1000;
const sign = (artifactId, exp) => crypto.createHmac('sha256', TICKET_KEY).update(`${artifactId}.${exp}`).digest('base64url');

// The expiry is rounded up to the hour, so a file's URL stays the same from
// poll to poll and the webview's cache holds.
function ticketFor(artifactId, now = Date.now()) {
  const hour = 60 * 60 * 1000;
  const exp = Math.ceil((now + TICKET_TTL_MS) / hour) * (hour / 1000);
  return `${exp}.${sign(artifactId, exp)}`;
}

function ticketValid(artifactId, k, now = Date.now()) {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(String(k || ''));
  if (!m || Number(m[1]) * 1000 < now) return false;
  const want = Buffer.from(sign(artifactId, Number(m[1])));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// A delivery as the Mini App shows it: its bytes behind a ticketed URL,
// relative to the page (the client's base is 'api').
function withSrc(d) {
  return { ...d, src: `api/artifacts/${encodeURIComponent(d.artifactId)}?k=${ticketFor(d.artifactId)}` };
}

// Mounted by platform/index.js on the pro router (auth-exempt subtree).
function mountApi(router) {
  const base = '/pro/vista/api';
  const { authed, resolveToken } = miniAppAuth.mountAuth(router, base, { key: KEY, header: SESSION_HEADER });
  const json = express.json({ limit: '1mb' });
  const jsonLarge = express.json({ limit: '25mb' }); // an edited mail body

  // Required lazily inside the handlers: platform-horst reaches back here for
  // the Mini App URL, so a top-level require would close a module cycle.
  const horst = () => require('./platform-horst');
  const emailEngine = () => require('./email-engine');

  router.get(`${base}/proposals`, authed(async (req, res) => {
    // Same pre-read the dashboard does: re-check the world before showing a
    // queue, so a proposal already overtaken by events says so on arrival.
    await require('./governance/horst-governance').refreshPending().catch(() => {});
    const status = STATUSES.has(req.query.status) ? req.query.status : 'pending';
    res.json({ proposals: horst().listProposals({ status, limit: 100 }) });
  }));

  // Never fails the request: proposalSource reports why it could not read the
  // mail instead of throwing, so a missing preview never blocks a decision.
  router.get(`${base}/proposals/:id/source`, authed(async (req, res) => {
    res.json(await horst().proposalSource(req.params.id, { full: req.query.full === '1' }));
  }));

  router.post(`${base}/proposals/:id/decide`, json, authed(async (req, res) => {
    const decision = String(req.body?.decision || '');
    if (decision !== 'approve' && decision !== 'deny') {
      return res.status(400).json({ error: 'decision must be approve or deny' });
    }
    // version: the payload version the detail view showed (governance.decide).
    res.json({ proposal: await horst().decideProposal(req.params.id, decision, 'miniapp', { version: req.body?.version ?? null }) });
  }));

  // Edit a pending proposal's payload — re-validated and re-frozen server-side
  // by governance.updateProposal, which also records the original draft so the
  // draft-vs-edit diff has a "before" to show.
  router.post(`${base}/proposals/:id/payload`, jsonLarge, authed(async (req, res) => {
    res.json({ proposal: require('./governance/horst-governance').updateProposal(req.params.id, req.body?.payload, 'miniapp') });
  }));

  // Only the two forms recorded on `prior` are reachable — the client cannot
  // name an arbitrary kind or payload.
  router.post(`${base}/proposals/:id/convert`, json, authed(async (req, res) => {
    res.json({ proposal: require('./governance/horst-governance').convertProposal(req.params.id, req.body?.to, 'miniapp') });
  }));

  router.post(`${base}/proposals/:id/undo`, json, authed(async (req, res) => {
    res.json({ proposal: horst().stageUndo(req.params.id, 'miniapp') });
  }));

  // Clearing a stale queue — the same batch the dashboard's Approvals view
  // calls. The loop, the bound (BATCH_MAX) and the "keep it" window (KEEP_MS)
  // all live in platform-horst, so the two surfaces cannot end up bounded
  // differently or teaching the decision ledger different things.
  router.post(`${base}/proposals/batch`, json, authed(async (req, res) => {
    try {
      res.json(await horst().batchProposals({ action: req.body?.action, ids: req.body?.ids, via: 'miniapp' }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  // --- read-only: mail, calendar and the briefing ------------------------------
  //
  // Writes are deliberately absent. This surface must not become a second,
  // ungoverned action path: acting on a mail here means STAGING a proposal
  // through the same funnel above, never sending directly. Every route below is
  // a GET, and test/vista-readonly.test.js asserts that structurally rather
  // than trusting this comment.

  // The morning briefing is composed on its own cron and journalled — it is
  // never pushed to the control chat, because it restates mail, proposals and
  // app state the owner has already seen. This is where it is read instead.
  // Same source as ctx.horst.briefing(): the newest journal entry, or null.
  router.get(`${base}/briefing`, authed(async (req, res) => {
    res.json({ briefing: horst().latestBriefing() });
  }));

  router.get(`${base}/mail/accounts`, authed(async (req, res) => {
    if (!emailEngine().isReady()) return res.json({ ready: false, accounts: [], folders: {} });
    const accounts = require('./email-accounts').list().map((a) => a.email);
    const folders = await emailEngine().folderCounts({}).catch(() => ({}));
    res.json({ ready: true, accounts, folders });
  }));

  router.get(`${base}/mail`, authed(async (req, res) => {
    if (!emailEngine().isReady()) return res.json({ ready: false, emails: [], total: 0 });
    // fields:'meta' leaves body/htmlBody undefined — that IS the "not hydrated"
    // signal for a list view, and it keeps the heavy columns off the wire.
    // attachment_meta IS in that column set, so chips render without a second
    // fetch per row.
    const r = await emailEngine().listEmails({
      account: req.query.account || undefined,
      folder: req.query.folder || undefined,
      limit: Math.min(Number(req.query.limit) || 50, 100),
      offset: Number(req.query.offset) || 0,
      fields: 'meta',
    }, 'horst');
    res.json({ ready: true, emails: r.emails, total: r.total });
  }));

  // Hydrate one message. The Mini App renders text, so it asks the engine's
  // read path for text — `html: 'text'` drops htmlBody and fills body from it.
  // The conversion used to live here, which is how the platform ended up with
  // no sanitiser at all: this surface sidestepped the problem instead of
  // solving it, and the next renderer had nothing to reuse.
  router.get(`${base}/mail/:account/:uid`, authed(async (req, res) => {
    if (!emailEngine().isReady()) return res.json({ missing: 'engine' });
    const mail = await emailEngine()
      .getEmail({ account: req.params.account, uid: req.params.uid, html: 'text' }, 'horst')
      .catch(() => null);
    if (!mail) return res.json({ missing: 'gone' });
    const body = String(mail.body || '');
    res.json({
      email: {
        ...mail,
        headers: undefined,
        body: body.slice(0, 40000),
        truncated: body.length > 40000,
        chars: body.length,
      },
    });
  }));

  // Also what the proposal detail view asks for to show the conflicts around a
  // calendar proposal's own day.
  router.get(`${base}/calendar/day`, authed(async (req, res) => {
    res.json(await horst().calendarDay({ date: String(req.query.date || ''), account: req.query.account }));
  }));

  // --- Files: what Horst delivered (agent/horst-deliveries.js) -----------------
  //
  // Reads plus the owner's one write, remove. The bytes route serves only an
  // artifact the deliveries ledger holds (removed ones refused), by artifact id
  // alone — no path ever reaches the filesystem (app-artifacts.sendBytes).
  const deliveries = () => require('./agent/horst-deliveries');

  router.get(`${base}/files`, authed(async (req, res) => {
    const kind = deliveries().KINDS.includes(req.query.kind) ? req.query.kind : undefined;
    const { files, counts } = deliveries().list({ kind, batch: req.query.batch ? String(req.query.batch) : undefined });
    res.json({ files: files.map(withSrc), counts });
  }));

  router.get(`${base}/files/:id`, authed(async (req, res) => {
    const d = deliveries().detail(String(req.params.id));
    if (!d) return res.status(404).json({ error: 'unknown file' });
    res.json({ file: withSrc(d.file), batch: d.batch.map(withSrc) });
  }));

  router.post(`${base}/files/:id/remove`, json, authed(async (req, res) => {
    res.json({ file: deliveries().remove(String(req.params.id)) });
  }));

  // The bearer header (a fetch) or the artifact's ticket (a media element, a
  // download). Range is answered, so audio and video seek.
  const bytes = async (req, res) => {
    const id = String(req.params.id || '');
    if (!resolveToken(req) && !ticketValid(id, req.query?.k)) return res.status(401).json({ error: 'unauthorized' });
    if (!deliveries().forArtifact(id)) return res.status(404).json({ error: 'not a delivered file' });
    require('./app-artifacts').sendBytes(req, res, id);
  };
  router.get(`${base}/artifacts/:id`, bytes);
}

module.exports = { mountApi, miniAppUrl, ticketFor, ticketValid, APP_PATH, SESSION_HEADER };
