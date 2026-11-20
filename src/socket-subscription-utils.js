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
