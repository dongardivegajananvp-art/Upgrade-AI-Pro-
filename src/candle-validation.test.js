import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidOhlcvCandle, validateSessionCandleWindow, validateFreshDailyCandleWindow } from '../src/candle-validation.js';

function candle(time) { return {time,open:100,high:102,low:99,close:101}; }

test('shared validator accepts contiguous completed five-minute candles across an NSE session boundary',()=>{
  const previous=Date.UTC(2026,10,20,9,55)/1000; // 15:25 IST
  const next=Date.UTC(2026,10,23,3,45)/1000; // 09:15 IST next trading session
  assert.equal(validateSessionCandleWindow([candle(previous),candle(next)],2,300),true);
});

test('shared validator rejects duplicate, missing, malformed and out-of-order candles',()=>{
  const first=Date.UTC(2026,10,23,3,45)/1000;
  assert.equal(validateSessionCandleWindow([candle(first),candle(first)],2,300),false);
  assert.equal(validateSessionCandleWindow([candle(first),candle(first+600)],2,300),false);
  assert.equal(validateSessionCandleWindow([candle(first+300),candle(first)],2,300),false);
  assert.equal(isValidOhlcvCandle({...candle(first),high:98}),false);
});

test('shared validator applies the same exchange-session boundary rule to fifteen-minute candles',()=>{
  const previous=Date.UTC(2026,10,20,9,45)/1000; // 15:15 IST
  const next=Date.UTC(2026,10,23,3,45)/1000; // 09:15 IST
  assert.equal(validateSessionCandleWindow([candle(previous),candle(next)],2,900),true);
  assert.equal(validateSessionCandleWindow([candle(previous),candle(next+900)],2,900),false);
});

test('daily history must contain a fully valid minimum window and a fresh latest completed session',()=>{
  const now=Date.UTC(2026,10,23,10,0)/1000*1000;
  const rows=Array.from({length:50},(_,i)=>candle(now/1000-(50-i)*86400));
  assert.equal(validateFreshDailyCandleWindow(rows,now,50,5*86400),true);
  assert.equal(validateFreshDailyCandleWindow(rows.slice(0,49),now,50,5*86400),false);
  assert.equal(validateFreshDailyCandleWindow(rows,now+7*86400*1000,50,5*86400),false);
  assert.equal(validateFreshDailyCandleWindow([...rows.slice(0,49),{...rows.at(-1),low:999}],now,50,5*86400),false);
});
