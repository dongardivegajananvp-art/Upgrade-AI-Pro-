import test from 'node:test';
import assert from 'node:assert/strict';
import { getFiveMinuteHistoryRange, normalizeFiveMinuteCandles, filterFiveMinuteCandlesToNseSession, filterLastNseTradingSessions } from '../src/fyers-rest.js';

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


test('legacy one-session filter remains available while the chart uses ten trading sessions', async () => {
  const now = Date.parse('2026-11-20T04:10:00.000Z'); // 09:40 IST
  const sessionStart = Date.parse('2026-11-20T03:45:00.000Z') / 1000;
  const priorSession = Date.parse('2026-11-19T10:00:00.000Z') / 1000;
  const rows = [
    [priorSession, 100, 101, 99, 100.5, 1000],
    [sessionStart, 101, 103, 100, 102, 1200]
  ];
  const candles = filterFiveMinuteCandlesToNseSession(normalizeFiveMinuteCandles(rows, now), now);
  assert.equal(candles.length, 1);
  assert.equal(candles[0].time, sessionStart);
  assert.deepEqual(getFiveMinuteHistoryRange(now), { from: '2026-11-10', to: '2026-11-20' });
});


test('chart history retains the latest ten distinct NSE dates in IST order', () => {
  const dates = ['2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13','2026-11-16','2026-11-17','2026-11-18','2026-11-19','2026-11-20','2026-11-23'];
  const candles = dates.map((date,i)=>({
    time: Date.parse(date+'T03:45:00Z')/1000,
    open:100+i,high:102+i,low:99+i,close:101+i,volume:1000
  }));
  const selected = filterLastNseTradingSessions(candles,10);
  assert.equal(selected.length,10);
  assert.equal(new Date((selected[0].time+19800)*1000).toISOString().slice(0,10),'2026-11-10');
  assert.equal(new Date((selected.at(-1).time+19800)*1000).toISOString().slice(0,10),'2026-11-23');
});
