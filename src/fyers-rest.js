import { getAccessTokenForServer } from './fyers-auth.js';
import { getRestWaitMs, isRestCooldownActive, getRateLimitCooldownUntil } from './rest-scheduler-utils.js';

const DATA_BASE = 'https://api-t1.fyers.in/data';
const API_BASE = 'https://api-t1.fyers.in/api/v3';
const MIN_REST_GAP_MS = 4000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
let nextRequestAt = 0;
let cooldownUntil = 0;
const restQueue = [];
let restQueueSequence = 0;
let drainingRestQueue = false;
let lastRestStatus = 'IDLE';
let lastRestError = null;
let lastRestMeta = { retryAfter: null, cfRay: null, server: null, contentType: null };
let lastRequestPath = null;
let lastRateLimitAt = null;

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
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function drainRestQueue() {
  if (drainingRestQueue) return;
  drainingRestQueue = true;
  try {
    while (restQueue.length) {
      if (isRestCooldownActive(Date.now(), cooldownUntil)) {
        const error = new Error('FYERS REST cooldown active; queued request was not sent upstream');
        for (const job of restQueue.splice(0)) job.reject(error);
        lastRestStatus = 'RATE_LIMITED';
        break;
      }
      restQueue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      const delay = getRestWaitMs(Date.now(), nextRequestAt);
      if (delay) await wait(delay);
      if (isRestCooldownActive(Date.now(), cooldownUntil)) {
        const error = new Error('FYERS REST cooldown active; queued request was not sent upstream');
        for (const job of restQueue.splice(0)) job.reject(error);
        lastRestStatus = 'RATE_LIMITED';
        break;
      }
      restQueue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      const job = restQueue.shift();
      if (!job) continue;
      lastRequestPath = job.url.pathname;
      try {
        const response = await fetch(job.url, { ...job.options, signal: AbortSignal.timeout(12000) });
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
        if (response.status === 429) {
          cooldownUntil = getRateLimitCooldownUntil(Date.now(), lastRestMeta.retryAfter, RATE_LIMIT_COOLDOWN_MS);
          lastRestStatus = 'RATE_LIMITED';
          const markers = [lastRestMeta.retryAfter ? 'Retry-After=' + lastRestMeta.retryAfter : null, lastRestMeta.cfRay ? 'CF-Ray=' + lastRestMeta.cfRay : null, lastRestMeta.server ? 'Server=' + lastRestMeta.server : null].filter(Boolean).join(' · ');
          lastRateLimitAt = new Date().toISOString();
          lastRestError = 'FYERS HTTP 429; REST cooldown active until ' + new Date(cooldownUntil).toISOString() + ' (process-local; restart persistence requires durable storage)' + (markers ? ' · ' + markers : '');
          console.warn('[FYERS_REST] upstream rate limit:', JSON.stringify({
            path: lastRequestPath, status: response.status, at: lastRateLimitAt,
            retryAfter: lastRestMeta.retryAfter, cfRay: lastRestMeta.cfRay,
            server: lastRestMeta.server, contentType: lastRestMeta.contentType
          }));
          job.reject(new Error(lastRestError));
          const queuedError = new Error('FYERS REST cooldown active; queued request was not sent upstream');
          for (const pending of restQueue.splice(0)) pending.reject(queuedError);
          break;
        }
        if (!response.ok || body.s === 'error' || Number(body.code) < 0) {
          lastRestStatus = 'ERROR';
          lastRestError = String(body.message || body.error || `FYERS HTTP ${response.status}`).slice(0, 180);
          job.reject(new Error(lastRestError));
          continue;
        }
        lastRestStatus = 'OK';
        lastRestError = null;
        job.resolve(body);
      } catch (error) {
        nextRequestAt = Date.now() + MIN_REST_GAP_MS;
        lastRestStatus = 'ERROR';
        lastRestError = String(error?.message || 'FYERS REST request failed').slice(0,180);
        job.reject(error);
      }
    }
  } finally {
    drainingRestQueue = false;
    if (restQueue.length && !isRestCooldownActive(Date.now(), cooldownUntil)) void drainRestQueue();
  }
}
function scheduledFetch(url, options, priority = 0) {
  return new Promise((resolve, reject) => {
    restQueue.push({ url, options, priority: Number(priority) || 0, sequence: ++restQueueSequence, resolve, reject });
    void drainRestQueue();
  });
}
async function fyersGet(base, path, params = {}, priority = 0) {
  const token = getAccessTokenForServer();
  const appId = process.env.FYERS_APP_ID?.trim();
  if (!token || !appId) throw new Error('FYERS authentication is not active in this server process');
  if (Date.now() < cooldownUntil) throw new Error('FYERS REST cooldown active; no upstream request was sent');
  const url = buildFyersUrl(base, path, params);
  return scheduledFetch(url, { method: 'GET', headers: { Authorization: `${appId}:${token}`, Accept: 'application/json' } }, priority);
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
export function getFiveMinuteHistoryRange(now = Date.now(), lookbackDays = 10) {
  const days = Math.max(2, Math.floor(Number(lookbackDays) || 10));
  return {
    from: new Date(now - days * 86400000 + 19800000).toISOString().slice(0, 10),
    to: istDate(now)
  };
}

const fiveMinuteCache = new Map();
export async function getFiveMinuteHistory(symbol, now = Date.now(), priority = 0) {
  if (!validateHistorySymbol(symbol)) throw new Error('A supported NSE/BSE index or NSE symbol is required');
  const date = istDate(now);
  const cached = fiveMinuteCache.get(symbol);
  if (cached && cached.sessionDate === date && now - cached.savedAt < 20_000) return cached.value;
  const range = getFiveMinuteHistoryRange(now);
  const body = await fyersGet(DATA_BASE, '/history', {
    symbol, resolution: '5', date_format: '1', range_from: range.from, range_to: range.to
  }, priority);
  if (body.s !== 'ok' || !Array.isArray(body.candles)) throw new Error('FYERS did not return verified historical candles');
  const candles = normalizeFiveMinuteCandles(body.candles, now);
  if (!candles.length) throw new Error('No completed FYERS 5-minute candles are available for the NSE session');
  const value = { symbol, resolution: '5', sessionDate: date, candles, count: candles.length, source: 'FYERS_HISTORY', actionable: true };
  fiveMinuteCache.set(symbol, { savedAt: now, sessionDate: date, value });
  return value;
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
const fiveMinuteSessionCache = new Map();
export async function getFiveMinuteSessionHistory(symbol, now = Date.now()) {
  if (!validateHistorySymbol(symbol)) throw new Error('A supported NSE/BSE index or NSE symbol is required');
  const date = istDate(now);
  const cached = fiveMinuteSessionCache.get(symbol);
  if (cached && cached.sessionDate === date && now - cached.savedAt < 20_000) return cached.value;
  const range = getFiveMinuteHistoryRange(now, 20);
  const body = await fyersGet(DATA_BASE, '/history', {
    symbol, resolution: '5', date_format: '1', range_from: range.from, range_to: range.to
  });
  if (body.s !== 'ok' || !Array.isArray(body.candles)) throw new Error('FYERS did not return verified ten-session 5-minute history');
  const candles = filterLastNseTradingSessions(normalizeFiveMinuteCandles(body.candles, now), 10);
  if (!candles.length) throw new Error('No completed FYERS 5-minute candles are available for the last ten NSE sessions');
  const sessions = [...new Set(candles.map(candle => new Date((candle.time + 19800) * 1000).toISOString().slice(0, 10)))];
  const value = { symbol, resolution: '5', sessionDate: date, candles, count: candles.length, sessions, sessionCount: sessions.length, source: 'FYERS_VERIFIED_5M_HISTORY', range: 'LAST_10_NSE_TRADING_SESSIONS', actionable: true };
  fiveMinuteSessionCache.set(symbol, { savedAt: now, sessionDate: date, value });
  return value;
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
export async function getFifteenMinuteHistory(symbol, now = Date.now(), priority = -10) {
  if (!validateNseSymbol(symbol)) throw new Error('A valid NSE equity/F&O underlying symbol is required for 15-minute research');
  const cached=fifteenMinuteCache.get(symbol);
  if(cached&&now-cached.savedAt<30*60*1000)return cached.value;
  const to=istDate(now);
  const from=new Date(now-45*86400000+19800000).toISOString().slice(0,10);
  const body=await fyersGet(DATA_BASE,'/history',{symbol,resolution:'15',date_format:'1',range_from:from,range_to:to},priority);
  if(body.s!=='ok'||!Array.isArray(body.candles))throw new Error('FYERS did not return verified 15-minute research candles');
  const candles=normalizeFifteenMinuteCandles(body.candles,now);
  if(candles.length<50)throw new Error('Insufficient completed FYERS 15-minute candles for research');
  const value={symbol,resolution:'15',candles,count:candles.length,source:'FYERS_HISTORY_15M'};
  fifteenMinuteCache.set(symbol,{savedAt:now,value});
  return value;
}
export async function getFyersQuotes(symbols) {
  if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > 50 || !symbols.every(validateNseSymbol)) {
    throw new Error('Quotes require 1 to 50 valid NSE symbols per request');
  }
  return fyersGet(DATA_BASE, '/quotes', { symbols: symbols.join(',') });
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
export async function getDailyHistory(symbol, now = Date.now(), priority = -10) {
  if (!validateNseSymbol(symbol)) throw new Error('A valid NSE symbol is required');
  const cached = dailyCache.get(symbol);
  if (cached && now - cached.savedAt < 30 * 60 * 1000) return cached.value;
  const to = istDate(now);
  const from = new Date(now - 180 * 86400000 + 19800000).toISOString().slice(0,10);
  const body = await fyersGet(DATA_BASE, '/history', { symbol, resolution: 'D', date_format: '1', range_from: from, range_to: to }, priority);
  if (body.s !== 'ok' || !Array.isArray(body.candles)) throw new Error('FYERS did not return verified daily candles');
  const candles = normalizeDailyCandles(body.candles, now);
  if (candles.length < 50) throw new Error('Insufficient completed FYERS daily candles for research');
  const value={symbol,candles,count:candles.length,source:'FYERS_DAILY_HISTORY'};
  dailyCache.set(symbol,{savedAt:now,value});
  return value;
}
export async function getFyersOptionChain(symbol, strikecount = 10, timestamp = '') {
  if (!validateNseSymbol(symbol)) throw new Error('A valid NSE underlying symbol is required');
  const count = Number(strikecount);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('Option-chain strike count must be from 1 to 50');
  return fyersGet(DATA_BASE, '/options-chain-v3', { symbol, strikecount: count, timestamp, greeks: '0' }, 100);
}
export async function getFyersPositions() { return fyersGet(API_BASE, '/positions'); }
export async function getFyersOrderbook() { return fyersGet(API_BASE, '/orders'); }
export function getRestDiagnostics(now = Date.now()) {
  return {
    status: lastRestStatus,
    lastError: lastRestError,
    upstream: { ...lastRestMeta },
    lastRequestPath,
    lastRateLimitAt,
    minGapMs: MIN_REST_GAP_MS,
    cooldownActive: now < cooldownUntil,
    cooldownUntil: cooldownUntil > now ? cooldownUntil : null,
    cooldownPersistence: 'PROCESS_LOCAL_ONLY',
    restartSafe: false
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
