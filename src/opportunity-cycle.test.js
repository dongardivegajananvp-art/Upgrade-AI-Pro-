import test from 'node:test';
import assert from 'node:assert/strict';
import { getOpportunityCycleState } from './opportunity-cycle.js';

test('one active setup leaves one slot and excludes its underlying from the next candidate queue',()=>{
  const state=getOpportunityCycleState({
    setups:[{status:'ACTIVE',underlying:'NSE:AAA-EQ'}],
    maxActiveSetups:2
  });
  assert.equal(state.activeCount,1);
  assert.equal(state.availableSlots,1);
  assert.deepEqual(state.excludedUnderlyings,['NSE:AAA-EQ']);
});

test('two active setups hold option handoff while scanner capacity remains bounded at zero',()=>{
  const state=getOpportunityCycleState({
    setups:[{status:'ACTIVE',underlying:'NSE:AAA-EQ'},{status:'ACTIVE',underlying:'NSE:BBB-EQ'}],
    maxActiveSetups:2
  });
  assert.equal(state.availableSlots,0);
  assert.equal(state.status,'WAITING_FOR_ACTIVE_SLOT');
  assert.deepEqual(state.excludedUnderlyings,['NSE:AAA-EQ','NSE:BBB-EQ']);
});

test('an exited underlying stays excluded until a newer completed five-minute candle arrives',()=>{
  const recentlyClosed=new Map([['NSE:AAA-EQ',{closedCandleTime:1800000000}]]);
  const waiting=getOpportunityCycleState({
    recentlyClosed,latestCandleTimes:new Map([['NSE:AAA-EQ',1800000000]])
  });
  assert.deepEqual(waiting.coolingUnderlyings,['NSE:AAA-EQ']);
  const ready=getOpportunityCycleState({
    recentlyClosed,latestCandleTimes:new Map([['NSE:AAA-EQ',1800000300]])
  });
  assert.deepEqual(ready.coolingUnderlyings,[]);
  assert.deepEqual(ready.expiredClosedUnderlyings,['NSE:AAA-EQ']);
});
