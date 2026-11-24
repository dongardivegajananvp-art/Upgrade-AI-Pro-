import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRollingFnoLeaderboard, buildFnoRotationSlice, FNO_SCAN_PER_SLICE,
  getNextFnoRotationIndex, getFnoScanBatchSize
} from './rolling-fno-scanner.js';

const universe=Array.from({length:218},(_,i)=>({symbol:`NSE:STOCK${String(i).padStart(3,'0')}-EQ`}));

test('218-symbol F&O rotation covers the full universe with bounded overlapping slices',()=>{
  const visited=new Set();
  let start=0,iterations=0;
  do{
    const slice=buildFnoRotationSlice(universe,start,20);
    assert.ok(slice.length<=20);
    for(const symbol of slice)visited.add(symbol);
    start=getNextFnoRotationIndex(universe.length,start,8);
    iterations++;
    assert.ok(iterations<=universe.length);
  }while(start!==0);
  assert.equal(visited.size,218);
  assert.equal(getFnoScanBatchSize(218,216,8),2);
});

test('selected underlying remains pinned without expanding the 20-symbol slice',()=>{
  const slice=buildFnoRotationSlice(universe,0,20,'NSE:STOCK217-EQ');
  assert.equal(slice.length,20);
  assert.ok(slice.includes('NSE:STOCK217-EQ'));
  assert.equal(new Set(slice).size,20);
});

test('rolling leaderboard excludes stale and old-session observations from live Top Gainers',()=>{
  const now=Date.parse('2026-11-23T05:00:00Z');
  const fresh={symbol:'NSE:FRESH-EQ',price:110,changePercent:5,exchangeTime:now/1000,receivedAt:now};
  const stale={symbol:'NSE:STALE-EQ',price:109,changePercent:9,exchangeTime:now/1000-20,receivedAt:now-20000};
  const old={symbol:'NSE:OLD-EQ',price:108,changePercent:12,exchangeTime:now/1000-3600,receivedAt:now-3600000};
  const result=buildRollingFnoLeaderboard({
    universe:[{symbol:fresh.symbol},{symbol:stale.symbol},{symbol:old.symbol}],
    ticks:new Map([[fresh.symbol,fresh],[stale.symbol,stale],[old.symbol,old]]),
    now,slotCount:8,rotationIntervalMs:60000
  });
  assert.equal(result.topGainers.length,1);
  assert.equal(result.topGainers[0].symbol,fresh.symbol);
  assert.equal(result.freshCount,1);
  assert.equal(result.observedCount,2);
  assert.equal(result.coverageComplete,false);
});


test('history-backed scanner advertises one new symbol per minute under the guarded REST budget',()=>{
  assert.equal(FNO_SCAN_PER_SLICE,1);
  assert.equal(getFnoScanBatchSize(218,0),1);
  assert.equal(getFnoScanBatchSize(218,217),1);
});
