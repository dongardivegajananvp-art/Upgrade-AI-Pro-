import test from 'node:test';
import assert from 'node:assert/strict';
import { REST_PRIORITY, REST_RECOVERY_REQUIRED_ON_START, canRunRestRecoveryProbe, sortRestQueue, getHistoryRequestWindowWaitMs, getRestRequestWindowWaitMs, getRestAccountWindowWaitMs, findFairRestQueueIndex, getRestQueueMaxAgeMs, getRestTotalWindowLimit, isRestQueueExpired, buildRestEndpointHealth, parseRetryAfterMs, getRateLimitCooldownUntil, getRecoveryProbeRetryDelayMs, getSocketRateLimitBackoffMs, canCompleteSocketRateLimitRecovery } from './rest-scheduler-utils.js';
import { validateNseSymbol, validateHistorySymbol, normalizeFiveMinuteCandles, normalizeFifteenMinuteCandles, normalizeDailyCandles, buildFyersUrl, getFiveMinuteCacheValidUntil, getFifteenMinuteCacheValidUntil, getIntradayHistoryRange, getFiveMinuteHistoryRange, getFifteenMinuteHistoryRange, getRestDiagnostics, getRestSafetyState, restoreRestSafetyState } from './fyers-rest.js';

test('FYERS REST accepts only a single NSE symbol', () => {
  assert.equal(validateNseSymbol('NSE:SBIN-EQ'), true);
  assert.equal(validateNseSymbol('NSE:NIFTY50-INDEX'), true);
  assert.equal(validateNseSymbol('BSE:SENSEX-INDEX'), false);
  assert.equal(validateHistorySymbol('BSE:SENSEX-INDEX'), false);
  assert.equal(validateHistorySymbol('NSE:NIFTY50-INDEX'), true);
  assert.equal(validateHistorySymbol('NSE:FINNIFTY-INDEX'), true);
  assert.equal(validateHistorySymbol('BSE:INVALID-EQ'), false);
  assert.equal(validateNseSymbol('NSE:SBIN-EQ,NSE:TCS-EQ'), false);
  assert.equal(validateNseSymbol('../orders'), false);
});

test('history normalization returns only valid completed NSE-session candles', () => {
  const first = Date.UTC(2027, 0, 4, 3, 45) / 1000;
  const now = (first + 600) * 1000 + 1000;
  const rows = [
    [first, 100, 102, 99, 101, 1000],
    [first + 60, 100, 102, 99, 101, 1000], // misaligned 09:16 candle must be rejected
    [first + 300, 101, 103, 100, 102, 1200],
    [first + 600, 102, 104, 101, 103, 1400],
    [first + 900, 103, 104, 102, 103, 1500],
    [first + 300, 101, 103, 100, 102, 1200],
    [first + 1200, 103, 104, 102, 103, 1500],
    [first + 1500, 100, 99, 101, 100, 10]
  ];
  const candles = normalizeFiveMinuteCandles(rows, now);
  assert.deepEqual(candles.map(c => c.time), [first, first + 300]);
  assert.ok(candles.every(c => c.completed && c.source === 'FYERS_HISTORY'));
});

test('intraday history requests use epoch range ending before the current incomplete candle', () => {
  const now=Date.UTC(2026,10,27,4,18,20); // 09:48:20 IST
  const five=getFiveMinuteHistoryRange(now,20);
  const fifteen=getFifteenMinuteHistoryRange(now,45);
  assert.equal(five.dateFormat,'0');
  assert.equal(five.intervalSeconds,300);
  assert.equal(five.to,Math.floor(now/300000)*300-1);
  assert.equal(fifteen.dateFormat,'0');
  assert.equal(fifteen.intervalSeconds,900);
  assert.equal(fifteen.to,Math.floor(now/900000)*900-1);
  assert.equal(five.from,Math.floor((now+19800000)/86400000)*86400-19800-20*86400);
  assert.equal(fifteen.from,Math.floor((now+19800000)/86400000)*86400-19800-45*86400);
  assert.ok(five.to < Math.floor(now/300000)*300);
  assert.ok(fifteen.to < Math.floor(now/900000)*900);
});
test('intraday range rejects invalid clocks and uses the selected candle resolution', () => {
  assert.throws(()=>getIntradayHistoryRange(0,300,20),/valid intraday history timestamp/);
  const range=getIntradayHistoryRange(Date.UTC(2026,10,27,4,18,20),60,5);
  assert.equal(range.intervalSeconds,60);
  assert.equal(range.to,Math.floor(Date.UTC(2026,10,27,4,18,20)/60000)*60-1);
});

