// Response hardening for everything served under /apps/<name>/ (docs/apps.md
// "Response headers"). Apps without a custom domain share the dashboard's
// origin, so an app response must never hand out the owner's auth cookies, and
// gets two cheap isolation headers. Applied at the point headers are flushed
// (res.writeHead, which node's implicit header path calls too), so it covers
// the in-process router, the own-process proxy (index.js proxyToApp passes the
// upstream headers straight to writeHead), static files and error pages alike.
// No broad CSP: it breaks apps. WebSocket upgrades never reach a router.

// core server.js authCookie names
const AUTH_COOKIES = new Set(['sid', 'token']);

const NOSNIFF = 'nosniff';
// A separate header, never merged into an app's own CSP: browsers enforce every
// Content-Security-Policy header they receive.
const EXTRA_CSP = "frame-ancestors 'self' https://web.telegram.org; base-uri 'self'";

// One Set-Cookie value may carry several comma-joined cookies; a comma inside
// an Expires date is not followed by `name=`.
// (a nameless `=sid=x` piece counts as a cookie start too).
const COOKIE_SPLIT = /,(?=\s*[^;,\s]*=)/;

// Dropped: the auth names, and any cookie with an empty name. RFC 6265bis
// browsers store `=sid=EVIL` as a nameless cookie and send it as `sid=EVIL`,
// which core's cookie parser reads as the auth cookie.
function isAuthCookie(cookie) {
  const pair = cookie.split(';', 1)[0];
  const eq = pair.indexOf('=');
  if (eq < 0) return false;
  const name = pair.slice(0, eq).trim().replace(/^["']+|["']+$/g, '');
  return name === '' || AUTH_COOKIES.has(name) || /^=?\s*["']?\s*(sid|token)\s*["']?\s*=/.test(pair.trim());
}

// A Set-Cookie header value (string or array) without the auth cookies; the
// same shape back, or undefined when nothing is left.
function stripAuthCookies(value) {
  if (value == null) return value;
  const list = [];
  for (const v of Array.isArray(value) ? value : [value]) {
    for (const c of String(v).split(COOKIE_SPLIT)) if (!isAuthCookie(c)) list.push(c);
  }
  if (!list.length) return undefined;
  return Array.isArray(value) ? list : list.join(',');
}

// Apply the policy to a header map { lowercased name: value } in place.
function hardenMap(h) {
  if ('set-cookie' in h) {
    const kept = stripAuthCookies(h['set-cookie']);
    if (kept === undefined) delete h['set-cookie']; else h['set-cookie'] = kept;
  }
  if (h['x-content-type-options'] == null) h['x-content-type-options'] = NOSNIFF;
  const csp = h['content-security-policy'];
  if (csp == null) h['content-security-policy'] = EXTRA_CSP;
  else {
    const list = Array.isArray(csp) ? csp : [csp];
    if (!list.includes(EXTRA_CSP)) h['content-security-policy'] = [...list, EXTRA_CSP];
  }
  return h;
}

// Informational (1xx) responses carry headers too (103 Early Hints): only the
// Set-Cookie policy applies. Strips a headers object or flat [name, value, ...].
function stripInformational(given) {
  const drop = (v) => stripAuthCookies(v);
  if (Array.isArray(given)) {
    const out = [];
    for (let i = 0; i + 1 < given.length; i += 2) {
      if (String(given[i]).toLowerCase() !== 'set-cookie') { out.push(given[i], given[i + 1]); continue; }
      const kept = drop(given[i + 1]);
      if (kept !== undefined) out.push(given[i], kept);
    }
    return out;
  }
  if (given && typeof given === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(given)) {
      if (k.toLowerCase() !== 'set-cookie') { out[k] = v; continue; }
      const kept = drop(v);
      if (kept !== undefined) out[k] = kept;
    }
    return out;
  }
  return given;
}

function wrap(res) {
  const writeHead = res.writeHead;
  const writeEarlyHints = res.writeEarlyHints;
  if (typeof writeEarlyHints === 'function') {
    res.writeEarlyHints = function (hints, ...rest) {
      return writeEarlyHints.call(this, stripInformational(hints), ...rest);
    };
  }
  res.writeHead = function (status, ...rest) {
    if (res.headersSent) return writeHead.call(this, status, ...rest);
    if (status < 200) {
      const hi = typeof rest[0] === 'string' ? 1 : 0;
      if (rest[hi] !== undefined) rest[hi] = stripInformational(rest[hi]);
      const own = res.getHeader('set-cookie');
      if (own !== undefined) {
        const kept = stripAuthCookies(own);
        if (kept === undefined) res.removeHeader('set-cookie'); else res.setHeader('set-cookie', kept);
      }
      return writeHead.call(this, status, ...rest);
    }
    const hi = typeof rest[0] === 'string' ? 1 : 0; // writeHead(status[, message][, headers])
    const given = rest[hi];
    // Fold what the app set so far and what it passes here into one map; the
    // headers argument (the proxy's upstream headers) is then spent on it.
    const map = { ...res.getHeaders() };
    if (Array.isArray(given)) { // flat [name, value, ...]; a repeated name becomes a list
      for (let i = 0; i + 1 < given.length; i += 2) {
        const k = String(given[i]).toLowerCase();
        map[k] = k in map ? [].concat(map[k], given[i + 1]) : given[i + 1];
      }
    } else if (given && typeof given === 'object') {
      for (const [k, v] of Object.entries(given)) map[k.toLowerCase()] = v;
    }
    hardenMap(map);
    for (const k of Object.keys(res.getHeaders())) res.removeHeader(k);
    for (const [k, v] of Object.entries(map)) res.setHeader(k, v);
    return writeHead.call(this, status, ...rest.slice(0, hi));
  };
}

// Mounted first under /apps in index.js.
function middleware() {
  return (req, res, next) => { wrap(res); next(); };
}

module.exports = { middleware, stripAuthCookies, stripInformational, hardenMap, EXTRA_CSP, NOSNIFF };
