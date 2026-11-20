// Master side of "open a slave's dashboard" (Apps → Remote → Access).
// Asks the slave for a one-time login link (GET /api/peer/access?v=2) and
// builds the URL from the slave's own address plus the link's path.
//
// Version skew:
//   old slave (answers with its permanent `token`) → still works, the token is
//     shown with a warning that the slave is outdated;
//   old master → the new slave answers 426 (peer-server.js), never the token.

// → { ok, url, loginUrl?, expiresInMs?, token?, warning? } | { ok: false, error }
async function fetchAccess(client, peer) {
  let r;
  try {
    r = await client.call(peer, '/access?v=2', { timeoutMs: 10000 });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const base = String((typeof r?.url === 'string' && r.url) || peer.baseUrl || '').replace(/\/+$/, '');
  if (typeof r?.loginPath === 'string') {
    if (!/^\/login\/once\?k=[0-9a-f]{1,128}$/.test(r.loginPath) || !/^https?:\/\//i.test(base)) {
      return { ok: false, error: 'the slave sent a login link this master does not accept' };
    }
    return { ok: true, url: base, loginUrl: base + r.loginPath, expiresInMs: Number(r.expiresInMs) || null };
  }
  if (r?.token) {
    return {
      ok: true, url: base, token: r.token,
      warning: 'This slave is outdated: it still hands out its permanent dashboard token. Update vc on the slave to get one-time login links instead.',
    };
  }
  return { ok: true, url: base, warning: 'The slave offered no way to log in.' };
}

module.exports = { fetchAccess };
