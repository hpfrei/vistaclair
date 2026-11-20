// Decision ledger — durable, append-only record of every terminal decision on
// a governance proposal (approve / deny / expire / auto), including what the
// user EDITED before approving: the richest preference signal the platform
// has. proposals.json cannot serve this role (cap 300 + 7-day TTL — history
// evaporates), so rows are written at decision time by horst-governance.js.
//
// Store: .horst/decisions.jsonl — one JSON object per line, appended with
// O_APPEND (atomic for <4KB lines on Linux); the reader skips unparseable
// lines, so a crash can at worst truncate one tail row. Rotation: when the
// live file exceeds ~2MB it is renamed decisions-<year>.jsonl and restarted.
//
// HARD RULES:
// - record() must NEVER throw into a decision path (fully try/caught) and must
//   NEVER touch proposals.json (the expiry hook lives inside loadProposals —
//   reading it back from here would recurse).
// - Ledger rows are attachment-free: payloads enter as compact kind-aware
//   projections, base64-looking values dropped, whole line capped.
// - Prompt surfaces built on stats() use mechanical aggregates only — never
//   payload or diff text (G9: payloads are downstream of untrusted content).
//
// v2 hook (not built): stats().streakCleanApprovals — consecutive most-recent
// human approvals without edit per kind — is what a future dial-calibration
// proposal ("promote calendar.create to auto+notify?") will argue from.
//
// Dependency-free (fs/path only), local helpers per the governance convention.
const fs = require('fs');
const path = require('path');

const MAX_LINE_BYTES = 4096;
const CLIP_DIFF = 300;
const CLIP_DEFAULT = 120;
const ROTATE_BYTES = 2 * 1024 * 1024;
const BASE64ISH = /^[A-Za-z0-9+/=\r\n]{200,}$/;

// Fields the SERVER recomputes from other payload fields (email-compose's
// `compose` hook). They move whenever a source moves, so counting them as
// human edits would feed a fabricated signal straight back into drafting:
// stats().editedFieldCounts → promptBlock() → draftReply's systemPrompt, i.e.
// flipping a checkbox would teach the model "the body is usually rewritten
// before approval". The preference itself is kept, as the `signature` field.
const DERIVED_FIELDS = new Set([
  'body', 'htmlBody', 'quotedText', 'quotedHtml', 'quoteAttribution',
  'quoteSha256', 'quoteDerived', 'quoteTrimmed', 'composeVersion',
]);

let dir = null;
let statsCache = null; // { key: 'mtime:size', value }

function init(options) {
  dir = options.dir;
  fs.mkdirSync(dir, { recursive: true });
}

function ledgerPath() { return path.join(dir, 'decisions.jsonl'); }

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------
function clip(v, n) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return null;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Kind-aware compact projection — enough to later answer "what do approved
// <kind> payloads look like", never enough to bloat the file. Attachments and
// base64-looking values are dropped unconditionally.
function compactPayload(kind, payload) {
  if (!payload || typeof payload !== 'object') return null;
  try {
    if (kind === 'email.send') {
      return {
        account: payload.account, to: clip(payload.to, CLIP_DEFAULT), subject: clip(payload.subject, CLIP_DEFAULT),
        bodyChars: typeof payload.body === 'string' ? payload.body.length : null,
        // For a composed reply the body is reply + signature + quoted trail;
        // the preview that answers "what did approved mail look like" is the
        // human-authored part, not the trail it was stitched onto.
        bodyPreview: clip(typeof payload.replyText === 'string' ? payload.replyText : payload.body, 200),
        replyChars: typeof payload.replyText === 'string' ? payload.replyText.length : null,
        includeSignature: typeof payload.includeSignature === 'boolean' ? payload.includeSignature : null,
        attachments: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
      };
    }
    if (kind === 'calendar.create' || kind === 'calendar.update') {
      return {
        title: clip(payload.title || payload.summary, CLIP_DEFAULT), date: payload.date || null,
        startTime: payload.startTime || null, endTime: payload.endTime || null,
        allDay: payload.allDay || false, location: clip(payload.location, CLIP_DEFAULT),
      };
    }
    if (kind === 'email.rule.add') return { type: payload.type, value: clip(payload.value, CLIP_DEFAULT) };
    if (kind === 'todo.create') return { title: clip(payload.title, CLIP_DEFAULT), dueAt: payload.dueAt || null, watch: !!payload.watch };
    // The plan is what the owner approved; the args are its machine half.
    if (kind === 'app.tool.job') return { app: payload.app, tool: payload.tool, plan: clip(payload.plan, 500), args: clip(payload.args, 200) };
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
      if (v == null) continue;
      if (typeof v === 'string' && BASE64ISH.test(v)) continue;
      if (k === 'attachments' || k === 'base64Data') { out[k] = Array.isArray(v) ? v.length : '(dropped)'; continue; }
      out[k] = clip(v, CLIP_DEFAULT);
    }
    return out;
  } catch {
    return null;
  }
}

