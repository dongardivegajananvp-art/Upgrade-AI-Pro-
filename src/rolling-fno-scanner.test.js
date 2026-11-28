import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRollingFnoLeaderboard, buildFnoRotationSlice, FNO_SCAN_PER_SLICE, FNO_SOCKET_ROTATION_ADVANCE,
  getNextFnoRotationIndex, getFnoScanBatchSize, getNextFreshFnoScanSymbol, FNO_SYMBOL_RESCAN_COOLDOWN_MS, getFnoScanSliceKey, shouldResetFnoScanCursor, buildFnoScanCandidates, isRetryableFnoScanError
} from './rolling-fno-scanner.js';

const universe=Array.from({length:218},(_,i)=>({symbol:`NSE:STOCK${String(i).padStart(3,'0')}-EQ`}));

test('218-symbol F&O rotation covers the full universe in twenty-symbol slices',()=>{
  const visited=new Set();
  let start=0,iterations=0;
  do{
    const slice=buildFnoRotationSlice(universe,start,20);
    assert.ok(slice.length<=20);
    for(const symbol of slice)visited.add(symbol);
    start=getNextFnoRotationIndex(universe.length,start,FNO_SOCKET_ROTATION_ADVANCE);
    iterations++;
    assert.ok(iterations<=Math.ceil(universe.length/FNO_SOCKET_ROTATION_ADVANCE));
  }while(start!==0);
  assert.equal(visited.size,218);
  assert.equal(iterations,11);
  assert.equal(getFnoScanBatchSize(218,216,FNO_SCAN_PER_SLICE),2);
});

