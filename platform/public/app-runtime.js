// VistaClair App Runtime — bridge + error handler
// Include via <script src="/pro/app-runtime.js"></script> before your app.js
(function() {
  'use strict';

  // --- Bridge ---
  const Bridge = {
    _id: 0,
    _pending: new Map(),
    _handlers: new Map(), // event → Map(handler → wrapper)
    // call(method, params, opts?) — opts.timeoutMs overrides the default 5-minute
    // timeout (generous: AI calls can run minutes); 0 disables it. The timeout
    // exists so a dashboard reload mid-call rejects instead of hanging forever.
    call(method, params, opts) {
      const timeoutMs = opts && opts.timeoutMs !== undefined ? opts.timeoutMs : 300000;
      return new Promise((resolve, reject) => {
        const id = String(++this._id);
        let timer = null;
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            if (this._pending.delete(id)) reject(new Error(`Bridge call '${method}' timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }
        this._pending.set(id, {
          resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
          reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
        });
        window.parent.postMessage({ type: 'bridge', id, method, params }, '*');
      });
    },
    on(event, handler) {
      const wrapper = (e) => handler(e.detail);
      if (!this._handlers.has(event)) this._handlers.set(event, new Map());
      this._handlers.get(event).set(handler, wrapper);
      window.addEventListener('bridge:' + event, wrapper);
      return () => this.off(event, handler);
    },
    off(event, handler) {
      const handlers = this._handlers.get(event);
      const wrapper = handlers && handlers.get(handler);
      if (wrapper) {
        window.removeEventListener('bridge:' + event, wrapper);
        handlers.delete(handler);
      }
    },
    init() {
      window.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg && msg.id && this._pending.has(msg.id)) {
          const { resolve, reject } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error)) : resolve(msg.result);
        }
        if (msg && msg.type === 'bridge:event') {
          window.dispatchEvent(new CustomEvent('bridge:' + msg.event, { detail: msg.data }));
        }
      });
    }
  };
  Bridge.init();
  window.Bridge = Bridge;

  // --- AI helpers ---
  async function askAI(message, systemPrompt, model) {
    const result = await Bridge.call('ai.prompt', { message, systemPrompt, model });
    return result.text;
  }
  window.askAI = askAI;

  // getModels(opts?) -> { models: [...], default }. opts: { provider, configuredOnly }.
  // Each model: { name, label, provider, lifecycle, disabled, hasApiKey, ... }.
  function getModels(opts) {
    return Bridge.call('ai.models', opts || {});
  }
  window.getModels = getModels;

  // --- Model picker (platform modal rendered over the app) ---
  // pickModel(params?) -> chosen model object (ai.models shape) or null if dismissed.
  // params: { title, provider, configuredOnly, selected, kind }. kind 'speech' |
  // 'transcription' | 'image' lists media models (ai.mediaModels shape; store
  // its modelId); none / 'text' is the text registry. This is a UI round-trip to
  // the dashboard parent window (not a server bridge call), so it needs no backend.
  const _pickPending = new Map();
  let _pickId = 0;
  window.addEventListener('message', function(e) {
    const msg = e.data;
    if (msg && msg.type === 'app:pickModel:result' && _pickPending.has(msg.id)) {
      const resolve = _pickPending.get(msg.id);
      _pickPending.delete(msg.id);
      resolve(msg.model || null);
    }
  });
  function pickModel(params) {
    return new Promise((resolve) => {
      const id = 'pick' + (++_pickId);
      _pickPending.set(id, resolve);
      window.parent.postMessage({ type: 'app:pickModel', id: id, params: params || {} }, '*');
    });
  }
  window.pickModel = pickModel;

  // --- Media AI helpers (audio + image) ---
  // transcribe(audioBase64, opts?) -> { text, ... }. audio may be raw base64 or a
  // data URI. opts: { accuracy: 'high'|'low', model, language, mimeType, filename }.
  function transcribe(audio, opts) {
    return Bridge.call('ai.transcribe', Object.assign({ audio: audio }, opts || {}));
  }
  window.transcribe = transcribe;

  // speak(input, opts?) -> { audio, mimeType, dataUri, model, voice, ignored? }. opts: { model, voice, format,
  // speed, language, instructions, provider }. Omitted ones use the platform default (Apps → Setup → AI Config).
  // Play the result: new Audio((await speak(text)).dataUri).play();
  function speak(input, opts) {
    return Bridge.call('ai.tts', Object.assign({ input: input }, opts || {}));
  }
  window.speak = speak;

  // generateImage(prompt, opts?) -> { images: [{ data, mimeType, dataUri }], text, model }.
  // opts: { image (base64/data-URI for editing), model, aspectRatio, size ('1K' | '2K' | '4K' | 'WxH') }.
  function generateImage(prompt, opts) {
    return Bridge.call('ai.image', Object.assign({ prompt: prompt }, opts || {}));
  }
  window.generateImage = generateImage;

  // generateSound(prompt, opts?) -> { audio, mime, mimeType, format, ext, sampleRate, durationSeconds, bytes, dataUri,
  // model, loop?, ignored? }. opts: { durationSeconds (0.5-30, omit = automatic), loop, promptInfluence (0-1),
  // format ('mp3' | 'wav' | 'ogg' | 'pcm'), sampleRate, model }. A looping call with no format returns wav (seamless).
  function generateSound(prompt, opts) {
    return Bridge.call('ai.sfx', Object.assign({ prompt: prompt }, opts || {}));
  }
  window.generateSound = generateSound;

  // getMediaModels(opts?) -> { models, defaults, refreshedAt }. opts: { kind ('speech' |
  // 'transcription' | 'image' | 'sfx'), method ('ai.tts' | …) }. Each model carries params, usable,
  // and for speech its voices. What <vc-model-picker kind="…"> lists.
  function getMediaModels(opts) {
    return Bridge.call('ai.mediaModels', opts || {});
  }
  window.getMediaModels = getMediaModels;

  // translate(text, target, opts?) -> { text, translations, detectedSourceLanguage }.
  // text may be a string or an array of strings; result.text matches that shape.
  // opts: { source (auto-detected if omitted), format: 'text'|'html' }.
  function translate(text, target, opts) {
    return Bridge.call('ai.translate', Object.assign({ text: text, target: target }, opts || {}));
  }
  window.translate = translate;

  // detectLanguage(text) -> { language, confidence, detections }. text may be a
  // string or an array of strings; result.language matches that shape (ISO-639
  // codes, 'und' when undetermined).
  function detectLanguage(text, opts) {
    return Bridge.call('ai.detect', Object.assign({ text: text }, opts || {}));
  }
  window.detectLanguage = detectLanguage;

  // --- Google Maps Platform helpers (routing, geocoding, places) ---
  // getRoute(origin, destination, opts?) -> { routes: [{ duration, distanceMeters, polyline, legs, ... }] }.
  // origin/destination/opts.waypoints: address string | {lat,lng} | {placeId}.
  // opts: { travelMode: 'DRIVE'|'WALK'|'BICYCLE'|'TRANSIT'|'TWO_WHEELER',
  //   computeAlternativeRoutes, avoidTolls, avoidHighways, avoidFerries,
  //   departureTime, arrivalTime, languageCode, units, fieldMask, body }.
  function getRoute(origin, destination, opts) {
    return Bridge.call('ai.route', Object.assign({ origin: origin, destination: destination }, opts || {}));
  }
  window.getRoute = getRoute;

  // getRouteMatrix({origins, destinations, ...opts}) -> { elements: [{originIndex,
  // destinationIndex, duration, distanceMeters, condition}] }. Waypoint shapes as getRoute.
  function getRouteMatrix(opts) {
    return Bridge.call('ai.routeMatrix', opts || {});
  }
  window.getRouteMatrix = getRouteMatrix;

  // geocode(addressOrParams, opts?) -> { results: [...] }. Forward: geocode('Brandenburg Gate').
  // Reverse: geocode({lat: 52.5, lng: 13.4}). opts: { language, region, components }.
  function geocode(query, opts) {
    var params = typeof query === 'string' ? { address: query } : (query || {});
    return Bridge.call('ai.geocode', Object.assign({}, params, opts || {}));
  }
  window.geocode = geocode;

  // findPlaces(query, opts?) -> { places: [...] }. Text search by default; set
  // opts.op to 'nearby' (lat/lng/radius), 'details' (placeId), or 'autocomplete' (input).
  function findPlaces(query, opts) {
    return Bridge.call('ai.places', Object.assign({ op: 'search', query: query }, opts || {}));
  }
  window.findPlaces = findPlaces;

  // getPlacePhoto(name, opts?) -> { data, mimeType, dataUri }. name is from
  // places.photos[].name in a search/details response. opts: { maxWidthPx, maxHeightPx }.
  function getPlacePhoto(name, opts) {
    return Bridge.call('ai.placePhoto', Object.assign({ name: name }, opts || {}));
  }
  window.getPlacePhoto = getPlacePhoto;

  // getStreetView(opts) -> Google Street View Static. Default op 'metadata'
  // (free) returns { status, pano_id, date, location, copyright }; { op: 'image',
  // lat/lng or pano_id, heading, pitch?, fov?, width?, height? } returns the JPEG
  // as { data (base64), dataUri, copyright, ... }. source: 'outdoor' drops indoor
  // panoramas. status 'ZERO_RESULTS' means no coverage — data is null, not an error.
  function getStreetView(opts) {
    return Bridge.call('ai.streetview', opts || {});
  }
  window.getStreetView = getStreetView;

  // get3dTiles(opts?) -> Photorealistic 3D Tiles. Default op 'root' returns
  // { tileset, session, expiresAt, cached }; { op: 'fetch', uri } returns a child
  // tileset ({ kind: 'tileset', json }) or a tile ({ kind: 'glb', data (base64),
  // copyright }). uri is a content.uri from a tileset (session token included).
  function get3dTiles(opts) {
    return Bridge.call('ai.tiles3d', opts || {});
  }
  window.get3dTiles = get3dTiles;

  // webSearch(query, opts?) -> { results: [{ title, url, description, ... }], news, videos }.
  // Live web search (Brave Search API). opts: { count (1-20), offset, country,
  // searchLang, freshness ('pd'|'pw'|'pm'|'py'), safesearch, resultFilter, extraSnippets }.
  function webSearch(query, opts) {
    return Bridge.call('ai.webSearch', Object.assign({ query: query }, opts || {}));
  }
  window.webSearch = webSearch;

  // --- Platform overlays (confirm + modal rendered over the app by the dashboard) ---
  // Bridge.confirm({title?, message, confirmLabel?, cancelLabel?, danger?}) -> Promise<boolean>
  // Bridge.modal({title, content?, fields?, buttons?, width?}) -> modal handle:
  //   a Promise<{button, values}|null> (null = dismissed via Escape / backdrop / x)
  //   with extra methods for live-updating dialogs:
  //     .update({title?, content?, buttons?, hints?, fieldOptions?})
  //       re-render parts in place (typed field values untouched).
  //       hints: {fieldName: 'msg' | {text, kind:'error'|'ok'|'info'} | null} — inline
  //       per-field feedback (null clears). fieldOptions: {selectName: [options]} —
  //       replace a select's option list (dependent dropdowns).
  //     .close(result?)                        close programmatically; promise resolves result ?? null
  //     .onButton(fn)                          fires {button, values} for buttons with keepOpen: true
  //     .onChange(fn)                          fires {field, values} as the user edits fields
  //                                            (typing debounced ~250ms) — validate or fetch,
  //                                            then respond via update()
  //   content: string | [{type:'text'|'code'|'kv'|'list', ...}] (structured — raw HTML
  //   is never rendered). fields: [{name, label?, type:'text'|'textarea'|'select'|
  //   'checkbox'|'number'|'file', options?, value?, placeholder?, required?, rows?,
  //   accept?, maxBytes?}]. 'file' = drop/browse/paste zone with media preview +
  //   click-to-zoom lightbox; value {name,mimeType,size,data}.
  //   buttons: [{id, label?, primary?, danger?, keepOpen?}] — keepOpen buttons report
  //   the click (with current field values) via onButton instead of closing.
  const _overlayPending = new Map();
  const _overlayButtonHandlers = new Map();
  const _overlayChangeHandlers = new Map();
  let _overlayId = 0;
  window.addEventListener('message', function(e) {
    const msg = e.data;
    if (!msg) return;
    if (msg.type === 'app:overlay:result' && _overlayPending.has(msg.id)) {
      const resolve = _overlayPending.get(msg.id);
      _overlayPending.delete(msg.id);
      _overlayButtonHandlers.delete(msg.id);
      _overlayChangeHandlers.delete(msg.id);
      resolve(msg.result);
    } else if (msg.type === 'app:overlay:button' && _overlayButtonHandlers.has(msg.id)) {
      _overlayButtonHandlers.get(msg.id).forEach(function(fn) {
        try { fn({ button: msg.button, values: msg.values }); } catch (err) { console.error(err); }
      });
    } else if (msg.type === 'app:overlay:change' && _overlayChangeHandlers.has(msg.id)) {
      _overlayChangeHandlers.get(msg.id).forEach(function(fn) {
        try { fn({ field: msg.field, values: msg.values }); } catch (err) { console.error(err); }
      });
    }
  });
  function overlayCall(kind, params) {
    const id = 'ov' + (++_overlayId);
    const promise = new Promise(function(resolve) {
      _overlayPending.set(id, resolve);
      window.parent.postMessage({ type: 'app:overlay', id: id, kind: kind, params: params || {} }, '*');
    });
    promise._overlayId = id;
    return promise;
  }
  function showConfirm(params) {
    if (typeof params === 'string') params = { message: params };
    return overlayCall('confirm', params).then(function(r) { return r === true; });
  }
  function showModal(params) {
    const promise = overlayCall('modal', params);
    const id = promise._overlayId;
    promise.update = function(p) {
      window.parent.postMessage({ type: 'app:overlay:update', id: id, params: p || {} }, '*');
      return promise;
    };
    promise.close = function(result) {
      window.parent.postMessage({ type: 'app:overlay:close', id: id, result: result === undefined ? null : result }, '*');
      return promise;
    };
    promise.onButton = function(fn) {
      if (!_overlayButtonHandlers.has(id)) _overlayButtonHandlers.set(id, new Set());
      _overlayButtonHandlers.get(id).add(fn);
      return promise;
    };
    promise.onChange = function(fn) {
      if (!_overlayChangeHandlers.has(id)) _overlayChangeHandlers.set(id, new Set());
      _overlayChangeHandlers.get(id).add(fn);
      return promise;
    };
    return promise;
  }
  Bridge.confirm = showConfirm;
  Bridge.modal = showModal;
  window.showConfirm = showConfirm;
  window.showModal = showModal;

  // --- Toast helper ---
  // Surfaces a notification in the Vistaclair header toast system.
  // showToast(message, level?, sender?) or showToast({ message, level, sender, title, duration }).
  function showToast(message, level, sender) {
    const params = (message && typeof message === 'object')
      ? message
      : { message: message, level: level, sender: sender };
    return Bridge.call('toast.show', params);
  }
  window.showToast = showToast;
  Bridge.toast = showToast;

  // --- Shared utilities ---

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  window.escapeHtml = escapeHtml;

  // apiFetch(path, opts?) — fetch against the app's own API with the base path
  // (/apps/<name>/) resolved automatically. Object bodies are JSON-encoded,
  // responses parsed by content-type, non-2xx throws an Error carrying the
  // server-provided message. apiFetch('api/items'), apiFetch('api/items', {method:'POST', body:{...}}).
  const _apiBase = (function() {
    const m = location.pathname.match(/^(\/apps\/[^/]+\/)/);
    return m ? m[1] : location.pathname.replace(/[^/]*$/, '');
  })();
  // Platform identity (dashboard context). When an app links a user (redeeming
  // a Telegram /link code via ctx.identity), the backend returns a signed
  // session token; store it with Identity.set(token) and apiFetch replays it as
  // a Bearer header automatically. Apps that never call set() are unaffected.
  const _identityKey = 'vista:identity:' + (function() {
    const m = location.pathname.match(/^\/apps\/([^/]+)\//);
    return m ? m[1] : _apiBase;
  })();
  const Identity = {
    token: function() { try { return localStorage.getItem(_identityKey) || null; } catch (e) { return null; } },
    set: function(token) { try { token ? localStorage.setItem(_identityKey, token) : localStorage.removeItem(_identityKey); } catch (e) {} },
    clear: function() { try { localStorage.removeItem(_identityKey); } catch (e) {} },
  };
  window.Identity = Identity;

  async function apiFetch(path, opts) {
    opts = Object.assign({}, opts);
    const url = /^https?:\/\//.test(path) ? path : _apiBase + String(path).replace(/^\//, '');
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData) && !(opts.body instanceof Blob)) {
      opts.body = JSON.stringify(opts.body);
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    }
    const _tok = Identity.token();
    if (_tok && !(opts.headers && (opts.headers.Authorization || opts.headers.authorization))) {
      opts.headers = Object.assign({ Authorization: 'Bearer ' + _tok }, opts.headers);
    }
    const res = await fetch(url, opts);
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('json') ? await res.json().catch(function() { return null; }) : await res.text();
    if (!res.ok) {
      const msg = (data && typeof data === 'object' && (data.error || data.message))
        || (typeof data === 'string' && data.slice(0, 200))
        || (res.status + ' ' + res.statusText);
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  window.apiFetch = apiFetch;

  function timeAgo(ts) {
    const d = ts instanceof Date ? ts : new Date(ts);
    const diff = Date.now() - d.getTime();
    if (!isFinite(diff)) return '';
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 7 * 86400000) return Math.floor(diff / 86400000) + 'd ago';
    return d.toLocaleDateString();
  }
  function formatDate(ts) {
    const d = ts instanceof Date ? ts : new Date(ts);
    return isNaN(d) ? '' : d.toLocaleDateString();
  }
  function formatTime(ts) {
    const d = ts instanceof Date ? ts : new Date(ts);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  window.timeAgo = timeAgo;
  window.formatDate = formatDate;
  window.formatTime = formatTime;

  // initTabs(root?) — wires .tab buttons (data-tab="x") to .tab-content/.tab-pane
  // panes (id="tab-x" or data-tab-content="x"), toggling .active on both.
  function initTabs(root) {
    root = root || document;
    root.addEventListener('click', function(e) {
      const tab = e.target.closest('.tab[data-tab]');
      if (!tab || !root.contains(tab)) return;
      const name = tab.dataset.tab;
      const scope = tab.closest('[data-tabs-scope]') || root;
      scope.querySelectorAll('.tab[data-tab]').forEach(function(t) { t.classList.toggle('active', t === tab); });
      scope.querySelectorAll('.tab-content, .tab-pane').forEach(function(pane) {
        const paneName = pane.dataset.tabContent || (pane.id || '').replace(/^tab-/, '');
        pane.classList.toggle('active', paneName === name);
      });
    });
  }
  window.initTabs = initTabs;

  // Bridge.subscribe(eventName, handler) — the one subscription API for ALL
  // platform events. Listens on the named bridge event (job:update, cron:result,
  // app-emitted events) AND multiplexes the shared 'broadcast' stream
  // (dispatching on msg.event || msg.type). Returns an unsubscribe function.
  const _subs = new Map(); // eventName → Set<handler>
  let _subsWired = false;
  Bridge.subscribe = function(eventName, handler) {
    if (!_subsWired) {
      _subsWired = true;
      Bridge.on('broadcast', function(msg) {
        const name = msg && (msg.event || msg.type);
        const set = name && _subs.get(name);
        if (set) set.forEach(function(fn) { try { fn(msg); } catch (e) { console.error(e); } });
      });
    }
    const offNamed = eventName === 'broadcast' ? null : Bridge.on(eventName, handler);
    if (!_subs.has(eventName)) _subs.set(eventName, new Set());
    _subs.get(eventName).add(handler);
    return function unsubscribe() {
      if (offNamed) offNamed();
      const set = _subs.get(eventName);
      if (set) set.delete(handler);
    };
  };

  // Bridge.bus(kinds, handler, { ttlMs }) — the platform bus from an iframe:
  // envelopes other apps (and the platform) publish. kinds: a full kind or a
  // pattern ('other-app:*', '*:crashloop'), or an array. The subscription is a
  // server-side LEASE (one pattern set per app, replaced on every call), renewed
  // at half its ttl while any handler is live; a closed tab simply expires.
  // Returns an unsubscribe function. Fire-and-forget only — no replies.
  const _busSubs = new Set(); // { patterns, handler }
  let _busTimer = null;
  let _busTtl = 15 * 60 * 1000;
  function _busMatch(pattern, kind) {
    if (pattern === kind) return true;
    if (pattern.indexOf('*') === -1) return false;
    const ps = pattern.split(':'), ks = kind.split(':');
    for (let i = 0; i < ps.length; i++) {
      if (ps[i] === '*' && i === ps.length - 1) return ks.length >= ps.length;
      if (i >= ks.length || (ps[i] !== '*' && ps[i] !== ks[i])) return false;
    }
    return ks.length === ps.length;
  }
  function _busRenew() {
    if (_busTimer) { clearTimeout(_busTimer); _busTimer = null; }
    const live = new Set();
    _busSubs.forEach(function(s) { s.patterns.forEach(function(p) { live.add(p); }); });
    if (!live.size) return Bridge.call('events.unsubscribe', {}).catch(function() {});
    return Bridge.call('events.subscribe', { kinds: Array.from(live), ttlMs: _busTtl })
      .then(function(r) { _busTtl = (r && r.ttlMs) || _busTtl; })
      .catch(function(e) { console.warn('Bridge.bus lease failed:', e.message); })
      .then(function() { if (_busSubs.size) _busTimer = setTimeout(_busRenew, _busTtl / 2); });
  }
  let _busWired = false;
  Bridge.bus = function(kinds, handler, opts) {
    if (!_busWired) {
      _busWired = true;
      Bridge.on('bus:event', function(env) {
        if (!env || !env.kind) return;
        _busSubs.forEach(function(s) {
          if (s.patterns.some(function(p) { return _busMatch(p, env.kind); })) {
            try { s.handler(env); } catch (e) { console.error(e); }
          }
        });
      });
    }
    if (opts && opts.ttlMs) _busTtl = opts.ttlMs;
    const sub = { patterns: (Array.isArray(kinds) ? kinds : [kinds]).map(String), handler: handler };
    _busSubs.add(sub);
    _busRenew();
    return function unsubscribe() { _busSubs.delete(sub); _busRenew(); };
  };

  function extractJsonObject(text) {
    const start = text.indexOf('{');
    if (start === -1) return null;
    var depth = 0, inString = false, escaped = false;
    for (var i = start; i < text.length; i++) {
      var ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return text.substring(start, i + 1); }
    }
    return text.substring(start);
  }

  function repairTruncatedJson(text) {
    var inString = false, escaped = false;
    var stack = [];
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') stack.push('{');
      else if (ch === '[') stack.push('[');
      else if (ch === '}') { if (stack.length && stack[stack.length - 1] === '{') stack.pop(); }
      else if (ch === ']') { if (stack.length && stack[stack.length - 1] === '[') stack.pop(); }
    }
    if (stack.length === 0) return null;
    var repaired = text;
    if (inString) { repaired = repaired.replace(/\\$/, '') + '"'; }
    repaired = repaired.replace(/,\s*$/, '');
    repaired = repaired.replace(/:\s*$/, ': null');
    while (stack.length) { var open = stack.pop(); repaired += open === '{' ? '}' : ']'; }
    return repaired;
  }

  function parseAIResponse(text) {
    var raw = (text && typeof text === 'object') ? text.text : text;
    if (!raw) return null;
    var cleaned = raw.replace(/```(?:json)?\s*/gi, '').trim();
    try { return JSON.parse(cleaned); } catch {}
    var jsonStr = extractJsonObject(cleaned);
    if (jsonStr) {
      try { return JSON.parse(jsonStr); } catch {}
      var repaired = repairTruncatedJson(jsonStr);
      if (repaired) try { return JSON.parse(repaired); } catch {}
    }
    var jsonFromOriginal = extractJsonObject(raw);
    if (jsonFromOriginal && jsonFromOriginal !== jsonStr) {
      try { return JSON.parse(jsonFromOriginal); } catch {}
      var repaired2 = repairTruncatedJson(jsonFromOriginal);
      if (repaired2) try { return JSON.parse(repaired2); } catch {}
    }
    return null;
  }
  window.parseAIResponse = parseAIResponse;

  // --- Error handler ---
  var _lastError = null;
  var _lastErrorTime = 0;

  function handleError(errorMsg, source, lineno, colno, errorObj) {
    var key = (errorMsg || '') + ':' + (source || '') + ':' + (lineno || '');
    var now = Date.now();
    if (key === _lastError && now - _lastErrorTime < 3000) return;
    _lastError = key;
    _lastErrorTime = now;

    window.parent.postMessage({
      type: 'app:error:report',
      error: {
        message: String(errorMsg || 'Unknown error'),
        source: source || '(unknown)',
        lineno: lineno || null,
        colno: colno || null,
        stack: errorObj && errorObj.stack ? errorObj.stack : null,
        timestamp: now
      }
    }, '*');
  }

  // --- vc-* sanitizer wiring ---
  // The vc-core sanitize seam (Vc.sanitize) is a pass-through until a real engine
  // is installed. Load DOMPurify (small) and install it platform-wide so every
  // component that injects caller HTML (vc-chat-log, vc-markdown) is XSS-safe by
  // default. Heavy renderers (marked/KaTeX) are loaded lazily by vc-markdown itself,
  // so apps that never render docs pay nothing for them.
  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-vc-lib="' + src + '"]');
      if (existing) {
        if (existing.dataset.loaded) return resolve();
        existing.addEventListener('load', function () { resolve(); });
        existing.addEventListener('error', function () { reject(new Error('load failed: ' + src)); });
        return;
      }
      var s = document.createElement('script');
      s.src = src; s.async = true; s.dataset.vcLib = src;
      s.addEventListener('load', function () { s.dataset.loaded = '1'; resolve(); });
      s.addEventListener('error', function () { reject(new Error('load failed: ' + src)); });
      document.head.appendChild(s);
    });
  }
  window.__vcLoadScript = loadScriptOnce; // shared by vc-markdown's lazy loader

  function installSanitizer() {
    if (!window.Vc || !window.DOMPurify || Vc.__sanitizerInstalled) return;
    Vc.setSanitizer(function (html) {
      return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true } });
    });
    Vc.__sanitizerInstalled = true;
  }
  window.__vcInstallSanitizer = installSanitizer; // vc-markdown calls this too
  loadScriptOnce('/pro/purify.min.js').then(function () {
    // vc.js is a synchronous <script> after app-runtime, so Vc exists by now; if an
    // app omits it, retry briefly in case vc-core arrives slightly later.
    var tries = 0;
    (function attempt() {
      if (window.Vc) return installSanitizer();
      if (tries++ < 50) setTimeout(attempt, 100);
    })();
  }).catch(function (err) { console.warn('[vc] DOMPurify load failed; HTML stays unsanitized:', err); });

  window.onerror = function(msg, source, lineno, colno, error) {
    handleError(msg, source, lineno, colno, error);
  };
  window.addEventListener('unhandledrejection', function(event) {
    var err = event.reason;
    handleError(
      err && err.message ? err.message : String(err),
      err && err.fileName ? err.fileName : '(promise)',
      err && err.lineNumber, err && err.columnNumber, err
    );
  });
})();