test('FYERS API paths preserve the data and v3 base path', () => {
  assert.equal(buildFyersUrl('https://api-t1.fyers.in/data','/history',{symbol:'NSE:SBIN-EQ'}).pathname, '/data/history');
  assert.equal(buildFyersUrl('https://api-t1.fyers.in/api/v3','/positions').pathname, '/api/v3/positions');
});

test('15-minute index and equity history normalization excludes incomplete, malformed and out-of-session rows', () => {
  const first=Date.UTC(2027,0,4,3,45)/1000; // 09:15 IST
  const now=(first+1800)*1000+1000;
  const rows=[
    [first,100,102,99,101,1000],
    [first+900,101,103,100,102,1200],
    [first+1800,102,104,101,103,1400],
    [first+900,101,103,100,102,1200],
    [first+2700,100,99,101,100,10]
  ];
  const candles=normalizeFifteenMinuteCandles(rows,now);
  assert.deepEqual(candles.map(c=>c.time),[first,first+900]);
  assert.ok(candles.every(c=>c.completed&&c.source==='FYERS_HISTORY_15M'));
});

test('15-minute history cache expires just after the next completed 15m candle is due',()=>{
  const start=Date.UTC(2027,0,4,3,45)/1000;
  const candles=[{time:start,open:100,high:102,low:99,close:101,volume:1000}];
  assert.equal(getFifteenMinuteCacheValidUntil(candles,Date.UTC(2027,0,4,4,1)),(start+1800)*1000+2000);
});
test('daily research excludes the current incomplete IST session candle', () => {
  const now = Date.UTC(2027, 0, 4, 5, 0); // 10:00 IST on 4 Jan 2027
  const yesterday = Date.UTC(2027, 0, 2, 18, 30) / 1000; // 00:00 IST on 3 Jan
  const today = Date.UTC(2027, 0, 3, 18, 30) / 1000; // 00:00 IST on 4 Jan
  const rows = [
    [yesterday, 100, 103, 99, 102, 1000],
    [today, 102, 108, 101, 107, 1500]
  ];
  const candles = normalizeDailyCandles(rows, now);
  assert.deepEqual(candles.map(c => c.time), [yesterday]);
  assert.ok(candles.every(c => c.completed && c.source === 'FYERS_DAILY_HISTORY'));
});



test('FYERS Retry-After and bounded REST backoff respect provider wait times', () => {
  const now = Date.UTC(2026, 10, 20, 10, 0, 0);
  assert.equal(parseRetryAfterMs('120', now), 120_000);
  assert.equal(parseRetryAfterMs('0', now), 0);
  assert.equal(getRateLimitCooldownUntil(now, '0', 1), now + 60_000);
  assert.equal(getRateLimitCooldownUntil(now, null, 2), now + 120_000);
  assert.equal(getRateLimitCooldownUntil(now, null, 3), now + 240_000);
  assert.equal(getRateLimitCooldownUntil(now, '7200', 1), now + 2 * 60 * 60 * 1000);
  assert.equal(parseRetryAfterMs('not-a-date', now), null);
});

test('fourth FYERS 429 in the same IST day blocks until the next IST midnight', () => {
  const now = Date.UTC(2026, 10, 20, 10, 0, 0);
  const nextIstMidnight = Date.UTC(2026, 10, 20, 18, 30, 0);
  assert.equal(getRateLimitCooldownUntil(now, '0', 4), nextIstMidnight);
});

