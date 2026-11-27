export const INDEX_STRATEGY_SYMBOLS = Object.freeze([
  'NSE:NIFTY50-INDEX',
  'NSE:NIFTYBANK-INDEX',
  'NSE:FINNIFTY-INDEX'
]);

export const INDEX_STRATEGY_LABELS = Object.freeze({
  'NSE:NIFTY50-INDEX': 'NIFTY 50',
  'NSE:NIFTYBANK-INDEX': 'BANK NIFTY',
  'NSE:FINNIFTY-INDEX': 'FIN NIFTY'
});

export function isFreshIndexTick(tick, now = Date.now()) {
  if (!tick) return false;
  const receivedAt = Number(tick.receivedAt);
  const exchangeTime = Number(tick.exchangeTime);
  const receiveAgeMs = Number(now) - receivedAt;
  const exchangeAgeSeconds = Number(now) / 1000 - exchangeTime;
  const exchangeReceiptDelayMs = receivedAt - exchangeTime * 1000;
  return Number.isFinite(receivedAt) && Number.isFinite(exchangeTime) &&
    Number.isFinite(Number(tick.price)) && Number(tick.price) > 0 &&
    receiveAgeMs >= 0 && receiveAgeMs <= 10_000 &&
    exchangeAgeSeconds >= -3 && exchangeReceiptDelayMs >= 0 &&
    exchangeReceiptDelayMs <= 5_000;
}

export function countFreshIndexTicks(indices = {}, now = Date.now()) {
  return INDEX_STRATEGY_SYMBOLS.filter(symbol => isFreshIndexTick(indices[symbol], now)).length;
}

export function isVerifiedIndexHistory(history, now = Date.now()) {
  if (!history || history.source !== 'FYERS_VERIFIED_5M_HISTORY' ||
      history.actionable !== true || !Array.isArray(history.candles) || !history.candles.length) return false;
  const last = history.candles.at(-1);
  const time = Number(last?.time);
  const ageSeconds = Number(now) / 1000 - (time + 300);
  return last?.completed === true && Number.isFinite(time) && time > 0 &&
    Number.isFinite(ageSeconds) && ageSeconds >= 0 && ageSeconds <= 600 &&
    Number(history.lastCompletedCandleTime) === time;
}

export function buildIndexStrategyScanRecord({ symbol, tick, history, result, now = Date.now(), attemptCount = 1 } = {}) {
  const candle = history?.candles?.at(-1) || null;
  const setupConfirmed = result?.status === 'UNDERLYING_SETUP_CONFIRMED';
  const ledger = Array.isArray(result?.strategyLedger) ? result.strategyLedger : [];
  return {
    symbol,
    label: INDEX_STRATEGY_LABELS[symbol] || symbol,
    status: result?.status || 'DATA_UNAVAILABLE_NO_TRADE',
    tradeStatus: setupConfirmed ? 'OPTION_CONFIRMATION_REQUIRED_NO_TRADE' : 'NO_TRADE',
    reason: result?.reason || (setupConfirmed ? 'Underlying setup confirmed; CE/PE live tick and completed option candle are not verified by this index scan' : null),
    strategy: result?.strategy || null,
    side: result?.side || null,
    breakoutLevel: Number.isFinite(Number(result?.breakoutLevel)) ? Number(result.breakoutLevel) : null,
    underlyingPrice: Number.isFinite(Number(result?.underlyingPrice)) ? Number(result.underlyingPrice) : Number.isFinite(Number(tick?.price)) ? Number(tick.price) : null,
    tickFresh: isFreshIndexTick(tick, now),
    tickExchangeTime: tick?.exchangeTime || null,
    tickReceivedAt: tick?.receivedAt || null,
    candleCount: Array.isArray(history?.candles) ? history.candles.length : 0,
    lastCompletedCandleTime: candle?.time || null,
    historySource: history?.source || null,
    strategyCheckCount: ledger.filter(row => !['BLOCKED', 'SKIPPED_AFTER_FIRST_PASS'].includes(row.status)).length,
    strategyLedger: ledger,
    attemptCount,
    lastScanAt: new Date(now).toISOString(),
    actionable: false,
    orders: 'DISABLED'
  };
}
