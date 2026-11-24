import test from 'node:test';
import assert from 'node:assert/strict';
import { createFnoWebsocketCandleBuilder } from '../src/fno-websocket-candles.js';
const base=Date.parse('2026-11-23T03:45:00Z')/1000;
function tick(exchangeTime,price,cumulativeVolume=100){return {exchangeTime,price,receivedAt:exchangeTime*1000,cumulativeVolume};}

test('WebSocket candle builder aggregates OHLC and only closes a bar when the next bucket arrives',()=>{
  const builder=createFnoWebsocketCandleBuilder();
  assert.equal(builder.ingest('NSE:ABC-EQ',tick(base+10,100)).accepted,true);
  builder.ingest('NSE:ABC-EQ',tick(base+90,102,120));
  builder.ingest('NSE:ABC-EQ',tick(base+290,99,150));
  let snapshot=builder.snapshot('NSE:ABC-EQ');
  assert.equal(snapshot.completedCandles.length,0);
  assert.equal(snapshot.liveCandle.open,100);assert.equal(snapshot.liveCandle.high,102);
  assert.equal(snapshot.liveCandle.low,99);assert.equal(snapshot.liveCandle.close,99);
  builder.ingest('NSE:ABC-EQ',tick(base+300,101,160));
  snapshot=builder.snapshot('NSE:ABC-EQ');
  assert.equal(snapshot.completedCandles.length,1);
  assert.equal(snapshot.completedCandles[0].time,Math.floor(base/300)*300);
  assert.equal(snapshot.completedCandles[0].completed,true);
  assert.equal(snapshot.completedCandles[0].contiguous,true);
  assert.equal(snapshot.liveCandle.open,101);
});

test('rotating subscription gaps break continuity and never fabricate missing candles',()=>{
  const builder=createFnoWebsocketCandleBuilder();
  builder.ingest('NSE:ABC-EQ',tick(base+10,100));
  builder.ingest('NSE:ABC-EQ',tick(base+900,105));
  const snapshot=builder.snapshot('NSE:ABC-EQ');
  assert.equal(snapshot.completedCandles.length,1);
  assert.equal(snapshot.completedCandles[0].contiguous,false);
  assert.equal(snapshot.completedCandles[0].gapBeforeSeconds,600);
  assert.equal(snapshot.contiguousCompletedCount,1);
});

test('out-of-order and off-session ticks are rejected',()=>{
  const builder=createFnoWebsocketCandleBuilder();
  assert.equal(builder.ingest('NSE:ABC-EQ',tick(base+100,100)).accepted,true);
  assert.equal(builder.ingest('NSE:ABC-EQ',tick(base+50,101)).reason,'OUT_OF_ORDER_TICK');
  const preOpen=Date.parse('2026-11-23T03:40:00Z')/1000;
  assert.equal(builder.ingest('NSE:XYZ-EQ',tick(preOpen,100)).reason,'INVALID_OR_OFF_SESSION_TICK');
  assert.equal(builder.ingest('MCX:CRUDEOIL26NOVFUT',tick(base+200,100)).reason,'INVALID_OR_OFF_SESSION_TICK');
});

test('WebSocket-only candles never claim verified volume or actionability',()=>{
  const builder=createFnoWebsocketCandleBuilder();
  builder.ingest('NSE:ABC-EQ',tick(base+10,100));
  builder.ingest('NSE:ABC-EQ',tick(base+310,101));
  const snapshot=builder.snapshot('NSE:ABC-EQ');
  assert.equal(snapshot.actionable,false);
  assert.equal(snapshot.volumeVerified,false);
  assert.equal(snapshot.completedCandles[0].volume,null);
  assert.match(snapshot.reason,/not verified/);
});

test('candle builder bounds symbol and candle memory',()=>{
  const builder=createFnoWebsocketCandleBuilder({maxSymbols:2,maxCandlesPerSymbol:2});
  for(let i=0;i<4;i++){
    const start=base+i*300;
    builder.ingest('NSE:ABC-EQ',tick(start+10,100+i));
    builder.ingest('NSE:ABC-EQ',tick(start+300,101+i));
  }
  assert.ok(builder.snapshot('NSE:ABC-EQ').completedCandles.length<=2);
  builder.ingest('NSE:XYZ-EQ',tick(base+10,100));
  builder.ingest('NSE:QWE-EQ',tick(base+10,100));
  assert.equal(builder.size(),2);
});