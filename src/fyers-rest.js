import { runHistoryRequestOnce } from './history-request-flight.js';
import { getAccessTokenForServer } from './fyers-auth.js';
import { getRestWaitMs, isRestCooldownActive, getRateLimitCooldownUntil, getCloudflareRateLimitCooldownUntil, getUnknownRateLimitCooldownUntil, classifyRestRateLimit, buildRestRateLimitContext, buildRestEndpointHealth, buildRestCoalesceKey, buildRestDispatchGate, findRestQueueDuplicate, getHistoryRequestWindowWaitMs, getRestRequestWindowWaitMs, findFairRestQueueIndex, getRestQueueMaxAgeMs, isRestQueueExpired, getRestQueueExpiryWaitMs, isRestBackgroundPriority, sortRestQueue, admitRestJob, createRestQueueWakeSignal, REST_PRIORITY, REST_RECOVERY_REQUIRED_ON_START, canRunRestRecoveryProbe } from './rest-scheduler-utils.js';

const DATA_BASE = 'https://api-t1.fyers.in/data';
const API_BASE = 'https://api-t1.fyers.in/api/v3';
const MIN_REST_GAP_MS = 4000;
const MAX_REST_QUEUE_SIZE = 100;
let nextRequestAt = 0;
let cooldownUntil = 0;
// Process-local cooldown timestamps disappear on restart. Start in a conservative
// recovery state so background scanner traffic cannot immediately hit the edge.
let recoveryProbeRequired = REST_RECOVERY_REQUIRED_ON_START;
// One recovery probe is permitted after startup or a 429 cooldown. A failed
// probe stays closed; no queued interactive request may turn into a retry storm.
let recoveryProbeAttempted = false;
const restQueue = [];
const inFlightRestJobs = new Map();
let restQueueSequence = 0;
let drainingRestQueue = false;
let lastRestStatus = 'IDLE';
let lastRestError = null;
let lastRestMeta = { retryAfter: null, cfRay: null, server: null, contentType: null };
let lastRequestPath = null;
let lastRateLimitAt = null;
let lastRequestPriority = null;
let lastRequestSource = null;
const requestSourceStats = new Map();
const recentUpstreamRequests = [];
let rateLimitDayKey = null;
let rateLimitCountToday = 0;
let cloudflareRateLimitCountToday = 0;
let unknownRateLimitCountToday = 0;
let lastRateLimitKind = null;
let requestMinuteKey = null;
let requestsThisMinute = 0;
let requestDayKey = null;
let requestsToday = 0;

function istDayKey(now = Date.now()) {
  return new Date(Number(now) + 19_800_000).toISOString().slice(0, 10);
}
function refreshRequestCounters(now = Date.now()) {
  const minuteKey = Math.floor(Number(now) / 60_000);
  if (requestMinuteKey !== minuteKey) {
    requestMinuteKey = minuteKey;
    requestsThisMinute = 0;
  }
  const dayKey = istDayKey(now);
  if (requestDayKey !== dayKey) {
    requestDayKey = dayKey;
    requestsToday = 0;
  }
  if (rateLimitDayKey !== dayKey) {
    rateLimitDayKey = dayKey;
    rateLimitCountToday = 0;
    cloudflareRateLimitCountToday = 0;
    unknownRateLimitCountToday = 0;
  }
}
function recordUpstreamRequest(now = Date.now(), source = 'UNCLASSIFIED', path = 'unknown', priority = 0) {
  refreshRequestCounters(now);
  requestsThisMinute++;
  requestsToday++;
  const minuteKey = Math.floor(Number(now) / 60_000);
  const dayKey = istDayKey(now);
  const key = String(source || 'UNCLASSIFIED');
  const stats = requestSourceStats.get(key) || { source:key, minuteKey, dayKey, requestsThisMinute:0, requestsToday:0 };
  if (stats.minuteKey !== minuteKey) { stats.minuteKey = minuteKey; stats.requestsThisMinute = 0; }
  if (stats.dayKey !== dayKey) { stats.dayKey = dayKey; stats.requestsToday = 0; }
  stats.requestsThisMinute++;
  stats.requestsToday++;
  requestSourceStats.set(key, stats);
  lastRequestSource = key;
  const record = { at:new Date(now).toISOString(), path, source:key, priority:Number(priority)||0, status:'IN_FLIGHT' };
  recentUpstreamRequests.push(record);
  if (recentUpstreamRequests.length > 30) recentUpstreamRequests.shift();
  return record;
}

