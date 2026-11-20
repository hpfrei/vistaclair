// Renders the card descriptor built by src/apps/horst-cards.js.
//
// Loaded by BOTH the Horst page and the Telegram Mini App, so it is a plain
// window global with no imports and no framework — the Horst page is an IIFE
// with no module system, and the Mini App must not pull in vc-core.
//
// NOT named vc-cards.js on purpose: index.js's bundler regex
// /^\/pro\/(vc(?:-[a-z-]+)?)\.js$/ claims every /pro/vc-*.js request and would
// prepend vc-core.js — precisely the dependency the Mini App must not have.
// This name falls through to express.static instead.
//
// Escaping is load-bearing here. The mail body path unescapes entities
// (email-content.js's regex fallback), and DOMPurify is effectively absent on
// the Horst page — public/purify.min.js is a 3-line stub. Every descriptor
// value goes through escHtml at render, without exception.
(function () {
  'use strict';

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Line-aware body: quoted lines and separators dim, like a mail client,
  // instead of one flat \n-soup block.
  function renderBody(text) {
    return String(text || '').split('\n').map(function (line) {
      var esc = escHtml(line) || '&nbsp;';
      if (/^\s*>/.test(line)) return '<div class="mail-quote">' + esc + '</div>';
      if (/^-{4,}.*-{4,}\s*$/.test(line.trim()) || /^_{10,}\s*$/.test(line.trim())) return '<div class="mail-sep">' + esc + '</div>';
      return '<div>' + esc + '</div>';
    }).join('');
  }

  function renderField(f) {
    var label = '<span class="mail-label">' + escHtml(f.label) + '</span>';
    if (f.kind === 'longtext' || f.kind === 'code') {
      var cls = f.kind === 'code' ? 'mail-body code' : 'mail-body';
      var more = (f.chars && f.chars > f.value.length)
        ? '<div class="mail-ref">… ' + escHtml(String(f.chars - f.value.length)) + ' more characters</div>'
        : '';
      return '<div class="card-block">' + label + '<div class="' + cls + '">' + renderBody(f.value) + '</div>' + more + '</div>';
    }
    if (f.kind === 'chips' || f.kind === 'address') {
      var chips = f.value.map(function (v) {
        return '<span class="att-chip">' + escHtml(v) + '</span>';
      }).join('');
      return '<div class="mail-row">' + label + '<span class="mail-val">' + chips + '</span></div>';
    }
    if (f.kind === 'bool') {
      return '<div class="mail-row">' + label + '<span class="mail-val">' + (f.value ? 'Yes' : 'No') + '</span></div>';
    }
    // text and when render alike; `when` simply carries an iso twin for
    // surfaces that offer "show me that day".
    var attr = (f.kind === 'when' && f.iso && f.iso.date)
      ? ' data-date="' + escHtml(f.iso.date) + '"' + (f.iso.startTime ? ' data-time="' + escHtml(f.iso.startTime) + '"' : '')
      : '';
    return '<div class="mail-row"' + attr + '>' + label + '<span class="mail-val">' + escHtml(f.value) + '</span></div>';
  }

  // Emits the class names the Horst stylesheet already defines, so a kind that
  // used to render as raw JSON now looks like the rest of the queue, and the
  // Mini App can ship a small stylesheet for the same names.
  function renderDescriptorCard(card) {
    if (!card) return '';
    var accent = card.accent ? ' ' + escHtml(card.accent) : '';
    return '<div class="mail-card card-' + escHtml(card.render) + accent + '">'
      + '<div class="mail-head">'
      + '<div class="mail-avatar">' + escHtml(card.icon) + '</div>'
      + '<div class="mail-meta">'
      + '<div class="mail-subject">' + escHtml(card.title) + '</div>'
      + (card.subtitle ? '<div class="mail-ref">' + escHtml(card.subtitle) + '</div>' : '')
      + '</div></div>'
      + card.fields.map(renderField).join('')
      + (card.warn ? '<div class="mail-ref warn">⚠ ' + escHtml(card.warn) + '</div>' : '')
      + (card.footer ? '<div class="mail-ref">' + escHtml(card.footer) + '</div>' : '')
      + '</div>';
  }

  // Compact one-liner for timeline rows, built from the same descriptor so a
  // row and its card can never describe different things.
  function summarizeCard(card) {
    if (!card) return '';
    var bits = card.fields
      .filter(function (f) { return f.kind !== 'longtext' && f.kind !== 'code'; })
      .slice(0, 2)
      .map(function (f) {
        return f.label + ': ' + (Array.isArray(f.value) ? f.value.join(', ') : String(f.value));
      });
    return [card.icon + ' ' + card.title].concat(bits).join(' · ');
  }

  // Compact card for a QUEUE — the third projection of the same descriptor,
  // beside the full card and the timeline one-liner.
  //
  // A pending-approvals list is a list of decisions to make, not of payloads to
  // read: rendering every field of every proposal inline meant two todo cards
  // filled a screen and the one question that matters ("what is this?") sat in
  // the middle of it. So: the title, at most three short facts, and one clamped
  // line of whatever prose the card carries. Everything else is one click away
  // in the full card.
  //
  // Generic by construction — it switches on FIELD KINDS, not on card.render —
  // so a calendar card yields When/Where/Guests, an email card To, a todo Due,
  // and a kind this file has never heard of yields its first three scalars
  // rather than nothing.
  var PREVIEW_FACTS = 3;
  var PREVIEW_CHARS = 200;

  function factValue(f) {
    if (f.kind === 'bool') return f.value ? 'Yes' : 'No';
    if (Array.isArray(f.value)) return f.value.join(', ');
    return String(f.value);
  }

  // opts.bare: facts and excerpt only — for a surface that already shows the
  // icon and the title in its own header (the Horst queue card). opts.chars
  // overrides the excerpt length for a surface with more room.
  function renderPreviewCard(card, opts) {
    if (!card) return '';
    var o = opts || {};
    var maxChars = o.chars || PREVIEW_CHARS;
    var facts = [];
    var excerpt = '';
    for (var i = 0; i < card.fields.length; i++) {
      var f = card.fields[i];
      if (f.kind === 'longtext' || f.kind === 'code') {
        if (!excerpt) excerpt = String(f.value || '').replace(/\s+/g, ' ').trim();
        continue;
      }
      if (facts.length < PREVIEW_FACTS) {
        facts.push('<span class="pc-fact"><b>' + escHtml(f.label) + '</b>' + escHtml(factValue(f)) + '</span>');
      }
    }
    if (excerpt.length > maxChars) excerpt = excerpt.slice(0, maxChars) + '…';
    return '<div class="pc-preview card-' + escHtml(card.render) + (card.accent ? ' ' + escHtml(card.accent) : '') + (o.bare ? ' bare' : '') + '">'
      + (o.bare ? '' : '<div class="pc-icon">' + escHtml(card.icon) + '</div>')
      + '<div class="pc-main">'
      + (o.bare ? '' : '<div class="pc-title">' + escHtml(card.title) + '</div>')
      + (card.subtitle ? '<div class="pc-sub">' + escHtml(card.subtitle) + '</div>' : '')
      + (facts.length ? '<div class="pc-facts">' + facts.join('') + '</div>' : '')
      + (excerpt ? '<div class="pc-excerpt">' + escHtml(excerpt) + '</div>' : '')
      // No `warn` here on purpose: "sent mail cannot be recalled" is a caution
      // about PRESSING the button, so it belongs next to the button, on the
      // full card — in a scan list it is noise on every row.
      + '</div></div>';
  }

  window.ProposalCards = {
    escHtml: escHtml,
    // Exported so a surface rendering a raw mail body (the proposal detail
    // view's "the email this came from") gets the same quote/separator
    // treatment as a card's longtext field, rather than a third copy of it.
    renderBody: renderBody,
    renderDescriptorCard: renderDescriptorCard,
    renderPreviewCard: renderPreviewCard,
    summarizeCard: summarizeCard,
  };
}());
