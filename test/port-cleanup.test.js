// src/port-cleanup.js: the stale-port sweep at server.js boot kills only
// processes LISTENING on the port — a process holding a client connection to it
// (as ngrok's upstream connection does) survives — and never a process named
// ngrok. Scratch ports and processes started here only.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { waitFor } = require('./wait-for');
const { killStalePortListeners, lsofListenerPids, procListenerPids } = require('../src/port-cleanup');

const hasLsof = spawnSync('lsof', ['-v']).error?.code !== 'ENOENT';
const hasProcNet = fs.existsSync('/proc/net/tcp');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Starts `node -e script` and resolves once it prints READY.
function start(t, script) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    t.after(() => { try { p.kill('SIGKILL'); } catch {} });
    p.stdout.on('data', (d) => { if (/READY/.test(d)) resolve(p); });
    p.on('exit', (code) => reject(new Error(`exited early (${code})`)));
  });
}

const listener = (port) => `require('net').createServer(() => {}).listen(${port}, '127.0.0.1', () => console.log('READY'))`;
const client = (port) => `const c = require('net').connect(${port}, '127.0.0.1', () => console.log('READY'));
  c.on('error', () => {}); c.on('close', () => {}); setInterval(() => {}, 1000)`;

async function listenerAndClient(t) {
  const port = await freePort();
  const srv = await start(t, listener(port));
  const cli = await start(t, client(port));
  return { port, srv, cli };
}

test('only the listener is found and killed; a connected client survives', { skip: !hasLsof && !hasProcNet && 'no lsof or /proc' }, async (t) => {
  const { port, srv, cli } = await listenerAndClient(t);
  if (hasLsof) assert.deepStrictEqual(lsofListenerPids(port), [srv.pid]);
  if (hasProcNet) assert.deepStrictEqual(procListenerPids(port), [srv.pid]);

  const killed = killStalePortListeners([port]);
  assert.deepStrictEqual(killed, [srv.pid]);
  // A killed child stays a zombie (kill(pid, 0) succeeds) until the event loop
  // reaps it, which a loaded machine can delay: wait for it to be gone.
  await waitFor(() => !alive(srv.pid), { what: 'the listener gone' });
  assert.strictEqual(alive(srv.pid), false, 'listener killed');
  assert.strictEqual(alive(cli.pid), true, 'client survives');
  assert.strictEqual(cli.exitCode, null);
});

test('a listener named ngrok is never killed', { skip: !hasLsof && !hasProcNet && 'no lsof or /proc' }, async (t) => {
  // The fake names itself: process.title sets the command name (prctl
  // PR_SET_NAME) that the check reads. A symlink named ngrok is not enough:
  // Node >= 24 renames its main thread to "MainThread". The real ngrok is a
  // Go binary and keeps its name.
  const port = await freePort();
  const srv = await start(t, `process.title = 'ngrok'; ${listener(port)}`);
  assert.deepStrictEqual(killStalePortListeners([port]), []);
  await new Promise(r => setTimeout(r, 300));
  assert.strictEqual(alive(srv.pid), true);
});

test('the own process is never killed', async () => {
  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => s.once('listening', r));
  assert.deepStrictEqual(killStalePortListeners([s.address().port]), []);
  s.close();
});
