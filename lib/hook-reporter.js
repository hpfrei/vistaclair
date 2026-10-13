#!/usr/bin/env node
// Hook reporter: reads Claude Code hook JSON from stdin, POSTs it to the
// dashboard and reproduces the answer — stdout, stderr and exit code — which is
// how the dashboard reaches a running session and its subagents (the pause flow,
// src/session-control.js). Most answers are empty. Invoked as a hook command by
// Claude Code; fails open: no dashboard, an error or a slow answer means exit 0
// with no output.
const http = require('http');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => data += c);
process.stdin.on('end', () => {
  const port = process.env.VISTACLAIR_DASHBOARD_PORT;
  const token = process.env.VISTACLAIR_AUTH_TOKEN;
  if (!port || !token) process.exit(0);
  const body = JSON.stringify({
    hookData: data,
    token,
    instanceId: process.env.VISTACLAIR_INSTANCE_ID || null,
  });
  const req = http.request({
    hostname: '127.0.0.1', port: parseInt(port, 10),
    path: '/api/hook-report', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    let out = '';
    res.setEncoding('utf8');
    res.on('data', c => out += c);
    res.on('end', () => {
      let answer = {};
      try { answer = out ? JSON.parse(out) : {}; } catch {}
      if (answer.stdout) process.stdout.write(answer.stdout);
      if (answer.stderr) process.stderr.write(answer.stderr);
      process.exit(answer.exitCode === 2 ? 2 : 0);
    });
  });
  req.on('error', () => process.exit(0));
  req.end(body);
});
setTimeout(() => process.exit(0), 3000);
