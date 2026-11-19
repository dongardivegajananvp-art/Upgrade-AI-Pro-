const labels = [
  ['NSE:NIFTY50-INDEX','nifty','nifty-change'],
  ['NSE:NIFTYBANK-INDEX','bank','bank-change'],
  ['BSE:SENSEX-INDEX','sensex','sensex-change']
];
let selectedSymbol = null;
let selectedUnderlyingPrice = null;
let optionChainRows = [];
let selectedOptionSide = 'CE';
let selectedContractSymbol = null;
let accountRefreshRunning = false;
let lastAccountRefresh = 0;
function tickStatusText(md, freshCount) {
  if (freshCount === 3 && md.socketStatus !== 'CONNECTED') return 'FYERS RECONNECTING · LAST TICKS NOT CONFIRMED';
  if (freshCount > 0) return 'FYERS PARTIAL / STALE · ' + freshCount + '/3 INDEX TICKS FRESH';
  return 'FYERS STALE · WAITING FOR FRESH EXCHANGE TICKS';
}
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
    const optionTick = md.selectedOption;
    const optionLtp = document.querySelector('#option-ltp');
    if (optionTick?.fresh && optionTick.symbol === selectedContractSymbol) optionLtp.textContent = '₹' + showNumber(optionTick.price);
    else if (selectedContractSymbol) optionLtp.textContent = optionTick ? 'STALE · NOT ACTIONABLE' : 'WAITING FOR LIVE OPTION TICK';
    const indices = md.indices || {};
    let freshCount = 0;
    for (const [symbol, priceId, changeId] of labels) {
      const tick = indices[symbol];
      const price = document.getElementById(priceId);
      const change = document.getElementById(changeId);
      if (tick?.fresh) {
        freshCount++;
        price.textContent = showNumber(tick.price);
        const pct = tick.changePercent != null && Number.isFinite(Number(tick.changePercent)) ? Number(tick.changePercent) : null;
        change.textContent = pct === null ? 'CHANGE UNAVAILABLE' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
        change.dataset.state = pct === null ? 'unknown' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
        price.dataset.state = 'fresh';
      } else if (tick) {
        price.textContent = showNumber(tick.price);
        const pct = tick.changePercent != null && Number.isFinite(Number(tick.changePercent)) ? Number(tick.changePercent) : null;
        change.textContent = pct === null ? 'STALE · CHANGE UNAVAILABLE' : 'STALE · ' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
        change.dataset.state = 'stale';
        price.dataset.state = 'stale';
      } else {
        price.textContent = '—';
        change.textContent = 'WAITING FOR FYERS TICK';
        change.dataset.state = 'unknown';
        price.dataset.state = 'unknown';
      }
    }
    const feed = document.querySelector('#feed');
    if (md.socketStatus === 'CONNECTED' && freshCount === 3) {
      feed.textContent = 'FYERS CONNECTED · 3/3 INDEX TICKS FRESH · NSE ONLY';
      feed.dataset.state = 'connected';
    } else if (md.socketStatus === 'CONNECTED' || md.socketStatus === 'CONNECTING' || freshCount > 0 || (s.auth?.tokenStored && !['ERROR','DISCONNECTED','SUBSCRIPTION_LIMIT_BLOCKED'].includes(md.socketStatus))) {
      feed.textContent = tickStatusText(md, freshCount);
      feed.dataset.state = 'stale';
    } else {
      feed.textContent = 'FYERS DISCONNECTED · NO VERIFIED LIVE TICK';
      feed.dataset.state = 'disconnected';
    }
  } catch {
    document.querySelector('#feed').textContent = 'BACKEND DISCONNECTED';
    document.querySelector('#feed').dataset.state = 'disconnected';
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
    document.querySelector('#movers-status').textContent = 'FEED / SYMBOL MASTER NOT READY';
    const note = document.createElement('div');
    note.className = 'empty-inline';
    note.textContent = fno.status === 'SYMBOL_MASTER_NOT_LOADED'
      ? 'Official FYERS NSE F&O symbol master is not loaded. No sample gainers are shown.'
      : 'Waiting for verified FYERS F&O WebSocket feed.';
    container.append(note);
    return;
  }
  document.querySelector('#movers-status').textContent = `ROTATING · ${fno.activeCount}/${fno.universeCount} · 20s`;
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
    button.addEventListener('click', () => selectSymbol(item.symbol, item.price));
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
async function selectSymbol(symbol, livePrice = null) {
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
    selectedUnderlyingPrice = Number(livePrice) > 0 ? Number(livePrice) : (Number(data.candles.at(-1)?.close) || null);
    await clearSelectedOption();
    await loadOptionChain(symbol, selectedUnderlyingPrice);
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

async function clearSelectedOption() {
  selectedContractSymbol = null;
  document.querySelector('#option-quantity').textContent = '—';
  document.querySelector('#option-ltp').textContent = '—';
  try {
    await fetch('/api/select-option', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({symbol:null}) });
  } catch {}
}
async function loadOptionChain(symbol, underlyingPrice, timestamp = '') {
  const status = document.querySelector('#option-status');
  status.textContent = 'LOADING FYERS OPTION CHAIN';
  try {
    const query = new URLSearchParams({symbol, strikecount:'10'});
    if (timestamp) query.set('timestamp', timestamp);
    const response = await fetch('/api/option-chain?' + query.toString(), {cache:'no-store'});
    const payload = await response.json();
    if (!response.ok || payload.s !== 'ok') throw new Error(payload.reason || payload.message || 'FYERS option chain unavailable');
    const data = payload.data || payload;
    optionChainRows = Array.isArray(data.optionsChain) ? data.optionsChain : [];
    const expiries = Array.isArray(data.expiryData) ? data.expiryData : [];
    const expirySelect = document.querySelector('#expiry-select');
    if (!timestamp) {
      expirySelect.replaceChildren();
      for (const expiry of expiries) {
        const option = document.createElement('option');
        option.value = String(expiry.expiry);
        option.textContent = expiry.date;
        expirySelect.append(option);
      }
      if (expiries.length) expirySelect.value = String(expiries[0].expiry);
    }
    if (!optionChainRows.length) throw new Error('No active option contracts returned by FYERS');
    renderOptionStrikes(underlyingPrice);
    status.textContent = 'FYERS CHAIN LOADED · CONTRACT MASTER CHECK REQUIRED';
  } catch (error) {
    optionChainRows = [];
    document.querySelector('#strike-select').replaceChildren(new Option('—',''));
    status.textContent = 'OPTION CHAIN UNAVAILABLE · ' + String(error.message || 'No verified contracts');
  }
}
function renderOptionStrikes(underlyingPrice) {
  const select = document.querySelector('#strike-select');
  select.replaceChildren();
  const rows = optionChainRows.filter(row => row.option_type === selectedOptionSide && row.symbol && Number(row.strike_price) > 0);
  rows.sort((a,b)=>Number(a.strike_price)-Number(b.strike_price));
  for (const row of rows) {
    const option = document.createElement('option');
    option.value = row.symbol;
    option.textContent = showNumber(Number(row.strike_price),2);
    select.append(option);
  }
  if (!rows.length) {
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'No contracts'; select.append(empty);
    return;
  }
  if (Number.isFinite(Number(underlyingPrice))) {
    const nearest = rows.reduce((best,row)=>Math.abs(Number(row.strike_price)-underlyingPrice)<Math.abs(Number(best.strike_price)-underlyingPrice)?row:best,rows[0]);
    select.value = nearest.symbol;
  }
  selectOptionContract(select.value);
}
async function selectOptionContract(symbol) {
  if (!symbol) return;
  const status = document.querySelector('#option-status');
  status.textContent = 'VERIFYING EXACT CONTRACT IN FYERS MASTER';
  try {
    const response = await fetch('/api/select-option', {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({symbol})
    });
    const result = await response.json();
    if (!response.ok || result.status !== 'CONTRACT_VERIFIED_SUBSCRIPTION_REQUESTED') throw new Error(result.reason || 'Contract master verification failed');
    selectedContractSymbol = result.contract.symbol;
    document.querySelector('#option-quantity').textContent = showNumber(result.contract.lotSize,0);
    document.querySelector('#option-ltp').textContent = 'WAITING FOR LIVE OPTION TICK';
    status.textContent = `${result.contract.side} · ${showNumber(result.contract.strike)} · MASTER VERIFIED · LIVE TICK PENDING`;
  } catch (error) {
    selectedContractSymbol = null;
    document.querySelector('#option-quantity').textContent = '—';
    status.textContent = 'CONTRACT NOT VERIFIED · ' + String(error.message || 'No action');
  }
}
document.querySelector('#ce-select').addEventListener('click',()=>{
  selectedOptionSide='CE';
  document.querySelector('#ce-select').classList.add('active');
  document.querySelector('#pe-select').classList.remove('active');
  renderOptionStrikes(selectedUnderlyingPrice);
});
document.querySelector('#pe-select').addEventListener('click',()=>{
  selectedOptionSide='PE';
  document.querySelector('#pe-select').classList.add('active');
  document.querySelector('#ce-select').classList.remove('active');
  renderOptionStrikes(selectedUnderlyingPrice);
});
document.querySelector('#strike-select').addEventListener('change',event=>selectOptionContract(event.target.value));
document.querySelector('#expiry-select').addEventListener('change',()=>{
  if (selectedSymbol && document.querySelector('#expiry-select').value) loadOptionChain(selectedSymbol,selectedUnderlyingPrice,document.querySelector('#expiry-select').value);
});
