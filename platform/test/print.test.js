// Local printing (platform-print.js + capabilities/print.js). CUPS is always a
// stub: these tests never run the real lp / lpstat (docs/print.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const print = require('../src/apps/platform-print');
const capabilities = require('../src/apps/capabilities');

const FX = path.join(__dirname, 'fixtures', 'print');
const fx = (n) => fs.readFileSync(path.join(FX, n), 'utf8');
const PRINTER = 'EPSON_ET_8500_Series';

// A small valid-looking PDF with `n` pages (a /Pages node plus n /Page leaves).
function pdfWithPages(n) {
  let body = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n';
  body += `2 0 obj\n<< /Type /Pages /Count ${n} /Kids [${Array.from({ length: n }, (_, i) => `${3 + i} 0 R`).join(' ')}] >>\nendobj\n`;
  for (let i = 0; i < n; i++) body += `${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n`;
  return Buffer.from(body + '%%EOF\n', 'latin1');
}

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// Per-test harness: temp state dir, scripted CUPS.
function harness(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-print-test-'));
  dirs.push(dir);
  const calls = [];
  const tmpFiles = [];
  const exec = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'lpstat' && args[0] === '-p') return opts.noPrinter ? { code: 1, stdout: fx('lpstat-p-d.none.stdout.txt'), stderr: fx('lpstat-p-d.none.stderr.txt') } : { code: 0, stdout: opts.pOut || fx('lpstat-p-d.host.txt'), stderr: '' };
    if (cmd === 'lpstat' && args[0] === '-v') return { code: 0, stdout: fx('lpstat-v.host.txt'), stderr: '' };
    if (cmd === 'lpstat' && args[0] === '-o') return { code: 0, stdout: opts.active || '', stderr: '' };
    if (cmd === 'lpstat' && args[0] === '-W') return { code: 0, stdout: opts.completed || '', stderr: '' };
    if (cmd === 'pdfinfo') {
      tmpFiles.push(args[0]);
      if (opts.noPdfinfo) return { code: 'ENOENT', stdout: '', stderr: '' };
      return { code: 0, stdout: `Pages:           ${opts.pages || 1}\n`, stderr: '' };
    }
    if (cmd === 'qpdf') return { code: 0, stdout: `${opts.qpdfPages || 1}\n`, stderr: '' };
    if (cmd === 'lp') { tmpFiles.push(args[args.length - 1]); return opts.lp || { code: 0, stdout: 'request id is EPSON_ET_8500_Series-42 (1 file(s))\n', stderr: '' }; }
    throw new Error('unexpected command ' + cmd);
  };
  const store = new Map();
  const artifacts = {
    get: (ref) => (store.has(ref) ? store.get(ref).rec : null),
    canRead: (p, ref) => store.has(ref) && store.get(ref).readers.includes(p.app),
    blobPath: (ref) => store.get(ref).file,
  };
  const addArtifact = (ref, buf, readers) => {
    const file = path.join(dir, ref.replace(/\W/g, '_') + '.blob');
    fs.writeFileSync(file, buf);
    store.set(ref, { rec: { id: ref, size: buf.length }, readers, file });
  };
  print._reset({ dir, exec, artifacts });
  return { dir, calls, tmpFiles, addArtifact, lpCalls: () => calls.filter((c) => c.cmd === 'lp') };
}

async function enable(h, patch = {}) {
  await print.saveSettings({ printer: PRINTER, enabled: true, allowedApps: ['gymihorst'], ...patch });
}

const b64 = (buf) => buf.toString('base64');

// ---- lpstat parser -----------------------------------------------------------

test('parser: the real lpstat output of this host', () => {
  const r = print.parsePrinters(fx('lpstat-p-d.host.txt'));
  assert.equal(r.defaultPrinter, null);
  assert.equal(r.printers.length, 1);
  assert.deepEqual({ name: r.printers[0].name, state: r.printers[0].state, online: r.printers[0].online }, { name: PRINTER, state: 'idle', online: true });
  assert.deepEqual(print.parseDevices(fx('lpstat-v.host.txt')), { [PRINTER]: 'implicitclass://EPSON_ET_8500_Series/' });
});

test('parser: zero printers ("No destinations added" / no default)', () => {
  const r = print.parsePrinters(fx('lpstat-p-d.none.stdout.txt') + fx('lpstat-p-d.none.stderr.txt'));
  assert.deepEqual(r, { printers: [], defaultPrinter: null });
  assert.deepEqual(print.parseDevices(''), {});
});

