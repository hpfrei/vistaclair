#!/usr/bin/env node
// App lint — the mechanically-checkable half of the platform's Architecture Rules
// and the migration guidance (`.vistaclair/migration.md`), as actual checks.
//
//   node src/apps/app-lint.js <appDir>        # defaults to cwd
//   node src/apps/app-lint.js <appDir> --json
//
// Why: those rules used to live only as prose in the build/change prompts, with no
// way for an agent to confirm it had followed them — and agents are (correctly)
// forbidden from starting the app, so they had no self-verification at all. This
// gives them a gate that needs no running server, using the same principle that
// makes the APP.md budget work: replace exhortation with measurement.
//
// `error` = a stated rule is broken. `warn` = a migration the platform now provides
// (very likely worth doing, but the app still works). Exit code 1 on any error.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SKIP_DIRS = new Set(['node_modules', '.git', '.data', '.vistaclair', 'dist', 'build', 'vendor', '.gradle']);
// At the app root only: `workspaces/` holds the cli.workspace folders —
// model-written files and large sources, the app's material, not its code.
const ROOT_SKIP_DIRS = new Set(['workspaces']);
const MINIFIED = /\.min\.(js|css)$/;

// Vendored third-party bundles are not the app's code and must not be linted — a
// bundled d3.js or three.js otherwise trips half the rules. Detected by shape
// rather than by name: a minified bundle has enormous lines, and a redistributed
// library carries a license/copyright banner up top.
function isVendored(src) {
  if (!src) return false;
  let max = 0;
  for (const line of src.split('\n')) if (line.length > max) max = line.length;
  if (max > 1000) return true;
  const head = src.slice(0, 600);
  return /@license|Copyright \d{4}|SPDX-License-Identifier/i.test(head)
    && /^\s*[!(]?function\s*\(|\bdefine\.amd\b|\btypeof exports\b/m.test(head);
}

// Rule 14 `tool-async-not-job` (see there).
const JOB_KIND_RE = /\bkind\s*:\s*['"`]job['"`]/;
const ASYNC_TEXT_RE = /\basynchronous(ly)?\b|\breturns? (immediately|at once|right away)\b|\breturns?\b[^.]{0,60}\bjob ?id\b|\bready shortly\b|\bruns? in the background\b/i;
// The tool's own `description:` / `returns:` lines, `+ '…'` continuations
// included (property descriptions sit inline in the inputSchema, not here),
// and its `name:` line for a one-line definition.
function asyncText(toolLines) {
  for (let i = 0; i < toolLines.length; i++) {
    if (i > 0 && !/^\s*(description|returns)\s*:/.test(toolLines[i])) continue;
    let text = toolLines[i];
    while (i + 1 < toolLines.length && /^\s*\+/.test(toolLines[i + 1])) text += toolLines[++i];
    if (ASYNC_TEXT_RE.test(text)) return true;
  }
  return false;
}
// The handler's own statement: the onToolCall line alone when it ends there,
// else up to the closing line at its indent (at most 80 lines).
function startsJob(lines, at) {
  let end = at + 1;
  if (!/\)\s*;?\s*$/.test(lines[at])) {
    const indent = lines[at].match(/^\s*/)[0];
    while (end < lines.length && end < at + 80 && !(lines[end].startsWith(`${indent}}`))) end++;
    end++;
  }
  const win = lines.slice(at, end).join('\n');
  return /\bjobs\.start\s*\(/.test(win) && /\bjobId\b/.test(win);
}

function walk(dir, out = [], root = true) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.gitignore') {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || (root && ROOT_SKIP_DIRS.has(e.name))) continue;
      walk(path.join(dir, e.name), out, false);
    } else if (e.isFile() && !MINIFIED.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// One duty, one implementation — the rule that keeps the three actors apart.
// The engine enforces, Horst judges, the owner decides, and that stays true
// only while each duty has a single implementation. An app that registers its
// own `email_send` kind, or hands platform sessions its own mail tool, is a
// second engine for an act the platform already governs: two sets of
// guardrails, two approval paths, and a decision ledger that sees half of what
// happened.
//
// The check has to read SOURCE, not the registry: registerKind namespaces every
// app kind to '<app>:<kind>', so at runtime the collision is invisible and only
// the literal in the call gives it away — which is exactly how this class of
// duplication survived the phase-8 migration unnoticed. Names are compared by
// their letters alone: 'email_send' and 'email.send' are one duty spelled
// twice.
//
// Exported because `lint:app` is not part of `npm test` (the build prompts
// invoke it), so the test run makes this one check over the installed apps
// directly rather than paying for the whole lint.
function dutyOverlaps(appDir) {
  const out = [];
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'manifest.json'), 'utf-8')); } catch {}
  // Only an app can duplicate the platform. The platform repo lints its own
  // source with the same walker, and it is the original, not a copy.
  if (!manifest || typeof manifest !== 'object') return out;

  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const kinds = new Map();
  const tools = new Map();
  try {
    const capabilities = require('./capabilities');
    for (const k of Object.keys(capabilities.horstKinds())) kinds.set(norm(k), k);
    for (const t of capabilities.horstTools()) tools.set(norm(t.def.name), t.def.name);
  } catch { return out; } // registry unavailable — the rule cannot run, and says nothing

  const files = walk(appDir).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const rel = path.relative(appDir, f);
    if (rel.startsWith(`public${path.sep}`)) continue; // browser code registers nothing
    let src;
    try { src = fs.readFileSync(f, 'utf-8'); } catch { continue; }
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('//')) continue;
      const k = lines[i].match(/registerKind\s*\(\s*['"`]([^'"`]+)['"`]/);
      if (k) {
        const hit = kinds.get(norm(k[1]));
        if (hit) {
          out.push({ file: rel, line: i + 1,
            message: `governance kind "${k[1]}" duplicates the platform kind "${hit}" — one act, one approval plane: stage it with ctx.governance.propose('${hit}', …) instead of registering a second kind for it` });
        }
      }
      // A tool's expose level sits at the end of its definition object, so the
      // name it belongs to is the nearest one above it.
      if (!/expose\s*:\s*['"`](platform|apps)['"`]/.test(lines[i])) continue;
      let name = null;
      for (let j = i; j >= Math.max(0, i - 25) && !name; j--) {
        const n = lines[j].match(/\bname\s*:\s*['"`]([^'"`]+)['"`]/);
        if (n) name = n[1];
      }
      const hit = name && tools.get(norm(name));
      if (hit) {
        out.push({ file: rel, line: i + 1,
          message: `tool "${name}" is exposed to platform sessions, but the platform already provides "${hit}" — Horst would pick one of two implementations at random. Drop the expose (leave it 'self' if the app's own AI needs the tool)` });
      }
    }
  }
  return out;
}

// The text of the `{ ... }` starting at src[open] (brace-balanced, string and
// comment aware enough for call arguments); null when unbalanced.
function balancedBraces(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2); if (i < 0) return null; i++;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

function lint(appDir) {
  const findings = [];
  const rel = (p) => path.relative(appDir, p) || path.basename(p);
  const add = (level, rule, file, line, message) =>
    findings.push({ level, rule, file: file ? rel(file) : '(app)', line: line || 0, message });

  const allFiles = walk(appDir);
  const readRaw = (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } };
  const vendored = new Set(allFiles.filter((f) => /\.js$/.test(f) && isVendored(readRaw(f))));
  const files = allFiles.filter((f) => !vendored.has(f));
  const read = readRaw;
  const jsFiles = files.filter((f) => f.endsWith('.js'));
  const isFrontend = (f) => rel(f).startsWith('public/');

  // The Telegram mini-app surface loads inside the Telegram webview: no owner
  // cookie, no /pro/app-runtime.js, no host overlays. Rules that assume the
  // platform runtime genuinely don't apply there, so an app-local `timeAgo` or a
  // `window.confirm` in that surface is correct, not a violation.
  const isTelegramSurface = (f) => {
    const r = rel(f);
    return r.startsWith('public/tg/') || /^public\/telegram[.\-]/.test(r)
      || r.startsWith('public/app/') || /^public\/app\.(html|css)$/.test(r);
  };

  // Scan a file's lines with a regex, reporting each hit.
  const scan = (file, src, re, cb) => {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (text.trimStart().startsWith('//')) continue;   // don't flag prose in comments
      re.lastIndex = 0;
      if (re.test(text)) cb(i + 1, text.trim());
    }
  };

  // ---- 1. syntax -----------------------------------------------------------
  for (const f of jsFiles) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (err) {
      const msg = String(err.stderr || err.message).split('\n').find((l) => /SyntaxError/.test(l)) || 'syntax error';
      add('error', 'syntax', f, 0, msg.trim());
    }
  }

  // ---- 2. platform runtime, not a per-app copy -----------------------------
  for (const f of files) {
    const base = path.basename(f);
    if ((base === 'bridge.js' || base === 'error-handler.js') && isFrontend(f)) {
      add('error', 'own-runtime', f, 0,
        `${base} duplicates the platform runtime — delete it and use /pro/app-runtime.js (Bridge, askAI, parseAIResponse, error handler)`);
    }
  }
  const indexHtml = files.find((f) => rel(f) === 'public/index.html');
  if (indexHtml) {
    const src = read(indexHtml) || '';
    if (!src.includes('/pro/app-runtime.js')) {
      add('error', 'own-runtime', indexHtml, 0,
        'index.html does not load /pro/app-runtime.js — the platform runtime is required');
    }
    if (/<script>[\s\S]{200,}<\/script>/.test(src)) {
      add('warn', 'inline-script', indexHtml, 0,
        'large inline <script> block — index.html should be markup only, with JS in a separate .js file');
    }
    if (/<style>[\s\S]{200,}<\/style>/.test(src)) {
      add('warn', 'inline-style', indexHtml, 0,
        'large inline <style> block — CSS belongs in style.css');
    }
  }

  // ---- 3. platform theme ---------------------------------------------------
  const styleCss = files.find((f) => rel(f) === 'public/style.css');
  if (styleCss) {
    const src = read(styleCss) || '';
    const firstReal = src.split('\n').find((l) => l.trim() && !l.trim().startsWith('/*'));
    if (!/@import\s+url\(['"]\/pro\/app-theme\.css['"]\)/.test(firstReal || '')) {
      add('error', 'theme-import', styleCss, 1,
        "style.css must start with @import url('/pro/app-theme.css');");
    }
    // Redefining a base token in :root overrides the platform theme app-wide.
    const rootBlock = src.match(/:root\s*\{([\s\S]*?)\}/);
    if (rootBlock) {
      const BASE = ['--bg', '--text', '--accent', '--border', '--bg-surface', '--text-dim', '--radius'];
      const hits = BASE.filter((v) => new RegExp(`^\\s*${v}\\s*:`, 'm').test(rootBlock[1]));
      if (hits.length) {
        add('error', 'theme-override', styleCss, 0,
          `redefines platform base token(s) ${hits.join(', ')} in :root — extend with new variables instead`);
      }
    }
  }

  // ---- 4. client-side polling (forbidden) ----------------------------------
  const POLL_BODY = /\b(apiFetch|fetch)\s*\(|Bridge\.call\s*\(\s*['"](exec|http\.fetch)['"]/;
  // setTimeout has legitimate non-polling uses that must not be flagged: a sleep
  // (`await new Promise(r => setTimeout(r, ms))`, e.g. rate limiting) and a timeout
  // guard (`setTimeout(() => ctl.abort(), ms)`). Only the timer *driving* the
  // request is polling.
  const TIMER_IDIOM = /new Promise\s*\(\s*\(?\s*\w*\s*\)?\s*=>\s*set(Timeout|Interval)|set(Timeout|Interval)\s*\(\s*\w+\s*,|abort\s*\(\s*\)|\.abort\b/;
  for (const f of jsFiles) {
    const src = read(f);
    if (!src) continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith('//')) continue;
      const isInterval = /setInterval\s*\(/.test(line);
      const isTimeout = /setTimeout\s*\(/.test(line);
      if (!isInterval && !isTimeout) continue;
      if (TIMER_IDIOM.test(line)) continue;         // sleep / abort guard, not a poll
      // Does the timer callback actually issue the request?
      const window = lines.slice(i, i + 8).join('\n');
      if (!POLL_BODY.test(window)) continue;
      if (isInterval) {
        add('error', 'client-polling', f, i + 1,
          "periodic refresh via setInterval + fetch/exec is forbidden — use cron.schedule + Bridge.on('cron:result'), spawn + Bridge.on('spawn:stdout'), or ctx.broadcaster");
      } else {
        add('warn', 'client-polling', f, i + 1,
          "setTimeout driving a fetch/exec — if this re-schedules itself it is client-side polling and is forbidden (use cron.schedule + Bridge.on('cron:result') or ctx.broadcaster). A one-shot retry/backoff is fine");
      }
    }
  }

  // ---- 5. dialogs ----------------------------------------------------------
  for (const f of jsFiles) {
    if (isTelegramSurface(f)) continue;   // no host overlays exist in that webview
    const src = read(f);
    if (!src) continue;
    scan(f, src, /\bwindow\.(confirm|prompt|alert)\s*\(|(?<![.\w])(confirm|alert)\s*\(\s*['"`]/, (line, text) => {
      // A guarded progressive-enhancement fallback is deliberate, not a violation:
      //   window.showConfirm ? window.showConfirm(msg) : window.confirm(msg)
      if (/showConfirm|showModal/.test(text)) return;
      add('error', 'native-dialog', f, line,
        'window.confirm/prompt/alert is forbidden — use showConfirm() / showModal(), or <vc-dialog> when the dialog must host vc-* components');
    });
  }
  for (const f of files.filter((x) => /\.(js|html|css)$/.test(x))) {
    const src = read(f);
    if (!src) continue;
    scan(f, src, /class=["'][^"']*\b(modal-backdrop|modal-overlay|dialog-backdrop)\b/, (line) => {
      add('warn', 'hand-rolled-modal', f, line,
        'hand-rolled modal backdrop — use showModal() (host overlay) or <vc-dialog> (in-iframe, can host vc-* components)');
    });
  }

  // ---- 6. duplicated runtime utilities -------------------------------------
  const DUP_UTILS = [
    [/function\s+escapeHtml\s*\(|const\s+escapeHtml\s*=/, 'escapeHtml'],
    [/function\s+timeAgo\s*\(|const\s+timeAgo\s*=/, 'timeAgo'],
    [/function\s+formatDate\s*\(|const\s+formatDate\s*=/, 'formatDate'],
    [/function\s+formatTime\s*\(|const\s+formatTime\s*=/, 'formatTime'],
    [/function\s+initTabs\s*\(|const\s+initTabs\s*=/, 'initTabs'],
  ];
  for (const f of jsFiles.filter(isFrontend).filter((x) => !isTelegramSurface(x))) {
    const src = read(f);
    if (!src) continue;
    for (const [re, name] of DUP_UTILS) {
      scan(f, src, re, (line) => {
        add('warn', 'duplicate-util', f, line,
          `app-local ${name}() — the platform runtime already provides it; delete this copy`);
      });
    }
  }

  // ---- 7. hand-rolled widgets the vc-* library covers ----------------------
  const WIDGETS = [
    [/\.(progress-fill|progressFill)\b[\s\S]{0,40}style\.width|style\.width\s*=\s*[^;]*(pct|percent|progress)/i,
      '<vc-progress> (set .value / .label)'],
    [/class=["'][^"']*\bempty-state\b/, '<vc-empty-state>'],
    [/Bridge\.call\s*\(\s*['"]ai\.models['"]|getModels\s*\(/, '<vc-model-picker> (with persist-key to remember the choice)'],
    [/getContext\s*\(\s*['"]2d['"][\s\S]{0,400}drawImage/, '<vc-media-viewer> (zoom/pan/lightbox built in)'],
    [/\bmarked\s*\(|\bmarkdownToHtml\s*\(/, '<vc-markdown>'],
  ];
  for (const f of files.filter((x) => /\.(js|html)$/.test(x)).filter(isFrontend).filter((x) => !isTelegramSurface(x))) {
    const src = read(f);
    if (!src) continue;
    for (const [re, suggestion] of WIDGETS) {
      // Multi-line patterns need a whole-file test, then a best-effort line number.
      if (re.source.includes('[\\s\\S]')) {
        const m = src.match(re);
        if (m) {
          const line = src.slice(0, m.index).split('\n').length;
          add('warn', 'hand-rolled-widget', f, line, `looks hand-rolled — prefer ${suggestion}`);
        }
      } else {
        scan(f, src, re, (line) => {
          add('warn', 'hand-rolled-widget', f, line, `looks hand-rolled — prefer ${suggestion}`);
        });
      }
    }
  }

  // ---- 8. forbidden dependencies -------------------------------------------
  const pkgPath = path.join(appDir, 'package.json');
  const pkgSrc = read(pkgPath);
  if (pkgSrc) {
    let pkg = null;
    try { pkg = JSON.parse(pkgSrc); } catch { add('error', 'syntax', pkgPath, 0, 'package.json is not valid JSON'); }
    if (pkg) {
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      const BANNED = {
        mariadb: 'use ctx.dbQuery() / Bridge.call(\'db.query\') — the platform provisions and owns the DB driver',
        mysql2: 'use ctx.dbQuery() / Bridge.call(\'db.query\')',
        imapflow: 'use the platform email engine (ctx.email.* / email.* bridge methods)',
        'node-imap': 'use the platform email engine (ctx.email.*)',
        nodemailer: 'use email.send / ctx.email.send',
        googleapis: 'use ctx.googleAuth / auth.google.* (and ctx.calendar for Calendar)',
        react: 'vanilla JS only',
        vue: 'vanilla JS only',
        jquery: 'vanilla JS only',
      };
      for (const [dep, why] of Object.entries(BANNED)) {
        if (deps[dep]) add('error', 'banned-dep', pkgPath, 0, `dependency "${dep}" is not allowed — ${why}`);
      }
    }
  }

  // ---- 9. AI auth mode + hardcoded OAuth redirect --------------------------
  for (const f of jsFiles) {
    const src = read(f);
    if (!src) continue;
    scan(f, src, /authMode\s*:\s*['"](?:subscription|apikey)['"]/, (line) => {
      add('warn', 'auth-mode', f, line,
        'a per-call authMode overrides the owner\'s platform-wide Claude credential choice (Models page) — remove it and let the call follow that setting');
    });
    scan(f, src, /redirect(_?uri|Uri)\s*[:=]\s*[`'"]https?:\/\/localhost/i, (line) => {
      add('error', 'hardcoded-redirect', f, line,
        'OAuth redirect URI must be derived from request headers (x-forwarded-proto / x-forwarded-host + ctx.basePath), never hardcoded to localhost');
    });
  }

  // ---- 10. BigInt serialization boundary -----------------------------------
  const routes = files.find((f) => rel(f) === 'routes.js');
  if (routes) {
    const src = read(routes) || '';
    // Only flag when a big-integer column actually exists: an explicit BIGINT, or a
    // platform id that is always one (Telegram/Discord ids, snowflakes). Firing on
    // "uses the DB at all" is noise — most apps have only INT primary keys.
    const bigintEvidence = src.match(/\bBIGINT\b/i)
      || src.match(/\b(chat|telegram|discord|guild|channel|snowflake|tg)_id\b/i);
    const hasReplacer = /typeof\s+\w+\s*===\s*['"]bigint['"]|BigInt\.prototype\.toJSON/.test(src);
    if (bigintEvidence && /res\.json\s*\(/.test(src) && !hasReplacer) {
      const line = src.slice(0, bigintEvidence.index).split('\n').length;
      add('warn', 'bigint-json', routes, line,
        `"${bigintEvidence[0]}" is a big-integer column and this file calls res.json() with no BigInt replacer — MariaDB returns BIGINT as JS BigInt, which JSON.stringify throws on (the route 500s and the UI shows a misleading generic error). Install the replacer once in a router.use() middleware`);
    }
  }

  // ---- 11. hand-rolled job tracking ---------------------------------------
  if (routes) {
    const src = read(routes) || '';
    const hasJobs = /ctx\.jobs\.start/.test(src);
    const MAP_RE = /(const|let|var)\s+(active|running|pending|current)[A-Z]\w*\s*=\s*(new\s+Map\(|\{\}|\[\])/;
    const m = src.match(MAP_RE);
    if (m && !hasJobs) {
      const line = src.slice(0, m.index).split('\n').length;
      add('error', 'own-job-tracking', routes, line,
        `in-memory operation tracking ("${m[2]}…") without ctx.jobs — this breaks the platform's GUI-reload-resilience rule (a reload orphans the operation). Use ctx.jobs.start() + frontend jobs.list / Bridge.subscribe('job:update')`);
    }
  }

  // ---- 12. exec/spawn with interpolated input ------------------------------
  for (const f of jsFiles) {
    const src = read(f);
    if (!src) continue;
    scan(f, src, /Bridge\.call\s*\(\s*['"](exec|spawn)['"]\s*,\s*\{\s*command\s*:\s*`[^`]*\$\{|ctx\.exec\s*\(\s*`[^`]*\$\{/, (line) => {
      add('warn', 'shell-interpolation', f, line,
        'shell command built by template interpolation — exec/spawn run with shell: true, so any caller-controlled value here is remote code execution. Pass a fixed command with args, or validate against an allowlist first (see Trust Model)');
    });
  }

  // ---- 13. APP.md presence + budget ---------------------------------------
  const appMd = files.find((f) => rel(f) === 'APP.md');
  if (!appMd) {
    add('error', 'appmd-missing', null, 0,
      'APP.md is missing — it is the single source of truth every future change session reads instead of the source');
  } else {
    const bytes = Buffer.byteLength(read(appMd) || '', 'utf8');
    const tokens = Math.round(bytes / 4);
    if (tokens > 8000) {
      add('error', 'appmd-budget', appMd, 0,
        `APP.md is ~${tokens.toLocaleString('en-US')} tokens, over the ~8,000 hard ceiling — compact it by moving detail into APP_<TOPIC>.md files (relocate, never delete an invariant)`);
    } else if (tokens > 6000) {
      add('warn', 'appmd-budget', appMd, 0,
        `APP.md is ~${tokens.toLocaleString('en-US')} tokens, over the ~6,000 target — compact the sections you touch as you go`);
    }
  }

  // ---- 14. tools without description/expose/returns/sideEffects -----------
  // The platform agent picks tools by their descriptions; an undescribed or
  // self-only reusable tool is invisible to it (Architecture D duty rules). A
  // tool exposed beyond this app is a contract for callers that cannot read its
  // code, so it also says what comes back (`returns`, preferably a JSON Schema)
  // and what it touches (`sideEffects`) — the inputSchema only says what goes in.
  //
  // A tool definition is a `name:` literal inside a `registerTools([...])`
  // block, or one whose object carries an `inputSchema` (tools kept in a const
  // array and registered by reference). Names in an `args:` object are
  // examples, not tools.
  const TOOL_NAME_RE = /name\s*:\s*['"]([a-z0-9_]+)['"]/;
  // A `registerTools([...])` array of a dozen tools is longer than any fixed
  // lookback window, so the block is tracked by its opening call and its closing
  // `]);` rather than by counting lines back — otherwise the rule only ever sees
  // the first two or three tools an app registers.
  const CLOSE_RE = /^\s*\]?\s*\)\s*;?\s*$/;
  const REGISTER_RE = /(?<!function\s+)\bregisterTools\s*\(/;
  const toolDefs = new Map(); // name → { file, line }
  const handlers = new Map(); // name → { file, line }
  let registersTools = false;
  let dynamicDefs = false;
  let dynamicHandlers = false;
  // Vendored-looking files (one line over 1000 chars is enough) are read for
  // the drift inventory too — an app's own routes.js can trip that heuristic —
  // but warned about only when they are the app's code.
  for (const f of allFiles.filter((x) => x.endsWith('.js'))) {
    if (isFrontend(f)) continue;
    const quiet = vendored.has(f);
    const src = read(f);
    if (!src) continue;
    const lines = src.split('\n');
    let inBlock = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('//')) continue;
      if (REGISTER_RE.test(lines[i])) { inBlock = true; registersTools = true; }
      const h = lines[i].match(/onToolCall\s*\(\s*(['"`]([a-z0-9_]+)['"`])?/);
      if (h) {
        if (h[2]) { if (!handlers.has(h[2])) handlers.set(h[2], { file: f, line: i + 1, startsJob: startsJob(lines, i) }); } else dynamicHandlers = true;
      }
      // A tool whose name is computed (mirrored from another server, built
      // from data) cannot be checked against the manifest or its handlers.
      if (/\bname\s*:\s*[A-Za-z_$][\w$.]*\s*[,}]/.test(lines[i]) && /\binputSchema\s*:/.test(lines.slice(i, i + 8).join('\n'))) dynamicDefs = true;
      const m = TOOL_NAME_RE.exec(lines[i]);
      if (CLOSE_RE.test(lines[i])) inBlock = false;
      if (!m) continue;
      if (/\bargs\s*:\s*\{[^}]*$/.test(lines[i].slice(0, m.index)) || /\bargs\s*:\s*\{\s*$/.test(lines[i - 1] || '')) continue;
      // `expose` and `returns` sit at the END of a tool definition, past the
      // inputSchema, so this window runs to the next tool rather than 12 lines.
      let end = i + 1;
      while (end < lines.length && end < i + 40 && !TOOL_NAME_RE.test(lines[end])) end++;
      const body = lines.slice(i, end).join('\n');
      const lineRest = lines[i].slice(m.index + m[0].length);
      if (!inBlock && !/\binputSchema\s*:/.test(TOOL_NAME_RE.test(lineRest) ? lineRest.slice(0, lineRest.search(TOOL_NAME_RE)) : body)) continue;
      if (!toolDefs.has(m[1])) {
        toolDefs.set(m[1], { file: f, line: i + 1, quiet, job: JOB_KIND_RE.test(body), asyncText: asyncText(lines.slice(i, end)) });
      }
      if (quiet) continue;
      const fwd = lines.slice(i, i + 12).join('\n');
      if (!/description\s*:/.test(fwd)) {
        add('warn', 'tool-description', f, i + 1,
          `tool "${m[1]}" has no description — the platform agent selects tools by description; an undescribed tool will be picked wrongly or never`);
      }
      if (!/expose\s*:\s*['"`](platform|apps)['"`]/.test(body)) continue;
      if (!/\breturns\s*:/.test(body)) {
        add('warn', 'tool-returns', f, i + 1,
          `tool "${m[1]}" is exposed beyond this app but has no \`returns\` — add a \`returns:\` JSON Schema of the result's structuredContent (or at least one line saying what the result object contains), so a caller that cannot read this app's code knows what it gets back`);
      } else if (/\breturns\s*:\s*['"`]/.test(body)) {
        add('warn', 'tool-returns-schema', f, i + 1,
          `tool "${m[1]}" is exposed beyond this app and its \`returns\` is prose — make it a JSON Schema of the result's structuredContent ({ type: 'object', properties, required }): the platform checks results against it and its contract hash tracks breaking changes`);
      }
      if (!/\bsideEffects\s*:/.test(body)) {
        add('warn', 'tool-side-effects', f, i + 1,
          `tool "${m[1]}" is exposed beyond this app but declares no \`sideEffects\` — say 'none' (read-only), 'writes' (changes this app's state) or 'external' (sends or spends outside); absent counts as 'writes'`);
      }
    }
  }

  // A tool that works in the background but is registered as a quick call:
  // a caller gets an id and never the result, and Horst cannot stage it as a
  // Start card. Signs, cheapest first: its own `description:` / `returns:`
  // lines say it runs asynchronously, returns immediately, returns a jobId, is
  // ready shortly after or runs in the background (ASYNC_TEXT_RE); or its
  // inline handler (`startsJob`) calls `jobs.start(` and mentions `jobId`.
  // Vendored-looking files are skipped, except routes.js (long prompt
  // strings trip that heuristic; the entry file is always the app's own).
  for (const [name, d] of toolDefs) {
    if (d.job || (d.quiet && path.basename(d.file) !== 'routes.js')) continue;
    const viaHandler = handlers.get(name) && handlers.get(name).startsJob;
    if (!d.asyncText && !viaHandler) continue;
    add('warn', 'tool-async-not-job', d.file, d.line,
      `tool "${name}" ${d.asyncText ? 'says it runs asynchronously / returns before the work is done' : 'starts ctx.jobs and returns the job id'} but is not registered as \`kind: 'job'\` — register it with kind: 'job' and return the finished result (the platform runs it as a job, reports progress, and delivers the outcome to the caller)`);
  }

  // ---- 14b. tool drift: manifest.tools ⇄ registerTools ⇄ onToolCall --------
  // A handler without a registered tool is never offered to any AI; a
  // registered tool without a handler fails every call; a manifest entry the
  // code never registers is a dead contract other apps and the catalog still
  // read (manifest.tools is rewritten only by a registration).
  {
    let manifest = null;
    try { manifest = JSON.parse(read(path.join(appDir, 'manifest.json')) || 'null'); } catch {}
    if (manifest && typeof manifest === 'object') {
      const mfile = path.join(appDir, 'manifest.json');
      const listed = (Array.isArray(manifest.tools) ? manifest.tools : []).filter((t) => t && typeof t.name === 'string');
      if (!registersTools) {
        for (const [name, at] of handlers) {
          add('warn', 'tool-drift', at.file, at.line,
            `onToolCall('${name}') but the app never calls ctx.registerTools — the tool is never offered to any AI or app; register it with a description and inputSchema`);
        }
        if (listed.length) {
          add('warn', 'tool-drift', mfile, 0,
            `manifest.tools lists ${listed.map((t) => t.name).join(', ')} but the code never calls ctx.registerTools — these entries are dead (no call can reach them) and stay until a registration rewrites them`);
        }
      } else {
        if (!dynamicDefs) {
          for (const [name, at] of handlers) {
            if (!toolDefs.has(name)) add('warn', 'tool-drift', at.file, at.line,
              `onToolCall('${name}') has no registered tool "${name}" — the handler is unreachable; add it to ctx.registerTools or remove it`);
          }
          const stale = listed.filter((t) => !toolDefs.has(t.name)).map((t) => t.name);
          if (stale.length) add('warn', 'tool-drift', mfile, 0,
            `manifest.tools lists ${stale.join(', ')}, which the code does not register — a stale contract until the next registration rewrites manifest.tools`);
        }
        if (!dynamicHandlers) {
          for (const [name, at] of toolDefs) {
            if (!handlers.has(name)) add('warn', 'tool-drift', at.file, at.line,
              `tool "${name}" is registered but has no ctx.onToolCall('${name}', …) handler — every call to it fails`);
          }
        }
      }
      // Examples are checked where registration recorded them: manifest.tools.
      let checkShallow = null;
      try { ({ checkShallow } = require('./app-tools')); } catch {}
      if (checkShallow) {
        for (const t of listed) {
          (Array.isArray(t.examples) ? t.examples : []).forEach((e, n) => {
            const problems = e && e.args && typeof e.args === 'object' ? checkShallow(t.inputSchema, e.args) : ['it has no args object'];
            if (problems.length) add('warn', 'tool-examples', mfile, 0,
              `tool "${t.name}" example ${n + 1} does not fit its inputSchema: ${problems.join('; ')} — an agent copies examples verbatim`);
          });
        }
      }
    }
  }

  // ---- 14c. undeclared app→app dependency -----------------------------------
  // A literal ctx.tools.call('<provider>', '<tool>') with no approved edge in
  // <dataHome>/app-deps.json (app-deps.js) is flagged at run time, or refused
  // when the owner enforces dependencies. Skipped without the edges file.
  {
    let edges = null;
    try { edges = require('./app-deps').readEdges({ appDir }); } catch {}
    if (edges) {
      let me = path.basename(appDir);
      try { me = JSON.parse(read(path.join(appDir, 'manifest.json')) || '{}').name || me; } catch {}
      const CALL_RE = /ctx\.tools\.call(?:AndWait)?\s*\(\s*(['"`])([\w.-]+)\1\s*,\s*(['"`])([\w.-]+)\3/g;
      const covered = (provider, tool) => edges.some((e) => e && e.consumer === me && e.provider === provider
        && e.status === 'approved' && Array.isArray(e.tools) && (e.tools.includes('*') || e.tools.includes(tool)));
      const seen = new Set();
      for (const f of jsFiles) {
        if (isFrontend(f)) continue;
        const lines = (read(f) || '').split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trimStart().startsWith('//')) continue;
          CALL_RE.lastIndex = 0;
          let m;
          while ((m = CALL_RE.exec(lines[i]))) {
            const [provider, tool] = [m[2], m[4]];
            if (provider === me || covered(provider, tool) || seen.has(`${provider}.${tool}`)) continue;
            seen.add(`${provider}.${tool}`);
            add('warn', 'tool-dependency', f, i + 1,
              `ctx.tools.call('${provider}', '${tool}') has no declared dependency — declare it: node ../../platform/scripts/app-change.js depend --on ${provider} --tools ${tool} --why "<why>" (an undeclared call is flagged, or refused when the owner enforces dependencies)`);
          }
        }
      }
    }
  }

  // ---- 15. autonomous AI initiative in event handlers ----------------------
  // Event-triggered AI (classifying arrivals, auto-drafting, background AI
  // sweeps) is the platform agent's lane. Apps consume platform intel (e.g.
  // the 'email-intel' annotation) instead of running their own model calls
  // from bus/engine event handlers.
  for (const f of jsFiles) {
    if (isFrontend(f)) continue;
    const src = read(f);
    if (!src) continue;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/ctx\.(email|calendar)\.on\s*\(\s*['"]/.test(lines[i])) continue;
      const window = lines.slice(i, i + 30).join('\n');
      if (/ctx\.aiPrompt\s*\(|Bridge\.call\s*\(\s*['"]ai\.prompt['"]/.test(window)) {
        add('warn', 'app-initiative', f, i + 1,
          'engine event handler reaching ctx.aiPrompt — autonomous AI initiative belongs to the platform agent (Horst). Consume platform intelligence (e.g. the email-intel annotation) or stage work via ctx.governance instead');
      }
    }
  }

  // ---- 15b. ai.prompt tool grants -------------------------------------------
  // A call without `allowedTools` gets NO tools (the platform default), so the
  // omission is usually a mistake only when the call wanted tools; say so
  // either way. A grant that includes Bash/Write/Edit lets the model act on
  // the host: flag it. Only calls whose argument is a literal object are
  // checked (a variable argument is the app's own business).
  for (const f of jsFiles) {
    const src = read(f);
    if (!src) continue;
    const re = /(?:\bctx\.aiPrompt|\bBridge\.call\s*\(\s*['"]ai\.prompt['"]\s*,|\bai\.prompt)\s*\(?\s*(\{)/g;
    let m;
    while ((m = re.exec(src))) {
      const open = m.index + m[0].length - 1;
      const body = balancedBraces(src, open);
      if (body === null) continue;
      const line = src.slice(0, m.index).split('\n').length;
      if (!/\ballowedTools\s*:/.test(body) && !/\.\.\./.test(body)) {
        add('warn', 'ai-no-allowed-tools', f, line,
          'no allowedTools: this call gets no tools; pass [] or an explicit list');
        continue;
      }
      const list = /\ballowedTools\s*:\s*\[([^\]]*)\]/.exec(body);
      if (list && /['"`](Bash|Write|Edit)(\(|['"`])/.test(list[1])) {
        add('warn', 'ai-risky-allowed-tools', f, line,
          'allowedTools includes Bash, Write or Edit: the model can run commands or change files on the host; grant it only if the app really needs it');
      }
    }
  }

  // ---- 16. a second implementation of a platform duty ----------------------
  for (const o of dutyOverlaps(appDir)) {
    add('error', 'duplicate-duty', path.join(appDir, o.file), o.line, o.message);
  }

  // ---- 17. an event emitted but never declared -----------------------------
  // An ERROR: the bus catalogs an undeclared kind as "discovered" (agenda-only,
  // no description), so other apps' authors, the Triggers view and the
  // cross-app change request learn nothing from it — a kind nobody can read is
  // not a published event. Known = every ctx.events.declare literal across the
  // app's server code ∪ manifest.events.emits. Only literal emits are checked;
  // an emit through a variable wrapper is the app's own business.
  {
    let manifest = null;
    try { manifest = JSON.parse(read(path.join(appDir, 'manifest.json')) || 'null'); } catch {}
    const appName = (manifest && typeof manifest.name === 'string' && manifest.name) || path.basename(appDir);
    const local = (k) => String(k).startsWith(appName + ':') ? String(k).slice(appName.length + 1) : String(k);
    let extract = null;
    try { ({ extractEventLiterals: extract } = require('./capabilities-infer')); } catch {} // lazy: infer requires this file
    if (extract) {
      const known = new Set(Object.keys((manifest && manifest.events && manifest.events.emits) || {}).map(local));
      const perFile = [];
      for (const f of jsFiles) {
        if (isFrontend(f)) continue;
        const src = read(f);
        if (!src) continue;
        const lit = extract(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1'));
        for (const d of lit.declares) known.add(local(d.kind));
        perFile.push({ f, src, emits: lit.emits });
      }
      for (const { f, src, emits } of perFile) {
        for (const e of emits) {
          if (known.has(local(e.kind))) continue;
          add('error', 'undeclared-event', f, src.slice(0, e.index).split('\n').length,
            `event "${e.kind}" is emitted but never declared — declare it via ctx.events.declare([{ kind, description }]) or manifest.events.emits so other apps and the Triggers view know what it means`);
        }
      }
    }
  }

  // ---- 18. a capability the code uses but the manifest never advertises ----
  // The advertisement gates nothing (open-world interior) — it is what the
  // docs inliner, the Spend panel and the MCP broker route on, so a stale one
  // misroutes them. `warn`, not `error`: the extractor matches `ctx.<member>`
  // roots textually and can pick up a name from a string or a stale branch.
  {
    let infer = null;
    try { ({ infer } = require('./capabilities-infer')); } catch {} // lazy: infer requires this file
    if (infer && fs.existsSync(path.join(appDir, 'manifest.json'))) {
      let missing = [];
      try { missing = infer(appDir).diff.add; } catch {}
      if (missing.length) {
        add('warn', 'stale-capabilities', path.join(appDir, 'manifest.json'), 0,
          `the app uses ${missing.join(', ')} but manifest.capabilities does not advertise ${missing.length > 1 ? 'them' : 'it'} — run \`node ../../platform/src/apps/capabilities-infer.js . --write\` to refresh capabilities and events`);
      }
    }
  }

  // ---- 19. a capability used without its section being inlined OR read ----
  // Every capability section is deferred to `.vistaclair/api/<key>.md` unless
  // the request mentioned it; the prompt carries only the index. A PreToolUse
  // hook records which of those files the session actually read
  // (`reads.jsonl`), so "you were told to read it first" stops being an
  // exhortation and becomes a check.
  //
  // Only NEW use is demanded. The launch snapshots per-file capability evidence
  // (`inlined.json.baseline`, from capabilities-infer `evidenceByFile`); a
  // capability counts here only where a file shows evidence the baseline did
  // not have — so an app that used `db` everywhere before this session does not
  // owe a `db` read for a one-line edit to routes.js. Without a baseline (an
  // older launcher) the tell falls back to the file's mtime against the launch
  // stamp.
  //
  // Reconciled the same way: a cross-app tool sidecar, the telegram-* DETAIL
  // surfaces, and the two bodies EVERY prompt defers — `scaffolds` (demanded of
  // a build session that wrote routes.js or public/) and `appmd-format`
  // (demanded of any session that wrote APP.md).
  //
  // Only inside a launched session: all three launcher-written files must be
  // present. Outside one (a manual `npm run lint:app`, test/duty-overlap) there
  // is no ledger to reconcile against and the rule is silent — never the other
  // way round, or an older core without `--settings` would fail every app.
  {
    const vc = path.join(appDir, '.vistaclair');
    const inlinedPath = path.join(vc, 'inlined.json');
    const ledgerPath = path.join(vc, 'reads.jsonl');
    const inSession = fs.existsSync(inlinedPath) && fs.existsSync(path.join(vc, 'hooks.json')) && fs.existsSync(ledgerPath);
    let infer = null; let evidenceByFile = null;
    try { ({ infer, evidenceByFile } = require('./capabilities-infer')); } catch {} // lazy: infer requires this file

    if (inSession && infer && fs.existsSync(path.join(appDir, 'manifest.json'))) {
      let inlinedDoc = {};
      try { inlinedDoc = JSON.parse(read(inlinedPath) || '{}') || {}; } catch {}
      const known = new Set();
      for (const k of inlinedDoc.keys || []) known.add(`api/${k}`);
      for (const line of (read(ledgerPath) || '').split('\n')) {
        if (!line.trim()) continue;
        try { known.add(JSON.parse(line).key); } catch {}
      }
      const readAll = known.has('all');   // the whole reference was read — every section with it

      const launchedAt = Date.parse(inlinedDoc.at || '') || 0;
      const writtenSince = (relPath) => {
        if (!launchedAt) return false;   // no stamp: nothing to compare against
        // The stamp has millisecond resolution, an mtime has more — so floor before
        // comparing, or a file written microseconds BEFORE the stamp reads as after it.
        try { return Math.floor(fs.statSync(path.join(appDir, relPath)).mtimeMs) > launchedAt; } catch { return false; }
      };
      const baseline = inlinedDoc.baseline && typeof inlinedDoc.baseline === 'object' ? inlinedDoc.baseline : null;

      // What the code uses now, per file, against what it used at launch. The
      // telegram-* and apps/<name> tells are DETAIL / cross-app sidecars whose
      // bodies are in NO prompt; they ride the same per-file evidence. A
      // cross-app sidecar is owed only when the launch actually wrote one.
      const TELL = {
        'telegram-miniapp': 'the cookieless `app` entry surface (`app.html` / `/api/app/` routes)',
        'telegram-identity': 'one identity across both contexts (`ctx.identity`)',
        'telegram-auth': 'the turnkey auth module (`/api/auth/*`)',
      };
      const used = new Map();   // sidecar key -> { why, file }
      try {
        const r = infer(appDir);
        for (const [file, keys] of Object.entries(evidenceByFile(r))) {
          const before = baseline ? (baseline[file] || []) : null;
          for (const key of keys) {
            const isNew = before ? !before.includes(key) : writtenSince(file);
            if (!isNew) continue;
            if (key.startsWith('apps/')) {
              if (fs.existsSync(path.join(vc, `${key}.md`))) used.set(key, { why: `calls ${key.slice(5)}'s tools`, file });
            } else if (TELL[key]) {
              used.set(`api/${key}`, { why: `builds on ${TELL[key]}`, file });
            } else if (r.used.has(key) && !used.has(`api/${key}`)) {
              used.set(`api/${key}`, { why: `uses \`${[...r.used.get(key).why][0] || key}\``, file });
            }
          }
        }
      } catch {}

      // Two prompt bodies are deferred to a pointer for EVERY session: the
      // scaffolds and the APP.md format. Neither is in the api reference, so
      // `all` does not cover them — only the ledger does. The tell is the file
      // the session wrote after the launch stamped `inlined.json`.
      const deferred = new Map();
      const wroteFrontend = () => files.some((f) => rel(f).startsWith('public/') && writtenSince(rel(f)));
      if (inlinedDoc.action === 'build' && (writtenSince('routes.js') || wroteFrontend())) {
        deferred.set('scaffolds', 'this build session wrote `routes.js` or files under `public/`');
      }
      if (writtenSince('APP.md')) deferred.set('appmd-format', 'this session wrote `APP.md`');
      // The lean orchestration-worker prompt (`inlined.json.profile`) defers the
      // APP.md maintenance block too: a worker that wrote APP.md owes that read.
      if (inlinedDoc.profile === 'worker' && writtenSince('APP.md')) deferred.set('appmd-maintenance', 'this worker wrote `APP.md` and its prompt defers the maintenance rules');

      const demand = (key, why) => {
        if (known.has(key)) return;
        add('error', 'unread-capability', path.join(appDir, 'manifest.json'), 0,
          `${why} but the \`${key}\` section was neither inlined into this session's prompt nor read — ` +
          `read \`.vistaclair/${key}.md\` (in this directory), then re-run app-lint`);
      };
      if (!readAll) {
        for (const [key, { why, file }] of used) demand(key, `\`${file}\` (written this session) ${why}`);
      }
      for (const [key, why] of deferred) demand(key, why);
    }
  }

  // ---- Access level (docs/apps.md "Access levels") ----------------
  // The auth block is the level; the cookieless surface is always `app`. An
  // anonymous /api/app/pub route in a private app is dead (nothing exempts it
  // without a login method).
  {
    let manifest = null;
    try { manifest = JSON.parse(read(path.join(appDir, 'manifest.json')) || 'null'); } catch {}
    if (manifest && typeof manifest === 'object') {
      const surfaces = require('./surfaces');
      const level = surfaces.accessLevel(manifest);
      const marker = manifest.surfaces && manifest.surfaces.user && manifest.surfaces.user.entry;
      if (marker && marker !== surfaces.ENTRY) {
        add('warn', 'access-level', path.join(appDir, 'manifest.json'), 0,
          `surfaces.user.entry "${marker}" is ignored — the entry surface is always "${surfaces.ENTRY}", derived from the auth block`);
      }
      if (manifest.public === true || (manifest.surfaces && manifest.surfaces.public && Array.isArray(manifest.surfaces.public.pages) && manifest.surfaces.public.pages.includes('**'))) {
        if (level !== 'open') add('error', 'access-level', path.join(appDir, 'manifest.json'), 0,
          'the manifest asks for the open level ("**" / public: true) AND declares a login channel — open never coexists with users; the "**" is ignored. Remove one of them.');
      }
      if (level === 'users' && !fs.existsSync(path.join(appDir, 'public', `${surfaces.ENTRY}.html`))) {
        add('warn', 'access-level', path.join(appDir, 'manifest.json'), 0,
          `access level is "users" (a login channel is declared) but public/${surfaces.ENTRY}.html is missing — app users have no cookieless entry page; the app root stays owner-gated until it exists`);
      }
      if (level === 'private') {
        for (const f of jsFiles) {
          if (isFrontend(f)) continue;
          const src = read(f) || '';
          const m = src.match(/['"`]\/api\/app\/pub\//);
          if (m) {
            add('error', 'access-level', f, src.slice(0, m.index).split('\n').length,
              'an anonymous /api/app/pub/* route in a PRIVATE app is unreachable (nothing is cookieless without a login channel) — declare the login channel in manifest.auth (level users) or drop the route');
            break;
          }
        }
      }
    }
  }

  return findings;
}

// ---- CLI --------------------------------------------------------------------

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const json = argv.includes('--json');
  const appDir = path.resolve(args[0] || process.cwd());

  if (!fs.existsSync(appDir)) {
    console.error(`app-lint: no such directory: ${appDir}`);
    return 2;
  }

  const findings = lint(appDir);
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  if (json) {
    console.log(JSON.stringify({ appDir, errors: errors.length, warnings: warns.length, findings }, null, 2));
    return errors.length ? 1 : 0;
  }

  if (!findings.length) {
    console.log(`app-lint: ${path.basename(appDir)} — clean (no rule violations, no migrations pending).`);
    return 0;
  }

  const order = { error: 0, warn: 1 };
  findings.sort((a, b) => order[a.level] - order[b.level] || a.file.localeCompare(b.file) || a.line - b.line);
  for (const f of findings) {
    const loc = f.line ? `${f.file}:${f.line}` : f.file;
    console.log(`${f.level === 'error' ? 'ERROR' : 'warn '}  ${loc}  [${f.rule}]\n         ${f.message}`);
  }
  console.log(`\napp-lint: ${errors.length} error(s), ${warns.length} warning(s) in ${path.basename(appDir)}.`);
  if (errors.length) console.log('Errors are stated platform rules — fix them before declaring the task done.');
  return errors.length ? 1 : 0;
}

// Exported BEFORE the CLI runs: rules 17 and 18 lazily require
// capabilities-infer, which requires `isVendored` back out of this file. With
// the assignment after main() the CLI handed it a half-built module and those
// two rules silently did nothing.
module.exports = { lint, isVendored, dutyOverlaps };

if (require.main === module) process.exit(main(process.argv.slice(2)));
