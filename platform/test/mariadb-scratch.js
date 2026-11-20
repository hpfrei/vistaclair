// A throwaway MariaDB for tests that need a real database (not a stub): a fresh
// datadir under the temp dir, a free loopback port, no connection to anything
// else. `start()` resolves { pool, stop } or null when the server binaries are
// missing (the caller must say so loudly — never skip silently).
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

function which(bin) {
  for (const d of (process.env.PATH || '').split(':').concat(['/usr/sbin', '/usr/bin'])) {
    try { fs.accessSync(path.join(d, bin), fs.constants.X_OK); return path.join(d, bin); } catch { /* next */ }
  }
  return null;
}
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start() {
  const server = which('mariadbd') || which('mysqld');
  const install = which('mariadb-install-db') || which('mysql_install_db');
  if (!server || !install) return null;
  const mariadb = require('mariadb');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-mdb-'));
  const port = await freePort();
  const inst = cp.spawnSync(install, ['--no-defaults', `--datadir=${dir}/data`, '--auth-root-authentication-method=normal', '--skip-test-db'], { encoding: 'utf8' });
  if (inst.status !== 0) { fs.rmSync(dir, { recursive: true, force: true }); return null; }
  const child = cp.spawn(server, ['--no-defaults', `--datadir=${dir}/data`, `--port=${port}`, `--socket=${dir}/s.sock`, '--bind-address=127.0.0.1',
    `--pid-file=${dir}/p.pid`, '--innodb-buffer-pool-size=32M', '--skip-log-bin', '--performance-schema=OFF'], { stdio: 'ignore' });
  let pool = null;
  for (let i = 0; i < 120 && !pool; i++) {
    await sleep(250);
    try {
      const p = mariadb.createPool({ host: '127.0.0.1', port, user: 'root', connectionLimit: 8, connectTimeout: 2000 });
      const c = await p.getConnection();
      c.release();
      pool = p;
    } catch { /* not up yet */ }
  }
  const stop = async () => {
    try { if (pool) await pool.end(); } catch { /* closed */ }
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 5000); });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  if (!pool) { await stop(); return null; }
  return { pool, port, stop };
}

module.exports = { start };
