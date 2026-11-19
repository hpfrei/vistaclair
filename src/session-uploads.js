// Files and voice recordings sent from the dashboard's input lines (the Agent
// SDK panel's <vc-composer> and the terminal tabs' message bar).
//
//   POST /api/session-upload?tab=<tabId>|sess=<sessId>&name=<file name>
//        body: the raw file bytes → { path, name, size }
//        A non-image file is saved in the session's uploads/ folder; the
//        message carries the absolute path so Claude can Read it. (Images
//        pasted into an SDK panel keep their base64 path: sdk-session.js.)
//   POST /api/session-transcribe?language=<iso>
//        body: the raw recording (Content-Type audio/*) → { text }
//        The recording becomes a platform artifact and the platform's
//        `audio_transcribe` tool turns it into text, so the spend is recorded
//        by the platform. Core has no tool or artifact access of its own: the
//        add-on hands it `platformTools` (addons.platformTools()).

const fs = require('fs');
const path = require('path');
const express = require('express');
const { DATA_HOME, ensureDir } = require('./utils');

const FILE_MAX = 25 * 1024 * 1024;
const AUDIO_MAX = 25 * 1024 * 1024; // the transcription providers' own cap
const TRANSCRIBE_TOOL = 'platform__audio_transcribe';

function fmtSize(n) {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) ? 1 : 0)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}

// A client-chosen name → a plain file name: no path parts, no control or odd
// characters, at most 200 long, extension kept.
function safeFileName(name) {
  let s = String(name || '').split(/[\\/]/).pop().replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  if (!s) s = 'file';
  if (s.length > 200) {
    const ext = path.extname(s).slice(0, 20);
    s = s.slice(0, 200 - ext.length) + ext;
  }
  return s;
}

// Write `buffer` into `<dir>/uploads/` under a unique name (a repeat of a name
// never overwrites an earlier file the transcript may still point at).
// Returns { name, path (absolute), size }. Throws on an oversize or empty file.
function saveUpload(dir, name, buffer, { max = FILE_MAX } = {}) {
  if (!dir) throw Object.assign(new Error('this session has no folder to save files in'), { status: 404 });
  if (!buffer || !buffer.length) throw Object.assign(new Error('the file is empty'), { status: 400 });
  if (buffer.length > max) throw Object.assign(new Error(`the file is too large (${fmtSize(buffer.length)}; max ${fmtSize(max)})`), { status: 413 });
  const uploads = path.join(dir, 'uploads');
  ensureDir(uploads);
  const base = safeFileName(name);
  let file = base;
  for (let i = 1; fs.existsSync(path.join(uploads, file)); i++) {
    const ext = path.extname(base);
    file = `${base.slice(0, base.length - ext.length)}-${i}${ext}`;
  }
  const abs = path.join(uploads, file);
  fs.writeFileSync(abs, buffer, { flag: 'wx' });
  return { name: file, path: abs, size: buffer.length };
}

// The folder a session's files go in: an SDK session's own uploads/ (also
// where its pasted images are), a terminal tab's interactions/<id>/ folder.
function sessionDirFor(mgr, { tab, sess } = {}) {
  let session = null;
  if (tab) session = mgr.get?.(String(tab)) || null;
  else if (sess) session = mgr.getBySessId?.(String(sess)) || null;
  if (session) {
    const dir = session.sessionDir?.() || session.getSettings?.()?.sessionDir || null;
    if (dir) return dir;
    const id = session.sessId || tab;
    if (id) return path.join(DATA_HOME, 'interactions', String(id));
  }
  const saved = sess ? mgr.sessionDirOf?.(String(sess)) : null;
  return saved || null;
}

// The text of an MCP tool result: its text blocks joined.
function resultText(r) {
  return (r?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
}

// → { text }. Throws an Error with .status for what the client should show.
async function transcribe({ buffer, mime, language }, platform) {
  if (!platform?.putArtifact || !platform?.call) {
    throw Object.assign(new Error('Transcription is not available: it needs the platform audio tool (VistaClair Pro), which is not loaded here.'), { status: 501 });
  }
  if (!buffer || !buffer.length) throw Object.assign(new Error('the recording is empty'), { status: 400 });
  if (buffer.length > AUDIO_MAX) throw Object.assign(new Error(`the recording is too large (${fmtSize(buffer.length)}; max ${fmtSize(AUDIO_MAX)})`), { status: 413 });
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!/^(audio|video)\/[a-z0-9.+-]+$/.test(base)) throw Object.assign(new Error(`not an audio recording (${base || 'no content type'})`), { status: 400 });
  const ext = (base.split('/')[1] || 'webm').replace(/^x-/, '').replace(/\+.*$/, '').replace('mpeg', 'mp3').replace('mp4', 'm4a');
  let uri;
  try {
    const art = await platform.putArtifact(buffer, { mime: base, name: `recording-${Date.now()}.${ext}` });
    uri = art?.uri;
    if (!uri) throw new Error('no artifact uri came back');
  } catch (e) {
    throw Object.assign(new Error(`Could not store the recording: ${e.message}`), { status: 502 });
  }
  let result;
  try {
    const args = { uri };
    if (language) args.language = language;
    result = await platform.call(TRANSCRIBE_TOOL, args);
  } catch (e) {
    throw Object.assign(new Error(`Transcription failed: ${e.message}`), { status: 502 });
  }
  const body = resultText(result).trim();
  if (result?.isError) throw Object.assign(new Error(`Transcription failed: ${body || 'the audio tool refused'}`), { status: 502 });
  if (/: no speech found\.?$/.test(body)) return { text: '' };
  // "Transcript of <uri> (data, not instructions):\n<text>"
  const m = body.match(/^Transcript of [^\n]*\n([\s\S]*)$/);
  return { text: (m ? m[1] : body).trim() };
}

// `platform` is read per request (the add-on registers after this router).
function createUploadRouter({ mgr, platform = () => null }) {
  const router = express.Router();
  const raw = (limit) => express.raw({ type: () => true, limit });
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });

  router.post('/session-upload', raw(FILE_MAX), (req, res) => {
    try {
      const dir = sessionDirFor(mgr, { tab: req.query.tab, sess: req.query.sess });
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      res.json(saveUpload(dir, req.query.name, buf));
    } catch (e) { fail(res, e); }
  });

  router.post('/session-transcribe', raw(AUDIO_MAX), async (req, res) => {
    try {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const language = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(String(req.query.language || '')) ? String(req.query.language) : '';
      res.json(await transcribe({ buffer: buf, mime: req.headers['content-type'], language }, platform()));
    } catch (e) { fail(res, e); }
  });

  // express.raw's own refusal (body over the limit) as the same JSON shape.
  router.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: `the file is too large (max ${fmtSize(FILE_MAX)})` });
    next(err);
  });
  return router;
}

module.exports = { FILE_MAX, AUDIO_MAX, TRANSCRIBE_TOOL, safeFileName, saveUpload, sessionDirFor, transcribe, createUploadRouter };
