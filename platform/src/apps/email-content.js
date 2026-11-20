// Deterministic email-content extraction — HTML → compact markdown-ish text.
// No AI, no browser. Shared by the engine (fills the missing text part at
// ingest so FULLTEXT/embeddings can see HTML-only mail), platform-horst
// (email_get tool) and horst-triage (fact mining).
//
// html-to-text is a direct dependency (also used by mailparser); lazy-load so
// a broken install degrades to the regex fallback instead of failing init.
let _htmlConvert;
function getHtmlConvert() {
  if (_htmlConvert === undefined) {
    try { _htmlConvert = require('html-to-text').convert; } catch { _htmlConvert = null; }
  }
  return _htmlConvert;
}

// Markdown headings and [text](url) links, real tables aligned, images and
// hidden preheader divs dropped, monster tracking URLs reduced to their origin.
function htmlToMarkdownish(html) {
  const convert = getHtmlConvert();
  let text = '';
  if (convert) {
    try {
      text = convert(String(html), {
        wordwrap: false,
        formatters: {
          mdAnchor: (elem, walk, builder) => {
            let href = String(elem.attribs?.href || '').trim();
            if (/^(javascript|data|cid):/i.test(href)) href = '';
            // Tracking URLs run to hundreds of chars; the link text carries
            // the meaning, so keep only the origin as a hint.
            if (href.length > 120) {
              try { href = new URL(href).origin + '/…'; } catch { href = ''; }
            }
            if (!href) { walk(elem.children, builder); return; }
            builder.addInline('[');
            walk(elem.children, builder);
            builder.addInline(`](${href})`);
          },
          mdHeading: (elem, walk, builder) => {
            const level = Math.min(Number(elem.name?.[1]) || 2, 6);
            builder.openBlock({ leadingLineBreaks: 2 });
            builder.addInline('#'.repeat(level) + ' ');
            walk(elem.children, builder);
            builder.closeBlock({ trailingLineBreaks: 2 });
          },
        },
        selectors: [
          { selector: 'img', format: 'skip' },
          { selector: '[style*="display:none"]', format: 'skip' },
          { selector: '[style*="display: none"]', format: 'skip' },
          { selector: 'a', format: 'mdAnchor' },
          ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((h) => ({ selector: h, format: 'mdHeading' })),
          // dataTable also copes with nested marketing layout tables (single-
          // cell wrappers pass content through; real grids come out aligned).
          // maxColumnWidth must exceed typical prose width or layout-table
          // cells hard-wrap at 60 chars and break [text](url) links mid-line.
          { selector: 'table', format: 'dataTable', options: { maxColumnWidth: 500 } },
        ],
      });
    } catch { text = ''; }
  }
  if (!text) {
    // Fallback: naive tag strip — a parser hiccup must never blank the email.
    text = String(html)
      .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  }
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Best readable body for a synced email: the text/plain part when substantial,
// else the HTML part converted. Marketing mail often ships an empty or stub
// plain part next to the real HTML — don't let the stub win.
function bestEmailBody(m) {
  const plain = String(m.body || '').trim();
  const html = String(m.htmlBody || '').trim();
  if (!html) return plain || String(m.snippet || '');
  if (plain.length >= 200) return plain;
  const md = htmlToMarkdownish(html);
  // A short plain part in the same ballpark as the converted HTML is a full
  // mirror of a short email — keep it. Far smaller means stub ("view in
  // browser") — the HTML is the real content.
  if (plain && plain.length >= md.length / 3) return plain;
  return md.length > plain.length ? md : (plain || String(m.snippet || ''));
}

// Quoted-trail rendering. Same converter, opposite priority: htmlToMarkdownish
// optimises for LEGIBILITY (drops images, shortens tracking URLs to their
// origin, emits markdown headings) because something downstream has to read it.
// A quote is evidence — what the correspondent actually sent — so links stay
// whole, images leave their alt text behind, and no markdown is invented.
function htmlToPlainQuote(html) {
  const convert = getHtmlConvert();
  let text = '';
  if (convert) {
    try {
      text = convert(String(html), {
        wordwrap: false,
        selectors: [
          { selector: '[style*="display:none"]', format: 'skip' },
          { selector: '[style*="display: none"]', format: 'skip' },
          { selector: 'table', format: 'dataTable', options: { maxColumnWidth: 500 } },
        ],
      });
    } catch { text = ''; }
  }
  // A converter hiccup must not blank the trail — fall back to the legible
  // rendering rather than to nothing.
  if (!text) text = htmlToMarkdownish(html);
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { htmlToMarkdownish, htmlToPlainQuote, bestEmailBody };