test('failed REST recovery probes retry with bounded backoff instead of a permanent lock', () => {
  assert.equal(getRecoveryProbeRetryDelayMs(1), 60_000);
  assert.equal(getRecoveryProbeRetryDelayMs(2), 120_000);
  assert.equal(getRecoveryProbeRetryDelayMs(3), 240_000);
  assert.equal(getRecoveryProbeRetryDelayMs(20), 5 * 60_000);
  assert.equal(getRecoveryProbeRetryDelayMs(0), 60_000);
});

test('FYERS WebSocket 1015 recovery uses bounded exponential backoff', () => {
  assert.equal(getSocketRateLimitBackoffMs(1), 60_000);
  assert.equal(getSocketRateLimitBackoffMs(2), 120_000);
  assert.equal(getSocketRateLimitBackoffMs(3), 240_000);
  assert.equal(getSocketRateLimitBackoffMs(50), 15 * 60_000);
  assert.equal(getSocketRateLimitBackoffMs(0), 60_000);
});

test('socket rate-limit recovery completes only after all paced batches drain on a connected socket', () => {
  const base = { recoveryPending:true, pendingCount:0, socketConnected:true, now:5000, cooldownUntil:5000 };
  assert.equal(canCompleteSocketRateLimitRecovery({...base,pendingCount:1}),false);
  assert.equal(canCompleteSocketRateLimitRecovery({...base,socketConnected:false}),false);
  assert.equal(canCompleteSocketRateLimitRecovery({...base,cooldownUntil:5001}),false);
  assert.equal(canCompleteSocketRateLimitRecovery({...base}),true);
  assert.equal(canCompleteSocketRateLimitRecovery({...base,recoveryPending:false}),false);
});

test('5-minute history cache remains valid only until the next completed candle is available', () => {
  const bucketStart = Date.UTC(2027, 0, 4, 3, 45); // 09:15 IST
  assert.equal(getFiveMinuteCacheValidUntil(bucketStart + 1_000), bucketStart + 300_000 + 2_000);
  assert.equal(getFiveMinuteCacheValidUntil(bucketStart + 299_000), bucketStart + 300_000 + 2_000);
  assert.equal(getFiveMinuteCacheValidUntil(bucketStart + 300_000), bucketStart + 600_000 + 2_000);
  assert.equal(getFiveMinuteCacheValidUntil(bucketStart + 301_000, 0), bucketStart + 600_000);
});

test('REST priority keeps entry verification ahead of chart, research, scanner and warmup', () => {
  const jobs = [
    { id:'warmup', priority:REST_PRIORITY.WARMUP, sequence:1 },
    { id:'scanner', priority:REST_PRIORITY.SCANNER, sequence:2 },
    { id:'research', priority:REST_PRIORITY.RESEARCH, sequence:3 },
    { id:'chart', priority:REST_PRIORITY.CHART, sequence:4 },
    { id:'entry', priority:REST_PRIORITY.ENTRY, sequence:5 }
  ];
  assert.deepEqual(sortRestQueue(jobs).map(job=>job.id), ['entry','chart','research','scanner','warmup']);
});

test('after a 429 cooldown, only a selected chart or higher-priority request may probe recovery', () => {
  assert.equal(canRunRestRecoveryProbe({recoveryProbeRequired:true,priority:REST_PRIORITY.SCANNER}),false);
  assert.equal(canRunRestRecoveryProbe({recoveryProbeRequired:true,priority:REST_PRIORITY.RESEARCH}),false);
  assert.equal(canRunRestRecoveryProbe({recoveryProbeRequired:true,priority:REST_PRIORITY.CHART}),true);
  assert.equal(canRunRestRecoveryProbe({recoveryProbeRequired:true,recoveryProbeAttempted:true,priority:REST_PRIORITY.CHART}),false);
  assert.equal(canRunRestRecoveryProbe({recoveryProbeRequired:true,recoveryProbeAttempted:true,priority:REST_PRIORITY.ENTRY}),false);
  assert.equal(canRunRestRecoveryProbe({recoveryProbeRequired:true,priority:REST_PRIORITY.ENTRY}),true);
  assert.equal(canRunRestRecoveryProbe({recoveryProbeRequired:false,priority:REST_PRIORITY.SCANNER}),true);
});

