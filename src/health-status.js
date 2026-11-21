// Process liveness stays independent from broker availability; dependency state is reported truthfully.
export function buildHealthStatus({
  market = {}, masterCurrent = false, sessionDate = null, loadedDate = null,
  ordersEnabled = false, scanner = {}, scanPerSlice = null, rotationIntervalMs = null,
  rest = {}, runtimeMemory = {}
} = {}) {
  const indices = market.indices && typeof market.indices === 'object' ? Object.values(market.indices) : [];
  const fno = market.fno || {};
  const memory = {
    rssBytes: Number.isFinite(Number(runtimeMemory.rss)) ? Number(runtimeMemory.rss) : null,
    heapUsedBytes: Number.isFinite(Number(runtimeMemory.heapUsed)) ? Number(runtimeMemory.heapUsed) : null,
    heapTotalBytes: Number.isFinite(Number(runtimeMemory.heapTotal)) ? Number(runtimeMemory.heapTotal) : null,
    externalBytes: Number.isFinite(Number(runtimeMemory.external)) ? Number(runtimeMemory.external) : null
  };
  return {
    ok: true,
    app: 'Upgrade AI Pro',
    mode: 'NSE_ONLY',
    marketData: market.socketStatus || 'NOT_STARTED',
    indexFeed: {
      freshCount: indices.filter(tick => Boolean(tick?.fresh)).length,
      totalCount: indices.length
    },
    fnoMaster: { status: masterCurrent ? 'CURRENT' : 'REFRESH_PENDING', sessionDate, loadedDate },
    fno: {
      status: fno.status || 'UNKNOWN',
      universeCount: Number.isFinite(Number(fno.universeCount)) ? Number(fno.universeCount) : 0,
      activeCount: Number.isFinite(Number(fno.activeCount)) ? Number(fno.activeCount) : 0,
      observedCount: Number.isFinite(Number(fno.observedCount)) ? Number(fno.observedCount) : 0,
      coverageComplete: Boolean(fno.coverageComplete),
      topGainersFreshCount: Array.isArray(fno.topGainers) ? fno.topGainers.filter(item => item?.fresh).length : 0
    },
    scanner: {
      status: scanner.status || 'NOT_STARTED',
      scannedCount: Number(scanner.scannedCount || 0),
      sliceScannedCount: Number(scanner.sliceScannedCount || 0),
      scanPerSlice,
      rotationIntervalMs,
      lastSymbol: scanner.lastSymbol || null,
      lastStatus: scanner.lastStatus || null,
      lastScanAt: scanner.lastScanAt || null,
      warmupStatus: scanner.warmupStatus || 'IDLE',
      warmupQueueDepth: Number(scanner.warmupQueueDepth || 0),
      warmupCompletedCount: Number(scanner.warmupCompletedCount || 0),
      warmupRetryCount: Number(scanner.warmupRetryCount || 0),
      warmupRejectedCount: Number(scanner.warmupRejectedCount || 0)
    },
    option: {
      subscriptionStatus: market.optionSubscription?.status || 'NOT_SELECTED',
      tickFresh: Boolean(market.selectedOption?.fresh),
      tickAgeSeconds: Number.isFinite(Number(market.optionSubscription?.tickAgeSeconds)) ? Number(market.optionSubscription.tickAgeSeconds) : null
    },
    rest: {
      minGapMs: Number.isFinite(Number(rest.minGapMs)) ? Number(rest.minGapMs) : null,
      queueDepth: Number.isFinite(Number(rest.queueDepth)) ? Number(rest.queueDepth) : null,
      queueCapacity: Number.isFinite(Number(rest.queueCapacity)) ? Number(rest.queueCapacity) : null,
      cooldownActive: Boolean(rest.cooldownActive),
      cooldownUntil: rest.cooldownUntil || null
    },
    runtimeMemory: memory,
    orders: ordersEnabled ? 'ENABLED' : 'DISABLED'
  };
}
