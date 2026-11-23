// Passive HTTP/1.1 parser for the agy-mitm tee (docs/agy-inspector.md). It
// reads copies of the plaintext both ways and never sits on the data path: the
// relay writes every byte before the tee sees it, and a parser error only
// stops the tee.
//
// Header values are read for framing and a short allow-list only. Every other
// header (Authorization, Cookie, x-goog-*, set-cookie, …) is compared by name
// inside the receive buffer and never turned into a string or copied out.
//
//   const tee = new H1Tee({ onExchange(req) { return sink | null } });
//   tee.clientData(buf); tee.upstreamData(buf); tee.close();
//
// onExchange(req) is called at each request head: req = { method, path,
// headers }. It returns null (the bodies are framed and dropped) or a sink:
//   { requestBody(buf), requestEnd(), responseHead(status, headers),
//     responseBody(buf), responseEnd(), aborted(reason) }
// Bodies arrive de-chunked but still content-encoded; headers holds only
// KEEP_HEADERS. 1xx responses are skipped; a 101 ends the tee (opaque bytes).
const KEEP_HEADERS = new Set(['content-type', 'content-encoding', 'content-length', 'transfer-encoding', 'user-agent']);
const MAX_HEAD = 64 * 1024;
const CRLF = Buffer.from('\r\n');
const CRLFCRLF = Buffer.from('\r\n\r\n');

class TeeError extends Error {}

class H1Parser {
  constructor(kind, onHead) {
    this.kind = kind;          // 'request' | 'response'
    this.onHead = onHead;      // (head) → { body(buf), end(), noBody?:bool, untilClose?:bool }
    this.state = 'head';
    this.buf = Buffer.alloc(0);
    this.remaining = 0;
    this.msg = null;
    this.dead = false;
  }

  push(chunk) {
    if (this.dead) return;
    let data = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.buf = Buffer.alloc(0);
    while (data.length && !this.dead) {
      switch (this.state) {
        case 'head': {
          const at = data.indexOf(CRLFCRLF);
          if (at === -1) {
            if (data.length > MAX_HEAD) throw new TeeError('head too long');
            this.buf = Buffer.from(data);
            return;
          }
          const head = _parseHead(data.subarray(0, at), this.kind);
          data = data.subarray(at + 4);
          this._startMessage(head);
          break;
        }
        case 'length': {
          const n = Math.min(this.remaining, data.length);
          this.msg.body(data.subarray(0, n));
          this.remaining -= n;
          data = data.subarray(n);
          if (this.remaining === 0) this._endMessage();
          break;
        }
        case 'close': {
          this.msg.body(data);
          return;
        }
        case 'chunk-size':
        case 'chunk-crlf':
        case 'trailer': {
          const at = data.indexOf(CRLF);
          if (at === -1) {
            if (data.length > 4096) throw new TeeError('chunk line too long');
            this.buf = Buffer.from(data);
            return;
          }
          const line = data.subarray(0, at);
          data = data.subarray(at + 2);
          if (this.state === 'chunk-crlf') {
            if (line.length) throw new TeeError('chunk crlf');
            this.state = 'chunk-size';
          } else if (this.state === 'trailer') {
            if (!line.length) this._endMessage();
          } else {
            const hex = line.toString('latin1').split(';')[0].trim();
            if (!/^[0-9a-fA-F]{1,12}$/.test(hex)) throw new TeeError('chunk size');
            const size = parseInt(hex, 16);
            if (size === 0) this.state = 'trailer';
            else { this.remaining = size; this.state = 'chunk-data'; }
          }
          break;
        }
        case 'chunk-data': {
          const n = Math.min(this.remaining, data.length);
          this.msg.body(data.subarray(0, n));
          this.remaining -= n;
          data = data.subarray(n);
          if (this.remaining === 0) this.state = 'chunk-crlf';
          break;
        }
        default:
          throw new TeeError('state');
      }
    }
  }

  _startMessage(head) {
    const framing = this.onHead(head);
    if (framing === 'stop') { this.dead = true; return; }
    this.msg = framing.sink;
    const te = (head.headers['transfer-encoding'] || '').toLowerCase();
    if (framing.noBody) return this._endMessage();
    if (te && te.split(',').map(s => s.trim()).pop() === 'chunked') {
      this.state = 'chunk-size';
    } else if (head.headers['content-length'] != null) {
      const n = Number(head.headers['content-length']);
      if (!Number.isSafeInteger(n) || n < 0) throw new TeeError('content-length');
      if (n === 0) return this._endMessage();
      this.remaining = n;
      this.state = 'length';
    } else if (this.kind === 'response') {
      this.state = 'close';    // read until the connection closes
    } else {
      this._endMessage();      // a request without framing has no body
    }
  }