test('selected underlying does not replace symbols in the stable rolling slice',()=>{
  const baseline=buildFnoRotationSlice(universe,0,20);
  const selectedA=buildFnoRotationSlice(universe,0,20,'NSE:STOCK217-EQ');
  const selectedB=buildFnoRotationSlice(universe,0,20,'NSE:STOCK150-EQ');
  assert.equal(baseline.length,20);
  assert.deepEqual(selectedA,baseline);
  assert.deepEqual(selectedB,baseline);
  assert.ok(!selectedA.includes('NSE:STOCK217-EQ'));
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


test('history-backed scanner uses two guarded REST background slots per minute',()=>{
  assert.equal(FNO_SCAN_PER_SLICE,2);
  assert.equal(getFnoScanBatchSize(218,0),2);
  assert.equal(getFnoScanBatchSize(218,216),2);
  assert.equal(getFnoScanBatchSize(218,217),1);
});


test('WebSocket rotates twenty new symbols per minute while two REST scans remain budgeted',()=>{
  assert.equal(FNO_SCAN_PER_SLICE,2);
  assert.equal(FNO_SOCKET_ROTATION_ADVANCE,20);
  const visited=new Set();
  let start=0,rotations=0;
  do{
    for(const symbol of buildFnoRotationSlice(universe,start,20)) visited.add(symbol);
    start=getNextFnoRotationIndex(universe.length,start,FNO_SOCKET_ROTATION_ADVANCE);
    rotations++;
    assert.ok(rotations<=Math.ceil(universe.length/FNO_SOCKET_ROTATION_ADVANCE));
  }while(start!==0);
  assert.equal(visited.size,218);
  assert.equal(rotations,11);
});

test('scanner picks the oldest fresh symbol and skips stale active ticks without losing the slot',()=>{
  const now=Date.parse('2026-11-25T05:00:00Z');
  const symbols=['NSE:A-EQ','NSE:B-EQ','NSE:C-EQ'];
  const fresh=symbol=>({symbol,price:100,receivedAt:now,exchangeTime:now/1000});
  const ticks=new Map([[symbols[0],fresh(symbols[0])],[symbols[1],{...fresh(symbols[1]),receivedAt:now-20000}],[symbols[2],fresh(symbols[2])]]);
  const ledger=new Map([[symbols[0],{scannedAt:new Date(now-60000).toISOString()}]]);
  assert.equal(getNextFreshFnoScanSymbol(symbols,ticks,ledger,now),symbols[2]);
  assert.equal(getNextFreshFnoScanSymbol([symbols[1]],ticks,ledger,now),null);
});

test('twenty-symbol socket rotation completes a 218-symbol universe in eleven minute slices',()=>{
  const total=218, advance=FNO_SOCKET_ROTATION_ADVANCE, visited=new Set();
  let start=0, rotations=0;
  do {
    const active=buildFnoRotationSlice(universe,start,20);
    assert.ok(active.length<=20);
    for(const symbol of active) visited.add(symbol);
    start=getNextFnoRotationIndex(total,start,advance);
    rotations++;
  } while(start!==0);
  assert.equal(visited.size,218);
  assert.equal(rotations,11);
});

test('scanner does not spend another REST slot rescanning the same symbol inside cooldown',()=>{
  const now=Date.parse('2026-11-25T05:00:00Z');
  const symbol='NSE:REPEAT-EQ';
  const tick={symbol,price:100,receivedAt:now,exchangeTime:now/1000};
  const ticks=new Map([[symbol,tick]]);
  const ledger=new Map([[symbol,{scannedAt:new Date(now-8000).toISOString()}]]);
  assert.equal(getNextFreshFnoScanSymbol([symbol],ticks,ledger,now),null);
  const later=now+FNO_SYMBOL_RESCAN_COOLDOWN_MS;
  ticks.set(symbol,{symbol,price:100,receivedAt:later,exchangeTime:later/1000});
  assert.equal(getNextFreshFnoScanSymbol([symbol],ticks,ledger,later),symbol);
});

test('fresh never-scanned symbol takes priority over a due previously scanned symbol',()=>{
  const now=Date.parse('2026-11-25T05:00:00Z');
  const old='NSE:OLD-EQ',fresh='NSE:NEW-EQ';
  const tick=symbol=>({symbol,price:100,receivedAt:now,exchangeTime:now/1000});
  const ticks=new Map([[old,tick(old)],[fresh,tick(fresh)]]);
  const ledger=new Map([[old,{scannedAt:new Date(now-FNO_SYMBOL_RESCAN_COOLDOWN_MS).toISOString()}]]);
  assert.equal(getNextFreshFnoScanSymbol([old,fresh],ticks,ledger,now),fresh);
});

test('scanner cursor resets when active slice membership changes without a rotation-index change',()=>{
  const previous=['NSE:A-EQ','NSE:B-EQ'];
  const next=['NSE:A-EQ','NSE:C-EQ'];
  const previousKey=getFnoScanSliceKey(previous);
  assert.equal(shouldResetFnoScanCursor(4,4,previousKey,getFnoScanSliceKey(next)),true);
  assert.equal(shouldResetFnoScanCursor(4,4,previousKey,getFnoScanSliceKey(previous)),false);
  assert.equal(shouldResetFnoScanCursor(4,5,previousKey,previousKey),true);
});


test('Top-5 priority is bounded and rotating F&O symbols retain a scan slot',()=>{
 const active=['NSE:A-EQ','NSE:B-EQ','NSE:C-EQ'],rows=buildFnoScanCandidates(active,['NSE:G1-EQ','NSE:G2-EQ']);
 assert.equal(rows[0],'NSE:G1-EQ');assert.deepEqual(rows.slice(1,4),active);
});
test('stale tick after history wait is retryable while malformed history is not',()=>{
 assert.equal(isRetryableFnoScanError('Fresh FYERS underlying tick became stale after history wait; scan result discarded'),true);
 assert.equal(isRetryableFnoScanError('malformed OHLCV'),false);
 assert.equal(isRetryableFnoScanError('Cloudflare 1015'),true);
});
test('218-symbol scheduler simulation with changing Top-5 eventually covers every rotating symbol',()=>{
 const visited=new Set(),attempts=new Map(),total=218;let rotation=0,cycles=0,minute=0;
 while(visited.size<total&&minute<2500){
  const active=buildFnoRotationSlice(universe,rotation,20),gainer=universe[(minute*17)%total].symbol;
  const candidates=buildFnoScanCandidates(active,[gainer]),chosen=[];
  for(const symbol of candidates){if(chosen.length>=2)break;if(chosen.includes(symbol))continue;if(symbol===gainer){chosen.push(symbol);continue;}if((attempts.get(symbol)||0)===0){chosen.push(symbol);break;}}
  for(const symbol of chosen){if(symbol!==gainer)visited.add(symbol);attempts.set(symbol,(attempts.get(symbol)||0)+1);}
  minute++;rotation=getNextFnoRotationIndex(total,rotation,FNO_SOCKET_ROTATION_ADVANCE);if(rotation===0)cycles++;
 }
 assert.equal(visited.size,total);assert.ok(minute<=total*11);assert.ok(cycles>=10);
});
