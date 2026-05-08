/**
 * retry.js
 * Exponential backoff for transient LLM errors.
 */

const RETRYABLE_PATTERNS = [
  /timeout/i,
  /rate.?limit/i,
  /5\d\d/,
  /aborted/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /overloaded/i,
];

async function withRetry(fn, { maxAttempts = 3, baseMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err && err.message ? err.message : String(err);
      const retryable = RETRYABLE_PATTERNS.some((re) => re.test(msg));
      if (!retryable || i === maxAttempts - 1) throw err;
      const delay = baseMs * 2 ** i + Math.random() * 200;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
