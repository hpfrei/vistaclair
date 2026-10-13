// PUT /api/write-file saves the directories editor's text over an existing
// file. It must never create files, and must refuse (409) to overwrite a file
// that changed on disk since the editor loaded it, unless told to force.
//
//   node --test test/
//
// The router is mounted on its own throwaway app on port 0 (OS-assigned), so
// this never touches a running Vistaclair instance.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

function freshRouter(home) {
  process.env.VISTACLAIR_HOME = home;
  for (const m of ['../src/api', '../src/utils']) {
    try { delete require.cache[require.resolve(m)]; } catch {}
  }
  return require('../src/api')({});
}

// Returns { put, close }: `put` sends a write and resolves { status, body }.
async function serve(home) {
  const app = express();
  app.use(express.json());
  app.use('/api', freshRouter(home));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return {
    async put(body) {
      const resp = await fetch(`http://127.0.0.1:${port}/api/write-file`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: resp.status, body: await resp.json() };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-write-'));
}

test('overwrites an existing file and reports its new size and mtime', async () => {
  const home = tmp();
  const file = path.join(home, 'notes.md');
  fs.writeFileSync(file, '# old\n');
  const mtime = fs.statSync(file).mtimeMs;

  const api = await serve(home);
  try {
    const { status, body } = await api.put({ path: file, content: '# new — ✓\n', expectedMtime: mtime });
    assert.strictEqual(status, 200);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), '# new — ✓\n');
    assert.strictEqual(body.size, fs.statSync(file).size);
    assert.strictEqual(body.mtime, fs.statSync(file).mtimeMs);
  } finally { await api.close(); }
});

test('refuses with 409 when the file changed on disk, unless forced', async () => {
  const home = tmp();
  const file = path.join(home, 'notes.md');
  fs.writeFileSync(file, 'v1');
  const loaded = fs.statSync(file).mtimeMs;
  // Someone else writes the file after the editor loaded it.
  fs.writeFileSync(file, 'v2 from elsewhere');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));

  const api = await serve(home);
  try {
    const stale = await api.put({ path: file, content: 'mine', expectedMtime: loaded });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'v2 from elsewhere', 'not clobbered');

    const forced = await api.put({ path: file, content: 'mine', expectedMtime: loaded, force: true });
    assert.strictEqual(forced.status, 200);
    assert.strictEqual(fs.readFileSync(file, 'utf-8'), 'mine');
  } finally { await api.close(); }
});

test('never creates a file, and rejects directories and relative paths', async () => {
  const home = tmp();
  const api = await serve(home);
  try {
    const missing = path.join(home, 'new.md');
    const r1 = await api.put({ path: missing, content: 'x' });
    assert.strictEqual(r1.status, 404);
    assert.ok(!fs.existsSync(missing), 'no file created');

    const r2 = await api.put({ path: home, content: 'x' });
    assert.strictEqual(r2.status, 400);

    const r3 = await api.put({ path: 'relative.md', content: 'x' });
    assert.strictEqual(r3.status, 400);

    const r4 = await api.put({ path: path.join(home, 'x.md') });
    assert.strictEqual(r4.status, 400, 'content is required');
  } finally { await api.close(); }
});

test('writes through a symlink without replacing the link', async () => {
  const home = tmp();
  const target = path.join(home, 'real.md');
  const link = path.join(home, 'link.md');
  fs.writeFileSync(target, 'old');
  fs.symlinkSync(target, link);

  const api = await serve(home);
  try {
    const { status } = await api.put({ path: link, content: 'new' });
    assert.strictEqual(status, 200);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'still a symlink');
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), 'new');
  } finally { await api.close(); }
});
