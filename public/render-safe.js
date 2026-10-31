// Safety rules for rendered session output (core.js renderMarkdown, the user
// turns of sdk-panel.js). Anything a session prints may be hostile HTML: a
// remote session relayed by an add-on, or a prompt injection. Markdown HTML
// goes through DOMPurify with PURIFY_BLOCK in the page, then through
// cleanHtml, a DOM-free pass that rebuilds every tag it keeps without event
// handlers or unsafe URLs, so a DOMPurify gap still renders inert.
(function (root) {
  // Live html/svg fences draw with these on top of DOMPurify's defaults.
  const SVG_TAGS = ['svg', 'circle', 'rect', 'line', 'polyline', 'polygon', 'path', 'text', 'g', 'defs', 'use', 'symbol', 'clipPath', 'mask', 'pattern', 'image', 'ellipse', 'tspan', 'textPath', 'linearGradient', 'radialGradient', 'stop', 'filter', 'feGaussianBlur', 'feOffset', 'feMerge', 'feMergeNode', 'feBlend', 'feColorMatrix', 'feComposite', 'animate', 'animateTransform', 'marker'];
  const SVG_ATTRS = ['viewBox', 'xmlns', 'fill', 'stroke', 'stroke-width', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'd', 'points', 'transform', 'opacity', 'font-size', 'text-anchor', 'dominant-baseline', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'clip-path', 'mask', 'filter', 'gradientUnits', 'offset', 'stop-color', 'stop-opacity', 'preserveAspectRatio', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'stdDeviation', 'dx', 'dy', 'result', 'in', 'in2', 'mode', 'values', 'type', 'begin', 'dur', 'repeatCount', 'attributeName', 'from', 'to'];
  // Elements that run, embed, submit or restyle the page; attributes that load
  // or submit elsewhere. DOMPurify already drops on* handlers and javascript:.
  const FORBID_TAGS = ['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'base', 'link', 'meta', 'template', 'noscript', 'portal', 'math'];
  const FORBID_ATTR = ['srcset', 'action', 'formaction', 'srcdoc', 'http-equiv', 'ping'];
  const PURIFY_BLOCK = { FORBID_TAGS, FORBID_ATTR, ADD_TAGS: SVG_TAGS, ADD_ATTR: SVG_ATTRS };

  // cleanHtml: dropped with everything inside them, or as a tag only.
  const DROP = ['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'template', 'noscript', 'noembed', 'noframes', 'xmp', 'plaintext', 'title', 'math'];
  const STRIP = new Set(['form', 'base', 'link', 'meta', 'portal']);
  const DROP_RE = new RegExp(`<(${DROP.join('|')})\\b[\\s\\S]*?(?:<\\/\\1\\s*>|$)`, 'gi');
  const DROP_SET = new Set(DROP);
  const ANIMATE = new Set(['animate', 'animatetransform', 'animatemotion', 'set']);
  const URL_ATTRS = new Set(['href', 'xlink:href', 'src', 'action', 'formaction', 'poster', 'background', 'cite', 'data', 'codebase', 'lowsrc', 'dynsrc', 'longdesc', 'manifest', 'icon']);
  const DATA_IMAGE_TAGS = new Set(['img', 'image', 'source']);
  const TAG_RE = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
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

  // A URL as the browser would read it: relative, http(s), mailto: or tel:,
  // and data:image/ on image elements. Anything else is refused.
  function safeUrl(raw, tag) {
    const url = decodeAttr(raw).replace(/[\u0000- \u007f]+/g, '');
    const scheme = url.split(/[/?#]/)[0];
    if (!/[:&]/.test(scheme)) return true;
    if (/^(?:https?|mailto|tel):$/i.test(scheme)) return true;
    return DATA_IMAGE_TAGS.has(tag) && /^data:image\//i.test(url);
  }

  // HTML with active elements gone, every kept tag rebuilt without on*
  // handlers, FORBID_ATTR or unsafe URLs, SVG animations of links dropped,
  // and any other `<` or `>` escaped as text.
  function cleanHtml(html) {
    if (typeof html !== 'string' || !html) return '';
    html = html.replace(DROP_RE, '');
    let out = '';
    let last = 0;
    TAG_RE.lastIndex = 0;
    for (let m; (m = TAG_RE.exec(html));) {
      out += escText(html.slice(last, m.index));
      last = TAG_RE.lastIndex;
      const tag = m[2];
      const name = (tag || '').toLowerCase();
      if (!name || DROP_SET.has(name) || STRIP.has(name)) continue;
      if (m[1]) { out += `</${tag}>`; continue; }
      let attrs = '';
      let drop = false;
      const seen = new Set();
      ATTR_RE.lastIndex = 0;
      for (let a; (a = ATTR_RE.exec(m[3]));) {
        const attr = a[1].toLowerCase();
        const val = a[2] ?? a[3] ?? a[4];
        if (!/^[a-z_:][-a-z0-9_:.]*$/.test(attr) || seen.has(attr)) continue;
        seen.add(attr);
        if (/^on/.test(attr) || FORBID_ATTR.includes(attr) || attr === 'style' && /expression|url\s*\(\s*(?!['"]?#)|@import/i.test(decodeAttr(val || ''))) continue;
        if (URL_ATTRS.has(attr) && !safeUrl(val || '', name)) continue;
        // <animate attributeName="href" values="javascript:…"> rewrites a link.
        if (ANIMATE.has(name) && attr === 'attributename' && /^(?:xlink:)?href$|^src$|^on/i.test(decodeAttr(val || '').trim())) drop = true;
        attrs += val == null ? ` ${a[1]}` : ` ${a[1]}="${escAttr(decodeAttr(val))}"`;
      }
      if (!drop) out += `<${tag}${attrs}${m[4] ? ' /' : ''}>`;
    }
    return out + escText(html.slice(last));
  }

  // Markdown HTML through `purify` (DOMPurify) with `cfg` (PURIFY_BLOCK by
  // default), then cleanHtml. Without a usable purify only cleanHtml runs.
  function sanitizeHtml(html, purify, cfg) {
    const purified = purify && typeof purify.sanitize === 'function' ? purify.sanitize(String(html ?? ''), cfg || PURIFY_BLOCK) : html;
    return cleanHtml(String(purified ?? ''));
  }

  // The src of an image in a user turn, or null when it may not load: only
  // data:image/ URIs and this dashboard's own uploads (/api/uploads/…, and
  // /api/sdk/upload?… where SDK sessions serve pasted images) are shown.
  function userImageUrl(url) {
    if (typeof url !== 'string') return null;
    if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(url)) return url;
    if (/[\s\\#]/.test(url)) return null;
    const q = url.indexOf('?');
    const p = q < 0 ? url : url.slice(0, q);
    if (p === '/api/sdk/upload' && q > 0) return url;
    const segs = p.split('/');
    if (segs[1] !== 'api' || segs[2] !== 'uploads' || segs.length < 4) return null;
    if (segs.slice(3).some(s => !/^[A-Za-z0-9._~-]+$/.test(s) || /^\.+$/.test(s))) return null;
    return url;
  }

  const api = { cleanHtml, sanitizeHtml, userImageUrl, PURIFY_BLOCK, FORBID_TAGS, FORBID_ATTR };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.renderSafe = api;
})(typeof window !== 'undefined' ? window : globalThis);
