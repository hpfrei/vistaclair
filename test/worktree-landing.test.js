// The per-repo manifest (.vistaclair-worktree.json) of src/worktree-landing.js:
// an unreadable one is an error, a landing reads it as committed on the base,
// "copy" entries (created, excluded, not a change, removed at teardown) and the
// gap list. Throwaway repos under a temp directory.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const landing = require('../src/worktree-landing');

const dirs = [];
function tmpDir(prefix) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(d);
  return d;
}
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A repo on `main` with a committed manifest and the given gitignore.
function repoWith(manifest, ignore = '') {
  const repo = tmpDir('vc-wl-repo-');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString().trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, '.gitignore'), ignore);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'one\n');
  if (manifest != null) fs.writeFileSync(path.join(repo, '.vistaclair-worktree.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  g('add', '.'); g('commit', '-qm', 'init');
  return { repo, g };
}

function worktreeOf(repo, g, branch = 'work') {
  const wt = path.join(tmpDir('vc-wl-wt-'), 'w');
  g('worktree', 'add', '-q', '-b', branch, wt, 'HEAD');
  return wt;
}

const write = (p, c = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };

test('readConfig: links, copy and check; paths outside the directory or absolute are dropped', () => {
  const { repo } = repoWith({ links: ['.data/', '../out', '/abs', 7], copy: ['.settings.json', '.'], check: ' npm test ' });
  const cfg = landing.readConfig(repo, repo);
  assert.deepStrictEqual([cfg.links, cfg.copy, cfg.check], [['.data'], ['.settings.json'], 'npm test']);
  assert.strictEqual(cfg.error, undefined);
});

test('readConfig: a manifest that is not valid JSON, or not an object, is an error with the file; no manifest is null', () => {
  for (const bad of ['{ "links": [', '', '[1]', 'null']) {
    const { repo } = repoWith(bad);
    const cfg = landing.readConfig(repo, repo);
    assert.strictEqual(cfg.file, path.join(repo, '.vistaclair-worktree.json'), bad);
    assert.ok(cfg.error, `error for ${JSON.stringify(bad)}`);
    assert.strictEqual(cfg.links, undefined);
  }
  const { repo } = repoWith(null);
  assert.strictEqual(landing.readConfig(repo, repo), null);
});

test('readConfig with a base: the committed manifest wins over a dirty working copy; untracked falls back to the file', () => {
  const { repo } = repoWith({ links: ['.data'], check: 'true' });
  fs.writeFileSync(path.join(repo, '.vistaclair-worktree.json'), '{ half edited');
  assert.ok(landing.readConfig(repo, repo).error, 'without a base the working file is read');
  const cfg = landing.readConfig(repo, repo, { base: 'main' });
  assert.deepStrictEqual([cfg.error, cfg.check, cfg.source], [undefined, 'true', 'base']);
  fs.writeFileSync(path.join(repo, '.vistaclair-worktree.json'), JSON.stringify({ check: 'edited' }));
  assert.strictEqual(landing.readConfig(repo, repo, { base: 'main' }).check, 'true', 'a valid edit does not change a landing either');

  const { repo: r2 } = repoWith(null);
  fs.writeFileSync(path.join(r2, '.vistaclair-worktree.json'), JSON.stringify({ check: 'untracked' }));
  const c2 = landing.readConfig(r2, r2, { base: 'main' });
  assert.deepStrictEqual([c2.check, c2.source], ['untracked', 'file']);
  assert.strictEqual(landing.readConfig(r2, r2, { base: 'nope' }).check, 'untracked', 'a missing base falls back too');
});

test('readConfig with a base: a manifest in a subdirectory is found there, committed or not', () => {
  const { repo, g } = repoWith(null);
  write(path.join(repo, 'app', '.vistaclair-worktree.json'), JSON.stringify({ links: ['x'] }));
  g('add', '.'); g('commit', '-qm', 'app manifest');
  fs.writeFileSync(path.join(repo, 'app', '.vistaclair-worktree.json'), 'garbage');
  const cfg = landing.readConfig(repo, path.join(repo, 'app', 'sub'), { base: 'main' });
  assert.deepStrictEqual([cfg.dir, cfg.links], [path.join(repo, 'app'), ['x']]);
});

test('land: a manifest error stops it before the rebase, after the cheap checks; nothing merged', async () => {
  const { repo, g } = repoWith({ check: 'true' });
  const wt = worktreeOf(repo, g);
  const manifest = { file: path.join(repo, '.vistaclair-worktree.json'), error: 'not valid JSON: x' };
  const opts = { repo, worktree: wt, branch: 'work', base: 'main', message: 'm', manifest };
  assert.strictEqual((await landing.land(opts)).outcome, 'nothing');
  write(path.join(wt, 'a.txt'));
  execFileSync('git', ['-C', wt, 'add', '-A']); execFileSync('git', ['-C', wt, 'commit', '-qm', 'a']);
  const before = g('rev-parse', 'main');
  const r = await landing.land(opts);
  assert.deepStrictEqual([r.outcome, r.file, r.error], ['manifest-unreadable', manifest.file, manifest.error]);
  assert.strictEqual(g('rev-parse', 'main'), before);
  assert.strictEqual((await landing.land({ ...opts, manifest: null })).outcome, 'landed');
});

test('copy: copied (a file and a directory), excluded, not a change, private; links still links', () => {
  const { repo, g } = repoWith({ links: ['.data'], copy: ['.settings.json', 'conf', 'missing'] }, '.data\n.settings.json\nconf/\n');
  write(path.join(repo, '.data', 'db'), 'db');
  write(path.join(repo, '.settings.json'), 'secret');
  write(path.join(repo, 'conf', 'a', 'b.txt'), 'b');
  const wt = worktreeOf(repo, g);
  const recs = landing.createLinks({ repo, worktree: wt, dir: repo });
  assert.deepStrictEqual(recs.map(r => [path.relative(wt, r.path), !!r.copy]), [['.data', false], ['.settings.json', true], ['conf', true]]);
  assert.ok(fs.lstatSync(path.join(wt, '.data')).isSymbolicLink());
  assert.ok(!fs.lstatSync(path.join(wt, '.settings.json')).isSymbolicLink());
  assert.strictEqual(fs.readFileSync(path.join(wt, 'conf', 'a', 'b.txt'), 'utf8'), 'b');
  // Private: a change in the worktree leaves the main checkout alone.
  fs.writeFileSync(path.join(wt, '.settings.json'), 'worker edit');
  assert.strictEqual(fs.readFileSync(path.join(repo, '.settings.json'), 'utf8'), 'secret');
  // Excluded from git, and not a change even when git would list it.
  const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.includes('/.settings.json') && exclude.includes('/conf'), exclude);
  assert.deepStrictEqual(landing.changes(wt, recs), []);
  const noExcludes = repoWith({ copy: ['p'] });
  write(path.join(noExcludes.repo, 'p', 'x'));
  const wt2 = worktreeOf(noExcludes.repo, noExcludes.g);
  const recs2 = landing.createLinks({ repo: noExcludes.repo, worktree: wt2, dir: noExcludes.repo });
  fs.rmSync(path.join(noExcludes.repo, '.git', 'info', 'exclude'));
  assert.deepStrictEqual(landing.changes(wt2).map(c => c.path), ['p/'], 'git lists an unexcluded copy');
  assert.deepStrictEqual(landing.changes(wt2, recs2), [], 'a recorded copy is not a change');
  assert.deepStrictEqual(landing.changedFiles({ repo: noExcludes.repo, worktree: wt2, branch: 'work', base: 'main', links: recs2 }), []);
});

