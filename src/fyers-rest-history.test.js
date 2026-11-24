import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHistoricalBacktestRange } from './fyers-rest.js';

const day = 86400;

test('FYERS three-month intraday range plus five-day warmup fits documented 100-day cap', () => {
  const endTime = 1795496400;
  const startTime = endTime - 97 * day;
  const dailyStartTime = startTime - 120 * day;
  const result = validateHistoricalBacktestRange({ startTime, dailyStartTime, endTime });
  assert.equal(result.intradayDays, 97);
  assert.equal(result.dailyDays, 217);
});

test('FYERS historical adapter rejects intraday ranges over 100 days', () => {
  const endTime = 1795496400;
  assert.throws(() => validateHistoricalBacktestRange({
    startTime: endTime - 101 * day,
    dailyStartTime: endTime - 200 * day,
    endTime
  }), /exceeds documented per-request limits/);
});

test('FYERS historical adapter rejects daily warmup over 366 days', () => {
  const endTime = 1795496400;
  assert.throws(() => validateHistoricalBacktestRange({
    startTime: endTime - 90 * day,
    dailyStartTime: endTime - 367 * day,
    endTime
  }), /exceeds documented per-request limits/);
});

test('FYERS historical adapter rejects invalid date ordering', () => {
  assert.throws(() => validateHistoricalBacktestRange({
    startTime: 200,
    dailyStartTime: 300,
    endTime: 100
  }), /date range is invalid/);
});
