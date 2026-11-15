// A small DOM for running browser modules in node:vm: elements, text, an
// HTML parser for innerHTML, a selector engine (tag, #id, .class, [attr],
// [attr="v"], :scope, :not(), descendant and child combinators, lists),
// events with capture and bubble, and hand-driven timers, frames and
// observers so a test decides when they run. Not a browser: no layout
// (sizes are plain numbers a test may set), no style cascade.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×', mdash: '—', ndash: '–', hellip: '…', middot: '·', rarr: '→', larr: '←', uarr: '↑', darr: '↓', copy: '©', bull: '•' };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] ?? m;
});
const escText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function createDom() {
  let connectedRoot = null;   // the document
  const counters = { getElementById: [] };

  class Event {
    constructor(type, init = {}) {
      this.type = type; this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable;
      this.defaultPrevented = false; this._stop = false; this._stopNow = false;
      this.target = null; this.currentTarget = null; this.detail = init.detail;
      Object.assign(this, init);
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this._stop = true; }
    stopImmediatePropagation() { this._stop = true; this._stopNow = true; }
  }

  class EventTargetish {
    addEventListener(type, fn, opts) {
      if (!fn) return;
      const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
      (this._ls ||= []).push({ type, fn, capture, once: !!opts?.once });
    }
    removeEventListener(type, fn, opts) {
      const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
      if (this._ls) this._ls = this._ls.filter(l => !(l.type === type && l.fn === fn && l.capture === capture));
    }
    _fire(ev, phase) {
      for (const l of [...(this._ls || [])]) {
        if (l.type !== ev.type) continue;
        if (phase === 'capture' && !l.capture) continue;
        if (phase === 'bubble' && l.capture) continue;
        if (l.once) this.removeEventListener(l.type, l.fn, l.capture);
        ev.currentTarget = this;
        typeof l.fn === 'function' ? l.fn.call(this, ev) : l.fn.handleEvent(ev);
        if (ev._stopNow) return;
      }
    }
    dispatchEvent(ev) {
      ev.target = this;
      const path = [];
      for (let n = this.parentNode; n; n = n.parentNode) path.push(n);
      if (this.nodeType === 9 || path[path.length - 1]?.nodeType === 9) path.push(win);
      for (let k = path.length - 1; k >= 0 && !ev._stop; k--) path[k]._fire(ev, 'capture');
      if (!ev._stop) this._fire(ev, 'target');
      if (ev.bubbles) for (const n of path) { if (ev._stop) break; n._fire(ev, 'bubble'); }
      return !ev.defaultPrevented;
    }
  }

  class Node extends EventTargetish {
    constructor(type) { super(); this.nodeType = type; this.parentNode = null; this.childNodes = []; }
    get ownerDocument() { return doc; }
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
    get previousSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) - 1] || null : null; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === connectedRoot; }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { this._clear(); if (v != null && v !== '') this.appendChild(new Text(String(v))); }
    _clear() { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; }
    _adopt(nodes) {
      const out = [];
      for (const n of nodes) {
        if (n == null) continue;
        if (typeof n === 'string') { out.push(new Text(n)); continue; }
        if (n.nodeType === 11) { out.push(...n.childNodes); n.childNodes = []; continue; }
        out.push(n);
      }
      for (const n of out) if (n.parentNode) n.parentNode.removeChild(n);
      return out;
    }
    insertBefore(node, ref) {
      if (ref && ref.parentNode !== this) throw new Error('insertBefore: ref is not a child');
      const nodes = this._adopt([node]);
      const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
      this.childNodes.splice(at, 0, ...nodes);
      for (const n of nodes) n.parentNode = this;
      return node;
    }
    appendChild(node) { return this.insertBefore(node, null); }
    removeChild(node) {
      const at = this.childNodes.indexOf(node);
      if (at < 0) throw new Error('removeChild: not a child');
      this.childNodes.splice(at, 1);
      node.parentNode = null;
      return node;
    }
    replaceChild(node, old) { this.insertBefore(node, old); return this.removeChild(old); }
    append(...nodes) { for (const n of this._adopt(nodes)) this.insertBefore(n, null); }
    prepend(...nodes) { const first = this.firstChild; for (const n of this._adopt(nodes)) this.insertBefore(n, first); }
    before(...nodes) { const p = this.parentNode; if (!p) return; for (const n of this._adopt(nodes)) p.insertBefore(n, this); }
    after(...nodes) {
      const p = this.parentNode; if (!p) return;
      const nodesA = this._adopt(nodes.filter(n => n !== this));
      let ref = this.nextSibling;
      for (const n of nodesA) { p.insertBefore(n, ref); }
    }
    replaceWith(...nodes) { const p = this.parentNode; if (!p) return; this.before(...nodes); if (this.parentNode) p.removeChild(this); }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
    hasChildNodes() { return this.childNodes.length > 0; }
    get children() { return this.childNodes.filter(c => c.nodeType === 1); }
    get childElementCount() { return this.children.length; }
    get firstElementChild() { return this.children[0] || null; }
    get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
    querySelector(sel) { return query(this, sel, true)[0] || null; }
    querySelectorAll(sel) { return query(this, sel, false); }
    getElementsByClassName(c) { return query(this, '.' + c.trim().split(/\s+/).join('.'), false); }
    getElementsByTagName(t) { return query(this, t, false); }
  }

  class Text extends Node {
    constructor(data) { super(3); this.data = data; }
    get nodeName() { return '#text'; }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
    get nodeValue() { return this.data; }
    set nodeValue(v) { this.data = String(v); }
    cloneNode() { return new Text(this.data); }
  }
  class Comment extends Node {
    constructor(data) { super(8); this.data = data; }
    get nodeName() { return '#comment'; }
    get textContent() { return ''; }
    cloneNode() { return new Comment(this.data); }
  }
  class Fragment extends Node {
    constructor() { super(11); }
    cloneNode(deep) { const f = new Fragment(); if (deep) for (const c of this.childNodes) f.appendChild(c.cloneNode(true)); return f; }
  }

  function styleObject(el) {
    const s = {};
    Object.defineProperties(s, {
      setProperty: { value: (k, v) => { s[k] = String(v); } },
      removeProperty: { value: k => { delete s[k]; } },
      getPropertyValue: { value: k => s[k] ?? '' },
      cssText: {
        get: () => Object.keys(s).map(k => `${k}: ${s[k]}`).join('; '),
        set: v => { for (const k of Object.keys(s)) delete s[k]; for (const d of String(v).split(';')) { const at = d.indexOf(':'); if (at > 0) s[d.slice(0, at).trim()] = d.slice(at + 1).trim(); } },
      },
    });
    return s;
  }

  const camelToData = k => 'data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
  const dataToCamel = k => k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase());

  class Element extends Node {
    constructor(tag, ns) {
      super(1);
      this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
      this.localName = ns && ns !== 'http://www.w3.org/1999/xhtml' ? tag : tag.toLowerCase();
      this._attrs = new Map();
      this.style = styleObject(this);
      this.scrollTop = 0; this.scrollLeft = 0;
      this.scrollHeight = 0; this.clientHeight = 0; this.clientWidth = 0;
      this.offsetHeight = 0; this.offsetWidth = 0; this.offsetTop = 0; this.offsetLeft = 0;
    }
    get tagName() { return this.namespaceURI === 'http://www.w3.org/1999/xhtml' ? this.localName.toUpperCase() : this.localName; }
    get nodeName() { return this.tagName; }
    getAttribute(k) { k = String(k).toLowerCase(); return this._attrs.has(k) ? this._attrs.get(k) : null; }
    setAttribute(k, v) { this._attrs.set(String(k).toLowerCase(), String(v)); }
    removeAttribute(k) { this._attrs.delete(String(k).toLowerCase()); }
    hasAttribute(k) { return this._attrs.has(String(k).toLowerCase()); }
    toggleAttribute(k, force) {
      const on = force === undefined ? !this.hasAttribute(k) : !!force;
      if (on) this.setAttribute(k, ''); else this.removeAttribute(k);
      return on;
    }
    get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
    get classList() {
      const el = this;
      const list = () => el.className.split(/\s+/).filter(Boolean);
      const set = a => el.setAttribute('class', [...new Set(a)].join(' '));
      return {
        add: (...c) => set([...list(), ...c]),
        remove: (...c) => set(list().filter(x => !c.includes(x))),
        contains: c => list().includes(c),
        toggle: (c, force) => {
          const has = list().includes(c);
          const on = force === undefined ? !has : !!force;
          if (on && !has) set([...list(), c]); else if (!on && has) set(list().filter(x => x !== c));
          return on;
        },
        replace: (a, b) => { if (!list().includes(a)) return false; set(list().map(x => x === a ? b : x)); return true; },
        get length() { return list().length; },
        [Symbol.iterator]: () => list()[Symbol.iterator](),
      };
    }
    get dataset() {
      const el = this;
      return new Proxy({}, {
        get: (t, k) => typeof k === 'string' ? el.getAttribute(camelToData(k)) ?? undefined : undefined,
        set: (t, k, v) => { el.setAttribute(camelToData(k), v); return true; },
        deleteProperty: (t, k) => { el.removeAttribute(camelToData(k)); return true; },
        has: (t, k) => el.hasAttribute(camelToData(k)),
        ownKeys: () => [...el._attrs.keys()].filter(k => k.startsWith('data-')).map(dataToCamel),
        getOwnPropertyDescriptor: (t, k) => el.hasAttribute(camelToData(k))
          ? { value: el.getAttribute(camelToData(k)), enumerable: true, configurable: true } : undefined,
      });
    }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(v) { this.toggleAttribute('hidden', !!v); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { this.toggleAttribute('disabled', !!v); }
    get open() { return this.hasAttribute('open'); }
    set open(v) { this.toggleAttribute('open', !!v); }
    get checked() { return this.hasAttribute('checked'); }
    set checked(v) { this.toggleAttribute('checked', !!v); }
    get title() { return this.getAttribute('title') || ''; }
    set title(v) { this.setAttribute('title', v); }
    get href() { return this.getAttribute('href') || ''; }
    set href(v) { this.setAttribute('href', v); }
    get src() { return this.getAttribute('src') || ''; }
    set src(v) { this.setAttribute('src', v); }
    get type() { return this.getAttribute('type') || ''; }
    set type(v) { this.setAttribute('type', v); }
    get value() { return this._value ?? this.getAttribute('value') ?? ''; }
    set value(v) { this._value = String(v); }
    get tabIndex() { return Number(this.getAttribute('tabindex') ?? -1); }
    set tabIndex(v) { this.setAttribute('tabindex', v); }
    get innerHTML() { return this.childNodes.map(serialize).join(''); }
    set innerHTML(html) { this._clear(); for (const n of parse(String(html ?? ''), this)) this.appendChild(n); }
    get outerHTML() { return serialize(this); }
    get innerText() { return this.textContent; }
    set innerText(v) { this.textContent = v; }
    insertAdjacentHTML(pos, html) {
      const nodes = parse(String(html), this);
      if (pos === 'beforeend') this.append(...nodes);
      else if (pos === 'afterbegin') this.prepend(...nodes);
      else if (pos === 'beforebegin') this.before(...nodes);
      else if (pos === 'afterend') this.after(...nodes);
    }
    insertAdjacentElement(pos, el) { this.insertAdjacentHTML(pos, ''); if (pos === 'beforeend') this.append(el); else if (pos === 'afterbegin') this.prepend(el); else if (pos === 'beforebegin') this.before(el); else this.after(el); return el; }
    cloneNode(deep) {
      const c = new Element(this.localName, this.namespaceURI);
      for (const [k, v] of this._attrs) c._attrs.set(k, v);
      Object.assign(c.style, this.style);
      if (deep) for (const n of this.childNodes) c.appendChild(n.cloneNode(true));
      return c;
    }
    matches(sel) { return matchesList(this, parseSelector(sel), null); }
    closest(sel) {
      const list = parseSelector(sel);
      for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matchesList(n, list, null)) return n;
      return null;
    }
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; }
    getClientRects() { return []; }
    scrollIntoView() {}
    scrollTo(x, y) { if (typeof x === 'object') { this.scrollTop = x.top ?? this.scrollTop; } else this.scrollTop = y ?? this.scrollTop; }
    scrollBy() {}
    focus() { doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = doc.body; }
    click() { this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
    setPointerCapture() {}
    releasePointerCapture() {}
    animate() { return { finished: Promise.resolve(), cancel() {}, onfinish: null }; }
    getContext() { return null; }
    play() { return Promise.resolve(); }
    pause() {}
  }

  function serialize(n) {
    if (n.nodeType === 3) return escText(n.data);
    if (n.nodeType === 8) return `<!--${n.data}-->`;
    if (n.nodeType === 11) return n.childNodes.map(serialize).join('');
    const attrs = [...n._attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
    if (VOID.has(n.localName)) return `<${n.localName}${attrs}>`;
    return `<${n.localName}${attrs}>${n.childNodes.map(serialize).join('')}</${n.localName}>`;
  }

  // --- HTML parser: enough for the markup the dashboard writes ---
  function parse(html, context) {
    const root = new Fragment();
    const stack = [root];
    const svgNs = 'http://www.w3.org/2000/svg';
    const nsOf = () => {
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].namespaceURI === svgNs) return svgNs;
      return context?.namespaceURI === svgNs ? svgNs : null;
    };
    let i = 0;
    const top = () => stack[stack.length - 1];
    while (i < html.length) {
      const lt = html.indexOf('<', i);
      if (lt < 0) { top().appendChild(new Text(decode(html.slice(i)))); break; }
      if (lt > i) top().appendChild(new Text(decode(html.slice(i, lt))));
      if (html.startsWith('<!--', lt)) {
        const end = html.indexOf('-->', lt + 4);
        top().appendChild(new Comment(html.slice(lt + 4, end < 0 ? html.length : end)));
        i = end < 0 ? html.length : end + 3;
        continue;
      }
      if (html[lt + 1] === '!' || html[lt + 1] === '?') { const end = html.indexOf('>', lt); i = end < 0 ? html.length : end + 1; continue; }
      if (html[lt + 1] === '/') {
        const end = html.indexOf('>', lt);
        const name = html.slice(lt + 2, end).trim().toLowerCase();
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k].localName.toLowerCase() === name) { stack.length = k; break; }
        }
        i = end < 0 ? html.length : end + 1;
        continue;
      }
      if (!/[a-zA-Z]/.test(html[lt + 1] || '')) { top().appendChild(new Text('<')); i = lt + 1; continue; }
      // Start tag.
      let j = lt + 1;
      while (j < html.length && /[^\s/>]/.test(html[j])) j++;
      const rawName = html.slice(lt + 1, j);
      const ns = rawName.toLowerCase() === 'svg' ? svgNs : nsOf();
      const el = new Element(ns ? rawName : rawName.toLowerCase(), ns);
      let selfClose = false;
      while (j < html.length) {
        while (/\s/.test(html[j])) j++;
        if (html[j] === '>') { j++; break; }
        if (html[j] === '/' && html[j + 1] === '>') { selfClose = true; j += 2; break; }
        if (html[j] === '/') { j++; continue; }
        let k = j;
        while (k < html.length && /[^\s=/>]/.test(html[k])) k++;
        const name = html.slice(j, k);
        j = k;
        while (/\s/.test(html[j])) j++;
        let value = '';
        if (html[j] === '=') {
          j++;
          while (/\s/.test(html[j])) j++;
          const q = html[j];
          if (q === '"' || q === "'") {
            const end = html.indexOf(q, j + 1);
            value = html.slice(j + 1, end);
            j = end + 1;
          } else {
            let e = j;
            while (e < html.length && /[^\s>]/.test(html[e])) e++;
            value = html.slice(j, e);
            j = e;
          }
        }
        if (name) el.setAttribute(name, decode(value));
      }
      top().appendChild(el);
      const lname = el.localName.toLowerCase();
      if (RAW.has(lname) && !selfClose) {
        const close = html.toLowerCase().indexOf(`</${lname}`, j);
        const end = close < 0 ? html.length : close;
        const text = html.slice(j, end);
        if (text) el.appendChild(new Text(lname === 'textarea' || lname === 'title' ? decode(text) : text));
        const gt = html.indexOf('>', end);
        i = close < 0 ? html.length : gt + 1;
        continue;
      }
      if (!selfClose && !(VOID.has(lname) && !ns)) stack.push(el);
      i = j;
    }
    const out = [...root.childNodes];
    for (const n of out) n.parentNode = null;
    return out;
  }

  // --- Selectors ---
  const selCache = new Map();
  function unescape(s) {
    return s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (m, hex, ch) => hex ? String.fromCodePoint(parseInt(hex, 16)) : ch);
  }
  function splitTop(s, sep) {
    const out = []; let depth = 0, q = null, start = 0;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      if (c === '\\') { k++; continue; }
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === sep && depth === 0) { out.push(s.slice(start, k)); start = k + 1; }
    }
    out.push(s.slice(start));
    return out;
  }
  function parseCompound(s) {
    const c = { tag: null, ids: [], classes: [], attrs: [], pseudos: [] };
    let k = 0;
    const ident = () => { let e = k; while (e < s.length && (/[\w\- -￿]/.test(s[e]) || s[e] === '\\')) { if (s[e] === '\\') e++; e++; } const r = unescape(s.slice(k, e)); k = e; return r; };
    if (s[k] === '*') k++;
    else if (/[a-zA-Z]/.test(s[k] || '')) c.tag = ident().toLowerCase();
    while (k < s.length) {
      const ch = s[k];
      if (ch === '#') { k++; c.ids.push(ident()); }
      else if (ch === '.') { k++; c.classes.push(ident()); }
      else if (ch === '[') {
        let depth = 0, e = k, q = null;
        for (; e < s.length; e++) {
          if (s[e] === '\\') { e++; continue; }
          if (q) { if (s[e] === q) q = null; continue; }
          if (s[e] === '"' || s[e] === "'") q = s[e];
          else if (s[e] === '[') depth++;
          else if (s[e] === ']' && --depth === 0) break;
        }
        const body = s.slice(k + 1, e);
        k = e + 1;
        const m = body.match(/^\s*([^\s~|^$*!=]+)\s*(?:([~|^$*]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]]+)))?\s*$/);
        if (!m) throw new Error('bad attribute selector: ' + body);
        c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value: m[2] ? unescape(m[3] ?? m[4] ?? m[5] ?? '') : null });
      } else if (ch === ':') {
        k++;
        const name = ident().toLowerCase();
        let arg = null;
        if (s[k] === '(') {
          let depth = 0, e = k;
          for (; e < s.length; e++) { if (s[e] === '(') depth++; else if (s[e] === ')' && --depth === 0) break; }
          arg = s.slice(k + 1, e);
          k = e + 1;
        }
        c.pseudos.push({ name, arg: name === 'not' ? parseSelector(arg) : arg });
      } else throw new Error(`unsupported selector "${s}" at ${k}`);
    }
    return c;
  }
  function parseComplex(s) {
    // [{ comb, compound }] left to right; comb joins it to the previous one.
    const parts = [];
    let k = 0, comb = null, buf = '', q = null, depth = 0;
    const flush = () => { if (buf.trim()) { parts.push({ comb, compound: parseCompound(buf.trim()) }); comb = null; } buf = ''; };
    for (; k < s.length; k++) {
      const ch = s[k];
      if (ch === '\\') { buf += ch + s[++k]; continue; }
      if (q) { buf += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; buf += ch; continue; }
      if (ch === '[' || ch === '(') depth++;
      if (ch === ']' || ch === ')') depth--;
      if (depth === 0 && (ch === '>' || ch === '+' || ch === '~')) { flush(); comb = ch; continue; }
      if (depth === 0 && /\s/.test(ch)) { if (buf.trim()) { flush(); comb = comb || ' '; } continue; }
      buf += ch;
    }
    flush();
    return parts;
  }
  function parseSelector(sel) {
    let r = selCache.get(sel);
    if (!r) { r = splitTop(sel, ',').map(x => parseComplex(x.trim())); selCache.set(sel, r); }
    return r;
  }
  function matchCompound(el, c, scope) {
    if (el.nodeType !== 1) return false;
    if (c.tag && el.localName.toLowerCase() !== c.tag) return false;
    for (const id of c.ids) if (el.getAttribute('id') !== id) return false;
    if (c.classes.length) {
      const cls = el.className.split(/\s+/);
      for (const x of c.classes) if (!cls.includes(x)) return false;
    }
    for (const a of c.attrs) {
      const v = el.getAttribute(a.name);
      if (v == null) return false;
      if (a.op === '=' && v !== a.value) return false;
      if (a.op === '^=' && !v.startsWith(a.value)) return false;
      if (a.op === '$=' && !v.endsWith(a.value)) return false;
      if (a.op === '*=' && !v.includes(a.value)) return false;
      if (a.op === '~=' && !v.split(/\s+/).includes(a.value)) return false;
    }
    for (const p of c.pseudos) {
      if (p.name === 'scope') { if (el !== scope) return false; }
      else if (p.name === 'not') { if (matchesList(el, p.arg, scope)) return false; }
      else if (p.name === 'first-child') { if (el.parentNode?.firstElementChild !== el) return false; }
      else if (p.name === 'last-child') { if (el.parentNode?.lastElementChild !== el) return false; }
      else if (p.name === 'checked') { if (!el.hasAttribute('checked')) return false; }
      else if (p.name === 'hover' || p.name === 'focus' || p.name === 'focus-within' || p.name === 'focus-visible') return false;
      else throw new Error('unsupported pseudo-class :' + p.name);
    }
    return true;
  }
  function matchParts(el, parts, idx, scope) {
    if (!matchCompound(el, parts[idx].compound, scope)) return false;
    if (idx === 0) return true;
    const comb = parts[idx].comb;
    if (comb === '>') return !!el.parentNode && el.parentNode.nodeType === 1 && matchParts(el.parentNode, parts, idx - 1, scope);
    if (comb === '+') { const p = el.previousElementSibling; return !!p && matchParts(p, parts, idx - 1, scope); }
    if (comb === '~') { for (let p = el.previousElementSibling; p; p = p.previousElementSibling) if (matchParts(p, parts, idx - 1, scope)) return true; return false; }
    for (let p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (matchParts(p, parts, idx - 1, scope)) return true;
    return false;
  }
  function matchesList(el, list, scope) { return list.some(parts => matchParts(el, parts, parts.length - 1, scope)); }
  function query(root, sel, first) {
    const list = parseSelector(sel);
    const scope = root.nodeType === 1 ? root : null;
    const out = [];
    const walk = n => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (matchesList(c, list, scope)) { out.push(c); if (first) return true; }
        if (walk(c)) return true;
      }
      return false;
    };
    walk(root);
    return out;
  }
  Object.defineProperty(Element.prototype, 'nextElementSibling', { get() { const p = this.parentNode; if (!p) return null; const s = p.children; return s[s.indexOf(this) + 1] || null; } });
  Object.defineProperty(Element.prototype, 'previousElementSibling', { get() { const p = this.parentNode; if (!p) return null; const s = p.children; return s[s.indexOf(this) - 1] || null; } });

  class Document extends Node {
    constructor() { super(9); this.hidden = false; this.visibilityState = 'visible'; this.title = ''; this.activeElement = null; }
    createElement(tag) { return new Element(String(tag)); }
    createElementNS(ns, tag) { return new Element(String(tag), ns); }
    createTextNode(t) { return new Text(String(t)); }
    createComment(t) { return new Comment(String(t)); }
    createDocumentFragment() { return new Fragment(); }
    get documentElement() { return this.childNodes.find(c => c.nodeType === 1) || null; }
    get body() { return this.documentElement?.querySelector('body') || null; }
    get head() { return this.documentElement?.querySelector('head') || null; }
    getElementById(id) {
      counters.getElementById.push(id);
      return this.querySelector('#' + cssEscape(id));
    }
    createRange() { return { selectNodeContents() {}, setStart() {}, setEnd() {}, collapse() {}, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }) }; }
    execCommand() { return false; }
  }

  function cssEscape(s) {
    return String(s).replace(/^-?\d/, m => m.replace(/\d/, d => `\\3${d} `)).replace(/[^\w\- -￿]/g, c => '\\' + c);
  }

  // --- Timers, frames and observers, driven by the test ---
  let clock = 0, nextId = 1;
  const timers = new Map();    // id -> { at, fn, every }
  const frames = new Map();    // id -> fn
  function setTimeoutF(fn, ms = 0, ...a) { const id = nextId++; timers.set(id, { at: clock + (Number(ms) || 0), fn: () => fn(...a), every: 0 }); return id; }
  function setIntervalF(fn, ms = 0, ...a) { const id = nextId++; timers.set(id, { at: clock + (Number(ms) || 0), fn: () => fn(...a), every: Math.max(1, Number(ms) || 0) }); return id; }
  function clearTimer(id) { timers.delete(id); }
  function rafF(fn) { const id = nextId++; frames.set(id, fn); return id; }
  function cafF(id) { frames.delete(id); }
  function flushFrames(max = 20) {
    for (let k = 0; k < max && frames.size; k++) {
      const batch = [...frames]; frames.clear();
      for (const [, fn] of batch) fn(clock);
    }
  }
  function advance(ms) {
    const end = clock + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      clock = t.at;
      if (t.every) t.at += t.every; else timers.delete(id);
      t.fn();
    }
    clock = end;
  }

  const observers = [];
  const makeObserver = kind => class {
    constructor(cb, opts) { this.kind = kind; this.cb = cb; this.opts = opts; this.targets = new Set(); this.live = true; observers.push(this); }
    observe(t) { if (t) this.targets.add(t); }
    unobserve(t) { this.targets.delete(t); }
    disconnect() { this.targets.clear(); }
    takeRecords() { return []; }
    trigger(entries = []) { this.cb(entries, this); }
  };

  const store = new Map();
  const localStorage = {
    getItem: k => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
  };

  const doc = new Document();
  connectedRoot = doc;
  const html = new Element('html');
  doc.appendChild(html);
  html.appendChild(new Element('head'));
  html.appendChild(new Element('body'));

  const win = new EventTargetish();
  Object.assign(win, {
    document: doc,
    Event, CustomEvent: Event, KeyboardEvent: Event, MouseEvent: Event,
    Node, Element, HTMLElement: Element, Text,
    setTimeout: setTimeoutF, clearTimeout: clearTimer, setInterval: setIntervalF, clearInterval: clearTimer,
    requestAnimationFrame: rafF, cancelAnimationFrame: cafF,
    ResizeObserver: makeObserver('resize'), IntersectionObserver: makeObserver('intersection'), MutationObserver: makeObserver('mutation'),
    matchMedia: q => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    getSelection: () => ({ isCollapsed: true, rangeCount: 0, anchorNode: null, focusNode: null, toString: () => '', removeAllRanges() {} }),
    getComputedStyle: el => el.style,
    CSS: { escape: cssEscape },
    localStorage, sessionStorage: localStorage,
    navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
    location: { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', pathname: '/', search: '', hash: '' },
    devicePixelRatio: 1, innerWidth: 1400, innerHeight: 900,
    console,
  });
  win.window = win;
  win.self = win;
  win.globalThis = win;

  // Parse a page fragment into the body (or a given parent).
  function mount(htmlText, parent = doc.body) {
    for (const n of parse(htmlText, parent)) parent.appendChild(n);
  }

  return {
    window: win, document: doc, Event, mount, parse,
    flushFrames, advance, observers,
    timers, frames,
    counters,
    activeTimers: () => timers.size,
  };
}

module.exports = { createDom };
