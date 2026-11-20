// <vc-markdown> — rich document renderer for the vistaclair-pro `vc-*` system.
// Shadow-DOM, theme-aware, built on vc-core (`Vc.Element`). Renders a "VistaDoc":
// an extended-markdown document that also carries inline LaTeX math, sized media
// previews (image/video/audio/pdf/file), and SVG — all in one safe surface.
//
// A VistaDoc is EITHER a plain markdown string (fully backwards compatible) OR a
// JSON object:
//   {
//     "vcdoc": 1,
//     "body": "# Title\n\nInline $E=mc^2$ …\n\n![door](media:cam1){width=160}\n",
//     "assets": {
//       "cam1":    { "type": "media", "src": "photo.jpg", "mime": "image/jpeg", "title": "Door" },
//       "diagram": { "type": "svg",   "src": "<svg …>…</svg>", "title": "Flow" }
//     }
//   }
//
// Body grammar = CommonMark/GFM, plus:
//   • Math:   $…$ inline, $$…$$ block (escape a literal dollar with \$).
//   • Embeds: standard image syntax with a scheme — ![alt](media:ID) / ![alt](svg:ID),
//             resolved against `assets`. A plain ![alt](url-or-path) is also rendered
//             as a media preview (no asset entry needed).
//   • Sizing: a trailing attribute block — ![…](media:ID){width=320 height=200}.
//             Width-only keeps aspect ratio; omit both for a small default preview.
// SVG/media source lives in `assets`, NEVER inline in the body — that separation is
// what keeps the markdown, math, and SVG renderers from clashing.
//
// Every media/SVG preview OPENS THE SHARED <vc-media-viewer> LIGHTBOX on click (one
// modal viewer per document, reused) — apps must not hand-roll a media overlay. All
// embeds in a doc form one gallery so ←/→ pages through them.
//
// Safety: math is rendered via the Vc.renderMath seam (KaTeX) and all HTML — marked
// output, KaTeX output, and inline SVG — passes through Vc.sanitize (DOMPurify) before
// it touches the DOM. Without those engines installed the component degrades: math
// shows as raw TeX, body as escaped text (each warns once via core).
//
// Usage:
//   <vc-markdown></vc-markdown>
//   el.doc = "# Hello $x^2$";                 // string or VistaDoc object
//   el.doc = { vcdoc:1, body:"…", assets:{…} };
//   el.assets = { cam1: { type:'media', src:'…' } };  // merge extra assets, re-renders
//   <vc-markdown src="report.json"></vc-markdown>     // fetch + render a doc
// Attributes: src (URL to fetch), thumb-size (default preview px, default 200).
// Properties: doc (get/set), assets (get/set/merge).
// Events (composed): embedopen {id,item}, rendererror {message}.