test('copy: teardown removes the copies, a differing one only logged; the main checkout keeps its file; relink copies again', () => {
  const { repo, g } = repoWith({ links: ['.data'], copy: ['.settings.json', 'conf'] }, '.data\n.settings.json\nconf/\n');
  write(path.join(repo, '.data', 'db'), 'db');
  write(path.join(repo, '.settings.json'), 'secret');
  write(path.join(repo, 'conf', 'c.txt'), 'c');
  const wt = worktreeOf(repo, g);
  const recs = landing.createLinks({ repo, worktree: wt, dir: repo });
  fs.writeFileSync(path.join(wt, '.settings.json'), 'worker edit');
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let r;
  try { r = landing.teardown({ repo, worktree: wt, branch: 'main', base: 'main', links: recs }); } finally { console.log = orig; }
  assert.deepStrictEqual(r, { removed: true });
  assert.ok(!fs.existsSync(wt));
  assert.strictEqual(logs.filter(l => /differs/.test(l)).length, 1, logs.join('\n'));
  assert.ok(/\.settings\.json/.test(logs.find(l => /differs/.test(l))));
  assert.strictEqual(fs.readFileSync(path.join(repo, '.settings.json'), 'utf8'), 'secret');
  assert.strictEqual(fs.readFileSync(path.join(repo, '.data', 'db'), 'utf8'), 'db');

  // A resume: the same records come back (relink copies; a new worktree via createLinks).
  const wt2 = worktreeOf(repo, g, 'work2');
  const again = landing.createLinks({ repo, worktree: wt2, dir: repo });
  assert.deepStrictEqual(again.map(x => !!x.copy), [false, true, true]);
  assert.strictEqual(fs.readFileSync(path.join(wt2, '.settings.json'), 'utf8'), 'secret', 'a fresh copy of the main checkout\'s file');
  landing.unlinkLinks(again);
  landing.relink(again);
  assert.strictEqual(fs.readFileSync(path.join(wt2, 'conf', 'c.txt'), 'utf8'), 'c');
  assert.ok(fs.lstatSync(path.join(wt2, '.data')).isSymbolicLink());
});

