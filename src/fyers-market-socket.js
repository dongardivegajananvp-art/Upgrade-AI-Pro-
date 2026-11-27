import { createRequire } from 'node:module';
import { buildFnoCandleObservationSymbols } from './socket-subscription-utils.js';
import { getAccessTokenForServer } from './fyers-auth.js';
import { buildRollingFnoLeaderboard, buildFnoRotationSlice, FNO_SCAN_PER_SLICE, FNO_SOCKET_ROTATION_ADVANCE, getFnoScanBatchSize, getNextFnoRotationIndex } from './rolling-fno-scanner.js';
import { getSocketSubscriptionDelta, splitSubscriptionBatches, buildSessionSocketSubscriptions, buildSocketSubscriptionDiagnostics, pruneSymbolMap, buildSetupEvaluationSubscriptionSymbols, isGenericSubscriptionAck, prioritizeSubscriptionQueue, resolveSelectedOptionOnUnderlyingChange, connectWithAutoReconnect, formatSocketCloseDetail, SOCKET_SUBSCRIPTION_BATCH_SIZE, SOCKET_SUBSCRIPTION_BATCH_INTERVAL_MS, shouldAdvanceFnoRotation, canResumeSocketSubscriptionRecovery } from './socket-subscription-utils.js';
import { getSocketRateLimitBackoffMs, canCompleteSocketRateLimitRecovery } from './rest-scheduler-utils.js';
import { createFnoWebsocketCandleBuilder } from './fno-websocket-candles.js';
import { isNseRegularSession } from './nse-session.js';
import { shouldActivateFnoSliceOnFeedRecovery } from './fno-feed-readiness.js';
export { getSocketSubscriptionDelta } from './socket-subscription-utils.js';

const require = createRequire(import.meta.url);
const FyersDataSocket = require('fyers-api-v3').fyersDataSocket;
const INDEX_SYMBOLS = ['NSE:NIFTY50-INDEX', 'NSE:NIFTYBANK-INDEX', 'NSE:FINNIFTY-INDEX'];
// Keep a wide safety margin under FYERS Standard's account-wide 100-symbol cap.
// Three indices + twenty rotating F&O symbols + five pinned gainers + selected
// underlying/option stay comfortably below the Standard 100-symbol ceiling.
const MAX_UNDERLYING_SLOTS = 20;
// The shared REST governor permits three background history requests per minute.
// History-backed strategy checks remain at that provider-safe cadence while the
// 20-symbol live socket window rotates to the next slice each minute.
const SCAN_PER_SLICE = FNO_SCAN_PER_SLICE;
const ROTATION_INTERVAL_MS = 60_000;
let socket = null;
let socketStatus = 'NOT_STARTED';
let lastError = null;
let universe = [];
let activeFnoSymbols = [];
let pinnedTopGainerSymbols = [];
let rotationIndex = 0;
let rotationTimer = null;
let selectedOptionSymbol = null;
let activeTradeOptionSymbols = [];
const setupEvaluationPins = new Map();
let optionSubscriptionStatus = 'NOT_SELECTED';
let optionSubscriptionError = null;
let optionSubscriptionRequestedAt = null;
let optionLastTickAt = null;
let selectedUnderlyingSymbol = null;
let selectedLiveCandle = null;
let lastCumulativeVolume = null;
const ticks = new Map();
const indexLiveCandles = new Map();
const indexLastCumulativeVolume = new Map();
const fnoWebsocketCandles = createFnoWebsocketCandleBuilder({maxSymbols:300,maxCandlesPerSymbol:120});
// Bounded, rate-limited observability: first tick per symbol, then at most once/minute.
const tickTelemetryLoggedAt = new Map();
let optionFirstTickLoggedFor = null;
let socketHasConnected = false;
// Local record of symbols sent to the SDK. FYERS emits a generic subscribe ACK,
// not a symbol-specific confirmation; this set must never be presented as
// exchange-confirmed subscription state.
const socketSdkRequestedSymbols = new Set();
let subscriptionOperationSequence = 0;
const SUBSCRIPTION_BATCH_SIZE = SOCKET_SUBSCRIPTION_BATCH_SIZE;
const SUBSCRIPTION_BATCH_INTERVAL_MS = SOCKET_SUBSCRIPTION_BATCH_INTERVAL_MS;
let lastSentSubscriptionBatch = [];
let pendingSubscriptionSymbols = [];
const pendingSubscriptionSet = new Set();
let subscriptionFlushTimer = null;
let socketRateLimitAttempt = 0;
let socketRateLimitUntil = 0;
let socketRateLimitRecoveryTimer = null;
let socketTransportConnected = false;
let resetRateLimitAfterSubscriptionFlush = false;
let socketConnectedAt = null;
let socketLastConnectedAt = null;
let socketLastClosedAt = null;
let socketLastCloseDetail = null;
let socketLastMessageAt = null;
let socketLastTickAt = null;
let socketLastTickExchangeTime = null;
let socketLastErrorAt = null;
let socketReconnectCount = 0;
let socketCloseCount = 0;
let socketErrorCount = 0;

function sessionFeedReady(now = Date.now()) {
  return isNseRegularSession(now) && INDEX_SYMBOLS.some(symbol => isFresh(ticks.get(symbol), now));
}

function desiredSocketSubscriptions(now = Date.now()) {
  const sessionOpen=isNseRegularSession(now);
  const setupSymbols=buildSetupEvaluationSubscriptionSymbols(setupEvaluationPins);
  return [...new Set([...buildSessionSocketSubscriptions(INDEX_SYMBOLS, [...activeFnoSymbols, ...pinnedTopGainerSymbols, selectedUnderlyingSymbol, ...setupSymbols], selectedOptionSymbol, sessionOpen), ...(sessionOpen ? activeTradeOptionSymbols : [])])];
}
function pruneSocketSymbolState() {
  const allowed = [...INDEX_SYMBOLS, ...universe.map(item => item.symbol), selectedOptionSymbol, ...activeTradeOptionSymbols, ...buildSetupEvaluationSubscriptionSymbols(setupEvaluationPins)].filter(Boolean);
  pruneSymbolMap(ticks, allowed, 300);
  pruneSymbolMap(tickTelemetryLoggedAt, allowed, 300);
}

