// Gmail sync provider for the platform email engine. Raw Gmail REST (no
// googleapis): historyId incremental poll (every 2 min via platformCron) +
// resumable full backfill with a page_token checkpoint. Registers itself with
// email-engine so the engine can delegate without circular requires.
const engine = require('./email-engine');
const gapi = require('./google-api');
const googleAuth = require('./google-auth');
const { singleFlight } = require('../utils');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const FETCH_CONCURRENCY = 10;

const GMAIL_SCOPE_ALIASES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://mail.google.com/',
];

// Single-flight per account: cron tick + manual syncNow must not overlap.
const running = new Map();

function gmailAccounts() {
  return googleAuth.listAccounts()
    .filter((a) => (a.grantedScopes || []).some((s) => GMAIL_SCOPE_ALIASES.includes(s)))
    .map((a) => a.email)
    .filter((email) => engine.accountType(email) === 'gmail');
}

// Ported from my-dashboard routes.js parseGmailMessage — same output shape so
// the imported rows and engine-synced rows are indistinguishable.
function parseGmailMessage(msg) {
  const hdrs = {};
  const allHeaders = (msg.payload?.headers || []).map((h) => ({ name: h.name, value: h.value }));
  for (const h of msg.payload?.headers || []) hdrs[h.name.toLowerCase()] = h.value;
  let text = '', html = '';
  const attachments = [];
  function walk(parts) {
    for (const p of parts || []) {
      if (p.mimeType === 'text/plain' && p.body?.data)
        text = Buffer.from(p.body.data, 'base64url').toString();
      else if (p.mimeType === 'text/html' && p.body?.data)
        html = Buffer.from(p.body.data, 'base64url').toString();
      if (p.filename && p.body) {
        // The part's own headers carry Content-ID; `walk` used to look only at
        // mimeType/body/filename, which is why an embedded image arrived with no
        // way to match the `cid:` src that references it. Same shape as the IMAP
        // side: bare Content-ID, and both fields only when present.
        const ph = {};
        for (const h of p.headers || []) ph[String(h.name || '').toLowerCase()] = h.value;
        const cid = String(ph['content-id'] || '').replace(/^</, '').replace(/>$/, '').trim();
        const inline = /^\s*inline/i.test(String(ph['content-disposition'] || '')) || !!cid;
        attachments.push({
          id: p.body.attachmentId || '',
          filename: p.filename,
          mimeType: p.mimeType || 'application/octet-stream',
          size: p.body.size || 0,
          ...(cid ? { contentId: cid } : {}),
          ...(inline ? { inline: true } : {}),
        });
      }
      if (p.parts) walk(p.parts);
    }
  }
  if (msg.payload?.body?.data) {
    const decoded = Buffer.from(msg.payload.body.data, 'base64url').toString();
    if (msg.payload.mimeType === 'text/html') html = decoded; else text = decoded;
  }
  walk(msg.payload?.parts);

  const labelIds = msg.labelIds || [];
  return {
    id: msg.id, threadId: msg.threadId, labelIds,
    snippet: msg.snippet || '', from: hdrs.from || '', to: hdrs.to || '',
    cc: hdrs.cc || '', subject: hdrs.subject || '(no subject)',
    date: hdrs.date || '', internalDate: msg.internalDate,
    messageId: hdrs['message-id'] || '',
    body: text, htmlBody: html,
    isUnread: labelIds.includes('UNREAD'),
    isStarred: labelIds.includes('STARRED'),
    headers: allHeaders,
    attachments,
    folder: folderFromLabels(labelIds),
  };
}

function folderFromLabels(labels = []) {
  if (labels.includes('TRASH')) return 'Trash';
  if (labels.includes('SPAM')) return 'Spam';
  if (labels.includes('INBOX')) return 'INBOX';
  if (labels.includes('SENT')) return 'Sent';
  return 'Archive';
}

async function fetchFull(token, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += FETCH_CONCURRENCY) {
    const chunk = ids.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(chunk.map((id) =>
      gapi.get(`${API}/messages/${id}?format=full`, token)
        .then(parseGmailMessage)
        .catch((err) => {
          if (err.status === 404) return null; // deleted between history and fetch
          throw err;
        })
    ));
    out.push(...results.filter(Boolean));
  }
  return out;
}

