import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [app, css, html, manifest, serviceWorker, server] = await Promise.all([
  readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/style.css', import.meta.url), 'utf8'),
  readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../public/sw.js', import.meta.url), 'utf8'),
  readFile(new URL('../server.js', import.meta.url), 'utf8')
]);

test('top five gainer cards expose direction and stale-state styling', () => {
  for (const state of ['up', 'down', 'flat', 'stale']) {
    assert.ok(css.includes('.mover-card[data-state="' + state + '"]'));
  }
  assert.match(app, /button\.dataset\.state = cardState/);
  assert.match(app, /change\.dataset\.state = view\.mode === 'LIVE' && item\.fresh \? direction : 'stale'/);
});

test('verified option entry, stop and target are rendered as labelled chart arrows', () => {
  for (const label of ['OPTION ENTRY', 'OPTION STOP LOSS', 'OPTION TARGET']) {
    assert.ok(app.includes(label));
  }
  assert.match(app, /chartSetupLevels = \{ entry: Number\(setup\.entry\), stopLoss: Number\(setup\.stopLoss\), target: Number\(setup\.target\) \}/);
  assert.match(app, /These levels are option-premium prices, not underlying-share prices/);
});

test('PWA supports standalone desktop/mobile layout, responsive breakpoints, and v14 chart cache', () => {
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.display_override.includes('standalone'));
  assert.ok(html.includes('viewport-fit=cover'));
  assert.ok(css.includes('@media(min-width:1200px)'));
  assert.ok(css.includes('@media(min-width:701px) and (max-width:1100px)'));
  assert.ok(css.includes('@media(max-width:700px)'));
  assert.match(serviceWorker, /upgrade-ai-pro-shell-v16/);
});

test('top five gainers use distinct rank-based card colors', () => {
  assert.ok(app.includes('button.dataset.rank = String(index + 1)'));
  for (const rank of ['1', '2', '3', '4', '5']) {
    assert.ok(css.includes('.mover-card[data-rank="' + rank + '"]'));
  }
});

