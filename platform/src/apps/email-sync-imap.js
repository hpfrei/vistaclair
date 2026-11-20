// IMAP sync provider for the platform email engine. One persistent ImapFlow
// IDLE connection per enabled account (in-process push, not cron), resumable
// backfill, periodic reconcile sweep (cron) for flag/move/delete drift outside
// IDLE's view, SPECIAL-USE folder detection, UIDVALIDITY + import-merge
// handling (plan B4.7).
//
// UID identity: IMAP UIDs are only unique per mailbox, so cross-folder rows
// would collide on UNIQUE(account, uid). INBOX rows keep the bare numeric UID
// (compatible with my-dashboard's imported data); every other folder uses a
// qualified uid "<Label>:<uid>". Moves and the import merge keep row identity
// via engine.remapEmailUid (message_id matching), so annotations follow.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const engine = require('./email-engine');
const emailAccounts = require('./email-accounts');

const BATCH = 50;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 30000];
const MAX_FAILURES = 5;
const SENT_FALLBACK_NAMES = ['Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent'];

// email → { client, folders, folderState, failures, stopped, reconnectTimer,
//           refreshTimer, busy }
const accounts = new Map();

// ---------------------------------------------------------------------------
// uid + folder helpers
// ---------------------------------------------------------------------------
function rowUid(label, uid) {
  return label === 'INBOX' ? String(uid) : `${label}:${uid}`;
}

function numericUid(uid) {
  const s = String(uid);
  const i = s.lastIndexOf(':');
  return parseInt(i === -1 ? s : s.slice(i + 1));
}

function syncDepthToDate(depth) {
  if (!depth || depth === 'all') return null;
  const now = new Date();
  if (depth === '30d') return new Date(now.getTime() - 30 * 86400000);
  if (depth === '6m') { now.setMonth(now.getMonth() - 6); return now; }
  if (depth === '1y') { now.setFullYear(now.getFullYear() - 1); return now; }
  return null;
}

// Detects the synced folder set from LIST SPECIAL-USE (plan Q3/Q4): INBOX +
// Sent always, Archive/Trash/Spam when advertised, plus per-account extras.
// Returns [{label, path}] — label is the canonical DB folder name.
async function detectFolders(account, client) {
  const settings = engine.accountSettings(account);
  const listing = await client.list();
  const byUse = {};
  for (const f of listing) {
    if (f.specialUse) byUse[f.specialUse] = f.path;
  }
  const folders = [{ label: 'INBOX', path: 'INBOX' }];
  let sent = settings.sentFolder || byUse['\\Sent'];
  if (!sent) sent = SENT_FALLBACK_NAMES.find((n) => listing.some((f) => f.path === n)) || null;
  if (sent) folders.push({ label: 'Sent', path: sent });
  if (byUse['\\Archive']) folders.push({ label: 'Archive', path: byUse['\\Archive'] });
  if (byUse['\\Trash']) folders.push({ label: 'Trash', path: byUse['\\Trash'] });
  if (byUse['\\Junk']) folders.push({ label: 'Spam', path: byUse['\\Junk'] });
  for (const extra of settings.folders || []) {
    if (!folders.some((f) => f.path === extra || f.label === extra)) {
      folders.push({ label: extra, path: extra });
    }
  }
  return folders;
}

