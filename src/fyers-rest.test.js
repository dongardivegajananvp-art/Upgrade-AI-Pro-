import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNseSymbol, normalizeFiveMinuteCandles } from './fyers-rest.js';

test('FYERS REST accepts only a single NSE symbol', () => {
  assert.equal(validateNseSymbol('NSE:SBIN-EQ'), true);
  assert.equal(validateNseSymbol('NSE:NIFTY50-INDEX'), true);
  assert.equal(validateNseSymbol('BSE:SENSEX-INDEX'), false);
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
