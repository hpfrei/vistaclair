#!/usr/bin/env node
// Orchestration hook: reads Claude Code hook JSON from stdin, asks the dashboard
// what to do (src/orchestration.js handleHook) and reproduces its answer —
// stdout, stderr and exit code. Installed for every event by an orchestration
// session's --settings file. Fails open: no dashboard, an error or a slow answer
// means exit 0 with no output, so a session is never stuck on its hook.
const http = require('http');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => data += c);
process.stdin.on('end', () => {
  const port = process.env.VISTACLAIR_DASHBOARD_PORT;
  const token = process.env.VISTACLAIR_AUTH_TOKEN;
  const instanceId = process.env.VISTACLAIR_INSTANCE_ID;
  if (!port || !token || !instanceId) process.exit(0);
  let input;
  try { input = JSON.parse(data); } catch { process.exit(0); }
  const body = JSON.stringify({ instanceId, input });
  const req = http.request({
    hostname: '127.0.0.1', port: parseInt(port, 10),
    path: '/api/orchestration/hook', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Vistaclair-Internal': token,
    },
  }, (res) => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', c => out += c);
    res.on('end', () => {
      let answer = {};
      try { answer = JSON.parse(out); } catch {}
      if (answer.stdout) process.stdout.write(answer.stdout);
      if (answer.stderr) process.stderr.write(answer.stderr);
      process.exit(answer.exitCode === 2 ? 2 : 0);
    });
  });
  req.on('error', () => process.exit(0));
  req.end(body);
});
setTimeout(() => process.exit(0), 4000);