// Ported from my-dashboard routes.js parseImapMessage (same output shape).
function parseImapMessage(parsed, uid, flags, folderLabel = 'INBOX') {
  const from = parsed.from?.text || '';
  const to = parsed.to?.text || '';
  const cc = parsed.cc?.text || '';
  const subject = parsed.subject || '(no subject)';
  const date = parsed.date ? parsed.date.toUTCString() : '';
  const internalDate = parsed.date ? String(parsed.date.getTime()) : '';
  const body = parsed.text || '';
  const htmlBody = parsed.html || '';
  const snippet = (body || '').substring(0, 200).replace(/\s+/g, ' ');
  const messageId = parsed.messageId || '';

  const allHeaders = [];
  if (parsed.headers) {
    for (const [key, value] of parsed.headers) {
      let v;
      if (typeof value === 'string') v = value;
      else if (value instanceof Date) v = value.toUTCString();
      else if (value && value.text) v = value.text;
      else if (Array.isArray(value)) {
        const hasObjects = value.some((x) => typeof x === 'object' && x !== null && !x.text);
        if (hasObjects) v = JSON.stringify(value);
        else v = value.map((x) => (x && x.text) ? x.text : String(x)).join(', ');
      } else if (typeof value === 'object' && value !== null) v = JSON.stringify(value);
      else v = String(value);
      allHeaders.push({ name: key, value: v });
    }
  }
  // `contentId`/`inline` are what makes an embedded image resolvable on the read
  // path: mailparser hands us the part's Content-ID, and dropping it here left
  // every `cid:` src in the body pointing at nothing. Stored bare (no angle
  // brackets) and only when present, so an ordinary attachment's metadata is
  // unchanged.
  const attachments = (parsed.attachments || []).map((att, i) => {
    const cid = String(att.cid || att.contentId || '').replace(/^</, '').replace(/>$/, '').trim();
    const inline = att.contentDisposition === 'inline' || att.related === true || !!cid;
    return {
      id: String(i),
      filename: att.filename || `attachment-${i}`,
      mimeType: att.contentType || 'application/octet-stream',
      size: att.size || 0,
      ...(cid ? { contentId: cid } : {}),
      ...(inline ? { inline: true } : {}),
    };
  });

  return {
    id: rowUid(folderLabel, uid),
    // No thread id: IMAP has none to give, and filling it with the row's own
    // uid made every message a thread of one. The engine derives a real one
    // from References/In-Reply-To at upsert (email-threading.js).
    threadId: null,
    labelIds: [],
    snippet, from, to, cc, subject, date, internalDate, messageId,
    body, htmlBody,
    isUnread: !flags.has('\\Seen'),
    isStarred: flags.has('\\Flagged'),
    headers: allHeaders,
    attachments,
    folder: folderLabel,
  };
}

// ---------------------------------------------------------------------------
// Merge-aware upsert (plan B4.7): before inserting a new uid, look for an
// existing row with the same message_id whose uid is gone server-side —
// imported rows (sync_orphan / unverified epoch) and externally-moved mail
// (just-expunged, is_deleted). Matching rows are uid-remapped (annotations +
// attachment cache cascade) instead of duplicated.
async function mergeOrInsert(account, messages, { mergeAll = false, suppressEvents = false } = {}) {
  if (!messages.length) return { inserted: [], updated: 0 };
  const c = await engine.conn();
  let known;
  try {
    const uids = messages.map((m) => String(m.id));
    const rows = await c.query(
      `SELECT uid FROM platform_emails WHERE account = ? AND uid IN (${uids.map(() => '?').join(',')})`,
      [account, ...uids]
    );
    known = new Set(rows.map((r) => String(r.uid)));

    for (const msg of messages) {
      if (known.has(String(msg.id)) || !msg.messageId) continue;
      const candidates = await c.query(
        `SELECT uid, folder, sync_orphan, is_deleted FROM platform_emails
         WHERE account = ? AND message_id = ? AND uid <> ?
         ${mergeAll ? '' : 'AND (sync_orphan = 1 OR is_deleted = TRUE)'}
         ORDER BY (folder = ?) DESC, sync_orphan DESC, is_deleted DESC
         LIMIT 1`,
        [account, msg.messageId, String(msg.id), msg.folder]
      );
      if (candidates.length) {
        const ok = await engine.remapEmailUid(account, candidates[0].uid, msg.id);
        if (ok) known.add(String(msg.id));
      }
    }
  } finally {
    c.release();
  }
  return engine.upsertEmails(account, messages, { suppressEvents });
}

