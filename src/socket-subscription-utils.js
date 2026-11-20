export function getSocketSubscriptionDelta(currentSymbols = [], desiredSymbols = []) {
  const current = [...new Set((Array.isArray(currentSymbols) ? currentSymbols : []).filter(symbol => typeof symbol === 'string' && symbol))];
  const desired = [...new Set((Array.isArray(desiredSymbols) ? desiredSymbols : []).filter(symbol => typeof symbol === 'string' && symbol))];
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  return {
    removed: current.filter(symbol => !desiredSet.has(symbol)),
    added: desired.filter(symbol => !currentSet.has(symbol))
  };
}

export function splitSubscriptionBatches(symbols = [], batchSize = 4) {
  const size = Math.max(1, Math.floor(Number(batchSize) || 4));
  const unique = [...new Set((Array.isArray(symbols) ? symbols : []).filter(symbol => typeof symbol === 'string' && symbol))];
  const batches = [];
  for (let i = 0; i < unique.length; i += size) batches.push(unique.slice(i, i + size));
  return batches;
}

export function buildDesiredSocketSubscriptions(indexSymbols = [], activeSymbols = [], selectedOptionSymbol = null) {
  const indices = Array.isArray(indexSymbols) ? indexSymbols : [...(indexSymbols || [])];
  const active = Array.isArray(activeSymbols) ? activeSymbols : [];
  const option = typeof selectedOptionSymbol === 'string' && selectedOptionSymbol ? [selectedOptionSymbol] : [];
  return [...new Set([...indices, ...active, ...option].filter(symbol => typeof symbol === 'string' && symbol))];
}
