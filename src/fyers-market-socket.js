import { createRequire } from 'node:module';
import { getAccessTokenForServer } from './fyers-auth.js';

const require = createRequire(import.meta.url);
const FyersDataSocket = require('fyers-api-v3').fyersDataSocket;
const INDEX_SYMBOLS = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'BSE:SENSEX-INDEX'];
const MAX_UNDERLYING_SLOTS = 20;
const ROTATION_INTERVAL_MS = 20_000;
let socket = null;
let socketStatus = 'NOT_STARTED';
let lastError = null;
let universe = [];
let activeFnoSymbols = [];
let rotationIndex = 0;
let rotationTimer = null;
let selectedOptionSymbol = null;
let selectedUnderlyingSymbol = null;
let selectedLiveCandle = null;
let lastCumulativeVolume = null;
const ticks = new Map();

function safeError(error) {
  if (error instanceof Error) return error.message.slice(0, 240);
  if (typeof error === 'string') return error.slice(0, 240);
  try { return JSON.stringify(error).slice(0, 240); } catch { return String(error).slice(0, 240); }
}
function decode(message) {
  if (Buffer.isBuffer(message) || message instanceof ArrayBuffer) {
    try { return JSON.parse(Buffer.from(message).toString('utf8')); } catch { return null; }
  }
  if (typeof message === 'string') {
    try { return JSON.parse(message); } catch { return null; }
  }
  return message && typeof message === 'object' ? message : null;
}
function asEpochSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? n / 1000 : n;
}
function isFresh(tick, now = Date.now()) {
  return Boolean(tick && now - tick.receivedAt <= 10_000 && now - tick.receivedAt >= 0 &&
    now / 1000 - tick.exchangeTime <= 10 && now / 1000 - tick.exchangeTime >= -3);
}
function acceptedSymbols() {
  return new Set([...INDEX_SYMBOLS, ...activeFnoSymbols, ...(selectedOptionSymbol ? [selectedOptionSymbol] : [])]);
}
function accept(item) {
  if (Array.isArray(item)) { for (const child of item) accept(child); return; }
  if (!item || typeof item !== 'object') return;
  const symbol = String(item.symbol || item.n || '');
  if (!acceptedSymbols().has(symbol)) return;
  const price = Number(item.ltp ?? item.lp);
  const exchangeTime = asEpochSeconds(item.exch_feed_time ?? item.last_traded_time ?? item.timestamp ?? item.tt);
  if (!Number.isFinite(price) || price <= 0 || !exchangeTime) return;
  const previousClose = Number(item.prev_close_price ?? item.prev_close ?? item.pc);
  const fallbackChange = Number.isFinite(previousClose) && previousClose > 0 ? price - previousClose : null;
  const fallbackPercent = Number.isFinite(previousClose) && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null;
  const reportedChange = item.ch ?? item.change;
  const reportedPercent = item.chp ?? item.changePercent;
  const change = reportedChange !== undefined && reportedChange !== null && Number.isFinite(Number(reportedChange)) ? Number(reportedChange) : fallbackChange;
  const changePercent = reportedPercent !== undefined && reportedPercent !== null && Number.isFinite(Number(reportedPercent)) ? Number(reportedPercent) : fallbackPercent;
  const cumulativeVolume = Number(item.v ?? item.volume ?? item.vol_traded_today);
  const tick = { symbol, price, exchangeTime, receivedAt: Date.now(), change, changePercent, type: item.type || null, cumulativeVolume: Number.isFinite(cumulativeVolume) && cumulativeVolume >= 0 ? cumulativeVolume : null };
  ticks.set(symbol, tick);
  if (symbol === selectedUnderlyingSymbol) {
    const bucket = Math.floor(exchangeTime / 300) * 300;
    const local = new Date((bucket + 19800) * 1000);
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (minute >= 555 && minute < 930) {
      if (!selectedLiveCandle || selectedLiveCandle.time !== bucket) {
        selectedLiveCandle = { time: bucket, open: price, high: price, low: price, close: price, volume: 0, completed: false, source: 'FYERS_LIVE_TICKS' };
        lastCumulativeVolume = tick.cumulativeVolume;
      } else {
        selectedLiveCandle.high = Math.max(selectedLiveCandle.high, price);
        selectedLiveCandle.low = Math.min(selectedLiveCandle.low, price);
        selectedLiveCandle.close = price;
        if (tick.cumulativeVolume !== null && lastCumulativeVolume !== null && tick.cumulativeVolume >= lastCumulativeVolume) selectedLiveCandle.volume += tick.cumulativeVolume - lastCumulativeVolume;
        lastCumulativeVolume = tick.cumulativeVolume;
      }
    }
  }
}
function nextSlice() {
  if (!universe.length) return [];
  const count = Math.min(MAX_UNDERLYING_SLOTS, universe.length);
  const slice = [];
  for (let i = 0; i < count; i++) slice.push(universe[(rotationIndex + i) % universe.length].symbol);
  if (selectedUnderlyingSymbol && universe.some(item => item.symbol === selectedUnderlyingSymbol) && !slice.includes(selectedUnderlyingSymbol)) slice[slice.length - 1] = selectedUnderlyingSymbol;
  return [...new Set(slice)];
}
function applyFnoRotation() {
  const next = nextSlice();
  if (!next.length) { activeFnoSymbols = []; return; }
  if (socket && socketStatus === 'CONNECTED') {
    const nextSet = new Set(next), activeSet = new Set(activeFnoSymbols);
    const removed = activeFnoSymbols.filter(symbol => !nextSet.has(symbol));
    const added = next.filter(symbol => !activeSet.has(symbol));
    try {
      if (removed.length) {
        if (typeof socket.unsubscribe !== 'function') throw new Error('FYERS SDK does not expose unsubscribe; rotation stopped to protect the 100-symbol cap');
        socket.unsubscribe(removed);
      }
      if (added.length) socket.subscribe(added);
    } catch (error) {
      lastError = safeError(error);
      socketStatus = 'SUBSCRIPTION_UPDATE_ERROR';
      console.error('[FYERS_DATA] F&O rotation update failed:', lastError);
      return;
    }
  }
  activeFnoSymbols = next;
  rotationIndex = universe.length > MAX_UNDERLYING_SLOTS ? (rotationIndex + MAX_UNDERLYING_SLOTS) % universe.length : 0;
}
export function setFnoUniverse(items) {
  const unique = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !/^NSE:[A-Z0-9&._-]+-EQ$/.test(String(item.symbol || ''))) continue;
    unique.set(item.symbol, item);
  }
  universe = [...unique.values()];
  rotationIndex = 0;
  applyFnoRotation();
  if (rotationTimer) clearInterval(rotationTimer);
  if (universe.length > MAX_UNDERLYING_SLOTS) {
    rotationTimer = setInterval(applyFnoRotation, ROTATION_INTERVAL_MS);
    rotationTimer.unref?.();
  }
  return { universeCount: universe.length, activeCount: activeFnoSymbols.length, rotationIntervalMs: ROTATION_INTERVAL_MS, symbolCap: 100 };
}
export function setSelectedUnderlyingSymbol(symbol) {
  const next = symbol && /^NSE:[A-Z0-9&._-]+-EQ$/.test(symbol) && universe.some(item => item.symbol === symbol) ? symbol : null;
  if (next === selectedUnderlyingSymbol) return { status: 'UNCHANGED', symbol: next };
  selectedUnderlyingSymbol = next;
  selectedLiveCandle = null;
  lastCumulativeVolume = null;
  applyFnoRotation();
  return { status: next ? 'UNDERLYING_PINNED_TO_SOCKET_SLICE' : 'UNDERLYING_CLEARED', symbol: next };
}
export function setSelectedOptionSymbol(symbol) {
  const next = symbol && /^NSE:[A-Z0-9&._-]+$/.test(symbol) ? symbol : null;
  if (next === selectedOptionSymbol) return;
  if (socket && socketStatus === 'CONNECTED') {
    try {
      if (selectedOptionSymbol && typeof socket.unsubscribe === 'function') socket.unsubscribe([selectedOptionSymbol]);
      if (next && !activeFnoSymbols.includes(next) && !INDEX_SYMBOLS.includes(next)) socket.subscribe([next]);
    } catch (error) {
      lastError = safeError(error);
      socketStatus = 'SUBSCRIPTION_UPDATE_ERROR';
      return;
    }
  }
  selectedOptionSymbol = next;
}
export function startMarketSocket() {
  const token = getAccessTokenForServer();
  if (!token) return { status: 'NOT_AUTHENTICATED' };
  if (socket && ['CONNECTING', 'CONNECTED'].includes(socketStatus)) return { status: socketStatus };
  try {
    socketStatus = 'CONNECTING';
    lastError = null;
    socket = FyersDataSocket.getInstance(`${process.env.FYERS_APP_ID}:${token}`, '', true);
    socket.on('connect', () => {
      socketStatus = 'CONNECTED';
      const subscriptions = [...INDEX_SYMBOLS, ...activeFnoSymbols, ...(selectedOptionSymbol ? [selectedOptionSymbol] : [])];
      if (subscriptions.length > 100) {
        socketStatus = 'SUBSCRIPTION_LIMIT_BLOCKED';
        lastError = 'Subscription count exceeded the Standard plan 100-symbol limit';
        return;
      }
      socket.subscribe(subscriptions);
      socket.autoreconnect(10);
      console.info('[FYERS_DATA] connected; subscribed symbols:', subscriptions.length, 'indices:', INDEX_SYMBOLS.length, 'F&O underlyings:', activeFnoSymbols.length);
    });
    socket.on('message', message => accept(decode(message)));
    socket.on('error', error => {
      lastError = safeError(error || 'FYERS data socket error');
      socketStatus = 'ERROR';
      console.error('[FYERS_DATA] socket error:', lastError);
    });
    socket.on('close', () => {
      socketStatus = 'DISCONNECTED';
      console.warn('[FYERS_DATA] socket closed');
    });
    socket.connect();
    return { status: socketStatus };
  } catch (error) {
    socketStatus = 'ERROR';
    lastError = safeError(error);
    console.error('[FYERS_DATA] socket start failed:', lastError);
    return { status: socketStatus, reason: lastError };
  }
}
export function getMarketData(now = Date.now()) {
  const indices = {};
  for (const symbol of INDEX_SYMBOLS) {
    const tick = ticks.get(symbol) || null;
    indices[symbol] = tick ? { ...tick, fresh: isFresh(tick, now) } : null;
  }
  const activeTicks = activeFnoSymbols.map(symbol => ticks.get(symbol)).filter(tick => isFresh(tick, now) && Number.isFinite(tick.changePercent));
  const topGainers = activeTicks.sort((a, b) => b.changePercent - a.changePercent).slice(0, 5);
  const optionTick = selectedOptionSymbol ? ticks.get(selectedOptionSymbol) || null : null;
  return {
    socketStatus, lastError, selectedOption: optionTick ? { ...optionTick, fresh: isFresh(optionTick, now) } : null,
    selectedUnderlying: selectedUnderlyingSymbol && ticks.get(selectedUnderlyingSymbol) ? { ...ticks.get(selectedUnderlyingSymbol), fresh: isFresh(ticks.get(selectedUnderlyingSymbol), now), liveCandle: selectedLiveCandle ? { ...selectedLiveCandle } : null } : null,
    selectedOptionSymbol,
    subscriptionCount: INDEX_SYMBOLS.length + activeFnoSymbols.length + (selectedOptionSymbol && !activeFnoSymbols.includes(selectedOptionSymbol) ? 1 : 0),
    symbolLimit: 100, indices,
    fno: {
      status: !universe.length ? 'SYMBOL_MASTER_NOT_LOADED' : ['ERROR','SUBSCRIPTION_UPDATE_ERROR','SUBSCRIPTION_LIMIT_BLOCKED','DISCONNECTED'].includes(socketStatus) ? 'SOCKET_ERROR' : topGainers.length ? 'ROTATING_LIVE_COVERAGE' : 'WAITING_FOR_FNO_TICKS',
      lastError, universeCount: universe.length, activeCount: activeFnoSymbols.length,
      rotationIntervalMs: ROTATION_INTERVAL_MS, currentSliceStart: universe.length ? rotationIndex : 0,
      subscriptionCount: INDEX_SYMBOLS.length + activeFnoSymbols.length + (selectedOptionSymbol && !activeFnoSymbols.includes(selectedOptionSymbol) ? 1 : 0),
      topGainers: topGainers.map(tick => ({ symbol: tick.symbol, price: tick.price, change: tick.change, changePercent: tick.changePercent, exchangeTime: tick.exchangeTime, receivedAt: tick.receivedAt, fresh: true }))
    }
  };
}