async function fetchBatch(client, label, uids) {
  const messages = [];
  for await (const msg of client.fetch(uids.join(','), { source: true, flags: true, uid: true }, { uid: true })) {
    try {
      const parsed = await simpleParser(msg.source);
      messages.push(parseImapMessage(parsed, msg.uid, msg.flags || new Set(), label));
    } catch {}
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Folder state (per-folder {uidvalidity, lastSeenUid, modseq} in
// platform_email_sync.folder_state JSON)
// ---------------------------------------------------------------------------
function parseFolderState(state) {
  if (!state?.folder_state) return {};
  try {
    const v = typeof state.folder_state === 'string' ? JSON.parse(state.folder_state) : state.folder_state;
    return v || {};
  } catch { return {}; }
}

async function saveFolderState(account, folderState, extra = {}) {
  await engine.setSyncState(account, {
    folder_state: JSON.stringify(folderState),
    uidvalidity: folderState.INBOX?.uidvalidity || null,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Backfill — resumable, 50-UID batches, newest-first; checkpoint in page_token
// ---------------------------------------------------------------------------
async function runBackfill(account, entry) {
  const client = entry.client;
  const state = await engine.getSyncState(account);
  let checkpoint = null;
  try { checkpoint = state?.page_token ? JSON.parse(state.page_token) : null; } catch {}
  const folderState = parseFolderState(state);
  const cutoff = syncDepthToDate(engine.accountSettings(account).backfillDepth);

  let done = checkpoint ? (Number(state?.backfill_done) || 0) : 0;
  let total = checkpoint ? (Number(state?.backfill_total) || 0) : 0;
  await engine.setSyncState(account, {
    status: 'backfilling',
    last_error: null,
    ...(checkpoint ? {} : { backfill_done: 0, backfill_total: 0 }),
  });

  const folders = entry.folders;
  const startIdx = checkpoint ? Math.max(0, folders.findIndex((f) => f.label === checkpoint.folder)) : 0;

  for (let fi = startIdx; fi < folders.length; fi++) {
    const { label, path } = folders[fi];
    const lock = await client.getMailboxLock(path);
    try {
      const uidvalidity = String(client.mailbox.uidValidity || '');
      const prev = folderState[label];
      // unverified import (uidvalidity null) or epoch change ⇒ merge-by-message_id pass
      const firstVerify = !prev?.uidvalidity || prev.uidvalidity !== uidvalidity;

      let uids = await client.search(cutoff ? { since: cutoff } : { all: true }, { uid: true }) || [];
      uids.sort((a, b) => b - a);
      const maxUid = uids.length ? uids[0] : (prev?.lastSeenUid || 0);
      total += uids.length;

      let startUids = uids;
      if (checkpoint && checkpoint.folder === label && checkpoint.lowestUid) {
        startUids = uids.filter((u) => u < checkpoint.lowestUid);
        total -= (uids.length - startUids.length);
      }

      for (let i = 0; i < startUids.length; i += BATCH) {
        const chunk = startUids.slice(i, i + BATCH);
        const messages = await fetchBatch(client, label, chunk);
        await mergeOrInsert(account, messages, { mergeAll: firstVerify, suppressEvents: true });
        done += chunk.length;
        checkpoint = { folder: label, lowestUid: Math.min(...chunk) };
        await engine.setSyncState(account, {
          status: 'backfilling',
          page_token: JSON.stringify(checkpoint),
          backfill_done: done,
          backfill_total: Math.max(total, done),
        });
        engine.dispatch('email:backfill-progress', { account, done, total: Math.max(total, done) });
      }

      if (firstVerify) {
        // flag rows in this folder that no live server uid claimed (plan B4.7:
        // preserved, searchable, but skip write-through). Depth-limited
        // backfills only judge rows inside the synced window.
        const serverUids = new Set(uids.map((u) => rowUid(label, u)));
        const c = await engine.conn();
        try {
          const rows = await c.query(
            `SELECT uid FROM platform_emails WHERE account = ? AND folder = ? AND is_deleted = FALSE AND sync_orphan = 0
             ${cutoff ? 'AND date >= ?' : ''}`,
            cutoff ? [account, label, cutoff] : [account, label]
          );
          const orphans = rows.map((r) => String(r.uid)).filter((u) => !serverUids.has(u));
          if (orphans.length) {
            await c.query(
              `UPDATE platform_emails SET sync_orphan = 1 WHERE account = ? AND uid IN (${orphans.map(() => '?').join(',')})`,
              [account, ...orphans]
            );
            console.log(`  Email engine [imap:${account}]: ${orphans.length} unmatched rows in ${label} kept as sync orphans`);
          }
        } finally {
          c.release();
        }
      }

      folderState[label] = {
        uidvalidity,
        lastSeenUid: maxUid,
        modseq: client.mailbox.highestModseq ? String(client.mailbox.highestModseq) : null,
      };
      checkpoint = null;
    } finally {
      lock.release();
    }
  }

  entry.folderState = folderState;
  await saveFolderState(account, folderState, {
    status: 'watching',
    page_token: null,
    condstore: client.capabilities?.has?.('CONDSTORE') ? 1 : 0,
    last_sync_at: new Date(),
    last_error: null,
  });
}

// ---------------------------------------------------------------------------
// Reconcile — new uids + flag resync (CONDSTORE when available) + expunge diff
// for one folder. Used by the cron sweep (all folders) and by IDLE refreshes
// (INBOX only).
// ---------------------------------------------------------------------------
async function reconcileFolder(account, entry, { label, path }) {
  const client = entry.client;
  const folderState = entry.folderState;
  const lock = await client.getMailboxLock(path);
  try {
    const uidvalidity = String(client.mailbox.uidValidity || '');
    const prev = folderState[label];
    if (!prev?.uidvalidity || prev.uidvalidity !== uidvalidity) {
      lock.release();
      // epoch change mid-flight — full re-verify of this folder via backfill
      await engine.setSyncState(account, { page_token: null });
      await runBackfill(account, entry);
      return;
    }

    const serverUids = await client.search({ all: true }, { uid: true }) || [];
    const serverSet = new Set(serverUids.map((u) => rowUid(label, u)));

    // 1. new messages
    const newUids = serverUids.filter((u) => u > (prev.lastSeenUid || 0)).sort((a, b) => a - b);
    for (let i = 0; i < newUids.length; i += BATCH) {
      const chunk = newUids.slice(i, i + BATCH);
      const messages = await fetchBatch(client, label, chunk);
      await mergeOrInsert(account, messages);
    }

    // 2. local rows for this folder (live, verified)
    const c = await engine.conn();
    let local;
    try {
      local = await c.query(
        'SELECT uid, is_unread, is_starred FROM platform_emails WHERE account = ? AND folder = ? AND is_deleted = FALSE AND sync_orphan = 0',
        [account, label]
      );
    } finally {
      c.release();
    }
    const localByUid = new Map(local.map((r) => [String(r.uid), r]));

    // 3. flag resync — CONDSTORE narrows to changed rows when the server has it
    if (serverUids.length) {
      const condstore = client.capabilities?.has?.('CONDSTORE') && prev.modseq;
      const opts = condstore ? { uid: true, changedSince: BigInt(prev.modseq) } : { uid: true };
      for await (const msg of client.fetch('1:*', { flags: true, uid: true }, opts)) {
        const id = rowUid(label, msg.uid);
        const row = localByUid.get(id);
        if (!row) continue;
        const flags = msg.flags || new Set();
        const isUnread = !flags.has('\\Seen');
        const isStarred = flags.has('\\Flagged');
        if (!!row.is_unread !== isUnread || !!row.is_starred !== isStarred) {
          await engine.applyEmailChanges(account, id, { isUnread, isStarred });
        }
      }
    }

    // 4. expunge diff — local rows whose uid vanished server-side ⇒ soft delete
    for (const [id] of localByUid) {
      if (!serverSet.has(id)) {
        await engine.applyEmailChanges(account, id, { isDeleted: true });
      }
    }

    folderState[label] = {
      uidvalidity,
      lastSeenUid: serverUids.length ? Math.max(prev.lastSeenUid || 0, ...serverUids) : (prev.lastSeenUid || 0),
      modseq: client.mailbox.highestModseq ? String(client.mailbox.highestModseq) : prev.modseq,
    };
  } finally {
    try { lock.release(); } catch {}
  }
}

async function reconcileAccount(account, entry) {
  if (entry.busy) return;
  entry.busy = true;
  try {
    for (const folder of entry.folders) {
      await reconcileFolder(account, entry, folder);
    }
    await saveFolderState(account, entry.folderState, {
      last_reconcile_at: new Date(),
      last_sync_at: new Date(),
      status: 'watching',
      last_error: null,
    });
  } catch (err) {
    console.error(`  Email engine [imap:${account}]: reconcile failed: ${err.message}`);
    await engine.setSyncState(account, { last_error: `reconcile: ${err.message}` }).catch(() => {});
  } finally {
    entry.busy = false;
    await reopenInbox(entry).catch(() => {});
  }
}

// After reconcile (which selects other mailboxes), put the persistent client
// back on INBOX so IDLE notifications resume.
async function reopenInbox(entry) {
  if (entry.client?.usable && entry.client.mailbox?.path !== 'INBOX') {
    await entry.client.mailboxOpen('INBOX');
  }
}

// ---------------------------------------------------------------------------
// IDLE-driven INBOX refresh (debounced — exists/expunge/flags events can burst)
// ---------------------------------------------------------------------------
function scheduleInboxRefresh(account, entry) {
  if (entry.refreshTimer) return;
  entry.refreshTimer = setTimeout(async () => {
    entry.refreshTimer = null;
    if (entry.busy || !entry.client?.usable) return;
    entry.busy = true;
    try {
      const inbox = entry.folders.find((f) => f.label === 'INBOX');
      await reconcileFolder(account, entry, inbox);
      await saveFolderState(account, entry.folderState, { last_sync_at: new Date() });
    } catch (err) {
      console.error(`  Email engine [imap:${account}]: refresh failed: ${err.message}`);
    } finally {
      entry.busy = false;
      await reopenInbox(entry).catch(() => {});
    }
  }, 1500);
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------
async function connectAccount(account) {
  const existing = accounts.get(account);
  if (existing?.client?.usable || existing?.connecting) return;

  const creds = emailAccounts.getCredentials(account);
  if (!creds) return;

  const entry = existing || { failures: 0, stopped: false };
  entry.connecting = true;
  accounts.set(account, entry);

  try {
    const client = new ImapFlow({
      host: creds.imap.host,
      port: creds.imap.port || 993,
      secure: creds.imap.tls !== false,
      auth: { user: creds.username, pass: creds.password },
      logger: false,
      // ImapFlow default is false = IDLE never renewed; 5 min keeps every
      // provider's idle-drop window at bay (plan Q13)
      maxIdleTime: 5 * 60 * 1000,
    });
    entry.client = client;

    client.on('error', (err) => {
      console.error(`  Email engine [imap:${account}]: ${err.message}`);
    });
    client.on('close', () => {
      if (!entry.stopped) scheduleReconnect(account, entry);
    });
    client.on('exists', () => scheduleInboxRefresh(account, entry));
    client.on('expunge', () => scheduleInboxRefresh(account, entry));
    client.on('flags', () => scheduleInboxRefresh(account, entry));

    await client.connect();
    entry.folders = await detectFolders(account, client);
    const state = await engine.getSyncState(account);
    entry.folderState = parseFolderState(state);
    entry.failures = 0;

    await client.mailboxOpen('INBOX');
    await runBackfill(account, entry);
    await reopenInbox(entry);
    console.log(`  Email engine [imap:${account}]: watching (${entry.folders.map((f) => f.label).join(', ')})`);
  } catch (err) {
    const auth = /auth|login|credentials/i.test(err.message || '');
    console.error(`  Email engine [imap:${account}]: connect failed: ${err.message}`);
    await engine.setSyncState(account, {
      status: auth ? 'auth_required' : 'error',
      last_error: err.message,
    }).catch(() => {});
    try { entry.client?.close(); } catch {}
    if (!entry.stopped) scheduleReconnect(account, entry, true);
  } finally {
    entry.connecting = false;
  }
}

function scheduleReconnect(account, entry, failed = false) {
  if (entry.reconnectTimer || entry.stopped) return;
  if (failed) entry.failures++;
  if (entry.failures >= MAX_FAILURES) {
    engine.setSyncState(account, {
      status: 'error',
      last_error: `Gave up after ${MAX_FAILURES} consecutive connection failures — re-enable in Setup to retry`,
    }).catch(() => {});
    return;
  }
  const delay = BACKOFF_MS[Math.min(entry.failures, BACKOFF_MS.length - 1)];
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    if (!entry.stopped && engine.accountSettings(account).enabled) connectAccount(account);
  }, delay);
}

async function stopAccount(account) {
  const entry = accounts.get(account);
  if (!entry) return;
  entry.stopped = true;
  if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
  if (entry.refreshTimer) { clearTimeout(entry.refreshTimer); entry.refreshTimer = null; }
  try { await entry.client?.logout(); } catch { try { entry.client?.close(); } catch {} }
  accounts.delete(account);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------
function imapAccounts() {
  return emailAccounts.list().map((a) => a.email);
}

function start() {
  for (const email of imapAccounts()) {
    if (engine.accountSettings(email).enabled) {
      connectAccount(email).catch((err) =>
        console.error(`  Email engine [imap:${email}]: start failed: ${err.message}`));
    }
  }
}

async function enableAccount(account) {
  const entry = accounts.get(account);
  if (entry) { entry.stopped = false; entry.failures = 0; }
  await engine.setSyncState(account, { enabled: 1, status: 'idle', last_error: null });
  await connectAccount(account);
}

async function disableAccount(account) {
  await stopAccount(account);
  await engine.setSyncState(account, { enabled: 0, status: 'disabled' });
}

// Cron sweep (email:imap-reconcile): catches drift outside IDLE's view.
async function reconcile() {
  for (const email of imapAccounts()) {
    if (!engine.accountSettings(email).enabled) continue;
    const entry = accounts.get(email);
    if (!entry?.client?.usable) {
      if (!entry?.connecting && !entry?.reconnectTimer) await connectAccount(email);
      continue;
    }
    await reconcileAccount(email, entry);
  }
}

async function syncNow(account) {
  const entry = accounts.get(account);
  if (!entry?.client?.usable) {
    const e = accounts.get(account);
    if (e) { e.stopped = false; e.failures = 0; }
    await connectAccount(account);
  } else {
    await reconcileAccount(account, entry);
  }
  return engine.getSyncState(account);
}

// Used by the write-through layer (A8.4): run an op against the account's
// persistent connection (or a one-shot connection when not watching).
async function withClient(account, fn) {
  const entry = accounts.get(account);
  if (entry?.client?.usable) {
    try {
      return await fn(entry.client, entry);
    } finally {
      await reopenInbox(entry).catch(() => {});
    }
  }
  const creds = emailAccounts.getCredentials(account);
  if (!creds) throw new Error(`No IMAP credentials for ${account}`);
  const client = new ImapFlow({
    host: creds.imap.host, port: creds.imap.port || 993,
    secure: creds.imap.tls !== false,
    auth: { user: creds.username, pass: creds.password },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client, null);
  } finally {
    try { await client.logout(); } catch { try { client.close(); } catch {} }
  }
}

// ---------------------------------------------------------------------------
// Write-through ops (called by engine.modify / engine.send / engine.attachment)
// ---------------------------------------------------------------------------
function folderLabel(uid) {
  const s = String(uid);
  const i = s.lastIndexOf(':');
  return i === -1 ? 'INBOX' : s.slice(0, i);
}

function resolvePath(entry, mailboxes, label) {
  const known = entry?.folders?.find((f) => f.label === label);
  if (known) return known.path;
  const mb = mailboxes?.find((m) =>
    m.path === label || m.name === label || m.specialUse === ('\\' + (label === 'Spam' ? 'Junk' : label)));
  return mb?.path || label;
}

// Canonical engine flags UNREAD/STARRED → IMAP \Seen/\Flagged. Move/delete
// remap the row uid to the destination folder's namespace BEFORE the server op
// completes the change, keeping row identity (annotations cascade).
async function applyModify(account, uid, { addFlags = [], removeFlags = [], move, del, restore } = {}) {
  const label = folderLabel(uid);
  const num = numericUid(uid);
  const changes = {};

  return withClient(account, async (client, entry) => {
    const mailboxes = await client.list();
    const srcPath = resolvePath(entry, mailboxes, label);

    if (del) {
      const permanent = typeof del === 'object' && del.permanent;
      if (permanent) {
        const lock = await client.getMailboxLock(srcPath);
        try {
          await client.messageFlagsAdd(String(num), ['\\Deleted'], { uid: true });
          await client.messageDelete(String(num), { uid: true });
        } finally { lock.release(); }
        changes.isDeleted = true;
        changes.permanent = true;
      } else {
        const trashPath = resolvePath(entry, mailboxes, 'Trash');
        if (!mailboxes.some((m) => m.path === trashPath)) {
          try { await client.mailboxCreate(trashPath); } catch {}
        }
        const lock = await client.getMailboxLock(srcPath);
        let newUid = null;
        try {
          const res = await client.messageMove(String(num), trashPath, { uid: true });
          newUid = res?.uidMap?.get?.(num) || null;
        } finally { lock.release(); }
        const target = rowUid('Trash', newUid || `m${Date.now()}`);
        await engine.remapEmailUid(account, uid, target);
        changes.folder = 'Trash';
        changes.uid = target;
      }
      return changes;
    }
    if (restore) {
      changes.isDeleted = false;
      // The message was soft-deleted because its server UID vanished, so there is
      // no live server copy to un-delete. Mark it a sync orphan (same state the
      // backfill verify pass assigns unmatched rows): the row stays present and
      // searchable, but the reconcile expunge-diff (which only judges
      // sync_orphan = 0 rows) won't re-delete it. If the message ever reappears
      // server-side, upsertEmails resets sync_orphan = 0 and it rebinds normally.
      changes.syncOrphan = true;
      return changes;
    }

    if (move) {
      const destPath = resolvePath(entry, mailboxes, move);
      if (!mailboxes.some((m) => m.path === destPath)) {
        await client.mailboxCreate(destPath);
      }
      const lock = await client.getMailboxLock(srcPath);
      let newUid = null;
      try {
        const res = await client.messageMove(String(num), destPath, { uid: true });
        newUid = res?.uidMap?.get?.(num) || null;
      } finally { lock.release(); }
      const target = rowUid(move, newUid || `m${Date.now()}`);
      await engine.remapEmailUid(account, uid, target);
      changes.folder = move;
      changes.uid = target;
    }

    const addF = [];
    const removeF = [];
    if (removeFlags.includes('UNREAD')) addF.push('\\Seen');
    if (addFlags.includes('UNREAD')) removeF.push('\\Seen');
    if (addFlags.includes('STARRED')) addF.push('\\Flagged');
    if (removeFlags.includes('STARRED')) removeF.push('\\Flagged');
    if (addF.length || removeF.length) {
      const flagUidStr = changes.uid ? String(numericUid(changes.uid)) : String(num);
      const flagPath = changes.folder ? resolvePath(entry, mailboxes, changes.folder) : srcPath;
      const lock = await client.getMailboxLock(flagPath);
      try {
        if (addF.length) await client.messageFlagsAdd(flagUidStr, addF, { uid: true });
        if (removeF.length) await client.messageFlagsRemove(flagUidStr, removeF, { uid: true });
      } finally { lock.release(); }
    }
    if (addFlags.includes('UNREAD')) changes.isUnread = true;
    if (removeFlags.includes('UNREAD')) changes.isUnread = false;
    if (addFlags.includes('STARRED')) changes.isStarred = true;
    if (removeFlags.includes('STARRED')) changes.isStarred = false;
    return changes;
  });
}

// SMTP send + APPEND-to-Sent (plan fix #5: plain SMTP does not save sent mail).
// Honors the full references chain (plan Q6).
async function send(account, payload) {
  const creds = emailAccounts.getCredentials(account);
  if (!creds?.smtp) throw new Error(`No SMTP credentials for ${account}`);
  const { body, htmlBody, attachments } = payload;
  // Header-bound fields are stripped of CR/LF at the transport as well as in
  // emailEngine.validateSend. The Gmail path has always done this (hdrSafe in
  // buildMimeMessage); nodemailer had no equivalent, so this path was the one
  // place a caller reaching an IMAP account could still inject a header.
  // Belt and braces deliberately: the engine refuses such a payload, and if a
  // future caller ever bypasses it the transport still cannot be made to emit
  // a second header line.
  const hdrSafe = (v) => (v == null ? undefined : String(v).replace(/[\r\n]+/g, ' ').trim());
  const to = hdrSafe(payload.to);
  const cc = hdrSafe(payload.cc);
  const bcc = hdrSafe(payload.bcc);
  const subject = hdrSafe(payload.subject);
  const inReplyTo = hdrSafe(payload.inReplyTo);
  const references = hdrSafe(payload.references);
  const transporter = nodemailer.createTransport({
    host: creds.smtp.host,
    port: creds.smtp.port || 587,
    secure: creds.smtp.port === 465,
    auth: { user: creds.username, pass: creds.password },
  });
  const mailOpts = {
    from: account, to, subject, text: body,
    html: htmlBody || undefined, // nodemailer builds multipart/alternative
    cc: cc || undefined,
    bcc: bcc || undefined,
    inReplyTo: inReplyTo || undefined,
    references: references || inReplyTo || undefined,
  };
  if (attachments?.length) {
    mailOpts.attachments = attachments.map((a) => ({
      filename: hdrSafe(a.filename),
      content: Buffer.from(a.base64Data, 'base64'),
      contentType: hdrSafe(a.contentType),
    }));
  }
  const info = await transporter.sendMail(mailOpts);

  // APPEND the raw message to Sent; non-fatal on failure (plan A7)
  let warning = null;
  try {
    const raw = info.message || (await new Promise((resolve, reject) => {
      const MailComposer = require('nodemailer/lib/mail-composer');
      new MailComposer(mailOpts).compile().build((err, msg) => err ? reject(err) : resolve(msg));
    }));
    await withClient(account, async (client, entry) => {
      let sentPath = entry?.folders?.find((f) => f.label === 'Sent')?.path;
      if (!sentPath) {
        const settings = engine.accountSettings(account);
        const listing = await client.list();
        sentPath = settings.sentFolder
          || listing.find((f) => f.specialUse === '\\Sent')?.path
          || SENT_FALLBACK_NAMES.find((n) => listing.some((f) => f.path === n));
        if (!sentPath) {
          sentPath = 'Sent';
          try { await client.mailboxCreate(sentPath); } catch {}
        }
      }
      await client.append(sentPath, raw, ['\\Seen']);
    });
  } catch (err) {
    warning = `Sent, but copying to Sent folder failed: ${err.message}`;
    console.error(`  Email engine [imap:${account}]: ${warning}`);
    await engine.setSyncState(account, { last_error: warning }).catch(() => {});
  }
  return { uid: null, messageId: info.messageId || null, warning };
}

// IMAP attachments are indexed by position within the parsed message.
async function fetchAttachment(account, uid, attachmentId) {
  const label = folderLabel(uid);
  const num = numericUid(uid);
  const idx = parseInt(attachmentId);
  return withClient(account, async (client, entry) => {
    const mailboxes = await client.list();
    const path = resolvePath(entry, mailboxes, label);
    const lock = await client.getMailboxLock(path);
    try {
      for await (const msg of client.fetch(String(num), { source: true, uid: true }, { uid: true })) {
        const parsed = await simpleParser(msg.source);
        const att = (parsed.attachments || [])[idx];
        if (!att) throw new Error('Attachment not found');
        return { content: att.content, filename: att.filename || 'attachment', mimeType: att.contentType || 'application/octet-stream' };
      }
      throw new Error('Message not found');
    } finally { lock.release(); }
  });
}

async function createFolder(account, name) {
  return withClient(account, async (client) => {
    const mailboxes = await client.list();
    if (!mailboxes.some((m) => m.path === name || m.name === name)) {
      await client.mailboxCreate(name);
    }
    return { ok: true, name };
  });
}

engine.registerProvider('imap', {
  reconcile, syncNow, accounts: imapAccounts,
  enableAccount, disableAccount, withClient,
  rowUid, numericUid, parseImapMessage,
  applyModify, send, fetchAttachment, createFolder,
});

module.exports = {
  start, reconcile, syncNow, enableAccount, disableAccount,
  withClient, imapAccounts, rowUid, numericUid, parseImapMessage,
  applyModify, send, fetchAttachment, createFolder,
};
