// Landing a worktree branch, owned by code: whoever works in a git worktree on
// its own branch (an orchestration worker) commits there; this merges the
// branch into its base, tears the worktree down and undoes a landing. No run
// state here: callers record what it returns.
//
//   .vistaclair-worktree.json  versioned in the target repo, the nearest one
//                        from the worktree's directory up to the repo root:
//                          { "links": [".data", "node_modules"], "copy": [".settings.json"], "check": "npm test" }
//                        links: gitignored paths, relative to the file's
//                        directory, symlinked from the main checkout into a new
//                        worktree. copy: the same, but copied (a private copy
//                        the worker may change; teardown removes it, and only
//                        logs one that differs). check: a shell command run
//                        there (same directory) before a landing; exit 0 passes.
//                        A landing reads the file as committed on the base branch
//                        when it is tracked there (else the working file), so the
//                        owner's half-edited copy changes nothing. A file that is
//                        not a JSON object is { file, error }: the landing stops
//                        as `manifest-unreadable`.
//   gapList()            gitignored entries of the main checkout that a new
//                        worktree lacks and no link or copy covers (noise left out).
//   changes()            the one cleanliness check: `git status --porcelain -z`.
//                        A recorded link or copy is not a change; anything else is (an
//                        untracked directory is one entry, never recursed).
//   changedFiles()       what a branch changes against its base, committed or not.
//   land()               in the worktree `git rebase <base>`, the check, then
//                        `git merge --no-ff` into the base. One landing per repo
//                        at a time. Never --force, never reset.
//   teardown()           merged into the base and nothing real left: unlink the
//                        links (never following one) and copies, `git worktree remove`,
//                        `git branch -d`.
//   undo()               `git revert -m 1 <merge>` on the base: a new commit.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const CONFIG_FILE = '.vistaclair-worktree.json';
const CHECK_TIMEOUT_MS = 30 * 60 * 1000;
const TAIL_CHARS = 3000;
// Nothing a landing runs may wait for an editor or a password.
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' };

function gitRaw(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } });
}

function git(cwd, args) {
  return gitRaw(cwd, args).trim();
}

function gitOk(cwd, args) {
  try { gitRaw(cwd, args); return true; } catch { return false; }
}

function firstLine(e) {
  const s = String(e?.stderr || e?.message || e || '').trim();
  return s.split('\n').find(l => l.trim() && !/^hint:/.test(l)) || s;
}

function tail(s, n = TAIL_CHARS) {
  s = String(s || '');
  return s.length > n ? '…' + s.slice(-n) : s;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function lexists(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

const posix = (p) => p.split(path.sep).join('/');

function branchExists(repo, branch) {
  return !!branch && gitOk(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]);
}

// The branch checked out in `dir`, or null (detached HEAD).
function currentBranch(dir) {
  try { return git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']) || null; } catch { return null; }
}

function isAncestor(repo, a, b) {
  return gitOk(repo, ['merge-base', '--is-ancestor', a, b]);
}

// The worktree (main checkout or another) that has `branch` checked out, or null.
function checkoutOf(repo, branch) {
  let out = '';
  try { out = gitRaw(repo, ['worktree', 'list', '--porcelain']); } catch { return null; }
  let at = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) at = line.slice(9);
    else if (line === `branch refs/heads/${branch}` && at) return at;
  }
  return null;
}

// --- Dependency links and copies ---

// The manifest at `d`: { file, text, source: 'base' | 'file' } or null. With a
// `base` branch, the content committed there wins over the working file.
function manifestAt(top, d, base) {
  const file = path.join(d, CONFIG_FILE);
  if (base && branchExists(top, base)) {
    const rel = posix(path.relative(top, file));
    try { return { file, text: gitRaw(top, ['show', `refs/heads/${base}:${rel}`]), source: 'base' }; } catch {}
  }
  if (!fs.existsSync(file)) return null;
  try { return { file, text: fs.readFileSync(file, 'utf8'), source: 'file' }; } catch (e) { return { file, error: firstLine(e) }; }
}

// Relative paths of a manifest key under `d`: strings inside it, never `d` itself.
function pathList(value, d) {
  return (Array.isArray(value) ? value : [])
    .filter(l => typeof l === 'string' && l.trim())
    .map(l => l.trim().replace(/\/+$/, ''))
    .filter(l => !path.isAbsolute(l) && path.resolve(d, l) !== d && isInside(path.resolve(d, l), d));
}

