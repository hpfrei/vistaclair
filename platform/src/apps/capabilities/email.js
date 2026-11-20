// Capability: email — `accounts.email.*`, `email.list/get/send/…` — always-synced master mail store
//
// One file per capability: the metadata the registry/prompts read, the
// routes.js ctx members it contributes (buildCtx) and the iframe bridge
// methods it dispatches (bridge). See src/apps/capabilities.js for the
// contract and docs/capabilities.md.

// email.modify plus the sugar verbs — thin wrappers over the canonical modify.
async function modify(app, params, io) {
  const engine = require('../email-engine');
  const method = io.method;
  const appName = app.name;
  const hasBatch = Array.isArray(params.uids) && params.uids.length > 0;
  if (!params.account || (params.uid == null && !hasBatch)) throw new Error('account and uid (or uids) required');
  // Optimistic batch delete: pre-flag locally, ack fast, write through in
  // the background. Only the delete verb supports the uids array form.
  if (hasBatch && (method === 'email.delete' || (method === 'email.modify' && params.delete))) {
    const permanent = method === 'email.delete' ? !!params.permanent
      : (typeof params.delete === 'object' && params.delete.permanent);
    return engine.batchDelete({ account: params.account, uids: params.uids, permanent }, { source: 'bridge', appName });
  }
  let p = params;
  if (method === 'email.markRead') p = { account: params.account, uid: params.uid, [params.unread ? 'addFlags' : 'removeFlags']: ['UNREAD'] };
  else if (method === 'email.star') p = { account: params.account, uid: params.uid, [params.starred === false ? 'removeFlags' : 'addFlags']: ['STARRED'] };
  else if (method === 'email.move') p = { account: params.account, uid: params.uid, move: params.folder || params.move };
  else if (method === 'email.delete') p = { account: params.account, uid: params.uid, delete: params.permanent ? { permanent: true } : true };
  return engine.modify(p, { source: 'bridge', appName });
}

// Engine-level sender rules (junk filtered at sync time, before any
// consumer). Owner-scoped config — one store for every surface.
async function rules(app, params, io) {
  const engine = require('../email-engine');
  const op = io.method.split('.')[2];
  if (op === 'list') return { rules: engine.listRules() };
  if (op === 'add') return engine.addRule(params);
  if (op === 'remove') return engine.removeRule(params.id);
  return engine.applyRules(params || {});
}

// Shared label vocabulary — the ONE list the classifier and every app work
// from. Owner-scoped config, same contract as email.rules.*: the store is
// platform-owned, editing stays with the apps.
async function labels(app, params, io) {
  const engine = require('../email-engine');
  const op = io.method.split('.')[2];
  if (op === 'list') return { labels: engine.listLabels() };
  if (op === 'add') return engine.addLabel(params || {});
  if (op === 'update') return engine.updateLabel(params.id, params);
  return engine.removeLabel(params.id);
}

// The names a row's `tags` annotation resolves to — what Horst reads on a
// search or get row (both read with annotationsFrom: ['platform']).
function tagNames(row) {
  const doc = row && row.annotations && row.annotations.tags;
  if (!doc) return [];
  const engine = require('../email-engine');
  const names = new Map(engine.listLabels().map((l) => [l.id, l.name]));
  return require('../email-tags').mergeTags(doc).map((t) => names.get(t.id) || t.id);
}

// Tag NAMES (what the owner and Horst say) → label ids (what the tags document
// stores), case-insensitive. An unknown name is refused naming the valid ones,
// so a chat-staged edit can be corrected rather than silently half-applied.
function tagIdsFor(names) {
  const labels = require('../email-engine').listLabels();
  const byName = new Map(labels.map((l) => [String(l.name || '').trim().toLowerCase(), l]));
  return (names || []).map((n) => {
    const l = byName.get(String(n || '').trim().toLowerCase());
    if (!l) {
      const valid = labels.map((x) => x.name).join(', ') || 'none — the tag vocabulary is empty';
      throw new Error(`unknown tag "${n}" (valid tags: ${valid})`);
    }
    return l;
  });
}

// Tag membership — engine-owned, one document per message (email-tags.js).
// `set` is the owner's decision, `assign` an app's deterministic tagging
// (source 'rule'; the classifier's own 'ai' entries are not an app's to write).
async function tags(app, params, io) {
  const engine = require('../email-engine');
  const op = io.method.split('.')[2];
  const p = params || {};
  if (op === 'of') return { tags: await engine.tagsOf(p.account, p.uid) };
  if (op === 'set') return engine.setTags(p.account, p.uid, { add: p.add || [], remove: p.remove || [] });
  return engine.assignTags(p.account, p.uid, p.ids || [], { source: 'rule' });
}

// --- Attachment reading (the `email_attachment` tool) ------------------------
//
// Three dispositions, because a mailbox holds three kinds of file: text the
// platform can just decode, documents only a model can read, and everything
// else — which is refused honestly rather than returned as mojibake.
const ATT_TEXT_RE = /^text\/|\/(json|xml|csv)$|^application\/(x-)?(yaml|javascript)$/i;
const ATT_TEXT_EXT = /\.(txt|csv|json|xml|html?|md|log|ya?ml|ini|cfg|conf|ics)$/i;
const ATT_MODEL_RE = /pdf|^image\//i;
const ATT_MAX_CHARS = 8000;

