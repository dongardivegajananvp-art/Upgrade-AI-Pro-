// Shared gate for scanner inputs: both receive time and exchange time must be fresh.
export function isFreshFnoTick(tick, now = Date.now(), maxAgeMs = 10_000) {
  if (!tick) return false;
  const receivedAt = Number(tick.receivedAt);
  const exchangeTime = Number(tick.exchangeTime);
  const receiveAgeMs = Number(now) - receivedAt;
  const exchangeAgeSeconds = Number(now) / 1000 - exchangeTime;
  const exchangeReceiptDelayMs = receivedAt - exchangeTime * 1000;
  return Number.isFinite(receivedAt) && Number.isFinite(exchangeTime) &&
    receiveAgeMs >= 0 && receiveAgeMs <= Math.max(0, Number(maxAgeMs) || 0) &&
    exchangeAgeSeconds >= -3 && exchangeAgeSeconds <= 10 &&
    exchangeReceiptDelayMs >= 0 && exchangeReceiptDelayMs <= 5000;
}
