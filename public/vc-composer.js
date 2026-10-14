// <vc-composer>: the message box of an Agent SDK panel. A textarea plus image
// attachments from three gestures (Ctrl-V paste, drag/drop, the file picker),
// all through one addFiles() so the size guards and the base64 conversion
// cannot drift between them. It knows nothing about sessions: it emits
//   send       {text, images:[{mediaType, base64, name}]}
//   interrupt  (Esc)
//   target-clear (the × on the "to: <name>" chip)
// and the panel decides where they go.
(function () {
  const FILE_MAX = 8 * 1024 * 1024;
  const TOTAL_MAX = 18 * 1024 * 1024;

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
      this._reading = new Set();
      this._detachers = [];
    }

    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this.classList.add('vc-composer');
      this.innerHTML = `
        <div class="vc-composer-chips">
          <span class="vc-composer-target hidden"><span class="vc-composer-target-label"></span><button type="button" class="vc-composer-target-x" title="Back to the default target">×</button></span>
        </div>
        <div class="vc-composer-row">
          <button type="button" class="vc-composer-attach" title="Attach images (or paste / drop them)">+</button>
          <textarea rows="1" spellcheck="true"></textarea>
          <button type="button" class="vc-composer-send" title="Send (Enter)">➤</button>
        </div>
        <div class="vc-composer-note hidden"></div>
        <input type="file" accept="image/*" multiple hidden>`;
      this._chips = this.querySelector('.vc-composer-chips');
      this._targetEl = this.querySelector('.vc-composer-target');
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
      this._targetEl.querySelector('.vc-composer-target-x').addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('target-clear', { bubbles: true }));
      });
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
      for (const a of this._atts) URL.revokeObjectURL(a.url);
    }

    get value() { return this._input?.value || ''; }
    set value(v) { if (this._input) { this._input.value = v; this._grow(); } }

    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) {
      this.toggleAttribute('disabled', !!v);
      if (this._input) this._input.disabled = !!v;
      this.querySelectorAll('button').forEach(b => { if (!b.classList.contains('vc-composer-target-x')) b.disabled = !!v; });
    }

    focus() { this._input?.focus(); }

    // "to: <name>" chip; null hides it.
    setTarget(label) {
      if (!this._targetEl) return;
      this._targetEl.classList.toggle('hidden', !label);
      this._targetEl.querySelector('.vc-composer-target-label').textContent = label ? `to: ${label}` : '';
    }

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
        if (!file.type.startsWith('image/')) { this._say(`"${file.name || 'that file'}" is not an image; only images can be attached`, true); continue; }
        if (file.size > FILE_MAX) { this._say(`"${file.name || 'that image'}" is too large (max ${fmtSize(FILE_MAX)})`, true); continue; }
        const total = this._atts.reduce((s, a) => s + a.size, 0) + this._pendingBytes();
        if (total + file.size > TOTAL_MAX) { this._say(`Attachments exceed ${fmtSize(TOTAL_MAX)} total`, true); break; }
        const name = nameFor(file);
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

    _pendingBytes() { let n = 0; for (const j of this._reading) n += j.size || 0; return n; }

    async send() {
      if (this.disabled) return;
      // An image still being read would otherwise be dropped from this send.
      if (this._reading.size) await Promise.all([...this._reading]);
      const text = this._input.value.replace(/\s+$/, '');
      if (!text.trim() && !this._atts.length) return;
      const images = this._atts.map(({ mediaType, base64, name }) => ({ mediaType, base64, name }));
      this.dispatchEvent(new CustomEvent('send', { bubbles: true, detail: { text, images } }));
      this.clear();
    }

    clear() {
      for (const a of this._atts) URL.revokeObjectURL(a.url);
      this._atts = [];
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
