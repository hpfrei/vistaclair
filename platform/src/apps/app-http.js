// SSRF-guarded outbound HTTP for apps — the `http` capability (http.fetch).
// Hostnames are resolved first and private/loopback targets refused; redirects
// are not followed (each hop would need its own check).

const dns = require('dns');
const { promisify } = require('util');

const dnsLookup = promisify(dns.lookup);

// --- SSRF protection for http.fetch ---

function isPrivateIP(ip) {
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
  }
  if (ip.startsWith('fd') || ip.startsWith('fe80') || ip === '::') return true;
  return false;
}

async function validateFetchUrl(urlStr) {
  let parsed;
  try { parsed = new URL(urlStr); } catch { throw new Error('Invalid URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked scheme: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname;
  if (isPrivateIP(hostname)) {
    throw new Error('Requests to private/loopback addresses are blocked');
  }
  try {
    const { address } = await dnsLookup(hostname);
    if (isPrivateIP(address)) {
      throw new Error('Requests to private/loopback addresses are blocked');
    }
  } catch (err) {
    if (err.message.includes('blocked')) throw err;
    throw new Error(`DNS lookup failed for ${hostname}: ${err.message}`);
  }
}

// The http.fetch bridge method. Resolves to the pre-module result shape
// { status, statusText, headers, body }; rejects with "Fetch failed: …".
async function fetchUrl({ url, options } = {}) {
  if (!url) throw new Error('No URL provided');
  try {
    await validateFetchUrl(url);
    const fetchOpts = {
      method: (options?.method || 'GET').toUpperCase(),
      headers: options?.headers || {},
      redirect: 'manual',
    };
    if (options?.body) fetchOpts.body = options.body;
    if (options?.timeout) {
      fetchOpts.signal = AbortSignal.timeout(options.timeout);
    }
    const res = await fetch(url, fetchOpts);
    const contentType = res.headers.get('content-type') || '';
    let body;
    if (contentType.includes('json')) {
      try { body = await res.json(); } catch { body = await res.text(); }
    } else {
      body = await res.text();
    }
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    return { status: res.status, statusText: res.statusText, headers, body };
  } catch (err) {
    throw new Error(`Fetch failed: ${err.message}`);
  }
}

module.exports = { isPrivateIP, validateFetchUrl, fetchUrl };