async function readAttachment({ account, uid, attachmentId }) {
  const emailEngine = require('../email-engine');
  if (!emailEngine.isReady()) return 'Email engine not connected.';
  const att = await emailEngine.attachment({ account, uid: String(uid), attachmentId: String(attachmentId) });
  if (!att) return 'Attachment not found.';
  const filename = att.filename || 'attachment';
  const mimeType = att.mimeType || 'application/octet-stream';
  const buf = Buffer.from(att.data, 'base64');

  if (ATT_TEXT_RE.test(mimeType) || ATT_TEXT_EXT.test(filename)) {
    const text = buf.toString('utf-8');
    return { filename, mimeType, content: text.slice(0, ATT_MAX_CHARS), truncated: text.length > ATT_MAX_CHARS || undefined };
  }

  if (!ATT_MODEL_RE.test(mimeType)) {
    return `Cannot read "${filename}" (${mimeType}) — not a text, PDF or image file. Its bytes are in the mailbox; propose sending it if the user needs it.`;
  }

  // A PDF or an image is read the way triage reads one: written to a temp file
  // and handed to a cheap model with Read and nothing else. The file is removed
  // whatever happens — an attachment left on disk is an attachment leaked.
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const appManager = require('../app-manager');
  const tmpDir = path.join(appManager.APPS_DIR, '.horst', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const hash = crypto.createHash('sha1').update(`${account}_${uid}_${attachmentId}`).digest('hex').slice(0, 12);
  const ext = path.extname(filename).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10) || (/pdf/i.test(mimeType) ? '.pdf' : '.bin');
  const tmpPath = path.join(tmpDir, `read_${hash}${ext}`);
  fs.writeFileSync(tmpPath, buf);
  try {
    const result = await require('../ai-service').aiPrompt('platform', appManager.APPS_DIR, {
      message: `Read the file at ${tmpPath} and return ALL of its text content — every paragraph, table, date, time, amount, name and reference code. Do not summarise and do not skip sections.`,
      systemPrompt: 'You are a document text extractor. Read the file and return its complete text content faithfully. Do not add commentary.',
      model: 'haiku',
      allowedTools: ['Read'],
      readRoots: [tmpPath], // an outsider's attachment: this one file and nothing else
    });
    const text = String(result?.text || '');
    return { filename, mimeType, extracted: true, content: text.slice(0, ATT_MAX_CHARS), truncated: text.length > ATT_MAX_CHARS || undefined };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* already gone */ }
  }
}

