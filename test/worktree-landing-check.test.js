// land() in src/worktree-landing.js: the rebase and the check run outside the
// repo lock (two landings check in parallel, the merges are serial), a base that
// moved during the check sends a landing round again, and a tree that already
// passed the check in this process is not checked twice. Throwaway repos.
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

function setup() {
  const repo = tmpDir('vc-wlc-repo-');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' }).toString().trim();
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'f.txt'), 'one\n');
  g('add', '.'); g('commit', '-qm', 'init');
  return { repo, g, scratch: tmpDir('vc-wlc-scratch-') };
}

// A worktree on its own branch with one commit (`file` holding `body`).
function worker({ repo, g }, branch, file, body = branch) {
  const wt = path.join(tmpDir('vc-wlc-wt-'), 'w');
  g('worktree', 'add', '-q', '-b', branch, wt, 'HEAD');
  fs.writeFileSync(path.join(wt, file), body + '\n');
  execFileSync('git', ['-C', wt, 'add', '-A']);
  execFileSync('git', ['-C', wt, 'commit', '-qm', `work ${branch}`]);
  return wt;
}
const commitIn = (wt, file, body) => {
  fs.writeFileSync(path.join(wt, file), body + '\n');
  execFileSync('git', ['-C', wt, 'add', '-A']);
  execFileSync('git', ['-C', wt, 'commit', '-qm', `more ${file}`]);
};
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);
const landOf = (s, wt, branch, check, extra = {}) => landing.land({
  repo: s.repo, worktree: wt, branch, base: 'main', links: [], message: `Merge ${branch}`, check, ...extra,
});

test('two landings check in parallel (each check waits for the other to start); the merges are serial', async () => {
  const s = setup();
  const wa = worker(s, 'a', 'a.txt');
  const wb = worker(s, 'b', 'b.txt');
  // Each check says it started, then waits (up to 6 s) for the other's: a check
  // that only starts after the other landing finished cannot pass.
  const check = (me, other) => `echo run >> ${s.scratch}/${me}.runs; touch ${s.scratch}/${me}.started; i=0; ` +
    `while [ ! -f ${s.scratch}/${other}.started ] && [ $i -lt 60 ]; do sleep 0.1; i=$((i+1)); done; test -f ${s.scratch}/${other}.started`;
  const [ra, rb] = await Promise.all([
    landOf(s, wa, 'a', check('a', 'b')),
    landOf(s, wb, 'b', check('b', 'a')),
  ]);
  assert.strictEqual(ra.outcome, 'landed', JSON.stringify(ra));
  assert.strictEqual(rb.outcome, 'landed', JSON.stringify(rb));
  // Both reached main, one merge after the other (the second one's first parent is the first merge).
  const merges = s.g('log', '--first-parent', '--merges', '--format=%H %P').split('\n').map(l => l.split(' '));
  assert.strictEqual(merges.length, 2);
  assert.strictEqual(merges[0][1], merges[1][0], 'the later merge sits on the earlier one');
  assert.ok(fs.existsSync(path.join(s.repo, 'a.txt')) && fs.existsSync(path.join(s.repo, 'b.txt')));
  // The one that merged second saw the base move and was rebased and checked again.
  assert.strictEqual(lines(`${s.scratch}/a.runs`) + lines(`${s.scratch}/b.runs`), 3);
});

test('a base that moves during the check (a change to the tree): rebased again, checked again, merged on top of it', async () => {
  const s = setup();
  const wt = worker(s, 'w', 'w.txt');
  // The first run of the check commits on main (the owner), the second finds it done.
  const check = `echo run >> ${s.scratch}/runs; if [ ! -f ${s.scratch}/moved ]; then touch ${s.scratch}/moved; ` +
    `echo o > ${s.repo}/owner.txt; git -C ${s.repo} add owner.txt; git -C ${s.repo} commit -qm owner-moved-main; fi`;
  const steps = [];
  const r = await landOf(s, wt, 'w', check, { onStep: (x) => steps.push(x) });
  assert.strictEqual(r.outcome, 'landed', JSON.stringify(r));
  assert.strictEqual(lines(`${s.scratch}/runs`), 2, 'checked once on the old base, once on the new one');
  assert.deepStrictEqual(steps, ['rebase', 'check', 'queue', 'merge', 'rebase', 'check', 'queue', 'merge']);
  assert.match(s.g('log', '--format=%s'), /owner-moved-main/);
  assert.ok(s.g('rev-parse', 'HEAD^2') === s.g('rev-parse', 'w'), 'the merged tip is the branch that was checked last');
});

