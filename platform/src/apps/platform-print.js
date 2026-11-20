// platform-print — local printing through CUPS, for every app (`ctx.print`).
//
// The engine owns every rule; the capability module (capabilities/print.js)
// only narrows who is calling. Discovery is on demand (`lpstat`, no polling).
// Every CUPS command is an execFile argument array — nothing a caller wrote is
// ever part of a shell string. The state (settings, per-day page counts, job
// log) is one JSON file beside the other platform stores, so a reload of the
// dashboard or a restart loses nothing (docs/print.md).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_COPIES = 5;
const TITLE_MAX = 80;
const JOBS_KEPT = 200;
const USAGE_DAYS_KEPT = 8;
const EXEC_TIMEOUT_MS = 15000;
const APP_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  printer: null,
  allowedApps: ['gymihorst'],
  dailyPageCap: 60,
  duplex: false,
});

let appsDir = null;
let state = null; // { settings, usage: { 'YYYY-MM-DD': { app: pages } }, jobs: [] }
let runner = null; // test seam: (cmd, args) => Promise<{ code, stdout, stderr }>
let deps = {};     // test seam: { artifacts }

// ---- process ----------------------------------------------------------------

// Resolves, never rejects: a missing binary is code 'ENOENT'. LC_ALL=C pins the
// English lpstat wording the parser reads.
function run(cmd, args) {
  if (runner) return Promise.resolve(runner(cmd, args));
  return new Promise((resolve) => {
    childProcess.execFile(cmd, args, {
      timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout: stdout || '', stderr: stderr || '' });
      resolve({ code: err.code === 'ENOENT' ? 'ENOENT' : (typeof err.code === 'number' ? err.code : 1), stdout: stdout || '', stderr: stderr || err.message || '' });
    });
  });
}

// ---- state ------------------------------------------------------------------

function statePath() {
  if (!appsDir) throw new Error('platform-print not initialised');
  return path.join(appsDir, '.platform-print.json');
}

function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, allowedApps: DEFAULT_SETTINGS.allowedApps.slice() };
  if (!raw || typeof raw !== 'object') return s;
  if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled;
  if (typeof raw.printer === 'string' && raw.printer) s.printer = raw.printer;
  if (Array.isArray(raw.allowedApps)) s.allowedApps = [...new Set(raw.allowedApps.filter((a) => typeof a === 'string' && APP_RE.test(a)))].slice(0, 50);
  if (Number.isFinite(raw.dailyPageCap)) s.dailyPageCap = Math.max(0, Math.min(1000, Math.floor(raw.dailyPageCap)));
  if (typeof raw.duplex === 'boolean') s.duplex = raw.duplex;
  return s;
}

function load() {
  if (state) return state;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(statePath(), 'utf-8')) || {}; } catch { raw = {}; }
  state = {
    settings: sanitizeSettings(raw.settings),
    usage: raw.usage && typeof raw.usage === 'object' ? raw.usage : {},
    jobs: Array.isArray(raw.jobs) ? raw.jobs.slice(-JOBS_KEPT) : [],
  };
  return state;
}

function save() {
  const st = load();
  const keep = Object.keys(st.usage).sort().slice(-USAGE_DAYS_KEPT);
  for (const d of Object.keys(st.usage)) if (!keep.includes(d)) delete st.usage[d];
  if (st.jobs.length > JOBS_KEPT) st.jobs = st.jobs.slice(-JOBS_KEPT);
  const tmp = statePath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, statePath());
}

function init(options = {}) {
  if (!options.appsDir) throw new Error('platform-print.init requires appsDir');
  appsDir = options.appsDir;
  state = null;
  load();
}

// Tests only.
function _reset({ dir, exec, artifacts } = {}) {
  appsDir = dir || null;
  state = null;
  runner = exec || null;
  deps = artifacts ? { artifacts } : {};
}

// Local calendar day: the cap resets at the host's midnight.
function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function usedToday(app, now) {
  const u = load().usage[dayKey(now)] || {};
  return Number(u[app]) || 0;
}

function addUsage(app, pages, now) {
  const st = load();
  const k = dayKey(now);
  st.usage[k] = st.usage[k] || {};
  st.usage[k][app] = Math.max(0, (Number(st.usage[k][app]) || 0) + pages);
}

function pagesLeft(app, now) {
  const cap = load().settings.dailyPageCap;
  return Math.max(0, cap - usedToday(app, now));
}

// ---- CUPS discovery ---------------------------------------------------------