// The declaration nearest to `dir` (inside the repo `top`), or null:
// { file, dir, links, copy: [relative path], check, source } — or { file, dir,
// error } when the file is not a JSON object. `base`: read it as committed there.
function readConfig(top, dir, { base = null } = {}) {
  if (!isInside(path.resolve(dir), top)) return null;
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const m = manifestAt(top, d, base);
    if (m) {
      if (m.error) return { file: m.file, dir: d, error: m.error };
      let raw;
      try { raw = JSON.parse(m.text); } catch (e) { return { file: m.file, dir: d, error: `not valid JSON: ${e.message}` }; }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { file: m.file, dir: d, error: 'not a JSON object' };
      return {
        file: m.file, dir: d, source: m.source, links: pathList(raw.links, d), copy: pathList(raw.copy, d),
        check: typeof raw.check === 'string' && raw.check.trim() ? raw.check.trim() : null,
      };
    }
    if (d === path.resolve(top) || path.dirname(d) === d) return null;
  }
}

// Link (links) or copy (copy) the declared paths of the main checkout `repo`
// into `worktree`, for a worktree serving `dir` (a directory of the main
// checkout). Only a path that exists in the main checkout and not in the
// worktree, under a directory the worktree has. Each one is also added to the
// repo's info/exclude (a trailing-slash .gitignore pattern does not match a
// symlink), so `git add -A` leaves it out. A manifest that cannot be read
// makes none. Returns [{ path, target, copy? }] — what to record.
function createLinks({ repo, worktree, dir }) {
  const cfg = readConfig(repo, dir);
  if (!cfg || cfg.error) return [];
  const out = [];
  for (const [rels, copy] of [[cfg.links, false], [cfg.copy, true]]) {
    for (const rel of rels) {
      const target = path.join(cfg.dir, rel);
      const link = path.join(worktree, path.relative(repo, target));
      if (!fs.existsSync(target) || lexists(link) || !fs.existsSync(path.dirname(link))) continue;
      try {
        if (copy) fs.cpSync(target, link, { recursive: true, errorOnExist: true });
        else fs.symlinkSync(target, link);
        out.push({ path: link, target, ...(copy ? { copy: true } : {}) });
      } catch {}
    }
  }
  if (out.length) addExcludes(repo, out.map(l => '/' + posix(path.relative(worktree, l.path))));
  return out;
}

// Recreate recorded links and copies that are missing (a teardown that git
// refused, a resume).
function relink(links = []) {
  for (const l of links) {
    if (lexists(l.path) || !fs.existsSync(path.dirname(l.path))) continue;
    try {
      if (l.copy) { if (fs.existsSync(l.target)) fs.cpSync(l.target, l.path, { recursive: true, errorOnExist: true }); }
      else fs.symlinkSync(l.target, l.path);
    } catch {}
  }
}

