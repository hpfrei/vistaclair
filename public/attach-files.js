// What the two input lines (<vc-composer>, the terminal tabs' message bar)
// share when a file or a recording arrives. Pure functions, no DOM, so they run
// under node's test runner too (test/attach-files.test.js).
//
//   classifyFile  an image → a base64 block (the composer's own path); any
//                 other file → upload, and the message names the saved path
//   attachedLines the "Attached: /abs/path" lines appended to a message
//   quotePath     a path as a terminal paste would write it
//   insertAtCursor / formatElapsed / pickRecorderMime   the mic's helpers
(function (root) {
  const IMAGE_MAX = 8 * 1024 * 1024;     // base64 images (sdk-session.js MAX_IMAGE_BYTES)
  const IMAGES_TOTAL_MAX = 18 * 1024 * 1024;
  const FILE_MAX = 25 * 1024 * 1024;     // uploads (src/session-uploads.js FILE_MAX)
  // The types the SDK takes as image content blocks; svg, heic, tiff… are files.
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  const fmtSize = (n) => n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) ? 1 : 0)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;

  // → { kind: 'image' | 'file' } or { kind: 'reject', reason }
  function classifyFile(file, { imageMax = IMAGE_MAX, fileMax = FILE_MAX } = {}) {
    const name = file?.name || 'that file';
    const size = Number(file?.size) || 0;
    const type = String(file?.type || '').toLowerCase();
    if (IMAGE_TYPES.includes(type)) {
      if (size > imageMax) return { kind: 'reject', reason: `"${name}" is too large (max ${fmtSize(imageMax)} for an image)` };
      return { kind: 'image' };
    }
    // A dropped folder arrives as an empty, typeless "file".
    if (!size && !type) return { kind: 'reject', reason: `"${name}" is empty or a folder; only files can be attached` };
    if (!size) return { kind: 'reject', reason: `"${name}" is empty` };
    if (size > fileMax) return { kind: 'reject', reason: `"${name}" is too large (max ${fmtSize(fileMax)})` };
    return { kind: 'file' };
  }

  // The message text with one "Attached: <abs path>" line per saved file.
  function withAttached(text, paths) {
    const list = (paths || []).filter(Boolean);
    if (!list.length) return text;
    const lines = list.map(p => `Attached: ${p}`).join('\n');
    return text && text.trim() ? `${text.replace(/\s+$/, '')}\n\n${lines}` : lines;
  }

  // A path the way a terminal drop writes it: bare when it is plain, else in
  // single quotes (an embedded quote closed, escaped and reopened).
  function quotePath(p) {
    const s = String(p);
    return /^[A-Za-z0-9_\/.,:@%+=~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
  }

  // Text put into a textarea value at its selection → { value, caret }.
  function insertAtCursor(value, start, end, text) {
    const v = String(value || '');
    const a = Math.min(Math.max(start ?? v.length, 0), v.length);
    const b = Math.min(Math.max(end ?? a, a), v.length);
    const before = v.slice(0, a), after = v.slice(b);
    // A space between a word and what lands against it; none at a line start.
    const lead = before && !/\s$/.test(before) ? ' ' : '';
    const trail = after && !/^\s/.test(after) ? ' ' : '';
    const ins = lead + text + trail;
    return { value: before + ins + after, caret: before.length + lead.length + text.length };
  }

  const formatElapsed = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  // The first container MediaRecorder will produce, webm/opus preferred (what
  // the transcription providers take best); '' lets the browser choose.
  function pickRecorderMime(isSupported) {
    const want = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return want.find(m => { try { return isSupported(m); } catch { return false; } }) || '';
  }

  const api = { IMAGE_MAX, IMAGES_TOTAL_MAX, FILE_MAX, IMAGE_TYPES, fmtSize, classifyFile, withAttached, quotePath, insertAtCursor, formatElapsed, pickRecorderMime };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VcAttach = api;
})(typeof window !== 'undefined' ? window : globalThis);
