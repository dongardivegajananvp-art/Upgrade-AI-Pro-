import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNseSymbol, validateHistorySymbol, normalizeFiveMinuteCandles, normalizeFifteenMinuteCandles, buildFyersUrl } from './fyers-rest.js';

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