// Shallow field-level diff: original draft → final payload (the NET preference
// signal — intermediate edits are noise). Values clipped for the ledger.
function diffPayloads(before, after) {
  const editedFields = [];
  const editDiff = [];
  try {
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    // Only a composed reply HAS derived fields. For hand-composed mail `body`
    // is the edit signal itself and must keep counting — the carve-out is
    // scoped to payloads that carry their own sources, never applied blanket.
    const composed = before?.replyText != null || after?.replyText != null;
    for (const k of keys) {
      if (composed && DERIVED_FIELDS.has(k)) continue;
      const b = before?.[k];
      const a = after?.[k];
      if (JSON.stringify(b) === JSON.stringify(a)) continue;
      editedFields.push(k);
      const safe = (v) => (typeof v === 'string' && BASE64ISH.test(v)) ? '(binary)' : clip(v, CLIP_DIFF);
      editDiff.push({ field: k, before: safe(b), after: safe(a) });
    }
  } catch { /* diff is best-effort */ }
  return { editedFields: editedFields.length ? editedFields : null, editDiff: editDiff.length ? editDiff : null };
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(ledgerPath());
    if (st.size > ROTATE_BYTES) {
      const year = new Date().getFullYear();
      let target = path.join(dir, `decisions-${year}.jsonl`);
      let i = 1;
      while (fs.existsSync(target)) target = path.join(dir, `decisions-${year}.${i++}.jsonl`);
      fs.renameSync(ledgerPath(), target);
    }
  } catch { /* no file yet, or stat failed — fine */ }
}