export function validateNseSymbol(symbol) {
  return typeof symbol === 'string' && /^NSE:[A-Z0-9&._-]{1,48}$/.test(symbol);
}
const INDEX_HISTORY_SYMBOLS = new Set(['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX']);
export function validateHistorySymbol(symbol) {
  return validateNseSymbol(symbol) || INDEX_HISTORY_SYMBOLS.has(symbol);
}
export function normalizeFiveMinuteCandles(rows, now = Date.now()) {
  if (!Array.isArray(rows)) return [];
  const currentBucket = Math.floor(now / 300000) * 300;
  const seen = new Set();
  return rows.map(row => {
    if (!Array.isArray(row) || row.length < 6) return null;
    const [time, open, high, low, close, volume] = row.map(Number);
    if (![time, open, high, low, close, volume].every(Number.isFinite)) return null;
    if (time <= 0 || open <= 0 || high < Math.max(open, close, low) || low > Math.min(open, close) || close <= 0 || volume < 0) return null;
    const ist = new Date((time + 19800) * 1000);
    const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (minute < 555 || minute >= 930 || ((minute - 555) % 5) !== 0 || time >= currentBucket || seen.has(time)) return null;
    seen.add(time);
    return { time, open, high, low, close, volume, completed: true, source: 'FYERS_HISTORY' };
  }).filter(Boolean).sort((a, b) => a.time - b.time);
}
const restQueueWakeSignal = createRestQueueWakeSignal();
function settleRestJob(job, succeeded, value) {
  if (job?.coalesceKey && inFlightRestJobs.get(job.coalesceKey) === job) inFlightRestJobs.delete(job.coalesceKey);
  const waiters = Array.isArray(job?.waiters) ? job.waiters.splice(0) : [];
  const settle = succeeded ? 'resolve' : 'reject';
  job?.[settle]?.(value);
  for (const waiter of waiters) waiter?.[settle]?.(value);
}
function expireQueuedRestJobs(now = Date.now()) {
  for (let index = restQueue.length - 1; index >= 0; index -= 1) {
    const job = restQueue[index];
    if (!isRestQueueExpired(job.enqueuedAt, now, job.maxQueueAgeMs)) continue;
    restQueue.splice(index, 1);
    const error = new Error('FYERS REST queued request expired before upstream submission; stale work was discarded');
    lastRestStatus = 'QUEUE_EXPIRED';
    lastRestError = error.message;
    settleRestJob(job, false, error);
    console.warn('[FYERS_REST] queued request expired before upstream submission:', JSON.stringify({
      path: job.url.pathname, source: job.source, priority: job.priority,
      queuedForMs: now - job.enqueuedAt
    }));
  }
}
async function drainRestQueue() {
  if (drainingRestQueue) return;
  drainingRestQueue = true;
  try {
    while (restQueue.length) {
      expireQueuedRestJobs();
      if (!restQueue.length) break;
      if (isRestCooldownActive(Date.now(), cooldownUntil)) {
        const error = new Error('FYERS REST cooldown active; queued request was not sent upstream');
        for (const job of restQueue.splice(0)) settleRestJob(job, false, error);
        lastRestStatus = 'RATE_LIMITED';
        break;
      }
      restQueue.splice(0, restQueue.length, ...sortRestQueue(restQueue));
      const delay = getRestWaitMs(Date.now(), nextRequestAt);
      if (delay) await restQueueWakeSignal.wait(delay);
      expireQueuedRestJobs();
      if (!restQueue.length) break;
      if (isRestCooldownActive(Date.now(), cooldownUntil)) {
        const error = new Error('FYERS REST cooldown active; queued request was not sent upstream');
        for (const job of restQueue.splice(0)) settleRestJob(job, false, error);
        lastRestStatus = 'RATE_LIMITED';
        break;
      }
      restQueue.splice(0, restQueue.length, ...sortRestQueue(restQueue));
      if (recoveryProbeRequired) {
        const recoveryIndex = restQueue.findIndex(job => canRunRestRecoveryProbe({ recoveryProbeRequired, recoveryProbeAttempted, priority: job.priority }));
        if (recoveryIndex < 0) {
          const error = new Error('FYERS REST recovery probe required; background request was held before upstream submission');
          for (const pending of restQueue.splice(0)) settleRestJob(pending, false, error);
          lastRestStatus = 'RECOVERY_PROBE_REQUIRED';
          break;
        }
      }
      // A Cloudflare 1015 was observed after 11 /data/history calls in one
      // minute. Cap this endpoint at 8 per rolling minute, while allowing
      // higher/lower-priority non-history REST work to proceed independently.
      // Cloudflare 1015 was observed on mixed traffic (history, option-chain,
      // positions and orderbook) at eight upstream requests/minute. Guard the
      // entire FYERS REST origin, while reserving half the conservative budget
      // for selected chart/option/Entry work. Scanner, research and warmup are
      // capped as background traffic; Account Feed is exempt from that cap but
      // remains below selected chart/option/Entry priorities.
      const eligibleIndex = findFairRestQueueIndex(restQueue, recentUpstreamRequests, Date.now(), job => {
        if (recoveryProbeRequired && !canRunRestRecoveryProbe({ recoveryProbeRequired, recoveryProbeAttempted, priority: job.priority })) return false;
        const totalWindowWait = getRestRequestWindowWaitMs(recentUpstreamRequests, Date.now(), 6);
        const backgroundWindowWait = isRestBackgroundPriority(job.priority)
          ? getRestRequestWindowWaitMs(recentUpstreamRequests, Date.now(), 3, 60_000, Number.NEGATIVE_INFINITY, REST_PRIORITY.CHART - 1, [REST_PRIORITY.ACCOUNT])
          : 0;
        if (totalWindowWait > 0 || backgroundWindowWait > 0) return false;
        // Keep the stricter existing /history-specific background protection as
        // a second guard; global request pacing applies to every REST path.
        if (job.url.pathname === '/history') {
          const historyWindowWait = getHistoryRequestWindowWaitMs(recentUpstreamRequests, Date.now(), 8);
          const historyBackgroundWait = isRestBackgroundPriority(job.priority)
            ? getHistoryRequestWindowWaitMs(recentUpstreamRequests, Date.now(), 4, 60_000, Number.NEGATIVE_INFINITY, REST_PRIORITY.CHART - 1, [REST_PRIORITY.ACCOUNT])
            : 0;
          return historyWindowWait === 0 && historyBackgroundWait === 0;
        }
        return true;
      });
      if (eligibleIndex < 0) {
        const waits = restQueue.map(job => {
          const totalWait = getRestRequestWindowWaitMs(recentUpstreamRequests, Date.now(), 6);
          const backgroundWait = isRestBackgroundPriority(job.priority)
            ? getRestRequestWindowWaitMs(recentUpstreamRequests, Date.now(), 3, 60_000, Number.NEGATIVE_INFINITY, REST_PRIORITY.CHART - 1, [REST_PRIORITY.ACCOUNT])
            : 0;
          const historyWait = job.url.pathname === '/history'
            ? getHistoryRequestWindowWaitMs(recentUpstreamRequests, Date.now(), 8)
            : 0;
          const historyBackgroundWait = job.url.pathname === '/history' && isRestBackgroundPriority(job.priority)
            ? getHistoryRequestWindowWaitMs(recentUpstreamRequests, Date.now(), 4, 60_000, Number.NEGATIVE_INFINITY, REST_PRIORITY.CHART - 1, [REST_PRIORITY.ACCOUNT])
            : 0;
          return Math.max(totalWait, backgroundWait, historyWait, historyBackgroundWait);
        }).filter(value => value > 0);
        const budgetWait = waits.length ? Math.min(...waits) : 1;
        const expiryWait = getRestQueueExpiryWaitMs(restQueue, Date.now());
        await restQueueWakeSignal.wait(Math.max(1, expiryWait > 0 ? Math.min(budgetWait, expiryWait) : budgetWait));
        continue;
      }
      const [job] = restQueue.splice(eligibleIndex, 1);
      if (!job) continue;
      lastRequestPath = job.url.pathname;
      lastRequestPriority = job.priority;
      const requestStartedAt = Date.now();
      if (job.coalesceKey) inFlightRestJobs.set(job.coalesceKey, job);
      if (recoveryProbeRequired) recoveryProbeAttempted = true;
      const requestRecord = recordUpstreamRequest(requestStartedAt, job.source, job.url.pathname, job.priority);
      try {
        const response = await fetch(job.url, { ...job.options, signal: AbortSignal.timeout(12000) });
        requestRecord.status = response.status;
        requestRecord.durationMs = Date.now() - requestStartedAt;
        nextRequestAt = Date.now() + MIN_REST_GAP_MS;
        lastRestMeta = {
          retryAfter: response.headers.get('retry-after'),
          cfRay: response.headers.get('cf-ray'),
          server: response.headers.get('server'),
          contentType: response.headers.get('content-type')
        };
        const rawBody = await response.text().catch(() => '');
        let body = {};
        try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = {}; }
        lastRestMeta.responseCode = body.code ?? null;
        requestRecord.responseCode = lastRestMeta.responseCode;
        requestRecord.apiStatus = body.s || null;
        lastRestMeta.responseMessage = String(body.message || body.error || '').slice(0, 160) || null;
        console.info('[FYERS_REST] upstream response:', JSON.stringify({
          path: job.url.pathname, source: job.source, priority: job.priority,
          status: response.status, responseCode: lastRestMeta.responseCode,
          durationMs: requestRecord.durationMs,
          queueWaitMs: Math.max(0, requestStartedAt - job.enqueuedAt),
          ok: response.ok && body.s !== 'error' && !(Number(body.code) < 0)
        }));
        if (response.status === 429) {
          refreshRequestCounters(Date.now());
          lastRateLimitKind = classifyRestRateLimit({
            status: response.status, code: lastRestMeta.responseCode,
            server: lastRestMeta.server, cfRay: lastRestMeta.cfRay
          });
          let cooldownAttempt = 1;
          if (lastRateLimitKind === 'FYERS_PLAN_LIMIT') {
            rateLimitCountToday++;
            cooldownAttempt = rateLimitCountToday;
            cooldownUntil = getRateLimitCooldownUntil(Date.now(), lastRestMeta.retryAfter, cooldownAttempt);
          } else if (lastRateLimitKind === 'CLOUDFLARE_1015') {
            cloudflareRateLimitCountToday++;
            cooldownAttempt = cloudflareRateLimitCountToday;
            cooldownUntil = getCloudflareRateLimitCooldownUntil(Date.now(), lastRestMeta.retryAfter, cooldownAttempt);
          } else {
            unknownRateLimitCountToday++;
            cooldownAttempt = unknownRateLimitCountToday;
            cooldownUntil = getUnknownRateLimitCooldownUntil(Date.now(), lastRestMeta.retryAfter, cooldownAttempt);
          }
          recoveryProbeRequired = true;
          // The next single probe is permitted only after this cooldown expires.
          recoveryProbeAttempted = false;
          lastRestStatus = 'RATE_LIMITED';
          const markers = [
            lastRestMeta.retryAfter !== null ? 'Retry-After=' + lastRestMeta.retryAfter : null,
            lastRestMeta.responseMessage ? 'Message=' + lastRestMeta.responseMessage : null,
            lastRestMeta.cfRay ? 'CF-Ray=' + lastRestMeta.cfRay : null,
            lastRestMeta.server ? 'Server=' + lastRestMeta.server : null
          ].filter(Boolean).join(' · ');
          lastRateLimitAt = new Date().toISOString();
          const cooldownLabel = lastRateLimitKind === 'FYERS_PLAN_LIMIT'
            ? (rateLimitCountToday >= 4 ? 'FYERS plan-limit rest-of-IST-day block' : 'FYERS plan-limit backoff ' + rateLimitCountToday + '/3')
            : lastRateLimitKind === 'CLOUDFLARE_1015'
              ? 'Cloudflare 1015 backoff ' + cloudflareRateLimitCountToday
              : 'Unclassified HTTP 429 backoff ' + unknownRateLimitCountToday;
          lastRestError = 'Upstream HTTP 429 (' + lastRateLimitKind + '); ' + cooldownLabel +
            ' active until ' + new Date(cooldownUntil).toISOString() +
            ' (process-local cooldown; no durable store configured)' + (markers ? ' · ' + markers : '');
          const requestContext = buildRestRateLimitContext({
            requestRecord,
            requestSources: [...requestSourceStats.values()],
            recentRequests: recentUpstreamRequests
          });
          console.warn('[FYERS_REST] upstream rate limit:', JSON.stringify({
            path: lastRequestPath, status: response.status, at: lastRateLimitAt,
            rateLimitKind: lastRateLimitKind, retryAfter: lastRestMeta.retryAfter,
            responseCode: lastRestMeta.responseCode, responseMessage: lastRestMeta.responseMessage,
            cfRay: lastRestMeta.cfRay, server: lastRestMeta.server,
            requestsThisMinute, requestsToday, rateLimitCountToday,
            cloudflareRateLimitCountToday, unknownRateLimitCountToday,
            ...requestContext,
            cooldownUntil: new Date(cooldownUntil).toISOString()
          }));
          settleRestJob(job, false, new Error(lastRestError));
          const queuedError = new Error('FYERS REST cooldown active; queued request was not sent upstream');
          for (const pending of restQueue.splice(0)) settleRestJob(pending, false, queuedError);
          break;
        }
        if (!response.ok || body.s === 'error' || Number(body.code) < 0 || (recoveryProbeRequired && body.s !== 'ok')) {
          lastRestStatus = 'ERROR';
          lastRestError = String(body.message || body.error || `FYERS HTTP ${response.status}`).slice(0, 180);
          settleRestJob(job, false, new Error(lastRestError));
          continue;
        }
        lastRestStatus = 'OK';
        lastRestError = null;
        recoveryProbeRequired = false;
        recoveryProbeAttempted = false;
        settleRestJob(job, true, body);
      } catch (error) {
        requestRecord.status = 'NETWORK_ERROR';
        requestRecord.durationMs = Date.now() - requestStartedAt;
        requestRecord.error = String(error?.message || 'FYERS REST request failed').slice(0,100);
        nextRequestAt = Date.now() + MIN_REST_GAP_MS;
        lastRestStatus = 'ERROR';
        lastRestError = String(error?.message || 'FYERS REST request failed').slice(0,180);
        settleRestJob(job, false, error);
      }
    }
  } finally {
    drainingRestQueue = false;
    if (restQueue.length && !isRestCooldownActive(Date.now(), cooldownUntil)) void drainRestQueue();
  }
}
function scheduledFetch(url, options, priority = 0, source = 'UNCLASSIFIED') {
  return new Promise((resolve, reject) => {
    const normalizedPriority = Number(priority) || 0;
    const requestMethod=String(options?.method||'GET').toUpperCase();
    const authorization=new Headers(options?.headers||{}).get('authorization')||'';
    const coalesceKey=buildRestCoalesceKey({method:requestMethod,url:url.href,authorization});
    const duplicateIndex = findRestQueueDuplicate(restQueue, coalesceKey);
    if (duplicateIndex >= 0) {
      const existing = restQueue[duplicateIndex];
      existing.waiters.push({ resolve, reject });
      if (normalizedPriority > existing.priority) {
        existing.priority = normalizedPriority;
        existing.source = String(source || existing.source);
        existing.maxQueueAgeMs = Math.min(existing.maxQueueAgeMs, getRestQueueMaxAgeMs(normalizedPriority));
      }
      return;
    }
    const inFlight = inFlightRestJobs.get(coalesceKey);
    if (inFlight) {
      inFlight.waiters.push({ resolve, reject });
      return;
    }
    const job = { url, options, priority: normalizedPriority, source:String(source || 'UNCLASSIFIED'), sequence: ++restQueueSequence, enqueuedAt:Date.now(), maxQueueAgeMs:getRestQueueMaxAgeMs(normalizedPriority), coalesceKey, waiters:[], resolve, reject };
    const admission = admitRestJob(restQueue, job, MAX_REST_QUEUE_SIZE);
    if (!admission.accepted) {
      reject(new Error('FYERS REST queue is full; request was rejected before upstream submission'));
      return;
    }
    restQueue.splice(0, restQueue.length, ...admission.queue);
    // A sleeping drain loop must re-evaluate priorities when a new interactive job arrives.
    restQueueWakeSignal.wake();
    if (admission.dropped) {
      settleRestJob(admission.dropped, false, new Error('FYERS REST queue capacity reached; lower-priority request was displaced before upstream submission'));
    }
    void drainRestQueue();
  });
}
async function fyersGet(base, path, params = {}, priority = 0, source = 'UNCLASSIFIED') {
  const token = getAccessTokenForServer();
  const appId = process.env.FYERS_APP_ID?.trim();
  if (!token || !appId) throw new Error('FYERS authentication is not active in this server process');
  if (Date.now() < cooldownUntil) throw new Error('FYERS REST cooldown active; no upstream request was sent');
  const url = buildFyersUrl(base, path, params);
  return scheduledFetch(url, { method: 'GET', headers: { Authorization: `${appId}:${token}`, Accept: 'application/json' } }, priority, source);
}
export function buildFyersUrl(base, path, params = {}) {
  const url = new URL(path.replace(/^\/+/, ''), base.endsWith('/') ? base : base + '/');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}
