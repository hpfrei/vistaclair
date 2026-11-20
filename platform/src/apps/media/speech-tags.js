// Speech tags — one provider-neutral way to write delivery for ai.tts
// (`tags: true`) and ai.ttsRender. The input carries xAI-style tags: inline
// `[laugh]`, `[pause]`, `[gasp]`… and wrapping `<whisper>…</whisper>`,
// `<loud>…</loud>`, `<emphasis>…</emphasis>`…. Per model (its descriptor):
//   native        — `speechTags: true` (xAI): the input is sent unchanged
//   instructions  — `instructions: true` (gpt-4o-mini-tts, Gemini): a cheap LLM
//                   pass (aiPrompt, haiku, no tools, charged to the app) turns
//                   each line into plain speakable text plus a one-sentence
//                   performance direction appended to the caller's instructions.
//                   The result is validated (no tags left, every spoken word kept
//                   in order, the direction never quotes the line) and falls back
//                   to the deterministic map below — the call never fails here.
//   plain         — neither (tts-1): the deterministic map, no direction.
// An input with no tags is sent as-is in every mode. LLM renderings are cached
// in-process by input, so ai.tts reuses what ai.ttsRender already produced.

const crypto = require('crypto');

const INLINE_RE = /\[([^\[\]\n]{1,40})\]/g;
const ANY_TAG_RE = /\[[^\[\]\n]{1,40}\]|<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/;
const WRAP_RE = /<([a-zA-Z][\w-]*)(?:\s[^<>]*)?>([^<]*)<\/\1\s*>/;
const STRAY_RE = /<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g;
const EMPHASIS = /^(emphasis|emphasize|emph|stress|strong)$/;

const norm = (name) => String(name).trim().toLowerCase().replace(/[\s_]+/g, '-');
const label = (name) => norm(name).replace(/[^a-z-]/g, '').replace(/-/g, ' ').trim();
const an = (w) => `${/^[aeiou]/.test(w) ? 'an' : 'a'} ${w}`;

function hasTags(text) {
  return typeof text === 'string' && ANY_TAG_RE.test(text);
}

// What an inline tag becomes in the spoken text ('' = dropped), and its cue.
function inlineTag(name) {
  const n = norm(name);
  if (/^laugh|laughter/.test(n)) return { text: 'hah-haha', cue: 'a laugh' };
  if (/chuckl/.test(n)) return { text: 'heh-heh', cue: 'a chuckle' };
  if (/giggl/.test(n)) return { text: 'hihi', cue: 'a giggle' };
  if (/pause|beat|silence/.test(n)) return { text: '…', cue: 'a deliberate pause' };
  if (/gasp/.test(n)) return { text: 'ah—', cue: 'a sharp gasp' };
  if (/sigh/.test(n)) return { text: '…', cue: 'a sigh' };
  const l = label(name);
  return { text: '', cue: l ? an(`${l} moment`) : null };
}

function wrapCue(name) {
  const n = norm(name);
  if (EMPHASIS.test(n)) return 'stressed words in capitals';
  if (/whisper/.test(n)) return 'a whispered passage';
  if (/loud|shout|yell/.test(n)) return 'a loud passage';
  if (/slow/.test(n)) return 'a slowed-down passage';
  if (/fast|quick|rapid/.test(n)) return 'a quick passage';
  if (/soft|quiet/.test(n)) return 'a soft passage';
  if (/sing/.test(n)) return 'a sung passage';
  const l = label(name);
  return l ? an(`${l} passage`) : null;
}

function tidy(s) {
  return s.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?;:])/g, '$1').trim();
}

function cueSentence(cues) {
  const seen = [];
  for (const c of cues) if (c && !seen.includes(c)) seen.push(c);
  return seen.length ? `${seen.join(', ')}.` : '';
}