// Append one decision row. NEVER throws — a ledger failure must not break the
// decision it records.
function record(row) {
  try {
    if (!dir) return;
    rotateIfNeeded();
    let line = JSON.stringify({ at: Date.now(), ...row });
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      // Defensive: drop the diff first, then the payload — the decision
      // itself (kind, verdict, via, latency) always survives.
      const slim = { at: Date.now(), ...row, editDiff: null, payload: null, oversize: true };
      line = JSON.stringify(slim).slice(0, MAX_LINE_BYTES);
    }
    fs.appendFileSync(ledgerPath(), line + '\n');
    statsCache = null;
    sourceCache = null;
  } catch (err) {
    console.warn('[horst-decisions] record failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------
function readAll() {
  try {
    const raw = fs.readFileSync(ledgerPath(), 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* torn tail line — skip */ }
    }
    return rows;
  } catch {
    return [];
  }
}

// "What was decided about THIS message?" — the per-message view of the ledger.
//
// This is what lets an app render an approved/denied chip beside an email
// without keeping its own copy of every decision: the ledger already holds the
// answer, it just had no read shaped like the question. Indexed by
// account+uid and cached against the file's mtime+size, because the caller is
// an inbox render — one whole-file parse per page, not per message.
//
// Rows are newest-first per uid. Mechanical fields only: no payload, no edit
// diff (G9 — those are downstream of untrusted content and have no business in
// an inbox badge).
let sourceCache = null; // { key: 'mtime:size', value: Map<'account\u0000uid', row[]> }

function sourceIndex() {
  let key = 'empty';
  try {
    const st = fs.statSync(ledgerPath());
    key = `${st.mtimeMs}:${st.size}`;
  } catch { /* no file */ }
  if (sourceCache && sourceCache.key === key) return sourceCache.value;

  const index = new Map();
  for (const r of readAll()) {
    const src = r.source;
    if (!src || src.type !== 'email' || !src.account || !src.uid) continue;
    const k = `${src.account}\u0000${src.uid}`;
    let list = index.get(k);
    if (!list) index.set(k, (list = []));
    list.push({
      at: r.at || null, kind: r.kind, decision: r.decision, via: r.via || null,
      edited: !!r.edited, outcome: r.outcome || null, summary: r.summary || null,
      proposalId: r.proposalId || null,
      // Only when the decision was about one extracted item of the message
      // (event 0 vs event 1 of the same mail) — absent otherwise, so a caller
      // keying on it does not have to distinguish null from "not applicable".
      ...(src.eventIdx == null ? {} : { eventIdx: src.eventIdx }),
    });
  }
  for (const list of index.values()) list.reverse(); // newest first
  sourceCache = { key, value: index };
  return index;
}

function bySource({ account, uids } = {}) {
  if (!account || !Array.isArray(uids) || !uids.length) return {};
  const index = sourceIndex();
  const out = {};
  for (const uid of uids) {
    const rows = index.get(`${account}\u0000${String(uid)}`);
    if (rows && rows.length) out[String(uid)] = rows;
  }
  return out;
}

function list({ kind, decision, limit = 100 } = {}) {
  let rows = readAll().reverse(); // newest first
  if (kind) rows = rows.filter((r) => r.kind === kind);
  if (decision) rows = rows.filter((r) => r.decision === decision);
  return rows.slice(0, Math.min(Number(limit) || 100, 1000));
}

// Aggregates per kind (with per-origin breakdown), cached against file
// mtime+size. Human decisions = approve/deny/expire; 'auto' rows are tracked
// separately (no preference signal, but v2 wants failure rates at auto).
function stats({ halfLifeDays = 30 } = {}) {
  let key = 'empty';
  try {
    const st = fs.statSync(ledgerPath());
    key = `${st.mtimeMs}:${st.size}`;
  } catch { /* no file */ }
  if (statsCache && statsCache.key === key) return statsCache.value;

  const rows = readAll();
  const now = Date.now();
  const perKind = {};
  for (const r of rows) {
    if (!r.kind || !r.decision) continue;
    const k = perKind[r.kind] || (perKind[r.kind] = {
      total: 0, approved: 0, denied: 0, expired: 0, auto: 0, autoFailed: 0, edited: 0,
      weightedApproved: 0, weightedDecided: 0,
      editedFieldCounts: {}, byOrigin: {}, lastDecisionAt: 0, lastDenialSummary: null,
      streakCleanApprovals: 0, _streakOpen: true,
    });
    k.total++;
    k.lastDecisionAt = Math.max(k.lastDecisionAt, r.at || 0);
    const origin = r.origin || '?';
    k.byOrigin[origin] = (k.byOrigin[origin] || 0) + 1;
    if (r.decision === 'auto') {
      k.auto++;
      if (r.outcome === 'failed') k.autoFailed++;
      continue;
    }
    const w = Math.pow(0.5, (now - (r.at || now)) / (halfLifeDays * 86400e3));
    k.weightedDecided += w;
    if (r.decision === 'approve') { k.approved++; k.weightedApproved += w; }
    else if (r.decision === 'deny') { k.denied++; if (!k.lastDenialSummary) k.lastDenialSummary = null; }
    else if (r.decision === 'expire') k.expired++;
    if (r.edited) {
      k.edited++;
      for (const f of r.editedFields || []) k.editedFieldCounts[f] = (k.editedFieldCounts[f] || 0) + 1;
    }
  }
  // Streak of most-recent consecutive clean human approvals (newest-first walk).
  for (const kind of Object.keys(perKind)) {
    let streak = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.kind !== kind || r.decision === 'auto') continue;
      if (r.decision === 'approve' && !r.edited) streak++;
      else break;
    }
    perKind[kind].streakCleanApprovals = streak;
    delete perKind[kind]._streakOpen;
    const s = perKind[kind];
    const humans = s.approved + s.denied + s.expired;
    s.approvalRate = humans ? +(s.approved / humans).toFixed(2) : null;
    s.editRate = s.approved ? +(s.edited / s.approved).toFixed(2) : null;
    s.weightedApprovalRate = s.weightedDecided ? +(s.weightedApproved / s.weightedDecided).toFixed(2) : null;
    // Newest denial summary for context (mechanical field, shown in UI only).
    const denial = rows.filter((r) => r.kind === kind && r.decision === 'deny').pop();
    s.lastDenialSummary = denial ? String(denial.summary || '').slice(0, 120) : null;
  }
  const value = perKind;
  statsCache = { key, value };
  return value;
}

// Compact prompt block — mechanical aggregates ONLY (G9: never payload text).
// Empty string until a kind reaches minCount human decisions, so zero-data
// prompts carry no empty header.
function promptBlock({ minCount = 3, maxLines = 10, kinds = null } = {}) {
  const all = stats();
  const lines = [];
  const entries = Object.entries(all)
    .filter(([kind, s]) => (!kinds || kinds.includes(kind)) && (s.approved + s.denied + s.expired) >= minCount)
    .sort((a, b) => (b[1].approved + b[1].denied) - (a[1].approved + a[1].denied));
  for (const [kind, s] of entries) {
    if (lines.length >= maxLines) break;
    const humans = s.approved + s.denied + s.expired;
    const bits = [`${humans} decided`, `${s.approved} approved${s.approvalRate != null ? ` (${Math.round(s.approvalRate * 100)}%)` : ''}`];
    if (s.denied) bits.push(`${s.denied} denied`);
    if (s.edited) {
      const topFields = Object.entries(s.editedFieldCounts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([f]) => f);
      bits.push(`edited before approval in ${s.edited}/${s.approved}${topFields.length ? ` (usually ${topFields.join(', ')})` : ''}`);
    }
    lines.push(`- ${kind}: ${bits.join(', ')}`);
  }
  if (!lines.length) return '';
  return 'DECISION PATTERNS (learned from the user\'s past approvals — match these preferences when drafting):\n' + lines.join('\n');
}

module.exports = { init, record, diffPayloads, compactPayload, list, bySource, stats, promptBlock };
