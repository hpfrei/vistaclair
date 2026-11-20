// <vc-stage-graph> — a multi-step job as plan → progress → receipt in ONE drawing:
// which steps will run, which are skipped and why, which is active, which are
// done or failed. Part of the vistaclair-pro `vc-*` component system. Shadow-DOM,
// theme-aware, built on vc-core (`Vc.Element`).
//
// Why it exists: apps driving ctx.jobs with named steps all hand-roll this strip
// (a platform gap that was closed here). A plain progress bar answers "how far", but not "what
// was planned, what was deliberately not done, and where are we in the plan".
//
// Usage — explicit steps (attribute takes JSON; property takes the array):
//   <vc-stage-graph steps='[
//     {"name":"Fetch","status":"done"},
//     {"name":"Tiles","status":"skipped","note":"cached from last run"},
//     {"name":"Render","status":"active"},
//     {"name":"Publish","status":"pending"}
//   ]'></vc-stage-graph>
//   el.steps = [...];                    // same, from JS
//
// Usage — driven by a job's progress label (the app-jobs "n/m Step name"
// convention: handle.setProgress(pct, `${i}/${total} ${stepName}`)):
//   <vc-stage-graph steps='[...]' progress-label="3/7 Render tiles"></vc-stage-graph>
//   el.progressLabel = job.progress.label;   // per jobs.get poll / event
//   // Steps NOT declared? The n/m in the label synthesizes m placeholder
//   // steps and names the active one from the label tail.
//   // n counts RUNNABLE steps only — skipped steps stay skipped (a skipped
//   // step never turns "done": painting it green would claim the run did
//   // work it deliberately did not do — see the vr-moritz reference).
//
// Attributes (reactive):
//   steps          — JSON array of {name, status?, note?};
//                    status ∈ pending|active|done|skipped|failed (default pending)
//   progress-label — "n/m Step name" ("n/m — Step name" and "n/m: x" also parse);
//                    derives done/active/pending across the runnable steps
//   done           — boolean: the receipt state; marks every runnable,
//                    non-failed step done (label convention has no "finished")
// Properties: steps (array), progressLabel, done. Notes render under the step
// name and in the tooltip — that is where "why was this skipped" lives.

