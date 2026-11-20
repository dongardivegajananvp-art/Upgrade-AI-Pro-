import test from 'node:test';
import assert from 'node:assert/strict';
import { getFiveMinuteHistoryRange, normalizeFiveMinuteCandles } from '../src/fyers-rest.js';

test('five-minute history requests a multi-session FYERS window', () => {
  const now = Date.parse('2026-11-20T04:10:00.000Z'); // 09:40 IST
  assert.deepEqual(getFiveMinuteHistoryRange(now), {
    from: '2026-11-10',
    to: '2026-11-20'
  });
});

test('five-minute history range supports an explicit bounded lookback', () => {
  const now = Date.parse('2026-11-20T04:10:00.000Z');
  assert.deepEqual(getFiveMinuteHistoryRange(now, 3), {
    from: '2026-11-17',
    to: '2026-11-20'
  });
});

test('normalizer retains verified completed candles across trading sessions', () => {
  const epoch = value => Date.parse(value) / 1000;
  const rows = [
    [epoch('2026-11-19T03:45:00Z'), 100, 101, 99, 100.5, 1000],
    [epoch('2026-11-19T03:50:00Z'), 100.5, 102, 100, 101.5, 1100],
    [epoch('2026-11-20T03:45:00Z'), 101.5, 103, 101, 102.5, 1200],
    [epoch('2026-11-20T03:50:00Z'), 102.5, 104, 102, 103.5, 1300]
  ];
  const now = Date.parse('2026-11-20T04:10:00.000Z');
  const candles = normalizeFiveMinuteCandles(rows, now);
  assert.equal(candles.length, 4);
  assert.deepEqual(candles.map(candle => candle.time), rows.map(row => row[0]));
  assert.ok(candles.every(candle => candle.completed && candle.source === 'FYERS_HISTORY'));
});


test('chart history requests only the current NSE session while research history remains multi-session', async () => {
  const now = Date.parse('2026-11-20T04:10:00.000Z'); // 09:40 IST
  const sessionStart = Date.parse('2026-11-20T03:45:00.000Z') / 1000;
  const priorSession = Date.parse('2026-11-19T10:00:00.000Z') / 1000;
  const rows = [
    [priorSession, 100, 101, 99, 100.5, 1000],
    [sessionStart, 101, 103, 100, 102, 1200]
  ];
  const candles = normalizeFiveMinuteCandles(rows, now).filter(candle => candle.time >= Date.parse('2026-11-19T18:30:00.000Z') / 1000);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].time, sessionStart);
  assert.deepEqual(getFiveMinuteHistoryRange(now), { from: '2026-11-10', to: '2026-11-20' });
});