function istDate(now = Date.now()) { return new Date(now + 19800000).toISOString().slice(0, 10); }

// A 10-calendar-day verified FYERS window supplies enough contiguous completed
// 5-minute candles for EMA50/pattern research from the opening part of the session.
// Session gaps are validated by the strategy engine; no synthetic candles are added.
export function getFiveMinuteCacheValidUntil(now = Date.now(), settleMs = 2000) {
  const current = Number(now);
  const nextCompletedBucket = (Math.floor(current / 300_000) + 1) * 300_000;
  return nextCompletedBucket + Math.max(0, Number(settleMs) || 0);
}

export function getFiveMinuteHistoryRange(now = Date.now(), lookbackDays = 10) {
  const days = Math.max(2, Math.floor(Number(lookbackDays) || 10));
  return {
    from: new Date(now - days * 86400000 + 19800000).toISOString().slice(0, 10),
    to: istDate(now)
  };
}

const fiveMinuteCache = new Map();

// Scanner and chart share one verified 5-minute cache and one FYERS history read.
// The shared payload retains the chart's last-ten-NSE-session candle set, which
// gives scanner research more complete real sessions without synthetic candles.
export async function getFiveMinuteHistory(symbol, now = Date.now(), priority = REST_PRIORITY.CHART, source = 'chart-history') {
  if (!validateHistorySymbol(symbol)) throw new Error('A supported NSE/BSE index or NSE symbol is required');
  return getFiveMinuteSessionHistory(symbol, now, priority, source);
}
// Chart history is the latest ten verified NSE trading sessions. Request a
// 20-calendar-day window so weekends and exchange holidays do not reduce the
// number of displayed sessions; retain only real completed FYERS candles.
export function filterLastNseTradingSessions(candles, sessionCount = 10) {
  const valid = Array.isArray(candles) ? candles : [];
  const sessionDates = [...new Set(valid.map(candle =>
    new Date((Number(candle.time) + 19800) * 1000).toISOString().slice(0, 10)
  ))].sort();
  const keep = new Set(sessionDates.slice(-Math.max(1, Math.floor(Number(sessionCount) || 10))));
  return valid.filter(candle => keep.has(
    new Date((Number(candle.time) + 19800) * 1000).toISOString().slice(0, 10)
  ));
}
// Retain the one-session filter as a compatibility utility for existing callers/tests;
// the chart endpoint now uses filterLastNseTradingSessions for its ten-day view.
export function filterFiveMinuteCandlesToNseSession(candles, now = Date.now()) {
  const sessionStart = Math.floor((now / 1000 + 19800) / 86400) * 86400 - 19800;
  return (Array.isArray(candles) ? candles : []).filter(candle => Number(candle?.time) >= sessionStart);
}
export async function getFiveMinuteSessionHistory(symbol, now = Date.now(), priority = 50, source = 'chart-history') {
  if (!validateHistorySymbol(symbol)) throw new Error('A supported NSE/BSE index or NSE symbol is required');
  return runHistoryRequestOnce('5m:' + symbol, async () => {
    const date = istDate(now);
    const cached = fiveMinuteCache.get(symbol);
    if (cached && cached.sessionDate === date && now < cached.validUntil) return cached.value;
    const range = getFiveMinuteHistoryRange(now, 20);
    const body = await fyersGet(DATA_BASE, '/history', {
      symbol, resolution: '5', date_format: '1', range_from: range.from, range_to: range.to
    }, priority, source);
    if (body.s !== 'ok' || !Array.isArray(body.candles)) throw new Error('FYERS did not return verified ten-session 5-minute history');
    const candles = filterLastNseTradingSessions(normalizeFiveMinuteCandles(body.candles, now), 10);
    if (!candles.length) throw new Error('No completed FYERS 5-minute candles are available for the last ten NSE sessions');
    const sessions = [...new Set(candles.map(candle => new Date((candle.time + 19800) * 1000).toISOString().slice(0, 10)))];
    const value = { symbol, resolution: '5', sessionDate: date, candles, count: candles.length, sessions, sessionCount: sessions.length, source: 'FYERS_VERIFIED_5M_HISTORY', range: 'LAST_10_NSE_TRADING_SESSIONS', actionable: true };
    fiveMinuteCache.set(symbol, { savedAt: now, validUntil:getFiveMinuteCacheValidUntil(now), sessionDate: date, value });
    return value;
  });
}