module.exports = {
  key: 'email',
  title: 'Email Accounts + Email Engine',
  headings: ['Email Accounts', 'Email Engine'],
  core: false,
  gated: true,
  methods: ['accounts.email.list', 'accounts.email.credentials', 'email.list', 'email.get', 'email.sent', 'email.repliedTo', 'email.folderCounts', 'email.modify', 'email.markRead', 'email.star', 'email.move', 'email.delete', 'email.send', 'email.draftReply', 'email.attachment', 'email.createFolder', 'email.annotate', 'email.annotations', 'email.rules.list', 'email.rules.add', 'email.rules.remove', 'email.rules.apply', 'email.labels.list', 'email.labels.add', 'email.labels.update', 'email.labels.remove', 'email.tags.of', 'email.tags.set', 'email.tags.assign', 'email.listAnnotations', 'email.reclassify', 'email.syncStatus', 'email.syncNow', 'email.subscribe'],
  prefixes: ['email.', 'accounts.email.'],
  ctx: ['email', 'emailAccounts'],
  keywords: /\b(e-?mail|imap|smtp|mailbox|inbox|message store)\b/i,
  summary: '`accounts.email.*`, `email.list/get/send/…` — always-synced master mail store',
  migration: 'Raw IMAP/SMTP (`imapflow`, `nodemailer`, `node-imap`) or direct Gmail API calls, and any app-run mail sync → the platform engine `email.*` / `ctx.email.*`. Bulk delete uses the array form `email.delete({ account, uids: [...] })`. Remove those deps and any app-stored IMAP/SMTP credentials.',
  visibility: { standalone: 'partial' },
  revocable: true,

  buildCtx(app) {
    const name = app.name;
    const E = () => require('../email-engine');
    // Platform email engine (master mail store; per-app annotations + events).
    // appName is stamped server-side — apps can't write under another identity.
    const email = {
      // Reads render `htmlBody` through the platform sanitiser (`html`,
      // `allowImages`). Each row's `attachments[]` carries `id, filename,
      // mimeType, size` plus, for a part that declared one, `contentId` (the
      // message's Content-ID, angle brackets stripped) and `inline: true`.
      // `inlineImageBase` (optional, absolute path or http(s) URL) rewrites
      // every `cid:` image src whose Content-ID matches one of THIS message's
      // attachments to `<base><attachment id>` — the id, never the cid string —
      // and reports `htmlInlineImages` / `htmlInlineImagesUnresolved` on the
      // row. Omitted, the read is byte-for-byte what it has always been.
      list: (params) => E().listEmails(params || {}, name),
      get: (params) => E().getEmail(params, name),
      folderCounts: (params) => E().folderCounts(params || {}),
      modify: (params) => E().modify(params, { source: 'bridge', appName: name }),
      batchDelete: (params) => E().batchDelete(params, { source: 'bridge', appName: name }),
      send: (params) => E().send(params, { source: 'bridge', appName: name }),
      // ONE drafting path. A "reply with AI" click is an app feature — the
      // trigger is the user — but the prompt, the correspondent context and the
      // anti-echo enforcement are the platform's, shared with Horst's triage.
      // Returns { text }; a draft that fails the enforcement throws.
      draftReply: (params) => require('../email-draft').draftReplyFor(params || {}, app),
      // Outbound mail (send log ∪ synced Sent folder). `includeBody: true`
      // adds the full sent text as `body` on each item; off by default, so a
      // caller that only needs "has this been answered?" keeps the headers-
      // and-`snippet` shape it reads today.
      sent: (params) => E().listSent(params || {}),
      // "Which of these messages have I answered?" — { account, messageIds }
      // → { messageId: sentAt }. The sent log is the one record of that, across
      // every surface that sends; an app keeping its own "replied" table only
      // ever learns about its own sends.
      repliedTo: (params) => E().repliedTo(params || {}),
      attachment: (params) => E().attachment(params),
      createFolder: (params) => E().createFolder(params),
      annotate: (params) => E().annotate(params, name),
      // `scope: 'all'` is how an app reads the platform's own `email-intel`.
      // Its calendarEvents[] carry `endDate` — the last day of a multi-day
      // event, inclusive — beside `date`; null for a single-day event and
      // absent on everything annotated before the field existed, so a consumer
      // spans the event as `endDate || date` and the one-day case is unchanged.
      annotations: (params) => E().annotations(params, name),
      // Bulk cross-app annotation read (writer app + kind [+ since/uids]) — the
      // catch-up path for apps consuming platform annotations like 'email-intel'.
      listAnnotations: (params) => E().listAnnotations(params),
      // Deep re-run of the ONE platform classifier for a single email (user-
      // triggered "Rescan" — full body + forced attachment read).
      reclassify: (params) => require('../agent/horst-triage').reclassify(params),
      // Engine-level sender rules: junk is trashed at sync time, before
      // email:new fires — apps render/edit the ONE store, never enforce.
      rules: {
        list: () => E().listRules(),
        add: (params) => E().addRule(params),
        remove: (id) => E().removeRule(id),
        apply: (params) => E().applyRules(params || {}),
      },
      matchesSenderRules: (from) => E().matchesSenderRules(from),
      // Same check but returns the matching rule (or null) — for provenance
      // display ("trashed by rule X"), not for enforcement.
      matchSenderRule: (from) => E().matchSenderRule(from),
      // Shared label vocabulary: ONE store the classifier and every app work
      // from. Platform-owned, app-editable — same contract as rules above.
      labels: {
        list: () => E().listLabels(),
        add: (params) => E().addLabel(params || {}),
        update: (id, params) => E().updateLabel(id, params || {}),
        remove: (id) => E().removeLabel(id),
      },
      // Which tags sit on which message — the engine's one document per mail.
      tags: {
        of: (account, uid) => E().tagsOf(account, uid),
        set: (account, uid, edit) => E().setTags(account, uid, edit || {}),
        assign: (account, uid, ids) => E().assignTags(account, uid, ids || [], { source: 'rule' }),
      },
      syncStatus: () => E().status(),
      syncNow: (account) => E().syncNow(account),
      on: (event, handler) => E().registerHandler(name, event, handler),
      subscribe: (events) => E().subscribe(name, events),
    };
    if (app.profile === 'standalone') {
      // Own-process app: only the verification-mail path, and only when the
      // manifest declares an email auth flow. No account reader.
      return app.manifest?.auth?.email ? { email: { send: email.send } } : {};
    }
    const emailAccounts = require('../email-accounts');
    return {
      email,
      emailAccounts: {
        list: () => emailAccounts.list(),
        getCredentials: (email) => emailAccounts.getCredentials(email),
      },
    };
  },

  bridge: {
    'accounts.email.list': async () => require('../email-accounts').list(),
    'accounts.email.credentials': async (app, params) => {
      const emailAccounts = require('../email-accounts');
      if (!params.email) throw new Error('email required');
      const creds = emailAccounts.getCredentials(params.email);
      if (!creds) throw new Error('Account not found');
      return creds;
    },
    'email.repliedTo': (app, params) => require('../email-engine').repliedTo(params || {}),
    'email.list': (app, params) => require('../email-engine').listEmails(params, app.name),
    // Same params as `ctx.email.get`, including `inlineImageBase` — an iframe
    // that renders mail passes the URL it serves `email.attachment` bytes from
    // and gets `htmlBody` with its inline images already pointed at it.
    'email.get': async (app, params) => {
      if (!params.account || params.uid == null) throw new Error('account and uid required');
      return require('../email-engine').getEmail(params, app.name);
    },
    // Outbound mail: the platform send log unioned with the synced Sent
    // folder, so a send is queryable immediately and manual sends from another
    // client are included. This is what makes "did I already reply?" answerable.
    // `includeBody: true` adds the full sent text as `body` (log items only).
    'email.sent': (app, params) => require('../email-engine').listSent(params || {}),
    'email.folderCounts': (app, params) => require('../email-engine').folderCounts(params || {}),
    'email.modify': modify,
    'email.markRead': modify,
    'email.star': modify,
    'email.move': modify,
    'email.delete': modify,
    // No field checks here: the engine refuses the same inputs on every entry
    // point, so a second partial copy would only be able to disagree with it.
    'email.send': (app, params) => require('../email-engine').send(params, { source: 'bridge', appName: app.name }),
    'email.draftReply': (app, params) => require('../email-draft').draftReplyFor(params || {}, app),
    'email.attachment': async (app, params) => {
      if (!params.account || params.uid == null || !params.attachmentId) throw new Error('account, uid and attachmentId required');
      return require('../email-engine').attachment(params);
    },
    'email.createFolder': async (app, params) => {
      if (!params.account || !params.name) throw new Error('account and name required');
      return require('../email-engine').createFolder(params);
    },
    'email.annotate': (app, params) => require('../email-engine').annotate(params, app.name),
    'email.annotations': (app, params) => require('../email-engine').annotations(params, app.name),
    'email.rules.list': rules,
    'email.rules.add': rules,
    'email.rules.remove': rules,
    'email.rules.apply': rules,
    'email.labels.list': labels,
    'email.labels.add': labels,
    'email.labels.update': labels,
    'email.labels.remove': labels,
    'email.tags.of': tags,
    'email.tags.set': tags,
    'email.tags.assign': tags,
    // Bulk cross-app annotation read (writer app + kind [+ since/uids]) —
    // the catch-up path for apps consuming platform annotations.
    'email.listAnnotations': (app, params) => require('../email-engine').listAnnotations(params),
    // User-triggered deep pass by the ONE platform classifier (full body +
    // forced attachment read) — apps proxy their "Rescan" buttons here so
    // classification prompts never fork per app.
    'email.reclassify': async (app, params) => {
      if (!params.account || !params.uid) throw new Error('account and uid required');
      return require('../agent/horst-triage').reclassify({ account: params.account, uid: String(params.uid) });
    },
    'email.syncStatus': async (app, params) => {
      const result = await require('../email-engine').status();
      return params.account ? { ...result, accounts: result.accounts.filter((a) => a.account === params.account) } : result;
    },
    'email.syncNow': async (app, params) => {
      if (!params.account) throw new Error('account required');
      return require('../email-engine').syncNow(params.account);
    },
    'email.subscribe': async (app, params) => require('../email-engine').subscribe(app.name, params.events),
  },

  // ---- Horst facet: senses, read-only tools, approval-gated kinds ------------
  horst: {
    lane: {
      direct: {
        'email.list': 'email_search', 'email.sent': 'email_search', 'email.get': 'email_get',
        'email.attachment': 'email_attachment', 'email.rules.list': 'email_rules', 'email.draftReply': 'email_draft_reply',
        'accounts.email.list': { deferred: 'the account list is in every chat prompt (platform status)' },
        'email.repliedTo': { deferred: 'email_search in:Sent answers it' },
        'email.folderCounts': { deferred: 'email_search is:unread answers the chat question' },
        'email.annotations': { deferred: 'app-written annotations; no chat need yet' },
        'email.listAnnotations': { deferred: 'app-written annotations; no chat need yet' },
        'email.labels.list': { deferred: 'tags are read through config_get email.tags' },
        'email.tags.of': { deferred: 'email_search returns each message\'s tags' },
        'email.syncStatus': { deferred: 'sync trouble reaches Horst as a sense' },
      },
      card: {
        'email.send': 'email.send',
        'email.modify': 'email.modify', 'email.markRead': 'email.modify', 'email.star': 'email.modify',
        'email.move': 'email.modify', 'email.delete': 'email.modify',
        'email.createFolder': 'email.folder.create',
        'email.rules.add': 'email.rule.add', 'email.rules.remove': 'email.rule.remove',
        'email.tags.set': 'email.tags.set', 'email.tags.assign': 'email.tags.set',
        'email.syncNow': 'email.sync.reconnect',
        'email.rules.apply': { missing: 'a rule applies on arrival; a re-run over old mail is not a kind' },
        'email.reclassify': { missing: 'reclassification is the triage loop\'s own act' },
        'email.annotate': { missing: 'annotations are app-written' },
        'email.labels.add': { missing: 'the tag set changes through config.set email.tags' },
        'email.labels.update': { missing: 'the tag set changes through config.set email.tags' },
        'email.labels.remove': { missing: 'the tag set changes through config.set email.tags' },
      },
      never: ['accounts.email.credentials', 'email.subscribe'],
      why: 'credentials never enter a model context; email.subscribe is an app\'s live feed',
    },
    brief: 'email: read/search/send/modify, tags, spam rules and folders via the platform mail engine; email_draft_reply drafts reply text (every write is approval-gated)',
    senses: [
      { kind: 'email:sync:failed', description: 'A mail account\'s sync has been failing for 10 minutes', defaultPolicy: 'notify' },
      { kind: 'email:sync:recovered', description: 'A mail account that reported email:sync:failed syncs again', defaultPolicy: 'notify' },
    ],
    wire({ publish }) {
      const engine = require('../email-engine');
      // One event when an account has been failing past the grace window, one
      // when it syncs again; blips in between are not news (syncAlertTracker).
      const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
      const tracker = engine.syncAlertTracker({
        onFailed: (f) => publish('email:sync:failed',
          { account: f.account, error: f.error, since: f.since, lastSyncAt: f.lastSyncAt || null },
          { dedupeKey: `email-sync:${f.account}`, summary: `Mail sync failing for ${f.account} (${minutes(Date.now() - f.since)} min): ${f.error}`.slice(0, 120) }),
        onRecovered: (r) => publish('email:sync:recovered',
          { account: r.account, since: r.since, downMs: r.downMs },
          { dedupeKey: `email-sync:${r.account}`, summary: `Mail sync recovered for ${r.account} after ${minutes(r.downMs)} min` }),
      });
      const off = engine.registerHandler('horst', 'email:sync:status', (d) => tracker.feed(d));
      return () => { off(); tracker.dispose(); };
    },
    tools: [
      {
        def: {
          name: 'email_search',
          description: 'Search the user\'s synced email (hybrid semantic + fulltext over subject/body/sender). The query also understands operators, combined with free text: from: to: cc: participant:/with: subject: account: in:/folder: is:unread|read|starred has:attachment before: after: any: tag: -tag: — values may be quoted, e.g. `from:anna subject:"ferry booking" is:unread` or `tag:"Bills · IT services"` (a tag name or id from config_get email.tags; -tag: excludes). Returns compact rows: account, uid, from, subject, date, folder, snippet, tags. Read-only.',
          inputSchema: { type: 'object', properties: {
            query: { type: 'string', description: 'Search text (semantic + keywords), optionally with operators. Omit to list recent mail.' },
            account: { type: 'string', description: 'Restrict to one account (email address).' },
            folder: { type: 'string', description: 'Folder filter, e.g. INBOX, Sent. Default: all.' },
            unread: { type: 'boolean', description: 'Only unread mail.' },
            limit: { type: 'number', description: 'Max rows (default 15, max 50).' },
          } },
        },
        handler: async (args) => {
          const emailEngine = require('../email-engine');
          const { textResult } = require('../horst-facet');
          if (!emailEngine.isReady()) return textResult('Email engine not connected.');
          const { emails } = await emailEngine.listEmails({
            search: args.query || undefined, account: args.account || undefined,
            folder: args.folder || undefined, unread: args.unread || undefined,
            similarSearch: !!args.query,
            limit: Math.min(Math.max(Number(args.limit) || 15, 1), 50),
            annotationsFrom: ['platform'],
          }, 'horst');
          const rows = (emails || []).map((e) => ({
            account: e.account, uid: String(e.id), from: e.from, subject: e.subject,
            date: e.date, folder: e.folder, snippet: (e.snippet || '').slice(0, 160),
            tags: tagNames(e),
          }));
          return textResult(rows.length ? rows : 'No matching mail.');
        },
      },
      {
        def: {
          name: 'email_get',
          description: 'Fetch one email\'s full headers and body plus attachment names. HTML-only mail is converted to compact markdown (headings, [text](url) links, aligned tables). Body capped at 8000 chars; bodyTruncated=true signals a cut. Read-only.',
          inputSchema: { type: 'object', properties: {
            account: { type: 'string' }, uid: { type: 'string' },
          }, required: ['account', 'uid'] },
        },
        handler: async (args) => {
          const emailEngine = require('../email-engine');
          const { bestEmailBody } = require('../email-content');
          const { textResult } = require('../horst-facet');
          if (!emailEngine.isReady()) return textResult('Email engine not connected.');
          const m = await emailEngine.getEmail({ account: args.account, uid: String(args.uid), annotationsFrom: ['platform'] }, 'horst');
          if (!m) return textResult('Email not found.');
          const body = bestEmailBody(m);
          const out = {
            account: m.account, uid: String(m.id), from: m.from, to: m.to, cc: m.cc,
            subject: m.subject, date: m.date, folder: m.folder,
            attachments: (m.attachments || []).map((a) => a.filename).filter(Boolean),
            tags: tagNames(m),
            body: body.slice(0, 8000),
            bodyTruncated: body.length > 8000 || undefined,
          };
          return textResult(out);
        },
      },
      {
        def: {
          name: 'email_contacts',
          description: 'Find people in the user\'s mail by name, domain or partial address. Returns each address with the display names it appeared under, how often, which header it was seen in (from/to/cc), when it was last seen, and up to three example messages. Use this to get a real address before drafting — never invent one. Read-only.',
          inputSchema: { type: 'object', properties: {
            query: { type: 'string', description: 'A name, a domain, or part of an address. All words must match.' },
            account: { type: 'string', description: 'Restrict to one of the user\'s accounts.' },
            limit: { type: 'number', description: 'Max contacts (default 10, max 25).' },
          }, required: ['query'] },
        },
        handler: async (args) => {
          const emailEngine = require('../email-engine');
          const { textResult } = require('../horst-facet');
          if (!emailEngine.isReady()) return textResult('Email engine not connected.');
          const contacts = await emailEngine.lookupParticipants(args.query, {
            limit: args.limit, account: args.account || undefined,
          });
          if (!contacts.length) {
            // The negative answer has to be as explicit as the positive one, or
            // the model fills the gap with a plausible address.
            return textResult(`No address matching "${args.query}" appears in the user's mail. Ask for the address — do not guess one.`);
          }
          return textResult({
            query: args.query,
            contacts,
            note: 'seenAs counts which header the address appeared in. A cc-only contact is still a valid address to write to. examples[].account + emailId address one message for email_get or email_attachment.',
          });
        },
      },
      {
        def: {
          name: 'email_attachment',
          description: 'Read the CONTENT of one attachment on a message (email_get returns only the names). Text-like files are returned verbatim; PDFs and images are transcribed. Content capped at 8000 chars. Read-only — reading never changes the mailbox.',
          inputSchema: { type: 'object', properties: {
            account: { type: 'string' }, uid: { type: 'string' },
            attachmentId: { type: 'string', description: 'The attachment id from email_get.' },
          }, required: ['account', 'uid', 'attachmentId'] },
        },
        handler: async (args) => {
          const { textResult } = require('../horst-facet');
          return textResult(await readAttachment(args));
        },
      },
      {
        def: {
          name: 'email_rules',
          description: 'The engine\'s spam rules: each sender or domain whose mail is trashed on arrival, with its id (for an email.rule.remove proposal), when it was added and how often it has matched. Read-only — adding and removing rules are proposals.',
          inputSchema: { type: 'object', properties: {} },
        },
        handler: async () => {
          const { textResult } = require('../horst-facet');
          const rows = require('../email-engine').listRules().map((r) => ({
            id: r.id, type: r.type, value: r.value,
            addedAt: r.createdAt ? new Date(r.createdAt).toISOString() : undefined,
            hits: r.hitCount || 0,
            lastMatchedAt: r.lastMatchedAt ? new Date(r.lastMatchedAt).toISOString() : undefined,
          }));
          return textResult(rows.length ? rows : 'No spam rules.');
        },
      },
      {
        def: {
          name: 'email_draft_reply',
          description: 'Draft the TEXT of a reply to one message, through the platform\'s one drafting path (the correspondent\'s context, the owner\'s directives, the anti-echo check). Returns only the reply text; stage it with an email.send proposal ({"account","replyToUid","replyText"}) — the subject, quote and signature are added by code. Costs one model call. Read-only — nothing is sent or saved.',
          inputSchema: { type: 'object', properties: {
            account: { type: 'string' }, uid: { type: 'string' },
            instruction: { type: 'string', description: 'What the reply should say or do, e.g. "decline politely, suggest next week".' },
          }, required: ['account', 'uid'] },
        },
        handler: async (args) => {
          const emailEngine = require('../email-engine');
          const { textResult } = require('../horst-facet');
          if (!emailEngine.isReady()) return textResult('Email engine not connected.');
          // The model triage drafts with, billed to the platform the way
          // triage's drafts are (aiPrompt carries the spend gate).
          const settings = require('../agent/horst-settings').get();
          try {
            const r = await require('../email-draft').draftReplyFor({
              account: args.account, uid: String(args.uid), instruction: args.instruction || '',
              model: settings.briefingModel || 'sonnet',
            });
            return textResult({ account: r.account, replyToUid: r.uid, replyText: r.text });
          } catch (err) {
            return textResult(`No draft: ${err.message}`);
          }
        },
      },
    ],
    kinds: {
      'email.send': {
        appProposable: true, // apps may stage it (docs/governance.md, appMayStage)
        label: 'Send email',
        about: 'Sends a real email from one of your connected accounts.',
        pinNote: 'Outward-facing and irreversible, and the material Horst drafts from (mail, web pages) is untrusted input — a send always needs a human.',
        ceiling: 'propose', // hard-pinned: outward-facing, untrusted-input world
        defaultLevel: 'propose',
        // Every guardrail this kind used to carry now lives on
        // `emailEngine.validateSend` — required fields, CR/LF refusal on every
        // header-bound field, the recompose assertion, the known-account check
        // and attachment validation. The kind still calls it, because refusing
        // at the FREEZE point is better than refusing after the owner approved;
        // what changed is that it is no longer the only caller that refuses.
        validate: (p) => require('../email-engine').validateSend(p),
        describe: (p) => `Send from ${p.account} to ${p.to}: "${p.subject}"`,
        // One THREAD is one reply act — not one per message in it. Reply drafts
        // carry no dedupeKey at all today, so this is the only thing standing
        // between a busy thread and a card per incoming message.
        identity: (p) => require('../governance/horst-identity').replyKey({
          account: p.account, threadId: p.threadId, inReplyTo: p.inReplyTo, subject: p.subject,
        }),
        // Recomputes body/htmlBody from replyText + quote + signature at every
        // freeze point. This is what lets a surface toggle the signature by
        // posting a boolean: it cannot hand us a body that disagrees with it.
        compose: (p) => require('../email-compose').recompose(p),
        execute: (p, proposal) => require('../email-engine').send({
          account: p.account, to: p.to, cc: p.cc || undefined, bcc: p.bcc || undefined,
          subject: p.subject, body: p.body, htmlBody: p.htmlBody || undefined,
          inReplyTo: p.inReplyTo || undefined, references: p.references || undefined,
          threadId: p.threadId || undefined,
          attachments: Array.isArray(p.attachments) && p.attachments.length ? p.attachments : undefined,
        }, { source: 'bridge', appName: proposal?.app || 'horst', proposalId: proposal?.id || null }),
      },

      'email.modify': {
        appProposable: true, // apps may stage it (docs/governance.md, appMayStage)
        label: 'Modify email',
        about: 'Flags, moves, archives, deletes or restores mail already in your mailbox.',
        ceiling: 'auto',
        defaultLevel: 'propose',
        validate(p) { const { req } = require('../horst-facet'); req(p, 'account'); req(p, 'uid', 'any'); },
        describe: (p) => {
          const ops = [];
          if (p.addFlags?.length) ops.push(`+${p.addFlags.join(',')}`);
          if (p.removeFlags?.length) ops.push(`-${p.removeFlags.join(',')}`);
          if (p.move) ops.push(`move→${p.move}`);
          if (p.delete) ops.push('delete');
          if (p.restore) ops.push('restore');
          return `Modify email ${p.uid} on ${p.account} (${ops.join(' ') || 'no-op'})`;
        },
        // No identity: two modifications of one message are usually different
        // acts (flag it now, archive it later), and collapsing them would drop
        // the second silently.
        identity: null,
        execute: (p, proposal) => require('../email-engine').modify({
          account: p.account, uid: p.uid, addFlags: p.addFlags, removeFlags: p.removeFlags,
          move: p.move, delete: p.delete, restore: p.restore,
        }, { source: 'bridge', appName: proposal?.app || 'horst' }),
      },

      'email.rule.add': {
        label: 'Add spam rule',
        about: 'Adds a sender or domain block rule: all future mail from it is trashed on arrival.',
        pinNote: 'A rule trashes mail before any app or briefing ever sees it — it destroys visibility, so it is never automatic.',
        // A rule trashes all future mail from the sender/domain BEFORE any
        // consumer sees it — it destroys visibility, so it is never automatic.
        ceiling: 'propose',
        defaultLevel: 'propose',
        notify: 'none', // reviewed in Approvals views, not pushed to the control chat
        validate(p) {
          const { req } = require('../horst-facet');
          if (!['sender', 'domain'].includes(p.type)) throw new Error("rule type must be 'sender' or 'domain'");
          req(p, 'value');
          // The engine's own refusal, at the freeze point rather than after approval.
          require('../email-engine').assertRuleAllowed({ type: p.type, value: p.value });
        },
        describe: (p) => p.type === 'domain'
          ? `Spam rule: trash all future mail from *@${p.value} (whole domain)`
          : `Spam rule: trash all future mail from ${p.value}`,
        // `type` belongs in the key: blocking one sender and blocking their
        // whole domain are different acts on the same string.
        identity: (p) => require('../governance/horst-identity').ruleKey({ type: p.type, value: p.value }),
        async execute(p) {
          const emailEngine = require('../email-engine');
          const { rule, existed } = emailEngine.addRule({ type: p.type, value: p.value });
          const swept = await emailEngine.applyRules({ rules: [rule] });
          return { ok: true, summary: `${existed ? 'Rule already existed' : `Rule added (${p.type}: ${p.value})`}; ${swept.moved} existing email(s) swept to Trash` };
        },
      },

      'email.rule.remove': {
        label: 'Remove spam rule',
        about: 'Removes a sender or domain spam rule, so mail from it reaches the inbox again. Mail the rule already trashed stays in Trash.',
        ceiling: 'auto',
        defaultLevel: 'propose',
        undo: true, // the executor records the rule it removed; undo re-adds it
        validate(p) {
          const { req } = require('../horst-facet');
          const id = req(p, 'id');
          if (!require('../email-engine').listRules().some((r) => r.id === id)) throw new Error(`no spam rule with id "${id}" (email_rules lists them)`);
        },
        describe: (p) => {
          const r = require('../email-engine').listRules().find((x) => x.id === p.id);
          return r ? `Remove spam rule: ${r.type === 'domain' ? `*@${r.value}` : r.value}` : `Remove spam rule ${p.id}`;
        },
        identity: (p) => require('../governance/horst-identity').objectKey('ruledel', { id: p.id }),
        execute(p) {
          const emailEngine = require('../email-engine');
          const rule = emailEngine.listRules().find((r) => r.id === p.id);
          const { removed } = emailEngine.removeRule(p.id);
          if (!rule || !removed) return { ok: true, summary: 'Rule was already gone' };
          return {
            ok: true,
            summary: `Rule removed (${rule.type}: ${rule.value})`,
            inverse: { kind: 'email.rule.add', payload: { type: rule.type, value: rule.value }, summary: `Undo: re-add spam rule ${rule.value}` },
          };
        },
      },

      'email.folder.create': {
        label: 'Create mail folder',
        about: 'Creates a folder in one of your IMAP mailboxes (Gmail needs none: a Gmail "folder" is a label).',
        ceiling: 'auto',
        defaultLevel: 'propose',
        idempotent: true, // an existing folder is left as it is
        validate(p) {
          const { req } = require('../horst-facet');
          const account = req(p, 'account');
          const name = String(req(p, 'name')).trim();
          if (/[\r\n]/.test(name) || name.length > 200) throw new Error('folder name must be one line of at most 200 characters');
          if (!require('../email-engine').knownAccounts().includes(account)) throw new Error(`unknown email account "${account}"`);
        },
        describe: (p) => `Create folder "${p.name}" on ${p.account}`,
        identity: (p) => require('../governance/horst-identity').objectKey('folder', { account: p.account, id: String(p.name || '').trim().toLowerCase() }),
        async execute(p) {
          await require('../email-engine').createFolder({ account: p.account, name: String(p.name).trim() });
          return { ok: true, summary: `Folder "${String(p.name).trim()}" ready on ${p.account}` };
        },
      },

      'email.tags.set': {
        label: 'Tag email',
        about: 'Adds or removes tags on one message — the same edit as the owner clicking a tag chip, so a removal sticks (the classifier will not put the tag back).',
        ceiling: 'auto',
        defaultLevel: 'propose',
        undo: true, // the executor records what actually changed; undo applies the opposite
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'account');
          req(p, 'uid', 'any');
          for (const f of ['add', 'remove']) if (p[f] != null && !Array.isArray(p[f])) throw new Error(`${f} must be an array of tag names`);
          const add = p.add || []; const remove = p.remove || [];
          if (!add.length && !remove.length) throw new Error('payload requires add or remove (tag names)');
          const addIds = tagIdsFor(add).map((l) => l.id);
          const both = tagIdsFor(remove).filter((l) => addIds.includes(l.id));
          if (both.length) throw new Error(`tag "${both[0].name}" is both added and removed`);
        },
        describe: (p) => `Tag email ${p.uid} on ${p.account}: ${[...(p.add || []).map((n) => `+${n}`), ...(p.remove || []).map((n) => `−${n}`)].join(' ')}`,
        // Two edits of one message's tags are different acts (as email.modify).
        identity: null,
        async execute(p) {
          const emailEngine = require('../email-engine');
          const add = tagIdsFor(p.add || []); const remove = tagIdsFor(p.remove || []);
          const had = new Set((await emailEngine.tagsOf(p.account, String(p.uid))).map((t) => t.id));
          await emailEngine.setTags(p.account, String(p.uid), { add: add.map((l) => l.id), remove: remove.map((l) => l.id) });
          // Only what this edit changed is undone: a tag that was already there
          // is not removed by the undo of "add it".
          const added = add.filter((l) => !had.has(l.id)).map((l) => l.name);
          const removed = remove.filter((l) => had.has(l.id)).map((l) => l.name);
          return {
            ok: true,
            summary: `Tags on ${p.uid}: ${[...added.map((n) => `+${n}`), ...removed.map((n) => `−${n}`)].join(' ') || 'no change'}`,
            ...(added.length || removed.length ? {
              inverse: { kind: 'email.tags.set', payload: { account: p.account, uid: p.uid, add: removed, remove: added }, summary: `Undo: tags on email ${p.uid}` },
            } : {}),
          };
        },
      },

      // Phase 6 remediation: the email:sync:failed sense finally has a
      // matching action — an immediate provider sync (reconnects a dropped
      // IMAP session / re-polls Gmail). Inward-facing and idempotent.
      'email.sync.reconnect': {
        identity: null, // a repeat run is a legitimate retry, never a duplicate
        label: 'Kick mail account sync',
        about: 'Triggers an immediate sync for a mail account after its sync failed — reconnects a dropped IMAP session or re-polls Gmail.',
        ceiling: 'auto+notify',
        // Remediation, not content: it repairs a connection that broke on its
        // own. Syncing an already-synced account is a no-op, so the worst case
        // of an unattended run is a wasted poll — while the cost of WAITING for
        // an approval is mail that silently stops arriving.
        defaultLevel: 'auto+notify',
        idempotent: true,
        validate(p) {
          const { req } = require('../horst-facet');
          req(p, 'account');
          const known = require('../email-accounts').list().map((a) => a.email);
          if (!known.includes(p.account)) throw new Error(`unknown email account "${p.account}"`);
        },
        describe: (p) => `Kick mail sync for ${p.account}`,
        async execute(p) {
          await require('../email-engine').syncNow(p.account);
          return { ok: true, summary: `Sync kicked for ${p.account}` };
        },
      },
    },
  },
};