test('parser: disabled with reason, printing, and a default destination', () => {
  const r = print.parsePrinters(fx('lpstat-p-d.multi.txt'));
  assert.equal(r.defaultPrinter, 'Busy_One');
  assert.deepEqual(r.printers.map((p) => [p.name, p.state, p.online]), [['Disabled_One', 'disabled', false], ['Busy_One', 'printing', true]]);
  assert.equal(r.printers[0].reason, 'reason unknown');
  assert.equal(r.printers[1].job, 'Busy_One-7');
});

test('discover: zero printers is an empty list, a missing lpstat says so', async () => {
  const h = harness({ noPrinter: true });
  const d = await print.discover();
  assert.equal(d.cups, true); assert.deepEqual(d.printers, []); assert.equal(d.error, undefined);
  print._reset({ dir: h.dir, exec: () => ({ code: 'ENOENT', stdout: '', stderr: '' }) });
  const m = await print.discover();
  assert.equal(m.cups, false); assert.match(m.error, /not installed/);
});

test('parseJobId / parseJobIds', () => {
  assert.equal(print.parseJobId('request id is EPSON_ET_8500_Series-42 (1 file(s))\n'), 'EPSON_ET_8500_Series-42');
  assert.equal(print.parseJobId('garbage'), null);
  assert.deepEqual(print.parseJobIds('EPSON-3  hp  1024   Thu Nov 19 19:16:02 2026\nno entries\n'), ['EPSON-3']);
});

// ---- lp argument array -------------------------------------------------------

test('buildLpArgs: exact arrays, duplex, copies clamped, title sanitised', () => {
  const f = '/tmp/x.pdf';
  assert.deepEqual(print.buildLpArgs({ printer: PRINTER, copies: 1, duplex: false, title: 'Blatt', file: f }), ['-d', PRINTER, '-n', '1', '-t', 'Blatt', f]);
  assert.deepEqual(print.buildLpArgs({ printer: PRINTER, copies: 2, duplex: true, title: 'Blatt', file: f }), ['-d', PRINTER, '-n', '2', '-o', 'sides=two-sided-long-edge', '-t', 'Blatt', f]);
  assert.equal(print.buildLpArgs({ printer: 'p', copies: 0, title: 't', file: f })[3], '1');
  assert.equal(print.buildLpArgs({ printer: 'p', copies: -3, title: 't', file: f })[3], '1');
  assert.equal(print.buildLpArgs({ printer: 'p', copies: 99, title: 't', file: f })[3], '5');
  assert.equal(print.buildLpArgs({ printer: 'p', copies: 2.6, title: 't', file: f })[3], '3');
  assert.equal(print.buildLpArgs({ printer: 'p', copies: 'abc', title: 't', file: f })[3], '1');
  assert.equal(print.buildLpArgs({ printer: 'p', copies: undefined, title: 't', file: f })[3], '1');
});

test('sanitizeTitle: control chars stripped, length capped, never empty', () => {
  assert.equal(print.sanitizeTitle('a\r\nb\u0007c\u0000d'), 'a b c d');
  assert.equal(print.sanitizeTitle('  x  '), 'x');
  assert.equal(Array.from(print.sanitizeTitle('ä'.repeat(500))).length, 80);
  assert.equal(print.sanitizeTitle(''), 'Vistaclair');
  assert.equal(print.sanitizeTitle(undefined), 'Vistaclair');
  assert.equal(print.sanitizeTitle('-d other -o x'), '-d other -o x'); // one argument; never split by a shell
});

// ---- page counting -----------------------------------------------------------

test('page count: /Type /Page objects, not /Pages', () => {
  assert.equal(print.countPagesFallback(pdfWithPages(1)), 1);
  assert.equal(print.countPagesFallback(pdfWithPages(7)), 7);
  assert.equal(print.countPagesFallback(print.testPagePdf({ printer: 'x (y)' })), 1);
  assert.equal(print.countPagesFallback(Buffer.from('%PDF-1.4\n<< /Type /Pages /Count 3 >>')), 0);
});

test('page count: pdfinfo, then qpdf when pdfinfo is absent, then the scan', async () => {
  const buf = pdfWithPages(3);
  harness({ pages: 9 });
  assert.equal(await print.countPages('/tmp/a.pdf', buf), 9);
  harness({ noPdfinfo: true, qpdfPages: 4 });
  assert.equal(await print.countPages('/tmp/a.pdf', buf), 4);
  print._reset({ dir: os.tmpdir(), exec: () => ({ code: 'ENOENT', stdout: '', stderr: '' }) });
  assert.equal(await print.countPages('/tmp/a.pdf', buf), 3);
});

