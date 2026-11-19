import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, detectNineStrategySetup, buildFixedPremiumPlan, canAcceptStrategyTrade, confirmBreakoutPressureVolume } from './strategy-engine.js';

test('exactly nine established NSE strategies are present', () => {
  assert.equal(STRATEGIES.length, 9);
  assert.deepEqual(STRATEGIES, [
    'EMA20_EMA50_TREND','TOP_GAINER_MOMENTUM_BREAKOUT','DAILY_TREND_5M_PULLBACK',
    'DAY_HIGH_LOW_BREAK_RETEST','DOUBLE_TOP_BOTTOM_NECKLINE_RETEST','BULLISH_CONTINUATION',
    'BEARISH_CONTINUATION','FLAG_BREAKOUT_VOLUME','OPENING_RANGE_BREAKOUT'
  ]);
});
test('scanner fails closed without a fresh exchange tick', () => {
  const result = detectNineStrategySetup({ underlyingCandles: [], underlyingTick: null, now: 1800000000000 });
  assert.equal(result.status, 'DATA_UNAVAILABLE_NO_TRADE');
});
test('fixed premium plan enforces breakout, chase block and exact 1:2', () => {
  const plan = buildFixedPremiumPlan({ breakoutLevel: 100, tickSize: 0.05, livePremium: 100.05, swingLow: 99 });
  assert.equal(plan.status, 'SETUP_CONFIRMED');
  assert.equal(plan.rr, 2);
  assert.equal(buildFixedPremiumPlan({ breakoutLevel:100,tickSize:0.05,livePremium:102,swingLow:99 }).status, 'NO_TRADE');
});
test('duplicate active underlying or option contract is rejected', () => {
  assert.equal(canAcceptStrategyTrade([], { underlying:'NSE:ABC-EQ',contract:'NSE:ABC26000CE' }).ok, true);
  assert.equal(canAcceptStrategyTrade([{underlying:'NSE:ABC-EQ',contract:'NSE:ABC26000CE'}], { underlying:'NSE:ABC-EQ',contract:'NSE:ABC26000CE' }).ok, false);
});


test('common confirmation accepts a bullish breakout candle with verified volume', () => {
  const rows = [
    { time: 1800000000, open: 100, high: 101, low: 99, close: 100, volume: 50 },
    { time: 1800000300, open: 100, high: 103, low: 99.5, close: 102.8, volume: 1 }
  ];
  const result = confirmBreakoutPressureVolume(rows, 'LONG', 101, rows[1].time);
  assert.equal(result.ok, true);
  assert.equal(result.pressure, 'BUYING');
  assert.equal(result.breakoutVolume, 1);
});
test('common confirmation accepts a bearish breakdown candle with verified volume', () => {
  const rows = [
    { time: 1800000000, open: 100, high: 101, low: 99, close: 100, volume: 50 },
    { time: 1800000300, open: 100, high: 100.5, low: 97, close: 97.2, volume: 1 }
  ];
  const result = confirmBreakoutPressureVolume(rows, 'SHORT', 99, rows[1].time);
  assert.equal(result.ok, true);
  assert.equal(result.pressure, 'SELLING');
});
test('common confirmation rejects a wick-only breakout without directional pressure', () => {
  const rows = [
    { time: 1800000000, open: 100, high: 101, low: 99, close: 100, volume: 50 },
    { time: 1800000300, open: 100, high: 103, low: 99.5, close: 100, volume: 200 }
  ];
  assert.equal(confirmBreakoutPressureVolume(rows, 'LONG', 101, rows[1].time).ok, false);
});
test('common confirmation rejects missing or zero breakout-candle volume', () => {
  const rows = [
    { time: 1800000000, open: 100, high: 101, low: 99, close: 100, volume: 50 },
    { time: 1800000300, open: 100, high: 103, low: 99.5, close: 102.8, volume: 0 }
  ];
  assert.equal(confirmBreakoutPressureVolume(rows, 'LONG', 101, rows[1].time).ok, false);
});
test('retest cannot substitute its candle when original level cross is missing', () => {
  const rows = [
    { time: 1800000000, open: 100, high: 101, low: 99, close: 100.2, volume: 100 },
    { time: 1800000300, open: 100, high: 103, low: 99.5, close: 102.8, volume: 200 }
  ];
  const result = confirmBreakoutPressureVolume(rows, 'LONG', 105, rows[1].time, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Original breakout/);
});
