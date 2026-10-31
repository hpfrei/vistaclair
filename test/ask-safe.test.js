// Question-form safety (public/ask-safe.js): the inline markdown of a form
// keeps only inline formatting, a remote ask loads only data:image/ images,
// and core.js wires both in (plus escaped number-field attributes).
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { cleanInlineHtml, askImageSrc, PURIFY_INLINE, INLINE_TAGS } = require('../public/ask-safe.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '../public', f), 'utf8');

test('inline html: <img onerror> loses the handler', () => {
  assert.strictEqual(cleanInlineHtml('<img src=x onerror=alert(1)>'), '<img src="x">');
  assert.strictEqual(cleanInlineHtml('<img src="a.png" alt="a" ONERROR="alert(1)" onload=\'x()\'>'), '<img src="a.png" alt="a">');
  // Not a whole tag: stays text.
  assert.strictEqual(cleanInlineHtml('<img src=x onerror=alert(1)'), '&lt;img src=x onerror=alert(1)');
});

test('inline html: <script> and other active elements are dropped with their content', () => {
  assert.strictEqual(cleanInlineHtml('a<script>alert(1)</script>b'), 'ab');
  assert.strictEqual(cleanInlineHtml('a<SCRIPT src="//x"></SCRIPT>b'), 'ab');
  assert.strictEqual(cleanInlineHtml('a<script>alert(1)'), 'a');
  assert.strictEqual(cleanInlineHtml('<svg onload=alert(1)><circle/></svg>ok'), 'ok');
  assert.strictEqual(cleanInlineHtml('<iframe src="javascript:alert(1)"></iframe>ok'), 'ok');
  // Unknown tags go, their text stays.
  assert.strictEqual(cleanInlineHtml('<div onclick="x()">hi</div>'), 'hi');
  assert.strictEqual(cleanInlineHtml('<!-- <script>x</script> -->t'), 't');
});

test('inline html: javascript: links lose their href, however spelt', () => {
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
    'javascript&#58;alert(1)', 'javascript&#x3A;alert(1)', 'javascript&colon;alert(1)', '&#106;avascript:alert(1)',
    'vbscript:x', 'data:text/html,<script>alert(1)</script>']) {
    assert.strictEqual(cleanInlineHtml(`<a href="${href.replace(/"/g, '&quot;')}">x</a>`), '<a>x</a>', href);
  }
  assert.strictEqual(cleanInlineHtml("<a href='javascript:alert(1)'>x</a>"), '<a>x</a>');
  assert.strictEqual(cleanInlineHtml('<img src="javascript:alert(1)">'), '<img>');
  assert.strictEqual(cleanInlineHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">'), '<img>');
});

test('inline html: the formatting forms use survives', () => {
  const md = 'Pick <strong>one</strong>, <em>quickly</em>: <code>a &lt; b</code> <del>no</del><br>'
    + '<a href="https://example.com/x?a=1&amp;b=2" title="t &quot;q&quot;">link</a> <a href="mailto:a@b.c">m</a> '
    + '<a href="docs/x.md">rel</a> <img src="shot.png" alt="s"> <img src="data:image/png;base64,AAAA" alt="d">';
  assert.strictEqual(cleanInlineHtml(md),
    'Pick <strong>one</strong>, <em>quickly</em>: <code>a &lt; b</code> <del>no</del><br>'
    + '<a href="https://example.com/x?a=1&amp;b=2" title="t &quot;q&quot;">link</a> <a href="mailto:a@b.c">m</a> '
    + '<a href="docs/x.md">rel</a> <img src="shot.png" alt="s"> <img src="data:image/png;base64,AAAA" alt="d">');
  // Stray angle brackets in text are escaped, entities kept.
  assert.strictEqual(cleanInlineHtml('1 < 2 > 0 &amp; x'), '1 &lt; 2 &gt; 0 &amp; x');
  assert.strictEqual(cleanInlineHtml(''), '');
  assert.strictEqual(cleanInlineHtml(null), '');
});

test('DOMPurify config allows only inline tags and no handlers', () => {
  assert.deepStrictEqual(PURIFY_INLINE.ALLOWED_TAGS, INLINE_TAGS);
  assert.ok(!INLINE_TAGS.includes('script') && !INLINE_TAGS.includes('svg'));
  assert.ok(PURIFY_INLINE.ALLOWED_ATTR.every((a) => !/^on/i.test(a) && a !== 'style'));
});