function backfillQuery(depth) {
  if (!depth || depth === 'all') return '';
  const now = new Date();
  if (depth === '30d') now.setDate(now.getDate() - 30);
  else if (depth === '6m') now.setMonth(now.getMonth() - 6);
  else if (depth === '1y') now.setFullYear(now.getFullYear() - 1);
  else return '';
  return `after:${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
}

function parseCheckpoint(state) {
  if (!state?.page_token) return null;
  try { return JSON.parse(state.page_token); } catch { return null; }
}

// Resumable full backfill. Anchors history_id from getProfile BEFORE listing so
// changes made during backfill are picked up by the first history poll after.
// Per-message email:new is suppressed; email:backfill-progress streams instead.
async function runBackfill(account, state) {
  const token = await gapi.getToken(gapi.SCOPES.gmail, account);
  let checkpoint = parseCheckpoint(state);

  if (!checkpoint) {
    const profile = await gapi.get(`${API}/profile`, token);
    checkpoint = { pageToken: null, anchor: String(profile.historyId) };
    await engine.setSyncState(account, {
      status: 'backfilling',
      history_id: checkpoint.anchor,
      page_token: JSON.stringify(checkpoint),
      backfill_done: 0,
      backfill_total: 0,
      last_error: null,
    });
  } else {
    await engine.setSyncState(account, { status: 'backfilling' });
  }

  const q = backfillQuery(engine.accountSettings(account).backfillDepth);
  let done = Number(state?.backfill_done) || 0;
  let total = Number(state?.backfill_total) || 0;

  while (true) {
    const params = new URLSearchParams({ maxResults: '100', includeSpamTrash: 'true' });
    if (q) params.set('q', q);
    if (checkpoint.pageToken) params.set('pageToken', checkpoint.pageToken);
    let list;
    try {
      list = await gapi.get(`${API}/messages?${params}`, token);
    } catch (err) {
      // stale pageToken after a long pause — restart the listing, upserts make it cheap
      if (checkpoint.pageToken && (err.status === 400 || err.status === 404)) {
        checkpoint.pageToken = null;
        continue;
      }
      throw err;
    }
    if (!total && list.resultSizeEstimate) total = list.resultSizeEstimate;
    const ids = (list.messages || []).map((m) => m.id);
    if (ids.length) {
      const messages = await fetchFull(token, ids);
      await engine.upsertEmails(account, messages, { suppressEvents: true });
      done += ids.length;
    }
    checkpoint.pageToken = list.nextPageToken || null;
    await engine.setSyncState(account, {
      status: 'backfilling',
      page_token: checkpoint.pageToken ? JSON.stringify(checkpoint) : null,
      backfill_done: done,
      backfill_total: Math.max(total, done),
    });
    engine.dispatch('email:backfill-progress', { account, done, total: Math.max(total, done) });
    if (!checkpoint.pageToken) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  await engine.setSyncState(account, {
    status: 'watching',
    page_token: null,
    last_sync_at: new Date(),
    last_error: null,
  });
}

// Incremental poll via history.list since the stored history_id.
async function runHistory(account, state) {
  const token = await gapi.getToken(gapi.SCOPES.gmail, account);
  const added = new Set();
  const removed = new Set();
  const labelChanged = new Set();
  let newHistoryId = state.history_id;
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      startHistoryId: state.history_id,
      maxResults: '100',
    });
    for (const t of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) {
      params.append('historyTypes', t);
    }
    if (pageToken) params.set('pageToken', pageToken);
    let res;
    try {
      res = await gapi.get(`${API}/history?${params}`, token);
    } catch (err) {
      if (err.status === 404 || err.status === 410) {
        // history expired — re-anchor and run a full re-list (upserts = reconcile)
        await engine.setSyncState(account, { history_id: null, page_token: null });
        return runBackfill(account, { ...state, history_id: null, page_token: null, backfill_done: 0, backfill_total: 0 });
      }
      throw err;
    }
    for (const h of res.history || []) {
      for (const m of h.messagesAdded || []) { added.add(m.message.id); removed.delete(m.message.id); }
      for (const m of h.messagesDeleted || []) { removed.add(m.message.id); added.delete(m.message.id); labelChanged.delete(m.message.id); }
      for (const m of h.labelsAdded || []) if (!added.has(m.message.id)) labelChanged.add(m.message.id);
      for (const m of h.labelsRemoved || []) if (!added.has(m.message.id)) labelChanged.add(m.message.id);
    }
    if (res.historyId) newHistoryId = String(res.historyId);
    pageToken = res.nextPageToken || null;
  } while (pageToken);

  if (added.size) {
    const messages = await fetchFull(token, [...added]);
    await engine.upsertEmails(account, messages, { origin: { source: 'sync' } });
  }

  for (const id of labelChanged) {
    if (removed.has(id)) continue;
    let meta;
    try {
      meta = await gapi.get(`${API}/messages/${id}?format=minimal`, token);
    } catch (err) {
      if (err.status === 404) { removed.add(id); continue; }
      throw err;
    }
    const labels = meta.labelIds || [];
    await engine.applyEmailChanges(account, id, {
      isUnread: labels.includes('UNREAD'),
      isStarred: labels.includes('STARRED'),
      folder: folderFromLabels(labels),
      labelIds: labels,
      isDeleted: false,
    });
  }

  for (const id of removed) {
    await engine.applyEmailChanges(account, id, { isDeleted: true });
  }

  await engine.setSyncState(account, {
    status: 'watching',
    history_id: newHistoryId,
    last_sync_at: new Date(),
    last_error: null,
  });
}

function syncAccount(account) {
  return singleFlight(running, account, async () => {
    try {
      const state = await engine.getSyncState(account);
      if (state?.page_token || !state?.history_id) {
        await runBackfill(account, state);
      } else {
        await runHistory(account, state);
      }
    } catch (err) {
      const auth = err.authRequired || err.status === 401;
      console.error(`  Email engine [gmail:${account}]: ${err.message}`);
      await engine.setSyncState(account, {
        status: auth ? 'auth_required' : 'error',
        last_error: err.message,
      }).catch(() => {});
    }
  });
}

async function poll() {
  for (const account of gmailAccounts()) {
    if (!engine.accountSettings(account).enabled) continue;
    await syncAccount(account);
  }
}

async function syncNow(account) {
  await syncAccount(account);
  return engine.getSyncState(account);
}

// ---------------------------------------------------------------------------
// Write-through ops (called by engine.modify / engine.send / engine.attachment)
// ---------------------------------------------------------------------------
const FOLDER_LABELS = {
  Archive: { remove: ['INBOX'] },
  Trash: { add: ['TRASH'], remove: ['INBOX', 'SPAM'] },
  Spam: { add: ['SPAM'], remove: ['INBOX'] },
  INBOX: { add: ['INBOX'], remove: ['TRASH', 'SPAM'] },
};

// Canonical engine flags: UNREAD / STARRED (matching Gmail labels; IMAP maps
// them to \Seen / \Flagged). Returns the DB changes for applyEmailChanges.
async function applyModify(account, uid, { addFlags = [], removeFlags = [], move, del, restore } = {}) {
  const token = await gapi.getToken(gapi.SCOPES.gmail, account);
  const changes = {};

  if (del) {
    const permanent = typeof del === 'object' && del.permanent;
    // gmail.modify scope allows trash but not delete — trash for all cases;
    // permanence is engine-side (is_deleted + tombstone)
    await gapi.post(`${API}/messages/${uid}/trash`, token);
    if (permanent) { changes.isDeleted = true; changes.permanent = true; }
    else changes.folder = 'Trash';
    return changes;
  }
  if (restore) {
    changes.isDeleted = false;
    return changes; // DB-only: soft-deleted row comes back, server untouched
  }

  const add = [];
  const remove = [];
  for (const f of addFlags) {
    if (f === 'UNREAD') add.push('UNREAD');
    if (f === 'STARRED') add.push('STARRED');
  }
  for (const f of removeFlags) {
    if (f === 'UNREAD') remove.push('UNREAD');
    if (f === 'STARRED') remove.push('STARRED');
  }
  if (move) {
    const action = FOLDER_LABELS[move] || {};
    add.push(...(action.add || []));
    remove.push(...(action.remove || []));
    changes.folder = move;
  }
  if (add.length || remove.length) {
    await gapi.post(`${API}/messages/${uid}/modify`, token, { addLabelIds: add, removeLabelIds: remove });
  }
  if (add.includes('UNREAD')) changes.isUnread = true;
  if (remove.includes('UNREAD')) changes.isUnread = false;
  if (add.includes('STARRED')) changes.isStarred = true;
  if (remove.includes('STARRED')) changes.isStarred = false;
  return changes;
}

// Same MIME builder as my-dashboard's buildMimeMessage, but honoring the full
// references chain (plan Q6 — today's app drops it).
// Every value below is folded into a raw header, so a CR or LF inside one
// injects a header of the caller's choosing (a Bcc, most usefully). Reply
// subjects are DERIVED from the parent message — untrusted mail — so this is
// reachable rather than theoretical. Strip rather than reject: a header that
// lost a line break is still the mail the user asked for.
const hdrSafe = (v) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim();

// A raw non-ASCII header value is not legal and renders as mojibake in most
// clients. RFC 2047 encoded-word, base64 flavour, applied whole.
const encodeHeaderWord = (v) => (/^[\x20-\x7E]*$/.test(v)
  ? v
  : `=?utf-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`);

function buildMimeMessage({ from, to, cc, bcc, subject, body, htmlBody, inReplyTo, references, attachments }) {
  const boundary = 'boundary_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  let raw = `From: ${hdrSafe(from)}\r\nTo: ${hdrSafe(to)}\r\n`;
  if (cc) raw += `Cc: ${hdrSafe(cc)}\r\n`;
  if (bcc) raw += `Bcc: ${hdrSafe(bcc)}\r\n`;
  raw += `Subject: ${encodeHeaderWord(hdrSafe(subject))}\r\n`;
  // Two independent headers, not one: a payload carrying an accumulated
  // References chain but no In-Reply-To used to lose the chain entirely.
  if (inReplyTo) raw += `In-Reply-To: ${hdrSafe(inReplyTo)}\r\n`;
  const refs = hdrSafe(references || inReplyTo);
  if (refs) raw += `References: ${refs}\r\n`;
  raw += `MIME-Version: 1.0\r\n`;

  // Body block: text/plain alone, or multipart/alternative when an HTML part
  // rides along (e.g. forwards preserving the original's formatting). BOTH
  // parts are base64-encoded: arbitrarily long lines stay RFC-compliant, and
  // 8-bit text goes out declared rather than smuggled. The text part used to be
  // emitted raw with no Content-Transfer-Encoding, which quietly corrupted any
  // non-ASCII body — now routine, since replies carry a quoted trail.
  const b64wrap = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const altBoundary = 'alt_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  const textPart = `Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64wrap(body || '')}`;
  const bodyBlock = htmlBody
    ? `Content-Type: multipart/alternative; boundary="${altBoundary}"\r\n\r\n`
      + `--${altBoundary}\r\n${textPart}\r\n`
      + `--${altBoundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64wrap(htmlBody)}\r\n`
      + `--${altBoundary}--`
    : textPart;

  if (!attachments?.length) {
    raw += bodyBlock;
  } else {
    raw += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
    raw += `--${boundary}\r\n${bodyBlock}\r\n`;
    for (const att of attachments) {
      const safeName = hdrSafe(att.filename || 'attachment').replace(/"/g, '\\"') || 'attachment';
      raw += `--${boundary}\r\nContent-Type: ${att.contentType || 'application/octet-stream'}; name="${safeName}"\r\n`;
      raw += `Content-Disposition: attachment; filename="${safeName}"\r\n`;
      raw += `Content-Transfer-Encoding: base64\r\n\r\n`;
      raw += att.base64Data + '\r\n';
    }
    raw += `--${boundary}--`;
  }
  return raw;
}

// attachments: [{filename, contentType, base64Data}]
async function send(account, payload) {
  const token = await gapi.getToken(gapi.SCOPES.gmailSend, account);
  const raw = buildMimeMessage({ ...payload, from: account });
  const encoded = Buffer.from(raw).toString('base64url');
  const res = await gapi.post(`${API}/messages/send`, token, {
    raw: encoded,
    ...(payload.threadId ? { threadId: payload.threadId } : {}),
  });
  return { uid: res.id || null, threadId: res.threadId || null };
}

async function fetchAttachment(account, uid, attachmentId) {
  const token = await gapi.getToken(gapi.SCOPES.gmail, account);
  const att = await gapi.get(`${API}/messages/${uid}/attachments/${attachmentId}`, token);
  if (!att?.data) throw new Error('Attachment not found');
  return Buffer.from(att.data, 'base64url');
}

engine.registerProvider('gmail', {
  poll, syncNow, accounts: gmailAccounts, parseGmailMessage, folderFromLabels,
  applyModify, send, fetchAttachment,
});

module.exports = {
  poll, syncNow, gmailAccounts, parseGmailMessage, folderFromLabels,
  applyModify, send, fetchAttachment, buildMimeMessage,
};
