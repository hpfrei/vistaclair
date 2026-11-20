// Environment additions for a shell that pro itself starts (ctx exec / spawn,
// app-scoped cron shell jobs): the local API proxy URL, plus the proxy caller
// secret core hands to its own sessions. The proxy attaches stored non-Anthropic
// provider keys only for a caller that sends the secret header; the Claude CLI
// sends it from ANTHROPIC_CUSTOM_HEADERS (same newline-separated format as core's
// buildClaudeEnv). Under an older host that does not provide the secret, no
// header is added. The secret is never logged.

const { core: coreServices } = require('./core-services');

function proxyEnv(baseEnv, port, core = coreServices) {
  const env = { ANTHROPIC_BASE_URL: `http://localhost:${port != null ? port : core.proxyPort}` };
  const header = core.proxySecretHeader;
  if (typeof core.getProxySecret !== 'function' || typeof header !== 'string' || !header) return env;
  let secret;
  try { secret = core.getProxySecret(); } catch { return env; }
  if (typeof secret !== 'string' || !secret) return env;
  const prefix = `${header.toLowerCase()}:`;
  const kept = String((baseEnv || {}).ANTHROPIC_CUSTOM_HEADERS || '').split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().toLowerCase().startsWith(prefix));
  kept.push(`${header}: ${secret}`);
  env.ANTHROPIC_CUSTOM_HEADERS = kept.join('\n');
  return env;
}

module.exports = { proxyEnv };
