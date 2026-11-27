import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRestWaitMs, isRestCooldownActive, createRestQueueWakeSignal, parseRetryAfterMs,
  getRateLimitCooldownUntil, getCloudflareRateLimitCooldownUntil,
  getUnknownRateLimitCooldownUntil, classifyRestRateLimit,
  getSocketRateLimitBackoffMs, canCompleteSocketRateLimitRecovery,
  sortRestQueue, admitRestJob, findFairRestQueueIndex, getRestQueueMaxAgeMs,
  isRestQueueExpired, getRestQueueExpiryWaitMs, isRestBackgroundPriority, getRestRequestWindowWaitMs, getRestAccountWindowWaitMs, getRestTotalWindowLimit, buildRestEndpointHealth, findRestQueueDuplicate, buildRestDispatchGate, buildRestCoalesceKey
} from '../src/rest-scheduler-utils.js';

test('queued REST work waits only for the minimum pacing deadline', () => {
  assert.equal(getRestWaitMs(1000, 5000), 4000);
  assert.equal(getRestWaitMs(6000, 5000), 0);
  assert.equal(getRestWaitMs(10000, 5000), 0);
});

test('cooldown remains active at the post-wait boundary until its deadline', () => {
  assert.equal(isRestCooldownActive(8999, 9000), true);
  assert.equal(isRestCooldownActive(9000, 9000), false);
});

test('Retry-After accepts seconds and HTTP dates', () => {
  const now = Date.parse('2026-11-21T10:00:00Z');
  assert.equal(parseRetryAfterMs('120', now), 120000);
  assert.equal(parseRetryAfterMs('0', now), 0);
  assert.equal(parseRetryAfterMs(new Date(now + 2*60*60*1000).toUTCString(), now), 2*60*60*1000);
  assert.equal(parseRetryAfterMs('not-a-date', now), null);
});

test('429 classification distinguishes Cloudflare 1015, FYERS quota codes and unknown responses', () => {
  assert.equal(classifyRestRateLimit({status:429,code:1015,server:'cloudflare',cfRay:'abc-SIN'}),'CLOUDFLARE_1015');
  assert.equal(classifyRestRateLimit({status:429,code:null,server:'cloudflare',cfRay:'abc-SIN'}),'CLOUDFLARE_1015');
  assert.equal(classifyRestRateLimit({status:429,code:-360,server:'nginx'}),'FYERS_PLAN_LIMIT');
  assert.equal(classifyRestRateLimit({status:429,code:'-429'}),'FYERS_PLAN_LIMIT');
  assert.equal(classifyRestRateLimit({status:429,code:1015,server:'fyers'}),'CLOUDFLARE_1015');
  assert.equal(classifyRestRateLimit({status:429,code:999}),'UNKNOWN_429');
  assert.equal(classifyRestRateLimit({status:200,code:1015}),'NOT_RATE_LIMITED');
});

test('identified FYERS quota errors use exponential backoff and fourth daily breach blocks until IST midnight', () => {
  const now = Date.parse('2026-11-21T10:00:00Z');
  const nextIstMidnight = Date.parse('2026-11-21T18:30:00Z');
  assert.equal(getRateLimitCooldownUntil(now, '0', 1), now + 60_000);
  assert.equal(getRateLimitCooldownUntil(now, null, 2), now + 120_000);
  assert.equal(getRateLimitCooldownUntil(now, 'not-a-date', 3), now + 240_000);
  assert.equal(getRateLimitCooldownUntil(now, '72000', 1), now + 72000_000);
  assert.equal(getRateLimitCooldownUntil(now, '0', 4), nextIstMidnight);
  assert.equal(getRateLimitCooldownUntil(now, '72000', 4), now + 72000_000);
});

test('Cloudflare 1015 uses its 30-second baseline and never inherits FYERS rest-of-day lock', () => {
  const now = Date.parse('2026-11-21T10:00:00Z');
  const nextIstMidnight = Date.parse('2026-11-21T18:30:00Z');
  assert.equal(getCloudflareRateLimitCooldownUntil(now, '0', 1), now + 30_000);
  assert.equal(getCloudflareRateLimitCooldownUntil(now, null, 2), now + 60_000);
  assert.equal(getCloudflareRateLimitCooldownUntil(now, null, 3), now + 120_000);
  assert.equal(getCloudflareRateLimitCooldownUntil(now, '7200', 1), now + 7200_000);
  assert.notEqual(getCloudflareRateLimitCooldownUntil(now, null, 4), nextIstMidnight);
});

