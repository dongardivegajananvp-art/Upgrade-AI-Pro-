// FIFO queue for verified multi-timeframe research warmups discovered by rolling slices.
// Pending symbols remain deduplicated while queued or in-flight, including across slice changes.
export function createResearchWarmupQueue({ maxSize = 500 } = {}) {
  const capacity = Math.max(1, Math.floor(Number(maxSize) || 500));
  const items = [];
  const pending = new Set();
  const inFlight = new Set();

  return {
    enqueue(symbol) {
      if (typeof symbol !== 'string' || !symbol.trim() || pending.has(symbol)) return false;
      if (pending.size >= capacity) return false;
      items.push(symbol);
      pending.add(symbol);
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
      return true;
    },
    get size() { return pending.size; },
    has(symbol) { return pending.has(symbol); },
    snapshot() { return [...items]; }
  };
}
