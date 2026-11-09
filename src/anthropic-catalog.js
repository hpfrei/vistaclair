// Anthropic's own model sources for the registry refresh.
//
// models.dev lags Anthropic releases, so the refresh also reads the vendor's
// docs, which serve plain markdown:
//   - models overview: which models exist (API id, label, context window, max
//     output, description; legacy models as links)
//   - pricing: $/MTok per model label (input, 5m cache write, cache hit, output)
//   - model deprecations: lifecycle state and retirement dates by API id
// plus, when an Anthropic API key is stored, GET /v1/models (ids, display
// names, token limits for exactly the models the account can call).
//
// Every page is untrusted input: tables are parsed deterministically, ids must
// look like Anthropic ids, numbers must be finite and plausible, and anything
// that does not fit is dropped. A page that fails to fetch or parse is reported
// in `errors`; nothing here throws.

const ID_RE = /^claude-[a-z0-9.-]+$/;
const UNSAFE_KEY_RE = /^(__proto__|constructor|prototype)$/;
const DATED_RE = /-(\d{8})$/;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

const ANTHROPIC_DOC_URLS = {
  overview: [
    'https://platform.claude.com/docs/en/about-claude/models/overview.md',
    'https://docs.claude.com/en/docs/about-claude/models/overview.md',
  ],
  pricing: [
    'https://platform.claude.com/docs/en/about-claude/pricing.md',
    'https://docs.claude.com/en/docs/about-claude/pricing.md',
  ],
  deprecations: [
    'https://platform.claude.com/docs/en/about-claude/model-deprecations.md',
    'https://docs.claude.com/en/docs/about-claude/model-deprecations.md',
  ],
};
const ANTHROPIC_MODELS_API = 'https://api.anthropic.com/v1/models';

function validId(id) {
  return typeof id === 'string' && id.length <= 80 && ID_RE.test(id) && !UNSAFE_KEY_RE.test(id);
}

// Dated snapshot → the undated id the API routes (claude-opus-4-5-20251101 →
// claude-opus-4-5).
function baseId(id) {
  return id.replace(DATED_RE, '');
}