test('the generated test page is a real one-page A4 PDF', () => {
  const b = print.testPagePdf({ printer: 'P', when: new Date(0) });
  assert.ok(print.isPdf(b));
  assert.match(b.toString('latin1'), /\/MediaBox \[0 0 595 842\]/);
  assert.match(b.toString('latin1'), /startxref\n\d+\n%%EOF\n$/);
});

// ---- printing ----------------------------------------------------------------

test('pdf: prints with the exact lp array, removes the temp file, logs the job', async () => {
  const h = harness({ pages: 2 });
  await enable(h);
  const r = await print.printPdf('gymihorst', { pdfBase64: b64(pdfWithPages(2)), title: 'Übungsblatt\nMathe', copies: 2, duplex: true });
  assert.deepEqual(r, { ok: true, jobId: 'EPSON_ET_8500_Series-42', printer: PRINTER, pages: 2 });
  const lp = h.lpCalls();
  assert.equal(lp.length, 1);
  const a = lp[0].args;
  assert.deepEqual(a.slice(0, 7), ['-d', PRINTER, '-n', '2', '-o', 'sides=two-sided-long-edge', '-t']);
  assert.equal(a[7], 'Übungsblatt Mathe');
  assert.match(a[8], /vc-print-\d+-[0-9a-f]{12}\.pdf$/);
  for (const f of h.tmpFiles) assert.equal(fs.existsSync(f), false, 'temp file removed: ' + f);
  const st = await print.adminState();
  assert.equal(st.jobs[0].app, 'gymihorst'); assert.equal(st.jobs[0].ok, true); assert.equal(st.jobs[0].pages, 2); assert.equal(st.jobs[0].copies, 2);
  assert.equal(st.usage.gymihorst, 4);
});

test('pdf: without duplex the sides option is absent; the owner default applies when the call is silent', async () => {
  const h = harness();
  await enable(h);
  await print.printPdf('gymihorst', { pdfBase64: b64(pdfWithPages(1)), title: 't' });
  assert.ok(!h.lpCalls()[0].args.includes('-o'));
  await print.saveSettings({ duplex: true });
  await print.printPdf('gymihorst', { pdfBase64: b64(pdfWithPages(1)), title: 't' });
  assert.deepEqual(h.lpCalls()[1].args.slice(4, 6), ['-o', 'sides=two-sided-long-edge']);
  await print.printPdf('gymihorst', { pdfBase64: b64(pdfWithPages(1)), title: 't', duplex: false });
  assert.ok(!h.lpCalls()[2].args.includes('-o'));
});

test('pdf: the artifact path respects the app\'s read access', async () => {
  const h = harness();
  await enable(h);
  h.addArtifact('vc-artifact://art_1', pdfWithPages(1), ['gymihorst']);
  h.addArtifact('vc-artifact://art_2', pdfWithPages(1), ['someone-else']);
  const ok = await print.printPdf('gymihorst', { pdf: 'vc-artifact://art_1', title: 't' });
  assert.equal(ok.ok, true);
  const denied = await print.printPdf('gymihorst', { pdf: 'vc-artifact://art_2', title: 't' });
  assert.equal(denied.ok, false); assert.match(denied.error, /may not read/);
  const unknown = await print.printPdf('gymihorst', { pdf: 'vc-artifact://nope', title: 't' });
  assert.equal(unknown.ok, false);
  assert.equal(h.lpCalls().length, 1);
});

test('pdf: rejections never reach lp and never throw', async () => {
  const h = harness();
  const good = b64(pdfWithPages(1));
  const cases = [];

  // disabled (default state)
  cases.push([await print.printPdf('gymihorst', { pdfBase64: good, title: 't' }), /not enabled/]);

  await enable(h, { dailyPageCap: 3 });
  cases.push([await print.printPdf('other-app', { pdfBase64: good, title: 't' }), /not allowed/]);
  cases.push([await print.printPdf('gymihorst', { pdfBase64: b64(Buffer.from('hello world')), title: 't' }), /not a PDF/]);
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(print.MAX_PDF_BYTES + 1)]);
  cases.push([await print.printPdf('gymihorst', { pdfBase64: b64(big), title: 't' }), /20 MB/]);
  cases.push([await print.printPdf('gymihorst', { title: 't' }), /required/]);
  cases.push([await print.printPdf('gymihorst', { pdfBase64: good, title: 't', copies: 5 }), /daily page limit/]); // 5 pages > cap 3
  cases.push([await print.printPdf('gymihorst', null), /required/]);
  for (const [r, re] of cases) {
    assert.equal(r.ok, false); assert.equal(r.jobId, null); assert.match(r.error, re);
  }
  assert.equal(h.lpCalls().length, 0);
  assert.equal((await print.adminState()).usage.gymihorst, 0, 'a rejection costs no pages');
});

