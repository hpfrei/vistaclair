// Local file paths in rendered session output (worker reports, messages,
// assistant text) must load through /api/raw-file, not as a bare path on the
// dashboard host. Owner's case: a thumbnail at
// https://<tunnel>/home/hp/.../previews/logo-zoom-color.png returned 404.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const renderSafe = require('../public/render-safe.js');

const P = '/home/hp/vistaclair/vistaclair-apps/family-board/.vistaclair/sessions/orch-137471-w9-masthead-logo/previews/logo-zoom-color.png';
const RAW = '/api/raw-file?path=' + encodeURIComponent(P);
const srcOf = (html) => (html.match(/\ssrc="([^"]*)"/) || [])[1];

test('an <img> with a bare absolute path goes through /api/raw-file', () => {
  const html = renderSafe.sanitizeHtml(`<p><img src="${P}" alt="logo"></p>`, null);
  assert.strictEqual(srcOf(html), RAW.replace(/&/g, '&amp;'));
});

test('video and audio: video through /api/video-stream, audio and source through raw-file', () => {
  assert.strictEqual(srcOf(renderSafe.cleanHtml('<video src="/tmp/a b.mp4" controls></video>')), '/api/video-stream?path=' + encodeURIComponent('/tmp/a b.mp4'));
  assert.strictEqual(srcOf(renderSafe.cleanHtml('<audio src="/tmp/a.mp3"></audio>')), '/api/raw-file?path=' + encodeURIComponent('/tmp/a.mp3'));
  assert.strictEqual(srcOf(renderSafe.cleanHtml('<video><source src="/tmp/a.webm"></video>')), '/api/raw-file?path=' + encodeURIComponent('/tmp/a.webm'));
  assert.match(renderSafe.cleanHtml('<video poster="/tmp/p.png" src="/tmp/a.mp4"></video>'), /poster="\/api\/raw-file\?path=%2Ftmp%2Fp\.png"/);
});

test('percent-encoded paths are decoded once, query and fragment are not part of the path', () => {
  assert.strictEqual(srcOf(renderSafe.cleanHtml('<img src="/tmp/my%20shot.png?v=2#x">')), '/api/raw-file?path=' + encodeURIComponent('/tmp/my shot.png'));
});

test('http(s), data:, protocol-relative, relative and the dashboard\'s own routes are left alone', () => {
  for (const u of ['https://example.com/a.png', 'http://example.com/a.png', 'data:image/png;base64,AAAA', '//cdn.example/a.png',
    '/api/raw-file?path=%2Ftmp%2Fa.png', '/api/uploads/x.png', '/outputs/a.png', '/vendor/d3/d3.js', '/favicon.svg', 'shot.png', './a/b.png']) {
    assert.strictEqual(srcOf(renderSafe.cleanHtml(`<img src="${u}">`)), u.replace(/&/g, '&amp;'), u);
  }
});

test('only media src attributes are rewritten; links and other tags keep their href', () => {
  assert.match(renderSafe.cleanHtml(`<a href="${P}">x</a>`), new RegExp(`href="${P}"`));
  assert.ok(!/raw-file/.test(renderSafe.cleanHtml('<div src="/tmp/a.png"></div>')));
});

test('the rewrite output cannot break out of the attribute', () => {
  const html = renderSafe.cleanHtml('<img src="/tmp/a&quot; onerror=&quot;alert(1).png">');
  assert.ok(!/\sonerror/.test(html), html);
  assert.match(html, /^<img src="\/api\/raw-file\?path=[^"<>\s]*">$/);
});

// The owner's case end to end: renderMarkdown of a report with a markdown
// image at a bare path (marked stubbed as passing `![alt](src)` to <img>).
test('renderMarkdown: ![](/abs/path.png) in a report renders a raw-file src', () => {
  const core = fs.readFileSync(path.join(__dirname, '../public/core.js'), 'utf8');
  const fnSrc = (head) => core.match(new RegExp(`function ${head}[\\s\\S]*?\\n\\}`))[0];
  class Renderer {}
  const marked = { Renderer, setOptions() {}, parse: (t) => t.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '<img src="$2" alt="$1">') };
  const ctx = { renderSafe, marked, DOMPurify: { sanitize: (h) => h }, window: {}, linkifyFilePaths() {} };
  vm.createContext(ctx);
  vm.runInContext([fnSrc('escHtml\\(str\\)'), fnSrc('renderMarkdown\\(text, targetEl, opts = \\{\\}\\)'), 'this.renderMarkdown = renderMarkdown;'].join('\n'), ctx);
  const el = { querySelectorAll: () => [], set innerHTML(v) { this.html = v; } };
  ctx.renderMarkdown(`Done.\n\n![logo](${P})`, el);
  assert.strictEqual(srcOf(el.html), RAW);
  assert.ok(!el.html.includes(`src="${P}"`));
});
