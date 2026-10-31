// Renderer safety (public/render-safe.js, core.js, sdk-panel.js): text a
// session prints may be hostile HTML, so every markdown render goes through
// DOMPurify and the DOM-free renderSafe.cleanHtml, escHtml output holds in any
// quoted attribute, a remote ask's preview keeps only inline markup, and a
// user turn loads only its own images. No DOM package is installed, so the
// page code runs in a vm with marked and DOMPurify stubbed as worst cases:
// marked passes raw HTML through and DOMPurify returns it unchanged.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const renderSafe = require('../public/render-safe.js');
const askSafe = require('../public/ask-safe.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');
const core = read('core.js');
const panel = read('sdk-panel.js');
const fnSrc = (src, head) => {
  const m = src.match(new RegExp(`function ${head}[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${head} found`);
  return m[0];
};

const PAYLOADS = [
  '<img src=x onerror="alert(1)">',
  '<script>alert(1)</script>',
  '[click](javascript:alert(1)) <a href="javascript:alert(1)">x</a> <a href="JaVa&#x53;cript:alert(1)">y</a>',
  '<iframe src="https://evil.example/"></iframe>',
  '<svg onload="alert(1)"><circle r="1"/></svg>',
  '```html\n<img src=x onerror=alert(1)><script>alert(1)</script>\n```',
  '```svg\n<svg onload=alert(1)><a><animate attributeName="href" values="javascript:alert(1)"/><text>c</text></a></svg>\n```',
];

// Nothing in `html` can run: no active element, no handler, no script URL.
function assertInert(html, label) {
  assert.ok(!/<\s*(script|iframe|object|embed|form|style)\b/i.test(html), `${label}: active element in ${html}`);
  for (const [, attrs] of html.matchAll(/<[a-zA-Z][\w-]*((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g)) {
    assert.ok(!/(^|\s)on[a-z]+\s*=/i.test(attrs), `${label}: handler in ${attrs}`);
    assert.ok(!/(^|\s)(href|src|xlink:href)\s*=\s*["']?\s*(javascript|vbscript|data:text)/i.test(attrs), `${label}: script URL in ${attrs}`);
    assert.ok(!/attributeName\s*=\s*"?(xlink:)?href/i.test(attrs), `${label}: link animation in ${attrs}`);
  }
}

// core.js renderMarkdown + renderMarkdownDebounced in a sandbox. marked turns
// fences into renderer.code calls and passes everything else through as raw
// HTML (what it does with raw HTML blocks); DOMPurify records its configs and
// returns its input, as if it had missed everything.
function loadRenderer() {
  const purifyCalls = [];
  class Renderer {}
  const marked = {
    Renderer,
    setOptions(o) { this.opts = o; },
    parse(text) {
      return text.replace(/```(\w*)\n([\s\S]*?)\n```/g, (m, lang, code) => this.opts.renderer.code({ text: code, lang }));
    },
  };
  const DOMPurify = { sanitize(html, cfg) { purifyCalls.push(cfg); return html; } };
  const ctx = {
    renderSafe, marked, DOMPurify, window: {}, WeakMap,
    setTimeout: (fn) => { fn(); return 1; }, clearTimeout() {},
    linkifyFilePaths() {},
  };
  vm.createContext(ctx);
  vm.runInContext([fnSrc(core, 'escHtml\\(str\\)'), fnSrc(core, 'renderMarkdown\\(text, targetEl, opts = \\{\\}\\)'),
    'const _renderTimers = new WeakMap();', fnSrc(core, 'renderMarkdownDebounced\\(text, targetEl\\)'),
    'this.renderMarkdown = renderMarkdown; this.renderMarkdownDebounced = renderMarkdownDebounced;'].join('\n'), ctx);
  const target = () => {
    const t = { html: null, text: null, querySelectorAll: () => [] };
    Object.defineProperty(t, 'innerHTML', { set(v) { t.html = v; }, get() { return t.html; } });
    Object.defineProperty(t, 'textContent', { set(v) { t.text = v; }, get() { return t.text; } });
    return t;
  };
  return { ctx, purifyCalls, target };
}

test('renderMarkdown: hostile HTML renders inert for every caller, files or not', () => {
  const { ctx, purifyCalls, target } = loadRenderer();
  for (const p of PAYLOADS) {
    for (const opts of [undefined, { file: true }]) {
      purifyCalls.length = 0;
      const el = target();
      ctx.renderMarkdown(`hello\n\n${p}\n\nbye`, el, opts);
      assertInert(el.html, `${JSON.stringify(opts)} ${p}`);
      assert.match(el.html, /hello[\s\S]*bye/);
      assert.ok(purifyCalls.length >= 1 && purifyCalls.every((c) => c === renderSafe.PURIFY_BLOCK), 'DOMPurify with PURIFY_BLOCK');
    }
  }
});

test('renderMarkdown: live html/svg fences still render; code fences stay text', () => {
  const { ctx, target } = loadRenderer();
  const el = target();
  ctx.renderMarkdown('```svg\n<svg viewBox="0 0 2 2"><circle cx="1" cy="1" r="1" fill="red"/></svg>\n```\n```js\n<b>x</b>\n```', el);
  assert.match(el.html, /<div class="rendered-block rendered-svg"><svg viewBox="0 0 2 2"><circle cx="1" cy="1" r="1" fill="red" \/><\/svg><\/div>/);
  assert.match(el.html, /<button class="code-copy-btn" title="Copy">Copy<\/button><pre><code class="language-js">&lt;b&gt;x&lt;\/b&gt;<\/code><\/pre>/);
});

test('renderMarkdown: without DOMPurify the text shows as text', () => {
  const { ctx, target } = loadRenderer();
  ctx.DOMPurify = undefined;
  const el = target();
  ctx.renderMarkdown('<img src=x onerror=alert(1)>', el);
  assert.strictEqual(el.html, null);
  assert.strictEqual(el.text, '<img src=x onerror=alert(1)>');
});

test('SDK panel: assistant text, a stream delta and a history page render through renderMarkdown, thinking as text', () => {
  const { ctx, target } = loadRenderer();
  // The calls sdk-panel.js makes, with the text it passes.
  const text = target(), delta = target(), page = target(), stop = target();
  let raw = '';
  for (const p of PAYLOADS) {
    raw += p.slice(0, 7);
    ctx.renderMarkdownDebounced(raw, delta);       // text_delta (blk.raw so far)
    assertInert(delta.html, `delta ${raw}`);
  }
  for (const p of PAYLOADS) {
    ctx.renderMarkdown(p, stop); assertInert(stop.html, `stop ${p}`);   // content_block_stop
    ctx.renderMarkdown(p, text); assertInert(text.html, `assistant ${p}`);  // assistant message
    ctx.renderMarkdown(p, page); assertInert(page.html, `history ${p}`);    // replayed from a history page
  }
  // The wiring: the stream delta, its stop, and an assistant message (live or
  // replayed by onHistory through apply) reach the DOM only through those two.
  assert.match(panel, /d\.type === 'text_delta'\) \{\n\s+blk\.raw \+= d\.text \|\| '';[\s\S]{0,140}renderMarkdownDebounced\(blk\.raw, blk\.body\)/);
  assert.match(panel, /blk\.type === 'text'\) \{\n\s+cancelRenderDebounce\(blk\.body\);\n\s+renderMarkdown\(blk\.raw, blk\.body\);/);
  assert.match(panel, /if \(t === 'text'\) \{\n\s+cancelRenderDebounce\(blk\.body\);\n\s+renderMarkdown\(b\.text \|\| '', blk\.body\);/);
  assert.match(panel, /onHistory\(events, error, page = \{\}\) \{[\s\S]*?this\.apply\(ev, false/);
  // Thinking is text: a growing text node while streaming, textContent after.
  assert.match(panel, /blk\.textNode = blk\.body\.appendChild\(document\.createTextNode\(''\)\);\n\s+blk\.textNode\.appendData\(d\.thinking \|\| ''\);/);
  assert.match(panel, /blk\.body\.textContent = raw;/);
});

test('renderSafe.cleanHtml: what DOMPurify might miss, cleanHtml drops', () => {
  const c = renderSafe.cleanHtml;
  assert.strictEqual(c('<img src=x onerror=alert(1)>'), '<img src="x">');
  assert.strictEqual(c('a<script>alert(1)</script>b'), 'ab');
  assert.strictEqual(c('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
  assert.strictEqual(c('<a href="java&#x09;script:alert(1)">x</a>'), '<a>x</a>');
  assert.strictEqual(c('<iframe src="//e"></iframe>ok'), 'ok');
  assert.strictEqual(c('<svg onload=alert(1)><rect/></svg>'), '<svg><rect /></svg>');
  assert.strictEqual(c('<form action="//e"><input formaction="//e" name="q"></form>'), '<input name="q">');
  assert.strictEqual(c('<p style="background:url(//e/x)">s</p><a href="data:text/html,x">d</a>'), '<p>s</p><a>d</a>');
  assert.strictEqual(c('<img src="data:image/png;base64,AA" srcset="//e/x 2x">'), '<img src="data:image/png;base64,AA">');
  assert.strictEqual(c('<a href="https://x.y/?a=1&amp;b=2" title="&quot;q&quot;">l</a> 1 < 2'), '<a href="https://x.y/?a=1&amp;b=2" title="&quot;q&quot;">l</a> 1 &lt; 2');
  assert.strictEqual(c('<style>*{}</style><math><mi>x</mi></math><meta http-equiv=refresh content="0;url=//e">t'), 't');
});

test('PURIFY_BLOCK forbids active elements and loading attributes', () => {
  const cfg = renderSafe.PURIFY_BLOCK;
  for (const t of ['script', 'iframe', 'object', 'embed', 'form', 'style']) assert.ok(cfg.FORBID_TAGS.includes(t), t);
  for (const a of ['srcset', 'formaction', 'action', 'srcdoc']) assert.ok(cfg.FORBID_ATTR.includes(a), a);
  assert.ok(!cfg.ADD_ATTR.some((a) => /^on/i.test(a)));
  assert.ok(!('ALLOWED_URI_REGEXP' in cfg) && !cfg.ALLOW_UNKNOWN_PROTOCOLS, 'DOMPurify keeps refusing javascript: URLs');
});

test('escHtml escapes quotes of both kinds', () => {
  const ctx = {};
  vm.runInNewContext(fnSrc(core, 'escHtml\\(str\\)') + '\nthis.escHtml = escHtml;', ctx);
  assert.strictEqual(ctx.escHtml(`<a b="c" d='e'>&`), '&lt;a b=&quot;c&quot; d=&#39;e&#39;&gt;&amp;');
  assert.strictEqual(ctx.escHtml(5), '5');
});

test('question form: a showIf value cannot leave its attribute', () => {
  const line = core.match(/const showIfAttr = .*;/)[0];
  const ctx = { q: { showIf: { questionId: 'a', equals: "a' onmouseover='alert(1)' x='" } } };
  vm.runInNewContext(fnSrc(core, 'escHtml\\(str\\)') + '\n' + line + '\nthis.out = showIfAttr;', ctx);
  const html = `<div class="ask-question"${ctx.out}>`;
  // Outside the double-quoted values only the element's own attributes are left.
  const names = html.replace(/"[^"]*"/g, '""').match(/[\w-]+(?==)/g);
  assert.deepStrictEqual(names, ['class', 'data-showif']);
  assert.ok(!/'/.test(ctx.out), 'no raw quote of either kind');
  const value = ctx.out.match(/data-showif="([^"]*)"/)[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.deepStrictEqual(JSON.parse(value), ctx.q.showIf);
  // No template attribute in the page code is single-quoted around data.
  for (const f of fs.readdirSync(path.join(__dirname, '../public')).filter((n) => n.endsWith('.js'))) {
    assert.ok(!/[\w-]='\$\{/.test(read(f)), `${f} has a single-quoted attribute fed with data`);
  }
});

// core.js askPreviewHtml in a sandbox, marked and DOMPurify as above.
function loadPreview() {
  const purifyCalls = [];
  const ctx = {
    askSafe, renderSafe,
    marked: { parse: (t) => t },
    DOMPurify: { sanitize(html, cfg) { purifyCalls.push(cfg); return html; } },
  };
  vm.runInNewContext(fnSrc(core, 'escHtml\\(str\\)') + '\n' + fnSrc(core, 'askPreviewHtml\\(text, remote\\)') + '\nthis.askPreviewHtml = askPreviewHtml;', ctx);
  return { ctx, purifyCalls };
}

test('ask preview: a remote ask keeps only the inline allow-list, a local one the block sanitizer', () => {
  const { ctx, purifyCalls } = loadPreview();
  const evil = '<p style="position:fixed">hi</p><form action="//e"><input></form><img src="a.png" srcset="//e/x 2x" onerror="x()"><b>ok</b><script>x</script>';
  const remote = ctx.askPreviewHtml(evil, true);
  assert.deepStrictEqual(purifyCalls, [askSafe.PURIFY_INLINE]);
  assert.strictEqual(remote, askSafe.cleanInlineHtml(evil));
  assert.strictEqual(remote, 'hi<img src="a.png"><b>ok</b>');
  purifyCalls.length = 0;
  const local = ctx.askPreviewHtml(evil, false);
  assert.deepStrictEqual(purifyCalls, [renderSafe.PURIFY_BLOCK]);
  assertInert(local, 'local preview');
  // showPreview uses it with the form's remote flag.
  assert.match(core, /safe = askResolveMdImages\(askPreviewHtml\(opt\.preview, remote\), cwd, remote\);/);
  assert.ok(!/DOMPurify\.sanitize\(rendered\)/.test(core), 'no default-config DOMPurify left');
});

test('user turn images: data:image/ and this dashboard\'s uploads load, nothing else', () => {
  const u = renderSafe.userImageUrl;
  assert.strictEqual(u('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.strictEqual(u('/api/uploads/x'), '/api/uploads/x');
  assert.strictEqual(u('/api/uploads/s1/shot.png'), '/api/uploads/s1/shot.png');
  assert.strictEqual(u('/api/sdk/upload?sessId=a&name=b.png'), '/api/sdk/upload?sessId=a&name=b.png');
  for (const bad of ['http://evil/x', 'https://evil/x.png', 'javascript:alert(1)', '//evil/x', '/api/uploads/../config',
    '/api/uploads/%2e%2e/x', '/api/raw-file?path=/etc/passwd', 'data:text/html,<script>x</script>', 'data:image', '', null, 42]) {
    assert.strictEqual(u(bad), null, String(bad));
  }
  // sdk-panel.js shows a refused one as its name, and sets the checked URL only.
  const block = panel.match(/for \(const im of imgs\) \{[\s\S]*?strip\.appendChild\(a\);/)[0];
  assert.match(block, /const url = window\.renderSafe\?\.userImageUrl\(im\?\.url\);/);
  assert.match(block, /if \(!url\) \{ strip\.appendChild\(el\('span', 'sdk-user-img-blocked'/);
  assert.match(block, /a\.href = url;/);
  assert.match(block, /img\.src = url;/);
  assert.ok(!/im\.url;/.test(block.replace('im?.url', '')), 'im.url is never set directly');
});

test('index.html loads render-safe.js before core.js', () => {
  const html = read('index.html');
  const at = html.indexOf('src="render-safe.js"');
  assert.ok(at > 0 && at < html.indexOf('src="core.js"'));
});
