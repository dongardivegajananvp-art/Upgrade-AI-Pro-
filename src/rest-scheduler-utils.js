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

export function canCompleteSocketRateLimitRecovery({ recoveryPending, pendingCount, socketConnected, now, cooldownUntil } = {}) {
  return Boolean(recoveryPending) && Number(pendingCount) === 0 &&
    Boolean(socketConnected) && Number(now) >= Number(cooldownUntil);
}

// Stable priority ordering: interactive work can move ahead of queued background scans,
// while equal-priority requests retain FIFO order.
export function sortRestQueue(jobs = []) {
  return [...jobs].sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || Number(a.sequence || 0) - Number(b.sequence || 0));
}

// Bound pending work so slow upstream responses cannot grow memory indefinitely.
// Higher-priority requests may displace the newest job at the lowest priority;
// equal-priority arrivals preserve FIFO and are rejected when the queue is full.
export function admitRestJob(jobs = [], job, maxSize = 100) {
  const queue = [...jobs];
  const limit = Math.max(1, Math.floor(Number(maxSize) || 100));
  if (queue.length < limit) return { accepted: true, queue: [...queue, job], dropped: null };
  const incomingPriority = Number(job?.priority || 0);
  const lowestPriority = Math.min(...queue.map(item => Number(item?.priority || 0)));
  if (incomingPriority <= lowestPriority) return { accepted: false, queue, dropped: job };
  let dropIndex = -1;
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (Number(queue[index]?.priority || 0) === lowestPriority) {
      dropIndex = index;
      break;
    }
  }
  if (dropIndex < 0) return { accepted: false, queue, dropped: job };
  const [dropped] = queue.splice(dropIndex, 1);
  queue.push(job);
  return { accepted: true, queue, dropped };
}
