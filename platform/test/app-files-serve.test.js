// ctx.files.serve must close its fd when the client aborts mid-stream.
//
// A <video> element requests `bytes=N-`, reads a little and drops the
// connection on every seek. With a bare `.pipe(res)` the paused read stream
// was never destroyed, so the fd stayed open for the life of the process and
// a deleted recording kept its disk blocks. Linux-only: counts /proc/self/fd.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { serveFile } = require('../src/apps/app-files');

function openFdsTo(file) {
  let n = 0;
  for (const fd of fs.readdirSync('/proc/self/fd')) {
    try { if (fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(file)) n++; } catch {}
  }
  return n;
}

async function waitFor(fn, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

test('aborted range request releases the file descriptor', { skip: process.platform !== 'linux' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-fd-'));
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024)); // well past the socket + stream buffers

  // serveFile uses only res.status/res.set from Express on top of http.
  const server = http.createServer((req, res) => {
    res.status = (c) => { res.statusCode = c; return res; };
    res.set = (h) => { for (const [k, v] of Object.entries(h)) res.setHeader(k, v); return res; };
    serveFile(res, file, { mimeType: 'video/mp4' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  for (const range of ['bytes=0-', null]) {
    await new Promise((resolve, reject) => {
      const headers = range ? { Range: range } : {};
      const req = http.get({ host: '127.0.0.1', port: server.address().port, path: '/', headers }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    });
    fs.unlinkSync(file); // the recordings panel deletes while the player is open
    assert.ok(await waitFor(() => openFdsTo(file) === 0), `fd still open after abort (range: ${range})`);
    fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024));
  }
});
