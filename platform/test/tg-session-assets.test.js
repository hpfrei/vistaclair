// The CLI-session Mini App runs in Telegram's webview, which carries no owner
// cookie: every asset its page loads must sit under an auth-EXEMPT path
// (index.js authExemptPaths) or come from telegram.org. A script tag on, say,
// /pro/marked.min.js would load in a browser with a session and fail silently
// on the phone.
const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXEMPT = ['/pro/tg-session', '/pro/tg-common'];
// Exempt as exact paths: the read-only markdown libraries.
const EXEMPT_FILES = ['/pro/marked.min.js', '/pro/purify.min.js'];

test('tg-session page loads only exempt or Telegram assets', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/tg-session/index.html'), 'utf8');
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    if (/^https:\/\/telegram\.org\//.test(ref)) continue;
    // A relative ref resolves under /pro/tg-session/ itself.
    const abs = ref.startsWith('/') ? ref : '/pro/tg-session/' + ref;
    assert.ok(EXEMPT.some((p) => abs === p || abs.startsWith(p + '/')) || EXEMPT_FILES.includes(abs), `${ref} is not under an auth-exempt path`);
  }
  const indexJs = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  for (const p of [...EXEMPT, ...EXEMPT_FILES]) assert.ok(indexJs.includes(`'${p}'`), `${p} is no longer auth-exempt in index.js`);
});

// A relayed remote ask is labelled and set apart; its images load only as
// inline data: URIs (a master path would not load in the webview).
test('tg-session labels remote asks and shows only data: images', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public/tg-session/tg-session.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/tg-session/tg-session.css'), 'utf8');
  assert.match(js, /className = 'q-remote'/);
  assert.match(js, /\['Remote', plainCap\(remote\.host, 100\), plainCap\(remote\.session, 120\)\]/);
  assert.match(css, /\.q-remote \{[^}]*border/);
  const m = /var DATA_IMAGE = (\/.+\/);/.exec(js);
  assert.ok(m, 'the data:image check');
  const re = eval(m[1]); // eslint-disable-line no-eval
  assert.ok(re.test('data:image/png;base64,iVBORw0KGgo='));
  for (const bad of ['/home/hp/x.png', 'https://x/y.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,AA"onerror=x', 'javascript:alert(1)']) {
    assert.equal(re.test(bad), false, bad);
  }
  assert.match(js, /if \(typeof src !== 'string' \|\| !DATA_IMAGE\.test\(src\)\) return null;/);
  assert.doesNotMatch(js, /\.innerHTML\s*=[^;]*(o\.label|q\.question|fd\.title|fd\.description|remote\.)/, 'ask data never goes through innerHTML');
});

// The remote sessions' questions no run holds: a list in the picker, its slave
// strings set as text only, every remote answer naming its tab (core's rule).
test('tg-session lists remote sessions as text and answers naming the tab', () => {
  const js = fs.readFileSync(path.join(ROOT, 'public/tg-session/tg-session.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public/tg-session/index.html'), 'utf8');
  assert.match(html, /<main id="picker"[^>]*>\s*<div id="remote-list" hidden><\/div>\s*<div id="picker-runs"><\/div>/);
  assert.doesNotMatch(js, /pickerEl\.innerHTML\s*=/, 'the runs re-render must not wipe the remote list');
  assert.match(js, /applyRuns\(data\.runs, data\.remote\)/);
  assert.match(js, /app\.api\('remote\/answer', \{ method: 'POST', body: answerBody\(ask, answer\) \}\)/);
  assert.match(js, /if \(p\.remote && typeof p\.remote\.tabId === 'string'\) body\.tabId = p\.remote\.tabId;/);
  assert.match(js, /body: answerBody\(pending\[0\], answer\)/);
  const list = js.slice(js.indexOf('// --- remote sessions'), js.indexOf('// --- navigation'));
  assert.ok(list.length > 500, 'the remote list section');
  assert.doesNotMatch(list, /innerHTML/, 'nothing in the remote list goes through innerHTML');
  for (const f of ['t.textContent = s.session', 'ph.textContent = g.host', 'c.stateEl.textContent = remoteStateLine(s)']) assert.ok(list.includes(f), f);
  assert.match(list, /host: plainCap\(g && g\.host, 100\)/);
  assert.match(list, /session: plainCap\(s && s\.session, 120\)/);
});
