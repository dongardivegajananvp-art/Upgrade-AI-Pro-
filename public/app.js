const labels = [
  ['NSE:NIFTY50-INDEX','nifty','nifty-change'],
  ['NSE:NIFTYBANK-INDEX','bank','bank-change'],
  ['BSE:SENSEX-INDEX','sensex','sensex-change']
];
let selectedSymbol = null;
let accountRefreshRunning = false;
let lastAccountRefresh = 0;
function showNumber(value, digits=2) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-IN',{maximumFractionDigits:digits}) : '—';
}
async function refresh() {
  try {
    const r = await fetch('/api/status',{cache:'no-store'});
    if (!r.ok) throw new Error('status unavailable');
    const s = await r.json();
    if (s.auth?.tokenStored && Date.now() - lastAccountRefresh >= 30000) refreshAccount();
    else if (!s.auth?.tokenStored) {
      document.querySelector('#positions-data').textContent = 'Connect FYERS to read current-day positions and P&L.';
      document.querySelector('#orders-data').textContent = 'Connect FYERS to read today’s order status.';
    }
    const md = s.marketData || {};
    renderMovers(md.fno || {});
    const indices = md.indices || {};
    let freshCount = 0;
    for (const [symbol, priceId, changeId] of labels) {
      const tick = indices[symbol];
      const price = document.getElementById(priceId);
      const change = document.getElementById(changeId);
      if (tick?.fresh) {
        freshCount++;
        price.textContent = showNumber(tick.price);
        const pct = Number.isFinite(Number(tick.changePercent)) ? Number(tick.changePercent) : null;
        change.textContent = pct === null ? 'CHANGE UNAVAILABLE' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
        change.dataset.state = pct === null ? 'unknown' : pct >= 0 ? 'up' : 'down';
      } else {
        price.textContent = '—';
        change.textContent = tick ? 'STALE · NOT ACTIONABLE' : 'WAITING FOR FYERS TICK';
        change.dataset.state = 'unknown';
      }
    }
    const feed = document.querySelector('#feed');
    if (freshCount === 3) feed.textContent = 'FYERS · 3/3 INDEX TICKS FRESH · NSE ONLY';
    else if (freshCount > 0) feed.textContent = `FYERS · ${freshCount}/3 INDEX TICKS FRESH · PARTIAL FEED`;
    else feed.textContent = 'FYERS · ' + (md.socketStatus || s.auth?.status || 'NOT CONNECTED').replaceAll('_',' ') + ' · NO VERIFIED LIVE TICK';
  } catch {
    document.querySelector('#feed').textContent = 'BACKEND DISCONNECTED';
  }
}
refresh();
setInterval(refresh,2000);
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));

function appendLine(container, text) {
  const line = document.createElement('div');
  line.className = 'account-line';
  line.textContent = text;
  container.append(line);
}
async function refreshAccount() {
  if (accountRefreshRunning) return;
  accountRefreshRunning = true;
  lastAccountRefresh = Date.now();
  const positionsEl = document.querySelector('#positions-data');
  const ordersEl = document.querySelector('#orders-data');
  try {
    const [positionsResponse, ordersResponse] = await Promise.all([
      fetch('/api/positions', { cache: 'no-store' }),
      fetch('/api/orderbook', { cache: 'no-store' })
    ]);
    const [positions, orders] = await Promise.all([
      positionsResponse.json(), ordersResponse.json()
    ]);
    positionsEl.replaceChildren();
    ordersEl.replaceChildren();
    if (!positionsResponse.ok) appendLine(positionsEl, positions.reason || 'FYERS positions are unavailable.');
    else {
      const rows = positions.netPositions || positions.data?.netPositions || [];
      const total = positions.overall?.pl;
      appendLine(positionsEl, `CURRENT-DAY POSITIONS · ${rows.length}`);
      if (Number.isFinite(Number(total))) appendLine(positionsEl, `Overall P&L: ₹${showNumber(total)}`);
      if (!rows.length) appendLine(positionsEl, 'No open or closed positions returned for today.');
      for (const row of rows.slice(0, 20)) {
        appendLine(positionsEl, `${row.symbol || 'Unknown'} · Net Qty ${showNumber(row.netQty,0)} · Avg ${showNumber(row.netAvg)} · P&L ₹${showNumber(row.pl)}`);
      }
    }
    if (!ordersResponse.ok) appendLine(ordersEl, orders.reason || 'FYERS orderbook is unavailable.');
    else {
      const rows = orders.orderBook || [];
      const statusNames = {1:'CANCELLED',2:'FILLED',4:'TRANSIT',5:'REJECTED',6:'PENDING',7:'EXPIRED'};
      appendLine(ordersEl, `TODAY’S ORDERS · ${rows.length} · READ-ONLY`);
      if (!rows.length) appendLine(ordersEl, 'No orders returned for today.');
      for (const row of rows.slice(0, 20)) {
        appendLine(ordersEl, `${row.symbol || 'Unknown'} · ${row.side === 1 ? 'BUY' : row.side === -1 ? 'SELL' : '—'} · ${statusNames[row.status] || 'STATUS ' + row.status} · Filled ${showNumber(row.filledQty,0)}/${showNumber(row.qty,0)}`);
      }
    }
  } catch {
    positionsEl.textContent = 'Account snapshot unavailable; no data is assumed.';
    ordersEl.textContent = 'Order status unavailable; no data is assumed.';
  } finally {
    accountRefreshRunning = false;
  }
}