// Does the copy at `a` hold what `b` holds (a file's bytes, a directory's tree)?
function sameContent(a, b) {
  try {
    const sa = fs.lstatSync(a);
    const sb = fs.lstatSync(b);
    if (sa.isDirectory() && sb.isDirectory()) {
      const na = fs.readdirSync(a).sort();
      const nb = fs.readdirSync(b).sort();
      return na.length === nb.length && na.every((n, i) => n === nb[i] && sameContent(path.join(a, n), path.join(b, n)));
    }
    if (sa.isSymbolicLink() || sb.isSymbolicLink()) return sa.isSymbolicLink() && sb.isSymbolicLink() && fs.readlinkSync(a) === fs.readlinkSync(b);
    return sa.isFile() && sb.isFile() && sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}

// Remove recorded links and copies. A link: only a symlink still pointing at
// its recorded target; unlink never follows it, the target is untouched. A copy
// is the worker's own: removed whatever it holds, a difference from the main
// checkout's only logged.
function unlinkLinks(links = []) {
  for (const l of links) {
    try {
      const st = fs.lstatSync(l.path);
      if (l.copy) {
        if (!st.isSymbolicLink() && lexists(l.target) && !sameContent(l.path, l.target)) {
          console.log(`[worktree-landing] the copy ${l.path} differs from ${l.target}; removed with the worktree`);
        }
        fs.rmSync(l.path, { recursive: true, force: true });
      } else if (st.isSymbolicLink() && fs.readlinkSync(l.path) === l.target) fs.unlinkSync(l.path);
    } catch {}
  }
}

// --- The gap list ---

// Names no one misses in a worktree: build output, caches, logs.
const NOISE_NAMES = new Set([
  '__pycache__', 'dist', 'build', 'target', '.cache', 'coverage', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
  '.DS_Store', '.orchestrator', '.next', '.nuxt', '.turbo', '.parcel-cache', '.gradle', '.nyc_output', 'Thumbs.db',
]);
const NOISE_FILE = /\.(pyc|pyo|log|swp|tmp)$/;
const GAP_CAP = 10;

// The gap list as the one sentence a session's card carries, or ''.
function gapSentence(gap) {
  if (!gap?.paths?.length) return '';
  return `Not available here (gitignored in the main checkout): ${gap.paths.join(', ')}${gap.more ? `, +${gap.more} more` : ''}; they can be added to "links" or "copy" in .vistaclair-worktree.json (tell your orchestrator/owner).`;
}
const isNoise = (n) => NOISE_NAMES.has(n) || NOISE_FILE.test(n);

// Does the directory hold anything but noise? A directory git reports whole
// (everything in it ignored) may be only a __pycache__. Bounded: a big tree is
// taken to hold something.
function hasSignal(dir, budget = { left: 5000 }) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
  for (const e of entries) {
    if (isNoise(e.name)) continue;
    if (!e.isDirectory() || --budget.left < 0 || hasSignal(path.join(dir, e.name), budget)) return true;
  }
  return false;
}

// Gitignored entries of the main checkout that `worktree` lacks and that nothing
// links or copies (`records`: createLinks' result): { paths, more }, paths
// relative to the manifest's directory (what "links" / "copy" take), `more` the
// number cut off. `dir`: the session's directory in the main checkout; the
// entries are those under the nearest manifest's directory, else under `dir`.
function gapList({ repo, worktree, dir, records = [] }) {
  const cfg = readConfig(repo, dir);
  if (cfg) dir = cfg.dir;
  let out = '';
  try {
    out = execFileSync('git', ['-C', dir, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  } catch { return { paths: [], more: 0 }; }
  const have = records.map(r => posix(path.relative(dir, path.join(repo, path.relative(worktree, r.path)))));
  const inWorktree = path.join(worktree, path.relative(repo, dir));
  const found = [];
  for (const e of out.split('\0')) {
    const rel = e.replace(/\/+$/, '');
    if (!rel) continue;
    const parts = rel.split('/');
    if (parts.some(isNoise)) continue;
    if (have.some(h => rel === h || rel.startsWith(h + '/'))) continue;
    if (lexists(path.join(inWorktree, rel))) continue;
    if (e.endsWith('/') && !hasSignal(path.join(dir, rel))) continue;
    found.push(rel);
  }
  found.sort();
  return { paths: found.slice(0, GAP_CAP), more: Math.max(0, found.length - GAP_CAP) };
}

function addExcludes(repo, patterns) {
  try {
    const file = path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'info/exclude']));
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const have = new Set(current.split('\n'));
    const add = patterns.filter(p => !have.has(p));
    if (!add.length) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (current && !current.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
  } catch {}
}

// --- The cleanliness check ---

// Real changes in a checkout: [{ code, path }] from `git status --porcelain -z`,
// without the recorded links. Throws when git cannot read it.
function changes(dir, links = []) {
  const own = new Set(links.map(l => posix(path.relative(dir, l.path))));
  const parts = gitRaw(dir, ['status', '--porcelain', '-z', '--untracked-files=normal']).split('\0');
  const list = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const code = e.slice(0, 2);
    const file = e.slice(3);
    // A rename or copy: its original path follows as its own field.
    const from = code[0] === 'R' || code[0] === 'C' ? parts[++i] : null;
    if (code === '??' && own.has(file.replace(/\/+$/, ''))) continue;
    list.push({ code, path: file, ...(from ? { from } : {}) });
  }
  return list;
}

// The files a worktree's branch changes against its base, committed or not:
// `git diff --name-only <base>...<branch>` and the cleanliness check's
// entries (links excluded; an untracked directory as `dir/`).
function changedFiles({ repo, worktree, branch, base, links = [] }) {
  const files = new Set();
  if (branchExists(repo, base) && branchExists(repo, branch)) {
    try {
      for (const f of gitRaw(repo, ['diff', '--name-only', '-z', `refs/heads/${base}...refs/heads/${branch}`]).split('\0')) if (f) files.add(f);
    } catch {}
  }
  try { for (const c of changes(worktree, links)) files.add(c.path); } catch {}
  return [...files];
}

