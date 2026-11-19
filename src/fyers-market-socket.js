import { createRequire } from 'node:module';
import { getAccessTokenForServer } from './fyers-auth.js';

const require = createRequire(import.meta.url);
const FyersDataSocket = require('fyers-api-v3').fyersDataSocket;
const SYMBOLS = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'BSE:SENSEX-INDEX'];
let socket = null;
let socketStatus = 'NOT_STARTED';
let lastError = null;
const ticks = new Map();

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
function accept(item) {
  if (Array.isArray(item)) { for (const child of item) accept(child); return; }
  if (!item || typeof item !== 'object') return;
  const symbol = String(item.symbol || item.n || '');
  if (!SYMBOLS.includes(symbol)) return;
  const price = Number(item.ltp ?? item.lp);
  const exchangeTime = asEpochSeconds(item.exch_feed_time ?? item.last_traded_time ?? item.timestamp ?? item.tt);
  if (!Number.isFinite(price) || price <= 0 || !exchangeTime) return;
  const previousClose = Number(item.prev_close_price ?? item.prev_close ?? item.pc);
  ticks.set(symbol, {
    symbol, price, exchangeTime, receivedAt: Date.now(),
    change: Number.isFinite(previousClose) && previousClose > 0 ? price - previousClose : null,
    changePercent: Number.isFinite(previousClose) && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null
  });
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
      socket.subscribe(SYMBOLS);
      socket.autoreconnect(10);
      console.info('[FYERS_DATA] connected; subscribed to 3 verified index identifiers');
    });
    socket.on('message', message => accept(decode(message)));
    socket.on('error', error => {
      lastError = String(error?.message || error || 'FYERS data socket error').slice(0, 180);
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
    lastError = String(error?.message || error).slice(0, 180);
    console.error('[FYERS_DATA] socket start failed:', lastError);
    return { status: socketStatus, reason: lastError };
  }
}
export function getMarketData(now = Date.now()) {
  const result = {};
  for (const symbol of SYMBOLS) {
    const tick = ticks.get(symbol) || null;
    const fresh = Boolean(tick && now - tick.receivedAt <= 10_000 && now / 1000 - tick.exchangeTime <= 10 && now / 1000 - tick.exchangeTime >= -3);
    result[symbol] = tick ? { ...tick, fresh } : null;
  }
  return { socketStatus, lastError, subscriptionCount: SYMBOLS.length, symbolLimit: 100, indices: result };
}
