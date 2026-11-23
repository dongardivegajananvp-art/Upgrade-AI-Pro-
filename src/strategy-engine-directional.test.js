import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectEmaTrend,
  detectDayHighLowRetest,
  detectFlagVolume,
  detectOpeningRange,
  detectDailyTrendPullback
} from './strategy-engine.js';

test('EMA20/EMA50 bearish trend confirms SHORT and rejects a flat control', () => {
  const rows = Array.from({length: 60}, (_, i) => {
    const close = 200 - i * 0.2;
    return {time: 1800000000 + i * 300, open: close + 0.05, high: close + 0.1, low: close - 0.1, close, volume: 100};
  });
  assert.equal(detectEmaTrend(rows)?.side, 'SHORT');
  const flat = rows.map(c => ({...c, open: 100, high: 101, low: 99, close: 100}));
  assert.equal(detectEmaTrend(flat), null);
});

test('day-low breakdown retest confirms SHORT only after close-through and retest rejection', () => {
  const start = Date.parse('2026-11-20T03:45:00Z') / 1000;
  const rows = [
    {time:start,open:100,high:101,low:99,close:100,volume:100},
    {time:start+300,open:99.2,high:100,low:98.5,close:98.8,volume:160},
    {time:start+600,open:98.8,high:99.4,low:98.2,close:98.7,volume:170},
    {time:start+900,open:99,high:99.2,low:98.4,close:98.8,volume:180}
  ];
  assert.equal(detectDayHighLowRetest(rows)?.side, 'SHORT');
  assert.equal(detectDayHighLowRetest(rows.slice(0, 3)), null);
});

test('opening-range first-candle breakdown confirms SHORT and does not invent a signal without a close below range', () => {
  const start = Date.parse('2026-11-20T03:45:00Z') / 1000;
  const opening = {time:start,open:100,high:101,low:99,close:100,volume:100};
  const breakdown = {time:start+300,open:99.2,high:99.4,low:97.8,close:98,volume:220};
  assert.equal(detectOpeningRange([opening, breakdown])?.side, 'SHORT');
  const noBreak = {...breakdown, close: 99.5};
  assert.equal(detectOpeningRange([opening, noBreak]), null);
});

test('bearish flag-volume continuation confirms SHORT only with contracting flag volume and a high-volume breakdown', () => {
  const rows = [];
  for (let i = 0; i < 17; i++) {
    const close = 120 - i;
    rows.push({time:1800000000+i*300,open:close+0.2,high:close+0.4,low:close-0.2,close,volume:200});
  }
  for (let i = 0; i < 12; i++) {
    rows.push({time:1800005100+i*300,open:104,high:104.5,low:103.5,close:104,volume:100});
  }
  rows.push({time:1800008700,open:103.4,high:103.6,low:101,close:101.5,volume:200});
  assert.equal(detectFlagVolume(rows)?.side, 'SHORT');
  assert.equal(detectFlagVolume(rows.map(c => ({...c, volume: 200}))), null);
});

test('daily-trend 5m bearish pullback requires fresh completed daily context and a resumed breakdown', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const start = Math.floor(now / 1000) - 60 * 300;
  const rows = Array.from({length:60}, (_, i) => {
    const close = 200 - i * 0.2;
    return {time:start+i*300,open:close+0.05,high:close+0.1,low:close-0.1,close,volume:100};
  });
  const previous = rows[58];
  rows[59] = {
    time:start+59*300,
    open:previous.low-0.02,
    high:previous.low+0.05,
    low:previous.low-0.2,
    close:previous.low-0.1,
    volume:150
  };
  const dailyStart = Math.floor(now / 1000) - 60 * 86400;
  const daily = Array.from({length:60}, (_, i) => {
    const close = 300 - i;
    return {time:dailyStart+i*86400,open:close+0.2,high:close+0.5,low:close-0.5,close,volume:1000};
  });
  const result = detectDailyTrendPullback(rows, daily, now);
  assert.equal(result?.side, 'SHORT');
  assert.equal(result?.strategy, 'DAILY_TREND_5M_PULLBACK');
  assert.equal(detectDailyTrendPullback(rows, [], now), null);
});