test('unknown 429 uses bounded backoff without assuming a FYERS daily quota breach', () => {
  const now = Date.parse('2026-11-21T10:00:00Z');
  assert.equal(getUnknownRateLimitCooldownUntil(now, null, 1), now + 60_000);
  assert.equal(getUnknownRateLimitCooldownUntil(now, null, 2), now + 120_000);
  assert.equal(getUnknownRateLimitCooldownUntil(now, null, 99), now + 15*60_000);
});

test('WebSocket 1015 backoff grows exponentially and remains bounded', () => {
  assert.equal(getSocketRateLimitBackoffMs(1), 60000);
  assert.equal(getSocketRateLimitBackoffMs(2), 120000);
  assert.equal(getSocketRateLimitBackoffMs(3), 240000);
  assert.equal(getSocketRateLimitBackoffMs(99), 15*60*1000);
});

test('socket recovery cannot clear backoff before transport and all subscription batches are ready', () => {
  const base = { recoveryPending:true, pendingCount:0, socketConnected:true, now:200000, cooldownUntil:200000 };
  assert.equal(canCompleteSocketRateLimitRecovery(base), true);
  assert.equal(canCompleteSocketRateLimitRecovery({...base,pendingCount:1}), false);
  assert.equal(canCompleteSocketRateLimitRecovery({...base,socketConnected:false}), false);
  assert.equal(canCompleteSocketRateLimitRecovery({...base,now:199999}), false);
  assert.equal(canCompleteSocketRateLimitRecovery({...base,recoveryPending:false}), false);
});

test('interactive FYERS requests are ordered ahead of background scans with stable FIFO ties', () => {
  const jobs = [
    { id:'scan-a', priority:-10, sequence:1 },
    { id:'chart', priority:0, sequence:2 },
    { id:'option-chain', priority:100, sequence:3 },
    { id:'scan-b', priority:-10, sequence:4 },
    { id:'user-history', priority:0, sequence:5 }
  ];
  assert.deepEqual(sortRestQueue(jobs).map(job=>job.id),['option-chain','chart','user-history','scan-a','scan-b']);
  assert.deepEqual(jobs.map(job=>job.id),['scan-a','chart','option-chain','scan-b','user-history']);
});

test('bounded REST queue rejects excess equal/lower-priority work without reordering FIFO', () => {
  const jobs = [{id:'chart-1',priority:0,sequence:1},{id:'chart-2',priority:0,sequence:2}];
  const rejected = admitRestJob(jobs,{id:'chart-3',priority:0,sequence:3},2);
  assert.equal(rejected.accepted,false);
  assert.equal(rejected.dropped.id,'chart-3');
  assert.deepEqual(rejected.queue.map(job=>job.id),['chart-1','chart-2']);
});

test('interactive request can displace newest lowest-priority background work at capacity', () => {
  const jobs = [
    {id:'scan-1',priority:-10,sequence:1},
    {id:'scan-2',priority:-10,sequence:2},
    {id:'chart',priority:0,sequence:3}
  ];
  const result = admitRestJob(jobs,{id:'option-chain',priority:100,sequence:4},3);
  assert.equal(result.accepted,true);
  assert.equal(result.dropped.id,'scan-2');
  assert.deepEqual(result.queue.map(job=>job.id),['scan-1','chart','option-chain']);
});

test('full queue of interactive requests does not evict existing user work', () => {
  const jobs = [{id:'option-1',priority:100,sequence:1},{id:'option-2',priority:100,sequence:2}];
  const result = admitRestJob(jobs,{id:'option-3',priority:100,sequence:3},2);
  assert.equal(result.accepted,false);
  assert.equal(result.dropped.id,'option-3');
  assert.deepEqual(result.queue.map(job=>job.id),['option-1','option-2']);
});

