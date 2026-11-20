// ctx.files helpers — base64/data-URL save into the app's .data/uploads and
// range-aware streaming of a file to an Express response. Backs the `files`
// capability (ctx-only; the frontend uploads via the app's own routes).

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');
const { ensureDir, safeJoin } = require('../utils');

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
  'audio/aac': 'aac', 'video/mp4': 'mp4', 'video/webm': 'webm',
  'application/pdf': 'pdf', 'application/json': 'json', 'text/plain': 'txt',
};

// Content types of outsider-supplied files. The dashboard's origin carries the
// owner's session, so a text/html, svg, xml or script response replayed from
// it would run with the owner's rights. Passive types (no script in any
// browser) are served inline; every other type — including malformed ones —
// gets a CSP sandbox with no allow-same-origin: an opaque origin that cannot
// reach the dashboard's cookies or WebSocket. No allow-scripts either; no
// caller serves its own scripted page through here.
const MIME_SYNTAX = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const PASSIVE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/apng',
  'image/x-icon', 'image/vnd.microsoft.icon', 'application/pdf', 'text/plain',
]);
const SANDBOX_CSP = 'sandbox';

// Lowercase, parameters stripped, valid type/subtype syntax — else octet-stream.
function normalizeMime(raw) {
  const t = String(raw == null ? '' : raw).split(';')[0].trim().toLowerCase();
  return MIME_SYNTAX.test(t) ? t : 'application/octet-stream';
}

function isPassiveMime(raw) {
  const t = normalizeMime(raw);
  return PASSIVE_MIME.has(t) || t.startsWith('audio/') || t.startsWith('video/');
}

// Headers that keep an outsider's bytes from running on this origin, for a
// (possibly parameterised) content type; `contentType` is the header to send
// (a text charset parameter survives, nothing else does).
function contentHeaders(raw) {
  const type = normalizeMime(raw);
  const charset = /^text\//.test(type) ? /;\s*charset=("?)([a-z0-9_.:-]+)\1\s*$/i.exec(String(raw)) : null;
  const h = {
    'Content-Type': charset ? `${type}; charset=${charset[2]}` : type,
    'X-Content-Type-Options': 'nosniff',
  };
  if (!isPassiveMime(type)) h['Content-Security-Policy'] = SANDBOX_CSP;
  return h;
}

function saveBase64File(appDirPath, data, { name, subdir, mimeType: mimeOpt } = {}) {
  let mimeType = null;
  let b64 = String(data || '');
  const dataUrl = b64.match(/^data:([^;,]+)(;base64)?,/);
  if (dataUrl) {
    mimeType = dataUrl[1];
    b64 = b64.slice(dataUrl[0].length);
  }
  // Explicit option wins over data-URL sniffing (raw base64 has nothing to sniff).
  if (mimeOpt) mimeType = String(mimeOpt).split(';')[0].trim();
  mimeType = normalizeMime(mimeType);
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('Empty or invalid base64 payload');

  const uploadsRoot = path.join(appDirPath, '.data', 'uploads');
  const dir = subdir ? safeJoin(uploadsRoot, subdir) : uploadsRoot;
  ensureDir(dir);
  let fileName = name
    ? path.basename(name)
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (!path.extname(fileName)) fileName += '.' + (MIME_EXT[mimeType] || 'bin');
  const filePath = safeJoin(dir, fileName);
  fs.writeFileSync(filePath, buf);
  return { path: filePath, mimeType, size: buf.length };
}

// onMissing: called instead of the default 404 JSON when the file is absent —
// lets apps serve a placeholder. Returns false if the file was missing.
function serveFile(res, filePath, { mimeType, onMissing } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    if (typeof onMissing === 'function') onMissing();
    else res.status(404).json({ error: 'File not found' });
    return false;
  }
  const total = stat.size;
  const policy = contentHeaders(mimeType);
  const range = res.req.headers.range;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (isNaN(start) || isNaN(end) || start > end || start >= total) {
      res.status(416).set('Content-Range', `bytes */${total}`).end();
      return;
    }
    end = Math.min(end, total - 1);
    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...policy,
    });
    // pipeline, not .pipe: a client that aborts mid-range (a <video> seek)
    // must destroy the read stream, or its fd outlives the file's deletion.
    pipeline(fs.createReadStream(filePath, { start, end }), res, () => {});
  } else {
    res.set({ 'Content-Length': total, 'Accept-Ranges': 'bytes', ...policy });
    pipeline(fs.createReadStream(filePath), res, () => {});
  }
  return true;
}

module.exports = { MIME_EXT, saveBase64File, serveFile, normalizeMime, isPassiveMime, contentHeaders };
