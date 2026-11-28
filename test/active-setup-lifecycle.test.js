import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFixedRiskPlan, updateActiveSetupFromTick } from '../src/active-setup-lifecycle.js';

const active={id:'x',status:'ACTIVE',entry:100,stopLoss:90,target:120,feedStatus:'WAITING_FOR_TICK'};
const tick=(price,now=1_000_000,delay=1000)=>({price,receivedAt:now,exchangeTime:(now-delay)/1000,fresh:true});

test('fixed risk plan requires positive ordered levels and at least 2R',()=>{
  assert.equal(validateFixedRiskPlan({entry:100,stopLoss:90,target:120}).ok,true);
  assert.equal(validateFixedRiskPlan({entry:100,stopLoss:90,target:119}).ok,false);
  assert.equal(validateFixedRiskPlan({entry:100,stopLoss:100,target:130}).ok,false);
  assert.equal(validateFixedRiskPlan({entry:100,stopLoss:90,target:120}).rr,2);
});

test('restored fixed risk levels must align to the official option tick size',()=>{
  assert.equal(validateFixedRiskPlan({entry:100.05,stopLoss:99.95,target:100.25,tickSize:0.05}).ok,true);
  assert.equal(validateFixedRiskPlan({entry:100.03,stopLoss:99.95,target:100.25,tickSize:0.05}).ok,false);
  assert.equal(validateFixedRiskPlan({entry:100.05,stopLoss:99.90,target:100.25,tickSize:0.05}).ok,true);
});

test('active setup monitor rejects a tick whose symbol is not its pinned contract',()=>{
  const setup={...active,contract:'NSE:ABC26NOV100CE'};
  const wrong={...tick(80,1_000_000),symbol:'NSE:ABC26NOV100PE'};
  const result=updateActiveSetupFromTick(setup,wrong,1_000_000);
  assert.equal(result.status,'ACTIVE');
  assert.equal(result.feedStatus,'STALE');
  assert.equal(result.exitPrice,undefined);
});

test('fresh verified option tick closes setup at stop loss',()=>{
  const result=updateActiveSetupFromTick(active,tick(89,1_000_000),1_000_000);
  assert.equal(result.status,'STOP_LOSS_HIT');
  assert.equal(result.exitPrice,89);
});

test('fresh verified option tick closes setup at target',()=>{
  const result=updateActiveSetupFromTick(active,tick(121,1_000_000),1_000_000);
  assert.equal(result.status,'TARGET_HIT');
  assert.equal(result.exitPrice,121);
});

test('fresh tick between levels keeps setup active',()=>{
  const result=updateActiveSetupFromTick(active,tick(110,1_000_000),1_000_000);
  assert.equal(result.status,'ACTIVE');
  assert.equal(result.lastObservedPrice,110);
});

test('stale receipt age cannot close an active setup',()=>{
  const result=updateActiveSetupFromTick(active,tick(80,1_000_000),1_011_000);
  assert.equal(result.status,'ACTIVE');
  assert.equal(result.feedStatus,'STALE');
  assert.equal(result.exitPrice,undefined);
});

test('exchange-to-receipt delay above five seconds cannot close an active setup',()=>{
  const result=updateActiveSetupFromTick(active,tick(80,1_000_000,6000),1_000_000);
  assert.equal(result.status,'ACTIVE');
  assert.equal(result.feedStatus,'STALE');
});

test('closed setup is immutable to later ticks',()=>{
  const closed={...active,status:'TARGET_HIT',exitPrice:120};
  assert.equal(updateActiveSetupFromTick(closed,tick(80,1_000_000),1_000_000),closed);
});
