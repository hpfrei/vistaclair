// The dashboard never opens the browser's own alert(), confirm() or prompt():
// every dialog is the in-app modal (window.dashboard.showAlert / showConfirm /
// showPrompt in public/core.js). This scans public/**/*.js, comments aside,
// for a native call, the window.-prefixed form included. Method calls such as
// tg.showConfirm( or x.confirm( are not native and do not count.
//
//   node --test test/

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const VENDORED = new Set(['vendor', 'vendored', 'node_modules', 'lib']);
const NATIVE = /(?<![\w$.])(?:window\.)?(?:alert|confirm|prompt)\s*\(/;

function jsFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (!VENDORED.has(ent.name)) out.push(...jsFiles(p)); }
    else if (ent.name.endsWith('.js') && !ent.name.endsWith('.min.js')) out.push(p);
  }
  return out;
}

// Comments out, line count kept. Only a comment that starts a line or follows
// whitespace is one, so 'http://…' and globs such as '**/*.js' in strings stay.
function stripComments(src) {
  return src
    .replace(/(^|\s)\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

function nativeCalls(src) {
  return stripComments(src).split('\n')
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter(({ text }) => NATIVE.test(text));
}

test('the matcher: native calls count, method calls and comments do not', () => {
  for (const s of ['alert(x)', 'if (!confirm("Sure?")) return;', 'const n = prompt("Name");',
    'window.confirm(msg)', 'window.alert (msg)', '`<button onclick="if(confirm(\'Delete?\'))go()">`']) {
    assert.strictEqual(nativeCalls(s).length, 1, s);
  }
  for (const s of ['tg.showConfirm(msg)', 'showConfirm(msg)', 'showAlert(msg)', 'x.confirm(msg)',
    'D.showPrompt("Name")', 'opts.alert(1)', '// call confirm() here', '/* alert(x) */',
    'const url = "http://x/confirm"; // prompt (no)', 'confirmed(x)']) {
    assert.strictEqual(nativeCalls(s).length, 0, s);
  }
});

test('public/**/*.js has no native alert/confirm/prompt call', () => {
  const files = jsFiles(PUBLIC);
  assert.ok(files.length > 10, 'public/*.js found');
  const hits = [];
  for (const f of files) {
    for (const { line, text } of nativeCalls(fs.readFileSync(f, 'utf8'))) {
      hits.push(`${path.relative(path.join(__dirname, '..'), f)}:${line}: ${text}`);
    }
  }
  assert.deepStrictEqual(hits, [], 'use window.dashboard.showAlert / showConfirm / showPrompt instead:\n' + hits.join('\n'));
});
