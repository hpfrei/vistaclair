// agy-mitm: the loopback HTTPS forward proxy that agy workers send their
// traffic through (docs/agy-inspector.md).
//
// - CONNECT only, on 127.0.0.1:<ephemeral>, started lazily by ensureStarted().
// - Every CONNECT carries `instanceId:secret` as Basic proxy auth (registerTag);
//   otherwise 407. Port ≠ 443, or a target that is not a public address → 403.
// - The Cloud Code hosts are TLS-terminated with a leaf from the name-
//   constrained CA (agy-mitm-ca.js) while interception is on; every other host,
//   and every host while it is off, is an opaque TCP tunnel.
// - Interception is byte-identical. agy's ClientHello is read first, and the
//   upstream connection offers exactly its SNI and ALPN list; the client side
//   then selects what the upstream selected. The plaintext is relayed raw both
//   ways with one upstream connection per client connection, and a running
//   sha256 per direction on each side proves it at close. The tee
//   (agy-h1-tee.js → agy-trace.js) only reads copies.
// - The proxy never originates traffic: no probes, retries or extra
//   connections. An upstream failure reaches agy as a closed connection.
const http = require('http');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Duplex } = require('stream');
const { AgyMitmCA, DECODED_HOSTS } = require('./agy-mitm-ca');
const { parseClientHello } = require('./agy-tls-hello');
const { H1Tee } = require('./agy-h1-tee');
const { AgyExchange, classifyPath } = require('./agy-trace');

const HELLO_TIMEOUT_MS = 15000;
const CA_RECHECK_MS = 6 * 3600e3;
const H2_NOTICE = 'agy negotiated h2 with Cloud Code: relayed, not decoded';

// ---------------------------------------------------------------------------
// Address policy: CONNECT goes to public unicast addresses only.

function isPublicAddress(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;      // CGNAT
    if (a === 169 && b === 254) return false;                // link-local
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;                  // 192.0.0/24, 192.0.2/24
    if (a === 198 && (b === 18 || b === 19)) return false;   // benchmarking
    if (a >= 224) return false;                              // multicast, reserved
    return true;
  }
  if (fam === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^f[cd]/.test(s)) return false;                      // ULA
    if (/^fe[89ab]/.test(s)) return false;                   // link-local
    if (/^ff/.test(s)) return false;                         // multicast
    if (/^2001:0?db8:/.test(s)) return false;                // documentation
    return true;
  }
  return false;
}

function _parseTarget(url) {
  const m = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(String(url || ''));
  if (!m) return null;
  const host = m[1].toLowerCase();
  const port = Number(m[2]);
  if (!(port > 0 && port < 65536)) return null;
  if (!net.isIP(host) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return null;
  return { host, port };
}

function _basicAuth(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(header || ''));
  if (!m) return null;
  const raw = Buffer.from(m[1], 'base64').toString('utf8');
  const at = raw.indexOf(':');
  if (at <= 0) return null;
  return { user: raw.slice(0, at), pass: raw.slice(at + 1) };
}

function _reject(socket, status, text, extra = '') {
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
  } catch {}
  setTimeout(() => { try { socket.destroy(); } catch {} }, 1000).unref();
}

// ---------------------------------------------------------------------------
// A Duplex over the raw client socket that first replays the bytes read while
// waiting for the ClientHello. TLSSocket on a net.Socket would read the native
// handle and lose them; on a Duplex it reads through the JS stream.

class ReplaySocket extends Duplex {
  constructor(socket, first) {
    super({ allowHalfOpen: true });
    this.socket = socket;
    if (first.length) this.push(first);
    socket.on('data', d => { if (!this.push(d)) socket.pause(); });
    socket.on('end', () => this.push(null));
    socket.on('error', err => this.destroy(err));
    socket.on('close', () => this.destroy());
  }
  _read() { this.socket.resume(); }
  _write(chunk, enc, cb) { this.socket.write(chunk, cb); }
  _final(cb) { this.socket.end(); cb(); }
  _destroy(err, cb) { this.socket.destroy(); cb(err); }
}

// ---------------------------------------------------------------------------
// The relay. Each direction is hashed where it is read and where it is
// written; nothing between the two changes the bytes.

