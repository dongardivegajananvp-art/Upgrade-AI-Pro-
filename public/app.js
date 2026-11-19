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
let chartCandles = [];
let chartLiveCandle = null;
let chartSetupLevels = null;
let chartZoom = 1;
let setupEvaluationRunning = false;
let setupEvaluationDone = false;
let setupLastBucket = null;
let lastAccountRefresh = 0;
document.querySelectorAll('.indices article[data-symbol]').forEach(card => {
  const open = () => selectIndexSymbol(card.dataset.symbol);
  card.addEventListener('click', open);
  card.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
  });
});
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
      const accountStatus = document.querySelector('#account-feed-status');
      if (accountStatus) accountStatus.textContent = 'FYERS ACCOUNT FEED · SESSION REQUIRED';
    }
    const md = s.marketData || {};
    renderMovers(md.fno || {});
    const optionTick = md.selectedOption;
    const underlyingTick = md.selectedUnderlying;
    renderLiveCandleSummary(underlyingTick);
    // Restore the backend's selected chart symbol after a page reload; otherwise
    // the server can build a live candle while the client never renders it.
    if (!selectedSymbol && underlyingTick?.symbol && underlyingTick.fresh) {
      selectSymbol(underlyingTick.symbol, underlyingTick.price);
    }
    if (selectedSymbol && underlyingTick?.symbol === selectedSymbol && underlyingTick.fresh && underlyingTick.liveCandle) {
      chartLiveCandle = underlyingTick.liveCandle;
      renderChartViewport();
    }
    const optionLtp = document.querySelector('#option-ltp');
    if (optionTick?.fresh && optionTick.symbol === selectedContractSymbol) {
      optionLtp.textContent = '₹' + showNumber(optionTick.price);
      const selectedTick = md.selectedUnderlying;
      const bucket = selectedTick?.exchangeTime ? Math.floor(Number(selectedTick.exchangeTime)/300)*300 : null;
      if (bucket && setupLastBucket !== null && bucket !== setupLastBucket) setupEvaluationDone = false;
      if (!setupEvaluationDone && !setupEvaluationRunning && selectedTick?.fresh && selectedTick.symbol === selectedSymbol) evaluateSelectedSetup();
    }
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
  const accountStatus = document.querySelector('#account-feed-status');
  if (accountStatus) accountStatus.textContent = 'CHECKING FYERS ACCOUNT FEED';
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
    if (accountStatus) {
      if (positionsResponse.ok && ordersResponse.ok) {
        accountStatus.textContent = 'FYERS ACCOUNT FEED · CONNECTED · READ-ONLY';
        accountStatus.dataset.state = 'connected';
      } else {
        const failed = !positionsResponse.ok ? positionsResponse : ordersResponse;
        accountStatus.textContent = failed.status === 429
          ? 'FYERS ACCOUNT FEED · RATE LIMITED'
          : failed.status === 401 || failed.status === 403
            ? 'FYERS ACCOUNT FEED · AUTHORIZATION REQUIRED'
            : 'FYERS ACCOUNT FEED · UNAVAILABLE · HTTP ' + failed.status;
        accountStatus.dataset.state = 'stale';
      }
    }
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
    if (accountStatus) {
      accountStatus.textContent = 'FYERS ACCOUNT FEED · REQUEST FAILED';
      accountStatus.dataset.state = 'stale';
    }
  } finally {
    accountRefreshRunning = false;
  }
}