test('chart supports direct TradingView-style zoom and pan without legacy zoom buttons', () => {
  for (const legacyId of ['chart-zoom-in','chart-zoom-out','chart-reset']) assert.ok(!html.includes(legacyId));
  assert.match(app, /addEventListener\('wheel'/);
  assert.match(app, /addEventListener\('pointerdown'/);
  assert.match(app, /addEventListener\('pointermove'/);
  assert.match(app, /addEventListener\('dblclick'/);
  assert.match(app, /chartPan/);
  assert.match(css, /touch-action:none/);
  assert.match(serviceWorker, /upgrade-ai-pro-shell-v16/);
});

test('early option breakout is rechecked on the live tick, not delayed until the next 5-minute candle', () => {
  assert.match(app, /setupOptionTrigger/);
  assert.match(app, /entryTriggerPrice/);
  assert.match(app, /setupRetryAfter = Date\.now\(\) \+ 5000/);
  assert.match(app, /Number\(optionTick\.price\).*entryTriggerPrice/);
});

test('entry evaluation respects FYERS one-hour REST cooldown instead of retrying every poll', () => {
  assert.match(server, /retryAt:rateLimited&&rest\.cooldownUntil\?rest\.cooldownUntil:null/);
  assert.match(app, /if\(response\.status===429\)/);
  assert.match(app, /Number\(setup\.retryAt\).*Date\.now\(\)/);
  assert.match(app, /60\*60\*1000/);
});

test('entry evaluation retries transient stale ticks and network/server failures without weakening trade gates', () => {
  assert.match(app, /underlying\|option\) tick \(\?:became stale\|is not fresh\)/);
  assert.match(app, /Date\.now\(\) \+ 5000/);
  assert.match(app, /Date\.now\(\)\+15000/);
  assert.match(app, /response\.status>=500/);
});

test('directional and manual option-selection responses cannot overwrite a newer symbol, side or strike', () => {
  assert.match(app, /const requestedUnderlying=selectedSymbol,requestedSide=optionSide/);
  assert.match(app, /selectedSymbol!==requestedUnderlying\|\|selectedOptionSide!==requestedSide/);
  assert.match(app, /const requestedUnderlying=selectedSymbol,requestedSymbol=symbol/);
  assert.match(app, /document\.querySelector\('#strike-select'\)\.value!==requestedSymbol/);
  assert.match(app, /selectedContractSymbol=null; setupOptionTrigger=null; setupRetryAfter=0; setupEvaluationDone=true/);
});

test('verified chart history is fetched even when live socket pinning is unavailable', () => {
  const start = app.indexOf('async function selectSymbol(');
  const end = app.indexOf('\nfunction drawHistoryChart', start);
  assert.ok(start >= 0 && end > start, 'selectSymbol implementation is present');
  const selectionFlow = app.slice(start, end);
  const pinAttempt = selectionFlow.indexOf("fetch('/api/select-underlying'");
  const historyRequest = selectionFlow.indexOf("fetch('/api/history?symbol='");
  assert.ok(pinAttempt >= 0 && historyRequest > pinAttempt,
    'socket pin is attempted before independent history retrieval');
  assert.match(selectionFlow, /socketPinError = String\(error\.message/);
  assert.match(selectionFlow, /LIVE FEED UNAVAILABLE · NO TRADE/);
  assert.match(selectionFlow, /catch \(error\) \{[\s\S]*?socketPinError = String\(error\.message[\s\S]*?\}\s*if \(selectedSymbol !== symbol \|\| selectionGeneration !== symbolSelectionGeneration\) return;\s*try \{\s*const response = await fetch\('\/api\/history\?symbol='/,
    'socket pin failure is isolated and history retrieval still follows');
});

test('verified history chart survives option-chain and research failures', () => {
  const start = app.indexOf('async function selectSymbol(');
  const end = app.indexOf('\nfunction drawHistoryChart', start);
  assert.ok(start >= 0 && end > start, 'selectSymbol implementation is present');
  const selectionFlow = app.slice(start, end);
  const chartRender = selectionFlow.indexOf('drawHistoryChart(data.candles)');
  const optionFlow = selectionFlow.indexOf('await loadOptionChain');
  const researchFlow = selectionFlow.indexOf('await ensureResearchContext(symbol)');
  assert.ok(chartRender >= 0 && optionFlow > chartRender && researchFlow > chartRender,
    'chart is rendered before downstream option and research requests');
  assert.match(app, /fetch\('\/api\/research-context\?symbol='/,
    'research context is fetched by the shared warmup gate');
  const postHistory = selectionFlow.slice(chartRender);
  const downstream = selectionFlow.slice(optionFlow);
  assert.match(postHistory, /OPTION CHAIN UNAVAILABLE/);
  assert.match(postHistory, /RESEARCH UNAVAILABLE · NO TRADE/);
  assert.doesNotMatch(downstream, /area\.replaceChildren\(\)/,
    'downstream failures must not clear the rendered chart');
  assert.match(app, /FYERS HISTORY \/api\/history/);
  assert.match(app, /OPTION CHAIN \/api\/option-chain/);
  assert.match(app, /returned non-JSON response · HTTP/);
});


test('read-only positions and orderbook REST polling is throttled to two minutes', () => {
  assert.match(app, /const ACCOUNT_REFRESH_INTERVAL_MS = 120_000/);
  assert.match(app, /Date\.now\(\) - lastAccountRefresh >= ACCOUNT_REFRESH_INTERVAL_MS/);
  assert.match(app, /fetch\('\/api\/orderbook'/);
  assert.match(app, /fetch\('\/api\/positions'/);
});


import { isNseRegularSession, normalizeTopGainersSnapshot, resolveTopGainersView, normalizeChartSnapshot } from '../public/session-snapshot.js';

test('last verified Top 5 gainers remain visible after market close and are never labelled live', () => {
  const savedAt = Date.parse('2026-11-20T09:59:00Z');
  const snapshot = normalizeTopGainersSnapshot({ savedAt, items: Array.from({length:5},(_,i)=>({symbol:'NSE:STOCK'+i+'-EQ',price:100+i,changePercent:5-i,fresh:true})) });
  const view = resolveTopGainersView({status:'WAITING_FOR_FNO_TICKS',topGainers:[]}, snapshot, Date.parse('2026-11-20T10:00:00Z'));
  assert.equal(view.mode, 'LAST_SESSION');
  assert.equal(view.items.length, 5);
  assert.equal(view.items[0].fresh, false);
  assert.equal(resolveTopGainersView({status:'SOCKET_ERROR'}, snapshot, Date.parse('2026-11-20T10:00:00Z')).mode, 'LAST_SESSION');
});

test('last observed Top 5 remains visible during session feed failure with an explicit stale state', () => {
  const snapshot = { savedAt: Date.now(), items: [{symbol:'NSE:ABC-EQ',price:123,changePercent:2.5}] };
  const view = resolveTopGainersView({status:'SOCKET_ERROR'}, snapshot, Date.parse('2026-11-20T06:00:00Z'));
  assert.equal(view.mode, 'LAST_OBSERVED');
  assert.equal(view.items[0].fresh, false);
});

test('rolling Top 5 remains visible during the live session when observations age beyond the 10-second tick gate', () => {
  const fno = {
    status:'ROTATING_LIVE_COVERAGE', observedCount:18, freshCount:2, universeCount:218,
    maxObservationAgeSeconds:3360,
    topGainers:[
      {symbol:'NSE:AAA-EQ',price:120,changePercent:5.2,fresh:true,ageSeconds:2},
      {symbol:'NSE:BBB-EQ',price:110,changePercent:4.1,fresh:false,ageSeconds:38}
    ]
  };
  const view = resolveTopGainersView(fno, null, Date.parse('2026-11-20T06:00:00Z'));
  assert.equal(view.mode,'LIVE');
  assert.equal(view.items.length,2);
  assert.equal(view.items[0].fresh,true);
  assert.equal(view.items[1].fresh,false);
  assert.match(app,/OBSERVED ' \+ Number\(item\.ageSeconds\)\.toFixed\(0\) \+ 's · NOT ACTIONABLE/);
});

test('rolling Top 5 rejects observations outside the declared rolling age window', () => {
  const fno = {
    status:'ROTATING_LIVE_COVERAGE', observedCount:1, freshCount:0, universeCount:218,
    maxObservationAgeSeconds:120,
    topGainers:[{symbol:'NSE:AAA-EQ',price:120,changePercent:5.2,fresh:false,ageSeconds:121}]
  };
  const view = resolveTopGainersView(fno, null, Date.parse('2026-11-20T06:00:00Z'));
  assert.equal(view.mode,'WAITING');
});

test('NSE regular session uses India time and excludes weekends and 15:30 close', () => {
  assert.equal(isNseRegularSession(Date.parse('2026-11-20T03:45:00Z')), true);
  assert.equal(isNseRegularSession(Date.parse('2026-11-20T10:00:00Z')), false);
  assert.equal(isNseRegularSession(Date.parse('2026-11-21T05:00:00Z')), false);
});

test('verified chart snapshot survives reload with bounded valid candles and rejects malformed data', () => {
  const candles = Array.from({length:900},(_,i)=>({time:1760000000+i*300,open:100,high:105,low:95,close:102,volume:1000}));
  const snapshot = normalizeChartSnapshot({symbol:'NSE:ABC-EQ',savedAt:Date.now(),candles});
  assert.equal(snapshot.candles.length,800);
  assert.equal(snapshot.symbol,'NSE:ABC-EQ');
  assert.equal(normalizeChartSnapshot({symbol:'NSE:ABC-EQ',candles:[{time:1,open:100,high:90,low:95,close:99}]}),null);
  assert.equal(normalizeChartSnapshot({symbol:'NSE:ABC-EQ',candles:[]}),null);
});

test('PWA offline shell caches the last-session snapshot module and bumps its cache version', () => {
  assert.match(serviceWorker, /upgrade-ai-pro-shell-v16/);
  assert.match(serviceWorker, /'\/session-snapshot\.js'/);
});


test('restored cached chart never suppresses a fresh verified history request for the same symbol', () => {
  const start = app.indexOf('async function selectSymbol(');
  const end = app.indexOf('\nfunction drawHistoryChart', start);
  assert.ok(start >= 0 && end > start, 'selectSymbol implementation is present');
  const flow = app.slice(start, end);
  assert.ok(flow.includes('if (symbol === selectedSymbol && !chartRestoredFromCache) return'));
  assert.ok(app.includes('chartRestoredFromCache && selectedSymbol === underlyingTick?.symbol'));
  assert.ok(flow.includes("fetch('/api/history?symbol='"));
});

test('scanner UI defaults to the real four-symbol slice, not the obsolete eleven-symbol fallback', () => {
  assert.ok(app.includes('data.scanPerSlice??4'));
  assert.ok(!app.includes('data.scanPerSlice||11'));
});


test('fresh FYERS ticks are never labelled LIVE outside NSE regular session', () => {
  const closed = Date.parse('2026-11-20T10:18:00Z'); // 15:48 IST
  const freshGainers = { status: 'ROTATING_LIVE_COVERAGE', topGainers: Array.from({length:5},(_,i)=>({symbol:'NSE:STOCK'+i+'-EQ',price:100,changePercent:1,fresh:true})) };
  const view = resolveTopGainersView(freshGainers, null, closed);
  assert.notEqual(view.mode, 'LIVE');
  assert.equal(view.mode, 'MARKET_CLOSED_NO_SNAPSHOT');
  assert.match(app, /if \(!isNseRegularSession\(Date\.now\(\)\)\) return 'MARKET CLOSED · FYERS LAST PRICES · NOT LIVE'/);
  assert.match(app, /const nseSessionOpen = isNseRegularSession\(Date\.now\(\)\)/);
  assert.match(app, /if \(nseSessionOpen && tick\?\.fresh\)/);
  assert.match(app, /if \(!nseSessionOpen\) \{/);
});


test('chart requests ten completed NSE trading sessions and renders day partitions with IST timestamps', async () => {
  const rest = await readFile(new URL('../src/fyers-rest.js', import.meta.url), 'utf8');
  assert.match(rest, /getFiveMinuteHistoryRange\(now, 20\)/);
  assert.match(rest, /filterLastNseTradingSessions\(normalizeFiveMinuteCandles\(body\.candles, now\), 10\)/);
  assert.match(rest, /LAST_10_NSE_TRADING_SESSIONS/);
  assert.match(app, /dayGroups\.forEach/);
  assert.match(app, /YYYY-MM-DD HH:mm IST timestamp/);
  assert.match(app, /toISOString\(\)\.slice\(0,16\)\.replace\('T',' '\)/);
  assert.match(html, /10 NSE TRADING DAYS/);
  assert.match(html, /DAY-WISE PARTITIONS/);
});

test('ten-session chart cache preserves up to 800 verified five-minute candles', () => {
  const snapshotSource = app.includes('normalizeChartSnapshot');
  assert.ok(snapshotSource);
  assert.match(serviceWorker, /upgrade-ai-pro-shell-v16/);
});

test('live candle summary is rendered only after the matching fresh tick updates the chart candle', () => {
  const start = app.indexOf('async function refresh()');
  const end = app.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start, 'refresh implementation is present');
  const flow = app.slice(start, end);
  const update = flow.indexOf('chartLiveCandle = underlyingTick.liveCandle || null');
  const summary = flow.indexOf('renderLiveCandleSummary(underlyingTick)');
  assert.ok(update >= 0 && summary > update,
    'summary must render after the live candle from the same status snapshot is assigned');
  assert.match(flow, /if \(selectedSymbol && underlyingTick\?\.symbol === selectedSymbol && underlyingTick\.fresh\) \{[\s\S]*?chartLiveCandle = underlyingTick\.liveCandle \|\| null;[\s\S]*?renderChartViewport\(\);/);
});

test('option contract identity check is independent of selected underlying tick freshness', () => {
  const start = server.indexOf("if (req.method === 'POST' && url.pathname === '/api/select-option')");
  const end = server.indexOf("if (req.method === 'POST' && url.pathname.startsWith('/api/orders'))", start);
  assert.ok(start >= 0 && end > start, 'manual option-selection route is present');
  const route = server.slice(start, end);
  assert.match(route, /verifyOptionContractUnderlying\(contract, market\.selectedUnderlyingSymbol\)/);
  assert.doesNotMatch(route, /market\.selectedUnderlying\?\.fresh/);
  assert.match(route, /liveTickRequired:true/);
});


test('live F&O scanner keeps the default DOM compact without weakening strategy diagnostics', () => {
  assert.match(app, /activeEvaluationsAll=\(data\.evaluations\|\|\[\]\)\.filter/);
  assert.match(app, /activeEvaluations=activeEvaluationsAll\.slice\(0,4\)/);
  assert.match(app, /for\(const item of stock\.strategyLedger\|\|\[\]\)/);
  assert.doesNotMatch(app, /for\(const stock of data\.symbolCoverage\|\|\[\]\)/);
  assert.match(app, /coverage\.freshTickCount/);
  assert.match(app, /coverage\.staleTickCount/);
  assert.match(app, /coverage\.noTickCount/);
  assert.match(app, /RESEARCH · /);
  assert.doesNotMatch(app, /warmupLastFailure/);
});


test('status polling is single-flight and paused while the workstation tab is hidden', () => {
  assert.match(app, /if \(refreshRunning \|\| document\.hidden\) return/);
  assert.match(app, /refreshRunning = true/);
  assert.match(app, /finally \{\s*refreshRunning = false;/);
  assert.match(app, /function startStatusPolling\(\)/);
  assert.match(app, /function stopStatusPolling\(\)/);
  assert.match(app, /document\.addEventListener\('visibilitychange'/);
  assert.match(app, /if \(document\.hidden\) stopStatusPolling\(\);\s*else startStatusPolling\(\);/);
});


test('PWA updates activate the versioned shell, evict old caches and never intercept live APIs', () => {
  assert.match(serviceWorker, /self\.skipWaiting\(\)/);
  assert.match(serviceWorker, /self\.clients\.claim\(\)/);
  assert.match(serviceWorker, /keys\.filter\(k=>k!==CACHE\)/);
  assert.match(serviceWorker, /u\.pathname\.startsWith\('\/api\/'\)\)return/);
});

test('research context warms fresh 15m history without requesting daily candles', () => {
  const start = server.indexOf("if (url.pathname === '/api/research-context')");
  const end = server.indexOf("if (url.pathname === '/api/research/historical-universe')", start);
  const flow = server.slice(start, end);
  assert.match(flow, /getFifteenMinuteHistory/);
  assert.doesNotMatch(flow, /getDailyHistory/);
  assert.match(flow, /entryContext:'15M_TREND_PLUS_5M_PRICE_STRUCTURE'/);
});

test('index chart selection does not request equity-only research context', () => {
  assert.match(app, /labels\.some\(\(\[indexSymbol\]\) => indexSymbol === symbol\)/);
  assert.match(app, /researchContextReadySymbol = symbol;[\s\S]*?return;/);
});

test('live setup loads 15m and 5m context without daily-history dependency', () => {
  const start = server.indexOf("if (req.method === 'POST' && url.pathname === '/api/evaluate-setup')");
  const end = server.indexOf("if (req.method === 'POST' && url.pathname === '/api/auto-select-option')", start);
  const flow = server.slice(start, end);
  const underlying = flow.indexOf("const underlyingHistory = await getFiveMinuteHistory");
  const option = flow.indexOf("const optionHistory = await getFiveMinuteHistory");
  const fifteen = flow.indexOf("const fifteenMinuteHistory = await getFifteenMinuteHistory");
  assert.ok(underlying >= 0 && option > underlying && fifteen > option, '5m underlying, option and 15m trend histories are sequential');
  assert.doesNotMatch(flow, /getDailyHistory/);
  assert.match(flow, /fifteenMinuteCandles:fifteenMinuteHistory\.candles/);
  assert.doesNotMatch(flow, /Promise\\.all\\(/, 'entry history reads are not queued as a burst');
  assert.match(flow, /REST_PRIORITY\\.ENTRY/, 'entry reads retain ENTRY priority');
});

test('live ticks never replace the chart loading or history-error state when completed history is absent', () => {
  const start = app.indexOf('function renderChartViewport()');
  const end = app.indexOf('\nfunction ', start + 10);
  assert.ok(start >= 0 && end > start, 'chart renderer is present');
  const renderer = app.slice(start, end);
  const historyGuard = renderer.indexOf('if (!chartCandles.length) return;');
  const clearArea = renderer.indexOf('area.replaceChildren();');
  assert.ok(historyGuard >= 0 && clearArea > historyGuard,
    'renderer must preserve loading/error content until verified completed candles exist');
  assert.match(renderer, /chartLiveCandle[\s\S]*?chartCandles/);
});