test('core.js: inline markdown goes through DOMPurify and the allow-list', () => {
  const core = read('core.js');
  const fn = core.match(/function inlineMd\(text\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /DOMPurify\.sanitize\(html, askSafe\.PURIFY_INLINE\)/);
  assert.match(fn, /return askSafe\.cleanInlineHtml\(purified\)/);
  assert.match(core, /function askInlineMd\(text, cwd, remote\) \{\n  return askResolveMdImages\(inlineMd\(text\), cwd, remote\);/);
  assert.match(core, /const askImageSrc = askSafe\.askImageSrc;/);
  const html = read('index.html');
  const at = html.indexOf('src="ask-safe.js"');
  assert.ok(at > 0 && at < html.indexOf('src="core.js"'), 'ask-safe.js loads before core.js');
  assert.ok(html.indexOf('purify.min.js') > 0 && html.indexOf('purify.min.js') < html.indexOf('src="core.js"'), 'DOMPurify loads before core.js');
});

test('image src: a remote ask loads only data:image/', () => {
  const data = 'data:image/png;base64,AAAA';
  assert.deepStrictEqual(askImageSrc(data, '/w', true), { url: data, path: null });
  assert.strictEqual(askImageSrc('/etc/passwd', '/w', true), null);
  assert.strictEqual(askImageSrc('shot.png', '/w', true), null);
  assert.strictEqual(askImageSrc('file:///home/u/a.png', '/w', true), null);
  assert.strictEqual(askImageSrc('/api/raw-file?path=%2Fetc%2Fpasswd', '/w', true), null);
  assert.strictEqual(askImageSrc('https://example.com/a.png', '/w', true), null);
  assert.strictEqual(askImageSrc('javascript:alert(1)', '/w', true), null);
});

test('image src: a local ask keeps paths via /api/raw-file and URLs', () => {
  assert.deepStrictEqual(askImageSrc('/home/u/a.png', '/w', false), { url: '/api/raw-file?path=%2Fhome%2Fu%2Fa.png', path: '/home/u/a.png' });
  assert.deepStrictEqual(askImageSrc('./shot.png', '/w/', undefined), { url: '/api/raw-file?path=%2Fw%2Fshot.png', path: '/w/shot.png' });
  assert.deepStrictEqual(askImageSrc('https://example.com/a.png', null), { url: 'https://example.com/a.png', path: null });
  assert.strictEqual(askImageSrc('data:image/gif;base64,R0', null).url, 'data:image/gif;base64,R0');
  assert.strictEqual(askImageSrc('javascript:alert(1)', '/w'), null);
  assert.strictEqual(askImageSrc('shot.png', null), null);
});

test('core.js and cli.js pass the remote flag through the form', () => {
  const core = read('core.js');
  assert.match(core, /const remote = opts\.remote === true;[\s\S]*askInlineMd\(q\.question, cwd, remote\)/);
  assert.match(core, /askImgHTML\(src, cwd, caption, remote\)/);
  assert.match(core, /askOpenImage\(zoom\.dataset\.zoomSrc, zoom\.dataset\.zoomCaption, cwd, remote\)/);
  const cli = read('cli.js');
  assert.match(cli, /remote: msg\.host != null/);
  assert.match(cli, /const formOpts = \{ cwd: meta\.cwd, remote: meta\.remote === true \};/);
  assert.match(cli, /askFormBuildHTML\(f\.formData, formOpts\)/);
});

test('number field: min/max/step/default cannot break out of their attributes', () => {
  const core = read('core.js');
  const src = core.match(/function escHtml\(str\) \{[\s\S]*?\n\}/)[0] + '\n'
    + core.match(/function askFieldHTML\(q, qi, qType, qId, cwd, remote\) \{[\s\S]*?\n\}/)[0];
  const ctx = {};
  vm.runInNewContext(src + '\nthis.askFieldHTML = askFieldHTML;', ctx);
  const evil = '1" onfocus="alert(1)" autofocus x="';
  const html = ctx.askFieldHTML({ min: evil, max: evil, step: evil, defaultValue: evil }, 0, 'number', 'n', null, false);
  // Outside the quoted values only the field's own attributes are left.
  const names = html.replace(/"[^"]*"/g, '""').match(/[\w-]+(?==)/g);
  assert.deepStrictEqual(names, ['type', 'class', 'data-qid', 'value', 'min', 'max', 'step', 'placeholder']);
  assert.ok(!/autofocus/.test(html.replace(/"[^"]*"/g, '""')));
  assert.strictEqual((html.match(/&quot; onfocus=&quot;/g) || []).length, 4);
  const plain = ctx.askFieldHTML({ min: 0, max: 10, step: 0.5, defaultValue: 3 }, 0, 'number', 'n', null, false);
  assert.match(plain, /value="3" min="0" max="10" step="0.5"/);
});
