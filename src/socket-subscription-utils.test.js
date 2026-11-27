import test from 'node:test';
import assert from 'node:assert/strict';
import { SOCKET_SUBSCRIPTION_BATCH_SIZE, SOCKET_SUBSCRIPTION_BATCH_INTERVAL_MS, splitSubscriptionBatches, canResumeSocketSubscriptionRecovery } from './socket-subscription-utils.js';

test('20-symbol F&O slice is subscribed in two paced batches to reduce 1015 churn', () => {
  const symbols=Array.from({length:20},(_,i)=>'NSE:SYMBOL'+i+'-EQ');
  const batches=splitSubscriptionBatches(symbols,SOCKET_SUBSCRIPTION_BATCH_SIZE);
  assert.equal(SOCKET_SUBSCRIPTION_BATCH_SIZE,10);
  assert.equal(SOCKET_SUBSCRIPTION_BATCH_INTERVAL_MS,30_000);
  assert.deepEqual(batches.map(batch=>batch.length),[10,10]);
  assert.deepEqual(batches.flat(),symbols);
});

test('subscription batching deduplicates symbols and preserves FIFO order', () => {
  assert.deepEqual(splitSubscriptionBatches(['A','B','A','C'],2),[['A','B'],['C']]);
});

test('1015 subscription recovery resumes only after backoff while transport remains connected', () => {
  assert.equal(canResumeSocketSubscriptionRecovery({transportConnected:true,socketStatus:'RATE_LIMITED_WAIT',now:60_000,cooldownUntil:60_000}),true);
  assert.equal(canResumeSocketSubscriptionRecovery({transportConnected:true,socketStatus:'RATE_LIMITED_WAIT',now:59_999,cooldownUntil:60_000}),false);
  assert.equal(canResumeSocketSubscriptionRecovery({transportConnected:false,socketStatus:'RATE_LIMITED_WAIT',now:60_000,cooldownUntil:60_000}),false);
  assert.equal(canResumeSocketSubscriptionRecovery({transportConnected:true,socketStatus:'DISCONNECTED',now:60_000,cooldownUntil:60_000}),false);
});
