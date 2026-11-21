import test from 'node:test';
import assert from 'node:assert/strict';
import { getRestWaitMs, isRestCooldownActive, parseRetryAfterMs, getRateLimitCooldownUntil, getSocketRateLimitBackoffMs, canCompleteSocketRateLimitRecovery } from '../src/rest-scheduler-utils.js';

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
