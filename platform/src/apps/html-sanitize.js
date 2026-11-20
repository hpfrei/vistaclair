// The platform's one HTML sanitiser for untrusted mail bodies.
//
// Until this module existed, `html_body` was stored raw and every renderer
// solved the problem again, differently: my-dashboard shipped a DOMParser-based
// sanitiser to the browser, and Vista sidestepped it by converting HTML to text
// server-side and dropping `htmlBody` from the wire entirely. Two solutions, one
// of them a refusal to render, and nothing for the next consumer to reuse —
// which meant the third renderer would have written a third one.
//
// Mail is the platform's canonical untrusted input. Sanitising it belongs next
// to the store, on the read path, so a consumer has to opt OUT to see raw HTML
// rather than opt in to safety.
//
// Parser, not regex. htmlparser2 already shipped as html-to-text's parser (a
// direct dependency used by email-content); htmlparser2, domutils and
// dom-serializer are now declared in package.json themselves, because this
// module requires all three by name and a dependency you rely on directly is
// not something to inherit from another package's tree. If they ever fail to
// load we degrade to text extraction — losing formatting is an acceptable
// failure, emitting unsanitised markup is not.

let _parser;
function getParser() {
  if (_parser === undefined) {
    try {
      _parser = {
        htmlparser2: require('htmlparser2'),
        domutils: require('domutils'),
        render: require('dom-serializer').default || require('dom-serializer'),
      };
    } catch { _parser = null; }
  }
  return _parser;
}

// Elements removed with their entire subtree. `script`/`style` carry code;
// `iframe`/`object`/`embed`/`frame` load third-party content; `base` rewrites
// every relative URL on the page; `form`/`input`/`button` phish; `link`/`meta`
// can pull remote resources and set refresh redirects; `template`/`noscript`
// hide markup from a naive walk while a browser still parses it.
const DROP_TREE = new Set([
  'script', 'style', 'link', 'meta', 'iframe', 'frame', 'frameset', 'object',
  'embed', 'base', 'form', 'input', 'button', 'textarea', 'select', 'option',
  'noscript', 'template', 'applet', 'portal',
]);

// Attributes that are never safe regardless of value. `srcdoc` is an inline
// document on an iframe we already drop, but it also appears on other elements
// in mangled mail and costs nothing to refuse. `formaction`/`action` submit,
// `ping` beacons, and the `dynsrc`/`lowsrc` pair are legacy image loaders.
const DROP_ATTR = new Set([
  'srcdoc', 'action', 'formaction', 'ping', 'dynsrc', 'lowsrc', 'background',
  'http-equiv',
]);

// URL-bearing attributes: their values go through the scheme check.
const URL_ATTRS = new Set(['href', 'src', 'srcset', 'xlink:href', 'cite', 'poster', 'longdesc']);

// Only these schemes may appear in a URL attribute. Everything else — including
// `javascript:`, `vbscript:`, `file:` and `data:` for anything but images — is
// dropped. `cid:` is an inline attachment reference; a browser cannot resolve
// one, so a caller that can serve the bytes passes `resolveCid` below and the
// src is rewritten to its own read path. Without it the reference is left
// untouched and the image renders as its alt text.
const SAFE_SCHEME = /^(https?:|mailto:|tel:|cid:|#|\/|\.\/|\.\.\/)/i;
const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp|x-icon);base64,[a-z0-9+/=\s]+$/i;

// `java\tscript:alert(1)` and `java&#10;script:` are the classic evasions: a
// browser strips whitespace and control characters before resolving the scheme,
// so the check has to see the same string the browser will. Strip C0/C1 and all
// whitespace — and nothing else, so a legitimate path is left intact.
const URL_NOISE = /[\u0000-\u001f\u007f-\u00a0\s]/g;

function schemeOk(value) {
  const v = String(value == null ? '' : value).replace(URL_NOISE, '');
  if (!v) return false;
  if (SAFE_DATA_IMAGE.test(String(value).trim())) return true;
  // No scheme at all is a relative reference, which is fine.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) return true;
  return SAFE_SCHEME.test(v);
}

function isRemote(value) {
  return /^(https?:)?\/\//i.test(String(value == null ? '' : value).trim());
}

