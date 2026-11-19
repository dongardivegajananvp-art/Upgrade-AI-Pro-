const labels = [
  ['NSE:NIFTY50-INDEX','nifty','nifty-change'],
  ['NSE:NIFTYBANK-INDEX','bank','bank-change'],
  ['BSE:SENSEX-INDEX','sensex','sensex-change']
];
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