// `lpstat -p -d` → { printers: [{ name, state, online, job?, since?, reason? }], defaultPrinter }
// States: idle | printing | disabled | stopped | unknown. Pure; the fixtures in
// test/fixtures/lpstat-* are real output.
function parsePrinters(text) {
  const printers = [];
  let defaultPrinter = null;
  let last = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    let m;
    if ((m = /^printer (\S+) is idle\.(?:\s+enabled since (.+))?$/.exec(line))) {
      last = { name: m[1], state: 'idle', online: true, since: m[2] || null };
      printers.push(last);
    } else if ((m = /^printer (\S+) (?:now printing|is printing) (\S+?)\.(?:\s+enabled since (.+))?$/.exec(line))) {
      last = { name: m[1], state: 'printing', online: true, job: m[2], since: m[3] || null };
      printers.push(last);
    } else if ((m = /^printer (\S+) (?:disabled|is disabled) since (.+?)(?: -)?$/.exec(line))) {
      last = { name: m[1], state: 'disabled', online: false, since: m[2] };
      printers.push(last);
    } else if ((m = /^printer (\S+) (?:is )?stopped(?: since (.+?))?(?: -)?$/.exec(line))) {
      last = { name: m[1], state: 'stopped', online: false, since: m[2] || null };
      printers.push(last);
    } else if ((m = /^printer (\S+) /.exec(line))) {
      last = { name: m[1], state: 'unknown', online: true, since: null };
      printers.push(last);
    } else if (/^\s+\S/.test(line) && last && !last.reason && !last.online) {
      last.reason = line.trim().slice(0, 200);
    } else if ((m = /^system default destination: (\S+)\s*$/.exec(line))) {
      defaultPrinter = m[1];
    }
  }
  return { printers, defaultPrinter };
}

