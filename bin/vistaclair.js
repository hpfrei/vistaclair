#!/usr/bin/env node
process.chdir(__dirname + '/..');

if (['help', '--help', '-h'].includes(process.argv[2])) {
  console.log(`Usage:
  vistaclair [port]         Start vistaclair (the supervisor runs the server; Ctrl-C stops it)
  vistaclair login-link     Print a one-time dashboard login URL (valid 5 minutes, single use)
                            Run it on the host while the server is running; it needs AUTH_TOKEN
                            from the environment or .env. The link signs a browser in without the
                            token; replace localhost with your public dashboard address if remote.
  vistaclair help           Show this help`);
  return;
}

if (process.argv[2] === 'login-link') {
  // `vistaclair login-link`: mint a one-time login URL from the host itself
  // (valid 5 minutes, single use; it signs the browser in without the token).
  // Requires the server to be running.
  require('dotenv').config();
  const port = parseInt(process.env.DASHBOARD_PORT || '3457');
  const token = process.env.AUTH_TOKEN;
  if (!token) {
    console.error('AUTH_TOKEN not found in environment/.env — cannot authenticate to the local server.');
    process.exit(1);
  }
  fetch(`http://127.0.0.1:${port}/api/login/login-link`, {
    method: 'POST',
    headers: { 'x-vistaclair-internal': token },
  })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      console.log('One-time login link (valid 5 minutes, single use):');
      console.log(`  http://localhost:${port}${body.path}`);
      console.log('Replace host with your public dashboard domain if accessing remotely.');
    })
    .catch((e) => {
      console.error(`Failed: ${e.message}. Is the server running on port ${port}?`);
      process.exit(1);
    });
  return;
}

// Local mode runs under the supervisor (restarts, rescue page); it hands
// server mode (VISTACLAIR_SERVER=1) straight to server.js.
require('./supervisor.js');