function scheduleSubscriptionFlush(delay = 0) {
  if (subscriptionFlushTimer || !pendingSubscriptionSymbols.length) return;
  subscriptionFlushTimer = setTimeout(() => {
    subscriptionFlushTimer = null;
    if (!socket || socketStatus !== 'CONNECTED' || !socketTransportConnected) return;
    const batch = splitSubscriptionBatches(pendingSubscriptionSymbols, SUBSCRIPTION_BATCH_SIZE)[0] || [];
    pendingSubscriptionSymbols.splice(0, batch.length);
    for (const symbol of batch) pendingSubscriptionSet.delete(symbol);
    try {
      console.info('[FYERS_DATA] paced subscribe batch:', JSON.stringify({
        count: batch.length, remaining: pendingSubscriptionSymbols.length,
        batchSize: SUBSCRIPTION_BATCH_SIZE, intervalMs: SUBSCRIPTION_BATCH_INTERVAL_MS
      }));
      lastSentSubscriptionBatch = [...batch];
      socket.subscribe(batch);
      for (const symbol of batch) socketSdkRequestedSymbols.add(symbol);
    } catch (error) {
      lastSentSubscriptionBatch = [];
      pendingSubscriptionSymbols = [...batch, ...pendingSubscriptionSymbols];
      for (const symbol of batch) pendingSubscriptionSet.add(symbol);
      lastError = safeError(error);
      socketStatus = 'SUBSCRIPTION_UPDATE_ERROR';
      console.error('[FYERS_DATA] paced subscription batch failed:', lastError);
      return;
    }
    if (pendingSubscriptionSymbols.length) {
      scheduleSubscriptionFlush(SUBSCRIPTION_BATCH_INTERVAL_MS);
    } else if (canCompleteSocketRateLimitRecovery({
      recoveryPending: resetRateLimitAfterSubscriptionFlush,
      pendingCount: pendingSubscriptionSymbols.length,
      socketConnected: socketTransportConnected && socketStatus === 'CONNECTED',
      now: Date.now(),
      cooldownUntil: socketRateLimitUntil
    })) {
      resetRateLimitAfterSubscriptionFlush = false;
      socketRateLimitUntil = 0;
      socketRateLimitAttempt = 0;
      console.info('[FYERS_DATA] rate-limit backoff cleared after all paced subscription batches were accepted');
    }
  }, delay);
  subscriptionFlushTimer.unref?.();
}

function syncSocketSubscriptions(desiredSymbols, reason = 'unspecified') {
  const desired = [...new Set(desiredSymbols)];
  const known = [...socketSdkRequestedSymbols, ...pendingSubscriptionSet];
  const { removed, added } = getSocketSubscriptionDelta(known, desired);
  const operationId = ++subscriptionOperationSequence;
  console.info('[FYERS_DATA] subscription delta:', JSON.stringify({
    operationId, reason, at: new Date().toISOString(),
    currentCount: socketSdkRequestedSymbols.size, queuedCount: pendingSubscriptionSet.size,
    desiredCount: desired.length, addedCount: added.length, removedCount: removed.length
  }));
  if (removed.length) {
    const removedSet = new Set(removed);
    pendingSubscriptionSymbols = pendingSubscriptionSymbols.filter(symbol => !removedSet.has(symbol));
    for (const symbol of removed) pendingSubscriptionSet.delete(symbol);
    const activeRemoved = removed.filter(symbol => socketSdkRequestedSymbols.has(symbol));
    if (activeRemoved.length) {
      if (typeof socket.unsubscribe !== 'function') throw new Error('FYERS SDK unsubscribe is unavailable; subscription update stopped to protect the 100-symbol cap');
      console.info('[FYERS_DATA] unsubscribe request:', JSON.stringify({ operationId, count: activeRemoved.length }));
      socket.unsubscribe(activeRemoved);
      for (const symbol of activeRemoved) socketSdkRequestedSymbols.delete(symbol);
    }
  }
  if (added.length) {
    for (const symbol of added) {
      pendingSubscriptionSymbols.push(symbol);
      pendingSubscriptionSet.add(symbol);
    }
  }
  if (selectedOptionSymbol && pendingSubscriptionSet.has(selectedOptionSymbol)) {
    const before = pendingSubscriptionSymbols.indexOf(selectedOptionSymbol);
    pendingSubscriptionSymbols = prioritizeSubscriptionQueue(pendingSubscriptionSymbols, selectedOptionSymbol);
    if (before > 0) {
      console.info('[FYERS_DATA] selected option subscription prioritized:', JSON.stringify({
        symbol: selectedOptionSymbol, previousQueuePosition: before + 1, nextQueuePosition: 1,
        pendingCount: pendingSubscriptionSymbols.length
      }));
    }
  }
  // Resume any batches paused by a disconnect, even when the desired set did not change.
  scheduleSubscriptionFlush();
}


