// The browser half of the two input lines' files and voice (<vc-composer> and
// the terminal tabs' message bar): upload a file, record and transcribe. The
// pure parts (classification, path quoting, cursor insertion) are in
// attach-files.js; the server half is src/session-uploads.js.
//
//   VcInput.upload(file, {tab|sess})   → {path, name, size}  (throws Error(msg))
//   VcInput.mountMic(btn, opts)        a record / stop / transcribe toggle
(function () {
  const A = window.VcAttach;

  async function failure(res) {
    let msg = '';
    try { msg = (await res.json()).error || ''; } catch {}
    return new Error(msg || `request failed (${res.status})`);
  }

  async function upload(file, { tab, sess } = {}) {
    const q = new URLSearchParams({ name: file.name || 'file' });
    if (tab) q.set('tab', tab); else if (sess) q.set('sess', sess);
    const res = await fetch(`/api/session-upload?${q}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' }, body: file,
    });
    if (!res.ok) throw await failure(res);
    return res.json();
  }

  async function transcribe(blob) {
    const type = String(blob.type || 'audio/webm').split(';')[0];
    const res = await fetch('/api/session-transcribe', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': type }, body: blob,
    });
    if (!res.ok) throw await failure(res);
    return (await res.json()).text || '';
  }

  // getUserMedia exists only on https and localhost; say so instead of failing.
  function micUnavailable() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return window.isSecureContext === false
        ? 'Voice input needs https or localhost (this page is not a secure origin)'
        : 'This browser cannot record audio';
    }
    if (typeof window.MediaRecorder === 'undefined') return 'This browser cannot record audio';
    return '';
  }

  // One recording at a time per button. `stop()` resolves to the Blob.
  class Recorder {
    constructor(onTick) { this.onTick = onTick; }
    async start() {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = A.pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
      this.rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
      this.chunks = [];
      this.rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
      this.t0 = Date.now();
      this.timer = setInterval(() => this.onTick(Date.now() - this.t0), 250);
      this.rec.start();
      this.onTick(0);
    }
    _release() {
      clearInterval(this.timer);
      for (const t of this.stream?.getTracks() || []) t.stop();
    }
    stop() {
      return new Promise((resolve) => {
        this.rec.onstop = () => { this._release(); resolve(new Blob(this.chunks, { type: this.rec.mimeType || 'audio/webm' })); };
        this.rec.stop();
      });
    }
    cancel() {
      if (this.rec.state !== 'inactive') { this.rec.onstop = () => {}; this.rec.stop(); }
      this._release();
    }
  }

  // Turns `btn` into the mic of a textarea: click records (the button shows ●
  // and the elapsed time, a ✕ appears beside it), click again stops, and the
  // transcript is inserted at the cursor for editing — never sent. Esc in the
  // textarea or on ✕ discards. opts: { input (textarea), say(text, bad),
  // idle: the button's resting label }.
  function mountMic(btn, { input, say, idle = '🎤' }) {
    const why = micUnavailable();
    if (why) { btn.disabled = true; btn.title = why; btn.classList.add('mic-unavailable'); return { destroy() {} }; }
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = `${btn.className} mic-cancel hidden`;
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Discard the recording (Esc)';
    btn.after(cancelBtn);
    let rec = null;
    let busy = false;
    btn.title = 'Record a voice message (click again to stop and transcribe)';
    btn.textContent = idle;

    const reset = () => {
      rec = null;
      btn.classList.remove('recording');
      btn.textContent = idle;
      btn.title = 'Record a voice message (click again to stop and transcribe)';
      cancelBtn.classList.add('hidden');
      input.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape' || !rec) return;
      e.preventDefault(); e.stopPropagation();
      discard();
    };
    function discard() {
      if (!rec) return;
      rec.cancel(); reset(); say('Recording discarded');
    }
    async function begin() {
      try {
        rec = new Recorder((ms) => { btn.textContent = `● ${A.formatElapsed(ms)}`; });
        await rec.start();
      } catch (e) {
        rec = null;
        say(e?.name === 'NotAllowedError' ? 'Microphone access was denied' : `Could not start recording: ${e?.message || e}`, true);
        return;
      }
      btn.classList.add('recording');
      btn.title = 'Stop and transcribe';
      cancelBtn.classList.remove('hidden');
      input.addEventListener('keydown', onKey, true);
      say('');
    }
    async function finish() {
      const r = rec;
      busy = true;
      btn.disabled = true;
      cancelBtn.classList.add('hidden');
      btn.textContent = '…';
      say('Transcribing…');
      try {
        const blob = await r.stop();
        const text = (await transcribe(blob)).trim();
        if (!text) say('No speech was found in the recording', true);
        else {
          const at = input.selectionStart ?? input.value.length;
          const out = A.insertAtCursor(input.value, at, input.selectionEnd ?? at, text);
          input.value = out.value;
          input.setSelectionRange(out.caret, out.caret);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          say('');
        }
      } catch (e) {
        say(`Voice input failed: ${e.message}`, true);
      } finally {
        busy = false;
        btn.disabled = false;
        reset();
        input.focus();
      }
    }
    btn.addEventListener('click', () => {
      if (busy) return;
      if (rec) finish(); else begin();
    });
    cancelBtn.addEventListener('click', discard);
    return { destroy() { if (rec) rec.cancel(); cancelBtn.remove(); } };
  }

  window.VcInput = { upload, transcribe, micUnavailable, mountMic };
})();
