// Text size ("zoom") in SDK sessions on a phone. The owner could not change it:
// the A−/A+ keys lived in the terminal's key row, which an SDK tab hides, and
// the SDK panel had no text-size control of its own (and `touch-action: pan-y`
// on the tab's wrap stopped pinch-zoom).
//
// This runs the real public/sdk-panel.js + sdk-panel.css in headless Chrome at
// phone width (390 wide; Chrome's headless floor is 500, still a phone: the
// breakpoint is 640), builds a Panel with a feed row, taps A+ and measures the
// row. Skipped where no Chrome is installed.
//
//   node --test test/sdk-text-zoom.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert');

const PUB = path.join(__dirname, '..', 'public');

function findChrome() {
  const cands = ['google-chrome', 'chromium-browser', 'chromium', 'chrome'];
  for (const c of cands) {
    const r = spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  const pw = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const d of fs.readdirSync(pw)) {
      for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = path.join(pw, d, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return null;
}
const CHROME = findChrome();

// Runs `body` (JS, with `out(k, v)` to report) in a page that has an SDK panel
// with one feed row. Returns what it reported.
function inBrowser(width, body, { seed } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-zoom-'));
  try {
    const file = path.join(dir, 'h.html');
    const u = (f) => 'file://' + path.join(PUB, f);
    fs.writeFileSync(file, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${u('sdk-panel.css')}"></head>
<body style="margin:0;height:100vh;display:flex;flex-direction:column"><div id="w" class="cli-sdk-wrap sdk-wrap" style="flex:1"></div><pre id="out"></pre>
<script>
${seed ? `localStorage.setItem('sdkTextZoom', '${seed}');` : `localStorage.removeItem('sdkTextZoom');`}
window.tabHookInfo = () => ({});
window.dashboard = { sendWs() {}, state: {}, escHtml: String, renderMarkdown() {}, renderMarkdownDebounced() {}, cancelRenderDebounce() {},
  registerModule() {}, _tabBadgeEl: () => null, _tabHooks: { onChange() {}, actionsFor: () => [], badgesFor: () => [] }, isPhone: () => true };
const R = {}; const out = (k, v) => { R[k] = v; };
</script>
<script src="${u('sdk-links.js')}"></script><script src="${u('sdk-activity.js')}"></script><script src="${u('sdk-panel.js')}"></script>
<script>
try {
  const p = new window.sdkPanel._Panel('t', document.getElementById('w'));
  p.update({ sessId: 's1', title: 'T', status: 'idle', settings: {}, cwd: '/x' });
  const feed = document.querySelector('.sdk-feed');
  const row = document.createElement('div'); row.className = 'sdk-text'; row.textContent = 'hello world '.repeat(40); feed.appendChild(row);
  const code = document.createElement('pre'); code.className = 'sdk-text'; code.textContent = 'const x = 1;\\nconst y = 2;'; feed.appendChild(code);
  const rowH = () => row.getBoundingClientRect().height;
  const btn = (d) => document.querySelector('.sdk-zoom [data-zoom="' + d + '"]');
  ${body}
} catch (e) { R.error = String(e.stack || e); }
document.getElementById('out').textContent = JSON.stringify(R);
</script></body></html>`);
    const r = spawnSync(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--window-size=${width},844`,
      `--user-data-dir=${path.join(dir, 'profile')}`, '--virtual-time-budget=3000', '--dump-dom', 'file://' + file], { encoding: 'utf8', timeout: 60000 });
    const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(r.stdout || '');
    assert.ok(m, 'page produced no result: ' + (r.stderr || '').slice(-300));
    const res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    assert.ok(!res.error, res.error);
    return res;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const opts = { skip: CHROME ? false : 'no Chrome installed' };

test('phone: an SDK tab has A−/A+ (≥40px) and A+ enlarges the transcript, A− shrinks it', opts, () => {
  const r = inBrowser(390, `
    const a = btn(1).getBoundingClientRect(), m = btn(-1).getBoundingClientRect();
    out('plus', [a.width, a.height]); out('minus', [m.width, m.height]);
    const h0 = rowH(); out('h0', h0);
    btn(1).click(); btn(1).click();
    out('hUp', rowH()); out('zoomVar', document.documentElement.style.getPropertyValue('--sdk-zoom'));
    out('saved', localStorage.getItem('sdkTextZoom'));
    out('codeUp', code.getBoundingClientRect().height);
    btn(-1).click(); btn(-1).click(); btn(-1).click(); btn(-1).click();
    out('hDown', rowH()); out('savedDown', localStorage.getItem('sdkTextZoom'));
    // The layout holds at the largest size.
    for (let i = 0; i < 20; i++) btn(1).click();
    out('max', localStorage.getItem('sdkTextZoom')); out('plusDisabled', btn(1).disabled);
    out('overflow', feed.scrollWidth - feed.clientWidth);
    out('feedW', feed.getBoundingClientRect().width);
  `);
  assert.ok(r.plus[0] >= 40 && r.plus[1] >= 40, `A+ target ${r.plus}`);
  assert.ok(r.minus[0] >= 40 && r.minus[1] >= 40, `A− target ${r.minus}`);
  assert.ok(r.hUp > r.h0 * 1.2, `text grew: ${r.h0} -> ${r.hUp}`);
  assert.strictEqual(r.zoomVar, '1.2');
  assert.strictEqual(r.saved, '120');
  assert.ok(r.hDown < r.h0, `text shrank: ${r.h0} -> ${r.hDown}`);
  assert.strictEqual(r.savedDown, '80');
  assert.strictEqual(r.max, '200');
  assert.strictEqual(r.plusDisabled, true);
  assert.ok(r.overflow <= 1, `no sideways overflow at 200%: ${r.overflow}`);
});

test('phone: the saved size is applied on load', opts, () => {
  const r = inBrowser(390, `out('v', document.documentElement.style.getPropertyValue('--sdk-zoom')); out('h', rowH());`, { seed: '150' });
  const base = inBrowser(390, `out('h', rowH());`);
  assert.strictEqual(r.v, '1.5');
  assert.ok(r.h > base.h * 1.3, `${base.h} -> ${r.h}`);
});

test('desktop: no A−/A+ in the toolbar and the transcript is untouched', opts, () => {
  const r = inBrowser(1000, `
    out('display', getComputedStyle(document.querySelector('.sdk-zoom')).display);
    const h0 = rowH(); document.documentElement.style.setProperty('--sdk-zoom', '2'); out('same', h0 === rowH());
  `);
  assert.strictEqual(r.display, 'none');
  assert.strictEqual(r.same, true);
});

test('an SDK tab\'s wrap does not block pinch-zoom (touch-action)', () => {
  const css = fs.readFileSync(path.join(PUB, 'mobile.css'), 'utf8');
  assert.match(css, /\.cli-terminal-wrap\.cli-sdk-wrap\s*\{\s*touch-action:\s*manipulation/);
});
