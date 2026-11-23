import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessFeed, tradingEnabled } from './src/safety.js';
import { createLoginUrl, verifyLoginState, exchangeAuthCode, getAuthStatus, createSessionCookie, restoreSessionCookie } from './src/fyers-auth.js';
import { startMarketSocket, getMarketData, getFnoUniverseSnapshot, setFnoUniverse, setSelectedOptionSymbol, setSelectedUnderlyingSymbol } from './src/fyers-market-socket.js';
import { loadFnoEquityUniverse, getVerifiedOptionContract, getNseSessionDate } from './src/fyers-symbol-master.js';
import { chooseDirectionalOption, normalizeExpiryTimestamp, matchesRequestedExpiry, verifyOptionContractUnderlying } from './src/option-selection.js';
import { evaluateNineStrategies, detectNineStrategySetup } from './src/strategy-engine.js';
import { REST_PRIORITY } from './src/rest-scheduler-utils.js';
import { getFiveMinuteHistory, getFiveMinuteSessionHistory, getFifteenMinuteHistory, getFyersQuotes, getFyersOptionChain, getFyersPositions, getFyersOrderbook, getRestDiagnostics, getRestDispatchReadiness, getDailyHistory, getCachedResearchHistories, validateNseSymbol } from './src/fyers-rest.js';
import { evaluateRollingFnoUniverse } from './src/rolling-fno-strategy-engine.js';
import { createResearchWarmupQueue } from './src/research-warmup-queue.js';
import { SCANNER_POLL_INTERVAL_MS } from './src/scanner-scheduler.js';
import { buildHealthStatus } from './src/health-status.js';
import { getFnoSliceScanSymbols } from './src/rolling-fno-scanner.js';
import { isFreshFnoTick } from './src/fno-scan-gate.js';
import { requiresFyersSession } from './src/api-access.js';
import { isNseRegularSession } from './src/nse-session.js';
import { createSingleFlight } from './src/setup-evaluation-flight.js';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT || 3000);
const EXPECTED_REDIRECT_URI = 'https://upgrade-ai-pro.onrender.com/api/fyers/auth/callback';
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml' };

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 4096) throw new Error('Request body too large');
  }
  return raw ? JSON.parse(raw) : {};
}
function send(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer' });
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return res.end(body);
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function parseCookies(header='') {
  return Object.fromEntries(header.split(';').map(part=>part.trim()).filter(Boolean).map(part=>{
    const i=part.indexOf('=');
    return i<0 ? [part,''] : [part.slice(0,i),part.slice(i+1)];
  }));
}
const consumedOAuthStates = new Set();
const setupEvaluationFlight = createSingleFlight();
let fnoUniverseLoadPromise = null;
let fnoUniverseLoadedDate = null;
let fnoUniverseRetryDate = null;
let fnoUniverseLoadRetryAt = 0;
let fnoStrategyScanTimer = null;
let fnoStrategyScanBusy = false;
let fnoStrategyScanCursor = 0;
let fnoStrategyScanRotation = null;
let fnoStrategyScanLoggedRotation = null;
let fnoStrategyScanRetryAt = 0;
let fnoStrategyScanRetrySymbol = null;
const fnoResearchWarmupQueue = createResearchWarmupQueue({ maxSize: 500 });
// Per-underlying audit ledger: records actual scan attempts and explicit skips/failures.
// It is diagnostic only and never upgrades stale/missing data to an actionable setup.
const fnoSymbolScanLedger = new Map();
const fnoStrategyScanStats = { status:'NOT_STARTED', scannedCount:0, sliceScannedCount:0, lastSymbol:null, lastStatus:null, lastReason:null, lastScanAt:null, warmupSymbol:null, warmupStatus:'IDLE', warmupQueueDepth:0, warmupCompletedCount:0, warmupRejectedCount:0, warmupRetryCount:0, warmupLastCompletedSymbol:null, warmupLastFailure:null, warmupLastRetryAt:null };
function startFnoStrategyScanner() {
  if (fnoStrategyScanTimer) return;
  fnoStrategyScanStats.status='RUNNING';
  fnoStrategyScanTimer=setInterval(async () => {
    if (fnoStrategyScanBusy) return;
    if (Date.now() < fnoStrategyScanRetryAt) { fnoStrategyScanStats.status='WAITING_FOR_REST_BUDGET'; return; }
    if (!isNseRegularSession(Date.now())) {
      fnoStrategyScanStats.status='OUTSIDE_NSE_SESSION';
      return;
    }
    const sessionMarket=getMarketData();
    const freshIndexCount=Object.values(sessionMarket.indices||{}).filter(tick=>tick?.fresh).length;
    if (freshIndexCount===0) {
      fnoStrategyScanStats.status='WAITING_FOR_FRESH_INDEX_FEED';
      return;
    }
    const snapshot=getFnoUniverseSnapshot();
    const active=snapshot.activeSymbols || [];
    if (!active.length) { fnoStrategyScanStats.status='WAITING_FOR_ACTIVE_FNO_SLICE'; return; }
    // Do not consume warmup retry attempts or advance scans during FYERS's 429 cooldown.
    const restGate=getRestDiagnostics();
    if (restGate.cooldownActive || restGate.recoveryProbeRequired) {
      fnoStrategyScanStats.status=restGate.cooldownActive?'FYERS_REST_COOLDOWN_WAIT':'FYERS_REST_RECOVERY_PROBE_WAIT';
      return;
    }
    if (fnoStrategyScanRotation !== snapshot.rotationIndex) {
      fnoStrategyScanRotation=snapshot.rotationIndex;
      fnoStrategyScanCursor=0;
      fnoStrategyScanStats.sliceScannedCount=0;
      // Research warmups deliberately survive slice rotation; eligible candidates
      // discovered in the previous slice must not be discarded.
    }
    const scanLimit=Math.min(snapshot.scanPerSlice || 12,active.length);
    // Complete the new-symbol scan batch first; use the remaining slice time for
    // Daily/15m warmups so research preparation cannot starve F&O coverage.
    const retryPendingActive=Boolean(fnoStrategyScanRetrySymbol && active.includes(fnoStrategyScanRetrySymbol) &&
      isFreshFnoTick(snapshot.ticks.get(fnoStrategyScanRetrySymbol),Date.now()));
    const shouldWarmup=!retryPendingActive && fnoResearchWarmupQueue.size>0 && fnoResearchWarmupQueue.hasReady() && fnoStrategyScanCursor>=scanLimit;
    if (shouldWarmup) {
      const warmupSymbol=fnoResearchWarmupQueue.take();
      fnoStrategyScanStats.warmupQueueDepth=fnoResearchWarmupQueue.size;
      if (!warmupSymbol) return;
      fnoStrategyScanBusy=true;
      fnoStrategyScanStats.warmupSymbol=warmupSymbol;
      fnoStrategyScanStats.warmupStatus='LOADING_VERIFIED_DAILY_15M';
      try {
        await getDailyHistory(warmupSymbol,Date.now(),REST_PRIORITY.WARMUP,'scanner-warmup-daily');
        await getFifteenMinuteHistory(warmupSymbol,Date.now(),REST_PRIORITY.WARMUP,'scanner-warmup-15m');
        if (!fnoResearchWarmupQueue.complete(warmupSymbol)) {
          throw new Error('Research warmup queue completion state was not registered');
        }
        fnoStrategyScanStats.warmupStatus='VERIFIED_DAILY_15M_CACHED';
        fnoStrategyScanStats.warmupLastCompletedSymbol=warmupSymbol;
        fnoStrategyScanStats.warmupLastFailure=null;
        fnoStrategyScanStats.warmupLastRetryAt=null;
        fnoStrategyScanStats.warmupCompletedCount++;
      } catch(error) {
        const retry=fnoResearchWarmupQueue.fail(warmupSymbol);
        fnoStrategyScanStats.warmupStatus=retry.retry?'RETRY_QUEUED':'BLOCKED';
        fnoStrategyScanStats.warmupLastFailure=String(error.message||'Research history warmup failed').slice(0,180);
        fnoStrategyScanStats.warmupLastRetryAt=retry.retry?new Date(Date.now()+retry.retryAfterMs).toISOString():null;
        fnoStrategyScanStats.lastReason=fnoStrategyScanStats.warmupLastFailure+
          (retry.retry?(' · retry '+retry.attempt+'/'+retry.maxAttempts+' after '+Math.ceil(retry.retryAfterMs/1000)+'s'):' · retry limit exhausted; candidate remains unqualified');
        if(retry.retry) fnoStrategyScanStats.warmupRetryCount++;
        else fnoStrategyScanStats.warmupRejectedCount++;
      } finally {
        fnoStrategyScanStats.warmupQueueDepth=fnoResearchWarmupQueue.size;
        fnoStrategyScanBusy=false;
      }
      return;
    }
    if (fnoStrategyScanCursor>=scanLimit) return;
    const scanSymbols=getFnoSliceScanSymbols(active,scanLimit);
    const normalSymbol=scanSymbols[fnoStrategyScanCursor] || null;
    const retryCandidate=retryPendingActive;
    const symbol=retryCandidate ? fnoStrategyScanRetrySymbol : normalSymbol;
    if(!symbol) return;
    let scanTick=snapshot.ticks.get(symbol)||null;
    if(!isFreshFnoTick(scanTick,Date.now())) {
      fnoStrategyScanRetrySymbol=symbol;
      fnoStrategyScanStats.status='WAITING_FOR_FRESH_FNO_TICK';
      fnoStrategyScanStats.lastReason='Fresh FYERS underlying/futures tick is required; history request not queued';
      return;
    }
    const dispatchGate=getRestDispatchReadiness(REST_PRIORITY.SCANNER,'/history');
    if(!dispatchGate.ready) {
      fnoStrategyScanRetrySymbol=symbol;
      fnoStrategyScanStats.status='WAITING_FOR_REST_BUDGET';
      fnoStrategyScanStats.lastReason='Scanner request held before queue admission: '+dispatchGate.blockers.join(',');
      return;
    }
    if(!retryCandidate) fnoStrategyScanCursor++;
    fnoStrategyScanStats.status='RUNNING';
    const scanStartedAt=Date.now();
    fnoStrategyScanStats.sliceScannedCount++;
    fnoStrategyScanBusy=true;
    fnoSymbolScanLedger.set(symbol,{symbol,status:'SCANNING',attemptedAt:new Date(scanStartedAt).toISOString(),attemptCount:(fnoSymbolScanLedger.get(symbol)?.attemptCount||0)+1});
    try {
      // Re-read immediately before requesting history; the tick must still be fresh.
      const latest=getFnoUniverseSnapshot();
      scanTick=latest.ticks.get(symbol)||null;
      if(!isFreshFnoTick(scanTick,Date.now())) {
        throw new Error('Fresh FYERS underlying/futures tick is required; history request skipped');
      }
      const history=await getFiveMinuteHistory(symbol,Date.now(),REST_PRIORITY.SCANNER,'fno-scanner-5m');
      const tick=scanTick;
      const market=getMarketData();
      const research=detectNineStrategySetup({
        underlyingCandles:history.candles,underlyingTick:tick,
        isTopGainer:(market.fno?.topGainers||[]).some(item=>item.symbol===symbol),
        researchEnabled:false,now:Date.now()
      });
      fnoStrategyScanStats.scannedCount++;
      if(retryCandidate) { fnoStrategyScanRetrySymbol=null; fnoStrategyScanRetryAt=0; }
      fnoStrategyScanStats.lastSymbol=symbol;
      fnoStrategyScanStats.lastStatus=research.status;
      fnoStrategyScanStats.lastReason=research.reason||null;
      fnoStrategyScanStats.lastScanAt=new Date().toISOString();
      const tickAgeMs=tick?Date.now()-Number(tick.receivedAt):null;
      fnoSymbolScanLedger.set(symbol,{
        symbol,status:research.status,reason:research.reason||null,
        attemptedAt:new Date(scanStartedAt).toISOString(),scannedAt:fnoStrategyScanStats.lastScanAt,
        attemptCount:fnoSymbolScanLedger.get(symbol)?.attemptCount||1,
        tickFresh:Boolean(tick&&tickAgeMs>=0&&tickAgeMs<=10000&&Date.now()/1000-Number(tick.exchangeTime)>=-3&&Date.now()/1000-Number(tick.exchangeTime)<=10),
        tickExchangeTime:tick?.exchangeTime||null,tickReceivedAt:tick?.receivedAt||null,
        candleCount:history.candles.length,lastCompletedCandleTime:history.candles.at(-1)?.time||null,
        source:history.source||'FYERS_HISTORY',strategyLedger:research.strategyLedger||[]
      });
      if(research.status==='UNDERLYING_SETUP_CONFIRMED') {
        const queued=fnoResearchWarmupQueue.enqueue(symbol);
        fnoStrategyScanStats.warmupQueueDepth=fnoResearchWarmupQueue.size;
        if(queued) {
          fnoStrategyScanStats.warmupSymbol=symbol;
          fnoStrategyScanStats.warmupStatus='QUEUED_AFTER_SLICE_SCAN';
        } else if(!fnoResearchWarmupQueue.has(symbol)) {
          fnoStrategyScanStats.warmupRejectedCount++;
          fnoStrategyScanStats.lastReason='Research warmup queue is at capacity; candidate remains un-warmed and cannot qualify for Top 3';
        }
      }
    } catch(error) {
      const errorMessage=String(error.message||'F&O history scan failed');
      const retryable=/queued request expired|queue capacity|queue is full|cooldown active|recovery probe required|429/i.test(errorMessage);
      if(retryable) {
        fnoStrategyScanRetrySymbol=symbol;
        const retryDiagnostics=getRestDiagnostics();
        fnoStrategyScanRetryAt=retryDiagnostics.cooldownUntil ? Date.parse(retryDiagnostics.cooldownUntil) : Date.now()+10_000;
        fnoStrategyScanStats.status='WAITING_FOR_REST_BUDGET';
      } else if(retryCandidate) {
        fnoStrategyScanRetrySymbol=null;
        fnoStrategyScanRetryAt=0;
      }
      fnoStrategyScanStats.lastSymbol=symbol;
      fnoStrategyScanStats.lastStatus=retryable?'RETRY_QUEUED':'DATA_UNAVAILABLE_NO_TRADE';
      fnoStrategyScanStats.lastReason=String(error.message||'F&O history scan failed').slice(0,180);
      fnoStrategyScanStats.lastScanAt=new Date().toISOString();
      fnoSymbolScanLedger.set(symbol,{
        symbol,status:fnoStrategyScanStats.lastStatus,reason:fnoStrategyScanStats.lastReason,
        attemptedAt:new Date(scanStartedAt).toISOString(),scannedAt:fnoStrategyScanStats.lastScanAt,
        attemptCount:fnoSymbolScanLedger.get(symbol)?.attemptCount||1,
        tickFresh:isFreshFnoTick(scanTick,Date.now()),
        tickExchangeTime:scanTick?.exchangeTime||null,
        source:retryable?'FYERS_REST_RETRY_PENDING':isFreshFnoTick(scanTick,Date.now())?'FYERS_HISTORY_BLOCKED':'FYERS_SCAN_BLOCKED'
      });
    } finally {
      fnoStrategyScanBusy=false;
      const memory=process.memoryUsage();
      const scanRecord=fnoSymbolScanLedger.get(symbol)||{};
      console.info('[FYERS_SCANNER] symbol scan completed:',JSON.stringify({
        symbol,
        status:fnoStrategyScanStats.lastStatus,
        reason:scanRecord.reason||fnoStrategyScanStats.lastReason||null,
        tickFresh:scanRecord.tickFresh??false,
        tickExchangeTime:scanRecord.tickExchangeTime||null,
        lastCompletedCandleTime:scanRecord.lastCompletedCandleTime||null,
        candleCount:scanRecord.candleCount||0,
        evaluatedStrategyCount:Array.isArray(scanRecord.strategyLedger)?scanRecord.strategyLedger.filter(row=>row.status!=='BLOCKED').length:0,
        blockedStrategyCount:Array.isArray(scanRecord.strategyLedger)?scanRecord.strategyLedger.filter(row=>row.status==='BLOCKED').length:0,
        durationMs:Date.now()-scanStartedAt,
        restCooldownActive:getRestDiagnostics().cooldownActive,
        rssBytes:memory.rss,
        heapUsedBytes:memory.heapUsed
      }));
    }
    if (fnoStrategyScanCursor>=scanLimit && fnoStrategyScanLoggedRotation!==snapshot.rotationIndex) {
      fnoStrategyScanLoggedRotation=snapshot.rotationIndex;
      const memory=process.memoryUsage();
      console.info('[FYERS_SCANNER] slice completed:',JSON.stringify({
        rotationIndex:snapshot.rotationIndex,
        sliceScannedCount:fnoStrategyScanStats.sliceScannedCount,
        totalScannedCount:fnoStrategyScanStats.scannedCount,
        lastSymbol:fnoStrategyScanStats.lastSymbol,
        lastStatus:fnoStrategyScanStats.lastStatus,
        warmupQueueDepth:fnoResearchWarmupQueue.size,
        warmupCompletedCount:fnoStrategyScanStats.warmupCompletedCount,
        warmupRetryCount:fnoStrategyScanStats.warmupRetryCount,
        restCooldownActive:getRestDiagnostics().cooldownActive,
        rssBytes:memory.rss,
        heapUsedBytes:memory.heapUsed
      }));
    }
  },SCANNER_POLL_INTERVAL_MS);
  fnoStrategyScanTimer.unref?.();
}

function isFnoMasterCurrent() {
  return fnoUniverseLoadedDate === getNseSessionDate();
}
function getSessionMarketData() {
  const market = getMarketData();
  if (!isFnoMasterCurrent()) {
    market.fno = {
      ...market.fno,
      status:'SYMBOL_MASTER_NOT_LOADED',
      topGainers:[],
      coverageComplete:false,
      lastError:'Current IST session official FYERS NSE F&O master is pending or unavailable'
    };
  }
  return market;
}
function ensureFyersMarketStarted() {
  const market = startMarketSocket();
  const sessionDate = getNseSessionDate();
  if (fnoUniverseRetryDate !== sessionDate) {
    fnoUniverseRetryDate = sessionDate;
    fnoUniverseLoadRetryAt = 0;
  }
  // Refresh official NSE F&O and option-contract masters once per IST trading day.
  // Fail closed: remove the prior session's universe and selections while today's
  // official master is unavailable; retry master download with bounded backoff.
  if (fnoUniverseLoadedDate !== sessionDate && !fnoUniverseLoadPromise && Date.now() >= fnoUniverseLoadRetryAt) {
    const requestedDate = sessionDate;
    console.info('[FYERS_SCANNER] current-session official F&O master refresh pending; F&O ranking and selection gates remain closed');
    fnoUniverseLoadPromise = loadFnoEquityUniverse().then(({ date, universe, diagnostics }) => {
      if (date !== getNseSessionDate()) throw new Error('Official symbol master completed for a different IST session; current-session ranking remains blocked');
      const coverage = setFnoUniverse(universe);
      // A new official NSE session starts a new audit ledger; yesterday's scan
      // results must never appear as today's coverage.
      fnoSymbolScanLedger.clear();
      const selectedUnderlying = getMarketData().selectedUnderlying?.symbol;
      if (selectedUnderlying && !universe.some(item => item.symbol === selectedUnderlying)) {
        setSelectedUnderlyingSymbol(null);
      }
      const selectedOption = getMarketData().selectedOptionSymbol;
      if (selectedOption) {
        try { getVerifiedOptionContract(selectedOption); }
        catch { setSelectedOptionSymbol(null); }
      }
      fnoUniverseLoadedDate = date;
      fnoUniverseLoadRetryAt = 0;
      startFnoStrategyScanner();
      console.info('[FYERS_SCANNER] official NSE F&O master diagnostics:', JSON.stringify(diagnostics), 'active socket slots:', coverage.activeCount, 'independent strategy scan slots:', coverage.scanPerSlice || 1, 'master date:', requestedDate);
      return true;
    }).catch(error => {
      fnoUniverseLoadRetryAt = Date.now() + 30_000;
      console.error('[FYERS_SCANNER] official symbol-master load failed; retry in 30s:', String(error?.message || error).slice(0,180));
      return false;
    }).finally(() => {
      fnoUniverseLoadPromise = null;
    });
  }
  return market;
}
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const requestCookies = parseCookies(req.headers.cookie || '');
  const hasFyersSession = Boolean(requestCookies.fyers_session && restoreSessionCookie(requestCookies.fyers_session, {
    appId:process.env.FYERS_APP_ID, appSecret:process.env.FYERS_SECRET_KEY
  }));
  if (hasFyersSession) ensureFyersMarketStarted();
  // Public endpoints are limited to non-account market/status views and OAuth
  // entry/callback. All broker-backed data and workstation controls require the
  // caller's own cryptographically valid FYERS session cookie.
  if (requiresFyersSession(url.pathname) && !hasFyersSession) {
    return send(res,401,{status:'AUTHENTICATION_REQUIRED',reason:'A valid Upgrade AI Pro FYERS session is required for this endpoint'});
  }
  if (req.method === 'GET' && url.pathname === '/api/fno/search') {
    if (!isFnoMasterCurrent()) return send(res,503,{status:'SYMBOL_MASTER_NOT_LOADED',results:[],reason:'Current-session official FYERS NSE F&O master is not verified'});
    const query=String(url.searchParams.get('q')||'').trim().toUpperCase().slice(0,40);
    if (query.length < 2) return send(res,200,{status:'QUERY_TOO_SHORT',query,results:[]});
    const snapshot=getFnoUniverseSnapshot();
    const results=(snapshot.universe||[])
      .filter(item=>String(item.symbol||'').toUpperCase().includes(query)||String(item.name||'').toUpperCase().includes(query)||String(item.underlying||'').toUpperCase().includes(query))
      .slice(0,20)
      .map(item=>({symbol:item.symbol,name:item.name||item.underlying||item.symbol,underlying:item.underlying}));
    return send(res,200,{status:'OFFICIAL_FNO_MASTER_MATCHES',query,universeCount:snapshot.universe?.length||0,resultCount:results.length,results});
  }
  if (req.method === 'GET' && url.pathname === '/api/market-data') return send(res,200,getSessionMarketData());
  if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
    try {
      if (url.pathname === '/api/history') return send(res,200,await getFiveMinuteSessionHistory(url.searchParams.get('symbol'),Date.now(),REST_PRIORITY.CHART,'chart-history'));
      if (url.pathname === '/api/research-context') {
        const symbol = url.searchParams.get('symbol');
        if (!validateNseSymbol(symbol)) return send(res,400,{status:'INVALID_SYMBOL',reason:'A verified NSE F&O underlying is required'});
        const [daily,fifteenMinute] = await Promise.all([getDailyHistory(symbol,Date.now(),REST_PRIORITY.CONTEXT,'research-context-daily'),getFifteenMinuteHistory(symbol,Date.now(),REST_PRIORITY.CONTEXT,'research-context-15m')]);
        return send(res,200,{status:'RESEARCH_CONTEXT_WARM',symbol,daily:{count:daily.count,source:daily.source},fifteenMinute:{count:fifteenMinute.count,source:fifteenMinute.source}});
      }
      if (url.pathname === '/api/research/historical-universe') {
        if (!isFnoMasterCurrent()) return send(res,200,{status:'SYMBOL_MASTER_NOT_LOADED',mode:'HISTORICAL_ONLY',universeCount:0,evaluatedCount:0,blockedCount:0,candidateCount:0,candidates:[],reason:'Current-session official FYERS NSE F&O master is not verified'});
        const snapshot=getFnoUniverseSnapshot();
        const histories=getCachedResearchHistories();
        const candidates=[],evaluations=[];
        for (const item of snapshot.universe||[]) {
          const history=histories.fiveMinute.get(item.symbol);
          if (!history?.candles?.length) {
            evaluations.push({symbol:item.symbol,status:'BLOCKED',reason:'No cached verified FYERS 5-minute history for this underlying'});
            continue;
          }
          const last=history.candles.at(-1);
          const historicalAsOf=Number(last?.time)+300;
          const result=detectNineStrategySetup({
            underlyingCandles:history.candles,underlyingTick:null,
            dailyCandles:histories.daily.get(item.symbol)?.candles||[],
            fifteenMinuteCandles:histories.fifteenMinute.get(item.symbol)?.candles||[],
            isTopGainer:false,researchEnabled:false,now:Date.now(),historicalAsOf
          });
          const row={symbol:item.symbol,name:item.name||item.underlying||item.symbol,status:result.status,reason:result.reason||null,strategyLedger:result.strategyLedger||[],strategy:result.strategy||null,side:result.side||null,breakoutLevel:result.breakoutLevel||null,confirmedAt:result.confirmedAt||null,underlyingPrice:result.underlyingPrice||null,asOfCandleTime:last.time,source:'FYERS_VERIFIED_COMPLETED_5M_HISTORY'};
          evaluations.push(row);
          if(result.status==='UNDERLYING_SETUP_CONFIRMED') candidates.push({...row,status:'HISTORICAL_RESEARCH_CANDIDATE'});
        }
        candidates.sort((a,b)=>Number(b.confirmedAt||0)-Number(a.confirmedAt||0));
        return send(res,200,{status:candidates.length?'HISTORICAL_CANDIDATES_AVAILABLE':'NO_HISTORICAL_CANDIDATE',mode:'HISTORICAL_ONLY_NOT_LIVE',universeCount:snapshot.universe?.length||0,evaluatedCount:evaluations.filter(row=>row.status!=='BLOCKED').length,blockedCount:evaluations.filter(row=>row.status==='BLOCKED').length,candidateCount:candidates.length,candidates:candidates.slice(0,20),evaluations,note:'Historical FYERS completed candles only. No live tick, option quote, option candle, entry, stop or target is inferred. This list is research-only and cannot authorize a trade.'});
      }
      if (url.pathname === '/api/research/universe') {
        if (!isFnoMasterCurrent()) return send(res,200,{status:'SYMBOL_MASTER_NOT_LOADED',marketSession:isNseRegularSession(Date.now())?'OPEN':'CLOSED',scannerStatus:'WAITING_FOR_OFFICIAL_MASTER',universeCount:0,evaluatedCount:0,blockedCount:0,candidateCount:0,top3:[],scanner:fnoStrategyScanStats,scanPerSlice:1,note:'Current IST session official FYERS NSE F&O master is pending; no prior-session universe is ranked.'});
        const snapshot=getFnoUniverseSnapshot();
        const histories=getCachedResearchHistories();
        const market=getMarketData();
        const result=evaluateRollingFnoUniverse({
          universe:snapshot.universe,ticks:snapshot.ticks,
          fiveMinute:histories.fiveMinute,daily:histories.daily,fifteenMinute:histories.fifteenMinute,
          topGainers:market.fno?.topGainers||[],now:Date.now()
        });
        const now=Date.now();
        const symbolCoverage=(snapshot.universe||[]).map(item=>{
          const prior=fnoSymbolScanLedger.get(item.symbol)||null;
          const tick=snapshot.ticks.get(item.symbol)||null;
          const tickAgeMs=tick?now-Number(tick.receivedAt):null;
          const tickFresh=Boolean(tick&&tickAgeMs>=0&&tickAgeMs<=10000&&now/1000-Number(tick.exchangeTime)>=-3&&now/1000-Number(tick.exchangeTime)<=10);
          return {symbol:item.symbol,name:item.name||item.underlying||item.symbol,
            scanStatus:prior?.status||'NOT_SCANNED',lastScanAt:prior?.scannedAt||null,
            scanAttempts:prior?.attemptCount||0,scanReason:prior?.reason||'Awaiting its rotation slot',
            tickStatus:!tick?'NO_TICK':tickFresh?'FRESH':'STALE',
            tickExchangeTime:tick?.exchangeTime||null,tickAgeSeconds:tickAgeMs===null?null:Math.max(0,Math.floor(tickAgeMs/1000)),
            candleCount:prior?.candleCount||0,lastCompletedCandleTime:prior?.lastCompletedCandleTime||null,
            strategyLedger:prior?.strategyLedger||[]};
        });
        const coverageSummary={
          universeCount:symbolCoverage.length,
          scannedCount:symbolCoverage.filter(x=>x.scanAttempts>0).length,
          notScannedCount:symbolCoverage.filter(x=>x.scanAttempts===0).length,
          freshTickCount:symbolCoverage.filter(x=>x.tickStatus==='FRESH').length,
          staleTickCount:symbolCoverage.filter(x=>x.tickStatus==='STALE').length,
          noTickCount:symbolCoverage.filter(x=>x.tickStatus==='NO_TICK').length,
          lastUpdatedAt:new Date(now).toISOString(),
          simultaneous:false
        };
        return send(res,200,{...result,marketSession:isNseRegularSession(now)?'OPEN':'CLOSED',scannerStatus:isNseRegularSession(now)?fnoStrategyScanStats.status:'OUTSIDE_NSE_SESSION',scannerPauseReason:isNseRegularSession(now)?null:'NSE market session is closed; live F&O scanning and research warmups are paused',activeSymbols:snapshot.activeSymbols,rotationIndex:snapshot.rotationIndex,
          rotationIntervalMs:snapshot.rotationIntervalMs,scanPerSlice:snapshot.scanPerSlice,symbolCap:snapshot.symbolCap,
          scanner:fnoStrategyScanStats,coverageSummary,symbolCoverage,
          note:'Per-symbol scan/tick coverage is observational only. Rotating ticks are not simultaneous. Missing/stale inputs are BLOCKED; this endpoint does not fetch synthetic data or place orders.'});
      }
      if (url.pathname === '/api/research') {
        if (!isFnoMasterCurrent()) return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',researchRanking:[],reason:'Current IST session official FYERS NSE F&O master is not verified'});
        const symbol = url.searchParams.get('symbol');
        if (!validateNseSymbol(symbol)) return send(res,400,{status:'INVALID_SYMBOL',reason:'A verified NSE F&O underlying is required'});
        const market = getMarketData();
        const underlying = market.selectedUnderlying;
        if (!underlying?.fresh || underlying.symbol !== symbol) {
          return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',researchRanking:[],reason:'Fresh selected-underlying FYERS tick is required for independent research'});
        }
        const [fiveMinute,daily,fifteenMinute] = await Promise.all([
          getFiveMinuteHistory(symbol,Date.now(),REST_PRIORITY.RESEARCH,'manual-research-5m'), getDailyHistory(symbol,Date.now(),REST_PRIORITY.RESEARCH,'manual-research-daily'), getFifteenMinuteHistory(symbol,Date.now(),REST_PRIORITY.RESEARCH,'manual-research-15m')
        ]);
        const latestMarket = getMarketData();
        const latestUnderlying = latestMarket.selectedUnderlying;
        if (!latestUnderlying?.fresh || latestUnderlying.symbol !== symbol) {
          return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',researchRanking:[],reason:'Underlying tick became stale while verified research history was loading'});
        }
        const isTopGainer = (latestMarket.fno?.topGainers || []).some(item => item.symbol === symbol);
        const research = detectNineStrategySetup({
          underlyingCandles:fiveMinute.candles, underlyingTick:latestUnderlying,
          dailyCandles:daily.candles, fifteenMinuteCandles:fifteenMinute.candles,
          isTopGainer, researchEnabled:true, now:Date.now()
        });
        return send(res,200,{
          status:research.status,
          researchRanking:research.researchRanking || [],
          reason:research.reason || (research.status === 'NO_TRADE' ? 'No strategy passed the verified setup filters' : ''),
          research:research.research || null,
          strategyLedger:research.strategyLedger || [],
          underlying:symbol,
          source:'FYERS_VERIFIED_DAILY_15M_5M_OHLCV',
          asOfExchangeTime:latestUnderlying.exchangeTime
        });
      }
      if (url.pathname === '/api/quotes') {
        const symbols = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
        return send(res,200,await getFyersQuotes(symbols,'quotes-endpoint'));
      }
      if (url.pathname === '/api/option-chain') {
        if (!isFnoMasterCurrent()) return send(res,503,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Current IST session official FYERS NSE F&O master is not verified'});
        return send(res,200,await getFyersOptionChain(url.searchParams.get('symbol'),url.searchParams.get('strikecount') || 10,url.searchParams.get('timestamp') || '','option-chain-panel'));
      }
      if (url.pathname === '/api/positions') return send(res,200,await getFyersPositions());
      if (url.pathname === '/api/orderbook') return send(res,200,await getFyersOrderbook());
    } catch (error) {
      const rateLimited = /429|cooldown/i.test(String(error.message));
      return send(res,rateLimited ? 429 : 503,{status:rateLimited ? 'RATE_LIMITED' : 'DATA_UNAVAILABLE',reason:String(error.message || 'FYERS read-only request failed').slice(0,180)});
    }
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    const market = getSessionMarketData();
    return send(res,200,buildHealthStatus({
      market, masterCurrent:isFnoMasterCurrent(), sessionDate:getNseSessionDate(),
      loadedDate:fnoUniverseLoadedDate, ordersEnabled:tradingEnabled(), authStatus:getAuthStatus(),
      scanner:fnoStrategyScanStats, scanPerSlice:getFnoUniverseSnapshot().scanPerSlice,
      rotationIntervalMs:getFnoUniverseSnapshot().rotationIntervalMs,
      rest:getRestDiagnostics(), runtimeMemory:process.memoryUsage()
    }));
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    if (!hasFyersSession) {
      // Do not expose a logged-in user's selected symbols, live ticks, scanner
      // diagnostics, or broker-session state to anonymous visitors.
      return send(res,200,{
        app:'Upgrade AI Pro', exchange:'NSE', provider:'FYERS',
        feed:{status:'MISSING',fresh:false,actionable:false,reason:'A valid FYERS session is required'},
        auth:{status:'NOT_AUTHENTICATED',tokenStored:false},
        marketData:{
          socketStatus:'NOT_AUTHENTICATED',indices:{},selectedUnderlying:null,
          selectedOption:null,selectedOptionSymbol:null,
          optionSubscription:{status:'SESSION_REQUIRED'},
          fno:{status:'SESSION_REQUIRED',topGainers:[]}
        },
        orderPlacementEnabled:false, marketSession:'NSE 09:15-15:30 Asia/Kolkata'
      });
    }
    const market = getSessionMarketData();
    return send(res,200,{
    app:'Upgrade AI Pro', exchange:'NSE', provider:'FYERS', feed:assessFeed(market.selectedUnderlying), auth:getAuthStatus(), marketData:market, rest:getRestDiagnostics(),
    fnoMaster:{status:isFnoMasterCurrent()?'CURRENT':'REFRESH_PENDING',sessionDate:getNseSessionDate(),loadedDate:fnoUniverseLoadedDate},
    configuration:{
      appIdConfigured:Boolean(process.env.FYERS_APP_ID?.trim()),
      appIdHasNewFormat: Boolean(process.env.FYERS_APP_ID?.trim().endsWith('-200')),
      redirectUriConfigured:Boolean(process.env.FYERS_REDIRECT_URI?.trim()),
      redirectUriMatchesExpected:process.env.FYERS_REDIRECT_URI?.trim() === EXPECTED_REDIRECT_URI,
      secretConfigured:Boolean(process.env.FYERS_SECRET_KEY?.trim())
    },
    fnoCoverage:market.fno, scanner:{mode:'ROLLING_FNO_NINE_STRATEGY_EVALUATION',...fnoStrategyScanStats,scanPerSlice:getFnoUniverseSnapshot().scanPerSlice,rotationIntervalMs:60000,simultaneous:false}, strategyEngine:'NINE_STRATEGY_WITH_VERIFIED_MULTI_TIMEFRAME_RESEARCH · ROLLING F&O UNIVERSE EVALUATION · CACHED FYERS DATA ONLY', orderPlacementEnabled:tradingEnabled(), marketSession:'NSE 09:15-15:30 Asia/Kolkata'
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/fyers/login') {
    console.info('[FYERS_OAUTH] login route reached');
    try {
      const auth = getAuthStatus();
      if (auth.tokenStored && hasFyersSession) {
        ensureFyersMarketStarted();
        const session = createSessionCookie({appId:process.env.FYERS_APP_ID,appSecret:process.env.FYERS_SECRET_KEY});
        const sessionCookie = `fyers_session=${session.value}; Max-Age=${session.maxAge}; Path=/api; HttpOnly; Secure; SameSite=Lax`;
        console.info('[FYERS_OAUTH] existing authenticated session reused; token exchange skipped');
        res.writeHead(302,{location:'/?fyers=session-restored','set-cookie':sessionCookie,'cache-control':'no-store','referrer-policy':'no-referrer'}); return res.end();
      }
      const login = createLoginUrl({ appId:process.env.FYERS_APP_ID, redirectUri:process.env.FYERS_REDIRECT_URI });
      console.info('[FYERS_OAUTH] redirect generated; app id configured:', Boolean(process.env.FYERS_APP_ID?.trim()), 'redirect matches expected:', process.env.FYERS_REDIRECT_URI?.trim() === EXPECTED_REDIRECT_URI);
      res.writeHead(302,{location:login.url,'set-cookie':`fyers_oauth_state=${login.state}; Max-Age=600; Path=/api/fyers; HttpOnly; Secure; SameSite=Lax`,'cache-control':'no-store','referrer-policy':'no-referrer'}); return res.end();
    } catch (error) {
      console.error('[FYERS_OAUTH] login setup failed:', error.message);
      return send(res,503,{status:'NOT_CONFIGURED',reason:error.message});
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/fyers/auth/callback') {
    console.info('[FYERS_OAUTH] callback route reached');
    const state = url.searchParams.get('state');
    const authCode = url.searchParams.get('auth_code');
    const cookies = parseCookies(req.headers.cookie || '');
    const clearStateCookie = 'fyers_oauth_state=; Max-Age=0; Path=/api/fyers; HttpOnly; Secure; SameSite=Lax';
    if (!verifyLoginState(state,cookies.fyers_oauth_state) || consumedOAuthStates.has(state)) {
      console.warn('[FYERS_OAUTH] callback rejected: state missing, mismatched or already consumed');
      res.setHeader('set-cookie',clearStateCookie);
      return send(res,400,{status:'REJECTED',reason:'OAuth state is missing, mismatched or already used. Start Connect once again.'});
    }
    consumedOAuthStates.add(state);
    if (consumedOAuthStates.size > 2000) consumedOAuthStates.delete(consumedOAuthStates.values().next().value);
    res.setHeader('set-cookie',clearStateCookie);
    if (!authCode) {
      console.warn('[FYERS_OAUTH] callback missing auth_code');
      return send(res,400,{status:'FAILED',reason:'FYERS authorization code was not returned'});
    }
    try {
      await exchangeAuthCode({appId:process.env.FYERS_APP_ID,appSecret:process.env.FYERS_SECRET_KEY,authCode});
      console.info('[FYERS_OAUTH] token exchange succeeded; token value withheld');
      const session = createSessionCookie({appId:process.env.FYERS_APP_ID,appSecret:process.env.FYERS_SECRET_KEY});
      const sessionCookie = `fyers_session=${session.value}; Max-Age=${session.maxAge}; Path=/api; HttpOnly; Secure; SameSite=Lax`;
      const market = ensureFyersMarketStarted();
      console.info('[FYERS_DATA] socket start requested; status:', market.status, 'encrypted session cookie issued');
      res.writeHead(302,{location:'/?fyers=connected','set-cookie':[clearStateCookie,sessionCookie],'cache-control':'no-store','referrer-policy':'no-referrer'}); return res.end();
    } catch (error) {
      const d = error.fyersDiagnostics || {};
      console.error('[FYERS_OAUTH] token exchange failed:', error.message,
        JSON.stringify({httpStatus:d.status || null, elapsedMs:d.elapsedMs || null, retryAfter:d.retryAfter || null, cfRay:d.cfRay || null, server:d.server || null, contentType:d.contentType || null}));
      const upstream429 = /FYERS_UPSTREAM_HTTP_429/.test(String(error.message));
      return send(res,upstream429 ? 429 : 502,{status:upstream429 ? 'FYERS_UPSTREAM_RATE_LIMIT' : 'TOKEN_EXCHANGE_FAILED',reason:error.message});
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/select-underlying') {
    try {
      if (!isFnoMasterCurrent()) return send(res,503,{status:'UNDERLYING_NOT_VERIFIED',reason:'Current IST session official FYERS NSE F&O master is not verified'});
      const body = await readJson(req);
      const result = setSelectedUnderlyingSymbol(body.symbol || null);
      if (body.symbol && result.status !== 'UNDERLYING_PINNED_TO_SOCKET_SLICE' && result.status !== 'UNCHANGED') return send(res,400,{status:'UNDERLYING_NOT_VERIFIED',reason:'Underlying is not in the official active NSE F&O universe'});
      return send(res,200,result);
    } catch (error) {
      return send(res,400,{status:'UNDERLYING_NOT_VERIFIED',reason:String(error.message || 'Underlying selection failed').slice(0,180)});
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/evaluate-setup') {
    try {
      if (!isFnoMasterCurrent()) return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Current IST session official FYERS NSE F&O master is not verified'});
      const body = await readJson(req);
      const market = getMarketData();
      const underlying = market.selectedUnderlying;
      const option = market.selectedOption;
      if (!underlying?.fresh || underlying.symbol !== body.underlying) return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Selected underlying tick is not fresh'});
      if (!option?.fresh || option.symbol !== body.contract) return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Selected option tick is not fresh'});
      const contract = getVerifiedOptionContract(body.contract);
      const expectedUnderlying = String(body.underlying).replace(/^NSE:/,'').replace(/-EQ$/,'').toUpperCase();
      if (contract.symbol !== body.contract || contract.underlying !== expectedUnderlying || !['CE','PE'].includes(contract.side)) {
        return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Selected option contract identity, underlying or CE/PE side does not match the requested setup'});
      }
      const flightKey = body.underlying + '|' + body.contract;
      const setup = await setupEvaluationFlight.run(flightKey, async () => {
        const startedAt = Date.now();
        console.info('[SETUP_EVAL] started:',JSON.stringify({underlying:body.underlying,contract:body.contract,contractSide:contract.side,strike:contract.strike,expiry:contract.expiry}));
        const [underlyingHistory,optionHistory,dailyHistory,fifteenMinuteHistory] = await Promise.all([
          getFiveMinuteHistory(body.underlying,Date.now(),REST_PRIORITY.ENTRY,'setup-underlying-5m'),
          getFiveMinuteHistory(body.contract,Date.now(),REST_PRIORITY.ENTRY,'setup-option-5m'),
          getDailyHistory(body.underlying,Date.now(),REST_PRIORITY.ENTRY,'setup-underlying-daily'),
          getFifteenMinuteHistory(body.underlying,Date.now(),REST_PRIORITY.ENTRY,'setup-underlying-15m')
        ]);
        console.info('[SETUP_EVAL] histories_verified:',JSON.stringify({
          underlying:body.underlying,contract:body.contract,
          underlying5mCount:underlyingHistory.candles.length,
          option5mCount:optionHistory.candles.length,
          optionLastCompletedCandleTime:optionHistory.candles.at(-1)?.time||null,
          dailyCount:dailyHistory.candles.length,fifteenMinuteCount:fifteenMinuteHistory.candles.length,
          sources:[underlyingHistory.source,optionHistory.source,dailyHistory.source,fifteenMinuteHistory.source]
        }));
        // Re-read after REST work: never let history latency silently weaken the
        // strict 10-second underlying/option WebSocket freshness gates.
        const latestMarket=getMarketData();
        const latestUnderlying=latestMarket.selectedUnderlying,latestOption=latestMarket.selectedOption;
        if(!latestUnderlying?.fresh||latestUnderlying.symbol!==body.underlying)
          return {status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Underlying tick became stale while verified research history was loading'};
        if(!latestOption?.fresh||latestOption.symbol!==body.contract)
          return {status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Option tick became stale while verified research history was loading'};
        const isTopGainer = (latestMarket.fno?.topGainers || []).some(item=>item.symbol===body.underlying);
        const result = evaluateNineStrategies({
          underlyingCandles:underlyingHistory.candles,underlyingTick:latestUnderlying,
          optionCandles:optionHistory.candles,optionTick:latestOption,contract,
          dailyCandles:dailyHistory.candles,fifteenMinuteCandles:fifteenMinuteHistory.candles,
          isTopGainer,researchEnabled:true,now:Date.now()
        });
        console.info('[SETUP_EVAL] completed:',JSON.stringify({
          underlying:body.underlying,contract:body.contract,status:result.status,
          strategy:result.strategy||null,reason:result.reason||null,
          optionCandleCount:optionHistory.candles.length,
          entry:Number.isFinite(Number(result.entry))?result.entry:null,
          stopLoss:Number.isFinite(Number(result.stopLoss))?result.stopLoss:null,
          target:Number.isFinite(Number(result.target))?result.target:null,
          rr:Number.isFinite(Number(result.rr))?result.rr:null,
          durationMs:Date.now()-startedAt
        }));
        return {...result,underlying:body.underlying,contract:body.contract,source:'FYERS_VERIFIED_DATA'};
      });
      return send(res,200,setup);
    } catch (error) {
      const rateLimited=/429|cooldown/i.test(String(error.message));
      const rest=getRestDiagnostics();
      console.warn('[SETUP_EVAL] blocked:',JSON.stringify({reason:String(error.message||'Setup verification unavailable').slice(0,180),restStatus:rest.status,cooldownActive:rest.cooldownActive,cooldownUntil:rest.cooldownUntil||null}));
      return send(res,rateLimited?429:200,{
        status:'DATA_UNAVAILABLE_NO_TRADE',
        reason:String(error.message||'Setup verification unavailable').slice(0,180),
        restStatus:rest.status,
        retryAt:rateLimited&&rest.cooldownUntil?rest.cooldownUntil:null
      });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/auto-select-option') {
    try {
      if (!isFnoMasterCurrent()) return send(res,503,{status:'AUTO_OPTION_UNAVAILABLE',reason:'Current IST session official FYERS NSE F&O master is not verified'});
      const body = await readJson(req);
      if (!validateNseSymbol(body.underlying) || !['LONG','SHORT'].includes(body.side)) {
        return send(res,400,{status:'AUTO_OPTION_UNAVAILABLE',reason:'Verified NSE underlying and confirmed LONG/SHORT direction are required'});
      }
      const requestedExpirySeconds = normalizeExpiryTimestamp(body.timestamp);
      if (requestedExpirySeconds === null) {
        return send(res,400,{status:'AUTO_OPTION_EXPIRY_REQUIRED',reason:'Select a valid FYERS option expiry before automatic CE/PE selection'});
      }
      const beforeChain = getMarketData();
      if (!beforeChain.selectedUnderlying?.fresh || beforeChain.selectedUnderlying.symbol !== body.underlying) {
        return send(res,200,{status:'AUTO_OPTION_UNAVAILABLE',reason:'Fresh selected-underlying FYERS tick is required before strike selection'});
      }
      const chainPayload = await getFyersOptionChain(body.underlying,10,body.timestamp || '','auto-option-selection');
      const chainData = chainPayload.data || chainPayload;
      const latestUnderlying = getMarketData().selectedUnderlying;
      if (!latestUnderlying?.fresh || latestUnderlying.symbol !== body.underlying) {
        return send(res,200,{status:'AUTO_OPTION_UNAVAILABLE',reason:'Underlying tick became stale while the FYERS option chain was loading'});
      }
      const selection = chooseDirectionalOption({
        optionsChain:chainData.optionsChain,
        underlyingPrice:Number(latestUnderlying.price),
        side:body.side
      });
      if (selection.status !== 'CANDIDATE_SELECTED') return send(res,200,{status:'AUTO_OPTION_UNAVAILABLE',reason:selection.reason});
      const contract = getVerifiedOptionContract(selection.symbol);
      const expectedUnderlying=body.underlying.replace(/^NSE:/,'').replace(/-EQ$/,'').toUpperCase();
      if (contract.side !== selection.side || contract.strike !== selection.strike ||
          contract.underlying !== expectedUnderlying ||
          !matchesRequestedExpiry(contract.expiry,requestedExpirySeconds)) {
        return send(res,409,{status:'AUTO_OPTION_MASTER_MISMATCH',reason:'FYERS chain candidate underlying, side, strike or expiry does not match the official active contract master'});
      }
      const subscription = setSelectedOptionSymbol(contract.symbol);
      if (subscription?.status === 'SUBSCRIPTION_FAILED') {
        return send(res,503,{status:'AUTO_OPTION_SUBSCRIPTION_FAILED',reason:subscription.reason || 'FYERS option subscription failed'});
      }
      return send(res,200,{status:'AUTO_CONTRACT_VERIFIED_SUBSCRIPTION_REQUESTED',selection,contract,subscription});
    } catch(error) {
      const rateLimited=/429|cooldown/i.test(String(error.message));
      return send(res,rateLimited?429:503,{status:'AUTO_OPTION_UNAVAILABLE',reason:String(error.message||'Automatic option selection failed').slice(0,180)});
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/select-option') {
    try {
      if (!isFnoMasterCurrent()) return send(res,503,{status:'CONTRACT_NOT_VERIFIED',reason:'Current IST session official FYERS NSE F&O master is not verified'});
      const body = await readJson(req);
      if (body.symbol === null) {
        setSelectedOptionSymbol(null);
        return send(res,200,{status:'OPTION_SUBSCRIPTION_CLEARED'});
      }
      const contract = getVerifiedOptionContract(body.symbol);
      const market = getMarketData();
      const identity = verifyOptionContractUnderlying(contract, market.selectedUnderlyingSymbol);
      if (identity.status !== 'CONTRACT_IDENTITY_VERIFIED') {
        return send(res,409,{status:'CONTRACT_NOT_VERIFIED',verification:identity.status,reason:identity.reason});
      }
      const subscription = setSelectedOptionSymbol(contract.symbol);
      if (subscription?.status === 'SUBSCRIPTION_FAILED') {
        return send(res,503,{status:'OPTION_SUBSCRIPTION_FAILED',reason:subscription.reason || 'FYERS option subscription failed',subscription});
      }
      return send(res,200,{status:'CONTRACT_VERIFIED_SUBSCRIPTION_REQUESTED',contract,subscription,tradeEligible:false,liveTickRequired:true,note:'Official contract identity verified independently; fresh underlying and option exchange ticks remain mandatory before setup evaluation.'});
    } catch (error) {
      return send(res,400,{status:'CONTRACT_NOT_VERIFIED',reason:String(error.message || 'Option contract verification failed').slice(0,180)});
    }
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/orders')) return send(res,423,{status:'BLOCKED',reason:'Order placement is disabled during build and initial verification'});
  if (req.method !== 'GET') return send(res,405,{error:'Method not allowed'});
  const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const safe = normalize(requested).replace(/^([.][.][/\\\\])+/, '');
  try {
    const path = join(root,safe);
    if (!path.startsWith(root)) return send(res,403,{error:'Forbidden'});
    const data = await readFile(path);
    return send(res,200,data,mime[extname(path)] || 'application/octet-stream');
  } catch { return send(res,404,{error:'Not found'}); }
});
server.listen(port,'0.0.0.0',()=>console.log(`Upgrade AI Pro listening on ${port}`));
