// Horst's deliveries — every file he hands the owner, kept for Vista › Files.
//
// Two paths deliver a file today, and both come through record() here: a
// long-running tool's outcome (agent/horst-jobs.js done) and the vc-artifact
// links a chat turn's quick tools return (platform-horst.js runChat). One
// record per file, one batch id per delivery:
//
//   { id: dl_…, at, batch: db_…, artifactId, uri, name, mime, size, kind,
//     source: job|chat, app, tool, jobId?, conversationId, title, removedAt? }
//
// A delivered artifact is pinned (holder HOLDER, reason 'horst-delivery'), so
// the store's 30-day gc never takes it: the owner keeps it until they remove
// it. remove() unpins and marks the record removed; the blob goes at the next
// gc. The ledger is <dir>/deliveries.json, written atomically.
//
// Telegram gets no file bytes: toTelegram() sends ONE message per delivery —
// the text plus an "Open in Vista" web_app button on the first file
// (`<miniAppUrl>?file=<id>`), and for a picture a small preview photo carrying
// that text as its caption.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOLDER = 'horst:deliveries';
const PIN_REASON = 'horst-delivery';
const KINDS = ['picture', 'audio', 'video', 'model', 'document'];
const MODEL_EXT = /\.(glb|gltf|obj|stl|fbx|usdz|usd|ply|3mf|dae)$/i;
const PHOTO_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const CAPTION_MAX = 1024;               // Telegram caption limit
const PREVIEW_RAW_MAX = 1024 * 1024;    // a picture up to 1 MB is its own preview
const PREVIEW_PHOTO_MAX = 10 * 1024 * 1024; // sendPhoto limit, the fallback without sharp
const PREVIEW_EDGE = 1024;
const REMOVED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const TITLE_CAP = 200;

let deps = {};
let state = null;

// init({ dir, sendControlMessage(chatId, text, markup), telegram: { sendPhoto(args) },
//        miniAppUrl() → url|null, now? })
function init(options = {}) {
  deps = options;
  state = null;
}