(function () {
  'use strict';

  const TEMPLATE = `
    <style>
      :host { display: block; }
      .vc-wrap {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        row-gap: 6px;
      }
      .vc-node {
        display: inline-flex;
        flex-direction: column;
        gap: 1px;
        padding: 4px 9px;
        border: 1px solid var(--border, #414868);
        border-radius: 6px;
        background: var(--bg-surface, #24283b);
        max-width: 180px;
      }
      .vc-top { display: inline-flex; align-items: center; gap: 6px; }
      .vc-mark { font-size: 11px; color: var(--text-dim, #565f89); flex: none; }
      .vc-name {
        font-size: 11.5px;
        color: var(--text, #c0caf5);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .vc-note {
        font-size: 10px;
        color: var(--text-dim, #565f89);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .vc-note:empty { display: none; }
      /* the connector: past (walked) turns green like a receipt line */
      .vc-link {
        flex: none;
        width: 14px;
        height: 1px;
        margin-top: 12px;
        background: var(--border, #414868);
        position: relative;
      }
      .vc-link::after {
        content: '';
        position: absolute;
        right: 0; top: -2.5px;
        border: 3px solid transparent;
        border-right: none;
        border-left: 4px solid var(--border, #414868);
      }
      .vc-link.past { background: var(--green, #9ece6a); }
      .vc-link.past::after { border-left-color: var(--green, #9ece6a); }
      /* states */
      .vc-node.st-done { border-color: var(--green, #9ece6a); }
      .vc-node.st-done .vc-mark { color: var(--green, #9ece6a); }
      .vc-node.st-active { border-color: var(--accent, #7aa2f7); }
      .vc-node.st-active .vc-mark { color: var(--accent, #7aa2f7); }
      .vc-node.st-active .vc-name { font-weight: 600; }
      .vc-node.st-failed { border-color: var(--red, #f7768e); }
      .vc-node.st-failed .vc-mark, .vc-node.st-failed .vc-name { color: var(--red, #f7768e); }
      /* dashed outline says "this run does not enter here" (vr-moritz precedent) */
      .vc-node.st-skipped { border-style: dashed; opacity: .75; }
      .vc-node.st-skipped .vc-name { color: var(--text-dim, #565f89); }
    </style>
    <div class="vc-wrap" part="graph" role="list"></div>
  `;

  const STATUSES = ['pending', 'active', 'done', 'skipped', 'failed'];
  const MARKS = { pending: '○', active: '▸', done: '✓', skipped: '⊘', failed: '✕' };

  // "3/7 Render tiles" | "3/7 — Render tiles" | "3/7: x" → {n, total, name}
  function parseProgressLabel(label) {
    const m = /^\s*(\d+)\s*\/\s*(\d+)\s*(?:[—–:-]\s*)?(.*)$/.exec(String(label == null ? '' : label));
    if (!m) return null;
    const n = Number(m[1]), total = Number(m[2]);
    if (!n || !total) return null;
    return { n, total, name: m[3].trim() };
  }

  class VcStageGraph extends Vc.Element {
    static get template() { return TEMPLATE; }
    static get observedAttributes() { return ['steps', 'progress-label', 'done']; }

    constructor() {
      super();
      this._wrap = this.$('.vc-wrap');
      this._steps = null; // property-set array (wins over the attribute)
    }

    connectedCallback() { this._render(); }
    attributeChangedCallback(name) {
      if (!this._wrap) return;
      if (name === 'steps') this._steps = null; // attribute write re-arms JSON parsing
      this._render();
    }

    // Declared steps: property if set, else the JSON attribute. Always a fresh
    // normalized copy — deriving statuses never mutates the caller's array.
    _declaredSteps() {
      let src = this._steps;
      if (!src) {
        const raw = this.getAttribute('steps');
        if (raw) { try { src = JSON.parse(raw); } catch { src = null; } }
      }
      if (!Array.isArray(src)) return [];
      return src
        .filter((s) => s && typeof s === 'object' && s.name != null)
        .map((s) => ({
          name: String(s.name),
          status: STATUSES.includes(s.status) ? s.status : 'pending',
          note: s.note == null ? '' : String(s.note),
        }));
    }

    // The one drawing = declared plan ⊕ label-derived position ⊕ done receipt.
    _effectiveSteps() {
      let steps = this._declaredSteps();
      const prog = parseProgressLabel(this.getAttribute('progress-label'));

      if (!steps.length && prog) {
        // No declared plan — synthesize one from the label's n/m.
        steps = [];
        for (let i = 1; i <= prog.total; i++) {
          steps.push({
            name: i === prog.n && prog.name ? prog.name : 'Step ' + i,
            status: i < prog.n ? 'done' : i === prog.n ? 'active' : 'pending',
            note: '',
          });
        }
      } else if (steps.length && prog) {
        // n/m counts runnable (non-skipped) steps; failures stay failed.
        const runnable = steps.filter((s) => s.status !== 'skipped');
        let idx = -1; // index into `runnable` of the active step
        if (prog.name) {
          const needle = prog.name.toLowerCase();
          idx = runnable.findIndex((s) => s.name.toLowerCase() === needle);
        }
        if (idx < 0 && prog.n >= 1 && prog.n <= runnable.length) idx = prog.n - 1;
        if (idx >= 0) {
          runnable.forEach((s, i) => {
            if (s.status === 'failed') return;
            s.status = i < idx ? 'done' : i === idx ? 'active' : 'pending';
          });
        }
      }

      if (this.hasAttribute('done')) {
        for (const s of steps) {
          if (s.status !== 'skipped' && s.status !== 'failed') s.status = 'done';
        }
      }
      return steps;
    }

    _render() {
      const steps = this._effectiveSteps();
      if (!steps.length) { this._wrap.innerHTML = ''; return; }

      // A connector is "walked" while every step before it is settled
      // (done or deliberately skipped) — the receipt line stops at the front.
      // A pure plan (nothing run yet) draws no walked line at all.
      let front = steps.length;
      for (let i = 0; i < steps.length; i++) {
        if (steps[i].status !== 'done' && steps[i].status !== 'skipped') { front = i; break; }
      }
      if (!steps.some((s) => s.status === 'done' || s.status === 'active' || s.status === 'failed')) front = 0;

      const parts = [];
      steps.forEach((s, i) => {
        if (i > 0) parts.push('<span class="vc-link' + (i <= front ? ' past' : '') + '"></span>');
        const title = s.note ? s.name + ' — ' + s.note : s.name;
        parts.push(Vc.html`<span class="vc-node st-${s.status}" part="node" role="listitem"
          title="${title}"${Vc.html.raw(s.status === 'active' ? ' aria-current="step"' : '')}>
          <span class="vc-top"><span class="vc-mark">${MARKS[s.status] || MARKS.pending}</span><span class="vc-name">${s.name}</span></span>
          <span class="vc-note">${s.note}</span>
        </span>`);
      });
      this._wrap.innerHTML = parts.join('');
    }

    get steps() { return this._effectiveSteps(); }
    set steps(v) {
      this._steps = Array.isArray(v) ? v : null;
      if (!this._steps) this.removeAttribute('steps');
      this._render();
    }

    get progressLabel() { return this.getAttribute('progress-label') || ''; }
    set progressLabel(v) { this.reflectAttr('progress-label', v); }

    get done() { return this.hasAttribute('done'); }
    set done(v) { this.reflectBool('done', !!v); }
  }

  Vc.define('vc-stage-graph', VcStageGraph);
})();