test('selected chart and option research work outranks background F&O scans', () => {
  const jobs = [
    {id:'background-scan',priority:-10,sequence:1},
    {id:'standard-history',priority:0,sequence:2},
    {id:'selected-chart',priority:50,sequence:3},
    {id:'option-chain',priority:100,sequence:4}
  ];
  assert.deepEqual(sortRestQueue(jobs).map(job=>job.id),['option-chain','selected-chart','standard-history','background-scan']);
  const full = [
    {id:'background-1',priority:-10,sequence:1},
    {id:'background-2',priority:-10,sequence:2},
    {id:'standard',priority:0,sequence:3}
  ];
  const admitted = admitRestJob(full,{id:'selected-option-history',priority:50,sequence:4},3);
  assert.equal(admitted.accepted,true);
  assert.equal(admitted.dropped.id,'background-2');
  assert.deepEqual(sortRestQueue(admitted.queue).map(job=>job.id),['selected-option-history','standard','background-1']);
});

import { buildRestRateLimitContext } from '../src/rest-scheduler-utils.js';

test('rate-limit diagnostics preserve the exact upstream caller and recent history request mix', () => {
  const context = buildRestRateLimitContext({
    requestRecord: { source:'fno-scanner-5m', path:'/data/history', priority:-10 },
    requestSources: [
      { source:'fno-scanner-5m', requestsThisMinute:8, requestsToday:80 },
      { source:'chart-history', requestsThisMinute:2, requestsToday:12 }
    ],
    recentRequests: [
      { at:'2026-11-23T08:39:40Z', path:'/data/history', source:'chart-history', priority:50, status:200 },
      { at:'2026-11-23T08:39:44Z', path:'/data/history', source:'fno-scanner-5m', priority:-10, status:429 }
    ]
  });
  assert.equal(context.requestSource, 'fno-scanner-5m');
  assert.equal(context.requestPath, '/data/history');
  assert.equal(context.requestPriority, -10);
  assert.deepEqual(context.sourceCounts.map(item=>item.source), ['fno-scanner-5m','chart-history']);
  assert.equal(context.recentRequests.at(-1).source, 'fno-scanner-5m');
  assert.equal(context.recentRequests.at(-1).status, 429);
});


import { getHistoryRequestWindowWaitMs } from '../src/rest-scheduler-utils.js';

test('history endpoint is capped at eight requests per rolling minute without blocking other paths', () => {
  const requests = Array.from({length:8}, (_, index) => ({
    at:new Date(1000 + index * 5000).toISOString(), path:'/history'
  }));
  requests.push({at:new Date(40000).toISOString(),path:'/quotes'});
  assert.equal(getHistoryRequestWindowWaitMs(requests, 41000), 20000);
  assert.equal(getHistoryRequestWindowWaitMs(requests, 76000), 0);
  assert.equal(getHistoryRequestWindowWaitMs([{at:new Date(40000).toISOString(),path:'/quotes'}], 41000), 0);
  assert.equal(getHistoryRequestWindowWaitMs(requests, 41000, 9), 0);
});


test('background REST queue selects the least-served Account, Scanner and Research class', () => {
  const now=Date.UTC(2026,10,23,5,0,0);
  const jobs=[
    {id:'research',priority:40,sequence:1},
    {id:'scanner',priority:10,sequence:2},
    {id:'account',priority:20,sequence:3}
  ];
  assert.equal(jobs[findFairRestQueueIndex(jobs,[],now,()=>true)].id,'research');
  const recent=[
    {at:new Date(now-30000).toISOString(),priority:40},
    {at:new Date(now-20000).toISOString(),priority:20}
  ];
  assert.equal(jobs[findFairRestQueueIndex(jobs,recent,now,()=>true)].id,'scanner');
  const allServed=[...recent,{at:new Date(now-10000).toISOString(),priority:10}];
  assert.equal(jobs[findFairRestQueueIndex(jobs,allServed,now,()=>true)].id,'research');
});

test('interactive Entry and Chart work retain priority over fair background classes', () => {
  const now=Date.UTC(2026,10,23,5,0,0);
  const jobs=[
    {id:'scanner',priority:10,sequence:1},
    {id:'chart',priority:80,sequence:2},
    {id:'entry',priority:100,sequence:3}
  ];
  assert.equal(jobs[findFairRestQueueIndex(jobs,[],now,()=>true)].id,'entry');
  assert.equal(jobs[findFairRestQueueIndex(jobs,[],now,job=>job.id!=='entry')].id,'chart');
});