function renderMovers(fno) {
  const container = document.querySelector('#movers');
  container.replaceChildren();
  const top = Array.isArray(fno.topGainers) ? fno.topGainers : [];
  if (fno.status !== 'ROTATING_LIVE_COVERAGE') {
    const labels = { SYMBOL_MASTER_NOT_LOADED: 'SYMBOL MASTER NOT READY', SOCKET_ERROR: 'FYERS SOCKET ERROR', WAITING_FOR_FNO_TICKS: 'WAITING FOR F&O TICKS' };
    document.querySelector('#movers-status').textContent = labels[fno.status] || 'F&O FEED PENDING';
    const note = document.createElement('div');
    note.className = 'empty-inline';
    note.textContent = fno.status === 'SYMBOL_MASTER_NOT_LOADED'
      ? 'Official FYERS NSE F&O symbol master is not loaded. No sample gainers are shown.'
      : fno.status === 'SOCKET_ERROR'
        ? 'FYERS rejected or closed the F&O subscription. ' + (fno.lastError || 'Socket error detail unavailable.')
        : 'Waiting for fresh exchange-timestamped F&O ticks in the active rotating slice.';
    container.append(note);
    return;
  }
  const coverageText = (fno.observedCount ?? 0) + '/' + fno.universeCount + ' OBSERVED';
  document.querySelector('#movers-status').textContent = (fno.coverageComplete ? 'ROLLING FULL-UNIVERSE · ' : 'ROLLING PARTIAL · ') + coverageText + ' · ' + Math.round((fno.rotationIntervalMs || 60000) / 1000) + 's/SLICE · NON-SIMULTANEOUS · ' + fno.subscriptionCount + '/100 SYMBOLS';
  if (!top.length) {
    const note = document.createElement('div');
    note.className = 'empty-inline';
    note.textContent = 'Waiting for fresh exchange-timestamped F&O underlying ticks in this slice.';
    container.append(note);
    return;
  }
  top.slice(0, 5).forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mover-card';
    const pct = Number(item.changePercent);
    const direction = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const cardState = item.fresh ? direction : 'stale';
    button.dataset.state = cardState;
    button.dataset.rank = String(index + 1);
    button.title = item.fresh ? 'Fresh FYERS exchange tick · ' + direction.toUpperCase() + ' ' + pct.toFixed(2) + '%' : 'STALE ROLLING OBSERVATION · ' + Math.floor((item.ageSeconds || 0) / 60) + 'm old · not actionable';
    button.addEventListener('click', () => selectSymbol(item.symbol, item.price));
    const name = document.createElement('strong');
    name.textContent = item.symbol.replace(/^NSE:/, '').replace(/-EQ$/, '');
    const price = document.createElement('span');
    price.textContent = `₹${showNumber(item.price)}`;
    const change = document.createElement('span');
    change.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '% · ' + (item.fresh ? 'FRESH' : 'SEEN ' + Math.floor((item.ageSeconds || 0) / 60) + 'm AGO');
    change.dataset.state = item.fresh ? direction : 'stale';
    button.append(name, price, change);
    container.append(button);
  });
}
async function selectIndexSymbol(symbol) {
  if (!['NSE:NIFTY50-INDEX','NSE:NIFTYBANK-INDEX','BSE:SENSEX-INDEX'].includes(symbol)) return;
  selectedSymbol = symbol; selectedUnderlyingPrice = null; selectedContractSymbol = null; chartSetupLevels = null;
  setupEvaluationDone = true; setupEvaluationRunning = false; chartLiveCandle = null; chartCandles = [];
  const title=document.querySelector('#symbol'),area=document.querySelector('#chart-area');
  title.textContent=symbol+' · LOADING VERIFIED FYERS INDEX HISTORY';
  area.replaceChildren();
  const loading=document.createElement('div');loading.className='chart-empty';
  loading.textContent='Loading completed FYERS index candles. No synthetic candles are used.';area.append(loading);
  for(const id of ['setup-entry','setup-sl','setup-target','setup-rr'])document.getElementById(id).textContent='—';
  document.querySelector('#setup-state').textContent='INDEX CHART · OPTIONS STRATEGY NOT APPLICABLE';
  document.querySelector('#option-status').textContent='INDEX SELECTED · OPTION CHAIN NOT APPLICABLE';
  document.querySelector('#option-ltp').textContent='—';document.querySelector('#option-quantity').textContent='—';
  document.querySelector('#expiry-select').replaceChildren(new Option('—',''));
  document.querySelector('#strike-select').replaceChildren(new Option('—',''));
  document.querySelector('#research-status').textContent='INDEX VIEW · STOCK SETUP RESEARCH NOT RUN';
  document.querySelector('#research-results').textContent='Select an NSE F&O gainer to run the nine-strategy research engine.';
  renderLiveCandleSummary(null);
  try {
    await clearSelectedOption();
    const response=await fetch('/api/history?symbol='+encodeURIComponent(symbol),{cache:'no-store'});
    const data=await response.json();
    if(!response.ok||!Array.isArray(data.candles)||!data.candles.length)throw new Error(data.reason||'Verified FYERS index history unavailable');
    if(selectedSymbol!==symbol)return;
    drawHistoryChart(data.candles);selectedUnderlyingPrice=Number(data.candles.at(-1)?.close)||null;
    title.textContent=`${symbol} · FYERS HISTORY · ${data.count} COMPLETED 5-MIN INDEX CANDLES`;
    document.querySelector('#chart-candle-status').textContent='INDEX HISTORY · COMPLETED FYERS CANDLES';
  } catch(error) {
    if(selectedSymbol!==symbol)return;
    area.replaceChildren();const note=document.createElement('div');note.className='chart-empty';
    note.textContent=String(error.message||'Index history unavailable')+' · NO SYNTHETIC DATA';
    area.append(note);title.textContent=symbol+' · INDEX HISTORY UNAVAILABLE';
  }
}
async function selectSymbol(symbol, livePrice = null) {
  if (!symbol || symbol === selectedSymbol) return;
  selectedSymbol = symbol;
  chartSetupLevels = null;
  setupEvaluationDone = false;
  chartLiveCandle = null;
  const title = document.querySelector('#symbol');
  const area = document.querySelector('#chart-area');
  title.textContent = symbol + ' · LOADING VERIFIED FYERS HISTORY';
  area.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'chart-empty';
  loading.textContent = 'Loading completed FYERS 5-minute candles. No synthetic candles are used.';
  area.append(loading);
  try {
    const selectionResponse = await fetch('/api/select-underlying',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({symbol})});
    const selection = await selectionResponse.json();
    if (!selectionResponse.ok || !['UNDERLYING_PINNED_TO_SOCKET_SLICE','UNCHANGED'].includes(selection.status)) throw new Error(selection.reason || 'Underlying socket subscription was not confirmed');
    const response = await fetch('/api/history?symbol=' + encodeURIComponent(symbol), { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.candles) || !data.candles.length) throw new Error(data.reason || 'Verified FYERS history is unavailable');
    drawHistoryChart(data.candles);
    selectedUnderlyingPrice = Number(livePrice) > 0 ? Number(livePrice) : (Number(data.candles.at(-1)?.close) || null);
    await clearSelectedOption();
    // Load the selected option chain before background research warmup. The FYERS
    // REST scheduler is shared and paced; background daily/15m history must not
    // sit ahead of the user's option-chain request in that queue.
    await loadOptionChain(symbol, selectedUnderlyingPrice);
    // Warm daily/15m caches after the user-facing option-chain request, then
    // calculate underlying research independently of option-premium availability.
    const contextResponse = await fetch('/api/research-context?symbol=' + encodeURIComponent(symbol), { cache: 'no-store' });
    const contextPayload = await contextResponse.json();
    let researchPayload = contextPayload;
    if (contextResponse.ok) {
      const researchResponse = await fetch('/api/research?symbol=' + encodeURIComponent(symbol), { cache: 'no-store' });
      researchPayload = await researchResponse.json();
    }
    if (selectedSymbol === symbol) renderResearchResults(researchPayload);
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
  chartCandles = Array.isArray(candles) ? candles.slice() : [];
  renderChartViewport();
}
function renderLiveCandleSummary(tick) {
  const panel = document.querySelector('#live-candle-summary');
  if (!panel) return;
  panel.replaceChildren();
  const heading = document.createElement('strong');
  heading.textContent = 'LIVE 5-MIN CANDLE';
  const fresh = Boolean(tick?.fresh && tick.symbol === selectedSymbol && chartLiveCandle);
  const state = document.createElement('span');
  state.className = 'live-candle-state';
  state.dataset.state = fresh ? 'fresh' : 'stale';
  state.textContent = fresh ? 'FRESH FYERS TICK' : 'WAITING FOR FRESH FYERS TICK';
  panel.append(heading, state);
  if (!chartLiveCandle || chartLiveCandle.time <= 0) return;
  const c = chartLiveCandle;
  const time = new Date((Number(c.time) + 19800) * 1000).toISOString().slice(11,16);
  const fields = [
    ['TIME', time + '–' + new Date((Number(c.time) + 19800 + 300) * 1000).toISOString().slice(11,16) + ' IST'],
    ['LIVE PRICE', fresh ? '₹' + showNumber(tick.price) : '—'],
    ['OPEN', showNumber(c.open)],
    ['HIGH', showNumber(c.high)],
    ['LOW', showNumber(c.low)],
    ['CLOSE', showNumber(c.close)],
    ['VOLUME', showNumber(c.volume, 0)]
  ];
  for (const [label, value] of fields) {
    const item = document.createElement('div');
    item.className = 'live-candle-metric';
    const name = document.createElement('small');
    name.textContent = label;
    const number = document.createElement('b');
    number.textContent = value;
    item.append(name, number);
    panel.append(item);
  }
}
function renderChartViewport() {
  const area = document.querySelector('#chart-area');
  const candles = chartLiveCandle && chartLiveCandle.time > 0 ? [...chartCandles, chartLiveCandle] : chartCandles;
  area.replaceChildren();
  if (!candles.length) return;
  const visibleCount = Math.max(8, Math.ceil(candles.length / chartZoom));
  const visible = candles.slice(-visibleCount);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 1200 620');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'FYERS completed five-minute candlestick chart with supply and demand structure zones');
  svg.setAttribute('preserveAspectRatio', 'none');
  const chartSymbolLabel = (selectedSymbol || 'SELECT SYMBOL')
    .replace(/^(NSE|BSE):/, '')
    .replace(/-EQ$/, '')
    .replace('-INDEX', '')
    .replace('NIFTY50', 'NIFTY 50')
    .replace('NIFTYBANK', 'BANK NIFTY');
  svg.setAttribute('aria-label', chartSymbolLabel + ' FYERS five-minute candlestick chart with supply and demand structure zones');
  const left=76,right=92,top=chartSetupLevels?118:28,bottom=100,plotW=1200-left-right,plotH=620-top-bottom;
  const highs=visible.map(c=>Number(c.high)), lows=visible.map(c=>Number(c.low));
  const max=Math.max(...highs),min=Math.min(...lows),range=Math.max(max-min,0.000001);
  const pad=range*.08, ceiling=max+pad, floor=min-pad, span=ceiling-floor;
  const y=p=>top+(ceiling-p)/span*plotH;
  const xStep=plotW/visible.length, xAt=i=>left+xStep*(i+.5);
  for(let i=0;i<=4;i++){
    const price=ceiling-span*i/4, gy=y(price);
    const grid=document.createElementNS(ns,'line');
    grid.setAttribute('x1',left);grid.setAttribute('x2',left+plotW);grid.setAttribute('y1',gy);grid.setAttribute('y2',gy);
    grid.setAttribute('stroke','#26364d');grid.setAttribute('stroke-width','1');svg.append(grid);
    const label=document.createElementNS(ns,'text');
    label.setAttribute('x',left+plotW+12);label.setAttribute('y',gy+5);label.setAttribute('fill','#9bb0ca');label.setAttribute('font-size','14');
    label.textContent=showNumber(price);svg.append(label);
  }
  // Demand/supply are drawn only from confirmed local pivot candles in the visible completed history.
  const pivots=[];
  for(let i=2;i<visible.length-2;i++){
    const c=visible[i],lo=Number(c.low),hi=Number(c.high);
    const isDemand=visible.slice(i-2,i).every(v=>Number(v.low)>=lo)&&visible.slice(i+1,i+3).every(v=>Number(v.low)>lo);
    const isSupply=visible.slice(i-2,i).every(v=>Number(v.high)<=hi)&&visible.slice(i+1,i+3).every(v=>Number(v.high)<hi);
    if(isDemand)pivots.push({kind:'DEMAND',index:i,low:lo,high:Math.min(Number(c.open),Number(c.close))});
    if(isSupply)pivots.push({kind:'SUPPLY',index:i,low:Math.max(Number(c.open),Number(c.close)),high:hi});
  }
  const latestDemand=[...pivots].reverse().find(p=>p.kind==='DEMAND');
  const latestSupply=[...pivots].reverse().find(p=>p.kind==='SUPPLY');
  for(const zone of [latestDemand,latestSupply].filter(Boolean)){
    const rect=document.createElementNS(ns,'rect');
    rect.setAttribute('x',left+xStep*zone.index);rect.setAttribute('width',Math.max(22,plotW*.18));
    rect.setAttribute('y',y(zone.high));rect.setAttribute('height',Math.max(3,y(zone.low)-y(zone.high)));
    rect.setAttribute('fill',zone.kind==='DEMAND'?'#16c784':'#ea3943');rect.setAttribute('fill-opacity','.14');
    rect.setAttribute('stroke',zone.kind==='DEMAND'?'#16c784':'#ea3943');rect.setAttribute('stroke-opacity','.75');rect.setAttribute('stroke-dasharray','5 4');
    svg.append(rect);
    const tag=document.createElementNS(ns,'text');tag.setAttribute('x',left+plotW-5);tag.setAttribute('y',y((zone.high+zone.low)/2)-5);
    tag.setAttribute('text-anchor','end');tag.setAttribute('font-size','13');tag.setAttribute('font-weight','700');tag.setAttribute('fill',zone.kind==='DEMAND'?'#35d99a':'#ff737c');
    tag.textContent=zone.kind+' ZONE';svg.append(tag);
  }
  visible.forEach((c,i)=>{
    const x=xAt(i),isLive=Boolean(chartLiveCandle && c.time===chartLiveCandle.time);
    const up=Number(c.close)>=Number(c.open),color=up?'#32c48d':'#ef6b73';
    if(isLive){
      const guide=document.createElementNS(ns,'line');
      guide.setAttribute('x1',x);guide.setAttribute('x2',x);guide.setAttribute('y1',top);guide.setAttribute('y2',top+plotH);
      guide.setAttribute('stroke','#55c8ff');guide.setAttribute('stroke-width','2');guide.setAttribute('stroke-dasharray','7 6');guide.setAttribute('opacity','.85');svg.append(guide);
    }
    const wick=document.createElementNS(ns,'line');wick.setAttribute('x1',x);wick.setAttribute('x2',x);wick.setAttribute('y1',y(Number(c.high)));wick.setAttribute('y2',y(Number(c.low)));wick.setAttribute('stroke',isLive?'#7bd8ff':color);wick.setAttribute('stroke-width',isLive?'4':'2');
    const body=document.createElementNS(ns,'rect'),bodyTop=y(Math.max(Number(c.open),Number(c.close))),bodyBottom=y(Math.min(Number(c.open),Number(c.close)));
    body.setAttribute('x',x-Math.max(isLive?6:2,xStep*(isLive?.39:.29)));body.setAttribute('y',bodyTop);body.setAttribute('width',Math.max(isLive?12:4,xStep*(isLive?.78:.58)));body.setAttribute('height',Math.max(3,bodyBottom-bodyTop));body.setAttribute('fill',color);
    if(isLive){body.setAttribute('stroke','#d8f5ff');body.setAttribute('stroke-width','2');body.setAttribute('filter','drop-shadow(0 0 7px #43bdff)');}
    const title=document.createElementNS(ns,'title');
    title.textContent=(isLive?'LIVE · ':'')+new Date((Number(c.time)+19800)*1000).toISOString().slice(11,16)+' IST · O '+showNumber(c.open)+' H '+showNumber(c.high)+' L '+showNumber(c.low)+' C '+showNumber(c.close)+' · Vol '+showNumber(c.volume,0);
    body.append(title);svg.append(wick,body);
    if(isLive){
      const tag=document.createElementNS(ns,'text');tag.setAttribute('x',x);tag.setAttribute('y',top+18);tag.setAttribute('text-anchor','middle');tag.setAttribute('font-size','15');tag.setAttribute('font-weight','900');tag.setAttribute('fill','#7bd8ff');tag.textContent='LIVE';svg.append(tag);
    }
  });
  // These levels are option-premium prices, not underlying-share prices.
  // Show a dedicated arrow lane above the underlying chart to avoid mixing scales.
  if (chartSetupLevels) {
    const markers = [
      { label: 'OPTION ENTRY', value: chartSetupLevels.entry, color: '#4c9aff' },
      { label: 'OPTION STOP LOSS', value: chartSetupLevels.stopLoss, color: '#ea3943' },
      { label: 'OPTION TARGET', value: chartSetupLevels.target, color: '#16c784' }
    ];
    markers.forEach((item, index) => {
      const yy = 36 + index * 28;
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', left + 4); line.setAttribute('x2', left + plotW - 5);
      line.setAttribute('y1', yy); line.setAttribute('y2', yy);
      line.setAttribute('stroke', item.color); line.setAttribute('stroke-width', '2.5');
      line.setAttribute('stroke-dasharray', index === 0 ? 'none' : '8 5');
      line.setAttribute('opacity', '.95'); svg.append(line);
      const arrow = document.createElementNS(ns, 'path');
      arrow.setAttribute('d', 'M ' + (left + plotW - 15) + ' ' + (yy - 8) + ' L ' + (left + plotW - 4) + ' ' + yy + ' L ' + (left + plotW - 15) + ' ' + (yy + 8));
      arrow.setAttribute('fill', 'none'); arrow.setAttribute('stroke', item.color);
      arrow.setAttribute('stroke-width', '3'); arrow.setAttribute('stroke-linecap', 'round');
      arrow.setAttribute('stroke-linejoin', 'round'); svg.append(arrow);
      const bg = document.createElementNS(ns, 'rect');
      bg.setAttribute('x', left + 12); bg.setAttribute('y', yy - 11);
      bg.setAttribute('width', 210); bg.setAttribute('height', 22);
      bg.setAttribute('rx', 5); bg.setAttribute('fill', '#091522');
      bg.setAttribute('stroke', item.color); bg.setAttribute('stroke-width', '1'); svg.append(bg);
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('x', left + 20); label.setAttribute('y', yy + 4);
      label.setAttribute('fill', item.color); label.setAttribute('font-size', '12');
      label.setAttribute('font-weight', '900');
      label.textContent = item.label + '  ₹' + showNumber(item.value); svg.append(label);
    });
  }
  for(let i=0;i<=4;i++){
    const index=Math.min(visible.length-1,Math.round((visible.length-1)*i/4)),c=visible[index];
    const label=document.createElementNS(ns,'text');label.setAttribute('x',xAt(index));label.setAttribute('y',550);label.setAttribute('text-anchor',i===0?'start':i===4?'end':'middle');label.setAttribute('fill','#9bb0ca');label.setAttribute('font-size','14');
    label.textContent=new Date((Number(c.time)+19800)*1000).toISOString().slice(11,16)+' IST';svg.append(label);
  }
  const crossV=document.createElementNS(ns,'line');crossV.setAttribute('id','chart-crosshair-v');crossV.setAttribute('y1',top);crossV.setAttribute('y2',top+plotH);crossV.setAttribute('stroke','#c6d4e6');crossV.setAttribute('stroke-dasharray','4 5');crossV.setAttribute('opacity','0');
  const crossH=document.createElementNS(ns,'line');crossH.setAttribute('id','chart-crosshair-h');crossH.setAttribute('x1',left);crossH.setAttribute('x2',left+plotW);crossH.setAttribute('stroke','#c6d4e6');crossH.setAttribute('stroke-dasharray','4 5');crossH.setAttribute('opacity','0');
  svg.append(crossV,crossH);
  const info=document.createElementNS(ns,'text');info.setAttribute('id','chart-crosshair-info');info.setAttribute('x',left+8);info.setAttribute('y',18);info.setAttribute('fill','#dceaff');info.setAttribute('font-size','14');info.textContent='Move over chart for candle time and OHLCV';svg.append(info);
  svg.addEventListener('pointermove',event=>{
    const rect=svg.getBoundingClientRect(),px=(event.clientX-rect.left)/rect.width*1200,py=(event.clientY-rect.top)/rect.height*620;
    if(px<left||px>left+plotW||py<top||py>top+plotH)return;
    const index=Math.max(0,Math.min(visible.length-1,Math.floor((px-left)/xStep))),c=visible[index],price=ceiling-(py-top)/plotH*span;
    crossV.setAttribute('x1',px);crossV.setAttribute('x2',px);crossV.setAttribute('opacity','1');crossH.setAttribute('y1',py);crossH.setAttribute('y2',py);crossH.setAttribute('opacity','1');
    info.textContent=new Date((Number(c.time)+19800)*1000).toISOString().slice(11,16)+' IST · O '+showNumber(c.open)+' H '+showNumber(c.high)+' L '+showNumber(c.low)+' C '+showNumber(c.close)+' · V '+showNumber(c.volume,0)+' · CURSOR '+showNumber(price);
  });
  svg.addEventListener('pointerleave',()=>{crossV.setAttribute('opacity','0');crossH.setAttribute('opacity','0');info.textContent='Move over chart for candle time and OHLCV';});
  // Draw the watermark after candles/zones so it remains visible on dark charts.
  // Pointer events stay disabled so chart crosshair and OHLCV inspection keep working.
  const watermark = document.createElementNS(ns, 'text');
  watermark.setAttribute('class', 'chart-symbol-watermark');
  watermark.setAttribute('x', '592');
  watermark.setAttribute('y', '315');
  watermark.setAttribute('text-anchor', 'middle');
  watermark.setAttribute('dominant-baseline', 'middle');
  watermark.setAttribute('fill', '#b8c9df');
  watermark.setAttribute('fill-opacity', '0.22');
  watermark.setAttribute('stroke', '#b8c9df');
  watermark.setAttribute('stroke-opacity', '0.08');
  watermark.setAttribute('stroke-width', '1');
  watermark.setAttribute('font-size', '72');
  watermark.setAttribute('font-weight', '900');
  watermark.setAttribute('letter-spacing', '4');
  watermark.setAttribute('pointer-events', 'none');
  watermark.textContent = chartSymbolLabel;
  svg.append(watermark);
  area.append(svg);
  const livePresent = Boolean(chartLiveCandle && visible.some(c=>c.time===chartLiveCandle.time));
  document.querySelector('#chart-candle-status').textContent=(visible.length-(livePresent?1:0))+' COMPLETED CANDLES · '+(livePresent?'LIVE 5-MIN CANDLE · TICK BUILT':'WAITING FOR LIVE UNDERLYING TICK');
}
document.querySelector('#chart-zoom-in').addEventListener('click',()=>{chartZoom=Math.min(4,chartZoom*1.35);renderChartViewport();});
document.querySelector('#chart-zoom-out').addEventListener('click',()=>{chartZoom=Math.max(1,chartZoom/1.35);renderChartViewport();});
document.querySelector('#chart-reset').addEventListener('click',()=>{chartZoom=1;renderChartViewport();});

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
function renderResearchResults(setup) {
  const status=document.querySelector('#research-status'),container=document.querySelector('#research-results');
  container.replaceChildren();
  const ranking=Array.isArray(setup?.researchRanking)?setup.researchRanking:[];
  if(ranking.length && ['LONG','SHORT'].includes(ranking[0]?.side)) {
    const desiredSide=ranking[0].side==='LONG'?'CE':'PE';
    const sideChanged=selectedOptionSide!==desiredSide;
    if(sideChanged) {
      selectedOptionSide=desiredSide;
      document.querySelector('#ce-select').classList.toggle('active',desiredSide==='CE');
      document.querySelector('#pe-select').classList.toggle('active',desiredSide==='PE');
    }
    if((sideChanged || !selectedContractSymbol) && optionChainRows.length && selectedUnderlyingPrice>0) {
      renderOptionStrikes(selectedUnderlyingPrice);
    }
  }
  if(!ranking.length) {
    status.textContent=setup?.research?.status==='UNAVAILABLE'?'RESEARCH DATA INCOMPLETE':'NO VERIFIED RESEARCH RANKING';
    const note=document.createElement('div');note.className='empty-inline';
    note.textContent=setup?.reason||setup?.research?.reason||'No setup passed all nine-strategy and verified-data gates; no score is fabricated.';
    container.append(note);return;
  }
  status.textContent='VERIFIED MULTI-TIMEFRAME · TOP '+ranking.length+' · DIRECTION-AWARE CE/PE';
  for(const item of ranking) {
    const card=document.createElement('article');card.className='research-card';
    const head=document.createElement('div');head.className='research-card-head';
    const name=document.createElement('strong');name.textContent='#'+item.rank+' '+item.strategy;
    const score=document.createElement('b');score.textContent=item.qualityScore+'/100 · '+item.grade;
    head.append(name,score);
    const tf=document.createElement('p');tf.textContent='Daily '+item.timeframes.daily+' · 15m '+item.timeframes.fifteenMinute+' · 5m '+item.timeframes.fiveMinute;
    const evidence=document.createElement('small');evidence.textContent=(item.evidence||[]).join(' · ');
    const invalid=document.createElement('small');invalid.textContent='Invalidation: '+item.invalidation;
    card.append(head,tf,evidence,invalid);container.append(card);
  }
}
async function evaluateSelectedSetup() {
  if (setupEvaluationRunning || setupEvaluationDone || !selectedSymbol || !selectedContractSymbol) return;
  setupEvaluationRunning = true;
  const evaluatedSymbol=selectedSymbol,evaluatedContract=selectedContractSymbol;
  const state=document.querySelector('#setup-state');
  state.textContent='VERIFYING 9 STRATEGIES · FYERS DATA';
  const researchStatus=document.querySelector('#research-status');
  researchStatus.textContent=(evaluatedSymbol.replace(/^(NSE|BSE):/,'').replace(/-EQ$/,'')+' · NINE-STRATEGY RESEARCH RUNNING');
  const researchResults=document.querySelector('#research-results');
  researchResults.replaceChildren();
  const researchNote=document.createElement('div');
  researchNote.className='empty-inline';
  researchNote.textContent='Checking verified FYERS daily, 15-minute and completed 5-minute candles for the selected stock.';
  researchResults.append(researchNote);
  for(const id of ['setup-entry','setup-sl','setup-target','setup-rr']) document.getElementById(id).textContent='—';
  chartSetupLevels = null;
  renderChartViewport();
  try {
    const response=await fetch('/api/evaluate-setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({underlying:selectedSymbol,contract:selectedContractSymbol})});
    const setup=await response.json();
    if(selectedSymbol!==evaluatedSymbol||selectedContractSymbol!==evaluatedContract)return;
    setupEvaluationDone = true;
    if (Array.isArray(setup.researchRanking) && setup.researchRanking.length) renderResearchResults(setup);
    const marketStatus = await fetch('/api/market-data',{cache:'no-store'}).then(r=>r.json()).catch(()=>null);
    setupLastBucket = marketStatus?.selectedUnderlying?.exchangeTime ? Math.floor(Number(marketStatus.selectedUnderlying.exchangeTime)/300)*300 : setupLastBucket;
    if(setup.status==='SETUP_CONFIRMED') {
      document.querySelector('#setup-entry').textContent='₹'+showNumber(setup.entry);
      document.querySelector('#setup-sl').textContent='₹'+showNumber(setup.stopLoss);
      document.querySelector('#setup-target').textContent='₹'+showNumber(setup.target);
      document.querySelector('#setup-rr').textContent='1:'+showNumber(setup.rr);
      state.textContent=setup.strategy+' · '+setup.optionSide+' · VERIFIED'; state.dataset.state='confirmed';
      chartSetupLevels = { entry: Number(setup.entry), stopLoss: Number(setup.stopLoss), target: Number(setup.target) };
      renderChartViewport();
    } else {
      chartSetupLevels = null; renderChartViewport();
      state.textContent=(setup.status||'NO TRADE')+' · '+(setup.reason||'No confirmed setup'); state.dataset.state='blocked';
    }
  } catch(error) { setupEvaluationDone=true; chartSetupLevels=null; renderChartViewport(); state.textContent='NO TRADE · '+String(error.message||'Setup verification unavailable'); state.dataset.state='blocked'; }
  finally { setupEvaluationRunning=false; }
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
    chartSetupLevels = null; renderChartViewport();
    setupEvaluationDone = false;
    document.querySelector('#option-quantity').textContent = showNumber(result.contract.lotSize,0);
    document.querySelector('#option-ltp').textContent = 'WAITING FOR LIVE OPTION TICK';
    const subscriptionState = result.subscription?.status || 'SUBSCRIPTION_STATE_UNAVAILABLE';
    status.textContent = result.contract.side + ' · ' + showNumber(result.contract.strike) + ' · MASTER VERIFIED · ' + subscriptionState + ' · LIVE TICK PENDING';
    document.querySelector('#setup-state').textContent='WAITING FOR FRESH UNDERLYING + OPTION TICKS';
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