function scheduleSocketRateLimitRecovery(delayMs = 0) {
  if (socketRateLimitRecoveryTimer) clearTimeout(socketRateLimitRecoveryTimer);
  socketStatus = 'RATE_LIMITED_WAIT';
  const waitMs = Math.max(0, Number(delayMs) || 0);
  socketRateLimitRecoveryTimer = setTimeout(() => {
    socketRateLimitRecoveryTimer = null;
    const now = Date.now();
    if (now < socketRateLimitUntil) {
      scheduleSocketRateLimitRecovery(socketRateLimitUntil - now);
      return;
    }
    if (!canResumeSocketSubscriptionRecovery({
      transportConnected: socketTransportConnected,
      socketStatus,
      now,
      cooldownUntil: socketRateLimitUntil
    })) {
      console.warn('[FYERS_DATA] rate-limit recovery deferred until socket transport reconnects:', JSON.stringify({
        transportConnected: socketTransportConnected,
        socketStatus,
        pendingCount: pendingSubscriptionSymbols.length
      }));
      return;
    }
    try {
      const currentSubscriptions = desiredSocketSubscriptions();
      if (currentSubscriptions.length > 100) throw new Error('Subscription count exceeded the Standard plan 100-symbol limit');
      socketStatus = 'CONNECTED';
      resetRateLimitAfterSubscriptionFlush = true;
      if (!pendingSubscriptionSymbols.length) {
        resetRateLimitAfterSubscriptionFlush = false;
        socketRateLimitUntil = 0;
        socketRateLimitAttempt = 0;
        console.info('[FYERS_DATA] rate-limit backoff elapsed; no rejected subscription batch remained');
        return;
      }
      syncSocketSubscriptions(currentSubscriptions, 'rate-limit-backoff-recovery');
      socketHasConnected = true;
      console.info('[FYERS_DATA] rate-limit backoff elapsed; paced subscription reconciliation resumed:', JSON.stringify({
        pendingCount: pendingSubscriptionSymbols.length,
        transportConnected: socketTransportConnected
      }));
    } catch (error) {
      lastError = safeError(error);
      socketStatus = 'SUBSCRIPTION_UPDATE_ERROR';
      console.error('[FYERS_DATA] rate-limit recovery reconciliation failed:', lastError);
    }
  }, waitMs);
  socketRateLimitRecoveryTimer.unref?.();
}

