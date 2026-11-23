import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFlight } from './setup-evaluation-flight.js';

test('concurrent evaluations for the same key share one task and result',async()=>{
  const flight=createSingleFlight();
  let calls=0;
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const task=async()=>{calls++;await gate;return{status:'NO_TRADE'};};
  const first=flight.run('NSE:ABC-EQ|NSE:ABC26NOV100CE',task);
  const second=flight.run('NSE:ABC-EQ|NSE:ABC26NOV100CE',task);
  assert.equal(flight.size,1);
  release();
  assert.deepEqual(await first,{status:'NO_TRADE'});
  assert.deepEqual(await second,{status:'NO_TRADE'});
  assert.equal(calls,1);
  assert.equal(flight.size,0);
});

test('different contracts run independently and failed tasks release their key',async()=>{
  const flight=createSingleFlight();
  const [a,b]=await Promise.all([
    flight.run('A',async()=>1),
    flight.run('B',async()=>2)
  ]);
  assert.deepEqual([a,b],[1,2]);
  await assert.rejects(flight.run('FAIL',async()=>{throw new Error('expected');}),/expected/);
  assert.equal(flight.has('FAIL'),false);
  assert.throws(()=>flight.run('',async()=>0),/non-empty/);
});
