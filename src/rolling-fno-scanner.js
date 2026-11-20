// Rolling market-wide F&O observation ranking for FYERS Standard's shared 100-symbol cap.
// This is deliberately NOT a simultaneous live scan and never creates actionable signals.
export const FNO_SCAN_PER_SLICE = 4;
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

export function buildFnoRotationSlice(universe = [], startIndex = 0, slotCount = 20, selectedSymbol = null) {
  const symbols=[...new Set(universe.map(item=>item?.symbol).filter(Boolean))];
  if(!symbols.length)return [];
  const count=Math.min(Math.max(1,Math.floor(Number(slotCount)||20)),symbols.length);
  const start=((Math.floor(Number(startIndex)||0)%symbols.length)+symbols.length)%symbols.length;
  const slice=[];
  for(let i=0;i<count;i++)slice.push(symbols[(start+i)%symbols.length]);
  if(selectedSymbol&&symbols.includes(selectedSymbol)&&!slice.includes(selectedSymbol))slice[slice.length-1]=selectedSymbol;
  return [...new Set(slice)];
}

export function getFnoScanBatchSize(universeCount, startIndex = 0, scanPerSlice = FNO_SCAN_PER_SLICE) {
  const total = Math.max(0, Math.floor(Number(universeCount) || 0));
  if (!total) return 0;
  const start = ((Math.floor(Number(startIndex) || 0) % total) + total) % total;
  const limit = Math.max(1, Math.floor(Number(scanPerSlice) || FNO_SCAN_PER_SLICE));
  // The last batch can be shorter than the configured cadence. Stop at the
  // universe boundary so a completed pass never rescans wrapped symbols.
  return Math.min(limit, total - start);
}

export function getNextFnoRotationIndex(universeCount, startIndex = 0, scanPerSlice = FNO_SCAN_PER_SLICE) {
  const total = Math.max(0, Math.floor(Number(universeCount) || 0));
  if (!total) return 0;
  const start = ((Math.floor(Number(startIndex) || 0) % total) + total) % total;
  const batchSize = getFnoScanBatchSize(total, start, scanPerSlice);
  return start + batchSize >= total ? 0 : start + batchSize;
}

export function getFnoSliceScanSymbols(activeSymbols, scanPerSlice = FNO_SCAN_PER_SLICE) {
  if (!Array.isArray(activeSymbols) || !activeSymbols.length) return [];
  const count = Math.max(1, Math.min(activeSymbols.length, Math.floor(Number(scanPerSlice) || FNO_SCAN_PER_SLICE)));
  // Rotation advances by this count, so the head is the next unscanned batch.
  return activeSymbols.slice(0,count);
}
