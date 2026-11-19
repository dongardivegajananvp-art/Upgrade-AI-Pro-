import { getAccessTokenForServer } from './fyers-auth.js';

const DATA_BASE = 'https://api-t1.fyers.in/data';
const API_BASE = 'https://api-t1.fyers.in/api/v3';
const MIN_REST_GAP_MS = 4000;
const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
let nextRequestAt = 0;
let cooldownUntil = 0;
let queue = Promise.resolve();
let lastRestStatus = 'IDLE';
let lastRestError = null;

export function validateNseSymbol(symbol) {
  return typeof symbol === 'string' && /^NSE:[A-Z0-9&._-]{1,48}$/.test(symbol);
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
    if (minute < 555 || minute >= 930 || time >= currentBucket || seen.has(time)) return null;
    seen.add(time);
    return { time, open, high, low, close, volume, completed: true, source: 'FYERS_HISTORY' };
  }).filter(Boolean).sort((a, b) => a.time - b.time);
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function scheduledFetch(url, options) {
  const run = queue.then(async () => {
    const now = Date.now();
    const delay = Math.max(0, nextRequestAt - now, cooldownUntil - now);
    if (delay) await wait(delay);
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
    nextRequestAt = Date.now() + MIN_REST_GAP_MS;
    if (response.status === 429) {
      cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
      lastRestStatus = 'RATE_LIMITED';
      lastRestError = 'FYERS HTTP 429; one-hour REST cooldown active';
      throw new Error(lastRestError);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.s === 'error' || (Number(body.code) < 0)) {
      lastRestStatus = 'ERROR';
      lastRestError = String(body.message || body.error || `FYERS HTTP ${response.status}`).slice(0, 180);
      throw new Error(lastRestError);
    }
    lastRestStatus = 'OK';
    lastRestError = null;
    return body;
  });
  queue = run.catch(() => {});
  return run;
}
async function fyersGet(base, path, params = {}) {
  const token = getAccessTokenForServer();
  const appId = process.env.FYERS_APP_ID?.trim();
  if (!token || !appId) throw new Error('FYERS authentication is not active in this server process');
  if (Date.now() < cooldownUntil) throw new Error('FYERS REST cooldown active; no upstream request was sent');
  const url = buildFyersUrl(base, path, params);
  return scheduledFetch(url, { method: 'GET', headers: { Authorization: `${appId}:${token}`, Accept: 'application/json' } });
}
export function buildFyersUrl(base, path, params = {}) {
  const url = new URL(path.replace(/^\/+/, ''), base.endsWith('/') ? base : base + '/');
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}
function istDate(now = Date.now()) { return new Date(now + 19800000).toISOString().slice(0, 10); }

export async function getFiveMinuteHistory(symbol, now = Date.now()) {
  if (!validateNseSymbol(symbol)) throw new Error('A valid NSE symbol is required');
  const date = istDate(now);
  const body = await fyersGet(DATA_BASE, '/history', {
    symbol, resolution: '5', date_format: '1', range_from: date, range_to: date
  });
  if (body.s !== 'ok' || !Array.isArray(body.candles)) throw new Error('FYERS did not return verified historical candles');
  const candles = normalizeFiveMinuteCandles(body.candles, now);
  if (!candles.length) throw new Error('No completed FYERS 5-minute candles are available for the NSE session');
  return { symbol, resolution: '5', sessionDate: date, candles, count: candles.length, source: 'FYERS_HISTORY', actionable: true };
}
export async function getFyersQuotes(symbols) {
  if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > 50 || !symbols.every(validateNseSymbol)) {
    throw new Error('Quotes require 1 to 50 valid NSE symbols per request');
  }
  return fyersGet(DATA_BASE, '/quotes', { symbols: symbols.join(',') });
}
export async function getFyersOptionChain(symbol, strikecount = 10, timestamp = '') {
  if (!validateNseSymbol(symbol)) throw new Error('A valid NSE underlying symbol is required');
  const count = Number(strikecount);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error('Option-chain strike count must be from 1 to 50');
  return fyersGet(DATA_BASE, '/options-chain-v3', { symbol, strikecount: count, timestamp, greeks: '0' });
}
export async function getFyersPositions() { return fyersGet(API_BASE, '/positions'); }
export async function getFyersOrderbook() { return fyersGet(API_BASE, '/orders'); }
export function getRestDiagnostics(now = Date.now()) {
  return {
    status: lastRestStatus,
    lastError: lastRestError,
    minGapMs: MIN_REST_GAP_MS,
    cooldownActive: now < cooldownUntil,
    cooldownUntil: cooldownUntil > now ? cooldownUntil : null
  };
}
