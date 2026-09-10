// DELETE /api/delete-files removes whole directory trees, and nothing else in
// this app confines a path — every other route just path.resolve()s whatever it
// is given. The only thing standing between a mis-click and an unrecoverable
// recursive delete is the "must sit directly inside cwd" rule, so it is worth
// pinning down: escapes, symlinked path components, and symlink entries.
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

// Returns { del, close }: `del` posts a delete and resolves { status, body }.
async function serve(home) {
  const app = express();
  app.use('/api', freshRouter(home));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return {
    async del(body) {
      const resp = await fetch(`http://127.0.0.1:${port}/api/delete-files`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: resp.status, body: await resp.json() };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-del-'));
}

test('deletes a file and a whole directory tree inside cwd', async () => {
  const home = tmp();
  const cwd = path.join(home, 'work');
  fs.mkdirSync(path.join(cwd, 'tree', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a');
  fs.writeFileSync(path.join(cwd, 'tree', 'nested', 'deep.txt'), 'deep');

  const api = await serve(home);
  try {
    const { status, body } = await api.del({
      cwd,
      paths: [path.join(cwd, 'a.txt'), path.join(cwd, 'tree')],
    });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body.errors, [], 'no errors expected');
    assert.strictEqual(body.summary.files, 1);
    assert.strictEqual(body.summary.dirs, 1);
    assert.ok(!fs.existsSync(path.join(cwd, 'a.txt')));
    assert.ok(!fs.existsSync(path.join(cwd, 'tree')), 'tree removed recursively');
  } finally { await api.close(); }
});

test('rejects paths outside cwd, including .. escapes and siblings', async () => {
  const home = tmp();
  const cwd = path.join(home, 'work');
  const sibling = path.join(home, 'other');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.writeFileSync(path.join(home, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(sibling, 's.txt'), 's');

  const api = await serve(home);
  try {
    const { body } = await api.del({
      cwd,
      paths: [
        path.join(cwd, '..', 'secret.txt'), // resolves to home/secret.txt
        path.join(sibling, 's.txt'),
        cwd,                                 // cwd itself
        path.join(cwd, 'sub', 'deep.txt'),   // a level too deep
      ],
    });
    assert.deepStrictEqual(body.deleted, [], 'nothing should be deleted');
    assert.strictEqual(body.errors.length, 4);
    for (const e of body.errors) {
      assert.match(e.error, /Outside the current directory/);
    }
    assert.ok(fs.existsSync(path.join(home, 'secret.txt')), 'escape target intact');
    assert.ok(fs.existsSync(path.join(sibling, 's.txt')), 'sibling intact');
    assert.ok(fs.existsSync(cwd), 'cwd itself intact');
  } finally { await api.close(); }
});

test('a symlinked path component cannot be used to reach outside cwd', async () => {
  const home = tmp();
  const cwd = path.join(home, 'work');
  const outside = path.join(home, 'outside');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'target.txt'), 'target');
  fs.symlinkSync(outside, path.join(cwd, 'escape'));

  const api = await serve(home);
  try {
    const { body } = await api.del({
      cwd,
      paths: [path.join(cwd, 'escape', 'target.txt')],
    });
    assert.deepStrictEqual(body.deleted, []);
    assert.match(body.errors[0].error, /Outside the current directory/);
    assert.ok(fs.existsSync(path.join(outside, 'target.txt')), 'target untouched');
  } finally { await api.close(); }
});

test('a symlink entry is unlinked, never followed into its target', async () => {
  const home = tmp();
  const cwd = path.join(home, 'work');
  const outside = path.join(home, 'outside');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  // A symlink *to a directory*, sitting directly inside cwd.
  fs.symlinkSync(outside, path.join(cwd, 'linkdir'));

  const api = await serve(home);
  try {
    const { body } = await api.del({ cwd, paths: [path.join(cwd, 'linkdir')] });
    assert.deepStrictEqual(body.errors, []);
    assert.strictEqual(body.summary.links, 1, 'counted as a link, not a dir');
    assert.strictEqual(body.summary.dirs, 0);
    assert.ok(!fs.existsSync(path.join(cwd, 'linkdir')), 'link removed');
    assert.ok(fs.existsSync(path.join(outside, 'keep.txt')),
      'target contents must survive — the link was unlinked, not recursed');
  } finally { await api.close(); }
});

test('cwd is required and must be absolute', async () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  const api = await serve(home);
  try {
    for (const bad of [undefined, '', 'relative/dir', 42]) {
      const { status, body } = await api.del({ paths: ['/tmp/x'], cwd: bad });
      assert.strictEqual(status, 400, `cwd=${JSON.stringify(bad)} should fail closed`);
      assert.match(body.error, /cwd must be an absolute path/);
    }
    const empty = await api.del({ cwd: path.join(home, 'work'), paths: [] });
    assert.strictEqual(empty.status, 400);
  } finally { await api.close(); }
});

test('a trailing-slash cwd still matches its entries', async () => {
  const home = tmp();
  const cwd = path.join(home, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'a');

  const api = await serve(home);
  try {
    const { body } = await api.del({ cwd: cwd + '/', paths: [path.join(cwd, 'a.txt')] });
    assert.deepStrictEqual(body.errors, [], 'trailing slash must normalize');
    assert.ok(!fs.existsSync(path.join(cwd, 'a.txt')));
  } finally { await api.close(); }
});

test('root as cwd passes validation rather than being rejected outright', async () => {
  // Guards the old `path.resolve(p) !== p` check, which rejected every entry at
  // '/' because the client built '//name'. Deletes nothing: the path is bogus,
  // so it must fail at lstat (ENOENT), not at the confinement or cwd check.
  const api = await serve(tmp());
  try {
    const { status, body } = await api.del({
      cwd: '/',
      paths: ['/vistaclair-nonexistent-test-entry'],
    });
    assert.strictEqual(status, 200, 'cwd "/" must be accepted');
    assert.strictEqual(body.errors.length, 1);
    assert.doesNotMatch(body.errors[0].error, /Outside the current directory/);
    assert.match(body.errors[0].error, /ENOENT/);
  } finally { await api.close(); }
});
