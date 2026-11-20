// The boolean-mode sanitiser both engines share.
//
// `AGAINST(? IN BOOLEAN MODE)` is parameter-bound, so the bug here was never
// SQL injection. It was two quieter things: a caller's `-` or `+` silently
// rewrote the meaning of their own search, and an unbalanced quote or a bare
// `*` made the server raise "syntax error in boolean full-text search
// expression" — a 500 out of an ordinary search box.
const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitize, MAX_TERMS } = require('../src/apps/fulltext-query');

test('plain words become required terms', () => {
  assert.equal(sanitize('quarterly numbers'), '+quarterly +numbers');
  assert.equal(sanitize('  spaced   out  '), '+spaced +out');
});

test('operator characters cannot change the caller"s meaning', () => {
  // The reported case: a leading minus turned a search INTO an exclusion.
  assert.equal(sanitize('-invoice'), '+invoice');
  assert.equal(sanitize('invoice -paid'), '+invoice +paid');
  assert.equal(sanitize('+must ~maybe >up <down'), '+must +maybe +up +down');
  // `@` is an operator (distance search), so an address splits into its parts
  // and both are required — which still finds the mail.
  assert.equal(sanitize('a@b.test'), '+a +b.test');
});

test('the inputs that throw today are neutralised', () => {
  // Each of these raises a syntax error if passed through untouched.
  assert.equal(sanitize('*'), '');
  assert.equal(sanitize('"unbalanced'), '+unbalanced');
  assert.equal(sanitize('((('), '');
  assert.equal(sanitize('+'), '');
  assert.equal(sanitize('@'), '');
});

test('an empty or absent search yields an empty string, not a clause', () => {
  for (const v of [null, undefined, '', '   ', '***']) {
    assert.equal(sanitize(v), '', `${JSON.stringify(v)} should produce no term`);
  }
});

test('terms and length are capped, so a pasted document cannot become a query', () => {
  const many = Array.from({ length: MAX_TERMS + 20 }, (_, i) => `w${i}`).join(' ');
  assert.equal(sanitize(many).split(' ').length, MAX_TERMS);
  assert.ok(sanitize('x'.repeat(5000)).length <= 600);
});

test('operators: true keeps the language but balances it', () => {
  assert.equal(sanitize('+urgent -spam', { operators: true }), '+urgent -spam');
  assert.equal(sanitize('"exact phrase"', { operators: true }), '"exact phrase"');
  // Unbalanced quote: the dangling fragment survives, the quote does not.
  assert.equal(sanitize('"dangling', { operators: true }), 'dangling');
  // Unbalanced parens are closed rather than thrown on.
  assert.equal(sanitize('(a b', { operators: true }), '(a b)');
  assert.equal(sanitize('a b)', { operators: true }), 'a b');
  // A bare asterisk is a syntax error, not a wildcard.
  assert.equal(sanitize('a * b', { operators: true }), 'a b');
});

test('prefix wildcards survive only on the explicit path', () => {
  assert.equal(sanitize('invoic*'), '+invoic');
  assert.equal(sanitize('invoic*', { operators: true }), 'invoic*');
});

// The property that matters for both engines: whatever comes out is something
// boolean mode can parse. Quotes balanced, parens balanced, never bare-operator.
test('output is always parseable: balanced quotes and parens, no lone operator', () => {
  const nasty = [
    '"', '""', '"""', '(', ')', '()', '(()', '*', '**', '+-', '~', '<>', '@@',
    'a "b (c', 'x))) y', '-"unclosed (', '+++', 'foo" bar) baz(',
  ];
  for (const input of nasty) {
    for (const operators of [false, true]) {
      const out = sanitize(input, { operators });
      assert.equal((out.match(/"/g) || []).length % 2, 0, `unbalanced quotes from ${JSON.stringify(input)} (operators=${operators})`);
      let depth = 0;
      for (const ch of out) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        assert.ok(depth >= 0, `parens close before opening from ${JSON.stringify(input)}`);
      }
      assert.equal(depth, 0, `unbalanced parens from ${JSON.stringify(input)} (operators=${operators})`);
      assert.doesNotMatch(out, /(^|\s)\*+(\s|$)/, `bare asterisk from ${JSON.stringify(input)}`);
    }
  }
});