// The deterministic rendering → { input, direction }: laughs written out,
// pauses as …, emphasis in capitals, every other tag dropped; the direction
// lists the cues by tag name only, so it can never quote the line.
function plain(text) {
  let s = String(text);
  // Cues in script order: every inline tag and every opening tag, left to right.
  const cues = [...s.matchAll(/\[([^\[\]\n]{1,40})\]|<([a-zA-Z][\w-]*)(?:\s[^<>]*)?>/g)]
    .map((m) => (m[1] !== undefined ? inlineTag(m[1]).cue : m[0].endsWith('/>') ? null : wrapCue(m[2])));
  for (let m = WRAP_RE.exec(s); m; m = WRAP_RE.exec(s)) {
    const inner = EMPHASIS.test(norm(m[1])) ? m[2].toUpperCase() : m[2];
    s = s.slice(0, m.index) + inner + s.slice(m.index + m[0].length);
  }
  s = s.replace(STRAY_RE, '');
  s = s.replace(INLINE_RE, (_, name) => {
    const t = inlineTag(name);
    return t.text ? ` ${t.text} ` : ' ';
  });
  return { input: tidy(s), direction: cueSentence(cues) };
}

// The spoken words alone (tags removed, wrapped text kept), for validation.
function spokenWords(text) {
  let s = String(text).replace(INLINE_RE, ' ');
  for (let m = WRAP_RE.exec(s); m; m = WRAP_RE.exec(s)) s = s.slice(0, m.index) + m[2] + s.slice(m.index + m[0].length);
  return words(s.replace(STRAY_RE, ' '));
}
function words(s) {
  return String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}
function inlineCount(text) {
  return (String(text).match(INLINE_RE) || []).length;
}

// An LLM rendering is accepted only when no tag is left, the spoken words are
// all there in order (vocalisations may be added, at most 3 words per inline
// tag), and the direction is one short line that does not quote the text.
function validText(source, out) {
  if (typeof out !== 'string' || !out.trim() || /[\[\]<>]/.test(out)) return false;
  const want = spokenWords(source);
  const got = words(out);
  let i = 0;
  for (const w of got) if (i < want.length && w === want[i]) i++;
  return i === want.length && got.length - want.length <= 3 * inlineCount(source);
}
function validDirection(source, dir) {
  if (typeof dir !== 'string' || !dir.trim() || dir.length > 400 || /[\[\]<>"„“”«»]/.test(dir)) return false;
  const src = spokenWords(source);
  const d = ` ${words(dir).join(' ')} `;
  const n = Math.min(3, src.length);
  for (let i = 0; n && i + n <= src.length; i++) {
    if (d.includes(` ${src.slice(i, i + n).join(' ')} `)) return false;
  }
  return true;
}

function cleanDirection(dir) {
  const d = String(dir).trim().replace(/^performance cues?\s*:\s*/i, '');
  return /[.!?]$/.test(d) ? d : `${d}.`;
}

function withCues(instructions, direction) {
  const base = typeof instructions === 'string' ? instructions.trim() : '';
  if (!direction) return base || null;
  const cue = `Performance cues: ${direction}`;
  return base ? `${base} ${cue}` : cue;
}

function modeFor(desc) {
  if (desc && desc.speechTags) return 'native';
  if (desc && desc.instructions) return 'instructions';
  return 'plain';
}

// ---- The LLM pass -------------------------------------------------------------
const CACHE_MAX = 5000;
const cache = new Map();
const cacheKey = (input) => crypto.createHash('sha1').update(input).digest('hex');
function cacheGet(input) {
  const k = cacheKey(input);
  const v = cache.get(k);
  if (v) { cache.delete(k); cache.set(k, v); }
  return v || null;
}
function cachePut(input, v) {
  const k = cacheKey(input);
  cache.delete(k);
  cache.set(k, v);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

const CHUNK_LINES = 30;
const CHUNK_CHARS = 8000;
const PARALLEL = 3;

const SYSTEM = [
  'You prepare lines of a script for a text-to-speech engine that cannot perform speech tags but follows a written performance direction.',
  'Each line may contain inline tags like [laugh], [pause], [gasp], [sigh] and wrapping tags like <whisper>…</whisper>, <loud>…</loud>, <slow>…</slow>, <emphasis>…</emphasis>.',
  'For every line marked "render": true return:',
  '- "text": the line as plain speakable text. Keep EVERY spoken word verbatim and in order, in the original language, with its punctuation. Remove every tag.',
  '  Write a laugh as a short lowercase, breath-broken laugh glued to the neighbouring words (e.g. "hah-haha", "heh"); a gasp as a short sound such as "ah—"; [pause] as "…".',
  '  Text inside <emphasis> goes in CAPITALS. Text inside other wrapping tags stays as written. Add no other words.',
  '- "direction": ONE short English sentence of performance cues, in order (e.g. "a sharp gasp after the opening, the middle phrase loud and rising, a breathy laugh spilling into the final phrase").',
  '  NEVER quote or repeat any words of the line in the direction, and use no quotation marks — describe positions instead (the opening, the middle phrase, the last words).',
  'Lines marked "render": false are context only (neighbouring lines of the same script); return nothing for them.',
  'Return ONLY JSON: {"lines":[{"i":<index>,"text":"…","direction":"…"}]}',
].join('\n');

function chunksOf(items) {
  // items: [{ i, input, render }] in script order; a chunk keeps its context lines.
  const out = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= CHUNK_LINES || chars + it.input.length > CHUNK_CHARS)) { out.push(cur); cur = []; chars = 0; }
    cur.push(it);
    chars += it.input.length;
  }
  if (cur.length) out.push(cur);
  return out.filter((c) => c.some((it) => it.render));
}

