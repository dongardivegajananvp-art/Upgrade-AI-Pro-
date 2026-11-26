import test from 'node:test';
import assert from 'node:assert/strict';
import { getOptionRetryDelayMs } from '../public/option-retry-policy.js';

test('option chain and contract verification retry rate limits after the cooldown window', () => {
  assert.equal(getOptionRetryDelayMs(429),30_000);
});

test('option chain and contract verification retry transient server failures and network errors', () => {
  assert.equal(getOptionRetryDelayMs(500),10_000);
  assert.equal(getOptionRetryDelayMs(503),10_000);
  assert.equal(getOptionRetryDelayMs(0),10_000);
});

test('permanent client errors and successful responses do not retry', () => {
  assert.equal(getOptionRetryDelayMs(200),null);
  assert.equal(getOptionRetryDelayMs(400),null);
  assert.equal(getOptionRetryDelayMs(401),null);
  assert.equal(getOptionRetryDelayMs(404),null);
});
