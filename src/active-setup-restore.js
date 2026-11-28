export function planActiveSetupRestore({
  currentSetups = [],
  incomingSetups = [],
  normalizeSetup,
  maxActiveSetups = 2
} = {}) {
  if (!Array.isArray(incomingSetups) || incomingSetups.length > maxActiveSetups) {
    return { ok:false, reason:'At most two verified active setups may be restored' };
  }
  if (typeof normalizeSetup !== 'function') {
    return { ok:false, reason:'Active setup validator is unavailable' };
  }

  const next = new Map(currentSetups.map(row => [row.id, row]));
  for (const input of incomingSetups) {
    const normalized = normalizeSetup(input);
    if (!normalized) {
      return { ok:false, reason:'Active setup identity or fixed Entry/SL/Target RR validation failed' };
    }

    const prior = next.get(normalized.id);
    if (prior?.status && prior.status !== 'ACTIVE') continue;
    if (prior?.status === 'ACTIVE') {
      if (prior.underlying !== normalized.underlying || prior.contract !== normalized.contract) {
        return { ok:false, reason:'An active setup ID cannot be reassigned to another underlying or option contract' };
      }
      // The server ledger is authoritative. A browser restore may refresh
      // visibility, but must never rewrite the fixed risk plan or lifecycle.
      continue;
    }

    const activeRows = [...next.values()].filter(row => row.status === 'ACTIVE');
    if (activeRows.length >= maxActiveSetups) {
      return { ok:false, reason:'Maximum two active setups already retained' };
    }
    if (activeRows.some(row => row.underlying === normalized.underlying || row.contract === normalized.contract)) {
      return { ok:false, reason:'Duplicate active underlying or option contract is not allowed' };
    }
    next.set(normalized.id, normalized);
  }

  return { ok:true, setups:[...next.values()] };
}
