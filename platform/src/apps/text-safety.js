// Characters a reader cannot see — the one checker for text the owner
// approves word for word (a remote session's prompt and title): refused by
// peer.session.launch's validate and the slave's launch, shown as ⟨U+XXXX⟩ by
// a verbatim card field (governance/horst-cards.js).
//
// The set: Unicode format characters (Cf: zero-width, BOM, bidi controls
// U+202A–202E / U+2066–2069…), tag characters U+E0000–E007F, control
// characters but \n and \t, the variation-selector supplement U+E0100–E01EF,
// and a run of two or more variation selectors U+FE00–FE0F. One selector after
// a base character (❤️ = U+2764 U+FE0F) is ordinary emoji and stays.
//
// No requires: horst-cards loads it, and that file stays dependency-free.

const SINGLE = /(?![\n\t])[\p{Cc}\p{Cf}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]|[︀-️]{2,}/gu;

// → the code points of every invisible character in `str`, in order.
function invisibleChars(str) {
  const out = [];
  for (const m of String(str ?? '').matchAll(SINGLE)) {
    for (const c of m[0]) out.push(c.codePointAt(0));
  }
  return out;
}

const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

// `str` with every invisible character written out as ⟨U+XXXX⟩.
function showInvisible(str) {
  return String(str ?? '').replace(SINGLE, (m) => [...m].map((c) => `⟨${hex(c.codePointAt(0))}⟩`).join(''));
}

module.exports = { invisibleChars, showInvisible, codePointLabel: hex };
