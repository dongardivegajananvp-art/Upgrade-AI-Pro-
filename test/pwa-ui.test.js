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

test('PWA supports standalone desktop/mobile layout and responsive breakpoints', () => {
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.display_override.includes('standalone'));
  assert.ok(html.includes('viewport-fit=cover'));
  assert.ok(css.includes('@media(min-width:1200px)'));
  assert.ok(css.includes('@media(min-width:701px) and (max-width:1100px)'));
  assert.ok(css.includes('@media(max-width:700px)'));
  assert.match(serviceWorker, /upgrade-ai-pro-shell-v10/);
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
  assert.match(serviceWorker, /upgrade-ai-pro-shell-v10/);
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
  assert.match(selectionFlow, /catch \(error\) \{[\s\S]*?socketPinError = String\(error\.message[\s\S]*?\}\s*if \(selectedSymbol !== symbol\) return;\s*try \{\s*const response = await fetch\('\/api\/history\?symbol='/,
    'socket pin failure is isolated and history retrieval still follows');
});

test('verified history chart survives option-chain and research failures', () => {
  const start = app.indexOf('async function selectSymbol(');
  const end = app.indexOf('\nfunction drawHistoryChart', start);
  assert.ok(start >= 0 && end > start, 'selectSymbol implementation is present');
  const selectionFlow = app.slice(start, end);
  const chartRender = selectionFlow.indexOf('drawHistoryChart(data.candles)');
  const optionFlow = selectionFlow.indexOf('await loadOptionChain');
  const researchFlow = selectionFlow.indexOf('/api/research-context');
  assert.ok(chartRender >= 0 && optionFlow > chartRender && researchFlow > chartRender,
    'chart is rendered before downstream option and research requests');
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

test('NSE regular session uses India time and excludes weekends and 15:30 close', () => {
  assert.equal(isNseRegularSession(Date.parse('2026-11-20T03:45:00Z')), true);
  assert.equal(isNseRegularSession(Date.parse('2026-11-20T10:00:00Z')), false);
  assert.equal(isNseRegularSession(Date.parse('2026-11-21T05:00:00Z')), false);
});

test('verified chart snapshot survives reload with bounded valid candles and rejects malformed data', () => {
  const candles = Array.from({length:300},(_,i)=>({time:1760000000+i*300,open:100,high:105,low:95,close:102,volume:1000}));
  const snapshot = normalizeChartSnapshot({symbol:'NSE:ABC-EQ',savedAt:Date.now(),candles});
  assert.equal(snapshot.candles.length,240);
  assert.equal(snapshot.symbol,'NSE:ABC-EQ');
  assert.equal(normalizeChartSnapshot({symbol:'NSE:ABC-EQ',candles:[{time:1,open:100,high:90,low:95,close:99}]}),null);
  assert.equal(normalizeChartSnapshot({symbol:'NSE:ABC-EQ',candles:[]}),null);
});

test('PWA offline shell caches the last-session snapshot module and bumps its cache version', () => {
  assert.match(serviceWorker, /upgrade-ai-pro-shell-v10/);
  assert.match(serviceWorker, /'\/session-snapshot\.js'/);
});
