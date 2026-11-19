import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchWarmupQueue } from '../src/research-warmup-queue.js';

test('research warmup queue preserves FIFO work across rolling slice boundaries', () => {
  const queue = createResearchWarmupQueue();
  queue.enqueue('NSE:A-EQ');
  queue.enqueue('NSE:B-EQ');
  // A slice transition does not reset or replace the queue instance.
  queue.enqueue('NSE:C-EQ');
  assert.deepEqual(queue.snapshot(), ['NSE:A-EQ', 'NSE:B-EQ', 'NSE:C-EQ']);
  assert.equal(queue.take(), 'NSE:A-EQ');
  assert.equal(queue.take(), 'NSE:B-EQ');
  assert.equal(queue.take(), 'NSE:C-EQ');
  assert.equal(queue.size, 3, 'in-flight items remain pending until warmup completes');
  queue.complete('NSE:A-EQ');
  queue.complete('NSE:B-EQ');
  queue.complete('NSE:C-EQ');
  assert.equal(queue.size, 0);
});

test('research warmup queue deduplicates queued and in-flight candidates', () => {
  const queue = createResearchWarmupQueue();
  assert.equal(queue.enqueue('NSE:A-EQ'), true);
  assert.equal(queue.enqueue('NSE:A-EQ'), false);
  assert.equal(queue.take(), 'NSE:A-EQ');
  assert.equal(queue.enqueue('NSE:A-EQ'), false);
  assert.equal(queue.complete('NSE:A-EQ'), true);
  assert.equal(queue.enqueue('NSE:A-EQ'), true);
});

test('research warmup queue is bounded and rejects invalid symbols', () => {
  const queue = createResearchWarmupQueue({ maxSize: 2 });
  assert.equal(queue.enqueue(''), false);
  assert.equal(queue.enqueue('NSE:A-EQ'), true);
  assert.equal(queue.enqueue('NSE:B-EQ'), true);
  assert.equal(queue.enqueue('NSE:C-EQ'), false);
  assert.equal(queue.size, 2);
});

test('failed warmups are requeued with bounded retries and remain deduplicated', () => {
  const queue = createResearchWarmupQueue({ maxAttempts: 3 });
  queue.enqueue('NSE:A-EQ');
  assert.equal(queue.take(), 'NSE:A-EQ');
  assert.deepEqual(queue.fail('NSE:A-EQ'), { retry: true, attempt: 1, maxAttempts: 3, retryAfterMs: 5000 });
  assert.deepEqual(queue.snapshot(), ['NSE:A-EQ']);
  assert.equal(queue.enqueue('NSE:A-EQ'), false);
  assert.equal(queue.take(), 'NSE:A-EQ');
  assert.deepEqual(queue.fail('NSE:A-EQ'), { retry: true, attempt: 2, maxAttempts: 3, retryAfterMs: 10000 });
  assert.equal(queue.take(), 'NSE:A-EQ');
  assert.deepEqual(queue.fail('NSE:A-EQ'), { retry: false, attempt: 3, maxAttempts: 3, retryAfterMs: 0 });
  assert.equal(queue.size, 0);
  assert.equal(queue.enqueue('NSE:A-EQ'), true, 'a later fresh slice may rediscover and enqueue the candidate');
});

test('only an in-flight symbol can complete or fail', () => {
  const queue = createResearchWarmupQueue();
  queue.enqueue('NSE:A-EQ');
  assert.equal(queue.complete('NSE:A-EQ'), false);
  assert.deepEqual(queue.fail('NSE:A-EQ'), { retry: false, attempt: 0, maxAttempts: 3, retryAfterMs: 0 });
  assert.equal(queue.size, 1);
});

test('warmup retry uses exponential backoff without blocking other ready candidates', () => {
  const queue = createResearchWarmupQueue({ retryBaseMs: 1000, retryMaxMs: 5000 });
  queue.enqueue('NSE:A-EQ');
  queue.enqueue('NSE:B-EQ');
  assert.equal(queue.take(10000), 'NSE:A-EQ');
  assert.deepEqual(queue.fail('NSE:A-EQ', 10000), { retry: true, attempt: 1, maxAttempts: 3, retryAfterMs: 1000 });
  assert.equal(queue.take(10000), 'NSE:B-EQ', 'a delayed retry must not block ready FIFO work');
  queue.complete('NSE:B-EQ');
  assert.equal(queue.take(10999), null);
  assert.equal(queue.take(11000), 'NSE:A-EQ');
  assert.deepEqual(queue.fail('NSE:A-EQ', 11000), { retry: true, attempt: 2, maxAttempts: 3, retryAfterMs: 2000 });
  assert.equal(queue.take(12999), null);
  assert.equal(queue.take(13000), 'NSE:A-EQ');
});

test('scanner can distinguish delayed retry work from immediately ready warmups', () => {
  const queue = createResearchWarmupQueue({ retryBaseMs: 2000 });
  queue.enqueue('NSE:A-EQ');
  assert.equal(queue.take(5000), 'NSE:A-EQ');
  queue.fail('NSE:A-EQ', 5000);
  assert.equal(queue.hasReady(6999), false);
  assert.equal(queue.hasReady(7000), true);
});
