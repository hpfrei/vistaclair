/**
 * REST API for filesystem browsing and file serving.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { MIME_TYPES, DATA_HOME, ensureDir } = require('./utils');

const VIDEO_THUMB_DIR = path.join(DATA_HOME, 'data', 'video-thumbs');
const VIDEO_FASTSTART_DIR = path.join(DATA_HOME, 'data', 'video-faststart');
const THUMB_COUNT = 4;
const THUMB_WIDTH = 160;

function cacheKey(resolved, stat) {
  return crypto.createHash('sha1').update(`${resolved}:${stat.mtimeMs}:${stat.size}`).digest('hex');
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 500)}`));
    });
  });
}

async function probeDuration(file) {
  const out = await runCmd('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ]);
  const d = parseFloat(out.trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

// Generate THUMB_COUNT JPEG frames evenly spaced through the video, cached on disk.
const thumbInFlight = new Map();
async function ensureThumbs(file, key) {
  const last = path.join(VIDEO_THUMB_DIR, `${key}_${THUMB_COUNT - 1}.jpg`);
  if (fs.existsSync(last)) return;
  if (thumbInFlight.has(key)) return thumbInFlight.get(key);
  const job = (async () => {
    ensureDir(VIDEO_THUMB_DIR);
    const duration = await probeDuration(file);
    for (let i = 0; i < THUMB_COUNT; i++) {
      const out = path.join(VIDEO_THUMB_DIR, `${key}_${i}.jpg`);
      if (fs.existsSync(out)) continue;
      // Sample at 10%, 30%, 50%, 70% of duration (fallback to 0 if unknown).
      const t = duration ? duration * (0.1 + (i * 0.2)) : 0;
      await runCmd('ffmpeg', [
        '-ss', String(t), '-i', file,
        '-frames:v', '1', '-vf', `scale=${THUMB_WIDTH}:-2`,
        '-q:v', '5', '-y', out,
      ]);
    }
  })();
  thumbInFlight.set(key, job);
  try { await job; } finally { thumbInFlight.delete(key); }
}

// Return true if the mp4 'moov' box precedes 'mdat' (i.e. already faststart).
function isFaststart(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(16);
    let pos = 0;
    while (pos + 8 <= size) {
      const n = fs.readSync(fd, buf, 0, 16, pos);
      if (n < 8) break;
      let boxSize = buf.readUInt32BE(0);
      const type = buf.toString('ascii', 4, 8);
      let headerSize = 8;
      if (boxSize === 1) { boxSize = Number(buf.readBigUInt64BE(8)); headerSize = 16; }
      else if (boxSize === 0) { boxSize = size - pos; }
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (boxSize < headerSize) break;
      pos += boxSize;
    }
  } catch { /* fall through */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return false;
}

