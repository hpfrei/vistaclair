// <vc-model-picker> — inline <select> of platform AI models, populated from the
// bridge (ai.models). Part of the vistaclair `vc-*` system. Shadow-DOM,
// theme-aware, built on vc-core (`Vc.Element`). Use this when you want a model
// dropdown embedded in your own form. (For a full-screen modal chooser, use the
// host-rendered window.pickModel().)
//
// Usage:
//   <vc-model-picker id="m" configured-only value="claude-haiku-4-5"></vc-model-picker>
//   <vc-model-picker configured-only persist-key="scriptModel"></vc-model-picker>
//   m.addEventListener('change', () => console.log(m.value));
//   await m.ready;        // resolves once models are loaded
// Attributes: value (selected model name), all-models (offer unusable models
//   too — see below), provider (filter to one provider), placeholder (label for
//   the empty/no-selection row), show-cost (append $in/$out per Mtok),
//   persist-key (remember the choice under this key across reloads),
//   persist-scope ("settings" default | "state").
//
// Only models the platform can actually call are offered, and that is the
// DEFAULT — `all-models` opts out. (`configured-only` is still accepted and is
// now a no-op, since it describes the default.) The opposite default used to
// offer models that failed at call time for want of a credential.
//
// persist-scope picks the store behind `persist-key`. "settings" (the default)
// writes to the app's `.settings.json`, which the app's own BACKEND can read as
// `ctx.settings.get(...)` — which is what you want for a model choice, because
// the backend is what makes the call. "state" writes to `.state.json`, which is
// reachable only from the iframe; use it for view preferences the server never
// needs. A value written under the old state-backed default is still read as a
// fallback, so an existing app keeps its stored choice.
// Properties: value (get/set), models (the offered list), ready (Promise).
// Event: change — fired on user selection (detail: { value, model, kind }).
//
// Model types — `kind`: "text" (the default, ai.models, everything above) or a
// media kind, "speech" | "transcription" | "image", listed from ai.mediaModels
// (the app needs the `audio` capability). For a media kind an empty value means
// "the platform default" (set in Setup → AI Config) and the placeholder defaults
// to "Platform default (<model>)"; the "Latest — auto-updating" tier group is
// text-only. Extra attributes:
//   show-voices  (speech) a voice <select> for the selected model, refilled when
//                the model changes, plus a ▶ that plays ai.voiceSample. Property
//                `voice` (get/set; '' = the model's / platform's default voice);
//                with persist-key it is stored under `<persist-key>Voice`; the
//                change event carries detail.voice.
//   show-params  a one-line summary of the selected model under the select:
//                price and limits (formats, voices, ratios, sizes; context and
//                $/Mtok for text).
//   <vc-model-picker kind="speech" show-voices persist-key="ttsModel"></vc-model-picker>
//   → backend: ctx.tts({ input, model: ctx.settings.get('ttsModel') || undefined,
//                        voice: ctx.settings.get('ttsModelVoice') || undefined })
//
// Only *usable* models are offered: `disabled` and `lifecycle: 'retired'` entries
// are omitted, because selecting one cannot produce a working call. Models are
// grouped into <optgroup>s by provider, ordered by the `providerRank`/`providerLabel`
// the server puts on the ai.models payload (the single source of truth for provider
// identity — see publicModelShape in app-bridge.js). A persisted `value` that is no
// longer offered is preserved as an extra option so a removed key or a newly
// disabled model never silently drops the app's stored choice.