const fmt = (c) => `${c.code.trim() || c.code} ${c.path}`;

// The entries of `dirty` that touch any of `files` (paths from the repo root).
function overlap(dirty, files) {
  const hit = [];
  for (const d of dirty) {
    for (const p of [d.path, d.from].filter(Boolean)) {
      const asDir = p.endsWith('/');
      if (files.some(f => f === p || (asDir && f.startsWith(p)) || f.startsWith(p + '/'))) { hit.push(p); break; }
    }
  }
  return hit;
}

function diffNames(repo, a, b) {
  return gitRaw(repo, ['diff', '--name-only', '-z', a, b]).split('\0').filter(Boolean);
}

function inProgress(dir) {
  for (const p of ['rebase-merge', 'rebase-apply']) {
    try { if (fs.existsSync(path.resolve(dir, git(dir, ['rev-parse', '--git-path', p])))) return 'rebase'; } catch {}
  }
  for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    if (gitOk(dir, ['rev-parse', '-q', '--verify', ref])) return ref.split('_')[0].toLowerCase();
  }
  return null;
}

// --- Per-repo lock ---

const locks = new Map();   // real repo path -> tail of its queue

function withRepoLock(repo, fn) {
  let key = repo;
  try { key = fs.realpathSync(repo); } catch {}
  const run = (locks.get(key) || Promise.resolve()).then(() => fn());
  const next = run.catch(() => {});
  locks.set(key, next);
  next.then(() => { if (locks.get(key) === next) locks.delete(key); });
  return run;
}

// --- The check ---

function runCheck(command, cwd, timeoutMs = CHECK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const add = (d) => { out = (out + d).slice(-TAIL_CHARS * 4); };
    let child;
    try {
      child = spawn('sh', ['-c', command], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) { resolve({ ok: false, output: e.message }); return; }
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, output: tail(out) + (timedOut ? `\n(timed out after ${Math.round(timeoutMs / 60000)} min)` : '') });
    });
  });
}

// --- Land ---

// Does `branch` have commits its base lacks?
function hasNew(repo, branch, base) {
  try { return Number(git(repo, ['rev-list', '--count', `refs/heads/${base}..refs/heads/${branch}`])) > 0; } catch { return false; }
}

// The checks before any landing, without the lock: { outcome } when it stops
// here, null when there is something to land.
function precheck({ repo, worktree, branch, base, links = [] }) {
  if (!fs.existsSync(worktree)) return { outcome: 'error', message: `the worktree ${worktree} is gone` };
  if (!branchExists(repo, base)) return { outcome: 'error', message: `the base branch ${base} does not exist` };
  const busy = inProgress(worktree);
  if (busy) return { outcome: 'busy', message: `a ${busy} is in progress in the worktree` };
  let dirty;
  try { dirty = changes(worktree, links); } catch (e) { return { outcome: 'error', message: firstLine(e) }; }
  if (dirty.length) return { outcome: 'dirty', files: dirty.map(fmt) };
  if (currentBranch(worktree) !== branch) return { outcome: 'error', message: `the worktree is not on ${branch}` };
  if (!hasNew(repo, branch, base)) return { outcome: 'nothing' };
  const committed = links.length
    ? gitRaw(repo, ['diff', '--name-only', '-z', `refs/heads/${base}...refs/heads/${branch}`, '--', ...links.map(l => posix(path.relative(worktree, l.path)))]).split('\0').filter(Boolean)
    : [];
  if (committed.length) return { outcome: 'link-committed', files: committed };
  return null;
}

// Land `branch` into `base`. Resolves { outcome, … }:
//   landed          { preLandSha, mergeSha, head }
//   nothing         no commit the base lacks
//   dirty           { files }   uncommitted changes in the worktree
//   link-committed  { files }   the branch commits a dependency link
//   conflict        { files }   the rebase conflicted; aborted, base untouched
//   check-failed    { output }  the check's output tail
//   manifest-unreadable  { file, error }  `manifest` (readConfig's { file, error })
//                   was passed: the landing would run without its check; nothing changed
//   owner-dirty     { files, checkout }  uncommitted changes where the base is
//                   checked out, to files the landing changes; nothing changed
//   busy / error    { message }
function land(opts) {
  return withRepoLock(opts.repo, () => landNow(opts));
}

