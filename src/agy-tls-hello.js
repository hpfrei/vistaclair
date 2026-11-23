// Read-only parsing of a TLS ClientHello / ServerHello from the raw bytes of a
// tunnel (agy-mitm). It never changes a byte: the MITM uses the ClientHello's
// SNI and ALPN list to open the upstream connection with exactly what agy
// offered, and the plain tunnel uses it for counters only.
//
// parseClientHello(buf) → { complete:false } while more bytes are needed,
//   { complete:true, ok:false, reason } for something that is not a ClientHello,
//   { complete:true, ok:true, sni, alpn: [..] | null, versions: [..], length }
//   where `length` is the number of bytes of the records that held the hello.
// parseServerHello(buf) → the same shape with { version, alpn } (alpn is only
//   visible in TLS 1.2; TLS 1.3 sends it encrypted).

const MAX_HELLO = 64 * 1024;

const VERSION_NAMES = { 0x0301: 'TLS1.0', 0x0302: 'TLS1.1', 0x0303: 'TLS1.2', 0x0304: 'TLS1.3' };
function versionName(v) {
  if (VERSION_NAMES[v]) return VERSION_NAMES[v];
  if ((v & 0x0f0f) === 0x0a0a) return 'GREASE';
  return '0x' + v.toString(16).padStart(4, '0');
}

// Concatenate the handshake fragments of the leading handshake records until
// the first handshake message is whole.
function _handshakeMessage(buf, wantType) {
  let off = 0;
  const frags = [];
  let have = 0;
  let need = -1;
  while (true) {
    if (buf.length < off + 5) return { complete: buf.length < MAX_HELLO ? false : true, ok: false, reason: 'too-long' };
    const type = buf[off];
    if (type !== 0x16) return { complete: true, ok: false, reason: 'not-handshake' };
    const len = buf.readUInt16BE(off + 3);
    if (len === 0 || len > 18432) return { complete: true, ok: false, reason: 'bad-record' };
    if (buf.length < off + 5 + len) {
      if (buf.length > MAX_HELLO) return { complete: true, ok: false, reason: 'too-long' };
      return { complete: false };
    }
    frags.push(buf.subarray(off + 5, off + 5 + len));
    have += len;
    off += 5 + len;
    if (need < 0 && have >= 4) {
      const hs = Buffer.concat(frags);
      if (hs[0] !== wantType) return { complete: true, ok: false, reason: 'unexpected-handshake' };
      need = 4 + hs.readUIntBE(1, 3);
    }
    if (need >= 0 && have >= need) {
      return { complete: true, ok: true, body: Buffer.concat(frags).subarray(4, need), length: off };
    }
    if (off > MAX_HELLO) return { complete: true, ok: false, reason: 'too-long' };
  }
}

function _extensions(b, at) {
  const out = new Map();
  if (at + 2 > b.length) return out;
  const end = Math.min(b.length, at + 2 + b.readUInt16BE(at));
  let p = at + 2;
  while (p + 4 <= end) {
    const t = b.readUInt16BE(p);
    const l = b.readUInt16BE(p + 2);
    out.set(t, b.subarray(p + 4, p + 4 + l));
    p += 4 + l;
  }
  return out;
}

function _alpnList(d) {
  if (!d || d.length < 2) return null;
  const end = Math.min(d.length, 2 + d.readUInt16BE(0));
  const list = [];
  for (let p = 2; p < end;) {
    const l = d[p];
    list.push(d.subarray(p + 1, p + 1 + l).toString('latin1'));
    p += 1 + l;
  }
  return list;
}

function parseClientHello(buf) {
  const m = _handshakeMessage(buf, 0x01);
  if (!m.complete || !m.ok) return m;
  try {
    const b = m.body;
    let p = 2 + 32;                       // legacy_version, random
    p += 1 + b[p];                        // session id
    p += 2 + b.readUInt16BE(p);           // cipher suites
    p += 1 + b[p];                        // compression methods
    const ext = _extensions(b, p);
    let sni = null;
    const s = ext.get(0);
    if (s && s.length >= 5 && s[2] === 0) sni = s.subarray(5, 5 + s.readUInt16BE(3)).toString('latin1');
    const versions = [];
    const sv = ext.get(43);
    if (sv) for (let i = 1; i + 1 < 1 + sv[0] && i + 1 < sv.length; i += 2) versions.push(versionName(sv.readUInt16BE(i)));
    if (!versions.length) versions.push(versionName(b.readUInt16BE(0)));
    return { complete: true, ok: true, sni, alpn: _alpnList(ext.get(16)), versions, length: m.length };
  } catch {
    return { complete: true, ok: false, reason: 'malformed' };
  }
}

function parseServerHello(buf) {
  const m = _handshakeMessage(buf, 0x02);
  if (!m.complete || !m.ok) return m;
  try {
    const b = m.body;
    let p = 2 + 32;
    p += 1 + b[p];                        // session id
    p += 2 + 1;                           // cipher suite, compression
    const ext = _extensions(b, p);
    const sv = ext.get(43);
    const version = versionName(sv && sv.length >= 2 ? sv.readUInt16BE(0) : b.readUInt16BE(0));
    const a = _alpnList(ext.get(16));
    return { complete: true, ok: true, version, alpn: a ? a[0] : null, length: m.length };
  } catch {
    return { complete: true, ok: false, reason: 'malformed' };
  }
}

module.exports = { parseClientHello, parseServerHello };
