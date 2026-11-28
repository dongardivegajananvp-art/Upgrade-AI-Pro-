import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessFeed, tradingEnabled } from './src/safety.js';
import { createLoginUrl, consumeLoginState, exchangeAuthCode, getAuthStatus, createSessionCookie, restoreSessionCookie, createRefreshSessionCookie, restoreRefreshSessionCookie, refreshAccessToken, shouldReuseAuthenticatedSession, createRestSafetyCookie, restoreRestSafetyCookie } from './src/fyers-auth.js';
import { startMarketSocket, getMarketData, getMarketTick, getFnoUniverseSnapshot, setFnoUniverse, setSelectedOptionSymbol, setSelectedUnderlyingSymbol, setActiveTradeOptionSymbols, pinSetupEvaluationSymbols, releaseSetupEvaluationSymbols } from './src/fyers-market-socket.js';
import { loadFnoEquityUniverse, getVerifiedOptionContract, getNseSessionDate } from './src/fyers-symbol-master.js';
import { chooseDirectionalOption, normalizeExpiryTimestamp, matchesRequestedExpiry, verifyOptionContractUnderlying } from './src/option-selection.js';
import { evaluateNineStrategies, detectNineStrategySetup, needsDailyTrendPullbackHistory } from './src/strategy-engine.js';
import { REST_PRIORITY } from './src/rest-scheduler-utils.js';
import { getFiveMinuteHistory, getFiveMinuteSessionHistory, getFifteenMinuteHistory, getDailyHistory, getFyersQuotes, getFyersOptionChain, getFyersPositions, getFyersOrderbook, getRestDiagnostics, getRestDispatchReadiness, getRestSafetyState, restoreRestSafetyState, getCachedResearchHistories, validateNseSymbol } from './src/fyers-rest.js';
import { evaluateRollingFnoUniverse } from './src/rolling-fno-strategy-engine.js';
import { createResearchWarmupQueue } from './src/research-warmup-queue.js';

import { SCANNER_POLL_INTERVAL_MS, FNO_SCAN_MIN_INTERVAL_MS } from './src/scanner-scheduler.js';
import { buildHealthStatus } from './src/health-status.js';

import { buildFnoScanCandidates, getNextFreshFnoScanSymbol, getFnoScanSliceKey, shouldResetFnoScanCursor, isRetryableFnoScanError } from './src/rolling-fno-scanner.js';
import { isFreshFnoTick } from './src/fno-scan-gate.js';
import { validateFixedRiskPlan, updateActiveSetupFromTick } from './src/active-setup-lifecycle.js';
import { planActiveSetupRestore } from './src/active-setup-restore.js';
import { requiresFyersSession } from './src/api-access.js';
import { isNseRegularSession, isNseSignalWindow } from './src/nse-session.js';
import { createSingleFlight } from './src/setup-evaluation-flight.js';
import { waitForCurrentFnoMaster } from './src/fno-master-readiness.js';
import { INDEX_STRATEGY_SYMBOLS, INDEX_STRATEGY_LABELS, countFreshIndexTicks, isFreshIndexTick, isVerifiedIndexHistory, buildIndexStrategyScanRecord } from './src/index-strategy-scan-utils.js';
import { getOpportunityCycleState } from './src/opportunity-cycle.js';

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
  try {
    const sessionCookie = res.__fyersSessionCookieFactory?.();
    if(sessionCookie) {
      const existing=res.getHeader('set-cookie');
      const cookies=Array.isArray(existing)?existing:existing?[existing]:[];
      res.setHeader('set-cookie',[...cookies,sessionCookie]);
    }
    const safetyCookie = res.__fyersRestSafetyCookieFactory?.();
    if (safetyCookie) {
      const existing = res.getHeader('set-cookie');
      const cookies = Array.isArray(existing) ? existing : existing ? [existing] : [];
      res.setHeader('set-cookie',[...cookies,safetyCookie]);
    }
  } catch (error) {
    console.warn('[FYERS_REST] could not attach encrypted cooldown recovery cookie:',String(error?.message||error).slice(0,120));
  }
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
const activeSetupLedger = new Map();
const MAX_ACTIVE_SETUP_LEDGER = 2;
const recentlyClosedSetupByUnderlying = new Map();
let fnoUniverseLoadPromise = null;
let fnoUniverseLoadedDate = null;
let fnoUniverseRetryDate = null;
let fnoUniverseLoadRetryAt = 0;
let fnoStrategyScanTimer = null;
let activeSetupMonitorTimer = null;
let fyersRefreshRetryAt = 0;
let fyersRefreshMonitorTimer = null;
let lastPinnedActiveSetupContractsKey = null;
let fnoStrategyScanBusy = false;
let fnoStrategyScanCursor = 0;
let fnoStrategyScanRotation = null;
let fnoStrategyScanActiveKey = null;
let fnoStrategyScanNextAllowedAt = 0;
let fnoStrategyScanLoggedRotation = null;
let fnoStrategyScanRetryAt = 0;
let fnoStrategyScanRetrySymbol = null;
const fnoResearchWarmupQueue = createResearchWarmupQueue({ maxSize: 500 });
// Per-underlying audit ledger: records actual scan attempts and explicit skips/failures.
// It is diagnostic only and never upgrades stale/missing data to an actionable setup.
const fnoSymbolScanLedger = new Map();
const indexStrategyScanStats = Object.fromEntries(INDEX_STRATEGY_SYMBOLS.map(symbol => [symbol, {
  symbol, label:INDEX_STRATEGY_LABELS[symbol], status:'NOT_STARTED',
  tradeStatus:'NO_TRADE', tickFresh:false, candleCount:0, strategyCheckCount:0,
  attemptCount:0, lastScanAt:null, lastCompletedCandleTime:null,
  reason:'Waiting for three fresh FYERS index ticks'
}]));
let indexStrategyScannerStatus='NOT_STARTED';
let indexStrategyScanTimer=null;
let indexStrategyScanBusy=false;
let indexStrategyScanCursor=0;
let indexStrategyScanRetryAt=0;

const fnoStrategyScanStats = { status:'NOT_STARTED', scannedCount:0, sliceScannedCount:0, candleReceivedCount:0, strategyCheckCount:0, sliceStrategyCheckCount:0, lastSymbol:null, lastStatus:null, lastReason:null, lastScanAt:null, warmupSymbol:null, warmupStatus:'IDLE', warmupQueueDepth:0, warmupCompletedCount:0, warmupRejectedCount:0, warmupRetryCount:0, warmupLastCompletedSymbol:null, warmupLastFailure:null, warmupLastRetryAt:null };

