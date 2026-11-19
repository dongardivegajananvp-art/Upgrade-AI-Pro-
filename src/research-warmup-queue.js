// FIFO queue for verified multi-timeframe research warmups discovered by rolling slices.
// Pending symbols remain deduplicated while queued or in-flight, including across slice changes.
// Failed transient warmups use bounded exponential backoff; the scanner separately pauses on FYERS 429 cooldown.
export function createResearchWarmupQueue({ maxSize = 500, maxAttempts = 3, retryBaseMs = 5000, retryMaxMs = 60000 } = {}) {
  const capacity = Math.max(1, Math.floor(Number(maxSize) || 500));
  const retryLimit = Math.max(1, Math.floor(Number(maxAttempts) || 3));
  const baseDelay = Math.max(0, Number(retryBaseMs) || 0);
  const maxDelay = Math.max(baseDelay, Number(retryMaxMs) || baseDelay);
  const items = [];
  const pending = new Set();
  const inFlight = new Set();
  const attempts = new Map();
  const retryAt = new Map();

  return {
    enqueue(symbol) {
      if (typeof symbol !== 'string' || !symbol.trim() || pending.has(symbol)) return false;
      if (pending.size >= capacity) return false;
      items.push(symbol);
      pending.add(symbol);
      attempts.set(symbol, 0);
      return true;
    },
    take(now = Date.now()) {
      const count = items.length;
      for (let i = 0; i < count; i++) {
        const symbol = items.shift();
        if ((retryAt.get(symbol) || 0) <= now) {
          inFlight.add(symbol);
          return symbol;
        }
        items.push(symbol);
      }
      return null;
    },
    complete(symbol) {
      if (!inFlight.delete(symbol)) return false;
      pending.delete(symbol);
      attempts.delete(symbol);
      retryAt.delete(symbol);
      return true;
    },
    fail(symbol, now = Date.now()) {
      if (!inFlight.delete(symbol)) return { retry: false, attempt: 0, maxAttempts: retryLimit, retryAfterMs: 0 };
      const attempt = (attempts.get(symbol) || 0) + 1;
      attempts.set(symbol, attempt);
      if (attempt < retryLimit) {
        const retryAfterMs = Math.min(maxDelay, baseDelay * (2 ** (attempt - 1)));
        retryAt.set(symbol, now + retryAfterMs);
        items.push(symbol);
        return { retry: true, attempt, maxAttempts: retryLimit, retryAfterMs };
      }
      pending.delete(symbol);
      attempts.delete(symbol);
      retryAt.delete(symbol);
      return { retry: false, attempt, maxAttempts: retryLimit, retryAfterMs: 0 };
    },
    get size() { return pending.size; },
    has(symbol) { return pending.has(symbol); },
    snapshot() { return [...items]; },
    getRetryAt(symbol) { return retryAt.get(symbol) || null; }
  };
}
