import test from 'node:test';
import assert from 'node:assert/strict';
import { getRestWaitMs, isRestCooldownActive, parseRetryAfterMs, getRateLimitCooldownUntil, getSocketRateLimitBackoffMs, canCompleteSocketRateLimitRecovery, sortRestQueue } from '../src/rest-scheduler-utils.js';

test('queued REST work waits only for the minimum pacing deadline', () => {
  assert.equal(getRestWaitMs(1000, 5000), 4000);
  assert.equal(getRestWaitMs(6000, 5000), 0);
  assert.equal(getRestWaitMs(10000, 5000), 0);
});

test('cooldown remains active at the post-wait boundary until its deadline', () => {
  assert.equal(isRestCooldownActive(8999, 9000), true);
  assert.equal(isRestCooldownActive(9000, 9000), false);
});


test('Retry-After seconds and HTTP dates are honored without shortening the one-hour safety floor', () => {
  const now = Date.parse('2026-11-21T10:00:00Z');
  assert.equal(parseRetryAfterMs('120', now), 120000);
  assert.equal(parseRetryAfterMs(new Date(now + 2*60*60*1000).toUTCString(), now), 2*60*60*1000);
  assert.equal(getRateLimitCooldownUntil(now, '120'), now + 60*60*1000);
  assert.equal(getRateLimitCooldownUntil(now, new Date(now + 2*60*60*1000).toUTCString()), now + 2*60*60*1000);
});

test('invalid Retry-After never creates a shorter-than-floor cooldown', () => {
  const now = 100000;
  assert.equal(parseRetryAfterMs('not-a-date', now), null);
  assert.equal(getRateLimitCooldownUntil(now, 'not-a-date'), now + 60*60*1000);
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
  assert.deepEqual(sortRestQueue(jobs).map(job=>job.id),[
    'option-chain','chart','user-history','scan-a','scan-b'
  ]);
  assert.deepEqual(jobs.map(job=>job.id),['scan-a','chart','option-chain','scan-b','user-history']);
});

test('bounded REST queue rejects excess equal/lower-priority work without reordering FIFO', async () => {
  const { admitRestJob } = await import('../src/rest-scheduler-utils.js');
  const jobs = [
    { id:'chart-1', priority:0, sequence:1 },
    { id:'chart-2', priority:0, sequence:2 }
  ];
  const rejected = admitRestJob(jobs, { id:'chart-3', priority:0, sequence:3 }, 2);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.dropped.id, 'chart-3');
  assert.deepEqual(rejected.queue.map(job=>job.id), ['chart-1','chart-2']);
});

test('interactive request can displace newest lowest-priority background work at capacity', async () => {
  const { admitRestJob } = await import('../src/rest-scheduler-utils.js');
  const jobs = [
    { id:'scan-1', priority:-10, sequence:1 },
    { id:'scan-2', priority:-10, sequence:2 },
    { id:'chart', priority:0, sequence:3 }
  ];
  const result = admitRestJob(jobs, { id:'option-chain', priority:100, sequence:4 }, 3);
  assert.equal(result.accepted, true);
  assert.equal(result.dropped.id, 'scan-2');
  assert.deepEqual(result.queue.map(job=>job.id), ['scan-1','chart','option-chain']);
});

test('full queue of interactive requests does not evict existing user work', async () => {
  const { admitRestJob } = await import('../src/rest-scheduler-utils.js');
  const jobs = [
    { id:'option-1', priority:100, sequence:1 },
    { id:'option-2', priority:100, sequence:2 }
  ];
  const result = admitRestJob(jobs, { id:'option-3', priority:100, sequence:3 }, 2);
  assert.equal(result.accepted, false);
  assert.equal(result.dropped.id, 'option-3');
  assert.deepEqual(result.queue.map(job=>job.id), ['option-1','option-2']);
});


test('selected chart and option research work outranks background F&O scans', async () => {
  const { sortRestQueue, admitRestJob } = await import('../src/rest-scheduler-utils.js');
  const jobs = [
    { id:'background-scan', priority:-10, sequence:1 },
    { id:'standard-history', priority:0, sequence:2 },
    { id:'selected-chart', priority:50, sequence:3 },
    { id:'option-chain', priority:100, sequence:4 }
  ];
  assert.deepEqual(sortRestQueue(jobs).map(job=>job.id),[
    'option-chain','selected-chart','standard-history','background-scan'
  ]);
  const full = [
    { id:'background-1', priority:-10, sequence:1 },
    { id:'background-2', priority:-10, sequence:2 },
    { id:'standard', priority:0, sequence:3 }
  ];
  const admitted = admitRestJob(full,{id:'selected-option-history',priority:50,sequence:4},3);
  assert.equal(admitted.accepted,true);
  assert.equal(admitted.dropped.id,'background-2');
  assert.deepEqual(sortRestQueue(admitted.queue).map(job=>job.id),[
    'selected-option-history','standard','background-1'
  ]);
});
