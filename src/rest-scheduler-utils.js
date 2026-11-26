export const REST_RECOVERY_REQUIRED_ON_START = true;

export const REST_PRIORITY = Object.freeze({ ENTRY:100, OPTION_CHAIN:90, CHART:80, INTERACTIVE:60, RESEARCH:40, CONTEXT:30, ACCOUNT:20, SCANNER:10, WARMUP:-20 });

// Account reads are background-class work for fairness, but they are excluded
// from the scanner/research background cap so positions and order status retain
// access to the shared global budget.
export function isRestBackgroundPriority(priority = 0) {
  const value = Number(priority) || 0;
  return value < REST_PRIORITY.CHART && value !== REST_PRIORITY.ACCOUNT;
}

export function canRunRestRecoveryProbe({ recoveryProbeRequired, recoveryProbeAttempted = false, priority } = {}) {
  return !Boolean(recoveryProbeRequired) || (!Boolean(recoveryProbeAttempted) && Number(priority) >= REST_PRIORITY.CHART);
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


// Cloudflare 1015 was observed on mixed REST traffic at only eight requests/minute.
// Apply a conservative process-local rolling budget to every FYERS REST endpoint,
// not only /history. This is an application safety guard, not a published FYERS quota.
export function getRestRequestWindowWaitMs(requests = [], now = Date.now(), maxRequests = 6, windowMs = 60_000, minPriority = Number.NEGATIVE_INFINITY, maxPriority = Number.POSITIVE_INFINITY, excludedPriorities = []) {
  const current = Number(now);
  const excluded = new Set((Array.isArray(excludedPriorities) ? excludedPriorities : []).map(Number));
  const limit = Math.max(1, Math.floor(Number(maxRequests) || 6));
  const window = Math.max(1, Number(windowMs) || 60_000);
  const recent = requests
    .filter(item => !excluded.has(Number(item?.priority || 0)) && Number(item?.priority || 0) >= Number(minPriority) && Number(item?.priority || 0) <= Number(maxPriority))
    .map(item => Date.parse(item?.at))
    .filter(at => Number.isFinite(at) && at <= current && current - at < window)
    .sort((a, b) => a - b);
  if (recent.length < limit) return 0;
  return Math.max(0, recent[0] + window - current);
}

// Cloudflare 1015 was observed on /data/history at 11 requests in one minute.
// Keep this endpoint below that observed edge threshold with a conservative
// rolling-window ceiling; this is an application guard, not FYERS' published plan limit.
export function getHistoryRequestWindowWaitMs(requests = [], now = Date.now(), maxRequests = 8, windowMs = 60_000, minPriority = Number.NEGATIVE_INFINITY, maxPriority = Number.POSITIVE_INFINITY, excludedPriorities = []) {
  const current = Number(now);
  const excluded = new Set((Array.isArray(excludedPriorities) ? excludedPriorities : []).map(Number));
  const limit = Math.max(1, Math.floor(Number(maxRequests) || 8));
  const window = Math.max(1, Number(windowMs) || 60_000);
  const recent = requests
    .filter(item => item?.path === '/history' && !excluded.has(Number(item?.priority || 0)) && Number(item?.priority || 0) >= Number(minPriority) && Number(item?.priority || 0) <= Number(maxPriority))
    .map(item => Date.parse(item?.at))
    .filter(at => Number.isFinite(at) && at <= current && current - at < window)
    .sort((a, b) => a - b);
  if (recent.length < limit) return 0;
  return Math.max(0, recent[0] + window - current);
}


// Select background work fairly inside the conservative shared REST budget.
// Interactive jobs retain strict priority; background classes share service so
// research/context cannot permanently outrank Account Feed or the F&O scanner.
export function getRestRequestClass(job = {}) {
  const priority = Number(job.priority) || 0;
  if (priority >= REST_PRIORITY.CHART) return 'INTERACTIVE';
  if (priority === REST_PRIORITY.ACCOUNT) return 'ACCOUNT';
  if (priority === REST_PRIORITY.SCANNER) return 'SCANNER';
  return 'RESEARCH';
}

export function findFairRestQueueIndex(jobs = [], recentRequests = [], now = Date.now(), isEligible = () => true, windowMs = 60_000) {
  const eligible = jobs.map((job, index) => ({ job, index }))
    .filter(({ job }) => Boolean(isEligible(job)));
  if (!eligible.length) return -1;
  const interactive = eligible.filter(({ job }) => getRestRequestClass(job) === 'INTERACTIVE');
  if (interactive.length) {
    interactive.sort((a, b) => Number(b.job.priority || 0) - Number(a.job.priority || 0) ||
      Number(a.job.sequence || 0) - Number(b.job.sequence || 0));
    return interactive[0].index;
  }
  const current = Number(now);
  const stats = new Map();
  for (const request of recentRequests) {
    const at = Date.parse(request?.at);
    if (!Number.isFinite(at) || at > current || current - at >= windowMs) continue;
    const requestClass = getRestRequestClass({ priority: request?.priority });
    if (requestClass === 'INTERACTIVE') continue;
    const row = stats.get(requestClass) || { count: 0, lastAt: 0 };
    row.count += 1;
    row.lastAt = Math.max(row.lastAt, at);
    stats.set(requestClass, row);
  }
  eligible.sort((a, b) => {
    const aClass = getRestRequestClass(a.job);
    const bClass = getRestRequestClass(b.job);
    const aStats = stats.get(aClass) || { count: 0, lastAt: 0 };
    const bStats = stats.get(bClass) || { count: 0, lastAt: 0 };
    return aStats.count - bStats.count || aStats.lastAt - bStats.lastAt ||
      Number(b.job.priority || 0) - Number(a.job.priority || 0) ||
      Number(a.job.sequence || 0) - Number(b.job.sequence || 0);
  });
  return eligible[0].index;
}


// Queue age limits prevent requests whose UI/market context has expired from
// being submitted upstream after a long rate-governor wait.
export function getRestTotalWindowLimit(priority = 0) {
  // Four of six global requests/minute are available to non-Entry work.
  // Two slots remain reserved for the live Entry verification path.
  return Number(priority) >= REST_PRIORITY.ENTRY ? 6 : 4;
}

export function getRestQueueMaxAgeMs(priority = 0) {
  const value = Number(priority) || 0;
  // Entry may wait behind one in-flight FYERS call (12s timeout) plus pacing.
  // Exchange-timestamped ticks are revalidated after all history requests finish.
  if (value >= REST_PRIORITY.ENTRY) return 60_000;
  if (value >= REST_PRIORITY.OPTION_CHAIN) return 15_000;
  if (value >= REST_PRIORITY.CHART) return 30_000;
  // CONTEXT and RESEARCH (priorities 30/40) often need two sequential
  // history requests. They must not inherit the shorter ACCOUNT queue TTL.
  if (value === REST_PRIORITY.ACCOUNT) return 30_000;
  if (value === REST_PRIORITY.SCANNER) return 10_000;
  return 120_000;
}

export function isRestQueueExpired(enqueuedAt, now = Date.now(), maxAgeMs = 0) {
  const queuedAt = Number(enqueuedAt);
  const current = Number(now);
  const maxAge = Math.max(0, Number(maxAgeMs) || 0);
  return !Number.isFinite(queuedAt) || !Number.isFinite(current) || current - queuedAt >= maxAge;
}

// Wake the drain at the earliest queued-job deadline instead of sleeping past
// an ENTRY/ACCOUNT TTL while waiting for a rolling request budget to recover.
export function getRestQueueExpiryWaitMs(jobs = [], now = Date.now()) {
  const current = Number(now);
  const waits = (Array.isArray(jobs) ? jobs : []).map(job =>
    Number(job?.enqueuedAt) + Math.max(0, Number(job?.maxQueueAgeMs) || 0) - current
  ).filter(Number.isFinite);
  return waits.length ? Math.max(0, Math.min(...waits)) : 0;
}

export function buildRestEndpointHealth(requests = [], now = Date.now()) {
  const latest = path => {
    const row = [...requests].reverse().find(item => item?.path === path && Number.isFinite(Number(item?.status)));
    if (!row) return { status: 'NOT_VERIFIED', ok: false, at: null, ageMs: null, source: null };
    const httpStatus = Number(row.status);
    const apiStatus = row.apiStatus || null;
    const responseCode = row.responseCode ?? null;
    const ok = httpStatus >= 200 && httpStatus < 300 && apiStatus !== 'error' &&
      !(responseCode !== null && Number(responseCode) < 0);
    const at = Date.parse(row.at);
    return {
      status: ok ? 'SUCCESS' : 'ERROR', ok,
      httpStatus, apiStatus, responseCode,
      at: row.at || null, ageMs: Number.isFinite(at) ? Math.max(0, Number(now) - at) : null,
      durationMs: Number.isFinite(Number(row.durationMs)) ? Number(row.durationMs) : null,
      source: row.source || null
    };
  };
  return {
    optionChain: latest('/options-chain-v3'),
    positions: latest('/api/v3/positions'),
    orderbook: latest('/api/v3/orders')
  };
}

export function findRestQueueDuplicate(jobs = [], coalesceKey) {
  if (typeof coalesceKey !== 'string' || !coalesceKey) return -1;
  return jobs.findIndex(job => job?.coalesceKey === coalesceKey);
}

export function buildRestDispatchGate({
  cooldownActive = false, recoveryProbeRequired = false, priority = 0,
  recoveryProbeAllowed = true, queueDepth = 0, minGapWaitMs = 0,
  totalWindowWaitMs = 0, backgroundWindowWaitMs = 0, historyWindowWaitMs = 0
} = {}) {
  const blockers = [];
  if (cooldownActive) blockers.push('COOLDOWN_ACTIVE');
  if (recoveryProbeRequired && !recoveryProbeAllowed) blockers.push('RECOVERY_PROBE_REQUIRED');
  if (Number(queueDepth) > 0) blockers.push('QUEUE_NOT_EMPTY');
  if (Number(minGapWaitMs) > 0) blockers.push('MIN_GAP_WAIT');
  if (Number(totalWindowWaitMs) > 0) blockers.push('TOTAL_WINDOW_BUDGET_WAIT');
  if (Number(backgroundWindowWaitMs) > 0) blockers.push('BACKGROUND_WINDOW_BUDGET_WAIT');
  if (Number(historyWindowWaitMs) > 0) blockers.push('HISTORY_WINDOW_BUDGET_WAIT');
  return {
    ready: blockers.length === 0,
    blockers,
    waitMs: Math.max(0, Number(minGapWaitMs)||0, Number(totalWindowWaitMs)||0,
      Number(backgroundWindowWaitMs)||0, Number(historyWindowWaitMs)||0)
  };
}

export function buildRestCoalesceKey({method='GET',url,authorization=''}={}) {
  const verb=String(method||'GET').toUpperCase();
  if(verb!=='GET'||typeof url!=='string'||!url)return null;
  return verb+':'+url+':auth:'+String(authorization||'');
}


// Wake the single REST queue drain when newly enqueued work may change priority order.
export function createRestQueueWakeSignal() {
  let activeWake = null;
  return {
    wait(ms) {
      return new Promise(resolve => {
        const timeout = setTimeout(finish, Math.max(0, Number(ms) || 0));
        function finish() {
          if (activeWake === finish) activeWake = null;
          clearTimeout(timeout);
          resolve();
        }
        activeWake = finish;
      });
    },
    wake() {
      activeWake?.();
    }
  };
}
