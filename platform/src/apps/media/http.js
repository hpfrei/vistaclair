// Shared HTTP helpers for the media adapters: auth headers, base64 input
// decoding, and the vendors' model-listing endpoints (one fetch per URL per
// refresh run — the TTS, transcribe and image adapters of one vendor share it).

const LIST_TIMEOUT_MS = 20000;

function bearer(key, json = true) {
  const h = { Authorization: `Bearer ${key}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

function googleHeaders(key) {
  return { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
}

// { data, mimeType } from a raw base64 string, a data: URI, or { data, mimeType }.
function decodeInline(img, fallbackMime) {
  let data, mimeType;
  if (img && typeof img === 'object') { data = img.data; mimeType = img.mimeType; }
  else if (typeof img === 'string') data = img;
  if (typeof data === 'string' && data.startsWith('data:')) {
    const comma = data.indexOf(',');
    const semi = data.indexOf(';');
    if (semi > 5 && !mimeType) mimeType = data.slice(5, semi);
    if (comma !== -1) data = data.slice(comma + 1);
  }
  if (!data) return null;
  return { data, mimeType: mimeType || fallbackMime };
}

function imageInputs(params) {
  const v = params.image;
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => decodeInline(x, 'image/png')).filter(Boolean);
}

async function getJson(url, headers, memo) {
  if (memo && memo.has(url)) return memo.get(url);
  const p = (async () => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`${res.status} ${t.slice(0, 200) || res.statusText}`);
    }
    return res.json();
  })();
  if (memo) memo.set(url, p);
  return p;
}

// OpenAI-style GET /v1/models → { ids, shutdown: { id: date } }.
async function listOpenAICompat(url, key, memo) {
  const body = await getJson(url, bearer(key, false), memo);
  const ids = [];
  const shutdown = {};
  for (const m of (body && body.data) || []) {
    if (!m || !m.id) continue;
    ids.push(m.id);
    if (m.shutdown_date) shutdown[m.id] = m.shutdown_date;
  }
  return { ids, shutdown };
}

// Gemini GET /v1beta/models → { ids } ("models/x" → "x").
async function listGemini(key, memo) {
  const body = await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', googleHeaders(key), memo);
  const ids = ((body && body.models) || []).map((m) => String(m.name || '').replace(/^models\//, '')).filter(Boolean);
  return { ids, shutdown: {} };
}

module.exports = { bearer, googleHeaders, decodeInline, imageInputs, getJson, listOpenAICompat, listGemini };