function _direction() {
  return { inHash: crypto.createHash('sha256'), outHash: crypto.createHash('sha256'), inBytes: 0, outBytes: 0 };
}

const CLOSE_GRACE_MS = 15000;

function relay(a, b, { onAtoB, onBtoA, onClose } = {}) {
  const ab = _direction();
  const ba = _direction();
  const st = new Map([[a, { ended: false, closed: false }], [b, { ended: false, closed: false }]]);
  let done = false;
  const pipe = (from, to, dir, tap) => {
    from.on('data', buf => {
      dir.inHash.update(buf);
      dir.inBytes += buf.length;
      dir.outHash.update(buf);
      dir.outBytes += buf.length;
      const ok = to.write(buf);
      if (tap) { try { tap(buf); } catch {} }
      if (!ok) { from.pause(); to.once('drain', () => from.resume()); }
    });
    // A clean end is passed on as an end (the peer's buffered bytes flush first).
    from.on('end', () => { st.get(from).ended = true; try { to.end(); } catch {} });
  };
  pipe(a, b, ab, onAtoB);
  pipe(b, a, ba, onBtoA);
  let err = null;
  const finish = () => {
    if (done) return;
    done = true;
    const res = {
      clientToUpstream: { in: ab.inHash.digest('hex'), out: ab.outHash.digest('hex'), inBytes: ab.inBytes, outBytes: ab.outBytes },
      upstreamToClient: { in: ba.inHash.digest('hex'), out: ba.outHash.digest('hex'), inBytes: ba.inBytes, outBytes: ba.outBytes },
      error: err ? (err.code || 'error') : null,
    };
    res.match = res.clientToUpstream.in === res.clientToUpstream.out && res.upstreamToClient.in === res.upstreamToClient.out
      && ab.inBytes === ab.outBytes && ba.inBytes === ba.outBytes;
    if (onClose) onClose(res);
  };
  const onCloseOf = (self, other) => () => {
    st.get(self).closed = true;
    if (st.get(other).closed) return finish();
    // An abrupt close (no end, or an error) is passed on as one; after a clean
    // end the other side gets time to flush, then is closed too.
    if (!st.get(self).ended || err) other.destroy();
    else setTimeout(() => other.destroy(), CLOSE_GRACE_MS).unref();
  };
  a.on('close', onCloseOf(a, b));
  b.on('close', onCloseOf(b, a));
  a.on('error', e => { err = err || e; a.destroy(); b.destroy(); });
  b.on('error', e => { err = err || e; a.destroy(); b.destroy(); });
}

// ---------------------------------------------------------------------------

