// Audio preprocessing for the transcribe bridge (ai.transcribe).
//
// Binary resolution policy (decided with the operator):
//   1. Prefer SYSTEM ffmpeg/ffprobe on PATH — apps that shell out get the full
//      suite (ffprobe, ffplay, all codecs), and the platform shares one binary.
//   2. If system ffmpeg is missing, auto-install it (apt-get, when sudo is
//      available) once per process, in the background — so ffprobe also lands.
//   3. ffmpeg-static is a guaranteed last-resort fallback for the transcribe
//      path so preprocessing never hard-fails on a bare host (note: it ships
//      ffmpeg only, no ffprobe).
//
// Preprocessing pipeline (best-effort; on ANY failure we fall back to the
// original bytes so transcription still happens). All work is done on 16 kHz
// mono PCM (Whisper's native rate); the final upload is FLAC (lossless, compact):
//
//   decode → Silero VAD speech-trim → two-pass EBU R128 loudnorm → 16 kHz FLAC
//
// Design notes (why this order, what's on by default):
//   • Loudness normalization is the headline fix for quiet recordings. We use a
//     TWO-PASS EBU R128 loudnorm (measure, then apply with the measured stats +
//     linear=true) targeting I=-16 / TP=-1.5 / LRA=11. It only rescales level —
//     it does NOT touch spectral detail, so it can't trigger the "denoising
//     penalty" that hurts Whisper accuracy. On by default (`enhance`).
//   • Silence trimming uses Silero VAD (silero-vad.js) — a learned speech
//     detector — instead of ffmpeg's energy-gate silenceremove. It cuts to
//     actual speech, shrinking the upload and reducing Whisper's tendency to
//     hallucinate over long non-speech stretches. Falls back to silenceremove
//     when the ONNX model can't load. On by default (`trimSilence`).
//   • Spectral denoise (afftdn) + low-pass band-limit are OPT-IN (`denoise`),
//     because they alter spectral content and can *reduce* Whisper accuracy.
//   • A gentle high-pass (60 Hz, removes DC/rumble) rides along with `enhance`.

const { execFile, execFileSync, exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let _resolved = null;        // { ffmpeg, ffprobe } absolute paths/commands
let _installAttempted = false;

function _onPath(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function _staticFfmpeg() {
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return null;
}

// Kick off a background apt install of ffmpeg when it's missing and sudo is
// available. Fire-and-forget: the static binary covers the current process;
// this makes the full system suite (incl. ffprobe) available going forward.
function _maybeAutoInstall() {
  if (_installAttempted) return;
  _installAttempted = true;
  let hasSudo = false;
  try { hasSudo = require('./env-detect').detect().hasSudo; } catch {}
  if (!hasSudo) {
    console.warn('[media-ffmpeg] system ffmpeg not found and no passwordless sudo — using bundled ffmpeg-static (no ffprobe for apps). Install ffmpeg manually for the full suite.');
    return;
  }
  console.log('[media-ffmpeg] system ffmpeg not found — installing via apt-get in the background...');
  exec('sudo -n apt-get update && sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg',
    { timeout: 300000 },
    (err) => {
      if (err) {
        console.warn(`[media-ffmpeg] apt-get install ffmpeg failed: ${err.message}. Falling back to ffmpeg-static.`);
      } else {
        console.log('[media-ffmpeg] ffmpeg installed (ffmpeg + ffprobe now on PATH).');
        try { require('./env-detect').invalidate(); } catch {}
        _resolved = null; // re-resolve to prefer the freshly installed system binary
      }
    });
}

// Resolve which binaries to use. System first; static fallback. Triggers a
// background install when the system binary is absent.
function resolve() {
  if (_resolved) return _resolved;
  const sysFfmpeg = _onPath('ffmpeg');
  const sysFfprobe = _onPath('ffprobe');
  if (sysFfmpeg) {
    _resolved = { ffmpeg: 'ffmpeg', ffprobe: sysFfprobe ? 'ffprobe' : null, source: 'system' };
    return _resolved;
  }
  _maybeAutoInstall();
  const stat = _staticFfmpeg();
  if (stat) {
    _resolved = { ffmpeg: stat, ffprobe: null, source: 'static' };
    return _resolved;
  }
  _resolved = { ffmpeg: null, ffprobe: null, source: 'none' };
  return _resolved;
}

// Eagerly resolve at boot so a missing system ffmpeg triggers the background
// install early (well before the first transcribe call).
function init() {
  const r = resolve();
  if (r.source === 'static') {
    // resolve() already kicked off the background install attempt.
  } else if (r.source === 'none') {
    console.warn('[media-ffmpeg] no ffmpeg available (system or bundled). ai.transcribe will send raw audio without preprocessing.');
  }
  return r;
}

function isAvailable() {
  return !!resolve().ffmpeg;
}

function _run(bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr ? stderr.toString() : '';
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

const TARGET_SR = 16000; // Whisper's native rate
const BYTES_PER_SAMPLE = 4; // f32le

// Minimum audible duration. OpenAI's transcription models reject anything under
// 0.1s; we use a slightly larger floor so a clip that's effectively silence
// (a stray click, a header-only stream) is reported as silent rather than sent.
const MIN_AUDIBLE_SEC = 0.15;

// Decode ANY input (any codec/container, incl. header-less MediaRecorder webm)
// to 16 kHz mono float32 PCM. This single canonical form is what VAD, loudnorm
// measurement, and the final encode all operate on. `preFilter` lets the caller
// fold in cheap level-preserving filters (e.g. a high-pass) during decode.
async function _decodeToPcm(bin, inPath, preFilter, timeout) {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', inPath];
  if (preFilter) args.push('-af', preFilter);
  args.push('-ac', '1', '-ar', String(TARGET_SR), '-f', 'f32le', '-');
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) { err.stderr = stderr ? stderr.toString() : ''; return reject(err); }
        const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        const aligned = buf.length - (buf.length % BYTES_PER_SAMPLE);
        resolve(new Float32Array(buf.buffer, buf.byteOffset, aligned / BYTES_PER_SAMPLE));
      });
  });
}