// `lpstat -v` → { NAME: deviceUri }
function parseDevices(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^device for (\S+): (.+?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// `lpstat -o` lines: `<printer>-<id> <user> <bytes> <date…>` → job ids.
function parseJobIds(text) {
  const ids = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(\S+-\d+)\s+\S+\s+\d+\s/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

// Never throws. `cups: false` when lpstat itself is missing. "No destinations
// added" (exit 1) is a normal empty list.
async function discover() {
  const p = await run('lpstat', ['-p', '-d']);
  if (p.code === 'ENOENT') return { cups: false, error: 'CUPS (lpstat) is not installed on this host', printers: [], defaultPrinter: null };
  const v = await run('lpstat', ['-v']);
  const parsed = parsePrinters(p.stdout);
  const devices = parseDevices(v.stdout);
  const printers = parsed.printers.map((x) => ({ ...x, device: devices[x.name] || null }));
  const noDest = /No destinations added/i.test(p.stderr + p.stdout);
  const out = { cups: true, printers, defaultPrinter: parsed.defaultPrinter };
  if (p.code !== 0 && !noDest && !printers.length) out.error = (p.stderr || p.stdout || 'lpstat failed').trim().slice(0, 200);
  return out;
}

// ---- PDF --------------------------------------------------------------------

function isPdf(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

// Page objects only (`/Type /Page`, never `/Pages`). Misses pages packed in
// compressed object streams — then it returns 0 and the caller refuses.
function countPagesFallback(buf) {
  const s = buf.toString('latin1');
  const m = s.match(/\/Type\s*\/Page(?![A-Za-z])/g);
  return m ? m.length : 0;
}

async function countPages(file, buf) {
  const info = await run('pdfinfo', [file]);
  if (info.code === 0) {
    const m = /^Pages:\s+(\d+)/m.exec(info.stdout);
    if (m && Number(m[1]) > 0) return Number(m[1]);
  }
  if (info.code === 'ENOENT') {
    const q = await run('qpdf', ['--show-npages', file]);
    if (q.code === 0 && /^\d+\s*$/.test(q.stdout) && Number(q.stdout) > 0) return Number(q.stdout);
  }
  return countPagesFallback(buf);
}

// The owner's test page: one A4 page, hand-written PDF (Helvetica, no deps).
function testPagePdf({ printer = '', when = new Date() } = {}) {
  const esc = (t) => String(t).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');
  const lines = [
    [24, 'Vistaclair - Testseite / Test page'],
    [12, 'Diese Seite wurde von Vistaclair Pro gedruckt.'],
    [12, 'This page was printed by Vistaclair Pro.'],
    [12, `Printer: ${printer}`],
    [12, `Time: ${when.toISOString()}`],
  ];
  let content = 'BT\n';
  let first = true;
  for (const [size, text] of lines) {
    content += `/F1 ${size} Tf\n${first ? '56 780 Td' : `0 -${size === 12 ? 22 : 34} Td`}\n(${esc(text)}) Tj\n`;
    first = false;
  }
  content += 'ET\n0.5 w 56 700 483 0 re S\n56 100 483 560 re S\n';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---- printing ---------------------------------------------------------------

function sanitizeTitle(t) {
  const s = String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, TITLE_MAX).join('') || 'Vistaclair';
}

function clampCopies(c) {
  const n = Math.round(Number(c));
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_COPIES, n)) : 1;
}

// The one argument array lp is run with.
function buildLpArgs({ printer, copies, duplex, title, file }) {
  const args = ['-d', printer, '-n', String(clampCopies(copies))];
  if (duplex) args.push('-o', 'sides=two-sided-long-edge');
  args.push('-t', sanitizeTitle(title), file);
  return args;
}

function parseJobId(text) {
  const m = /request id is (\S+) \(/.exec(String(text || ''));
  return m ? m[1] : null;
}

function artifacts() { return deps.artifacts || require('./app-artifacts'); }

// pdf bytes from a vc-artifact:// uri the app may read, or base64. Returns
// { buf } | { error }. Sizes are checked BEFORE the bytes are read or decoded.
function readInput(app, params) {
  if (params.pdf != null && params.pdf !== '') {
    if (typeof params.pdf !== 'string') return { error: 'pdf must be a vc-artifact:// uri string' };
    const store = artifacts();
    const self = { type: 'app', app };
    const rec = store.get(params.pdf);
    if (!rec || !store.canRead(self, params.pdf)) return { error: 'unknown artifact, or this app may not read it' };
    if (rec.size > MAX_PDF_BYTES) return { error: 'PDF is larger than 20 MB' };
    const file = store.blobPath(params.pdf);
    try { return { buf: fs.readFileSync(file) }; } catch { return { error: 'artifact bytes are not readable' }; }
  }
  if (typeof params.pdfBase64 === 'string' && params.pdfBase64) {
    const b64 = params.pdfBase64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (Math.floor(b64.length * 3 / 4) > MAX_PDF_BYTES) return { error: 'PDF is larger than 20 MB' };
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return { error: 'pdfBase64 is not valid base64' };
    return { buf: Buffer.from(b64, 'base64') };
  }
  return { error: 'pdf (a vc-artifact:// uri) or pdfBase64 is required' };
}

function logJob(entry) {
  const st = load();
  st.jobs.push({ id: crypto.randomBytes(4).toString('hex'), at: new Date().toISOString(), ...entry });
  save();
}

const fail = (error, extra = {}) => ({ ok: false, jobId: null, printer: null, pages: 0, error, ...extra });

// The shared print path. `opts.bypass` (Setup's test page only) skips the
// enabled switch, the allow list and the cap — never the printer check.
async function printBuffer(app, buf, { title, copies, duplex, bypass = false } = {}, now = new Date()) {
  const st = load();
  const s = st.settings;
  const rec = { app, title: sanitizeTitle(title), copies: clampCopies(copies), pages: 0, jobId: null, printer: null };
  const reject = (error) => { logJob({ ...rec, ok: false, error }); return fail(error, { pages: rec.pages }); };

  if (!bypass) {
    if (!s.enabled) return reject('printing is not enabled — the owner sets it up in Setup → Drucker');
    if (!s.allowedApps.includes(app)) return reject(`app "${app}" is not allowed to print`);
  }
  if (!s.printer) return reject('no printer selected');
  if (!isPdf(buf)) return reject('not a PDF (missing %PDF- header)');
  if (buf.length > MAX_PDF_BYTES) return reject('PDF is larger than 20 MB');

  const found = await discover();
  const printer = found.printers.find((p) => p.name === s.printer);
  if (!printer) return reject(`printer "${s.printer}" is not available`);
  rec.printer = printer.name;
  if (!printer.online) return reject(`printer "${printer.name}" is ${printer.state}`);

  const file = path.join(os.tmpdir(), `vc-print-${process.pid}-${crypto.randomBytes(6).toString('hex')}.pdf`);
  let reserved = 0;
  try {
    fs.writeFileSync(file, buf, { mode: 0o600 });
    rec.pages = await countPages(file, buf);
    if (!rec.pages) return reject('could not determine the page count of this PDF');
    const total = rec.pages * rec.copies;
    if (!bypass) {
      const left = pagesLeft(app, now);
      if (total > left) return reject(`daily page limit reached (${total} pages requested, ${left} left today)`);
      addUsage(app, total, now);
      reserved = total;
    }
    const useDuplex = duplex == null ? !!s.duplex : !!duplex;
    const r = await run('lp', buildLpArgs({ printer: printer.name, copies: rec.copies, duplex: useDuplex, title: rec.title, file }));
    if (r.code !== 0) {
      if (reserved) { addUsage(app, -reserved, now); reserved = 0; }
      return reject(`lp failed: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 200)}`);
    }
    rec.jobId = parseJobId(r.stdout);
    rec.duplex = useDuplex;
    logJob({ ...rec, ok: true });
    return { ok: true, jobId: rec.jobId, printer: printer.name, pages: rec.pages };
  } catch (err) {
    if (reserved) addUsage(app, -reserved, now);
    return reject(`print failed: ${String(err && err.message || err).slice(0, 200)}`);
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

// ---- app-facing -------------------------------------------------------------

async function status(app, now = new Date()) {
  const s = load().settings;
  const off = { available: false, printer: null, online: false, pagesLeftToday: null };
  if (!s.enabled || !s.printer || !s.allowedApps.includes(app)) return off;
  const found = await discover();
  const p = found.printers.find((x) => x.name === s.printer);
  if (!p) return off;
  save(); // persists the day rollover prune, cheap
  return { available: true, printer: p.name, online: p.online, pagesLeftToday: pagesLeft(app, now) };
}

async function printPdf(app, params = {}, now = new Date()) {
  try {
    const p = params && typeof params === 'object' ? params : {};
    const input = readInput(app, p);
    if (input.error) {
      logJob({ app, title: sanitizeTitle(p.title), copies: clampCopies(p.copies), pages: 0, jobId: null, printer: null, ok: false, error: input.error });
      return fail(input.error);
    }
    return await printBuffer(app, input.buf, { title: p.title, copies: p.copies, duplex: typeof p.duplex === 'boolean' ? p.duplex : null }, now);
  } catch (err) {
    return fail(String(err && err.message || err).slice(0, 200));
  }
}

// ---- owner / admin (Setup panel only) ---------------------------------------

async function adminState(now = new Date()) {
  const st = load();
  const found = await discover();
  const [active, done] = found.cups ? await Promise.all([run('lpstat', ['-o']), run('lpstat', ['-W', 'completed', '-o'])]) : [{ stdout: '' }, { stdout: '' }];
  const activeIds = new Set(parseJobIds(active.stdout));
  const doneIds = new Set(parseJobIds(done.stdout));
  const jobs = st.jobs.slice(-20).reverse().map((j) => ({
    ...j,
    status: !j.ok ? 'failed' : !j.jobId ? 'sent' : activeIds.has(j.jobId) ? 'active' : doneIds.has(j.jobId) ? 'completed' : 'unknown',
  }));
  const usage = {};
  for (const a of new Set([...st.settings.allowedApps, ...Object.keys(st.usage[dayKey(now)] || {})])) usage[a] = usedToday(a, now);
  return {
    cups: found.cups, error: found.error || null,
    printers: found.printers, defaultPrinter: found.defaultPrinter,
    settings: { ...st.settings, allowedApps: st.settings.allowedApps.slice() },
    selectedListed: !!st.settings.printer && found.printers.some((p) => p.name === st.settings.printer),
    usage, jobs,
  };
}

async function saveSettings(patch = {}) {
  const st = load();
  const next = { ...st.settings };
  if (patch.printer !== undefined) {
    if (patch.printer === null || patch.printer === '') next.printer = null;
    else {
      const found = await discover();
      if (!found.printers.some((p) => p.name === patch.printer)) throw new Error(`printer "${patch.printer}" is not listed by CUPS`);
      next.printer = patch.printer;
    }
  }
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.duplex !== undefined) next.duplex = !!patch.duplex;
  if (patch.dailyPageCap !== undefined) {
    const n = Number(patch.dailyPageCap);
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new Error('dailyPageCap must be a whole number from 0 to 1000');
    next.dailyPageCap = n;
  }
  if (patch.allowedApps !== undefined) {
    if (!Array.isArray(patch.allowedApps)) throw new Error('allowedApps must be a list of app names');
    const bad = patch.allowedApps.find((a) => typeof a !== 'string' || !APP_RE.test(a));
    if (bad !== undefined) throw new Error(`invalid app name "${String(bad).slice(0, 40)}"`);
    next.allowedApps = [...new Set(patch.allowedApps)].slice(0, 50);
  }
  if (next.enabled && !next.printer) throw new Error('select a printer before enabling printing');
  st.settings = next;
  save();
  return { ...next, allowedApps: next.allowedApps.slice() };
}

async function testPage(now = new Date()) {
  const s = load().settings;
  if (!s.printer) return fail('select a printer first');
  return printBuffer('setup', testPagePdf({ printer: s.printer, when: now }), { title: 'Vistaclair Testseite', copies: 1, duplex: false, bypass: true }, now);
}

module.exports = {
  init, status, printPdf, adminState, saveSettings, testPage,
  // exported for tests
  parsePrinters, parseDevices, parseJobIds, parseJobId, buildLpArgs, sanitizeTitle, clampCopies,
  countPagesFallback, countPages, isPdf, testPagePdf, dayKey, discover, _reset,
  MAX_PDF_BYTES, MAX_COPIES, DEFAULT_SETTINGS,
};
