// Voice samples for the model pickers (Setup → AI Config, <vc-model-picker
// kind="speech" show-voices>, ai.voiceSample). No vendor hosts samples for its
// built-in voices, so the first play speaks "Hello, I am <voice name>." through
// that model and voice — metered to 'platform' like any ai.tts call — and the
// clip is kept forever under <APPS_DIR>/.media-samples/. Later plays read the file.

const fs = require('fs');
const path = require('path');
const mediaCatalog = require('./media-catalog');

const inflight = new Map();

function samplesDir() {
  return path.join(require('./app-manager').APPS_DIR, '.media-samples');
}

const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, '_');

// { dataUri, mimeType, cached, model, voice } for one model + voice.
async function sample({ model, voice } = {}) {
  if (!model || !voice) throw new Error('model and voice are required');
  const row = mediaCatalog.find(String(model), { method: 'ai.tts' });
  if (!row) throw new Error(`unknown TTS model "${model}"`);
  const offered = mediaCatalog.voicesFor(row) || [];
  const v = offered.find((x) => String(x.id).toLowerCase() === String(voice).toLowerCase());
  if (!v) throw new Error(`voice "${voice}" is not offered by ${model}`);

  const media = require('./media');
  const desc = media.adapter('ai.tts', row.provider).describe(row.modelId);
  const format = desc.formats.includes('mp3') ? 'mp3' : desc.defaultFormat;
  const file = path.join(samplesDir(), `${safe(row.provider)}-${safe(row.modelId)}-${safe(v.id)}.${format}`);
  const mimeType = format === 'mp3' ? 'audio/mpeg' : `audio/${format}`;
  const read = (cached) => ({ dataUri: `data:${mimeType};base64,${fs.readFileSync(file).toString('base64')}`, mimeType, cached, model: row.modelId, voice: v.id });

  if (fs.existsSync(file)) return read(true);
  if (!inflight.has(file)) {
    inflight.set(file, (async () => {
      const r = await require('./ai-media').aiTts('platform', {
        model: row.modelId, voice: v.id, format, input: `Hello, I am ${v.name || v.id}.`,
      });
      fs.mkdirSync(samplesDir(), { recursive: true });
      fs.writeFileSync(file + '.tmp', Buffer.from(r.audio, 'base64'));
      fs.renameSync(file + '.tmp', file);
    })().finally(() => inflight.delete(file)));
  }
  await inflight.get(file);
  return read(false);
}

module.exports = { sample, samplesDir };
