#!/usr/bin/env node
// Root `postinstall`: one `npm install` / `npm ci` at the root gives a working
// tree. The integrated MCP server (mcp-servers/integrated) has its own
// dependencies (@modelcontextprotocol/sdk, zod); src/mcp/index.js autoStart
// installs them at first boot, but anything that runs the server earlier (the
// test suite's ask-lifecycle bridge test, `lib/mcp-bridge.js`) needs them now.
// Skipped quietly when that folder already has a node_modules (a directory or
// a symlink). A failed install only warns: the first-boot install still runs.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'mcp-servers', 'integrated');
if (!fs.existsSync(path.join(dir, 'package.json'))) process.exit(0);
try { fs.lstatSync(path.join(dir, 'node_modules')); process.exit(0); } catch {}

console.log('  vistaclair: installing mcp-servers/integrated dependencies...');
const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--omit=dev', '--no-audit', '--no-fund'],
  { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
if (r.status !== 0) {
  console.warn('  vistaclair: could not install mcp-servers/integrated dependencies; run `npm install` there (first boot also tries).');
}
process.exit(0);
