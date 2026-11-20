// <vc-media-viewer> — one viewer for image / video / audio / pdf / file, with a
// zoomable image canvas and an optional gallery. Part of the vistaclair-pro
// `vc-*` system. Shadow-DOM, theme-aware, built on vc-core (`Vc.Element`).
//
// Two modes:
//   • inline  — fills its host box: <vc-media-viewer src="…" style="height:400px">
//   • modal   — full-screen lightbox over the page; reveal with open():
//                 const v = document.querySelector('vc-media-viewer');  // has `modal`
//                 v.open([{src,title}, …], 0);   // or v.open({src})
//
// Image kind renders to a <canvas>: wheel/⌃+− zoom toward the cursor, drag or
// pinch to pan, double-click toggles fit⇄2×, rotate in 90° steps (rotate re-fits).
// video gets native controls PLUS the same wheel/drag zoom-pan (CSS transform),
// a playback-speed menu, a position seek bar (own row under the toolbar), and the
// adjustments panel. An optional frame-step mode (toolbar "Frame step" checkbox or
// the `frame-step` attribute) lets a paused video step one frame at a time via
// ,/. keys, mousewheel, horizontal swipe, or the ⏮/⏭ buttons; with it off the
// wheel zooms as usual. The whole frame can go fullscreen (any kind). audio/pdf/file
// are otherwise unchanged.
//
// Adjustments (brightness/contrast/saturation/hue) apply to both image and video
// via a CSS filter — on the canvas for images, on the <video> element for video.
//
// Kind is detected from `mime` then the `src` extension; override per item with
// `kind`. Gallery: pass an array to open()/items; ←/→ (or nav arrows) move; the
// image view resets per item.
//
// Usage:
//   <vc-media-viewer src="/photo.jpg" title="Front door"></vc-media-viewer>
//   el.open([{ src, title?, kind?, mime?, poster?, downloadName?, fps?, start?, timeline? }], 0)
//     start    — video: open positioned at this many seconds (clamped)
//     timeline — video: { values: number[0..1], colors?, titles?, label?(i) } drawn as
//                an activity strip under the seek bar (hover = time, click/drag seeks)
//   el.next(); el.prev(); el.go(i); el.close()
//   el.zoomIn(); el.zoomOut(); el.zoomToFit(); el.zoomActual(); el.rotate()  // image + video
//   el.setSpeed(2);                       // video playback rate
//   el.seek(120);                         // video position in seconds (clamped)
//   el.stepFrame(1); el.stepFrame(-1);    // video frame step (pauses if playing)
//   el.setFps(25);                        // override frame rate for the current item
//   el.setAdjust({ brightness: 120 }); el.resetAdjust()
//   el.toggleFullscreen(); el.requestFullscreen(); el.exitFullscreen()
// Keys: ←/→ nav · +/−/0/1 zoom · r rotate (image) · </> speed (video) ·
//   ,/. step one frame (video, frame-step on) · f fullscreen · Esc closes a
//   popover, else the modal.
// Attributes: src, kind, title, mime, modal, no-controls, no-download, frame-step.
// Properties: items (get/set), index (get/set), src (get/set), current(),
//   currentTime / duration (read-only, current video item; null otherwise).
// Events (composed): load {index,item,kind,naturalWidth?,naturalHeight?},
//   error {index,item,message}, change {index,item},
//   framestep {index,item,currentTime,frame,fps,approximate},
//   timeupdate {index,item,currentTime,duration} (video, while playing + on seek), close.

