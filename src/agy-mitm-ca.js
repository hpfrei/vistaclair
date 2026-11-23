// The agy-mitm CA (docs/agy-inspector.md). An EC P-256 CA with X.509
// nameConstraints that permit only the Cloud Code hosts, so even a leaked key
// cannot impersonate any other name. Made with the system openssl (execFile /
// spawn, no npm dependency), stored under <dataHome>/agy-mitm/ (dir 0700, key
// 0600). bundle.pem = the system CA bundle + this CA: it is handed to agy
// processes only, as SSL_CERT_FILE, never installed system-wide.
//
// Leaf certificates live in memory only (7 days, re-issued when close to expiry).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DECODED_HOSTS = ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com'];
const CA_DAYS = 90;
const CA_MIN_LEFT_MS = 30 * 86400e3;
const LEAF_DAYS = 7;
const LEAF_MIN_LEFT_MS = 86400e3;
const SYSTEM_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/ssl/cert.pem',
];
const MIN_CONF = '[req]\ndistinguished_name = dn\nprompt = no\n[dn]\n';

function openssl(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.VISTACLAIR_OPENSSL || 'openssl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => err.push(d));
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out));
      // stderr of openssl names files and options, never key material.
      else reject(new Error(`openssl ${args[0]} failed (${code}): ${Buffer.concat(err).toString().trim().split('\n').slice(-2).join(' ')}`));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(input || '');
  });
}

function _mode(p) {
  try { return fs.statSync(p).mode & 0o777; } catch { return null; }
}

class AgyMitmCA {
  /** @param {{ dir: string, hosts?: string[] }} opts */
  constructor({ dir, hosts } = {}) {
    if (!dir) throw new Error('AgyMitmCA needs a dir');
    this.dir = dir;
    this.hosts = hosts || DECODED_HOSTS;
    this.keyPath = path.join(dir, 'ca.key');
    this.certPath = path.join(dir, 'ca.crt');
    this.bundlePath = path.join(dir, 'bundle.pem');
    this.confPath = path.join(dir, 'openssl.cnf');
    this._leaves = new Map();   // host → Promise<{ key, cert, notAfter }>
    this._caKey = null;         // the key is read once, kept in memory
    this.caPem = null;
  }

  /** Creates or rotates the CA when needed, rebuilds the bundle. Idempotent. */
  async ensure() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (_mode(this.dir) !== 0o700) fs.chmodSync(this.dir, 0o700);
    if (!fs.existsSync(this.confPath)) fs.writeFileSync(this.confPath, MIN_CONF, { mode: 0o600 });
    if (!this._caUsable()) await this._createCA();
    this._caKey = fs.readFileSync(this.keyPath);
    this.caPem = fs.readFileSync(this.certPath, 'utf8');
    this._writeBundle();
    return { certPath: this.certPath, bundlePath: this.bundlePath };
  }

  _caUsable() {
    if (_mode(this.keyPath) !== 0o600) return false;
    try {
      const cert = new crypto.X509Certificate(fs.readFileSync(this.certPath));
      if (Date.parse(cert.validTo) - Date.now() < CA_MIN_LEFT_MS) return false;
      const key = crypto.createPrivateKey(fs.readFileSync(this.keyPath));
      if (!cert.checkPrivateKey(key)) return false;
      // The constraints are part of the contract: a CA without them is replaced.
      return this.hosts.every(h => this._permits(cert, h));
    } catch {
      return false;
    }
  }

  _permits(cert, host) {
    // Node exposes no nameConstraints accessor; the CA's PEM is ours, so
    // checking the DER for the permitted DNS names is enough to notice an old
    // or foreign file.
    return cert.raw.includes(Buffer.from(host, 'latin1'));
  }

  async _createCA() {
    for (const f of [this.keyPath, this.certPath, this.bundlePath]) { try { fs.unlinkSync(f); } catch {} }
    this._leaves.clear();
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const tag = crypto.randomBytes(4).toString('hex');
    const permitted = this.hosts.map(h => `permitted;DNS:${h}`).join(',');
    fs.writeFileSync(this.keyPath, keyPem, { mode: 0o600 });
    fs.chmodSync(this.keyPath, 0o600);
    const certPem = await openssl([
      'req', '-x509', '-new', '-key', this.keyPath, '-sha256', '-days', String(CA_DAYS),
      '-config', this.confPath, '-subj', `/O=Vistaclair/CN=Vistaclair agy-mitm CA ${tag}`,
      '-set_serial', '0x' + crypto.randomBytes(16).toString('hex'),
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
      '-addext', `nameConstraints=critical,${permitted}`,
      '-addext', 'subjectKeyIdentifier=hash',
    ]);
    fs.writeFileSync(this.certPath, certPem, { mode: 0o644 });
  }

  _writeBundle() {
    let system = '';
    for (const p of SYSTEM_BUNDLES) {
      try { system = fs.readFileSync(p, 'utf8'); break; } catch {}
    }
    if (!system) {
      // Node's own roots keep run_command children (curl, git, npm) working.
      system = require('tls').rootCertificates.join('\n') + '\n';
    }
    const tmp = this.bundlePath + '.tmp';
    fs.writeFileSync(tmp, system.replace(/\s*$/, '\n') + this.caPem, { mode: 0o644 });
    fs.renameSync(tmp, this.bundlePath);
  }

  /**
   * A leaf for `host`, signed by the CA. Any host can be asked for (the
   * tests issue one for example.com to prove the constraints); the MITM only
   * asks for the decoded hosts.
   * @returns {Promise<{ key: string, cert: string, notAfter: number }>}
   */
  leaf(host) {
    const cur = this._leaves.get(host);
    if (cur) {
      return cur.then(l => (l.notAfter - Date.now() > LEAF_MIN_LEFT_MS ? l : this._issue(host)),
        () => this._issue(host));
    }
    return this._issue(host);
  }

  _issue(host) {
    if (!/^[a-z0-9.-]+$/i.test(host)) return Promise.reject(new Error('bad host'));
    const p = (async () => {
      if (!this._caKey) await this.ensure();
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
      // openssl cannot read a key from a pipe: the leaf key sits in a 0600
      // file inside the 0700 dir for the length of one openssl call.
      const tmpKey = path.join(this.dir, `.leaf-${crypto.randomBytes(8).toString('hex')}.key`);
      fs.writeFileSync(tmpKey, keyPem, { mode: 0o600 });
      let cert;
      try {
        cert = await openssl([
        'req', '-x509', '-new', '-key', tmpKey, '-sha256', '-days', String(LEAF_DAYS),
        '-config', this.confPath, '-subj', `/CN=${host}`,
        '-CA', this.certPath, '-CAkey', this.keyPath,
        '-set_serial', '0x' + crypto.randomBytes(16).toString('hex'),
        '-addext', 'basicConstraints=critical,CA:FALSE',
        '-addext', 'keyUsage=critical,digitalSignature',
        '-addext', 'extendedKeyUsage=serverAuth',
        '-addext', `subjectAltName=DNS:${host}`,
        ]);
      } finally {
        try { fs.unlinkSync(tmpKey); } catch {}
      }
      const certPem = cert.toString('utf8');
      const notAfter = Date.parse(new crypto.X509Certificate(certPem).validTo);
      return { key: keyPem, cert: certPem + this.caPem, notAfter };
    })();
    this._leaves.set(host, p);
    p.catch(() => { if (this._leaves.get(host) === p) this._leaves.delete(host); });
    return p;
  }
}

module.exports = { AgyMitmCA, DECODED_HOSTS, openssl };