test('every backend restart starts behind an interactive REST recovery gate', () => {
  assert.equal(REST_RECOVERY_REQUIRED_ON_START, true);
  assert.equal(canRunRestRecoveryProbe({recoveryProbeRequired:REST_RECOVERY_REQUIRED_ON_START,priority:REST_PRIORITY.SCANNER}), false);
  assert.equal(canRunRestRecoveryProbe({recoveryProbeRequired:REST_RECOVERY_REQUIRED_ON_START,priority:REST_PRIORITY.CHART}), true);
  assert.equal(canRunRestRecoveryProbe({recoveryProbeRequired:REST_RECOVERY_REQUIRED_ON_START,recoveryProbeAttempted:true,priority:REST_PRIORITY.CHART}), false);
});


test('background history budget preserves two rolling-window slots for Entry and chart work', () => {
  const now = Date.UTC(2026, 10, 23, 5, 0, 0);
  const requests = Array.from({length:4}, (_,index) => ({
    at:new Date(now - index * 1000).toISOString(), path:'/history',
    source:'fno-scanner-5m', priority:REST_PRIORITY.SCANNER
  }));
  assert.equal(getHistoryRequestWindowWaitMs(requests, now, 8), 0);
  assert.ok(getHistoryRequestWindowWaitMs(requests, now, 2, 60_000, Number.NEGATIVE_INFINITY, REST_PRIORITY.CHART - 1) > 0);
  assert.equal(getHistoryRequestWindowWaitMs(requests.slice(0,1), now, 2, 60_000, Number.NEGATIVE_INFINITY, REST_PRIORITY.CHART - 1), 0);
  const entryRequests = [...requests, {at:new Date(now).toISOString(),path:'/history',source:'entry-option-history',priority:REST_PRIORITY.ENTRY}];
  assert.equal(getHistoryRequestWindowWaitMs(entryRequests, now, 8), 0);
});


test('global FYERS REST budget reserves two of five requests per minute for live Entry', () => {
  assert.equal(getRestTotalWindowLimit(REST_PRIORITY.ENTRY), 5);
  assert.equal(getRestTotalWindowLimit(REST_PRIORITY.CHART), 3);
  assert.equal(getRestTotalWindowLimit(REST_PRIORITY.OPTION_CHAIN), 3);
  assert.equal(getRestTotalWindowLimit(REST_PRIORITY.ACCOUNT), 3);
  assert.equal(getRestTotalWindowLimit(REST_PRIORITY.SCANNER), 3);
  const now=Date.UTC(2026,10,23,5,0,0);
  const nonEntry=Array.from({length:3},(_,i)=>({at:new Date(now-i*1000).toISOString(),path:'/history',priority:REST_PRIORITY.CHART}));
  assert.ok(getRestRequestWindowWaitMs(nonEntry,now,getRestTotalWindowLimit(REST_PRIORITY.CHART))>0);
  assert.equal(getRestRequestWindowWaitMs(nonEntry,now,getRestTotalWindowLimit(REST_PRIORITY.ENTRY)),0);
  const allFive=[...nonEntry,...Array.from({length:2},(_,i)=>({at:new Date(now-i*1000).toISOString(),path:'/history',priority:REST_PRIORITY.ENTRY}))];
  assert.ok(getRestRequestWindowWaitMs(allFive,now,getRestTotalWindowLimit(REST_PRIORITY.ENTRY))>0);
  const accountRequests=[
    {at:new Date(now-2000).toISOString(),priority:REST_PRIORITY.ACCOUNT,path:'/api/v3/positions'},
    {at:new Date(now-1000).toISOString(),priority:REST_PRIORITY.ACCOUNT,path:'/api/v3/orders'}
  ];
  assert.ok(getRestAccountWindowWaitMs(accountRequests,now)>0);
  assert.equal(getRestAccountWindowWaitMs(accountRequests,now+60_001),0);
});

