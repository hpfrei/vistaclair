// Silero VAD (v5) — speech activity detection for the ai.transcribe path.
//
// Why: ffmpeg's silenceremove is an energy gate. It trims true silence but keeps
// non-speech energy (hum, keyboard, music) and can clip soft speech onsets. A
// learned VAD cuts to actual *speech*, which both shrinks the upload and reduces
// Whisper hallucinations on long non-speech stretches.
//
// The model is a tiny (~2 MB) ONNX net run on CPU via onnxruntime-node (already a
// platform dep). It's lazy-loaded as a single in-process singleton (like
// embeddings.js) and the weights are cached under appsDir/.vad-cache so they
// survive npm install. Everything here is best-effort: if the model can't load,
// callers fall back to ffmpeg silenceremove.
//
// Operates on 16 kHz mono float32 PCM (Whisper's native rate). At 16 kHz Silero
// v5 consumes fixed 512-sample windows (32 ms) and carries an LSTM state between
// windows. Standard post-processing (min speech/silence durations + padding)
// turns per-window probabilities into clean speech segments.

const fs = require('fs');
const path = require('path');
const https = require('https');

const MODEL_URL = 'https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx';
const MODEL_FILE = 'silero_vad.onnx';
const SAMPLE_RATE = 16000;
const WINDOW = 512;        // samples per inference window at 16 kHz (fixed for v5)
const STATE_SHAPE = [2, 1, 128];

let _cacheDir = null;
let _session = null;
let _loading = null;

function init(appsDir) {
  if (appsDir) _cacheDir = path.join(appsDir, '.vad-cache');
}

function _modelPath() {
  const dir = _cacheDir || path.join(require('os').tmpdir(), 'vc-vad-cache');
  return path.join(dir, MODEL_FILE);
}

function _download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const tmp = dest + '.part';
    const file = fs.createWriteStream(tmp);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(tmp); } catch {}
        return resolve(_download(res.headers.location, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(tmp); } catch {}
        return reject(new Error(`download failed: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => {
        try {
          if (fs.statSync(tmp).size < 1024) throw new Error('downloaded model too small');
          fs.renameSync(tmp, dest);
          resolve(dest);
        } catch (e) { try { fs.unlinkSync(tmp); } catch {} reject(e); }
      }));
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(tmp); } catch {}
      reject(err);
    });
  });
}

async function _ensureModel() {
  const p = _modelPath();
  if (fs.existsSync(p) && fs.statSync(p).size > 1024) return p;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  await _download(MODEL_URL, p);
  return p;
}

async function getSession() {
  if (_session) return _session;
  if (_loading) return _loading;
  _loading = (async () => {
    const ort = require('onnxruntime-node');
    const modelPath = await _ensureModel();
    _session = await ort.InferenceSession.create(modelPath, { logSeverityLevel: 3 });
    _session._ort = ort;
    return _session;
  })();
  try {
    return await _loading;
  } catch (err) {
    _loading = null; // allow a later retry (e.g. transient download failure)
    throw err;
  }
}

// Optional background warmup so the first transcribe call isn't slow.
function warm() {
  getSession().catch(() => {});
}

function isReady() {
  return !!_session;
}

// Run the model window-by-window, returning a speech probability per 512-sample
// frame. Carries the LSTM state forward across windows as the model requires.
async function _frameProbabilities(pcm) {
  const session = await getSession();
  const ort = session._ort;
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  let state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), STATE_SHAPE);
  const probs = [];
  const frame = new Float32Array(WINDOW);
  for (let i = 0; i + WINDOW <= pcm.length; i += WINDOW) {
    frame.set(pcm.subarray(i, i + WINDOW));
    const input = new ort.Tensor('float32', frame, [1, WINDOW]);
    const out = await session.run({ input, state, sr });
    probs.push(out.output.data[0]);
    state = out.stateN;
  }
  return probs;
}

// Convert per-frame probabilities into speech segments (in samples) with the
// usual Silero post-processing: hysteresis on the threshold, drop too-short
// speech blips, bridge short gaps, then pad each segment.
function _segmentsFromProbs(probs, totalSamples, opts) {
  const {
    threshold = 0.5,
    negThreshold = Math.max(0.15, threshold - 0.15),
    minSpeechMs = 250,
    minSilenceMs = 100,
    speechPadMs = 30,
  } = opts;

  const frameSamples = WINDOW;
  const msToFrames = (ms) => Math.round((ms / 1000) * SAMPLE_RATE / frameSamples);
  const minSpeechFrames = Math.max(1, msToFrames(minSpeechMs));
  const minSilenceFrames = Math.max(1, msToFrames(minSilenceMs));
  const padSamples = Math.round((speechPadMs / 1000) * SAMPLE_RATE);

  const segs = [];
  let inSpeech = false;
  let start = 0;
  let silenceRun = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (!inSpeech) {
      if (p >= threshold) { inSpeech = true; start = i; silenceRun = 0; }
    } else {
      if (p < negThreshold) {
        silenceRun++;
        if (silenceRun >= minSilenceFrames) {
          const end = i - silenceRun + 1;
          if (end - start >= minSpeechFrames) segs.push([start, end]);
          inSpeech = false;
          silenceRun = 0;
        }
      } else {
        silenceRun = 0;
      }
    }
  }
  if (inSpeech) {
    const end = probs.length;
    if (end - start >= minSpeechFrames) segs.push([start, end]);
  }

  // Frames -> samples, apply padding, clamp, and merge overlaps created by pad.
  const padded = segs.map(([s, e]) => [
    Math.max(0, s * frameSamples - padSamples),
    Math.min(totalSamples, e * frameSamples + padSamples),
  ]);
  const merged = [];
  for (const seg of padded) {
    const last = merged[merged.length - 1];
    if (last && seg[0] <= last[1]) last[1] = Math.max(last[1], seg[1]);
    else merged.push(seg);
  }
  return merged;
}

// Public API: detect speech segments in 16 kHz mono float32 PCM.
// Returns { segments: [{startSec,endSec}], speechSec, totalSec, hasSpeech }.
// Throws if the model is unavailable — callers should catch and fall back.
async function getSegments(pcm, opts = {}) {
  if (!(pcm instanceof Float32Array)) throw new Error('pcm must be a Float32Array (16 kHz mono)');
  const totalSamples = pcm.length;
  const totalSec = totalSamples / SAMPLE_RATE;
  if (totalSamples < WINDOW) {
    return { segments: [], speechSec: 0, totalSec, hasSpeech: false };
  }
  const probs = await _frameProbabilities(pcm);
  const segSamples = _segmentsFromProbs(probs, totalSamples, opts);
  const segments = segSamples.map(([s, e]) => ({ startSec: s / SAMPLE_RATE, endSec: e / SAMPLE_RATE }));
  const speechSamples = segSamples.reduce((a, [s, e]) => a + (e - s), 0);
  return {
    segments,
    speechSec: speechSamples / SAMPLE_RATE,
    totalSec,
    hasSpeech: segments.length > 0,
  };
}

module.exports = { init, warm, isReady, getSegments, SAMPLE_RATE, WINDOW };