export function normalizeFifteenMinuteCandles(rows, now = Date.now()) {
  if (!Array.isArray(rows)) return [];
  const currentBucket = Math.floor((now / 1000) / 900) * 900;
  const seen = new Set();
  return rows.map(row => {
    if (!Array.isArray(row) || row.length < 6) return null;
    const [time,open,high,low,close,volume]=row.map(Number);
    if (![time,open,high,low,close,volume].every(Number.isFinite) || time<=0 || open<=0 ||
        high<Math.max(open,close,low) || low>Math.min(open,close) || close<=0 || volume<0 ||
        time>=currentBucket || seen.has(time)) return null;
    const ist=new Date((time+19800)*1000),minute=ist.getUTCHours()*60+ist.getUTCMinutes();
    if(minute<555||minute>=930||((minute-555)%15)!==0)return null;
    seen.add(time);
    return {time,open,high,low,close,volume,completed:true,source:'FYERS_HISTORY_15M'};
  }).filter(Boolean).sort((a,b)=>a.time-b.time);
}
const fifteenMinuteCache = new Map();
export async function getFifteenMinuteHistory(symbol, now = Date.now(), priority = REST_PRIORITY.WARMUP, source = 'fifteen-minute-research') {
  if (!validateNseSymbol(symbol)) throw new Error('A valid NSE equity/F&O underlying symbol is required for 15-minute research');
  return runHistoryRequestOnce('15m:' + symbol, async () => {
    const cached=fifteenMinuteCache.get(symbol);
    if(cached&&now-cached.savedAt<30*60*1000)return cached.value;
    const to=istDate(now);
    const from=new Date(now-45*86400000+19800000).toISOString().slice(0,10);
    const body=await fyersGet(DATA_BASE,'/history',{symbol,resolution:'15',date_format:'1',range_from:from,range_to:to},priority,source);
    if(body.s!=='ok'||!Array.isArray(body.candles))throw new Error('FYERS did not return verified 15-minute research candles');
    const candles=normalizeFifteenMinuteCandles(body.candles,now);
    if(candles.length<50)throw new Error('Insufficient completed FYERS 15-minute candles for research');
    const value={symbol,resolution:'15',candles,count:candles.length,source:'FYERS_HISTORY_15M'};
    fifteenMinuteCache.set(symbol,{savedAt:now,value});
    return value;
  });
}
export async function getFyersQuotes(symbols, source = 'quotes-panel') {
  if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > 50 || !symbols.every(validateNseSymbol)) {
    throw new Error('Quotes require 1 to 50 valid NSE symbols per request');
  }
  return fyersGet(DATA_BASE, '/quotes', { symbols: symbols.join(',') }, REST_PRIORITY.INTERACTIVE, source);
}
export function normalizeDailyCandles(rows, now = Date.now()) {
  if (!Array.isArray(rows)) return [];
  // FYERS may include today's still-forming daily candle. Research must use
  // completed sessions only, with the trading-day boundary interpreted in IST.
  const todayStartIstEpoch = Math.floor((now / 1000 + 19800) / 86400) * 86400 - 19800;
  const seen = new Set();
  return rows.map(row => {
    if (!Array.isArray(row) || row.length < 6) return null;
    const [time,open,high,low,close,volume] = row.map(Number);
    if (![time,open,high,low,close,volume].every(Number.isFinite) ||
        time <= 0 || time >= todayStartIstEpoch || time > now / 1000 ||
        open <= 0 || close <= 0 || high < Math.max(open,close,low) ||
        low > Math.min(open,close) || volume < 0 || seen.has(time)) return null;
    seen.add(time);
    return {time,open,high,low,close,volume,completed:true,source:'FYERS_DAILY_HISTORY'};
  }).filter(Boolean).sort((a,b)=>a.time-b.time);
}
const dailyCache = new Map();
export async function getDailyHistory(symbol, now = Date.now(), priority = REST_PRIORITY.WARMUP, source = 'daily-research') {
  if (!validateNseSymbol(symbol)) throw new Error('A valid NSE symbol is required');
  return runHistoryRequestOnce('1d:' + symbol, async () => {
    const cached = dailyCache.get(symbol);
    if (cached && now - cached.savedAt < 30 * 60 * 1000) return cached.value;
    const to = istDate(now);
    const from = new Date(now - 180 * 86400000 + 19800000).toISOString().slice(0,10);
    const body = await fyersGet(DATA_BASE, '/history', { symbol, resolution: 'D', date_format: '1', range_from: from, range_to: to }, priority, source);
    if (body.s !== 'ok' || !Array.isArray(body.candles)) throw new Error('FYERS did not return verified daily candles');
    const candles = normalizeDailyCandles(body.candles, now);
    if (candles.length < 50) throw new Error('Insufficient completed FYERS daily candles for research');
    const value={symbol,candles,count:candles.length,source:'FYERS_DAILY_HISTORY'};
    dailyCache.set(symbol,{savedAt:now,value});
    return value;
  });
}
export async function getFyersOptionChain(symbol, strikecount = 10, timestamp = '', source = 'option-chain') {
  if (!validateNseSymbol(symbol)) throw new Error('A valid NSE underlying symbol is required');
  const count = Number(strikecount);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('Option-chain strike count must be from 1 to 50');
  return fyersGet(DATA_BASE, '/options-chain-v3', { symbol, strikecount: count, timestamp, greeks: '0' }, REST_PRIORITY.OPTION_CHAIN, source);
}
export async function getFyersPositions() { return fyersGet(API_BASE, '/positions', {}, REST_PRIORITY.ACCOUNT, 'account-positions'); }
export async function getFyersOrderbook() { return fyersGet(API_BASE, '/orders', {}, REST_PRIORITY.ACCOUNT, 'account-orderbook'); }
export function getRestDispatchReadiness(priority = REST_PRIORITY.SCANNER, path = '/history', now = Date.now()) {
  const background = Number(priority) < REST_PRIORITY.CHART;
  const recoveryProbeAllowed = canRunRestRecoveryProbe({ recoveryProbeRequired, recoveryProbeAttempted, priority });
  return buildRestDispatchGate({
    cooldownActive: isRestCooldownActive(now, cooldownUntil),
    recoveryProbeRequired,
    recoveryProbeAllowed,
    priority,
    queueDepth: restQueue.length + (drainingRestQueue ? 1 : 0),
    minGapWaitMs: getRestWaitMs(now, nextRequestAt),
    totalWindowWaitMs: getRestRequestWindowWaitMs(recentUpstreamRequests, now, 6),
    backgroundWindowWaitMs: background
      ? getRestRequestWindowWaitMs(recentUpstreamRequests, now, 3, 60_000, Number.NEGATIVE_INFINITY, REST_PRIORITY.CHART - 1)
      : 0,
    historyWindowWaitMs: path === '/history'
      ? Math.max(
          getHistoryRequestWindowWaitMs(recentUpstreamRequests, now, 8),
          background ? getHistoryRequestWindowWaitMs(recentUpstreamRequests, now, 4, 60_000, Number.NEGATIVE_INFINITY, REST_PRIORITY.CHART - 1) : 0
        )
      : 0
  });
}