test('global FYERS REST budget counts every endpoint and preserves interactive headroom', () => {
  const now = Date.UTC(2026, 10, 23, 5, 0, 0);
  const requests = [
    {at:new Date(now-30_000).toISOString(),path:'/history',source:'fno-scanner-5m',priority:REST_PRIORITY.SCANNER},
    {at:new Date(now-25_000).toISOString(),path:'/api/v3/positions',source:'account-positions',priority:REST_PRIORITY.ACCOUNT},
    {at:new Date(now-20_000).toISOString(),path:'/api/v3/orders',source:'account-orderbook',priority:REST_PRIORITY.ACCOUNT},
    {at:new Date(now-15_000).toISOString(),path:'/options-chain-v3',source:'option-chain-panel',priority:REST_PRIORITY.OPTION_CHAIN},
    {at:new Date(now-10_000).toISOString(),path:'/history',source:'chart-history',priority:REST_PRIORITY.CHART},
    {at:new Date(now-5_000).toISOString(),path:'/history',source:'research-context-daily',priority:REST_PRIORITY.CONTEXT}
  ];
  assert.ok(getRestRequestWindowWaitMs(requests, now, 5) > 0);
  assert.equal(getRestRequestWindowWaitMs(requests, now, 3, 60_000, REST_PRIORITY.CHART, Number.POSITIVE_INFINITY), 0);
  assert.ok(getRestRequestWindowWaitMs(requests, now, 3, 60_000, Number.NEGATIVE_INFINITY, REST_PRIORITY.CHART-1) > 0);
  assert.ok(getRestRequestWindowWaitMs(requests.slice(0,4), now, 5) === 0);
});


test('background REST scheduling rotates fairly across Account, scanner and research classes', () => {
  const now = Date.UTC(2026, 10, 23, 5, 0, 0);
  const jobs = [
    {id:'research',priority:REST_PRIORITY.RESEARCH,sequence:1},
    {id:'scanner',priority:REST_PRIORITY.SCANNER,sequence:2},
    {id:'account',priority:REST_PRIORITY.ACCOUNT,sequence:3}
  ];
  const eligible = () => true;
  assert.equal(jobs[findFairRestQueueIndex(jobs, [], now, eligible)].id, 'research');
  const recent = [
    {at:new Date(now-30_000).toISOString(),priority:REST_PRIORITY.RESEARCH},
    {at:new Date(now-20_000).toISOString(),priority:REST_PRIORITY.ACCOUNT}
  ];
  assert.equal(jobs[findFairRestQueueIndex(jobs, recent, now, eligible)].id, 'scanner');
  const withScanner = [...recent,{at:new Date(now-10_000).toISOString(),priority:REST_PRIORITY.SCANNER}];
  assert.equal(jobs[findFairRestQueueIndex(jobs, withScanner, now, eligible)].id, 'research');
});

test('interactive REST jobs keep priority over fair background classes', () => {
  const now = Date.UTC(2026, 10, 23, 5, 0, 0);
  const jobs = [
    {id:'scanner',priority:REST_PRIORITY.SCANNER,sequence:1},
    {id:'chart',priority:REST_PRIORITY.CHART,sequence:2},
    {id:'entry',priority:REST_PRIORITY.ENTRY,sequence:3}
  ];
  assert.equal(jobs[findFairRestQueueIndex(jobs, [], now, () => true)].id, 'entry');
  assert.equal(jobs[findFairRestQueueIndex(jobs, [], now, job => job.id !== 'entry')].id, 'chart');
});