function renderMovers(fno) {
  const container = document.querySelector('#movers');
  container.replaceChildren();
  const top = Array.isArray(fno.topGainers) ? fno.topGainers : [];
  if (fno.status !== 'ROTATING_LIVE_COVERAGE') {
    const note = document.createElement('div');
    note.className = 'empty-inline';
    note.textContent = fno.status === 'SYMBOL_MASTER_NOT_LOADED'
      ? 'Official FYERS NSE F&O symbol master is not loaded. No sample gainers are shown.'
      : 'Waiting for verified FYERS F&O WebSocket feed.';
    container.append(note);
    return;
  }
  const coverage = document.createElement('div');
  coverage.className = 'coverage-note';
  coverage.textContent = `ROTATING LIVE COVERAGE · ${fno.activeCount}/${fno.universeCount} UNDERLYINGS IN THIS SLICE · 20s ROTATION`;
  container.append(coverage);
  if (!top.length) {
    const note = document.createElement('div');
    note.className = 'empty-inline';
    note.textContent = 'Waiting for fresh exchange-timestamped F&O underlying ticks in this slice.';
    container.append(note);
    return;
  }
  for (const item of top) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mover-card';
    button.addEventListener('click', () => selectSymbol(item.symbol));
    const name = document.createElement('strong');
    name.textContent = item.symbol.replace(/^NSE:/, '').replace(/-EQ$/, '');
    const price = document.createElement('span');
    price.textContent = `₹${showNumber(item.price)}`;
    const change = document.createElement('span');
    const pct = Number(item.changePercent);
    change.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% · LIVE`;
    change.dataset.state = pct >= 0 ? 'up' : 'down';
    button.append(name, price, change);
    container.append(button);
  }
}
async function selectSymbol(symbol) {
  if (!symbol || symbol === selectedSymbol) return;
  selectedSymbol = symbol;
  const title = document.querySelector('#symbol');
  const area = document.querySelector('#chart-area');
  title.textContent = symbol + ' · LOADING VERIFIED FYERS HISTORY';
  area.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'chart-empty';
  loading.textContent = 'Loading completed FYERS 5-minute candles. No synthetic candles are used.';
  area.append(loading);
  try {
    const response = await fetch('/api/history?symbol=' + encodeURIComponent(symbol), { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.candles) || !data.candles.length) throw new Error(data.reason || 'Verified FYERS history is unavailable');
    drawHistoryChart(data.candles);
    title.textContent = `${symbol} · FYERS HISTORY · ${data.count} COMPLETED 5-MIN CANDLES`;
  } catch (error) {
    area.replaceChildren();
    const note = document.createElement('div');
    note.className = 'chart-empty';
    note.textContent = String(error.message || 'History unavailable') + ' · NO TRADE';
    area.append(note);
    title.textContent = symbol + ' · HISTORY UNAVAILABLE';
  }
}
function drawHistoryChart(candles) {
  const area = document.querySelector('#chart-area');
  area.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 1200 560');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Verified FYERS completed five-minute candlestick chart');
  svg.setAttribute('preserveAspectRatio', 'none');
  const max = Math.max(...candles.map(c => Number(c.high)));
  const min = Math.min(...candles.map(c => Number(c.low)));
  const range = Math.max(max - min, 0.000001);
  const left = 34, right = 24, top = 24, bottom = 92;
  const plotW = 1200 - left - right, plotH = 560 - top - bottom;
  const xStep = plotW / candles.length;
  const y = price => top + (max - price) / range * plotH;
  for (let i = 0; i <= 4; i++) {
    const gy = top + plotH * i / 4;
    const grid = document.createElementNS(ns, 'line');
    grid.setAttribute('x1', left); grid.setAttribute('x2', 1200 - right);
    grid.setAttribute('y1', gy); grid.setAttribute('y2', gy);
    grid.setAttribute('stroke', '#26364d'); grid.setAttribute('stroke-width', '1');
    svg.append(grid);
  }
  candles.forEach((candle, index) => {
    const x = left + xStep * (index + 0.5);
    const up = Number(candle.close) >= Number(candle.open);
    const stroke = up ? '#32c48d' : '#ef6b73';
    const wick = document.createElementNS(ns, 'line');
    wick.setAttribute('x1', x); wick.setAttribute('x2', x);
    wick.setAttribute('y1', y(Number(candle.high))); wick.setAttribute('y2', y(Number(candle.low)));
    wick.setAttribute('stroke', stroke); wick.setAttribute('stroke-width', '2');
    const body = document.createElementNS(ns, 'rect');
    const bodyTop = y(Math.max(Number(candle.open), Number(candle.close)));
    const bodyBottom = y(Math.min(Number(candle.open), Number(candle.close)));
    body.setAttribute('x', x - Math.max(1.5, xStep * 0.3));
    body.setAttribute('y', bodyTop);
    body.setAttribute('width', Math.max(3, xStep * 0.6));
    body.setAttribute('height', Math.max(1.5, bodyBottom - bodyTop));
    body.setAttribute('fill', stroke);
    svg.append(wick, body);
  });
  const first = document.createElementNS(ns, 'text');
  first.setAttribute('x', left); first.setAttribute('y', 535); first.setAttribute('fill', '#91a2ba'); first.setAttribute('font-size', '15');
  first.textContent = new Date((candles[0].time + 19800) * 1000).toISOString().slice(11,16) + ' IST';
  const last = document.createElementNS(ns, 'text');
  last.setAttribute('x', 1200 - right); last.setAttribute('y', 535); last.setAttribute('text-anchor', 'end'); last.setAttribute('fill', '#91a2ba'); last.setAttribute('font-size', '15');
  last.textContent = new Date((candles.at(-1).time + 19800) * 1000).toISOString().slice(11,16) + ' IST';
  svg.append(first, last);
  area.append(svg);
}