const now = () => (deps.now ? deps.now() : Date.now());
const art = () => require('../app-artifacts');
const newId = (prefix) => `${prefix}_${now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;

function kindOf(mime, name) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('model/') || MODEL_EXT.test(String(name || ''))) return 'model';
  if (m.startsWith('image/')) return 'picture';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'document';
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

function file() { return path.join(deps.dir, 'deliveries.json'); }

function load() {
  if (state) return state;
  try { state = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { state = null; }
  if (!state || !Array.isArray(state.items)) state = { items: [] };
  return state;
}

function save() {
  const cutoff = now() - REMOVED_KEEP_MS;
  state.items = state.items.filter((d) => !d.removedAt || Date.parse(d.removedAt) > cutoff);
  fs.mkdirSync(deps.dir, { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file());
}

const active = (d) => d && !d.removedAt;

// links: resource_link-shaped { uri, name?, mimeType?, size? }. meta: { source,
// conversationId, title, jobId?, app?, tool? } — app/tool default to the
// artifact's producer. → the batch's records, in order; an artifact already
// delivered (and not removed) keeps its record. A link the store does not
// know is skipped.
function record(links, meta = {}) {
  if (!deps.dir) return [];
  const st = load();
  const batch = newId('db');
  const at = new Date(now()).toISOString();
  const out = [];
  let changed = false;
  for (const link of links || []) {
    const view = link && art().get(link.uri);
    if (!view) continue;
    if (out.some((d) => d.artifactId === view.id)) continue;
    const existing = st.items.find((d) => active(d) && d.artifactId === view.id);
    if (existing) { out.push(existing); continue; }
    try { art().pin(view.id, HOLDER, PIN_REASON); } catch (err) { console.warn('[horst-deliveries] pin failed:', err.message); }
    const producer = view.producer || {};
    const d = {
      id: newId('dl'), at, batch, artifactId: view.id, uri: view.uri,
      name: view.name || link.name || view.id, mime: view.mime || link.mimeType || 'application/octet-stream',
      size: view.size, kind: kindOf(view.mime, view.name || link.name),
      source: meta.source === 'job' ? 'job' : 'chat',
      app: meta.app || producer.app || producer.platform || null,
      tool: meta.tool || producer.tool || null,
      ...(meta.jobId ? { jobId: meta.jobId } : {}),
      conversationId: meta.conversationId || null,
      title: String(meta.title || '').split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, TITLE_CAP) || null,
    };
    st.items.push(d);
    out.push(d);
    changed = true;
  }
  if (changed) save();
  return out;
}

function get(id) {
  return load().items.find((d) => d.id === id) || null;
}

// The live record delivering an artifact, or null — what decides whether the
// Mini App may serve its bytes.
function forArtifact(artifactId) {
  return load().items.find((d) => active(d) && d.artifactId === artifactId) || null;
}

// list({ kind?, batch?, artifact? }) → { files, counts }, newest first, removed
// records left out. Each file adds `missing` (its blob is gone) and
// `previews` — the pictures of the same batch, for a 3D model.
function list(filter = {}) {
  const items = load().items.filter(active);
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const d of items) counts[d.kind] = (counts[d.kind] || 0) + 1;
  const files = items
    .filter((d) => (!filter.kind || d.kind === filter.kind)
      && (!filter.batch || d.batch === filter.batch)
      && (!filter.artifact || d.artifactId === filter.artifact))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .map((d) => present(d, items));
  return { files, counts };
}

function present(d, items = load().items.filter(active)) {
  return {
    ...d,
    ...(art().get(d.artifactId) ? {} : { missing: true }),
    previews: items.filter((x) => x.batch === d.batch && x.kind === 'picture' && x.id !== d.id).map((x) => x.id),
  };
}

// One record and the rest of its batch (deep link: the Mini App opens on it).
function detail(id) {
  const d = get(id);
  if (!active(d)) return null;
  const items = load().items.filter(active);
  return { file: present(d, items), batch: items.filter((x) => x.batch === d.batch).map((x) => present(x, items)) };
}

// The owner's remove: unpin (the blob goes at the next gc) and hide.
function remove(id) {
  const d = get(id);
  if (!active(d)) throw new Error('unknown file');
  try { art().unpin(d.artifactId, HOLDER); } catch (err) { console.warn('[horst-deliveries] unpin failed:', err.message); }
  d.removedAt = new Date(now()).toISOString();
  save();
  return { ...d };
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

function vistaUrl(d) {
  let base = null;
  try { base = deps.miniAppUrl ? deps.miniAppUrl() : null; } catch {}
  return base ? `${base}?file=${encodeURIComponent(d.id)}` : null;
}

// A picture's preview for sendPhoto: the photo itself up to 1 MB, else a
// downscaled jpeg (sharp, when installed), else the photo up to Telegram's
// 10 MB — or null (link only).
async function previewOf(d) {
  const blob = art().blobPath(d.artifactId);
  if (!blob) return null;
  let size = 0;
  try { size = fs.statSync(blob).size; } catch { return null; }
  const mime = String(d.mime || '').toLowerCase();
  if (PHOTO_MIME.has(mime) && size <= PREVIEW_RAW_MAX) return { buffer: fs.readFileSync(blob), contentType: mime, filename: d.name };
  let sharp = null;
  try { sharp = require('sharp'); } catch {}
  if (sharp) {
    try {
      const buffer = await sharp(blob).rotate().resize(PREVIEW_EDGE, PREVIEW_EDGE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
      return { buffer, contentType: 'image/jpeg', filename: 'preview.jpg' };
    } catch (err) { console.warn('[horst-deliveries] preview failed:', err.message); }
  }
  if (PHOTO_MIME.has(mime) && size <= PREVIEW_PHOTO_MAX) return { buffer: fs.readFileSync(blob), contentType: mime, filename: d.name };
  return null;
}

// ONE Telegram message for a delivery: `text` (the outcome or the reply) with
// `markup`'s rows plus "Open in Vista" on the first file. With a picture the
// message is its preview photo, the text its caption; a text above the caption
// limit goes first on its own and the photo follows with the button. No public
// URL → no button, the text names the Horst tab instead.
async function toTelegram(chatId, text, deliveries, markup) {
  const files = (deliveries || []).filter(Boolean);
  const rows = (markup && markup.inline_keyboard) || [];
  const withRows = (extra) => (rows.length || extra.length ? { inline_keyboard: [...rows, ...extra] } : undefined);
  if (!files.length) return deps.sendControlMessage(chatId, text, markup);
  const url = vistaUrl(files[0]);
  const n = files.length;
  const button = url ? [[{ text: n > 1 ? `📁 Open in Vista (${n} files)` : '📁 Open in Vista', web_app: { url } }]] : [];
  const body = url ? String(text || '') : `${text || ''}\n\n📁 ${n === 1 ? 'The file is' : `${n} files are`} in the Horst tab › Files.`.trim();
  const pic = files.find((d) => d.kind === 'picture');
  const preview = pic ? await previewOf(pic) : null;
  if (!preview) return deps.sendControlMessage(chatId, body, withRows(button));
  let caption = body;
  if (body.length > CAPTION_MAX) {
    await deps.sendControlMessage(chatId, body, markup);
    caption = `🖼 ${pic.name}${n > 1 ? ` (+${n - 1} more)` : ''}`;
  }
  const replyMarkup = body.length > CAPTION_MAX ? (button.length ? { inline_keyboard: button } : undefined) : withRows(button);
  try {
    // telegram.sendPhoto resolves with Telegram's envelope; a refusal is { ok: false }.
    const res = await deps.telegram.sendPhoto({
      chatId, photo: preview.buffer, filename: preview.filename, contentType: preview.contentType,
      caption, ...(replyMarkup ? { options: { reply_markup: replyMarkup } } : {}),
    });
    if (res && res.ok === false) throw new Error(res.description || 'sendPhoto refused');
  } catch (err) {
    console.warn('[horst-deliveries] preview send failed:', err.message);
    if (body.length <= CAPTION_MAX) return deps.sendControlMessage(chatId, body, withRows(button));
    if (button.length) return deps.sendControlMessage(chatId, caption, { inline_keyboard: button });
  }
  return null;
}

module.exports = {
  init, record, list, get, detail, forArtifact, remove, toTelegram, kindOf, vistaUrl,
  HOLDER, PIN_REASON, KINDS,
};
