// Platform credential headers never reach app code.
//
// Core accepts `x-vistaclair-internal` (its AUTH_TOKEN, loopback only) as owner
// credentials, and the platform sends other `x-vistaclair-*` secrets (peer
// token, poll secret, per-app cron signature). App code runs behind /apps/<name>
// and must not be able to read any of them: a compromised app would otherwise
// hold the owner's credential. Order at the dispatch point:
//
//   1. markOwner(req, isOwner)  — resolve the owner decision while the header
//      is still there; the result rides on the request object (`req._vcOwner`,
//      a non-header property no client can set), and is what
//      ctx.identity.resolve / spend attribution read afterwards.
//   2. strip(req)               — remove every `x-vistaclair-*` header.
//   3. hand the request to the app router / the proxy.

const PREFIX = 'x-vistaclair-';

function markOwner(req, isOwner) {
  let owner = false;
  try { owner = !!isOwner(req); } catch {}
  Object.defineProperty(req, '_vcOwner', { value: owner, configurable: true, writable: true, enumerable: false });
  return owner;
}

// Wrap core's isOwnerRequest so a request already resolved by markOwner stays
// owner after its credential header is gone.
function ownerAware(isOwner) {
  return (req) => (req && req._vcOwner === true) || isOwner(req);
}

function strip(req) {
  for (const k of Object.keys(req.headers)) if (k.startsWith(PREFIX)) delete req.headers[k];
  if (Array.isArray(req.rawHeaders)) {
    const out = [];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      if (!req.rawHeaders[i].toLowerCase().startsWith(PREFIX)) out.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
    req.rawHeaders.length = 0;
    req.rawHeaders.push(...out);
  }
}

// For a plain header map (the proxy's forwarded copy).
function stripMap(headers) {
  for (const k of Object.keys(headers)) if (k.toLowerCase().startsWith(PREFIX)) delete headers[k];
  return headers;
}

module.exports = { markOwner, ownerAware, strip, stripMap };
