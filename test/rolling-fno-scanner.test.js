import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRollingFnoLeaderboard } from '../src/rolling-fno-scanner.js';
const now = Date.parse('2026-11-19T06:00:00Z');
const sec = Date.parse('2026-11-19T05:59:55Z') / 1000;
test('ranks rolling observations across all symbols and exposes partial coverage', () => {
  const universe = Array.from({length: 25}, (_,i)=>({symbol:'NSE:STOCK'+i+'-EQ'}));
  const ticks = new Map([
    [universe[0].symbol,{symbol:universe[0].symbol,price:101,changePercent:4.2,exchangeTime:sec,receivedAt:now-5000}],
    [universe[1].symbol,{symbol:universe[1].symbol,price:102,changePercent:2.1,exchangeTime:sec,receivedAt:now-5000}]
  ]);
  const result=buildRollingFnoLeaderboard({universe,ticks,now,slotCount:20,rotationIntervalMs:60000});
  assert.equal(result.observedCount,2);
  assert.equal(result.coverageComplete,false);
  assert.equal(result.topGainers[0].symbol,universe[0].symbol);
  assert.equal(result.topGainers[0].fresh,true);
});
test('marks old rolling ticks non-fresh and excludes prior-session observations', () => {
  const universe=[{symbol:'NSE:A-EQ'},{symbol:'NSE:B-EQ'}];
  const ticks=new Map([
    ['NSE:A-EQ',{symbol:'NSE:A-EQ',price:10,changePercent:5,exchangeTime:sec,receivedAt:now-180000}],
    ['NSE:B-EQ',{symbol:'NSE:B-EQ',price:20,changePercent:9,exchangeTime:sec-86400,receivedAt:now-1000}]
  ]);
  const result=buildRollingFnoLeaderboard({universe,ticks,now,slotCount:20,rotationIntervalMs:60000});
  assert.equal(result.observedCount,1);
  assert.equal(result.topGainers[0].fresh,false);
});
test('reports complete coverage only after every current-session symbol was observed', () => {
  const universe=[{symbol:'NSE:A-EQ'},{symbol:'NSE:B-EQ'}];
  const ticks=new Map(universe.map(item=>[item.symbol,{symbol:item.symbol,price:10,changePercent:1,exchangeTime:sec,receivedAt:now-5000}]));
  assert.equal(buildRollingFnoLeaderboard({universe,ticks,now}).coverageComplete,true);
});
