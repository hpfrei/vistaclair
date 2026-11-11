// Source line numbers for the rendered markdown preview (core.js
// openFilePreview). marked's lexer splits a document into top-level tokens whose
// `.raw` strings add up to the whole text, so the newlines in the tokens before
// one give the line it starts on.
//
//   mdBlocks(text, marked) -> [{ token, line }]   one per non-space top-level token
//   mdBlockLines(text, marked) -> [line, ...]     1-based start lines of those
//
// `marked` is the page's global in the browser; node tests pass the vendored one.
(function (root) {
  function getMarked(m) {
    const lib = m || (typeof marked !== 'undefined' ? marked : null);
    if (!lib || typeof lib.lexer !== 'function') throw new Error('marked is not available');
    return lib;
  }

  function mdBlocks(text, m) {
    const tokens = getMarked(m).lexer(String(text ?? ''));
    const blocks = [];
    let line = 1;
    for (const token of tokens) {
      if (token.type !== 'space') blocks.push({ token, line });
      // marked turns CRLF and lone CR into LF before lexing, so raw has LFs only.
      line += (token.raw.match(/\n/g) || []).length;
    }
    return blocks;
  }

  function mdBlockLines(text, m) {
    return mdBlocks(text, m).map(b => b.line);
  }

  const api = { mdBlocks, mdBlockLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.mdLines = api;
})(typeof window !== 'undefined' ? window : globalThis);