test('a base that moves without changing the tree (an empty commit): rebased again, the passed tree is not checked again', async () => {
  const s = setup();
  const wt = worker(s, 'w', 'w.txt');
  const check = `echo run >> ${s.scratch}/runs; if [ ! -f ${s.scratch}/moved ]; then touch ${s.scratch}/moved; git -C ${s.repo} commit --allow-empty -qm empty-move; fi`;
  const r = await landOf(s, wt, 'w', check);
  assert.strictEqual(r.outcome, 'landed', JSON.stringify(r));
  assert.strictEqual(lines(`${s.scratch}/runs`), 1);
  assert.strictEqual(r.checkReused, true);
});

test('a base that keeps moving: the last round holds the lock, so the landing still lands', async () => {
  const s = setup();
  const wt = worker(s, 'w', 'w.txt');
  // Every check run moves main, until the third (the locked round).
  const check = `echo run >> ${s.scratch}/runs; test $(wc -l < ${s.scratch}/runs) -ge 3 || { echo m$(date +%N) > ${s.repo}/m.txt; git -C ${s.repo} add m.txt; git -C ${s.repo} commit -qm moved; }`;
  const r = await landOf(s, wt, 'w', check);
  assert.strictEqual(r.outcome, 'landed', JSON.stringify(r));
  assert.strictEqual(lines(`${s.scratch}/runs`), 3);
});

test('the tree that passed is not checked twice (a re-report after the owner blocked the merge); a changed tree is', async () => {
  const s = setup();
  const wt = worker(s, 'w', 'f.txt', 'worker version');
  const runs = `${s.scratch}/runs`;
  const check = `echo run >> ${runs}`;
  const ownerEdit = () => fs.writeFileSync(path.join(s.repo, 'f.txt'), 'owner wip\n');
  ownerEdit();                                                         // uncommitted, to a file the landing changes
  let r = await landOf(s, wt, 'w', check);
  assert.strictEqual(r.outcome, 'owner-dirty', JSON.stringify(r));
  assert.strictEqual(lines(runs), 1);
  r = await landOf(s, wt, 'w', check);                                 // same tree
  assert.strictEqual(r.outcome, 'owner-dirty');
  assert.strictEqual(lines(runs), 1, 'the same tree: no second check');
  commitIn(wt, 'g.txt', 'a change');                                   // a new tree
  r = await landOf(s, wt, 'w', check);
  assert.strictEqual(r.outcome, 'owner-dirty');
  assert.strictEqual(lines(runs), 2, 'a changed tree is checked');
  s.g('checkout', '--', 'f.txt');
  r = await landOf(s, wt, 'w', check);
  assert.strictEqual(r.outcome, 'landed', JSON.stringify(r));
  assert.strictEqual(r.checkReused, true);
  assert.strictEqual(lines(runs), 2, 'merged without a third check');
});

test('a failed check is not remembered; another check command is its own entry', async () => {
  const s = setup();
  const wt = worker(s, 'w', 'w.txt');
  const runs = `${s.scratch}/runs`;
  let r = await landOf(s, wt, 'w', `echo run >> ${runs}; exit 1`);
  assert.strictEqual(r.outcome, 'check-failed');
  r = await landOf(s, wt, 'w', `echo run >> ${runs}; exit 1`);
  assert.strictEqual(r.outcome, 'check-failed');
  assert.strictEqual(lines(runs), 2, 'a failure is checked again');
  r = await landOf(s, wt, 'w', `echo run >> ${runs}`);
  assert.strictEqual(r.outcome, 'landed');
  assert.strictEqual(lines(runs), 3);
  assert.ok(!r.checkReused);
});

test('a landing without a check still merges, and reports no check step', async () => {
  const s = setup();
  const wt = worker(s, 'w', 'w.txt');
  const steps = [];
  const r = await landOf(s, wt, 'w', null, { onStep: (x) => steps.push(x) });
  assert.strictEqual(r.outcome, 'landed');
  assert.deepStrictEqual(steps, ['rebase', 'queue', 'merge']);
});
