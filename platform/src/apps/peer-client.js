// Master-side HTTP client for a linked slave's /api/peer/* control plane.
// JSON calls ride global fetch; the data-bundle upload uses a raw http(s)
// request so the tar.gz streams from disk with a known Content-Length and
// per-chunk progress. All calls carry the peer token from the registry.
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const security = require('./peer-security');

class PeerError extends Error {
  constructor(message, { status, step, body } = {}) {
    super(message);
    this.name = 'PeerError';
    this.status = status || null;
    this.step = step || null;
    this.body = body || null;   // the slave's JSON error answer, when it sent one
  }
}

// The peer token is a bearer credential for the whole slave: it never goes to a
// plain-http base (loopback excepted), and a peer flagged needsRepair is one
// that was linked that way before this rule existed.
function assertSecure(peer) {
  if (peer.needsRepair || !security.isSecureUrl(peer.baseUrl)) {
    throw new PeerError(`refusing to send the peer token to ${peer.name} (${peer.baseUrl}) over plain HTTP — re-pair the slave over https://`);
  }
}

function headers(peer, extra = {}) {
  return { 'X-Vistaclair-Peer-Token': peer.token, ...extra };
}

// Read a response body as JSON, refusing one over `maxBytes` (a peer's answer
// is untrusted: it is never buffered past the cap). null when not JSON.
async function readJson(res, maxBytes) {
  if (!maxBytes) { try { return await res.json(); } catch { return null; } }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel(); } catch {}
    throw new PeerError('too-large', { status: res.status, step: 'too-large' });
  }
  const chunks = [];
  let n = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      n += chunk.length;
      if (n > maxBytes) {
        try { await res.body.cancel(); } catch {}
        throw new PeerError('too-large', { status: res.status, step: 'too-large' });
      }
      chunks.push(Buffer.from(chunk));
    }
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { return null; }
}

// `maxBytes` caps the answer (PeerError step 'too-large' past it).
async function call(peer, apiPath, { method = 'GET', body, timeoutMs = 30000, signal, maxBytes } = {}) {
  assertSecure(peer);
  const url = peer.baseUrl.replace(/\/+$/, '') + '/api/peer' + apiPath;
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: headers(peer, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any(signals),
      // Never follow a redirect with the token attached: undici keeps custom
      // headers across origins. A 3xx surfaces as "answered HTTP 30x".
      redirect: 'manual',
    });
  } catch (err) {
    if (signal?.aborted) throw new PeerError('cancelled');
    throw new PeerError(`cannot reach ${peer.name} (${peer.baseUrl}): ${err.cause?.message || err.message}`);
  }
  let json = null;
  try { json = await readJson(res, maxBytes); } catch (err) {
    if (err instanceof PeerError) throw err;
    if (signal?.aborted) throw new PeerError('cancelled');
  }
  if (!res.ok) {
    throw new PeerError(json?.error || `${peer.name} answered HTTP ${res.status}`, { status: res.status, body: json });
  }
  return json;
}

