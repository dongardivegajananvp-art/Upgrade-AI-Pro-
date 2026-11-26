import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRollingFnoUniverse } from './rolling-fno-strategy-engine.js';

test('evaluates every official universe symbol independently and reports missing history as blocked', () => {
  const universe=[{symbol:'NSE:AAA-EQ'},{symbol:'NSE:BBB-EQ'},{symbol:'NSE:CCC-EQ'}];
  const result=evaluateRollingFnoUniverse({universe,now:1800000000000});
  assert.equal(result.universeCount,3);
  assert.equal(result.evaluations.length,3);
  assert.equal(result.blockedCount,3);
  assert.ok(result.evaluations.every(row=>row.status==='DATA_UNAVAILABLE_NO_TRADE'));
  assert.ok(result.evaluations.every(row=>row.strategyLedger.length===9));
  assert.equal(result.top3.length,0);
});

test('does not rank a symbol without fresh tick and verified multi-timeframe history', () => {
  const now=1800000000000;
  const symbol='NSE:AAA-EQ';
  const result=evaluateRollingFnoUniverse({universe:[{symbol}],ticks:new Map([[symbol,{symbol,price:100,exchangeTime:now/1000-30,receivedAt:now-30000}]]),now});
  assert.equal(result.candidateCount,0);
  assert.equal(result.top3.length,0);
  assert.equal(result.evaluations[0].fresh,false);
});


test('rolling scanner surfaces a fresh 5m price setup without daily/15m research warmup', () => {
  const now=Date.parse('2026-11-26T08:00:30Z');
  const symbol='NSE:AAA-EQ';
  const start=Date.parse('2026-11-26T03:45:00Z')/1000;
  const candles=Array.from({length:50},(_,i)=>{
    const open=100+i,close=open+1;
    return {time:start+i*300,open,high:close+0.5,low:open-0.5,close,volume:0};
  });
  const tick={symbol,price:151,exchangeTime:now/1000-1,receivedAt:now};
  const result=evaluateRollingFnoUniverse({
    universe:[{symbol}],ticks:new Map([[symbol,tick]]),
    fiveMinute:new Map([[symbol,{candles}]]),now
  });
  assert.equal(result.status,'PRICE_SETUPS_AVAILABLE');
  assert.equal(result.candidateCount,1);
  assert.equal(result.top3[0].strategy,'EMA20_EMA50_TREND');
  assert.equal(result.top3[0].side,'LONG');
  assert.equal(result.top3[0].grade,'PRICE_SETUP');
  assert.equal(result.top3[0].qualityScore,null);
});
