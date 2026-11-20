// Software version of THIS host's vistaclair checkout (one repo, one SHA), and
// comparison of a slave's reported version against the master's. Used by /ping on the slave and by app:peer:test on the master so
// the GUI can flag a slave running outdated code.
//
// "Current" deliberately means "same commit as the master's checkout": the
// master is the reference the slave must be compatible with, and comparing
// against GitHub would need a network fetch on every test.
const path = require('path');
const { promisify } = require('util');
const { exec: execCb } = require('child_process');

const execAsync = promisify(execCb);

// This file lives at <vc>/platform/src/apps/host-versions.js.
const VC_DIR = path.join(__dirname, '..', '..', '..');
const SHA_RX = /^[0-9a-f]{7,40}$/i;

async function gitHead(dir) {
  try {
    return (await execAsync('git rev-parse HEAD', { cwd: dir, timeout: 5000 })).stdout.trim() || null;
  } catch { return null; }
}

// { vc: <sha>|null } for this host.
async function getVersions() {
  return { vc: await gitHead(VC_DIR) };
}

// Compare one repo: slave's sha vs this host's sha, using this host's history
// for the ancestor test. status: current | behind | ahead | unknown.
async function compareOne(dir, slaveHead, masterHead) {
  const out = { slaveHead: slaveHead || null, masterHead: masterHead || null };
  if (!masterHead || !slaveHead || !SHA_RX.test(slaveHead)) return { ...out, status: 'unknown' };
  if (slaveHead === masterHead) return { ...out, status: 'current' };
  try {
    await execAsync(`git merge-base --is-ancestor ${slaveHead} ${masterHead}`, { cwd: dir, timeout: 5000 });
    let behind = null;
    try {
      behind = Number((await execAsync(`git rev-list --count ${slaveHead}..${masterHead}`, { cwd: dir, timeout: 5000 })).stdout.trim()) || null;
    } catch {}
    return { ...out, status: 'behind', behind };
  } catch {}
  try {
    await execAsync(`git merge-base --is-ancestor ${masterHead} ${slaveHead}`, { cwd: dir, timeout: 5000 });
    return { ...out, status: 'ahead' };
  } catch {}
  // Not in this host's history at all — diverged, or the slave pulled commits
  // this master hasn't fetched yet.
  return { ...out, status: 'unknown' };
}

// slaveVersions is the `versions` object from the slave's /ping (may be absent
// on a slave that does not report — it then compares as 'unknown').
async function compareToSlave(slaveVersions) {
  const mine = await getVersions();
  return {
    vc: await compareOne(VC_DIR, slaveVersions?.vc, mine.vc),
  };
}

module.exports = { getVersions, compareToSlave };
