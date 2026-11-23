import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRestWaitMs, isRestCooldownActive, parseRetryAfterMs,
  getRateLimitCooldownUntil, getCloudflareRateLimitCooldownUntil,
  getUnknownRateLimitCooldownUntil, classifyRestRateLimit,
  getSocketRateLimitBackoffMs, canCompleteSocketRateLimitRecovery,
  sortRestQueue, admitRestJob
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
