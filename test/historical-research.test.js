import test from 'node:test';
import assert from 'node:assert/strict';
import { detectNineStrategySetup } from '../src/strategy-engine.js';

const sessionOpen = Date.parse('2026-11-20T09:15:00+05:30') / 1000;
const candles = Array.from({ length: 50 }, (_, index) => ({
  time: sessionOpen + index * 300,
  open: 100,
  high: 100.2,
  low: 99.8,
  close: 100,
  volume: 100,
  completed: true,
  source: 'FYERS_HISTORY'
}));
const now = Date.parse('2026-11-21T12:00:00+05:30');

test('live strategy evaluation still fails closed without a fresh FYERS tick', () => {
  const result = detectNineStrategySetup({
    underlyingCandles: candles,
    underlyingTick: null,
    now,
    researchEnabled: false
  });
  assert.equal(result.status, 'DATA_UNAVAILABLE_NO_TRADE');
  assert.match(result.reason, /Fresh FYERS underlying/);
});

test('historical-only evaluation can inspect completed FYERS candles without inventing a live tick', () => {
  const result = detectNineStrategySetup({
    underlyingCandles: candles,
    underlyingTick: null,
    historicalAsOf: candles.at(-1).time + 300,
    now,
    researchEnabled: false
  });
  assert.notEqual(result.status, 'DATA_UNAVAILABLE_NO_TRADE');
  assert.ok(['NO_TRADE', 'UNDERLYING_SETUP_CONFIRMED'].includes(result.status));
});

test('historical-only mode rejects an arbitrary timestamp that is not the last candle close', () => {
  const result = detectNineStrategySetup({
    underlyingCandles: candles,
    underlyingTick: null,
    historicalAsOf: candles.at(-1).time + 600,
    now,
    researchEnabled: false
  });
  assert.equal(result.status, 'DATA_UNAVAILABLE_NO_TRADE');
});