export function getRestSafetyState(now = Date.now()) {
  return {
    cooldownUntil: cooldownUntil > now ? cooldownUntil : null,
    rateLimitDayKey,
    rateLimitCountToday,
    cloudflareRateLimitCountToday,
    unknownRateLimitCountToday,
    lastRateLimitAt,
    lastRateLimitKind
  };
}

// Restore only a future, bounded cooldown. A stale browser cookie can never
// shorten a cooldown already known by this process; daily counters restore only
// when their IST date matches the current session date.
export function restoreRestSafetyState(state, now = Date.now()) {
  if (!state || typeof state !== 'object') return false;
  const currentDay = istDayKey(now);
  if (state.rateLimitDayKey === currentDay) {
    rateLimitDayKey = currentDay;
    rateLimitCountToday = Math.max(rateLimitCountToday, Math.floor(Number(state.rateLimitCountToday) || 0));
    cloudflareRateLimitCountToday = Math.max(cloudflareRateLimitCountToday, Math.floor(Number(state.cloudflareRateLimitCountToday) || 0));
    unknownRateLimitCountToday = Math.max(unknownRateLimitCountToday, Math.floor(Number(state.unknownRateLimitCountToday) || 0));
  }
  if (typeof state.lastRateLimitAt === 'string' && Number.isFinite(Date.parse(state.lastRateLimitAt))) {
    lastRateLimitAt = state.lastRateLimitAt;
  }
  if (typeof state.lastRateLimitKind === 'string') lastRateLimitKind = state.lastRateLimitKind;
  const restoredUntil = Number(state.cooldownUntil);
  if (!Number.isFinite(restoredUntil) || restoredUntil <= now || restoredUntil > now + 30 * 24 * 60 * 60 * 1000) return false;
  cooldownUntil = Math.max(cooldownUntil, restoredUntil);
  recoveryProbeRequired = true;
  recoveryProbeAttempted = false;
  lastRestStatus = 'RATE_LIMITED';
  lastRestError = 'Restored encrypted FYERS REST cooldown from authenticated browser session until ' + new Date(cooldownUntil).toISOString();
  return true;
}