  _endMessage() {
    const m = this.msg;
    this.msg = null;
    this.state = 'head';
    if (m) m.end();
  }

  /** The connection closed. Returns true if a message was cut off. */
  close() {
    if (this.dead) return false;
    this.dead = true;
    if (this.state === 'close' && this.msg) { this._endMessage(); return false; }
    return !!this.msg || this.state !== 'head' || this.buf.length > 0;
  }
}

function _parseHead(head, kind) {
  let lineEnd = head.indexOf(CRLF);
  if (lineEnd === -1) lineEnd = head.length;
  // The start line holds no credentials (method, path, status).
  const start = head.subarray(0, lineEnd).toString('latin1');
  const out = { headers: {} };
  if (kind === 'request') {
    const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(start);
    if (!m) throw new TeeError('request line');
    out.method = m[1];
    out.path = m[2];
  } else {
    const m = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(start);
    if (!m) throw new TeeError('status line');
    out.status = Number(m[1]);
  }
  let p = lineEnd + 2;
  while (p < head.length) {
    let e = head.indexOf(CRLF, p);
    if (e === -1) e = head.length;
    const colon = head.indexOf(0x3a, p);
    if (colon > p && colon < e) {
      // Only the name is read for every header; the value only for KEEP_HEADERS.
      const name = head.subarray(p, colon).toString('latin1').trim().toLowerCase();
      if (KEEP_HEADERS.has(name)) {
        out.headers[name] = head.subarray(colon + 1, e).toString('latin1').trim();
      }
    }
    p = e + 2;
  }
  return out;
}

const NOOP_SINK = { body() {}, end() {} };

class H1Tee {
  constructor({ onExchange }) {
    this.onExchange = onExchange;
    this.pending = [];   // requests whose response has not started: { method, sink }
    this.current = null; // the exchange whose response is being read
    this.dead = false;
    this.error = null;
    this.reqParser = new H1Parser('request', head => this._onRequest(head));
    this.resParser = new H1Parser('response', head => this._onResponse(head));
  }

  _onRequest(head) {
    let sink = null;
    try { sink = this.onExchange({ method: head.method, path: head.path, headers: head.headers }) || null; } catch { sink = null; }
    const ex = { method: head.method, sink };
    this.pending.push(ex);
    return {
      sink: sink ? { body: b => sink.requestBody(b), end: () => sink.requestEnd() } : NOOP_SINK,
    };
  }

  _onResponse(head) {
    const ex = this.pending[0];
    if (!ex) throw new TeeError('response without request');
    if (head.status >= 100 && head.status < 200) {
      if (head.status === 101) { this._stop('upgrade'); return 'stop'; }
      return { sink: NOOP_SINK, noBody: true };
    }
    this.pending.shift();
    this.current = ex;
    const sink = ex.sink;
    if (sink) sink.responseHead(head.status, head.headers);
    const noBody = ex.method === 'HEAD' || head.status === 204 || head.status === 304;
    return {
      noBody,
      sink: {
        body: b => { if (sink) sink.responseBody(b); },
        end: () => { this.current = null; if (sink) sink.responseEnd(); },
      },
    };
  }

  _guard(fn) {
    if (this.dead) return;
    try { fn(); } catch (err) { this._stop(err instanceof TeeError ? err.message : 'parser error'); }
  }

  _stop(reason) {
    if (this.dead) return;
    this.dead = true;
    this.error = reason;
    this.reqParser.dead = this.resParser.dead = true;
    const live = [...(this.current ? [this.current] : []), ...this.pending];
    this.current = null;
    this.pending = [];
    for (const ex of live) { try { ex.sink?.aborted(`tee stopped: ${reason}`); } catch {} }
  }

  clientData(buf) { this._guard(() => this.reqParser.push(buf)); }
  upstreamData(buf) { this._guard(() => this.resParser.push(buf)); }

  close() {
    if (this.dead) return;
    this._guard(() => { this.reqParser.close(); this.resParser.close(); });
    this.dead = true;
    const live = [...(this.current ? [this.current] : []), ...this.pending];
    this.current = null;
    this.pending = [];
    for (const ex of live) { try { ex.sink?.aborted('connection closed before the response ended'); } catch {} }
  }
}

module.exports = { H1Tee, KEEP_HEADERS };
