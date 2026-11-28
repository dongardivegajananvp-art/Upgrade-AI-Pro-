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
  assert.ok(['EMA20_EMA50_TREND','DAY_HIGH_LOW_BREAK_RETEST'].includes(result.top3[0].strategy));
  assert.equal(result.top3[0].side,'LONG');
  assert.equal(result.top3[0].grade,'PRICE_SETUP');
  assert.equal(result.top3[0].qualityScore,null);
  assert.equal(result.top3[0].lastCompletedCandleTime,candles.at(-1).time);
  const excluded=evaluateRollingFnoUniverse({
    universe:[{symbol}],ticks:new Map([[symbol,tick]]),
    fiveMinute:new Map([[symbol,{candles}]]),now,excludeSymbols:[symbol]
  });
  assert.equal(excluded.candidateCount,0);
  assert.equal(excluded.evaluations[0].status,'UNDERLYING_SETUP_CONFIRMED');
});

test('next opportunity queue prefers a fresh Top-5 gainer without inventing a quality score',()=>{
  const now=Date.parse('2026-11-26T08:00:30Z');
  const start=Date.parse('2026-11-26T03:45:00Z')/1000;
  const candles=Array.from({length:50},(_,i)=>{
    const open=100+i,close=open+1;
    return {time:start+i*300,open,high:close+0.5,low:open-0.5,close,volume:0};
  });
  const symbols=['NSE:AAA-EQ','NSE:BBB-EQ'];
  const ticks=new Map(symbols.map(symbol=>[symbol,{symbol,price:151,exchangeTime:now/1000-1,receivedAt:now}]));
  const history=new Map(symbols.map(symbol=>[symbol,{candles}]));
  const result=evaluateRollingFnoUniverse({
    universe:symbols.map(symbol=>({symbol})),ticks,fiveMinute:history,now,
    topGainers:[{symbol:'NSE:BBB-EQ'}]
  });
  assert.equal(result.top3[0].symbol,'NSE:BBB-EQ');
  assert.equal(result.top3[0].qualityScore,null);
});


test('rolling scanner passes cached daily history into Strategy 3 ledger',()=>{
 const now=Date.parse('2026-11-26T08:00:30Z'),symbol='NSE:AAA-EQ',start=Date.parse('2026-11-26T03:45:00Z')/1000;
 const five=Array.from({length:50},(_,i)=>{const c=100+i;return{time:start+i*300,open:c-.2,high:c+.5,low:c-.5,close:c,volume:1000};});
 const daily=Array.from({length:60},(_,i)=>{const c=100+i;return{time:Date.parse('2026-09-01T00:00:00Z')/1000+i*86400,open:c-.2,high:c+.5,low:c-.5,close:c,volume:1000};});
 const tick={symbol,price:151,exchangeTime:now/1000-1,receivedAt:now};
 const result=evaluateRollingFnoUniverse({universe:[{symbol}],ticks:new Map([[symbol,tick]]),fiveMinute:new Map([[symbol,{candles:five}]]),daily:new Map([[symbol,{candles:daily}]]),now});
 assert.ok(result.evaluations[0].strategyLedger.some(row=>row.strategy==='DAILY_TREND_5M_PULLBACK'));
});
