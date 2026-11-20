// Process liveness stays independent from broker availability; dependency state is reported truthfully.
export function buildHealthStatus({ market = {}, masterCurrent = false, sessionDate = null, loadedDate = null, ordersEnabled = false } = {}) {
  const indices = market.indices && typeof market.indices === 'object' ? Object.values(market.indices) : [];
  return {
    ok: true,
    app: 'Upgrade AI Pro',
    mode: 'NSE_ONLY',
    marketData: market.socketStatus || 'NOT_STARTED',
    indexFeed: {
      freshCount: indices.filter(tick => Boolean(tick?.fresh)).length,
      totalCount: indices.length
    },
    fnoMaster: {
      status: masterCurrent ? 'CURRENT' : 'REFRESH_PENDING',
      sessionDate,
      loadedDate
    },
    fno: market.fno?.status || 'UNKNOWN',
    orders: ordersEnabled ? 'ENABLED' : 'DISABLED'
  };
}
