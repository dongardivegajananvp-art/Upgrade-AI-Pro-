export const REST_PRIORITY = Object.freeze({ ENTRY:100, OPTION_CHAIN:90, CHART:80, INTERACTIVE:60, RESEARCH:40, CONTEXT:30, ACCOUNT:20, SCANNER:10, WARMUP:-20 });

export function canRunRestRecoveryProbe({ recoveryProbeRequired, priority } = {}) {
  return !Boolean(recoveryProbeRequired) || Number(priority) >= REST_PRIORITY.CHART;
}

export function isRestCooldownActive(now, cooldownUntil) {
  return Number(now) < Number(cooldownUntil);
}

export function getRestWaitMs(now, nextRequestAt) {
  return Math.max(0, Number(nextRequestAt) - Number(now));
}

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

// Distinguish Cloudflare edge throttling from FYERS plan/API quota responses.
// Cloudflare 1015 is not the FYERS documented -360/-429 quota error.
export function classifyRestRateLimit({ status, code, server, cfRay } = {}) {
  if (Number(status) !== 429) return 'NOT_RATE_LIMITED';
  const normalizedCode = String(code ?? '').trim();
  const normalizedServer = String(server ?? '').toLowerCase();
  if (normalizedCode === '1015' || (normalizedServer.includes('cloudflare') && Boolean(cfRay))) {
    return 'CLOUDFLARE_1015';
  }
  if (normalizedCode === '-360' || normalizedCode === '-429') return 'FYERS_PLAN_LIMIT';
  return 'UNKNOWN_429';
}

function boundedBackoffUntil(now, retryAfter, attempt, baseMs, maxMs) {
  const current = Number(now);
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const providerWait = parseRetryAfterMs(retryAfter, current) || 0;
  const base = Math.max(1, Number(baseMs) || 60_000);
  const cap = Math.max(base, Number(maxMs) || 15 * 60_000);
  const backoff = Math.min(cap, base * (2 ** Math.min(n - 1, 20)));
  return current + Math.max(backoff, providerWait);
}

// FYERS documents a rest-of-day block after more than three per-minute
// quota violations in a day. Call this only for identified FYERS -360/-429 errors.
export function getRateLimitCooldownUntil(now, retryAfter, attempt = 1, baseMs = 60_000, maxMs = 15 * 60_000) {
  const current = Number(now);
  const n = Math.max(1, Math.floor(Number(attempt) || 1));
  const providerWait = parseRetryAfterMs(retryAfter, current) || 0;
  if (n >= 4) {
    const ist = new Date(current + 19_800_000);
    const nextIstMidnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1) - 19_800_000;
    return Math.max(nextIstMidnight, current + providerWait);
  }
  return boundedBackoffUntil(current, retryAfter, n, baseMs, maxMs);
}

// Cloudflare documents a 30-second default Retry-After for 1015.
// Repeated 1015 responses back off further, but never trigger FYERS' daily quota lock.
export function getCloudflareRateLimitCooldownUntil(now, retryAfter, attempt = 1, baseMs = 30_000, maxMs = 15 * 60_000) {
  return boundedBackoffUntil(now, retryAfter, attempt, baseMs, maxMs);
}

// Unclassified 429s fail closed with bounded backoff, not a guessed provider day lock.
export function getUnknownRateLimitCooldownUntil(now, retryAfter, attempt = 1, baseMs = 60_000, maxMs = 15 * 60_000) {
  return boundedBackoffUntil(now, retryAfter, attempt, baseMs, maxMs);
}

// Bounded exponential backoff for WebSocket 1015/rate-limit recovery.
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

// Keep the exact caller identity with a 429 so shared /data/history traffic can
// be traced to chart, scanner, warmup, or manual research without guessing.
export function buildRestRateLimitContext({ requestRecord, requestSources = [], recentRequests = [] } = {}) {
  return {
    requestSource: String(requestRecord?.source || 'UNCLASSIFIED'),
    requestPath: String(requestRecord?.path || 'unknown'),
    requestPriority: Number(requestRecord?.priority) || 0,
    sourceCounts: requestSources.map(item => ({
      source: String(item?.source || 'UNCLASSIFIED'),
      requestsThisMinute: Number(item?.requestsThisMinute) || 0,
      requestsToday: Number(item?.requestsToday) || 0
    })).sort((a, b) => b.requestsThisMinute - a.requestsThisMinute || b.requestsToday - a.requestsToday),
    recentRequests: recentRequests.slice(-12).map(item => ({
      at: item?.at || null, path: item?.path || 'unknown',
      source: item?.source || 'UNCLASSIFIED', priority: Number(item?.priority) || 0,
      status: item?.status || 'UNKNOWN'
    }))
  };
}


// Cloudflare 1015 was observed on /data/history at 11 requests in one minute.
// Keep this endpoint below that observed edge threshold with a conservative
// rolling-window ceiling; this is an application guard, not FYERS' published plan limit.
export function getHistoryRequestWindowWaitMs(requests = [], now = Date.now(), maxRequests = 8, windowMs = 60_000) {
  const current = Number(now);
  const limit = Math.max(1, Math.floor(Number(maxRequests) || 8));
  const window = Math.max(1, Number(windowMs) || 60_000);
  const recent = requests
    .filter(item => item?.path === '/history')
    .map(item => Date.parse(item?.at))
    .filter(at => Number.isFinite(at) && at <= current && current - at < window)
    .sort((a, b) => a - b);
  if (recent.length < limit) return 0;
  return Math.max(0, recent[0] + window - current);
}
