// Brave Web Search for apps — the `web-search` capability (ai.webSearch) and
// ctx.webSearch. Key comes from the 'brave-search' provider key (set in Apps →
// AI Config). Independent service — no Google-key fallback.

const spawnManager = require('./spawn-manager');
const { core } = require('./core-services');

function _braveKey() {
  const apiKey = core.resolveProviderKey('brave-search');
  if (!apiKey) throw new Error('Brave Search API key not configured. Add it in Apps → AI Config (free tier at brave.com/search/api).');
  return apiKey;
}

// Web search via the Brave Search API. params.query (or q) is required.
// Optional passthrough: count (1-20), offset, country, searchLang, freshness
// ('pd'|'pw'|'pm'|'py' or a date range), safesearch ('off'|'moderate'|'strict'),
// resultFilter (e.g. 'web,news'), extraSnippets, spellcheck.
async function aiWebSearch(appName, params) {
  const apiKey = _braveKey();
  const p = params || {};
  const query = p.query || p.q;
  if (!query || typeof query !== 'string') throw new Error('query is required');

  const q = new URLSearchParams({ q: query });
  if (p.count !== undefined) q.set('count', String(Math.min(Math.max(1, p.count), 20)));
  if (p.offset !== undefined) q.set('offset', String(p.offset));
  if (p.country) q.set('country', p.country);
  if (p.searchLang || p.search_lang) q.set('search_lang', p.searchLang || p.search_lang);
  if (p.freshness) q.set('freshness', p.freshness);
  if (p.safesearch) q.set('safesearch', p.safesearch);
  if (p.resultFilter || p.result_filter) q.set('result_filter', p.resultFilter || p.result_filter);
  if (p.extraSnippets || p.extra_snippets) q.set('extra_snippets', 'true');
  if (p.spellcheck === false) q.set('spellcheck', 'false');

  let res;
  try {
    res = await fetch(`https://api.search.brave.com/res/v1/web/search?${q}`, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      signal: AbortSignal.timeout(p.timeout || 30000),
    });
  } catch (err) {
    throw new Error(`Web search request failed: ${err.message}`);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (res.status === 429) throw new Error('Web search failed (429): Brave Search rate limit or monthly quota exceeded.');
    if (res.status === 401 || res.status === 403) throw new Error(`Web search failed (${res.status}): Brave Search API key invalid or subscription inactive.`);
    let msg = '';
    try { msg = JSON.parse(errText)?.error?.detail || JSON.parse(errText)?.message || ''; } catch {}
    throw new Error(`Web search failed (${res.status}): ${msg || errText.slice(0, 500) || res.statusText}`);
  }

  const json = await res.json();
  const mapResult = (r) => ({
    title: r.title || '',
    url: r.url || '',
    description: r.description || '',
    age: r.age || r.page_age || null,
    siteName: r.profile?.name || r.meta_url?.hostname || null,
    thumbnail: r.thumbnail?.src || null,
    extraSnippets: r.extra_snippets || undefined,
  });
  return {
    query: json.query?.original || query,
    altered: json.query?.altered || null,
    results: (json.web?.results || []).map(mapResult),
    news: (json.news?.results || []).map(mapResult),
    videos: (json.videos?.results || []).map(mapResult),
    instanceId: `${appName}-websearch-${spawnManager.currentId()}`,
  };
}

// Live diagnostic for the Brave Search setup. Probes with a trivial query and
// classifies the result. Never throws. Possible `state`: 'ok' | 'no-key' |
// 'invalid-key' | 'rate-limited' | 'error'.
async function webSearchDiagnose() {
  const apiKey = core.resolveProviderKey('brave-search');
  if (!apiKey) return { state: 'no-key' };

  let res, text;
  try {
    res = await fetch('https://api.search.brave.com/res/v1/web/search?q=ping&count=1', {
      headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
      signal: AbortSignal.timeout(15000),
    });
    text = await res.text();
  } catch (err) {
    return { state: 'error', message: `Could not reach Brave: ${err.message}` };
  }

  if (res.ok) {
    let sample = '';
    try { sample = JSON.parse(text)?.web?.results?.[0]?.title || ''; } catch {}
    return { state: 'ok', sample };
  }
  let message = '';
  try { const j = JSON.parse(text); message = j?.error?.detail || j?.message || ''; } catch {}
  const state = (res.status === 401 || res.status === 403) ? 'invalid-key'
    : res.status === 429 ? 'rate-limited'
    : 'error';
  return { state, status: res.status, message: message || `HTTP ${res.status}` };
}

const spendGate = require('./spend-gate');
module.exports = { aiWebSearch: spendGate.wrap('ai.webSearch', aiWebSearch, () => 1), webSearchDiagnose };
