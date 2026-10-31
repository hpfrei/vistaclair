// Safety rules for question forms (core.js askFormBuildHTML): which inline
// markup a question's markdown may keep, and which image srcs a form may load.
// The inline HTML goes through DOMPurify in the page, then through
// cleanInlineHtml, an allow-list that rebuilds every tag it keeps and escapes
// the rest, so it needs no DOM and holds even when DOMPurify failed to load.
(function (root) {
  // What marked.parseInline produces, and nothing else.
  const INLINE_TAGS = ['a', 'b', 'strong', 'i', 'em', 'code', 'del', 's', 'br', 'img', 'sub', 'sup', 'kbd', 'mark'];
  const INLINE_ATTRS = { a: ['href', 'title'], img: ['src', 'alt', 'title'] };
  const PURIFY_INLINE = { ALLOWED_TAGS: INLINE_TAGS, ALLOWED_ATTR: ['href', 'title', 'src', 'alt'] };
  const VOID = new Set(['br', 'img']);
  // Dropped with everything inside them.
  const DROP_RE = /<(script|style|iframe|object|embed|template|noscript|textarea|title|xmp|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;
  const TAG_RE = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
  const ATTR_RE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  const escText = (s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', sol: '/', lpar: '(', rpar: ')' };
  function decodeAttr(s) {
    return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));?/gi, (m, d, h, n) => {
      if (d || h) { try { return String.fromCodePoint(parseInt(d || h, d ? 10 : 16)); } catch { return ''; } }
      return NAMED[n.toLowerCase()] ?? m;
    });
  }

  // A link or image URL as the browser would read it: relative, http(s),
  // mailto: (links) or data:image/ (images). Anything else is refused.
  function safeUrl(raw, tag) {
    const url = decodeAttr(raw).replace(/[\u0000- \u007f]+/g, '');
    const scheme = url.split(/[/?#]/)[0];
    if (!/[:&]/.test(scheme)) return true;
    if (/^https?:$/i.test(scheme)) return true;
    if (tag === 'a') return /^mailto:/i.test(scheme);
    return /^data:image\//i.test(url);
  }

  // Inline HTML with only INLINE_TAGS and their INLINE_ATTRS left, every URL
  // checked, and any other `<` or `>` escaped as text.
  function cleanInlineHtml(html) {
    if (typeof html !== 'string' || !html) return '';
    html = html.replace(DROP_RE, '');
    let out = '';
    let last = 0;
    TAG_RE.lastIndex = 0;
    for (let m; (m = TAG_RE.exec(html));) {
      out += escText(html.slice(last, m.index));
      last = TAG_RE.lastIndex;
      const name = (m[2] || '').toLowerCase();
      if (!INLINE_TAGS.includes(name)) continue;
      if (m[1]) { if (!VOID.has(name)) out += `</${name}>`; continue; }
      const allowed = INLINE_ATTRS[name] || [];
      let attrs = '';
      ATTR_RE.lastIndex = 0;
      for (let a; (a = ATTR_RE.exec(m[3]));) {
        const attr = a[1].toLowerCase();
        const val = a[2] ?? a[3] ?? a[4] ?? '';
        if (!allowed.includes(attr) || attrs.includes(` ${attr}="`)) continue;
        if ((attr === 'href' || attr === 'src') && !safeUrl(val, name)) continue;
        attrs += ` ${attr}="${escAttr(decodeAttr(val))}"`;
      }
      out += `<${name}${attrs}>`;
    }
    return out + escText(html.slice(last));
  }

  // Image src from a form → { url, path } or null when it can't be shown.
  // Accepts http(s) URLs, data:image/ URIs, absolute paths and paths relative
  // to the asking session's cwd; local files load through /api/raw-file. Any
  // other scheme (javascript:, file: aside) is refused. An ask from a session
  // on another machine (remote) may only show data:image/ URIs: its paths
  // would read this machine's files, its URLs would call out.
  function askImageSrc(src, cwd, remote) {
    src = typeof src === 'string' ? src.trim() : '';
    if (!src) return null;
    if (/^data:image\//i.test(src)) return { url: src, path: null };
    if (remote) return null;
    if (/^https?:\/\//i.test(src)) return { url: src, path: null };
    let p = src;
    if (/^file:\/\//i.test(p)) { try { p = decodeURIComponent(p.slice(7)); } catch { return null; } }
    else if (!/^[a-zA-Z]:[\\/]/.test(p) && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return null;
    if (!p.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(p)) {
      if (!cwd) return null;
      p = cwd.replace(/[\\/]+$/, '') + '/' + p.replace(/^\.\//, '');
    }
    return { url: '/api/raw-file?path=' + encodeURIComponent(p), path: p };
  }

  const api = { cleanInlineHtml, askImageSrc, PURIFY_INLINE, INLINE_TAGS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.askSafe = api;
})(typeof window !== 'undefined' ? window : globalThis);