export function getRestDiagnostics(now = Date.now()) {
  refreshRequestCounters(now);
  return {
    status: lastRestStatus,
    lastError: lastRestError,
    upstream: { ...lastRestMeta },
    lastRequestPath,
    lastRequestSource,
    requestSources:[...requestSourceStats.values()].map(item=>({...item})).sort((a,b)=>b.requestsToday-a.requestsToday),
    recentRequests:recentUpstreamRequests.slice(-20).map(item=>({...item})),
    endpointHealth: buildRestEndpointHealth(recentUpstreamRequests, now),
    lastRateLimitAt,
    minGapMs: MIN_REST_GAP_MS,
    rollingWindowLimitPerMinute: 6,
    backgroundRollingWindowLimitPerMinute: 3,
    rollingWindowScope: 'ALL_FYERS_REST_ENDPOINTS_PROCESS_LOCAL',
    queueDepth: restQueue.length,
    queueCapacity: MAX_REST_QUEUE_SIZE,
    interactiveQueueDepth: restQueue.filter(job => job.priority >= 50).length,
    standardQueueDepth: restQueue.filter(job => job.priority >= 0 && job.priority < 50).length,
    backgroundQueueDepth: restQueue.filter(job => job.priority < 0).length,
    queueDrainActive: drainingRestQueue,
    lastRequestPriority,
    requestsThisMinute,
    requestsToday,
    requestCountersScope: 'PROCESS_LOCAL',
    rateLimitCountToday,
    cloudflareRateLimitCountToday,
    unknownRateLimitCountToday,
    lastRateLimitKind,
    cooldownStrategy: 'FYERS_PLAN_LIMIT_60S_120S_240S_THEN_IST_DAY_BLOCK; CLOUDFLARE_1015_30S_EXPONENTIAL; UNKNOWN_429_BOUNDED',
    cooldownActive: now < cooldownUntil,
    recoveryProbeRequired,
    recoveryProbeAttempted,
    recoveryProbePolicy: 'ONE_PROBE_PER_START_OR_429_COOLDOWN; FAILED_PROBE_REQUIRES_OPERATOR_RESTART',
    cooldownUntil: cooldownUntil > now ? cooldownUntil : null,
    cooldownPersistence: 'ENCRYPTED_AUTHENTICATED_BROWSER_COOKIE_PER_SESSION',
    restartSafe: false,
    restartSafeScope: 'BROWSER_SESSION_ONLY_NOT_SHARED_ACROSS_CLIENTS'
  };
}

