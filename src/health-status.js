// Process liveness stays independent from broker availability; dependency state is reported truthfully.
export function buildHealthStatus({
  market = {}, masterCurrent = false, sessionDate = null, loadedDate = null,
  ordersEnabled = false, scanner = {}, scanPerSlice = null, rotationIntervalMs = null,
  rest = {}, runtimeMemory = {}, authStatus = {}
} = {}) {
  const indices = market.indices && typeof market.indices === 'object' ? Object.values(market.indices) : [];
  const fno = market.fno || {};
  const endpointHealth = rest.endpointHealth || {};
  const positions = endpointHealth.positions || { status:'NOT_VERIFIED', ok:false };
  const orderbook = endpointHealth.orderbook || { status:'NOT_VERIFIED', ok:false };
  const optionChain = endpointHealth.optionChain || { status:'NOT_VERIFIED', ok:false };
  const accountFeedStatus = positions.ok && orderbook.ok ? 'VERIFIED'
    : [positions.status,orderbook.status].some(status=>status==='ERROR') ? 'ERROR' : 'NOT_VERIFIED';
  const blockers = [];
  if (!authStatus.tokenStored) blockers.push('FYERS_AUTH_NOT_READY');
  if (market.socketStatus !== 'CONNECTED') blockers.push('WEBSOCKET_NOT_CONNECTED');
  if (indices.filter(tick => Boolean(tick?.fresh)).length !== 3) blockers.push('THREE_FRESH_INDEX_TICKS_REQUIRED');
  if (!masterCurrent) blockers.push('CURRENT_SESSION_FNO_MASTER_NOT_READY');
  if (!market.selectedUnderlying?.fresh) blockers.push('SELECTED_UNDERLYING_TICK_NOT_FRESH');
  if (!market.selectedOption?.fresh) blockers.push('SELECTED_OPTION_TICK_NOT_FRESH');
  if (rest.cooldownActive) blockers.push('FYERS_REST_COOLDOWN_ACTIVE');
  if (rest.recoveryProbeRequired) blockers.push('FYERS_REST_RECOVERY_PROBE_REQUIRED');
  if (scanner.status !== 'RUNNING') blockers.push('FNO_SCANNER_NOT_RUNNING');
  const memory = {
    rssBytes: Number.isFinite(Number(runtimeMemory.rss)) ? Number(runtimeMemory.rss) : null,
    heapUsedBytes: Number.isFinite(Number(runtimeMemory.heapUsed)) ? Number(runtimeMemory.heapUsed) : null,
    heapTotalBytes: Number.isFinite(Number(runtimeMemory.heapTotal)) ? Number(runtimeMemory.heapTotal) : null,
    externalBytes: Number.isFinite(Number(runtimeMemory.external)) ? Number(runtimeMemory.external) : null
  };
  return {
    ok: true,
    processLiveness: 'ALIVE',
    accountFeed: { status:accountFeedStatus, positions, orderbook },
    optionChain,
    setupReadiness: {
      status:'NOT_EVALUATED',
      blockers:['LIVE_SETUP_EVALUATION_REQUIRED','COMPLETED_OPTION_CANDLES_REQUIRED','ENTRY_SL_TARGET_RR_VALIDATION_REQUIRED'],
      orders:'DISABLED'
    },
    marketPipelineReadiness: { status: blockers.length ? 'WAIT' : 'MARKET_DATA_READY', blockers },
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
      status: rest.status || 'IDLE',
      lastError: rest.lastError || null,
      lastRequestSource: rest.lastRequestSource || null,
      cooldownActive: Boolean(rest.cooldownActive),
      cooldownUntil: rest.cooldownUntil || null,
      recoveryProbeRequired: Boolean(rest.recoveryProbeRequired),
      recoveryProbeAttempted: Boolean(rest.recoveryProbeAttempted),
      cooldownPersistence: rest.cooldownPersistence || 'UNKNOWN'
    },
    runtimeMemory: memory,
    orders: ordersEnabled ? 'ENABLED' : 'DISABLED'
  };
}
