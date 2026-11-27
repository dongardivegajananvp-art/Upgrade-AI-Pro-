import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRollingFnoLeaderboard, buildFnoRotationSlice, FNO_SCAN_PER_SLICE, FNO_SOCKET_ROTATION_ADVANCE, getFnoScanBatchSize, getNextFnoRotationIndex, getFnoSliceScanSymbols } from '../src/rolling-fno-scanner.js';
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
test('keeps current-session rolling observations visible with explicit stale age and excludes prior-session ticks', () => {
  const universe=[{symbol:'NSE:A-EQ'},{symbol:'NSE:B-EQ'}];
  const ticks=new Map([
    ['NSE:A-EQ',{symbol:'NSE:A-EQ',price:10,changePercent:5,exchangeTime:sec,receivedAt:now-90000}],
    ['NSE:B-EQ',{symbol:'NSE:B-EQ',price:20,changePercent:9,exchangeTime:sec-86400,receivedAt:now-1000}]
  ]);
  const result=buildRollingFnoLeaderboard({universe,ticks,now,slotCount:20,rotationIntervalMs:60000});
  assert.equal(result.observedCount,1);
  assert.equal(result.freshCount,0);
  assert.equal(result.observations.length,1);
  assert.equal(result.observations[0].fresh,false);
  assert.equal(result.observations[0].ageSeconds,90);
  assert.equal(result.topGainers.length,0);
});
test('reports complete coverage only after every current-session symbol was observed', () => {
  const universe=[{symbol:'NSE:A-EQ'},{symbol:'NSE:B-EQ'}];
  const ticks=new Map(universe.map(item=>[item.symbol,{symbol:item.symbol,price:10,changePercent:1,exchangeTime:sec,receivedAt:now-5000}]));
  assert.equal(buildRollingFnoLeaderboard({universe,ticks,now}).coverageComplete,true);
});

test('Top Gainers includes rolling observations but preserves each tick freshness flag', () => {
  const universe=[{symbol:'NSE:A-EQ'},{symbol:'NSE:B-EQ'}];
  const ticks=new Map([
    ['NSE:A-EQ',{symbol:'NSE:A-EQ',price:10,changePercent:9,exchangeTime:sec,receivedAt:now-5000}],
    ['NSE:B-EQ',{symbol:'NSE:B-EQ',price:20,changePercent:2,exchangeTime:sec,receivedAt:now-90000}]
  ]);
  const result=buildRollingFnoLeaderboard({universe,ticks,now,slotCount:20,rotationIntervalMs:60000});
  assert.equal(result.freshCount,1);
  assert.equal(result.observations.length,2);
  assert.equal(result.observations[0].symbol,'NSE:A-EQ');
  assert.equal(result.observations[0].fresh,true);
  assert.equal(result.observations[1].symbol,'NSE:B-EQ');
  assert.equal(result.observations[1].fresh,false);
  assert.equal(result.topGainers.length,1);
  assert.equal(result.topGainers[0].symbol,'NSE:A-EQ');
  assert.equal(result.topGainers[0].fresh,true);
});

test('twenty-symbol socket slices advance by twenty without overlap', () => {
  const universe=Array.from({length:218},(_,i)=>({symbol:'NSE:STOCK'+i+'-EQ'}));
  const first=buildFnoRotationSlice(universe,0,20);
  const second=buildFnoRotationSlice(universe,FNO_SOCKET_ROTATION_ADVANCE,20);
  assert.equal(first.length,20);
  assert.equal(second.length,20);
  assert.equal(first.filter(symbol=>second.includes(symbol)).length,0);
  assert.equal(second[0],'NSE:STOCK20-EQ');
  assert.equal(second[19],'NSE:STOCK39-EQ');
});

test('selected underlying is separate from the deterministic rolling slice', () => {
  const universe=Array.from({length:30},(_,i)=>({symbol:'NSE:STOCK'+i+'-EQ'}));
  const baseline=buildFnoRotationSlice(universe,0,20);
  const selected=buildFnoRotationSlice(universe,0,20,'NSE:STOCK29-EQ');
  assert.equal(selected.length,20);
  assert.deepEqual(selected,baseline);
  assert.ok(!selected.includes('NSE:STOCK29-EQ'));
});

test('three REST history scans per minute cover the universe without changing the 20-symbol socket rotation', () => {
  assert.equal(FNO_SCAN_PER_SLICE,3);
  assert.equal(FNO_SOCKET_ROTATION_ADVANCE,20);
  const universe=Array.from({length:218},(_,i)=>({symbol:'NSE:STOCK'+i+'-EQ'}));
  const batches=[];
  let start=0;
  do {
    const batchSize=getFnoScanBatchSize(universe.length,start,FNO_SCAN_PER_SLICE);
    const active=buildFnoRotationSlice(universe,start,20);
    batches.push(...getFnoSliceScanSymbols(active,batchSize));
    start=getNextFnoRotationIndex(universe.length,start,FNO_SCAN_PER_SLICE);
  } while(start!==0);
  assert.equal(batches.length,218);
  assert.equal(new Set(batches).size,218);
  assert.deepEqual([...batches].sort(),universe.map(item=>item.symbol).sort());
  assert.equal(getFnoScanBatchSize(218,216,3),2);
  assert.equal(getFnoScanBatchSize(218,0,3),3);
  assert.equal(getNextFnoRotationIndex(218,213,3),216);
  assert.equal(getNextFnoRotationIndex(218,216,3),0);
  assert.equal(getFnoSliceScanSymbols(buildFnoRotationSlice(universe,0,20),3)[0],'NSE:STOCK0-EQ');
  assert.equal(getFnoSliceScanSymbols(buildFnoRotationSlice(universe,3,20),3)[0],'NSE:STOCK3-EQ');
  const rollingWindow=buildRollingFnoLeaderboard({universe,ticks:new Map(),now,slotCount:20,rotationIntervalMs:60000});
  assert.equal(rollingWindow.maxObservationAgeSeconds,720);
});
