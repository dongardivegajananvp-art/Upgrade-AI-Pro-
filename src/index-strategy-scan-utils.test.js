import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INDEX_STRATEGY_SYMBOLS,
  isFreshIndexTick,
  countFreshIndexTicks,
  isVerifiedIndexHistory,
  buildIndexStrategyScanRecord
} from './index-strategy-scan-utils.js';
import { validateHistorySymbol } from './fyers-rest.js';

const now = Date.parse('2026-11-27T06:00:10.000Z');
const freshTick = {
  price: 25100,
  exchangeTime: now / 1000 - 1,
  receivedAt: now - 500
};

test('NSE index symbols are permitted for verified 15-minute history requests', () => {
  for (const symbol of INDEX_STRATEGY_SYMBOLS) assert.equal(validateHistorySymbol(symbol), true);
  assert.equal(validateHistorySymbol('BSE:NOT-A-REAL-INDEX'), false);
});

test('index scanner recognizes only ticks with fresh receipt and exchange clocks', () => {
  assert.equal(isFreshIndexTick(freshTick, now), true);
  assert.equal(isFreshIndexTick({ ...freshTick, receivedAt: now - 11_000 }, now), false);
  assert.equal(isFreshIndexTick({ ...freshTick, receivedAt: now - 6_000, exchangeTime: now / 1000 - 1 }, now), false);
  assert.equal(isFreshIndexTick({ ...freshTick, price: 0 }, now), false);
});

test('index scanner requires all three fresh index feeds before global evaluation', () => {
  const indices = Object.fromEntries(INDEX_STRATEGY_SYMBOLS.map(symbol => [symbol, freshTick]));
  assert.equal(countFreshIndexTicks(indices, now), 3);
  indices[INDEX_STRATEGY_SYMBOLS[1]] = { ...freshTick, receivedAt: now - 20_000 };
  assert.equal(countFreshIndexTicks(indices, now), 2);
});

test('index scanner accepts only recent completed FYERS five-minute history', () => {
  const candleTime = Math.floor(now / 300_000) * 300 - 300;
  const history = {
    source: 'FYERS_VERIFIED_5M_HISTORY',
    actionable: true,
    lastCompletedCandleTime: candleTime,
    candles: [{ time: candleTime, open: 1, high: 2, low: 1, close: 2, volume: 10, completed: true }]
  };
  assert.equal(isVerifiedIndexHistory(history, now), true);
  assert.equal(isVerifiedIndexHistory({ ...history, source: 'SYNTHETIC' }, now), false);
  assert.equal(isVerifiedIndexHistory({ ...history, candles: [{ ...history.candles[0], completed: false }] }, now), false);
  assert.equal(isVerifiedIndexHistory({ ...history, lastCompletedCandleTime: candleTime - 300 }, now), false);
  const staleButRecent = { ...history, lastCompletedCandleTime:candleTime-300, candles:[{...history.candles[0],time:candleTime-300}] };
  assert.equal(isVerifiedIndexHistory(staleButRecent, now), false);
});

test('underlying index setup is never represented as an actionable trade', () => {
  const record = buildIndexStrategyScanRecord({
    symbol: INDEX_STRATEGY_SYMBOLS[0],
    tick: freshTick,
    history: { source: 'FYERS_VERIFIED_5M_HISTORY', candles: [{ time: now / 1000 - 300, completed: true }] },
    result: { status: 'UNDERLYING_SETUP_CONFIRMED', strategy: 'EMA20_EMA50_TREND', side: 'LONG', strategyLedger: [{ status: 'DETECTED' }] },
    now
  });
  assert.equal(record.tradeStatus, 'OPTION_CONFIRMATION_REQUIRED_NO_TRADE');
  assert.equal(record.actionable, false);
  assert.equal(record.orders, 'DISABLED');
  assert.equal(record.strategyCheckCount, 1);
});
