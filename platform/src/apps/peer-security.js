// Shared guards for the federation code (peer-*.js): what a peer-supplied
// string may look like before it reaches git, the filesystem or a URL, the
// https-only rule for anything carrying the peer token, and the owner-only
// approval check for fleet kinds. Pure helpers, no state.
const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

function isAppName(v) { return typeof v === 'string' && APP_NAME_RE.test(v); }
function isHostname(v) { return typeof v === 'string' && HOSTNAME_RE.test(v); }

function isLoopbackHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// https:// anywhere, or http:// to a loopback host. Anything else (including a
// malformed URL) is not allowed to carry the peer token or a pairing request.
function isSecureUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && isLoopbackHost(u.hostname);
}

function assertSecureUrl(raw, what = 'URL') {
  if (!isSecureUrl(raw)) throw new Error(`${what} must be https:// (http:// is accepted only for localhost)`);
}

// A public URL a slave announces: parsed, no whitespace, <= 200 chars, no
// credentials/query/hash, https (or loopback http). Returns the normalised
// string without a trailing slash, or null.
function cleanPublicUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.length > 200 || /\s/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  if (!isSecureUrl(s)) return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

// governance `approveFrom` for every fleet kind: only the owner's own surfaces
// (dashboard, full card, Mini App, Telegram). An app holding the governance
// capability decides as `app:<name>` and is refused; so is any unknown surface.
const OWNER_SURFACES = new Set(['ui', 'ui-full', 'miniapp', 'telegram']);
function ownerOnlyApproveFrom(proposal, via) {
  if (OWNER_SURFACES.has(via)) return null;
  return `Fleet actions are approved only by the owner from the dashboard or Telegram, not via "${via}".`;
}

module.exports = {
  APP_NAME_RE, isAppName, isHostname, isLoopbackHost, isSecureUrl, assertSecureUrl, cleanPublicUrl,
  ownerOnlyApproveFrom, OWNER_SURFACES,
};
