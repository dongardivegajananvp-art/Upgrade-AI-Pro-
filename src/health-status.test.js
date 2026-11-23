import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthStatus } from './health-status.js';

test('health endpoint keeps process liveness separate from market readiness',()=>{
  const result=buildHealthStatus({market:{socketStatus:'CONNECTED',indices:{}},authStatus:{tokenStored:false}});
  assert.equal(result.ok,true);
  assert.equal(result.processLiveness,'ALIVE');
  assert.equal(result.marketPipelineReadiness.status,'WAIT');
  assert.ok(result.marketPipelineReadiness.blockers.includes('FYERS_AUTH_NOT_READY'));
  assert.ok(result.marketPipelineReadiness.blockers.includes('THREE_FRESH_INDEX_TICKS_REQUIRED'));
  assert.equal(result.orders,'DISABLED');
});

test('market readiness requires all three fresh indices, selected underlying and option, current master and clear REST recovery',()=>{
  const tick={fresh:true,price:100,exchangeTime:1800000000};
  const market={socketStatus:'CONNECTED',indices:{a:tick,b:tick,c:tick},selectedUnderlying:tick,selectedOption:tick,
    fno:{status:'ROTATING_LIVE_COVERAGE',universeCount:218,activeCount:20,observedCount:218,coverageComplete:true,topGainers:[{fresh:true}]}};
  const ready=buildHealthStatus({market,masterCurrent:true,authStatus:{tokenStored:true},scanner:{status:'RUNNING'},
    rest:{cooldownActive:false,recoveryProbeRequired:false}});
  assert.equal(ready.marketPipelineReadiness.status,'MARKET_DATA_READY');
  assert.deepEqual(ready.marketPipelineReadiness.blockers,[]);
  assert.equal(ready.indexFeed.freshCount,3);
  assert.equal(ready.fno.topGainersFreshCount,1);
  const blocked=buildHealthStatus({market,masterCurrent:true,authStatus:{tokenStored:true},scanner:{status:'RUNNING'},
    rest:{cooldownActive:true,recoveryProbeRequired:true}});
  assert.equal(blocked.marketPipelineReadiness.status,'WAIT');
  assert.ok(blocked.marketPipelineReadiness.blockers.includes('FYERS_REST_COOLDOWN_ACTIVE'));
  assert.ok(blocked.marketPipelineReadiness.blockers.includes('FYERS_REST_RECOVERY_PROBE_REQUIRED'));
});