test('fair REST selector never chooses a request rejected by the budget gate', () => {
  const now = Date.UTC(2026, 10, 23, 5, 0, 0);
  const jobs = [
    {id:'scanner',priority:REST_PRIORITY.SCANNER,sequence:1},
    {id:'account',priority:REST_PRIORITY.ACCOUNT,sequence:2}
  ];
  assert.equal(jobs[findFairRestQueueIndex(jobs, [], now, job => job.id === 'account')].id, 'account');
  assert.equal(findFairRestQueueIndex(jobs, [], now, () => false), -1);
});


test('queued REST work has strict freshness deadlines by request class', () => {
  assert.equal(getRestQueueMaxAgeMs(REST_PRIORITY.ENTRY), 60_000);
  assert.equal(getRestQueueMaxAgeMs(REST_PRIORITY.OPTION_CHAIN), 15_000);
  assert.equal(getRestQueueMaxAgeMs(REST_PRIORITY.CHART), 30_000);
  assert.equal(getRestQueueMaxAgeMs(REST_PRIORITY.ACCOUNT), 65_000);
  assert.equal(getRestQueueMaxAgeMs(REST_PRIORITY.CONTEXT), 120_000);
  assert.equal(getRestQueueMaxAgeMs(REST_PRIORITY.RESEARCH), 120_000);
  assert.equal(getRestQueueMaxAgeMs(REST_PRIORITY.SCANNER), 40_000);
  assert.equal(getRestQueueMaxAgeMs(REST_PRIORITY.WARMUP), 120_000);
});


test('queued REST requests expire at the exact age boundary and reject invalid timestamps', () => {
  assert.equal(isRestQueueExpired(1000, 10999, 10_000), false);
  assert.equal(isRestQueueExpired(1000, 11000, 10_000), true);
  assert.equal(isRestQueueExpired(Number.NaN, 11000, 10_000), true);
  assert.equal(isRestQueueExpired(1000, 11000, 0), true);
});


test('endpoint health is based on real HTTP and FYERS API responses, never connection state', () => {
  const now = Date.UTC(2026, 10, 23, 5, 0, 0);
  const health = buildRestEndpointHealth([
    {path:'/options-chain-v3',status:200,apiStatus:'ok',responseCode:200,at:new Date(now-1000).toISOString(),durationMs:240,source:'option-chain-panel'},
    {path:'/api/v3/positions',status:429,apiStatus:'error',responseCode:1015,at:new Date(now-2000).toISOString(),durationMs:90,source:'account-positions'}
  ], now);
  assert.equal(health.optionChain.status,'SUCCESS');
  assert.equal(health.optionChain.ok,true);
  assert.equal(health.optionChain.ageMs,1000);
  assert.equal(health.positions.status,'ERROR');
  assert.equal(health.positions.httpStatus,429);
  assert.equal(health.orderbook.status,'NOT_VERIFIED');
  assert.equal(health.orderbook.ok,false);
});


test('encrypted browser safety state restores a future cooldown monotonically',()=>{
  const now=Date.UTC(2026,10,24,5,0,0);
  const firstUntil=now+120000;
  assert.equal(restoreRestSafetyState({
    cooldownUntil:firstUntil,rateLimitDayKey:'2026-11-24',rateLimitCountToday:2,
    cloudflareRateLimitCountToday:1,unknownRateLimitCountToday:0,
    lastRateLimitAt:new Date(now).toISOString(),lastRateLimitKind:'CLOUDFLARE_1015'
  },now),true);
  assert.equal(getRestDiagnostics(now).cooldownUntil,firstUntil);
  assert.equal(getRestDiagnostics(now).recoveryProbeRequired,true);
  assert.equal(restoreRestSafetyState({cooldownUntil:now+60000,rateLimitDayKey:'2026-11-24',rateLimitCountToday:1},now),true);
  assert.equal(getRestDiagnostics(now).cooldownUntil,firstUntil);
  assert.equal(getRestSafetyState(now).cooldownUntil,firstUntil);
  assert.equal(restoreRestSafetyState({cooldownUntil:now-1},now),false);
});
