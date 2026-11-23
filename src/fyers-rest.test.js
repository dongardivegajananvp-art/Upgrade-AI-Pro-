import test from 'node:test';
import assert from 'node:assert/strict';
import { REST_PRIORITY, REST_RECOVERY_REQUIRED_ON_START, canRunRestRecoveryProbe, sortRestQueue, getHistoryRequestWindowWaitMs, parseRetryAfterMs, getRateLimitCooldownUntil, getSocketRateLimitBackoffMs, canCompleteSocketRateLimitRecovery } from './rest-scheduler-utils.js';
import { validateNseSymbol, validateHistorySymbol, normalizeFiveMinuteCandles, normalizeFifteenMinuteCandles, normalizeDailyCandles, buildFyersUrl, getFiveMinuteCacheValidUntil } from './fyers-rest.js';

test('FYERS REST accepts only a single NSE symbol', () => {
  assert.equal(validateNseSymbol('NSE:SBIN-EQ'), true);
  assert.equal(validateNseSymbol('NSE:NIFTY50-INDEX'), true);
  assert.equal(validateNseSymbol('BSE:SENSEX-INDEX'), false);
  assert.equal(validateHistorySymbol('BSE:SENSEX-INDEX'), true);
  assert.equal(validateHistorySymbol('NSE:NIFTY50-INDEX'), true);
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
  assert.ok(getHistoryRequestWindowWaitMs(requests, now, 4, 60_000, Number.NEGATIVE_INFINITY, REST_PRIORITY.CHART - 1) > 0);
  assert.equal(getHistoryRequestWindowWaitMs(requests.slice(0,3), now, 4, 60_000, Number.NEGATIVE_INFINITY, REST_PRIORITY.CHART - 1), 0);
  const entryRequests = [...requests, {at:new Date(now).toISOString(),path:'/history',source:'entry-option-history',priority:REST_PRIORITY.ENTRY}];
  assert.equal(getHistoryRequestWindowWaitMs(entryRequests, now, 8), 0);
});