// One markdown table cell as plain text: footnote markers, links, code ticks
// and emphasis removed, whitespace collapsed.
function cleanCell(s) {
  return String(s || '')
    .replace(/<sup>.*?<\/sup>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every pipe table in the document: { header: [cells], rows: [[cells]] }, raw
// cell text (callers clean what they read). The `| :--- |` separator is dropped.
function parseTables(md) {
  const tables = [];
  let cur = null;
  for (const line of String(md || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) { cur = null; continue; }
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    if (!cur) { cur = { header: cells, rows: [] }; tables.push(cur); continue; }
    if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;
    cur.rows.push(cells);
  }
  return tables;
}

// "1M tokens" → 1000000, "128K tokens" → 128000, "200,000" → 200000.
function parseTokenCount(s) {
  const m = cleanCell(s).match(/^(\d+(?:[.,]\d+)*)\s*([kKmM])?\b/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, '')) * (m[2] ? (/m/i.test(m[2]) ? 1e6 : 1e3) : 1);
  return Number.isFinite(n) && n >= 1000 && n <= 1e8 ? Math.round(n) : null;
}

// "$12.50 / MTok" → 12.5. Anything else (a range, "N/A", a blank) → null.
function parseUsd(s) {
  const m = cleanCell(s).match(/^(?:from\s+)?\$\s*(\d+(?:\.\d+)?)\s*(?:USD\s*)?\/\s*MTok\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 10000 ? n : null;
}

// A model name without its annotation: "Claude Opus 4.1 (retired, except on
// … (Google managed) …)" → "Claude Opus 4.1".
function cleanLabel(s) {
  return cleanCell(s).split('(')[0].trim().slice(0, 80);
}

// "Claude Fable 5.2" → "claude-fable-5-2", the id pattern Anthropic uses from
// the 4.x generation on. Only ever used to match a page row to an id some
// other source already knows — never to invent a model.
function idFromLabel(label) {
  const m = String(label || '').match(/^Claude ([A-Za-z]+) (\d+(?:\.\d+)?)$/);
  return m ? `claude-${m[1].toLowerCase()}-${m[2].replace('.', '-')}` : null;
}

// The models overview: the comparison table is transposed (one column per
// current model, one row per feature); legacy models are a list of links to
// their model pages. Returns { models: { id: meta }, labels: { label: id } }.
function parseOverview(md) {
  const models = {};
  const labels = {};
  const table = parseTables(md).find(t =>
    /^feature$/i.test(cleanCell(t.header[0])) && t.rows.some(r => /^claude api id$/i.test(cleanCell(r[0]))));
  if (table) {
    const row = (re) => table.rows.find(r => re.test(cleanCell(r[0])));
    const idRow = row(/^claude api id$/i);
    const ctxRow = row(/^context window$/i);
    const outRow = row(/^max output$/i);
    const descRow = row(/^description$/i);
    const priceRow = row(/^pricing$/i);
    const thinkRow = row(/^(extended |adaptive )?thinking$/i);
    for (let i = 1; i < table.header.length; i++) {
      const id = (String(idRow[i] || '').match(/`([^`]+)`/) || [])[1] || cleanCell(idRow[i]);
      if (!validId(id)) continue;
      const label = cleanLabel(table.header[i]);
      const meta = { modelId: id };
      if (label) { meta.label = label; labels[label] = id; }
      const ctx = ctxRow ? parseTokenCount(ctxRow[i]) : null;
      if (ctx) meta.contextWindow = ctx;
      const out = outRow ? parseTokenCount(outRow[i]) : null;
      if (out) meta.maxOutputTokens = out;
      const desc = descRow ? cleanCell(descRow[i]) : '';
      if (desc) meta.description = desc.slice(0, 300);
      if (thinkRow) {
        const think = cleanCell(thinkRow[i]);
        if (think) meta.reasoning = !/^(no|none|not supported|-|—)$/i.test(think);
      }
      if (priceRow) {
        const cell = cleanCell(priceRow[i]);
        const inp = cell.match(/\$\s*(\d+(?:\.\d+)?)\s*\/\s*input MTok/i);
        const outp = cell.match(/\$\s*(\d+(?:\.\d+)?)\s*\/\s*output MTok/i);
        if (inp && outp) {
          meta.inputCostPerMTok = Number(inp[1]);
          meta.outputCostPerMTok = Number(outp[1]);
        }
      }
      models[id] = meta;
    }
  }
  const legacy = String(md || '').match(/^Legacy models[^:\n]*:(.*)$/im);
  if (legacy) {
    for (const [, text, url] of legacy[1].matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
      const slug = (url.match(/\/models\/([a-z0-9-]+)\/overview\b/) || [])[1];
      if (!slug) continue;
      const id = `claude-${slug}`;
      if (!validId(id) || models[id]) continue;
      const label = cleanLabel(text);
      models[id] = { modelId: id, ...(label ? { label } : {}) };
      if (label) labels[label] = id;
    }
  }
  return { models, labels };
}

// The pricing page's model table. Returns [{ label, note, prices }] in page
// order; a model with tiers (Haiku: "for prompts up to / over 100,000 tokens")
// appears once per tier — the first is the base tier.
function parsePricing(md) {
  const rows = [];
  for (const table of parseTables(md)) {
    const head = table.header.map(cleanCell);
    if (!/^model$/i.test(head[0] || '')) continue;
    const col = (re) => head.findIndex(h => re.test(h));
    const inCol = col(/base input/i);
    const outCol = col(/^output/i);
    if (inCol < 0 || outCol < 0) continue;
    let writeCol = col(/5m cache write/i);
    if (writeCol < 0) writeCol = col(/cache write/i);
    const hitCol = col(/cache hit/i);
    for (const r of table.rows) {
      const raw = cleanCell(r[0]);
      const label = cleanLabel(r[0]);
      if (!label) continue;
      const note = raw.includes('(') ? raw.slice(raw.indexOf('(') + 1) : '';
      const input = parseUsd(r[inCol]);
      const output = parseUsd(r[outCol]);
      if (input == null || output == null) continue;
      const prices = { inputCostPerMTok: input, outputCostPerMTok: output };
      const write = writeCol >= 0 ? parseUsd(r[writeCol]) : null;
      const hit = hitCol >= 0 ? parseUsd(r[hitCol]) : null;
      if (write != null) prices.cacheCreateCostPerMTok = write;
      if (hit != null) prices.cacheReadCostPerMTok = hit;
      rows.push({ label, note: note.toLowerCase(), prices });
    }
    if (rows.length) break;   // the first model table is the standard-rate one
  }
  return rows;
}

// "November 30, 2026" → ISO; "Not sooner than …", "N/A", "To be announced" → null.
function parseDate(s) {
  const t = cleanCell(s);
  if (!/^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(t)) return null;
  const d = Date.parse(`${t} 00:00:00 UTC`);
  return Number.isNaN(d) ? null : new Date(d).toISOString();
}

// The deprecations page's "Model status" table, keyed by undated id:
// { id: { lifecycle: 'current'|'deprecated'|'retired', retiresAt } }.
function parseDeprecations(md) {
  const out = {};
  for (const table of parseTables(md)) {
    const head = table.header.map(cleanCell);
    const idCol = head.findIndex(h => /api model name/i.test(h));
    const stateCol = head.findIndex(h => /current state/i.test(h));
    if (idCol < 0 || stateCol < 0) continue;
    const retireCol = head.findIndex(h => /retirement date/i.test(h));
    for (const r of table.rows) {
      const id = cleanCell(r[idCol]);
      if (!validId(id)) continue;
      const state = cleanCell(r[stateCol]).toLowerCase();
      const lifecycle = state === 'active' ? 'current' : state === 'deprecated' ? 'deprecated' : state === 'retired' ? 'retired' : null;
      if (!lifecycle) continue;
      const key = baseId(id);
      if (out[key]) continue;
      out[key] = { lifecycle, retiresAt: lifecycle === 'deprecated' && retireCol >= 0 ? parseDate(r[retireCol]) : null };
    }
    break;
  }
  return out;
}

// GET /v1/models → { id: { modelId, label, contextWindow, maxOutputTokens } },
// dated ids collapsed onto the undated one.
function normalizeApiModels(data) {
  const out = {};
  const list = Array.isArray(data) ? data : [];
  for (const m of list) {
    if (!m || typeof m !== 'object' || !validId(m.id)) continue;
    const id = baseId(m.id);
    if (out[id]) continue;
    const meta = { modelId: id };
    if (typeof m.display_name === 'string' && m.display_name.trim()) meta.label = cleanLabel(m.display_name);
    const ctx = Number.isInteger(m.max_input_tokens) && m.max_input_tokens >= 1000 && m.max_input_tokens <= 1e8 ? m.max_input_tokens : null;
    const out_ = Number.isInteger(m.max_tokens) && m.max_tokens >= 1000 && m.max_tokens <= 1e8 ? m.max_tokens : null;
    if (ctx) meta.contextWindow = ctx;
    if (out_) meta.maxOutputTokens = out_;
    out[id] = meta;
  }
  return out;
}

// Combine the parsed sources into { anthropic: { id: meta } } — the shape
// normalizeModelsDevCatalog produces for its anthropic part. `knownIds` are
// the ids some other source (registry, pricing file, models.dev) already has.
// A model is listed (may be added) only when the overview or the Models API
// names it; the pricing and deprecations pages only describe listed or known ids.
// Returns { catalog: { id: meta }, listed: [ids], priced: [ids] }.
function buildAnthropicCatalog({ overview, pricing, deprecations, api } = {}, knownIds = new Set()) {
  const catalog = {};
  const listed = new Set();
  const labels = {};
  for (const src of [overview?.models, api]) {
    for (const [id, meta] of Object.entries(src || {})) {
      if (!validId(id)) continue;
      listed.add(id);
      const entry = catalog[id] || (catalog[id] = { modelId: id });
      // The Models API (the account's own view) overrides the overview's limits.
      for (const [k, v] of Object.entries(meta)) if (v !== undefined && (entry[k] === undefined || src === api)) entry[k] = v;
      if (meta.label && !labels[meta.label]) labels[meta.label] = id;
    }
  }
  for (const [label, id] of Object.entries(overview?.labels || {})) if (!labels[label]) labels[label] = id;

  const priced = new Set();
  for (const row of pricing || []) {
    const id = labels[row.label] || idFromLabel(row.label);
    if (!id || !validId(id) || priced.has(id)) continue;   // first tier wins
    if (!listed.has(id) && !knownIds.has(id)) continue;
    const entry = catalog[id] || (catalog[id] = { modelId: id });
    Object.assign(entry, row.prices);
    if (!entry.label) entry.label = row.label;
    if (/\bretired\b/.test(row.note)) { entry.lifecycle = 'retired'; entry.deprecated = false; }
    priced.add(id);
  }

  for (const [id, d] of Object.entries(deprecations || {})) {
    if (!catalog[id] && !listed.has(id) && !knownIds.has(id)) continue;
    const entry = catalog[id] || (catalog[id] = { modelId: id });
    entry.lifecycle = d.lifecycle;
    entry.deprecated = d.lifecycle === 'deprecated';
    if (d.retiresAt) entry.retiresAt = d.retiresAt;
  }
  return { catalog, listed: [...listed], priced: [...priced] };
}

async function _fetchText(url, { timeoutMs, fetchImpl, headers }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow', headers: headers || { 'Accept': 'text/markdown, text/plain;q=0.9, */*;q=0.1' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_PAGE_BYTES) throw new Error('page too large');
    return text;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// First mirror that answers with markdown (not an HTML shell).
async function _fetchPage(urls, opts) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const text = await _fetchText(url, opts);
      if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('served HTML, not markdown');
      return text;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no URL');
}

// Fetch and parse every Anthropic source in parallel. Never throws:
// resolves { overview, pricing, deprecations, api, errors: [string], ms }
// where a failed source is null and named in `errors`.
async function fetchAnthropicSources({ apiKey = '', timeoutMs = 10000, fetchImpl = globalThis.fetch, urls = ANTHROPIC_DOC_URLS } = {}) {
  const t0 = Date.now();
  const errors = [];
  const opts = { timeoutMs, fetchImpl };
  const page = async (name, parse, empty) => {
    try {
      const parsed = parse(await _fetchPage(urls[name], opts));
      if (empty(parsed)) { errors.push(`${name} page: no model table found`); return null; }
      return parsed;
    } catch (err) {
      errors.push(`${name} page: ${err.message || err}`);
      return null;
    }
  };
  const api = async () => {
    if (!apiKey) return null;
    try {
      const all = [];
      let after = '';
      for (let i = 0; i < 5; i++) {
        const text = await _fetchText(`${ANTHROPIC_MODELS_API}?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`,
          { ...opts, headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Accept': 'application/json' } });
        const body = JSON.parse(text);
        if (Array.isArray(body?.data)) all.push(...body.data);
        if (!body?.has_more || typeof body.last_id !== 'string') break;
        after = body.last_id;
      }
      const models = normalizeApiModels(all);
      if (!Object.keys(models).length) { errors.push('Models API: no models returned'); return null; }
      return models;
    } catch (err) {
      errors.push(`Models API: ${err.message || err}`);
      return null;
    }
  };
  const [overview, pricing, deprecations, apiModels] = await Promise.all([
    page('overview', parseOverview, p => !Object.keys(p.models).length),
    page('pricing', parsePricing, p => !p.length),
    page('deprecations', parseDeprecations, p => !Object.keys(p).length),
    api(),
  ]);
  return { overview, pricing, deprecations, api: apiModels, errors, ms: Date.now() - t0 };
}

module.exports = {
  ANTHROPIC_DOC_URLS,
  parseTables,
  parseOverview,
  parsePricing,
  parseDeprecations,
  normalizeApiModels,
  buildAnthropicCatalog,
  fetchAnthropicSources,
  idFromLabel,
};
