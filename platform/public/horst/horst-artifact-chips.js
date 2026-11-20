// vc-artifact:// uris in a chat message → download chips (images as inline
// thumbnails), served by the owner route /pro/artifacts/:id. Pure: text in,
// HTML out — node --test requires it (test/horst-artifacts-io.test.js). Each
// chip carries a "Files" link (data-art-files) that horst.js turns into the
// Files view opened on that artifact's delivery.
//
// It reads the two line shapes the platform writes, falling back to the bare
// uri anywhere else:
//   - name (mime, size): vc-artifact://art_…          a job outcome or a chat turn's tool files (agent/horst-jobs.js fileLines)
//   [attached: vc-artifact://art_… name mime size]    a Telegram upload (platform-horst.js)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HorstArtifactChips = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const BASE = '/pro/artifacts/';
  const URI_RE = /vc-artifact:\/\/(art_[0-9a-f]{16}-[0-9a-f]{4})/g;
  const OUTCOME_RE = /^\s*-\s+(.+?)\s+\(([^,()]+)(?:,\s*([^()]*))?\):\s*vc-artifact:\/\/(art_[0-9a-f]{16}-[0-9a-f]{4})\s*$/;
  const ATTACHED_RE = /\[attached:\s*vc-artifact:\/\/(art_[0-9a-f]{16}-[0-9a-f]{4})\s+(.+?)\s+([a-z0-9.+-]+\/[a-z0-9.+-]+)\s+([\d.]+\s*[kKMG]?B)\]/g;
  const THUMB_MIME = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // text → [{ id, uri, name, mime, size }], first mention wins, in order.
  function refsOf(text) {
    const s = String(text || '');
    const byId = new Map();
    const add = (id, name, mime, size) => {
      const cur = byId.get(id);
      if (cur && cur.mime) return;
      byId.set(id, { id, uri: 'vc-artifact://' + id, name: name || (cur && cur.name) || id, mime: mime || '', size: size || '' });
    };
    const order = [];
    for (const m of s.matchAll(URI_RE)) if (!order.includes(m[1])) order.push(m[1]);
    for (const line of s.split('\n')) {
      const m = OUTCOME_RE.exec(line);
      if (m) add(m[4], m[1], m[2].trim().toLowerCase(), (m[3] || '').trim());
    }
    for (const m of s.matchAll(ATTACHED_RE)) add(m[1], m[2], m[3].toLowerCase(), m[4]);
    return order.map((id) => byId.get(id) || { id, uri: 'vc-artifact://' + id, name: id, mime: '', size: '' });
  }

  function chipHtml(ref) {
    const href = BASE + encodeURIComponent(ref.id);
    const meta = [ref.mime, ref.size].filter(Boolean).join(' · ');
    const thumb = THUMB_MIME.test(ref.mime)
      ? `<a class="art-thumb" href="${href}" target="_blank" rel="noopener"><img src="${href}" alt="${esc(ref.name)}" loading="lazy"></a>`
      : '';
    return `<div class="art-chip" data-art-id="${esc(ref.id)}">${thumb}`
      + `<a class="art-dl" href="${href}?download=1" download="${esc(ref.name)}" title="${esc(ref.uri)}">⬇ ${esc(ref.name)}</a>`
      + (meta ? ` <span class="art-meta">${esc(meta)}</span>` : '')
      + `<a class="art-files" href="#files" data-art-files="${esc(ref.id)}" title="Open in Files — everything Horst delivered to you">⧉ Files</a>`
      + '</div>';
  }

  // The chip row for a message, or '' when it names no artifact.
  function chipsHtml(text) {
    const refs = refsOf(text);
    return refs.length ? `<div class="art-chips">${refs.map(chipHtml).join('')}</div>` : '';
  }

  return { refsOf, chipHtml, chipsHtml, BASE };
}));
