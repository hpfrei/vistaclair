// Start-up output and the boot auto-open. The permanent owner token never goes
// on a command line (every local user can read one) or into the log (a file
// others can read, and which the supervisor echoes): the browser is opened
// with a single-use login code (src/login.js one-time link), and the banner
// says where to get a login, never the token.

const BOOT_CODE_TTL_MS = 60 * 1000;

function openCommand(platform = process.platform) {
  return platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
}

// Opens the dashboard in the default browser with a fresh single-use code.
// → the opened URL (it carries only the code), for the caller that wants to
// show it; a failing opener is ignored.
function openDashboard({ port, login, execFile, platform = process.platform, ttlMs = BOOT_CODE_TTL_MS }) {
  const url = `http://localhost:${port}/login/once?k=${login.createOneTimeLink({ ttlMs })}`;
  try { execFile(openCommand(platform), [url], () => {}); } catch {}
  return url;
}

// The lines after the ports. `autoOpen`: a browser is being opened with a code.
// Without one and with a token the owner never saw (generated here, or by the
// supervisor), a single-use URL (5 minutes) is printed instead, so a login is
// possible; otherwise only a hint.
function loginLines({ tokenSource, supervised, autoOpen, login, port }) {
  const lines = [];
  if (autoOpen) {
    lines.push('  Login: opening your browser with a single-use login link.');
  } else if ((tokenSource === 'generated' || supervised) && login) {
    lines.push('  Login: single-use link (valid 5 minutes) — open it in this machine\'s browser:');
    lines.push(`    http://localhost:${port}/login/once?k=${login.createOneTimeLink()}`);
  }
  lines.push(tokenSource === 'env'
    ? '  Auth token: set through AUTH_TOKEN (not printed). `vistaclair login-link` prints a single-use login URL.'
    : '  Auth token: generated for this run (not printed). Set AUTH_TOKEN in .env to keep one.');
  return lines;
}

// Files that hold or have held the permanent token are owner-only (0600): the
// .env that sets AUTH_TOKEN, and the server log (older boots printed the token
// into it; the supervisor creates it group/world-readable). Best effort.
// → the paths whose mode was changed.
function tightenSecretFiles({ envFile, logDir }) {
  const fs = require('fs');
  const path = require('path');
  const changed = [];
  const tighten = (file) => {
    try {
      const st = fs.statSync(file);
      if (st.isFile() && (st.mode & 0o077)) { fs.chmodSync(file, 0o600); changed.push(file); }
    } catch {}
  };
  try {
    if (envFile && /^\s*(?:export\s+)?AUTH_TOKEN\s*=/m.test(fs.readFileSync(envFile, 'utf8'))) tighten(envFile);
  } catch {}
  try {
    for (const f of fs.readdirSync(logDir)) if (/^server\.log(\.\d+)?$/.test(f)) tighten(path.join(logDir, f));
  } catch {}
  return changed;
}

module.exports = { tightenSecretFiles, openDashboard, loginLines, openCommand, BOOT_CODE_TTL_MS };
