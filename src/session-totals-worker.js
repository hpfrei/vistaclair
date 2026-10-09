// Worker half of SessionTotals: reads the turn files of one session dir that
// the cache does not cover yet and posts their raw usage back in batches.
//
// Only the tail of each file is parsed. Files are written pretty-printed
// (JSON.stringify(_, null, 2)) with `request` before `response`, and a long
// session's request carries the whole conversation — hundreds of KB per
// turn. String values escape their newlines, so a newline followed by
// exactly two spaces only ever starts a top-level key; everything from
// `response` on is a valid object body once a `{` is put in front of it.
const fs = require('fs');
const path = require('path');
const { parentPort, workerData } = require('worker_threads');

const RESPONSE_KEY = '\n  "response": {';
const ID_RE = /^\{\s*"id": "((?:[^"\\]|\\.)*)"/;
const MODEL_RE = /\n    "model": "((?:[^"\\]|\\.)*)"/;
const HEAD = 4096;
const BATCH = 500;

function readRange(fd, start, end) {
  const buf = Buffer.allocUnsafe(end - start);
  const n = fs.readSync(fd, buf, 0, buf.length, start);
  return buf.toString('utf8', 0, n);
}

function countToolUses(resp) {
  let n = 0;
  if (Array.isArray(resp.body?.content)) {
    for (const b of resp.body.content) if (b?.type === 'tool_use') n++;
    return n;
  }
  for (const e of resp.sseEvents || []) {
    if (e?.eventType === 'content_block_start' && e.data?.content_block?.type === 'tool_use') n++;
  }
  return n;
}

function rawFrom(data, fallbackId) {
  const resp = data.response || {};
  return {
    id: data.id || fallbackId,
    model: data.request?.model || null,
    usage: resp.usage || null,
    pricing: data.pricing || null,
    timing: resp.timing || null,
    tools: countToolUses(resp),
    isHook: !!data.isHook,
    hookEvent: data.hookEvent || null,
    isMcp: !!data.isMcp,
  };
}

function readTurn(filePath, fallbackId) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const head = readRange(fd, 0, Math.min(size, HEAD));
    // Grow the tail window until it holds the response key; a turn with a
    // large streamed response needs more than the first guess.
    let start = size, text = '', at = -1;
    for (let want = 256 * 1024; at < 0 && start > 0; want *= 4) {
      start = Math.max(0, size - want);
      text = readRange(fd, start, size);
      at = text.indexOf(RESPONSE_KEY);
    }
    if (at >= 0) {
      try {
        const tail = JSON.parse('{' + text.slice(at));
        const raw = rawFrom(tail, fallbackId);
        const id = head.match(ID_RE);
        if (id) raw.id = JSON.parse(`"${id[1]}"`);
        const model = head.match(MODEL_RE);
        if (model) raw.model = JSON.parse(`"${model[1]}"`);
        return raw;
      } catch {}
    }
    // Not the layout we expect (or the tail did not parse): read it whole.
    const full = start === 0 ? text : readRange(fd, 0, size);
    const data = JSON.parse(full);
    return data && typeof data === 'object' && !Array.isArray(data) ? rawFrom(data, fallbackId) : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function run({ dir, sessId, known }) {
  const skip = new Set(known);
  let names;
  try { names = fs.readdirSync(dir); } catch { names = []; }
  const seqs = [];
  for (const f of names) {
    if (!/^\d+\.json$/.test(f)) continue;
    const seq = parseInt(f, 10);
    if (!skip.has(seq)) seqs.push(seq);
  }
  seqs.sort((a, b) => a - b);
  parentPort.postMessage({ type: 'start', total: seqs.length });
  let batch = [];
  for (const seq of seqs) {
    const raw = readTurn(path.join(dir, `${seq}.json`), `${sessId}-${seq}`);
    batch.push([seq, raw]);
    if (batch.length >= BATCH) {
      parentPort.postMessage({ type: 'batch', entries: batch });
      batch = [];
    }
  }
  parentPort.postMessage({ type: 'batch', entries: batch });
  parentPort.postMessage({ type: 'done' });
}

if (parentPort && workerData) run(workerData);

module.exports = { readTurn };
