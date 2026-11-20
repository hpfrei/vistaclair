'use strict';
// descriptor.platformTools — what core's dashboard calls for voice input
// (core src/session-uploads.js → addons.platformTools()):
//   putArtifact(buffer, { mime, name }) → { uri }   an owner artifact, producer { platform: 'dashboard', tool: 'voice-input' }
//   call(tool, args) → MCP result                    a platform-pack tool, through callAppToolHandler
// Narrow on purpose: core names tools as `platform__<tool>`; only the tools in
// CALLABLE are reachable. The call is the owner's dashboard acting as the
// platform ({ type: 'platform' }, the caller of the platform pack's other
// owner-side calls), so the choke point's authorization, the audit and the
// platform spend policy apply as for any tool call.

const CALLABLE = new Set(['audio_transcribe']);
const PLATFORM_APP = '__platform__';
const PREFIX = 'platform__';

async function putArtifact(buffer, { mime, name } = {}) {
  const art = require('./app-artifacts');
  const view = await art.putPlatform(buffer, { mime, name }, { producer: { platform: 'dashboard', tool: 'voice-input' } });
  return { uri: view.uri };
}

async function call(tool, args) {
  const short = typeof tool === 'string' && tool.startsWith(PREFIX) ? tool.slice(PREFIX.length) : null;
  if (!short || !CALLABLE.has(short)) throw new Error(`platform tool "${tool}" is not available to the dashboard`);
  return require('./app-tools').callAppToolHandler(PLATFORM_APP, short, args || {}, { type: 'platform' });
}

module.exports = { putArtifact, call, CALLABLE };
