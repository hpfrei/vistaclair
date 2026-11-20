// Local music ML (MusicGen + beatgrid) — the platform service behind the
// ai.music.* bridge and ctx.music. Thin spawner around the CLI wrappers in
// /opt/vistaclair-ml (installed via Setup > Extras).
//
// Generation saturates the CPU for minutes, so ALL generations platform-wide
// are serialized through one promise chain (concurrency 1) — two apps
// generating at once would thrash both. Analysis (beatgrid) is cheap and runs
// unqueued.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const platformExtras = require('./platform-extras');

const MUSICGEN = path.join(platformExtras.ML_BIN, 'musicgen');
const BEATGRID = path.join(platformExtras.ML_BIN, 'beatgrid');

let queueTail = Promise.resolve();
let queueDepth = 0;
let runningPrompt = null;

function installed() {
  return platformExtras.probe('music-ml');
}

function status() {
  return {
    installed: installed(),
    queue: { running: runningPrompt !== null, runningPrompt, pending: queueDepth - (runningPrompt !== null ? 1 : 0) },
  };
}

function requireInstalled() {
  if (!installed()) {
    throw new Error('Music generation not installed — enable it in Apps > Setup > Extras.');
  }
}

// Spawn a wrapper, parse its JSON stdout line. signal (optional AbortSignal)
// kills the child; that's how job cancellation propagates.
function runTool(bin, args, { signal, timeout = 3600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let out = '', errTail = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-800); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    const onAbort = () => child.kill('SIGKILL');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(new Error('cancelled'));
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch {}
      if (code === 0 && parsed && parsed.ok) return resolve(parsed);
      reject(new Error((parsed && parsed.error) || `${path.basename(bin)} failed (exit ${code}): ${errTail.trim().slice(-400)}`));
    });
  });
}

// Serialized text→music generation. outFile must be an absolute path already
// resolved into the caller's sandbox. onQueue(position) fires when the request
// parks behind others.
function generate({ prompt, duration = 30, seed, model = 'small', continueFrom, outFile, signal, onQueue, onStart }) {
  requireInstalled();
  if (!prompt || !outFile) throw new Error('music.generate requires prompt and outFile');
  if (!['small', 'medium'].includes(model)) throw new Error('model must be "small" or "medium"');
  const dur = Math.min(Math.max(1, Number(duration) || 30), 30);

  queueDepth++;
  const position = queueDepth - 1;
  if (position > 0 && onQueue) onQueue(position);

  const task = queueTail.then(async () => {
    if (signal && signal.aborted) throw new Error('cancelled');
    runningPrompt = String(prompt).slice(0, 80);
    if (onStart) onStart();
    try {
      const args = ['--prompt', String(prompt), '--duration', String(dur), '--out', outFile];
      if (seed !== undefined && seed !== null) args.push('--seed', String(seed));
      if (model !== 'small') args.push('--model', model);
      if (continueFrom) args.push('--continue-from', continueFrom);
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      return await runTool(MUSICGEN, args, { signal });
    } finally {
      runningPrompt = null;
      queueDepth--;
    }
  });
  // Keep the chain alive past failures.
  queueTail = task.catch(() => {});
  return task;
}

// Beat/tempo analysis. Cheap (librosa, seconds) — not queued. Needs only the
// venv + wrapper, not the MusicGen weights, so it works mid-install too.
function analyze({ file, tightness, signal }) {
  if (!fs.existsSync(BEATGRID)) {
    throw new Error('Music analysis not installed — enable "Local music generation" in Apps > Setup > Extras.');
  }
  if (!file) throw new Error('music.analyze requires file');
  if (!fs.existsSync(file)) throw new Error('audio file not found: ' + file);
  const args = ['--in', file];
  if (tightness) args.push('--tightness', String(tightness));
  return runTool(BEATGRID, args, { signal, timeout: 300000 });
}

module.exports = { status, generate, analyze, installed };
