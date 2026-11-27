export function getOpportunityCycleState({
  setups = [],
  recentlyClosed = new Map(),
  latestCandleTimes = new Map(),
  maxActiveSetups = 2
} = {}) {
  const activeRows = setups.filter(row => row?.status === 'ACTIVE');
  const activeUnderlyings = [...new Set(activeRows.map(row => row.underlying).filter(Boolean))];
  const coolingUnderlyings = [];
  const expiredClosedUnderlyings = [];
  for (const [symbol, closed] of recentlyClosed instanceof Map ? recentlyClosed : []) {
    const latest = Number(latestCandleTimes.get(symbol) || 0);
    const closedCandle = Number(closed?.closedCandleTime || closed?.setupCandleTime || 0);
    if (closedCandle > 0 && latest <= closedCandle) coolingUnderlyings.push(symbol);
    else expiredClosedUnderlyings.push(symbol);
  }
  const excludedUnderlyings = [...new Set([...activeUnderlyings, ...coolingUnderlyings])];
  return {
    activeCount: activeRows.length,
    availableSlots: Math.max(0, Number(maxActiveSetups) - activeRows.length),
    activeUnderlyings,
    coolingUnderlyings,
    expiredClosedUnderlyings,
    excludedUnderlyings,
    status: activeRows.length >= Number(maxActiveSetups)
      ? 'WAITING_FOR_ACTIVE_SLOT'
      : 'SCANNING_FOR_NEXT_CANDIDATE'
  };
}