test('gapList: ignored entries missing in the worktree, noise and covered paths left out, capped with a count', () => {
  const ignore = ['.data/', 'node_modules/', 'dist/', '__pycache__/', '*.pyc', '*.log', '.DS_Store', '.cache/', 'coverage/', 'target/', 'build/', '.pytest_cache/', 'cfg/', 'one/*.pyc', '/e*.env', ''].join('\n');
  const { repo, g } = repoWith({ links: ['node_modules'], copy: ['.env'] }, ignore + '.env\n');
  for (const f of ['.data/a', 'node_modules/m/i.js', 'dist/b.js', 'pkg/__pycache__/x.pyc', 'x.pyc', 'run.log', '.DS_Store', '.cache/c', 'coverage/lcov', 'target/t', 'build/o', '.pytest_cache/p', '.env', 'cfg/y', 'e1.env']) write(path.join(repo, f));
  const wt = worktreeOf(repo, g);
  const recs = landing.createLinks({ repo, worktree: wt, dir: repo });
  write(path.join(wt, 'e1.env'));   // already there: not a gap
  assert.deepStrictEqual(landing.gapList({ repo, worktree: wt, dir: repo, records: recs }), { paths: ['.data', 'cfg'], more: 0 });

  const many = repoWith(null, Array.from({ length: 14 }, (_, i) => `s${String(i).padStart(2, '0')}.txt`).join('\n') + '\n');
  for (let i = 0; i < 14; i++) write(path.join(many.repo, `s${String(i).padStart(2, '0')}.txt`));
  const wt2 = worktreeOf(many.repo, many.g);
  const gap = landing.gapList({ repo: many.repo, worktree: wt2, dir: many.repo });
  assert.strictEqual(gap.paths.length, 10);
  assert.strictEqual(gap.more, 4);
  assert.strictEqual(gap.paths[0], 's00.txt');
});

test('gapList: only under the given directory, paths relative to it; none outside a repo', () => {
  const { repo, g } = repoWith(null, 'app/.local\ntop.env\n');
  write(path.join(repo, 'app', '.local'));
  write(path.join(repo, 'top.env'));
  const wt = worktreeOf(repo, g);
  fs.mkdirSync(path.join(wt, 'app'), { recursive: true });
  assert.deepStrictEqual(landing.gapList({ repo, worktree: wt, dir: path.join(repo, 'app') }), { paths: ['.local'], more: 0 });
  assert.deepStrictEqual(landing.gapList({ repo, worktree: wt, dir: tmpDir('vc-wl-none-') }), { paths: [], more: 0 });
});
