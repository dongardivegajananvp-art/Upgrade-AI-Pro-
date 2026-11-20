export function isRestCooldownActive(now, cooldownUntil) {
  return Number(now) < Number(cooldownUntil);
}

export function getRestWaitMs(now, nextRequestAt) {
  return Math.max(0, Number(nextRequestAt) - Number(now));
}

// FYERS may provide Retry-After as seconds or an HTTP date. Keep the local
// one-hour safety floor, but never retry earlier than the provider explicitly asks.
export function parseRetryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const raw = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Number(now)) : null;
}

export function getRateLimitCooldownUntil(now, retryAfter, fallbackMs = 60 * 60 * 1000) {
  const providerWait = parseRetryAfterMs(retryAfter, now);
  return Number(now) + Math.max(Number(fallbackMs) || 0, providerWait || 0);
}

// Bounded exponential backoff for WebSocket 1015/rate-limit recovery.
// attempt is one-based; the cap prevents an unbounded reconnect delay.
export function getSocketRateLimitBackoffMs(attempt, baseMs = 60_000, maxMs = 15 * 60_000) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const base = Math.max(1, Number(baseMs) || 60_000);
  const cap = Math.max(base, Number(maxMs) || 15 * 60_000);
  return Math.min(cap, base * (2 ** Math.min(n - 1, 20)));
}