function startIndexStrategyScanner() {
  if (indexStrategyScanTimer) return;
  indexStrategyScannerStatus='RUNNING';
  indexStrategyScanTimer=setInterval(async () => {
    if (indexStrategyScanBusy || Date.now()<indexStrategyScanRetryAt) return;
    const now=Date.now();
    if (!isNseSignalWindow(now)) {
      indexStrategyScannerStatus='OUTSIDE_NSE_SESSION';
      return;
    }
    const market=getMarketData(now);
    const freshCount=countFreshIndexTicks(market.indices||{},now);
    if (freshCount!==3) {
      indexStrategyScannerStatus='WAITING_FOR_3_OF_3_FRESH_INDEX_TICKS';
      return;
    }
    const rest=getRestDiagnostics();
    if (rest.cooldownActive || rest.recoveryProbeRequired) {
      indexStrategyScannerStatus=rest.cooldownActive?'FYERS_REST_COOLDOWN_WAIT':'FYERS_REST_RECOVERY_PROBE_WAIT';
      return;
    }
    const symbol=INDEX_STRATEGY_SYMBOLS[indexStrategyScanCursor%INDEX_STRATEGY_SYMBOLS.length];
    indexStrategyScanCursor=(indexStrategyScanCursor+1)%INDEX_STRATEGY_SYMBOLS.length;
    const tick=market.indices[symbol];
    if (!isFreshIndexTick(tick,now)) return;
    const dispatch=getRestDispatchReadiness(REST_PRIORITY.SCANNER,'/history');
    if (!dispatch.ready) {
      indexStrategyScannerStatus='WAITING_FOR_SHARED_REST_BUDGET';
      return;
    }
    indexStrategyScanBusy=true;
    indexStrategyScannerStatus='RUNNING';
    try {
      const history=await getFiveMinuteHistory(symbol,Date.now(),REST_PRIORITY.SCANNER,'index-nine-strategy-5m');
      const scanAt=Date.now();
      const latestMarket=getMarketData(scanAt);
      const latestTick=latestMarket.indices?.[symbol]||null;
      if (countFreshIndexTicks(latestMarket.indices||{},scanAt)!==3 || !isFreshIndexTick(latestTick,scanAt)) {
        indexStrategyScannerStatus='WAITING_FOR_3_OF_3_FRESH_INDEX_TICKS';
        return;
      }
      if (!isVerifiedIndexHistory(history,scanAt)) {
        indexStrategyScanStats[symbol]={
          ...indexStrategyScanStats[symbol],status:'DATA_UNAVAILABLE_NO_TRADE',
          tradeStatus:'NO_TRADE',tickFresh:true,lastCheckedAt:new Date(scanAt).toISOString(),
          reason:'Recent completed FYERS 5-minute index history is unavailable; no candle was synthesized'
        };
        indexStrategyScannerStatus='WAITING_FOR_VERIFIED_INDEX_CANDLES';
        return;
      }
      const lastCandleTime=Number(history.lastCompletedCandleTime);
      const previous=indexStrategyScanStats[symbol];
      if (lastCandleTime<=Number(previous.lastCompletedCandleTime||0)) {
        indexStrategyScannerStatus='RUNNING';
        return;
      }
      // This scanner runs with researchEnabled:false and Strategy 3 now uses
      // daily EMA context. A 15-minute history request here is unused, so do
      // not spend a scarce FYERS REST slot on it.
      const fifteenMinuteHistory={candles:[]};
      // Strategy 3 uses daily trend, not 15m trend. Request daily context only
      // after the verified 5m pullback/resume prefilter passes.
      let dailyHistory={candles:[]};
      let dailyHistoryError=null;
      if(needsDailyTrendPullbackHistory(history.candles,latestTick.exchangeTime)) {
        try {
          dailyHistory=await getDailyHistory(symbol,Date.now(),REST_PRIORITY.CONTEXT,'index-nine-strategy-daily');
        } catch(error) {
          dailyHistoryError=String(error?.message||'Daily index context unavailable').slice(0,160);
        }
      }
      const evaluationAt=Date.now();
      const evaluationMarket=getMarketData(evaluationAt);
      const evaluationTick=evaluationMarket.indices?.[symbol]||null;
      if (countFreshIndexTicks(evaluationMarket.indices||{},evaluationAt)!==3 || !isFreshIndexTick(evaluationTick,evaluationAt)) {
        indexStrategyScannerStatus='WAITING_FOR_3_OF_3_FRESH_INDEX_TICKS';
        return;
      }
      const result=detectNineStrategySetup({
        underlyingCandles:history.candles,
        underlyingTick:evaluationTick,
        dailyCandles:dailyHistory.candles||[],
        fifteenMinuteCandles:fifteenMinuteHistory.candles||[],
        isTopGainer:false,
        researchEnabled:false,
        now:evaluationAt
      });
      const record=buildIndexStrategyScanRecord({
        symbol,tick:evaluationTick,history,result,now:evaluationAt,
        attemptCount:Number(previous.attemptCount||0)+1
      });
      record.fifteenMinuteCandleCount=0;
      record.fifteenMinuteHistoryStatus='NOT_REQUIRED_STRATEGY3_USES_DAILY';
      record.fifteenMinuteHistoryReason=null;
      record.dailyCandleCount=Array.isArray(dailyHistory.candles)?dailyHistory.candles.length:0;
      record.dailyHistoryStatus=record.dailyCandleCount>=50?'FYERS_DAILY_CONTEXT_AVAILABLE':needsDailyTrendPullbackHistory(history.candles,evaluationTick.exchangeTime)?'BLOCKED':'NOT_REQUIRED_5M_PREFILTER';
      record.dailyHistoryReason=dailyHistoryError;
      indexStrategyScanStats[symbol]=record;
      indexStrategyScannerStatus='RUNNING';
      console.info('[FYERS_INDEX_SCANNER] completed:',JSON.stringify({
        symbol,label:record.label,status:record.status,tradeStatus:record.tradeStatus,
        strategy:record.strategy,side:record.side,tickFresh:record.tickFresh,
        tickExchangeTime:record.tickExchangeTime,lastCompletedCandleTime:record.lastCompletedCandleTime,
        candleCount:record.candleCount,strategyCheckCount:record.strategyCheckCount,
        source:record.historySource,orders:'DISABLED'
      }));
    } catch(error) {
      const message=String(error?.message||'Index strategy scan failed').slice(0,180);
      indexStrategyScanStats[symbol]={
        ...indexStrategyScanStats[symbol],status:'DATA_UNAVAILABLE_NO_TRADE',
        tradeStatus:'NO_TRADE',tickFresh:isFreshIndexTick(tick,Date.now()),
        lastCheckedAt:new Date().toISOString(),reason:message
      };
      const restState=getRestDiagnostics();
      indexStrategyScanRetryAt=restState.cooldownUntil?Date.parse(restState.cooldownUntil):Date.now()+10_000;
      indexStrategyScannerStatus=/cooldown|429|recovery probe|queue/i.test(message)
        ?'WAITING_FOR_SHARED_REST_BUDGET':'DATA_UNAVAILABLE_NO_TRADE';
      console.warn('[FYERS_INDEX_SCANNER] scan blocked:',JSON.stringify({symbol,reason:message,status:indexStrategyScannerStatus}));
    } finally {
      indexStrategyScanBusy=false;
    }
  },5_000);
  indexStrategyScanTimer.unref?.();
}