test('pdf: a printer CUPS no longer lists, and a disabled one, are refused', async () => {
  const h = harness();
  await enable(h);
  print._reset({ dir: h.dir, exec: (cmd, args) => (cmd === 'lpstat' && args[0] === '-p' ? { code: 1, stdout: fx('lpstat-p-d.none.stdout.txt'), stderr: fx('lpstat-p-d.none.stderr.txt') } : { code: 0, stdout: '', stderr: '' }) });
  const r = await print.printPdf('gymihorst', { pdfBase64: b64(pdfWithPages(1)), title: 't' });
  assert.equal(r.ok, false); assert.match(r.error, /not available/);
  assert.deepEqual(await print.status('gymihorst'), { available: false, printer: null, online: false, pagesLeftToday: null });

  const h2 = harness({ pOut: `printer ${PRINTER} disabled since Thu Nov 19 19:16:02 2026 -\n\treason unknown\nno system default destination\n` });
  await enable(h2);
  const r2 = await print.printPdf('gymihorst', { pdfBase64: b64(pdfWithPages(1)), title: 't' });
  assert.equal(r2.ok, false); assert.match(r2.error, /disabled/);
  assert.deepEqual(await print.status('gymihorst'), { available: true, printer: PRINTER, online: false, pagesLeftToday: 60 });
  assert.equal(h2.lpCalls().length, 0);
});

test('pdf: the daily cap counts pages x copies, a failed lp gives them back, a new local day resets', async () => {
  const h = harness({ pages: 2 });
  await enable(h, { dailyPageCap: 10 });
  const pdf = b64(pdfWithPages(2));
  const day1 = new Date(2026, 10, 19, 10, 0, 0);
  assert.equal((await print.printPdf('gymihorst', { pdfBase64: pdf, title: 't', copies: 3 }, day1)).ok, true); // 6
  assert.equal((await print.status('gymihorst', day1)).pagesLeftToday, 4);
  const over = await print.printPdf('gymihorst', { pdfBase64: pdf, title: 't', copies: 3 }, day1); // 6 > 4
  assert.equal(over.ok, false); assert.match(over.error, /daily page limit/);
  assert.equal((await print.printPdf('gymihorst', { pdfBase64: pdf, title: 't', copies: 2 }, day1)).ok, true); // 4 -> 0 left
  assert.equal((await print.status('gymihorst', day1)).pagesLeftToday, 0);
  const day2 = new Date(2026, 10, 20, 0, 5, 0);
  assert.equal((await print.status('gymihorst', day2)).pagesLeftToday, 10);

  const h2 = harness({ pages: 2, lp: { code: 1, stdout: '', stderr: 'lp: The printer or class does not exist.\n' } });
  await enable(h2, { dailyPageCap: 10 });
  const bad = await print.printPdf('gymihorst', { pdfBase64: pdf, title: 't' }, day1);
  assert.equal(bad.ok, false); assert.match(bad.error, /lp failed/);
  assert.equal((await print.status('gymihorst', day1)).pagesLeftToday, 10);
});

test('settings: persisted across a reload, validated, enabling needs a printer', async () => {
  const h = harness();
  await assert.rejects(print.saveSettings({ enabled: true }), /select a printer/);
  await assert.rejects(print.saveSettings({ printer: 'Nope' }), /not listed/);
  await assert.rejects(print.saveSettings({ dailyPageCap: -1 }), /dailyPageCap/);
  await assert.rejects(print.saveSettings({ allowedApps: ['bad name; rm -rf'] }), /invalid app name/);
  await enable(h, { dailyPageCap: 12, allowedApps: ['gymihorst', 'kids'] });
  print._reset({ dir: h.dir, exec: () => ({ code: 0, stdout: '', stderr: '' }) }); // "restart"
  const s = (await print.adminState()).settings;
  assert.deepEqual(s, { enabled: true, printer: PRINTER, allowedApps: ['gymihorst', 'kids'], dailyPageCap: 12, duplex: false });
  assert.deepEqual(print.DEFAULT_SETTINGS, { enabled: false, printer: null, allowedApps: ['gymihorst'], dailyPageCap: 60, duplex: false });
});