// Scanner cache accessors expose only FYERS history already fetched through the
// shared 4-second REST scheduler; they never trigger extra upstream requests.
export function getCachedResearchHistories() {
  return {
    fiveMinute: new Map([...fiveMinuteCache].map(([symbol, entry]) => [symbol, entry.value])),
    daily: new Map([...dailyCache].map(([symbol, entry]) => [symbol, entry.value])),
    fifteenMinute: new Map([...fifteenMinuteCache].map(([symbol, entry]) => [symbol, entry.value]))
  };
}


function istDateFromEpochSeconds(seconds) {
  return new Date((Number(seconds) + 19800000) * 1000).toISOString().slice(0, 10);
}

/**
 * Fetch a bounded historical backtest dataset from FYERS /data/history.
 * Intraday and daily windows are separate because FYERS documents different
 * per-request limits (100 days intraday, 366 days daily).
 */
export function validateHistoricalBacktestRange({ startTime, dailyStartTime, endTime } = {}) {
  const start = Number(startTime);
  const dailyStart = Number(dailyStartTime);
  const end = Number(endTime);
  if (![start, dailyStart, end].every(Number.isFinite) || dailyStart <= 0 || start <= 0 || end <= start || dailyStart > start) {
    throw new Error('Historical backtest date range is invalid');
  }
  const intradayDays = (end - start) / 86400;
  const dailyDays = (end - dailyStart) / 86400;
  if (intradayDays > 100 || dailyDays > 366) {
    throw new Error('Requested FYERS history range exceeds documented per-request limits');
  }
  return { intradayDays, dailyDays };
}

