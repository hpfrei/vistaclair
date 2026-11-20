#!/usr/bin/env node
// Access report — what an app exposes and what it may use, from the admin's
// point of view (docs/apps.md "Access levels").
//
//   npm run access                 # every app
//   npm run access -- <app> [...]  # one or more apps
//   npm run access -- --json       # machine-readable (the app workflow's verify stage)
//
// Per app: the derived access level and its login channels, the exact paths
// reachable without the owner cookie, the /api/* prefixes that bypass app-auth's
// default-deny guard, where an anonymous visit to the root lands, the
// capabilities the admin revoked per deployment mode (with the ctx member names
// they remove), a stale entry marker if one lingers, and the lint findings that
// concern access. Needs no running server: it reads manifests, files and the
// spend-policy store exactly as the platform does at mount.
const fs = require('fs');
const path = require('path');

const PRO = path.join(__dirname, '..');
const coreDir = path.resolve(process.env.VISTACLAIR_CORE_DIR || path.join(PRO, '..'));
const addonHost = path.join(coreDir, 'src', 'addon-host.js');
if (!fs.existsSync(addonHost)) {
  console.error(`Core not found at ${coreDir} (set VISTACLAIR_CORE_DIR).`);
  process.exit(2);
}
const { createAddonCtx } = require(addonHost);
const host = createAddonCtx({ loadEnv: true });
const appsDir = process.env.VISTACLAIR_APPS_DIR || path.join(host.coreDir, 'vistaclair-apps');

const appManager = require(path.join(PRO, 'src/apps/app-manager'));
appManager.setAppsDir(appsDir);
const surfaces = require(path.join(PRO, 'src/apps/surfaces'));
const capabilities = require(path.join(PRO, 'src/apps/capabilities'));
const spendPolicy = require(path.join(PRO, 'src/apps/spend-policy'));
const deploymentMode = require(path.join(PRO, 'src/apps/deployment-mode'));
const lint = require(path.join(PRO, 'src/apps/app-lint'));
spendPolicy.init({ dataHome: host.dataHome });
deploymentMode.init({ appManager });

function report(name) {
  const dir = appManager.appDir(name);
  const manifest = appManager.readManifest(name);
  if (!manifest) return { app: name, error: 'no manifest' };
  const srf = surfaces.readSurfaces(manifest);
  const entryPage = fs.existsSync(path.join(dir, 'public', `${surfaces.ENTRY}.html`));
  const redirect = surfaces.rootRedirectTarget(manifest);
  const revoked = {};
  for (const mode of spendPolicy.MODES) {
    revoked[mode] = [...spendPolicy.revokedCapabilities(name, mode)].map((key) => {
      const cap = capabilities.get(key);
      return { key, ctx: cap ? cap.ctx : [] };
    });
  }
  let findings = [];
  try { findings = lint.lint(dir).filter((f) => f.rule === 'access-level'); } catch {}
  const notes = [];
  if (srf.level === 'users' && !entryPage) notes.push(`public/${surfaces.ENTRY}.html is missing — app users have no entry page; the root stays owner-gated`);
  const marker = manifest.surfaces && manifest.surfaces.user && manifest.surfaces.user.entry;
  if (marker && marker !== surfaces.ENTRY) notes.push(`surfaces.user.entry "${marker}" is ignored`);
  if (manifest.domain && srf.level === 'private') notes.push(`domain ${manifest.domain} is set but the app is private — visitors via that domain are blocked`);
  return {
    app: name,
    level: srf.level,
    channels: surfaces.loginMethods(manifest),
    licence: manifest.auth && manifest.auth.license ? (typeof manifest.auth.license === 'string' ? manifest.auth.license : manifest.auth.license.product || 'object') : null,
    domain: manifest.domain || null,
    display: manifest.display === 'fullscreen' ? 'fullscreen' : 'inline',
    cookieless: surfaces.describePatterns(name, manifest),
    guardExempt: surfaces.publicApiPrefixes(manifest),
    guardMounted: !!(manifest.auth && (manifest.auth.email || manifest.auth.telegram || manifest.auth.whatsapp || manifest.auth.license)),
    rootRedirect: redirect && !(redirect === `${surfaces.ENTRY}.html` && !entryPage) ? redirect : null,
    landing: srf.public.landing,
    pages: srf.public.pages.filter((g) => g !== '**'),
    revoked,
    entryMarker: marker || null,   // stale manifest declaration, if any — always ignored
    notes,
    findings: findings.map((f) => ({ level: f.level, file: f.file, message: f.message })),
  };
}

function print(r, currentMode) {
  if (r.error) { console.log(`${r.app}: ${r.error}\n`); return; }
  const chan = r.channels.length ? ` (${r.channels.join(', ')})` : '';
  console.log(`${r.app}  —  ${r.level.toUpperCase()}${chan}${r.licence ? ` · licence ${r.licence}` : ''}${r.domain ? ` · ${r.domain}` : ''} · ${r.display}`);
  const line = (k, v) => console.log(`  ${k.padEnd(18)}${v}`);
  line('cookieless', r.cookieless.length ? r.cookieless.join('\n' + ' '.repeat(20)) : '(nothing — owner cookie required everywhere)');
  line('guard', r.guardMounted ? `default-deny on /api/*; exempt: ${r.guardExempt.join(', ') || '(none)'}` : 'not mounted (no login channel)');
  line('root visit', r.rootRedirect ? `anonymous → ${r.rootRedirect}` : r.level === 'open' ? 'anonymous → index.html (open)' : 'anonymous → /login');
  for (const mode of Object.keys(r.revoked)) {
    const list = r.revoked[mode];
    line(`revoked (${mode})${mode === currentMode ? ' *' : ''}`, list.length ? list.map((x) => `${x.key} → ctx.${x.ctx.join(', ctx.')}`).join('; ') : '—');
  }
  for (const n of r.notes) console.log(`  ! ${n}`);
  for (const f of r.findings) console.log(`  ${f.level === 'error' ? 'ERROR' : 'warn '} ${f.file}: ${f.message}`);
  console.log('');
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const names = args.filter((a) => !a.startsWith('--'));
  const all = appManager.list().map((a) => a.name).sort();
  const targets = names.length ? names : all;
  const missing = targets.filter((n) => !all.includes(n));
  if (missing.length) { console.error(`unknown app(s): ${missing.join(', ')}`); process.exit(2); }
  const det = deploymentMode.detect();
  const reports = targets.map(report);
  if (json) { console.log(JSON.stringify({ mode: det.mode, apps: reports }, null, 2)); return; }
  console.log(`deployment mode: ${det.mode}${det.override ? ' (pinned)' : ''} — ${det.reason}\n`);
  for (const r of reports) print(r, det.mode);
  const errors = reports.reduce((n, r) => n + (r.findings || []).filter((f) => f.level === 'error').length, 0);
  process.exit(errors ? 1 : 0);
}

main();
