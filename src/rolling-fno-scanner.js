// Rolling market-wide F&O observation ranking for FYERS Standard's shared 100-symbol cap.
// This is deliberately NOT a simultaneous live scan and never creates actionable signals.
function istDayKey(epochSeconds) {
  return new Date((Number(epochSeconds) + 19800) * 1000).toISOString().slice(0, 10);
}
export function buildRollingFnoLeaderboard({ universe = [], ticks = new Map(), now = Date.now(), slotCount = 20, rotationIntervalMs = 60000, limit = 5 } = {}) {
  const symbols = [...new Set(universe.map(item => item?.symbol).filter(Boolean))];
  const today = istDayKey(now / 1000);
  const maxObservationAgeSeconds = Math.ceil(symbols.length / Math.max(1, slotCount)) * (rotationIntervalMs / 1000) + 60;
  const observed = [];
  const freshObserved = [];
  for (const symbol of symbols) {
    const tick = ticks.get(symbol);
    if (!tick || !Number.isFinite(Number(tick.changePercent)) || !Number.isFinite(Number(tick.receivedAt)) ||
        !Number.isFinite(Number(tick.exchangeTime)) || istDayKey(tick.exchangeTime) !== today) continue;
    const ageSeconds = Math.max(0, Math.floor((now - Number(tick.receivedAt)) / 1000));
    if (ageSeconds > maxObservationAgeSeconds) continue;
    const fresh = ageSeconds <= 10 && now / 1000 - Number(tick.exchangeTime) <= 10 && now / 1000 - Number(tick.exchangeTime) >= -3;
    const row = { ...tick, fresh, ageSeconds };
    observed.push(row);
    if (fresh) freshObserved.push(row);
  }
  observed.sort((a, b) => Number(b.changePercent) - Number(a.changePercent));
  freshObserved.sort((a, b) => Number(b.changePercent) - Number(a.changePercent));
  return {
    observedCount: observed.length,
    freshCount: freshObserved.length,
    universeCount: symbols.length,
    coverageComplete: symbols.length > 0 && observed.length === symbols.length,
    maxObservationAgeSeconds,
    topGainers: freshObserved.slice(0, Math.max(1, limit))
  };
}
