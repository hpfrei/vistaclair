// Git isolation for plain CLI sessions (not orchestration workers): the same
// worktree, landing and teardown as a worktree worker (src/worktree-landing.js),
// opted into per session.
//
//   start                launchSession({ isolation: 'worktree', landOnClose })
//                        (openCli's simple mode, cli:open): a worktree under
//                        data/worktrees/cli/<id> on branch cli/<id> from the
//                        main checkout's HEAD, its dependency links made; the
//                        session runs there. settings.worktree records it
//                        (persists with the tab and its saved entry):
//                          { id, path, repo, branch, base, cwd (the directory
//                            asked for, in the main checkout), links?,
//                            landOnClose?, lastLanding?, landings?, kept?,
//                            removed? }
//   land                 land({ tabId | sessId }): rebase onto the base, the
//                        repo's check, merge --no-ff ("Merge cli/<id>: <title>").
//                        Resolves { outcome, text, … }; recorded as lastLanding
//                        and broadcast (cli:landing). A closed session's
//                        worktree goes once landed.
//   close / exit         landOnClose: land first. Then teardown (merged and
//                        clean: removed; else kept, with the reason and files;
//                        broadcast cli:worktree). Not at a server shutdown.
//   resume               a session whose worktree is gone gets it back at the
//                        same path (restore), on its branch or a new one.
//   restart              a landing in flight is marked in data/cli-landings.json;
//                        recover() at boot aborts its rebase (and its merge) and
//                        records it as interrupted. Worktrees stay.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const landing = require('./worktree-landing');
const folders = require('./session-folders');
const { readJSON, writeJSON } = require('./utils');

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitToplevel(dir) {
  try { return git(dir, ['rev-parse', '--show-toplevel']); } catch { return null; }
}

function realpathOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

const firstLine = (s) => String(s || '').split('\n').map(l => l.trim()).find(Boolean) || '';
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const list = (files = []) => files.slice(0, 10).join(', ') + (files.length > 10 ? `, … (${files.length} in all)` : '');

// What a session in a worktree is told (appended to its system prompt).
function card(wt, cwd) {
  return `You work in a git worktree at ${cwd} on branch \`${wt.branch}\`, isolated from the main checkout (${wt.repo}). Commit your work on this branch; links the server made to the main checkout's dependencies are not yours to commit. The owner lands it into \`${wt.base}\` (rebase, the repo's check, merge --no-ff)${wt.landOnClose ? ', also when this session closes' : ''}. Never merge into ${wt.base}, rebase it or reset branches yourself.`;
}

// A landing's outcome as one line for the owner.
function describe(r, wt) {
  const files = r.files?.length ? ` (${list(r.files)})` : '';
  switch (r.outcome) {
    case 'landed': return `landed ${r.mergeSha.slice(0, 8)}: ${wt.branch} merged into ${wt.base}`;
    case 'nothing': return `nothing to land: ${wt.branch} has no commit ${wt.base} lacks`;
    case 'dirty': return `not landed: uncommitted changes in the worktree${files}; commit or discard them`;
    case 'link-committed': return `not landed: the branch commits dependency links${files}`;
    case 'conflict': return `not landed: ${wt.branch} conflicts with ${wt.base}${files}; the rebase was aborted, ${wt.base} is untouched`;
    case 'check-failed': return `not landed: the check failed${r.code != null ? ` (exit ${r.code})` : ''}`;
    case 'owner-dirty': return `not landed: ${r.message || `uncommitted changes in ${r.checkout} to files this landing changes${files}`}; nothing changed`;
    default: return `not landed: ${r.message || r.outcome}`;
  }
}

