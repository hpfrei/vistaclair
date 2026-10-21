#!/usr/bin/env node
process.chdir(__dirname + '/..');

if (process.argv[2] === 'login-link') {
  // Break-glass: mint a one-time login URL from the host itself (works even
  // when Telegram login is unavailable). Requires the server to be running.
  require('dotenv').config();
  const port = parseInt(process.env.DASHBOARD_PORT || '3457');
  const token = process.env.AUTH_TOKEN;
  if (!token) {
    console.error('AUTH_TOKEN not found in environment/.env — cannot authenticate to the local server.');
    process.exit(1);
  }
  fetch(`http://127.0.0.1:${port}/api/tg-login/login-link`, {
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