(function () {
  'use strict';

  // A model worth offering. The server decides this (publicModelShape.usable,
  // from core's credential join) and every surface reads the same field — this
  // file must never re-derive it from `disabled`/`lifecycle`/`hasApiKey`.
  const isUsable = (m) => !!m.usable;

  const MEDIA_METHOD = { speech: 'ai.tts', transcription: 'ai.transcribe', image: 'ai.image', sfx: 'ai.sfx' };

  const TEMPLATE = `
    <style>
      :host { display: inline-block; min-width: 160px; }
      .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .row > select:first-child { flex: 1 1 160px; }
      .voice { display: none; gap: 4px; align-items: center; flex: 1 1 140px; }
      :host([show-voices][kind="speech"]) .voice { display: flex; }
      .voice select { flex: 1; }
      button {
        padding: 5px 9px; background: var(--bg, #1a1b26); color: var(--text, #c0caf5);
        border: 1px solid var(--border, #414868); border-radius: var(--radius, 6px);
        font: inherit; font-size: 12px; cursor: pointer;
      }
      button:disabled { opacity: .6; cursor: progress; }
      .params { display: none; margin-top: 4px; font-size: 11px; opacity: .75; }
      :host([show-params]) .params { display: block; }
      audio { display: none; height: 28px; margin-top: 4px; max-width: 100%; }
      audio.on { display: block; }
      select {
        width: 100%;
        padding: 6px 10px;
        background: var(--bg, #1a1b26);
        color: var(--text, #c0caf5);
        border: 1px solid var(--border, #414868);
        border-radius: var(--radius, 6px);
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      select:focus { outline: none; border-color: var(--accent, #7aa2f7); }
      select:disabled { opacity: .6; cursor: progress; }
    </style>
    <div class="row">
      <select part="select" aria-label="Model"></select>
      <span class="voice"><select part="voice" aria-label="Voice"></select><button type="button" part="play" title="Play a sample of this voice">&#9654;</button></span>
    </div>
    <div class="params" part="params"></div>
    <audio part="sample" controls></audio>
  `;

  class VcModelPicker extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() {
      return ['value', 'configured-only', 'all-models', 'provider', 'placeholder', 'show-cost', 'kind', 'show-voices', 'show-params'];
    }

    constructor() {
      super();
      this._select = this.$('select[part="select"]');
      this._voiceSelect = this.$('select[part="voice"]');
      this._play = this.$('button[part="play"]');
      this._audio = this.$('audio');
      this._params = this.$('.params');
      this._all = [];      // catalog as returned, including unusable entries
      this._models = [];   // the usable subset actually offered
      this._aliases = [];  // bare Anthropic tiers, offered ahead of concrete names
      this._defaults = {}; // media: the effective platform default per method
      this._voice = '';
      this._loaded = false;
      this._select.addEventListener('change', () => {
        this._persist();
        if (this._voiceOn) { this._renderVoices(); this._persistVoice(); }
        this._renderParams();
        this._emitChange();
      });
      this._voiceSelect.addEventListener('change', () => {
        this._voice = this._voiceSelect.value;
        this._persistVoice();
        this._emitChange();
      });
      this._play.addEventListener('click', () => this._playSample());
      this.ready = this._load();
    }

    connectedCallback() {
      this._select.disabled = !this._loaded;
      if (this._loaded) this._renderOptions();
    }

    attributeChangedCallback(name, _old, val) {
      if (!this._select) return;
      if (name === 'value') {
        if (this._loaded) { this._applyValue(val); if (this._voiceOn) this._renderVoices(); this._renderParams(); }
      }
      else if (name === 'configured-only' || name === 'all-models' || name === 'provider' || name === 'kind') { this.refresh(); }
      else if (name === 'placeholder' || name === 'show-cost' || name === 'show-voices' || name === 'show-params') { if (this._loaded) this._renderOptions(); }
    }

    // --- public API ---
    get value() { return this._select.value; }
    set value(v) {
      const s = v == null ? '' : String(v);
      if (this._loaded) this._applyValue(s);
      else this.setAttribute('value', s);
    }

    get models() { return this._models.slice(); }

    // The selected voice (show-voices on a speech picker); '' = the default.
    get voice() { return this._voiceOn ? this._voiceSelect.value : this._voice; }
    set voice(v) {
      this._voice = v == null ? '' : String(v);
      if (this._loaded && this._voiceOn) this._renderVoices(this._voice);
    }

    refresh() { this.ready = this._load(); return this.ready; }

    // --- internals ---
    _modelByName(name) { return this._models.find((m) => m.name === name) || null; }

    get _kind() {
      const k = this.getAttribute('kind');
      return k && MEDIA_METHOD[k] ? k : 'text';
    }
    get _media() { return this._kind !== 'text'; }
    get _voiceOn() { return this._kind === 'speech' && this.hasAttribute('show-voices'); }
    // The platform default for this media kind ({ model, voice?, … }).
    get _platformDefault() { return (this._media && this._defaults[MEDIA_METHOD[this._kind]]) || {}; }
    // The entry the voice list and summary describe: the selection, else the
    // platform default it stands for.
    get _effective() {
      const name = this.value || this._platformDefault.model || this._default || '';
      return this._all.find((m) => m.name === name) || null;
    }

    _emitChange() {
      const detail = { value: this.value, model: this._modelByName(this.value), kind: this._kind };
      if (this._voiceOn) detail.voice = this.voice;
      this.emit('change', detail);
    }

    // Which store `persist-key` uses. Settings by default: it is the only one the
    // app's backend can read, and the backend is what makes the call.
    get _scope() {
      return this.getAttribute('persist-scope') === 'state' ? 'state' : 'settings';
    }

    async _load() {
      this._select.disabled = true;
      // Usable-only is the default; `all-models` is the opt-out. Asking the
      // server to filter keeps one definition of "usable" on the server side.
      const opts = {};
      if (!this.hasAttribute('all-models')) opts.configuredOnly = true;
      const provider = this.getAttribute('provider');
      if (provider) opts.provider = provider;
      try {
        if (this._media) {
          // ai.mediaModels lists every model of the kind; filtering is local.
          const res = await Vc.getModels({ kind: this._kind });
          const all = (res && Array.isArray(res.models)) ? res.models : [];
          this._all = provider ? all.filter((m) => m.provider === provider) : all;
          this._aliases = [];
          this._defaults = (res && res.defaults) || {};
          this._default = this._platformDefault.model || null;
        } else {
          const res = await Vc.getModels(opts);
          this._all = (res && Array.isArray(res.models)) ? res.models : [];
          this._aliases = (res && Array.isArray(res.aliases)) ? res.aliases : [];
          this._default = res && res.default;
        }
      } catch (_) {
        this._all = [];
        this._aliases = [];
      }
      this._models = this.hasAttribute('all-models') ? this._all : this._all.filter(isUsable);

      // A persisted choice outranks the markup default. Applied while _loaded is
      // still false so the attribute change can't trigger a premature render.
      const key = this.getAttribute('persist-key');
      if (key) {
        let saved = null;
        const store = this._scope === 'state' ? Vc.state : Vc.settings;
        try { saved = await store.get(key); } catch (_) { /* no runtime → keep markup default */ }
        // Migration: settings-scoped pickers read a value left behind by the old
        // state-backed default, so an existing app does not lose its choice.
        if (!saved && this._scope === 'settings') {
          try { saved = await Vc.state.get(key); } catch (_) { /* nothing stored */ }
        }
        if (saved) this.setAttribute('value', String(saved));
        if (this._voiceOn) {
          try { this._voice = String((await store.get(`${key}Voice`)) || this._voice || ''); } catch (_) { /* keep */ }
        }
      }

      this._loaded = true;
      this._select.disabled = false;
      this._renderOptions();
      return this._models;
    }

    _persist() {
      const key = this.getAttribute('persist-key');
      if (!key) return;
      // '' is meaningful — it means "use the platform/server default".
      const store = this._scope === 'state' ? Vc.state : Vc.settings;
      store.set(key, this.value || '').catch(() => {});
    }

    _persistVoice() {
      const key = this.getAttribute('persist-key');
      if (!key || !this._voiceOn) return;
      const store = this._scope === 'state' ? Vc.state : Vc.settings;
      store.set(`${key}Voice`, this.voice || '').catch(() => {});
    }

    // Voices of the effective model. A stored voice that model does not offer
    // falls back to '' (its default) — the voice belongs to the model.
    _renderVoices(wanted) {
      const m = this._effective;
      const voices = (m && m.voices) || [];
      const want = wanted !== undefined ? wanted : (this._voiceSelect.options.length ? this._voiceSelect.value : this._voice);
      const pd = this._platformDefault;
      const dflt = !this.value && pd.voice ? pd.voice : (m && m.defaultVoice) || '';
      this._voiceSelect.innerHTML = '';
      const d = document.createElement('option');
      d.value = ''; d.textContent = dflt ? `Default voice (${dflt})` : 'Default voice';
      this._voiceSelect.appendChild(d);
      for (const v of voices) {
        const o = document.createElement('option');
        o.value = v.id;
        o.textContent = v.name || v.id;
        const about = [v.language, v.gender, v.description].filter(Boolean).join(', ');
        if (about) o.title = about;
        this._voiceSelect.appendChild(o);
      }
      const hit = voices.find((v) => String(v.id).toLowerCase() === String(want || '').toLowerCase());
      this._voiceSelect.value = hit ? hit.id : '';
      this._voice = this._voiceSelect.value;
    }

    async _playSample() {
      const m = this._effective;
      if (!m) return;
      const pd = this._platformDefault;
      const voice = this._voiceSelect.value || (!this.value && pd.voice) || m.defaultVoice;
      if (!voice) return;
      this._play.disabled = true;
      try {
        const r = await Vc.voiceSample(m.modelId || m.name, voice);
        this._audio.src = r.dataUri;
        this._audio.classList.add('on');
        this._audio.play().catch(() => {});
      } catch (err) {
        Vc.toast(`Voice sample failed: ${err.message || err}`, 'error');
      } finally {
        this._play.disabled = false;
      }
    }

    // One line about the effective model.
    _renderParams() {
      if (!this.hasAttribute('show-params')) { this._params.textContent = ''; return; }
      const m = this._effective;
      if (!m) { this._params.textContent = ''; return; }
      const bits = [];
      if (this._media) {
        const d = m.params || {};
        if (m.price) bits.push(m.price);
        if (m.voices) bits.push(`${m.voices.length} voices`);
        if (d.formats) bits.push(d.formats.join('/'));
        if (d.maxChars) bits.push(`≤${d.maxChars.toLocaleString()} chars`);
        if (d.maxBytes) bits.push(`≤${Math.round(d.maxBytes / 1048576)} MB`);
        if (d.aspectRatios) bits.push(`${d.aspectRatios.length} aspect ratios`);
        if (d.sizes) bits.push(d.sizes.join('/'));
        if (m.shutdownDate) bits.push(`ends ${m.shutdownDate}`);
      } else {
        if (m.contextWindow) bits.push(`${Math.round(m.contextWindow / 1000)}K context`);
        if (m.inputCostPerMTok != null && m.outputCostPerMTok != null) bits.push(`$${m.inputCostPerMTok}/$${m.outputCostPerMTok} per Mtok`);
      }
      this._params.textContent = bits.join(' · ');
    }

    // "Opus 5 — deprecated · $15/$75 per Mtok"
    _optionLabel(m) {
      let text = m.label || m.name;
      if ((m.lifecycle || 'current') === 'deprecated') text += ' — deprecated';
      if (this._media && m.shutdownDate) text += ` — ends ${m.shutdownDate}`;
      if (this.hasAttribute('show-cost') && this._media && m.price) text += ` · ${m.price}`;
      if (this.hasAttribute('show-cost') && m.inputCostPerMTok != null && m.outputCostPerMTok != null) {
        text += ` · $${m.inputCostPerMTok}/$${m.outputCostPerMTok} per Mtok`;
      }
      return text;
    }

    _renderOptions() {
      const want = this.getAttribute('value');
      // Media: '' is the platform default, so that row is always offered.
      let ph = this.getAttribute('placeholder');
      if (ph == null && this._media) ph = this._default ? `Platform default (${this._default})` : 'Platform default';
      this._select.innerHTML = '';
      if (ph != null) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = ph;
        this._select.appendChild(o);
      }

      // Group by provider, then order the groups by the server-supplied
      // `providerRank`. Deliberately does NOT assume the payload arrives sorted:
      // grouping into a Map first means an older server (or any future change to
      // response order) can't produce duplicate optgroups for one provider. The
      // label and rank still come from the payload, so no provider table lives here.
      // Leading group: the bare Anthropic tiers. These are what the platform
      // recommends an app store, because they follow new releases instead of
      // pinning a dated snapshot that eventually goes stale.
      const aliases = this._aliases || [];
      if (aliases.length) {
        const ag = document.createElement('optgroup');
        ag.label = 'Latest — auto-updating';
        for (const a of aliases) {
          const o = document.createElement('option');
          o.value = a.value;
          o.textContent = a.label;
          if (a.description) o.title = a.description;
          ag.appendChild(o);
        }
        this._select.appendChild(ag);
      }

      const groups = new Map();
      for (const m of this._models) {
        const key = m.provider || 'custom';
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            label: m.providerLabel || key,
            rank: Number.isFinite(m.providerRank) ? m.providerRank : Infinity,
            list: [],
          });
        }
        groups.get(key).list.push(m);
      }
      const ordered = [...groups.values()].sort((a, b) => (a.rank - b.rank) || a.key.localeCompare(b.key));

      // One provider carries no information in a group header — render flat,
      // unless the alias group is present, in which case the concrete names need
      // a header of their own to read as a separate section.
      const grouped = ordered.length > 1 || aliases.length > 0;
      for (const g of ordered) {
        let parent = this._select;
        if (grouped) {
          parent = document.createElement('optgroup');
          parent.label = g.label;
          this._select.appendChild(parent);
        }
        for (const m of g.list) {
          const o = document.createElement('option');
          o.value = m.name;
          o.textContent = this._optionLabel(m);
          if (m.description) o.title = m.description;
          parent.appendChild(o);
        }
      }
      this._applyValue(want, true);
      if (this._voiceOn) this._renderVoices();
      this._renderParams();
    }

    // Keep a stored value selectable even when it is no longer offered, so a
    // removed API key or a newly disabled model doesn't silently rewrite the
    // app's saved choice. When we can tell *why* it's absent, say so.
    _applyValue(val, fromRender) {
      const s = val == null ? '' : String(val);
      const prior = this._select.querySelector('option[data-vc-synthetic]');
      if (prior) prior.remove();

      // A bare tier ("sonnet") is a first-class value, not a missing model — it
      // is offered in the alias group even though no registry entry bears that name.
      const offered = !s
        || this._models.some((m) => m.name === s)
        || (this._aliases || []).some((a) => a.value === s);
      if (!offered) {
        const raw = this._all.find((m) => m.name === s);
        const o = document.createElement('option');
        o.value = s;
        o.textContent = raw ? `${raw.label || raw.name} — unavailable` : `${s} (saved)`;
        o.dataset.vcSynthetic = '1';
        this._select.appendChild(o);
      }
      this._select.value = s;
      if (!fromRender && this.getAttribute('value') !== s) this.setAttribute('value', s);
    }
  }

  Vc.define('vc-model-picker', VcModelPicker);
})();