test('non-Entry REST traffic leaves two global request slots reserved for Entry', () => {
  assert.equal(getRestTotalWindowLimit(100),5);
  for (const priority of [90,80,60,40,30,10,-20]) assert.equal(getRestTotalWindowLimit(priority),3);
  assert.equal(getRestTotalWindowLimit(20),3);
  const now=Date.UTC(2026,10,23,5,0,0);
  const fourNonEntry=Array.from({length:3},(_,i)=>({at:new Date(now-i*1000).toISOString(),path:'/history',priority:80}));
  assert.ok(getRestRequestWindowWaitMs(fourNonEntry,now,getRestTotalWindowLimit(80))>0);
  assert.equal(getRestRequestWindowWaitMs(fourNonEntry,now,getRestTotalWindowLimit(100)),0);
  const fiveTotal=[...fourNonEntry,...Array.from({length:2},(_,i)=>({at:new Date(now-i*1000).toISOString(),path:'/history',priority:100}))];
  assert.ok(getRestRequestWindowWaitMs(fiveTotal,now,getRestTotalWindowLimit(100))>0);
});

test('queued REST requests expire at their exact deadline and invalid timestamps fail closed', () => {
  assert.equal(getRestQueueMaxAgeMs(100),60000);
  assert.equal(getRestQueueMaxAgeMs(90),15000);
  assert.equal(getRestQueueMaxAgeMs(80),30000);
  assert.equal(getRestQueueMaxAgeMs(20),65000);
  assert.equal(getRestQueueMaxAgeMs(30),120000);
  assert.equal(getRestQueueMaxAgeMs(40),120000);
  assert.equal(getRestQueueMaxAgeMs(10),40000);
  assert.equal(getRestQueueMaxAgeMs(-20),120000);
  assert.equal(isRestQueueExpired(1000,10999,10000),false);
  assert.equal(isRestQueueExpired(1000,11000,10000),true);
  assert.equal(isRestQueueExpired(Number.NaN,11000,10000),true);
});

test('Option Chain and Account Feed endpoint health requires actual successful responses', () => {
  const now=Date.UTC(2026,10,23,5,0,0);
  const health=buildRestEndpointHealth([
    {path:'/options-chain-v3',status:200,apiStatus:'ok',responseCode:200,at:new Date(now-1000).toISOString(),durationMs:240,source:'option-chain-panel'},
    {path:'/api/v3/positions',status:429,apiStatus:'error',responseCode:1015,at:new Date(now-2000).toISOString(),durationMs:90,source:'account-positions'}
  ],now);
  assert.equal(health.optionChain.status,'SUCCESS');
  assert.equal(health.optionChain.ageMs,1000);
  assert.equal(health.positions.status,'ERROR');
  assert.equal(health.positions.httpStatus,429);
  assert.equal(health.orderbook.status,'NOT_VERIFIED');
  assert.equal(health.orderbook.ok,false);
});

test('identical pending FYERS REST requests are discoverable for coalescing', () => {
  const jobs=[
    {coalesceKey:'GET:https://api-t1.fyers.in/data/options-chain-v3?symbol=NSE%3AABC'},
    {coalesceKey:'GET:https://api-t1.fyers.in/api/v3/positions'}
  ];
  assert.equal(findRestQueueDuplicate(jobs,jobs[0].coalesceKey),0);
  assert.equal(findRestQueueDuplicate(jobs,'GET:https://api-t1.fyers.in/data/history'),-1);
  assert.equal(findRestQueueDuplicate(jobs,''),-1);
});

test('scanner dispatch gate holds work when queue, cooldown, pacing or budgets are not ready', () => {
  const ready=buildRestDispatchGate({});
  assert.equal(ready.ready,true);
  assert.deepEqual(ready.blockers,[]);
  const held=buildRestDispatchGate({
    cooldownActive:true,queueDepth:2,minGapWaitMs:4000,
    totalWindowWaitMs:12000,backgroundWindowWaitMs:30000,historyWindowWaitMs:15000
  });
  assert.equal(held.ready,false);
  assert.ok(held.blockers.includes('COOLDOWN_ACTIVE'));
  assert.ok(held.blockers.includes('QUEUE_NOT_EMPTY'));
  assert.equal(held.waitMs,30000);
  const recovery=buildRestDispatchGate({recoveryProbeRequired:true,recoveryProbeAllowed:false});
  assert.ok(recovery.blockers.includes('RECOVERY_PROBE_REQUIRED'));
});