function createCliIsolation({ mgr, broadcaster, dataHome }) {
  const root = path.join(dataHome, 'data', 'worktrees', 'cli');
  const inflightFile = path.join(dataHome, 'data', 'cli-landings.json');
  const jobs = new Map();   // worktree id -> promise of its landing in flight

  // --- Start ---

  // A launch asking isolation 'worktree' as one that runs in a new worktree:
  // { ...opts, cwd, settings: { worktree, appendSystemPrompt } }. Throws when
  // the directory is not in a git repository or its HEAD is detached.
  function prepare(opts) {
    const source = realpathOr(path.resolve(opts.cwd));
    const repo = gitToplevel(source);
    if (!repo) throw new Error(`isolation "worktree" needs a git repository; ${source} is not in one`);
    const base = landing.currentBranch(repo);
    if (!base) throw new Error(`isolation "worktree" needs ${repo} on a branch (its HEAD is detached)`);
    const id = `${folders.slugify(path.basename(repo))}-${crypto.randomBytes(4).toString('hex')}`;
    const branch = `cli/${id}`;
    const wtPath = path.join(root, id);
    fs.mkdirSync(root, { recursive: true });
    git(repo, ['worktree', 'add', '-b', branch, wtPath, 'HEAD']);
    const links = landing.createLinks({ repo, worktree: wtPath, dir: source });
    const wt = { id, path: wtPath, repo, branch, base, cwd: source, ...(links.length ? { links } : {}), ...(opts.landOnClose ? { landOnClose: true } : {}) };
    const cwd = path.join(wtPath, path.relative(repo, source));
    const prior = opts.settings?.appendSystemPrompt;
    return {
      ...opts, cwd,
      settings: { ...opts.settings, worktree: wt, appendSystemPrompt: (prior ? prior + '\n\n' : '') + card(wt, cwd) },
    };
  }

  // A worktree that is gone (torn down, deleted by hand) comes back at the same
  // path, so a resume finds its transcript: on its branch, or a new one from
  // its base. Returns the record to keep, or null when it is there. Throws when
  // git refuses.
  function restore(wt) {
    if (!wt?.path || fs.existsSync(wt.path)) return null;
    try { git(wt.repo, ['worktree', 'prune']); } catch {}
    const from = landing.branchExists(wt.repo, wt.base) ? wt.base : 'HEAD';
    fs.mkdirSync(path.dirname(wt.path), { recursive: true });
    try {
      git(wt.repo, landing.branchExists(wt.repo, wt.branch) ? ['worktree', 'add', wt.path, wt.branch] : ['worktree', 'add', '-b', wt.branch, wt.path, from]);
    } catch (e) {
      throw new Error(`the worktree ${wt.path} is gone and could not be recreated: ${firstLine(e.stderr || e.message)}`);
    }
    const links = landing.createLinks({ repo: wt.repo, worktree: wt.path, dir: wt.cwd });
    const { removed: _r, kept: _k, links: _l, ...rest } = wt;
    return { ...rest, ...(links.length ? { links } : {}) };
  }

  // --- State ---

  // The session behind a ref, live or saved: { sessId, title, wt } or null.
  function find({ tabId, sessId } = {}) {
    const live = tabId ? mgr.get(tabId) : sessId ? mgr.getBySessId(sessId) : null;
    if (live) return { sessId: live.sessId, title: live.title, wt: live.getSettings().worktree || null };
    const saved = sessId ? mgr.findSaved(sessId) : null;
    return saved ? { sessId, title: saved.title, wt: saved.settings?.worktree || null } : null;
  }

  // Change a session's worktree record, wherever it lives now.
  function record(sessId, fn) {
    const live = mgr.getBySessId(sessId);
    if (live) {
      live.updateSettings({ worktree: fn(live.getSettings().worktree || {}) });
      mgr.noteSettingsChanged(live);
    } else {
      mgr.patchSavedSettings(sessId, s => (s.worktree ? { ...s, worktree: fn(s.worktree) } : s));
    }
  }

  function tabOf(sessId) {
    for (const [tabId, s] of mgr.sessions) if (s.sessId === sessId) return tabId;
    return null;
  }

  function mark(wt, sessId) {
    const all = readJSON(inflightFile, {});
    all[wt.id] = { sessId, repo: wt.repo, path: wt.path, branch: wt.branch, base: wt.base, at: new Date().toISOString() };
    writeJSON(inflightFile, all);
  }

  function unmark(id) {
    const all = readJSON(inflightFile, {});
    if (!(id in all)) return;
    delete all[id];
    writeJSON(inflightFile, all);
  }

  // --- Land ---

  // Land a session's branch into its base. Resolves { outcome, text, at, … }
  // (worktree-landing's outcomes; mergeSha / preLandSha when landed, files,
  // message or output when stopped).
  async function land(ref = {}, { message } = {}) {
    const s = find(ref);
    if (!s) return { outcome: 'error', text: 'not landed: no such session' };
    const wt = s.wt;
    if (!wt) return { outcome: 'error', text: 'not landed: the session was not started with isolation "worktree"' };
    if (wt.removed) return { outcome: 'error', text: `not landed: its worktree was torn down (${wt.branch} is merged)` };
    if (jobs.has(wt.id)) return { outcome: 'busy', text: 'not landed: a landing of this session is in progress' };
    const job = (async () => {
      let result;
      try { result = await landNow(s, wt, message); } finally { jobs.delete(wt.id); }
      // Landed after its session closed: the worktree can go now.
      if (result.outcome === 'landed' && !mgr.getBySessId(s.sessId)?.running) teardown(s.sessId);
      return result;
    })();
    jobs.set(wt.id, job);
    return job;
  }

  async function landNow({ sessId, title }, wt, message) {
    const cfg = landing.readConfig(wt.repo, wt.cwd);
    mark(wt, sessId);
    let r;
    try {
      r = await landing.land({
        repo: wt.repo, worktree: wt.path, branch: wt.branch, base: wt.base, links: wt.links || [],
        message: `Merge ${wt.branch}: ${clip(firstLine(message) || title || wt.id, 120)}`,
        check: cfg?.check || null,
        checkDir: cfg ? path.join(wt.path, path.relative(wt.repo, cfg.dir)) : null,
      });
    } catch (e) {
      r = { outcome: 'error', message: firstLine(e.message || e) };
    }
    unmark(wt.id);
    const at = new Date().toISOString();
    const result = { ...r, at, text: describe(r, wt) };
    const brief = { outcome: r.outcome, at, text: result.text, ...(r.mergeSha ? { mergeSha: r.mergeSha, preLandSha: r.preLandSha } : {}), ...(r.files?.length ? { files: r.files } : {}) };
    record(sessId, w => ({
      ...w, lastLanding: brief,
      ...(r.outcome === 'landed' ? { landings: [...(w.landings || []), { mergeSha: r.mergeSha, preLandSha: r.preLandSha, at }] } : {}),
    }));
    broadcaster?.broadcast({ type: 'cli:landing', tabId: tabOf(sessId), sessId, title, branch: wt.branch, base: wt.base, ...result });
    return result;
  }

  // --- Teardown ---

  // A closed session's worktree: removed when merged into its base and clean,
  // else kept with the reason. Recorded and broadcast; returns teardown's
  // { removed } | { kept, files }, or null when there is nothing to do.
  function teardown(sessId) {
    const s = find({ sessId });
    const wt = s?.wt;
    if (!wt || wt.removed) return null;
    if (mgr.getBySessId(sessId)?.running) return null;   // resumed meanwhile
    const r = jobs.has(wt.id)
      ? { kept: 'landing in progress', files: [] }
      : landing.teardown({ repo: wt.repo, worktree: wt.path, branch: wt.branch, base: wt.base, links: wt.links || [] });
    const at = new Date().toISOString();
    record(sessId, ({ kept: _k, ...w }) => (r.removed
      ? { ...w, removed: { at } }
      : { ...w, kept: { reason: r.kept, ...(r.files?.length ? { files: r.files } : {}), at } }));
    if (!r.removed) {
      console.log(`[cli-isolation] ${s.title || wt.id}: worktree ${wt.path} kept: ${r.kept}${r.files?.length ? ` (${list(r.files)})` : ''}`);
    }
    broadcaster?.broadcast({
      type: 'cli:worktree', sessId, title: s.title, branch: wt.branch, path: wt.path,
      removed: !!r.removed, ...(r.kept ? { kept: r.kept, files: r.files || [] } : {}),
    });
    return r;
  }

  // Exit listener (not called at a server shutdown): land when the owner asked
  // for it at start, then tear down.
  function onSessionExit(tabId, session) {
    const st = session?.getSettings?.() || {};
    const wt = st.worktree;
    if (!wt || wt.removed || st.orchestration || !session.sessId) return null;
    const sessId = session.sessId;
    return (async () => {
      await null;   // after the manager has dropped the session
      if (jobs.has(wt.id)) await jobs.get(wt.id);
      else if (wt.landOnClose) await land({ sessId }, {});
      return teardown(sessId);
    })().catch((e) => { console.error('[cli-isolation] close:', e.message); return null; });
  }

  // --- After a restart ---

  // Landings a restart cut off: rebase (and merge) aborted, recorded on the
  // session as interrupted. Call before the open tabs are restored. Returns
  // [{ sessId, branch, text }].
  function recover() {
    const all = readJSON(inflightFile, {});
    const out = [];
    for (const m of Object.values(all || {})) {
      let aborted = [];
      try { aborted = landing.abortInterrupted({ repo: m.repo, worktree: m.path, branch: m.branch, base: m.base }); } catch {}
      const text = `not landed: the landing was cut off by a restart${aborted.length ? ` (${aborted.join(' and ')} aborted)` : ''}; ${m.base} is as before`;
      const brief = { outcome: 'interrupted', at: new Date().toISOString(), text, ...(aborted.length ? { aborted } : {}) };
      if (m.sessId) mgr.patchSavedSettings(m.sessId, s => (s.worktree ? { ...s, worktree: { ...s.worktree, lastLanding: brief } } : s));
      console.log(`[cli-isolation] ${m.branch}: ${text}`);
      out.push({ sessId: m.sessId, branch: m.branch, text });
    }
    if (out.length) writeJSON(inflightFile, {});
    return out;
  }

  // /api/cli-isolation — behind the dashboard's auth.
  function router() {
    const express = require('express');
    const r = express.Router();
    r.use(express.json());
    const ref = (b) => ({ tabId: b.tabId ? String(b.tabId) : undefined, sessId: b.sessId ? String(b.sessId) : undefined });
    r.post('/land', async (req, res) => {
      try { res.json(await land(ref(req.body || {}), { message: req.body?.message })); } catch (e) { res.json({ outcome: 'error', text: e.message }); }
    });
    r.get('/status', (req, res) => {
      const s = find(ref(req.query || {}));
      if (!s) return res.status(404).json({ error: 'no such session' });
      res.json({ sessId: s.sessId, title: s.title, worktree: s.wt, landing: !!(s.wt && jobs.has(s.wt.id)) });
    });
    return r;
  }

  return { prepare, restore, land, teardown, onSessionExit, recover, router, landingOf: (id) => jobs.get(id) || null };
}

module.exports = { createCliIsolation };
