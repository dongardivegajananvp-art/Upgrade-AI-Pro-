import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectEmaTrend,
  detectDoublePattern,
  detectContinuation,
  detectTopGainerMomentum,
  detectDayHighLowRetest,
  detectFlagPriceStructure,
  detectOpeningRange,
  detectFifteenMinuteTrendPullback
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

test('bearish flag price continuation confirms SHORT only after compact consolidation and price breakdown', () => {
  const rows = [];
  for (let i = 0; i < 17; i++) {
    const close = 120 - i;
    rows.push({time:1800000000+i*300,open:close+0.2,high:close+0.4,low:close-0.2,close,volume:200});
  }
  for (let i = 0; i < 12; i++) {
    const close=104+i*.05;
    rows.push({time:1800005100+i*300,open:close-0.1,high:104.5,low:103.5,close,volume:0});
  }
  rows.push({time:1800008700,open:103.4,high:103.6,low:101,close:101.5,volume:200});
  assert.equal(detectFlagPriceStructure(rows)?.side, 'SHORT');
  assert.equal(detectFlagPriceStructure(rows.map(c => ({...c, volume: 0})))?.side, 'SHORT');
});

test('15m trend plus 5m bearish pullback requires fresh 15m context and a resumed breakdown',()=>{
  const now=Date.parse('2026-11-23T10:05:00Z');
  const start=Math.floor(now/1000)-60*300;
  const rows=Array.from({length:60},(_,i)=>{const close=200-i*.2;return{time:start+i*300,open:close+.05,high:close+.1,low:close-.1,close,volume:100};});
  rows[58]={time:start+58*300,open:190,high:190.2,low:189.9,close:190.05,volume:120};
  const previous=rows[58];
  rows[59]={time:start+59*300,open:previous.low-.02,high:previous.low+.05,low:previous.low-.2,close:previous.low-.1,volume:150};
  const fifteen=Array.from({length:50},(_,i)=>{const session=i<25?0:1,slot=i%25,day=session===0?'2026-11-20':'2026-11-23',time=Date.parse(day+'T03:45:00Z')/1000+slot*900,close=300-i;return{time,open:close+.2,high:close+.5,low:close-.5,close,volume:1000};});
  const result=detectFifteenMinuteTrendPullback(rows,fifteen,now);
  assert.equal(result?.side,'SHORT');
  assert.equal(result?.strategy,'FIFTEEN_MIN_TREND_5M_PULLBACK');
  assert.equal(detectFifteenMinuteTrendPullback(rows,[],now),null);
});


test('Top Gainer breakout is LONG-only, requires verified Top Gainer membership, and rejects a non-breakout', () => {
  const rows = [
    {time:1800000000,open:100,high:101,low:99,close:100.5,volume:100},
    {time:1800000300,open:101,high:103,low:100.8,close:102.5,volume:150}
  ];
  assert.equal(detectTopGainerMomentum(rows, true)?.side, 'LONG');
  assert.equal(detectTopGainerMomentum(rows, false), null);
  assert.equal(detectTopGainerMomentum([{...rows[0]}, {...rows[1], close:100.9}], true), null);
});

test('double-top neckline breakdown/retest confirms SHORT and rejects an unbroken neckline', () => {
  const start = Date.parse('2026-11-20T03:45:00Z') / 1000;
  const rows = Array.from({length:50}, (_, i) => ({
    time:start+i*300,open:100,high:101,low:99,close:100,volume:100
  }));
  for (const i of [10,20]) rows[i] = {...rows[i],open:109,high:110,low:108,close:109};
  rows[15] = {...rows[15],high:100,low:95};
  for (let i=21;i<49;i++) rows[i] = {...rows[i],open:94.7,high:94.9,low:93.8,close:94.2};
  rows[49] = {...rows[49],open:94.9,high:95.2,low:94.4,close:94.8};
  assert.equal(detectDoublePattern(rows)?.side, 'SHORT');
  assert.equal(detectDoublePattern(rows.slice(0,22)), null);
});

test('double-bottom neckline breakout/retest confirms LONG and rejects an unbroken neckline', () => {
  const start = Date.parse('2026-11-20T03:45:00Z') / 1000;
  const rows = Array.from({length:50}, (_, i) => ({
    time:start+i*300,open:100,high:101,low:99,close:100,volume:100
  }));
  for (const i of [10,20]) rows[i] = {...rows[i],open:91,high:92,low:90,close:91};
  rows[15] = {...rows[15],high:110,low:100};
  for (let i=21;i<49;i++) rows[i] = {...rows[i],open:111,high:112,low:110.5,close:111.5};
  rows[49] = {...rows[49],open:110.2,high:111,low:109.8,close:110.5};
  assert.equal(detectDoublePattern(rows)?.side, 'LONG');
  assert.equal(detectDoublePattern(rows.slice(0,22)), null);
});

test('bullish continuation requires a strong impulse, tight consolidation and completed breakout', () => {
  const start = 1800000000;
  const rows = [];
  for (let i=0;i<17;i++) {
    const close=100+i;
    rows.push({time:start+i*300,open:close-0.2,high:close+0.3,low:close-0.3,close,volume:150});
  }
  for (let i=0;i<12;i++) rows.push({time:start+(17+i)*300,open:107.2,high:108,low:106,close:107.2,volume:100});
  rows.push({time:start+29*300,open:108.2,high:109.5,low:108.1,close:109,volume:180});
  assert.equal(detectContinuation(rows,'LONG')?.side, 'LONG');
  assert.equal(detectContinuation(rows.slice(0,-1),'LONG'), null);
});

test('bearish continuation requires a strong downside impulse, tight consolidation and completed breakdown', () => {
  const start = 1800000000;
  const rows = [];
  for (let i=0;i<17;i++) {
    const close=120-i;
    rows.push({time:start+i*300,open:close+0.2,high:close+0.3,low:close-0.3,close,volume:150});
  }
  for (let i=0;i<12;i++) rows.push({time:start+(17+i)*300,open:103.8,high:104,low:102,close:103.8,volume:100});
  rows.push({time:start+29*300,open:101.8,high:101.9,low:100.5,close:101,volume:180});
  assert.equal(detectContinuation(rows,'SHORT')?.side, 'SHORT');
  assert.equal(detectContinuation(rows.slice(0,-1),'SHORT'), null);
});
