'use strict';
// Port checks for sites (docs/sites.md, "Ports"): is a port free, who holds
// it, and reclaim ONLY our own orphan — a site-runner.js of this install whose
// env names the same site (VC_SITE_KEY) and the same owner (VC_SITE_OWNER).
// Anything else on the port is named in plain words and never touched.
// /proc is Linux-only; elsewhere holders() is [] and a busy port is refused.

const fs = require('fs');
const net = require('net');

function portFree(port, bind = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, bind);
  });
}

// Socket inodes LISTENING on `port` (tcp + tcp6).
function listenInodes(port) {
  const inodes = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10 || c[3] !== '0A') continue; // 0A = LISTEN
      if (parseInt((c[1].split(':')[1] || ''), 16) === port) inodes.add(c[9]);
    }
  }
  return inodes;
}

function envOf(pid, key) {
  try {
    const kv = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find(x => x.startsWith(`${key}=`));
    return kv ? kv.slice(key.length + 1) : null;
  } catch { return null; }
}

// Every process /proc lets us see that listens on `port`:
// [{ pid, comm, cmd, runner: cmdline names our runner, key, owner }]
function holders(port, runnerPath) {
  const inodes = listenInodes(port);
  const out = [];
  if (!inodes.size) return out;
  let dirs = [];
  try { dirs = fs.readdirSync('/proc'); } catch { return out; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    let fds;
    try { fds = fs.readdirSync(`/proc/${d}/fd`); } catch { continue; }
    let holds = false;
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${d}/fd/${fd}`); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (m && inodes.has(m[1])) { holds = true; break; }
    }
    if (!holds) continue;
    let argv = [];
    try { argv = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { /* unreadable */ }
    let comm = '';
    try { comm = fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim(); } catch { /* gone */ }
    const runner = !!runnerPath && argv.includes(runnerPath);
    out.push({
      pid: Number(d), comm, cmd: argv.join(' ').slice(0, 160), runner,
      key: runner ? envOf(d, 'VC_SITE_KEY') : null,
      owner: runner ? envOf(d, 'VC_SITE_OWNER') : null,
    });
  }
  return out;
}

function describe(h) {
  if (!h) return 'another program (one this user cannot inspect — likely another user\'s or a system service)';
  if (h.runner && h.key) return `the site ${h.key} of another Vistaclair install (pid ${h.pid})`;
  const exe = (h.cmd.split(' ')[0] || '').split('/').pop();
  const name = exe || h.comm || 'a process';
  return `another program: ${name} (pid ${h.pid}${h.cmd ? `, "${h.cmd.slice(0, 80)}"` : ''})`;
}

// Make `port` available for site `key`, or throw a plain-language error.
// Returns null (was free) or a note naming the orphan it reclaimed.
async function ensureFree(port, { bind = '0.0.0.0', key, owner, runnerPath }) {
  if (await portFree(port, bind)) return null;
  const found = holders(port, runnerPath);
  const ours = (h) => h.runner && h.key === key && h.owner === owner;
  const foreign = found.find(h => !ours(h));
  if (!found.length || foreign) {
    const err = new Error(`port ${port} is in use by ${describe(foreign || null)} — stop it or pick another port, then start the site again`);
    err.code = 'port_in_use';
    err.holder = foreign || null;
    throw err;
  }
  const pids = found.map(h => h.pid);
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    for (const pid of pids) { try { process.kill(pid, sig); } catch { /* gone */ } }
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (await portFree(port, bind)) return `reclaimed port ${port} from an orphaned runner of this site (pid ${pids.join(', ')})`;
    }
  }
  const err = new Error(`port ${port} is still held after stopping this site's orphaned runner (pid ${pids.join(', ')})`);
  err.code = 'port_in_use';
  throw err;
}

module.exports = { portFree, holders, ensureFree, describe };
