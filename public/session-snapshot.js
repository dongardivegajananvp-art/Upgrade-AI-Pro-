const INDEX_SYMBOLS = new Set(['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX']);

export function isNseRegularSession(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const weekday = ['Mon','Tue','Wed','Thu','Fri'].includes(values.weekday);
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  return weekday && minutes >= 9 * 60 + 15 && minutes < 15 * 60 + 30;
}

export function normalizeTopGainersSnapshot(value) {
  if (!value || !Array.isArray(value.items)) return null;
  const items = value.items.slice(0, 5).filter(item =>
    item && /^NSE:[A-Z0-9&_-]+-EQ$/.test(String(item.symbol || '')) &&
    Number.isFinite(Number(item.price)) && Number(item.price) > 0 &&
    Number.isFinite(Number(item.changePercent))
  ).map(item => ({
    symbol: String(item.symbol),
    price: Number(item.price),
    changePercent: Number(item.changePercent),
    exchangeTime: Number(item.exchangeTime) || null,
    fresh: false,
    ageSeconds: null
  }));
  return items.length ? { savedAt: Number(value.savedAt) || null, items } : null;
}

export function resolveTopGainersView(fno = {}, snapshot = null, now = Date.now()) {
  const live = Array.isArray(fno.topGainers) ? fno.topGainers.slice(0, 5) : [];
  if (isNseRegularSession(now) && fno.status === 'ROTATING_LIVE_COVERAGE' && live.length && live.every(item => item?.fresh === true)) {
    return { mode: 'LIVE', items: live };
  }
  const cached = normalizeTopGainersSnapshot(snapshot);
  if (cached) return { mode: isNseRegularSession(now) ? 'LAST_OBSERVED' : 'LAST_SESSION', items: cached.items, savedAt: cached.savedAt };
  return { mode: isNseRegularSession(now) ? 'WAITING' : 'MARKET_CLOSED_NO_SNAPSHOT', items: [] };
}

export function normalizeChartSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const symbol = String(value.symbol || '');
  if (!INDEX_SYMBOLS.has(symbol) && !/^NSE:[A-Z0-9&_-]+-EQ$/.test(symbol)) return null;
  if (!Array.isArray(value.candles)) return null;
  const candles = value.candles.slice(-800).filter(candle =>
    candle && Number.isFinite(Number(candle.time)) && Number(candle.time) > 0 &&
    ['open','high','low','close'].every(key => Number.isFinite(Number(candle[key])) && Number(candle[key]) > 0) &&
    Number(candle.high) >= Math.max(Number(candle.open), Number(candle.close), Number(candle.low)) &&
    Number(candle.low) <= Math.min(Number(candle.open), Number(candle.close), Number(candle.high))
  ).map(candle => ({
    time: Number(candle.time), open: Number(candle.open), high: Number(candle.high),
    low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume) || 0
  }));
  return candles.length ? { symbol, savedAt: Number(value.savedAt) || null, candles } : null;
}
