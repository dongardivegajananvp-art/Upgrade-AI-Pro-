import test from 'node:test';
import assert from 'node:assert/strict';
import { planActiveSetupRestore } from '../src/active-setup-restore.js';

const normalize = input => input?.valid === false ? null : ({
  id:String(input.id), underlying:String(input.underlying), contract:String(input.contract),
  entry:Number(input.entry), stopLoss:Number(input.stopLoss), target:Number(input.target),
  rr:Number(input.rr), entryAt:input.entryAt || '2026-11-28T04:00:00.000Z',
  status:'ACTIVE', feedStatus:'WAITING_FOR_TICK'
});
const active = (id, underlying, contract, entry=100, stopLoss=90, target=120) => ({
  id,underlying,contract,entry,stopLoss,target,rr:2,entryAt:'2026-11-28T04:00:00.000Z',
  status:'ACTIVE',feedStatus:'FRESH',lastObservedPrice:105
});

test('restore cannot overwrite a server-retained active Entry/SL/Target or lifecycle state',()=>{
  const prior=active('a','NSE:AAA-EQ','NSE:AAA26DEC100CE');
  const result=planActiveSetupRestore({
    currentSetups:[prior],
    incomingSetups:[{id:'a',underlying:prior.underlying,contract:prior.contract,entry:101,stopLoss:95,target:113}],
    normalizeSetup:normalize
  });
  assert.equal(result.ok,true);
  assert.deepEqual(result.setups[0],prior);
});

test('restore rejects duplicate underlying or contract under different IDs atomically',()=>{
  const result=planActiveSetupRestore({
    incomingSetups:[
      {id:'a',underlying:'NSE:AAA-EQ',contract:'NSE:AAA26DEC100CE',entry:100,stopLoss:90,target:120},
      {id:'b',underlying:'NSE:AAA-EQ',contract:'NSE:AAA26DEC105CE',entry:100,stopLoss:90,target:120}
    ],
    normalizeSetup:normalize
  });
  assert.equal(result.ok,false);
  assert.match(result.reason,/Duplicate active underlying/i);
  assert.equal(result.setups,undefined);
});

test('restore rejects a third active setup without partially changing the ledger',()=>{
  const current=[active('a','NSE:AAA-EQ','NSE:AAA26DEC100CE'),active('b','NSE:BBB-EQ','NSE:BBB26DEC100CE')];
  const result=planActiveSetupRestore({
    currentSetups:current,
    incomingSetups:[{id:'c',underlying:'NSE:CCC-EQ',contract:'NSE:CCC26DEC100CE',entry:100,stopLoss:90,target:120}],
    normalizeSetup:normalize
  });
  assert.equal(result.ok,false);
  assert.match(result.reason,/Maximum two/i);
  assert.equal(result.setups,undefined);
  assert.equal(current.length,2);
});

test('restore cannot reactivate a previously closed setup',()=>{
  const closed={...active('a','NSE:AAA-EQ','NSE:AAA26DEC100CE'),status:'TARGET_HIT',exitPrice:121};
  const result=planActiveSetupRestore({
    currentSetups:[closed],
    incomingSetups:[{id:'a',underlying:closed.underlying,contract:closed.contract,entry:100,stopLoss:90,target:120}],
    normalizeSetup:normalize
  });
  assert.equal(result.ok,true);
  assert.deepEqual(result.setups[0],closed);
});

test('restore rejects reassignment of an active setup ID to another contract',()=>{
  const prior=active('a','NSE:AAA-EQ','NSE:AAA26DEC100CE');
  const result=planActiveSetupRestore({
    currentSetups:[prior],
    incomingSetups:[{id:'a',underlying:'NSE:BBB-EQ',contract:'NSE:BBB26DEC100CE',entry:100,stopLoss:90,target:120}],
    normalizeSetup:normalize
  });
  assert.equal(result.ok,false);
  assert.match(result.reason,/cannot be reassigned/i);
});
