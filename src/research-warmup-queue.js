// FIFO queue for verified multi-timeframe research warmups discovered by rolling slices.
// Pending symbols remain deduplicated while queued or in-flight, including across slice changes.
export function createResearchWarmupQueue({ maxSize = 500, maxAttempts = 3 } = {}) {
  const capacity = Math.max(1, Math.floor(Number(maxSize) || 500));
  const retryLimit = Math.max(1, Math.floor(Number(maxAttempts) || 3));
  const items = [];
  const pending = new Set();
  const inFlight = new Set();
  const attempts = new Map();

  return {
    enqueue(symbol) {
      if (typeof symbol !== 'string' || !symbol.trim() || pending.has(symbol)) return false;
      if (pending.size >= capacity) return false;
      items.push(symbol);
      pending.add(symbol);
      attempts.set(symbol, 0);
      return true;
    },
    take() {
      const symbol = items.shift() || null;
      if (symbol) inFlight.add(symbol);
      return symbol;
    },
    complete(symbol) {
      if (!inFlight.delete(symbol)) return false;
      pending.delete(symbol);
      attempts.delete(symbol);
      return true;
    },
    fail(symbol) {
      if (!inFlight.delete(symbol)) return { retry: false, attempt: 0, maxAttempts: retryLimit };
      const attempt = (attempts.get(symbol) || 0) + 1;
      attempts.set(symbol, attempt);
      if (attempt < retryLimit) {
        items.push(symbol);
        return { retry: true, attempt, maxAttempts: retryLimit };
      }
      pending.delete(symbol);
      attempts.delete(symbol);
      return { retry: false, attempt, maxAttempts: retryLimit };
    },
    get size() { return pending.size; },
    has(symbol) { return pending.has(symbol); },
    snapshot() { return [...items]; }
  };
}