function startFnoStrategyScanner() {
  if (fnoStrategyScanTimer) return;
  fnoStrategyScanStats.status='RUNNING';
  fnoStrategyScanTimer=setInterval(async () => {
    if (fnoStrategyScanBusy) return;
    if (Date.now() < fnoStrategyScanRetryAt) { fnoStrategyScanStats.status='WAITING_FOR_REST_BUDGET'; return; }
    if (!isNseSignalWindow(Date.now())) {
      fnoStrategyScanStats.status='OUTSIDE_NSE_SESSION';
      fnoStrategyScanStats.lastReason='Signal generation is paused outside the regular NSE session; active setup monitoring continues until market close';
      return;
    }
    const sessionMarket=getMarketData();
    const freshIndexCount=Object.values(sessionMarket.indices||{}).filter(tick=>tick?.fresh).length;
    if (freshIndexCount!==3) {
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
    const activeSliceKey=getFnoScanSliceKey(active);
    if (shouldResetFnoScanCursor(fnoStrategyScanRotation,snapshot.rotationIndex,fnoStrategyScanActiveKey,activeSliceKey)) {
      const resetReason=fnoStrategyScanRotation!==snapshot.rotationIndex?'ROTATION_CHANGED':'ACTIVE_SYMBOL_MEMBERSHIP_CHANGED';
      fnoStrategyScanRotation=snapshot.rotationIndex;
      fnoStrategyScanActiveKey=activeSliceKey;
      fnoStrategyScanCursor=0;
      fnoStrategyScanStats.sliceScannedCount=0;
      fnoStrategyScanStats.candleReceivedCount=0;
      fnoStrategyScanStats.sliceStrategyCheckCount=0;
      console.info('[FYERS_SCANNER] scan cursor reset:',JSON.stringify({
        reason:resetReason,rotationIndex:snapshot.rotationIndex,activeCount:active.length,
        firstActiveSymbol:active[0]||null,lastActiveSymbol:active.at(-1)||null
      }));
      // Research warmups deliberately survive slice rotation and manual selection
      // changes; eligible candidates discovered in the previous slice are retained.
    }
    // Fresh rolling Top-5 gainers are subscribed independently of the 20-symbol
    // rotation. Put them first in the bounded history-scan queue so a newly
    // observed leader is not forced to wait for the full 218-symbol rotation.
    // The shared REST governor and two-scan-per-minute budget remain unchanged.
    const freshTopGainers=(sessionMarket.fno?.topGainers||[])
      .filter(item=>item?.fresh&&snapshot.ticks.has(item.symbol))
      .map(item=>item.symbol);
    const scanCandidates=buildFnoScanCandidates(active,freshTopGainers);
    const scanLimit=Math.min(snapshot.scanPerSlice || 12,scanCandidates.length);
    // Complete the new-symbol scan batch first; use the remaining slice time for
    // daily context refreshes so research preparation cannot starve F&O coverage.
    const retryPendingActive=Boolean(fnoStrategyScanRetrySymbol && scanCandidates.includes(fnoStrategyScanRetrySymbol) &&
      isFreshFnoTick(snapshot.ticks.get(fnoStrategyScanRetrySymbol),Date.now()));
    const shouldWarmup=!retryPendingActive && fnoResearchWarmupQueue.size>0 && fnoResearchWarmupQueue.hasReady() && fnoStrategyScanCursor>=scanLimit;
    if (shouldWarmup) {
      const warmupSymbol=fnoResearchWarmupQueue.take();
      fnoStrategyScanStats.warmupQueueDepth=fnoResearchWarmupQueue.size;
      if (!warmupSymbol) return;
      fnoStrategyScanBusy=true;
      fnoStrategyScanStats.warmupSymbol=warmupSymbol;
      fnoStrategyScanStats.warmupStatus='LOADING_VERIFIED_DAILY_CONTEXT';
      try {
        await getDailyHistory(warmupSymbol,Date.now(),REST_PRIORITY.WARMUP,'scanner-warmup-daily');
        if (!fnoResearchWarmupQueue.complete(warmupSymbol)) {
          throw new Error('Research warmup queue completion state was not registered');
        }
        fnoStrategyScanStats.warmupStatus='VERIFIED_DAILY_CONTEXT_CACHED';
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
    if (Date.now()<fnoStrategyScanNextAllowedAt) {
      fnoStrategyScanStats.status='WAITING_FOR_SCAN_INTERVAL';
      fnoStrategyScanStats.lastReason='Global scanner cadence: one new underlying history scan every '+Math.round(FNO_SCAN_MIN_INTERVAL_MS/1000)+' seconds';
      return;
    }
    const normalSymbol=getNextFreshFnoScanSymbol(scanCandidates,snapshot.ticks,fnoSymbolScanLedger,Date.now());
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
    fnoStrategyScanNextAllowedAt=scanStartedAt+FNO_SCAN_MIN_INTERVAL_MS;
    fnoStrategyScanBusy=true;
    fnoSymbolScanLedger.set(symbol,{symbol,status:'SCANNING',attemptedAt:new Date(scanStartedAt).toISOString(),attemptCount:(fnoSymbolScanLedger.get(symbol)?.attemptCount||0)+1});
    try {
      // Re-read immediately before requesting history; the tick must still be fresh.
      let latest=getFnoUniverseSnapshot();
      scanTick=latest.ticks.get(symbol)||null;
      if(!isFreshFnoTick(scanTick,Date.now())) {
        throw new Error('Fresh FYERS underlying/futures tick is required; history request skipped');
      }
      const history=await getFiveMinuteHistory(symbol,Date.now(),REST_PRIORITY.SCANNER,'fno-scanner-5m');
      fnoStrategyScanStats.sliceScannedCount++;
      if(Array.isArray(history.candles)&&history.candles.length>0) fnoStrategyScanStats.candleReceivedCount++;
      // REST queue waits can span multiple ticks. Re-read both the feed tick and
      // WebSocket candle snapshot after history returns; never log pre-wait state.
      latest=getFnoUniverseSnapshot();
      scanTick=latest.ticks.get(symbol)||null;
      if(!isFreshFnoTick(scanTick,Date.now())) {
        throw new Error('Fresh FYERS underlying/futures tick is required after history wait; scan result discarded');
      }
      const websocketObservation=latest.websocketCandles?.get(symbol)||null;
      const tick=scanTick;
      const market=getMarketData();
      const cachedDaily=getCachedResearchHistories().daily.get(symbol);
      const research=detectNineStrategySetup({
        underlyingCandles:history.candles,underlyingTick:tick,dailyCandles:cachedDaily?.candles||[],
        isTopGainer:(market.fno?.topGainers||[]).some(item=>item.symbol===symbol),
        researchEnabled:false,now:Date.now()
      });
      fnoStrategyScanStats.scannedCount++;
      const successfulStrategyChecks=(research.strategyLedger||[]).filter(row=>row.status!=='BLOCKED').length;
      if(successfulStrategyChecks>0){fnoStrategyScanStats.strategyCheckCount++;fnoStrategyScanStats.sliceStrategyCheckCount++;}
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
        tickFresh:Boolean(tick&&tickAgeMs>=0&&tickAgeMs<=10000&&Date.now()/1000-Number(tick.exchangeTime)>=-3&&Number(tick.receivedAt)-Number(tick.exchangeTime)*1000>=0&&Number(tick.receivedAt)-Number(tick.exchangeTime)*1000<=5000),
        tickExchangeTime:tick?.exchangeTime||null,tickReceivedAt:tick?.receivedAt||null,
        candleCount:history.candles.length,lastCompletedCandleTime:history.candles.at(-1)?.time||null,
        source:history.source||'FYERS_HISTORY',strategyLedger:research.strategyLedger||[],
        websocketObservation:{status:websocketObservation?.status||'NO_OBSERVATIONS',completedCount:websocketObservation?.completedCandles?.length||0,contiguousCompletedCount:websocketObservation?.contiguousCompletedCount||0,volumeVerified:Boolean(websocketObservation?.volumeVerified),actionable:Boolean(websocketObservation?.actionable)}
      });
      // Fetch daily context only when verified 5m structure shows an EMA20
      // pullback touch followed by a resume candle; do not warm every symbol.
      if(needsDailyTrendPullbackHistory(history.candles,scanTick.exchangeTime)) {
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
      const retryable=isRetryableFnoScanError(errorMessage);
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
        websocketObservation:scanRecord.websocketObservation||null,
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
function updateActiveSetupLifecycle(market) {
  const ticksBySymbol = new Map((market.activeOptionTicks || []).map(row => [row.symbol, row.tick]));
  for (const [id, setup] of activeSetupLedger) {
    if (setup.status !== 'ACTIVE') continue;
    const tick = ticksBySymbol.get(setup.contract);
    const updated=updateActiveSetupFromTick(setup,tick,Date.now());
    activeSetupLedger.set(id,updated);
    if(updated.status!=='ACTIVE') {
      const cached=getCachedResearchHistories().fiveMinute.get(setup.underlying);
      const closedAt=updated.closedAt||new Date().toISOString();
      const closedAtMs=Date.parse(closedAt);
      const closedCandleTime=Number.isFinite(closedAtMs)?Math.floor(closedAtMs/300_000)*300:
        Number(setup.setupCandleTime||cached?.candles?.at(-1)?.time||0);
      recentlyClosedSetupByUnderlying.set(setup.underlying,{
        closedCandleTime,closedAt,status:updated.status,contract:setup.contract
      });
      console.info('[OPPORTUNITY_CYCLE] setup closed; slot released and next scan remains enabled:',JSON.stringify({
        id,underlying:setup.underlying,contract:setup.contract,status:updated.status,
        activeCount:[...activeSetupLedger.values()].filter(row=>row.status==='ACTIVE').length,
        setupCandleTime:closedCandleTime,closedAt:updated.closedAt||null
      }));
    }
  }
  const activeContracts = [...new Set([...activeSetupLedger.values()].filter(row => row.status === 'ACTIVE').map(row => row.contract))];
  const activeContractsKey = activeContracts.join('|');
  if (activeContractsKey !== lastPinnedActiveSetupContractsKey) {
    setActiveTradeOptionSymbols(activeContracts);
    lastPinnedActiveSetupContractsKey = activeContractsKey;
  }
  market.activeSetups = [...activeSetupLedger.values()].map(row => ({...row}));
  return market;
}
function startActiveSetupMonitor() {
  if (activeSetupMonitorTimer) return;
  activeSetupMonitorTimer = setInterval(() => {
    if (!isNseRegularSession(Date.now())) return;
    if (![...activeSetupLedger.values()].some(row => row.status === 'ACTIVE')) return;
    // Tick-driven exit monitoring runs server-side; it does not depend on the
    // browser polling /api/market-data or remaining open after setup trigger.
    updateActiveSetupLifecycle(getMarketData());
  }, 1000);
  activeSetupMonitorTimer.unref?.();
}
function normalizeActiveSetup(input) {
  if (!input || typeof input !== 'object') return null;
  const underlying = String(input.underlying || '');
  const contractSymbol = String(input.contract || '');
  const contract = getVerifiedOptionContract(contractSymbol);
  const entry = Number(input.entry), stopLoss = Number(input.stopLoss), target = Number(input.target);
  const riskPlan = validateFixedRiskPlan({entry,stopLoss,target,minRR:2,tickSize:contract?.tickSize});
  const expectedUnderlying = underlying.replace(/^NSE:/,'').replace(/-EQ$/,'').toUpperCase();
  if (!validateNseSymbol(underlying) || !contract || contract.symbol !== contractSymbol ||
      contract.underlying !== expectedUnderlying || !riskPlan.ok) return null;
  const entryAt = Number.isFinite(Date.parse(input.entryAt)) ? new Date(input.entryAt).toISOString() : new Date().toISOString();
  const id = String(input.id || (contractSymbol + '|' + entryAt));
  return {id,underlying,contract:contractSymbol,strategy:String(input.strategy || 'VERIFIED_STRATEGY'),
    optionSide:contract.side,strike:contract.strike??null,expiry:contract.expiry??null,
    entry,stopLoss,target,rr:riskPlan.rr,entryAt,
    setupCandleTime:Number.isFinite(Number(input.setupCandleTime))&&Number(input.setupCandleTime)>0?Number(input.setupCandleTime):null,
    status:'ACTIVE',feedStatus:'WAITING_FOR_TICK',lastObservedPrice:null,lastObservedExchangeTime:null,lastObservedAt:null,
    exitPrice:null,closedAt:null};
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
  return updateActiveSetupLifecycle(market);
}
function startFyersRefreshMonitor() {
  if(fyersRefreshMonitorTimer || !process.env.FYERS_PIN?.trim()) return;
  fyersRefreshMonitorTimer=setInterval(async()=>{
    if(Date.now()<fyersRefreshRetryAt) return;
    const auth=getAuthStatus();
    if(!auth.refreshTokenStored) return;
    try {
      const result=await refreshAccessToken({appId:process.env.FYERS_APP_ID,appSecret:process.env.FYERS_SECRET_KEY,pin:process.env.FYERS_PIN});
      if(result.refreshed) {
        fyersRefreshRetryAt=0;
        console.info('[FYERS_OAUTH] background access-token refresh succeeded; token value withheld');
      }
    } catch(error) {
      const message=String(error?.message||error);
      if(!/already in progress/.test(message)) fyersRefreshRetryAt=Date.now()+5*60*1000;
      console.warn('[FYERS_OAUTH] background refresh unavailable; OAuth reconnect may be required:',message.slice(0,180));
    }
  },60_000);
  fyersRefreshMonitorTimer.unref?.();
}

function ensureFyersMarketStarted() {
  startFyersRefreshMonitor();
  const market = startMarketSocket();
  startIndexStrategyScanner();
  startActiveSetupMonitor();
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
  const appId=process.env.FYERS_APP_ID, appSecret=process.env.FYERS_SECRET_KEY;
  let hasFyersSession=Boolean(requestCookies.fyers_session && restoreSessionCookie(requestCookies.fyers_session,{appId,appSecret}));
  const hasRefreshSession=Boolean(requestCookies.fyers_refresh && restoreRefreshSessionCookie(requestCookies.fyers_refresh,{appId,appSecret}));
  let refreshedThisRequest=false;
  if(hasRefreshSession && process.env.FYERS_PIN?.trim() && Date.now()>=fyersRefreshRetryAt) {
    // refreshAccessToken enforces the five-minute expiry safety window and single-flight guard.
    try {
      const result=await refreshAccessToken({appId,appSecret,pin:process.env.FYERS_PIN});
      refreshedThisRequest=Boolean(result.refreshed);
      if(refreshedThisRequest) {
        fyersRefreshRetryAt=0;
        hasFyersSession=true;
        console.info('[FYERS_OAUTH] access token refreshed from encrypted browser refresh session; token value withheld');
      }
    } catch(error) {
      const message=String(error?.message||error);
      if(!/already in progress/.test(message)) fyersRefreshRetryAt=Date.now()+5*60*1000;
      console.warn('[FYERS_OAUTH] automatic refresh unavailable; OAuth reconnect required:',message.slice(0,180));
    }
  }
  if (hasFyersSession) {
    if(refreshedThisRequest) {
      res.__fyersSessionCookieFactory=()=>{
        const session=createSessionCookie({appId,appSecret});
        return `fyers_session=${session.value}; Max-Age=${session.maxAge}; Path=/api; HttpOnly; Secure; SameSite=Lax`;
      };
    }
    const restoredSafety=restoreRestSafetyCookie(requestCookies.fyers_rest_safety,{appId,appSecret});
    if (restoredSafety) restoreRestSafetyState(restoredSafety);
    // Attach a cookie only when this process has a newer active cooldown than
    // the browser already holds. This avoids rewriting Set-Cookie on 2s polling.
    res.__fyersRestSafetyCookieFactory=()=>{
      const state=getRestSafetyState();
      const deadline=Number(state.cooldownUntil);
      if (!Number.isFinite(deadline) || deadline<=Date.now()) return null;
      if (restoredSafety && Number(restoredSafety.cooldownUntil)>=deadline) return null;
      const cookie=createRestSafetyCookie({appId,appSecret,state});
      return cookie ? `fyers_rest_safety=${cookie.value}; Max-Age=${cookie.maxAge}; Path=/api; HttpOnly; Secure; SameSite=Lax` : null;
    };
    ensureFyersMarketStarted();
  }
  // Public endpoints are limited to non-account market/status views and OAuth
  // entry/callback. All broker-backed data and workstation controls require the
  // caller's own cryptographically valid FYERS session cookie.
  if (requiresFyersSession(url.pathname) && !hasFyersSession) {
    return send(res,401,{status:'AUTHENTICATION_REQUIRED',reason:'A valid Upgrade AI Pro FYERS session is required for this endpoint'});
  }
  if (req.method === 'GET' && url.pathname === '/api/fno/search') {
    if (!(await waitForCurrentFnoMaster({ loadPromise:fnoUniverseLoadPromise, isCurrent:isFnoMasterCurrent }))) return send(res,503,{status:'SYMBOL_MASTER_NOT_LOADED',results:[],reason:'Current-session official FYERS NSE F&O master is not verified'});
    const query=String(url.searchParams.get('q')||'').trim().toUpperCase().slice(0,40);
    if (query.length < 2) return send(res,200,{status:'QUERY_TOO_SHORT',query,results:[]});
    const snapshot=getFnoUniverseSnapshot();
    const results=(snapshot.universe||[])
      .filter(item=>String(item.symbol||'').toUpperCase().includes(query)||String(item.name||'').toUpperCase().includes(query)||String(item.underlying||'').toUpperCase().includes(query))
      .slice(0,20)
      .map(item=>({symbol:item.symbol,name:item.name||item.underlying||item.symbol,underlying:item.underlying}));
    return send(res,200,{status:'OFFICIAL_FNO_MASTER_MATCHES',query,universeCount:snapshot.universe?.length||0,resultCount:results.length,results});
  }

  if (req.method === 'GET' && url.pathname === '/api/research/indices') {
    const now=Date.now();
    const market=getMarketData(now);
    const freshIndexCount=countFreshIndexTicks(market.indices||{},now);
    const inSession=isNseSignalWindow(now);
    const scans=INDEX_STRATEGY_SYMBOLS.map(symbol=>{
      const prior=indexStrategyScanStats[symbol];
      const tick=market.indices?.[symbol]||null;
      const tickFresh=isFreshIndexTick(tick,now);
      const candleTime=Number(prior.lastCompletedCandleTime||0);
      const candleAgeSeconds=candleTime>0?now/1000-(candleTime+300):null;
      const expectedLatestCompletedCandleTime=Math.floor(now/300_000)*300-300;
      const scanCurrent=Number.isFinite(candleAgeSeconds)&&candleAgeSeconds>=0&&candleAgeSeconds<=600&&candleTime===expectedLatestCompletedCandleTime;
      const tradeStatus=inSession&&freshIndexCount===3&&tickFresh&&scanCurrent&&prior.status==='UNDERLYING_SETUP_CONFIRMED'
        ?'OPTION_CONFIRMATION_REQUIRED_NO_TRADE':'NO_TRADE';
      return {
        ...prior,tickFresh,tickPrice:tickFresh?tick.price:null,
        tickExchangeTime:tick?.exchangeTime||prior.tickExchangeTime||null,
        tickReceivedAt:tick?.receivedAt||prior.tickReceivedAt||null,
        feedStatus:tickFresh?'FRESH':'STALE_OR_MISSING',
        scanCurrent,tradeStatus,actionable:false,orders:'DISABLED'
      };
    });
    return send(res,200,{
      status:inSession?'LIVE_INDEX_SCAN':'OUTSIDE_NSE_SESSION',
      marketSession:inSession?'OPEN':'CLOSED',
      scannerStatus:indexStrategyScannerStatus,
      freshIndexCount,totalIndexCount:INDEX_STRATEGY_SYMBOLS.length,
      scanReady:inSession&&freshIndexCount===3,
      scans,restBudget:'SHARED_BACKGROUND_MAX_2_PER_MINUTE',
      note:'Three fresh FYERS index ticks and recent completed FYERS 5-minute candles are required. Nine underlying strategies only; any detected setup still requires independent fresh CE/PE tick and completed option-candle confirmation. No Entry/SL/Target or orders are produced by this index scan.'
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/market-data') return send(res,200,getSessionMarketData());
  if (req.method === 'GET' && url.pathname === '/api/active-setups') return send(res,200,{setups:[...activeSetupLedger.values()].map(row=>({...row}))});
  if (req.method === 'POST' && url.pathname === '/api/active-setups') {
    try {
      const body = await readJson(req);
      const restore = planActiveSetupRestore({
        currentSetups:[...activeSetupLedger.values()],
        incomingSetups:body.setups,
        normalizeSetup:normalizeActiveSetup,
        maxActiveSetups:MAX_ACTIVE_SETUP_LEDGER
      });
      if (!restore.ok) return send(res,restore.reason.includes('Maximum two')?409:400,{status:'REJECTED',reason:restore.reason});
      activeSetupLedger.clear();
      for (const row of restore.setups) activeSetupLedger.set(row.id,row);
      const contracts=[...new Set([...activeSetupLedger.values()].filter(row=>row.status==='ACTIVE').map(row=>row.contract))];
      const subscription=setActiveTradeOptionSymbols(contracts);
      return send(res,200,{status:subscription.status,setups:[...activeSetupLedger.values()].map(row=>({...row})),subscription});
    } catch(error) {
      return send(res,400,{status:'REJECTED',reason:String(error.message||'Active setup restore failed').slice(0,180)});
    }
  }
  if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
    try {
      if (url.pathname === '/api/history') return send(res,200,await getFiveMinuteSessionHistory(url.searchParams.get('symbol'),Date.now(),REST_PRIORITY.CHART,'chart-history'));
      if (url.pathname === '/api/backtest/historical-fno') return send(res,410,{status:'BACKTEST_ISOLATED',reason:'Historical backtests are not available inside the live trading process'});
      if (url.pathname === '/api/option-history') {
        const symbol=url.searchParams.get('symbol');
        const contract=getVerifiedOptionContract(symbol);
        if(!contract||contract.symbol!==symbol||!['CE','PE'].includes(contract.side))
          return send(res,400,{status:'OPTION_CONTRACT_NOT_VERIFIED',reason:'The requested strike is not an exact current-session FYERS option-master contract'});
        const history=await getFiveMinuteSessionHistory(symbol,Date.now(),REST_PRIORITY.CHART,'retained-option-chart-history');
        return send(res,200,{...history,contract:{symbol:contract.symbol,underlying:contract.underlying,side:contract.side,strike:contract.strike,expiry:contract.expiry},chartSource:'FYERS_VERIFIED_OPTION_HISTORY'});
      }
      if (url.pathname === '/api/research-context') {
        const symbol = url.searchParams.get('symbol');
        if (!validateNseSymbol(symbol)) return send(res,400,{status:'INVALID_SYMBOL',reason:'A verified NSE F&O underlying is required'});
        // Keep context warmup inside the shared REST pacing instead of
        // enqueueing two lower-priority history requests as a burst.
        const fifteenMinute = await getFifteenMinuteHistory(symbol,Date.now(),REST_PRIORITY.CONTEXT,'research-context-15m');
        return send(res,200,{status:'RESEARCH_CONTEXT_WARM',symbol,timeframes:{fifteenMinute:{count:fifteenMinute.count,source:fifteenMinute.source,lastCompletedCandleTime:fifteenMinute.lastCompletedCandleTime,ageSeconds:fifteenMinute.ageSeconds}},researchContext:'15M_5M_RESEARCH_ONLY_NOT_STRATEGY_3'});
      }
      if (url.pathname === '/api/research/historical-universe') {
        if (!(await waitForCurrentFnoMaster({ loadPromise:fnoUniverseLoadPromise, isCurrent:isFnoMasterCurrent }))) return send(res,200,{status:'SYMBOL_MASTER_NOT_LOADED',mode:'HISTORICAL_ONLY',universeCount:0,evaluatedCount:0,blockedCount:0,candidateCount:0,candidates:[],reason:'Current-session official FYERS NSE F&O master is not verified'});
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
          if(result.status==='UNDERLYING_SETUP_CONFIRMED') candidates.push({...row,status:'LAST_SESSION_RESEARCH_CANDIDATE'});
        }
        candidates.sort((a,b)=>Number(b.confirmedAt||0)-Number(a.confirmedAt||0));
        return send(res,200,{status:candidates.length?'HISTORICAL_CANDIDATES_AVAILABLE':'NO_HISTORICAL_CANDIDATE',mode:'HISTORICAL_ONLY_NOT_LIVE',universeCount:snapshot.universe?.length||0,evaluatedCount:evaluations.filter(row=>row.status!=='BLOCKED').length,blockedCount:evaluations.filter(row=>row.status==='BLOCKED').length,candidateCount:candidates.length,candidates:candidates.slice(0,20),evaluations,note:'Historical FYERS completed candles only. No live tick, option quote, option candle, entry, stop or target is inferred. This list is research-only and cannot authorize a trade.'});
      }
      if (url.pathname === '/api/research/universe') {
        if (!(await waitForCurrentFnoMaster({ loadPromise:fnoUniverseLoadPromise, isCurrent:isFnoMasterCurrent }))) return send(res,200,{status:'SYMBOL_MASTER_NOT_LOADED',marketSession:isNseRegularSession(Date.now())?'OPEN':'CLOSED',scannerStatus:'WAITING_FOR_OFFICIAL_MASTER',universeCount:0,evaluatedCount:0,blockedCount:0,candidateCount:0,top3:[],scanner:fnoStrategyScanStats,scanPerSlice:1,note:'Current IST session official FYERS NSE F&O master is pending; no prior-session universe is ranked.'});
        const snapshot=getFnoUniverseSnapshot();
        const histories=getCachedResearchHistories();
        const market=getMarketData();
        const latestCandleTimes=new Map((snapshot.universe||[]).map(item=>[
          item.symbol,Number(histories.fiveMinute.get(item.symbol)?.candles?.at(-1)?.time||0)
        ]));
        const opportunityCycle=getOpportunityCycleState({
          setups:[...activeSetupLedger.values()],
          recentlyClosed:recentlyClosedSetupByUnderlying,
          latestCandleTimes,maxActiveSetups:MAX_ACTIVE_SETUP_LEDGER
        });
        for(const symbol of opportunityCycle.expiredClosedUnderlyings) recentlyClosedSetupByUnderlying.delete(symbol);
        const excludedUnderlyings=opportunityCycle.excludedUnderlyings;
        const result=evaluateRollingFnoUniverse({
          universe:snapshot.universe,ticks:snapshot.ticks,
          fiveMinute:histories.fiveMinute,daily:histories.daily,fifteenMinute:histories.fifteenMinute,
          topGainers:market.fno?.topGainers||[],now:Date.now(),
          excludeSymbols:excludedUnderlyings
        });
        const now=Date.now();
        const symbolCoverage=(snapshot.universe||[]).map(item=>{
          const prior=fnoSymbolScanLedger.get(item.symbol)||null;
          const tick=snapshot.ticks.get(item.symbol)||null;
          const tickAgeMs=tick?now-Number(tick.receivedAt):null;
          const exchangeReceiptDelayMs=tick?Number(tick.receivedAt)-Number(tick.exchangeTime)*1000:null;
          const tickFresh=Boolean(tick&&tickAgeMs>=0&&tickAgeMs<=10000&&now/1000-Number(tick.exchangeTime)>=-3&&exchangeReceiptDelayMs>=0&&exchangeReceiptDelayMs<=5000);
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
        const strategyChecksThisSlice=Number(fnoStrategyScanStats.sliceStrategyCheckCount||0);
        const fullCycleMinutes=snapshot.activeSymbols?.length&&snapshot.scanPerSlice?Math.ceil((snapshot.universe?.length||0)/snapshot.activeSymbols.length)*Math.ceil(snapshot.activeSymbols.length/snapshot.scanPerSlice):null;
        // Candidate generation already requires a fresh underlying tick and a verified
        // completed-candle ten-strategy confirmation. Do not hide valid rolling
        // candidates merely because the active WebSocket slice just rotated and
        // its per-slice diagnostic counter was reset.
        const safeTop3=Array.isArray(result.top3)?result.top3:[];
        return send(res,200,{...result,status:safeTop3.length?result.status:strategyChecksThisSlice>0?result.status:'NO_TRADE_DATA',top3:safeTop3,candidateCount:safeTop3.length,activeSetupCount:opportunityCycle.activeCount,availableSetupSlots:opportunityCycle.availableSlots,excludedActiveUnderlyings:opportunityCycle.activeUnderlyings,excludedUntilNextFiveMinuteCandle:opportunityCycle.coolingUnderlyings,opportunityCycleStatus:opportunityCycle.availableSlots===0?'WAITING_FOR_ACTIVE_SLOT':safeTop3.length?'NEXT_VERIFIED_CANDIDATE_AVAILABLE':'SCANNING_FOR_NEXT_CANDIDATE',marketSession:isNseRegularSession(now)?'OPEN':'CLOSED',scannerStatus:isNseRegularSession(now)?fnoStrategyScanStats.status:'OUTSIDE_NSE_SESSION',scannerPauseReason:isNseRegularSession(now)?null:'NSE market session is closed; live F&O scanning and research warmups are paused',activeSymbols:snapshot.activeSymbols,rotationIndex:snapshot.rotationIndex,
          rotationIntervalMs:snapshot.rotationIntervalMs,scanIntervalMs:FNO_SCAN_MIN_INTERVAL_MS,scanPerSlice:snapshot.scanPerSlice,sliceSize:snapshot.activeSymbols?.length||0,fullCycleMinutes,strategyChecksThisSlice,candleReceivedThisSlice:Number(fnoStrategyScanStats.candleReceivedCount||0),symbolCap:snapshot.symbolCap,
          scanner:{...fnoStrategyScanStats,scanIntervalMs:FNO_SCAN_MIN_INTERVAL_MS},coverageSummary,symbolCoverage,
          note:'Twenty-symbol live socket slices rotate each minute. History-backed strategy checks remain within the FYERS REST governor; counters report actual completed checks only. Per-symbol scan/tick coverage is observational only. Missing/stale inputs are BLOCKED; no synthetic data or orders.'});
      }
      if (url.pathname === '/api/research') {
        if (!(await waitForCurrentFnoMaster({ loadPromise:fnoUniverseLoadPromise, isCurrent:isFnoMasterCurrent }))) return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',researchRanking:[],reason:'Current IST session official FYERS NSE F&O master is not verified'});
        const symbol = url.searchParams.get('symbol');
        if (!validateNseSymbol(symbol)) return send(res,400,{status:'INVALID_SYMBOL',reason:'A verified NSE F&O underlying is required'});
        const market = getMarketData();
        const underlying = market.selectedUnderlying;
        if (!underlying?.fresh || underlying.symbol !== symbol) {
          return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',researchRanking:[],reason:'Fresh selected-underlying FYERS tick is required for independent research'});
        }
        const [fiveMinute,fifteenMinute] = await Promise.all([
          getFiveMinuteHistory(symbol,Date.now(),REST_PRIORITY.RESEARCH,'manual-research-5m'),
          getFifteenMinuteHistory(symbol,Date.now(),REST_PRIORITY.RESEARCH,'manual-research-15m')
        ]);
        const preDailyMarket = getMarketData();
        const preDailyUnderlying = preDailyMarket.selectedUnderlying;
        if (!preDailyUnderlying?.fresh || preDailyUnderlying.symbol !== symbol) {
          return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',researchRanking:[],reason:'Underlying tick became stale while verified research history was loading'});
        }
        // Daily EMA20/EMA50 is Strategy 3's required context. Avoid a daily
        // REST call unless completed 5m structure reaches its pullback/resume prefilter.
        let dailyHistory={candles:[]};
        let dailyHistoryError=null;
        const dailyContextRequired=needsDailyTrendPullbackHistory(fiveMinute.candles,preDailyUnderlying.exchangeTime);
        if(dailyContextRequired) {
          try {
            dailyHistory=await getDailyHistory(symbol,Date.now(),REST_PRIORITY.RESEARCH,'manual-research-daily');
          } catch(error) {
            dailyHistoryError=String(error?.message||'Daily research context unavailable').slice(0,160);
          }
        }
        const latestMarket = getMarketData();
        const latestUnderlying = latestMarket.selectedUnderlying;
        if (!latestUnderlying?.fresh || latestUnderlying.symbol !== symbol) {
          return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',researchRanking:[],reason:'Underlying tick became stale while verified research history was loading'});
        }
        const isTopGainer = (latestMarket.fno?.topGainers || []).some(item => item.symbol === symbol);
        const research = detectNineStrategySetup({
          underlyingCandles:fiveMinute.candles, underlyingTick:latestUnderlying,
          dailyCandles:dailyHistory.candles||[],fifteenMinuteCandles:fifteenMinute.candles,
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
          dailyContextRequired,
          dailyCandleCount:Array.isArray(dailyHistory.candles)?dailyHistory.candles.length:0,
          dailyContextStatus:dailyContextRequired?(dailyHistory.candles.length>=50?'FYERS_DAILY_CONTEXT_AVAILABLE':'BLOCKED'):'NOT_REQUIRED_5M_PREFILTER',
          dailyContextReason:dailyHistoryError,
          asOfExchangeTime:latestUnderlying.exchangeTime
        });
      }
      if (url.pathname === '/api/quotes') {
        const symbols = (url.searchParams.get('symbols') || '').split(',').filter(Boolean);
        return send(res,200,await getFyersQuotes(symbols,'quotes-endpoint'));
      }
      if (url.pathname === '/api/option-chain') {
        if (!(await waitForCurrentFnoMaster({ loadPromise:fnoUniverseLoadPromise, isCurrent:isFnoMasterCurrent }))) return send(res,503,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Current IST session official FYERS NSE F&O master is not verified'});
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
    return send(res,200,{
      ...buildHealthStatus({
        market, masterCurrent:isFnoMasterCurrent(), marketSessionOpen:isNseRegularSession(Date.now()), sessionDate:getNseSessionDate(),
        loadedDate:fnoUniverseLoadedDate, ordersEnabled:tradingEnabled(), authStatus:getAuthStatus(),
        scanner:{...fnoStrategyScanStats,scanIntervalMs:FNO_SCAN_MIN_INTERVAL_MS}, scanPerSlice:getFnoUniverseSnapshot().scanPerSlice,
        rotationIntervalMs:getFnoUniverseSnapshot().rotationIntervalMs,
        rest:getRestDiagnostics(), runtimeMemory:process.memoryUsage()
      }),
      indexScanner:{status:indexStrategyScannerStatus,freshIndexCount:countFreshIndexTicks(market.indices||{},Date.now()),totalIndexCount:INDEX_STRATEGY_SYMBOLS.length,scans:Object.values(indexStrategyScanStats).map(row=>({...row,actionable:false,orders:'DISABLED'}))},
      schedule:{timezone:'Asia/Kolkata',signalWindow:'09:15-15:30',marketMonitoringWindow:'09:15-15:30',
        signalWindowOpen:isNseSignalWindow(Date.now()),activeSetupMonitoring:'SERVER_SIDE_UNTIL_MARKET_CLOSE'}
    });
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
      secretConfigured:Boolean(process.env.FYERS_SECRET_KEY?.trim()),
      refreshPinConfigured:Boolean(process.env.FYERS_PIN?.trim())
    },
    fnoCoverage:market.fno, indexScanner:{mode:'THREE_INDEX_NINE_STRATEGY_UNDERLYING_ONLY',status:indexStrategyScannerStatus,freshIndexCount:countFreshIndexTicks(market.indices||{},Date.now()),totalIndexCount:INDEX_STRATEGY_SYMBOLS.length,scans:Object.values(indexStrategyScanStats).map(row=>({...row,actionable:false,orders:'DISABLED'}))}, scanner:{mode:'ROLLING_FNO_NINE_STRATEGY_EVALUATION',...fnoStrategyScanStats,scanIntervalMs:FNO_SCAN_MIN_INTERVAL_MS,scanPerSlice:getFnoUniverseSnapshot().scanPerSlice,rotationIntervalMs:getFnoUniverseSnapshot().rotationIntervalMs,simultaneous:false}, strategyEngine:'NINE_STRATEGY_WITH_VERIFIED_MULTI_TIMEFRAME_RESEARCH · ROLLING F&O UNIVERSE EVALUATION · CACHED FYERS DATA ONLY', orderPlacementEnabled:tradingEnabled(), marketSession:'NSE 09:15-15:30 Asia/Kolkata'
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/fyers/login') {
    console.info('[FYERS_OAUTH] login route reached');
    try {
      const auth = getAuthStatus();
      if (shouldReuseAuthenticatedSession({auth,hasSession:hasFyersSession})) {
        ensureFyersMarketStarted();
        const session = createSessionCookie({appId:process.env.FYERS_APP_ID,appSecret:process.env.FYERS_SECRET_KEY});
        const sessionCookie = `fyers_session=${session.value}; Max-Age=${session.maxAge}; Path=/api; HttpOnly; Secure; SameSite=Lax`;
        const refresh = createRefreshSessionCookie({appId:process.env.FYERS_APP_ID,appSecret:process.env.FYERS_SECRET_KEY});
        const cookies=[sessionCookie];
        if(refresh) cookies.push(`fyers_refresh=${refresh.value}; Max-Age=${refresh.maxAge}; Path=/api; HttpOnly; Secure; SameSite=Lax`);
        console.info('[FYERS_OAUTH] existing authenticated session reused; encrypted refresh session reissued:',Boolean(refresh));
        res.writeHead(302,{location:'/?fyers=session-restored','set-cookie':cookies,'cache-control':'no-store','referrer-policy':'no-referrer'}); return res.end();
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
    if (!consumeLoginState(state,cookies.fyers_oauth_state,consumedOAuthStates)) {
      console.warn('[FYERS_OAUTH] callback rejected: state missing, mismatched or already consumed');
      res.setHeader('set-cookie',clearStateCookie);
      return send(res,400,{status:'REJECTED',reason:'OAuth state is missing, mismatched or already used. Start Connect once again.'});
    }
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
      const refresh=createRefreshSessionCookie({appId:process.env.FYERS_APP_ID,appSecret:process.env.FYERS_SECRET_KEY});
      const cookies=[clearStateCookie,sessionCookie];
      if(refresh) cookies.push(`fyers_refresh=${refresh.value}; Max-Age=${refresh.maxAge}; Path=/api; HttpOnly; Secure; SameSite=Lax`);
      const market = ensureFyersMarketStarted();
      console.info('[FYERS_DATA] socket start requested; status:', market.status, 'encrypted access/refresh session cookies issued:',Boolean(refresh));
      res.writeHead(302,{location:'/?fyers=connected','set-cookie':cookies,'cache-control':'no-store','referrer-policy':'no-referrer'}); return res.end();
    } catch (error) {
      const d = error.fyersDiagnostics || {};
      console.error('[FYERS_OAUTH] token exchange failed:', error.message,
        JSON.stringify({httpStatus:d.status || null, elapsedMs:d.elapsedMs || null, retryAfter:d.retryAfter || null, cfRay:d.cfRay || null, server:d.server || null, contentType:d.contentType || null}));
      const upstream429 = /FYERS_UPSTREAM_HTTP_429/.test(String(error.message));
      return send(res,upstream429 ? 429 : 502,{status:upstream429 ? 'FYERS_UPSTREAM_RATE_LIMIT' : 'TOKEN_EXCHANGE_FAILED',reason:error.message});
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/backtest/historical-fno') return send(res,410,{status:'BACKTEST_ISOLATED',reason:'Historical backtests must run in a separate worker and cannot use the live process'});
  if (req.method === 'POST' && url.pathname === '/api/select-underlying') {
    try {
      if (!(await waitForCurrentFnoMaster({ loadPromise:fnoUniverseLoadPromise, isCurrent:isFnoMasterCurrent }))) return send(res,503,{status:'UNDERLYING_NOT_VERIFIED',reason:'Current IST session official FYERS NSE F&O master is not verified'});
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
      if (!(await waitForCurrentFnoMaster({ loadPromise:fnoUniverseLoadPromise, isCurrent:isFnoMasterCurrent }))) return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Current IST session official FYERS NSE F&O master is not verified'});
      const body = await readJson(req);
      // Refresh lifecycle from the latest official option ticks before deciding
      // whether an active slot is still occupied by a position that has exited.
      const market = getSessionMarketData();
      const activeRows=[...activeSetupLedger.values()].filter(row=>row.status==='ACTIVE');
      if(activeRows.length>=MAX_ACTIVE_SETUP_LEDGER) return send(res,200,{
        status:'ACTIVE_SETUP_LIMIT_NO_TRADE',
        reason:'Two verified setups are already active. The independent F&O scanner continues searching; option confirmation waits until an active slot is released.',
        activeSetupCount:activeRows.length,availableSetupSlots:0,orders:'DISABLED'
      });
      if(activeRows.some(row=>row.underlying===body.underlying||row.contract===body.contract)) return send(res,200,{
        status:'ACTIVE_SETUP_ALREADY_RETAINED_NO_TRADE',
        reason:'This underlying or option contract already has an active retained setup.',
        activeSetupCount:activeRows.length,availableSetupSlots:Math.max(0,MAX_ACTIVE_SETUP_LEDGER-activeRows.length),orders:'DISABLED'
      });
      const freshIndexCount=Object.values(market.indices||{}).filter(tick=>tick?.fresh).length;
      if(freshIndexCount!==3) return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:'All three FYERS indices (NIFTY 50, BANK NIFTY and FIN NIFTY) must be fresh; one stale index blocks the setup'});
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
      const pin = pinSetupEvaluationSymbols(flightKey,[body.underlying,body.contract]);
      if(pin.status!=='SETUP_EVALUATION_SYMBOLS_PINNED') return send(res,200,{status:'DATA_UNAVAILABLE_NO_TRADE',reason:pin.reason||'Setup feed symbols could not be pinned safely'});
      let setup;
      try {
        setup = await setupEvaluationFlight.run(flightKey, async () => {
        const startedAt = Date.now();
        console.info('[SETUP_EVAL] started:',JSON.stringify({underlying:body.underlying,contract:body.contract,contractSide:contract.side,strike:contract.strike,expiry:contract.expiry}));
        // Load the setup's history inputs sequentially. Promise.all queued four
        // ENTRY jobs at once; with the mandatory 4-second REST gap, the final
        // job could expire before dispatch even when the upstream was healthy.
        // Each history accessor reuses its verified in-memory cache / single-flight.
        const underlyingHistory = await getFiveMinuteHistory(body.underlying,Date.now(),REST_PRIORITY.ENTRY,'setup-underlying-5m');
        const optionHistory = await getFiveMinuteHistory(body.contract,Date.now(),REST_PRIORITY.ENTRY,'setup-option-5m');
        // Strategy 3 is Daily EMA20/EMA50 trend + 5m pullback/resume.
        // Load completed FYERS daily candles through the same paced ENTRY scheduler.
        const dailyHistory = await getDailyHistory(body.underlying,Date.now(),REST_PRIORITY.ENTRY,'setup-underlying-daily');
        console.info('[SETUP_EVAL] histories_verified:',JSON.stringify({
          underlying:body.underlying,contract:body.contract,
          underlying5mCount:underlyingHistory.candles.length,
          underlyingDailyCount:dailyHistory.candles.length,
          dailyLastCompletedCandleTime:dailyHistory.candles.at(-1)?.time||null,
          option5mCount:optionHistory.candles.length,
          optionLastCompletedCandleTime:optionHistory.candles.at(-1)?.time||null,
          strategyContext:'DAILY_TREND_PLUS_5M_PULLBACK_RESUME',
          sources:[underlyingHistory.source,dailyHistory.source,optionHistory.source]
        }));
        // Re-read after REST work: never let history latency silently weaken the
        // strict 10-second underlying/option WebSocket freshness gates.
        const latestMarket=getMarketData();
        const latestUnderlying=getMarketTick(body.underlying),latestOption=getMarketTick(body.contract);
        if(!latestUnderlying?.fresh||latestUnderlying.symbol!==body.underlying)
          return {status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Underlying tick became stale while verified research history was loading'};
        if(!latestOption?.fresh||latestOption.symbol!==body.contract)
          return {status:'DATA_UNAVAILABLE_NO_TRADE',reason:'Option tick became stale while verified research history was loading'};
        const isTopGainer = (latestMarket.fno?.topGainers || []).some(item=>item.symbol===body.underlying);
        const result = evaluateNineStrategies({
          underlyingCandles:underlyingHistory.candles,underlyingTick:latestUnderlying,
          optionCandles:optionHistory.candles,optionTick:latestOption,contract,
          dailyCandles:dailyHistory.candles,fifteenMinuteCandles:[],
          isTopGainer,researchEnabled:false,now:Date.now()
        });
        console.info('[SETUP_EVAL] completed:',JSON.stringify({
          underlying:body.underlying,contract:body.contract,status:result.status,
          strategy:result.strategy||null,reason:result.reason||null,
          optionCandleCount:optionHistory.candles.length,
          entry:Number.isFinite(Number(result.entry))?result.entry:null,
          stopLoss:Number.isFinite(Number(result.stopLoss))?result.stopLoss:null,
          target:Number.isFinite(Number(result.target))?result.target:null,
          rr:Number.isFinite(Number(result.rr))?result.rr:null,
          entryTriggerPrice:Number.isFinite(Number(result.entryTriggerPrice))?result.entryTriggerPrice:null,
          optionConfirmation:result.optionConfirmation||null,
          researchStatus:result.research?.status||null,
          researchQualityScore:Number.isFinite(Number(result.research?.qualityScore))?result.research.qualityScore:null,
          evaluatedStrategies:Array.isArray(result.evaluatedStrategies)?result.evaluatedStrategies:[],
          blockedStrategies:Array.isArray(result.blockedStrategies)?result.blockedStrategies:[],
          strategyLedger:Array.isArray(result.strategyLedger)?result.strategyLedger.map(({strategy,status,reason,side,confirmedAt})=>({strategy,status,reason,side:side||null,confirmedAt:confirmedAt||null})):[],
          durationMs:Date.now()-startedAt
        }));
        return {...result,underlying:body.underlying,contract:body.contract,contractDetails:{side:contract.side,strike:contract.strike,expiry:contract.expiry},underlyingCandleTime:underlyingHistory.candles.at(-1)?.time||null,source:'FYERS_VERIFIED_DATA'};
        });
      } finally {
        releaseSetupEvaluationSymbols(flightKey);
      }
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
      if (!(await waitForCurrentFnoMaster({ loadPromise:fnoUniverseLoadPromise, isCurrent:isFnoMasterCurrent }))) return send(res,503,{status:'AUTO_OPTION_UNAVAILABLE',reason:'Current IST session official FYERS NSE F&O master is not verified'});
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
      if (!(await waitForCurrentFnoMaster({ loadPromise:fnoUniverseLoadPromise, isCurrent:isFnoMasterCurrent }))) return send(res,503,{status:'CONTRACT_NOT_VERIFIED',reason:'Current IST session official FYERS NSE F&O master is not verified'});
      const body = await readJson(req);
      if (body.symbol === null) {
        setSelectedOptionSymbol(null);
        return send(res,200,{status:'OPTION_SUBSCRIPTION_CLEARED'});
      }
      const contract = getVerifiedOptionContract(body.symbol);
      const market = getMarketData();
      const identity = verifyOptionContractUnderlying(contract, market.selectedUnderlyingSymbol);
      if (identity.status !== 'CONTRACT_IDENTITY_VERIFIED') {
        // Log only public instrument identifiers; never log FYERS credentials or tokens.
        console.warn('[FYERS_OPTION] contract identity rejected:',JSON.stringify({
          requestedContract:String(body.symbol||'').slice(0,80),
          officialContract:String(contract.symbol||'').slice(0,80),
          officialUnderlying:String(contract.underlying||'').slice(0,40),
          selectedUnderlying:String(market.selectedUnderlyingSymbol||'').slice(0,40),
          verification:identity.status
        }));
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