test('REST coalescing is limited to same-authenticated GET requests', () => {
  const url='https://api-t1.fyers.in/api/v3/positions';
  assert.equal(buildRestCoalesceKey({method:'GET',url,authorization:'Bearer token-A'}),
    'GET:'+url+':auth:Bearer token-A');
  assert.notEqual(
    buildRestCoalesceKey({method:'GET',url,authorization:'Bearer token-A'}),
    buildRestCoalesceKey({method:'GET',url,authorization:'Bearer token-B'})
  );
  assert.equal(buildRestCoalesceKey({method:'POST',url,authorization:'Bearer token-A'}),null);
  assert.equal(buildRestCoalesceKey({method:'GET',url:''}),null);
});


test('newly queued interactive REST work wakes a drain sleeping on a background budget window', async () => {
  const signal = createRestQueueWakeSignal();
  let settled = false;
  const pending = signal.wait(5_000).then(() => { settled = true; });
  signal.wake();
  await pending;
  assert.equal(settled, true);
});

test('REST queue wake signal still resumes naturally when its pacing deadline expires', async () => {
  const signal = createRestQueueWakeSignal();
  const startedAt = Date.now();
  await signal.wait(5);
  assert.ok(Date.now() - startedAt >= 0);
});


test('Account feed is exempt from the scanner/research background cap but remains below interactive work', () => {
  assert.equal(isRestBackgroundPriority(20), false);
  assert.equal(isRestBackgroundPriority(40), true);
  assert.equal(isRestBackgroundPriority(10), true);
  assert.equal(isRestBackgroundPriority(80), false);
  const now=Date.UTC(2026,10,26,5,0,0);
  const recent=[
    {at:new Date(now-50000).toISOString(),priority:40},
    {at:new Date(now-40000).toISOString(),priority:10},
    {at:new Date(now-30000).toISOString(),priority:20}
  ];
  assert.equal(getRestRequestWindowWaitMs(recent,now,3,60000,Number.NEGATIVE_INFINITY,79,[20]),0);
  assert.ok(getRestRequestWindowWaitMs(recent,now,2,60000,Number.NEGATIVE_INFINITY,79,[20])>0);
});

test('REST drain wakes at the earliest queued request expiry instead of oversleeping its TTL', () => {
  const now=10000;
  const jobs=[
    {enqueuedAt:1000,maxQueueAgeMs:30000},
    {enqueuedAt:5000,maxQueueAgeMs:10000}
  ];
  assert.equal(getRestQueueExpiryWaitMs(jobs,now),5000);
  assert.equal(getRestQueueExpiryWaitMs(jobs,15000),0);
  assert.equal(getRestQueueExpiryWaitMs([],now),0);
});


test('Account Feed retains two rolling-window slots without bypassing the global FYERS cap', () => {
  const now=Date.UTC(2026,10,23,5,0,0);
  assert.equal(getRestTotalWindowLimit(20),3);
  const twoAccount=[
    {at:new Date(now-2000).toISOString(),priority:20,path:'/positions'},
    {at:new Date(now-1000).toISOString(),priority:20,path:'/orders'}
  ];
  assert.ok(getRestAccountWindowWaitMs(twoAccount,now)>0);
  assert.equal(getRestAccountWindowWaitMs(twoAccount,now+60_001),0);
  const oneAccount=[twoAccount[0]];
  assert.equal(getRestAccountWindowWaitMs(oneAccount,now),0);
  const background=[
    {at:new Date(now-3000).toISOString(),priority:10,path:'/history'},
    {at:new Date(now-2000).toISOString(),priority:40,path:'/history'},
  ];
  assert.ok(getRestRequestWindowWaitMs(background,now,getRestTotalWindowLimit(20))===0);
  const globalFive=[...background,...twoAccount,{at:new Date(now).toISOString(),priority:80,path:'/history'}];
  assert.ok(getRestRequestWindowWaitMs(globalFive,now,getRestTotalWindowLimit(100))>0);
});
