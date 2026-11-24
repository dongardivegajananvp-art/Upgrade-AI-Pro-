import test from 'node:test';
import assert from 'node:assert/strict';
import { runHistoricalSignalReplay } from './backtest-engine.js';

const start = Date.parse('2026-11-20T03:45:00Z') / 1000;
function neutralData() {
  const fiveMinuteCandles = Array.from({ length: 60 }, (_, index) => ({
    time: start + index * 300,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100
  }));
  const dailyStart = Date.parse('2026-09-20T00:00:00Z') / 1000;
  const dailyCandles = Array.from({ length: 60 }, (_, index) => ({
    time: dailyStart + index * 86400,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000
  }));
  return { symbol: 'NSE:TEST-EQ', fiveMinuteCandles, dailyCandles, dataProvenance: 'FYERS_HISTORICAL_API' };
}

test('historical signal replay refuses unverified or synthetic provenance', () => {
  const input = neutralData();
  input.dataProvenance = 'SAMPLE_FIXTURE';
  const result = runHistoricalSignalReplay(input);
  assert.equal(result.status, 'DATA_UNAVAILABLE');
  assert.equal(result.actionable, false);
  assert.equal(result.tradePerformance, null);
  assert.match(result.reason, /Only explicitly identified FYERS historical API data/);
});

test('historical signal replay evaluates candle prefixes and never fabricates option P&L', () => {
  const result = runHistoricalSignalReplay(neutralData());
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.mode, 'HISTORICAL_SIGNAL_REPLAY');
  assert.equal(result.actionable, false);
  assert.ok(result.evaluatedCandles > 0);
  assert.equal(result.tradePerformance, null);
  assert.equal(Object.keys(result.strategyDiagnostics).length, 9);
  assert.ok(result.strategyDiagnostics.TOP_GAINER_MOMENTUM_BREAKOUT.blocked > 0);
  assert.ok(result.signals.every(signal =>
    signal.optionExecution === 'NOT_SIMULATED' &&
    signal.entry === null && signal.stopLoss === null &&
    signal.target === null && signal.pnl === null
  ));
  assert.ok(result.limitations.some(value => /future-candle look-ahead/.test(value)));
});

test('historical signal replay rejects an unexplained five-minute gap', () => {
  const input = neutralData();
  input.fiveMinuteCandles[40].time += 300;
  const result = runHistoricalSignalReplay(input);
  assert.equal(result.status, 'DATA_UNAVAILABLE');
  assert.match(result.reason, /strictly increasing|unexplained gap/);
});

test('historical Top Gainer membership cannot be inferred from current gainers', () => {
  const input = neutralData();
  input.topGainerMembership = [{ time: start + 300, symbols: 'not-an-array' }];
  const result = runHistoricalSignalReplay(input);
  assert.equal(result.status, 'DATA_UNAVAILABLE');
  assert.match(result.reason, /snapshot is malformed/);
});