// `cid:logo@shop` → `logo@shop`. Mail writes the reference in every spelling the
// spec and the clients allow: percent-encoded, wrapped in the angle brackets the
// Content-ID header carries, padded with whitespace. Normalising here means the
// match against the message's own attachment list is done once, on one shape.
function cidOf(value) {
  let v = String(value == null ? '' : value).trim().replace(/^cid:/i, '');
  try { v = decodeURIComponent(v); } catch { /* a malformed escape is not a reason to drop the ref */ }
  return v.replace(/^</, '').replace(/>$/, '').trim();
}

// Build the `cid` → URL function `renderEmail` hands the sanitiser, from a
// message's own `attachments[]` and the base URL the caller can serve bytes
// from. The URL is built from the ATTACHMENT ID, never from the cid string: a
// crafted `cid:../../secret` either matches a known Content-ID — and then the
// id it resolves to shapes the path — or matches nothing and is left alone.
function cidResolver(attachments, base) {
  const exact = new Map();
  const ci = new Map();
  for (const a of attachments || []) {
    if (!a || a.id == null) continue;
    const cid = String(a.contentId == null ? '' : a.contentId).replace(/^</, '').replace(/>$/, '').trim();
    if (!cid) continue;
    if (!exact.has(cid)) exact.set(cid, String(a.id));
    const lower = cid.toLowerCase();
    if (!ci.has(lower)) ci.set(lower, String(a.id));
  }
  if (!exact.size) return () => null;
  return (cid) => {
    // Content-IDs are case-sensitive per RFC 2392; real mail is not, and a
    // template that writes `cid:Logo` against `Content-ID: <logo>` is common
    // enough that falling back beats showing alt text.
    const id = exact.has(cid) ? exact.get(cid) : ci.get(String(cid).toLowerCase());
    return id == null ? null : `${base}${encodeURIComponent(id)}`;
  };
}

// `style` is kept for layout — mail is unreadable without it — but CSS can
// execute (`expression()`), navigate (`behavior`, `-moz-binding`) and phone
// home (`url()`), so those declarations are removed rather than the attribute.
function cleanStyle(style, { allowImages }) {
  let s = String(style == null ? '' : style);
  let hadImages = false;
  if (/url\s*\(\s*['"]?(https?:)?\/\//i.test(s)) {
    hadImages = true;
    if (!allowImages) s = s.replace(/[a-z-]*\s*:\s*[^;]*url\s*\([^)]*\)[^;]*;?/gi, '');
  }
  s = s
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/(-moz-)?binding\s*:[^;]*;?/gi, '')
    .replace(/behaviou?r\s*:[^;]*;?/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/(javascript|vbscript)\s*:/gi, '');
  // Fixed positioning escapes the message frame and can cover the app's own UI.
  s = s.replace(/position\s*:\s*fixed/gi, 'position:static');
  return { style: s.trim(), hadImages };
}

