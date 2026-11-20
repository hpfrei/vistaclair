// One sanitiser for MySQL/MariaDB FULLTEXT boolean-mode search terms.
//
// Both engines pass the caller's raw string straight into
// `AGAINST(? IN BOOLEAN MODE)` — email-engine's `listEmails` and
// calendar-engine's `listEvents`. The value is parameter-bound, so this was
// never SQL injection; what it was is OPERATOR injection plus a denial of
// service by syntax error. `+foo -bar` silently changes the caller's meaning,
// `*` alone or an unbalanced `"` makes the server raise
// "syntax error in boolean full-text search expression", and that error reached
// the user as a 500 from a perfectly ordinary search box.
//
// Default is literal: every operator character is stripped and each surviving
// word is required, which is what a search box means by typing two words. A
// caller that genuinely wants the operator language asks for it explicitly with
// `{ operators: true }`, and then only gets a balanced, length-capped string.
//
// Leaf module by design — requires nothing, so both engines can use it without
// either owning it.

// Every character MySQL treats as a boolean-mode operator, plus the quote.
const OPERATORS = /[+\-><()~*"@]/g;

// Boolean mode ignores words shorter than ft_min_word_len (4 by default on
// MyISAM, 3 on InnoDB). We do not enforce that — a too-short word simply
// matches nothing — but we do drop empty tokens so `a  b` cannot produce `++`.
const MAX_TERMS = 32;
const MAX_LENGTH = 512;

function sanitize(input, { operators = false } = {}) {
  if (input == null) return '';
  let s = String(input).slice(0, MAX_LENGTH);

  if (operators) {
    // Trusted-ish path: keep the language but make it parseable. Unbalanced
    // quotes and parens are what actually throw, so balance them and drop a
    // bare `*`, which is a syntax error rather than a wildcard on its own.
    const quotes = (s.match(/"/g) || []).length;
    if (quotes % 2) s = s.replace(/"([^"]*)$/, '$1');
    let depth = 0;
    s = s.split('').filter((ch) => {
      if (ch === '(') { depth++; return true; }
      if (ch === ')') { if (depth === 0) return false; depth--; return true; }
      return true;
    }).join('');
    if (depth > 0) s += ')'.repeat(depth);
    s = s.replace(/(^|\s)\*+(\s|$)/g, '$1$2');
    return s.replace(/\s+/g, ' ').trim();
  }

  // Literal path: strip the operator alphabet, then require each word. A
  // trailing `*` on a term is the one wildcard a search box plausibly means,
  // but honouring it here would make `strip then require` inconsistent, so it
  // goes with the rest — a caller wanting prefix search passes `operators`.
  const terms = s
    .replace(OPERATORS, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_TERMS);
  if (!terms.length) return '';
  return terms.map((t) => `+${t}`).join(' ');
}

module.exports = { sanitize, OPERATORS, MAX_TERMS, MAX_LENGTH };