// Remux to a faststart copy (moov moved to front), cached on disk. Returns the
// path to serve: the cached copy, or the original if it is already faststart.
const faststartInFlight = new Map();
async function ensureFaststart(file, key) {
  if (isFaststart(file)) return file;
  const out = path.join(VIDEO_FASTSTART_DIR, `${key}.mp4`);
  if (fs.existsSync(out)) return out;
  if (faststartInFlight.has(key)) return faststartInFlight.get(key);
  const job = (async () => {
    ensureDir(VIDEO_FASTSTART_DIR);
    const tmp = path.join(VIDEO_FASTSTART_DIR, `${key}.tmp.mp4`);
    try {
      await runCmd('ffmpeg', ['-i', file, '-c', 'copy', '-movflags', '+faststart', '-y', tmp]);
      fs.renameSync(tmp, out);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
    return out;
  })();
  faststartInFlight.set(key, job);
  try { return await job; } finally { faststartInFlight.delete(key); }
}

// Stream a file with HTTP range support.
function streamFile(req, res, file, mime) {
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : size - 1;
      res.writeHead(206, {
        'Content-Type': mime,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', size);
  res.setHeader('Accept-Ranges', 'bytes');
  fs.createReadStream(file).pipe(res);
}

function createApiRouter({ broadcaster, store, proxyPort, dashboardPort, authToken, cliSessionManager }) {
  const router = express.Router();
  router.use(express.json());

  // ── GET /api/browse-dirs — real filesystem directory browser ────
  const os = require('os');
  router.get('/browse-dirs', (req, res) => {
    const requestedPath = req.query.path || os.homedir();
    const resolved = path.resolve(requestedPath);
    try {
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
      res.json({ current: resolved, parent: path.dirname(resolved), dirs });
    } catch (err) {
      res.status(403).json({ error: 'Cannot access directory', path: resolved });
    }
  });

  // ── POST /api/browse-dirs — create a directory on the real filesystem ──
  router.post('/browse-dirs', (req, res) => {
    const { parent, name } = req.body || {};
    if (!parent || !name) return res.status(400).json({ error: 'parent and name are required' });
    if (typeof name !== 'string' || name.length > 100 || /[/\\]/.test(name) || name.includes('..')) {
      return res.status(400).json({ error: 'Invalid folder name' });
    }
    const target = path.join(path.resolve(parent), name);
    try {
      fs.mkdirSync(target, { recursive: true });
      res.json({ ok: true, created: target });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create directory: ' + err.message });
    }
  });

  // ── GET /api/recent-dirs — recently used CLI directories ──────────
  router.get('/recent-dirs', (req, res) => {
    if (!cliSessionManager) return res.json({ dirs: [] });
    res.json({ dirs: cliSessionManager.getRecentDirs() });
  });

  // ── DELETE /api/recent-dirs — remove one recent directory ─────────
  router.delete('/recent-dirs', (req, res) => {
    const { path: dirPath } = req.body || {};
    if (!dirPath) return res.status(400).json({ error: 'path is required' });
    if (cliSessionManager) cliSessionManager.deleteRecentDir(dirPath);
    res.json({ ok: true });
  });

  // ── GET /api/browse-files — filesystem browser with file metadata ──
  router.get('/browse-files', (req, res) => {
    const requestedPath = req.query.path || os.homedir();
    const resolved = path.resolve(requestedPath);
    const sortBy = req.query.sort || 'name';
    const order = req.query.order || 'asc';
    try {
      const dirents = fs.readdirSync(resolved, { withFileTypes: true });
      const entries = [];
      for (const d of dirents) {
        try {
          const fullPath = path.join(resolved, d.name);
          const stat = fs.statSync(fullPath);
          const entry = { name: d.name, isDirectory: stat.isDirectory(), size: stat.size, mtime: stat.mtimeMs };
          if (entry.isDirectory) {
            try {
              const children = fs.readdirSync(fullPath, { withFileTypes: true });
              let count = 0, oldest = Infinity, newest = 0;
              for (const c of children) {
                try {
                  const cStat = fs.statSync(path.join(fullPath, c.name));
                  count++;
                  if (cStat.mtimeMs < oldest) oldest = cStat.mtimeMs;
                  if (cStat.mtimeMs > newest) newest = cStat.mtimeMs;
                } catch {}
              }
              entry.childCount = count;
              if (count > 0) { entry.oldestChild = oldest; entry.newestChild = newest; }
            } catch {}
          }
          entries.push(entry);
        } catch { /* skip inaccessible entries */ }
      }
      const dirs = entries.filter(e => e.isDirectory);
      const files = entries.filter(e => !e.isDirectory);
      const cmp = (a, b) => {
        let v;
        if (sortBy === 'size') v = a.size - b.size;
        else if (sortBy === 'date') v = a.mtime - b.mtime;
        else v = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        return order === 'desc' ? -v : v;
      };
      dirs.sort(cmp);
      files.sort(cmp);
      res.json({ current: resolved, parent: path.dirname(resolved), entries: [...dirs, ...files] });
    } catch (err) {
      res.status(403).json({ error: 'Cannot access directory', path: resolved });
    }
  });

  // ── GET /api/raw-file — serve any file with correct MIME type ──────
  router.get('/raw-file', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    const resolved = path.resolve(filePath);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
      const ext = path.extname(resolved).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      streamFile(req, res, resolved, mime);
    } catch (err) {
      res.status(404).json({ error: 'File not found', path: resolved });
    }
  });

  // ── GET /api/file-info — stat a single path (preview modal header) ─
  router.get('/file-info', (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    const resolved = path.resolve(filePath);
    try {
      const stat = fs.statSync(resolved);
      res.json({
        exists: true,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size,
        mtime: stat.mtimeMs,
        name: path.basename(resolved),
        path: resolved,
      });
    } catch {
      res.json({ exists: false, isFile: false, isDirectory: false, path: resolved });
    }
  });

  // ── GET /api/video-thumb — one cached ffmpeg frame from a video ────
  router.get('/video-thumb', async (req, res) => {
    const filePath = req.query.path;
    const idx = Math.max(0, Math.min(THUMB_COUNT - 1, parseInt(req.query.i, 10) || 0));
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    const resolved = path.resolve(filePath);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
      const key = cacheKey(resolved, stat);
      await ensureThumbs(resolved, key);
      const thumb = path.join(VIDEO_THUMB_DIR, `${key}_${idx}.jpg`);
      if (!fs.existsSync(thumb)) return res.status(404).json({ error: 'No thumbnail' });
      res.setHeader('Cache-Control', 'private, max-age=86400');
      streamFile(req, res, thumb, 'image/jpeg');
    } catch (err) {
      res.status(500).json({ error: 'Thumbnail failed' });
    }
  });

  // ── GET /api/video-stream — faststart mp4 for instant playback ─────
  router.get('/video-stream', async (req, res) => {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    const resolved = path.resolve(filePath);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
      const ext = path.extname(resolved).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      let serve = resolved;
      if (ext === '.mp4' || ext === '.mov' || ext === '.m4v') {
        try { serve = await ensureFaststart(resolved, cacheKey(resolved, stat)); }
        catch { serve = resolved; }
      }
      streamFile(req, res, serve, mime);
    } catch (err) {
      res.status(404).json({ error: 'File not found', path: resolved });
    }
  });

  // ── GET /api/search-files — recursive file search ─────────────────
  router.get('/search-files', (req, res) => {
    const searchPath = req.query.path;
    if (!searchPath) return res.status(400).json({ error: 'path is required' });
    const resolved = path.resolve(searchPath);

    const filenamePattern = req.query.filenamePattern || '';
    const contentPattern = req.query.contentPattern || '';
    const modifiedWithin = req.query.modifiedWithin || '';

    const UNSAFE_RE = /([+*])\s*[?+*]|\(\?[^)]*\([^)]*[+*]|([+*])\)[\s]*[+*]/;
    function safeRegex(pattern, label) {
      if (UNSAFE_RE.test(pattern)) return { error: `${label} pattern rejected: nested quantifiers can cause excessive backtracking` };
      if (pattern.length > 200) return { error: `${label} pattern too long (max 200 chars)` };
      try { return { re: new RegExp(pattern, 'i') }; }
      catch (e) { return { error: `Invalid ${label} pattern: ${e.message}` }; }
    }

    let filenameRe, contentRe;
    if (filenamePattern) {
      const r = safeRegex(filenamePattern, 'filename');
      if (r.error) return res.status(400).json({ error: r.error });
      filenameRe = r.re;
    }
    if (contentPattern) {
      const r = safeRegex(contentPattern, 'content');
      if (r.error) return res.status(400).json({ error: r.error });
      contentRe = r.re;
    }

    let cutoffMs = 0;
    if (modifiedWithin) {
      const now = Date.now();
      const map = { '5m': 5*60e3, '15m': 15*60e3, '1h': 60*60e3, '24h': 24*60*60e3, '7d': 7*24*60*60e3, '30d': 30*24*60*60e3 };
      if (modifiedWithin === 'today') {
        const d = new Date(); d.setHours(0,0,0,0);
        cutoffMs = d.getTime();
      } else if (map[modifiedWithin]) {
        cutoffMs = now - map[modifiedWithin];
      }
    }

    const TEXT_EXTS = new Set([
      '.txt','.md','.mdx','.json','.js','.mjs','.cjs','.jsx','.ts','.tsx','.css','.scss','.less',
      '.html','.htm','.xml','.csv','.yaml','.yml','.toml','.ini','.sh','.bash','.zsh',
      '.py','.rb','.go','.rs','.java','.c','.cpp','.h','.hpp','.cs','.php','.swift','.kt','.scala',
      '.sql','.r','.lua','.pl','.pm','.ex','.exs','.erl','.hs','.ml','.clj','.dart','.v','.zig',
      '.makefile','.cmake','.gitignore','.gitattributes','.editorconfig',
      '.env','.log','.cfg','.conf','.properties','.lock','.vue','.svelte','.astro',
      '.graphql','.gql','.proto','.tf','.hcl','.nix','.bat','.ps1','.fish',
    ]);

    const results = [];
    const MAX_RESULTS = 200;
    const MAX_CONTENT_SIZE = 1024 * 1024;
    const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', '.cache']);

    function walk(dir) {
      if (results.length >= MAX_RESULTS) return;
      let dirents;
      try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      for (const d of dirents) {
        if (results.length >= MAX_RESULTS) return;
        if (d.name.startsWith('.')) continue;

        const full = path.join(dir, d.name);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }

        if (stat.isDirectory()) {
          if (SKIP_DIRS.has(d.name)) continue;
          walk(full);
          continue;
        }
        if (!stat.isFile()) continue;

        if (filenameRe && !filenameRe.test(d.name)) continue;
        if (cutoffMs && stat.mtimeMs < cutoffMs) continue;

        if (contentRe) {
          const ext = path.extname(d.name).toLowerCase();
          if (!TEXT_EXTS.has(ext)) continue;
          if (stat.size > MAX_CONTENT_SIZE) continue;
          try {
            const content = fs.readFileSync(full, 'utf-8');
            if (content.includes('\0')) continue;
            if (!contentRe.test(content)) continue;
          } catch { continue; }
        }

        results.push({ path: full, name: d.name, size: stat.size, mtime: stat.mtimeMs });
      }
    }

    try {
      walk(resolved);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: 'Search failed: ' + err.message });
    }
  });

  // ── DELETE /api/delete-files — delete files/folders inside one directory ────
  // Deletion is confined to a single directory: every entry must sit directly
  // inside `cwd`. Nothing else in this app confines paths, so without that bound
  // a recursive delete would reach anywhere the owner can read.
  router.delete('/delete-files', async (req, res) => {
    const { paths, cwd } = req.body || {};
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths array required' });
    }
    // Fail closed when cwd is absent: the only client ships from this process.
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      return res.status(400).json({ error: 'cwd must be an absolute path' });
    }
    const parent = path.resolve(cwd);
    let realParent;
    try {
      if (!fs.lstatSync(parent).isDirectory()) {
        return res.status(400).json({ error: 'cwd is not a directory' });
      }
      realParent = fs.realpathSync(parent);
    } catch (err) {
      return res.status(400).json({ error: 'cwd is not accessible: ' + err.message });
    }

    const deleted = [];
    const errors = [];
    const summary = { files: 0, dirs: 0, links: 0 };

    for (const p of paths) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) {
        errors.push({ path: p, error: 'Must be an absolute path' });
        continue;
      }
      const resolved = path.resolve(p);
      try {
        // Lexical check first (cheap), then realpath the *parent* only. A
        // symlinked path component must not become a way out of cwd, while a
        // symlink entry itself stays deletable as a link.
        if (path.dirname(resolved) !== parent
            || fs.realpathSync(path.dirname(resolved)) !== realParent) {
          errors.push({ path: p, error: 'Outside the current directory' });
          continue;
        }
        // lstat, not stat: a symlink to a directory must be unlinked, never
        // followed and recursed into. It also keeps a genuine ENOENT visible,
        // which rm's force:true would otherwise swallow.
        const st = fs.lstatSync(resolved);
        if (st.isSymbolicLink()) {
          fs.unlinkSync(resolved);
          summary.links++;
        } else if (st.isDirectory()) {
          // Async: a sync recursive delete of a large tree blocks the event
          // loop and stalls the WebSocket and every other request.
          await fs.promises.rm(resolved, { recursive: true, force: true });
          summary.dirs++;
        } else {
          fs.unlinkSync(resolved);
          summary.files++;
        }
        deleted.push(p);
      } catch (err) {
        errors.push({ path: p, error: err.message });
      }
    }
    res.json({ deleted, errors, summary });
  });

  return router;
}

module.exports = createApiRouter;