async function landNow({ repo, worktree, branch, base, links = [], message, check = null, checkDir = null, manifest = null }) {
  // The base can move while the check runs (the owner commits): rebase again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const stop = precheck({ repo, worktree, branch, base, links });
    if (stop) return stop;
    if (manifest?.error) return { outcome: 'manifest-unreadable', file: manifest.file, error: manifest.error };
    try {
      git(worktree, ['rebase', '--no-autostash', base]);
    } catch (e) {
      let files = [];
      try { files = git(worktree, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean); } catch {}
      try { git(worktree, ['rebase', '--abort']); } catch {}
      return { outcome: 'conflict', files, message: firstLine(e) };
    }
    if (check) {
      const r = await runCheck(check, checkDir && fs.existsSync(checkDir) ? checkDir : worktree);
      if (!r.ok) return { outcome: 'check-failed', output: r.output, code: r.code };
    }
    const tip = git(repo, ['rev-parse', `refs/heads/${base}`]);
    const head = git(repo, ['rev-parse', `refs/heads/${branch}`]);
    if (!isAncestor(repo, tip, head)) continue;
    const checkout = checkoutOf(repo, base);
    if (!checkout) {
      // Not checked out anywhere: the same merge commit, without a working tree.
      const tree = git(repo, ['rev-parse', `${head}^{tree}`]);
      const mergeSha = git(repo, ['commit-tree', tree, '-p', tip, '-p', head, '-m', message]);
      if (!gitOk(repo, ['update-ref', '-m', `merge ${branch}`, `refs/heads/${base}`, mergeSha, tip])) continue;
      return { outcome: 'landed', preLandSha: tip, mergeSha, head };
    }
    const owner = ownerBlock(checkout, tip, head);
    if (owner) return owner;
    try {
      git(checkout, ['merge', '--no-ff', '--no-edit', '-m', message, branch]);
    } catch (e) {
      // Ours half-done (it should not conflict after the rebase): undo it.
      let mh = '';
      try { mh = git(checkout, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']); } catch {}
      if (mh === head) { try { git(checkout, ['merge', '--abort']); } catch {} }
      return { outcome: 'error', message: `merge into ${base} failed: ${firstLine(e)}` };
    }
    return { outcome: 'landed', preLandSha: tip, mergeSha: git(checkout, ['rev-parse', 'HEAD']), head };
  }
  return { outcome: 'error', message: `${base} kept moving during the landing` };
}

// Where the base is checked out: an operation in progress, or uncommitted
// changes to files that a.. b changes, stop it. Null when clear.
function ownerBlock(checkout, a, b) {
  const busy = inProgress(checkout);
  if (busy) return { outcome: 'owner-dirty', checkout, files: [], message: `a ${busy} is in progress in ${checkout}` };
  let dirty = [];
  try { dirty = changes(checkout); } catch (e) { return { outcome: 'error', message: firstLine(e) }; }
  const files = overlap(dirty, diffNames(checkout, a, b));
  return files.length ? { outcome: 'owner-dirty', checkout, files } : null;
}

// --- Teardown ---

// Remove a worktree whose branch is merged into `base` and that holds nothing
// real: { removed: true } | { kept: reason, files }.
function teardown({ repo, worktree, branch, base, links = [] }) {
  const has = branchExists(repo, branch);
  if (has && !isAncestor(repo, `refs/heads/${branch}`, base)) return { kept: `branch ${branch} is not merged into ${base}`, files: [] };
  if (fs.existsSync(worktree)) {
    let files;
    try { files = changes(worktree, links); } catch (e) { return { kept: firstLine(e), files: [] }; }
    if (files.length) return { kept: 'uncommitted changes', files: files.map(fmt) };
    unlinkLinks(links);
    try { git(repo, ['worktree', 'remove', worktree]); } catch (e) {
      relink(links);
      return { kept: firstLine(e), files: [] };
    }
  } else {
    try { git(repo, ['worktree', 'prune']); } catch {}
  }
  if (has) deleteBranch(repo, branch, base);
  return { removed: true };
}

// `git branch -d` checks the main checkout's HEAD: a base checked out nowhere
// (or elsewhere) refuses it, so a branch verified merged into its base and
// checked out nowhere has its ref deleted at the sha just checked.
function deleteBranch(repo, branch, base) {
  if (gitOk(repo, ['branch', '-d', branch])) return true;
  if (checkoutOf(repo, branch)) return false;
  let sha;
  try { sha = git(repo, ['rev-parse', `refs/heads/${branch}`]); } catch { return false; }
  if (!isAncestor(repo, sha, base)) return false;
  return gitOk(repo, ['update-ref', '-d', `refs/heads/${branch}`, sha]);
}

// --- Undo ---

// Revert a landing's merge on `base`: { outcome: 'reverted', revertSha } |
// { outcome: 'owner-dirty', files } | { outcome: 'error', message }.
function undo(opts) {
  return withRepoLock(opts.repo, () => undoNow(opts));
}

function undoNow({ repo, base, mergeSha }) {
  if (!branchExists(repo, base)) return { outcome: 'error', message: `the base branch ${base} does not exist` };
  if (!gitOk(repo, ['rev-parse', '-q', '--verify', `${mergeSha}^2`])) return { outcome: 'error', message: `${mergeSha} is not a merge commit` };
  if (!isAncestor(repo, mergeSha, `refs/heads/${base}`)) return { outcome: 'error', message: `${mergeSha} is not on ${base}` };
  const checkout = checkoutOf(repo, base);
  if (checkout) {
    const tip = git(repo, ['rev-parse', `refs/heads/${base}`]);
    const owner = ownerBlock(checkout, `${mergeSha}^1`, mergeSha);
    if (owner) return owner;
    try { git(checkout, ['revert', '-m', '1', '--no-edit', mergeSha]); } catch (e) {
      if (inProgress(checkout) === 'revert') { try { git(checkout, ['revert', '--abort']); } catch {} }
      return { outcome: 'error', message: `revert failed: ${firstLine(e)}` };
    }
    const revertSha = git(checkout, ['rev-parse', 'HEAD']);
    return revertSha === tip ? { outcome: 'error', message: 'the revert made no commit' } : { outcome: 'reverted', revertSha };
  }
  // Not checked out anywhere: revert in a throwaway worktree, then move the base.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vistaclair-undo-'));
  try {
    const tip = git(repo, ['rev-parse', `refs/heads/${base}`]);
    git(repo, ['worktree', 'add', '--detach', tmp, tip]);
    try { git(tmp, ['revert', '-m', '1', '--no-edit', mergeSha]); } catch (e) {
      try { git(tmp, ['revert', '--abort']); } catch {}
      return { outcome: 'error', message: `revert failed: ${firstLine(e)}` };
    }
    const revertSha = git(tmp, ['rev-parse', 'HEAD']);
    if (!gitOk(repo, ['update-ref', `refs/heads/${base}`, revertSha, tip])) return { outcome: 'error', message: `${base} moved during the revert` };
    return { outcome: 'reverted', revertSha };
  } catch (e) {
    return { outcome: 'error', message: firstLine(e) };
  } finally {
    try { git(repo, ['worktree', 'remove', tmp]); } catch {}
    try { fs.rmdirSync(tmp); } catch {}
  }
}

// --- After a restart ---

// A landing cut off by a restart: abort its rebase in the worktree, and its
// merge where the base is checked out (only when MERGE_HEAD is the branch).
// Returns what it aborted.
function abortInterrupted({ repo, worktree, branch, base }) {
  const aborted = [];
  if (worktree && fs.existsSync(worktree) && inProgress(worktree) === 'rebase') {
    try { git(worktree, ['rebase', '--abort']); aborted.push('rebase'); } catch {}
  }
  const checkout = base ? checkoutOf(repo, base) : null;
  if (checkout && branchExists(repo, branch)) {
    let mh = '';
    try { mh = git(checkout, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']); } catch {}
    if (mh && mh === git(repo, ['rev-parse', `refs/heads/${branch}`])) {
      try { git(checkout, ['merge', '--abort']); aborted.push('merge'); } catch {}
    }
  }
  return aborted;
}

module.exports = {
  CONFIG_FILE, readConfig, createLinks, relink, unlinkLinks, gapList, gapSentence, changes, changedFiles, currentBranch, branchExists,
  hasNew, precheck, land, teardown, undo, abortInterrupted, withRepoLock,
};