// Two-pass EBU R128 loudnorm on a float32 PCM buffer. Pass 1 measures, pass 2
// applies with the measured stats + linear=true so the gain is a single level
// rescale (no spectral coloring, no dynamic pumping). Returns adjusted PCM, or
// the input unchanged if measurement/encoding fails. Level-only by design.
// `targetI` is the integrated-loudness target in LUFS (default -16).
async function _twoPassLoudnorm(bin, pcm, timeout, targetI = -16) {
  const I = targetI, TP = -1.5, LRA = 11;
  const writePcm = (proc) => { proc.stdin.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)); proc.stdin.end(); };

  // --- Pass 1: measure ---
  const measure = await _runWithStdin(bin, [
    '-hide_banner', '-f', 'f32le', '-ar', String(TARGET_SR), '-ac', '1', '-i', 'pipe:0',
    '-af', `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`, '-f', 'null', '-',
  ], pcm, timeout).catch((e) => ({ stderr: e.stderr || '' }));

  let stats = null;
  const jsonMatch = String(measure.stderr || '').match(/\{[\s\S]*?\}/);
  if (jsonMatch) { try { stats = JSON.parse(jsonMatch[0]); } catch {} }
  if (!stats || stats.input_i == null) return pcm; // can't measure → leave level as-is
  // Silence/near-silence yields -inf measurements that loudnorm's apply pass
  // rejects (out of [-99,0]). Nothing to normalize anyway — skip the second pass.
  const finite = (v) => Number.isFinite(parseFloat(v));
  if (![stats.input_i, stats.input_tp, stats.input_lra, stats.input_thresh, stats.target_offset].every(finite)) return pcm;

  // --- Pass 2: apply with measured values (linear, single-pass gain) ---
  const af = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:linear=true`
    + `:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}`
    + `:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}`
    + `:offset=${stats.target_offset}`;
  try {
    const out = await _runWithStdin(bin, [
      '-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(TARGET_SR), '-ac', '1', '-i', 'pipe:0',
      '-af', af, '-ac', '1', '-ar', String(TARGET_SR), '-f', 'f32le', '-',
    ], pcm, timeout, true);
    const buf = out.stdout;
    const aligned = buf.length - (buf.length % BYTES_PER_SAMPLE);
    if (aligned >= BYTES_PER_SAMPLE) return new Float32Array(buf.buffer, buf.byteOffset, aligned / BYTES_PER_SAMPLE);
  } catch (err) {
    console.warn(`[media-ffmpeg] loudnorm apply failed (${err.message}); using pre-norm audio.`);
  }
  return pcm;
}

// Concatenate sample-range [start,end] segments of a PCM buffer into one
// contiguous buffer (ranges must be pre-merged & sorted; in the same timeline).
function _spliceSegments(pcm, ranges) {
  let total = 0;
  for (const [s, e] of ranges) total += Math.max(0, e - s);
  const out = new Float32Array(total);
  let off = 0;
  for (const [s, e] of ranges) { if (e > s) { out.set(pcm.subarray(s, e), off); off += e - s; } }
  return out;
}

// Merge a list of [start,end] sample ranges: drop empties, sort, coalesce
// overlapping/adjacent spans into a minimal ordered set.
function _mergeRanges(ranges) {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

// RMS energy floor (linear, ~-48 dBFS) below which audio is treated as true
// silence. After loudnorm, speech sits far above this; only genuine gaps fall
// under it. Used as a safety net alongside the VAD (see _audibleSegments).
const SILENCE_FLOOR_RMS = 0.004;

// [start,end] sample ranges where short-window RMS stays above the silence
// floor, with the same gap-bridging (minSilenceMs) + padding (speechPadMs) the
// VAD path uses. This catches AUDIBLE speech the learned VAD under-scores (it
// can rate genuine, quiet speech below the keep-threshold) so trimming never
// discards real content — only space that is BOTH non-speech AND silent is cut.
function _audibleSegments(pcm, minSilenceMs, speechPadMs) {
  const frame = 512; // ~32 ms at 16 kHz, matches the VAD window
  const minSilenceFrames = Math.max(1, Math.round((minSilenceMs / 1000) * TARGET_SR / frame));
  const padSamples = Math.round((speechPadMs / 1000) * TARGET_SR);
  const runs = [];
  let inRun = false, start = 0, silenceRun = 0;
  for (let off = 0; off < pcm.length; off += frame) {
    const end = Math.min(pcm.length, off + frame);
    let sum = 0;
    for (let i = off; i < end; i++) sum += pcm[i] * pcm[i];
    const rms = Math.sqrt(sum / (end - off));
    if (rms >= SILENCE_FLOOR_RMS) {
      if (!inRun) { inRun = true; start = off; }
      silenceRun = 0;
    } else if (inRun) {
      silenceRun++;
      if (silenceRun >= minSilenceFrames) {
        runs.push([start, off - (silenceRun - 1) * frame]);
        inRun = false; silenceRun = 0;
      }
    }
  }
  if (inRun) runs.push([start, pcm.length]);
  return runs.map(([s, e]) => [Math.max(0, s - padSamples), Math.min(pcm.length, e + padSamples)]);
}

// Encode a float32 PCM buffer to 16 kHz mono FLAC bytes.
async function _pcmToFlac(bin, pcm, outPath, timeout) {
  await _runWithStdin(bin, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'f32le', '-ar', String(TARGET_SR), '-ac', '1', '-i', 'pipe:0',
    '-c:a', 'flac', outPath,
  ], pcm, timeout);
  return fs.readFileSync(outPath);
}

// execFile variant that pipes a Buffer to stdin. `wantStdoutBuffer` returns
// stdout as a Buffer (for PCM passthrough); otherwise resolves {stdout,stderr}.
function _runWithStdin(bin, args, inputBuf, timeout, wantStdoutBuffer) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout, maxBuffer: 256 * 1024 * 1024, encoding: wantStdoutBuffer ? 'buffer' : 'utf8' },
      (err, stdout, stderr) => {
        if (err) { err.stderr = stderr ? stderr.toString() : ''; return reject(err); }
        resolve({ stdout: wantStdoutBuffer ? (Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)) : stdout, stderr });
      });
    child.stdin.on('error', () => {}); // ignore EPIPE if ffmpeg exits early
    child.stdin.write(Buffer.from(inputBuf.buffer, inputBuf.byteOffset, inputBuf.byteLength));
    child.stdin.end();
  });
}

// ffmpeg silenceremove fallback (used only when Silero VAD is unavailable).
// Trims leading/trailing silence; with trimInternal also collapses long gaps.
function _silenceremoveFilter(trimInternal) {
  const parts = ['silenceremove=start_periods=1:start_silence=0.3:start_threshold=-45dB:detection=peak'];
  if (trimInternal) parts.push('silenceremove=stop_periods=-1:stop_silence=0.5:stop_threshold=-45dB:stop_duration=1:detection=peak');
  parts.push('areverse', 'silenceremove=start_periods=1:start_silence=0.3:start_threshold=-45dB:detection=peak', 'areverse');
  return parts.join(',');
}

// Preprocess a raw audio Buffer for Whisper. Returns { buffer, filename,
// mimeType, processed, durationSec, silent, trim }:
//   processed=false  → we fell back to the (re-encoded or original) input
//   silent=true      → no audible/speech audio survived; caller should NOT upload
//   trim             → 'vad' | 'silenceremove' | 'none' (how silence was trimmed)
// We always verify the decoded duration of whatever we return, so we never hand
// back a zero-duration clip (the cause of OpenAI's "audio duration 0.0 seconds"
// 400 — common with MediaRecorder webm, whose container has no duration header).
//
// opts: enhance (loudnorm, default true), trimSilence (VAD trim, default true),
//   trimInternal (collapse internal gaps; false when caller wants timestamps),
//   denoise (opt-in spectral denoise + band-limit, default false).
// Numeric tuning (all optional; defaults match the constants used before):
//   loudnessTarget — integrated-loudness target in LUFS for `enhance` (default -16).
//   denoiseNf      — afftdn noise-floor in dB for `denoise` (default -25; more
//                    negative = gentler). vadThreshold — Silero speech probability
//                    cutoff 0..1 (default 0.5; higher = stricter). minSilenceMs —
//                    gap length before a cut (default 100). speechPadMs — padding
//                    kept around each speech segment (default 30).
async function preprocessAudio(inputBuf, opts = {}) {
  const {
    enhance = true,
    trimSilence = true,
    trimInternal = true,
    denoise = false,
    inputExt = 'audio',
    timeout = 120000,
    loudnessTarget = -16,
    denoiseNf = -25,
    vadThreshold = 0.5,
    minSilenceMs = 100,
    speechPadMs = 30,
  } = opts;

  const r = resolve();
  const fallback = { buffer: inputBuf, filename: `audio.${_extFor(inputExt)}`, mimeType: _mimeFor(inputExt), processed: false, durationSec: null, silent: false, trim: 'none' };
  if (!r.ffmpeg) return fallback;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-audio-'));
  const outPath = path.join(tmpDir, 'out.flac');

  // Level-preserving decode filters: a gentle high-pass with enhance (kills
  // DC/rumble without coloring speech); denoise adds afftdn + an 8 kHz low-pass
  // (opt-in — alters spectrum, can hurt Whisper).
  const decodeParts = [];
  if (enhance || denoise) decodeParts.push('highpass=f=60');
  if (denoise) { decodeParts.push(`afftdn=nf=${denoiseNf}`); decodeParts.push('lowpass=f=8000'); }
  const preFilter = decodeParts.join(',');

  try {
    const inPath = path.join(tmpDir, `in.${_extFor(inputExt)}`);
    fs.writeFileSync(inPath, inputBuf);

    // 1) Decode to canonical 16 kHz mono float32 PCM (handles header-less webm).
    let pcm;
    try {
      pcm = await _decodeToPcm(r.ffmpeg, inPath, preFilter, timeout);
    } catch (err) {
      console.warn(`[media-ffmpeg] decode failed (${err.message}); sending original audio.`);
      return fallback;
    }
    if (!pcm.length || pcm.length / TARGET_SR < MIN_AUDIBLE_SEC) {
      return { ...fallback, durationSec: pcm.length / TARGET_SR, silent: true };
    }

    // 2) Two-pass EBU R128 loudnorm FIRST (level only — no spectral change).
    //    Normalizing before VAD is what fixes quiet recordings: it lifts a faint
    //    voice to a consistent level so the detector reliably finds the speech
    //    (running VAD on raw quiet audio misses most of it).
    let leveled = pcm;
    if (enhance) {
      try { leveled = await _twoPassLoudnorm(r.ffmpeg, pcm, timeout, loudnessTarget); }
      catch (err) { console.warn(`[media-ffmpeg] loudnorm failed (${err.message}); using un-normalized audio.`); }
    }

    // 3) Speech-trim the leveled audio. Prefer Silero VAD (learned, cuts to
    //    actual speech); fall back to ffmpeg silenceremove if the model can't load.
    let trim = 'none';
    let final = leveled;
    if (trimSilence) {
      try {
        const vad = require('./silero-vad');
        const det = await vad.getSegments(leveled, { threshold: vadThreshold, minSilenceMs, speechPadMs });

        // Keep the UNION of VAD-detected speech and audibly-energetic regions.
        // The VAD can under-score genuine but quiet speech (rating it below the
        // keep-threshold); splicing on the VAD alone then discards that audio —
        // e.g. real speech that resumes after a pause vanishes. Unioning with an
        // RMS-audibility pass means only space that is BOTH non-speech AND truly
        // silent is cut; any audible content survives regardless of VAD score.
        const vadRanges = det.segments.map(({ startSec, endSec }) => [
          Math.max(0, Math.floor(startSec * TARGET_SR)),
          Math.min(leveled.length, Math.ceil(endSec * TARGET_SR)),
        ]);
        const audibleRanges = _audibleSegments(leveled, minSilenceMs, speechPadMs);
        let ranges = _mergeRanges([...vadRanges, ...audibleRanges]);

        if (!ranges.length) {
          // Nothing audible and no speech anywhere → genuine silence.
          return { ...fallback, durationSec: det.totalSec, silent: true };
        }
        if (!trimInternal) {
          // Preserve internal timing: keep one span from first kept sample to last.
          ranges = [[ranges[0][0], ranges[ranges.length - 1][1]]];
        }
        final = _spliceSegments(leveled, ranges);
        trim = 'vad';
      } catch (err) {
        // VAD unavailable → ffmpeg silenceremove on the leveled PCM.
        try {
          const flacTmp = path.join(tmpDir, 'sr.f32');
          await _runWithStdin(r.ffmpeg, [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'f32le', '-ar', String(TARGET_SR), '-ac', '1', '-i', 'pipe:0',
            '-af', _silenceremoveFilter(trimInternal), '-ac', '1', '-ar', String(TARGET_SR), '-f', 'f32le', flacTmp,
          ], leveled, timeout);
          const sb = fs.readFileSync(flacTmp);
          const aligned = sb.length - (sb.length % BYTES_PER_SAMPLE);
          if (aligned >= BYTES_PER_SAMPLE) { final = new Float32Array(sb.buffer, sb.byteOffset, aligned / BYTES_PER_SAMPLE); trim = 'silenceremove'; }
        } catch (e2) {
          console.warn(`[media-ffmpeg] silenceremove fallback failed (${e2.message}); keeping untrimmed audio.`);
        }
      }
    }

    if (!final.length || final.length / TARGET_SR < MIN_AUDIBLE_SEC) {
      return { ...fallback, durationSec: final.length / TARGET_SR, silent: true };
    }

    // 4) Encode to 16 kHz mono FLAC and verify a real duration came out.
    const flac = await _pcmToFlac(r.ffmpeg, final, outPath, timeout);
    const durationSec = final.length / TARGET_SR;
    if (!flac || flac.length < 256 || durationSec < MIN_AUDIBLE_SEC) {
      return { ...fallback, durationSec, silent: true };
    }
    return { buffer: flac, filename: 'audio.flac', mimeType: 'audio/flac', processed: true, durationSec, silent: false, trim, source: r.source };
  } catch (err) {
    console.warn(`[media-ffmpeg] preprocessing failed (${err.message}); sending original audio.`);
    return fallback;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function _extFor(hint) {
  const h = String(hint || '').toLowerCase();
  if (h.includes('wav')) return 'wav';
  if (h.includes('webm')) return 'webm';
  if (h.includes('ogg')) return 'ogg';
  if (h.includes('flac')) return 'flac';
  if (h.includes('m4a') || h.includes('mp4') || h.includes('aac')) return 'm4a';
  return 'mp3';
}

function _mimeFor(hint) {
  const ext = _extFor(hint);
  return ({ wav: 'audio/wav', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', mp3: 'audio/mpeg' })[ext];
}

// Re-encode a WAV clip to another codec (a TTS vendor that only returns WAV,
// asked for mp3/opus/aac/flac). Throws when ffmpeg is missing or fails — the
// caller asked for a format, so silently handing back WAV would be a lie.
const TRANSCODE_ARGS = {
  mp3: ['-f', 'mp3', '-codec:a', 'libmp3lame', '-b:a', '128k'],
  opus: ['-f', 'ogg', '-codec:a', 'libopus', '-b:a', '64k'],
  aac: ['-f', 'adts', '-codec:a', 'aac', '-b:a', '128k'],
  flac: ['-f', 'flac'],
};
async function transcodeWav(wavBuf, to, { timeout = 60000 } = {}) {
  const out = TRANSCODE_ARGS[to];
  if (!out) throw new Error(`cannot transcode to "${to}" (${Object.keys(TRANSCODE_ARGS).join(', ')})`);
  const bin = resolve().ffmpeg;
  if (!bin) throw new Error(`format "${to}" needs ffmpeg to convert this voice's WAV output, and none is available`);
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', ...out, 'pipe:1'];
  const { stdout } = await _runWithStdin(bin, args, wavBuf, timeout, true);
  if (!stdout.length) throw new Error(`ffmpeg produced no ${to} output`);
  return stdout;
}

module.exports = { init, resolve, isAvailable, preprocessAudio, transcodeWav };
