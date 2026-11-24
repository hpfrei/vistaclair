// Just enough DOM for the tab strip, TabHost and the Desks controller tests
// (test/tab-host.test.js, test/desks-controller.test.js; kept apart from
// other workers' fake DOMs): elements with
// children, classes, dataset, style, listeners and a selector subset
// (.class, tag, [data-x], .class[data-x], #id). No jsdom.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Like the browser's NodeList: indexable, iterable, forEach, but no array
// methods (find, filter, map...). Code that needs them must use Array.from.
function nodeList(items) {
  const l = { length: items.length, item: (i) => items[i] || null, forEach: (fn, th) => items.forEach(fn, th), [Symbol.iterator]: () => items[Symbol.iterator]() };
  items.forEach((n, i) => { l[i] = n; });
  return l;
}

function makeDom() {
  let constructed = 0;
  class ClassList {
    constructor(el) { this.el = el; }
    get list() { return this.el.className.split(/\s+/).filter(Boolean); }
    add(...cs) { const l = this.list; for (const c of cs) if (!l.includes(c)) l.push(c); this.el.className = l.join(' '); }
    remove(...cs) { this.el.className = this.list.filter(c => !cs.includes(c)).join(' '); }
    contains(c) { return this.list.includes(c); }
    toggle(c, on) { const has = this.contains(c); const want = on === undefined ? !has : !!on; if (want) this.add(c); else this.remove(c); return want; }
  }
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  function matches(el, sel) {
    const m = /^([a-z]+)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)(?:#([\w-]+))?$/i.exec(sel.trim());
    if (!m) throw new Error('fake-dom: unsupported selector ' + sel);
    const [, tag, classes, attrs, id] = m;
    if (tag && el.tagName !== tag.toUpperCase()) return false;
    if (id && el.id !== id) return false;
    for (const c of classes.split('.').filter(Boolean)) if (!el.classList.contains(c)) return false;
    for (const a of attrs.match(/\[[^\]]+\]/g) || []) {
      const [, name, val] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a);
      const v = name.startsWith('data-') ? el.dataset[camel(name.slice(5))] : el.attrs[name];
      if (v === undefined || v === null) return false;
      if (val !== undefined && String(v) !== val) return false;
    }
    return true;
  }
  class El {
    constructor(tag) {
      constructed++;
      this.tagName = String(tag).toUpperCase();
      this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {};
      this.className = ''; this.id = ''; this.dataset = {}; this.style = {}; this.title = ''; this._text = '';
      this.classList = new ClassList(this);
      this.offsetWidth = 100; this.offsetHeight = 50; this.value = '';
    }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v); }
    set innerHTML(v) { this.textContent = ''; this._html = v; }
    get innerHTML() { return this._html || ''; }
    get parentElement() { return this.parentNode; }
    get firstChild() { return this.children[0] || null; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc.body; }
    get offsetParent() { let n = this; while (n) { if (n.style.display === 'none') return null; n = n.parentNode; } return this.isConnected ? doc.body : null; }
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
    removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter(f => f !== fn); }
    dispatch(t, ev = {}) { ev.target ||= this; ev.stopPropagation ||= () => {}; ev.preventDefault ||= () => {}; for (const fn of (this.listeners[t] || []).slice()) fn(ev); return ev; }
    click() { return this.dispatch('click'); }
    appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
    append(...cs) { cs.forEach(c => this.appendChild(c)); }
    insertBefore(c, ref) {
      if (!ref) return this.appendChild(c);
      if (c.parentNode) c.remove();
      const i = this.children.indexOf(ref);
      c.parentNode = this;
      this.children.splice(i < 0 ? this.children.length : i, 0, c);
      return c;
    }
    remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(c => c !== this); this.parentNode = null; } }
    replaceChildren(...cs) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = ''; cs.forEach(c => this.appendChild(c)); }
    contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    focus() { doc.activeElement = this; }
    getBoundingClientRect() { return { left: 0, top: 0, right: this.offsetWidth, bottom: this.offsetHeight, width: this.offsetWidth, height: this.offsetHeight }; }
    querySelectorAll(sel) {
      const out = [];
      const sels = sel.split(',');
      const walk = (n) => { for (const c of n.children) { if (sels.some(s => matches(c, s))) out.push(c); walk(c); } };
      walk(this);
      return doc.strictNodeLists ? nodeList(out) : out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) { let n = this; while (n) { if (n.tagName && matches(n, sel)) return n; n = n.parentNode; } return null; }
  }
  const docListeners = {};
  const doc = {
    body: null,
    activeElement: null,
    createElement: (tag) => new El(tag),
    getElementById: null,
    addEventListener: (t, fn) => { (docListeners[t] ||= []).push(fn); },
    removeEventListener: (t, fn) => { docListeners[t] = (docListeners[t] || []).filter(f => f !== fn); },
    querySelectorAll: (s) => doc.body.querySelectorAll(s),
    querySelector: (s) => doc.body.querySelector(s),
    visibilityState: 'visible',
    _listeners: docListeners,
  };
  function findId(n, id) { for (const c of n.children) { if (c.id === id) return c; const d = findId(c, id); if (d) return d; } return null; }
  doc.getElementById = (id) => findId(doc.body, id);
  doc.body = new El('body');
  return { El, doc, constructed: () => constructed };
}

// Runs public/<files> in one vm context with a fake window/document.
// Returns the window.
function loadPublic(files, { doc, window: extra = {}, timers = true, globals = {} } = {}) {
  const window = {
    innerWidth: 1600, innerHeight: 900,
    addEventListener() {}, removeEventListener() {},
    localStorage: { _m: {}, getItem(k) { return this._m[k] ?? null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } },
    ...extra,
  };
  const ctx = {
    window, document: doc, console,
    setTimeout: timers ? setTimeout : () => 0, clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
    ...globals,
  };
  ctx.globalThis = ctx;
  window.document = doc;
  vm.createContext(ctx);
  // Scripts see `window` both as window and as their global object.
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  }
  return { window, ctx };
}

module.exports = { makeDom, loadPublic };