// Stream a file as the request body (application/octet-stream). `start` /
// `length` send one byte range of it (fleet-data.js chunks), `method` PUT.
function uploadFile(peer, apiPath, filePath, { signal, onProgress, timeoutMs = 30 * 60 * 1000, method = 'POST', start = 0, length } = {}) {
  let onAbort = null;
  return new Promise((resolve, reject) => {
    try { assertSecure(peer); } catch (err) { return reject(err); }
    const url = new URL(peer.baseUrl.replace(/\/+$/, '') + '/api/peer' + apiPath);
    const mod = url.protocol === 'https:' ? https : http;
    let size;
    try { size = length ?? fs.statSync(filePath).size - start; } catch (err) { return reject(err); }

    const req = mod.request(url, {
      method,
      headers: headers(peer, { 'Content-Type': 'application/octet-stream', 'Content-Length': size }),
      timeout: timeoutMs,
    });

    let stream = null;
    const fail = (err) => {
      req.destroy();
      stream?.destroy();
      reject(err instanceof PeerError ? err : new PeerError(`upload to ${peer.name} failed: ${err.message}`));
    };

    if (signal) {
      if (signal.aborted) return fail(new PeerError('cancelled'));
      onAbort = () => fail(new PeerError('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('timeout', () => fail(new PeerError('upload timed out')));
    req.on('error', fail);
    req.on('response', (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json || {});
        // 413 without a JSON body is a reverse proxy (nginx defaults to 1 MB)
        // refusing the upload before vistaclair ever saw it.
        else if (res.statusCode === 413 && !json) fail(new PeerError(`${peer.name} rejected the upload with HTTP 413 — its reverse proxy limits request bodies (nginx: raise client_max_body_size on the slave)`, { status: 413 }));
        else fail(new PeerError(json?.error || `${peer.name} answered HTTP ${res.statusCode}`, { status: res.statusCode, body: json }));
      });
    });

    let sent = 0;
    if (size === 0) { req.end(); return; }
    stream = fs.createReadStream(filePath, { start, end: start + size - 1 });
    stream.on('error', fail);
    stream.on('data', (chunk) => {
      sent += chunk.length;
      onProgress?.(sent, size);
    });
    stream.pipe(req);
  }).finally(() => { if (onAbort) signal.removeEventListener('abort', onAbort); });
}

// GET one raw byte range from the slave (the up direction of the fleet data
// publish, fleet-data-up.js): resolves on a 2xx with { stream, length } — the
// response itself, never buffered, `length` its Content-Length. A non-2xx
// rejects with the slave's JSON answer (read up to 64 KB) as `body`. The
// caller consumes or destroys the stream; `signal` destroys it.
function download(peer, apiPath, { signal, timeoutMs = 10 * 60 * 1000 } = {}) {
  let onAbort = null;
  return new Promise((resolve, reject) => {
    try { assertSecure(peer); } catch (err) { return reject(err); }
    const url = new URL(peer.baseUrl.replace(/\/+$/, '') + '/api/peer' + apiPath);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'GET', headers: headers(peer), timeout: timeoutMs });
    let settled = false;
    const fail = (err) => {
      req.destroy(err instanceof PeerError ? err : undefined);
      if (!settled) { settled = true; reject(err instanceof PeerError ? err : new PeerError(`download from ${peer.name} failed: ${err.message}`)); }
    };
    if (signal) {
      if (signal.aborted) return fail(new PeerError('cancelled'));
      onAbort = () => fail(new PeerError('cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.on('timeout', () => fail(new PeerError('download timed out')));
    req.on('error', fail);
    req.on('response', (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        settled = true;
        const length = Number(res.headers['content-length']);
        return resolve({ stream: res, length: Number.isSafeInteger(length) ? length : null });
      }
      let raw = '';
      res.on('data', (c) => { if (raw.length < 65536) raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        settled = true;
        reject(new PeerError(json?.error || `${peer.name} answered HTTP ${res.statusCode}`, { status: res.statusCode, body: json }));
      });
      res.on('error', fail);
    });
    req.end();
  }).finally(() => { if (onAbort) signal.removeEventListener('abort', onAbort); });
}

// Poll a slave-side job until it reaches a terminal state. Resolves with the
// final record on 'done'; throws on error/cancelled/interrupted.
async function pollJob(peer, appName, jobId, { signal, onProgress, intervalMs = 1000, timeoutMs = 30 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new PeerError('cancelled');
    if (Date.now() > deadline) throw new PeerError(`job on ${peer.name} timed out`);
    const job = await call(peer, `/jobs/${appName}/${jobId}`, { signal, timeoutMs: 15000 });
    if (job.progress) onProgress?.(job.progress.pct ?? null, job.progress.label ?? null);
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new PeerError(`job on ${peer.name} failed: ${job.error || 'unknown error'}`);
    if (job.status === 'cancelled' || job.status === 'interrupted') {
      throw new PeerError(`job on ${peer.name} was ${job.status}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { assertSecure, call, uploadFile, download, pollJob, PeerError };
