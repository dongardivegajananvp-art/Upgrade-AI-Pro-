// Rolling market-wide F&O observation ranking for FYERS Standard's shared 100-symbol cap.
// This is deliberately NOT a simultaneous live scan and never creates actionable signals.
// Keep history-backed strategy evaluation within the measured FYERS REST budget.
// The 20-symbol socket slice is an observation/rotation window, NOT a promise that
// all 20 symbols receive REST history in one minute. Only actual successful checks
// are counted by the scanner ledger and UI.
export const FNO_SCAN_PER_SLICE = 3;
// Rotate exactly 20 F&O symbols into the live socket window each minute.
export const FNO_SOCKET_ROTATION_ADVANCE = 20;
export const FNO_SYMBOL_RESCAN_COOLDOWN_MS = 5 * 60 * 1000;
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
    const exchangeReceiptDelayMs=Number(tick.receivedAt)-Number(tick.exchangeTime)*1000;
    const fresh = ageSeconds <= 10 && now / 1000 - Number(tick.exchangeTime) >= -3 && exchangeReceiptDelayMs >= 0 && exchangeReceiptDelayMs <= 5000;
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
    observations: observed.slice(0, Math.max(1, limit)),
    // The live Top Gainers list must never promote stale rolling observations.
    // Keep stale rows separately for coverage diagnostics and age visibility.
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
  // Keep the market-wide rotation deterministic. The selected underlying is
  // subscribed separately by the socket manager and must not replace a rotating
  // symbol, otherwise each UI selection churns up to 20 subscriptions.
  return slice;
}

export function getNextFreshFnoScanSymbol(activeSymbols, ticks = new Map(), scanLedger = new Map(), now = Date.now(), minRescanIntervalMs = FNO_SYMBOL_RESCAN_COOLDOWN_MS) {
  if (!Array.isArray(activeSymbols) || !activeSymbols.length) return null;
  const eligible = activeSymbols.filter(symbol => {
    const tick = ticks.get(symbol);
    return Boolean(tick && Number.isFinite(Number(tick.price)) && Number(tick.price) > 0 &&
      Number.isFinite(Number(tick.receivedAt)) && now - Number(tick.receivedAt) >= 0 &&
      now - Number(tick.receivedAt) <= 10000 && Number.isFinite(Number(tick.exchangeTime)) &&
      now / 1000 - Number(tick.exchangeTime) >= -3 && true &&
      Number(tick.receivedAt) - Number(tick.exchangeTime) * 1000 >= 0 && Number(tick.receivedAt) - Number(tick.exchangeTime) * 1000 <= 5000);
  });
  if (!eligible.length) return null;
  const lastAttempt = symbol => {
    const row = scanLedger.get(symbol);
    const stamp = Date.parse(row?.scannedAt || row?.attemptedAt || '');
    return Number.isFinite(stamp) ? stamp : null;
  };
  // Fresh symbols with no recorded attempt always win. A previously scanned
  // symbol cannot consume another REST slot until its cooldown has elapsed.
  const unscanned = eligible.filter(symbol => lastAttempt(symbol) === null);
  if (unscanned.length) return unscanned[0];
  const due = eligible.filter(symbol => {
    const stamp = lastAttempt(symbol);
    return stamp !== null && now - stamp >= Math.max(0, Number(minRescanIntervalMs) || 0);
  });
  if (!due.length) return null;
  due.sort((a, b) => lastAttempt(a) - lastAttempt(b));
  return due[0];
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

export function getFnoScanSliceKey(activeSymbols) {
  return Array.isArray(activeSymbols) ? activeSymbols.filter(Boolean).join('|') : '';
}

export function shouldResetFnoScanCursor(previousRotation, nextRotation, previousSliceKey, nextSliceKey) {
  return previousRotation !== nextRotation || previousSliceKey !== nextSliceKey;
}
