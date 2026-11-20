// Mid-session spend cut for platform ai.prompt sessions.
//
// Pro's spend gate admits a session up front (ai.prompt → spendGate.authorize)
// and settles every request's cost from this proxy's interaction:complete
// broadcast. When that settle finds the app's or the user's cap exhausted, Pro
// writes a marker file (tmpdir, keyed by the session's instanceId — the same
// channel as the ai-tool-gate rule) and this rule refuses the session's NEXT
// request with an API-shaped error, so a runaway agent stops mid-session
// instead of at its next turn. Sessions without a marker are untouched.
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = function (ctx) {
  const id = ctx.instanceId;
  if (!id || !/^app-[A-Za-z0-9._-]+-ai-[a-f0-9]+$/.test(id)) return;

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), `vistaclair-ai-spend-${id}.json`), 'utf8'));
  } catch { return; }
  if (!marker || marker.blocked !== true) return;

  const message = `${marker.message || 'Spend cap reached'} [${marker.code || 'E_NO_CREDITS'}]`;
  ctx.interaction.status = 'error';
  ctx.interaction.response.status = 402;
  ctx.interaction.response.error = message;
  ctx.interaction.timing.ttfb = Date.now() - ctx.interaction.timing.startedAt;
  if (!ctx.res.headersSent) {
    ctx.res.writeHead(402, { 'content-type': 'application/json' });
    ctx.res.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message } }));
  }
  return true; // handled — the proxy records the interaction and stops here
};