(function () {
  'use strict';
  if (!window.Vc || !Vc.Element) { console.error('[vc-media-viewer] requires vc-core.js'); return; }
  if (window.customElements && customElements.get('vc-media-viewer')) return;

  const EXT_KIND = {
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
    bmp: 'image', svg: 'image', avif: 'image', ico: 'image',
    mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', mkv: 'video', ogv: 'video',
    mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio',
    pdf: 'pdf',
  };

  function basename(src) {
    try { return decodeURIComponent(String(src).split(/[?#]/)[0].split('/').pop() || ''); }
    catch (_) { return String(src).split(/[?#]/)[0].split('/').pop() || ''; }
  }
  function extOf(src) {
    const b = basename(src);
    const i = b.lastIndexOf('.');
    return i >= 0 ? b.slice(i + 1).toLowerCase() : '';
  }
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    s = Math.floor(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(ss).padStart(2, '0');
  }
  function detectKind(item) {
    if (item.kind) return item.kind;
    // explicit mime, then the mime carried by a data: URI, then file extension
    let mime = String(item.mime || '').toLowerCase();
    if (!mime) {
      const m = /^data:([^;,]+)[;,]/.exec(String(item.src || ''));
      if (m) mime = m[1].toLowerCase();
    }
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'pdf';
    return EXT_KIND[extOf(item.src)] || 'file';
  }
  function normItem(it) {
    if (it == null) return null;
    if (typeof it === 'string') return { src: it };
    return it;
  }

  const TEMPLATE = `
    <style>
      :host {
        display: block; position: relative; width: 100%; height: 100%;
        color: var(--text, #c0caf5); background: var(--bg-deep, #0a0e17);
        --vc-mv-bg: var(--bg-deep, #0a0e17);
      }
      :host([modal]) {
        position: fixed; inset: 0; z-index: 9999; width: 100vw; height: 100vh;
        background: transparent;
      }
      .vc-backdrop { display: none; }
      :host([modal]) .vc-backdrop {
        display: block; position: absolute; inset: 0;
        background: rgba(0,0,0,.82); backdrop-filter: blur(2px);
      }
      .vc-frame {
        position: relative; z-index: 1; display: flex; flex-direction: column;
        width: 100%; height: 100%;
      }
      :host([modal]) .vc-frame {
        width: min(94vw, 1400px); height: min(92vh, 1000px);
        margin: auto; inset: 0; position: absolute;
        background: var(--vc-mv-bg); border: 1px solid var(--border, #414868);
        border-radius: var(--radius, 6px); overflow: hidden;
        box-shadow: 0 16px 60px rgba(0,0,0,.6);
      }
      .vc-toolbar {
        display: flex; align-items: center; gap: 10px; flex: none;
        padding: 7px 10px; font-size: 13px;
        background: var(--bg-surface, #24283b);
        border-bottom: 1px solid var(--border, #414868);
      }
      :host([no-controls]) .vc-toolbar { display: none; }
      .vc-title {
        font-weight: 600; white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; max-width: 50%;
      }
      .vc-count { color: var(--text-dim, #565f89); font-family: var(--font-mono, monospace); font-size: 12px; }
      .vc-tools { margin-left: auto; display: flex; align-items: center; gap: 4px; }
      .vc-tools button {
        font: inherit; font-size: 12px; line-height: 1; min-width: 28px; height: 28px;
        padding: 0 7px; cursor: pointer;
        background: var(--bg, #1a1b26); color: var(--text, #c0caf5);
        border: 1px solid var(--border, #414868); border-radius: var(--radius, 6px);
        transition: background .12s, border-color .12s, opacity .12s;
      }
      .vc-tools button:hover:not(:disabled) { background: var(--bg-hover, #2f3348); border-color: var(--accent, #7aa2f7); }
      .vc-tools button:disabled { opacity: .4; cursor: default; }
      .vc-tools .sep { width: 1px; height: 18px; background: var(--border, #414868); margin: 0 3px; }
      .vc-tools [hidden] { display: none; }
      .vc-fstep-toggle {
        display: inline-flex; align-items: center; gap: 5px; height: 28px;
        padding: 0 8px; cursor: pointer; user-select: none; font-size: 12px;
        color: var(--text, #c0caf5);
        background: var(--bg, #1a1b26);
        border: 1px solid var(--border, #414868); border-radius: var(--radius, 6px);
      }
      .vc-fstep-toggle input { accent-color: var(--accent, #7aa2f7); margin: 0; cursor: pointer; }
      .vc-fstep-hint { font-size: 11px; color: var(--text-dim, #565f89); white-space: nowrap; }
      .vc-stage {
        position: relative; flex: 1; min-height: 0; overflow: hidden;
        display: grid; place-items: center; background: var(--vc-mv-bg);
      }
      canvas.vc-canvas {
        max-width: 100%; max-height: 100%;
        touch-action: none; cursor: grab; display: none;
      }
      canvas.vc-canvas.panning { cursor: grabbing; }
      .vc-slot { display: none; width: 100%; height: 100%; place-items: center; }
      .vc-slot.show { display: grid; }
      .vc-slot video { max-width: 100%; max-height: 100%; background: #000; }
      .vc-slot iframe { width: 100%; height: 100%; border: 0; background: #fff; }
      .vc-media-card {
        display: flex; flex-direction: column; align-items: center; gap: 14px;
        padding: 28px 22px; text-align: center; color: var(--text-dim, #565f89);
        font-size: 13px; max-width: 90%;
      }
      .vc-media-card .ic { font-size: 46px; line-height: 1; opacity: .85; }
      .vc-media-card .nm { color: var(--text, #c0caf5); font-weight: 600; word-break: break-all; }
      .vc-media-card audio { width: min(420px, 80vw); }
      .vc-media-card .row { display: flex; gap: 8px; }
      .vc-media-card a, .vc-media-card button {
        font: inherit; font-size: 13px; padding: 7px 14px; cursor: pointer;
        text-decoration: none; border-radius: var(--radius, 6px);
        border: 1px solid var(--accent, #7aa2f7);
        background: var(--accent, #7aa2f7); color: #fff;
      }
      .vc-media-card a.ghost {
        background: var(--bg, #1a1b26); color: var(--text, #c0caf5);
        border-color: var(--border, #414868);
      }
      .vc-empty { color: var(--text-dim, #565f89); font-size: 13px; }
      .vc-err { color: var(--red, #f7768e); font-size: 13px; padding: 20px; text-align: center; }
      .vc-nav {
        position: absolute; top: 50%; transform: translateY(-50%); z-index: 3;
        width: 40px; height: 56px; display: grid; place-items: center;
        font-size: 26px; line-height: 1; cursor: pointer; color: #fff;
        background: rgba(0,0,0,.4); border: 0; border-radius: var(--radius, 6px);
        transition: background .12s, opacity .12s;
      }
      .vc-nav:hover { background: rgba(0,0,0,.65); }
      .vc-nav.prev { left: 8px; } .vc-nav.next { right: 8px; }
      .vc-nav[hidden] { display: none; }
      .vc-slot video { transform-origin: center center; will-change: transform; }
      /* adjustment / speed popovers */
      .vc-pop {
        position: absolute; top: 44px; right: 10px; z-index: 6;
        background: var(--bg-surface, #24283b); color: var(--text, #c0caf5);
        border: 1px solid var(--border, #414868); border-radius: var(--radius, 6px);
        box-shadow: 0 10px 34px rgba(0,0,0,.55); padding: 10px;
        display: flex; flex-direction: column; gap: 9px; font-size: 12px;
      }
      .vc-pop[hidden] { display: none; }
      .vc-adjust { min-width: 210px; }
      .vc-adjust label { display: grid; grid-template-columns: 62px 1fr 38px; align-items: center; gap: 8px; }
      .vc-adjust input[type=range] { width: 100%; accent-color: var(--accent, #7aa2f7); }
      .vc-adjust .val { text-align: right; font-family: var(--font-mono, monospace); color: var(--text-dim, #565f89); }
      .vc-pop .reset {
        align-self: flex-end; font: inherit; font-size: 12px; cursor: pointer; margin-top: 2px;
        padding: 4px 10px; border-radius: var(--radius, 6px);
        background: var(--bg, #1a1b26); color: var(--text, #c0caf5); border: 1px solid var(--border, #414868);
      }
      .vc-pop .reset:hover { border-color: var(--accent, #7aa2f7); }
      .vc-speed { flex-direction: row; flex-wrap: wrap; gap: 4px; max-width: 210px; }
      .vc-speed button {
        font: inherit; font-size: 12px; line-height: 1; height: 26px; padding: 0 8px; cursor: pointer;
        background: var(--bg, #1a1b26); color: var(--text, #c0caf5);
        border: 1px solid var(--border, #414868); border-radius: var(--radius, 6px);
      }
      .vc-speed button:hover { border-color: var(--accent, #7aa2f7); }
      .vc-speed button.active { background: var(--accent, #7aa2f7); color: #fff; border-color: var(--accent, #7aa2f7); }
      /* video position seeker (own row under the toolbar) */
      .vc-seek {
        display: flex; align-items: center; gap: 10px; flex: none;
        padding: 6px 12px; font-size: 12px;
        background: var(--bg-surface, #24283b);
        border-bottom: 1px solid var(--border, #414868);
      }
      .vc-seek[hidden] { display: none; }
      :host([no-controls]) .vc-seek { display: none; }
      .vc-seek .vc-time { font-family: var(--font-mono, monospace); color: var(--text-dim, #565f89); min-width: 46px; }
      .vc-seek .vc-time.dur { text-align: right; }
      .vc-seek input[type=range] { flex: 1; min-width: 0; accent-color: var(--accent, #7aa2f7); cursor: pointer; }
      /* optional per-item activity strip (item.timeline) under the seek range;
         inset by half a range thumb so bucket edges line up with the thumb travel */
      .vc-track { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      .vc-track input[type=range] { flex: none; }
      .vc-timeline {
        position: relative; height: 18px; margin: 2px var(--vc-mv-timeline-inset, 8px) 0;
        background: var(--bg, #1a1b26); border-radius: 3px; cursor: pointer; touch-action: none;
      }
      .vc-timeline[hidden] { display: none; }
      .vc-timeline canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
      .vc-tl-head {
        position: absolute; top: -2px; bottom: -2px; left: 0; width: 2px; margin-left: -1px;
        background: var(--text, #c0caf5); box-shadow: 0 0 0 1px rgba(0,0,0,.55); pointer-events: none;
      }
      .vc-tl-tip {
        position: absolute; bottom: calc(100% + 6px); left: 0;
        padding: 3px 7px; white-space: nowrap; pointer-events: none; z-index: 2;
        font-family: var(--font-mono, monospace); font-size: 11px;
        background: var(--bg-surface, #24283b); color: var(--text, #c0caf5);
        border: 1px solid var(--border, #414868); border-radius: var(--radius, 6px);
      }
      .vc-tl-tip[hidden] { display: none; }
      /* fullscreen: the frame becomes the fullscreen element — fill the screen
         (override the modal centring rule, which has higher specificity) */
      .vc-frame:fullscreen {
        width: 100% !important; height: 100% !important;
        max-width: none !important; max-height: none !important;
        margin: 0 !important; inset: auto !important; position: relative !important;
        border: 0 !important; border-radius: 0 !important;
        background: var(--vc-mv-bg);
      }
      @media (prefers-reduced-motion: reduce) {
        .vc-tools button, .vc-nav { transition: none; }
      }
    </style>
    <div class="vc-backdrop" part="backdrop"></div>
    <div class="vc-frame" part="frame" tabindex="-1">
      <div class="vc-toolbar" part="toolbar">
        <span class="vc-title" part="title"></span>
        <span class="vc-count" part="count"></span>
        <span class="vc-tools">
          <button class="t-speed" part="button" title="Playback speed">1×</button>
          <label class="vc-fstep-toggle" part="frame-toggle" title="Frame step"><input type="checkbox" class="t-fstep"><span>Frame step</span></label>
          <button class="t-fprev" part="frame-prev" title="Previous frame (,)">⏮</button>
          <button class="t-fnext" part="frame-next" title="Next frame (.)">⏭</button>
          <span class="vc-fstep-hint">step ⏮ ⏭ · , .</span>
          <button class="t-fit" part="button" title="Fit (0)">Fit</button>
          <button class="t-actual" part="button" title="Actual size (1)">1:1</button>
          <button class="t-out" part="button" title="Zoom out (−)">−</button>
          <button class="t-in" part="button" title="Zoom in (+)">+</button>
          <button class="t-rot" part="button" title="Rotate (r)">⟳</button>
          <button class="t-adjust" part="button" title="Adjustments">◐</button>
          <span class="sep t-imgsep"></span>
          <button class="t-fs" part="button" title="Fullscreen (f)">⛶</button>
          <a class="t-dl" part="button" title="Download" download>⤓</a>
          <button class="t-close" part="button" title="Close (Esc)">✕</button>
        </span>
      </div>
      <div class="vc-seek" part="seek" hidden>
        <span class="vc-time cur" part="time">0:00</span>
        <div class="vc-track">
          <input class="t-seek" type="range" min="0" max="1000" value="0" step="1" part="seek-range" aria-label="Seek">
          <div class="vc-timeline" part="timeline" hidden>
            <canvas></canvas>
            <div class="vc-tl-head" part="timeline-playhead"></div>
            <div class="vc-tl-tip" part="timeline-tip" hidden></div>
          </div>
        </div>
        <span class="vc-time dur" part="duration">0:00</span>
      </div>
      <div class="vc-stage" part="stage">
        <button class="vc-nav prev" part="nav-prev" title="Previous (←)" aria-label="Previous">‹</button>
        <canvas class="vc-canvas" part="canvas" title="Scroll to zoom · drag to pan"></canvas>
        <div class="vc-slot" part="slot"></div>
        <button class="vc-nav next" part="nav-next" title="Next (→)" aria-label="Next">›</button>
        <div class="vc-pop vc-speed" part="speed-menu" hidden></div>
        <div class="vc-pop vc-adjust" part="adjust-menu" hidden>
          <label>Brightness<input type="range" data-adj="brightness" min="0" max="200" step="1" value="100"><span class="val" data-val="brightness">100%</span></label>
          <label>Contrast<input type="range" data-adj="contrast" min="0" max="200" step="1" value="100"><span class="val" data-val="contrast">100%</span></label>
          <label>Saturation<input type="range" data-adj="saturate" min="0" max="200" step="1" value="100"><span class="val" data-val="saturate">100%</span></label>
          <label>Hue<input type="range" data-adj="hue-rotate" min="0" max="360" step="1" value="0"><span class="val" data-val="hue-rotate">0°</span></label>
          <button class="reset" part="button">Reset</button>
        </div>
      </div>
    </div>
  `;

  class VcMediaViewer extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() { return ['src', 'kind', 'title', 'mime', 'modal', 'no-controls', 'no-download', 'frame-step']; }

    constructor() {
      super();
      this._items = [];
      this._index = 0;
      this._kind = 'file';
      this._img = { el: null, scale: 1, fit: 1, tx: 0, ty: 0, rot: 0, nw: 0, nh: 0 };
      this._vid = { el: null, scale: 1, tx: 0, ty: 0 };
      this._adj = { brightness: 100, contrast: 100, saturate: 100, 'hue-rotate': 0 };
      this._speed = 1;
      // frame-step state (per video item): fps override, detected cadence, and
      // the wheel/swipe accumulators that coalesce raw input into whole frames.
      this._frameStep = { override: null, detected: null, wheelAccum: 0, swipe: null };
      this._pointers = new Map();
      this._pinch = null;
      this._dragLast = null;
      this._render = Vc.rafThrottle(() => this._paintCanvas());

      this._frame = this.$('.vc-frame');
      this._backdrop = this.$('.vc-backdrop');
      this._titleEl = this.$('.vc-title');
      this._countEl = this.$('.vc-count');
      this._canvas = this.$('.vc-canvas');
      this._slot = this.$('.vc-slot');
      this._stage = this.$('.vc-stage');
      this._prev = this.$('.vc-nav.prev');
      this._next = this.$('.vc-nav.next');
      this._dl = this.$('.t-dl');
      this._speedBtn = this.$('.t-speed');
      this._frameToggle = this.$('.vc-fstep-toggle');
      this._frameToggleInput = this.$('.t-fstep');
      this._framePrevBtn = this.$('.t-fprev');
      this._frameNextBtn = this.$('.t-fnext');
      this._frameHint = this.$('.vc-fstep-hint');
      this._adjustBtn = this.$('.t-adjust');
      this._rotBtn = this.$('.t-rot');
      this._fsBtn = this.$('.t-fs');
      this._speedMenu = this.$('.vc-speed');
      this._adjustMenu = this.$('.vc-adjust');
      this._zoomTools = this.$$('.t-fit, .t-actual, .t-out, .t-in');
      this._imgSep = this.$('.t-imgsep');
      this._seekRow = this.$('.vc-seek');
      this._seek = this.$('.t-seek');
      this._curTime = this.$('.vc-time.cur');
      this._durTime = this.$('.vc-time.dur');
      this._seeking = false;
      this._tl = this.$('.vc-timeline');
      this._tlCanvas = this.$('.vc-timeline canvas');
      this._tlHead = this.$('.vc-tl-head');
      this._tlTip = this.$('.vc-tl-tip');
      this._tlData = null;
      this._tlPaint = Vc.rafThrottle(() => this._paintTimeline());
    }

    connectedCallback() {
      if (this._wired) { return this._initFromAttrs(); }
      this._wired = true;

      this.$('.t-close').addEventListener('click', () => this.close());
      this.$('.t-fit').addEventListener('click', () => this.zoomToFit());
      this.$('.t-actual').addEventListener('click', () => this.zoomActual());
      this.$('.t-in').addEventListener('click', () => this.zoomIn());
      this.$('.t-out').addEventListener('click', () => this.zoomOut());
      this.$('.t-rot').addEventListener('click', () => this.rotate());
      this._prev.addEventListener('click', () => this.prev());
      this._next.addEventListener('click', () => this.next());
      this._backdrop.addEventListener('click', () => this.close());

      this._speedBtn.addEventListener('click', (e) => { e.stopPropagation(); this._togglePop(this._speedMenu); });
      this._adjustBtn.addEventListener('click', (e) => { e.stopPropagation(); this._togglePop(this._adjustMenu); });
      this._fsBtn.addEventListener('click', () => this.toggleFullscreen());

      this._frameToggleInput.addEventListener('change', () => this.reflectBool('frame-step', this._frameToggleInput.checked));
      this._framePrevBtn.addEventListener('click', () => this.stepFrame(-1));
      this._frameNextBtn.addEventListener('click', () => this.stepFrame(1));

      // seek bar (range is 0–1000 promille of duration → resilient to unknown duration)
      this._seek.addEventListener('input', () => {
        const v = this._vid.el; if (!v || !isFinite(v.duration)) return;
        this._seeking = true;
        this._curTime.textContent = fmtTime(v.duration * (this._seek.value / 1000));
        this._tlHead.style.left = (this._seek.value / 10) + '%';
      });
      this._seek.addEventListener('change', () => {
        const v = this._vid.el; if (!v || !isFinite(v.duration)) { this._seeking = false; return; }
        v.currentTime = v.duration * (this._seek.value / 1000);
        this._seeking = false;
      });
      // timeline strip: hover shows the time (+ title), click/drag seeks there
      this._tl.addEventListener('pointerdown', (e) => {
        if (e.button) return;
        this._tl.setPointerCapture(e.pointerId);
        this._tlSeekAt(e);
      });
      this._tl.addEventListener('pointermove', (e) => {
        if (this._tl.hasPointerCapture(e.pointerId)) this._tlSeekAt(e);
        this._tlHover(e);
      });
      this._tl.addEventListener('pointerleave', () => { this._tlTip.hidden = true; });
      if (window.ResizeObserver) new ResizeObserver(() => this._tlPaint()).observe(this._tl);

      this._onFsChange = () => this._syncFsButton();
      document.addEventListener('fullscreenchange', this._onFsChange);
      this._speedMenu.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-rate]'); if (!b) return;
        this.setSpeed(parseFloat(b.dataset.rate));
      });
      this._adjustMenu.addEventListener('input', (e) => {
        const inp = e.target.closest('input[data-adj]'); if (!inp) return;
        this._adj[inp.dataset.adj] = parseFloat(inp.value);
        this._applyAdjust();
      });
      this._adjustMenu.querySelector('.reset').addEventListener('click', () => this.resetAdjust());
      this._buildSpeedMenu();
      // a pointer-down outside the popovers/their buttons dismisses them
      this._frame.addEventListener('pointerdown', (e) => {
        if (!e.target.closest('.vc-pop, .t-speed, .t-adjust')) this._closePops();
      });

      this._onWheel = (e) => this._wheel(e);
      this._onDown = (e) => this._pointerDown(e);
      this._onMove = (e) => this._pointerMove(e);
      this._onUp = (e) => this._pointerUp(e);
      this._onDbl = () => this._toggleZoom();
      this._onResize = () => {
        if (this._kind === 'image' && this._img.el) { this._fit(); this._render(); }
        if (this._tlData) this._tlPaint();
      };

      this._canvas.addEventListener('wheel', this._onWheel, { passive: false });
      this._canvas.addEventListener('pointerdown', this._onDown);
      this._canvas.addEventListener('pointermove', this._onMove);
      this._canvas.addEventListener('pointerup', this._onUp);
      this._canvas.addEventListener('pointercancel', this._onUp);
      this._canvas.addEventListener('dblclick', this._onDbl);
      window.addEventListener('resize', this._onResize);

      this._onKey = (e) => this._key(e);
      this._frame.addEventListener('keydown', this._onKey);

      this._initFromAttrs();
    }

    disconnectedCallback() {
      window.removeEventListener('resize', this._onResize);
      if (this._onFsChange) document.removeEventListener('fullscreenchange', this._onFsChange);
      this._unbindModalKeys();
      this._stopMedia();
    }

    attributeChangedCallback(name) {
      if (!this._wired) return;
      if (name === 'modal') { if (this.hasAttribute('modal')) this._bindModalKeys(); else this._unbindModalKeys(); }
      else if (name === 'no-download' || name === 'frame-step') this._syncToolbar();
      else this._initFromAttrs();
    }

    // ---- public API ----
    get items() { return this._items.slice(); }
    set items(list) { this.open(list, 0); }

    get index() { return this._index; }
    set index(i) { this.go(i); }

    get src() { return (this._items[this._index] || {}).src || ''; }
    set src(v) { this.open(v == null ? [] : [{ src: String(v) }], 0); }

    current() { return this._items[this._index] || null; }

    // current video item's position / length in seconds (null when not a video
    // item, or — for duration — until its metadata has loaded)
    get currentTime() { return this._vid.el ? this._vid.el.currentTime : null; }
    get duration() { const v = this._vid.el; return v && isFinite(v.duration) ? v.duration : null; }

    open(itemsOrItem, startIndex) {
      const raw = Array.isArray(itemsOrItem) ? itemsOrItem : (itemsOrItem == null ? [] : [itemsOrItem]);
      this._items = raw.map(normItem).filter(Boolean);
      this._index = Vc.clamp(startIndex || 0, 0, Math.max(0, this._items.length - 1));
      if (this.hasAttribute('modal')) { this.hidden = false; this._bindModalKeys(); this._frame.focus(); }
      this._show();
      return this;
    }

    close() {
      if (this.isFullscreen()) this.exitFullscreen();
      this._stopMedia();
      if (this.hasAttribute('modal')) { this.hidden = true; this._unbindModalKeys(); }
      this.emit('close', { index: this._index });
      return this;
    }

    go(i) {
      if (!this._items.length) return this;
      const n = Vc.clamp(i, 0, this._items.length - 1);
      if (n === this._index && this._shown) return this;
      this._index = n;
      this._show();
      this.emit('change', { index: this._index, item: this.current() });
      return this;
    }
    next() { return this.go(this._index + 1); }
    prev() { return this.go(this._index - 1); }

    zoomIn() { this._zoomBy(1.25); return this; }
    zoomOut() { this._zoomBy(1 / 1.25); return this; }
    zoomToFit() {
      if (this._vid.el) { this._vid.scale = 1; this._vid.tx = 0; this._vid.ty = 0; this._applyVidTransform(); return this; }
      if (this._img.el) { this._fit(); this._render(); }
      return this;
    }
    zoomActual() {
      if (this._vid.el) {
        const r = this._vid.el.getBoundingClientRect();
        this._vidZoomTo(1, r.left + r.width / 2, r.top + r.height / 2);
        return this;
      }
      if (!this._img.el) return this;
      this._zoomTo(1, this._stage.clientWidth / 2, this._stage.clientHeight / 2);
      return this;
    }
    rotate(deg) {
      if (!this._img.el) return this;
      const step = (deg == null ? 90 : deg);
      this._img.rot = (((this._img.rot + step) % 360) + 360) % 360;
      this._fit(); this._render();
      return this;
    }

    // ---- internals: lifecycle ----
    _initFromAttrs() {
      const src = this.getAttribute('src');
      if (src && !this._items.length) {
        this._items = [{
          src,
          kind: this.getAttribute('kind') || undefined,
          mime: this.getAttribute('mime') || undefined,
          title: this.getAttribute('title') || undefined,
        }];
        this._index = 0;
      }
      if (this.hasAttribute('modal')) {
        this.hidden = true; // modal stays hidden until open()
      } else {
        this._show();
      }
    }

    _show() {
      const item = this.current();
      this._shown = true;
      this._loadToken = (this._loadToken || 0) + 1; // invalidates in-flight async loads
      this._closePops();
      this._stopMedia();
      this._vid.el = null;
      this._slot.classList.remove('show');
      this._slot.innerHTML = '';
      this._canvas.style.display = 'none';
      this._setTimeline(null);

      const multi = this._items.length > 1;
      this._prev.hidden = !multi;
      this._next.hidden = !multi;
      this._prev.disabled = this._index <= 0;
      this._next.disabled = this._index >= this._items.length - 1;
      this._countEl.textContent = multi ? `${this._index + 1} / ${this._items.length}` : '';

      if (!item) {
        this._kind = 'file';
        this._titleEl.textContent = '';
        this._slot.classList.add('show');
        this._slot.innerHTML = '<div class="vc-empty">No media.</div>';
        this._syncToolbar();
        return;
      }

      this._kind = detectKind(item);
      this._titleEl.textContent = item.title || basename(item.src) || '';
      this._dl.href = item.src || '#';
      this._dl.setAttribute('download', item.downloadName || basename(item.src) || '');
      this._syncToolbar();

      if (this._kind === 'image') this._showImage(item);
      else if (this._kind === 'video') this._showVideo(item);
      else if (this._kind === 'audio') this._showAudio(item);
      else if (this._kind === 'pdf') this._showPdf(item);
      else this._showFile(item);
    }

    _syncToolbar() {
      const isImg = this._kind === 'image';
      const isVid = this._kind === 'video';
      const zoomable = isImg || isVid;          // image and video both support zoom/pan
      const adjustable = isImg || isVid;        // CSS filters apply to image canvas and video
      this._zoomTools.forEach((el) => { el.hidden = !zoomable; });
      this._rotBtn.hidden = !isImg;             // rotate stays image-only (canvas-rendered)
      this._speedBtn.hidden = !isVid;
      // frame-step checkbox is video-only; the step buttons + hint show only once enabled
      const stepOn = isVid && this.hasAttribute('frame-step');
      this._frameToggle.hidden = !isVid;
      this._frameToggleInput.checked = stepOn;
      this._framePrevBtn.hidden = !stepOn;
      this._frameNextBtn.hidden = !stepOn;
      this._frameHint.hidden = !stepOn;
      this._adjustBtn.hidden = !adjustable;
      this._imgSep.hidden = !(zoomable || adjustable);
      this._seekRow.hidden = !isVid;
      this._dl.hidden = this.hasAttribute('no-download') || !this.current();
    }

    _stopMedia() {
      const v = this._slot.querySelector('video, audio');
      if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) {} }
    }

    // ---- per-kind renderers ----
    _showImage(item) {
      this._canvas.style.display = 'block';
      const token = this._loadToken;
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => {
        if (token !== this._loadToken) return; // superseded by a newer _show()
        this._img.el = im; this._img.nw = im.naturalWidth; this._img.nh = im.naturalHeight; this._img.rot = 0;
        this._fit(); this._applyAdjust(); this._render();
        this.emit('load', { index: this._index, item, kind: 'image', naturalWidth: im.naturalWidth, naturalHeight: im.naturalHeight });
      };
      im.onerror = () => { if (token === this._loadToken) this._fail(item, 'Image failed to load'); };
      this._img.el = null;
      im.src = item.src;
    }

    _showVideo(item) {
      this._slot.classList.add('show');
      const v = document.createElement('video');
      v.controls = true; v.autoplay = true; v.playsInline = true; v.src = item.src;
      if (item.poster) v.poster = item.poster;
      // pendingSeek: a seek() (or item.start) asked for before metadata loaded
      const start = Number(item.start);
      this._vid = { el: v, scale: 1, tx: 0, ty: 0, pendingSeek: start > 0 ? start : null };
      v.playbackRate = this._speed;
      this._frameStep = { override: null, detected: null, wheelAccum: 0, swipe: null };
      this._resetSeek();
      this._setTimeline(item.timeline);
      const syncDur = () => { if (isFinite(v.duration)) this._durTime.textContent = fmtTime(v.duration); };
      v.addEventListener('loadedmetadata', () => {
        v.playbackRate = this._speed;             // some browsers reset rate on metadata
        syncDur();
        if (this._vid.el === v && this._vid.pendingSeek != null) {
          const at = this._vid.pendingSeek;
          this._vid.pendingSeek = null;
          this.seek(at);
        }
        if (item.fps == null) this._detectFps(v); // skip detection when fps is supplied
        this.emit('load', { index: this._index, item, kind: 'video' });
      }, { once: true });
      v.addEventListener('durationchange', syncDur);
      v.addEventListener('timeupdate', () => {
        this._syncSeek();
        if (this._vid.el !== v) return;
        this.emit('timeupdate', {
          index: this._index, item, currentTime: v.currentTime,
          duration: isFinite(v.duration) ? v.duration : null,
        });
      });
      v.addEventListener('error', () => this._fail(item, 'Video failed to load'), { once: true });
      // zoom/pan: wheel zooms toward the cursor, drag pans (controls bar still works)
      v.addEventListener('wheel', (e) => this._vidWheel(e), { passive: false });
      v.addEventListener('pointerdown', (e) => this._vidDown(e));
      v.addEventListener('pointermove', (e) => this._vidMove(e));
      v.addEventListener('pointerup', (e) => this._vidUp(e));
      v.addEventListener('pointercancel', (e) => this._vidUp(e));
      this._slot.appendChild(v);
      this._applyVidTransform();
      this._applyAdjust();
    }

    _showAudio(item) {
      this._slot.classList.add('show');
      const card = document.createElement('div');
      card.className = 'vc-media-card';
      const ic = document.createElement('div'); ic.className = 'ic'; ic.textContent = '🎵';
      const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = item.title || basename(item.src);
      const a = document.createElement('audio'); a.controls = true; a.autoplay = true; a.src = item.src;
      a.addEventListener('loadedmetadata', () => this.emit('load', { index: this._index, item, kind: 'audio' }), { once: true });
      a.addEventListener('error', () => this._fail(item, 'Audio failed to load'), { once: true });
      card.append(ic, nm, a);
      this._slot.appendChild(card);
    }

    _showPdf(item) {
      this._slot.classList.add('show');
      const f = document.createElement('iframe');
      f.src = item.src; f.title = item.title || basename(item.src);
      f.addEventListener('load', () => this.emit('load', { index: this._index, item, kind: 'pdf' }), { once: true });
      this._slot.appendChild(f);
    }

    _showFile(item) {
      this._slot.classList.add('show');
      const card = document.createElement('div');
      card.className = 'vc-media-card';
      const ext = extOf(item.src);
      const ic = document.createElement('div'); ic.className = 'ic'; ic.textContent = '📄';
      const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = item.title || basename(item.src);
      const meta = document.createElement('div');
      meta.textContent = (ext ? ext.toUpperCase() + ' file' : 'File') + (item.size != null ? ' · ' + Vc.formatBytes(item.size) : '');
      const row = document.createElement('div'); row.className = 'row';
      const open = document.createElement('a'); open.href = item.src; open.target = '_blank'; open.rel = 'noopener'; open.textContent = 'Open';
      const dl = document.createElement('a'); dl.href = item.src; dl.className = 'ghost'; dl.setAttribute('download', item.downloadName || basename(item.src) || ''); dl.textContent = 'Download';
      row.append(open, dl);
      card.append(ic, nm, meta, row);
      this._slot.appendChild(card);
      this.emit('load', { index: this._index, item, kind: 'file' });
    }

    _fail(item, message) {
      this._canvas.style.display = 'none';
      this._slot.classList.add('show');
      this._slot.innerHTML = '<div class="vc-err">' + Vc.escapeHtml(message) + '</div>';
      this.emit('error', { index: this._index, item, message });
    }

    // ---- image canvas: zoom/pan/rotate ----
    // The displayed bounding box (top-left tx,ty; size dw,dh) is the single source
    // of truth, so zoom/pan/rotate all compose without per-pixel image mapping.
    _box() {
      const swap = this._img.rot % 180 !== 0;
      const dw = (swap ? this._img.nh : this._img.nw) * this._img.scale;
      const dh = (swap ? this._img.nw : this._img.nh) * this._img.scale;
      return { dw, dh };
    }
    _baseDims() {
      const swap = this._img.rot % 180 !== 0;
      return { w: swap ? this._img.nh : this._img.nw, h: swap ? this._img.nw : this._img.nh };
    }
    _fit() {
      const sw = this._stage.clientWidth || 1, sh = this._stage.clientHeight || 1;
      const { w, h } = this._baseDims();
      this._img.fit = Math.min(sw / w, sh / h) || 1;
      this._img.scale = this._img.fit;
      const { dw, dh } = this._box();
      this._img.tx = (sw - dw) / 2;
      this._img.ty = (sh - dh) / 2;
    }
    _zoomTo(nextScale, anchorX, anchorY) {
      // floor/ceiling always include 1.0 so "actual size" is reachable even when
      // the image is smaller than the viewport (fit > 1).
      const min = Math.min(this._img.fit * 0.5, 1), max = Math.max(this._img.fit * 40, 1);
      const next = Vc.clamp(nextScale, min, max);
      const before = this._box();
      const fx = before.dw ? (anchorX - this._img.tx) / before.dw : 0.5;
      const fy = before.dh ? (anchorY - this._img.ty) / before.dh : 0.5;
      this._img.scale = next;
      const after = this._box();
      this._img.tx = anchorX - fx * after.dw;
      this._img.ty = anchorY - fy * after.dh;
      this._render();
    }
    _zoomBy(factor) {
      if (this._vid.el) {
        const r = this._vid.el.getBoundingClientRect();
        this._vidZoomTo(this._vid.scale * factor, r.left + r.width / 2, r.top + r.height / 2);
        return;
      }
      if (!this._img.el) return;
      this._zoomTo(this._img.scale * factor, this._stage.clientWidth / 2, this._stage.clientHeight / 2);
    }
    _toggleZoom() {
      if (!this._img.el) return;
      const near = Math.abs(this._img.scale - this._img.fit) < this._img.fit * 0.05;
      const c = this._canvas.getBoundingClientRect();
      const ax = (this._dblXY ? this._dblXY[0] : this._stage.clientWidth / 2);
      const ay = (this._dblXY ? this._dblXY[1] : this._stage.clientHeight / 2);
      this._zoomTo(near ? this._img.fit * 2 : this._img.fit, ax, ay);
    }
    _paintCanvas() {
      const cv = this._canvas, im = this._img.el;
      if (!im) return;
      const sw = this._stage.clientWidth, sh = this._stage.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      cv.style.width = sw + 'px'; cv.style.height = sh + 'px';
      if (cv.width !== Math.round(sw * dpr)) cv.width = Math.round(sw * dpr);
      if (cv.height !== Math.round(sh * dpr)) cv.height = Math.round(sh * dpr);
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, sw, sh);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.filter = this._filterString() || 'none';
      const { dw, dh } = this._box();
      const cx = this._img.tx + dw / 2, cy = this._img.ty + dh / 2;
      const drawW = this._img.nw * this._img.scale, drawH = this._img.nh * this._img.scale;
      ctx.translate(cx, cy);
      if (this._img.rot) ctx.rotate(this._img.rot * Math.PI / 180);
      ctx.drawImage(im, -drawW / 2, -drawH / 2, drawW, drawH);
    }

    // ---- pointer + wheel + keys ----
    _stageXY(e) {
      const r = this._canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }
    _wheel(e) {
      if (!this._img.el) return;
      e.preventDefault();
      const [x, y] = this._stageXY(e);
      this._zoomTo(this._img.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), x, y);
    }
    _pointerDown(e) {
      if (!this._img.el) return;
      this._canvas.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, this._stageXY(e));
      if (this._pointers.size === 2) {
        const pts = Array.from(this._pointers.values());
        this._pinch = { dist: this._dist(pts[0], pts[1]), mid: this._mid(pts[0], pts[1]) };
        this._dragLast = null;
      } else {
        this._dragLast = this._stageXY(e);
        this._canvas.classList.add('panning');
      }
    }
    _pointerMove(e) {
      if (!this._pointers.has(e.pointerId)) return;
      const cur = this._stageXY(e);
      this._pointers.set(e.pointerId, cur);
      if (this._pointers.size >= 2 && this._pinch) {
        const pts = Array.from(this._pointers.values());
        const dist = this._dist(pts[0], pts[1]);
        const mid = this._mid(pts[0], pts[1]);
        if (this._pinch.dist > 0) this._zoomTo(this._img.scale * (dist / this._pinch.dist), mid[0], mid[1]);
        this._img.tx += mid[0] - this._pinch.mid[0];
        this._img.ty += mid[1] - this._pinch.mid[1];
        this._pinch = { dist, mid };
        this._render();
      } else if (this._dragLast) {
        this._img.tx += cur[0] - this._dragLast[0];
        this._img.ty += cur[1] - this._dragLast[1];
        this._dragLast = cur;
        this._render();
      }
    }
    _pointerUp(e) {
      this._pointers.delete(e.pointerId);
      try { this._canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      if (this._pointers.size < 2) this._pinch = null;
      if (this._pointers.size === 0) { this._dragLast = null; this._canvas.classList.remove('panning'); }
      else if (this._pointers.size === 1) { this._dragLast = Array.from(this._pointers.values())[0]; }
      if (e.type === 'dblclick') return;
      this._dblXY = this._stageXY(e);
    }
    _dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
    _mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }

    // ---- speed ----
    setSpeed(rate) {
      this._speed = Vc.clamp(rate || 1, 0.0625, 16);
      if (this._vid.el) this._vid.el.playbackRate = this._speed;
      this._speedBtn.textContent = this._speed + '×';
      this._buildSpeedMenu();
      this._closePops();
      return this;
    }
    _buildSpeedMenu() {
      const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];
      this._speedMenu.innerHTML = rates.map((r) =>
        `<button data-rate="${r}" class="${r === this._speed ? 'active' : ''}">${r}×</button>`).join('');
    }

    // ---- frame stepping ----
    // Active only for video with the `frame-step` attribute set (mirrored by the
    // toolbar checkbox). Gates all wheel/swipe/key stepping in one place.
    _frameStepOn() { return this._kind === 'video' && this.hasAttribute('frame-step'); }

    // Resolve the frame rate to use, in priority order. `approximate` is true
    // whenever fps was estimated (detected or the 30fps fallback) rather than known.
    _resolveFps() {
      const fs = this._frameStep;
      if (fs.override > 0) return { fps: fs.override, approximate: false };
      const item = this.current();
      const itemFps = item && Number(item.fps);
      if (itemFps > 0) return { fps: itemFps, approximate: false };
      if (fs.detected > 0) return { fps: fs.detected, approximate: true };
      return { fps: 30, approximate: true };
    }

    // Best-effort cadence detection via requestVideoFrameCallback: sample frame
    // mediaTime deltas and take the median. Token-guarded so an item switch cancels.
    _detectFps(v) {
      if (typeof v.requestVideoFrameCallback !== 'function') return;
      const token = this._loadToken;
      const times = [];
      let last = null;
      const onFrame = (_now, meta) => {
        if (token !== this._loadToken || v !== this._vid.el) return; // superseded
        const t = meta && typeof meta.mediaTime === 'number' ? meta.mediaTime : null;
        if (t != null && last != null) { const d = t - last; if (d > 0) times.push(d); }
        last = t;
        if (times.length < 10) { v.requestVideoFrameCallback(onFrame); return; }
        const sorted = times.slice().sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const fps = median > 0 ? Math.round(1 / median) : 0;
        if (fps >= 1 && fps <= 240) this._frameStep.detected = fps;
      };
      v.requestVideoFrameCallback(onFrame);
    }

    setFps(fps) {
      const n = Number(fps);
      this._frameStep.override = n > 0 ? n : null;
      return this;
    }

    stepFrame(n) {
      const v = this._vid.el;
      if (!v) return this;
      if (n == null) n = 1;
      if (!v.paused) v.pause();                  // stepping implies pause-first
      const { fps, approximate } = this._resolveFps();
      const hi = isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
      const next = Vc.clamp(v.currentTime + n / fps, 0, hi);
      v.currentTime = next;
      this.emit('framestep', {
        index: this._index, item: this.current(), currentTime: next,
        frame: Math.round(next * fps), fps, approximate,
      });
      return this;
    }

    // ---- seek bar ----
    // Seek the current video item to `sec` (clamped to [0, duration]); before
    // metadata has loaded the position is kept and applied once it has.
    seek(sec) {
      const v = this._vid.el;
      if (!v) return this;
      const t = Math.max(0, Number(sec) || 0);
      if (v.readyState < 1) { this._vid.pendingSeek = t; return this; }
      v.currentTime = isFinite(v.duration) ? Math.min(t, v.duration) : t;
      this._syncSeek();
      return this;
    }
    _resetSeek() {
      this._seeking = false;
      this._seek.value = 0;
      this._curTime.textContent = '0:00';
      this._durTime.textContent = '0:00';
    }
    _syncSeek() {
      const v = this._vid.el; if (!v || this._seeking) return;
      this._curTime.textContent = fmtTime(v.currentTime);
      if (isFinite(v.duration) && v.duration > 0) {
        this._seek.value = Math.round((v.currentTime / v.duration) * 1000);
        this._tlHead.style.left = (Vc.clamp(v.currentTime / v.duration, 0, 1) * 100) + '%';
      }
    }

    // ---- timeline strip (item.timeline: { values, colors?, titles?, label? }) ----
    // Bucket i of n covers [i/n, (i+1)/n] of the duration, so the strip draws
    // before the duration is known; only hover times and seeking wait for it.
    _setTimeline(tl) {
      const values = tl && Array.isArray(tl.values) ? tl.values : null;
      this._tlData = values && values.length ? tl : null;
      this._tl.hidden = !this._tlData;
      this._tlTip.hidden = true;
      this._tlHead.style.left = '0%';
      if (this._tlData) this._tlPaint();
    }
    _paintTimeline() {
      const tl = this._tlData, cv = this._tlCanvas;
      if (!tl || this._tl.hidden) return;
      const w = this._tl.clientWidth, h = this._tl.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
      if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const accent = getComputedStyle(this).getPropertyValue('--accent').trim() || '#7aa2f7';
      const vals = tl.values, n = vals.length, bw = w / n;
      const colors = Array.isArray(tl.colors) ? tl.colors : null;
      for (let i = 0; i < n; i++) {
        const val = Vc.clamp(vals[i], 0, 1);
        if (!val) continue;
        const bh = Math.max(1, val * h);
        ctx.globalAlpha = colors && colors[i] ? 1 : 0.35 + 0.65 * val;
        ctx.fillStyle = (colors && colors[i]) || accent;
        // widen by a pixel fraction so adjacent buckets don't leave hairline gaps
        ctx.fillRect(i * bw, h - bh, bw + 0.5, bh);
      }
      ctx.globalAlpha = 1;
    }
    _tlFraction(e) {
      const r = this._tl.getBoundingClientRect();
      return r.width ? Vc.clamp((e.clientX - r.left) / r.width, 0, 1) : 0;
    }
    _tlSeekAt(e) {
      const v = this._vid.el; if (!v || !isFinite(v.duration)) return;
      v.currentTime = this._tlFraction(e) * v.duration;
      this._syncSeek();
    }
    _tlHover(e) {
      const tl = this._tlData; if (!tl) return;
      const f = this._tlFraction(e);
      const i = Math.min(tl.values.length - 1, Math.floor(f * tl.values.length));
      let title = Array.isArray(tl.titles) ? tl.titles[i] : null;
      if (title == null && typeof tl.label === 'function') { try { title = tl.label(i); } catch (_) { title = null; } }
      const v = this._vid.el;
      const time = v && isFinite(v.duration) ? fmtTime(f * v.duration) : '';
      const text = [time, title == null ? '' : String(title)].filter(Boolean).join(' · ');
      this._tlTip.textContent = text;
      this._tlTip.hidden = !text;
      this._tlTip.style.left = (f * 100) + '%';
      this._tlTip.style.transform = `translateX(${-f * 100}%)`;   // stays inside the strip at both ends
    }

    // ---- fullscreen (whole frame; works for any kind) ----
    // document.fullscreenElement is retargeted to the host; the shadow root sees the frame
    isFullscreen() { return this.shadowRoot.fullscreenElement === this._frame; }
    toggleFullscreen() {
      if (this.isFullscreen()) this.exitFullscreen(); else this.requestFullscreen();
      return this;
    }
    requestFullscreen() {
      if (this._frame.requestFullscreen) {
        Promise.resolve(this._frame.requestFullscreen()).catch(() => {});
      }
      return this;
    }
    exitFullscreen() {
      if (this.isFullscreen() && document.exitFullscreen) {
        Promise.resolve(document.exitFullscreen()).catch(() => {});
      }
      return this;
    }
    _syncFsButton() {
      const on = this.isFullscreen();
      this._fsBtn.textContent = on ? '⛗' : '⛶';
      this._fsBtn.title = on ? 'Exit fullscreen (f)' : 'Fullscreen (f)';
      if (this._kind === 'image' && this._img.el) { this._fit(); this._render(); }
    }

    // ---- image/video adjustments (CSS filters) ----
    _filterString() {
      const a = this._adj;
      const parts = [];
      if (a.brightness !== 100) parts.push(`brightness(${a.brightness}%)`);
      if (a.contrast !== 100) parts.push(`contrast(${a.contrast}%)`);
      if (a.saturate !== 100) parts.push(`saturate(${a.saturate}%)`);
      if (a['hue-rotate'] !== 0) parts.push(`hue-rotate(${a['hue-rotate']}deg)`);
      return parts.join(' ');
    }
    _applyAdjust() {
      const f = this._filterString();
      if (this._kind === 'image') this._render();          // canvas re-paints with ctx.filter
      else if (this._vid.el) this._vid.el.style.filter = f || 'none';
      // keep the readouts in sync (covers programmatic setAdjust())
      const units = { brightness: '%', contrast: '%', saturate: '%', 'hue-rotate': '°' };
      this._adjustMenu.querySelectorAll('input[data-adj]').forEach((inp) => {
        const k = inp.dataset.adj;
        if (parseFloat(inp.value) !== this._adj[k]) inp.value = this._adj[k];
        const v = this._adjustMenu.querySelector(`[data-val="${k}"]`);
        if (v) v.textContent = this._adj[k] + units[k];
      });
    }
    setAdjust(partial) {
      Object.assign(this._adj, partial || {});
      this._applyAdjust();
      return this;
    }
    resetAdjust() {
      this._adj = { brightness: 100, contrast: 100, saturate: 100, 'hue-rotate': 0 };
      this._applyAdjust();
      return this;
    }

    // ---- video zoom/pan (CSS transform; mirrors the image canvas math) ----
    _applyVidTransform() {
      const v = this._vid.el; if (!v) return;
      v.style.transform = `translate(${this._vid.tx}px, ${this._vid.ty}px) scale(${this._vid.scale})`;
      v.style.cursor = this._vid.scale > 1 ? (this._vidDrag ? 'grabbing' : 'grab') : '';
    }
    _vidZoomTo(next, ax, ay) {
      const v = this._vid.el; if (!v) return;
      const s = this._vid.scale;
      const clamped = Vc.clamp(next, 1, 40);
      // getBoundingClientRect() is the *transformed* box. Its centre is the
      // untransformed centre plus the current translate, so recover U = tc − t.
      const r = v.getBoundingClientRect();
      const tcx = r.left + r.width / 2, tcy = r.top + r.height / 2;
      const ux = tcx - this._vid.tx, uy = tcy - this._vid.ty;
      // local offset (CSS px, origin = centre) of the anchored point
      const lx = (ax - tcx) / s, ly = (ay - tcy) / s;
      this._vid.scale = clamped;
      this._vid.tx = ax - ux - lx * clamped;
      this._vid.ty = ay - uy - ly * clamped;
      if (clamped === 1) { this._vid.tx = 0; this._vid.ty = 0; }
      this._applyVidTransform();
    }
    _vidWheel(e) {
      e.preventDefault();
      if (this._frameStepOn()) {
        // coalesce raw deltaY (trackpads fire many small events) into one frame
        // per ~50px notch. Wheel down (deltaY > 0) → forward one frame.
        const fs = this._frameStep;
        fs.wheelAccum += e.deltaY;
        const NOTCH = 50;
        while (Math.abs(fs.wheelAccum) >= NOTCH) {
          const dir = fs.wheelAccum > 0 ? 1 : -1;
          fs.wheelAccum -= dir * NOTCH;
          this.stepFrame(dir);
        }
        return;
      }
      this._vidZoomTo(this._vid.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX, e.clientY);
    }
    _vidDown(e) {
      // touch swipe steps frames at 1× when frame-step is on (doesn't fight pan-at-zoom)
      if (this._frameStepOn() && e.pointerType === 'touch' && this._vid.scale === 1) {
        this._frameStep.swipe = { x: e.clientX };
        return;
      }
      if (this._vid.scale <= 1) return;            // let the controls bar receive clicks at 1×
      this._vidDrag = { x: e.clientX, y: e.clientY, moved: false };
      this._applyVidTransform();
    }
    _vidMove(e) {
      const sw = this._frameStep.swipe;
      if (sw) {
        // ~40px of horizontal travel = one frame; swipe left advances (matches
        // dragging the timeline forward). Consume distance as whole frames.
        const PX = 40;
        let dx = e.clientX - sw.x;
        while (Math.abs(dx) >= PX) {
          const dir = dx < 0 ? 1 : -1;            // swipe left (dx<0) → forward
          this.stepFrame(dir);
          dx -= (dx < 0 ? -PX : PX);
          sw.x = e.clientX - dx;
        }
        return;
      }
      if (!this._vidDrag) return;
      const dx = e.clientX - this._vidDrag.x, dy = e.clientY - this._vidDrag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) this._vidDrag.moved = true;
      this._vid.tx += dx; this._vid.ty += dy;
      this._vidDrag.x = e.clientX; this._vidDrag.y = e.clientY;
      this._applyVidTransform();
    }
    _vidUp() { this._vidDrag = null; this._frameStep.swipe = null; this._applyVidTransform(); }

    // ---- popovers ----
    _togglePop(menu) {
      const open = menu.hidden;
      this._closePops();
      if (open) menu.hidden = false;
    }
    _closePops() {
      if (this._speedMenu) this._speedMenu.hidden = true;
      if (this._adjustMenu) this._adjustMenu.hidden = true;
    }

    _key(e) {
      const zoomable = this._img.el || this._vid.el;
      switch (e.key) {
        case 'Escape':
          if (!this._speedMenu.hidden || !this._adjustMenu.hidden) { e.preventDefault(); this._closePops(); break; }
          if (this.isFullscreen()) break;  // let the browser exit fullscreen; don't also close
          if (this.hasAttribute('modal')) { e.preventDefault(); this.close(); } break;
        case 'ArrowLeft': if (this._items.length > 1) { e.preventDefault(); this.prev(); } break;
        case 'ArrowRight': if (this._items.length > 1) { e.preventDefault(); this.next(); } break;
        case '+': case '=': if (zoomable) { e.preventDefault(); this.zoomIn(); } break;
        case '-': case '_': if (zoomable) { e.preventDefault(); this.zoomOut(); } break;
        case '0': if (zoomable) { e.preventDefault(); this.zoomToFit(); } break;
        case '1': if (zoomable) { e.preventDefault(); this.zoomActual(); } break;
        case 'r': case 'R': if (this._img.el) { e.preventDefault(); this.rotate(); } break;
        case '<': if (this._vid.el) { e.preventDefault(); this._stepSpeed(-1); } break;
        case '>': if (this._vid.el) { e.preventDefault(); this._stepSpeed(1); } break;
        case ',': if (this._frameStepOn()) { e.preventDefault(); this.stepFrame(-1); } break;
        case '.': if (this._frameStepOn()) { e.preventDefault(); this.stepFrame(1); } break;
        case 'f': case 'F': e.preventDefault(); this.toggleFullscreen(); break;
      }
    }
    _stepSpeed(dir) {
      const rates = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 4];
      let i = rates.indexOf(this._speed);
      if (i < 0) i = rates.indexOf(1);
      this.setSpeed(rates[Vc.clamp(i + dir, 0, rates.length - 1)]);
    }
    // In modal mode the lightbox owns the page, so bind keys at document level
    // (the frame may not hold focus). Inline mode only reacts when focused.
    _bindModalKeys() {
      if (this._modalKeyBound) return;
      this._modalKeyBound = true;
      this._docKey = (e) => this._key(e);
      document.addEventListener('keydown', this._docKey);
    }
    _unbindModalKeys() {
      if (!this._modalKeyBound) return;
      this._modalKeyBound = false;
      document.removeEventListener('keydown', this._docKey);
    }
  }

  Vc.define('vc-media-viewer', VcMediaViewer);
})();
