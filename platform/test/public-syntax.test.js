// Every .js file under public/ must parse.
//
// public/ is served as static files and every script in it is loaded by a
// plain <script src> tag (no type="module", no import/export anywhere), so each
// file is parsed as a CLASSIC script. A syntax error there does not fail any
// server test: it only shows as a page error in the browser and takes the view
// down with it (horst-map.js once broke the Horst Map tab this way).
//
// Parsing only — vm.Script compiles the source and never runs it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');

function jsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsFiles(p));
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out.sort();
}

function htmlFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...htmlFiles(p));
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const files = jsFiles(PUBLIC);

test('public/ has scripts to check', () => {
  assert.ok(files.length > 0);
});

test('no public/ page loads a module script (the files below are parsed as classic scripts)', () => {
  for (const f of htmlFiles(PUBLIC)) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/<script[^>]*type\s*=\s*["']?module/i.test(src),
      `${path.relative(PUBLIC, f)} loads a module script; teach test/public-syntax.test.js to parse it as a module`);
  }
  for (const f of files) {
    assert.ok(!/\.mjs$/.test(f), `${path.relative(PUBLIC, f)} is a module file; parse it as a module`);
  }
});

for (const f of files) {
  const rel = path.relative(PUBLIC, f);
  test(`public/${rel} parses`, () => {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotThrow(() => new vm.Script(src, { filename: f }), `public/${rel} has a syntax error`);
  });
}