class AgyMitm extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dir                 CA + settings dir (<dataHome>/agy-mitm)
   * @param {object} [o.store]             InteractionStore
   * @param {object} [o.broadcaster]       { broadcast(msg) }
   * @param {string[]} [o.hosts]           decoded hosts (default the Cloud Code hosts)
   * @param {Function} [o.connectUpstream] test seam: ({host, port}) → net.Socket (skips DNS and the address policy)
   * @param {object} [o.upstreamTls]       test seam: extra tls.connect options (e.g. { ca }) for the upstream
   * @param {Function} [o.lookup]          dns.lookup replacement (tests)
   */
  constructor(o = {}) {
    super();
    if (!o.dir) throw new Error('AgyMitm needs a dir');
    this.dir = o.dir;
    this.store = o.store || null;
    this.broadcaster = o.broadcaster || { broadcast() {} };
    this.hosts = new Set(o.hosts || DECODED_HOSTS);
    this.connectUpstream = o.connectUpstream || null;
    this.upstreamTls = o.upstreamTls || {};
    this.lookup = o.lookup || dns.lookup;
    // caHosts: test seam for a CA whose constraints do not cover the decoded hosts.
    this.ca = new AgyMitmCA({ dir: this.dir, hosts: o.caHosts || [...this.hosts] });
    this.settingsPath = path.join(this.dir, 'settings.json');
    this._settings = null;
    this._settingsMtime = -1;
    this.tags = new Map();         // instanceId → { secret: Buffer, sockets: Set, lanes, stats }
    this.server = null;
    this._port = null;
    this._starting = null;
    this._caCheckedAt = 0;
    this.totals = { connections: 0, intercepted: 0, tunnelled: 0, rejected: 0, mismatches: 0, upstreamFailures: 0, clientTlsFailures: 0, h2: 0 };
  }

  // --- kill switch ---------------------------------------------------------

  _readSettings() {
    let st = null;
    try { st = fs.statSync(this.settingsPath); } catch {}
    const mtime = st ? st.mtimeMs : 0;
    if (mtime !== this._settingsMtime) {
      this._settingsMtime = mtime;
      let s = {};
      if (st) { try { s = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) || {}; } catch { s = {}; } }
      this._settings = s;
    }
    return this._settings || {};
  }

  /** Interception of the Cloud Code hosts: default on; settings.json `{ intercept:false }` or VISTACLAIR_AGY_INTERCEPT=0 turns it off. */
  interceptionEnabled() {
    const env = process.env.VISTACLAIR_AGY_INTERCEPT;
    if (env === '0' || env === 'false' || env === 'off') return false;
    return this._readSettings().intercept !== false;
  }

  setInterception(on) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const s = { ...this._readSettings(), intercept: !!on };
    const tmp = this.settingsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.settingsPath);
    this._settingsMtime = -1;
    return this.interceptionEnabled();
  }

  // --- lifecycle -----------------------------------------------------------

  ensureStarted() {
    if (this._port) {
      // A long uptime: the CA is re-checked (and rotated near expiry) at most
      // every 6 h; per-turn agy processes pick up the new bundle next turn.
      if (Date.now() - this._caCheckedAt < CA_RECHECK_MS) return Promise.resolve({ port: this._port });
      this._caCheckedAt = Date.now();
      return this.ca.ensure().then(() => ({ port: this._port }), () => ({ port: this._port }));
    }
    if (this._starting) return this._starting;
    this._starting = (async () => {
      await this.ca.ensure();
      this._caCheckedAt = Date.now();
      const server = http.createServer((req, res) => { res.writeHead(405, { 'content-length': '0' }); res.end(); });
      server.on('connect', (req, socket, head) => this._onConnect(req, socket, head));
      server.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      this.server = server;
      this._port = server.address().port;
      return { port: this._port };
    })();
    this._starting.catch(() => { this._starting = null; });
    return this._starting;
  }

  port() { return this._port; }
  bundlePath() { return this.ca.bundlePath; }

  async stop() {
    for (const t of this.tags.values()) for (const s of t.sockets) s.destroy();
    if (this.server) await new Promise(r => this.server.close(() => r()));
    this.server = null;
    this._port = null;
    this._starting = null;
  }

  /**
   * A per-worker proxy URL: HTTPS_PROXY for the agy process. ensureStarted()
   * must have resolved. Registering a known instance returns its current URL.
   */
  registerTag(instanceId) {
    if (!this._port) throw new Error('agy-mitm is not started: await ensureStarted() first');
    const id = String(instanceId || '');
    if (!id || id.length > 200 || /[\s:]/.test(id)) throw new Error('bad instance id');
    let t = this.tags.get(id);
    if (!t) {
      t = {
        secret: crypto.randomBytes(32).toString('hex'),
        sockets: new Set(),
        lanes: { main: null, pendingType: null, types: new Map() },
        stats: { connections: 0, intercepted: 0, tunnelled: 0, mismatches: 0, notices: 0, hosts: {} },
      };
      this.tags.set(id, t);
    }
    return { proxyUrl: `http://${encodeURIComponent(id)}:${t.secret}@127.0.0.1:${this._port}` };
  }

  /** Forgets the tag and closes its open connections. */
  revokeTag(instanceId) {
    const t = this.tags.get(String(instanceId || ''));
    if (!t) return false;
    this.tags.delete(String(instanceId));
    for (const s of t.sockets) s.destroy();
    return true;
  }

  /** The agy conversation id of the worker's main lane (B2 knows it from `init`). */
  setMainConversation(instanceId, conversationId) {
    const t = this.tags.get(String(instanceId || ''));
    if (t) t.lanes.main = conversationId || null;
  }

  /** Counters only, never content. */
  stats(instanceId) {
    if (instanceId == null) return { ...this.totals, port: this._port, intercept: this.interceptionEnabled() };
    const t = this.tags.get(String(instanceId));
    return t ? JSON.parse(JSON.stringify(t.stats)) : null;
  }

  /**
   * Hook point for the quota work (B4): called with the parsed JSON of a
   * loadCodeAssist / retrieveUserQuotaSummary response, and of a non-2xx model
   * call, as agy itself received it. Emits 'cloudcode-response'.
   */
  onCloudCodeResponse(urlPath, json, instanceId, status) {
    this.emit('cloudcode-response', { path: urlPath, json, instanceId, status });
  }

  // --- CONNECT -------------------------------------------------------------

  _auth(req) {
    const cred = _basicAuth(req.headers['proxy-authorization']);
    if (!cred) return null;
    let id;
    try { id = decodeURIComponent(cred.user); } catch { return null; }
    const t = this.tags.get(id);
    if (!t) return null;
    const a = Buffer.from(cred.pass);
    const b = Buffer.from(t.secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return { id, tag: t };
  }

  _onConnect(req, socket, head) {
    socket.on('error', () => {});
    const auth = this._auth(req);
    if (!auth) {
      this.totals.rejected++;
      return _reject(socket, 407, 'Proxy Authentication Required', 'Proxy-Authenticate: Basic realm="agy-mitm"\r\n');
    }
    const target = _parseTarget(req.url);
    if (!target || target.port !== 443) { this.totals.rejected++; return _reject(socket, 403, 'Forbidden'); }
    if (net.isIP(target.host) && !isPublicAddress(target.host)) { this.totals.rejected++; return _reject(socket, 403, 'Forbidden'); }
    if (target.host === 'localhost' || target.host.endsWith('.localhost')) { this.totals.rejected++; return _reject(socket, 403, 'Forbidden'); }

    const { id, tag } = auth;
    tag.sockets.add(socket);
    socket.on('close', () => tag.sockets.delete(socket));
    tag.stats.connections++;
    this.totals.connections++;
    const hs = (tag.stats.hosts[target.host] ||= { connections: 0, up: 0, down: 0 });
    hs.connections++;

    const resolveAndCheck = (cb) => {
      if (this.connectUpstream) return cb(null, null);
      if (net.isIP(target.host)) return cb(null, target.host);
      this.lookup(target.host, { all: true }, (err, addrs) => {
        if (err || !addrs?.length) return cb(err || new Error('no address'));
        if (!addrs.every(a => isPublicAddress(a.address))) return cb(Object.assign(new Error('non-public'), { forbidden: true }));
        cb(null, addrs[0].address);
      });
    };

    resolveAndCheck((err, ip) => {
      if (socket.destroyed) return;
      if (err) {
        if (err.forbidden) { this.totals.rejected++; return _reject(socket, 403, 'Forbidden'); }
        this.totals.upstreamFailures++;
        return socket.destroy();
      }
      const intercept = this.hosts.has(target.host) && this.interceptionEnabled();
      if (intercept) this._intercept({ id, tag, target, ip, socket, head, hs });
      else this._tunnel({ tag, target, ip, socket, head, hs });
    });
  }

  _tcp(target, ip) {
    if (this.connectUpstream) return this.connectUpstream(target);
    return net.connect({ host: ip, port: target.port });
  }

  _tunnel({ tag, target, ip, socket, head, hs }) {
    tag.stats.tunnelled++;
    this.totals.tunnelled++;
    const up = this._tcp(target, ip);
    up.on('error', () => {});
    const onFail = () => { this.totals.upstreamFailures++; socket.destroy(); };
    up.once('error', onFail);
    up.once('connect', () => {
      up.off('error', onFail);
      socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head?.length) { hs.up += head.length; up.write(head); }
      relay(socket, up, { onAtoB: d => { hs.up += d.length; }, onBtoA: d => { hs.down += d.length; } });
    });
  }

  _intercept({ id, tag, target, ip, socket, head, hs }) {
    tag.stats.intercepted++;
    this.totals.intercepted++;
    socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
    let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    timer.unref();
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const hello = parseClientHello(buf);
      if (!hello.complete) return;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.pause();
      if (!hello.ok) return socket.destroy();
      // SNI must name the CONNECT host; anything else is not ours to decrypt.
      if (hello.sni && hello.sni.toLowerCase() !== target.host) {
        return this._tunnelAfterHello({ target, ip, socket, buf, hs });
      }
      this._openUpstream({ id, tag, target, ip, socket, first: buf, hello, hs });
    };
    socket.on('data', onData);
    if (buf.length) onData(Buffer.alloc(0));
  }

  _tunnelAfterHello({ target, ip, socket, buf, hs }) {
    const up = this._tcp(target, ip);
    const onFail = () => { this.totals.upstreamFailures++; socket.destroy(); };
    up.once('error', onFail);
    up.once('connect', () => {
      up.off('error', onFail);
      up.write(buf);
      hs.up += buf.length;
      relay(socket, up, { onAtoB: d => { hs.up += d.length; }, onBtoA: d => { hs.down += d.length; } });
      socket.resume();
    });
  }

  _openUpstream({ id, tag, target, ip, socket, first, hello, hs }) {
    const opts = {
      ...this.upstreamTls,
      // Mirror what agy offered: SNI as sent, the same ALPN list.
      servername: hello.sni || undefined,
      ALPNProtocols: hello.alpn && hello.alpn.length ? hello.alpn : undefined,
      checkServerIdentity: (_name, cert) => tls.checkServerIdentity(target.host, cert),
    };
    if (this.connectUpstream) opts.socket = this.connectUpstream(target);
    else { opts.host = ip; opts.port = target.port; }
    const up = tls.connect(opts);
    let upReady = false;
    const failEarly = () => {
      if (upReady) return;
      this.totals.upstreamFailures++;
      up.destroy();
      socket.destroy();
    };
    up.once('error', failEarly);
    socket.once('close', () => { if (!upReady) up.destroy(); });
    up.once('secureConnect', async () => {
      upReady = true;
      up.off('error', failEarly);
      up.on('error', () => {});
      const selected = up.alpnProtocol || null;
      let leaf;
      try { leaf = await this.ca.leaf(target.host); }
      catch { up.destroy(); socket.destroy(); return; }
      if (socket.destroyed) { up.destroy(); return; }
      if (!leaf.ctx) leaf.ctx = tls.createSecureContext({ key: leaf.key, cert: leaf.cert });
      const cOpts = { isServer: true, secureContext: leaf.ctx };
      if (selected && hello.alpn?.includes(selected)) cOpts.ALPNCallback = ({ protocols }) => (protocols.includes(selected) ? selected : undefined);
      const client = new tls.TLSSocket(new ReplaySocket(socket, first), cOpts);
      client.on('error', () => {});
      const onClientFail = (err) => {
        this.totals.clientTlsFailures++;
        this._notice(id, tag, `agy rejected the agy-mitm certificate for ${target.host} (${err?.code || 'tls error'})`, 'warn');
        client.destroy();
        up.destroy();
      };
      let relayed = false;
      client.once('error', onClientFail);
      // agy may close before the handshake completes on this side: the
      // upstream connection closes with it.
      client.once('close', () => { if (!relayed) up.destroy(); });
      up.once('close', () => { if (!relayed) client.destroy(); });
      client.once('secure', () => {
        relayed = true;
        client.off('error', onClientFail);
        this._relay({ id, tag, target, client, up, selected, hs });
      });
    });
  }

  _relay({ id, tag, target, client, up, selected, hs }) {
    let tee = null;
    const counts = { requests: 0, gzipResponses: 0 };
    if (selected === 'h2') {
      this.totals.h2++;
      this._notice(id, tag, H2_NOTICE, 'warn');
    } else if (this.store) {
      const ctx = {
        store: this.store,
        broadcaster: this.broadcaster,
        instanceId: id,
        host: target.host,
        lanes: tag.lanes,
        hook: (p, json, status) => { try { this.onCloudCodeResponse(p, json, id, status); } catch {} },
      };
      tee = new H1Tee({
        onExchange: (req) => {
          counts.requests++;
          const ex = classifyPath(req.path) ? new AgyExchange(ctx, req) : null;
          if (!ex) return null;
          const head = ex.responseHead.bind(ex);
          ex.responseHead = (status, headers) => { if (/gzip/i.test(headers['content-encoding'] || '')) counts.gzipResponses++; head(status, headers); };
          return ex;
        },
      });
    }
    relay(client, up, {
      onAtoB: buf => { hs.up += buf.length; if (tee) tee.clientData(buf); },
      onBtoA: buf => { hs.down += buf.length; if (tee) tee.upstreamData(buf); },
      onClose: (res) => {
        if (tee) { try { tee.close(); } catch {} }
        const proof = { host: target.host, alpn: selected, match: res.match, ...counts, teeError: tee?.error || null, clientToUpstreamBytes: res.clientToUpstream.inBytes, upstreamToClientBytes: res.upstreamToClient.inBytes };
        this.emit('connection-closed', { instanceId: id, ...proof, digests: { c2u: res.clientToUpstream, u2c: res.upstreamToClient } });
        if (!res.match) {
          tag.stats.mismatches++;
          this.totals.mismatches++;
          console.error(`[agy-mitm] byte mismatch on a ${target.host} connection of ${id}`);
          this._notice(id, tag, `agy-mitm byte mismatch on a ${target.host} connection`, 'error');
        }
      },
    });
  }

  /** One visible line in the worker's Inspector lane, a broadcast and a log line. */
  _notice(instanceId, tag, message, level = 'info') {
    if (tag) tag.stats.notices++;
    const msg = { type: 'agy-mitm:notice', instanceId, level, message, ts: Date.now() };
    try { this.broadcaster.broadcast(msg); } catch {}
    this.emit('notice', msg);
    if (level !== 'info') console.warn(`[agy-mitm] ${instanceId}: ${message}`);
    if (!this.store) return;
    const it = {
      id: `agy-notice-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      timestamp: Date.now(),
      endpoint: 'agy-mitm://notice',
      instanceId,
      isMcp: true,
      mcpSource: 'agy-mitm',
      request: { tool: 'agy-mitm', params: { notice: message } },
      response: { status: level === 'error' ? 500 : 200, body: { notice: message, level } },
      timing: { startedAt: Date.now(), duration: 0 },
      status: level === 'error' ? 'error' : 'complete',
      isStreaming: false,
    };
    try {
      this.store.add(it);
      this.store.save(it.id);
      this.broadcaster.broadcast({ type: 'interaction:start', interaction: it });
      this.broadcaster.broadcast({ type: 'interaction:complete', interaction: it });
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// The server's instance. configure() is cheap (no listener, no CA); the first
// ensureStarted() makes the CA and opens the port.

let _instance = null;
let _config = null;

function configure({ store, broadcaster, dataHome } = {}) {
  _config = { store, broadcaster, dataHome };
  if (_instance) {
    if (store) _instance.store = store;
    if (broadcaster) _instance.broadcaster = broadcaster;
  }
}

function instance() {
  if (!_instance) {
    const dataHome = _config?.dataHome || require('./utils').DATA_HOME;
    _instance = new AgyMitm({ dir: path.join(dataHome, 'agy-mitm'), store: _config?.store, broadcaster: _config?.broadcaster });
  }
  return _instance;
}

module.exports = {
  AgyMitm, relay, isPublicAddress, H2_NOTICE,
  configure,
  instance,
  ensureStarted: () => instance().ensureStarted(),
  registerTag: (id) => instance().registerTag(id),
  revokeTag: (id) => instance().revokeTag(id),
  setMainConversation: (id, conv) => instance().setMainConversation(id, conv),
  port: () => (_instance ? _instance.port() : null),
  bundlePath: () => instance().bundlePath(),
  onCloudCodeResponse: (p, json, id, status) => instance().onCloudCodeResponse(p, json, id, status),
  interceptionEnabled: () => instance().interceptionEnabled(),
  setInterception: (on) => instance().setInterception(on),
  stats: (id) => (_instance ? _instance.stats(id) : null),
};