// Sanitise an email HTML body.
//
// Returns `{ html, hadImages }` — `hadImages` says the message referenced remote
// images that were blocked, which is what lets a renderer offer "show images"
// without re-parsing the document itself.
//
// `resolveCid(cid)` (optional) turns an inline `cid:` reference into a URL the
// caller can serve; returning null leaves the reference as it is. When any cid
// was seen the result also carries `inlineImages` (rewritten) and/or
// `unresolvedInlineImages` (left as-is) — a count is omitted when it is zero, so
// a document without inline images returns exactly what it always did.
function sanitizeEmailHtml(raw, { allowImages = false, resolveCid = null } = {}) {
  const input = String(raw == null ? '' : raw);
  if (!input.trim()) return { html: '', hadImages: false };

  const P = getParser();
  if (!P) {
    // Degrade to text. Never return markup we did not parse.
    const text = require('./email-content').htmlToMarkdownish(input);
    return { html: escapeHtml(text).replace(/\n/g, '<br>'), hadImages: false, degraded: true };
  }

  let hadImages = false;
  let inlineImages = 0;
  let unresolvedInlineImages = 0;
  const dom = P.htmlparser2.parseDocument(input, { decodeEntities: true });

  const walk = (node) => {
    const children = node.children ? [...node.children] : [];
    for (const child of children) {
      // htmlparser2 types script/style content nodes distinctly from 'tag'.
      if (child.type === 'script' || child.type === 'style') { P.domutils.removeElement(child); continue; }
      if (child.type === 'directive' || child.type === 'comment') { P.domutils.removeElement(child); continue; }
      if (child.type !== 'tag') continue;

      const tag = String(child.name || '').toLowerCase();
      if (DROP_TREE.has(tag)) { P.domutils.removeElement(child); continue; }

      const attribs = child.attribs || {};
      for (const name of Object.keys(attribs)) {
        const lower = name.toLowerCase();
        const value = attribs[name];
        // Event handlers, in every spelling.
        if (lower.startsWith('on')) { delete attribs[name]; continue; }
        if (DROP_ATTR.has(lower)) { delete attribs[name]; continue; }
        if (lower === 'style') {
          const r = cleanStyle(value, { allowImages });
          hadImages = hadImages || r.hadImages;
          if (r.style) attribs[name] = r.style; else delete attribs[name];
          continue;
        }
        if (URL_ATTRS.has(lower)) {
          if (!schemeOk(value)) { delete attribs[name]; continue; }
          // Inline attachment: rewrite to the caller's own read path when it
          // resolves, count it either way so a renderer can say what is missing
          // rather than leaving the user with unexplained alt text.
          if (lower === 'src' && /^\s*cid:/i.test(String(value))) {
            const url = resolveCid ? resolveCid(cidOf(value)) : null;
            // The resolved URL goes through the same scheme check as anything
            // else in the document: a base the caller got wrong may not become
            // the one src that skipped it.
            if (url && schemeOk(url)) { attribs[name] = url; inlineImages++; } else unresolvedInlineImages++;
            continue;
          }
          if ((lower === 'src' || lower === 'srcset') && isRemote(value)) {
            hadImages = true;
            if (!allowImages) {
              delete attribs[name];
              if (tag === 'img') {
                attribs.alt = attribs.alt || '[image]';
                attribs.class = `${attribs.class ? `${attribs.class} ` : ''}email-img-blocked`;
              }
            }
          }
        }
      }

      // Links leave the app: never same-tab (the dashboard would navigate away)
      // and never with an exploitable opener handle.
      if (tag === 'a' && attribs.href) {
        attribs.target = '_blank';
        attribs.rel = 'noopener noreferrer';
      }
      walk(child);
    }
  };
  walk(dom);

  // Serialise the body if the document has one; a fragment has no html/body
  // wrapper and renders whole.
  const body = P.domutils.findOne((el) => el.name === 'body', dom.children, true);
  const out = P.render(body ? body.children : dom.children, { decodeEntities: true });
  return {
    html: out, hadImages,
    ...(inlineImages ? { inlineImages } : {}),
    ...(unresolvedInlineImages ? { unresolvedInlineImages } : {}),
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The render modes the engine read path exposes.
//   'sanitized' (default) — htmlBody cleaned, safe to inject
//   'text'                — htmlBody dropped, body carries the extracted text
//   'raw'                 — untouched; explicit opt-in, for a caller that will
//                           sanitise itself or is not rendering at all
const HTML_MODES = ['sanitized', 'text', 'raw'];

// Apply a render mode to one email row, so a consumer never has to.
//
// `inlineImageBase` (optional) is the URL prefix the caller serves attachment
// bytes from; given one, every `cid:` src that matches an `attachments[].
// contentId` on THIS row becomes `<base><attachment id>`. Omitted, the row is
// byte-for-byte what it has always been.
function renderEmail(email, mode = 'sanitized', { allowImages = false, inlineImageBase = null } = {}) {
  if (!email) return email;
  if (!HTML_MODES.includes(mode)) throw new Error(`unknown html mode "${mode}"`);
  if (mode === 'raw') return email;
  if (mode === 'text') {
    const body = require('./email-content').bestEmailBody(email);
    return { ...email, body, htmlBody: undefined };
  }
  if (!email.htmlBody) return email;
  const resolveCid = inlineImageBase ? cidResolver(email.attachments, inlineImageBase) : null;
  const { html, hadImages, inlineImages, unresolvedInlineImages } =
    sanitizeEmailHtml(email.htmlBody, { allowImages, resolveCid });
  return {
    ...email,
    htmlBody: html,
    htmlBlockedImages: hadImages && !allowImages ? true : undefined,
    // Both counts are absent when zero: a message without inline images keeps
    // the shape every current caller reads.
    ...(inlineImages ? { htmlInlineImages: inlineImages } : {}),
    ...(unresolvedInlineImages ? { htmlInlineImagesUnresolved: unresolvedInlineImages } : {}),
  };
}

module.exports = { sanitizeEmailHtml, renderEmail, HTML_MODES, escapeHtml };
