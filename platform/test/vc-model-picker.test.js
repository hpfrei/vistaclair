// <vc-model-picker> model types: without `kind` it asks ai.models exactly as
// before; kind="speech" lists ai.mediaModels; show-voices refills the voice
// list when the model changes and persist-key stores the voice under
// `<key>Voice`. Runs vc-core.js + vc-model-picker.js in a vm with a minimal DOM
// stub (no DOM library in the tree) — just enough of select/option semantics.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.textContent = ''; this.classList = { add() {}, remove() {} }; this._value = undefined; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  set innerHTML(_) { this.children = []; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  fire(t) { for (const f of this.listeners[t] || []) f({}); }
  get options() { const out = []; const walk = (e) => { for (const c of e.children) { if (c.tag === 'option') out.push(c); else walk(c); } }; walk(this); return out; }
  querySelector(sel) { return sel === 'option[data-vc-synthetic]' ? this.options.find((o) => o.dataset.vcSynthetic) || null : null; }
  get value() {
    if (this.tag !== 'select') return this._value ?? '';
    const opts = this.options;
    return opts.some((o) => o.value === this._value) ? this._value : (this._value === undefined && opts[0] ? opts[0].value : '');
  }
  set value(v) { this._value = String(v); }
}

function load() {
  const calls = [];
  const store = { settings: {}, state: {} };
  const catalogs = {
    'ai.models': { models: [{ name: 'claude-haiku-4-5', label: 'Haiku', provider: 'anthropic', usable: true }], aliases: [], default: 'claude-haiku-4-5' },
    'ai.mediaModels': {
      defaults: { 'ai.tts': { model: 'gpt-4o-mini-tts', voice: 'coral' } },
      models: [
        { name: 'gpt-4o-mini-tts', modelId: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS', provider: 'openai', usable: true, price: '$0.015 / 1K chars', params: { formats: ['mp3'] }, defaultVoice: 'alloy', voices: [{ id: 'alloy', name: 'Alloy' }, { id: 'coral', name: 'Coral' }, { id: 'marin', name: 'Marin' }] },
        { name: 'xai-tts', modelId: 'xai-tts', label: 'Grok TTS', provider: 'xai', usable: true, params: {}, defaultVoice: 'eve', voices: [{ id: 'eve', name: 'Eve' }, { id: 'rex', name: 'Rex' }] },
      ],
    },
  };
  class FakeHTMLElement {
    constructor() { this._attrs = {}; this.events = []; }
    attachShadow() { return {}; }
    getAttribute(n) { return n in this._attrs ? this._attrs[n] : null; }
    hasAttribute(n) { return n in this._attrs; }
    setAttribute(n, v) { const old = this.getAttribute(n); this._attrs[n] = String(v); this.attributeChangedCallback?.(n, old, String(v)); }
    removeAttribute(n) { delete this._attrs[n]; }
    dispatchEvent(e) { this.events.push(e); }
  }
  const defined = {};
  const window = {
    Bridge: {
      call: async (method, params) => {
        calls.push([method, params]);
        if (method === 'settings.set') { store.settings[params.key] = params.value; return {}; }
        if (method === 'settings.get') return store.settings[params.key] ?? null;
        if (method === 'state.get') return null;
        return catalogs[method];
      },
    },
  };
  const ctx = vm.createContext({
    Bridge: window.Bridge, HTMLElement: FakeHTMLElement, customElements: { get: (t) => defined[t], define: (t, c) => { defined[t] = c; } },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
    document: { createElement: (t) => new El(t) }, console, Promise,
  });
  ctx.window = ctx; // in a browser `window` is the global object
  for (const f of ['vc-core.js', 'vc-model-picker.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'), ctx, { filename: f });
  const Vc = ctx.window.Vc;
  // The real VcElement wires a shadow root from the template; the stub hands out
  // one element per selector instead.
  const Base = Vc.Element;
  Base.prototype.$ = function (sel) {
    this._els = this._els || {};
    const tag = sel.startsWith('select') ? 'select' : sel.startsWith('button') ? 'button' : sel === 'audio' ? 'audio' : 'div';
    return (this._els[sel] = this._els[sel] || new El(tag));
  };
  return { Picker: defined['vc-model-picker'], calls, store };
}

// vm objects carry the sandbox's prototypes; compare their JSON shape.
const plain = (x) => JSON.parse(JSON.stringify(x));

function make(Picker, attrs) {
  // Attributes exist before construction (as when parsed from markup).
  const orig = Picker.prototype._load;
  let el;
  Picker.prototype._load = function () { el = this; for (const [k, v] of Object.entries(attrs)) this._attrs[k] = v; return orig.call(this); };
  new Picker();
  Picker.prototype._load = orig;
  return el;
}

test('no kind: ai.models with today\'s options, tier-group logic untouched', async () => {
  const { Picker, calls } = load();
  const p = make(Picker, {});
  await p.ready;
  assert.deepEqual(plain(calls[0]), ['ai.models', { configuredOnly: true }]);
  assert.deepEqual(p._select.options.map((o) => o.value), ['claude-haiku-4-5']);
  assert.equal(p._voiceSelect.options.length, 0, 'no voice list on a text picker');
  assert.equal(p.voice, '');
});

test('kind="speech": ai.mediaModels, "Platform default" row, voices follow the model and persist', async () => {
  const { Picker, calls, store } = load();
  const p = make(Picker, { kind: 'speech', 'show-voices': '', 'show-params': '', 'persist-key': 'ttsModel' });
  await p.ready;
  assert.deepEqual(plain(calls[0]), ['ai.mediaModels', { kind: 'speech' }]);
  const sel = p._select;
  assert.equal(sel.options[0].textContent, 'Platform default (gpt-4o-mini-tts)');
  assert.equal(p.value, '', 'empty = the platform default');
  const vs = p._voiceSelect;
  assert.deepEqual(vs.options.map((o) => o.value), ['', 'alloy', 'coral', 'marin'], 'the platform default model\'s voices');
  assert.equal(vs.options[0].textContent, 'Default voice (coral)', 'the platform default voice');
  assert.match(p._params.textContent, /\$0\.015 \/ 1K chars · 3 voices · mp3/);

  vs.value = 'marin'; vs.fire('change');
  assert.equal(store.settings.ttsModelVoice, 'marin');
  assert.equal(p.events.at(-1).detail.voice, 'marin');
  assert.equal(p.events.at(-1).detail.kind, 'speech');

  sel.value = 'xai-tts'; sel.fire('change');
  assert.deepEqual(vs.options.map((o) => o.value), ['', 'eve', 'rex'], 'refilled for the new model');
  assert.equal(p.voice, '', 'marin is not an xAI voice → the model default');
  assert.equal(vs.options[0].textContent, 'Default voice (eve)');
  assert.equal(store.settings.ttsModel, 'xai-tts');
  assert.equal(store.settings.ttsModelVoice, '');

  p.voice = 'rex';
  assert.equal(p.voice, 'rex');
});

test('a persisted model and voice are restored', async () => {
  const { Picker, store } = load();
  store.settings.ttsModel = 'xai-tts';
  store.settings.ttsModelVoice = 'rex';
  const p = make(Picker, { kind: 'speech', 'show-voices': '', 'persist-key': 'ttsModel' });
  await p.ready;
  assert.equal(p.value, 'xai-tts');
  assert.equal(p.voice, 'rex');
});
