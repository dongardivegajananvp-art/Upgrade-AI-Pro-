import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRollingFnoLeaderboard, buildFnoRotationSlice, FNO_SCAN_PER_SLICE, getFnoSliceScanSymbols } from '../src/rolling-fno-scanner.js';
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
    ['NSE:A-EQ',{symbol:'NSE:A-EQ',price:10,changePercent:5,exchangeTime:sec,receivedAt:now-90000}],
    ['NSE:B-EQ',{symbol:'NSE:B-EQ',price:20,changePercent:9,exchangeTime:sec-86400,receivedAt:now-1000}]
  ]);
  const result=buildRollingFnoLeaderboard({universe,ticks,now,slotCount:20,rotationIntervalMs:60000});
  assert.equal(result.observedCount,1);
  assert.equal(result.freshCount,0);
  assert.equal(result.topGainers.length,0);
});
test('reports complete coverage only after every current-session symbol was observed', () => {
  const universe=[{symbol:'NSE:A-EQ'},{symbol:'NSE:B-EQ'}];
  const ticks=new Map(universe.map(item=>[item.symbol,{symbol:item.symbol,price:10,changePercent:1,exchangeTime:sec,receivedAt:now-5000}]));
  assert.equal(buildRollingFnoLeaderboard({universe,ticks,now}).coverageComplete,true);
});


test('live Top Gainers never retains a stale rolling observation', () => {
  const universe=[{symbol:'NSE:A-EQ'},{symbol:'NSE:B-EQ'}];
  const ticks=new Map([
    ['NSE:A-EQ',{symbol:'NSE:A-EQ',price:10,changePercent:9,exchangeTime:sec,receivedAt:now-5000}],
    ['NSE:B-EQ',{symbol:'NSE:B-EQ',price:20,changePercent:2,exchangeTime:sec,receivedAt:now-90000}]
  ]);
  const result=buildRollingFnoLeaderboard({universe,ticks,now,slotCount:20,rotationIntervalMs:60000});
  assert.equal(result.freshCount,1);
  assert.equal(result.topGainers.length,1);
  assert.equal(result.topGainers[0].symbol,'NSE:A-EQ');
});


test('overlapping socket slices cover new F&O symbols without skipping the overlap', () => {
  const universe=Array.from({length:218},(_,i)=>({symbol:'NSE:STOCK'+i+'-EQ'}));
  const first=buildFnoRotationSlice(universe,0,20);
  const second=buildFnoRotationSlice(universe,11,20);
  assert.equal(first.length,20);
  assert.equal(second.length,20);
  assert.equal(first.filter(symbol=>second.includes(symbol)).length,9);
  assert.equal(second[0],'NSE:STOCK11-EQ');
  assert.equal(second[19],'NSE:STOCK30-EQ');
});

test('selected underlying is pinned without duplicates or changing the rotation start', () => {
  const universe=Array.from({length:30},(_,i)=>({symbol:'NSE:STOCK'+i+'-EQ'}));
  const slice=buildFnoRotationSlice(universe,0,20,'NSE:STOCK29-EQ');
  assert.equal(slice.length,20);
  assert.equal(slice.at(-1),'NSE:STOCK29-EQ');
  assert.equal(new Set(slice).size,20);
});

test('overlapping F&O slices scan only newly added tail symbols and cover the whole universe fairly', () => {
  assert.equal(FNO_SCAN_PER_SLICE,4);
  const universe=Array.from({length:218},(_,i)=>({symbol:'NSE:STOCK'+i+'-EQ'}));
  const batches=[];
  for(let start=0;start<universe.length;start+=FNO_SCAN_PER_SLICE){
    const active=buildFnoRotationSlice(universe,start,20);
    batches.push(...getFnoSliceScanSymbols(active));
  }
  assert.equal(new Set(batches).size,218);
  assert.equal(getFnoSliceScanSymbols(buildFnoRotationSlice(universe,0,20))[0],'NSE:STOCK0-EQ');
  assert.equal(getFnoSliceScanSymbols(buildFnoRotationSlice(universe,4,20))[0],'NSE:STOCK4-EQ');
});