(function () {
  'use strict';
  if (!window.Vc || !Vc.Element) { console.error('[vc-markdown] requires vc-core.js'); return; }
  if (window.customElements && customElements.get('vc-markdown')) return;

  var KATEX_CSS_HREF = '/pro/katex.min.css';
  var DEFAULT_THUMB = 200;

  // Lazy-load the heavy renderers (marked ~35KB, KaTeX ~275KB) once, on first use,
  // so apps that never render a doc don't pay for them. app-runtime exposes the
  // shared loader; fall back to a local one if vc-markdown is used standalone.
  var _enginesPromise = null;
  function loadScript(src) {
    if (window.__vcLoadScript) return window.__vcLoadScript(src);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = function () { reject(new Error('load failed: ' + src)); };
      document.head.appendChild(s);
    });
  }
  function installSanitizer() {
    if (window.__vcInstallSanitizer) return window.__vcInstallSanitizer();
    if (!window.Vc || !window.DOMPurify || Vc.__sanitizerInstalled) return;
    Vc.setSanitizer(function (html) {
      return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true } });
    });
    Vc.__sanitizerInstalled = true;
  }
  function ensureEngines() {
    if (_enginesPromise) return _enginesPromise;
    var jobs = [];
    if (!window.marked) jobs.push(loadScript('/pro/marked.min.js').catch(function (e) { console.warn('[vc-markdown]', e); }));
    if (!(window.Vc && Vc.__sanitizerInstalled) && !window.DOMPurify) {
      jobs.push(loadScript('/pro/purify.min.js').then(function () {
        installSanitizer();
      }).catch(function (e) { console.warn('[vc-markdown] DOMPurify load failed; HTML stays unsanitized:', e); }));
    }
    if (!(window.Vc && Vc.__mathInstalled)) {
      jobs.push(loadScript('/pro/katex.min.js').then(function () {
        if (window.katex && window.Vc && !Vc.__mathInstalled) {
          Vc.setMathRenderer(function (tex, opts) {
            return window.katex.renderToString(tex, { displayMode: !!(opts && opts.display), throwOnError: false, output: 'html' });
          });
          Vc.__mathInstalled = true;
        }
      }).catch(function (e) { console.warn('[vc-markdown] KaTeX load failed; math shown as raw TeX:', e); }));
    }
    // Ensure the sanitizer is wired even if app-runtime is absent.
    installSanitizer();
    _enginesPromise = Promise.all(jobs);
    return _enginesPromise;
  }

  // One shared modal lightbox per document, created lazily and reused by every
  // <vc-markdown> instance — the click target for all media/SVG previews.
  var _sharedViewer = null;
  function sharedViewer() {
    if (_sharedViewer && _sharedViewer.isConnected) return _sharedViewer;
    var v = document.createElement('vc-media-viewer');
    v.setAttribute('modal', '');
    v.hidden = true;
    document.body.appendChild(v);
    _sharedViewer = v;
    return v;
  }

  // ---- markdown helpers ----
  function lineStart(s, i) {
    // i is at a column where only whitespace precedes it on the line (CommonMark
    // allows up to 3 leading spaces before a fence; we are lenient).
    var j = i - 1;
    while (j >= 0 && s[j] !== '\n') { if (s[j] !== ' ' && s[j] !== '\t') return false; j--; }
    return true;
  }
  function matchFence(s, i) {
    // ``` or ~~~ (run >= 3) at line start → consume through the closing fence line.
    var ch = s[i], k = 0;
    while (s[i + k] === ch) k++;
    if (k < 3) return -1;
    var nl = s.indexOf('\n', i + k);
    var pos = nl < 0 ? s.length : nl + 1;
    while (pos < s.length) {
      // closing fence: line start, same char, run >= opening length, only ws after
      if (lineStart(s, pos)) {
        var p = pos; while (s[p] === ' ' || s[p] === '\t') p++;
        if (s[p] === ch) {
          var c = 0; while (s[p + c] === ch) c++;
          if (c >= k) {
            var after = p + c; while (s[after] === ' ' || s[after] === '\t') after++;
            if (after >= s.length || s[after] === '\n') {
              var endnl = s.indexOf('\n', after);
              return endnl < 0 ? s.length : endnl + 1;
            }
          }
        }
      }
      var n2 = s.indexOf('\n', pos);
      pos = n2 < 0 ? s.length : n2 + 1;
    }
    return s.length; // unterminated fence → to EOF
  }
  function matchInlineCode(s, i) {
    // backtick run of length k closes at the next run of exactly k backticks.
    var k = 0; while (s[i + k] === '`') k++;
    var j = i + k;
    while (j < s.length) {
      if (s[j] === '`') {
        var c = 0; while (s[j + c] === '`') c++;
        if (c === k) return j + c;
        j += c;
      } else j++;
    }
    return -1; // unterminated → not code
  }
  function findDelim(s, from, delim) {
    // next unescaped occurrence of delim (1- or 2-char) starting at `from`.
    for (var j = from; j <= s.length - delim.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s.substr(j, delim.length) === delim) return j;
    }
    return -1;
  }
  function matchInlineMath(s, i) {
    // Pandoc rule: opening $ must be followed by a non-space; closing $ must be
    // preceded by a non-space and not followed by a digit; no blank line inside.
    if (s[i + 1] == null || /\s/.test(s[i + 1])) return null;
    for (var j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '\n' && s[j + 1] === '\n') return null;
      if (s[j] === '$') {
        var prev = s[j - 1], next = s[j + 1];
        if (!/\s/.test(prev) && !(next != null && /\d/.test(next))) {
          return { tex: s.slice(i + 1, j), end: j + 1 };
        }
      }
    }
    return null;
  }
  function matchImage(s, i) {
    // ![alt](dest "title"?){attrs}? — inline images only (no reference style).
    if (s[i] !== '!' || s[i + 1] !== '[') return null;
    var close = s.indexOf(']', i + 2);
    if (close < 0 || s[close + 1] !== '(') return null;
    var alt = s.slice(i + 2, close);
    if (alt.indexOf('\n') >= 0) return null;
    var p = close + 2, depth = 1, dest = '';
    for (; p < s.length; p++) {
      var c = s[p];
      if (c === '\\') { dest += s[p + 1] || ''; p++; continue; }
      if (c === '(') depth++;
      if (c === ')') { depth--; if (depth === 0) break; }
      if (c === '\n') return null;
      dest += c;
    }
    if (depth !== 0) return null;
    var end = p + 1;
    dest = dest.trim();
    var title = '';
    var tm = /\s+"([^"]*)"$|\s+'([^']*)'$/.exec(dest);
    if (tm) { title = tm[1] != null ? tm[1] : tm[2]; dest = dest.slice(0, tm.index).trim(); }
    var attrs = null;
    if (s[end] === '{') {
      var bclose = s.indexOf('}', end + 1);
      if (bclose >= 0 && s.slice(end + 1, bclose).indexOf('\n') < 0) {
        attrs = parseAttrs(s.slice(end + 1, bclose));
        end = bclose + 1;
      }
    }
    return { alt: alt, dest: dest, title: title, attrs: attrs, end: end };
  }
  function parseAttrs(str) {
    var out = {};
    var re = /(width|height)\s*=\s*("([^"]*)"|'([^']*)'|[^\s}]+)/gi;
    var m;
    while ((m = re.exec(str))) {
      var v = m[3] != null ? m[3] : (m[4] != null ? m[4] : m[2]);
      out[m[1].toLowerCase()] = v;
    }
    return out;
  }
  function cssLen(v) {
    if (v == null || v === '') return null;
    return /^\d+$/.test(String(v)) ? v + 'px' : String(v);
  }

  var TEMPLATE =
    '<link rel="stylesheet" href="' + KATEX_CSS_HREF + '">' +
    '<style>' +
    ':host { display: block; color: var(--text, #c0caf5); font-size: 13px; line-height: 1.6; }' +
    ':host([hidden]) { display: none; }' +
    '.vc-md { overflow-wrap: anywhere; word-wrap: break-word; }' +
    '.vc-md :where(h1,h2,h3,h4,h5,h6) { line-height: 1.25; margin: 1em 0 .5em; }' +
    '.vc-md :where(h1):first-child, .vc-md :where(h2):first-child, .vc-md :where(p):first-child { margin-top: 0; }' +
    '.vc-md :where(p) { margin: .6em 0; }' +
    '.vc-md :where(a) { color: var(--accent, #7aa2f7); text-decoration: none; }' +
    '.vc-md :where(a):hover { text-decoration: underline; }' +
    '.vc-md :where(ul,ol) { padding-left: 1.4em; margin: .5em 0; }' +
    '.vc-md :where(li) { margin: .2em 0; }' +
    '.vc-md :where(blockquote) { margin: .6em 0; padding: .2em .9em; border-left: 3px solid var(--border, #414868); color: var(--text-dim, #565f89); }' +
    '.vc-md :where(code) { font-family: var(--font-mono, monospace); font-size: .92em; }' +
    '.vc-md :where(:not(pre) > code) { background: var(--bg-deep, #0a0e17); padding: .1em .35em; border-radius: 4px; }' +
    '.vc-md :where(pre) { background: var(--bg-deep, #0a0e17); padding: 10px 12px; border-radius: var(--radius, 6px); overflow-x: auto; }' +
    '.vc-md :where(pre code) { background: none; padding: 0; }' +
    '.vc-md :where(table) { border-collapse: collapse; margin: .6em 0; }' +
    '.vc-md :where(th,td) { border: 1px solid var(--border, #414868); padding: 5px 9px; text-align: left; }' +
    '.vc-md :where(hr) { border: 0; border-top: 1px solid var(--border, #414868); margin: 1em 0; }' +
    '.vc-md :where(img) { max-width: 100%; }' +
    '.katex-display { margin: .7em 0; overflow-x: auto; overflow-y: hidden; }' +
    '.vc-math-raw { color: var(--orange, #ff9e64); }' +
    /* media / svg embed previews */
    '.vc-embed { display: inline-block; vertical-align: middle; max-width: 100%; margin: 2px; cursor: pointer;' +
    '  border: 1px solid var(--border, #414868); border-radius: var(--radius, 6px); overflow: hidden;' +
    '  background: var(--bg-surface, #24283b); transition: border-color .12s, box-shadow .12s; }' +
    '.vc-embed:hover, .vc-embed:focus-visible { border-color: var(--accent, #7aa2f7);' +
    '  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #7aa2f7) 35%, transparent); outline: none; }' +
    '.vc-embed img { display: block; width: 100%; height: 100%; object-fit: cover; }' +
    '.vc-embed .vc-svgbox { display: grid; place-items: center; width: 100%; height: 100%; }' +
    '.vc-embed .vc-svgbox svg { max-width: 100%; max-height: 100%; height: auto; }' +
    '.vc-embed.vc-video { position: relative; }' +
    '.vc-embed.vc-video .vc-play { position: absolute; inset: 0; display: grid; place-items: center;' +
    '  font-size: 26px; color: #fff; background: rgba(0,0,0,.28); }' +
    '.vc-embed.vc-card { display: inline-flex; align-items: center; gap: 8px; padding: 8px 11px; cursor: pointer;' +
    '  font-size: 12px; color: var(--text, #c0caf5); }' +
    '.vc-embed.vc-card .ic { font-size: 20px; line-height: 1; }' +
    '.vc-embed.vc-card .nm { font-weight: 600; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }' +
    '.vc-embed.vc-bad { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; cursor: default;' +
    '  color: var(--red, #f7768e); border-color: var(--red, #f7768e); font-size: 12px; }' +
    '@media (prefers-reduced-motion: reduce) { .vc-embed { transition: none; } }' +
    '</style>' +
    '<div class="vc-md" part="content"></div>';

  class VcMarkdown extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() { return ['src', 'thumb-size']; }

    constructor() {
      super();
      this._content = this.$('.vc-md');
      this._doc = '';
      this._extraAssets = {};
      this._embeds = [];
      this._gallery = [];
    }

    connectedCallback() {
      if (this.hasAttribute('src') && this._doc === '') this._fetch(this.getAttribute('src'));
      else this._render();
    }

    attributeChangedCallback(name, _old, val) {
      if (!this._content) return;
      if (name === 'src') { if (val) this._fetch(val); }
      else if (name === 'thumb-size') this._render();
    }

    // ---- public API ----
    get doc() { return this._doc; }
    set doc(v) { this._doc = v == null ? '' : v; this._render(); }

    get assets() { return Object.assign({}, this._docAssets(), this._extraAssets); }
    set assets(map) { this._extraAssets = map && typeof map === 'object' ? map : {}; this._render(); }

    // ---- internals ----
    _thumb() {
      var n = Number(this.getAttribute('thumb-size'));
      return isFinite(n) && n > 0 ? n : DEFAULT_THUMB;
    }
    _docAssets() {
      var d = this._doc;
      return (d && typeof d === 'object' && d.assets && typeof d.assets === 'object') ? d.assets : {};
    }
    _normalize() {
      var d = this._doc;
      var body = '', assets = {};
      if (typeof d === 'string') body = d;
      else if (d && typeof d === 'object') { body = typeof d.body === 'string' ? d.body : ''; assets = d.assets || {}; }
      return { body: body, assets: Object.assign({}, assets, this._extraAssets) };
    }

    async _fetch(url) {
      try {
        var res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var ct = res.headers.get('content-type') || '';
        var txt = await res.text();
        if (/json/i.test(ct)) { try { this._doc = JSON.parse(txt); } catch (_) { this._doc = txt; } }
        else this._doc = txt;
        this._render();
      } catch (err) {
        this.emit('rendererror', { message: 'Failed to load doc: ' + (err && err.message || err) });
        this._content.innerHTML = '';
        var p = document.createElement('div');
        p.className = 'vc-embed vc-bad';
        p.textContent = '⚠ Could not load document';
        this._content.appendChild(p);
      }
    }

    _render() {
      if (!this._content) return;
      // Paint immediately with whatever engines are present (graceful: raw text /
      // raw TeX), then ensure the engines are loaded and repaint once they land.
      this._paint();
      var self = this;
      var token = (this._renderToken = (this._renderToken || 0) + 1);
      ensureEngines().then(function () {
        if (token === self._renderToken) self._paint();
      });
    }

    _paint() {
      if (!this._content) return;
      var doc = this._normalize();
      this._embeds = [];
      this._gallery = [];
      var mathHtml = [];
      var nonce = 'vcz' + Math.random().toString(36).slice(2, 9);

      // 1) Protect math + embeds from the markdown parser. Each is rendered/parsed
      //    in isolation and replaced with a contiguous, markdown-inert token.
      var protectedBody;
      try {
        protectedBody = this._protect(doc.body, doc.assets, nonce, mathHtml);
      } catch (err) {
        this.emit('rendererror', { message: 'Parse failed: ' + (err && err.message || err) });
        protectedBody = doc.body;
      }

      // 2) markdown → HTML (math/embeds are inert tokens, untouched here)
      var rawHtml;
      if (window.marked && typeof marked.parse === 'function') {
        try { rawHtml = marked.parse(protectedBody, { gfm: true, breaks: false }); }
        catch (err) { rawHtml = Vc.escapeHtml(protectedBody); this.emit('rendererror', { message: 'Markdown failed: ' + (err && err.message || err) }); }
      } else {
        rawHtml = '<pre>' + Vc.escapeHtml(protectedBody) + '</pre>';
        if (!this._warnedNoMd) { this._warnedNoMd = true; console.warn('[vc-markdown] marked.js not loaded; rendering escaped text.'); }
      }

      // 3) sanitize the markdown output (tokens are plain text → survive intact)
      var safeHtml = Vc.sanitize(rawHtml);

      // 4) swap tokens: math → its (already-sanitized) HTML; embeds → marker spans
      var tokenRe = new RegExp(nonce + '([ME])(\\d+)' + nonce, 'g');
      safeHtml = safeHtml.replace(tokenRe, function (_m, kind, n) {
        if (kind === 'M') return mathHtml[+n] || '';
        return '<span data-vc-embed="' + (+n) + '"></span>';
      });

      // 5) mount, then materialize embed previews (need listeners → real nodes)
      this._content.innerHTML = safeHtml;
      var self = this;
      this._content.querySelectorAll('[data-vc-embed]').forEach(function (span) {
        var idx = +span.getAttribute('data-vc-embed');
        var node = self._buildPreview(self._embeds[idx]);
        if (node) span.replaceWith(node); else span.remove();
      });
    }

    // Walk the body, copying verbatim through code, and replacing math/images with
    // tokens. Returns the tokenized body; fills mathHtml and this._embeds.
    _protect(body, assets, nonce, mathHtml) {
      var out = '', i = 0, n = body.length;
      var self = this;
      var mathTok = function (tex, display) {
        var idx = mathHtml.length;
        mathHtml.push(Vc.sanitize(Vc.renderMath(tex, { display: display })));
        return nonce + 'M' + idx + nonce;
      };
      var embedTok = function (desc) {
        var idx = self._embeds.length;
        self._embeds.push(self._resolveEmbed(desc, assets));
        return nonce + 'E' + idx + nonce;
      };
      while (i < n) {
        var c = body[i];
        if ((c === '`' || c === '~') && lineStart(body, i)) {
          var fe = matchFence(body, i);
          if (fe > 0) { out += body.slice(i, fe); i = fe; continue; }
        }
        if (c === '`') {
          var ic = matchInlineCode(body, i);
          if (ic > 0) { out += body.slice(i, ic); i = ic; continue; }
        }
        if (c === '\\' && body[i + 1] === '$') { out += '\\$'; i += 2; continue; }
        if (c === '!' && body[i + 1] === '[') {
          var img = matchImage(body, i);
          if (img) { out += embedTok(img); i = img.end; continue; }
        }
        if (c === '$' && body[i + 1] === '$') {
          var close = findDelim(body, i + 2, '$$');
          if (close >= 0) { out += mathTok(body.slice(i + 2, close), true); i = close + 2; continue; }
        }
        if (c === '$') {
          var im = matchInlineMath(body, i);
          if (im) { out += mathTok(im.tex, false); i = im.end; continue; }
        }
        out += c; i++;
      }
      return out;
    }

    // Turn a parsed image descriptor into a resolved embed. Media/SVG that joins the
    // lightbox gets a gallery slot; broken refs get an inline error chip.
    _resolveEmbed(desc, assets) {
      var dest = desc.dest || '';
      var schemeM = /^(media|svg):([\s\S]+)$/.exec(dest);
      var title = desc.title || desc.alt || '';
      if (schemeM) {
        var id = schemeM[2].trim();
        var asset = assets[id];
        if (!asset) return { kind: 'bad', message: 'missing asset “' + id + '”', desc: desc };
        if (schemeM[1] === 'svg' || asset.type === 'svg') {
          return this._svgEmbed(asset, desc, title);
        }
        return this._mediaEmbed({
          src: asset.src, mime: asset.mime, kind: asset.kind, title: asset.title || title,
          poster: asset.poster, downloadName: asset.downloadName, fps: asset.fps,
        }, desc);
      }
      // plain url / relative path → media
      if (!dest) return { kind: 'bad', message: 'empty embed', desc: desc };
      return this._mediaEmbed({ src: dest, title: title }, desc);
    }

    _mediaEmbed(item, desc) {
      var gi = this._gallery.length;
      this._gallery.push(item);
      return { kind: 'media', item: item, galleryIndex: gi, attrs: desc.attrs };
    }
    _svgEmbed(asset, desc, title) {
      var safe = Vc.sanitize(String(asset.src || ''));
      // SVG joins the gallery as an image via a data: URL so clicking opens the viewer.
      var dataUri = 'data:image/svg+xml;utf8,' + encodeURIComponent(String(asset.src || ''));
      var item = { src: dataUri, kind: 'image', title: asset.title || title || 'SVG' };
      var gi = this._gallery.length;
      this._gallery.push(item);
      return { kind: 'svg', svg: safe, item: item, galleryIndex: gi, attrs: desc.attrs };
    }

    _sizeStyle(attrs, fallbackSquare) {
      var w = attrs && cssLen(attrs.width);
      var h = attrs && cssLen(attrs.height);
      var s = '';
      if (w) s += 'width:' + w + ';';
      if (h) s += 'height:' + h + ';';
      if (!w && !h) {
        var t = this._thumb();
        s += 'width:' + t + 'px;';
        if (fallbackSquare) s += 'height:' + t + 'px;';
      }
      return s;
    }

    _openGallery(galleryIndex, item) {
      var v = sharedViewer();
      try { v.open(this._gallery.slice(), galleryIndex); }
      catch (err) { console.warn('[vc-markdown] viewer open failed:', err); return; }
      this.emit('embedopen', { id: galleryIndex, item: item });
    }

    _buildPreview(embed) {
      if (!embed) return null;
      var self = this;
      if (embed.kind === 'bad') {
        var bad = document.createElement('span');
        bad.className = 'vc-embed vc-bad';
        bad.textContent = '⚠ ' + embed.message;
        return bad;
      }

      var item = embed.item;
      var kind = item.kind || guessKind(item);
      var node = document.createElement('button');
      node.type = 'button';
      node.className = 'vc-embed';
      node.title = item.title || 'Open';
      node.style.cssText = 'font:inherit;color:inherit;text-align:left;';

      if (embed.kind === 'svg') {
        node.classList.add('vc-svg');
        node.style.cssText += this._sizeStyle(embed.attrs, true);
        var box = document.createElement('div');
        box.className = 'vc-svgbox';
        box.innerHTML = embed.svg;
        node.appendChild(box);
      } else if (kind === 'image') {
        node.style.cssText += this._sizeStyle(embed.attrs, true);
        var img = document.createElement('img');
        img.src = item.src; img.alt = item.title || '';
        img.loading = 'lazy';
        node.appendChild(img);
      } else if (kind === 'video') {
        node.classList.add('vc-video');
        node.style.cssText += this._sizeStyle(embed.attrs, true);
        if (item.poster) {
          var pimg = document.createElement('img');
          pimg.src = item.poster; pimg.alt = item.title || ''; pimg.loading = 'lazy';
          node.appendChild(pimg);
        } else {
          node.classList.remove('vc-video');
          return this._card(node, '🎬', item, embed);
        }
        var play = document.createElement('span'); play.className = 'vc-play'; play.textContent = '▶';
        node.appendChild(play);
      } else {
        var icon = kind === 'audio' ? '🎵' : (kind === 'pdf' ? '📕' : '📄');
        return this._card(node, icon, item, embed);
      }

      node.addEventListener('click', function () { self._openGallery(embed.galleryIndex, item); });
      return node;
    }

    _card(node, icon, item, embed) {
      var self = this;
      node.classList.add('vc-card');
      node.style.cssText = 'font:inherit;color:inherit;';
      var ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = icon;
      var nm = document.createElement('span'); nm.className = 'nm';
      nm.textContent = item.title || baseName(item.src) || 'File';
      node.append(ic, nm);
      node.addEventListener('click', function () { self._openGallery(embed.galleryIndex, item); });
      return node;
    }
  }

  // local kind guessers (the viewer owns the authoritative detection; these only
  // choose a preview shape)
  var EXT_KIND = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', bmp: 'image',
    svg: 'image', avif: 'image', ico: 'image',
    mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', mkv: 'video', ogv: 'video',
    mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio',
    pdf: 'pdf',
  };
  function baseName(src) {
    try { return decodeURIComponent(String(src).split(/[?#]/)[0].split('/').pop() || ''); }
    catch (_) { return String(src).split(/[?#]/)[0].split('/').pop() || ''; }
  }
  function guessKind(item) {
    var mime = String(item.mime || '').toLowerCase();
    if (!mime) { var m = /^data:([^;,]+)[;,]/.exec(String(item.src || '')); if (m) mime = m[1].toLowerCase(); }
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'pdf';
    var b = baseName(item.src); var dot = b.lastIndexOf('.');
    return EXT_KIND[dot >= 0 ? b.slice(dot + 1).toLowerCase() : ''] || 'file';
  }

  Vc.define('vc-markdown', VcMarkdown);
})();
