// <vc-composer>: the message box of an Agent SDK panel. A textarea plus
// attachments from three gestures (Ctrl-V paste, drag/drop, the file picker),
// all through one addFiles() so the size guards cannot drift between them.
// An image becomes a base64 block; any other file is uploaded to the session's
// uploads/ folder (needs the tab-id or sess-id attribute) and the sent text
// gets an "Attached: /abs/path" line for it. The mic records, transcribes
// (platform audio tool) and puts the text in the textarea; it never sends. It knows nothing about sessions: it emits
//   send       {text, images:[{mediaType, base64, name}]}  (Enter, Ctrl+Enter, ➤)
//   interrupt  (Esc)
// and the panel decides where they go. A send does not clear the draft: the
// panel calls clear() once the message has really gone out.
(function () {
  const A = window.VcAttach;
  const FILE_MAX = A.IMAGE_MAX;
  const TOTAL_MAX = A.IMAGES_TOTAL_MAX;

  const fmtSize = (n) => n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(n % (1024 * 1024) ? 1 : 0)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  // A pasted screenshot arrives as a File with an empty name; give it one so
  // the chip, the upload and the transcript do not all read "image".
  function nameFor(file) {
    if (file.name) return file.name;
    const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/\+.*$/, '');
    return `pasted-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`;
  }

  class VcComposer extends HTMLElement {
    constructor() {
      super();
      this._atts = [];        // {name, mediaType, base64, size, url}
      this._files = [];       // uploaded non-images: {name, size, path}
      this._reading = new Set();
      this._detachers = [];
    }

    static get observedAttributes() { return ['placeholder']; }

    // The panel words its hint once it knows the tab's role.
    attributeChangedCallback(name, _old, value) {
      if (name === 'placeholder' && this._input && value) this._input.placeholder = value;
    }

    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.classList.add('vc-composer');
      this.innerHTML = `
        <div class="vc-composer-chips"></div>
        <div class="vc-composer-row">
          <button type="button" class="vc-composer-attach" title="Attach files or images (or paste / drop them)">+</button>
          <textarea rows="1" spellcheck="true"></textarea>
          <button type="button" class="vc-composer-mic">🎤</button>
          <button type="button" class="vc-composer-send" title="Send (Enter)">➤</button>
        </div>
        <div class="vc-composer-note hidden"></div>
        <input type="file" multiple hidden>`;
      this._chips = this.querySelector('.vc-composer-chips');
      this._input = this.querySelector('textarea');
      this._note = this.querySelector('.vc-composer-note');
      this._file = this.querySelector('input[type=file]');
      const narrow = window.matchMedia?.('(max-width: 640px)').matches;
      this._input.placeholder = this.getAttribute('placeholder')
        || (narrow ? 'Message…' : 'Message… (Enter sends, Shift+Enter new line, Esc interrupts)');

      this.querySelector('.vc-composer-attach').addEventListener('click', () => this._file.click());
      this._file.addEventListener('change', () => {
        const files = [...this._file.files];
        this._file.value = '';
        this.addFiles(files);
      });
      this.querySelector('.vc-composer-send').addEventListener('click', () => this.send());
      this._mic = window.VcInput?.mountMic(this.querySelector('.vc-composer-mic'), { input: this._input, say: (t, bad) => this._say(t, bad) });
      this._input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
        else if (e.key === 'Escape') { e.preventDefault(); this.dispatchEvent(new CustomEvent('interrupt', { bubbles: true })); }
      });
      this._input.addEventListener('input', () => this._grow());
      // Files on the clipboard become attachments; a plain text paste falls
      // through to the textarea.
      this.addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (!files.length) return;
        e.preventDefault();
        this.addFiles(files);
      });
      this.attachDropTarget(this);
    }

    disconnectedCallback() {
      this._mic?.destroy();
      for (const a of this._atts) URL.revokeObjectURL(a.url);
    }

    get value() { return this._input?.value || ''; }
    set value(v) { if (this._input) { this._input.value = v; this._grow(); } }

    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) {
      this.toggleAttribute('disabled', !!v);
      if (this._input) this._input.disabled = !!v;
      this.querySelectorAll('button').forEach(b => { b.disabled = !!v || b.classList.contains('mic-unavailable'); });
    }

    focus() { this._input?.focus(); }

    // Any element can take drops for this composer (the whole panel does).
    // The counter goes up and down rather than toggling on every dragenter:
    // moving over a child fires dragleave on the parent, and a boolean would
    // flicker the drop target away under the cursor. Only drags carrying
    // files count, so dragging text or a tab around does nothing.
    attachDropTarget(el) {
      let depth = 0;
      const on = (type, fn) => { el.addEventListener(type, fn); this._detachers.push(() => el.removeEventListener(type, fn)); };
      on('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); depth++; el.classList.add('vc-dropping');
      });
      on('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      });
      on('dragleave', (e) => {
        if (!hasFiles(e)) return;
        if (--depth <= 0) { depth = 0; el.classList.remove('vc-dropping'); }
      });
      on('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth = 0; el.classList.remove('vc-dropping');
        // Nested targets (the composer inside its panel) all see the drop and
        // reset their highlight; only the first one takes the files.
        if (e.__vcTaken) return;
        e.__vcTaken = true;
        this.addFiles([...(e.dataTransfer.files || [])]);
      });
    }

    addFiles(files) {
      this._say('');
      for (const file of files) {
        const name = nameFor(file);
        const verdict = A.classifyFile({ name, size: file.size, type: file.type });
        if (verdict.kind === 'reject') { this._say(verdict.reason, true); continue; }
        if (verdict.kind === 'file') { this._upload(file, name); continue; }
        const total = this._atts.reduce((s, a) => s + a.size, 0) + this._pendingBytes();
        if (total + file.size > TOTAL_MAX) { this._say(`Attachments exceed ${fmtSize(TOTAL_MAX)} total`, true); break; }
        const job = new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = String(reader.result).split(',')[1] || '';
            this._atts.push({ name, mediaType: file.type, base64, size: file.size, url: URL.createObjectURL(file) });
            this._renderChips();
            resolve();
          };
          reader.onerror = () => { this._say(`Could not read "${name}"`, true); resolve(); };
          reader.readAsDataURL(file);
        });
        job.size = file.size;
        this._reading.add(job);
        job.then(() => this._reading.delete(job));
      }
    }

    // A non-image file goes to the server; its chip appears (marked "…") at
    // once and send() waits for it like it waits for an image being read.
    _upload(file, name) {
      const where = { tab: this.getAttribute('tab-id'), sess: this.getAttribute('sess-id') };
      if (!where.tab && !where.sess) { this._say(`"${name}" cannot be attached here (no session to save it in)`, true); return; }
      const chip = { name, size: file.size, path: null };
      this._files.push(chip);
      this._renderChips();
      const job = window.VcInput.upload(file, where).then((r) => { chip.path = r.path; }, (e) => {
        this._files = this._files.filter(c => c !== chip);
        this._say(`"${name}" was not attached: ${e.message}`, true);
      }).then(() => this._renderChips());
      job.size = 0;
      this._reading.add(job);
      job.then(() => this._reading.delete(job));
    }

    _pendingBytes() { let n = 0; for (const j of this._reading) n += j.size || 0; return n; }

    async send() {
      if (this.disabled) return;
      // An image still being read would otherwise be dropped from this send.
      if (this._reading.size) await Promise.all([...this._reading]);
      const typed = this._input.value.replace(/\s+$/, '');
      const text = A.withAttached(typed, this._files.map(f => f.path));
      if (!text.trim() && !this._atts.length) return;
      const images = this._atts.map(({ mediaType, base64, name }) => ({ mediaType, base64, name }));
      this.dispatchEvent(new CustomEvent('send', { bubbles: true, detail: { text, images } }));
    }

    clear() {
      for (const a of this._atts) URL.revokeObjectURL(a.url);
      this._atts = [];
      this._files = [];
      this._input.value = '';
      this._grow();
      this._renderChips();
      this._say('');
    }

    _grow() {
      this._input.style.height = '';
      this._input.style.height = Math.min(this._input.scrollHeight, 200) + 'px';
    }

    _say(text, bad) {
      this._note.textContent = text;
      this._note.classList.toggle('hidden', !text);
      this._note.classList.toggle('bad', !!bad);
    }

    _renderChips() {
      this._chips.querySelectorAll('.vc-composer-att').forEach(el => el.remove());
      this._files.forEach((f) => {
        const chip = document.createElement('span');
        chip.className = 'vc-composer-att vc-composer-file' + (f.path ? '' : ' uploading');
        chip.title = f.path ? `${f.path} · ${fmtSize(f.size)}` : `Uploading ${f.name}…`;
        const lbl = document.createElement('span');
        lbl.className = 'vc-composer-file-name';
        lbl.textContent = `📎 ${f.name}${f.path ? '' : ' …'}`;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'vc-composer-att-x vc-composer-file-x';
        rm.textContent = '×';
        rm.title = 'Remove';
        rm.addEventListener('click', () => { this._files = this._files.filter(c => c !== f); this._renderChips(); });
        chip.append(lbl, rm);
        this._chips.appendChild(chip);
      });
      this._atts.forEach((a, i) => {
        const chip = document.createElement('span');
        chip.className = 'vc-composer-att';
        chip.title = `${a.name} · ${fmtSize(a.size)}`;
        const img = document.createElement('img');
        img.src = a.url;
        img.alt = a.name;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'vc-composer-att-x';
        rm.textContent = '×';
        rm.title = 'Remove';
        rm.addEventListener('click', () => {
          const [gone] = this._atts.splice(i, 1);
          if (gone) URL.revokeObjectURL(gone.url);
          this._renderChips();
        });
        chip.append(img, rm);
        this._chips.appendChild(chip);
      });
    }
  }

  if (!customElements.get('vc-composer')) customElements.define('vc-composer', VcComposer);
})();
