// Wait for a condition instead of sleeping a fixed time. The store writes with
// un-awaitable fs.writeFile calls, so a test polls the disk until the state it
// expects is there. The timeout is generous: a full parallel `npm test` can
// starve a write for seconds, and a passing run returns after the first poll.

const fs = require('fs');

async function waitFor(read, { timeoutMs = 10000, intervalMs = 10, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = read();
      if (value) return value;
      last = 'not met yet';
    } catch (err) {
      last = err.message;
    }
    if (Date.now() >= deadline) throw new Error(`${what} not met within ${timeoutMs} ms (${last})`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

/** Parsed JSON of `file` once it exists, parses (a half-written file does not) and passes `ready`. */
function readJsonWhenReady(file, ready = () => true, opts = {}) {
  return waitFor(() => {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return ready(json) ? json : null;
  }, { what: file, ...opts });
}

module.exports = { waitFor, readJsonWhenReady };
