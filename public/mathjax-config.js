// MathJax reads this global when tex-mml-chtml.js loads, so this file comes
// first in index.html. A file, not an inline <script>: CSP script-src 'self'.
window.MathJax = {
  tex: { inlineMath: [['$', '$'], ['\\(', '\\)']], displayMath: [['$$', '$$'], ['\\[', '\\]']] },
  startup: { typeset: false }
};
