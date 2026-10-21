// Stale-listener cleanup before server.js binds its ports (local mode only).
//
// Only a process LISTENING on one of our ports is a stale server; everything
// merely connected to the port — ngrok's upstream connection, browsers, MCP
// bridges, CLI sessions, the supervisor's health pings — is a client and is
// never touched. Listeners come from `lsof -sTCP:LISTEN`, else from
// /proc/net/tcp{,6} (state 0A) mapped to pids through /proc/<pid>/fd; with
// neither, nothing is killed. Never killed either way: this process, its
// parent (the supervisor), and anything whose command name is ngrok.

const fs = require('fs');
const { execFileSync } = require('child_process');

function parsePids(out) {
  return [...new Set(String(out || '').split('\n').map(s => parseInt(s.trim(), 10)).filter(n => n > 0))];
}

// null when lsof is not available.
function lsofListenerPids(port) {
  try {
    return parsePids(execFileSync('lsof', ['-nP', '-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    return parsePids(e.stdout); // exit 1 = nothing listening
  }
}

// null when /proc/net is not available.
function procListenerPids(port) {
  const inodes = new Set();
  let readable = false;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = fs.readFileSync(file, 'utf-8'); readable = true; } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 10 || f[3] !== '0A') continue; // 0A = TCP_LISTEN
      if (parseInt(f[1].split(':').pop(), 16) === port && f[9] !== '0') inodes.add(`socket:[${f[9]}]`);
    }
  }
  if (!readable) return null;
  if (!inodes.size) return [];
  const pids = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let fds;
    try { fds = fs.readdirSync(`/proc/${entry}/fd`); } catch { continue; }
    for (const fd of fds) {
      let link;
      try { link = fs.readlinkSync(`/proc/${entry}/fd/${fd}`); } catch { continue; }
      if (inodes.has(link)) { pids.push(Number(entry)); break; }
    }
  }
  return pids;
}

function listenerPids(port) {
  const viaLsof = lsofListenerPids(port);
  if (viaLsof) return viaLsof;
  return procListenerPids(port) || [];
}

// null when the name cannot be read.
function commandName(pid) {
  try { return fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim(); } catch {}
  try { return execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('/').pop(); } catch {}
  return null;
}

function killStalePortListeners(ports) {
  const protectedPids = new Set([process.pid, process.ppid]);
  const killed = [];
  for (const port of ports) {
    for (const pid of listenerPids(port)) {
      if (protectedPids.has(pid)) continue;
      const name = commandName(pid);
      if (!name || /^ngrok/i.test(name)) continue;
      try { process.kill(pid, 'SIGKILL'); killed.push(pid); } catch {}
    }
  }
  return killed;
}

module.exports = { killStalePortListeners, listenerPids, lsofListenerPids, procListenerPids };