function safeError(error) {
  if (error instanceof Error) return error.message.slice(0, 240);
  if (typeof error === 'string') return error.slice(0, 240);
  try { return JSON.stringify(error).slice(0, 240); } catch { return String(error).slice(0, 240); }
}
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
function isFresh(tick, now = Date.now()) {
  if (!tick || !Number.isFinite(Number(tick.exchangeTime)) || !Number.isFinite(Number(tick.receivedAt))) return false;
  const receiptAge = now - Number(tick.receivedAt);
  const exchangeAge = now / 1000 - Number(tick.exchangeTime);
  const exchangeReceiptDelayMs = Number(tick.receivedAt) - Number(tick.exchangeTime) * 1000;
  return receiptAge >= 0 && receiptAge <= 10_000 && exchangeAge >= -3 && exchangeReceiptDelayMs >= 0 && exchangeReceiptDelayMs <= 5_000;
}
function acceptedSymbols() {
  return new Set(desiredSocketSubscriptions());
}
function accept(item) {
  if (Array.isArray(item)) { for (const child of item) accept(child); return; }
  if (!item || typeof item !== 'object') return;
  socketLastMessageAt = Date.now();
  const symbol = String(item.symbol || item.n || '');
  if (!acceptedSymbols().has(symbol)) return;
  const price = Number(item.ltp ?? item.lp);
  const exchangeTime = asEpochSeconds(item.exch_feed_time ?? item.last_traded_time ?? item.timestamp ?? item.tt);
  if (!Number.isFinite(price) || price <= 0 || !exchangeTime) return;
  const previousClose = Number(item.prev_close_price ?? item.prev_close ?? item.pc);
  const fallbackChange = Number.isFinite(previousClose) && previousClose > 0 ? price - previousClose : null;
  const fallbackPercent = Number.isFinite(previousClose) && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null;
  const reportedChange = item.ch ?? item.change;
  const reportedPercent = item.chp ?? item.changePercent;
  const change = reportedChange !== undefined && reportedChange !== null && Number.isFinite(Number(reportedChange)) ? Number(reportedChange) : fallbackChange;
  const changePercent = reportedPercent !== undefined && reportedPercent !== null && Number.isFinite(Number(reportedPercent)) ? Number(reportedPercent) : fallbackPercent;
  const cumulativeVolume = Number(item.v ?? item.volume ?? item.vol_traded_today);
  const receivedAt = Date.now();
  const exchangeReceiptDelayMs = receivedAt - exchangeTime * 1000;
  const tick = { symbol, price, exchangeTime, receivedAt, exchangeReceiptDelayMs, change, changePercent, type: item.type || null, cumulativeVolume: Number.isFinite(cumulativeVolume) && cumulativeVolume >= 0 ? cumulativeVolume : null };
  const sessionWasReady = sessionFeedReady(tick.receivedAt);
  ticks.set(symbol, tick);
  if (INDEX_SYMBOLS.includes(symbol)) {
    const bucket = Math.floor(exchangeTime / 300) * 300;
    const local = new Date((bucket + 19800) * 1000);
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (minute >= 555 && minute < 930) {
      let candle = indexLiveCandles.get(symbol);
      if (!candle || candle.time !== bucket) {
        candle = { time: bucket, open: price, high: price, low: price, close: price, volume: 0, completed: false, source: 'FYERS_LIVE_TICKS' };
        indexLiveCandles.set(symbol, candle);
      } else {
        candle.high = Math.max(candle.high, price);
        candle.low = Math.min(candle.low, price);
        candle.close = price;
      }
      if (tick.cumulativeVolume !== null) {
        const previousVolume = indexLastCumulativeVolume.get(symbol);
        if (previousVolume !== undefined && tick.cumulativeVolume >= previousVolume) candle.volume += tick.cumulativeVolume - previousVolume;
        indexLastCumulativeVolume.set(symbol, tick.cumulativeVolume);
      }
    }
  }
  if (universe.some(item => item.symbol === symbol)) fnoWebsocketCandles.ingest(symbol,tick);
  if (shouldActivateFnoSliceOnFeedRecovery(sessionWasReady, sessionFeedReady(tick.receivedAt), universe.length)) {
    console.info('[FYERS_DATA] fresh index feed restored; activating first F&O slice immediately');
    applyFnoRotation(false);
  }
  // Index ticks drive the NSE feed-readiness gate. Log them explicitly so a
  // connected transport with no accepted index data is distinguishable in prod.
  if (INDEX_SYMBOLS.includes(symbol) || universe.some(item => item.symbol === symbol) || symbol === selectedOptionSymbol) {
    const previousLogAt = tickTelemetryLoggedAt.get(symbol) || 0;
    const logIntervalMs = INDEX_SYMBOLS.includes(symbol) ? 15_000 : 60_000;
    if (!previousLogAt || tick.receivedAt - previousLogAt >= logIntervalMs) {
      tickTelemetryLoggedAt.set(symbol, tick.receivedAt);
      console.info('[FYERS_DATA] market tick received:', JSON.stringify({
        symbol, receivedAt: new Date(tick.receivedAt).toISOString(),
        exchangeTime: new Date(tick.exchangeTime * 1000).toISOString(),
        receiveAgeMs: Date.now() - tick.receivedAt, exchangeAgeMs: Math.round((Date.now() / 1000 - tick.exchangeTime) * 1000),
        fresh: isFresh(tick), index: INDEX_SYMBOLS.includes(symbol),
        selectedUnderlying: symbol === selectedUnderlyingSymbol,
        selectedOption: symbol === selectedOptionSymbol
      }));
    }
  }
  socketLastTickAt = tick.receivedAt;
  socketLastTickExchangeTime = tick.exchangeTime;
  if (symbol === selectedOptionSymbol) {
    if (optionFirstTickLoggedFor !== symbol) {
      optionFirstTickLoggedFor = symbol;
      console.info('[FYERS_DATA] selected option first tick verified:', JSON.stringify({
        symbol, receivedAt: new Date(tick.receivedAt).toISOString(),
        exchangeTime: new Date(tick.exchangeTime * 1000).toISOString(), fresh: isFresh(tick)
      }));
    }
    optionSubscriptionStatus = 'TICK_RECEIVED';
    optionSubscriptionError = null;
    optionLastTickAt = tick.receivedAt;
  }
  if (symbol === selectedUnderlyingSymbol) {
    const bucket = Math.floor(exchangeTime / 300) * 300;
    const local = new Date((bucket + 19800) * 1000);
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (minute >= 555 && minute < 930) {
      if (!selectedLiveCandle || selectedLiveCandle.time !== bucket) {
        selectedLiveCandle = { time: bucket, open: price, high: price, low: price, close: price, volume: 0, completed: false, source: 'FYERS_LIVE_TICKS' };
        lastCumulativeVolume = tick.cumulativeVolume;
      } else {
        selectedLiveCandle.high = Math.max(selectedLiveCandle.high, price);
        selectedLiveCandle.low = Math.min(selectedLiveCandle.low, price);
        selectedLiveCandle.close = price;
        if (tick.cumulativeVolume !== null && lastCumulativeVolume !== null && tick.cumulativeVolume >= lastCumulativeVolume) selectedLiveCandle.volume += tick.cumulativeVolume - lastCumulativeVolume;
        lastCumulativeVolume = tick.cumulativeVolume;
      }
    }
  }
}
function nextSlice(startIndex = rotationIndex) {
  return buildFnoRotationSlice(universe,startIndex,MAX_UNDERLYING_SLOTS,selectedUnderlyingSymbol);
}
function applyFnoRotation(advance = false) {
  const ready = isNseRegularSession();
  if (!ready) {
    activeFnoSymbols = [];
    if (socket && socketStatus === 'CONNECTED') {
      try { syncSocketSubscriptions(desiredSocketSubscriptions(), 'nse-session-or-index-feed-not-ready'); }
      catch (error) {
        lastError = safeError(error);
        socketStatus = 'SUBSCRIPTION_UPDATE_ERROR';
        console.error('[FYERS_DATA] off-session subscription cleanup failed:', lastError);
      }
    }
    if (selectedOptionSymbol) optionSubscriptionStatus = 'QUEUED_UNTIL_FRESH_NSE_SESSION';
    return;
  }
  const nextIndex=advance&&universe.length>MAX_UNDERLYING_SLOTS
    ? getNextFnoRotationIndex(universe.length,rotationIndex,FNO_SOCKET_ROTATION_ADVANCE) : rotationIndex;
  const next=nextSlice(nextIndex);
  if (!next.length) {
    activeFnoSymbols = [];
    if (socket && socketStatus === 'CONNECTED') {
      try { syncSocketSubscriptions(desiredSocketSubscriptions(), 'empty-fno-universe'); }
      catch (error) {
        lastError = safeError(error);
        socketStatus = 'SUBSCRIPTION_UPDATE_ERROR';
        console.error('[FYERS_DATA] empty-universe subscription cleanup failed:', lastError);
      }
    }
    return;
  }
  if (socket && socketStatus === 'CONNECTED') {
    try {
      const observed=buildRollingFnoLeaderboard({universe,ticks,now:Date.now(),slotCount:MAX_UNDERLYING_SLOTS,rotationIntervalMs:ROTATION_INTERVAL_MS,limit:5}).observations;
      const nextPinned=observed.map(item=>item.symbol).filter(Boolean).slice(0,5);
      // Pin the five highest recently observed F&O gainers across rotations.
      // This keeps their WebSocket feed alive instead of dropping them when the
      // 20-symbol market-wide slice advances; stale ticks remain non-actionable.
      if(nextPinned.length) pinnedTopGainerSymbols=nextPinned;
      syncSocketSubscriptions(buildSessionSocketSubscriptions(INDEX_SYMBOLS, [...next, ...pinnedTopGainerSymbols, selectedUnderlyingSymbol], selectedOptionSymbol, true), advance ? 'fno-rotation-with-top-gainer-pins' : 'fno-slice-selection-with-top-gainer-pins');
    } catch (error) {
      lastError = safeError(error);
      socketStatus = 'SUBSCRIPTION_UPDATE_ERROR';
      console.error('[FYERS_DATA] F&O rotation update failed:', lastError);
      return;
    }
  }
  activeFnoSymbols = next;
  rotationIndex = nextIndex;
  if (selectedOptionSymbol) {
    optionSubscriptionStatus = 'SUBSCRIPTION_QUEUED';
    optionSubscriptionError = null;
  }
}
export function setFnoUniverse(items) {
  const unique = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !/^NSE:[A-Z0-9&._-]+-EQ$/.test(String(item.symbol || ''))) continue;
    unique.set(item.symbol, item);
  }
  universe = [...unique.values()];
  pruneSocketSymbolState();
  rotationIndex = 0;
  applyFnoRotation();
  if (rotationTimer) clearInterval(rotationTimer);
  if (universe.length) {
    rotationTimer = setInterval(() => {
      if (!sessionFeedReady()) {
        applyFnoRotation(false);
        return;
      }
      // Do not replace a slice while its paced subscription queue is still being
      // delivered or while FYERS 1015 backoff is active. Otherwise each 60s
      // rotation discards queued symbols faster than the socket can subscribe.
      const pendingCount = pendingSubscriptionSet.size;
      if (!shouldAdvanceFnoRotation({ pendingCount, cooldownActive: Date.now() < socketRateLimitUntil })) {
        console.info('[FYERS_DATA] F&O rotation held until subscription queue drains:', JSON.stringify({ pendingCount, rateLimitWaitMs: Math.max(0, socketRateLimitUntil - Date.now()) }));
        return;
      }
      applyFnoRotation(activeFnoSymbols.length > 0 && universe.length > MAX_UNDERLYING_SLOTS);
    }, ROTATION_INTERVAL_MS);
    rotationTimer.unref?.();
  }
  return { universeCount: universe.length, activeCount: activeFnoSymbols.length, scanPerSlice: universe.length > MAX_UNDERLYING_SLOTS ? getFnoScanBatchSize(universe.length,rotationIndex,SCAN_PER_SLICE) : activeFnoSymbols.length, rotationIntervalMs: ROTATION_INTERVAL_MS, symbolCap: 100, reservedHeadroom: 70 };
}
export function setSelectedUnderlyingSymbol(symbol) {
  const next = symbol && /^NSE:[A-Z0-9&._-]+-EQ$/.test(symbol) && universe.some(item => item.symbol === symbol) ? symbol : null;
  if (next === selectedUnderlyingSymbol) return { status: 'UNCHANGED', symbol: next };
  const previousUnderlying = selectedUnderlyingSymbol;
  const previousOption = selectedOptionSymbol;
  selectedOptionSymbol = resolveSelectedOptionOnUnderlyingChange(previousUnderlying, next, selectedOptionSymbol);
  if (previousOption && !selectedOptionSymbol) {
    optionFirstTickLoggedFor = null;
    optionSubscriptionRequestedAt = null;
    optionLastTickAt = null;
    optionSubscriptionError = null;
    optionSubscriptionStatus = 'NOT_SELECTED';
    console.info('[FYERS_DATA] prior option cleared on underlying change:', JSON.stringify({ previousUnderlying, nextUnderlying: next, clearedOption: previousOption }));
  }
  selectedUnderlyingSymbol = next;
  selectedLiveCandle = null;
  lastCumulativeVolume = null;
  applyFnoRotation();
  return { status: next ? 'UNDERLYING_PINNED_TO_SOCKET_SLICE' : 'UNDERLYING_CLEARED', symbol: next };
}
export function pinSetupEvaluationSymbols(key, symbols = []) {
  const id=typeof key==='string'?key.trim():'';
  const next=[...new Set((Array.isArray(symbols)?symbols:[]).filter(symbol=>typeof symbol==='string'&&/^NSE:[A-Z0-9&._-]+$/.test(symbol)))];
  if(!id||next.length!==2) return {status:'REJECTED',reason:'A setup pin requires one verified NSE underlying and one verified NSE option contract'};
  const current=setupEvaluationPins.get(id);
  if(current&&current.symbols.some((symbol,index)=>symbol!==next[index])) return {status:'REJECTED',reason:'Setup pin key is already bound to different symbols'};
  if(!current&&setupEvaluationPins.size>=2) return {status:'REJECTED',reason:'At most two concurrent setup evaluations may pin live feed symbols'};
  setupEvaluationPins.set(id,{symbols:next,refCount:(current?.refCount||0)+1});
  pruneSocketSymbolState();
  try {
    if(socket&&socketStatus==='CONNECTED') syncSocketSubscriptions(desiredSocketSubscriptions(),'setup-evaluation-feed-pins');
  } catch(error) {
    if(current) setupEvaluationPins.set(id,current); else setupEvaluationPins.delete(id);
    pruneSocketSymbolState();
    return {status:'SUBSCRIPTION_UPDATE_ERROR',reason:safeError(error)};
  }
  console.info('[FYERS_DATA] setup evaluation feed symbols pinned:',JSON.stringify({key:id,symbols:next,refCount:setupEvaluationPins.get(id).refCount}));
  return {status:'SETUP_EVALUATION_SYMBOLS_PINNED',symbols:next};
}
export function releaseSetupEvaluationSymbols(key) {
  const id=typeof key==='string'?key.trim():'';
  const current=setupEvaluationPins.get(id);
  if(!current) return {status:'UNCHANGED'};
  if(current.refCount>1) setupEvaluationPins.set(id,{...current,refCount:current.refCount-1});
  else setupEvaluationPins.delete(id);
  pruneSocketSymbolState();
  if(socket&&socketStatus==='CONNECTED') {
    try { syncSocketSubscriptions(desiredSocketSubscriptions(),'setup-evaluation-feed-release'); }
    catch(error) { console.warn('[FYERS_DATA] setup evaluation feed pin release sync failed:',safeError(error)); }
  }
  console.info('[FYERS_DATA] setup evaluation feed symbols released:',JSON.stringify({key:id,remainingRefs:setupEvaluationPins.get(id)?.refCount||0}));
  return {status:'SETUP_EVALUATION_SYMBOLS_RELEASED'};
}
export function setActiveTradeOptionSymbols(symbols = []) {
  if (!Array.isArray(symbols) || symbols.length > 2) return { status:'REJECTED', reason:'At most two active option contracts may be pinned' };
  const next = [...new Set(symbols.filter(symbol => typeof symbol === 'string' && /^NSE:[A-Z0-9&._-]+$/.test(symbol)))];
  if (next.length !== symbols.length) return { status:'REJECTED', reason:'Every active option contract must be a valid NSE symbol' };
  activeTradeOptionSymbols = next;
  pruneSocketSymbolState();
  if (socket && socketStatus === 'CONNECTED') {
    try { syncSocketSubscriptions(desiredSocketSubscriptions(), 'active-trade-option-pins'); }
    catch (error) { lastError = safeError(error); return { status:'SUBSCRIPTION_UPDATE_ERROR', reason:lastError }; }
  }
  console.info('[FYERS_DATA] active trade option pins:', JSON.stringify({count:next.length,symbols:next}));
  return { status:'ACTIVE_TRADE_OPTIONS_PINNED', symbols:[...next] };
}
export function setSelectedOptionSymbol(symbol) {
  const next = symbol && /^NSE:[A-Z0-9&._-]+$/.test(symbol) ? symbol : null;
  if (next === selectedOptionSymbol) {
    return { status: optionSubscriptionStatus, symbol: next, reason: optionSubscriptionError };
  }
  selectedOptionSymbol = next;
  pruneSocketSymbolState();
  optionFirstTickLoggedFor = null;
  if (socket && socketStatus === 'CONNECTED') {
    try {
      syncSocketSubscriptions(desiredSocketSubscriptions(), 'selected-option-change');
    } catch (error) {
      lastError = safeError(error);
      optionSubscriptionStatus = 'SUBSCRIPTION_FAILED';
      optionSubscriptionError = lastError;
      socketStatus = 'SUBSCRIPTION_UPDATE_ERROR';
      console.error('[FYERS_DATA] option subscription update failed:', lastError);
      return { status: optionSubscriptionStatus, symbol: selectedOptionSymbol, reason: lastError };
    }
  }
  optionSubscriptionRequestedAt = next ? Date.now() : null;
  optionLastTickAt = null;
  optionSubscriptionError = null;
  optionSubscriptionStatus = !next ? 'NOT_SELECTED' : !isNseRegularSession() ? 'QUEUED_UNTIL_FRESH_NSE_SESSION' : socketStatus === 'CONNECTED' ? 'SUBSCRIPTION_QUEUED' : 'QUEUED_UNTIL_SOCKET_CONNECT';
  console.info('[FYERS_DATA] option subscription state:', optionSubscriptionStatus, next || 'cleared');
  return { status: optionSubscriptionStatus, symbol: next };
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
      if (socketHasConnected) socketReconnectCount++;
      socketConnectedAt = Date.now();
      socketLastConnectedAt = new Date(socketConnectedAt).toISOString();
      socketTransportConnected = true;
      const subscriptions = desiredSocketSubscriptions();
      const waitMs = Math.max(0, socketRateLimitUntil - Date.now());
      if (waitMs > 0) {
        scheduleSocketRateLimitRecovery(waitMs);
        console.warn('[FYERS_DATA] socket connected during rate-limit backoff; subscription reconciliation deferred:', waitMs);
        return;
      }
      socketStatus = 'CONNECTED';
      if (subscriptions.length > 100) {
        socketStatus = 'SUBSCRIPTION_LIMIT_BLOCKED';
        lastError = 'Subscription count exceeded the Standard plan 100-symbol limit';
        return;
      }
      const isFirstConnection = !socketHasConnected;
      try {
        // The FYERS SDK is expected to restore its prior subscriptions on auto-reconnect.
        // This local set records SDK requests, not exchange-confirmed symbols. Reconcile
        // only symbols changed while disconnected; freshness remains the proof of feed.
        syncSocketSubscriptions(subscriptions, isFirstConnection ? 'initial-connect' : 'auto-reconnect-reconcile');
        socketHasConnected = true;
      } catch (error) {
        lastError = safeError(error);
        socketStatus = 'SUBSCRIPTION_UPDATE_ERROR';
        console.error('[FYERS_DATA] subscription reconciliation failed:', lastError);
        return;
      }
      if (selectedOptionSymbol) {
        optionSubscriptionStatus = 'SUBSCRIPTION_QUEUED';
        optionSubscriptionError = null;
      }
      console.info('[FYERS_DATA] connected; subscription reconciliation queued:', subscriptions.length, 'symbols; initial connection:', isFirstConnection);
    });
    socket.on('message', message => {
      const decoded = decode(message);
      const acknowledge = item => {
        if (Array.isArray(item)) { for (const child of item) acknowledge(child); return; }
        if (isGenericSubscriptionAck(item)) {
          // This ACK has no symbol identity. Never attribute it to the most
          // recent local batch; delayed ACKs can arrive after another batch was sent.
          console.info('[FYERS_DATA] generic subscription ACK received:', JSON.stringify({
            symbolLevelConfirmation: false,
            at: new Date().toISOString()
          }));
          return;
        }
        accept(item);
      };
      acknowledge(decoded);
    });
    socket.on('error', error => {
      socketErrorCount++;
      socketLastErrorAt = new Date().toISOString();
      lastError = safeError(error || 'FYERS data socket error');
      socketStatus = /1015|too many requests|rate.?limit/i.test(lastError) ? 'RATE_LIMITED' : 'ERROR';
      if (socketStatus === 'RATE_LIMITED') {
        // FYERS 1015 is emitted for a subscription request; the existing tick
        // stream can remain connected. Do not wait for a reconnect that may never
        // occur: arm a bounded retry timer on this live transport as well.
        socketRateLimitAttempt += 1;
        const backoffMs = getSocketRateLimitBackoffMs(socketRateLimitAttempt);
        socketRateLimitUntil = Date.now() + backoffMs;
        const rejectedBatch = [...lastSentSubscriptionBatch];
        lastSentSubscriptionBatch = [];
        for (const symbol of rejectedBatch) socketSdkRequestedSymbols.delete(symbol);
        const retryBatch = rejectedBatch.filter(symbol => !pendingSubscriptionSet.has(symbol));
        pendingSubscriptionSymbols = [...retryBatch, ...pendingSubscriptionSymbols];
        for (const symbol of retryBatch) pendingSubscriptionSet.add(symbol);
        resetRateLimitAfterSubscriptionFlush = true;
        scheduleSocketRateLimitRecovery(backoffMs);
        console.warn('[FYERS_DATA] rate-limit backoff armed:', JSON.stringify({
          attempt: socketRateLimitAttempt, backoffMs,
          retryAt: new Date(socketRateLimitUntil).toISOString(),
          transportConnected: socketTransportConnected,
          pendingCount: pendingSubscriptionSymbols.length
        }));
      }
      console.error('[FYERS_DATA] socket error:', lastError);
    });
    socket.on('close', (...details) => {
      socketCloseCount++;
      socketLastClosedAt = new Date().toISOString();
      socketLastCloseDetail = formatSocketCloseDetail(details);
      socketConnectedAt = null;
      socketTransportConnected = false;
      socketStatus = 'DISCONNECTED';
      // FYERS Data Socket auto-reconnect is expected to restore prior SDK requests.
      // Keep the SDK-requested set to avoid duplicate sends; it is not an exchange ACK.
      // Per-symbol fresh ticks, not this set, prove that the feed has resumed.
      console.warn('[FYERS_DATA] socket closed:', JSON.stringify({
        at:socketLastClosedAt, detail:socketLastCloseDetail,
        reconnectCount:socketReconnectCount, closeCount:socketCloseCount,
        errorCount:socketErrorCount
      }));
    });
    // Configure the SDK's reconnect handler before opening the transport.
    connectWithAutoReconnect(socket, 10);
    return { status: socketStatus };
  } catch (error) {
    socketStatus = 'ERROR';
    lastError = safeError(error);
    console.error('[FYERS_DATA] socket start failed:', lastError);
    return { status: socketStatus, reason: lastError };
  }
}
export function getMarketTick(symbol, now = Date.now()) {
  const tick=typeof symbol==='string'?ticks.get(symbol)||null:null;
  return tick?{...tick,fresh:isFresh(tick,now)}:null;
}
export function getMarketData(now = Date.now()) {
  const indices = {};
  for (const symbol of INDEX_SYMBOLS) {
    const tick = ticks.get(symbol) || null;
    indices[symbol] = tick ? { ...tick, fresh: isFresh(tick, now), liveCandle: isFresh(tick, now) && indexLiveCandles.has(symbol) ? { ...indexLiveCandles.get(symbol) } : null } : null;
  }
  const rolling = buildRollingFnoLeaderboard({ universe, ticks, now, slotCount: MAX_UNDERLYING_SLOTS, rotationIntervalMs: ROTATION_INTERVAL_MS });
  const topGainers = rolling.topGainers;
  const optionTick = selectedOptionSymbol ? ticks.get(selectedOptionSymbol) || null : null;
  const activeFnoTicks = activeFnoSymbols.map(symbol => ({ symbol, tick: ticks.get(symbol) || null }));
  const activeCandleSnapshots=activeFnoSymbols.map(symbol=>fnoWebsocketCandles.snapshot(symbol));
  const websocketCandleCoverage={activeSymbols:activeFnoSymbols.length,withObservations:activeCandleSnapshots.filter(item=>item.completedCandles.length||item.liveCandle).length,withCompletedBars:activeCandleSnapshots.filter(item=>item.completedCandles.length>0).length,contiguousBars:activeCandleSnapshots.reduce((sum,item)=>sum+item.contiguousCompletedCount,0),actionable:false,volumeVerified:false};
  const fnoTickCoverage = {
    activeSymbols: activeFnoSymbols.length,
    pinnedTopGainerSymbols:[...pinnedTopGainerSymbols],
    pinnedTopGainerCoverage:pinnedTopGainerSymbols.map(symbol=>{
      const tick=ticks.get(symbol)||null;
      return {symbol,status:!tick?'NO_TICK':isFresh(tick,now)?'FRESH':'STALE',
        receiveAgeSeconds:tick?Math.max(0,Math.floor((now-tick.receivedAt)/1000)):null,
        exchangeAgeSeconds:tick?Math.max(0,Math.floor(now/1000-tick.exchangeTime)):null};
    }),
    withTick: activeFnoTicks.filter(item => item.tick).length,
    fresh: activeFnoTicks.filter(item => isFresh(item.tick, now)).length,
    stale: activeFnoTicks.filter(item => item.tick && !isFresh(item.tick, now)).length,
    noTick: activeFnoTicks.filter(item => !item.tick).length,
    symbols: activeFnoTicks.map(({ symbol, tick }) => ({
      symbol, status: !tick ? 'NO_TICK' : isFresh(tick, now) ? 'FRESH' : 'STALE',
      receivedAt: tick ? new Date(tick.receivedAt).toISOString() : null,
      exchangeTime: tick ? new Date(tick.exchangeTime * 1000).toISOString() : null,
      receiveAgeSeconds: tick ? Math.max(0, Math.floor((now - tick.receivedAt) / 1000)) : null,
      exchangeAgeSeconds: tick ? Math.max(0, Math.floor(now / 1000 - tick.exchangeTime)) : null
    }))
  };
  return {
    socketStatus, lastError, fnoTickCoverage,
    subscriptionDiagnostics: buildSocketSubscriptionDiagnostics({ desired:desiredSocketSubscriptions(), sentToSdk:[...socketSdkRequestedSymbols], pending:pendingSubscriptionSymbols }),
    socketRateLimit: { attempt: socketRateLimitAttempt, retryAt: socketRateLimitUntil > now ? new Date(socketRateLimitUntil).toISOString() : null, backoffActive: now < socketRateLimitUntil },
    socketDiagnostics: {
      connectedAt: socketConnectedAt ? new Date(socketConnectedAt).toISOString() : null,
      lastConnectedAt: socketLastConnectedAt, lastClosedAt: socketLastClosedAt, lastCloseDetail:socketLastCloseDetail,
      lastMessageAt: socketLastMessageAt, lastTickAt: socketLastTickAt,
      lastTickExchangeTime: socketLastTickExchangeTime,
      lastTickAgeSeconds: socketLastTickAt ? Math.max(0, Math.floor((now - socketLastTickAt) / 1000)) : null,
      lastTickExchangeAgeSeconds: socketLastTickExchangeTime ? Math.max(0, Math.floor(now / 1000 - socketLastTickExchangeTime)) : null,
      lastErrorAt: socketLastErrorAt, reconnectCount: socketReconnectCount,
      closeCount: socketCloseCount, errorCount: socketErrorCount
    },
    selectedUnderlyingSymbol, selectedOption: optionTick ? { ...optionTick, fresh: isFresh(optionTick, now) } : null,
    activeOptionTicks: activeTradeOptionSymbols.map(symbol => { const tick=ticks.get(symbol)||null; return {symbol,tick:tick?{...tick,fresh:isFresh(tick,now)}:null}; }),
    optionSubscription: {
      status: optionSubscriptionStatus,
      symbol: selectedOptionSymbol,
      reason: optionSubscriptionError,
      requestedAt: optionSubscriptionRequestedAt,
      lastTickAt: optionLastTickAt,
      tickAgeSeconds: optionLastTickAt ? Math.max(0, Math.floor((now - optionLastTickAt) / 1000)) : null
    },
    selectedUnderlying: selectedUnderlyingSymbol && ticks.get(selectedUnderlyingSymbol) ? { ...ticks.get(selectedUnderlyingSymbol), fresh: isFresh(ticks.get(selectedUnderlyingSymbol), now), liveCandle: selectedLiveCandle ? { ...selectedLiveCandle } : null } : null,
    selectedOptionSymbol,
    subscriptionCount: desiredSocketSubscriptions(now).length,
    symbolLimit: 100, indices,
    fno: {
      status: !universe.length ? 'SYMBOL_MASTER_NOT_LOADED' : ['ERROR','RATE_LIMITED','RATE_LIMITED_WAIT','SUBSCRIPTION_UPDATE_ERROR','SUBSCRIPTION_LIMIT_BLOCKED','DISCONNECTED'].includes(socketStatus) ? 'SOCKET_ERROR' : topGainers.length ? 'ROTATING_LIVE_COVERAGE' : 'WAITING_FOR_FNO_TICKS',
      lastError, universeCount: universe.length, activeCount: activeFnoSymbols.length,
      observedCount: rolling.observedCount, freshCount: rolling.freshCount, coverageComplete: rolling.coverageComplete,
      websocketCandleCoverage,
      rankingMode: 'ROLLING_SESSION_OBSERVATIONS_NOT_SIMULTANEOUS', maxObservationAgeSeconds: rolling.maxObservationAgeSeconds,
      rotationIntervalMs: ROTATION_INTERVAL_MS, scanPerSlice: universe.length > MAX_UNDERLYING_SLOTS ? getFnoScanBatchSize(universe.length,rotationIndex,SCAN_PER_SLICE) : activeFnoSymbols.length, currentSliceStart: universe.length ? rotationIndex : 0,
      subscriptionCount: desiredSocketSubscriptions(now).length,
      topGainers: topGainers.map(tick => ({ symbol: tick.symbol, price: tick.price, change: tick.change, changePercent: tick.changePercent, exchangeTime: tick.exchangeTime, receivedAt: tick.receivedAt, fresh: tick.fresh, ageSeconds: tick.ageSeconds, actionable: false }))
    }
  };
}

// Read-only snapshot for the rolling strategy engine; never treats old ticks as fresh.
export function getFnoUniverseSnapshot() {
  return {
    universe: universe.map(item => ({ ...item })),
    ticks: new Map(universe.map(item => [item.symbol, ticks.get(item.symbol)]).filter(([, tick]) => Boolean(tick))),
    websocketCandles: new Map(buildFnoCandleObservationSymbols(activeFnoSymbols,pinnedTopGainerSymbols,selectedUnderlyingSymbol).map(symbol=>[symbol,fnoWebsocketCandles.snapshot(symbol)])),
    activeSymbols: [...activeFnoSymbols],
    rotationIndex,
    rotationIntervalMs: ROTATION_INTERVAL_MS,
    scanPerSlice: universe.length > MAX_UNDERLYING_SLOTS ? getFnoScanBatchSize(universe.length,rotationIndex,SCAN_PER_SLICE) : activeFnoSymbols.length,
    symbolCap: 100
  };
}
