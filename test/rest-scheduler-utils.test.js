import test from 'node:test';
import assert from 'node:assert/strict';
import { getRestWaitMs, isRestCooldownActive } from '../src/rest-scheduler-utils.js';

test('queued REST work waits only for the minimum pacing deadline', () => {
  assert.equal(getRestWaitMs(1000, 5000), 4000);
  assert.equal(getRestWaitMs(6000, 5000), 0);
  assert.equal(getRestWaitMs(10000, 5000), 0);
});

test('cooldown remains active at the post-wait boundary until its deadline', () => {
  assert.equal(isRestCooldownActive(8999, 9000), true);
  assert.equal(isRestCooldownActive(9000, 9000), false);
});
