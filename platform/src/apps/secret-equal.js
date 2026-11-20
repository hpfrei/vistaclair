// Constant-time comparison of a presented secret with the stored one. Both are
// hashed first so the compare runs over equal-length buffers and the length of
// the stored secret does not leak. Non-strings (an absent header, a repeated
// header arriving as an array) and an empty stored secret never match.
const crypto = require('crypto');

const digest = (s) => crypto.createHash('sha256').update(s).digest();

function secretEqual(presented, stored) {
  if (typeof presented !== 'string' || typeof stored !== 'string' || !stored) return false;
  return crypto.timingSafeEqual(digest(presented), digest(stored));
}

module.exports = { secretEqual };