test('status: available only when enabled + listed + this app allowed', async () => {
  const h = harness();
  assert.equal((await print.status('gymihorst')).available, false); // off by default
  await enable(h);
  assert.deepEqual(await print.status('gymihorst'), { available: true, printer: PRINTER, online: true, pagesLeftToday: 60 });
  assert.deepEqual(await print.status('stranger'), { available: false, printer: null, online: false, pagesLeftToday: null });
});

test('test page: needs a printer, bypasses enabled/allow/cap, still checks the printer', async () => {
  const h = harness();
  assert.match((await print.testPage()).error, /select a printer/);
  await print.saveSettings({ printer: PRINTER }); // not enabled
  const r = await print.testPage();
  assert.equal(r.ok, true);
  assert.equal(h.lpCalls().length, 1);
  assert.equal(h.lpCalls()[0].args[5], 'Vistaclair Testseite');
  assert.equal((await print.adminState()).jobs[0].app, 'setup');
});

test('admin state: job status comes from lpstat -o / -W completed', async () => {
  const h = harness({ active: 'EPSON_ET_8500_Series-42  hp  1024   Thu Nov 19 19:16:02 2026\n' });
  await enable(h);
  await print.printPdf('gymihorst', { pdfBase64: b64(pdfWithPages(1)), title: 't' });
  assert.equal((await print.adminState()).jobs[0].status, 'active');
  const h2 = harness({ completed: 'EPSON_ET_8500_Series-42  hp  1024   Thu Nov 19 19:16:02 2026\n' });
  await enable(h2);
  await print.printPdf('gymihorst', { pdfBase64: b64(pdfWithPages(1)), title: 't' });
  assert.equal((await print.adminState()).jobs[0].status, 'completed');
});

test('the job log keeps the last 200, the panel shows 20', async () => {
  const h = harness();
  await enable(h);
  for (let i = 0; i < 25; i++) await print.printPdf('gymihorst', { pdfBase64: b64(Buffer.from('nope')), title: 'job ' + i });
  const st = await print.adminState();
  assert.equal(st.jobs.length, 20);
  assert.equal(st.jobs[0].title, 'job 24');
});

// ---- the capability ----------------------------------------------------------

test('ctx.print: the caller is the app, never a parameter', async () => {
  const h = harness();
  await enable(h);
  const ctx = capabilities.buildCtx({ name: 'gymihorst', dir: __dirname, manifest: {} });
  const other = capabilities.buildCtx({ name: 'other', dir: __dirname, manifest: {} });
  assert.deepEqual(Object.keys(ctx.print).sort(), ['pdf', 'status']);
  assert.equal((await ctx.print.status()).available, true);
  assert.equal((await other.print.status()).available, false);
  const r = await other.print.pdf({ pdfBase64: b64(pdfWithPages(1)), title: 't', app: 'gymihorst', appName: 'gymihorst' });
  assert.equal(r.ok, false); assert.match(r.error, /"other" is not allowed/);
  assert.equal((await ctx.print.pdf({ pdfBase64: b64(pdfWithPages(1)), title: 't' })).ok, true);
});

test('bridge: print.status / print.pdf resolve to the same engine with app.name', async () => {
  const h = harness();
  await enable(h);
  const status = capabilities.dispatch('print.status');
  const pdf = capabilities.dispatch('print.pdf');
  assert.equal((await status({ name: 'gymihorst' }, {}, {})).available, true);
  assert.equal((await pdf({ name: 'x' }, { pdfBase64: b64(pdfWithPages(1)), title: 't', app: 'gymihorst' }, {})).ok, false);
  assert.equal((await pdf({ name: 'gymihorst' }, { pdfBase64: b64(pdfWithPages(1)), title: 't' }, {})).ok, true);
});

test('the module is not in the standalone ctx, and owner methods are not app-facing', () => {
  const ctx = capabilities.buildCtx({ name: 'a', dir: __dirname, manifest: {} });
  for (const m of ['adminState', 'saveSettings', 'testPage', 'settings', 'printers', 'jobs']) assert.equal(ctx.print[m], undefined);
  const cap = capabilities.all().find((c) => c.key === 'print');
  assert.deepEqual(cap.methods, ['print.status', 'print.pdf']);
  assert.equal(cap.visibility.standalone, false);
});