export async function getHistoricalBacktestHistory({
  symbol,
  startTime,
  dailyStartTime,
  endTime,
  priority = REST_PRIORITY.RESEARCH,
  source = 'historical-backtest'
} = {}) {
  if (!validateNseSymbol(symbol)) throw new Error('Historical backtest requires a valid NSE equity symbol');
  const start = Number(startTime);
  const dailyStart = Number(dailyStartTime);
  const end = Number(endTime);
  validateHistoricalBacktestRange({ startTime: start, dailyStartTime: dailyStart, endTime: end });
  const from5m = istDateFromEpochSeconds(start);
  const fromDaily = istDateFromEpochSeconds(dailyStart);
  const to = istDateFromEpochSeconds(end);
  const [fiveMinuteBody, dailyBody] = await Promise.all([
    fyersGet(DATA_BASE, '/history', {
      symbol, resolution: '5', date_format: '1', range_from: from5m, range_to: to
    }, priority, source + '-5m'),
    fyersGet(DATA_BASE, '/history', {
      symbol, resolution: 'D', date_format: '1', range_from: fromDaily, range_to: to
    }, priority, source + '-daily')
  ]);
  if (fiveMinuteBody.s !== 'ok' || !Array.isArray(fiveMinuteBody.candles)) {
    throw new Error('FYERS did not return a successful 5-minute historical response');
  }
  if (dailyBody.s !== 'ok' || !Array.isArray(dailyBody.candles)) {
    throw new Error('FYERS did not return a successful daily historical response');
  }
  const endMs = end * 1000;
  const fiveMinuteCandles = normalizeFiveMinuteCandles(fiveMinuteBody.candles, endMs)
    .filter(candle => candle.time >= start && candle.time <= end);
  const dailyCandles = normalizeDailyCandles(dailyBody.candles, endMs)
    .filter(candle => candle.time >= dailyStart && candle.time <= end);
  if (!fiveMinuteCandles.length) throw new Error('FYERS returned no completed 5-minute candles for the requested backtest range');
  if (dailyCandles.length < 50) throw new Error('FYERS returned fewer than 50 completed daily warm-up candles');
  return {
    symbol,
    fiveMinuteCandles,
    dailyCandles,
    dataProvenance: 'FYERS_HISTORICAL_API',
    sources: ['FYERS_HISTORY_5M', 'FYERS_DAILY_HISTORY'],
    requested: { fiveMinuteFrom: from5m, dailyFrom: fromDaily, to },
    retrievedAt: new Date().toISOString()
  };
}