async function promptChunk(appName, chunk) {
  const appManager = require('../app-manager');
  const res = await require('../ai-service').aiPrompt(appName, appManager.appDir(appName), {
    model: 'haiku',
    allowedTools: [],
    expectJson: true,
    retries: 1,
    timeout: 120000,
    systemPrompt: SYSTEM,
    message: JSON.stringify({ lines: chunk.map((it) => ({ i: it.i, render: it.render, line: it.input })) }),
  });
  const rows = res && res.json && Array.isArray(res.json.lines) ? res.json.lines : [];
  const byIndex = new Map();
  for (const r of rows) if (r && Number.isInteger(r.i)) byIndex.set(r.i, r);
  return byIndex;
}

async function pool(tasks, n) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) { const k = next++; results[k] = await tasks[k](); }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return results;
}

// items: [{ input, mode, instructions }] in script order → one rendering each:
// { input, instructions, mode, via, cached?, fallback? } where input /
// instructions are exactly what ai.tts sends (instructions null when the model
// takes none). via: 'none' (no tags) | 'native' | 'plain' | 'llm' | 'fallback'.
async function render(appName, items) {
  const out = new Array(items.length);
  const pending = [];
  items.forEach((it, i) => {
    const { input, mode } = it;
    if (!hasTags(input)) {
      out[i] = { input, instructions: mode === 'instructions' ? withCues(it.instructions, '') : null, mode, via: 'none' };
    } else if (mode === 'native') {
      out[i] = { input, instructions: null, mode, via: 'native' };
    } else if (mode === 'plain') {
      out[i] = { input: plain(input).input, instructions: null, mode, via: 'plain' };
    } else {
      const hit = cacheGet(input);
      if (hit) out[i] = { input: hit.input, instructions: withCues(it.instructions, hit.direction), mode, via: 'llm', cached: true };
      else pending.push(i);
    }
  });
  if (!pending.length) return out;

  const want = new Set(pending);
  const chunks = chunksOf(items.map((it, i) => ({ i, input: String(it.input), render: want.has(i) })));
  const answers = new Map();
  const failures = new Map();
  await pool(chunks.map((chunk) => async () => {
    try {
      for (const [i, r] of await promptChunk(appName, chunk)) if (want.has(i)) answers.set(i, r);
    } catch (err) {
      for (const it of chunk) if (it.render) failures.set(it.i, err.message || String(err));
    }
  }), PARALLEL);

  for (const i of pending) {
    const it = items[i];
    const det = plain(it.input);
    const a = answers.get(i);
    if (a && validText(it.input, a.text)) {
      const direction = validDirection(it.input, a.direction) ? cleanDirection(a.direction) : det.direction;
      const text = tidy(a.text);
      cachePut(it.input, { input: text, direction });
      out[i] = { input: text, instructions: withCues(it.instructions, direction), mode: 'instructions', via: 'llm' };
    } else {
      const fallback = failures.get(i) || (a ? 'rendering failed validation' : 'no rendering returned');
      out[i] = { input: det.input, instructions: withCues(it.instructions, det.direction), mode: 'instructions', via: 'fallback', fallback };
    }
  }
  return out;
}

module.exports = { hasTags, plain, modeFor, render, validText, validDirection, _cache: cache };
