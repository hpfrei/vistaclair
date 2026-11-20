// The slim, incremental transcript of an orchestrator session for the Telegram
// Mini App (platform-tg-runs.js, GET /pro/tg-session/api/run/:runId).
//
// Two sources, one entry shape `{ id, role: 'user'|'assistant'|'tools', text,
// ts, toolCount?, from?, open? }`:
//   sdk  the session folder's transcript.jsonl (SdkSession's envelopes, every
//        orchestrator of the run — a refresh or resume appends to the same
//        file). Read by byte offset: a poll parses only what was appended.
//   cli  the interaction store (`store.loadSessionIntoMemory(sessId)`), the
//        same heuristic as the legacy tg-session transcript; processed
//        interactions are remembered per sessId, so a poll handles only new
//        ones (and keeps turns the store has since evicted from memory).
// Dropped: subagent, hook and MCP rows, tool results, notices and statuses.
// The tool_use blocks between two texts become ONE `tools` entry
// ("🔧 3 tools: Read, Edit, Bash"); while a turn is still calling tools that
// entry is returned `open: true` after the cursor and comes again, grown, on
// the next poll (same id — the client replaces it).
//
// Cursor `<tag>.<count>`: tag names the source (folder file or sessId), count
// the finalized entries the client holds. Another tag, a count beyond what
// exists, or none → `reset: true` with the last RESET_ENTRIES entries.

const fs = require('fs');
const crypto = require('crypto');

const TEXT_CAP = 6000;
const RESET_ENTRIES = 200;
const MAX_CACHES = 20;

const caches = new Map(); // source key → { tag, entries, open, …source state }

function tagOf(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
}

function clip(s) {
  const t = String(s || '');
  return t.length > TEXT_CAP ? `${t.slice(0, TEXT_CAP)}…` : t;
}

function cacheFor(key, init) {
  let c = caches.get(key);
  if (!c) {
    c = { tag: tagOf(key), entries: [], open: null, ...init() };
    caches.set(key, c);
    if (caches.size > MAX_CACHES) caches.delete(caches.keys().next().value);
  }
  return c;
}

// --- Entry assembly (shared) ---

function push(c, entry) {
  closeTools(c);
  c.entries.push({ id: String(c.entries.length), ...entry, text: clip(entry.text) });
}

function addTools(c, names, ts) {
  if (!names.length) return;
  if (!c.open) c.open = { names: [], ts };
  c.open.names.push(...names);
}

function toolsEntry(group, id) {
  const unique = [...new Set(group.names)];
  const n = group.names.length;
  return { id: String(id), role: 'tools', text: `🔧 ${n} tool${n === 1 ? '' : 's'}: ${unique.join(', ')}`, ts: group.ts, toolCount: n };
}

function closeTools(c) {
  if (!c.open) return;
  const group = c.open;
  c.open = null;
  c.entries.push(toolsEntry(group, c.entries.length));
}

// --- sdk: the folder transcript.jsonl ---

function sdkEnvelope(c, env, orchestrator) {
  const ev = env && env.ev;
  if (!ev) return;
  const ts = env.ts || null;
  if (ev.user) {
    const u = ev.user;
    if (u.pending || u.cancelled || !String(u.text || '').trim()) return;
    push(c, { role: 'user', text: u.text, ts, ...(u.from ? { from: u.from } : {}) });
  } else if (ev.sdk) {
    const m = ev.sdk;
    if (m.type === 'result') { closeTools(c); return; }
    if (m.type !== 'assistant' || m.parent_tool_use_id) return;
    const content = Array.isArray(m.message && m.message.content) ? m.message.content : [];
    const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
    if (text.trim()) push(c, { role: 'assistant', text, ts });
    addTools(c, content.filter((b) => b && b.type === 'tool_use').map((b) => b.name || 'tool'), ts);
  } else if (ev.platform && ev.platform.kind === 'message') {
    const p = ev.platform;
    if (orchestrator && p.from === orchestrator) push(c, { role: 'assistant', text: `→ ${p.to}: ${p.text}`, ts });
    else push(c, { role: 'user', text: p.text, ts, from: p.from });
  }
}

function readSdk(file, orchestrator) {
  const c = cacheFor(`sdk:${file}`, () => ({ offset: 0, partial: '' }));
  let size = 0;
  try { size = fs.statSync(file).size; } catch { size = 0; }
  if (size < c.offset) { // rewritten: parse again from the start
    c.entries = []; c.open = null; c.offset = 0; c.partial = '';
  }
  if (size > c.offset) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - c.offset);
      fs.readSync(fd, buf, 0, buf.length, c.offset);
      c.offset = size;
      const lines = (c.partial + buf.toString('utf8')).split('\n');
      c.partial = lines.pop(); // an unfinished last line waits for the next read
      for (const line of lines) {
        if (!line.trim()) continue;
        let env;
        try { env = JSON.parse(line); } catch { continue; }
        sdkEnvelope(c, env, orchestrator);
      }
    } finally { fs.closeSync(fd); }
  }
  return c;
}

// --- cli: the interaction store ---

function userTextOf(i) {
  const messages = (i.request && i.request.messages) || [];
  for (let m = messages.length - 1; m >= 0; m--) {
    const msg = messages[m];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content) && !msg.content.some((b) => b && b.type === 'tool_result')) {
      return msg.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
    }
    return null; // only the last user message per interaction
  }
  return null;
}

function readCli(store, sessId) {
  const c = cacheFor(`cli:${sessId}`, () => ({ seen: new Set(), lastUserText: null }));
  let list = [];
  try { list = store.loadSessionIntoMemory(sessId) || []; } catch { list = []; }
  const fresh = list
    .filter((i) => i && !i.isHook && !i.isMcp && !i.deleted && !i.subagent && !c.seen.has(i.id))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  for (const i of fresh) {
    if (i.status === 'pending' || i.status === 'streaming') break; // keep the order: wait for it
    c.seen.add(i.id);
    const user = userTextOf(i);
    if (user && user.trim() && user !== c.lastUserText) {
      push(c, { role: 'user', text: user, ts: i.timestamp || null });
      c.lastUserText = user;
    }
    const content = i.response && i.response.body && i.response.body.content;
    if (!Array.isArray(content)) continue;
    const text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
    if (text.trim()) push(c, { role: 'assistant', text, ts: i.timestamp || null });
    addTools(c, content.filter((b) => b && b.type === 'tool_use').map((b) => b.name || 'tool'), i.timestamp || null);
  }
  return c;
}

// --- The read ---

// source: { kind: 'sdk', file, orchestrator } | { kind: 'cli', store, sessId }
// → { transcript, cursor, reset }
function read(source, since) {
  let c = null;
  if (source && source.kind === 'sdk' && source.file) c = readSdk(source.file, source.orchestrator);
  else if (source && source.kind === 'cli' && source.store && source.sessId) c = readCli(source.store, source.sessId);
  if (!c) return { transcript: [], cursor: null, reset: true };
  const total = c.entries.length;
  const m = /^([0-9a-f]{8})\.(\d+)$/.exec(String(since || ''));
  const from = m && m[1] === c.tag && Number(m[2]) <= total ? Number(m[2]) : null;
  const transcript = from === null ? c.entries.slice(-RESET_ENTRIES) : c.entries.slice(from);
  if (c.open) transcript.push({ ...toolsEntry(c.open, total), open: true });
  return { transcript, cursor: `${c.tag}.${total}`, reset: from === null };
}

function _reset() { caches.clear(); }

module.exports = { read, _reset };
